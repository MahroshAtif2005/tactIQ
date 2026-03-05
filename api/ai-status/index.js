const { jsonResponse, optionsResponse, resolveAoaiRuntimeConfig } = require('../shared/agentRuntime');

module.exports = async function aiStatus(context, _req) {
  const method = String(_req?.method || 'GET').trim().toUpperCase();
  const url = String(_req?.url || '/api/ai/status').trim() || '/api/ai/status';
  const respond = (response) => {
    context.res = response;
    return response;
  };
  if (method === 'OPTIONS') {
    return respond(optionsResponse('GET,OPTIONS', {}, _req));
  }
  const aoai = resolveAoaiRuntimeConfig();
  const missing = aoai.missing;
  context.log?.('[ai-status] request', {
    method,
    url,
    mode: 'n/a',
    routing: missing.length === 0 ? 'real' : 'fallback',
  });
  const response = jsonResponse(200, {
    ok: true,
    aiEnabled: aoai.ok,
    endpointConfigured: Boolean(aoai.endpoint),
    keyConfigured: Boolean(aoai.apiKey),
    deploymentConfigured: Boolean(aoai.deployment),
    apiVersion: aoai.apiVersion,
    endpointHost: (() => {
      try {
        return aoai.endpoint ? new URL(aoai.endpoint).host : '';
      } catch {
        return '';
      }
    })(),
    deploymentName: aoai.deployment || '',
    modeHint: aoai.ok ? 'ai' : 'fallback',
    ...(missing.length > 0 ? { missing } : {}),
  }, {}, _req);
  respond(response);
  context.log?.('[ai-status] response', {
    method,
    url,
    mode: 'n/a',
    routing: missing.length === 0 ? 'real' : 'fallback',
    status: 200,
  });
  // Explicit return avoids implicit "No Content" responses in legacy handlers.
  return response;
};
