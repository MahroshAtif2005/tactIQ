import { FatigueAgentResponse, OrchestrateResponse, RiskAgentResponse } from '../types/agents';

const fatigueEndpoint = '/api/agents/fatigue';
const riskEndpoint = '/api/agents/risk';
const orchestrateEndpoint = '/api/orchestrate';

export class ApiClientError extends Error {
  status?: number;
  url: string;
  body?: string;

  constructor(message: string, url: string, status?: number, body?: string) {
    super(message);
    this.name = 'ApiClientError';
    this.url = url;
    this.status = status;
    this.body = body;
  }
}

export async function postFatigueAgent(
  payload: unknown,
  signal?: AbortSignal
): Promise<FatigueAgentResponse> {
  let response: Response;
  try {
    response = await fetch(fatigueEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (error) {
    console.error('[FatigueAgent] Network error', {
      url: fatigueEndpoint,
      error,
    });
    throw new ApiClientError(
      'AI Offline. Start backend: cd api && func start',
      fatigueEndpoint
    );
  }

  if (!response.ok) {
    const responseText = await response.text();
    console.error('[FatigueAgent] Non-2xx response', {
      url: fatigueEndpoint,
      status: response.status,
      body: responseText,
    });
    throw new ApiClientError(
      `AI Offline. Start backend: cd api && func start`,
      fatigueEndpoint,
      response.status,
      responseText
    );
  }

  return response.json() as Promise<FatigueAgentResponse>;
}

export async function postRiskAgent(
  payload: unknown,
  signal?: AbortSignal
): Promise<RiskAgentResponse> {
  let response: Response;
  try {
    response = await fetch(riskEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (error) {
    console.error('[RiskAgent] Network error', {
      url: riskEndpoint,
      error,
    });
    throw new ApiClientError(
      'AI Offline. Start backend: cd api && func start',
      riskEndpoint
    );
  }

  if (!response.ok) {
    const responseText = await response.text();
    console.error('[RiskAgent] Non-2xx response', {
      url: riskEndpoint,
      status: response.status,
      body: responseText,
    });
    throw new ApiClientError(
      `AI Offline. Start backend: cd api && func start`,
      riskEndpoint,
      response.status,
      responseText
    );
  }

  return response.json() as Promise<RiskAgentResponse>;
}

export async function postOrchestrate(
  payload: unknown,
  signal?: AbortSignal
): Promise<OrchestrateResponse> {
  let response: Response;
  try {
    response = await fetch(orchestrateEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (error) {
    console.error('[Orchestrate] Network error', {
      url: orchestrateEndpoint,
      error,
    });
    throw new ApiClientError(
      'AI Offline. Start backend: cd api && func start',
      orchestrateEndpoint
    );
  }

  if (!response.ok) {
    const responseText = await response.text();
    console.error('[Orchestrate] Non-2xx response', {
      url: orchestrateEndpoint,
      status: response.status,
      body: responseText,
    });
    throw new ApiClientError(
      'AI Offline. Start backend: cd api && func start',
      orchestrateEndpoint,
      response.status,
      responseText
    );
  }

  return response.json() as Promise<OrchestrateResponse>;
}
