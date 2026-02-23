export type Role = 'Fast Bowler' | 'All-rounder' | 'Spinner';
export type Phase = 'Powerplay' | 'Middle' | 'Death';
export type RiskLevel = 'Low' | 'Medium' | 'High';
export type InjuryRiskLevel = RiskLevel | 'Critical';
export type RecoveryLevel = 'Good' | 'Moderate' | 'Poor';
export type RecoveryMode = 'auto' | 'manual';
export type StatusLevel = 'WITHIN SAFE RANGE' | 'APPROACHING LIMIT' | 'EXCEEDED LIMIT';

export const clamp = (x: number, min: number, max: number): number => Math.min(max, Math.max(min, x));
export const round1 = (x: number): number => Math.round(x * 10) / 10;

export const roleMult = (role: Role): number => {
  if (role === 'Fast Bowler') return 1.1;
  if (role === 'Spinner') return 0.95;
  return 1.0;
};

export const phaseMult = (phase: Phase): number => {
  if (phase === 'Powerplay') return 1.1;
  if (phase === 'Death') return 1.15;
  return 1.0;
};

const toWorkloadRatio = (oversBowled: number, maxOvers: number): number => {
  const safeMax = Math.max(1, Math.floor(Number.isFinite(maxOvers) ? maxOvers : 1));
  const safeOvers = clamp(Math.floor(Number.isFinite(oversBowled) ? oversBowled : 0), 0, safeMax);
  return safeOvers / safeMax;
};

const intensityMultiplier = (intensity?: string): number => {
  const normalized = String(intensity || '').trim().toUpperCase();
  if (normalized === 'LOW' || normalized === 'COOL') return 0.92;
  if (normalized === 'POWERPLAY' || normalized === 'DEATH' || normalized === 'HIGH') return 1.12;
  return 1.0;
};

export const computeBaselineRecoveryScore = (sleepHrs: number, recoveryMin: number): number => {
  // Weighted baseline readiness from sleep and recovery profile.
  const sleepScore = clamp((sleepHrs - 5) / 3, 0, 1);
  const recMinScore = clamp((recoveryMin - 20) / 40, 0, 1);
  return (0.6 * sleepScore) + (0.4 * recMinScore);
};

export const computeFatigue = (
  oversBowled: number,
  consecutiveOvers: number,
  phase: Phase,
  role: Role,
  baselineRecoveryScore: number
): number => {
  // Match load scaled by phase/role, then reduced by baseline recovery ability.
  const safeOvers = Math.max(0, oversBowled);
  const safeConsecutive = Math.max(0, Math.min(consecutiveOvers, safeOvers));
  const baseLoad = (safeOvers * 0.55) + (safeConsecutive * 0.9);
  let raw = baseLoad * phaseMult(phase) * roleMult(role);
  const recoveryFactor = 1 - (0.25 * baselineRecoveryScore);
  raw *= recoveryFactor;
  const floorAtFreshSpell = safeOvers === 0 && safeConsecutive === 0 ? 2.5 : 0;
  return clamp(round1(Math.max(raw, floorAtFreshSpell)), 0, 10);
};

export const computeLoadRatio = (fatigue: number, fatigueLimit: number): number => {
  const effectiveLimit = Math.max(1, fatigueLimit);
  return fatigue / effectiveLimit;
};

export const computeRecoveryLevelAuto = (
  baselineRecoveryScore: number,
  loadRatio: number
): RecoveryLevel => {
  // Baseline recovery is penalized as load approaches/exceeds tolerance.
  let penalty = 0;
  if (loadRatio > 1.0) penalty = 0.2;
  else if (loadRatio > 0.85) penalty = 0.1;

  const effectiveRecoveryScore = clamp(baselineRecoveryScore - penalty, 0, 1);
  if (effectiveRecoveryScore >= 0.66) return 'Good';
  if (effectiveRecoveryScore >= 0.4) return 'Moderate';
  return 'Poor';
};

export const computeInjuryRisk = (
  fatigueIndex: number,
  _oversBowled: number,
  _maxOvers: number,
  isUnfit: boolean = false
): InjuryRiskLevel => {
  const safeFatigue = clamp(Number.isFinite(fatigueIndex) ? fatigueIndex : 0, 0, 10);
  if (!isUnfit && safeFatigue < 4) return 'Low';
  if (isUnfit || safeFatigue >= 9) return 'Critical';
  if (safeFatigue >= 7) return 'High';
  if (safeFatigue >= 4) return 'Medium';
  return 'Low';
};

export const computeNoBallRisk = (
  fatigue: number,
  oversBowled: number,
  maxOvers: number,
  intensity?: string,
  isUnfit: boolean = false
): RiskLevel => {
  const safeFatigue = clamp(Number.isFinite(fatigue) ? fatigue : 0, 0, 10);
  const safeMax = Math.max(1, Math.floor(Number.isFinite(maxOvers) ? maxOvers : 1));
  const safeOvers = clamp(Math.floor(Number.isFinite(oversBowled) ? oversBowled : 0), 0, safeMax);
  const workloadRatio = toWorkloadRatio(safeOvers, safeMax);
  const score = clamp(
    safeFatigue * 0.55 + workloadRatio * 3.0 * intensityMultiplier(intensity) + (isUnfit ? 1.2 : 0),
    0,
    10
  );
  if (!isUnfit && safeOvers === 0 && safeFatigue < 4) return 'Low';
  if (score < 3) return 'Low';
  if (score <= 5.4) return 'Medium';
  return 'High';
};

export const computeStatus = (loadRatio: number): StatusLevel => {
  if (loadRatio > 1.0) return 'EXCEEDED LIMIT';
  if (loadRatio > 0.85) return 'APPROACHING LIMIT';
  return 'WITHIN SAFE RANGE';
};
