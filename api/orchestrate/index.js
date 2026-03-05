const {
  jsonResponse,
  optionsResponse,
  normalizeBody,
  resolveAiExecution,
  tryInvokeDistHandler,
  isLlmConfigured,
} = require('../shared/agentRuntime');
const { runOrchestrateFallback } = require('../shared/simpleAgents');

const toRecord = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const hasKeys = (value) => Object.keys(toRecord(value)).length > 0;
const firstText = (...values) => {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const normalized = value.trim();
    if (normalized.length > 0) return normalized;
  }
  return '';
};
const toConfidence = (...values) => {
  for (const value of values) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) continue;
    const normalized = parsed > 1 && parsed <= 100 ? parsed / 100 : parsed;
    return Math.max(0, Math.min(1, normalized));
  }
  return 0.62;
};
const toErrorMessage = (raw) => {
  const record = toRecord(raw);
  return firstText(record.message, record.error, 'Orchestrate request failed.');
};
const toArray = (value) => (Array.isArray(value) ? value : []);
const toRouteMode = (value) => {
  const token = String(value || '').trim().toLowerCase();
  return token === 'fallback' ? 'fallback' : 'ai';
};
const toTopLevelMode = (rawMode, routeMode, requestModeHint) => {
  const token = String(rawMode || '').trim().toLowerCase();
  if (token === 'demo' || token === 'live' || token === 'fallback') return token;
  if (routeMode === 'fallback') return 'fallback';
  return requestModeHint === 'demo' ? 'demo' : 'live';
};
const toIsoNow = () => new Date().toISOString();
const toAgentStatus = (value, fallbackMode) => {
  const token = String(value || '').trim().toUpperCase();
  if (token === 'OK' || token === 'SUCCESS' || token === 'DONE') return 'OK';
  if (token === 'FALLBACK') return 'FALLBACK';
  if (token === 'SKIPPED') return 'SKIPPED';
  if (token === 'RUNNING') return 'RUNNING';
  if (token === 'ERROR' || token === 'FAILED') return fallbackMode ? 'FALLBACK' : 'ERROR';
  return '';
};
const normalizeErrors = (rawErrors) => {
  if (!Array.isArray(rawErrors)) return [];
  return rawErrors
    .map((entry) => {
      if (entry && typeof entry === 'object') {
        const item = entry;
        const rawAgent = String(item.agent || '').trim().toLowerCase();
        const agent = rawAgent === 'fatigue' || rawAgent === 'risk' || rawAgent === 'tactical' ? rawAgent : 'tactical';
        const message = firstText(item.message, item.error, item.reason);
        if (!message) return null;
        return { agent, message };
      }
      const message = firstText(String(entry || ''));
      if (!message) return null;
      return { agent: 'tactical', message };
    })
    .filter(Boolean);
};
const readHeader = (headers, name) => {
  if (!headers) return '';
  if (typeof headers.get === 'function') {
    return firstText(headers.get(name), headers.get(name.toLowerCase()), headers.get(name.toUpperCase()));
  }
  return firstText(headers[name], headers[name.toLowerCase()], headers[name.toUpperCase()]);
};
const resolveRequestModeHint = (req, payload) => {
  const explicitDataMode = String(toRecord(payload).dataMode || '').trim().toLowerCase();
  if (explicitDataMode === 'demo') return 'demo';
  const bodyMode = String(toRecord(payload).mode || '').trim().toLowerCase();
  if (bodyMode === 'demo') return 'demo';
  const demoHeader = String(readHeader(req?.headers, 'x-tactiq-demo') || '').trim().toLowerCase();
  if (demoHeader === 'true' || demoHeader === '1' || demoHeader === 'yes') return 'demo';
  return 'live';
};
const toAnalysisPayload = (raw, options = {}) => {
  const { fallbackRoutingReason = '', requestModeHint = 'live' } = options;
  const record = toRecord(raw);
  const meta = toRecord(record.meta);
  const strategic = toRecord(record.strategicAnalysis);
  const tacticalRec = toRecord(strategic.tacticalRecommendation);
  const tactical = toRecord(record.tactical);
  const combined = toRecord(record.combinedDecision || record.finalDecision);
  const routingRecord = toRecord(record.routing);
  const errors = normalizeErrors(record.errors);

  const agentOutputs = toRecord(record.agentOutputs);
  if (!agentOutputs.fatigue && hasKeys(record.fatigue)) {
    agentOutputs.fatigue = record.fatigue;
  }
  if (!agentOutputs.risk && hasKeys(record.risk)) {
    agentOutputs.risk = record.risk;
  }
  if (!agentOutputs.tactical && hasKeys(record.tactical)) {
    agentOutputs.tactical = record.tactical;
  }

  const analysisBundleId = firstText(
    record.analysisBundleId,
    record.analysisId,
    meta.analysisId,
    meta.requestId,
    `bundle-${Date.now()}`
  );
  const tacticalRecommendation = firstText(
    record.tacticalRecommendation,
    tacticalRec.nextAction,
    tacticalRec.why,
    tactical.immediateAction,
    tactical.nextAction,
    combined.immediateAction,
    'Continue with monitored plan'
  );
  const summary = firstText(
    record.summary,
    record.combinedBriefing,
    strategic.fatigueAnalysis,
    tactical.rationale,
    combined.rationale,
    tacticalRec.why,
    'Coach analysis completed.'
  );
  const confidence = toConfidence(record.confidence, combined.confidence, tactical.confidence);

  const fallbackReasons = [];
  const modelRouting = toRecord(meta.modelRouting);
  if (Array.isArray(modelRouting.fallbacksUsed)) {
    fallbackReasons.push(
      ...modelRouting.fallbacksUsed
        .map((entry) => String(entry || '').trim())
        .filter(Boolean)
    );
  }
  if (Array.isArray(meta.usedFallbackAgents) && meta.usedFallbackAgents.length > 0) {
    fallbackReasons.push(
      ...meta.usedFallbackAgents
        .map((entry) => String(entry || '').trim())
        .filter(Boolean)
        .map((agent) => `${agent}:fallback`)
    );
  }
  const routerFallback = firstText(meta.routerFallbackMessage, record.warning);
  if (routerFallback) fallbackReasons.push(routerFallback);
  if (fallbackRoutingReason) fallbackReasons.push(fallbackRoutingReason);

  const inferredFallback = fallbackReasons.length > 0 || toRouteMode(routingRecord.mode) === 'fallback';
  const routing = {
    mode: inferredFallback ? 'fallback' : 'ai',
    ...(fallbackReasons.length > 0 ? { reasons: Array.from(new Set(fallbackReasons)).slice(0, 8) } : {}),
  };
  const topLevelMode = toTopLevelMode(record.mode, routing.mode, requestModeHint);
  const fallbackMode = topLevelMode === 'fallback';

  const agentResults = toRecord(record.agentResults);
  const rawAgents = toRecord(record.agents);
  const normalizedAgents = ['fatigue', 'risk', 'tactical'].reduce((acc, agent) => {
    const existing = toRecord(rawAgents[agent]);
    const existingStatus = toAgentStatus(existing.status, fallbackMode);
    if (existingStatus) {
      acc[agent] = { ...existing, status: existingStatus };
      return acc;
    }
    const resultStatus = String(toRecord(agentResults[agent]).status || '').trim().toLowerCase();
    let status = '';
    if (resultStatus === 'success') status = 'OK';
    if (resultStatus === 'fallback') status = 'FALLBACK';
    if (resultStatus === 'skipped') status = 'SKIPPED';
    if (resultStatus === 'running') status = 'RUNNING';
    if (resultStatus === 'error') status = fallbackMode ? 'FALLBACK' : 'ERROR';
    if (!status && hasKeys(agentOutputs[agent])) {
      status = fallbackMode ? 'FALLBACK' : 'OK';
    }
    if (!status) {
      const hasAgentError = errors.some((entry) => entry.agent === agent);
      status = hasAgentError ? (fallbackMode ? 'FALLBACK' : 'ERROR') : (fallbackMode ? 'FALLBACK' : 'SKIPPED');
    }
    acc[agent] = { status };
    return acc;
  }, {});

  const combinedDecision = hasKeys(combined)
    ? {
      ...combined,
      immediateAction: firstText(combined.immediateAction, tacticalRecommendation, 'Continue with monitored plan'),
      suggestedAdjustments: toArray(combined.suggestedAdjustments).map((entry) => String(entry || '').trim()).filter(Boolean),
      confidence: toConfidence(combined.confidence, confidence),
      rationale: firstText(combined.rationale, summary, 'Coach analysis completed.'),
    }
    : {
      immediateAction: tacticalRecommendation,
      suggestedAdjustments: summary ? [summary] : [],
      confidence,
      rationale: summary || 'Coach analysis completed.',
    };

  const coachOutputRecord = toRecord(record.coachOutput);
  const coachOutputText = typeof record.coachOutput === 'string' ? record.coachOutput.trim() : '';
  const coachOutput = {
    ...coachOutputRecord,
    tacticalRecommendation: firstText(
      coachOutputRecord.tacticalRecommendation,
      coachOutputRecord.recommendation,
      tacticalRecommendation
    ),
    summary: firstText(coachOutputRecord.summary, coachOutputRecord.explanation, summary, coachOutputText),
    confidence: toConfidence(coachOutputRecord.confidence, confidence),
    explanation: firstText(coachOutputRecord.explanation, coachOutputRecord.summary, summary, coachOutputText),
  };

  const usedFallbackAgents = toArray(meta.usedFallbackAgents)
    .map((entry) => String(entry || '').trim().toLowerCase())
    .filter((entry) => entry === 'fatigue' || entry === 'risk' || entry === 'tactical');
  const executedAgents = toArray(meta.executedAgents)
    .map((entry) => String(entry || '').trim().toLowerCase())
    .filter((entry) => entry === 'fatigue' || entry === 'risk' || entry === 'tactical');
  const normalizedExecutedAgents = executedAgents.length > 0
    ? executedAgents
    : ['fatigue', 'risk', 'tactical'].filter((agent) => hasKeys(agentOutputs[agent]));
  const normalizedFallbackAgents = usedFallbackAgents.length > 0
    ? usedFallbackAgents
    : (fallbackMode ? ['fatigue', 'risk', 'tactical'] : []);

  const normalizedMeta = {
    ...meta,
    requestId: firstText(meta.requestId, analysisBundleId),
    analysisId: firstText(meta.analysisId, analysisBundleId),
    mode: String(meta.mode || '').trim().toLowerCase() === 'full' ? 'full' : 'auto',
    executedAgents: normalizedExecutedAgents,
    modelRouting: {
      fatigueModel: firstText(modelRouting.fatigueModel, fallbackMode ? 'rules-based-fallback' : 'llm'),
      riskModel: firstText(modelRouting.riskModel, fallbackMode ? 'rules-based-fallback' : 'llm'),
      tacticalModel: firstText(modelRouting.tacticalModel, fallbackMode ? 'rules-based-fallback' : 'llm'),
      fallbacksUsed: toArray(modelRouting.fallbacksUsed)
        .map((entry) => String(entry || '').trim())
        .filter(Boolean),
    },
    usedFallbackAgents: normalizedFallbackAgents,
    routerFallbackMessage: firstText(meta.routerFallbackMessage),
    timingsMs: {
      ...toRecord(meta.timingsMs),
      total: Number(toRecord(meta.timingsMs).total) || 0,
    },
  };
  const createdAt = firstText(record.createdAt, meta.createdAt, toIsoNow());

  return {
    ...record,
    ok: record.ok !== false,
    mode: topLevelMode,
    analysisId: firstText(record.analysisId, normalizedMeta.analysisId, analysisBundleId),
    analysisBundleId,
    coachOutput,
    tacticalRecommendation,
    summary,
    confidence,
    agentOutputs,
    combinedDecision,
    agents: normalizedAgents,
    errors,
    createdAt,
    routingMode: routing.mode,
    meta: normalizedMeta,
    routing,
  };
};

module.exports = async function orchestrate(context, req) {
  const startedAt = Date.now();
  const method = String(req?.method || '').trim().toUpperCase();
  const url = String(req?.url || '/api/orchestrate').trim() || '/api/orchestrate';
  const respond = (response) => {
    context.res = response;
    return response;
  };
  if (method === 'OPTIONS') {
    return respond(optionsResponse('GET,POST,OPTIONS', {}, req));
  }
  const payload = normalizeBody(req);
  const requestMode = String(payload?.mode || '').trim().toLowerCase() || 'auto';
  const llm = isLlmConfigured();
  const execution = resolveAiExecution(payload, llm);
  context.log?.('[orchestrate] request', {
    method,
    url,
    mode: requestMode,
    routing: execution.aiEnabled ? 'ai' : 'fallback',
    aiEnabled: execution.aiEnabled,
    dataMode: execution.dataMode,
    llmMode: execution.llmMode,
    llmConfigured: llm.ok,
  });

  const logResponse = (routing, status, responseBody) => {
    const bodyRecord = toRecord(responseBody);
    const metaTimings = toRecord(toRecord(bodyRecord.meta).timingsMs);
    const timings = {
      totalMs: Date.now() - startedAt,
      fatigueMs: Number(metaTimings.fatigue) || undefined,
      riskMs: Number(metaTimings.risk) || undefined,
      tacticalMs: Number(metaTimings.tactical) || undefined,
      routerMs: Number(metaTimings.router) || undefined,
      azureCallMs: Number(metaTimings.azureCall) || undefined,
    };
    context.log?.('[orchestrate] response', {
      method,
      url,
      mode: requestMode,
      routing,
      status,
      timings,
    });
  };

  const respondWithFallback = (reason) => {
    const fallbackPayload = toAnalysisPayload(runOrchestrateFallback(payload), {
      fallbackRoutingReason: reason,
      requestModeHint: execution.dataMode === 'demo' ? 'demo' : 'live',
    });
    fallbackPayload.mode = 'fallback';
    fallbackPayload.dataMode = execution.dataMode;
    fallbackPayload.llmMode = execution.llmMode;
    fallbackPayload.routingMode = 'fallback';
    fallbackPayload.reasons = Array.from(
      new Set([String(reason || '').trim(), ...execution.reasons, ...llm.missing].filter(Boolean))
    );
    const response = jsonResponse(200, fallbackPayload, {}, req);
    respond(response);
    logResponse('fallback', 200, fallbackPayload);
    return response;
  };

  try {
    if (method === 'GET') {
      const createdAt = toIsoNow();
      const analysisBundleId = `orchestrate-health-${Date.now()}`;
      const response = jsonResponse(200, {
        ok: true,
        mode: 'fallback',
        dataMode: execution.dataMode,
        llmMode: execution.llmMode,
        analysisBundleId,
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
        createdAt,
        routingMode: 'fallback',
        reasons: llm.ok ? ['health_probe'] : ['missing_aoai_config', ...llm.missing],
      }, {}, req);
      respond(response);
      // Return immediately after setting context.res; missing returns can lead to empty 204 responses.
      logResponse('fallback', 200, response?.jsonBody);
      return response;
    }
    if (method !== 'POST') {
      const response = jsonResponse(200, {
        ok: false,
        error: 'method_not_allowed',
        message: 'Use GET /api/orchestrate for route info or POST JSON to run analysis.',
        dataMode: execution.dataMode,
        llmMode: execution.llmMode,
        routingMode: 'fallback',
        reasons: ['method_not_allowed'],
      }, {}, req);
      respond(response);
      context.log?.('[orchestrate] response', {
        method,
        url,
        mode: requestMode,
        routing: 'fallback',
        status: 200,
        totalMs: Date.now() - startedAt,
      });
      return response;
    }

    if (!execution.aiEnabled) {
      if (!llm.ok) {
        context.log?.('[orchestrate] warning', {
          message: 'Azure OpenAI is not configured. Falling back to rules output.',
          missing: llm.missing,
        });
      }
      respondWithFallback(execution.reasons[0] || 'fallback_requested');
      return;
    }
    const requestModeHint = resolveRequestModeHint(req, payload);

    const distResponse = await tryInvokeDistHandler({
      context,
      req,
      relativePath: 'dist/functions/orchestrate.js',
      exportName: 'orchestrateHandler',
    });

    if (distResponse) {
      const distStatus = Number(distResponse.status);
      const status = Number.isFinite(distStatus) ? distStatus : 200;
      const bodyFromDist = toRecord(distResponse.jsonBody);
      if (status >= 400) {
        respondWithFallback(`upstream_status_${status}`);
        return;
      }
      if (status === 204 || Object.keys(bodyFromDist).length === 0) {
        respondWithFallback('empty_orchestrate_response');
        return;
      }
      const normalizedResponse = toAnalysisPayload(bodyFromDist, {
        fallbackRoutingReason: '',
        requestModeHint,
      });
      const routing = String(normalizedResponse.routingMode || normalizedResponse.mode || '').toLowerCase() === 'fallback'
        ? 'fallback'
        : 'ai';
      normalizedResponse.dataMode = String(normalizedResponse.dataMode || execution.dataMode);
      normalizedResponse.llmMode = String(normalizedResponse.llmMode || execution.llmMode);
      normalizedResponse.reasons = Array.isArray(normalizedResponse.reasons) ? normalizedResponse.reasons : [];
      const response = jsonResponse(200, normalizedResponse, {}, req);
      respond(response);
      logResponse(routing, 200, normalizedResponse);
      return response;
    }

    respondWithFallback('upstream_unavailable');
    // Return explicitly so the runtime does not emit an implicit 204.
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context.log?.('[orchestrate] error', message);
    respondWithFallback(`upstream_error:${message}`);
    return;
  }
};
