const path = require('path');

const handlerCache = new Map();
const loggedMissingConfigByRoute = new Set();

const firstNonEmpty = (...values) => {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return '';
};

const applyEnvAlias = (target, aliases = []) => {
  const current = firstNonEmpty(process.env[target]);
  if (current) return;
  const candidate = firstNonEmpty(...aliases.map((name) => process.env[name]));
  if (candidate) {
    process.env[target] = candidate;
  }
};

applyEnvAlias('AZURE_OPENAI_API_KEY', ['AZURE_OPENAI_KEY']);
applyEnvAlias('AZURE_OPENAI_DEPLOYMENT', ['AOAI_DEPLOYMENT_FAST']);
applyEnvAlias('COSMOS_DB', ['COSMOS_DATABASE']);
applyEnvAlias('COSMOS_CONTAINER', ['COSMOS_CONTAINER_PLAYERS']);

const normalizePayload = (payload) => {
  if (payload === undefined) return { ok: true };
  return payload;
};

const jsonResponse = (status, payload, headers = {}) => ({
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    ...headers,
  },
  jsonBody: normalizePayload(payload),
  body: JSON.stringify(normalizePayload(payload)),
});

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
    const absolutePath = path.resolve(__dirname, '..', relativePath);
    const mod = require(absolutePath);
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
  const endpoint = firstNonEmpty(process.env.AZURE_OPENAI_ENDPOINT);
  const apiKey = firstNonEmpty(process.env.AZURE_OPENAI_API_KEY, process.env.AZURE_OPENAI_KEY);
  const deployment = firstNonEmpty(
    process.env.AZURE_OPENAI_DEPLOYMENT,
    process.env.AOAI_DEPLOYMENT_FAST,
    process.env.AZURE_OPENAI_MODEL
  );
  const apiVersion = firstNonEmpty(process.env.AZURE_OPENAI_API_VERSION);

  if (!endpoint) missing.push('AZURE_OPENAI_ENDPOINT');
  if (!apiKey) missing.push('AZURE_OPENAI_API_KEY|AZURE_OPENAI_KEY');
  if (!deployment) missing.push('AZURE_OPENAI_DEPLOYMENT|AOAI_DEPLOYMENT_FAST');
  if (!apiVersion) missing.push('AZURE_OPENAI_API_VERSION');

  const connectionString = firstNonEmpty(process.env.COSMOS_CONNECTION_STRING);
  const cosmosEndpoint = firstNonEmpty(process.env.COSMOS_ENDPOINT);
  const cosmosKey = firstNonEmpty(process.env.COSMOS_KEY);
  const cosmosDb = firstNonEmpty(process.env.COSMOS_DB, process.env.COSMOS_DATABASE);
  const cosmosContainer = firstNonEmpty(process.env.COSMOS_CONTAINER, process.env.COSMOS_CONTAINER_PLAYERS);
  const hasCosmosAuth = Boolean(connectionString || (cosmosEndpoint && cosmosKey));
  if (!hasCosmosAuth) {
    missing.push('COSMOS_CONNECTION_STRING|COSMOS_ENDPOINT+COSMOS_KEY');
  }
  if (!cosmosDb) missing.push('COSMOS_DB|COSMOS_DATABASE');
  if (!cosmosContainer) missing.push('COSMOS_CONTAINER|COSMOS_CONTAINER_PLAYERS');

  return missing;
};

const logMissingRuntimeConfig = (context, routeName, missing) => {
  if (!Array.isArray(missing) || missing.length === 0) return;
  const key = `${routeName}:${missing.join('|')}`;
  if (loggedMissingConfigByRoute.has(key)) return;
  loggedMissingConfigByRoute.add(key);
  if (typeof context?.log === 'function') {
    context.log(`[${routeName}] missing_config`, {
      missing,
      envPresence: {
        endpoint: Boolean(firstNonEmpty(process.env.AZURE_OPENAI_ENDPOINT)),
        apiKey: Boolean(firstNonEmpty(process.env.AZURE_OPENAI_API_KEY, process.env.AZURE_OPENAI_KEY)),
        deployment: Boolean(firstNonEmpty(process.env.AZURE_OPENAI_DEPLOYMENT, process.env.AOAI_DEPLOYMENT_FAST)),
        apiVersion: Boolean(firstNonEmpty(process.env.AZURE_OPENAI_API_VERSION)),
        cosmosAuth: Boolean(
          firstNonEmpty(process.env.COSMOS_CONNECTION_STRING) ||
          (firstNonEmpty(process.env.COSMOS_ENDPOINT) && firstNonEmpty(process.env.COSMOS_KEY))
        ),
        cosmosDb: Boolean(firstNonEmpty(process.env.COSMOS_DB, process.env.COSMOS_DATABASE)),
        cosmosContainer: Boolean(firstNonEmpty(process.env.COSMOS_CONTAINER, process.env.COSMOS_CONTAINER_PLAYERS)),
      },
    });
  }
};

module.exports = {
  jsonResponse,
  normalizeBody,
  tryInvokeDistHandler,
  getMissingRuntimeConfig,
  logMissingRuntimeConfig,
};
