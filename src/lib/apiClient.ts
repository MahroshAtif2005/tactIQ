import { FatigueAgentResponse, OrchestrateResponse, RiskAgentResponse } from '../types/agents';

const API_BASE = import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, '') ?? '';

const toApiUrl = (path: string): string => `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`;

export const apiHealthUrl = toApiUrl('/api/health');
export const apiOrchestrateUrl = toApiUrl('/api/orchestrate');

const fatigueEndpoint = toApiUrl('/api/agents/fatigue');
const riskEndpoint = toApiUrl('/api/agents/risk');
const orchestrateEndpoint = apiOrchestrateUrl;

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

const coachAgentFailureMessage = (status: number | 'network'): string =>
  `Coach Agent failed (${status}). Check API deployment / VITE_API_BASE_URL.`;

const summarizeErrorText = (text: string): string => {
  const normalized = text.trim().replace(/\s+/g, ' ');
  return normalized.length > 180 ? `${normalized.slice(0, 180)}...` : normalized;
};

const looksLikeHtml = (text: string): boolean => {
  const trimmed = text.trim().toLowerCase();
  return trimmed.startsWith('<!doctype html') || trimmed.startsWith('<html');
};

async function requestText(
  url: string,
  init: RequestInit
): Promise<{ status: number; text: string }> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') {
      throw error;
    }
    console.error('[API] Network error', { url, error });
    throw new ApiClientError(
      coachAgentFailureMessage('network'),
      url,
      undefined,
      error instanceof Error ? error.message : String(error)
    );
  }

  const responseText = await response.text();
  if (!response.ok) {
    console.error('[API] Non-2xx response', {
      url,
      status: response.status,
      body: responseText,
    });
    const shortText = summarizeErrorText(responseText);
    throw new ApiClientError(
      shortText
        ? `${coachAgentFailureMessage(response.status)} API ${response.status}: ${shortText}`
        : coachAgentFailureMessage(response.status),
      url,
      response.status,
      responseText
    );
  }

  return { status: response.status, text: responseText };
}

function parseJsonResponse<TResponse>(
  text: string,
  url: string,
  status: number
): TResponse {
  if (looksLikeHtml(text)) {
    throw new ApiClientError(
      `Coach Agent failed (${status}). API returned HTML instead of JSON at ${url}. Check API routing and SPA fallback.`,
      url,
      status,
      text
    );
  }

  try {
    return JSON.parse(text) as TResponse;
  } catch (error) {
    console.error('[API] Invalid JSON response', {
      url,
      status,
      body: text,
      error,
    });
    throw new ApiClientError(
      coachAgentFailureMessage(status),
      url,
      status,
      text
    );
  }
}

async function postJson<TResponse>(
  url: string,
  payload: unknown,
  signal?: AbortSignal
): Promise<TResponse> {
  const { status, text } = await requestText(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
  return parseJsonResponse<TResponse>(text, url, status);
}

export async function postFatigueAgent(
  payload: unknown,
  signal?: AbortSignal
): Promise<FatigueAgentResponse> {
  return postJson<FatigueAgentResponse>(fatigueEndpoint, payload, signal);
}

export async function postRiskAgent(
  payload: unknown,
  signal?: AbortSignal
): Promise<RiskAgentResponse> {
  return postJson<RiskAgentResponse>(riskEndpoint, payload, signal);
}

export async function postOrchestrate(
  payload: unknown,
  signal?: AbortSignal
): Promise<OrchestrateResponse> {
  return postJson<OrchestrateResponse>(orchestrateEndpoint, payload, signal);
}

export async function getApiHealth(
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  const { text } = await requestText(apiHealthUrl, {
    method: 'GET',
    signal,
  });

  if (!text.trim()) {
    return { status: 'ok' };
  }

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Health endpoint reachability is what matters for preflight.
  }

  return { status: 'ok', raw: text };
}
