export type Role = 'Fast Bowler' | 'All-rounder' | 'Spinner';
export type Phase = 'Powerplay' | 'Middle' | 'Death';
export type RiskLevel = 'Low' | 'Medium' | 'High';
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
  const baseLoad = (oversBowled * 0.55) + (consecutiveOvers * 0.9);
  let raw = baseLoad * phaseMult(phase) * roleMult(role);
  const recoveryFactor = 1 - (0.25 * baselineRecoveryScore);
  raw *= recoveryFactor;
  return clamp(round1(raw), 0, 10);
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
  loadRatio: number,
  consecutiveOvers: number,
  role: Role,
  recoveryDisplayed: RecoveryLevel
): RiskLevel => {
  // Injury score combines tolerance breach, spell pressure, role, and shown recovery.
  let score = 1;
  if (loadRatio > 1.0) score = 3;
  else if (loadRatio > 0.7) score = 2;

  if (consecutiveOvers >= 3) score += 1;
  if (role === 'Fast Bowler') score += 1;

  if (recoveryDisplayed === 'Poor') score += 1;
  if (recoveryDisplayed === 'Good') score -= 1;

  const bounded = clamp(score, 1, 3);
  if (bounded === 1) return 'Low';
  if (bounded === 2) return 'Medium';
  return 'High';
};

export const computeNoBallRisk = (
  fatigue: number,
  consecutiveOvers: number,
  phase: Phase
): RiskLevel => {
  // No-ball risk follows fatigue band + pressure modifiers from spell/phase.
  let score = 1;
  if (fatigue > 7) score = 3;
  else if (fatigue >= 5) score = 2;

  if (consecutiveOvers >= 3) score += 1;
  if (phase === 'Powerplay' || phase === 'Death') score += 1;

  const bounded = clamp(score, 1, 3);
  if (bounded === 1) return 'Low';
  if (bounded === 2) return 'Medium';
  return 'High';
};

export const computeStatus = (loadRatio: number): StatusLevel => {
  if (loadRatio > 1.0) return 'EXCEEDED LIMIT';
  if (loadRatio > 0.85) return 'APPROACHING LIMIT';
  return 'WITHIN SAFE RANGE';
};
