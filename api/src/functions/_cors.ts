import { HttpRequest, HttpResponseInit } from '@azure/functions';
import { getCorsHeaders, handleOptions } from '../cors';

const toHeaderRecord = (headers: HttpResponseInit['headers']): Record<string, string> => {
  if (!headers) return {};
  if (Array.isArray(headers)) {
    return headers.reduce<Record<string, string>>((acc, [name, value]) => {
      acc[String(name)] = String(value);
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

const hasHeader = (headers: Record<string, string>, key: string): boolean =>
  Object.keys(headers).some((existing) => existing.toLowerCase() === key.toLowerCase());

export const preflight = (request: HttpRequest): HttpResponseInit | null =>
  String(request.method || '').trim().toUpperCase() === 'OPTIONS' ? handleOptions(request) : null;

export const withCors = (request: HttpRequest, response: HttpResponseInit): HttpResponseInit => {
  const headers = {
    ...getCorsHeaders(request),
    ...toHeaderRecord(response.headers),
  };
  if (Object.prototype.hasOwnProperty.call(response, 'jsonBody') && !hasHeader(headers, 'Content-Type')) {
    headers['Content-Type'] = 'application/json; charset=utf-8';
  }
  return {
    ...response,
    headers,
  };
};
