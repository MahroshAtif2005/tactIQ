import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { buildRouterDecision } from '../orchestrator/orchestrator';
import { validateOrchestrateRequest } from '../orchestrator/validation';
import { ROUTES } from '../routes/routes';

export async function routerHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
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

    const mode = validated.value.mode === 'full' ? 'full' : 'auto';
    const decision = buildRouterDecision(mode, validated.value);
    return {
      status: 200,
      jsonBody: {
        intent: decision.intent,
        run: {
          fatigue: decision.selectedAgents.includes('fatigue'),
          risk: decision.selectedAgents.includes('risk'),
          tactical: decision.selectedAgents.includes('tactical'),
        },
        selectedAgents: decision.selectedAgents,
        reason: decision.reason,
        signals: decision.signals,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid router payload';
    context.error('Router endpoint error', { message });
    return {
      status: 400,
      jsonBody: {
        error: message,
      },
    };
  }
}

app.http('router', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: ROUTES.router,
  handler: routerHandler,
});

