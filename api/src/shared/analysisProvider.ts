import { scoreFatigue } from './fatigueModel';
import { FatigueAgentRequest, FatigueAgentResponse, Severity } from './types';

const normalizeSeverity = (value: unknown): Severity => {
  const upper = String(value || '').toUpperCase();
  if (upper === 'HIGH') return 'HIGH';
  if (upper === 'MED' || upper === 'MEDIUM') return 'MED';
  return 'LOW';
};

const clampFatigue = (value: unknown): number => {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(10, n));
};

const buildEcho = (input: FatigueAgentRequest): FatigueAgentResponse['echo'] => ({
  playerId: input.playerId || undefined,
  fatigueIndex: clampFatigue(input.fatigueIndex),
  injuryRisk: normalizeSeverity(input.injuryRisk),
  noBallRisk: normalizeSeverity(input.noBallRisk),
  oversBowled: Math.max(0, Number(input.oversBowled) || 0),
  consecutiveOvers: Math.max(0, Number(input.consecutiveOvers) || 0),
  heartRateRecovery: input.heartRateRecovery || undefined,
});

export const analyzeFatigueRuleBased = (input: FatigueAgentRequest): FatigueAgentResponse => {
  const model = scoreFatigue(input);
  return {
    severity: model.severity,
    headline: model.headline,
    explanation: model.explanation,
    recommendation: model.recommendation,
    signals: model.signals,
    echo: buildEcho(input),
    suggestedTweaks: model.suggestedTweaks,
  };
};

// Legacy export retained for compatibility in callers that import analyzeFatigue directly.
export async function analyzeFatigue(input: FatigueAgentRequest): Promise<{ output: FatigueAgentResponse; mode: 'rule' }> {
  return { output: analyzeFatigueRuleBased(input), mode: 'rule' };
}
