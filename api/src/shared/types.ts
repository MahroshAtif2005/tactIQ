import { FullMatchContext, ReplacementCandidate } from './matchContext';

export type InjuryRisk = 'LOW' | 'MEDIUM' | 'HIGH' | 'MED' | 'UNKNOWN';
export type Severity = 'LOW' | 'MED' | 'HIGH';

export interface FatigueAgentRequest {
  playerId: string;
  playerName: string;
  role: string;
  oversBowled: number;
  consecutiveOvers: number;
  oversRemaining?: number;
  maxOvers?: number;
  quotaComplete?: boolean;
  fatigueIndex: number;
  injuryRisk: InjuryRisk;
  noBallRisk: InjuryRisk;
  heartRateRecovery: string;
  fatigueLimit: number;
  sleepHours: number;
  recoveryMinutes: number;
  snapshotId?: string;
  matchContext: {
    format: string;
    phase: string;
    over: number;
    intensity: string;
  };
  fullMatchContext?: FullMatchContext;
  replacementCandidates?: ReplacementCandidate[];
}

export interface FatigueModelDebug {
  inputFatigueIndex: number;
  modelFatigueIndex: number;
  base: number;
  sleepPenalty: number;
  recoveryBonus: number;
  limitPressure: number;
}

export interface FatigueModelResult {
  severity: Severity;
  signals: string[];
  headline: string;
  explanation: string;
  recommendation: string;
  suggestedTweaks?: {
    suggestedRestOvers?: number;
    suggestedSubRole?: string;
    notes?: string;
  };
  debug: FatigueModelDebug;
}

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
    injuryRisk: Severity;
    noBallRisk: Severity;
    oversBowled: number;
    consecutiveOvers: number;
    heartRateRecovery?: string;
  };
  suggestedTweaks?: {
    suggestedRestOvers?: number;
    suggestedSubRole?: string;
    notes?: string;
  };
  debug?: unknown;
}

export type RiskLevelInput = 'LOW' | 'MED' | 'HIGH' | 'MEDIUM' | 'UNKNOWN';
export type RiskSeverity = 'LOW' | 'MED' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';

export interface RiskAgentRequest {
  playerId: string;
  fatigueIndex: number;
  strainIndex?: number;
  injuryRisk: RiskLevelInput;
  noBallRisk: RiskLevelInput;
  oversBowled: number;
  consecutiveOvers: number;
  oversRemaining?: number;
  maxOvers?: number;
  quotaComplete?: boolean;
  heartRateRecovery?: string;
  isUnfit?: boolean;
  format?: string;
  phase?: string;
  intensity?: string;
  conditions?: string;
  target?: number;
  score?: number;
  over?: number;
  balls?: number;
  fullMatchContext?: FullMatchContext;
  replacementCandidates?: ReplacementCandidate[];
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
  echo: RiskAgentRequest;
  riskDebug?: {
    fatigueIndex: number;
    consecutiveOvers: number;
    oversBowled: number;
    workloadRatio: number;
    heartRateRecovery: 'GOOD' | 'MODERATE' | 'POOR' | 'UNKNOWN';
    computedInjuryScore: number;
    computedNoBallScore: number;
  };
}
