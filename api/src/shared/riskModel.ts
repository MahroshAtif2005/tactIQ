import { RiskAgentRequest, RiskAgentResponse, RiskSeverity } from './types';

type RecoveryLevel = 'GOOD' | 'MODERATE' | 'POOR' | 'UNKNOWN';
type RiskBand = 'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN';
type InjuryBand = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

const toFiniteNumber = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
};

const normalizeRiskInput = (value: unknown): 'LOW' | 'MED' | 'HIGH' | 'UNKNOWN' => {
  const upper = String(value || '').toUpperCase();
  if (upper === 'HIGH') return 'HIGH';
  if (upper === 'MED' || upper === 'MEDIUM') return 'MED';
  if (upper === 'LOW') return 'LOW';
  return 'UNKNOWN';
};

const normalizeRecovery = (value: unknown): RecoveryLevel => {
  const upper = String(value || '').toUpperCase();
  if (upper === 'GOOD') return 'GOOD';
  if (upper === 'MODERATE') return 'MODERATE';
  if (upper === 'POOR') return 'POOR';
  return 'UNKNOWN';
};

const maxAllowedOversByFormat = (format?: string): number => {
  const upper = String(format || '').toUpperCase();
  if (upper.includes('T20')) return 4;
  if (upper.includes('ODI')) return 10;
  if (upper.includes('TEST')) return 999;
  return 10;
};

const intensityMultiplier = (intensity?: string): number => {
  const normalized = String(intensity || '').trim().toUpperCase();
  if (normalized === 'LOW' || normalized === 'COOL') return 0.92;
  if (normalized === 'POWERPLAY' || normalized === 'DEATH' || normalized === 'HIGH') return 1.12;
  return 1.0;
};

const normalizeRequest = (input: RiskAgentRequest): RiskAgentRequest => {
  const maxOversRaw = toFiniteNumber(input.maxOvers);
  const maxOversByFormat = maxAllowedOversByFormat(input.format);
  const maxOvers = Number.isFinite(maxOversRaw) ? Math.max(1, Math.floor(maxOversRaw)) : maxOversByFormat;
  const oversBowledRaw = toFiniteNumber(input.oversBowled);
  const oversBowled = Number.isFinite(oversBowledRaw) ? clamp(oversBowledRaw, 0, maxOvers) : Number.NaN;
  const oversRemainingRaw = toFiniteNumber(input.oversRemaining);
  const oversRemaining = Number.isFinite(oversRemainingRaw)
    ? clamp(oversRemainingRaw, 0, maxOvers)
    : Number.isFinite(oversBowled)
      ? Math.max(0, maxOvers - oversBowled)
      : Number.NaN;
  const rawSpellOvers = Math.max(0, toFiniteNumber(input.consecutiveOvers));
  const consecutiveOvers = Number.isFinite(oversBowled) && Number.isFinite(rawSpellOvers)
    ? Math.min(rawSpellOvers, oversBowled)
    : 0;

  return {
    playerId: String(input.playerId || 'UNKNOWN'),
    fatigueIndex: clamp(toFiniteNumber(input.fatigueIndex), 0, 10),
    injuryRisk: normalizeRiskInput(input.injuryRisk),
    noBallRisk: normalizeRiskInput(input.noBallRisk),
    oversBowled,
    consecutiveOvers,
    oversRemaining,
    maxOvers,
    heartRateRecovery: normalizeRecovery(input.heartRateRecovery),
    isUnfit: Boolean(input.isUnfit),
    format: input.format ? String(input.format) : 'T20',
    phase: input.phase ? String(input.phase) : undefined,
    intensity: input.intensity ? String(input.intensity) : undefined,
    conditions: input.conditions ? String(input.conditions) : undefined,
    target: Number.isFinite(Number(input.target)) ? Number(input.target) : undefined,
    score: Number.isFinite(Number(input.score)) ? Number(input.score) : undefined,
    over: Number.isFinite(Number(input.over)) ? Number(input.over) : undefined,
    balls: Number.isFinite(Number(input.balls)) ? Number(input.balls) : undefined,
  };
};

const toInjuryBand = (score: number, fatigueIndex: number, isUnfit: boolean): InjuryBand => {
  if (!Number.isFinite(score)) return 'UNKNOWN';
  if (!isUnfit && fatigueIndex < 4) return 'LOW';
  if (isUnfit || fatigueIndex >= 9) return 'CRITICAL';
  if (fatigueIndex >= 7) return 'HIGH';
  if (fatigueIndex >= 4) return 'MEDIUM';
  return 'LOW';
};

const toNoBallBand = (score: number): RiskBand => {
  if (!Number.isFinite(score)) return 'UNKNOWN';
  if (score < 3) return 'LOW';
  if (score <= 5.4) return 'MEDIUM';
  return 'HIGH';
};

export const computeInjuryScore = (input: RiskAgentRequest): { score: number; level: InjuryBand } => {
  const fatigueIndex = clamp(toFiniteNumber(input.fatigueIndex), 0, 10);
  const isUnfit = Boolean(input.isUnfit);

  if (!Number.isFinite(fatigueIndex)) {
    return { score: 0, level: 'UNKNOWN' };
  }

  const score = clamp(fatigueIndex + (isUnfit ? 2.5 : 0), 0, 10);
  const level = toInjuryBand(score, fatigueIndex, isUnfit);

  return { score: Number(score.toFixed(2)), level };
};

export const computeNoBallScore = (input: RiskAgentRequest): { score: number; level: RiskBand; workloadRatio: number } => {
  const fatigueIndex = clamp(toFiniteNumber(input.fatigueIndex), 0, 10);
  const maxOvers = Math.max(1, toFiniteNumber(input.maxOvers) || maxAllowedOversByFormat(input.format));
  const oversBowled = clamp(toFiniteNumber(input.oversBowled), 0, maxOvers);
  const workloadRatio = Number.isFinite(oversBowled) ? clamp(oversBowled / maxOvers, 0, 1) : 0;
  const isUnfit = Boolean(input.isUnfit);

  if (!Number.isFinite(fatigueIndex) || !Number.isFinite(oversBowled)) {
    return { score: 0, level: 'UNKNOWN', workloadRatio: 0 };
  }

  const score = clamp(
    fatigueIndex * 0.55 + workloadRatio * 3.0 * intensityMultiplier(input.intensity) + (isUnfit ? 1.2 : 0),
    0,
    10
  );
  if (!isUnfit && oversBowled === 0 && fatigueIndex < 4) {
    return {
      score: Number(score.toFixed(2)),
      level: 'LOW',
      workloadRatio: Number(workloadRatio.toFixed(2)),
    };
  }
  const level = toNoBallBand(score);

  return {
    score: Number(score.toFixed(2)),
    level,
    workloadRatio: Number(workloadRatio.toFixed(2)),
  };
};

export const projectFatigueLinear = (fatigueIndex: number, oversAhead: number): number => {
  const safeFatigue = clamp(Number.isFinite(fatigueIndex) ? fatigueIndex : 0, 0, 10);
  const safeOversAhead = Math.max(0, Number.isFinite(oversAhead) ? oversAhead : 0);
  return Number(clamp(safeFatigue + safeOversAhead * 0.4, 0, 10).toFixed(2));
};

export function analyzeRisk(input: RiskAgentRequest): RiskAgentResponse {
  const echo = normalizeRequest(input);
  const recovery = normalizeRecovery(echo.heartRateRecovery);
  const injury = computeInjuryScore(echo);
  const noBall = computeNoBallScore(echo);
  const signals: string[] = [];

  if (injury.level === 'UNKNOWN' || noBall.level === 'UNKNOWN') {
    return {
      agent: 'risk',
      severity: 'UNKNOWN',
      riskScore: 0,
      headline: 'RISK UNKNOWN',
      explanation: 'Insufficient telemetry for deterministic injury/no-ball risk scoring.',
      recommendation: 'Collect telemetry (fatigue, overs bowled, overs remaining/quota, recovery) before substitution decisions.',
      signals: ['UNKNOWN_TELEMETRY'],
      echo,
      riskDebug: {
        fatigueIndex: Number.isFinite(echo.fatigueIndex) ? Number(echo.fatigueIndex.toFixed(2)) : 0,
        consecutiveOvers: Number.isFinite(echo.consecutiveOvers) ? Number(echo.consecutiveOvers.toFixed(2)) : 0,
        oversBowled: Number.isFinite(echo.oversBowled) ? Number(echo.oversBowled.toFixed(2)) : 0,
        workloadRatio: noBall.workloadRatio,
        heartRateRecovery: recovery,
        computedInjuryScore: injury.score,
        computedNoBallScore: noBall.score,
      },
    };
  }

  if (injury.level === 'CRITICAL') signals.push('INJURY_CRITICAL');
  if (injury.level === 'HIGH') signals.push('INJURY_HIGH');
  if (noBall.level === 'HIGH') signals.push('NO_BALL_HIGH');
  if (injury.level === 'MEDIUM') signals.push('INJURY_MEDIUM');
  if (noBall.level === 'MEDIUM') signals.push('NO_BALL_MEDIUM');

  const severityBand: RiskSeverity = injury.level === 'CRITICAL'
    ? 'CRITICAL'
    : injury.level === 'HIGH' || noBall.level === 'HIGH'
      ? 'HIGH'
      : injury.level === 'MEDIUM' || noBall.level === 'MEDIUM'
        ? 'MED'
        : 'LOW';

  const riskScore = Number(Math.max(injury.score, noBall.score).toFixed(2));
  const severity = severityBand;
  const headline = severity === 'CRITICAL'
    ? 'CRITICAL RISK DETECTED'
    : severity === 'HIGH'
    ? 'HIGH RISK DETECTED'
    : severity === 'MED'
      ? 'ELEVATED RISK DETECTED'
      : 'LOW RISK CONDITION';

  const recommendation = severity === 'CRITICAL'
    ? 'Immediate substitution advised: fatigue and workload quota exposure are in the critical zone.'
    : severity === 'HIGH'
    ? 'Reduce exposure immediately and consider substitution based on tactical context.'
    : severity === 'MED'
      ? 'Manage workload closely and reassess in the next over.'
      : 'Proceed with normal plan and continue telemetry monitoring.';

  return {
    agent: 'risk',
    severity,
    riskScore,
    headline,
    explanation:
      `Deterministic telemetry scoring: injury=${injury.score}/10 (${injury.level}), ` +
      `no-ball=${noBall.score}/10 (${noBall.level}).`,
    recommendation,
    signals,
    echo,
    riskDebug: {
      fatigueIndex: Number(echo.fatigueIndex.toFixed(2)),
      consecutiveOvers: Number(echo.consecutiveOvers.toFixed(2)),
      oversBowled: Number(echo.oversBowled.toFixed(2)),
      workloadRatio: noBall.workloadRatio,
      heartRateRecovery: recovery,
      computedInjuryScore: injury.score,
      computedNoBallScore: noBall.score,
    },
  };
}
