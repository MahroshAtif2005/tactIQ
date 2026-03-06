import { HttpRequest, HttpResponseInit } from '@azure/functions';
import { preflight, withCors } from './_cors';

export { preflight, withCors };

export const json = (
  request: HttpRequest,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {}
): HttpResponseInit =>
  withCors(request, {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...headers,
    },
    jsonBody: payload,
  });

export const ok = (request: HttpRequest, payload: unknown): HttpResponseInit => json(request, 200, payload);
export const error = (request: HttpRequest, status: number, payload: unknown): HttpResponseInit =>
  json(request, status, payload);
