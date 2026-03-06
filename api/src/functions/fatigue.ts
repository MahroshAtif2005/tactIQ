import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { randomUUID } from 'crypto';
import { buildFatigueFallback, runFatigueAgent } from '../agents/fatigueAgent';
import { ok } from '../lib/httpResponse';
import { getAoaiConfig } from '../llm/modelRegistry';
import { FatigueAgentRequest, FatigueAgentResponse } from '../shared/types';
import { dedupeRoutingReasons, extractAoaiStatusFromValues, resolveDataMode, resolveLlmMode, toResponseMode } from '../shared/routing';
import { preflight, withCors } from './_cors';

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
  const requestId = randomUUID();
  const startedAt = Date.now();
  const method = String(request.method || 'POST').trim().toUpperCase();
  const url = String(request.url || '/api/agents/fatigue').trim() || '/api/agents/fatigue';
  const pf = preflight(request);
  if (pf) return pf;
  let mode = 'live';
  let dataMode: 'demo' | 'live' = 'live';
  let llmMode: 'ai' | 'rules' = 'ai';
  try {
    const body = (await request.json()) as Partial<FatigueAgentRequest> & Record<string, unknown>;
    mode = String(body?.mode || '').trim().toLowerCase() || 'live';
    dataMode = resolveDataMode(body?.dataMode);
    llmMode = resolveLlmMode(body?.llmMode);
    const input = sanitizeRequest(body);
    const aoai = getAoaiConfig();
    const aoaiConfigured = aoai.ok;
    context.log('[fatigue] request', {
      requestId,
      method,
      url,
      mode,
      dataMode,
      llmMode,
      aoaiConfigured,
      routing: llmMode === 'ai' && aoaiConfigured ? 'real' : 'fallback',
    });
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
    const result =
      llmMode !== 'ai'
        ? buildFatigueFallback(input, 'llm_mode_rules')
        : !aoaiConfigured
          ? buildFatigueFallback(input, 'missing_aoai_config')
          : await runFatigueAgent(input);
    const response: FatigueAgentResponse = {
      ...result.output,
      status: result.output.status || (result.fallbacksUsed.length > 0 ? 'fallback' : 'ok'),
    };
    const routingMode: 'fallback' | 'ai' = response.status === 'fallback' ? 'fallback' : 'ai';
    const reasons = routingMode === 'fallback'
      ? dedupeRoutingReasons(result.fallbacksUsed, llmMode !== 'ai' ? 'llm_mode_rules' : 'upstream_unavailable')
      : [];
    const aoaiStatus = extractAoaiStatusFromValues(result.fallbacksUsed);
    const coachOutput = String(response.recommendation || response.explanation || response.headline || 'Fatigue analysis completed.').trim();
    const timings = {
      totalMs: Date.now() - startedAt,
      fatigueMs: Date.now() - startedAt,
    };
    if (typeof aoaiStatus === 'number') {
      context.log('[fatigue] aoai_status', { requestId, status: aoaiStatus });
    }
    context.log('[fatigue] response', {
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
        analysisBundleId: `fatigue-${requestId}`,
        coachOutput,
        agents: {
          fatigue: { status: routingMode === 'fallback' ? 'FALLBACK' : 'OK' },
        },
        timings,
        ...response,
        meta: {
          requestId,
          model: result.model,
          fallbacksUsed: result.fallbacksUsed,
          llmMode,
          dataMode,
          timingsMs: timings,
        },
      })
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Fatigue request failed';
    const reasons = dedupeRoutingReasons([message], 'upstream_unavailable');
    context.error('Fatigue agent error', { requestId, message, stack: error instanceof Error ? error.stack : undefined });
    const timings = {
      totalMs: Date.now() - startedAt,
      fatigueMs: Date.now() - startedAt,
    };
    context.log('[fatigue] response', {
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
        coachOutput: 'Fatigue analysis failed before a recommendation could be produced.',
        agents: {
          fatigue: { status: 'FALLBACK' },
        },
        timings,
        requestId,
      })
    );
  }
}

app.http('fatigue', {
  methods: ['POST', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'agents/fatigue',
  handler: fatigueHandler,
});
