const AOAI_DEFAULT_API_VERSION = '2024-02-15-preview';

const AOAI_ALIAS_MAP = {
  endpoint: [
    'AZURE_OPENAI_ENDPOINT',
    'AZURE_OPENAI_BASE_URL',
    'OPENAI_ENDPOINT',
    'AOAI_ENDPOINT',
    'AZURE_OPENAI_BASE',
  ],
  apiKey: [
    'AZURE_OPENAI_API_KEY',
    'AZURE_OPENAI_KEY',
    'OPENAI_API_KEY',
    'AOAI_KEY',
    'AOAI_API_KEY',
  ],
  deployment: [
    'AZURE_OPENAI_DEPLOYMENT',
    'AZURE_OPENAI_DEPLOYMENT_NAME',
    'OPENAI_DEPLOYMENT',
    'AZURE_OPENAI_MODEL',
    'OPENAI_MODEL',
    'AOAI_DEPLOYMENT_STRONG',
    'AOAI_DEPLOYMENT_FAST',
    'AOAI_DEPLOYMENT',
  ],
  apiVersion: [
    'AZURE_OPENAI_API_VERSION',
    'OPENAI_API_VERSION',
    'AOAI_API_VERSION',
  ],
  aiEnabled: ['AI_ENABLED'],
};

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

const normalizeEndpoint = (value) => stripQuotes(String(value || '').trim()).replace(/\/+$/, '');

const readAlias = (aliases = []) => firstNonEmpty(...aliases.map((name) => stripQuotes(process.env[name])));

const parseBooleanToken = (value) => {
  const token = stripQuotes(String(value || '').trim()).toLowerCase();
  if (!token) return undefined;
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(token)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(token)) return false;
  return undefined;
};

const safeEndpointHost = (endpoint) => {
  try {
    return endpoint ? new URL(endpoint).host : '';
  } catch {
    return '';
  }
};

const buildAoaiChatUrl = (config = {}) => {
  const endpoint = normalizeEndpoint(config.endpoint || '');
  const deployment = stripQuotes(String(config.deployment || '').trim());
  const apiVersion = stripQuotes(String(config.apiVersion || AOAI_DEFAULT_API_VERSION).trim()) || AOAI_DEFAULT_API_VERSION;
  if (!endpoint || !deployment) return '';
  return `${endpoint}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;
};

const parseStatusCode = (value) => {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed >= 100 && parsed <= 599) return parsed;
  return undefined;
};

const summarizeBody = (value, max = 320) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);

const probeAoaiChatCompletion = async (config = {}, options = {}) => {
  const requestUrl = buildAoaiChatUrl(config);
  if (!requestUrl || !config.apiKey) {
    return {
      ok: false,
      requestUrl,
      authHeader: 'api-key',
      error: 'missing_config',
    };
  }

  const timeoutMs = Number(options.timeoutMs || process.env.AI_STATUS_PROBE_TIMEOUT_MS || 4500);
  const controller = Number.isFinite(timeoutMs) && timeoutMs > 0 && typeof AbortController === 'function'
    ? new AbortController()
    : undefined;
  let timeoutId;
  if (controller) {
    timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  }

  let response;
  let raw = '';
  try {
    response = await fetch(requestUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': String(config.apiKey || ''),
      },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: 'Health check probe.' },
          { role: 'user', content: 'ping' },
        ],
        max_tokens: 1,
        temperature: 0,
      }),
      ...(controller ? { signal: controller.signal } : {}),
    });
    raw = await response.text();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || 'probe_failed');
    const timedOut = Boolean(controller?.signal?.aborted);
    return {
      ok: false,
      requestUrl,
      authHeader: 'api-key',
      ...(timedOut ? { status: 408 } : {}),
      error: timedOut ? `timeout:${message}` : message,
    };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }

  if (response.ok) {
    return {
      ok: true,
      status: response.status,
      requestUrl,
      authHeader: 'api-key',
    };
  }

  let parsedCode = '';
  try {
    const parsed = JSON.parse(raw);
    parsedCode = String((((parsed || {}).error || {}).code) || '').trim();
  } catch {
    parsedCode = '';
  }

  return {
    ok: false,
    status: parseStatusCode(response.status),
    requestUrl,
    authHeader: 'api-key',
    ...(parsedCode ? { code: parsedCode } : {}),
    body: summarizeBody(raw),
  };
};

const resolveAoaiConfig = () => {
  const endpoint = normalizeEndpoint(readAlias(AOAI_ALIAS_MAP.endpoint));
  const apiKey = stripQuotes(readAlias(AOAI_ALIAS_MAP.apiKey));
  const deployment = stripQuotes(readAlias(AOAI_ALIAS_MAP.deployment));
  const apiVersion = stripQuotes(readAlias(AOAI_ALIAS_MAP.apiVersion) || AOAI_DEFAULT_API_VERSION);
  const aiEnabledOverride = parseBooleanToken(readAlias(AOAI_ALIAS_MAP.aiEnabled));

  const missing = [];
  if (!endpoint) missing.push('AZURE_OPENAI_ENDPOINT');
  if (!apiKey) missing.push('AZURE_OPENAI_API_KEY');
  if (!deployment) missing.push('AZURE_OPENAI_DEPLOYMENT');

  const aiDisabled = aiEnabledOverride === false;
  const effectiveMissing = aiDisabled ? [...missing, 'AI_ENABLED=false'] : missing;
  const ok = effectiveMissing.length === 0;

  if (endpoint) process.env.AZURE_OPENAI_ENDPOINT = endpoint;
  if (apiKey) process.env.AZURE_OPENAI_API_KEY = apiKey;
  if (deployment) process.env.AZURE_OPENAI_DEPLOYMENT = deployment;
  process.env.AZURE_OPENAI_API_VERSION = apiVersion;
  if (typeof aiEnabledOverride === 'boolean') {
    process.env.AI_ENABLED = aiEnabledOverride ? 'true' : 'false';
  }

  return {
    endpoint,
    apiKey,
    deployment,
    apiVersion,
    endpointHost: safeEndpointHost(endpoint),
    aiEnabled: ok,
    aiEnabledOverride,
    missing: effectiveMissing,
    configMissing: missing,
    ok,
  };
};

module.exports = {
  AOAI_ALIAS_MAP,
  AOAI_DEFAULT_API_VERSION,
  buildAoaiChatUrl,
  probeAoaiChatCompletion,
  resolveAoaiConfig,
};
