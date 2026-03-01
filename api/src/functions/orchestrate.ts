import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { randomUUID } from 'crypto';
import { orchestrateAgents } from '../orchestrator/orchestrator';
import { validateOrchestrateRequest } from '../orchestrator/validation';
import { ROUTES } from '../routes/routes';

export async function orchestrateHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const traceId = randomUUID();
  let requestedMode: 'auto' | 'full' = 'auto';
  try {
    const body = await request.json();
    const bodyRecord = (body && typeof body === 'object' && !Array.isArray(body)) ? (body as Record<string, unknown>) : {};
    requestedMode = String(bodyRecord.mode || '').trim().toLowerCase() === 'full' ? 'full' : 'auto';
    const matchContext =
      bodyRecord.matchContext && typeof bodyRecord.matchContext === 'object' && !Array.isArray(bodyRecord.matchContext)
        ? (bodyRecord.matchContext as Record<string, unknown>)
        : null;
    const rawMatchMode = String(matchContext?.matchMode || '').trim();
    if (!rawMatchMode) {
      return {
        status: 400,
        jsonBody: {
          ok: false,
          code: 'MISSING_MATCH_MODE',
          message: 'matchContext.matchMode is required',
          traceId,
        },
      };
    }
    const validated = validateOrchestrateRequest(body);
    if (!validated.ok) {
      return {
        status: 400,
        jsonBody: {
          error: validated.message,
          traceId,
        },
      };
    }
    const normalizedMode =
      rawMatchMode.toUpperCase() === 'BAT' || rawMatchMode.toUpperCase() === 'BATTING' ? 'BATTING' : 'BOWLING';
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
    context.log('orchestrate request', {
      traceId,
      mode: normalizedMode,
      selectedPlayerId: activeId || 'UNKNOWN',
      fatigueIndex: validated.value.telemetry?.fatigueIndex ?? null,
      strainIndex: validated.value.telemetry?.strainIndex ?? null,
      phase: validated.value.matchContext?.phase || null,
    });
    context.log('[analysis] baseline', baselineSummary);
    const result = await orchestrateAgents(validated.value, context);
    return {
      status: 200,
      jsonBody: {
        ...result,
        ok: true,
        traceId,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid request payload';
    context.error('[orchestrate] error', message);
    context.error('Orchestrator error', { traceId, message, stack: error instanceof Error ? error.stack : undefined });
    return {
      status: 200,
      jsonBody: {
        ok: true,
        traceId,
        warnings: [`Combined analysis completed with orchestrate fallback: ${message}`],
        agentResults: {
          fatigue: { status: 'error', routedTo: 'rules', error: message, reason: 'orchestrate_exception' },
          risk: { status: 'error', routedTo: 'rules', error: message, reason: 'orchestrate_exception' },
          tactical: { status: 'error', routedTo: 'rules', error: message, reason: 'orchestrate_exception' },
        },
        agents: {
          fatigue: { status: 'ERROR' },
          risk: { status: 'ERROR' },
          tactical: { status: 'ERROR' },
        },
        errors: [
          { agent: 'fatigue', message },
          { agent: 'risk', message },
          { agent: 'tactical', message },
        ],
        combinedDecision: {
          immediateAction: 'Continue with monitored plan',
          suggestedAdjustments: [`Combined analysis completed with orchestrate fallback: ${message}`],
          confidence: 0.55,
          rationale: 'orchestrate_exception',
        },
        routerDecision: {
          mode: requestedMode,
          intent: 'GENERAL',
          selectedAgents: ['fatigue', 'risk', 'tactical'],
          agentsToRun: ['FATIGUE', 'RISK', 'TACTICAL'],
          rulesFired: ['orchestrate_exception'],
          inputsUsed: {
            active: {},
            match: {},
          },
          reason: message,
          signals: {},
          agents: {
            fatigue: { routedTo: 'rules', reason: 'orchestrate_exception' },
            risk: { routedTo: 'rules', reason: 'orchestrate_exception' },
            tactical: { routedTo: 'rules', reason: 'orchestrate_exception' },
          },
        },
        meta: {
          requestId: traceId,
          mode: requestedMode,
          executedAgents: [],
          modelRouting: {
            fatigueModel: 'error',
            riskModel: 'error',
            tacticalModel: 'error',
            fallbacksUsed: ['orchestrate_exception'],
          },
          usedFallbackAgents: ['fatigue', 'risk', 'tactical'],
          timingsMs: {},
        },
      },
    };
  }
}

app.http('orchestrate', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: ROUTES.orchestrate,
  handler: orchestrateHandler,
});
