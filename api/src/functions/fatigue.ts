import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { generateAzureExplanation } from '../shared/azureOpenAI';
import { scoreFatigue } from '../shared/fatigueModel';
import { FatigueAgentRequest, FatigueAgentResponse } from '../shared/types';

const sanitizeRequest = (payload: Partial<FatigueAgentRequest>): FatigueAgentRequest => {
  const toNum = (value: unknown, fallback: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  return {
    playerId: String(payload.playerId || 'UNKNOWN'),
    playerName: String(payload.playerName || 'Unknown Player'),
    role: String(payload.role || 'Unknown Role'),
    oversBowled: Math.max(0, toNum(payload.oversBowled, 0)),
    consecutiveOvers: Math.max(0, toNum(payload.consecutiveOvers, 0)),
    fatigueLimit: Math.max(0, toNum(payload.fatigueLimit, 6)),
    sleepHours: Math.max(0, toNum(payload.sleepHours, 7)),
    recoveryMinutes: Math.max(0, toNum(payload.recoveryMinutes, 0)),
    matchContext: {
      format: String(payload.matchContext?.format || 'T20'),
      phase: String(payload.matchContext?.phase || 'Middle'),
      over: toNum(payload.matchContext?.over, 0),
      intensity: String(payload.matchContext?.intensity || 'Medium'),
    },
  };
};

const fallbackExplanation = (result: ReturnType<typeof scoreFatigue>, input: FatigueAgentRequest) => {
  const signals = result.signals.length > 0 ? result.signals.join(', ') : 'stable workload';
  return `${input.playerName} is at fatigue ${result.fatigueIndex}/10 with ${result.injuryRisk} risk; key signals: ${signals}. Consider rotation and recovery before the next spell.`;
};

export async function fatigueHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const body = (await request.json()) as Partial<FatigueAgentRequest>;
    const input = sanitizeRequest(body);
    const model = scoreFatigue(input);

    const explanation = (await generateAzureExplanation(input, model)) ?? fallbackExplanation(model, input);
    const includeDebug = request.query.get('debug') === '1' || process.env.NODE_ENV !== 'production';

    const response: FatigueAgentResponse = {
      agent: 'fatigue',
      version: '1.0',
      playerId: input.playerId,
      fatigueIndex: model.fatigueIndex,
      injuryRisk: model.injuryRisk,
      signals: model.signals,
      explanation,
      ...(includeDebug ? { debug: model.debug } : {}),
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
