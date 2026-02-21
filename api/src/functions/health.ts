import { app, HttpRequest, HttpResponseInit } from '@azure/functions';
import { ROUTES } from '../routes/routes';

export async function healthHandler(_request: HttpRequest): Promise<HttpResponseInit> {
  return {
    status: 200,
    jsonBody: {
      status: 'ok',
      service: 'tactiq-functions',
      timestamp: new Date().toISOString(),
      availableRoutes: {
        health: `/api/${ROUTES.health}`,
        fatigue: `/api/${ROUTES.fatigue}`,
        risk: `/api/${ROUTES.risk}`,
        tactical: `/api/${ROUTES.tactical}`,
        router: `/api/${ROUTES.router}`,
        orchestrate: `/api/${ROUTES.orchestrate}`,
      },
      availableAgents: ['fatigue', 'risk', 'tactical'],
    },
  };
}

app.http('health', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: ROUTES.health,
  handler: healthHandler,
});
