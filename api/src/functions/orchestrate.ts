import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { orchestrateAgents } from '../orchestrator/orchestrator';
import { validateOrchestrateRequest } from '../orchestrator/validation';
import { ROUTES } from '../routes/routes';

export async function orchestrateHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const body = await request.json();
    const validated = validateOrchestrateRequest(body);
    if (!validated.ok) {
      return {
        status: 400,
        jsonBody: {
          error: validated.message,
        },
      };
    }
    const result = await orchestrateAgents(validated.value, context);
    return {
      status: result.errors.length > 0 ? 207 : 200,
      jsonBody: result,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid request payload';
    context.error('Orchestrator error', { message });
    return {
      status: 400,
      jsonBody: {
        error: message,
      },
    };
  }
}

app.http('orchestrate', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: ROUTES.orchestrate,
  handler: orchestrateHandler,
});
