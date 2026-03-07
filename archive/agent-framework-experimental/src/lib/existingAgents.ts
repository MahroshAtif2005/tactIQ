import { randomUUID } from 'node:crypto';
import { fetch } from 'undici';

type AgentKey = 'fatigue' | 'risk' | 'tactical';
const ALL_AGENT_KEYS: AgentKey[] = ['fatigue', 'risk', 'tactical'];
type RouterIntent = 'InjuryPrevention' | 'PressureControl' | 'TacticalAttack' | 'General';
export type AgentFrameworkMode = 'route' | 'all';

type LooseRecord = Record<string, unknown>;

interface NormalizedTelemetry {
  playerId: string;
  playerName: string;
  role: string;
  fatigueIndex: number;
  strainIndex: number;
  heartRateRecovery: string;
  oversBowled: number;
  consecutiveOvers: number;
  injuryRisk: string;
  noBallRisk: string;
  fatigueLimit?: number;
  sleepHours?: number;
  recoveryMinutes?: number;
  isUnfit?: boolean;
}

interface NormalizedMatchContext {
  matchMode?: string;
  teamMode?: string;
  phase: string;
  requiredRunRate: number;
  currentRunRate: number;
  wicketsInHand: number;
  oversRemaining: number;
  format?: string;
  over?: number;
  intensity?: string;
  conditions?: string;
  target?: number;
  score?: number;
  balls?: number;
}

interface NormalizedPlayers {
  striker: string;
  nonStriker: string;
  bowler: string;
  bench?: string[];
}

interface NormalizedRequest {
  mode: 'auto' | 'full';
  intent: 'monitor' | 'substitution' | 'strategy' | 'full';
  telemetry: NormalizedTelemetry;
  matchContext: NormalizedMatchContext;
  players: NormalizedPlayers;
  rawPayload: LooseRecord;
}

interface RouterDecision {
  intent: RouterIntent;
  selectedAgents: AgentKey[];
  signalSummaryBullets: string[];
  rationale: string;
  reason?: string;
  signals?: Record<string, unknown>;
  rulesFired?: string[];
  inputsUsed?: Record<string, unknown>;
  fallbackRoutingUsed?: boolean;
  routerUnavailable?: boolean;
}

interface StrategicAnalysis {
  signals: string[];
  fatigueAnalysis: string;
  injuryRiskAnalysis: string;
  tacticalRecommendation: {
    nextAction: string;
    why: string;
    ifIgnored: string;
    alternatives: string[];
  };
  coachNote?: string;
  meta?: {
    usedBaseline: boolean;
  };
}

interface ModeEligibleCandidate {
  playerId: string;
  name: string;
  role?: string;
  reason?: string;
}

interface OrchestrateLikeResponse {
  fatigue?: Record<string, unknown>;
  risk?: Record<string, unknown>;
  tactical?: Record<string, unknown>;
  strategicAnalysis?: StrategicAnalysis;
  agentOutputs?: Record<string, unknown>;
  finalDecision?: Record<string, unknown>;
  combinedDecision: Record<string, unknown>;
  routerDecision?: RouterDecision;
  errors: Array<{ agent: AgentKey; message: string }>;
  meta: {
    requestId: string;
    mode: 'auto' | 'full';
    executedAgents: AgentKey[];
    modelRouting: {
      fatigueModel: string;
      riskModel: string;
      tacticalModel: string;
      fallbacksUsed: string[];
    };
    usedFallbackAgents?: AgentKey[];
    timingsMs: {
      fatigue?: number;
      risk?: number;
      tactical?: number;
      total: number;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

const asRecord = (value: unknown): LooseRecord => (value && typeof value === 'object' ? (value as LooseRecord) : {});
const toNumber = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const toOptionalNumber = (value: unknown): number | undefined => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, '');
const normalizeRoleToken = (value: string): string => value.replace(/[^A-Z]/g, '');
const BOWLING_ROLE_HINTS = ['BOWL', 'BOWLER', 'FAST', 'PACE', 'PACER', 'SEAM', 'SPIN', 'SPINNER', 'AR', 'ALLROUNDER'];
const BATTING_ROLE_HINTS = ['BAT', 'BATTER', 'BATSMAN', 'BATSMEN', 'WK', 'WICKETKEEPER', 'AR', 'ALLROUNDER'];
const toBooleanFlag = (value: unknown): boolean => {
  if (value === true) return true;
  if (value === false || value === undefined || value === null) return false;
  const token = String(value).trim().toLowerCase();
  return token === 'true' || token === '1' || token === 'yes';
};

function normalizeIntent(value: unknown): 'monitor' | 'substitution' | 'strategy' | 'full' {
  const parsed = String(value || 'monitor').toLowerCase();
  if (parsed === 'substitution' || parsed === 'strategy' || parsed === 'full') return parsed;
  return 'monitor';
}

function normalizeRequest(payloadInput: unknown): NormalizedRequest {
  const payload = asRecord(payloadInput);
  const telemetry = asRecord(payload.telemetry);
  const matchContext = asRecord(payload.matchContext);
  const players = asRecord(payload.players);

  const legacyPlayer = asRecord(payload.player);
  const legacyMatch = asRecord(payload.match);
  const legacyTactical = asRecord(legacyMatch.tactical);

  const hasNewSchema = Object.keys(telemetry).length > 0 && Object.keys(matchContext).length > 0;
  const sourceTelemetry = hasNewSchema ? telemetry : legacyPlayer;
  const sourceMatch = hasNewSchema
    ? matchContext
    : {
        phase: legacyTactical.phase ?? legacyMatch.phase,
        requiredRunRate: legacyTactical.requiredRunRate,
        currentRunRate: legacyTactical.currentRunRate,
        wicketsInHand: legacyTactical.wicketsInHand,
        oversRemaining: legacyTactical.oversRemaining,
        format: legacyMatch.format,
        over: legacyMatch.over,
        intensity: legacyMatch.intensity,
        conditions: legacyMatch.conditions,
        target: legacyMatch.target,
        score: legacyMatch.score,
        balls: legacyMatch.balls,
      };

  const normalized: NormalizedRequest = {
    mode: payload.mode === 'full' ? 'full' : 'auto',
    intent: normalizeIntent(payload.intent),
    telemetry: {
      playerId: String(sourceTelemetry.playerId || 'UNKNOWN'),
      playerName: String(sourceTelemetry.playerName || 'Unknown Player'),
      role: String(sourceTelemetry.role || 'Unknown Role'),
      fatigueIndex: clamp(toNumber(sourceTelemetry.fatigueIndex, 0), 0, 10),
      strainIndex: clamp(toNumber(sourceTelemetry.strainIndex, 0), 0, 10),
      heartRateRecovery: String(sourceTelemetry.heartRateRecovery || 'Moderate'),
      oversBowled: Math.max(0, toNumber(sourceTelemetry.oversBowled, 0)),
      consecutiveOvers: Math.max(0, toNumber(sourceTelemetry.consecutiveOvers, 0)),
      injuryRisk: String(sourceTelemetry.injuryRisk || 'MEDIUM').toUpperCase(),
      noBallRisk: String(sourceTelemetry.noBallRisk || 'MEDIUM').toUpperCase(),
      fatigueLimit: toOptionalNumber(sourceTelemetry.fatigueLimit),
      sleepHours: toOptionalNumber(sourceTelemetry.sleepHours),
      recoveryMinutes: toOptionalNumber(sourceTelemetry.recoveryMinutes),
      isUnfit: sourceTelemetry.isUnfit === true,
    },
    matchContext: {
      matchMode: sourceMatch.matchMode ? String(sourceMatch.matchMode) : undefined,
      teamMode: sourceMatch.teamMode ? String(sourceMatch.teamMode) : undefined,
      phase: String(sourceMatch.phase || 'middle').toLowerCase(),
      requiredRunRate: Math.max(0, toNumber(sourceMatch.requiredRunRate, 0)),
      currentRunRate: Math.max(0, toNumber(sourceMatch.currentRunRate, 0)),
      wicketsInHand: Math.max(0, toNumber(sourceMatch.wicketsInHand, 0)),
      oversRemaining: Math.max(0, toNumber(sourceMatch.oversRemaining, 0)),
      format: sourceMatch.format ? String(sourceMatch.format) : undefined,
      over: toOptionalNumber(sourceMatch.over),
      intensity: sourceMatch.intensity ? String(sourceMatch.intensity) : undefined,
      conditions: sourceMatch.conditions ? String(sourceMatch.conditions) : undefined,
      target: toOptionalNumber(sourceMatch.target),
      score: toOptionalNumber(sourceMatch.score),
      balls: toOptionalNumber(sourceMatch.balls),
    },
    players: {
      striker: String(players.striker || 'Striker'),
      nonStriker: String(players.nonStriker || 'Non-striker'),
      bowler: String(players.bowler || sourceTelemetry.playerName || 'Bowler'),
      bench: Array.isArray(players.bench) ? players.bench.map((entry) => String(entry)) : undefined,
    },
    rawPayload: payload,
  };

  return normalized;
}

function normalizeTeamMode(input: NormalizedRequest): 'BOWLING' | 'BATTING' {
  const rawPayload = asRecord(input.rawPayload);
  const rawMatchContext = asRecord(rawPayload.matchContext);
  const modeToken = String(
    rawPayload.teamMode ||
      rawMatchContext.teamMode ||
      rawMatchContext.matchMode ||
      input.matchContext.teamMode ||
      input.matchContext.matchMode ||
      ''
  )
    .trim()
    .toUpperCase();

  if (modeToken === 'BAT' || modeToken === 'BATTING') return 'BATTING';
  return 'BOWLING';
}

function includesRoleHint(role: unknown, hints: string[]): boolean {
  const normalized = normalizeRoleToken(String(role || '').trim().toUpperCase());
  if (!normalized) return false;
  return hints.some((hint) => {
    const normalizedHint = normalizeRoleToken(hint);
    return normalized.includes(normalizedHint);
  });
}

function isEligibleForMode(
  player: { role?: unknown; canBowl?: unknown; canBat?: unknown },
  mode: 'BOWLING' | 'BATTING'
): boolean {
  const roleImpliesBowling = includesRoleHint(player.role, BOWLING_ROLE_HINTS);
  const roleImpliesBatting = includesRoleHint(player.role, BATTING_ROLE_HINTS);
  const canBowl = toBooleanFlag(player.canBowl);
  const canBat = toBooleanFlag(player.canBat);
  if (mode === 'BOWLING') {
    return roleImpliesBowling && (canBowl || roleImpliesBowling);
  }
  return roleImpliesBatting && (canBat || roleImpliesBatting);
}

function buildModeEligibleCandidates(input: NormalizedRequest, limit = 3): ModeEligibleCandidate[] {
  const payload = asRecord(input.rawPayload);
  const context = asRecord(payload.context);
  const roster = Array.isArray(context.roster)
    ? context.roster.map((entry) => asRecord(entry))
    : [];
  const activePlayerId = String(context.activePlayerId || input.telemetry.playerId || '').trim();
  const mode = normalizeTeamMode(input);

  const candidates: ModeEligibleCandidate[] = roster
    .map((entry) => ({
      playerId: String(entry.playerId || '').trim(),
      name: String(entry.name || '').trim(),
      role: entry.role ? String(entry.role) : undefined,
      canBowl: entry.canBowl,
      canBat: entry.canBat,
    }))
    .filter((entry) => entry.playerId && entry.name)
    .filter((entry) => entry.playerId !== activePlayerId)
    .filter((entry) => isEligibleForMode(entry, mode))
    .map((entry) => ({
      playerId: entry.playerId,
      name: entry.name,
      role: entry.role,
      reason: `Mode-eligible ${mode.toLowerCase()} replacement candidate.`,
    }));

  return candidates.slice(0, Math.max(1, limit));
}

function summarizePayload(input: NormalizedRequest): { playerId: string; mode: 'BOWLING' | 'BATTING'; over: number; fatigue: number; strain: number } {
  return {
    playerId: input.telemetry.playerId,
    mode: normalizeTeamMode(input),
    over: Number(input.matchContext.over || 0),
    fatigue: Number(input.telemetry.fatigueIndex.toFixed(2)),
    strain: Number(input.telemetry.strainIndex.toFixed(2)),
  };
}

function buildSignalSummaryBullets(signals: Record<string, unknown>, mode: 'BOWLING' | 'BATTING'): string[] {
  const bullets: string[] = [];
  const fatigue = toNumber(signals.fatigueIndex, Number.NaN);
  const strain = toNumber(signals.strainIndex, Number.NaN);
  const noBallRisk = String(signals.noBallRisk || '').toUpperCase();
  const injuryRisk = String(signals.injuryRisk || '').toUpperCase();
  const hrr = String(signals.heartRateRecovery || '').toLowerCase();
  const sleepHours = toNumber(signals.sleepHours, Number.NaN);
  const oversBowled = toNumber(signals.oversBowled, Number.NaN);
  const pressure = toNumber(signals.pressureIndex, Number.NaN);
  const phase = String(signals.phase || '').toLowerCase();

  if (Number.isFinite(fatigue) && fatigue >= 6.5) bullets.push('Fatigue is approaching the upper workload limit.');
  else if (Number.isFinite(fatigue) && fatigue >= 5) bullets.push('Fatigue is trending upward across recent workload.');
  if (Number.isFinite(strain) && strain >= 6) bullets.push('Strain is elevated and may compromise bowling mechanics.');
  else if (Number.isFinite(strain) && strain >= 4.5) bullets.push('Strain trend is rising and needs proactive management.');
  if (injuryRisk === 'HIGH' || injuryRisk === 'CRITICAL') bullets.push('Injury exposure is elevated if current intensity continues.');
  if (noBallRisk === 'HIGH') bullets.push('No-ball risk is elevated under current pressure and rhythm.');
  if (hrr.includes('poor') || hrr.includes('slow')) bullets.push('Recovery response is lagging between efforts.');
  if (Number.isFinite(sleepHours) && sleepHours > 0 && sleepHours < 6) bullets.push('Sleep is below baseline, reducing recovery headroom.');
  if (Number.isFinite(oversBowled) && oversBowled >= 3) bullets.push('Workload volume in the current spell is high.');
  if (Number.isFinite(pressure) && pressure >= 6.5) bullets.push('Match pressure is rising and amplifying execution risk.');
  if (phase === 'death') bullets.push('Death phase context increases fatigue and control trade-offs.');
  if (mode === 'BATTING' && bullets.length === 0) bullets.push('Batting context is stable, with focus on tactical continuity.');
  if (mode === 'BOWLING' && bullets.length === 0) bullets.push('Bowling context is stable; tactical control remains the priority.');

  return Array.from(new Set(bullets)).slice(0, 7);
}

function normalizeRouterIntent(value: unknown, signals: Record<string, unknown>): RouterIntent {
  const token = String(value || '').trim().toUpperCase();
  if (token === 'INJURYPREVENTION') return 'InjuryPrevention';
  if (token === 'PRESSURECONTROL') return 'PressureControl';
  if (token === 'TACTICALATTACK') return 'TacticalAttack';
  if (token === 'GENERAL') return 'General';

  if (token === 'SUBSTITUTION' || token === 'SAFETY_ALERT' || token === 'RISK_CHECK') return 'InjuryPrevention';
  if (token === 'BOWLING_NEXT' || token === 'BATTING_NEXT' || token === 'BOTH_NEXT') return 'TacticalAttack';
  if (String(signals.noBallRisk || '').toUpperCase() === 'HIGH' || toNumber(signals.pressureIndex, 0) >= 6.5) {
    return 'PressureControl';
  }
  return 'General';
}

function buildLocalRouterDecision(input: NormalizedRequest): RouterDecision {
  const isBowlingMode = normalizeTeamMode(input) === 'BOWLING';
  const rawSignals = asRecord(asRecord(input.rawPayload).signals);
  const pressureIndex = toNumber(rawSignals.pressureIndex, Number.NaN);
  const fatigueSignal = input.telemetry.fatigueIndex >= 5.8 || input.telemetry.strainIndex >= 5 || input.telemetry.oversBowled >= 3;
  const riskSignal =
    input.telemetry.noBallRisk === 'HIGH' ||
    input.telemetry.fatigueIndex >= 6.5 ||
    input.telemetry.strainIndex >= 6 ||
    Number.isFinite(pressureIndex) && pressureIndex >= 6.5;
  const hasAnySignal =
    fatigueSignal ||
    riskSignal ||
    input.telemetry.isUnfit === true ||
    input.telemetry.injuryRisk === 'HIGH' ||
    input.telemetry.injuryRisk === 'CRITICAL';

  const selectedSet = new Set<AgentKey>();
  if (fatigueSignal || isBowlingMode) selectedSet.add('fatigue');
  if (riskSignal || isBowlingMode) selectedSet.add('risk');
  if (hasAnySignal || selectedSet.size > 0) selectedSet.add('tactical');
  if (selectedSet.size === 0) selectedSet.add('tactical');

  const signals: Record<string, unknown> = {
    fatigueIndex: input.telemetry.fatigueIndex,
    strainIndex: input.telemetry.strainIndex,
    injuryRisk: input.telemetry.injuryRisk,
    noBallRisk: input.telemetry.noBallRisk,
    heartRateRecovery: input.telemetry.heartRateRecovery,
    oversBowled: input.telemetry.oversBowled,
    consecutiveOvers: input.telemetry.consecutiveOvers,
    pressureIndex: Number.isFinite(pressureIndex) ? pressureIndex : undefined,
    sleepHours: input.telemetry.sleepHours,
    phase: input.matchContext.phase,
    mode: isBowlingMode ? 'BOWLING' : 'BATTING',
    fatigueSignal,
    riskSignal,
  };

  const selectedAgents = ALL_AGENT_KEYS.filter((agent) => selectedSet.has(agent));
  const intent = riskSignal || String(input.telemetry.injuryRisk).toUpperCase() === 'HIGH'
    ? 'InjuryPrevention'
    : String(input.telemetry.noBallRisk).toUpperCase() === 'HIGH'
      ? 'PressureControl'
      : hasAnySignal
        ? 'TacticalAttack'
        : 'General';
  const signalSummaryBullets = buildSignalSummaryBullets(signals, normalizeTeamMode(input));

  return {
    intent,
    selectedAgents,
    signalSummaryBullets,
    rationale:
      intent === 'InjuryPrevention'
        ? 'The active signal profile indicates elevated injury exposure and reduced control margin. Prioritizing safety-focused tactical action.'
        : intent === 'PressureControl'
          ? 'Pressure and execution signals indicate control risk in the next phase. The route prioritizes stabilization and risk reduction.'
          : intent === 'TacticalAttack'
            ? 'Signals indicate an actionable tactical edge if workload is managed correctly. The route emphasizes proactive tactical optimization.'
            : 'Current signals are stable, so the route favors a balanced tactical briefing.',
    reason: `Router selected ${selectedAgents.join(', ')} from deterministic signal baseline.`,
    signals,
  };
}

function mapRouterApiDecision(input: NormalizedRequest, apiDecision: unknown): RouterDecision | null {
  const record = asRecord(apiDecision);
  if (Object.keys(record).length === 0) return null;
  const rawSelected = Array.isArray(record.selectedAgents) ? record.selectedAgents : [];
  const selectedAgents = rawSelected
    .map((entry) => String(entry).toLowerCase())
    .filter((entry): entry is AgentKey => entry === 'fatigue' || entry === 'risk' || entry === 'tactical');
  const rawSignals = asRecord(record.signals);
  const signalSummaryBullets = Array.isArray(record.signalSummaryBullets)
    ? record.signalSummaryBullets.map((entry) => String(entry)).filter(Boolean).slice(0, 7)
    : buildSignalSummaryBullets(rawSignals, normalizeTeamMode(input));
  const fallbackSelected = selectedAgents.length > 0 ? selectedAgents : ['tactical'];
  if (!fallbackSelected.includes('tactical')) fallbackSelected.push('tactical');

  const normalizedSelectedAgents: AgentKey[] = ALL_AGENT_KEYS.filter((agent) => fallbackSelected.includes(agent));

  return {
    intent: normalizeRouterIntent(record.intent, rawSignals),
    selectedAgents: normalizedSelectedAgents,
    signalSummaryBullets,
    rationale: String(record.rationale || record.reason || 'Router selected agents from current match signals.'),
    reason: String(record.reason || record.rationale || ''),
    signals: rawSignals,
    rulesFired: Array.isArray(record.rulesFired) ? record.rulesFired.map((entry) => String(entry)) : undefined,
    inputsUsed: asRecord(record.inputsUsed),
    fallbackRoutingUsed: record.fallbackRoutingUsed === true,
    routerUnavailable: record.routerUnavailable === true,
  };
}

function buildRouterSignalsPayload(input: NormalizedRequest): Record<string, unknown> {
  const isBowlingMode = normalizeTeamMode(input) === 'BOWLING';
  const fatigueSignal = input.telemetry.fatigueIndex >= 5.8 || input.telemetry.strainIndex >= 5 || input.telemetry.oversBowled >= 3;
  const pressureSignal =
    input.matchContext.requiredRunRate > 0 &&
    input.matchContext.currentRunRate > 0 &&
    input.matchContext.requiredRunRate - input.matchContext.currentRunRate >= 1.2;
  const riskSignal =
    input.telemetry.noBallRisk === 'HIGH' ||
    input.telemetry.injuryRisk === 'HIGH' ||
    input.telemetry.injuryRisk === 'CRITICAL' ||
    fatigueSignal ||
    pressureSignal;

  return {
    fatigueIndex: input.telemetry.fatigueIndex,
    strainIndex: input.telemetry.strainIndex,
    oversBowled: input.telemetry.oversBowled,
    consecutiveOvers: input.telemetry.consecutiveOvers,
    injuryRisk: input.telemetry.injuryRisk,
    noBallRisk: input.telemetry.noBallRisk,
    heartRateRecovery: input.telemetry.heartRateRecovery,
    sleepHours: input.telemetry.sleepHours,
    phase: input.matchContext.phase,
    mode: isBowlingMode ? 'BOWLING' : 'BATTING',
    fatigueSignal,
    pressureSignal,
    riskSignal,
  };
}

function buildFatiguePayload(input: NormalizedRequest): Record<string, unknown> {
  return {
    playerId: input.telemetry.playerId,
    playerName: input.telemetry.playerName,
    role: input.telemetry.role,
    oversBowled: input.telemetry.oversBowled,
    consecutiveOvers: input.telemetry.consecutiveOvers,
    fatigueIndex: input.telemetry.fatigueIndex,
    injuryRisk: input.telemetry.injuryRisk,
    noBallRisk: input.telemetry.noBallRisk,
    heartRateRecovery: input.telemetry.heartRateRecovery,
    fatigueLimit: input.telemetry.fatigueLimit,
    sleepHours: input.telemetry.sleepHours,
    recoveryMinutes: input.telemetry.recoveryMinutes,
    snapshotId: `${input.telemetry.playerId}:${Date.now()}`,
    matchContext: {
      teamMode: normalizeTeamMode(input),
      matchMode: input.matchContext.matchMode,
      format: input.matchContext.format || 'T20',
      phase: input.matchContext.phase || 'middle',
      over: input.matchContext.over || 0,
      intensity: input.matchContext.intensity || 'Medium',
    },
  };
}

function buildRiskPayload(input: NormalizedRequest): Record<string, unknown> {
  return {
    playerId: input.telemetry.playerId,
    fatigueIndex: input.telemetry.fatigueIndex,
    injuryRisk: input.telemetry.injuryRisk,
    noBallRisk: input.telemetry.noBallRisk,
    oversBowled: input.telemetry.oversBowled,
    consecutiveOvers: input.telemetry.consecutiveOvers,
    heartRateRecovery: input.telemetry.heartRateRecovery,
    teamMode: normalizeTeamMode(input),
    matchMode: input.matchContext.matchMode,
    format: input.matchContext.format || 'T20',
    phase: input.matchContext.phase || 'middle',
    intensity: input.matchContext.intensity || 'Medium',
    conditions: input.matchContext.conditions,
    target: input.matchContext.target,
    score: input.matchContext.score,
    over: input.matchContext.over,
    balls: input.matchContext.balls,
  };
}

function buildTacticalPayload(input: NormalizedRequest): Record<string, unknown> {
  const phase = input.matchContext.phase === 'powerplay' || input.matchContext.phase === 'death' ? input.matchContext.phase : 'middle';
  const rawPayload = asRecord(input.rawPayload);
  const rawContext = asRecord(rawPayload.context);
  const hasRosterContext = Array.isArray(rawContext.roster) && rawContext.roster.length > 0;
  const replacementCandidates = buildModeEligibleCandidates(input, 3);
  return {
    requestId: randomUUID(),
    intent: input.intent,
    telemetry: {
      ...input.telemetry,
    },
    matchContext: {
      ...input.matchContext,
      phase,
    },
    players: input.players,
    ...(hasRosterContext ? { context: rawContext } : {}),
    ...(replacementCandidates.length > 0 ? { replacementCandidates } : {}),
  };
}

function buildStrategicAnalysis(args: {
  mode: 'BOWLING' | 'BATTING';
  requestMode: 'auto' | 'full';
  routerDecision?: RouterDecision;
  fatigue?: Record<string, unknown>;
  risk?: Record<string, unknown>;
  tactical?: Record<string, unknown>;
  baseline?: {
    sleepHours?: number;
    recoveryMinutes?: number;
    fatigueLimit?: number;
    control?: number;
    speed?: number;
    power?: number;
  };
  playerName?: string;
  fatigueIndex?: number;
}): StrategicAnalysis {
  const { mode, requestMode, routerDecision, fatigue, risk, tactical, baseline, playerName, fatigueIndex } = args;
  const defaultSignals = buildSignalSummaryBullets(
    asRecord(routerDecision?.signals),
    mode
  );
  const subject = String(playerName || 'the active player').trim() || 'the active player';
  const baselineSleep = toOptionalNumber(baseline?.sleepHours);
  const baselineRecovery = toOptionalNumber(baseline?.recoveryMinutes);
  const baselineFatigueLimit = toOptionalNumber(baseline?.fatigueLimit);
  const fatigueEcho = asRecord(asRecord(fatigue).echo);
  const fatigueNow = toOptionalNumber(fatigueIndex ?? fatigueEcho.fatigueIndex);
  const usedBaseline =
    Number.isFinite(baselineSleep) ||
    Number.isFinite(baselineRecovery) ||
    Number.isFinite(baselineFatigueLimit);
  const sleepConstrained = Number.isFinite(baselineSleep) ? baselineSleep! < 7 : false;
  const recoveryConstrained = Number.isFinite(baselineRecovery) ? baselineRecovery! < 50 : false;
  const lowFatigueCeiling = Number.isFinite(baselineFatigueLimit) ? baselineFatigueLimit! <= 6 : false;
  const nearFatigueCeiling =
    Number.isFinite(baselineFatigueLimit) && Number.isFinite(fatigueNow)
      ? fatigueNow! >= baselineFatigueLimit! - 0.8
      : false;
  const baselineConstrained = sleepConstrained || recoveryConstrained || lowFatigueCeiling || nearFatigueCeiling;
  const baselineLine = usedBaseline
    ? [
        Number.isFinite(baselineSleep)
          ? `Given ${subject} only had ~${baselineSleep!.toFixed(1)}h sleep today, neuromuscular control is more fragile under pressure.`
          : null,
        Number.isFinite(baselineRecovery)
          ? `Recovery window today is ~${Math.round(baselineRecovery!)}min, so repeat efforts are carrying more residual load.`
          : null,
        Number.isFinite(baselineFatigueLimit)
          ? `Fatigue ceiling for this player is ${baselineFatigueLimit!.toFixed(1)}/10, and the current spell is operating too close to that cap.`
          : null,
      ]
        .filter((line): line is string => Boolean(line))
        .join(' ')
    : 'Baseline not available — using live telemetry only.';
  const fatigueSeverity = String(fatigue?.severity || '').toUpperCase();
  const fatigueHeadline = String(fatigue?.headline || 'Fatigue trend indicates workload is building.');
  const fatigueExplanation = String(
    fatigue?.explanation ||
      fatigue?.recommendation ||
      'Workload and recovery signals suggest caution before extending intensity.'
  );
  const fatigueActionLine = baselineConstrained
    ? mode === 'BOWLING'
      ? `Recommendation: rotate ${subject} now or cap to one controlled over; do not extend the same spell intensity.`
      : `Recommendation: reduce tempo load now and avoid forcing high-risk acceleration until recovery markers settle.`
    : mode === 'BOWLING'
      ? `Recommendation: allow one controlled over with tighter length discipline, then reassess immediately.`
      : `Recommendation: continue with controlled intent and explicit strike-rotation guardrails.`;
  const fatigueAnalysis =
    requestMode === 'full'
      ? `${fatigueHeadline} ${baselineLine} ${fatigueExplanation} ${fatigueActionLine}`
      : `${fatigueHeadline} ${baselineLine} ${fatigueActionLine}`;

  const riskSeverity = String(risk?.severity || '').toUpperCase();
  const elevatedRisk = riskSeverity === 'MED' || riskSeverity === 'MEDIUM' || riskSeverity === 'HIGH' || riskSeverity === 'CRITICAL';
  const riskHeadline = String(risk?.headline || 'Injury risk profile is elevated under current load conditions.');
  const riskExplanation = String(
    risk?.explanation ||
      risk?.recommendation ||
      'The risk profile is tied to cumulative workload, strain drift, and reduced quality under pressure.'
  );
  const bowlingInjuryTypes = 'hamstring strain, lower back stress, side strain, and shoulder overload';
  const injuryTypesLine =
    mode === 'BOWLING' && elevatedRisk
      ? `Likely injury pathways include ${bowlingInjuryTypes}.`
      : 'Current risk pattern still requires close monitoring of tissue stress and movement quality.';
  const injuryHowLine =
    'This usually means mechanics drift under fatigue, then tissue load shifts into vulnerable zones across repeated high-intensity efforts.';
  const riskDirective = baselineConstrained
    ? 'Decision stance: intervene now to break the overload chain before the next over compounds risk.'
    : 'Decision stance: continue only with strict workload constraints and immediate re-check after the next phase.';
  const injuryRiskAnalysis =
    requestMode === 'full'
      ? `${riskHeadline} ${baselineLine} ${riskExplanation} ${injuryTypesLine} ${injuryHowLine} ${riskDirective}`
      : `${riskHeadline} ${baselineLine} ${injuryTypesLine} ${injuryHowLine} ${riskDirective}`;

  const tacticalAction =
    mode === 'BOWLING'
      ? baselineConstrained
        ? `Rotate ${subject} now and shorten the next spell.`
        : String(tactical?.immediateAction || `Give ${subject} one controlled over with pace-off variation, then reassess.`)
      : baselineConstrained
        ? `Stabilize batting tempo immediately and protect wicket value.`
        : String(tactical?.immediateAction || 'Continue with controlled batting pressure and strike rotation.');
  const tacticalWhy = String(
    tactical?.rationale ||
      'This recommendation aligns workload control with match context to protect execution quality and reduce avoidable risk.'
  );
  const tacticalAlternatives = (() => {
    const llmAlts = Array.isArray(tactical?.suggestedAdjustments)
      ? tactical.suggestedAdjustments.map((entry) => String(entry)).filter(Boolean)
      : [];
    if (llmAlts.length > 0) return llmAlts.slice(0, 3);
    if (mode === 'BOWLING') {
      return baselineConstrained
        ? [
            'Switch to a fresher bowler and remove back-to-back high-intensity overs.',
            'Use control-first lengths and avoid high-effort bouncer plans.',
            'Re-check risk and fatigue before assigning another spell.',
          ]
        : [
            'Keep the same bowler for one over max with pace-off variation.',
            'Use a defensive field to preserve control under pressure.',
            'Pre-warm the next rotation option before the over ends.',
          ];
    }
    return baselineConstrained
      ? [
          'Prioritize low-risk strike rotation over boundary forcing.',
          'Delay high-risk acceleration until recovery signs improve.',
          'Use matchup-based shot selection for control.',
        ]
      : [
          'Maintain strike rotation and pick one boundary option per over.',
          'Use controlled intent against high-risk lines.',
          'Reassess pressure before expanding shot range.',
        ];
  })();
  const tacticalIfIgnored = baselineConstrained
    ? 'If ignored, control will drop first, then overload risk will spike in the following phase.'
    : riskSeverity === 'HIGH' || riskSeverity === 'CRITICAL' || fatigueSeverity === 'HIGH'
      ? 'If ignored, execution quality is likely to drop quickly and injury exposure can escalate in the next phase.'
      : 'If ignored, control drift can build gradually and reduce tactical flexibility later in the innings.';
  const coachNote = baselineConstrained
    ? `Tonight’s risk is not the next ball, it is the next over. Act early on ${subject} and you protect both control and availability late in the innings.`
    : `The profile supports one controlled phase, not a free extension. Keep discipline high and reassess before committing further workload.`;

  return {
    signals: routerDecision?.signalSummaryBullets?.length ? routerDecision.signalSummaryBullets : defaultSignals,
    fatigueAnalysis,
    injuryRiskAnalysis,
    tacticalRecommendation: {
      nextAction: tacticalAction,
      why: `${baselineLine} ${tacticalWhy} ${riskDirective}`.trim(),
      ifIgnored: tacticalIfIgnored,
      alternatives: tacticalAlternatives,
    },
    coachNote,
    meta: {
      usedBaseline,
    },
  };
}

function buildCombinedDecisionFromStrategic(
  strategic: StrategicAnalysis,
  tactical?: Record<string, unknown>
): Record<string, unknown> {
  return {
    immediateAction: strategic.tacticalRecommendation.nextAction,
    substitutionAdvice: tactical?.substitutionAdvice,
    suggestedAdjustments: [
      strategic.tacticalRecommendation.ifIgnored,
      ...strategic.tacticalRecommendation.alternatives,
    ].slice(0, 4),
    confidence: Number(tactical?.confidence || 0.72),
    rationale: strategic.tacticalRecommendation.why,
  };
}

export class ExistingAgentsClient {
  private readonly baseUrl: string;
  private readonly agentRunners: Record<AgentKey, (input: NormalizedRequest) => Promise<Record<string, unknown>>>;

  constructor(baseUrl: string) {
    this.baseUrl = trimTrailingSlash(baseUrl || 'http://localhost:7071');
    this.agentRunners = {
      fatigue: (input) => this.callFatigue(buildFatiguePayload(input)),
      risk: (input) => this.callRisk(buildRiskPayload(input)),
      tactical: (input) => this.callTactical(buildTacticalPayload(input)),
    };
  }

  private async postJson<T>(path: string, payload: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} at ${url}: ${text.slice(0, 240)}`);
    }
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (contentType && !contentType.includes('application/json')) {
      throw new Error(
        `Expected JSON but received ${contentType || 'unknown'} at ${url}. Check API route/base URL configuration.`
      );
    }
    const trimmed = text.trim().toLowerCase();
    if (trimmed.startsWith('<!doctype html') || trimmed.startsWith('<html')) {
      throw new Error(`Expected JSON but received HTML at ${url}. Check API route/proxy configuration.`);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Invalid JSON response from ${url}.`);
    }
  }

  async callRisk(payload: unknown): Promise<Record<string, unknown>> {
    return this.postJson<Record<string, unknown>>('/api/agents/risk', payload);
  }

  async callFatigue(payload: unknown): Promise<Record<string, unknown>> {
    return this.postJson<Record<string, unknown>>('/api/agents/fatigue', payload);
  }

  async callTactical(payload: unknown): Promise<Record<string, unknown>> {
    return this.postJson<Record<string, unknown>>('/api/agents/tactical', payload);
  }

  async callOrchestrator(payload: unknown): Promise<OrchestrateLikeResponse> {
    return this.postJson<OrchestrateLikeResponse>('/api/orchestrate', payload);
  }

  async callRouter(payload: unknown): Promise<unknown> {
    return this.postJson<unknown>('/api/router', payload);
  }

  private async runCombinedAnalysis(
    input: NormalizedRequest,
    selectedAgents: AgentKey[],
    requestMode: 'auto' | 'full',
    routerDecision?: RouterDecision,
    routerFallbackMessage?: string
  ): Promise<OrchestrateLikeResponse> {
    const startedAt = Date.now();
    const requestId = randomUUID();
    const errors: Array<{ agent: AgentKey; message: string }> = [];
    const timingsMs: OrchestrateLikeResponse['meta']['timingsMs'] = { total: 0 };
    const executionSet = new Set<AgentKey>(selectedAgents);
    executionSet.add('tactical');
    const executedAgents: AgentKey[] = ALL_AGENT_KEYS.filter((agent) => executionSet.has(agent));

    let fatigue: Record<string, unknown> | undefined;
    let risk: Record<string, unknown> | undefined;
    let tactical: Record<string, unknown> | undefined;
    let fatigueModel = 'skipped';
    let riskModel = 'skipped';
    let tacticalModel = 'skipped';

    const settled = await Promise.allSettled(
      executedAgents.map(async (agent) => {
        console.log('[agent-framework] agent execution', { agent, requestId });
        const started = Date.now();
        const output = await this.agentRunners[agent](input);
        return {
          agent,
          output,
          durationMs: Date.now() - started,
        };
      })
    );

    settled.forEach((result, index) => {
      const agent = executedAgents[index];
      if (result.status === 'fulfilled') {
        const { output, durationMs } = result.value;
        if (agent === 'fatigue') {
          fatigue = output;
          fatigueModel = 'agent-framework-http';
          timingsMs.fatigue = durationMs;
          return;
        }
        if (agent === 'risk') {
          risk = output;
          riskModel = 'agent-framework-http';
          timingsMs.risk = durationMs;
          return;
        }
        tactical = output;
        tacticalModel = 'agent-framework-http';
        timingsMs.tactical = durationMs;
        return;
      }

      const reason = result.reason;
      errors.push({
        agent,
        message: reason instanceof Error ? reason.message : 'Agent call failed',
      });
    });

    timingsMs.total = Date.now() - startedAt;
    const mode = normalizeTeamMode(input);
    const modeCandidates = buildModeEligibleCandidates(input, 3);
    const tacticalSubstitution = asRecord(asRecord(tactical).substitutionAdvice);
    const suggestedId = String(tacticalSubstitution.playerId || tacticalSubstitution.bowlerId || '').trim().toLowerCase();
    const suggestedName = String(tacticalSubstitution.in || tacticalSubstitution.name || '').trim().toLowerCase();
    const validatedRecommendation =
      modeCandidates.find((candidate) => {
        const candidateId = candidate.playerId.toLowerCase();
        const candidateName = candidate.name.toLowerCase();
        return (suggestedId && candidateId === suggestedId) || (suggestedName && candidateName === suggestedName);
      }) || modeCandidates[0];
    const noEligibleMessage = 'No eligible replacement available for current mode.';
    const strategicAnalysis = buildStrategicAnalysis({
      mode,
      requestMode,
      routerDecision,
      fatigue,
      risk,
      tactical,
      baseline: {
        sleepHours: toOptionalNumber(input.telemetry.sleepHours),
        recoveryMinutes: toOptionalNumber(input.telemetry.recoveryMinutes),
        fatigueLimit: toOptionalNumber(input.telemetry.fatigueLimit),
      },
      playerName: input.telemetry.playerName,
      fatigueIndex: toOptionalNumber(input.telemetry.fatigueIndex),
    });
    const combinedDecision = buildCombinedDecisionFromStrategic(strategicAnalysis, tactical);
    if (!validatedRecommendation) {
      const adjustments = Array.isArray(combinedDecision.suggestedAdjustments)
        ? combinedDecision.suggestedAdjustments
        : [];
      combinedDecision.suggestedAdjustments = [...adjustments, noEligibleMessage];
    }
    if (routerFallbackMessage) {
      const adjustments = Array.isArray(combinedDecision.suggestedAdjustments)
        ? combinedDecision.suggestedAdjustments
        : [];
      combinedDecision.suggestedAdjustments = [routerFallbackMessage, ...adjustments].slice(0, 4);
    }

    return {
      ...(fatigue ? { fatigue } : {}),
      ...(risk ? { risk } : {}),
      ...(tactical ? { tactical } : {}),
      strategicAnalysis,
      agentOutputs: {
        ...(fatigue ? { fatigue: { ...fatigue, status: fatigue.status || 'ok' } } : {}),
        ...(risk ? { risk: { ...risk, status: risk.status || 'ok' } } : {}),
        ...(tactical ? { tactical } : {}),
      },
      finalDecision: combinedDecision,
      combinedDecision,
      ...(validatedRecommendation && mode === 'BOWLING'
        ? {
            recommendation: {
              bowlerId: validatedRecommendation.playerId,
              bowlerName: validatedRecommendation.name,
              reason: validatedRecommendation.reason,
            },
          }
        : {}),
      ...(validatedRecommendation
        ? {
            suggestedRotation: {
              playerId: validatedRecommendation.playerId,
              name: validatedRecommendation.name,
              rationale: validatedRecommendation.reason,
            },
          }
        : {}),
      errors,
      ...(routerDecision ? { routerDecision } : {}),
      meta: {
        requestId,
        mode: requestMode,
        executedAgents,
        modelRouting: {
          fatigueModel,
          riskModel,
          tacticalModel,
          fallbacksUsed: [],
        },
        usedFallbackAgents: [],
        ...(routerFallbackMessage ? { routerFallbackMessage } : {}),
        timingsMs,
      },
    };
  }

  async run(mode: AgentFrameworkMode, payloadInput: unknown): Promise<OrchestrateLikeResponse> {
    const normalized = normalizeRequest(payloadInput);
    const payloadSummary = summarizePayload(normalized);

    if (mode === 'all') {
      console.log('[agent-framework] full analysis payload', payloadSummary);
      return this.runCombinedAnalysis(normalized, ALL_AGENT_KEYS, 'full');
    }

    const payload = asRecord(payloadInput);
    const rawSignals = asRecord(payload.signals);
    const routerPayload = {
      ...payload,
      mode: 'auto',
      signals: {
        ...rawSignals,
        ...buildRouterSignalsPayload(normalized),
      },
      context: payload.context,
    };

    let routerDecision: RouterDecision | null = null;
    let routerFallbackMessage: string | undefined;
    try {
      const routerResponse = await this.callRouter(routerPayload);
      routerDecision = mapRouterApiDecision(normalized, routerResponse);
      if (routerDecision?.fallbackRoutingUsed) {
        routerDecision.rationale = `${routerDecision.rationale} Fallback routing used.`.trim();
      }
      if (routerDecision?.routerUnavailable) {
        routerFallbackMessage = 'Routing: rules-based (safe fallback)';
      }
    } catch {
      routerFallbackMessage = 'Routing: rules-based (safe fallback)';
    }

    if (!routerDecision) {
      routerDecision = buildLocalRouterDecision(normalized);
      if (!routerFallbackMessage) {
        routerFallbackMessage = 'Routing: rules-based (safe fallback)';
      }
      routerDecision.selectedAgents = ['tactical'];
      routerDecision.rationale = `${routerDecision.rationale} ${routerFallbackMessage}`;
    }

    const selectedSet = new Set<AgentKey>(routerDecision.selectedAgents);
    selectedSet.add('tactical');
    const selectedAgents: AgentKey[] = ALL_AGENT_KEYS.filter((agent) => selectedSet.has(agent));

    console.log('[agent-framework] router decision', {
      selectedAgents,
      payload: payloadSummary,
    });
    return this.runCombinedAnalysis(normalized, selectedAgents, 'auto', routerDecision, routerFallbackMessage);
  }
}
