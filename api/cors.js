'use strict';

const DEFAULT_ALLOWED_ORIGINS = ['http://localhost:5173'];
const ALLOW_METHODS = 'GET,POST,PATCH,DELETE,OPTIONS';
const ALLOW_HEADERS = 'Content-Type, Authorization, api-key, Accept';
const MAX_AGE_SECONDS = '86400';
const CREDENTIALS_ENABLED = false;

const normalizeOrigin = (value) => String(value || '').trim().replace(/\/+$/, '').toLowerCase();

const splitOrigins = (value) =>
  String(value || '')
    .split(',')
    .map((entry) => normalizeOrigin(entry))
    .filter(Boolean);

const readAllowedOrigins = () => {
  const source = String(
    process.env.CORS_ALLOWED_ORIGINS ||
    process.env.CORS ||
    process.env.ALLOWED_ORIGINS ||
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
  try {
    const parsedOrigin = new URL(origin);
    const normalizedRule = normalizeOrigin(rule);
    if (normalizedRule === '*') return true;
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
  const hasWildcard = allowedOrigins.includes('*');
  const resolvedOrigin = requestOrigin && isAllowedOrigin(requestOrigin, allowedOrigins)
    ? requestOrigin
    : hasWildcard && !CREDENTIALS_ENABLED
      ? '*'
      : allowedOrigins[0] || DEFAULT_ALLOWED_ORIGINS[0];

  const headers = {
    'Access-Control-Allow-Origin': resolvedOrigin,
    'Access-Control-Allow-Methods': ALLOW_METHODS,
    'Access-Control-Allow-Headers': ALLOW_HEADERS,
    'Access-Control-Max-Age': MAX_AGE_SECONDS,
    Vary: 'Origin',
  };
  if (CREDENTIALS_ENABLED) {
    headers['Access-Control-Allow-Credentials'] = 'true';
  }
  return headers;
};

const optionsJsonResponse = (req) => ({
  status: 200,
  headers: {
    ...getCorsHeaders(req),
    'Content-Type': 'application/json; charset=utf-8',
  },
  body: JSON.stringify({ ok: true, preflight: true }),
});

module.exports = {
  corsHeaders: getCorsHeaders(),
  getCorsHeaders,
  optionsJsonResponse,
};
