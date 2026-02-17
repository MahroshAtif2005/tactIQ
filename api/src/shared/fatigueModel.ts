import { FatigueAgentRequest, FatigueModelResult, Severity } from './types';

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function scoreFatigue(input: FatigueAgentRequest): FatigueModelResult {
  const base = (input.oversBowled * 1.2) + (input.consecutiveOvers * 0.9);
  const sleepPenalty = Math.max(0, 7 - input.sleepHours) * 0.6;
  const recoveryBonus = Math.min(1.5, input.recoveryMinutes / 60) * 0.8;
  const limitPressure = Math.max(0, base - input.fatigueLimit) * 0.7;
  const inputFatigueIndex = clamp(input.fatigueIndex, 0, 10);
  const modelFatigueIndex = clamp(base + sleepPenalty + limitPressure - recoveryBonus, 0, 10);

  const normalizeSeverity = (risk: string): Severity => {
    const upper = String(risk || '').toUpperCase();
    if (upper === 'HIGH') return 'HIGH';
    if (upper === 'MED' || upper === 'MEDIUM') return 'MED';
    return 'LOW';
  };

  let severity: Severity = normalizeSeverity(input.injuryRisk);
  if (inputFatigueIndex >= 7) severity = 'HIGH';
  else if (inputFatigueIndex >= 4 && severity === 'LOW') severity = 'MED';

  const signals: string[] = [];
  if (input.sleepHours < 7) signals.push('LOW_SLEEP');
  if (input.consecutiveOvers >= 2) signals.push('CONSEC_OVERS');
  if (inputFatigueIndex >= input.fatigueLimit) signals.push('NEARING_LIMIT');
  if (inputFatigueIndex >= 7) signals.push('HIGH_FATIGUE');
  if (input.noBallRisk === 'HIGH') signals.push('NO_BALL_ALERT');
  if (input.heartRateRecovery.toLowerCase() === 'poor') signals.push('POOR_HR_RECOVERY');

  const headline = severity === 'HIGH'
    ? 'HIGH RISK DETECTED'
    : severity === 'MED'
      ? 'ELEVATED RISK DETECTED'
      : 'LOW RISK CONDITION';

  const explanation = `${input.playerName} measured fatigue is ${inputFatigueIndex.toFixed(1)}/10 with ${severity} advisory risk.`;

  const recommendation = severity === 'HIGH'
    ? 'Reduce workload immediately and consider substitution.'
    : severity === 'MED'
      ? 'Manage spell length and monitor next over closely.'
      : 'Continue with current plan and monitor fatigue trend.';

  const suggestedTweaks = severity === 'HIGH'
    ? { suggestedRestOvers: 2, suggestedSubRole: 'Spinner', notes: 'Temporary substitution recommended.' }
    : severity === 'MED'
      ? { suggestedRestOvers: 1, notes: 'Short rest window can stabilize fatigue.' }
      : { notes: 'No immediate intervention required.' };

  return {
    severity,
    signals,
    headline,
    explanation,
    recommendation,
    suggestedTweaks,
    debug: {
      inputFatigueIndex: Number(inputFatigueIndex.toFixed(3)),
      modelFatigueIndex: Number(modelFatigueIndex.toFixed(3)),
      base: Number(base.toFixed(3)),
      sleepPenalty: Number(sleepPenalty.toFixed(3)),
      recoveryBonus: Number(recoveryBonus.toFixed(3)),
      limitPressure: Number(limitPressure.toFixed(3))
    }
  };
}
