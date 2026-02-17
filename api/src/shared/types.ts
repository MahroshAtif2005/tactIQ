export type InjuryRisk = 'LOW' | 'MEDIUM' | 'HIGH' | 'MED';
export type Severity = 'LOW' | 'MED' | 'HIGH';

export interface FatigueAgentRequest {
  playerId: string;
  playerName: string;
  role: string;
  oversBowled: number;
  consecutiveOvers: number;
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
  severity: Severity;
  headline: string;
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
