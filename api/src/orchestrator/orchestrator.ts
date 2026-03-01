import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { InvocationContext } from '@azure/functions';
import { buildFatigueFallback, FatigueAgentRunResult, runFatigueAgent } from '../agents/fatigueAgent';
import { buildRiskFallback, RiskAgentRunResult, runRiskAgent } from '../agents/riskAgent';
import { buildTacticalFallback, runTacticalAgent } from '../agents/tacticalAgent';
import {
  AgentCode,
  AgentError,
  AgentStatus,
  FatigueAgentOutput,
  FinalRecommendation,
  LegacyAgentId,
  OrchestrateIntent,
  OrchestrateRequest,
  OrchestrateResponse,
  RiskAgentOutput,
  RouterDecision,
  TacticalAgentStructuredOutput,
  TriggerScores,
  toFatigueRequest,
  toRiskRequest,
} from '../agents/types';
import { getAoaiConfig } from '../llm/modelRegistry';
import { FullMatchContext, ReplacementCandidate, RosterPlayerContext } from '../shared/matchContext';
import { buildContinueRiskSummary, mapLikelyInjuries } from '../lib/injuryMap';
import { isEligibleForMode, rankSafetyCandidates, SafetyCandidate } from '../lib/safetyRank';

let dotenvLib: { config: (options: { path: string; override?: boolean }) => unknown } | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  dotenvLib = require('dotenv');
} catch {
  dotenvLib = null;
}

const ENV_CANDIDATE_PATHS = [
  path.resolve(__dirname, '../../../server/agent-framework/.env'),
  path.resolve(__dirname, '../../../.env'),
  path.resolve(__dirname, '../../.env'),
];

for (const envPath of ENV_CANDIDATE_PATHS) {
  if (!fs.existsSync(envPath)) continue;
  dotenvLib?.config({ path: envPath, override: false });
  break;
}

let azureEnvLogged = false;
const hasAzureConfig = (): boolean =>
  Boolean(
    String(process.env.AZURE_OPENAI_API_KEY || '').trim() &&
      String(process.env.AZURE_OPENAI_ENDPOINT || '').trim() &&
      String(process.env.AZURE_OPENAI_DEPLOYMENT || process.env.AZURE_OPENAI_MODEL || '').trim() &&
      String(process.env.AZURE_OPENAI_API_VERSION || '').trim()
  );
const logAzureEnv = (context: InvocationContext): void => {
  if (azureEnvLogged) return;
  azureEnvLogged = true;
  context.log('[env] azure', {
    hasAzure: hasAzureConfig(),
    endpoint: Boolean(String(process.env.AZURE_OPENAI_ENDPOINT || '').trim()),
    deployment: Boolean(String(process.env.AZURE_OPENAI_DEPLOYMENT || process.env.AZURE_OPENAI_MODEL || '').trim()),
    apiVersion: Boolean(String(process.env.AZURE_OPENAI_API_VERSION || '').trim()),
  });
};

const AGENT_CODE_TO_LEGACY: Record<AgentCode, LegacyAgentId> = {
  RISK: 'risk',
  TACTICAL: 'tactical',
  FATIGUE: 'fatigue',
};
const LEGACY_TO_AGENT_CODE: Record<LegacyAgentId, AgentCode> = {
  risk: 'RISK',
  tactical: 'TACTICAL',
  fatigue: 'FATIGUE',
};

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const safeNumber = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const normalizeRisk = (value: unknown): 'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN' => {
  const token = String(value || '').trim().toUpperCase();
  if (token === 'LOW') return 'LOW';
  if (token === 'HIGH' || token === 'CRITICAL') return 'HIGH';
  if (token === 'MED' || token === 'MEDIUM') return 'MEDIUM';
  return 'UNKNOWN';
};
const normalizeRole = (value: unknown): string => String(value || '').trim();
const toLegacyAgents = (agentsToRun: RouterDecision['agentsToRun']): LegacyAgentId[] =>
  agentsToRun.map((agent) => AGENT_CODE_TO_LEGACY[agent]);
const toAgentCode = (agent: LegacyAgentId): AgentCode => LEGACY_TO_AGENT_CODE[agent];
const normalizeSelectedLegacyAgents = (value: unknown): LegacyAgentId[] => {
  const source = Array.isArray(value) ? value : [];
  const ordered: LegacyAgentId[] = [];
  const seen = new Set<LegacyAgentId>();
  for (const entry of source) {
    const token = String(entry || '').trim().toLowerCase();
    const normalized =
      token === 'fatigue' ? 'fatigue' : token === 'risk' ? 'risk' : token === 'tactical' ? 'tactical' : undefined;
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    ordered.push(normalized);
  }
  return ordered;
};
const capAutoSelectedAgents = (selected: LegacyAgentId[]): LegacyAgentId[] => {
  const normalized = normalizeSelectedLegacyAgents(selected);
  if (normalized.length <= 2) return normalized;
  if (normalized.includes('tactical')) {
    const paired = normalized.find((agent) => agent !== 'tactical') || 'risk';
    return ['tactical', paired];
  }
  return normalized.slice(0, 2);
};
const isCriticalRouterDecision = (decision: RouterDecision): boolean => {
  const intentToken = String(decision.intent || '').trim().toUpperCase();
  if (intentToken === 'SUBSTITUTION' || intentToken === 'SAFETY_ALERT') return true;
  const injuryRisk = normalizeRisk(decision.signals?.injuryRisk ?? decision.inputsUsed?.active?.injuryRisk);
  const noBallRisk = normalizeRisk(decision.signals?.noBallRisk ?? decision.inputsUsed?.active?.noBallRisk);
  const fatigueIndex = safeNumber(decision.signals?.fatigueIndex ?? decision.inputsUsed?.active?.fatigueIndex, 0);
  return injuryRisk === 'HIGH' || noBallRisk === 'HIGH' || fatigueIndex >= 7.5;
};
const toAgentStatus = (status: string | undefined, didRun: boolean): AgentStatus => {
  if (!didRun) return 'SKIPPED';
  if (status === 'fallback') return 'FALLBACK';
  if (status === 'error') return 'ERROR';
  return 'OK';
};
const isRecordValue = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isExplicitDisable = (value: unknown): boolean => value === true || String(value || '').trim().toLowerCase() === 'true';
const isAgentEnabled = (input: OrchestrateRequest, agent: LegacyAgentId): boolean => {
  const signalRecord = isRecordValue(input.signals) ? input.signals : {};
  const agentFlags = isRecordValue((input as unknown as Record<string, unknown>).agents)
    ? ((input as unknown as Record<string, unknown>).agents as Record<string, unknown>)
    : {};
  const disableFlagKey =
    agent === 'fatigue'
      ? ['disableFatigue', 'fatigueDisabled']
      : agent === 'risk'
        ? ['disableRisk', 'riskDisabled']
        : ['disableTactical', 'tacticalDisabled'];
  const explicitDisableInSignals = disableFlagKey.some((key) => isExplicitDisable(signalRecord[key]));
  const explicitDisableInAgents =
    isRecordValue(agentFlags[agent]) && (agentFlags[agent] as Record<string, unknown>).enabled === false;
  return !(explicitDisableInSignals || explicitDisableInAgents);
};
const toAgentRoute = (status: string | undefined, model: string): 'llm' | 'rules' =>
  status === 'fallback' || /^rule:/i.test(String(model || '')) ? 'rules' : 'llm';
const toAgentResultStatus = (status: string | undefined, didRun: boolean, hasOutput: boolean): 'success' | 'error' | 'fallback' => {
  if (!didRun) return 'error';
  if (status === 'fallback') return 'fallback';
  if (status === 'error' || !hasOutput) return 'error';
  return 'success';
};
const normalizeConfidenceToScore = (confidence: FinalRecommendation['confidence']): number => {
  if (confidence === 'HIGH') return 0.82;
  if (confidence === 'MEDIUM') return 0.66;
  return 0.52;
};
const confidenceFromSignals = (riskLevel: number, fatigueNow: number, intent: RouterDecision['intent']): FinalRecommendation['confidence'] => {
  if (intent === 'SUBSTITUTION' || intent === 'SAFETY_ALERT' || riskLevel >= 7) return 'HIGH';
  if (riskLevel >= 4 || fatigueNow >= 6) return 'MEDIUM';
  return 'LOW';
};
const firstLine = (value: string | undefined, fallback: string): string => {
  const normalized = String(value || '').trim();
  return normalized || fallback;
};

const maxOversByFormat = (format?: string): number => {
  const token = String(format || '').trim().toUpperCase();
  if (token === 'T20') return 4;
  if (token === 'ODI') return 10;
  return 999;
};

const normalizeToAgentRisk = (value: unknown): 'LOW' | 'MED' | 'HIGH' | 'UNKNOWN' => {
  const normalized = normalizeRisk(value);
  if (normalized === 'MEDIUM') return 'MED';
  return normalized;
};

const normalizePhaseValue = (value: unknown): 'powerplay' | 'middle' | 'death' => {
  const token = String(value || 'middle').trim().toLowerCase();
  if (token === 'powerplay') return 'powerplay';
  if (token === 'death') return 'death';
  return 'middle';
};
const normalizeMatchMode = (value: unknown): 'BAT' | 'BOWL' => {
  const token = String(value || 'BOWL').trim().toUpperCase();
  if (token === 'BAT' || token === 'BATTING') return 'BAT';
  return 'BOWL';
};
const toTeamMode = (value: unknown): 'BATTING' | 'BOWLING' =>
  normalizeMatchMode(value) === 'BAT' ? 'BATTING' : 'BOWLING';
const toFocusRole = (role: unknown, teamMode: 'BATTING' | 'BOWLING'): 'BOWLER' | 'BATTER' => {
  const normalized = String(role || '').trim().toUpperCase();
  if (normalized.includes('BOWL') || normalized.includes('FAST') || normalized.includes('SPIN')) return 'BOWLER';
  if (normalized.includes('ALL-ROUNDER') || normalized.includes('ALLROUNDER') || normalized === 'AR') {
    return teamMode === 'BOWLING' ? 'BOWLER' : 'BATTER';
  }
  return 'BATTER';
};

const deriveContextSummary = (context: FullMatchContext) => {
  const hasBaselinesCount = context.roster.filter(
    (entry) =>
      entry.baseline &&
      (entry.baseline.sleepHours !== undefined ||
        entry.baseline.recoveryScore !== undefined ||
        entry.baseline.workload7d !== undefined ||
        entry.baseline.workload28d !== undefined ||
        entry.baseline.fatigueLimit !== undefined)
  ).length;

  const hasTelemetryCount = context.roster.filter(
    (entry) =>
      entry.live &&
      (entry.live.fatigueIndex !== undefined ||
        entry.live.strainIndex !== undefined ||
        entry.live.injuryRisk !== undefined ||
        entry.live.noBallRisk !== undefined ||
        entry.live.oversBowled !== undefined)
  ).length;

  return {
    rosterCount: context.roster.length,
    activePlayerId: context.activePlayerId,
    match: {
      matchMode: String(context.match.matchMode || 'BOWL'),
      format: String(context.match.format || ''),
      phase: String(context.match.phase || ''),
      intensity: String(context.match.intensity || ''),
      scoreRuns: safeNumber(context.match.scoreRuns, 0),
      wickets: safeNumber(context.match.wickets, 0),
      overs: safeNumber(context.match.overs, 0),
      balls: safeNumber(context.match.balls, 0),
      targetRuns: context.match.targetRuns,
    },
    hasBaselinesCount,
    hasTelemetryCount,
  };
};

const deriveRuntimeInputFromContext = (input: OrchestrateRequest): OrchestrateRequest => {
  if (!input.context || !Array.isArray(input.context.roster) || input.context.roster.length === 0) {
    throw new Error('FullMatchContext is required for orchestrate execution.');
  }

  const context = input.context;
  const activePlayer =
    context.roster.find((player) => player.playerId === context.activePlayerId) ||
    context.roster[0];
  const match = context.match;
  const matchMode = normalizeMatchMode(match.matchMode);
  const teamMode = toTeamMode(input.teamMode || matchMode);
  const maxOvers = maxOversByFormat(match.format);
  const oversBowled = Math.max(0, safeNumber(activePlayer.live?.oversBowled, 0));
  const oversRemaining = maxOvers < 999 ? Math.max(0, maxOvers - oversBowled) : 0;
  const oversValue = Math.max(0, safeNumber(match.overs, 0));
  const currentRunRate = oversValue > 0 ? safeNumber(match.scoreRuns, 0) / oversValue : 0;
  const battingOptions = context.roster.filter(
    (player) => player.playerId !== activePlayer.playerId && isEligibleForMode(player, 'BATTING')
  );
  const bowlingOptions = context.roster.filter(
    (player) => player.playerId !== activePlayer.playerId && isEligibleForMode(player, 'BOWLING')
  );
  const battingPool = battingOptions;
  const striker = matchMode === 'BAT' ? activePlayer.name : battingPool[0]?.name || activePlayer.name;
  const nonStriker = matchMode === 'BAT' ? battingPool[0]?.name || activePlayer.name : battingPool[1]?.name || striker;
  const bowler = matchMode === 'BOWL' ? activePlayer.name : bowlingOptions[0]?.name || activePlayer.name;
  const bench = context.roster
    .filter((player) => player.playerId !== activePlayer.playerId && isEligibleForMode(player, teamMode))
    .map((player) => player.name)
    .slice(0, 6);

  return {
    ...input,
    teamMode,
    focusRole: input.focusRole || toFocusRole(activePlayer.role, teamMode),
    context: {
      ...context,
      activePlayerId: activePlayer.playerId,
    },
    telemetry: {
      playerId: activePlayer.playerId,
      playerName: activePlayer.name,
      role: String(activePlayer.role || 'Unknown Role'),
      fatigueIndex: clamp(safeNumber(activePlayer.live?.fatigueIndex, 0), 0, 10),
      strainIndex: clamp(safeNumber(activePlayer.live?.strainIndex, 0), 0, 10),
      heartRateRecovery: String(activePlayer.live?.heartRateRecovery || 'Ok'),
      oversBowled,
      consecutiveOvers: 0,
      oversRemaining,
      maxOvers: maxOvers < 999 ? maxOvers : undefined,
      quotaComplete: maxOvers < 999 ? oversBowled >= maxOvers : false,
      injuryRisk: normalizeToAgentRisk(activePlayer.live?.injuryRisk),
      noBallRisk: normalizeToAgentRisk(activePlayer.live?.noBallRisk),
      fatigueLimit: safeNumber(activePlayer.baseline?.fatigueLimit, 6),
      sleepHours: safeNumber(activePlayer.baseline?.sleepHours, 7),
      recoveryMinutes: safeNumber(activePlayer.baseline?.recoveryScore, 45),
      isUnfit: normalizeRisk(activePlayer.live?.injuryRisk) === 'HIGH',
    },
    matchContext: {
      teamMode,
      matchMode,
      phase: normalizePhaseValue(match.phase),
      requiredRunRate: safeNumber(match.requiredRunRate, 0),
      currentRunRate: Number(currentRunRate.toFixed(2)),
      wicketsInHand: Math.max(0, 10 - safeNumber(match.wickets, 0)),
      oversRemaining:
        maxOvers < 999
          ? Number(Math.max(0, maxOvers - safeNumber(match.overs, 0)).toFixed(1))
          : 0,
      format: String(match.format || 'T20'),
      over: safeNumber(match.overs, 0),
      intensity: String(match.intensity || 'Medium'),
      conditions: String(match.tempState || 'Normal'),
      target: match.targetRuns,
      score: safeNumber(match.scoreRuns, 0),
      balls: safeNumber(match.balls, 0),
    },
    players: {
      striker,
      nonStriker,
      bowler,
      bench: bench.length > 0 ? bench : undefined,
    },
  };
};

const runModelRouter = (
  contextPayload: FullMatchContext,
  requestInput: OrchestrateRequest,
  mode: 'auto' | 'full',
  _traceId: string
): RouterDecision => {
  return buildRouterDecision(mode, { ...requestInput, context: contextPayload });
};

const runFatigueAgentFromContext = (requestInput: OrchestrateRequest, snapshotId: string): Promise<FatigueAgentRunResult> =>
  runFatigueAgent(toFatigueRequest(requestInput, snapshotId));

const runRiskAgentFromContext = (requestInput: OrchestrateRequest): Promise<RiskAgentRunResult> =>
  runRiskAgent(toRiskRequest(requestInput));

const runTacticalAgentFromContext = (args: {
  requestId: string;
  intent: OrchestrateIntent;
  requestInput: OrchestrateRequest;
  fatigueOutput?: OrchestrateResponse['fatigue'];
  riskOutput?: OrchestrateResponse['risk'];
  replacementCandidates: ReplacementCandidate[];
}) =>
  runTacticalAgent({
    requestId: args.requestId,
    intent: args.intent,
    teamMode: args.requestInput.teamMode,
    focusRole: args.requestInput.focusRole,
    matchContext: args.requestInput.matchContext,
    telemetry: args.requestInput.telemetry,
    players: args.requestInput.players,
    fatigueOutput: args.fatigueOutput,
    riskOutput: args.riskOutput,
    context: args.requestInput.context,
    replacementCandidates: args.replacementCandidates,
  });

const getActivePlayerContext = (input: OrchestrateRequest): RosterPlayerContext | undefined => {
  const roster = input.context?.roster || [];
  const activeId = input.context?.activePlayerId;
  return roster.find((player) => player.playerId === activeId);
};

const buildReplacementCandidates = (input: OrchestrateRequest, limit = 3): ReplacementCandidate[] => {
  const context = input.context;
  if (!context) return [];
  const rankResult = rankSafetyCandidates(context, { activePlayerId: context.activePlayerId, limit });
  const mode = toTeamMode(input.teamMode || input.matchContext?.teamMode || context.match.matchMode);
  const scopedCandidates = mode === 'BATTING' ? rankResult.batterCandidates : rankResult.bowlerCandidates;
  return scopedCandidates.map((candidate) => ({
    playerId: candidate.playerId,
    name: candidate.name,
    role: candidate.role,
    fatigueIndex: Number(candidate.reason.match(/Fatigue\s([\d.]+)/)?.[1] || Number.NaN),
    score: candidate.score,
    reason: candidate.reason,
  }));
};

function computeTriggers(input: OrchestrateRequest): TriggerScores {
  const fatigue = clamp(safeNumber(input.telemetry.fatigueIndex, 0), 0, 10);
  const injury = normalizeRisk(input.telemetry.injuryRisk);
  const noBall = normalizeRisk(input.telemetry.noBallRisk);
  const wicketsInHand = Math.max(0, safeNumber(input.matchContext.wicketsInHand, 0));
  const requiredRR = safeNumber(input.matchContext.requiredRunRate, 0);
  const currentRR = safeNumber(input.matchContext.currentRunRate, 0);

  return {
    fatigue: Math.round(clamp(fatigue * 10 + (input.telemetry.oversBowled || 0) * 2, 0, 100)),
    risk: Math.round(
      clamp(
        (injury === 'HIGH' ? 45 : injury === 'MEDIUM' ? 25 : 10) +
          (noBall === 'HIGH' ? 30 : noBall === 'MEDIUM' ? 15 : 5) +
          fatigue * 2,
        0,
        100
      )
    ),
    tactical: Math.round(clamp((requiredRR - currentRR) * 10 + Math.max(0, 6 - wicketsInHand) * 6, 0, 100)),
  };
}

export function buildRouterDecision(mode: 'auto' | 'full', input: OrchestrateRequest): RouterDecision {
  const contextPayload = input.context;
  const activeFromContext = getActivePlayerContext(input) || contextPayload?.roster?.[0];
  const activePlayerId = activeFromContext?.playerId || contextPayload?.activePlayerId || undefined;
  const fatigueIndex = safeNumber(activeFromContext?.live?.fatigueIndex, 0);
  const strainIndex = safeNumber(activeFromContext?.live?.strainIndex, 0);
  const injuryRisk = normalizeRisk(activeFromContext?.live?.injuryRisk);
  const noBallRisk = normalizeRisk(activeFromContext?.live?.noBallRisk);
  const match = contextPayload?.match;
  const matchMode = normalizeMatchMode(match?.matchMode);
  const matchPhase = String(match?.phase || 'Middle');
  const matchIntensity = String(match?.intensity || 'Medium');
  const fatigueLimit = safeNumber(activeFromContext?.baseline?.fatigueLimit, safeNumber(input.telemetry?.fatigueLimit, 6));
  const projectedFatigueNextOver = Number(clamp(fatigueIndex + Math.max(0, strainIndex) * 0.15 + 0.6, 0, 10).toFixed(1));
  const fatigueTriggered = fatigueIndex >= 6 || projectedFatigueNextOver >= fatigueLimit || strainIndex >= 3;
  const riskTriggered =
    injuryRisk === 'MEDIUM' || injuryRisk === 'HIGH' || noBallRisk === 'MEDIUM' || noBallRisk === 'HIGH';

  const rulesFired: string[] = [];
  let intent: RouterDecision['intent'] = 'GENERAL';
  let agentsToRun: AgentCode[] = ['TACTICAL'];

  if (mode === 'full') {
    rulesFired.push('mode=full');
  }
  rulesFired.push(`matchMode=${matchMode}`);
  rulesFired.push('tactical_always_on');
  if (fatigueTriggered) rulesFired.push('fatigue_triggered');
  if (riskTriggered) rulesFired.push('risk_triggered');

  if (mode === 'full') {
    intent = 'BOTH_NEXT';
    agentsToRun = ['FATIGUE', 'RISK', 'TACTICAL'];
    rulesFired.push('fullRunsAllAgents');
  } else {
    if (matchMode === 'BAT') intent = 'BATTING_NEXT';
    else if (riskTriggered) intent = 'SAFETY_ALERT';
    else if (fatigueTriggered) intent = 'GENERAL';

    if (fatigueTriggered) agentsToRun.push('FATIGUE');
    if (riskTriggered) agentsToRun.push('RISK');
  }

  const resolvedAgentSet = new Set<AgentCode>(agentsToRun);
  // Tactical must always execute on non-empty coach requests so the UI always gets a narrative decision.
  resolvedAgentSet.add('TACTICAL');

  const orderedAgents: AgentCode[] = (['FATIGUE', 'RISK', 'TACTICAL'] as const).filter((agent): agent is AgentCode =>
    resolvedAgentSet.has(agent)
  );
  if (orderedAgents.length === 0) {
    orderedAgents.push('TACTICAL');
    rulesFired.push('fallbackTacticalOnly');
  }

  const inputsUsed = {
    activePlayerId,
    active: {
      fatigueIndex,
      strainIndex,
      injuryRisk,
      noBallRisk,
    },
    match: {
      matchMode,
      format: String(match?.format || ''),
      phase: matchPhase,
      overs: safeNumber(match?.overs, 0),
      balls: safeNumber(match?.balls, 0),
      scoreRuns: safeNumber(match?.scoreRuns, 0),
      wickets: safeNumber(match?.wickets, 0),
      targetRuns: safeNumber(match?.targetRuns, 0),
      intensity: matchIntensity,
    },
  };

  const selectedAgents = toLegacyAgents(orderedAgents);
  const reason = `Rules: ${rulesFired.join(', ')}`;

  return {
    intent,
    agentsToRun: orderedAgents,
    rulesFired,
    inputsUsed,
    selectedAgents,
    reason,
    signals: {
      ...inputsUsed.active,
      ...inputsUsed.match,
      projectedFatigueNextOver,
      fatigueLimit,
    },
  };
}

const selectCandidate = (
  preferred: SafetyCandidate | undefined,
  unavailableName: string,
  unavailableReason: string
): { playerId: string; name: string; reason: string } => {
  if (preferred) {
    return {
      playerId: preferred.playerId,
      name: preferred.name,
      reason: preferred.reason,
    };
  }
  return {
    playerId: 'NONE',
    name: unavailableName,
    reason: unavailableReason,
  };
};

const buildRiskStructuredOutput = (
  input: OrchestrateRequest,
  risk: OrchestrateResponse['risk'] | undefined,
  activePlayer: RosterPlayerContext | undefined
): RiskAgentOutput | undefined => {
  if (!risk) return undefined;
  const likelyInjuries = mapLikelyInjuries(activePlayer, input.context?.match);
  if (likelyInjuries.length === 0 && (safeNumber(risk.riskScore, 0) >= 6 || String(risk.severity || '').toUpperCase() === 'HIGH' || String(risk.severity || '').toUpperCase() === 'CRITICAL')) {
    likelyInjuries.push({
      type: 'general soft-tissue injury',
      reason: 'Elevated risk score indicates increased soft-tissue injury exposure if load continues.',
      severity: 'MEDIUM',
    });
  }
  const playerName = activePlayer?.name || 'active player';
  return {
    riskLevel: Number(clamp(safeNumber(risk.riskScore, 0), 0, 10).toFixed(2)),
    headline: firstLine(risk.headline, 'Risk assessment available'),
    keySignals: (risk.signals || []).slice(0, 6),
    likelyInjuries,
    continueRiskSummary: buildContinueRiskSummary(playerName, likelyInjuries),
  };
};

const buildFatigueStructuredOutput = (
  input: OrchestrateRequest,
  fatigue: OrchestrateResponse['fatigue'] | undefined,
  activePlayer: RosterPlayerContext | undefined
): FatigueAgentOutput | undefined => {
  if (!fatigue) return undefined;
  const fatigueNow = Number(
    clamp(
      safeNumber(activePlayer?.live?.fatigueIndex, safeNumber(fatigue.echo?.fatigueIndex, 0)),
      0,
      10
    ).toFixed(1)
  );
  const intensity = String(input.context?.match?.intensity || 'Medium').toLowerCase();
  const recoveryScore = safeNumber(activePlayer?.baseline?.recoveryScore, 45);
  const sleepHours = safeNumber(activePlayer?.baseline?.sleepHours, 7);
  const intensityDelta = intensity === 'high' ? 0.7 : intensity === 'low' ? 0.3 : 0.5;
  const recoveryRelief = recoveryScore >= 55 ? 0.15 : recoveryScore < 30 ? -0.15 : 0;
  const sleepRelief = sleepHours >= 7 ? 0.1 : sleepHours < 6 ? -0.1 : 0;
  const netDelta = intensityDelta - recoveryRelief - sleepRelief;

  const projectionNextOvers = Array.from({ length: 6 }, (_, index) =>
    Number(clamp(fatigueNow + netDelta * index, 0, 10).toFixed(1))
  );

  const recoveryAdvice = [
    firstLine(fatigue.recommendation, 'Monitor fatigue trend over the next over.'),
    firstLine(fatigue.suggestedTweaks?.notes, 'Use short recovery window before the next spell.'),
  ]
    .filter(Boolean)
    .slice(0, 3);

  return {
    fatigueNow,
    projectionNextOvers,
    recoveryAdvice,
  };
};

const buildTacticalStructuredOutput = (
  input: OrchestrateRequest,
  tactical: OrchestrateResponse['tactical'] | undefined,
  safetyRank: ReturnType<typeof rankSafetyCandidates>
): TacticalAgentStructuredOutput => {
  const matchMode = normalizeMatchMode(input.context?.match?.matchMode);
  const recommendationMode: 'BATTING' | 'BOWLING' = matchMode === 'BAT' ? 'BATTING' : 'BOWLING';
  const nextSafeBowler = selectCandidate(
    safetyRank.nextSafeBowler,
    'No eligible bowler available in roster',
    'Role filter found no bowling-capable replacement in the current roster.'
  );
  const nextSafeBatter = selectCandidate(
    safetyRank.nextSafeBatter,
    'No eligible batter available in roster',
    'Role filter found no batting-capable replacement in the current roster.'
  );

  const defaultActionSteps =
    matchMode === 'BAT'
      ? [
          'Adjust batting tempo and strike rotation over the next over.',
          nextSafeBatter.playerId === 'NONE'
            ? 'No eligible next batter is available from the current roster if a wicket falls.'
            : `If wicket falls next, send ${nextSafeBatter.name} as the safest batting option.`,
          'Re-check pressure and injury signals after one over.',
        ]
      : [
          nextSafeBowler.playerId === 'NONE'
            ? 'No eligible bowler is available from the current roster for the next over.'
            : `Use ${nextSafeBowler.name} for the next over to reduce immediate workload risk.`,
          'Set a defensive field plan that protects execution quality under pressure.',
          'Re-check live fatigue and risk after one over.',
        ];

  return {
    headline: firstLine(tactical?.immediateAction, 'Tactical safety rotation'),
    nextSafeBowler,
    nextSafeBatter,
    benchOptions: safetyRank.benchOptions
      .filter((candidate) => {
        const rosterEntry = input.context?.roster?.find((player) => player.playerId === candidate.playerId);
        return rosterEntry ? isEligibleForMode(rosterEntry, recommendationMode) : false;
      })
      .slice(0, 2)
      .map((candidate) => ({
        playerId: candidate.playerId,
        name: candidate.name,
        reason: candidate.reason,
      })),
    actionSteps: (tactical?.suggestedAdjustments || defaultActionSteps).slice(0, 3),
  };
};

const buildFinalRecommendation = (args: {
  input: OrchestrateRequest;
  routerDecision: RouterDecision;
  riskOutput?: RiskAgentOutput;
  fatigueOutput?: FatigueAgentOutput;
  tacticalOutput: TacticalAgentStructuredOutput;
  activePlayer?: RosterPlayerContext;
}): FinalRecommendation => {
  const { input, routerDecision, riskOutput, fatigueOutput, tacticalOutput, activePlayer } = args;
  const match = input.context?.match;
  const matchMode = normalizeMatchMode(match?.matchMode);
  const format = String(match?.format || 'Match');
  const phase = String(match?.phase || 'Middle');
  const scoreRuns = safeNumber(match?.scoreRuns, 0);
  const wickets = safeNumber(match?.wickets, 0);
  const overs = safeNumber(match?.overs, 0);
  const targetRuns = safeNumber(match?.targetRuns, 0);
  const requiredRate = safeNumber(match?.requiredRunRate, 0);
  const activeName = String(activePlayer?.name || 'Current active player');
  const activeId = String(activePlayer?.playerId || 'UNKNOWN');
  const fatigueIndex = safeNumber(activePlayer?.live?.fatigueIndex, 0);
  const strainIndex = safeNumber(activePlayer?.live?.strainIndex, 0);
  const injuryRisk = normalizeRisk(activePlayer?.live?.injuryRisk);
  const noBallRisk = normalizeRisk(activePlayer?.live?.noBallRisk);

  const signals: string[] = [];
  if (fatigueIndex >= 6) signals.push(`fatigue ${fatigueIndex.toFixed(1)}/10`);
  if (strainIndex >= 3 || strainIndex >= 6) signals.push(`strain ${strainIndex.toFixed(1)}`);
  if (injuryRisk === 'HIGH') signals.push('injury risk HIGH');
  if (noBallRisk === 'HIGH') signals.push('no-ball risk HIGH');
  if (signals.length === 0) signals.push('live workload drift signals');

  const likelyInjuries = riskOutput?.likelyInjuries || mapLikelyInjuries(activePlayer, input.context?.match);
  const continueRiskSummary =
    riskOutput?.continueRiskSummary || buildContinueRiskSummary(activeName, likelyInjuries);

  const matchSituation = `${format} ${phase}: ${scoreRuns}/${wickets} after ${overs.toFixed(1)} overs` +
    (targetRuns > 0 ? ` chasing ${targetRuns}` : '') +
    (requiredRate > 0 ? ` (Req RR ${requiredRate.toFixed(2)})` : '');

  const injurySnippet =
    likelyInjuries.length > 0
      ? likelyInjuries
          .slice(0, 2)
          .map((injury) => injury.type)
          .join(' and ')
      : 'soft-tissue overload';

  const hasEligibleBowler = tacticalOutput.nextSafeBowler.playerId !== 'NONE';
  const hasEligibleBatter = tacticalOutput.nextSafeBatter.playerId !== 'NONE';
  const bowlerGuidance = hasEligibleBowler
    ? `Next safest bowler is ${tacticalOutput.nextSafeBowler.name}.`
    : 'No eligible bowler available in roster.';
  const batterGuidance =
    hasEligibleBatter
      ? `If wicket falls next, send ${tacticalOutput.nextSafeBatter.name} as the safest batter option.`
      : 'No eligible batter available in roster if wicket falls.';

  const statement =
    matchMode === 'BAT'
      ? [
          `${matchSituation}.`,
          `${activeName} is showing safety pressure on ${signals.join(', ')}; adjust batting plan now with tighter tempo and strike rotation rather than forcing high-risk shots.`,
          batterGuidance,
          `If ${activeName} continues unchanged, there is increased risk of ${injurySnippet}.`,
        ].join(' ')
      : [
          `${matchSituation}.`,
          `${activeName} is trending unsafe on ${signals.join(', ')}; move to a safer bowling option now.`,
          bowlerGuidance,
          `If ${activeName} continues, there is increased risk of ${injurySnippet}.`,
        ].join(' ');

  const confidence = confidenceFromSignals(
    safeNumber(riskOutput?.riskLevel, fatigueIndex),
    safeNumber(fatigueOutput?.fatigueNow, fatigueIndex),
    routerDecision.intent
  );

  return {
    title: matchMode === 'BAT' ? `Batting plan adjustment for ${activeName}` : `Bowling safety rotation for ${activeName}`,
    statement,
    nextSafeBowler: tacticalOutput.nextSafeBowler,
    nextSafeBatter: tacticalOutput.nextSafeBatter,
    ifContinues: {
      playerId: activeId,
      name: activeName,
      riskSummary: continueRiskSummary,
      likelyInjuries,
    },
    confidence,
  };
};

const mergeFinalOutcome = (args: {
  context: FullMatchContext;
  routerDecision: RouterDecision;
  agentAOutput?: RiskAgentOutput | FatigueAgentOutput;
  agentBOutput?: RiskAgentOutput | FatigueAgentOutput;
  tacticalOutput: TacticalAgentStructuredOutput;
  activePlayer?: RosterPlayerContext;
  requestInput: OrchestrateRequest;
}): FinalRecommendation => {
  const riskOutput = [args.agentAOutput, args.agentBOutput].find((entry): entry is RiskAgentOutput =>
    Boolean(entry && typeof entry === 'object' && 'riskLevel' in entry)
  );
  const fatigueOutput = [args.agentAOutput, args.agentBOutput].find((entry): entry is FatigueAgentOutput =>
    Boolean(entry && typeof entry === 'object' && 'fatigueNow' in entry)
  );

  return buildFinalRecommendation({
    input: {
      ...args.requestInput,
      context: args.context,
    },
    routerDecision: args.routerDecision,
    riskOutput,
    fatigueOutput,
    tacticalOutput: args.tacticalOutput,
    activePlayer: args.activePlayer,
  });
};

const NO_ELIGIBLE_REPLACEMENT_MESSAGE = 'No eligible replacement available for current mode.';

const resolveModeScopedRecommendation = (args: {
  input: OrchestrateRequest;
  finalRecommendation: FinalRecommendation;
  safetyRank: ReturnType<typeof rankSafetyCandidates>;
}): {
  mode: 'BATTING' | 'BOWLING';
  selected?: { playerId: string; name: string; reason: string };
  eligibleCandidates: Array<{ playerId: string; name: string; reason: string }>;
} => {
  const mode = toTeamMode(args.input.teamMode || args.input.matchContext?.teamMode || args.input.context?.match?.matchMode);
  const roster = args.input.context?.roster || [];
  const activePlayerId = args.input.context?.activePlayerId;
  const ranked = mode === 'BATTING' ? args.safetyRank.batterCandidates : args.safetyRank.bowlerCandidates;
  const eligibleCandidates = ranked
    .filter((candidate) => {
      const rosterEntry = roster.find((player) => player.playerId === candidate.playerId);
      return rosterEntry ? isEligibleForMode(rosterEntry, mode) : false;
    })
    .map((candidate) => ({
      playerId: candidate.playerId,
      name: candidate.name,
      reason: candidate.reason,
    }));

  const preferred = mode === 'BATTING' ? args.finalRecommendation.nextSafeBatter : args.finalRecommendation.nextSafeBowler;
  const preferredRosterEntry = roster.find((player) => player.playerId === preferred.playerId);
  if (
    preferred.playerId &&
    preferred.playerId !== 'NONE' &&
    preferredRosterEntry &&
    isEligibleForMode(preferredRosterEntry, mode)
  ) {
    return {
      mode,
      selected: {
        playerId: preferred.playerId,
        name: preferred.name,
        reason: preferred.reason,
      },
      eligibleCandidates,
    };
  }

  const rankedFallback = eligibleCandidates[0];
  if (rankedFallback) {
    return {
      mode,
      selected: rankedFallback,
      eligibleCandidates,
    };
  }

  const rosterFallback = roster.find(
    (player) => player.playerId !== activePlayerId && isEligibleForMode(player, mode)
  );
  if (rosterFallback) {
    return {
      mode,
      selected: {
        playerId: rosterFallback.playerId,
        name: rosterFallback.name,
        reason: 'Mode-validation fallback replacement from eligible roster.',
      },
      eligibleCandidates,
    };
  }

  return {
    mode,
    selected: undefined,
    eligibleCandidates,
  };
};

export async function orchestrateAgents(input: OrchestrateRequest, context: InvocationContext): Promise<OrchestrateResponse> {
  logAzureEnv(context);
  const requestId = randomUUID();
  const mode: 'auto' | 'full' = input.mode === 'full' ? 'full' : 'auto';
  const intent: OrchestrateIntent = input.intent || 'monitor';
  const startedAt = Date.now();
  const timingsMs: OrchestrateResponse['meta']['timingsMs'] = { total: 0 };
  const errors: AgentError[] = [];
  const fallbacksUsed: string[] = [];
  const aoai = getAoaiConfig();

  let fatigue: OrchestrateResponse['fatigue'];
  let risk: OrchestrateResponse['risk'];
  let tactical: OrchestrateResponse['tactical'];
  let fatigueModel = 'n/a';
  let riskModel = 'n/a';
  let tacticalModel = 'n/a';

  const contextDerivedInput = deriveRuntimeInputFromContext(input);
  const replacementCandidates =
    Array.isArray(contextDerivedInput.replacementCandidates) && contextDerivedInput.replacementCandidates.length > 0
      ? contextDerivedInput.replacementCandidates
      : buildReplacementCandidates(contextDerivedInput, 3);

  const inputWithContext: OrchestrateRequest = {
    ...contextDerivedInput,
    replacementCandidates,
  };

  const routerDecisionRaw = runModelRouter(inputWithContext.context as FullMatchContext, inputWithContext, mode, requestId);
  const forceAllAgents = mode === 'full';
  const routerSelectedAgents = normalizeSelectedLegacyAgents(
    Array.isArray(routerDecisionRaw.selectedAgents) && routerDecisionRaw.selectedAgents.length > 0
      ? routerDecisionRaw.selectedAgents
      : toLegacyAgents(routerDecisionRaw.agentsToRun)
  );
  const selectedAgents = forceAllAgents
    ? (['fatigue', 'risk', 'tactical'] as LegacyAgentId[])
    : (routerSelectedAgents.length > 0 ? routerSelectedAgents : (['tactical'] as LegacyAgentId[]));
  const routerDecision: RouterDecision = {
    ...routerDecisionRaw,
    mode,
    agentsToRun: selectedAgents.map((agent) => toAgentCode(agent)),
    selectedAgents,
    reason: routerDecisionRaw.reason,
  };
  const selectedSet = new Set<LegacyAgentId>(routerDecision.selectedAgents);
  const runFlags = {
    fatigue: selectedSet.has('fatigue') && isAgentEnabled(inputWithContext, 'fatigue'),
    risk: selectedSet.has('risk') && isAgentEnabled(inputWithContext, 'risk'),
    tactical: selectedSet.has('tactical') && isAgentEnabled(inputWithContext, 'tactical'),
  };
  const executedAgents: LegacyAgentId[] = (['fatigue', 'risk', 'tactical'] as const).filter((agent) => runFlags[agent]);
  context.log('[orchestrate] routing', {
    mode,
    intent: routerDecision.intent,
    forceAllAgents,
    agentsToRun: routerDecision.selectedAgents,
    executedAgents,
  });
  const settledErrorMessage = (reason: unknown, fallback: string): string =>
    reason instanceof Error ? reason.message : fallback;

  const fatiguePromise: Promise<FatigueAgentRunResult | undefined> = runFlags.fatigue
    ? (async () => {
        const fatigueStart = Date.now();
        try {
          const result = await runFatigueAgentFromContext(inputWithContext, `${inputWithContext.telemetry.playerId}:${Date.now()}`);
          timingsMs.fatigue = Date.now() - fatigueStart;
          return result;
        } catch (error) {
          timingsMs.fatigue = Date.now() - fatigueStart;
          const message = error instanceof Error ? error.message : 'Fatigue agent failed';
          context.error('orchestrator fatigue failed', { requestId, message });
          errors.push({ agent: 'fatigue', message });
          return buildFatigueFallback(toFatigueRequest(inputWithContext, `${inputWithContext.telemetry.playerId}:${Date.now()}`), `orchestrator-error:${message}`);
        }
      })()
    : Promise.resolve(undefined);

  const riskPromise: Promise<RiskAgentRunResult | undefined> = runFlags.risk
    ? (async () => {
        const riskStart = Date.now();
        try {
          const result = await runRiskAgentFromContext(inputWithContext);
          timingsMs.risk = Date.now() - riskStart;
          return result;
        } catch (error) {
          timingsMs.risk = Date.now() - riskStart;
          const message = error instanceof Error ? error.message : 'Risk agent failed';
          context.error('orchestrator risk failed', { requestId, message });
          errors.push({ agent: 'risk', message });
          return buildRiskFallback(toRiskRequest(inputWithContext), `orchestrator-error:${message}`);
        }
      })()
    : Promise.resolve(undefined);

  const tacticalPromise = runFlags.tactical
    ? (async () => {
        const tacticalStart = Date.now();
        const [fatigueSettled, riskSettled] = await Promise.allSettled([fatiguePromise, riskPromise]);
        const fatigueResult =
          fatigueSettled.status === 'fulfilled'
            ? fatigueSettled.value
            : buildFatigueFallback(
                toFatigueRequest(inputWithContext, `${inputWithContext.telemetry.playerId}:${Date.now()}`),
                `orchestrator-error:${settledErrorMessage(fatigueSettled.reason, 'Fatigue dependency failed')}`
              );
        const riskResult =
          riskSettled.status === 'fulfilled'
            ? riskSettled.value
            : buildRiskFallback(
                toRiskRequest(inputWithContext),
                `orchestrator-error:${settledErrorMessage(riskSettled.reason, 'Risk dependency failed')}`
              );
        if (fatigueSettled.status === 'rejected') {
          const message = settledErrorMessage(fatigueSettled.reason, 'Fatigue dependency failed');
          context.error('orchestrator fatigue dependency failed', { requestId, message });
          errors.push({ agent: 'fatigue', message });
        }
        if (riskSettled.status === 'rejected') {
          const message = settledErrorMessage(riskSettled.reason, 'Risk dependency failed');
          context.error('orchestrator risk dependency failed', { requestId, message });
          errors.push({ agent: 'risk', message });
        }
        try {
          const result = await runTacticalAgentFromContext({
            requestId,
            intent,
            requestInput: inputWithContext,
            fatigueOutput: fatigueResult?.output,
            riskOutput: riskResult?.output,
            replacementCandidates,
          });
          timingsMs.tactical = Date.now() - tacticalStart;
          return result;
        } catch (error) {
          timingsMs.tactical = Date.now() - tacticalStart;
          const message = error instanceof Error ? error.message : 'Tactical agent failed';
          context.error('orchestrator tactical failed', { requestId, message });
          errors.push({ agent: 'tactical', message });
          return buildTacticalFallback(
            {
              requestId,
              intent,
              matchContext: inputWithContext.matchContext,
              telemetry: inputWithContext.telemetry,
              players: inputWithContext.players,
              fatigueOutput: fatigueResult?.output,
              riskOutput: riskResult?.output,
              context: inputWithContext.context,
              replacementCandidates,
            },
            `orchestrator-error:${message}`
          );
        }
      })()
    : Promise.resolve(undefined);

  const [fatigueSettled, riskSettled, tacticalSettled] = await Promise.allSettled([
    fatiguePromise,
    riskPromise,
    tacticalPromise,
  ]);

  let fatigueResult =
    fatigueSettled.status === 'fulfilled'
      ? fatigueSettled.value
      : undefined;
  if (fatigueSettled.status === 'rejected' && runFlags.fatigue) {
    const message = settledErrorMessage(fatigueSettled.reason, 'Fatigue agent failed');
    context.error('orchestrator fatigue failed (settled)', { requestId, message });
    errors.push({ agent: 'fatigue', message });
    fatigueResult = buildFatigueFallback(
      toFatigueRequest(inputWithContext, `${inputWithContext.telemetry.playerId}:${Date.now()}`),
      `orchestrator-error:${message}`
    );
  }

  let riskResult =
    riskSettled.status === 'fulfilled'
      ? riskSettled.value
      : undefined;
  if (riskSettled.status === 'rejected' && runFlags.risk) {
    const message = settledErrorMessage(riskSettled.reason, 'Risk agent failed');
    context.error('orchestrator risk failed (settled)', { requestId, message });
    errors.push({ agent: 'risk', message });
    riskResult = buildRiskFallback(
      toRiskRequest(inputWithContext),
      `orchestrator-error:${message}`
    );
  }

  let tacticalResult =
    tacticalSettled.status === 'fulfilled'
      ? tacticalSettled.value
      : undefined;
  if (tacticalSettled.status === 'rejected' && runFlags.tactical) {
    const message = settledErrorMessage(tacticalSettled.reason, 'Tactical agent failed');
    context.error('orchestrator tactical failed (settled)', { requestId, message });
    errors.push({ agent: 'tactical', message });
    tacticalResult = buildTacticalFallback(
      {
        requestId,
        intent,
        matchContext: inputWithContext.matchContext,
        telemetry: inputWithContext.telemetry,
        players: inputWithContext.players,
        fatigueOutput: fatigueResult?.output,
        riskOutput: riskResult?.output,
        context: inputWithContext.context,
        replacementCandidates,
      },
      `orchestrator-error:${message}`
    );
  }

  if (fatigueResult) {
    fatigue = {
      ...fatigueResult.output,
      status: fatigueResult.output.status || (fatigueResult.fallbacksUsed.length > 0 ? 'fallback' : 'ok'),
    };
    fatigueModel = fatigueResult.model;
    fallbacksUsed.push(...fatigueResult.fallbacksUsed);
  }

  if (riskResult) {
    risk = {
      ...riskResult.output,
      status: riskResult.output.status || (riskResult.fallbacksUsed.length > 0 ? 'fallback' : 'ok'),
    };
    riskModel = riskResult.model;
    fallbacksUsed.push(...riskResult.fallbacksUsed);
  }

  if (tacticalResult) {
    tactical = tacticalResult.output;
    tacticalModel = tacticalResult.model;
    fallbacksUsed.push(...tacticalResult.fallbacksUsed);
  }

  timingsMs.total = Date.now() - startedAt;

  const activePlayer = getActivePlayerContext(inputWithContext);
  const fullContext: FullMatchContext | undefined = inputWithContext.context;
  const safetyRank = fullContext
    ? rankSafetyCandidates(fullContext, { activePlayerId: fullContext.activePlayerId, limit: 3 })
    : {
        nextSafeBowler: undefined,
        nextSafeBatter: undefined,
        bowlerCandidates: [],
        batterCandidates: [],
        benchOptions: [],
      };

  const riskStructured = buildRiskStructuredOutput(inputWithContext, risk, activePlayer);
  const fatigueStructured = buildFatigueStructuredOutput(inputWithContext, fatigue, activePlayer);
  const tacticalStructured = buildTacticalStructuredOutput(inputWithContext, tactical, safetyRank);

  const finalRecommendation = mergeFinalOutcome({
    context: inputWithContext.context as FullMatchContext,
    routerDecision,
    agentAOutput: riskStructured,
    agentBOutput: fatigueStructured,
    tacticalOutput: tacticalStructured,
    activePlayer,
    requestInput: inputWithContext,
  });
  const recommendationMode = toTeamMode(
    inputWithContext.teamMode || inputWithContext.matchContext?.teamMode || inputWithContext.context?.match?.matchMode
  );
  const recommendationGuard = resolveModeScopedRecommendation({
    input: inputWithContext,
    finalRecommendation,
    safetyRank,
  });
  const guardedFinalRecommendation: FinalRecommendation = {
    ...finalRecommendation,
    ...(recommendationGuard.mode === 'BOWLING'
      ? {
          nextSafeBowler: recommendationGuard.selected || {
            playerId: 'NONE',
            name: NO_ELIGIBLE_REPLACEMENT_MESSAGE,
            reason: `Mode guard: no eligible bowling-capable replacement found.`,
          },
        }
      : {
          nextSafeBatter: recommendationGuard.selected || {
            playerId: 'NONE',
            name: NO_ELIGIBLE_REPLACEMENT_MESSAGE,
            reason: `Mode guard: no eligible batting-capable replacement found.`,
          },
        }),
  };
  context.log('orchestrate recommendation guard', {
    mode: recommendationGuard.mode,
    selectedPlayerId: recommendationGuard.selected?.playerId || 'NONE',
  });
  const noEligibleModeReplacement = !recommendationGuard.selected;
  const eligibleCandidateList = recommendationGuard.eligibleCandidates.map((candidate) => candidate.name);
  const noEligibleMessageWithCandidates = `${NO_ELIGIBLE_REPLACEMENT_MESSAGE} Eligible candidates: ${
    eligibleCandidateList.length > 0 ? eligibleCandidateList.join(', ') : 'None'
  }.`;
  const modeScopedSuggestionLine =
    recommendationMode === 'BATTING'
      ? noEligibleModeReplacement
        ? noEligibleMessageWithCandidates
        : `Next batter (if wicket falls): ${guardedFinalRecommendation.nextSafeBatter.name} (${guardedFinalRecommendation.nextSafeBatter.reason})`
      : noEligibleModeReplacement
        ? noEligibleMessageWithCandidates
        : `Next safe bowler: ${guardedFinalRecommendation.nextSafeBowler.name} (${guardedFinalRecommendation.nextSafeBowler.reason})`;

  const combinedDecision = {
    immediateAction: guardedFinalRecommendation.title,
    substitutionAdvice:
      (routerDecision.intent === 'SUBSTITUTION' || routerDecision.intent === 'SAFETY_ALERT') &&
      recommendationMode === 'BOWLING' &&
      !noEligibleModeReplacement
        ? {
            out: String(activePlayer?.name || inputWithContext.telemetry.playerName || 'Current player'),
            in: guardedFinalRecommendation.nextSafeBowler.name,
            reason: guardedFinalRecommendation.ifContinues.riskSummary,
          }
        : undefined,
    suggestedAdjustments:
      [guardedFinalRecommendation.statement, modeScopedSuggestionLine],
    confidence: normalizeConfidenceToScore(finalRecommendation.confidence),
    rationale: `Router intent ${routerDecision.intent}; agents run: ${
      executedAgents.length > 0 ? executedAgents.join(' + ') : 'none'
    }.`,
  };
  const subject = String(activePlayer?.name || inputWithContext.telemetry.playerName || 'the active player');
  const fatigueNow = safeNumber(activePlayer?.live?.fatigueIndex, Number.NaN);
  const baselineSleep = safeNumber(activePlayer?.baseline?.sleepHours, Number.NaN);
  const baselineRecovery = safeNumber(activePlayer?.baseline?.recoveryScore, Number.NaN);
  const baselineFatigueLimit = safeNumber(activePlayer?.baseline?.fatigueLimit, Number.NaN);
  const usedBaseline =
    Number.isFinite(baselineSleep) || Number.isFinite(baselineRecovery) || Number.isFinite(baselineFatigueLimit);
  const sleepConstrained = Number.isFinite(baselineSleep) ? baselineSleep < 7 : false;
  const recoveryConstrained = Number.isFinite(baselineRecovery) ? baselineRecovery < 50 : false;
  const lowCeiling = Number.isFinite(baselineFatigueLimit) ? baselineFatigueLimit <= 6 : false;
  const nearCeiling =
    Number.isFinite(baselineFatigueLimit) && Number.isFinite(fatigueNow)
      ? fatigueNow >= baselineFatigueLimit - 0.8
      : false;
  const baselineConstrained = sleepConstrained || recoveryConstrained || lowCeiling || nearCeiling;
  const baselineLine = usedBaseline
    ? [
        Number.isFinite(baselineSleep)
          ? `Given ${subject} only had ~${baselineSleep.toFixed(1)}h sleep today, control under pressure is easier to lose.`
          : null,
        Number.isFinite(baselineRecovery)
          ? `Recovery window today is ~${Math.round(baselineRecovery)}min, so repeated efforts carry more residual load.`
          : null,
        Number.isFinite(baselineFatigueLimit)
          ? `Fatigue ceiling for this player is ${baselineFatigueLimit.toFixed(1)}/10, and this spell is already too close to that cap.`
          : null,
      ]
        .filter((entry): entry is string => Boolean(entry))
        .join(' ')
    : 'Baseline not available — using live telemetry only.';
  const strategicSignals = (() => {
    const bullets: string[] = [];
    const fatigueSignal = safeNumber(routerDecision.signals?.fatigueIndex, Number.NaN);
    const strainSignal = safeNumber(routerDecision.signals?.strainIndex, Number.NaN);
    const noBallSignal = String(routerDecision.signals?.noBallRisk || '').toUpperCase();
    const injurySignal = String(routerDecision.signals?.injuryRisk || '').toUpperCase();
    const hrrSignal = String(routerDecision.signals?.heartRateRecovery || '').toLowerCase();
    if (Number.isFinite(fatigueSignal) && fatigueSignal >= 6.5) bullets.push('Fatigue is approaching the upper workload limit.');
    else if (Number.isFinite(fatigueSignal) && fatigueSignal >= 5) bullets.push('Fatigue is trending upward from recent workload.');
    if (Number.isFinite(strainSignal) && strainSignal >= 5.5) bullets.push('Strain trend is elevated and may affect mechanics.');
    if (injurySignal === 'HIGH') bullets.push('Injury exposure is elevated if the current pattern continues.');
    if (noBallSignal === 'HIGH') bullets.push('No-ball control risk is elevated under pressure.');
    if (hrrSignal.includes('poor') || hrrSignal.includes('slow')) bullets.push('Recovery response is lagging between efforts.');
    if (bullets.length === 0) bullets.push('Signal profile is currently stable; tactical control remains the priority.');
    return bullets.slice(0, 7);
  })();
  const decisiveRiskLine = baselineConstrained
    ? 'Decision stance: intervene now to break the overload chain before the next over compounds risk.'
    : 'Decision stance: continue only under strict one-over constraints and immediate reassessment.';
  const coachNote = baselineConstrained
    ? `Tonight’s risk is not the next ball, it is the next over. Rotate ${subject} now to protect both control and late-innings availability.`
    : `The profile supports one controlled phase, not a free extension. Keep discipline high and reassess immediately.`;
  const strategicAnalysis = {
    signals: strategicSignals,
    fatigueAnalysis:
      fatigueStructured
        ? `${baselineLine} ${fatigueStructured.recoveryAdvice[0] || 'Fatigue trend reviewed for this phase.'} ${fatigueStructured.recoveryAdvice[1] || ''} ${baselineConstrained ? `Recommendation: rotate ${subject} now or cap to one controlled over.` : `Recommendation: allow one controlled over and reassess immediately.`}`.trim()
        : `${baselineLine} ${baselineConstrained ? `Recommendation: rotate ${subject} now or cap to one controlled over.` : `Recommendation: allow one controlled over and reassess immediately.`}`.trim(),
    injuryRiskAnalysis:
      riskStructured
        ? `${riskStructured.headline}. ${baselineLine} ${riskStructured.likelyInjuries.length > 0 ? `Likely injury types include ${riskStructured.likelyInjuries.slice(0, 3).map((injury) => injury.type).join(', ')}.` : ''} This usually means mechanics drift under fatigue and overload shifts into vulnerable tissues such as hamstring, lower-back, side strain/oblique, and shoulder structures. ${decisiveRiskLine}`
        : `Injury risk profile remains manageable, but repeated high-intensity spells can still create preventable exposure. ${baselineLine} ${decisiveRiskLine}`.trim(),
    tacticalRecommendation: {
      nextAction: combinedDecision.immediateAction,
      why: `${baselineLine} ${combinedDecision.rationale} ${decisiveRiskLine}`.trim(),
      ifIgnored: guardedFinalRecommendation.ifContinues.riskSummary,
      alternatives: combinedDecision.suggestedAdjustments.slice(0, 3),
    },
    coachNote,
    meta: {
      usedBaseline,
    },
  };

  const finalDecision = combinedDecision;

  const usedFallbackAgents: LegacyAgentId[] = [];
  if (fatigue?.status === 'fallback') usedFallbackAgents.push('fatigue');
  if (risk?.status === 'fallback') usedFallbackAgents.push('risk');
  if (tactical?.status === 'fallback') usedFallbackAgents.push('tactical');

  const fatigueStatus = toAgentStatus(fatigue?.status, runFlags.fatigue);
  const riskStatus = toAgentStatus(risk?.status, runFlags.risk);
  const tacticalStatus = toAgentStatus(tactical?.status, runFlags.tactical);
  const fatigueRoutedTo = toAgentRoute(fatigue?.status, fatigueModel);
  const riskRoutedTo = toAgentRoute(risk?.status, riskModel);
  const tacticalRoutedTo = toAgentRoute(tactical?.status, tacticalModel);
  const deriveRouteReason = (
    agent: LegacyAgentId,
    didRun: boolean,
    status: string | undefined,
    agentModel: string
  ): string => {
    if (!didRun) return 'disabled_by_request';
    if (status === 'fallback') {
      return `${agent}:fallback(${/^rule:|fallback/i.test(agentModel) ? 'openai_or_json_failure' : 'fallback'})`;
    }
    if (status === 'error') return `${agent}:error`;
    return `${agent}:llm_success`;
  };
  const routerAgentDetails: NonNullable<RouterDecision['agents']> = {
    fatigue: {
      routedTo: fatigueRoutedTo,
      reason: deriveRouteReason('fatigue', runFlags.fatigue, fatigue?.status, fatigueModel),
    },
    risk: {
      routedTo: riskRoutedTo,
      reason: deriveRouteReason('risk', runFlags.risk, risk?.status, riskModel),
    },
    tactical: {
      routedTo: tacticalRoutedTo,
      reason: deriveRouteReason('tactical', runFlags.tactical, tactical?.status, tacticalModel),
    },
  };
  const routerDecisionWithRoutes: RouterDecision = {
    ...routerDecision,
    mode,
    agents: routerAgentDetails,
  };

  context.log(`[router] fatigue -> ${runFlags.fatigue ? fatigueRoutedTo : 'rules'} (reason: ${
    runFlags.fatigue
      ? fatigue?.status === 'fallback'
        ? 'openai_error'
        : 'agent_success'
      : 'disabled_by_request'
  })`);
  context.log(`[router] risk -> ${runFlags.risk ? riskRoutedTo : 'rules'} (reason: ${
    runFlags.risk
      ? risk?.status === 'fallback'
        ? 'openai_error'
        : 'agent_success'
      : 'disabled_by_request'
  })`);
  context.log(`[router] tactical -> ${runFlags.tactical ? tacticalRoutedTo : 'rules'} (reason: ${
    runFlags.tactical
      ? tactical?.status === 'fallback'
        ? 'openai_error'
        : 'agent_success'
      : 'disabled_by_request'
  })`);

  const agentResults: OrchestrateResponse['agentResults'] = {
    fatigue: {
      status: toAgentResultStatus(fatigue?.status, runFlags.fatigue, Boolean(fatigue)),
      routedTo: fatigueRoutedTo,
      ...(fatigue ? { output: fatigue as unknown as Record<string, unknown> } : {}),
      ...(!runFlags.fatigue
        ? { error: 'Agent explicitly disabled by request.' }
        : !fatigue
          ? { error: errors.find((entry) => entry.agent === 'fatigue')?.message || 'Fatigue analysis unavailable.' }
          : {}),
    },
    risk: {
      status: toAgentResultStatus(risk?.status, runFlags.risk, Boolean(risk)),
      routedTo: riskRoutedTo,
      ...(risk ? { output: risk as unknown as Record<string, unknown> } : {}),
      ...(!runFlags.risk
        ? { error: 'Agent explicitly disabled by request.' }
        : !risk
          ? { error: errors.find((entry) => entry.agent === 'risk')?.message || 'Risk analysis unavailable.' }
          : {}),
    },
    tactical: {
      status: toAgentResultStatus(tactical?.status, runFlags.tactical, Boolean(tactical)),
      routedTo: tacticalRoutedTo,
      ...(tactical ? { output: tactical as unknown as Record<string, unknown> } : {}),
      ...(!runFlags.tactical
        ? { error: 'Agent explicitly disabled by request.' }
        : !tactical
          ? { error: errors.find((entry) => entry.agent === 'tactical')?.message || 'Tactical analysis unavailable.' }
          : {}),
    },
  };

  const agentsRun: AgentCode[] = (['FATIGUE', 'RISK', 'TACTICAL'] as const).filter((agent) => {
    if (agent === 'FATIGUE') return runFlags.fatigue;
    if (agent === 'RISK') return runFlags.risk;
    return runFlags.tactical;
  });

  const triggers = computeTriggers(inputWithContext);
  const contextSummary = deriveContextSummary(inputWithContext.context as FullMatchContext);

  return {
    ...(fatigue ? { fatigue } : {}),
    ...(risk ? { risk } : {}),
    ...(tactical ? { tactical } : {}),
    agentOutputs: {
      ...(fatigue ? { fatigue: { ...fatigue, status: fatigue.status || 'ok' } } : {}),
      ...(risk ? { risk: { ...risk, status: risk.status || 'ok' } } : {}),
      ...(tactical ? { tactical } : {}),
    },
    finalDecision,
    combinedDecision,
    strategicAnalysis,
    finalRecommendation: guardedFinalRecommendation,
    ...(recommendationGuard.mode === 'BOWLING' && recommendationGuard.selected
      ? {
          recommendation: {
            bowlerId: recommendationGuard.selected.playerId,
            bowlerName: recommendationGuard.selected.name,
            reason: recommendationGuard.selected.reason,
          },
        }
      : {}),
    ...(recommendationGuard.selected
      ? {
          suggestedRotation: {
            playerId: recommendationGuard.selected.playerId,
            name: recommendationGuard.selected.name,
            rationale: recommendationGuard.selected.reason,
          },
        }
      : {}),
    structuredOutputs: {
      ...(riskStructured ? { risk: riskStructured } : {}),
      ...(fatigueStructured ? { fatigue: fatigueStructured } : {}),
      tactical: tacticalStructured,
    },
    agentsRun,
    contextSummary,
    ...(risk?.riskDebug ? { riskDebug: risk.riskDebug } : {}),
    errors,
    agents: {
      fatigue: { status: fatigueStatus },
      risk: { status: riskStatus },
      tactical: { status: tacticalStatus },
    },
    routerIntent: routerDecision.intent,
    router: {
      status: 'OK',
      intent: routerDecision.intent,
      run: runFlags,
      reason: routerDecision.reason,
    },
    agentResults,
    routerDecision: routerDecisionWithRoutes,
    meta: {
      requestId,
      mode,
      intent,
      executedAgents,
      triggers,
      suggestFullAnalysis: false,
      modelRouting: {
        fatigueModel,
        riskModel,
        tacticalModel,
        fallbacksUsed,
      },
      usedFallbackAgents,
      ...(aoai.ok ? {} : { aoai: { missing: aoai.missing } }),
      timingsMs,
    },
  };
}
