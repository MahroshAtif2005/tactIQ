import { FatigueAgentRequest, FatigueModelResult, InjuryRisk } from './types';

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function scoreFatigue(input: FatigueAgentRequest): FatigueModelResult {
  const base = (input.oversBowled * 1.2) + (input.consecutiveOvers * 0.9);
  const sleepPenalty = Math.max(0, 7 - input.sleepHours) * 0.6;
  const recoveryBonus = Math.min(1.5, input.recoveryMinutes / 60) * 0.8;
  const limitPressure = Math.max(0, base - input.fatigueLimit) * 0.7;

  const rawFatigue = clamp(base + sleepPenalty + limitPressure - recoveryBonus, 0, 10);
  const fatigueIndex = Number(rawFatigue.toFixed(1));

  let injuryRisk: InjuryRisk = 'LOW';
  if (fatigueIndex >= 7) injuryRisk = 'HIGH';
  else if (fatigueIndex >= 4) injuryRisk = 'MEDIUM';

  const signals: string[] = [];
  if (input.sleepHours < 7) signals.push('LOW_SLEEP');
  if (input.consecutiveOvers >= 2) signals.push('CONSEC_OVERS');
  if (fatigueIndex >= input.fatigueLimit) signals.push('NEARING_LIMIT');
  if (fatigueIndex >= 7) signals.push('HIGH_FATIGUE');

  return {
    fatigueIndex,
    injuryRisk,
    signals,
    debug: {
      base: Number(base.toFixed(3)),
      sleepPenalty: Number(sleepPenalty.toFixed(3)),
      recoveryBonus: Number(recoveryBonus.toFixed(3)),
      limitPressure: Number(limitPressure.toFixed(3))
    }
  };
}
