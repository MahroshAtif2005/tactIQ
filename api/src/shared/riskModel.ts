import { RiskAgentRequest, RiskAgentResponse, RiskSeverity } from './types';

const normalizeRisk = (value: unknown): 'LOW' | 'MED' | 'HIGH' => {
  const upper = String(value || '').toUpperCase();
  if (upper === 'HIGH') return 'HIGH';
  if (upper === 'MED' || upper === 'MEDIUM') return 'MED';
  return 'LOW';
};

const normalizeRecovery = (value: unknown): 'Good' | 'Moderate' | 'Poor' => {
  const lower = String(value || 'Moderate').toLowerCase();
  if (lower === 'poor') return 'Poor';
  if (lower === 'good') return 'Good';
  return 'Moderate';
};

const normalizeRequest = (input: RiskAgentRequest): RiskAgentRequest => ({
  playerId: String(input.playerId || 'UNKNOWN'),
  fatigueIndex: Math.max(0, Math.min(10, Number(input.fatigueIndex) || 0)),
  injuryRisk: normalizeRisk(input.injuryRisk),
  noBallRisk: normalizeRisk(input.noBallRisk),
  oversBowled: Math.max(0, Number(input.oversBowled) || 0),
  consecutiveOvers: Math.max(0, Number(input.consecutiveOvers) || 0),
  heartRateRecovery: normalizeRecovery(input.heartRateRecovery),
  format: String(input.format || 'T20'),
  phase: String(input.phase || 'Middle'),
  intensity: String(input.intensity || 'Medium'),
  conditions: input.conditions ? String(input.conditions) : undefined,
  target: Number.isFinite(Number(input.target)) ? Number(input.target) : undefined,
  score: Number.isFinite(Number(input.score)) ? Number(input.score) : undefined,
  over: Number.isFinite(Number(input.over)) ? Number(input.over) : undefined,
  balls: Number.isFinite(Number(input.balls)) ? Number(input.balls) : undefined,
});

export function analyzeRisk(input: RiskAgentRequest): RiskAgentResponse {
  const echo = normalizeRequest(input);
  const signals: string[] = [];
  const riskWeight = (value: 'LOW' | 'MED' | 'HIGH') => {
    if (value === 'HIGH') return 3;
    if (value === 'MED') return 2;
    return 1;
  };
  const injuryWeight = riskWeight(echo.injuryRisk as 'LOW' | 'MED' | 'HIGH');
  const noBallWeight = riskWeight(echo.noBallRisk as 'LOW' | 'MED' | 'HIGH');
  let points = Math.round(echo.fatigueIndex) + injuryWeight + noBallWeight;

  if (echo.injuryRisk === 'HIGH' || echo.noBallRisk === 'HIGH') {
    signals.push('CONTROL_RISK');
  }

  if (echo.consecutiveOvers >= 4) {
    points += 3;
    signals.push('CONSEC_OVERS');
  } else if (echo.consecutiveOvers >= 3) {
    points += 2;
    signals.push('CONSEC_OVERS');
  }

  if (echo.oversBowled >= 12) {
    points += 2;
    signals.push('SPELL_LOAD');
  } else if (echo.oversBowled >= 8) {
    points += 1;
    signals.push('SPELL_LOAD');
  }

  const phase = String(echo.phase || '').toLowerCase();
  if (phase === 'death') {
    points += 2;
    signals.push('DEATH_PHASE_PRESSURE');
  } else if (phase === 'powerplay') {
    points += 1;
    signals.push('POWERPLAY_INTENSITY');
  }

  const intensity = String(echo.intensity || '').toLowerCase();
  if (intensity === 'high') {
    points += 2;
    signals.push('INTENSITY_HIGH');
  } else if (intensity === 'medium') {
    points += 1;
    signals.push('INTENSITY_MEDIUM');
  }

  const conditions = String(echo.conditions || '').toLowerCase();
  if (conditions === 'hot') {
    points += 1;
    signals.push('HEAT_STRESS');
  }

  const recovery = normalizeRecovery(echo.heartRateRecovery);
  if (recovery === 'Poor') {
    points += 2;
    signals.push('RECOVERY_POOR');
  } else if (recovery === 'Moderate') {
    points += 1;
    signals.push('RECOVERY_MODERATE');
  }

  const ballsRemaining = echo.balls != null ? Math.max(0, Number(echo.balls)) : undefined;
  if (echo.target != null && echo.score != null && ballsRemaining != null && ballsRemaining > 0) {
    const runsNeeded = Math.max(0, Number(echo.target) - Number(echo.score));
    const requiredRate = (runsNeeded / ballsRemaining) * 6;
    if (requiredRate >= 10 || (runsNeeded <= 20 && ballsRemaining <= 24)) {
      points += 2;
      signals.push('CHASE_PRESSURE');
    } else if (requiredRate >= 8 || runsNeeded <= 30) {
      points += 1;
      signals.push('CHASE_PRESSURE');
    }
  }

  const riskScore = Math.max(1, Math.min(10, points));

  let severity: RiskSeverity = 'LOW';
  if (riskScore >= 9) severity = 'CRITICAL';
  else if (riskScore >= 7) severity = 'HIGH';
  else if (riskScore >= 4) severity = 'MED';

  const headline =
    severity === 'CRITICAL'
      ? 'CRITICAL RISK DETECTED'
      : severity === 'HIGH'
      ? 'HIGH RISK DETECTED'
      : severity === 'MED'
        ? 'ELEVATED RISK DETECTED'
        : 'LOW RISK CONDITION';

  const recommendation =
    severity === 'CRITICAL'
      ? 'Immediately stop current spell and substitute; protect player workload.'
      : severity === 'HIGH'
      ? 'Immediately rest or rotate bowler; avoid high-pressure overs.'
      : severity === 'MED'
        ? 'Manage spell length and monitor next over closely.'
        : 'Continue with current plan and monitor trend.';

  const explanation = `Risk score ${riskScore}/10 combines fatigue ${echo.fatigueIndex.toFixed(1)}, injury/no-ball control risk, spell load, and match context pressure.`;

  return {
    agent: 'risk',
    severity,
    riskScore,
    headline,
    explanation,
    recommendation,
    signals: Array.from(new Set(signals)),
    echo,
  };
}
