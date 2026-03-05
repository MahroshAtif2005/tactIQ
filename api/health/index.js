const { jsonResponse, optionsResponse, resolveAoaiRuntimeConfig } = require('../shared/agentRuntime');

module.exports = async function health(context, _req) {
  const method = String(_req?.method || 'GET').trim().toUpperCase();
  const url = String(_req?.url || '/api/health').trim() || '/api/health';
  const respond = (response) => {
    context.res = response;
    return response;
  };
  context.log?.('[health] request', { method, url, mode: 'n/a', routing: 'health' });
  if (method === 'OPTIONS') {
    return respond(optionsResponse('GET,OPTIONS', {}, _req));
  }
  const aoai = resolveAoaiRuntimeConfig();
  const now = new Date().toISOString();
  const response = jsonResponse(200, {
    ok: true,
    service: 'tactiq_api',
    time: now,
    timestamp: now,
    aiEnabled: aoai.ok,
    mode: aoai.ok ? 'ai' : 'fallback',
    aoai: {
      endpointSet: Boolean(aoai.endpoint),
      keySet: Boolean(aoai.apiKey),
      deployment: aoai.deployment || '',
      apiVersion: aoai.apiVersion,
      ...(aoai.ok ? {} : { missing: aoai.missing }),
    },
  }, {}, _req);
  respond(response);
  context.log?.('[health] response', { method, url, mode: 'n/a', routing: 'health', status: 200 });
  // Explicit return avoids implicit "No Content" when a handler exits without a response object.
  return response;
};
