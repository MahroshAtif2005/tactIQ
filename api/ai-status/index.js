const { jsonResponse, optionsResponse, resolveAoaiRuntimeConfig } = require('../shared/agentRuntime');
const { buildAoaiChatUrl, probeAoaiChatCompletion } = require('../shared/aoaiConfig');

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
  const probe = aoai.ok
    ? await probeAoaiChatCompletion(aoai)
    : { ok: false, error: 'missing_config', requestUrl: buildAoaiChatUrl(aoai), authHeader: 'api-key' };
  const aiEnabled = Boolean(aoai.ok && probe.ok);
  context.log?.('[ai-status] request', {
    method,
    url,
    mode: 'n/a',
    routing: aiEnabled ? 'real' : 'fallback',
  });
  if (aoai.ok) {
    context.log?.('[ai-status] upstream_probe', {
      endpointHost: aoai.endpointHost || '',
      apiVersion: aoai.apiVersion || '',
      deployment: aoai.deployment || '',
      requestUrl: probe.requestUrl || '',
      authHeader: probe.authHeader || 'api-key',
      ok: probe.ok,
      status: typeof probe.status === 'number' ? probe.status : undefined,
      code: probe.code || undefined,
      error: probe.error || undefined,
    });
  }
  const response = jsonResponse(200, {
    ok: true,
    aiEnabled,
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
    modeHint: aiEnabled ? 'ai' : 'fallback',
    upstream: {
      checked: Boolean(aoai.ok),
      ok: Boolean(probe.ok),
      requestUrl: probe.requestUrl || '',
      authHeader: probe.authHeader || 'api-key',
      ...(typeof probe.status === 'number' ? { status: probe.status } : {}),
      ...(probe.code ? { code: probe.code } : {}),
      ...(probe.error ? { error: probe.error } : {}),
      ...(probe.body ? { body: probe.body } : {}),
    },
    ...(missing.length > 0 ? { missing } : {}),
  }, {}, _req);
  respond(response);
  context.log?.('[ai-status] response', {
    method,
    url,
    mode: 'n/a',
    routing: aiEnabled ? 'real' : 'fallback',
    status: 200,
  });
  // Explicit return avoids implicit "No Content" responses in legacy handlers.
  return response;
};
