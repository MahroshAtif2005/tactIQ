import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { getAoaiConfig } from '../llm/modelRegistry';
import { ok } from '../lib/httpResponse';
import { ROUTES } from '../routes/routes';
import { preflight, withCors } from './_cors';

export async function healthHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const method = String(request.method || 'GET').trim().toUpperCase();
  const url = String(request.url || '/api/health').trim() || '/api/health';
  const pf = preflight(request);
  if (pf) return pf;
  const now = new Date().toISOString();
  const aoai = getAoaiConfig();
  context.log('[health] request', { method, url, mode: 'n/a', routing: 'health' });
  context.log('[health] response', { method, url, mode: 'n/a', routing: 'health', status: 200 });
  return withCors(
    request,
    ok({
      ok: true,
      service: 'tactiq_api',
      time: now,
      timestamp: now,
      aiEnabled: aoai.ok,
      mode: aoai.ok ? 'ai' : 'fallback',
      aoai: {
        endpointSet: aoai.ok ? true : !aoai.missing.includes('AZURE_OPENAI_ENDPOINT'),
        keySet: aoai.ok ? true : !aoai.missing.includes('AZURE_OPENAI_API_KEY'),
        deployment: aoai.ok ? aoai.config.strongDeployment : '',
        deploymentSet: aoai.ok ? true : !aoai.missing.includes('AZURE_OPENAI_DEPLOYMENT'),
        apiVersion: aoai.ok ? aoai.config.apiVersion : process.env.AZURE_OPENAI_API_VERSION || '2024-02-15-preview',
        ...(aoai.ok ? {} : { missing: aoai.missing }),
      },
    })
  );
}

app.http('health', {
  methods: ['GET', 'OPTIONS'],
  authLevel: 'anonymous',
  route: ROUTES.health,
  handler: healthHandler,
});
