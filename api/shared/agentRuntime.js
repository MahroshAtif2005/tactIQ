const { getCorsHeaders, optionsJsonResponse } = require('../cors');
const { resolveAoaiConfig } = require('./aoaiConfig');

const loggedMissingConfigByRoute = new Set();

const firstNonEmpty = (...values) => {
  for (const value of values) {
    const normalized = String(value || '').trim();
    if (normalized.length > 0) return normalized;
  }
  return '';
};

const stripQuotes = (value) => {
  const normalized = String(value || '').trim();
  if (
    (normalized.startsWith('"') && normalized.endsWith('"')) ||
    (normalized.startsWith("'") && normalized.endsWith("'"))
  ) {
    return normalized.slice(1, -1).trim();
  }
  return normalized;
};

const applyEnvAlias = (target, aliases = []) => {
  const candidate = firstNonEmpty(process.env[target], ...aliases.map((name) => process.env[name]));
  if (candidate) process.env[target] = stripQuotes(candidate);
};

const resolveAoaiRuntimeConfig = () => {
  const resolved = resolveAoaiConfig();
  return {
    endpoint: resolved.endpoint,
    apiKey: resolved.apiKey,
    deployment: resolved.deployment,
    apiVersion: resolved.apiVersion,
    endpointHost: resolved.endpointHost,
    aiEnabled: resolved.aiEnabled,
    aiEnabledOverride: resolved.aiEnabledOverride,
    missing: resolved.missing,
    ok: resolved.ok,
  };
};

applyEnvAlias('COSMOS_DB', ['COSMOS_DATABASE']);
applyEnvAlias('COSMOS_CONNECTION_STRING', ['AZURE_COSMOS_CONNECTION_STRING', 'AZURE_COSMOSDB_CONNECTION_STRING']);
applyEnvAlias('COSMOS_ENDPOINT', ['AZURE_COSMOS_ENDPOINT', 'AZURE_COSMOSDB_ENDPOINT']);
applyEnvAlias('COSMOS_KEY', ['AZURE_COSMOS_KEY', 'AZURE_COSMOS_PRIMARY_KEY', 'AZURE_COSMOSDB_KEY']);
resolveAoaiRuntimeConfig();

const normalizePayload = (payload) => {
  if (payload === undefined) return { ok: true };
  return payload;
};

const buildCorsHeaders = (overrides = {}, req = null) => ({
  ...getCorsHeaders(req),
  ...overrides,
});

const jsonResponse = (status, payload, headers = {}, req = null) => ({
  status,
  headers: {
    ...buildCorsHeaders({}, req),
    'Content-Type': 'application/json; charset=utf-8',
    ...headers,
  },
  jsonBody: normalizePayload(payload),
  body: JSON.stringify(normalizePayload(payload)),
});

const optionsResponse = (_allowMethods = 'GET,POST,PATCH,DELETE,OPTIONS', headers = {}, req = null) => {
  const response = optionsJsonResponse(req);
  return {
    ...response,
    headers: {
      ...(response.headers || {}),
      ...headers,
    },
  };
};

const normalizeBody = (req) => {
  if (req && typeof req.body === 'object' && req.body !== null) return req.body;
  if (typeof req?.body === 'string' && req.body.trim().length > 0) {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  if (typeof req?.rawBody === 'string' && req.rawBody.trim().length > 0) {
    try {
      return JSON.parse(req.rawBody);
    } catch {
      return {};
    }
  }
  return {};
};

const resolveAiExecution = (payload, llmState) => {
  const modeToken = String(payload?.mode || '').trim().toLowerCase();
  const requestedDataMode = String(payload?.dataMode || '').trim().toLowerCase();
  const requestedLlmMode = String(payload?.llmMode || '').trim().toLowerCase();

  const requestedMode = modeToken === 'ai' || modeToken === 'demo' || modeToken === 'fallback' || modeToken === 'full'
    ? modeToken
    : 'auto';

  const dataMode = requestedDataMode === 'demo' || requestedMode === 'demo' ? 'demo' : 'live';
  const llmMode = requestedLlmMode === 'rules' || modeToken === 'rules' ? 'rules' : 'ai';
  const strictAi = requestedMode === 'ai';

  const reasons = [];
  if (requestedMode === 'fallback') reasons.push('mode=fallback');
  if (llmMode !== 'ai') reasons.push('llm_mode_rules');
  if (!llmState?.ok) {
    reasons.push('missing_aoai_config', ...(Array.isArray(llmState?.missing) ? llmState.missing : []));
  }

  const aiEnabled = llmMode === 'ai' && Boolean(llmState?.ok);

  return {
    requestedMode,
    modeToken,
    dataMode,
    llmMode,
    strictAi,
    aiEnabled,
    reasons: Array.from(new Set(reasons.filter(Boolean))),
  };
};

const getMissingRuntimeConfig = () => {
  const missing = [];
  const aoai = resolveAoaiRuntimeConfig();
  missing.push(...aoai.missing);

  const connectionString = firstNonEmpty(process.env.COSMOS_CONNECTION_STRING);
  const cosmosEndpoint = firstNonEmpty(process.env.COSMOS_ENDPOINT);
  const cosmosKey = firstNonEmpty(process.env.COSMOS_KEY);
  const cosmosDb = firstNonEmpty(process.env.COSMOS_DB, process.env.COSMOS_DATABASE);
  const cosmosContainer = firstNonEmpty(process.env.COSMOS_CONTAINER_PLAYERS);
  const hasCosmosAuth = Boolean(connectionString || (cosmosEndpoint && cosmosKey));
  if (!hasCosmosAuth) {
    missing.push('COSMOS_CONNECTION_STRING|COSMOS_ENDPOINT+COSMOS_KEY');
  }
  if (!cosmosDb) missing.push('COSMOS_DB|COSMOS_DATABASE');
  if (!cosmosContainer) missing.push('COSMOS_CONTAINER_PLAYERS');

  return missing;
};

const getMissingAzureRuntimeConfig = () => {
  return resolveAoaiRuntimeConfig().missing;
};

const isLlmConfigured = () => {
  const aoai = resolveAoaiRuntimeConfig();
  return {
    ok: aoai.ok,
    missing: aoai.missing,
    config: {
      endpoint: aoai.endpoint,
      deployment: aoai.deployment,
      apiVersion: aoai.apiVersion,
    },
  };
};

const logMissingRuntimeConfig = (context, routeName, missing) => {
  if (!Array.isArray(missing) || missing.length === 0) return;
  const key = `${routeName}:${missing.join('|')}`;
  if (loggedMissingConfigByRoute.has(key)) return;
  loggedMissingConfigByRoute.add(key);
  if (typeof context?.log === 'function') {
    const aoai = resolveAoaiRuntimeConfig();
    context.log(`[${routeName}] missing_config`, {
      missing,
      envPresence: {
        endpoint: Boolean(aoai.endpoint),
        apiKey: Boolean(aoai.apiKey),
        deployment: Boolean(aoai.deployment),
        apiVersion: Boolean(aoai.apiVersion),
      },
    });
  }
};

module.exports = {
  jsonResponse,
  optionsResponse,
  normalizeBody,
  resolveAiExecution,
  getMissingRuntimeConfig,
  getMissingAzureRuntimeConfig,
  isLlmConfigured,
  resolveAoaiRuntimeConfig,
  logMissingRuntimeConfig,
};
