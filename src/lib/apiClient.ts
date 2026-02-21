import { FatigueAgentResponse, OrchestrateResponse, RiskAgentResponse } from '../types/agents';

export type ApiClientErrorKind = 'network' | 'timeout' | 'cors' | 'http' | 'parse';
export type AgentFrameworkMode = 'route' | 'all';

const trimTrailingSlashes = (value: string): string => value.replace(/\/+$/, '');
const ensureLeadingSlash = (value: string): string => (value.startsWith('/') ? value : `/${value}`);

const rawApiBaseUrl = String(import.meta.env.VITE_API_BASE_URL || '').trim();
export const apiBaseUrl = rawApiBaseUrl ? trimTrailingSlashes(rawApiBaseUrl) : '';
const rawAgentFrameworkBase = String(import.meta.env.VITE_AGENT_FRAMEWORK_BASE_URL || '').trim();
const agentFrameworkBaseUrl = rawAgentFrameworkBase ? trimTrailingSlashes(rawAgentFrameworkBase) : '';

const resolveApiUrl = (path: string): string => {
  const normalizedPath = ensureLeadingSlash(path);
  if (!apiBaseUrl) return normalizedPath;

  try {
    return new URL(normalizedPath, apiBaseUrl).toString();
  } catch {
    return `${trimTrailingSlashes(apiBaseUrl)}${normalizedPath}`;
  }
};

const resolveAgentFrameworkUrl = (path: string): string => {
  const normalizedPath = ensureLeadingSlash(path);
  if (!agentFrameworkBaseUrl) return normalizedPath;

  try {
    return new URL(normalizedPath, agentFrameworkBaseUrl).toString();
  } catch {
    return `${trimTrailingSlashes(agentFrameworkBaseUrl)}${normalizedPath}`;
  }
};

export const apiHealthPath = '/api/health';
export const apiOrchestratePath = '/api/orchestrate';
export const apiMessagesPath = '/api/messages';
export const apiHealthUrl = resolveApiUrl(apiHealthPath);
export const apiOrchestrateUrl = resolveApiUrl(apiOrchestratePath);
export const apiAgentFrameworkMessagesUrl = resolveAgentFrameworkUrl(apiMessagesPath);

const fatigueEndpoint = resolveApiUrl('/api/agents/fatigue');
const riskEndpoint = resolveApiUrl('/api/agents/risk');
const orchestrateEndpoint = apiOrchestrateUrl;

interface ApiClientErrorOptions {
  message: string;
  kind: ApiClientErrorKind;
  url: string;
  status?: number;
  body?: string;
}

export class ApiClientError extends Error {
  kind: ApiClientErrorKind;
  status?: number;
  url: string;
  body?: string;

  constructor({ message, kind, url, status, body }: ApiClientErrorOptions) {
    super(message);
    this.name = 'ApiClientError';
    this.kind = kind;
    this.url = url;
    this.status = status;
    this.body = body;
  }
}

const devWarn = (message: string, detail: Record<string, unknown>): void => {
  if (!import.meta.env.DEV) return;
  console.warn(message, detail);
};

const summarizeErrorText = (text: string): string => {
  const normalized = text.trim().replace(/\s+/g, ' ');
  return normalized.length > 180 ? `${normalized.slice(0, 180)}...` : normalized;
};

const looksLikeHtml = (text: string): boolean => {
  const trimmed = text.trim().toLowerCase();
  return trimmed.startsWith('<!doctype html') || trimmed.startsWith('<html');
};

const isLikelyCorsBlocked = (message: string, url: string): boolean => {
  if (!/failed to fetch|networkerror|load failed|fetch failed/i.test(message)) return false;
  if (!apiBaseUrl || typeof window === 'undefined') return false;

  try {
    const requestOrigin = new URL(url, window.location.origin).origin;
    return requestOrigin !== window.location.origin;
  } catch {
    return false;
  }
};

interface RequestTextOptions {
  timeoutMs?: number;
}

async function requestText(
  url: string,
  init: RequestInit,
  options: RequestTextOptions = {}
): Promise<{ status: number; text: string }> {
  const { timeoutMs } = options;
  const parentSignal = init.signal;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  let abortRelay: (() => void) | null = null;
  let signal = parentSignal;

  if (typeof timeoutMs === 'number' && timeoutMs > 0) {
    const controller = new AbortController();
    abortRelay = () => controller.abort();
    if (parentSignal?.aborted) {
      controller.abort();
    } else if (parentSignal) {
      parentSignal.addEventListener('abort', abortRelay, { once: true });
    }

    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    signal = controller.signal;
  }

  let response: Response;
  try {
    response = await fetch(url, { ...init, signal });
  } catch (error) {
    if (timeoutId) clearTimeout(timeoutId);
    if (parentSignal && abortRelay) {
      parentSignal.removeEventListener('abort', abortRelay);
    }

    if ((error as Error)?.name === 'AbortError') {
      if (timedOut) {
        devWarn('[API] Request timed out', { url, status: 'timeout', timeoutMs });
        throw new ApiClientError({
          message: 'Backend not reachable. Start the API or set VITE_API_BASE_URL.',
          kind: 'timeout',
          url,
        });
      }
      throw error;
    }

    const networkMessage = error instanceof Error ? error.message : String(error);
    const kind: ApiClientErrorKind = isLikelyCorsBlocked(networkMessage, url) ? 'cors' : 'network';
    devWarn('[API] Request failed', { url, status: kind, kind });
    throw new ApiClientError({
      message: kind === 'cors'
        ? 'Request blocked (CORS). Check API CORS settings or VITE_API_BASE_URL.'
        : 'Backend not reachable. Start the API or set VITE_API_BASE_URL.',
      kind,
      url,
      body: networkMessage,
    });
  }

  if (timeoutId) clearTimeout(timeoutId);
  if (parentSignal && abortRelay) {
    parentSignal.removeEventListener('abort', abortRelay);
  }

  const responseText = await response.text();
  if (!response.ok) {
    devWarn('[API] Non-2xx response', { url, status: response.status });
    const shortText = summarizeErrorText(responseText);
    throw new ApiClientError({
      message: shortText || `Request failed with status ${response.status}.`,
      kind: 'http',
      url,
      status: response.status,
      body: responseText,
    });
  }

  return { status: response.status, text: responseText };
}

function parseJsonResponse<TResponse>(
  text: string,
  url: string,
  status: number
): TResponse {
  if (looksLikeHtml(text)) {
    throw new ApiClientError({
      message: `API returned HTML instead of JSON at ${url}. Check API routing and SPA fallback.`,
      kind: 'parse',
      url,
      status,
      body: text,
    });
  }

  try {
    return JSON.parse(text) as TResponse;
  } catch (error) {
    devWarn('[API] Invalid JSON response', { url, status });
    throw new ApiClientError({
      message: 'Invalid JSON response from API.',
      kind: 'parse',
      url,
      status,
      body: text,
    });
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

function normalizeOrchestrateResponse(raw: unknown): OrchestrateResponse {
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

function parsePossibleJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function extractAgentFrameworkPayload(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const record = raw as Record<string, unknown>;

  if (Array.isArray(record.activities)) {
    for (const activity of record.activities) {
      if (!activity || typeof activity !== 'object') continue;
      const activityRecord = activity as Record<string, unknown>;
      if (activityRecord.value && typeof activityRecord.value === 'object') {
        return activityRecord.value;
      }
      if (typeof activityRecord.text === 'string') {
        const parsed = parsePossibleJson(activityRecord.text);
        if (parsed !== undefined) return parsed;
      }
    }
  }

  if (record.value && typeof record.value === 'object') {
    return record.value;
  }

  if (typeof record.text === 'string') {
    const parsed = parsePossibleJson(record.text);
    if (parsed !== undefined) return parsed;
  }

  return raw;
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
  return normalizeOrchestrateResponse(raw);
}

export async function postAgentFrameworkOrchestrate(
  payload: unknown,
  mode: AgentFrameworkMode = 'route',
  signal?: AbortSignal
): Promise<OrchestrateResponse> {
  const activity = {
    type: 'message',
    id: `web-${Date.now()}`,
    serviceUrl: 'http://localhost',
    channelId: 'webchat',
    from: { id: 'tactiq-web' },
    recipient: { id: 'coach-orchestrator-bot' },
    conversation: { id: `conversation-${Date.now()}` },
    deliveryMode: 'expectReplies',
    text: mode,
    value: {
      mode,
      payload,
    },
  };

  const raw = await postJson<unknown>(apiAgentFrameworkMessagesUrl, activity, signal);
  const payloadFromBot = extractAgentFrameworkPayload(raw);
  return normalizeOrchestrateResponse(payloadFromBot);
}

export async function checkHealth(
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  const { text } = await requestText(apiHealthUrl, {
    method: 'GET',
    signal,
  }, { timeoutMs: 6000 });

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

export const getApiHealth = checkHealth;
