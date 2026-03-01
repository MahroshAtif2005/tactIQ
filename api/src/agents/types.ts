import { FatigueAgentRequest, FatigueAgentResponse, RiskAgentRequest, RiskAgentResponse } from '../shared/types';
import { FullMatchContext, ReplacementCandidate } from '../shared/matchContext';

export type OrchestrateMode = 'auto' | 'full';
export type OrchestrateRequestMode = 'route' | 'auto' | 'full';
export type OrchestrateIntent = 'monitor' | 'substitution' | 'strategy' | 'full';
export type RouterIntent = 'SUBSTITUTION' | 'BOWLING_NEXT' | 'BATTING_NEXT' | 'BOTH_NEXT' | 'SAFETY_ALERT' | 'GENERAL';
export type AgentCode = 'RISK' | 'TACTICAL' | 'FATIGUE';
export type LegacyAgentId = 'risk' | 'tactical' | 'fatigue';

export interface TacticalMatchContext {
  teamMode?: 'BATTING' | 'BOWLING' | string;
  matchMode?: 'BAT' | 'BOWL' | string;
  phase: 'powerplay' | 'middle' | 'death';
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

export interface TacticalPlayersInput {
  striker: string;
  nonStriker: string;
  bowler: string;
  bench?: string[];
}

export interface TelemetryInput {
  playerId: string;
  playerName: string;
  role: string;
  fatigueIndex: number;
  strainIndex?: number;
  heartRateRecovery: string;
  oversBowled: number;
  consecutiveOvers: number;
  oversRemaining?: number;
  maxOvers?: number;
  quotaComplete?: boolean;
  injuryRisk: FatigueAgentRequest['injuryRisk'];
  noBallRisk: FatigueAgentRequest['noBallRisk'];
  fatigueLimit?: number;
  sleepHours?: number;
  recoveryMinutes?: number;
  isUnfit?: boolean;
}

export interface TacticalSubstitutionAdvice {
  out: string;
  in: string;
  reason: string;
}

export interface TacticalAgentInput {
  requestId: string;
  intent: OrchestrateIntent;
  teamMode?: 'BATTING' | 'BOWLING';
  focusRole?: 'BOWLER' | 'BATTER';
  matchContext: TacticalMatchContext;
  telemetry: TelemetryInput;
  players: TacticalPlayersInput;
  fatigueOutput?: FatigueAgentResponse;
  riskOutput?: RiskAgentResponse;
  context?: FullMatchContext;
  replacementCandidates?: ReplacementCandidate[];
}

export interface TacticalAgentOutput {
  status: 'ok' | 'fallback' | 'error';
  immediateAction: string;
  rationale: string;
  suggestedAdjustments: string[];
  substitutionAdvice?: TacticalSubstitutionAdvice;
  nextAction?: string;
  why?: string[];
  swap?: TacticalSubstitutionAdvice;
  ifIgnored?: string;
  coachNote?: string;
  confidence: number;
  keySignalsUsed: string[];
}

export type AgentStepStatus = 'ok' | 'fallback' | 'error' | 'running' | 'skipped';
export type AgentStatus = 'OK' | 'SKIPPED' | 'FALLBACK' | 'ERROR';

export interface AgentSummary {
  status: 'success' | 'error' | 'fallback';
  routedTo: 'llm' | 'rules';
  output?: Record<string, unknown>;
  error?: string;
}

export interface RouterInputsUsed {
  activePlayerId?: string;
  active: {
    fatigueIndex?: number;
    strainIndex?: number;
    injuryRisk?: string;
    noBallRisk?: string;
  };
  match: {
    matchMode?: string;
    format?: string;
    phase?: string;
    overs?: number;
    balls?: number;
    scoreRuns?: number;
    wickets?: number;
    targetRuns?: number;
    intensity?: string;
  };
}

export interface RouterDecision {
  mode?: 'auto' | 'full';
  intent: RouterIntent;
  agentsToRun: AgentCode[];
  rulesFired: string[];
  inputsUsed: RouterInputsUsed;
  // Compatibility aliases consumed by current UI surfaces.
  selectedAgents: LegacyAgentId[];
  agents?: {
    fatigue: { routedTo: 'llm' | 'rules'; reason: string };
    risk: { routedTo: 'llm' | 'rules'; reason: string };
    tactical: { routedTo: 'llm' | 'rules'; reason: string };
  };
  reason: string;
  signals: Record<string, unknown>;
}

export interface TacticalAgentResult {
  output: TacticalAgentOutput;
  model: string;
  fallbacksUsed: string[];
}

export interface OrchestrateRequest {
  mode?: OrchestrateMode;
  rawMode?: OrchestrateRequestMode;
  intent?: OrchestrateIntent;
  teamMode?: 'BATTING' | 'BOWLING';
  focusRole?: 'BOWLER' | 'BATTER';
  text?: string;
  signals?: Record<string, unknown>;
  matchContext: TacticalMatchContext;
  telemetry: TelemetryInput;
  players: TacticalPlayersInput;
  context?: FullMatchContext;
  replacementCandidates?: ReplacementCandidate[];
  userAction?: string;
}

export interface OrchestrateRequestBody {
  text?: string;
  mode?: OrchestrateRequestMode | string;
  intent?: OrchestrateIntent | string;
  teamMode?: 'BATTING' | 'BOWLING' | string;
  focusRole?: 'BOWLER' | 'BATTER' | string;
  telemetry?: Partial<TelemetryInput> | Record<string, unknown>;
  matchContext?: Partial<TacticalMatchContext> | Record<string, unknown>;
  players?: TacticalPlayersInput | string[] | Record<string, unknown>;
  signals?: Record<string, unknown>;
  context?: FullMatchContext | Record<string, unknown>;
  userAction?: string;
  player?: Record<string, unknown>;
  match?: Record<string, unknown>;
}

export interface AgentError {
  agent: 'fatigue' | 'risk' | 'tactical';
  message: string;
}

export interface TriggerScores {
  fatigue: number;
  risk: number;
  tactical: number;
}

export interface LikelyInjury {
  type: string;
  reason: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH';
}

export interface RiskAgentOutput {
  riskLevel: number;
  headline: string;
  keySignals: string[];
  likelyInjuries: LikelyInjury[];
  continueRiskSummary: string;
}

export interface TacticalAgentStructuredOutput {
  headline: string;
  nextSafeBowler: { playerId: string; name: string; reason: string };
  nextSafeBatter: { playerId: string; name: string; reason: string };
  benchOptions?: Array<{ playerId: string; name: string; reason: string }>;
  actionSteps: string[];
}

export interface FatigueAgentOutput {
  fatigueNow: number;
  projectionNextOvers: number[];
  recoveryAdvice: string[];
}

export interface FinalRecommendation {
  title: string;
  statement: string;
  nextSafeBowler: { playerId: string; name: string; reason: string };
  nextSafeBatter: { playerId: string; name: string; reason: string };
  ifContinues: {
    playerId: string;
    name: string;
    riskSummary: string;
    likelyInjuries: LikelyInjury[];
  };
  confidence: 'LOW' | 'MEDIUM' | 'HIGH';
}

export interface OrchestrateResponse {
  fatigue?: FatigueAgentResponse;
  risk?: RiskAgentResponse;
  tactical?: TacticalAgentOutput;
  strategicAnalysis?: {
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
  };
  agentOutputs: {
    fatigue?: (FatigueAgentResponse & { status: AgentStepStatus });
    risk?: (RiskAgentResponse & { status: AgentStepStatus });
    tactical?: TacticalAgentOutput;
  };
  finalDecision: {
    immediateAction: string;
    substitutionAdvice?: TacticalSubstitutionAdvice;
    suggestedAdjustments: string[];
    confidence: number;
    rationale: string;
  };
  combinedDecision: {
    immediateAction: string;
    substitutionAdvice?: TacticalSubstitutionAdvice;
    suggestedAdjustments: string[];
    confidence: number;
    rationale: string;
  };
  errors: AgentError[];
  routerIntent?: string;
  router?: {
    status: AgentStatus;
    intent: string;
    run: {
      fatigue: boolean;
      risk: boolean;
      tactical: boolean;
    };
    reason: string;
  };
  agents?: {
    fatigue?: { status: AgentStatus };
    risk?: { status: AgentStatus };
    tactical?: { status: AgentStatus };
  };
  agentResults?: {
    fatigue: AgentSummary;
    risk: AgentSummary;
    tactical: AgentSummary;
  };
  agentsRun?: AgentCode[];
  contextSummary?: {
    rosterCount: number;
    activePlayerId?: string;
    match: {
      matchMode?: string;
      format: string;
      phase: string;
      intensity: string;
      scoreRuns: number;
      wickets: number;
      overs: number;
      balls: number;
      targetRuns?: number;
    };
    hasBaselinesCount: number;
    hasTelemetryCount: number;
  };
  structuredOutputs?: {
    risk?: RiskAgentOutput;
    tactical?: TacticalAgentStructuredOutput;
    fatigue?: FatigueAgentOutput;
  };
  finalRecommendation?: FinalRecommendation;
  recommendation?: {
    bowlerId: string;
    bowlerName: string;
    reason?: string;
  };
  suggestedRotation?: {
    playerId: string;
    name: string;
    rationale?: string;
  };
  riskDebug?: RiskAgentResponse['riskDebug'];
  routerDecision: RouterDecision;
  meta: {
    requestId: string;
    mode: OrchestrateMode;
    intent: OrchestrateIntent;
    executedAgents: Array<'fatigue' | 'risk' | 'tactical'>;
    triggers: TriggerScores;
    suggestFullAnalysis: boolean;
    modelRouting: {
      fatigueModel: string;
      riskModel: string;
      tacticalModel: string;
      fallbacksUsed: string[];
    };
    usedFallbackAgents: Array<'fatigue' | 'risk' | 'tactical'>;
    aoai?: {
      missing: string[];
    };
    timingsMs: {
      fatigue?: number;
      risk?: number;
      tactical?: number;
      total: number;
    };
  };
}

export const toFatigueRequest = (input: OrchestrateRequest, snapshotId: string): FatigueAgentRequest => ({
  playerId: String(input.telemetry.playerId || 'UNKNOWN'),
  playerName: String(input.telemetry.playerName || 'Unknown Player'),
  role: String(input.telemetry.role || 'Unknown Role'),
  oversBowled: Math.max(0, Number(input.telemetry.oversBowled) || 0),
  consecutiveOvers: Math.max(0, Number(input.telemetry.consecutiveOvers) || 0),
  oversRemaining: Number.isFinite(Number(input.telemetry.oversRemaining))
    ? Math.max(0, Number(input.telemetry.oversRemaining))
    : undefined,
  maxOvers: Number.isFinite(Number(input.telemetry.maxOvers))
    ? Math.max(1, Number(input.telemetry.maxOvers))
    : undefined,
  quotaComplete: Boolean(input.telemetry.quotaComplete),
  fatigueIndex: Math.max(0, Math.min(10, Number(input.telemetry.fatigueIndex) || 0)),
  injuryRisk: String(input.telemetry.injuryRisk || 'MEDIUM').toUpperCase() as FatigueAgentRequest['injuryRisk'],
  noBallRisk: String(input.telemetry.noBallRisk || 'MEDIUM').toUpperCase() as FatigueAgentRequest['noBallRisk'],
  heartRateRecovery: String(input.telemetry.heartRateRecovery || 'Moderate'),
  fatigueLimit: Math.max(0, Number(input.telemetry.fatigueLimit) || 6),
  sleepHours: Math.max(0, Number(input.telemetry.sleepHours) || 7),
  recoveryMinutes: Math.max(0, Number(input.telemetry.recoveryMinutes) || 45),
  snapshotId,
  matchContext: {
    format: String(input.matchContext.format || 'T20'),
    phase: String(input.matchContext.phase || 'Middle'),
    over: Number.isFinite(Number(input.matchContext.over)) ? Number(input.matchContext.over) : 0,
    intensity: String(input.matchContext.intensity || 'Medium'),
  },
  ...(input.context ? { fullMatchContext: input.context } : {}),
  ...(Array.isArray(input.replacementCandidates) ? { replacementCandidates: input.replacementCandidates } : {}),
});

export const toRiskRequest = (input: OrchestrateRequest): RiskAgentRequest => ({
  playerId: String(input.telemetry.playerId || 'UNKNOWN'),
  fatigueIndex: Number.isFinite(Number(input.telemetry.fatigueIndex))
    ? Math.max(0, Math.min(10, Number(input.telemetry.fatigueIndex)))
    : Number.NaN,
  strainIndex: Number.isFinite(Number(input.telemetry.strainIndex))
    ? Math.max(0, Math.min(10, Number(input.telemetry.strainIndex)))
    : undefined,
  injuryRisk: String(input.telemetry.injuryRisk || 'UNKNOWN').toUpperCase() as RiskAgentRequest['injuryRisk'],
  noBallRisk: String(input.telemetry.noBallRisk || 'UNKNOWN').toUpperCase() as RiskAgentRequest['noBallRisk'],
  oversBowled: Number.isFinite(Number(input.telemetry.oversBowled))
    ? Math.max(0, Number(input.telemetry.oversBowled))
    : Number.NaN,
  consecutiveOvers: (() => {
    const overs = Number.isFinite(Number(input.telemetry.oversBowled))
      ? Math.max(0, Number(input.telemetry.oversBowled))
      : Number.NaN;
    const spell = Number.isFinite(Number(input.telemetry.consecutiveOvers))
      ? Math.max(0, Number(input.telemetry.consecutiveOvers))
      : Number.NaN;
    if (!Number.isFinite(overs) || !Number.isFinite(spell)) return spell;
    return Math.min(spell, overs);
  })(),
  heartRateRecovery: input.telemetry.heartRateRecovery ? String(input.telemetry.heartRateRecovery) : undefined,
  isUnfit: Boolean(input.telemetry.isUnfit),
  oversRemaining: Number.isFinite(Number(input.telemetry.oversRemaining))
    ? Math.max(0, Number(input.telemetry.oversRemaining))
    : undefined,
  maxOvers: Number.isFinite(Number(input.telemetry.maxOvers))
    ? Math.max(1, Number(input.telemetry.maxOvers))
    : undefined,
  quotaComplete: Boolean(input.telemetry.quotaComplete),
  format: String(input.matchContext.format || 'T20'),
  phase: String(input.matchContext.phase || 'Middle'),
  intensity: String(input.matchContext.intensity || 'Medium'),
  conditions: input.matchContext.conditions,
  target: input.matchContext.target,
  score: input.matchContext.score,
  over: input.matchContext.over,
  balls: input.matchContext.balls,
  ...(input.context ? { fullMatchContext: input.context } : {}),
  ...(Array.isArray(input.replacementCandidates) ? { replacementCandidates: input.replacementCandidates } : {}),
});
