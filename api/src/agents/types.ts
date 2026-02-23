import { FatigueAgentRequest, FatigueAgentResponse, RiskAgentRequest, RiskAgentResponse } from '../shared/types';

export type OrchestrateMode = 'auto' | 'full';
export type OrchestrateRequestMode = 'route' | 'auto' | 'full';
export type OrchestrateIntent = 'monitor' | 'substitution' | 'strategy' | 'full';
export type RouterIntent = 'fatigue_check' | 'risk_check' | 'substitution' | 'full';

export interface TacticalMatchContext {
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
  matchContext: TacticalMatchContext;
  telemetry: TelemetryInput;
  players: TacticalPlayersInput;
  fatigueOutput?: FatigueAgentResponse;
  riskOutput?: RiskAgentResponse;
}

export interface TacticalAgentOutput {
  status: 'ok' | 'fallback' | 'error';
  immediateAction: string;
  rationale: string;
  suggestedAdjustments: string[];
  substitutionAdvice?: TacticalSubstitutionAdvice;
  confidence: number;
  keySignalsUsed: string[];
}

export type AgentStepStatus = 'ok' | 'fallback' | 'error' | 'running' | 'skipped';
export type AgentStatus = 'OK' | 'SKIPPED' | 'FALLBACK' | 'ERROR';

export interface AgentSummary {
  status: AgentStatus;
  summaryTitle: string;
  summary: string;
  signals?: string[];
  data?: Record<string, unknown>;
  fallbackReason?: string;
}

export interface RouterDecision {
  intent: RouterIntent;
  selectedAgents: Array<'fatigue' | 'risk' | 'tactical'>;
  reason: string;
  signals: {
    fatigueIndex: number;
    injuryRisk: string;
    noBallRisk: string;
    heartRateRecovery: string;
    oversBowled: number;
    consecutiveOvers: number;
    maxOvers?: number;
    quotaComplete?: boolean;
    phase: string;
    wicketsInHand: number;
    oversRemaining: number;
    isUnfit: boolean;
  };
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
  text?: string;
  signals?: Record<string, unknown>;
  matchContext: TacticalMatchContext;
  telemetry: TelemetryInput;
  players: TacticalPlayersInput;
}

export interface OrchestrateRequestBody {
  text?: string;
  mode?: OrchestrateRequestMode | string;
  intent?: OrchestrateIntent | string;
  telemetry?: Partial<TelemetryInput> | Record<string, unknown>;
  matchContext?: Partial<TacticalMatchContext> | Record<string, unknown>;
  players?: TacticalPlayersInput | string[] | Record<string, unknown>;
  signals?: Record<string, unknown>;
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

export interface OrchestrateResponse {
  fatigue?: FatigueAgentResponse;
  risk?: RiskAgentResponse;
  tactical?: TacticalAgentOutput;
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
  agentResults?: {
    fatigue: AgentSummary;
    risk: AgentSummary;
    tactical: AgentSummary;
  };
  finalRecommendation?: {
    title: string;
    bulletReasons: string[];
    confidence: number;
    source: 'MODEL' | 'FALLBACK';
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
});

export const toRiskRequest = (input: OrchestrateRequest): RiskAgentRequest => ({
  playerId: String(input.telemetry.playerId || 'UNKNOWN'),
  fatigueIndex: Number.isFinite(Number(input.telemetry.fatigueIndex))
    ? Math.max(0, Math.min(10, Number(input.telemetry.fatigueIndex)))
    : Number.NaN,
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
});
