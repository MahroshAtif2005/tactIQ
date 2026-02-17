import { FatigueAgentResponse } from '../types/agents';

const fatigueEndpoint = '/api/agents/fatigue';

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
