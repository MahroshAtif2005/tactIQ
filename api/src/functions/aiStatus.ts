import { app, HttpRequest, HttpResponseInit } from '@azure/functions';
import { getAoaiConfig } from '../llm/modelRegistry';
import { ok } from '../lib/httpResponse';
import { ROUTES } from '../routes/routes';
import { preflight, withCors } from './_cors';

export async function aiStatusHandler(request: HttpRequest): Promise<HttpResponseInit> {
  const pf = preflight(request);
  if (pf) return pf;
  const aoai = getAoaiConfig();
  const endpoint = String(process.env.AZURE_OPENAI_ENDPOINT || '').trim();
  const deploymentName = String(process.env.AZURE_OPENAI_DEPLOYMENT || '').trim();
  const apiVersion = String(process.env.AZURE_OPENAI_API_VERSION || '2024-02-15-preview').trim();
  const endpointHost = (() => {
    try {
      return endpoint ? new URL(endpoint).host : '';
    } catch {
      return '';
    }
  })();
  return withCors(
    request,
    ok({
      ok: true,
      aiEnabled: aoai.ok,
      endpointConfigured: endpoint.length > 0,
      keyConfigured: aoai.ok ? true : !aoai.missing.includes('AZURE_OPENAI_API_KEY'),
      deploymentConfigured: deploymentName.length > 0 || (aoai.ok ? aoai.config.strongDeployment.length > 0 : false),
      apiVersion,
      endpointHost,
      deploymentName: deploymentName || (aoai.ok ? aoai.config.strongDeployment : ''),
      modeHint: aoai.ok ? 'ai' : 'fallback',
      ...(aoai.ok ? {} : { missing: aoai.missing }),
    })
  );
}

app.http('aiStatus', {
  methods: ['GET', 'OPTIONS'],
  authLevel: 'anonymous',
  route: ROUTES.aiStatus,
  handler: aiStatusHandler,
});
