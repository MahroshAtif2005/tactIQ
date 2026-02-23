export type BaselineRole = 'FAST' | 'SPIN' | 'BAT' | 'AR';

export interface PlayerBaseline {
  id: string;
  role: BaselineRole;
  sleep: number;
  recovery: number;
  fatigueLimit: number;
  control: number;
  speed: number;
  power: number;
  active: boolean;
  name?: string;
  orderIndex?: number;
  createdAt?: string;
  updatedAt?: string;
}

// Baseline keeps backward-compatible aliases used across existing UI logic.
export interface Baseline extends PlayerBaseline {
  playerId: string;
  name: string;
  isActive: boolean;
  sleepHoursToday: number;
  recoveryMinutes: number;
  controlBaseline: number;
}
