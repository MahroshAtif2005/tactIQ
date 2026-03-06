import { app, HttpRequest, HttpResponseInit } from '@azure/functions';
import { getAoaiConfig } from '../llm/modelRegistry';
import { ok } from '../lib/httpResponse';
import { ROUTES } from '../routes/routes';
import { loadAoaiEnv } from '../shared/env';
import { preflight, withCors } from './_cors';

export async function aiStatusHandler(request: HttpRequest): Promise<HttpResponseInit> {
  const pf = preflight(request);
  if (pf) return pf;
  const aoai = getAoaiConfig();
  const env = loadAoaiEnv();
  return withCors(
    request,
    ok({
      ok: true,
      aiEnabled: env.aiEnabled,
      endpointConfigured: Boolean(env.endpoint),
      keyConfigured: Boolean(env.apiKey),
      deploymentConfigured: Boolean(env.deployment),
      apiVersion: env.apiVersion,
      endpointHost: env.endpointHost,
      deploymentName: env.deployment || (aoai.ok ? aoai.config.strongDeployment : ''),
      modeHint: env.aiEnabled ? 'ai' : 'fallback',
      ...(env.missing.length > 0 ? { missing: env.missing } : {}),
    })
  );
}

app.http('aiStatus', {
  methods: ['GET', 'OPTIONS'],
  authLevel: 'anonymous',
  route: ROUTES.aiStatus,
  handler: aiStatusHandler,
});
