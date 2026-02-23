export type InjuryRisk = 'LOW' | 'MED' | 'HIGH' | 'MEDIUM';
export type Severity = 'LOW' | 'MED' | 'HIGH';
export type RiskSeverity = 'LOW' | 'MED' | 'HIGH' | 'CRITICAL';

export interface FatigueAgentResponse {
  status?: 'ok' | 'fallback' | 'error' | 'running' | 'skipped';
  severity: Severity;
  headline: string;
  explanation: string;
  recommendation: string;
  signals: string[];
  echo: {
    playerId?: string;
    fatigueIndex: number;
    injuryRisk: InjuryRisk;
    noBallRisk: InjuryRisk;
    oversBowled: number;
    consecutiveOvers: number;
    oversRemaining?: number;
    maxOvers?: number;
    heartRateRecovery?: string;
  };
  suggestedTweaks?: {
    suggestedRestOvers?: number;
    suggestedSubRole?: string;
    notes?: string;
  };
}

export interface RiskAgentResponse {
  status?: 'ok' | 'fallback' | 'error' | 'running' | 'skipped';
  agent: 'risk';
  severity: RiskSeverity;
  riskScore: number;
  headline: string;
  explanation: string;
  recommendation: string;
  signals: string[];
  echo: {
    playerId?: string;
    fatigueIndex: number;
    injuryRisk: InjuryRisk;
    noBallRisk: InjuryRisk;
    oversBowled: number;
    consecutiveOvers: number;
    oversRemaining?: number;
    maxOvers?: number;
    heartRateRecovery?: string;
    format?: string;
    phase?: string;
    intensity?: string;
    conditions?: string;
    target?: number;
    score?: number;
    over?: number;
    balls?: number;
  };
}

export interface TacticalCombinedDecision {
  immediateAction: string;
  substitutionAdvice?: {
    out: string;
    in: string;
    reason: string;
  };
  suggestedAdjustments: string[];
  confidence: number;
  rationale: string;
}

export interface TacticalAgentResponse {
  status?: 'ok' | 'fallback' | 'error';
  immediateAction: string;
  rationale: string;
  suggestedAdjustments: string[];
  substitutionAdvice?: {
    out: string;
    in: string;
    reason: string;
  };
  confidence: number;
  keySignalsUsed: string[];
}

export interface OrchestrateResponse {
  fatigue?: FatigueAgentResponse;
  risk?: RiskAgentResponse;
  tactical?: TacticalAgentResponse;
  agentOutputs?: {
    fatigue?: FatigueAgentResponse;
    risk?: RiskAgentResponse;
    tactical?: TacticalAgentResponse;
  };
  finalDecision?: TacticalCombinedDecision;
  combinedDecision: TacticalCombinedDecision;
  routerDecision?: {
    intent: 'fatigue_check' | 'risk_check' | 'substitution' | 'full';
    selectedAgents: Array<'fatigue' | 'risk' | 'tactical'>;
    reason: string;
    signals: Record<string, unknown>;
  };
  errors: Array<{ agent: 'fatigue' | 'risk' | 'tactical'; message: string }>;
  meta: {
    requestId: string;
    mode: 'auto' | 'full';
    executedAgents: Array<'fatigue' | 'risk' | 'tactical'>;
    modelRouting: {
      fatigueModel: string;
      riskModel: string;
      tacticalModel: string;
      fallbacksUsed: string[];
    };
    usedFallbackAgents?: Array<'fatigue' | 'risk' | 'tactical'>;
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
