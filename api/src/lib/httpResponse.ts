import { HttpResponseInit } from '@azure/functions';

type JsonBody = Record<string, unknown> | Array<unknown> | string | number | boolean | null;

export const json = (
  status: number,
  body: JsonBody,
  extraHeaders: Record<string, string> = {}
): HttpResponseInit => ({
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    ...extraHeaders,
  },
  body: JSON.stringify(body),
});

export const ok = (body: JsonBody, extraHeaders: Record<string, string> = {}): HttpResponseInit =>
  json(200, body, extraHeaders);

export const badRequest = (message: string, extra: Record<string, unknown> = {}): HttpResponseInit =>
  ok({
    ok: false,
    error: 'bad_request',
    message,
    ...extra,
  });

export const internalError = (message: string, extra: Record<string, unknown> = {}): HttpResponseInit =>
  ok({
    ok: false,
    error: 'internal_error',
    message,
    ...extra,
  });
