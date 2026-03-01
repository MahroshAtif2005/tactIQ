export interface MatchSetupContext {
  matchMode: 'BATTING' | 'BOWLING' | string;
  format: 'ODI' | 'T20' | 'Test' | string;
  phase: 'Powerplay' | 'Middle' | 'Death' | string;
  intensity: 'Low' | 'Medium' | 'High' | string;
  tempState: 'Cool' | 'Normal' | 'Hot' | string;
  scoreRuns: number;
  wickets: number;
  overs: number;
  balls: number;
  targetRuns?: number;
  requiredRunRate?: number;
  timestamp: string;
}

export interface PlayerBaselineContext {
  playerId: string;
  name: string;
  role?: string;
  sleepHours?: number;
  recoveryScore?: number;
  workload7d?: number;
  workload28d?: number;
  injuryHistoryFlags?: string[];
  fatigueLimit?: number;
  controlBaseline?: number;
  speed?: number;
  power?: number;
}

export interface PlayerLiveTelemetry {
  playerId: string;
  fatigueIndex?: number;
  strainIndex?: number;
  injuryRisk?: 'LOW' | 'MEDIUM' | 'HIGH' | string;
  noBallRisk?: 'LOW' | 'MEDIUM' | 'HIGH' | string;
  heartRateRecovery?: 'Poor' | 'Ok' | 'Good' | string;
  oversBowled?: number;
  lastUpdated: string;
}

export interface RosterPlayerContext {
  playerId: string;
  name: string;
  role?: string;
  baseline: PlayerBaselineContext;
  live: PlayerLiveTelemetry;
}

export interface FullMatchContext {
  match: MatchSetupContext;
  roster: RosterPlayerContext[];
  activePlayerId?: string;
  uiFlags?: {
    powerplay: boolean;
    autoRouting: boolean;
  };
  contextVersion: 'v1';
}
