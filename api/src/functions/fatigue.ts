import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { analyzeFatigue } from '../shared/analysisProvider';
import { FatigueAgentRequest, FatigueAgentResponse } from '../shared/types';

const sanitizeRequest = (payload: Partial<FatigueAgentRequest>): FatigueAgentRequest => {
  const toNum = (value: unknown, fallback: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const toRisk = (value: unknown, fallback: FatigueAgentRequest['injuryRisk']) => {
    const upper = String(value || fallback).toUpperCase();
    return upper === 'LOW' || upper === 'MEDIUM' || upper === 'HIGH' ? upper : fallback;
  };

  return {
    playerId: String(payload.playerId || 'UNKNOWN'),
    playerName: String(payload.playerName || 'Unknown Player'),
    role: String(payload.role || 'Unknown Role'),
    oversBowled: Math.max(0, toNum(payload.oversBowled, 0)),
    consecutiveOvers: Math.max(0, toNum(payload.consecutiveOvers, 0)),
    fatigueIndex: Math.max(0, Math.min(10, toNum(payload.fatigueIndex, 3))),
    injuryRisk: toRisk(payload.injuryRisk, 'MEDIUM'),
    noBallRisk: toRisk(payload.noBallRisk, 'MEDIUM'),
    heartRateRecovery: String(payload.heartRateRecovery || 'Moderate'),
    fatigueLimit: Math.max(0, toNum(payload.fatigueLimit, 6)),
    sleepHours: Math.max(0, toNum(payload.sleepHours, 7)),
    recoveryMinutes: Math.max(0, toNum(payload.recoveryMinutes, 0)),
    snapshotId: String(payload.snapshotId || ''),
    matchContext: {
      format: String(payload.matchContext?.format || 'T20'),
      phase: String(payload.matchContext?.phase || 'Middle'),
      over: toNum(payload.matchContext?.over, 0),
      intensity: String(payload.matchContext?.intensity || 'Medium'),
    },
  };
};

export async function fatigueHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const body = (await request.json()) as Partial<FatigueAgentRequest>;
    const input = sanitizeRequest(body);
    context.log('Fatigue payload', {
      playerId: input.playerId,
      snapshotId: input.snapshotId,
      fatigueIndex: input.fatigueIndex,
      injuryRisk: input.injuryRisk,
      noBallRisk: input.noBallRisk,
      oversBowled: input.oversBowled,
      consecutiveOvers: input.consecutiveOvers,
      heartRateRecovery: input.heartRateRecovery,
    });
    const { output, mode } = await analyzeFatigue(input);
    context.log('Fatigue analysis output mode', { mode });
    const response: FatigueAgentResponse = {
      severity: output.severity,
      headline: output.headline,
      explanation: output.explanation,
      recommendation: output.recommendation,
      signals: output.signals,
      echo: output.echo,
      ...(output.suggestedTweaks ? { suggestedTweaks: output.suggestedTweaks } : {}),
    };

    return {
      status: 200,
      jsonBody: response,
    };
  } catch (error) {
    context.error('Fatigue agent error', error);
    return {
      status: 400,
      jsonBody: {
        error: 'Invalid request payload',
      },
    };
  }
}

app.http('fatigue', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'agents/fatigue',
  handler: fatigueHandler,
});
