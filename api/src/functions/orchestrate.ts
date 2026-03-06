import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { randomUUID } from 'crypto';
import { orchestrateAgents } from '../orchestrator/orchestrator';
import { validateOrchestrateRequest } from '../orchestrator/validation';
import { ROUTES } from '../routes/routes';
import { buildFatigueFallback } from '../agents/fatigueAgent';
import { buildRiskFallback } from '../agents/riskAgent';
import { buildTacticalFallback } from '../agents/tacticalAgent';
import { toFatigueRequest, toRiskRequest } from '../agents/types';
import { ok } from '../lib/httpResponse';
import { getAoaiConfig } from '../llm/modelRegistry';
import { dedupeRoutingReasons, normalizeRoutingReason, resolveDataMode, resolveLlmMode, toResponseMode } from '../shared/routing';
import { preflight, withCors } from './_cors';

type OrchestrateInput = Parameters<typeof orchestrateAgents>[0];
const toText = (...values: unknown[]): string => {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const normalized = value.trim();
    if (normalized.length > 0) return normalized;
  }
  return '';
};
const toConfidence = (...values: unknown[]): number => {
  for (const value of values) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) continue;
    const normalized = parsed > 1 && parsed <= 100 ? parsed / 100 : parsed;
    return Math.max(0, Math.min(1, normalized));
  }
  return 0.62;
};
const toIsoNow = (): string => new Date().toISOString();
const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const toArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const hasRecordKeys = (value: unknown): boolean =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.keys(value as Record<string, unknown>).length > 0;
const normalizeStatus = (value: unknown, fallbackMode: boolean): string => {
  const token = String(value || '').trim().toUpperCase();
  if (token === 'OK' || token === 'SUCCESS' || token === 'DONE') return 'OK';
  if (token === 'FALLBACK') return 'FALLBACK';
  if (token === 'RUNNING') return 'RUNNING';
  if (token === 'SKIPPED') return 'SKIPPED';
  if (token === 'ERROR' || token === 'FAILED') return fallbackMode ? 'FALLBACK' : 'ERROR';
  return '';
};
const normalizeErrorItems = (value: unknown): Array<{ agent: 'fatigue' | 'risk' | 'tactical'; message: string }> => {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        const message = String(entry || '').trim();
        if (!message) return null;
        return { agent: 'tactical' as const, message };
      }
      const item = entry as Record<string, unknown>;
      const agentToken = String(item.agent || '').trim().toLowerCase();
      const agent: 'fatigue' | 'risk' | 'tactical' =
        agentToken === 'fatigue' || agentToken === 'risk' || agentToken === 'tactical' ? agentToken : 'tactical';
      const message = toText(item.message, item.error, item.reason);
      if (!message) return null;
      return { agent, message };
    })
    .filter((entry): entry is { agent: 'fatigue' | 'risk' | 'tactical'; message: string } => Boolean(entry));
};
const collectFallbackSignals = (meta: Record<string, unknown>, payload: Record<string, unknown>): unknown[] => {
  const modelRouting = meta.modelRouting && typeof meta.modelRouting === 'object' && !Array.isArray(meta.modelRouting)
    ? (meta.modelRouting as Record<string, unknown>)
    : {};
  return [
    ...toArray(modelRouting.fallbacksUsed),
    ...toArray(meta.usedFallbackAgents),
    ...toArray(payload.reasons),
    toText(meta.routerFallbackMessage),
  ].filter(Boolean);
};
const withCompatFields = (
  payload: Record<string, unknown>,
  fallbackAnalysisBundleId: string
): Record<string, unknown> => {
  const meta =
    payload.meta && typeof payload.meta === 'object' && !Array.isArray(payload.meta)
      ? (payload.meta as Record<string, unknown>)
      : {};
  const strategic =
    payload.strategicAnalysis && typeof payload.strategicAnalysis === 'object' && !Array.isArray(payload.strategicAnalysis)
      ? (payload.strategicAnalysis as Record<string, unknown>)
      : {};
  const tactical =
    payload.tactical && typeof payload.tactical === 'object' && !Array.isArray(payload.tactical)
      ? (payload.tactical as Record<string, unknown>)
      : {};
  const tacticalRecommendationRecord =
    strategic.tacticalRecommendation &&
    typeof strategic.tacticalRecommendation === 'object' &&
    !Array.isArray(strategic.tacticalRecommendation)
      ? (strategic.tacticalRecommendation as Record<string, unknown>)
      : {};
  const combinedDecision =
    payload.combinedDecision && typeof payload.combinedDecision === 'object' && !Array.isArray(payload.combinedDecision)
      ? (payload.combinedDecision as Record<string, unknown>)
      : payload.finalDecision && typeof payload.finalDecision === 'object' && !Array.isArray(payload.finalDecision)
        ? (payload.finalDecision as Record<string, unknown>)
        : {};
  const agentOutputs =
    payload.agentOutputs && typeof payload.agentOutputs === 'object' && !Array.isArray(payload.agentOutputs)
      ? { ...(payload.agentOutputs as Record<string, unknown>) }
      : {};
  if (!agentOutputs.fatigue && payload.fatigue && typeof payload.fatigue === 'object') {
    agentOutputs.fatigue = payload.fatigue;
  }
  if (!agentOutputs.risk && payload.risk && typeof payload.risk === 'object') {
    agentOutputs.risk = payload.risk;
  }
  if (!agentOutputs.tactical && payload.tactical && typeof payload.tactical === 'object') {
    agentOutputs.tactical = payload.tactical;
  }
  const analysisBundleId = String(
    payload.analysisBundleId ||
    payload.analysisId ||
    meta.analysisId ||
    meta.requestId ||
    fallbackAnalysisBundleId ||
    ''
  ).trim();
  const tacticalRecommendation = toText(
    payload.tacticalRecommendation,
    tacticalRecommendationRecord.nextAction,
    tacticalRecommendationRecord.why,
    tactical.nextAction,
    tactical.immediateAction,
    combinedDecision.immediateAction
  );
  const summary = toText(
    payload.summary,
    payload.combinedBriefing,
    strategic.fatigueAnalysis,
    tactical.rationale,
    combinedDecision.rationale,
    tacticalRecommendationRecord.why,
    strategic.coachNote
  );
  const confidence = toConfidence(payload.confidence, combinedDecision.confidence, tactical.confidence);
  const errors = normalizeErrorItems(payload.errors);
  const fallbackSignals = collectFallbackSignals(meta, payload);
  const fallbackReasons = dedupeRoutingReasons(fallbackSignals);
  const routingRecord =
    payload.routing && typeof payload.routing === 'object' && !Array.isArray(payload.routing)
      ? (payload.routing as Record<string, unknown>)
      : {};
  const explicitRoutingMode = String(payload.routingMode || routingRecord.mode || '').trim().toLowerCase();
  const routeMode: 'ai' | 'fallback' | 'demo' =
    explicitRoutingMode === 'demo'
      ? 'demo'
      : explicitRoutingMode === 'fallback' || fallbackReasons.length > 0
        ? 'fallback'
        : 'ai';
  const rawModeToken = String(payload.mode || '').trim().toLowerCase();
  const mode: 'demo' | 'live' | 'fallback' =
    rawModeToken === 'demo' || rawModeToken === 'live' || rawModeToken === 'fallback'
      ? rawModeToken
      : routeMode !== 'ai'
        ? 'fallback'
        : 'live';
  const fallbackMode = routeMode !== 'ai';
  const rawAgents =
    payload.agents && typeof payload.agents === 'object' && !Array.isArray(payload.agents)
      ? (payload.agents as Record<string, unknown>)
      : {};
  const agentResults =
    payload.agentResults && typeof payload.agentResults === 'object' && !Array.isArray(payload.agentResults)
      ? (payload.agentResults as Record<string, unknown>)
      : {};
  const agents = (['fatigue', 'risk', 'tactical'] as const).reduce<Record<string, { status: string }>>((acc, agent) => {
    const existing =
      rawAgents[agent] && typeof rawAgents[agent] === 'object' && !Array.isArray(rawAgents[agent])
        ? (rawAgents[agent] as Record<string, unknown>)
        : {};
    const existingStatus = normalizeStatus(existing.status, fallbackMode);
    if (existingStatus) {
      acc[agent] = { ...(existing as Record<string, never>), status: existingStatus } as { status: string };
      return acc;
    }
    const resultRecord =
      agentResults[agent] && typeof agentResults[agent] === 'object' && !Array.isArray(agentResults[agent])
        ? (agentResults[agent] as Record<string, unknown>)
        : {};
    const resultStatus = String(resultRecord.status || '').trim().toLowerCase();
    let status = '';
    if (resultStatus === 'success') status = 'OK';
    if (resultStatus === 'fallback') status = 'FALLBACK';
    if (resultStatus === 'running') status = 'RUNNING';
    if (resultStatus === 'skipped') status = 'SKIPPED';
    if (resultStatus === 'error') status = fallbackMode ? 'FALLBACK' : 'ERROR';
    if (!status && hasRecordKeys(agentOutputs[agent])) {
      status = fallbackMode ? 'FALLBACK' : 'OK';
    }
    if (!status) {
      const hasError = errors.some((entry) => entry.agent === agent);
      status = hasError ? (fallbackMode ? 'FALLBACK' : 'ERROR') : (fallbackMode ? 'FALLBACK' : 'SKIPPED');
    }
    acc[agent] = { status };
    return acc;
  }, {});
  const coachOutputRecord =
    payload.coachOutput && typeof payload.coachOutput === 'object' && !Array.isArray(payload.coachOutput)
      ? (payload.coachOutput as Record<string, unknown>)
      : {};
  const coachOutputText = typeof payload.coachOutput === 'string' ? payload.coachOutput.trim() : '';
  const coachOutput = {
    ...coachOutputRecord,
    tacticalRecommendation: toText(
      coachOutputRecord.tacticalRecommendation,
      coachOutputRecord.recommendation,
      tacticalRecommendation
    ),
    summary: toText(coachOutputRecord.summary, coachOutputRecord.explanation, summary, coachOutputText),
    confidence: toConfidence(coachOutputRecord.confidence, confidence),
    explanation: toText(coachOutputRecord.explanation, coachOutputRecord.summary, summary, coachOutputText),
  };
  const normalizedCombinedDecision = {
    ...combinedDecision,
    immediateAction: toText(combinedDecision.immediateAction, tacticalRecommendation, 'Continue with monitored plan'),
    suggestedAdjustments: Array.isArray(combinedDecision.suggestedAdjustments)
      ? combinedDecision.suggestedAdjustments.map((entry) => String(entry || '').trim()).filter(Boolean)
      : summary
        ? [summary]
        : [],
    confidence: toConfidence(combinedDecision.confidence, confidence),
    rationale: toText(combinedDecision.rationale, summary, 'Coach analysis completed.'),
  };
  const modelRouting =
    meta.modelRouting && typeof meta.modelRouting === 'object' && !Array.isArray(meta.modelRouting)
      ? (meta.modelRouting as Record<string, unknown>)
      : {};
  const normalizedMeta = {
    ...meta,
    requestId: toText(meta.requestId, analysisBundleId),
    analysisId: toText(meta.analysisId, analysisBundleId),
    mode: String(meta.mode || '').trim().toLowerCase() === 'full' ? 'full' : 'auto',
    executedAgents: Array.isArray(meta.executedAgents) && meta.executedAgents.length > 0
      ? meta.executedAgents
      : (['fatigue', 'risk', 'tactical'] as const).filter((agent) => hasRecordKeys(agentOutputs[agent])),
    modelRouting: {
      fatigueModel: toText(modelRouting.fatigueModel, fallbackMode ? 'rules-based-fallback' : 'llm'),
      riskModel: toText(modelRouting.riskModel, fallbackMode ? 'rules-based-fallback' : 'llm'),
      tacticalModel: toText(modelRouting.tacticalModel, fallbackMode ? 'rules-based-fallback' : 'llm'),
      fallbacksUsed: Array.isArray(modelRouting.fallbacksUsed)
        ? modelRouting.fallbacksUsed.map((entry) => String(entry || '').trim()).filter(Boolean)
        : [],
    },
    usedFallbackAgents: Array.isArray(meta.usedFallbackAgents) && meta.usedFallbackAgents.length > 0
      ? meta.usedFallbackAgents
      : (fallbackMode ? ['fatigue', 'risk', 'tactical'] : []),
    routerFallbackMessage: toText(meta.routerFallbackMessage),
    timingsMs:
      meta.timingsMs && typeof meta.timingsMs === 'object' && !Array.isArray(meta.timingsMs)
        ? (meta.timingsMs as Record<string, unknown>)
        : {},
  };
  const createdAt = toText(payload.createdAt, meta.createdAt, toIsoNow());

  return {
    ...payload,
    mode,
    routingMode: routeMode,
    reasons: fallbackReasons,
    analysisBundleId: analysisBundleId || fallbackAnalysisBundleId,
    summary,
    tacticalRecommendation,
    confidence,
    coachOutput,
    agentOutputs,
    combinedDecision: normalizedCombinedDecision,
    agents,
    errors,
    createdAt,
    meta: normalizedMeta,
    routing: {
      ...routingRecord,
      mode: routeMode,
      ...(fallbackReasons.length > 0 ? { reasons: fallbackReasons.slice(0, 8) } : {}),
    },
  };
};

const toTimings = (startedAt: number, metaTimings: Record<string, unknown>): Record<string, number> => ({
  totalMs: Date.now() - startedAt,
  fatigueMs: Number(metaTimings.fatigue) || 0,
  riskMs: Number(metaTimings.risk) || 0,
  tacticalMs: Number(metaTimings.tactical) || 0,
  routerMs: Number(metaTimings.router) || 0,
  azureCallMs: Number(metaTimings.azureCall) || 0,
});

const toCoachOutputText = (payload: Record<string, unknown>): string => {
  const coachOutput = asRecord(payload.coachOutput);
  const text = toText(
    coachOutput.tacticalRecommendation,
    coachOutput.recommendation,
    coachOutput.summary,
    coachOutput.explanation,
    payload.tacticalRecommendation,
    payload.summary
  );
  return text || 'Coach analysis completed.';
};

export async function orchestrateHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const traceId = randomUUID();
  const startedAt = Date.now();
  const method = String(request.method || '').trim().toUpperCase();
  const url = String(request.url || '/api/orchestrate').trim() || '/api/orchestrate';
  const pf = preflight(request);
  if (pf) return pf;
  if (method === 'GET') {
    const createdAt = toIsoNow();
    const timings = {
      totalMs: Date.now() - startedAt,
      fatigueMs: 0,
      riskMs: 0,
      tacticalMs: 0,
      routerMs: 0,
      azureCallMs: 0,
    };
    context.log('[orchestrate] request', { method, url, mode: 'health', routing: 'fallback' });
    context.log('[orchestrate] response', {
      method,
      url,
      mode: 'health',
      routing: 'fallback',
      status: 200,
      timings,
    });
    return withCors(
      request,
      ok({
        ok: true,
        mode: 'fallback',
        routingMode: 'fallback',
        analysisBundleId: `orchestrate-health-${Date.now()}`,
        coachOutput: {
          summary: 'Orchestrate endpoint is reachable.',
          tacticalRecommendation: 'POST match-state JSON to run coach analysis.',
          confidence: 0.62,
          explanation: 'Health-style orchestrate response for browser checks.',
        },
        agents: {
          fatigue: { status: 'SKIPPED' },
          risk: { status: 'SKIPPED' },
          tactical: { status: 'SKIPPED' },
        },
        timings,
        createdAt,
        traceId,
      })
    );
  }
  if (method !== 'POST') {
    context.log('[orchestrate] response', {
      method,
      url,
      mode: 'live',
      routing: 'fallback',
      status: 200,
      timings: { totalMs: Date.now() - startedAt },
    });
    return withCors(
      request,
      ok({
        ok: false,
        error: 'method_not_allowed',
        message: 'Use GET /api/orchestrate for route info or POST JSON to run analysis.',
        traceId,
      })
    );
  }
  let requestedMode: 'auto' | 'full' = 'auto';
  let dataMode: 'demo' | 'live' = 'live';
  let llmMode: 'ai' | 'rules' = 'ai';
  let validatedInput: OrchestrateInput | null = null;
  try {
    // Always return an explicit response object; missing returns can surface as 204 No Content.
    const body = await request.json();
    const bodyRecord = (body && typeof body === 'object' && !Array.isArray(body)) ? (body as Record<string, unknown>) : {};
    dataMode = resolveDataMode(bodyRecord.dataMode);
    llmMode = resolveLlmMode(bodyRecord.llmMode);
    requestedMode = String(bodyRecord.mode || '').trim().toLowerCase() === 'full' ? 'full' : 'auto';
    const aoai = getAoaiConfig();
    const aoaiConfigured = aoai.ok;
    context.log('[orchestrate] request', {
      method,
      url,
      mode: requestedMode,
      dataMode,
      llmMode,
      aoaiConfigured,
      routing: llmMode === 'ai' && aoaiConfigured ? 'real' : 'fallback',
    });
    const matchContext =
      bodyRecord.matchContext && typeof bodyRecord.matchContext === 'object' && !Array.isArray(bodyRecord.matchContext)
        ? (bodyRecord.matchContext as Record<string, unknown>)
        : null;
    const rawMatchMode = String(matchContext?.matchMode || '').trim();
    if (!rawMatchMode) {
      throw new Error('matchContext.matchMode is required');
    }
    const validated = validateOrchestrateRequest(body);
    if (!validated.ok) {
      throw new Error(validated.message || 'Invalid orchestrate payload');
    }
    validatedInput = validated.value;
    dataMode = resolveDataMode(validatedInput.dataMode);
    llmMode = resolveLlmMode(validatedInput.llmMode);
    if (llmMode !== 'ai') {
      throw new Error('llm_mode_rules');
    }
    if (!aoaiConfigured) {
      throw new Error('missing_aoai_config');
    }
    const normalizedMode =
      rawMatchMode.toUpperCase() === 'BAT' || rawMatchMode.toUpperCase() === 'BATTING' ? 'BATTING' : 'BOWLING';
    const activeId = validatedInput.context?.activePlayerId || validatedInput.telemetry?.playerId;
    const active = validatedInput.context?.roster?.find((entry) => entry.playerId === activeId);
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
      fatigueIndex: validatedInput.telemetry?.fatigueIndex ?? null,
      strainIndex: validatedInput.telemetry?.strainIndex ?? null,
      phase: validatedInput.matchContext?.phase || null,
    });
    context.log('[analysis] baseline', baselineSummary);
    const result = await orchestrateAgents(validatedInput, context);
    const enriched = withCompatFields(result as unknown as Record<string, unknown>, traceId);
    const enrichedRecord = asRecord(enriched);
    const metaTimings = asRecord(asRecord(enrichedRecord.meta).timingsMs);
    const timings = toTimings(startedAt, metaTimings);
    const responseRouting = String(enrichedRecord.routingMode || enrichedRecord.mode || '').toLowerCase() === 'fallback' ? 'fallback' : 'ai';
    const reasons = responseRouting === 'fallback'
      ? dedupeRoutingReasons(toArray(enrichedRecord.reasons), 'upstream_unavailable')
      : [];
    context.log('[orchestrate] response', {
      method,
      url,
      mode: requestedMode,
      dataMode,
      llmMode,
      routing: responseRouting,
      status: 200,
      timings,
    });
    return withCors(
      request,
      ok({
        ...enriched,
        ok: true,
        traceId,
        dataMode,
        llmMode,
        mode: String(enrichedRecord.mode || toResponseMode(responseRouting === 'fallback' ? 'fallback' : 'ai')),
        routingMode: String(enrichedRecord.routingMode || responseRouting),
        reasons,
        analysisBundleId: String(enrichedRecord.analysisBundleId || traceId),
        coachOutput: enrichedRecord.coachOutput || toCoachOutputText(enrichedRecord),
        agents: enrichedRecord.agents || {
          fatigue: { status: responseRouting === 'fallback' ? 'FALLBACK' : 'OK' },
          risk: { status: responseRouting === 'fallback' ? 'FALLBACK' : 'OK' },
          tactical: { status: responseRouting === 'fallback' ? 'FALLBACK' : 'OK' },
        },
        timings,
      })
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid request payload';
    const reason = normalizeRoutingReason(message);
    const fallbackReason = reason || 'upstream_unavailable';
    context.error('[orchestrate] error', message);
    context.error('Orchestrator error', { traceId, message, stack: error instanceof Error ? error.stack : undefined });
    try {
      const fallbackWarning =
        fallbackReason === 'missing_aoai_config'
          ? 'Azure OpenAI is not configured. Returning rules fallback.'
          : fallbackReason === 'llm_mode_rules'
            ? 'LLM mode is not set to ai. Returning rules fallback.'
            : `Combined analysis completed with orchestrate fallback: ${message}`;
      const fatigueFallback = validatedInput
        ? buildFatigueFallback(
            toFatigueRequest(validatedInput, `${String(validatedInput.telemetry?.playerId || 'UNKNOWN')}:${Date.now()}`),
            `orchestrate_exception:${fallbackReason}`
          ).output
        : undefined;
      const riskFallback = validatedInput
        ? buildRiskFallback(
            toRiskRequest(validatedInput),
            `orchestrate_exception:${fallbackReason}`
          ).output
        : undefined;
      const tacticalFallback =
        validatedInput && fatigueFallback && riskFallback
          ? buildTacticalFallback(
              {
                requestId: traceId,
                intent: validatedInput.intent || 'monitor',
                teamMode: validatedInput.teamMode,
                focusRole: validatedInput.focusRole,
                matchContext: validatedInput.matchContext,
                telemetry: validatedInput.telemetry,
                players: validatedInput.players,
                fatigueOutput: fatigueFallback,
                riskOutput: riskFallback,
                context: validatedInput.context,
                replacementCandidates: validatedInput.replacementCandidates,
              },
              `orchestrate_exception:${fallbackReason}`
            ).output
          : undefined;
      const combinedDecision = tacticalFallback
        ? {
            immediateAction: tacticalFallback.immediateAction,
            suggestedAdjustments: tacticalFallback.suggestedAdjustments || [],
            confidence: Number.isFinite(Number(tacticalFallback.confidence)) ? Number(tacticalFallback.confidence) : 0.62,
            rationale: tacticalFallback.rationale || fallbackWarning,
          }
        : {
            immediateAction: 'Continue with monitored plan',
            suggestedAdjustments: [fallbackWarning],
            confidence: 0.55,
            rationale: 'orchestrate_exception',
          };
      const fallbackBody = withCompatFields({
        ok: true,
        analysisId: traceId,
        traceId,
        warnings: [fallbackWarning],
        dataMode,
        llmMode,
        ...(fatigueFallback ? { fatigue: fatigueFallback } : {}),
        ...(riskFallback ? { risk: riskFallback } : {}),
        ...(tacticalFallback ? { tactical: tacticalFallback } : {}),
        ...(tacticalFallback
          ? {
              strategicAnalysis: {
                signals: tacticalFallback.keySignalsUsed || [],
                fatigueAnalysis: String(
                  fatigueFallback?.recommendation || fatigueFallback?.explanation || 'Fatigue signal reviewed via rules fallback.'
                ),
                injuryRiskAnalysis: String(
                  riskFallback?.recommendation || riskFallback?.explanation || 'Risk signal reviewed via rules fallback.'
                ),
                tacticalRecommendation: {
                  nextAction: tacticalFallback.nextAction || tacticalFallback.immediateAction || 'Continue with monitored plan',
                  why: tacticalFallback.rationale || fallbackWarning,
                  ifIgnored: tacticalFallback.ifIgnored || 'Execution risk may increase if no tactical adjustment is made.',
                  alternatives: (tacticalFallback.suggestedAdjustments || []).slice(0, 3),
                },
                coachNote: 'Rules fallback active: model response unavailable.',
              },
            }
          : {}),
        agentResults: {
          fatigue: {
            status: 'fallback',
            routedTo: 'rules',
            ...(fatigueFallback ? { output: fatigueFallback } : {}),
            reason: fallbackReason,
          },
          risk: {
            status: 'fallback',
            routedTo: 'rules',
            ...(riskFallback ? { output: riskFallback } : {}),
            reason: fallbackReason,
          },
          tactical: {
            status: 'fallback',
            routedTo: 'rules',
            ...(tacticalFallback ? { output: tacticalFallback } : {}),
            reason: fallbackReason,
          },
        },
        agents: {
          fatigue: { status: 'FALLBACK' },
          risk: { status: 'FALLBACK' },
          tactical: { status: 'FALLBACK' },
        },
        errors: [],
        combinedDecision,
        routerDecision: {
          mode: requestedMode,
          intent: 'GENERAL',
          selectedAgents: ['fatigue', 'risk', 'tactical'],
          agentsToRun: ['FATIGUE', 'RISK', 'TACTICAL'],
            rulesFired: [fallbackReason],
          inputsUsed: {
            active: {},
            match: {},
          },
            reason: fallbackWarning,
            signals: {},
            agents: {
            fatigue: { routedTo: 'rules', reason: fallbackReason },
            risk: { routedTo: 'rules', reason: fallbackReason },
            tactical: { routedTo: 'rules', reason: fallbackReason },
            },
          },
          meta: {
            requestId: traceId,
            mode: requestedMode,
          executedAgents: ['fatigue', 'risk', 'tactical'],
          modelRouting: {
              fatigueModel: 'rules-based-fallback',
              riskModel: 'rules-based-fallback',
              tacticalModel: 'rules-based-fallback',
              fallbacksUsed: [fallbackReason],
            },
            usedFallbackAgents: ['fatigue', 'risk', 'tactical'],
            routerFallbackMessage: fallbackWarning,
            timingsMs: {},
          },
      }, traceId);
      const fallbackRecord = asRecord(fallbackBody);
      const fallbackMetaTimings = asRecord(asRecord(fallbackRecord.meta).timingsMs);
      const timings = toTimings(startedAt, fallbackMetaTimings);
      const fallbackPayload = {
        ...fallbackBody,
        ok: true,
        dataMode,
        llmMode,
        mode: 'fallback',
        routingMode: 'fallback',
        reasons: [fallbackReason],
        analysisBundleId: String(fallbackRecord.analysisBundleId || traceId),
        coachOutput: fallbackRecord.coachOutput || toCoachOutputText(fallbackRecord),
        agents: fallbackRecord.agents || {
          fatigue: { status: 'FALLBACK' },
          risk: { status: 'FALLBACK' },
          tactical: { status: 'FALLBACK' },
        },
        timings,
      };
      context.log('[orchestrate] response', {
        method,
        url,
        mode: requestedMode,
        dataMode,
        llmMode,
        routing: 'fallback',
        status: 200,
        timings,
      });
      return withCors(request, ok(fallbackPayload));
    } catch (fallbackError) {
      const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : 'Fallback serialization failed';
      const timings = {
        totalMs: Date.now() - startedAt,
        fatigueMs: 0,
        riskMs: 0,
        tacticalMs: 0,
        routerMs: 0,
        azureCallMs: 0,
      };
      context.error('[orchestrate] fallback_error', {
        traceId,
        message: fallbackMessage,
        stack: fallbackError instanceof Error ? fallbackError.stack : undefined,
      });
      return withCors(
        request,
        ok({
          error: true,
          message: fallbackMessage,
          ...(process.env.NODE_ENV === 'production'
            ? {}
            : { stack: fallbackError instanceof Error ? fallbackError.stack : undefined }),
          dataMode,
          llmMode,
          mode: 'fallback',
          routingMode: 'fallback',
          reasons: ['upstream_unavailable'],
          coachOutput: 'Coach analysis failed before a recommendation could be produced.',
          agents: {
            fatigue: { status: 'FALLBACK' },
            risk: { status: 'FALLBACK' },
            tactical: { status: 'FALLBACK' },
          },
          timings,
          traceId,
        })
      );
    }
  }
}

app.http('orchestrate', {
  methods: ['GET', 'POST', 'OPTIONS'],
  authLevel: 'anonymous',
  route: ROUTES.orchestrate,
  handler: orchestrateHandler,
});
