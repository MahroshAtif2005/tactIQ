const {
  jsonResponse,
  optionsResponse,
  normalizeBody,
  resolveAiExecution,
  tryInvokeDistHandler,
  isLlmConfigured,
} = require('../shared/agentRuntime');
const { runFatigueFallback, runRiskFallback } = require('../shared/simpleAgents');

module.exports = async function risk(context, req) {
  const startedAt = Date.now();
  const method = String(req?.method || 'POST').trim().toUpperCase();
  const url = String(req?.url || '/api/agents/risk').trim() || '/api/agents/risk';
  const respond = (response) => {
    context.res = response;
    return response;
  };
  if (method === 'OPTIONS') {
    return respond(optionsResponse('POST,OPTIONS', {}, req));
  }
  const payload = normalizeBody(req);
  const requestMode = String(payload?.mode || '').trim().toLowerCase() || 'auto';
  const llm = isLlmConfigured();
  const execution = resolveAiExecution(payload, llm);
  context.log?.('[risk] request', {
    method,
    url,
    mode: requestMode,
    routing: execution.aiEnabled ? 'real' : 'fallback',
    aiEnabled: execution.aiEnabled,
    dataMode: execution.dataMode,
    llmMode: execution.llmMode,
    llmConfigured: llm.ok,
  });

  const respondWithFallback = (reason) => {
    const fatigue = runFatigueFallback(payload);
    const fallback = runRiskFallback(payload, fatigue);
    const reasons = Array.from(
      new Set([String(reason || '').trim(), ...execution.reasons, ...llm.missing].filter(Boolean))
    );
    const responseBody = {
      ...fallback,
      mode: 'fallback',
      dataMode: execution.dataMode,
      llmMode: execution.llmMode,
      status: 'fallback',
      routingMode: 'fallback',
      reasons,
      createdAt: new Date().toISOString(),
    };
    const response = jsonResponse(200, responseBody, {}, req);
    respond(response);
    context.log?.('[risk] response', {
      method,
      url,
      mode: requestMode,
      routing: 'fallback',
      status: 200,
      durationMs: Date.now() - startedAt,
    });
    return response;
  };

  try {
    if (!execution.aiEnabled) {
      if (!llm.ok) {
        context.log?.('[risk] warning', {
          message: 'Azure OpenAI is not configured. Falling back to rules output.',
          missing: llm.missing,
        });
      }
      respondWithFallback(execution.reasons[0] || 'fallback_requested');
      return;
    }

    const distResponse = await tryInvokeDistHandler({
      context,
      req,
      relativePath: 'dist/functions/risk.js',
      exportName: 'riskHandler',
    });

    if (distResponse) {
      const status = Number.isFinite(Number(distResponse.status)) ? Number(distResponse.status) : 200;
      const body = (distResponse.jsonBody && typeof distResponse.jsonBody === 'object')
        ? distResponse.jsonBody
        : {};
      if (status >= 400 || status === 204 || Object.keys(body).length === 0) {
        respondWithFallback(`upstream_status_${status}`);
        return;
      }
      const routingModeToken = String(body.routingMode || body.mode || body.status || '').trim().toLowerCase();
      const routingMode = routingModeToken === 'fallback'
        ? 'fallback'
        : routingModeToken === 'demo'
          ? 'demo'
          : 'ai';
      const response = jsonResponse(200, {
        ...body,
        mode: String(body.mode || (routingMode === 'ai' ? 'live' : routingMode)),
        dataMode: String(body.dataMode || execution.dataMode),
        llmMode: String(body.llmMode || execution.llmMode),
        routingMode,
        reasons: Array.isArray(body.reasons) ? body.reasons : [],
        createdAt: String(body.createdAt || new Date().toISOString()),
      }, {}, req);
      respond(response);
      context.log?.('[risk] response', {
        method,
        url,
        mode: requestMode,
        routing: routingMode,
        status: 200,
        durationMs: Date.now() - startedAt,
      });
      return response;
    }

    respondWithFallback('upstream_unavailable');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context.log?.('[risk] error', message);
    respondWithFallback(`upstream_error:${message}`);
  }
};
