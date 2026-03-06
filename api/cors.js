'use strict';

const DEFAULT_ALLOWED_ORIGINS = ['http://localhost:5173'];
const ALLOW_METHODS = 'GET,POST,PATCH,DELETE,OPTIONS';
const ALLOW_HEADERS = 'Content-Type, Authorization, Accept';
const MAX_AGE_SECONDS = '86400';

const normalizeOrigin = (value) => String(value || '').trim().replace(/\/+$/, '').toLowerCase();
const stripQuotes = (value) => {
  const trimmed = String(value || '').trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
};

const splitOrigins = (value) =>
  String(value || '')
    .split(',')
    .map((entry) => normalizeOrigin(stripQuotes(entry)))
    .filter(Boolean);

const readAllowedOrigins = () => {
  const source = String(
    process.env.CORS_ALLOWED_ORIGINS ||
      process.env.ALLOWED_ORIGINS ||
      process.env.CORS_ORIGINS ||
      process.env.CORS ||
      DEFAULT_ALLOWED_ORIGINS.join(',')
  );
  const parsed = splitOrigins(source);
  return parsed.length > 0 ? parsed : [...DEFAULT_ALLOWED_ORIGINS];
};

const readRequestOrigin = (req) => {
  const headers = req?.headers;
  if (!headers || typeof headers !== 'object') return '';
  if (typeof headers.get === 'function') {
    return String(headers.get('origin') || '').trim();
  }
  return String(headers.origin || headers.Origin || '').trim();
};

const isWildcardMatch = (origin, rule) => {
  if (!String(rule || '').includes('*')) return false;
  if (rule === '*') return true;
  try {
    const parsedOrigin = new URL(origin);
    const normalizedRule = normalizeOrigin(rule);
    const [ruleProtocolRaw, ruleHostRaw] = normalizedRule.split('://');
    if (!ruleProtocolRaw || !ruleHostRaw) return false;
    if (ruleProtocolRaw !== parsedOrigin.protocol.replace(':', '')) return false;
    if (!ruleHostRaw.startsWith('*.')) return false;
    const suffix = ruleHostRaw.slice(1);
    return parsedOrigin.hostname.toLowerCase().endsWith(suffix);
  } catch {
    return false;
  }
};

const isAllowedOrigin = (origin, allowedOrigins) => {
  const normalizedOrigin = normalizeOrigin(origin);
  return allowedOrigins.some((allowed) => {
    if (allowed === '*') return true;
    if (allowed === normalizedOrigin) return true;
    return isWildcardMatch(origin, allowed);
  });
};

const getCorsHeaders = (req) => {
  const allowedOrigins = readAllowedOrigins();
  const requestOrigin = readRequestOrigin(req);
  const headers = {
    'Access-Control-Allow-Methods': ALLOW_METHODS,
    'Access-Control-Allow-Headers': ALLOW_HEADERS,
    'Access-Control-Max-Age': MAX_AGE_SECONDS,
    Vary: 'Origin',
  };

  if (requestOrigin && isAllowedOrigin(requestOrigin, allowedOrigins)) {
    headers['Access-Control-Allow-Origin'] = requestOrigin;
    return headers;
  }

  if (!requestOrigin && allowedOrigins.includes('*')) {
    headers['Access-Control-Allow-Origin'] = '*';
    return headers;
  }

  const fallbackOrigin = allowedOrigins.find((entry) => entry !== '*') || DEFAULT_ALLOWED_ORIGINS[0];
  if (fallbackOrigin) headers['Access-Control-Allow-Origin'] = fallbackOrigin;
  return headers;
};

const optionsJsonResponse = (req) => ({
  status: 204,
  headers: getCorsHeaders(req),
});

module.exports = {
  corsHeaders: getCorsHeaders(),
  getCorsHeaders,
  optionsJsonResponse,
};
