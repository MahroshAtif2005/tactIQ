import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { randomUUID } from 'crypto';
import { buildRiskFallback, runRiskAgent } from '../agents/riskAgent';
import { ok } from '../lib/httpResponse';
import { getAoaiConfig } from '../llm/modelRegistry';
import { RiskAgentRequest, RiskAgentResponse } from '../shared/types';
import { dedupeRoutingReasons, extractAoaiStatusFromValues, resolveDataMode, resolveLlmMode, toResponseMode } from '../shared/routing';
import { preflight, withCors } from './_cors';

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
  const requestId = randomUUID();
  const startedAt = Date.now();
  const method = String(request.method || 'POST').trim().toUpperCase();
  const url = String(request.url || '/api/agents/risk').trim() || '/api/agents/risk';
  const pf = preflight(request);
  if (pf) return pf;
  let mode = 'live';
  let dataMode: 'demo' | 'live' = 'live';
  let llmMode: 'ai' | 'rules' = 'ai';
  try {
    const body = (await request.json()) as Partial<RiskAgentRequest> & Record<string, unknown>;
    mode = String(body?.mode || '').trim().toLowerCase() || 'live';
    dataMode = resolveDataMode(body?.dataMode);
    llmMode = resolveLlmMode(body?.llmMode);
    const input = sanitizeRequest(body);
    const aoai = getAoaiConfig();
    const aoaiConfigured = aoai.ok;
    context.log('[risk] request', {
      requestId,
      method,
      url,
      mode,
      dataMode,
      llmMode,
      aoaiConfigured,
      routing: llmMode === 'ai' && aoaiConfigured ? 'real' : 'fallback',
    });
    if (process.env.NODE_ENV !== 'production') {
      console.log('Risk payload', input);
    }

    const result =
      llmMode !== 'ai'
        ? buildRiskFallback(input, 'llm_mode_rules')
        : !aoaiConfigured
          ? buildRiskFallback(input, 'missing_aoai_config')
          : await runRiskAgent(input);
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
    const routingMode: 'fallback' | 'ai' = response.status === 'fallback' ? 'fallback' : 'ai';
    const reasons = routingMode === 'fallback'
      ? dedupeRoutingReasons(result.fallbacksUsed, llmMode !== 'ai' ? 'llm_mode_rules' : 'upstream_unavailable')
      : [];
    const aoaiStatus = extractAoaiStatusFromValues(result.fallbacksUsed);
    const coachOutput = String(response.recommendation || response.explanation || response.headline || 'Risk analysis completed.').trim();
    const timings = {
      totalMs: Date.now() - startedAt,
      riskMs: Date.now() - startedAt,
    };
    if (typeof aoaiStatus === 'number') {
      context.log('[risk] aoai_status', { requestId, status: aoaiStatus });
    }
    context.log('[risk] response', {
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
        analysisBundleId: `risk-${requestId}`,
        coachOutput,
        agents: {
          risk: { status: routingMode === 'fallback' ? 'FALLBACK' : 'OK' },
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
    const message = error instanceof Error ? error.message : 'Risk request failed';
    const reasons = dedupeRoutingReasons([message], 'upstream_unavailable');
    context.error('Risk agent error', { requestId, message, stack: error instanceof Error ? error.stack : undefined });
    const timings = {
      totalMs: Date.now() - startedAt,
      riskMs: Date.now() - startedAt,
    };
    context.log('[risk] response', {
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
        coachOutput: 'Risk analysis failed before a recommendation could be produced.',
        agents: {
          risk: { status: 'FALLBACK' },
        },
        timings,
        requestId,
      })
    );
  }
}

app.http('risk', {
  methods: ['POST', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'agents/risk',
  handler: riskHandler,
});
