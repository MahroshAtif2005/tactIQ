const path = require('path');
const { getCorsHeaders, optionsJsonResponse } = require('../cors');

const handlerCache = new Map();
const loggedMissingConfigByRoute = new Set();
const DEFAULT_CORS_ALLOW_METHODS = 'GET,POST,PATCH,DELETE,OPTIONS';

const firstNonEmpty = (...values) => {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return '';
};

const AOAI_DEFAULT_API_VERSION = '2024-02-15-preview';
const AOAI_ALIAS_MAP = {
  endpoint: [
    'AZURE_OPENAI_ENDPOINT',
    'AZURE_OPENAI_BASE',
    'AZURE_OPENAI_BASE_URL',
    'AOAI_ENDPOINT',
    'OPENAI_ENDPOINT',
  ],
  apiKey: [
    'AZURE_OPENAI_API_KEY',
    'AZURE_OPENAI_KEY',
    'AOAI_API_KEY',
    'OPENAI_API_KEY',
  ],
  deployment: [
    'AZURE_OPENAI_DEPLOYMENT',
    'AZURE_OPENAI_DEPLOYMENT_NAME',
    'AOAI_DEPLOYMENT',
    'AOAI_DEPLOYMENT_FAST',
    'AOAI_DEPLOYMENT_STRONG',
    'AZURE_OPENAI_MODEL',
    'OPENAI_DEPLOYMENT',
    'OPENAI_MODEL',
  ],
  apiVersion: [
    'AZURE_OPENAI_API_VERSION',
    'AOAI_API_VERSION',
    'OPENAI_API_VERSION',
  ],
};

const normalizeEndpoint = (value) => String(value || '').trim().replace(/\/+$/, '');

const readAlias = (aliases = []) => firstNonEmpty(...aliases.map((name) => process.env[name]));

const applyEnvAlias = (target, aliases = []) => {
  const candidate = firstNonEmpty(process.env[target], ...aliases.map((name) => process.env[name]));
  if (candidate) process.env[target] = candidate;
};

const resolveAoaiRuntimeConfig = () => {
  const endpoint = normalizeEndpoint(readAlias(AOAI_ALIAS_MAP.endpoint));
  const apiKey = readAlias(AOAI_ALIAS_MAP.apiKey);
  const deployment = readAlias(AOAI_ALIAS_MAP.deployment);
  const apiVersion = readAlias(AOAI_ALIAS_MAP.apiVersion) || AOAI_DEFAULT_API_VERSION;
  const missing = [];
  if (!endpoint) missing.push('AZURE_OPENAI_ENDPOINT');
  if (!apiKey) missing.push('AZURE_OPENAI_API_KEY');
  if (!deployment) missing.push('AZURE_OPENAI_DEPLOYMENT');

  if (endpoint) process.env.AZURE_OPENAI_ENDPOINT = endpoint;
  if (apiKey) process.env.AZURE_OPENAI_API_KEY = apiKey;
  if (deployment) process.env.AZURE_OPENAI_DEPLOYMENT = deployment;
  process.env.AZURE_OPENAI_API_VERSION = apiVersion;

  return {
    endpoint,
    apiKey,
    deployment,
    apiVersion,
    missing,
    ok: missing.length === 0,
  };
};

applyEnvAlias('COSMOS_DB', ['COSMOS_DATABASE']);
applyEnvAlias('COSMOS_CONTAINER_PLAYERS', ['COSMOS_CONTAINER']);
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

// Keep allowMethods argument for compatibility with existing calls, but enforce one global CORS policy.
const optionsResponse = (_allowMethods = DEFAULT_CORS_ALLOW_METHODS, headers = {}, req = null) => {
  const response = optionsJsonResponse(req);
  return {
    ...response,
    headers: {
      ...response.headers,
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
  const dataMode = requestedDataMode === 'demo' || modeToken === 'demo' ? 'demo' : 'live';
  const llmMode = requestedLlmMode === 'rules' ? 'rules' : 'ai';
  const forcedFallback = modeToken === 'fallback' || llmMode !== 'ai';
  const aiEnabled = !forcedFallback && Boolean(llmState?.ok);
  const reasons = [];
  if (modeToken === 'fallback') reasons.push('mode=fallback');
  if (llmMode !== 'ai') reasons.push('llm_mode_rules');
  if (!llmState?.ok) reasons.push('missing_aoai_config', ...(Array.isArray(llmState?.missing) ? llmState.missing : []));
  return {
    modeToken,
    dataMode,
    llmMode,
    forcedFallback,
    aiEnabled,
    reasons: Array.from(new Set(reasons.filter(Boolean))),
  };
};

const toV4Request = (req) => {
  const body = normalizeBody(req);
  return {
    method: String(req?.method || 'POST').toUpperCase(),
    headers: req?.headers || {},
    query: req?.query || {},
    params: req?.params || {},
    url: req?.url || '',
    body,
    json: async () => body,
  };
};

const toV4Context = (context) => ({
  log: (...args) => {
    if (typeof context?.log === 'function') context.log(...args);
  },
  error: (...args) => {
    if (context?.log && typeof context.log.error === 'function') {
      context.log.error(...args);
      return;
    }
    if (typeof context?.log === 'function') context.log(...args);
  },
  warn: (...args) => {
    if (context?.log && typeof context.log.warn === 'function') {
      context.log.warn(...args);
      return;
    }
    if (typeof context?.log === 'function') context.log(...args);
  },
});

const normalizeHandlerResponse = (result) => {
  if (!result || typeof result !== 'object') {
    return jsonResponse(200, { ok: true, result: result ?? null });
  }

  const rawStatus = Number.isFinite(Number(result.status)) ? Number(result.status) : 200;
  const status = rawStatus === 204 ? 200 : rawStatus;
  const headers = (result.headers && typeof result.headers === 'object') ? result.headers : {};

  if ('jsonBody' in result) {
    return jsonResponse(status, result.jsonBody, headers);
  }

  if ('body' in result) {
    const body = result.body;
    if (typeof body === 'string') {
      try {
        return jsonResponse(status, JSON.parse(body), headers);
      } catch {
        return jsonResponse(status, {
          ok: status < 400,
          message: body,
        }, headers);
      }
    }
    return jsonResponse(status, body, headers);
  }

  return jsonResponse(status, result, headers);
};

const loadDistHandler = (relativePath, exportName, context) => {
  const key = `${relativePath}:${exportName}`;
  if (handlerCache.has(key)) {
    return handlerCache.get(key);
  }

  try {
    let restoreAppHttp = null;
    try {
      const azureFunctions = require('@azure/functions');
      if (azureFunctions?.app && typeof azureFunctions.app.http === 'function') {
        const originalHttp = azureFunctions.app.http;
        azureFunctions.app.http = () => undefined;
        restoreAppHttp = () => {
          azureFunctions.app.http = originalHttp;
        };
      }
    } catch {
      // If patching fails, continue and let normal module loading errors surface.
    }
    let mod;
    try {
      const absolutePath = path.resolve(__dirname, '..', relativePath);
      mod = require(absolutePath);
    } finally {
      if (typeof restoreAppHttp === 'function') {
        restoreAppHttp();
      }
    }
    const handler = mod && mod[exportName];
    if (typeof handler !== 'function') {
      throw new Error(`Export ${exportName} missing from ${relativePath}`);
    }
    handlerCache.set(key, handler);
    return handler;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (typeof context?.log === 'function') {
      context.log(`[functions] unable to load ${relativePath}:${exportName} (${message})`);
    }
    handlerCache.set(key, null);
    return null;
  }
};

const tryInvokeDistHandler = async ({ context, req, relativePath, exportName }) => {
  const handler = loadDistHandler(relativePath, exportName, context);
  if (!handler) return null;

  const result = await handler(toV4Request(req), toV4Context(context));
  return normalizeHandlerResponse(result);
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
        cosmosAuth: Boolean(
          firstNonEmpty(process.env.COSMOS_CONNECTION_STRING) ||
          (firstNonEmpty(process.env.COSMOS_ENDPOINT) && firstNonEmpty(process.env.COSMOS_KEY))
        ),
        cosmosDb: Boolean(firstNonEmpty(process.env.COSMOS_DB, process.env.COSMOS_DATABASE)),
        cosmosContainer: Boolean(firstNonEmpty(process.env.COSMOS_CONTAINER_PLAYERS)),
      },
    });
  }
};

module.exports = {
  jsonResponse,
  optionsResponse,
  normalizeBody,
  resolveAiExecution,
  tryInvokeDistHandler,
  getMissingRuntimeConfig,
  getMissingAzureRuntimeConfig,
  isLlmConfigured,
  resolveAoaiRuntimeConfig,
  logMissingRuntimeConfig,
};
