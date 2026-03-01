import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { orchestrateAgents } from '../orchestrator/orchestrator';
import { validateOrchestrateRequest } from '../orchestrator/validation';
import { ROUTES } from '../routes/routes';

export async function analysisFullHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const body = await request.json();
    const bodyRecord =
      body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    const forcedBody = {
      ...bodyRecord,
      mode: 'full',
    };
    const validated = validateOrchestrateRequest(forcedBody);
    if (!validated.ok) {
      return {
        status: 400,
        jsonBody: {
          error: validated.message,
        },
      };
    }

    context.log('analysis full request', {
      mode:
        String(validated.value.matchContext?.matchMode || validated.value.matchContext?.teamMode || '').toUpperCase() === 'BAT'
          ? 'BATTING'
          : 'BOWLING',
      selectedPlayerId: validated.value.context?.activePlayerId || validated.value.telemetry?.playerId || 'UNKNOWN',
    });
    const activeId = validated.value.context?.activePlayerId || validated.value.telemetry?.playerId;
    const active = validated.value.context?.roster?.find((entry) => entry.playerId === activeId);
    const baselineSummary = active?.baseline
      ? {
          sleepHours: active.baseline.sleepHours,
          recoveryMinutes: active.baseline.recoveryScore,
          fatigueLimit: active.baseline.fatigueLimit,
          role: active.role,
          control: active.baseline.controlBaseline,
          speed: active.baseline.speed,
          power: active.baseline.power,
        }
      : null;
    context.log('[analysis] baseline', baselineSummary);

    const result = await orchestrateAgents(
      {
        ...validated.value,
        mode: 'full',
      },
      context
    );
    const hasNarrative =
      Boolean(result.strategicAnalysis) || Boolean(result.fatigue) || Boolean(result.risk) || Boolean(result.tactical);
    if (!hasNarrative) {
      return {
        status: 502,
        jsonBody: {
          error: 'Full analysis unavailable',
          details: 'All full-analysis agents failed.',
        },
      };
    }
    return {
      status: result.errors.length > 0 ? 207 : 200,
      jsonBody: {
        ...result,
        ...(result.errors.length > 0
          ? { warning: 'Some signals unavailable; showing best available guidance.' }
          : {}),
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid request payload';
    context.error('Full analysis error', { message });
    return {
      status: 400,
      jsonBody: {
        error: message,
      },
    };
  }
}

app.http('analysisFull', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: ROUTES.analysisFull,
  handler: analysisFullHandler,
});
