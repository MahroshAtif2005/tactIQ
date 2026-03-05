import { HttpRequest, HttpResponseInit } from '@azure/functions';

const DEFAULT_ALLOWED_ORIGINS = ['http://localhost:5173'];
const ALLOW_METHODS = 'GET,POST,PATCH,DELETE,OPTIONS';
const ALLOW_HEADERS = 'Content-Type, Authorization, api-key, Accept';
const MAX_AGE_SECONDS = '86400';
const CREDENTIALS_ENABLED = false;

const normalizeOrigin = (value: string): string => value.trim().replace(/\/+$/, '').toLowerCase();

const splitOrigins = (value: string): string[] =>
  value
    .split(',')
    .map((entry) => normalizeOrigin(entry))
    .filter(Boolean);

const readOrigin = (request?: HttpRequest): string => {
  const headers = request?.headers as unknown;
  if (!headers || typeof headers !== 'object') return '';
  if (typeof (headers as { get?: unknown }).get === 'function') {
    const value = (headers as { get: (name: string) => string | null }).get('origin');
    return String(value || '').trim();
  }
  const record = headers as Record<string, unknown>;
  return String(record.origin || record.Origin || '').trim();
};

const readAllowedOrigins = (): string[] => {
  const source = String(
    process.env.CORS_ALLOWED_ORIGINS ||
      process.env.CORS ||
      process.env.ALLOWED_ORIGINS ||
      DEFAULT_ALLOWED_ORIGINS.join(',')
  );
  const parsed = splitOrigins(source);
  return parsed.length > 0 ? parsed : [...DEFAULT_ALLOWED_ORIGINS];
};

const isWildcardMatch = (origin: string, rule: string): boolean => {
  if (!rule.includes('*')) return false;
  try {
    const target = new URL(origin);
    const normalizedRule = normalizeOrigin(rule);
    if (normalizedRule === '*') return true;
    const [ruleProtocolRaw, ruleHostRaw] = normalizedRule.split('://');
    if (!ruleProtocolRaw || !ruleHostRaw) return false;
    if (ruleProtocolRaw !== target.protocol.replace(':', '')) return false;
    if (!ruleHostRaw.startsWith('*.')) return false;
    const suffix = ruleHostRaw.slice(1); // keep leading dot
    return target.hostname.toLowerCase().endsWith(suffix);
  } catch {
    return false;
  }
};

const isAllowedOrigin = (origin: string, allowedOrigins: string[]): boolean => {
  const normalizedOrigin = normalizeOrigin(origin);
  return allowedOrigins.some((allowed) => {
    if (allowed === '*') return true;
    if (allowed === normalizedOrigin) return true;
    return isWildcardMatch(origin, allowed);
  });
};

export const getCorsHeaders = (request?: HttpRequest): Record<string, string> => {
  const allowedOrigins = readAllowedOrigins();
  const requestOrigin = readOrigin(request);
  const hasWildcard = allowedOrigins.includes('*');
  const resolvedOrigin = requestOrigin && isAllowedOrigin(requestOrigin, allowedOrigins)
    ? requestOrigin
    : hasWildcard && !CREDENTIALS_ENABLED
      ? '*'
      : allowedOrigins[0] || DEFAULT_ALLOWED_ORIGINS[0];

  const headers: Record<string, string> = {
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

export const handleOptions = (request: HttpRequest): HttpResponseInit => ({
  status: 200,
  headers: {
    ...getCorsHeaders(request),
    'Content-Type': 'application/json; charset=utf-8',
  },
  body: JSON.stringify({ ok: true, preflight: true }),
});

export const corsHeaders = getCorsHeaders;
