export type InjuryRisk = 'LOW' | 'MEDIUM' | 'HIGH';

export interface FatigueAgentResponse {
  agent: string;
  version: string;
  playerId: string;
  fatigueIndex: number;
  injuryRisk: InjuryRisk;
  signals: string[];
  explanation: string;
}
