import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { RiskAgentRequest, RiskAgentResponse } from '../shared/types';
import { runRiskAgent } from '../agents/riskAgent';

const sanitizeRequest = (payload: Partial<RiskAgentRequest>): RiskAgentRequest => {
  const toNum = (value: unknown, fallback: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const toRisk = (value: unknown): RiskAgentRequest['injuryRisk'] => {
    const upper = String(value || '').toUpperCase();
    if (upper === 'LOW' || upper === 'MED' || upper === 'MEDIUM' || upper === 'HIGH') return upper as RiskAgentRequest['injuryRisk'];
    return 'UNKNOWN';
  };

  const oversBowled = toNum(payload.oversBowled, Number.NaN);
  const format = String((payload as RiskAgentRequest).format || (payload as any).match?.format || 'T20');
  const formatMaxOvers =
    format.toUpperCase().includes('T20') ? 4 : format.toUpperCase().includes('ODI') ? 10 : 999;
  const maxOversRaw = toNum((payload as RiskAgentRequest).maxOvers, formatMaxOvers);
  const maxOvers = Number.isFinite(maxOversRaw) ? Math.max(1, Math.floor(maxOversRaw)) : formatMaxOvers;
  const spellOversRaw = toNum(payload.consecutiveOvers, Number.NaN);
  const normalizedOvers = Number.isFinite(oversBowled) ? Math.min(maxOvers, Math.max(0, oversBowled)) : Number.NaN;
  const normalizedSpellOvers = Number.isFinite(spellOversRaw)
    ? Math.max(0, spellOversRaw)
    : Number.NaN;
  const clampedSpellOvers = Number.isFinite(normalizedOvers) && Number.isFinite(normalizedSpellOvers)
    ? Math.min(normalizedSpellOvers, normalizedOvers)
    : normalizedSpellOvers;
  const oversRemainingRaw = toNum((payload as RiskAgentRequest).oversRemaining, Number.NaN);
  const oversRemaining = Number.isFinite(oversRemainingRaw)
    ? Math.min(maxOvers, Math.max(0, oversRemainingRaw))
    : Number.isFinite(normalizedOvers)
      ? Math.max(0, maxOvers - normalizedOvers)
      : Number.NaN;

  return {
    playerId: String(payload.playerId || 'UNKNOWN'),
    fatigueIndex: Math.max(0, Math.min(10, toNum(payload.fatigueIndex, Number.NaN))),
    injuryRisk: toRisk(payload.injuryRisk),
    noBallRisk: toRisk(payload.noBallRisk),
    oversBowled: normalizedOvers,
    consecutiveOvers: clampedSpellOvers,
    oversRemaining,
    maxOvers,
    quotaComplete: payload.quotaComplete === true,
    heartRateRecovery: payload.heartRateRecovery ? String(payload.heartRateRecovery) : undefined,
    isUnfit: payload.isUnfit === true,
    format,
    phase: String((payload as RiskAgentRequest).phase || (payload as any).match?.phase || 'Middle'),
    intensity: String((payload as RiskAgentRequest).intensity || (payload as any).match?.intensity || 'Medium'),
    conditions: (payload as RiskAgentRequest).conditions
      ? String((payload as RiskAgentRequest).conditions)
      : (payload as any).match?.conditions
        ? String((payload as any).match?.conditions)
        : undefined,
    target: Number.isFinite(toNum((payload as RiskAgentRequest).target, NaN))
      ? toNum((payload as RiskAgentRequest).target, 0)
      : undefined,
    score: Number.isFinite(toNum((payload as RiskAgentRequest).score, NaN))
      ? toNum((payload as RiskAgentRequest).score, 0)
      : undefined,
    over: Number.isFinite(toNum((payload as RiskAgentRequest).over, NaN))
      ? toNum((payload as RiskAgentRequest).over, 0)
      : undefined,
    balls: Number.isFinite(toNum((payload as RiskAgentRequest).balls, NaN))
      ? toNum((payload as RiskAgentRequest).balls, 0)
      : undefined,
  };
};

export async function riskHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const body = (await request.json()) as Partial<RiskAgentRequest>;
    const input = sanitizeRequest(body);
    if (process.env.NODE_ENV !== 'production') {
      console.log('Risk payload', input);
    }

    const result = await runRiskAgent(input);
    const response: RiskAgentResponse = {
      ...result.output,
      status: result.output.status || (result.fallbacksUsed.length > 0 ? 'fallback' : 'ok'),
    };
    const pointsHint = response.explanation.match(/score (\d+)/)?.[1];
    if (process.env.NODE_ENV !== 'production') {
      console.log('Risk computed', {
        points: pointsHint ? Number(pointsHint) : undefined,
        severity: response.severity,
        signals: response.signals,
      });
    }

    return {
      status: 200,
      jsonBody: {
        ...response,
        meta: {
          model: result.model,
          fallbacksUsed: result.fallbacksUsed,
        },
      },
    };
  } catch (error) {
    context.error('Risk agent error', error);
    return {
      status: 400,
      jsonBody: {
        error: 'Invalid request payload',
      },
    };
  }
}

app.http('risk', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'agents/risk',
  handler: riskHandler,
});
