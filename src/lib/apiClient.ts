import { FatigueAgentResponse, OrchestrateResponse, RiskAgentResponse } from '../types/agents';

export const apiHealthUrl = '/api/health';
export const apiOrchestrateUrl = '/api/orchestrate';

const fatigueEndpoint = '/api/agents/fatigue';
const riskEndpoint = '/api/agents/risk';
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
  `Coach Agent failed (${status}). Check API deployment.`;

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
  const raw = await postJson<unknown>(orchestrateEndpoint, payload, signal);

  if (
    raw &&
    typeof raw === 'object' &&
    'meta' in raw &&
    'errors' in raw &&
    'combinedDecision' in raw
  ) {
    return raw as OrchestrateResponse;
  }

  const rawRecord = (raw && typeof raw === 'object') ? (raw as Record<string, unknown>) : {};
  const rawMode = rawRecord.mode;
  const mode: 'auto' | 'full' = rawMode === 'full' ? 'full' : 'auto';
  const message = typeof rawRecord.message === 'string'
    ? rawRecord.message
    : 'Orchestrator fallback response received.';

  return {
    combinedDecision: {
      immediateAction: 'Continue with monitored plan',
      suggestedAdjustments: [message],
      confidence: 0.55,
      rationale: 'Normalized from simplified orchestrator payload.',
    },
    errors: [],
    meta: {
      requestId: `normalized-${Date.now()}`,
      mode,
      executedAgents: [],
      modelRouting: {
        fatigueModel: 'fallback',
        riskModel: 'fallback',
        tacticalModel: 'fallback',
        fallbacksUsed: ['normalized-simple-orchestrate-response'],
      },
      usedFallbackAgents: [],
      timingsMs: {
        total: 1,
      },
    },
  };
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
