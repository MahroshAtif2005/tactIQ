import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { analyzeRisk } from '../shared/riskModel';
import { RiskAgentRequest, RiskAgentResponse } from '../shared/types';

const sanitizeRequest = (payload: Partial<RiskAgentRequest>): RiskAgentRequest => {
  const toNum = (value: unknown, fallback: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  return {
    playerId: String(payload.playerId || 'UNKNOWN'),
    fatigueIndex: Math.max(0, Math.min(10, toNum(payload.fatigueIndex, 0))),
    injuryRisk: String(payload.injuryRisk || 'LOW').toUpperCase() as RiskAgentRequest['injuryRisk'],
    noBallRisk: String(payload.noBallRisk || 'LOW').toUpperCase() as RiskAgentRequest['noBallRisk'],
    oversBowled: Math.max(0, toNum(payload.oversBowled, 0)),
    consecutiveOvers: Math.max(0, toNum(payload.consecutiveOvers, 0)),
    heartRateRecovery: payload.heartRateRecovery ? String(payload.heartRateRecovery) : undefined,
    format: String((payload as RiskAgentRequest).format || (payload as any).match?.format || 'T20'),
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

    const result: RiskAgentResponse = analyzeRisk(input);
    const pointsHint = result.explanation.match(/score (\d+)/)?.[1];
    if (process.env.NODE_ENV !== 'production') {
      console.log('Risk computed', {
        points: pointsHint ? Number(pointsHint) : undefined,
        severity: result.severity,
        signals: result.signals,
      });
    }

    return {
      status: 200,
      jsonBody: result,
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
