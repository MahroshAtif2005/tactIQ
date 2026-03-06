import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { randomUUID } from 'crypto';
import { buildTacticalFallback, runTacticalAgent } from '../agents/tacticalAgent';
import { ok } from '../lib/httpResponse';
import { validateTacticalRequest } from '../orchestrator/validation';
import { ROUTES } from '../routes/routes';
import { getAoaiConfig } from '../llm/modelRegistry';
import { dedupeRoutingReasons, extractAoaiStatusFromValues, resolveDataMode, resolveLlmMode, toResponseMode } from '../shared/routing';
import { preflight, withCors } from './_cors';

export async function tacticalHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const requestId = randomUUID();
  const startedAt = Date.now();
  const aoai = getAoaiConfig();
  const method = String(request.method || 'POST').trim().toUpperCase();
  const url = String(request.url || '/api/agents/tactical').trim() || '/api/agents/tactical';
  const pf = preflight(request);
  if (pf) return pf;
  let mode = 'live';
  let dataMode: 'demo' | 'live' = 'live';
  let llmMode: 'ai' | 'rules' = 'ai';
  try {
    const body = await request.json() as Record<string, unknown>;
    mode = String((body as Record<string, unknown>)?.mode || '').trim().toLowerCase() || 'live';
    dataMode = resolveDataMode(body?.dataMode);
    llmMode = resolveLlmMode(body?.llmMode);
    context.log('[tactical] request', {
      requestId,
      method,
      url,
      mode,
      dataMode,
      llmMode,
      aoaiConfigured: aoai.ok,
      routing: llmMode === 'ai' && aoai.ok ? 'real' : 'fallback',
    });
    const validated = validateTacticalRequest(body);
    if (!validated.ok) {
      const timings = {
        totalMs: Date.now() - startedAt,
        tacticalMs: Date.now() - startedAt,
      };
      const reasons = ['invalid_payload'];
      context.log('[tactical] response', {
        requestId,
        method,
        url,
        mode,
        dataMode,
        llmMode,
        routing: 'fallback',
        status: 200,
        durationMs: timings.totalMs,
      });
      return withCors(
        request,
        ok({
          error: true,
          message: validated.message,
          mode: 'fallback',
          dataMode,
          llmMode,
          routingMode: 'fallback',
          reasons,
          coachOutput: 'Tactical analysis failed because the request payload was invalid.',
          agents: {
            tactical: { status: 'FALLBACK' },
          },
          timings,
          requestId,
        })
      );
    }

    const requestInput = {
      ...validated.value,
      requestId,
    };
    const result =
      llmMode !== 'ai'
        ? buildTacticalFallback(requestInput, 'llm_mode_rules')
        : !aoai.ok
          ? buildTacticalFallback(requestInput, 'missing_aoai_config')
          : await runTacticalAgent(requestInput);
    const routingMode: 'fallback' | 'ai' = String(result.output?.status || '').toLowerCase() === 'fallback' ? 'fallback' : 'ai';
    const reasons = routingMode === 'fallback'
      ? dedupeRoutingReasons(result.fallbacksUsed, llmMode !== 'ai' ? 'llm_mode_rules' : 'upstream_unavailable')
      : [];
    const aoaiStatus = extractAoaiStatusFromValues(result.fallbacksUsed);
    const coachOutput = String(result.output?.immediateAction || result.output?.rationale || 'Tactical analysis completed.').trim();
    const timings = {
      totalMs: Date.now() - startedAt,
      tacticalMs: Date.now() - startedAt,
    };
    if (typeof aoaiStatus === 'number') {
      context.log('[tactical] aoai_status', { requestId, status: aoaiStatus });
    }
    context.log('[tactical] response', {
      requestId,
      method,
      url,
      mode,
      dataMode,
      llmMode,
      routing: routingMode,
      status: 200,
      durationMs: timings.totalMs,
    });

    return withCors(
      request,
      ok({
        ok: true,
        mode: toResponseMode(routingMode),
        dataMode,
        llmMode,
        routingMode,
        reasons,
        analysisBundleId: `tactical-${requestId}`,
        coachOutput,
        agents: {
          tactical: { status: routingMode === 'fallback' ? 'FALLBACK' : 'OK' },
        },
        timings,
        ...result.output,
        meta: {
          requestId,
          model: result.model,
          fallbacksUsed: result.fallbacksUsed,
          llmMode,
          dataMode,
          ...(aoai.ok ? {} : { aoai: { missing: aoai.missing } }),
          timingsMs: timings,
        },
      })
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid request payload';
    const reasons = dedupeRoutingReasons([message], 'upstream_unavailable');
    context.error('Tactical agent error', { requestId, message });
    const timings = {
      totalMs: Date.now() - startedAt,
      tacticalMs: Date.now() - startedAt,
    };
    context.log('[tactical] response', {
      requestId,
      method,
      url,
      mode,
      dataMode,
      llmMode,
      routing: 'fallback',
      status: 200,
      durationMs: timings.totalMs,
    });
    return withCors(
      request,
      ok({
        error: true,
        message,
        ...(process.env.NODE_ENV === 'production' ? {} : { stack: error instanceof Error ? error.stack : undefined }),
        mode: 'fallback',
        dataMode,
        llmMode,
        routingMode: 'fallback',
        reasons,
        coachOutput: 'Tactical analysis failed before a recommendation could be produced.',
        agents: {
          tactical: { status: 'FALLBACK' },
        },
        timings,
        requestId,
      })
    );
  }
}

app.http('tactical', {
  methods: ['POST', 'OPTIONS'],
  authLevel: 'anonymous',
  route: ROUTES.tactical,
  handler: tacticalHandler,
});
