import { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';

const DEFAULT_ALLOWED_ORIGINS = ['http://localhost:5173'];
const ALLOW_METHODS = 'GET,POST,PATCH,DELETE,OPTIONS';
const ALLOW_HEADERS = 'Content-Type, Authorization, Accept';
const MAX_AGE = '86400';

type HttpHandler = (request: HttpRequest, context: InvocationContext) => Promise<HttpResponseInit> | HttpResponseInit;

const normalizeOrigin = (value: string): string => value.trim().replace(/\/+$/, '').toLowerCase();

const stripQuotes = (value: string): string => {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
};

const splitOrigins = (value: string): string[] =>
  value
    .split(',')
    .map((entry) => normalizeOrigin(stripQuotes(entry)))
    .filter(Boolean);

const readAllowedOrigins = (): string[] => {
  const raw =
    process.env.CORS_ALLOWED_ORIGINS ||
    process.env.ALLOWED_ORIGINS ||
    process.env.CORS_ORIGINS ||
    process.env.CORS ||
    DEFAULT_ALLOWED_ORIGINS.join(',');
  const parsed = splitOrigins(raw);
  return parsed.length > 0 ? parsed : [...DEFAULT_ALLOWED_ORIGINS];
};

const readOrigin = (request?: HttpRequest): string => {
  if (!request?.headers) return '';
  if (typeof request.headers.get === 'function') {
    return String(request.headers.get('origin') || '').trim();
  }
  const rawHeaders = request.headers as unknown as Record<string, unknown>;
  return String(rawHeaders.origin || rawHeaders.Origin || '').trim();
};

const isWildcardMatch = (origin: string, rule: string): boolean => {
  if (!rule.includes('*')) return false;
  if (rule === '*') return true;
  try {
    const parsedOrigin = new URL(origin);
    const normalizedRule = normalizeOrigin(rule);
    const [ruleProtocol, ruleHost] = normalizedRule.split('://');
    if (!ruleProtocol || !ruleHost) return false;
    if (ruleProtocol !== parsedOrigin.protocol.replace(':', '')) return false;
    if (!ruleHost.startsWith('*.')) return false;
    const suffix = ruleHost.slice(1); // include leading dot
    return parsedOrigin.hostname.toLowerCase().endsWith(suffix);
  } catch {
    return false;
  }
};

const isAllowedOrigin = (origin: string, allowed: string[]): boolean => {
  const normalizedOrigin = normalizeOrigin(origin);
  return allowed.some((entry) => {
    if (entry === '*') return true;
    if (entry === normalizedOrigin) return true;
    return isWildcardMatch(origin, entry);
  });
};

export const getCorsHeaders = (request?: HttpRequest): Record<string, string> => {
  const allowed = readAllowedOrigins();
  const requestOrigin = readOrigin(request);
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': ALLOW_METHODS,
    'Access-Control-Allow-Headers': ALLOW_HEADERS,
    'Access-Control-Max-Age': MAX_AGE,
    Vary: 'Origin',
  };

  if (requestOrigin && isAllowedOrigin(requestOrigin, allowed)) {
    headers['Access-Control-Allow-Origin'] = requestOrigin;
    return headers;
  }

  if (!requestOrigin && allowed.includes('*')) {
    headers['Access-Control-Allow-Origin'] = '*';
    return headers;
  }

  const fallback = allowed.find((entry) => entry !== '*') || DEFAULT_ALLOWED_ORIGINS[0];
  if (fallback) {
    headers['Access-Control-Allow-Origin'] = fallback;
  }
  return headers;
};

export const corsHeaders = getCorsHeaders;

const headersToRecord = (headers: HttpResponseInit['headers']): Record<string, string> => {
  if (!headers) return {};
  if (Array.isArray(headers)) {
    return headers.reduce<Record<string, string>>((acc, [key, value]) => {
      acc[String(key)] = String(value);
      return acc;
    }, {});
  }
  if (typeof (headers as { forEach?: unknown }).forEach === 'function') {
    const record: Record<string, string> = {};
    (headers as Headers).forEach((value, key) => {
      record[key] = value;
    });
    return record;
  }
  return Object.entries(headers as Record<string, unknown>).reduce<Record<string, string>>((acc, [key, value]) => {
    acc[key] = String(value);
    return acc;
  }, {});
};

export const mergeCorsHeaders = (request: HttpRequest, response: HttpResponseInit): HttpResponseInit => {
  const mergedHeaders = {
    ...getCorsHeaders(request),
    ...headersToRecord(response.headers),
  };
  return {
    ...response,
    headers: mergedHeaders,
  };
};

export const handleOptions = (request: HttpRequest): HttpResponseInit => ({
  status: 204,
  headers: getCorsHeaders(request),
});

export const withCors = (handler: HttpHandler): HttpHandler =>
  async (request, context) => {
    if (String(request.method || '').toUpperCase() === 'OPTIONS') {
      return handleOptions(request);
    }

    try {
      const response = await handler(request, context);
      return mergeCorsHeaders(request, response);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unhandled error';
      context.error('[cors-wrapper] handler_error', { message });
      return mergeCorsHeaders(request, {
        status: 500,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ ok: false, error: 'internal_error', message }),
      });
    }
  };
