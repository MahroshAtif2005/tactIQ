export type InjuryRisk = 'LOW' | 'MED' | 'HIGH' | 'MEDIUM';
export type Severity = 'LOW' | 'MED' | 'HIGH';

export interface FatigueAgentResponse {
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
    heartRateRecovery?: string;
  };
  suggestedTweaks?: {
    suggestedRestOvers?: number;
    suggestedSubRole?: string;
    notes?: string;
  };
}
