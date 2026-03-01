export type InjuryRisk = 'LOW' | 'MED' | 'HIGH' | 'MEDIUM';
export type Severity = 'LOW' | 'MED' | 'HIGH';
export type RiskSeverity = 'LOW' | 'MED' | 'HIGH' | 'CRITICAL';
export type RouterIntent =
  | 'SUBSTITUTION'
  | 'BOWLING_NEXT'
  | 'BATTING_NEXT'
  | 'BOTH_NEXT'
  | 'SAFETY_ALERT'
  | 'GENERAL'
  | 'fatigue_check'
  | 'risk_check'
  | 'substitution'
  | 'full';
export type AgentCode = 'RISK' | 'TACTICAL' | 'FATIGUE';

export interface FatigueAgentResponse {
  status?: 'ok' | 'fallback' | 'error' | 'running' | 'skipped';
  severity: Severity;
  headline: string;
  summary?: string;
  why?: string[];
  action?: string;
  projection?: string;
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
  nextAction?: string;
  why?: string[];
  swap?: {
    out: string;
    in: string;
    reason: string;
  };
  ifIgnored?: string;
  coachNote?: string;
  substitutionAdvice?: {
    out: string;
    in: string;
    reason: string;
  };
  confidence: number;
  keySignalsUsed: string[];
}

export interface RouterProof {
  intent: string;
  rulesFired: string[];
  inputsUsed: Record<string, unknown>;
}

export interface AgentExecutionStatus {
  status?: string;
}

export interface OrchestrateAgentResult<TOutput = unknown> {
  status: 'success' | 'error' | 'fallback';
  routedTo: 'llm' | 'rules';
  output?: TOutput;
  error?: string;
  reason?: string;
}

export interface OrchestrateContextSummary {
  rosterCount: number;
  activePlayerId?: string;
  match: {
    matchMode?: string;
    format: string;
    phase?: string;
    intensity?: string;
    scoreRuns: number;
    wickets: number;
    overs: number;
    balls?: number;
    targetRuns?: number;
  };
  hasBaselinesCount: number;
  hasTelemetryCount: number;
}

export interface LikelyInjury {
  type: string;
  reason: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH';
}

export interface FinalRecommendation {
  title: string;
  statement: string;
  nextSafeBowler: {
    playerId: string;
    name: string;
    reason: string;
  };
  nextSafeBatter: {
    playerId: string;
    name: string;
    reason: string;
  };
  ifContinues: {
    playerId: string;
    name: string;
    riskSummary: string;
    likelyInjuries: LikelyInjury[];
  };
  confidence: 'LOW' | 'MEDIUM' | 'HIGH';
}

export interface BowlerRecommendationPayload {
  bowlerId: string;
  bowlerName: string;
  reason?: string;
}

export interface SuggestedRotationPayload {
  playerId: string;
  name: string;
  rationale?: string;
}

export interface OrchestrateResponse {
  ok?: boolean;
  combinedBriefing?: string;
  fatigue?: FatigueAgentResponse;
  risk?: RiskAgentResponse;
  tactical?: TacticalAgentResponse;
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
  agentOutputs?: {
    fatigue?: FatigueAgentResponse;
    risk?: RiskAgentResponse;
    tactical?: TacticalAgentResponse;
  };
  finalDecision?: TacticalCombinedDecision;
  combinedDecision: TacticalCombinedDecision;
  routerDecision?: {
    mode?: 'auto' | 'full';
    routedTo?: 'llm' | 'mixed' | 'rules';
    intent: RouterIntent | 'InjuryPrevention' | 'PressureControl' | 'TacticalAttack' | 'General' | string;
    agentsToRun?: AgentCode[];
    rulesFired: string[];
    inputsUsed: {
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
    };
    selectedAgents?: Array<'fatigue' | 'risk' | 'tactical'>;
    agents?: {
      fatigue?: { routedTo: 'llm' | 'rules'; reason: string };
      risk?: { routedTo: 'llm' | 'rules'; reason: string };
      tactical?: { routedTo: 'llm' | 'rules'; reason: string };
    };
    signalSummaryBullets?: string[];
    rationale?: string;
    reason: string;
    signals: Record<string, unknown>;
  };
  agentsRun?: AgentCode[];
  finalRecommendation?: FinalRecommendation;
  recommendation?: BowlerRecommendationPayload;
  suggestedRotation?: SuggestedRotationPayload;
  traceId?: string;
  source?: 'azure' | 'mock';
  azureRequestId?: string;
  warnings?: string[];
  router?: RouterProof;
  agents?: {
    fatigue?: AgentExecutionStatus;
    risk?: AgentExecutionStatus;
    tactical?: AgentExecutionStatus;
  };
  agentResults?: {
    fatigue?: OrchestrateAgentResult<FatigueAgentResponse>;
    risk?: OrchestrateAgentResult<RiskAgentResponse>;
    tactical?: OrchestrateAgentResult<TacticalAgentResponse>;
  };
  output?: Record<string, unknown>;
  timingsMs?: {
    total?: number;
    router?: number;
    azureCall?: number;
  };
  responseHeaders?: {
    traceId?: string;
    source?: 'azure' | 'mock';
    contextRosterCount?: number;
  };
  contextSummary?: OrchestrateContextSummary;
  debugContext?: Record<string, unknown>;
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
    routerFallbackMessage?: string;
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
