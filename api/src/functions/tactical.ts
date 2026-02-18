import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { randomUUID } from 'crypto';
import { runTacticalAgent } from '../agents/tacticalAgent';
import { validateTacticalRequest } from '../orchestrator/validation';
import { ROUTES } from '../routes/routes';
import { getAoaiConfig } from '../llm/modelRegistry';

export async function tacticalHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const requestId = randomUUID();
  const startedAt = Date.now();
  const aoai = getAoaiConfig();
  try {
    const body = await request.json();
    const validated = validateTacticalRequest(body);
    if (!validated.ok) {
      return {
        status: 400,
        jsonBody: {
          error: validated.message,
          requestId,
        },
      };
    }

    const result = await runTacticalAgent({
      ...validated.value,
      requestId,
    });

    return {
      status: 200,
      jsonBody: {
        ...result.output,
        meta: {
          requestId,
          model: result.model,
          fallbacksUsed: result.fallbacksUsed,
          ...(aoai.ok ? {} : { aoai: { missing: aoai.missing } }),
          timingsMs: {
            tactical: Date.now() - startedAt,
          },
        },
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid request payload';
    context.error('Tactical agent error', { requestId, message });
    return {
      status: 400,
      jsonBody: {
        error: message,
        requestId,
      },
    };
  }
}

app.http('tactical', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: ROUTES.tactical,
  handler: tacticalHandler,
});
