export type InjuryRisk = 'LOW' | 'MEDIUM' | 'HIGH';

export interface FatigueAgentRequest {
  playerId: string;
  playerName: string;
  role: string;
  oversBowled: number;
  consecutiveOvers: number;
  fatigueLimit: number;
  sleepHours: number;
  recoveryMinutes: number;
  matchContext: {
    format: string;
    phase: string;
    over: number;
    intensity: string;
  };
}

export interface FatigueModelDebug {
  base: number;
  sleepPenalty: number;
  recoveryBonus: number;
  limitPressure: number;
}

export interface FatigueModelResult {
  fatigueIndex: number;
  injuryRisk: InjuryRisk;
  signals: string[];
  debug: FatigueModelDebug;
}

export interface FatigueAgentResponse {
  agent: 'fatigue';
  version: '1.0';
  playerId: string;
  fatigueIndex: number;
  injuryRisk: InjuryRisk;
  signals: string[];
  explanation: string;
  debug?: FatigueModelDebug;
}
