import { FatigueAgentResponse, OrchestrateResponse, RiskAgentResponse, TacticalAgentResponse } from '../types/agents';
import { Baseline, PlayerBaseline } from '../types/baseline';
import { isDemoModeEnabled } from '../auth/swaAuth';
import { ensureDemoRosterSeeded, resetDemoRosterToDefaults } from './rosterStorage';

export type ApiClientErrorKind = 'network' | 'timeout' | 'cors' | 'http' | 'parse';
export type AgentFrameworkMode = 'route' | 'all';

const trimTrailingSlashes = (value: string): string => value.replace(/\/+$/, '');
const ensureLeadingSlash = (value: string): string => (value.startsWith('/') ? value : `/${value}`);
const ensureApiSuffix = (value: string): string => (/\/api$/i.test(value) ? value : `${value}/api`);
const isAbsoluteHttpUrl = (value: string): boolean => /^https?:\/\//i.test(value);
const API_BASE_LOGGED_KEY = '__TACTIQ_API_BASE_LOGGED__';

const envApiBaseRaw = String(import.meta.env.VITE_API_BASE_URL || '').trim();
const defaultApiBase = '/api';
const normalizedEnvBase = trimTrailingSlashes(envApiBaseRaw || defaultApiBase) || defaultApiBase;
const baseCandidate = isAbsoluteHttpUrl(normalizedEnvBase)
  ? normalizedEnvBase
  : ensureLeadingSlash(normalizedEnvBase);
export const API_BASE_URL = trimTrailingSlashes(
  ensureApiSuffix(baseCandidate)
);
export const BASE_URL = API_BASE_URL;
export const apiBaseUrl = API_BASE_URL;
const DEMO_HEADER_ALLOWED = String(import.meta.env.VITE_DEMO || '').trim().toLowerCase() === 'true';
if (typeof globalThis !== 'undefined' && !(globalThis as Record<string, unknown>)[API_BASE_LOGGED_KEY]) {
  (globalThis as Record<string, unknown>)[API_BASE_LOGGED_KEY] = true;
  console.info('[tactIQ] API_BASE_URL =', API_BASE_URL);
}

const normalizePathForBase = (path: string): string => {
  const normalizedPath = ensureLeadingSlash(path);
  if (normalizedPath === '/api') return '';
  if (normalizedPath.startsWith('/api/')) return normalizedPath.slice(4);
  return normalizedPath;
};
const resolveApiUrl = (path: string): string => `${API_BASE_URL}${normalizePathForBase(path)}`;
export const apiHealthPath = '/health';
export const apiLegacyHealthPath = '/health';
export const apiOrchestratePath = '/orchestrate';
export const apiLegacyOrchestratePath = '/orchestrate';
export const apiMessagesPath = '/messages';
export const apiHealthUrl = resolveApiUrl(apiHealthPath);
export const apiLegacyHealthUrl = resolveApiUrl(apiLegacyHealthPath);
export const apiOrchestrateUrl = resolveApiUrl(apiOrchestratePath);
export const apiLegacyOrchestrateUrl = resolveApiUrl(apiLegacyOrchestratePath);
export const apiAgentFrameworkMessagesUrl = resolveApiUrl(apiMessagesPath);

const fatigueEndpoint = resolveApiUrl('/agents/fatigue');
const riskEndpoint = resolveApiUrl('/agents/risk');
const tacticalEndpoint = resolveApiUrl('/agents/tactical');
const orchestrateEndpoint = apiOrchestrateUrl;
const aiStatusEndpoint = resolveApiUrl('/ai/status');
const baselinesEndpoint = resolveApiUrl('/baselines');
const usersEnsureEndpoint = resolveApiUrl('/users/ensure');
const copilotChatEndpoint = resolveApiUrl('/copilot-chat');
const analysisExistsEndpoint = (analysisId: string): string =>
  resolveApiUrl(`/analysis/${encodeURIComponent(String(analysisId || '').trim())}/exists`);

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
  if (!BASE_URL || typeof window === 'undefined') return false;

  try {
    const requestOrigin = new URL(url, window.location.origin).origin;
    return requestOrigin !== window.location.origin;
  } catch {
    return false;
  }
};

const isCrossOriginRequest = (url: string): boolean => {
  if (typeof window === 'undefined') return false;
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
): Promise<{ status: number; text: string; headers: Headers }> {
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
    const method = String(init.method || 'GET').trim().toUpperCase();
    const requestHeaders = new Headers(init.headers || {});
    if (!requestHeaders.has('Accept')) {
      requestHeaders.set('Accept', 'application/json');
    }
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
      requestHeaders.delete('Content-Type');
    }
    if (DEMO_HEADER_ALLOWED && isDemoModeEnabled()) {
      requestHeaders.set('x-tactiq-demo', 'true');
    }
    response = await fetch(url, { ...init, headers: requestHeaders, signal });
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
    const isTypeError = typeof TypeError !== 'undefined' && error instanceof TypeError;
    const isCorsLike = isLikelyCorsBlocked(networkMessage, url) || (isTypeError && isCrossOriginRequest(url));
    const kind: ApiClientErrorKind = isCorsLike ? 'cors' : 'network';
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

  let responseText = '';
  try {
    responseText = await response.text();
  } catch {
    responseText = '';
  }
  if (!response.ok) {
    devWarn('[API] Non-2xx response', { url, status: response.status });
    const snippet = summarizeErrorText(responseText);
    let message = snippet
      ? `HTTP ${response.status}: ${snippet}`
      : `HTTP ${response.status} ${response.statusText || ''}`.trim();
    if (response.status === 401) {
      message = 'Authentication required. Please sign in with Microsoft.';
    } else if (response.status === 403) {
      message = 'Access denied for this coach workspace.';
    }
    throw new ApiClientError({
      message,
      kind: 'http',
      url,
      status: response.status,
      body: responseText,
    });
  }

  return { status: response.status, text: responseText, headers: response.headers };
}

function parseJsonResponse<TResponse>(
  text: string,
  url: string,
  status: number,
  headers?: Headers
): TResponse {
  if (String(text || '').trim().length === 0) {
    throw new ApiClientError({
      message: `Expected JSON response (status ${status}) but received an empty body.`,
      kind: 'parse',
      url,
      status,
      body: text,
    });
  }
  const snippet = summarizeErrorText(text);
  const contentType = String(headers?.get('content-type') || '').toLowerCase();
  if (looksLikeHtml(text)) {
    throw new ApiClientError({
      message: `Expected JSON response (status ${status}) but received HTML${snippet ? `: ${snippet}` : '.'}`,
      kind: 'parse',
      url,
      status,
      body: text,
    });
  }

  try {
    return JSON.parse(text) as TResponse;
  } catch (_error) {
    devWarn('[API] Invalid JSON response', { url, status });
    throw new ApiClientError({
      message: contentType && !contentType.includes('application/json')
        ? `Expected JSON response (status ${status}) but received ${contentType || 'unknown'}${snippet ? `: ${snippet}` : '.'}`
        : `Invalid JSON response (status ${status})${snippet ? `: ${snippet}` : '.'}`,
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
  const { status, text, headers } = await requestText(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
  return parseJsonResponse<TResponse>(text, url, status, headers);
}

async function putJson<TResponse>(
  url: string,
  payload: unknown,
  signal?: AbortSignal
): Promise<TResponse> {
  const { status, text, headers } = await requestText(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
  return parseJsonResponse<TResponse>(text, url, status, headers);
}

async function deleteJson<TResponse>(
  url: string,
  signal?: AbortSignal
): Promise<TResponse> {
  const { status, text, headers } = await requestText(url, {
    method: 'DELETE',
    signal,
  });
  return parseJsonResponse<TResponse>(text, url, status, headers);
}

async function patchJson<TResponse>(
  url: string,
  payload: unknown,
  signal?: AbortSignal
): Promise<TResponse> {
  const { status, text, headers } = await requestText(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
  return parseJsonResponse<TResponse>(text, url, status, headers);
}

async function getJson<TResponse>(
  url: string,
  signal?: AbortSignal
): Promise<TResponse> {
  const { status, text, headers } = await requestText(url, {
    method: 'GET',
    signal,
  });
  return parseJsonResponse<TResponse>(text, url, status, headers);
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
  const coachOutputRecord =
    rawRecord.coachOutput && typeof rawRecord.coachOutput === 'object' && !Array.isArray(rawRecord.coachOutput)
      ? (rawRecord.coachOutput as Record<string, unknown>)
      : {};
  const message = typeof rawRecord.message === 'string'
    ? rawRecord.message
    : 'Orchestrator fallback response received.';
  const summary = typeof rawRecord.summary === 'string'
    ? rawRecord.summary
    : typeof coachOutputRecord.summary === 'string'
      ? coachOutputRecord.summary
      : typeof coachOutputRecord.explanation === 'string'
        ? coachOutputRecord.explanation
        : message;
  const tacticalRecommendation = typeof rawRecord.tacticalRecommendation === 'string'
    ? rawRecord.tacticalRecommendation
    : typeof coachOutputRecord.tacticalRecommendation === 'string'
      ? coachOutputRecord.tacticalRecommendation
      : typeof coachOutputRecord.recommendation === 'string'
        ? coachOutputRecord.recommendation
        : 'Continue with monitored plan';
  const confidenceCandidate = Number(
    rawRecord.confidence ??
    coachOutputRecord.confidence ??
    0.55
  );
  const confidence = Number.isFinite(confidenceCandidate)
    ? (confidenceCandidate > 1 && confidenceCandidate <= 100 ? confidenceCandidate / 100 : confidenceCandidate)
    : 0.55;
  const fallbackAgentOutputs: Record<string, unknown> = {};
  if (rawRecord.fatigue && typeof rawRecord.fatigue === 'object') fallbackAgentOutputs.fatigue = rawRecord.fatigue;
  if (rawRecord.risk && typeof rawRecord.risk === 'object') fallbackAgentOutputs.risk = rawRecord.risk;
  if (rawRecord.tactical && typeof rawRecord.tactical === 'object') fallbackAgentOutputs.tactical = rawRecord.tactical;

  return {
    analysisBundleId: `normalized-${Date.now()}`,
    summary,
    tacticalRecommendation,
    confidence: Math.max(0, Math.min(1, confidence)),
    combinedDecision: {
      immediateAction: tacticalRecommendation || 'Continue with monitored plan',
      suggestedAdjustments: [summary || message].filter(Boolean),
      confidence: Math.max(0, Math.min(1, confidence)),
      rationale: summary || 'Normalized from simplified orchestrator payload.',
    },
    errors: [],
    agentResults: {
      fatigue: { status: 'fallback', routedTo: 'rules', error: message, reason: 'normalized-simple-orchestrate-response' },
      risk: { status: 'fallback', routedTo: 'rules', error: message, reason: 'normalized-simple-orchestrate-response' },
      tactical: { status: 'fallback', routedTo: 'rules', error: message, reason: 'normalized-simple-orchestrate-response' },
    },
    agents: {
      fatigue: { status: 'FALLBACK' },
      risk: { status: 'FALLBACK' },
      tactical: { status: 'FALLBACK' },
    },
    agentOutputs: fallbackAgentOutputs,
    meta: {
      requestId: `normalized-${Date.now()}`,
      mode,
      executedAgents: ['fatigue', 'risk', 'tactical'],
      modelRouting: {
        fatigueModel: 'fallback',
        riskModel: 'fallback',
        tacticalModel: 'fallback',
        fallbacksUsed: ['normalized-simple-orchestrate-response'],
      },
      usedFallbackAgents: ['fatigue', 'risk', 'tactical'],
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const getHeaderProofValue = (
  headers: Headers
): { traceId?: string; source?: 'azure' | 'mock'; contextRosterCount?: number } => {
  const traceId = headers.get('x-trace-id') || undefined;
  const sourceHeader = headers.get('x-source');
  const rosterCountHeader = headers.get('x-context-roster-count');
  const parsedRosterCount = Number(rosterCountHeader);
  const contextRosterCount = Number.isFinite(parsedRosterCount) ? parsedRosterCount : undefined;
  const normalizedSource = sourceHeader === 'azure' || sourceHeader === 'mock' ? sourceHeader : undefined;
  return { traceId, source: normalizedSource, contextRosterCount };
};

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

export async function postTacticalAgent(
  payload: unknown,
  signal?: AbortSignal
): Promise<TacticalAgentResponse> {
  return postJson<TacticalAgentResponse>(tacticalEndpoint, payload, signal);
}

export async function postOrchestrate(
  payload: unknown,
  signal?: AbortSignal
): Promise<OrchestrateResponse> {
  const sendRequest = async (url: string) =>
    requestText(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal,
      },
      { timeoutMs: 15000 }
    );

  let requestUrl = orchestrateEndpoint;
  const response = await sendRequest(requestUrl).catch((error: unknown) => {
    if (error instanceof ApiClientError && error.status === 404 && orchestrateEndpoint !== apiLegacyOrchestrateUrl) {
      requestUrl = apiLegacyOrchestrateUrl;
      return sendRequest(requestUrl);
    }
    throw error;
  });

  const raw = parseJsonResponse<unknown>(response.text, requestUrl, response.status, response.headers);
  const normalized = normalizeOrchestrateResponse(raw);
  const headerProof = getHeaderProofValue(response.headers);
  const bodyProof = isRecord(normalized)
    ? {
        traceId: typeof normalized.traceId === 'string' ? normalized.traceId : undefined,
        source: normalized.source === 'azure' || normalized.source === 'mock' ? normalized.source : undefined,
      }
    : { traceId: undefined, source: undefined };
  const traceId = bodyProof.traceId || headerProof.traceId;
  const source = bodyProof.source || headerProof.source;
  const allowVerboseDevContextLog = String(import.meta.env.VITE_DEBUG_CONTEXT || '').trim().toLowerCase() === 'true';

  if (import.meta.env.DEV) {
    console.info('[orchestrate] proof', {
      url: requestUrl,
      traceId,
      source,
      headerTraceId: headerProof.traceId,
      headerSource: headerProof.source,
      contextRosterCount: headerProof.contextRosterCount,
    });
    if (allowVerboseDevContextLog) {
      console.info('[orchestrate] raw json', raw);
    }
  }

  return {
    ...normalized,
    ...(traceId ? { traceId } : {}),
    ...(source ? { source } : {}),
    responseHeaders: {
      traceId: headerProof.traceId,
      source: headerProof.source,
      contextRosterCount: headerProof.contextRosterCount,
    },
  };
}

export async function postFullCombinedAnalysis(
  payload: unknown,
  signal?: AbortSignal
): Promise<OrchestrateResponse> {
  const payloadRecord =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const fullPayload = {
    ...payloadRecord,
    mode: 'full',
  };
  return postOrchestrate(fullPayload, signal);
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

export interface CopilotChatHistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface CopilotChatRequest {
  analysisId?: string;
  message: string;
  history?: CopilotChatHistoryTurn[];
  matchContextSnapshot?: Record<string, unknown>;
  telemetry?: Record<string, unknown>;
  matchContext?: Record<string, unknown>;
  players?: Record<string, unknown>;
  coachOutput?: Record<string, unknown>;
  matchId?: string;
  sessionId?: string;
}

export interface CopilotChatResponse {
  ok?: boolean;
  reply: string;
  analysisIdUsed?: string;
  recovered?: boolean;
  messagesUsed?: number;
  suggestedQuestions?: string[];
  error?: string;
  message?: string;
  needsAnalysis?: boolean;
  retryAfterMs?: number;
}

export async function postCopilotChat(
  payload: CopilotChatRequest,
  signal?: AbortSignal
): Promise<CopilotChatResponse> {
  return postJson<CopilotChatResponse>(copilotChatEndpoint, payload, signal);
}

export interface AnalysisExistsResponse {
  ok?: boolean;
  exists?: boolean;
  analysisId?: string;
}

export interface CoachUserProfile {
  ok?: boolean;
  id?: string;
  userId: string;
  teamId: string;
  name?: string | null;
  email?: string | null;
  role?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export async function ensureCoachUserProfile(signal?: AbortSignal): Promise<CoachUserProfile> {
  if (isDemoModeEnabled()) {
    return {
      ok: true,
      id: 'demo-local',
      userId: 'demo-local',
      teamId: 'demo-local-team',
      name: 'Demo Coach',
      email: 'demo@local',
      role: 'coach',
    };
  }
  const raw = await postJson<unknown>(usersEnsureEndpoint, {}, signal);
  if (!raw || typeof raw !== 'object') {
    throw new ApiClientError({
      message: 'Invalid coach profile response.',
      kind: 'parse',
      url: usersEnsureEndpoint,
    });
  }
  const record = raw as Record<string, unknown>;
  const userId = String(record.userId || '').trim();
  const teamId = String(record.teamId || '').trim();
  if (!userId || !teamId) {
    throw new ApiClientError({
      message: 'Coach profile is missing user/team scope.',
      kind: 'parse',
      url: usersEnsureEndpoint,
    });
  }
  return {
    ok: typeof record.ok === 'boolean' ? record.ok : true,
    id: typeof record.id === 'string' ? record.id : undefined,
    userId,
    teamId,
    name: typeof record.name === 'string' ? record.name : null,
    email: typeof record.email === 'string' ? record.email : null,
    role: typeof record.role === 'string' ? record.role : null,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : null,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : null,
  };
}

export async function checkAnalysisExists(
  analysisId: string,
  signal?: AbortSignal
): Promise<boolean> {
  const normalizedId = String(analysisId || '').trim();
  if (!normalizedId) return false;
  const url = analysisExistsEndpoint(normalizedId);
  try {
    const { status, text, headers } = await requestText(
      url,
      {
        method: 'GET',
        signal,
      },
      { timeoutMs: 6000 }
    );
    const raw = parseJsonResponse<AnalysisExistsResponse>(text, url, status, headers);
    return Boolean(raw?.exists);
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 404) {
      return false;
    }
    throw error;
  }
}

export interface BaselinesResponse {
  baselines: Baseline[];
  source: 'cosmos' | 'fallback';
  warning?: string;
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
const toNumberOr = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const normalizeOrderIndex = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
};

const normalizeBaseline = (raw: unknown): Baseline | null => {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const id = String(item.id || item.playerId || '').trim();
  const roleRaw = String(item.role || '').trim().toUpperCase();
  if (!id) return null;
  const role = roleRaw === 'FAST' || roleRaw === 'SPIN' || roleRaw === 'BAT' || roleRaw === 'AR' ? roleRaw : 'FAST';

  const sleepHoursToday = Number(item.sleep ?? item.sleepHoursToday);
  const recoveryMinutes = Number(item.recovery ?? item.recoveryMinutes);
  const fatigueLimit = Number(item.fatigueLimit);
  const controlBaseline = Number(item.control ?? item.controlBaseline);
  const speed = Number(item.speed);
  const power = Number(item.power);
  const isActive = typeof item.active === 'boolean'
    ? item.active
    : typeof item.isActive === 'boolean'
      ? item.isActive
      : true;
  const inRoster = typeof item.inRoster === 'boolean'
    ? item.inRoster
    : typeof item.roster === 'boolean'
      ? item.roster
      : false;
  const name = String(item.name || id).trim() || id;

  return {
    id,
    playerId: id,
    name,
    role,
    isActive,
    sleepHoursToday: Number.isFinite(sleepHoursToday) ? clamp(sleepHoursToday, 0, 12) : 7,
    recoveryMinutes: Number.isFinite(recoveryMinutes) ? clamp(recoveryMinutes, 0, 240) : 45,
    fatigueLimit: Number.isFinite(fatigueLimit) ? clamp(fatigueLimit, 0, 10) : 6,
    controlBaseline: Number.isFinite(controlBaseline) ? clamp(controlBaseline, 0, 100) : 78,
    speed: Number.isFinite(speed) ? clamp(speed, 0, 100) : 7,
    power: Number.isFinite(power) ? clamp(power, 0, 100) : 6,
    sleep: Number.isFinite(sleepHoursToday) ? clamp(sleepHoursToday, 0, 12) : 7,
    recovery: Number.isFinite(recoveryMinutes) ? clamp(recoveryMinutes, 0, 240) : 45,
    control: Number.isFinite(controlBaseline) ? clamp(controlBaseline, 0, 100) : 78,
    active: isActive,
    inRoster,
    orderIndex: normalizeOrderIndex(item.orderIndex),
    createdAt: typeof item.createdAt === 'string' ? item.createdAt : undefined,
    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : undefined,
  };
};

const DEMO_BASELINES_STORAGE_KEY = 'tactiq_demo_baselines_v1';
const LEGACY_DEMO_BASELINES_STORAGE_KEY = 'tactiq:demoBaselines';
const DEMO_SEEDED_STORAGE_KEY = 'tactiq_demo_seeded_v1';
const DEFAULT_DEMO_BASELINES: Baseline[] = [
  {
    id: 'J. Archer',
    playerId: 'J. Archer',
    name: 'J. Archer',
    role: 'FAST',
    sleepHoursToday: 7.5,
    recoveryMinutes: 45,
    fatigueLimit: 6,
    controlBaseline: 80,
    speed: 9,
    power: 0,
    sleep: 7.5,
    recovery: 45,
    control: 80,
    active: true,
    isActive: true,
    inRoster: true,
    orderIndex: 1,
  },
  {
    id: 'R. Khan',
    playerId: 'R. Khan',
    name: 'R. Khan',
    role: 'SPIN',
    sleepHoursToday: 7.1,
    recoveryMinutes: 40,
    fatigueLimit: 6,
    controlBaseline: 86,
    speed: 8,
    power: 0,
    sleep: 7.1,
    recovery: 40,
    control: 86,
    active: true,
    isActive: true,
    inRoster: true,
    orderIndex: 2,
  },
  {
    id: 'M. Starc',
    playerId: 'M. Starc',
    name: 'M. Starc',
    role: 'FAST',
    sleepHoursToday: 6.8,
    recoveryMinutes: 50,
    fatigueLimit: 6,
    controlBaseline: 79,
    speed: 9,
    power: 0,
    sleep: 6.8,
    recovery: 50,
    control: 79,
    active: true,
    isActive: true,
    inRoster: true,
    orderIndex: 3,
  },
  {
    id: 'H. Ali',
    playerId: 'H. Ali',
    name: 'H. Ali',
    role: 'FAST',
    sleepHoursToday: 7.2,
    recoveryMinutes: 42,
    fatigueLimit: 6,
    controlBaseline: 77,
    speed: 8,
    power: 0,
    sleep: 7.2,
    recovery: 42,
    control: 77,
    active: true,
    isActive: true,
    inRoster: true,
    orderIndex: 4,
  },
  {
    id: 'S. Khan',
    playerId: 'S. Khan',
    name: 'S. Khan',
    role: 'SPIN',
    sleepHoursToday: 7.4,
    recoveryMinutes: 48,
    fatigueLimit: 6,
    controlBaseline: 84,
    speed: 7,
    power: 0,
    sleep: 7.4,
    recovery: 48,
    control: 84,
    active: true,
    isActive: true,
    inRoster: true,
    orderIndex: 5,
  },
  {
    id: 'B. Stokes',
    playerId: 'B. Stokes',
    name: 'B. Stokes',
    role: 'AR',
    sleepHoursToday: 7.0,
    recoveryMinutes: 50,
    fatigueLimit: 6,
    controlBaseline: 76,
    speed: 7,
    power: 8,
    sleep: 7.0,
    recovery: 50,
    control: 76,
    active: true,
    isActive: true,
    inRoster: true,
    orderIndex: 6,
  },
  {
    id: 'V. Kohli',
    playerId: 'V. Kohli',
    name: 'V. Kohli',
    role: 'BAT',
    sleepHoursToday: 7.8,
    recoveryMinutes: 55,
    fatigueLimit: 7,
    controlBaseline: 90,
    speed: 6,
    power: 8,
    sleep: 7.8,
    recovery: 55,
    control: 90,
    active: true,
    isActive: true,
    inRoster: true,
    orderIndex: 7,
  },
  {
    id: 'B. Azam',
    playerId: 'B. Azam',
    name: 'B. Azam',
    role: 'BAT',
    sleepHoursToday: 7.6,
    recoveryMinutes: 52,
    fatigueLimit: 7,
    controlBaseline: 89,
    speed: 6,
    power: 7,
    sleep: 7.6,
    recovery: 52,
    control: 89,
    active: true,
    isActive: true,
    inRoster: true,
    orderIndex: 8,
  },
  {
    id: 'K. Williamson',
    playerId: 'K. Williamson',
    name: 'K. Williamson',
    role: 'BAT',
    sleepHoursToday: 7.7,
    recoveryMinutes: 54,
    fatigueLimit: 7,
    controlBaseline: 88,
    speed: 6,
    power: 6,
    sleep: 7.7,
    recovery: 54,
    control: 88,
    active: true,
    isActive: true,
    inRoster: true,
    orderIndex: 9,
  },
  {
    id: 'G. Maxwell',
    playerId: 'G. Maxwell',
    name: 'G. Maxwell',
    role: 'AR',
    sleepHoursToday: 7.3,
    recoveryMinutes: 47,
    fatigueLimit: 6,
    controlBaseline: 74,
    speed: 6,
    power: 9,
    sleep: 7.3,
    recovery: 47,
    control: 74,
    active: true,
    isActive: true,
    inRoster: true,
    orderIndex: 10,
  },
];

const cloneDemoBaselines = (rows: Baseline[]): Baseline[] => rows.map((entry) => ({ ...entry }));

const readDemoBaselines = (): Baseline[] => {
  if (typeof window === 'undefined') return cloneDemoBaselines(DEFAULT_DEMO_BASELINES);
  try {
    const raw = window.localStorage.getItem(DEMO_BASELINES_STORAGE_KEY);
    const legacyRaw = raw ? null : window.localStorage.getItem(LEGACY_DEMO_BASELINES_STORAGE_KEY);
    const candidateRaw = raw || legacyRaw;
    const seededFlag = String(window.localStorage.getItem(DEMO_SEEDED_STORAGE_KEY) || '').trim().toLowerCase() === 'true';
    if (!candidateRaw) {
      const seeded = cloneDemoBaselines(DEFAULT_DEMO_BASELINES);
      writeDemoBaselines(seeded);
      window.localStorage.setItem(DEMO_SEEDED_STORAGE_KEY, 'true');
      return seeded;
    }
    const parsed = JSON.parse(candidateRaw);
    const rows = Array.isArray(parsed) ? parsed : [];
    const normalized = rows.map(normalizeBaseline).filter((entry): entry is Baseline => Boolean(entry));
    if (normalized.length > 0 && seededFlag) {
      if (legacyRaw) {
        writeDemoBaselines(normalized);
      }
      return normalized;
    }
    const seeded = cloneDemoBaselines(DEFAULT_DEMO_BASELINES);
    writeDemoBaselines(seeded);
    window.localStorage.setItem(DEMO_SEEDED_STORAGE_KEY, 'true');
    return seeded;
  } catch {
    const seeded = cloneDemoBaselines(DEFAULT_DEMO_BASELINES);
    writeDemoBaselines(seeded);
    try {
      window.localStorage.setItem(DEMO_SEEDED_STORAGE_KEY, 'true');
    } catch {
      // Ignore storage failures in restricted browser modes.
    }
    return seeded;
  }
};

const writeDemoBaselines = (rows: Baseline[]): void => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(DEMO_BASELINES_STORAGE_KEY, JSON.stringify(rows));
    window.localStorage.removeItem(LEGACY_DEMO_BASELINES_STORAGE_KEY);
  } catch {
    // Ignore storage failures in restricted browser modes.
  }
};

export const ensureDemoBaselinesSeeded = (): Baseline[] => {
  const rows = readDemoBaselines();
  ensureDemoRosterSeeded();
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(DEMO_SEEDED_STORAGE_KEY, 'true');
    } catch {
      // Ignore storage failures in restricted browser modes.
    }
  }
  return rows;
};

export async function getBaselinesWithMeta(signal?: AbortSignal): Promise<BaselinesResponse> {
  if (isDemoModeEnabled()) {
    const baselines = ensureDemoBaselinesSeeded();
    return { baselines, source: 'fallback', warning: 'Demo mode: local data only (no Cosmos writes).' };
  }
  const raw = await getJson<unknown>(baselinesEndpoint, signal);
  if (Array.isArray(raw)) {
    const baselines = raw.map(normalizeBaseline).filter((entry): entry is Baseline => Boolean(entry));
    return { baselines, source: 'cosmos' };
  }

  if (raw && typeof raw === 'object') {
    const record = raw as Record<string, unknown>;
    if (record.ok === false) {
      const message = typeof record.message === 'string' && record.message.trim().length > 0
        ? record.message
        : 'Failed to load baselines.';
      throw new ApiClientError({
        message,
        kind: 'http',
        url: baselinesEndpoint,
        status: 500,
        body: JSON.stringify(record),
      });
    }
    const rows = Array.isArray(record.players)
      ? record.players
      : Array.isArray(record.items)
        ? record.items
      : Array.isArray(record.baselines)
        ? record.baselines
        : [];
    const baselines = rows.map(normalizeBaseline).filter((entry): entry is Baseline => Boolean(entry));
    const source = record.source === 'cosmos' ? 'cosmos' : 'fallback';
    const warning = typeof record.warning === 'string' && record.warning.trim().length > 0 ? record.warning : undefined;
    return { baselines, source, warning };
  }
  return { baselines: [], source: 'fallback', warning: 'Unexpected baselines response shape.' };
}

export async function getBaselines(signal?: AbortSignal): Promise<Baseline[]> {
  const response = await getBaselinesWithMeta(signal);
  return response.baselines;
}

export async function getBaselineByPlayerId(playerId: string, signal?: AbortSignal): Promise<Baseline | null> {
  const normalizedId = String(playerId || '').trim();
  if (!normalizedId) return null;
  if (isDemoModeEnabled()) {
    return readDemoBaselines().find((row) => String(row.id || '').trim() === normalizedId) || null;
  }
  const id = encodeURIComponent(normalizedId);
  const url = `${baselinesEndpoint}/${id}`;
  const raw = await getJson<unknown>(url, signal);
  if (raw && typeof raw === 'object') {
    const record = raw as Record<string, unknown>;
    const candidate = normalizeBaseline(record.player ?? record.baseline ?? record);
    if (candidate) return candidate;
  }
  return null;
}

export async function saveBaselines(baselines: Baseline[], signal?: AbortSignal): Promise<Baseline[]> {
  if (isDemoModeEnabled()) {
    const normalized = baselines.map(normalizeBaseline).filter((entry): entry is Baseline => Boolean(entry));
    writeDemoBaselines(normalized);
    return normalized;
  }
  const players: PlayerBaseline[] = baselines.map((row) => ({
    id: String(row.id || row.playerId || '').trim(),
    type: 'playerBaseline',
    role: row.role,
    sleep: clamp(toNumberOr(row.sleep ?? row.sleepHoursToday, 7), 0, 12),
    recovery: clamp(toNumberOr(row.recovery ?? row.recoveryMinutes, 45), 0, 240),
    fatigueLimit: clamp(toNumberOr(row.fatigueLimit, 6), 0, 10),
    control: clamp(toNumberOr(row.control ?? row.controlBaseline, 78), 0, 100),
    speed: clamp(toNumberOr(row.speed, 7), 0, 100),
    power: clamp(toNumberOr(row.power, 0), 0, 100),
    name: String(row.name || row.id || row.playerId || '').trim() || undefined,
    ...(normalizeOrderIndex(row.orderIndex) > 0 ? { orderIndex: normalizeOrderIndex(row.orderIndex) } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));

  const raw = await postJson<unknown>(baselinesEndpoint, { players }, signal);
  if (raw && typeof raw === 'object') {
    const record = raw as Record<string, unknown>;
    const rows = Array.isArray(record.players)
      ? record.players
      : Array.isArray(record.baselines)
        ? record.baselines
        : [];
    return rows.map(normalizeBaseline).filter((entry): entry is Baseline => Boolean(entry));
  }
  return [];
}

export async function deleteBaseline(playerId: string, signal?: AbortSignal): Promise<void> {
  if (isDemoModeEnabled()) {
    const normalizedId = String(playerId || '').trim();
    if (!normalizedId) return;
    const remaining = readDemoBaselines().filter((row) => String(row.id || '').trim() !== normalizedId);
    writeDemoBaselines(remaining);
    return;
  }
  const id = encodeURIComponent(String(playerId || '').trim());
  await deleteJson<{ ok: boolean }>(`${baselinesEndpoint}/${id}`, signal);
}

export async function updateBaselineActive(
  baselineId: string,
  active: boolean,
  signal?: AbortSignal
): Promise<Baseline | null> {
  return updateBaseline(baselineId, { active }, signal);
}

export async function updateBaseline(
  baselineId: string,
  patch: { active?: boolean; inRoster?: boolean },
  signal?: AbortSignal
): Promise<Baseline | null> {
  const normalizedId = String(baselineId || '').trim();
  if (!normalizedId) {
    throw new ApiClientError({
      message: 'Cannot update baseline: missing player id.',
      kind: 'http',
      url: `${baselinesEndpoint}/:id`,
      status: 400,
    });
  }
  if (isDemoModeEnabled()) {
    const rows = readDemoBaselines();
    const nextRows = rows.map((row) => {
      if (String(row.id || '').trim() !== normalizedId) return row;
      return {
        ...row,
        ...(typeof patch.active === 'boolean' ? { active: patch.active, isActive: patch.active } : {}),
        ...(typeof patch.inRoster === 'boolean' ? { inRoster: patch.inRoster } : {}),
        updatedAt: new Date().toISOString(),
      };
    });
    writeDemoBaselines(nextRows);
    return nextRows.find((row) => String(row.id || '').trim() === normalizedId) || null;
  }
  const id = encodeURIComponent(normalizedId);
  const payload: Record<string, unknown> = {};
  if (typeof patch.active === 'boolean') payload.active = patch.active;
  if (typeof patch.inRoster === 'boolean') payload.inRoster = patch.inRoster;
  payload.updatedAt = new Date().toISOString();
  const url = `${baselinesEndpoint}/${id}`;
  if (import.meta.env.DEV) {
    console.log('[api] PATCH baseline', { url, payload });
  }
  const { status, text, headers } = await requestText(
    url,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    }
  );
  if (import.meta.env.DEV) {
    console.log('[api] PATCH baseline status', { url, status });
    if (patch.inRoster === false) {
      console.log(`Removed from roster: ${normalizedId} status=${status}`);
    }
  }
  const raw = parseJsonResponse<unknown>(text, url, status, headers);
  if (raw && typeof raw === 'object') {
    const record = raw as Record<string, unknown>;
    const candidate = normalizeBaseline(record.player ?? record.baseline ?? record);
    if (candidate) return candidate;
  }
  return null;
}

export async function resetBaselines(signal?: AbortSignal): Promise<void> {
  if (isDemoModeEnabled()) {
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.removeItem(DEMO_BASELINES_STORAGE_KEY);
        window.localStorage.removeItem(LEGACY_DEMO_BASELINES_STORAGE_KEY);
        window.localStorage.removeItem(DEMO_SEEDED_STORAGE_KEY);
      } catch {
        // Ignore storage failures in restricted browser modes.
      }
    }
    writeDemoBaselines(cloneDemoBaselines(DEFAULT_DEMO_BASELINES));
    resetDemoRosterToDefaults();
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(DEMO_SEEDED_STORAGE_KEY, 'true');
      } catch {
        // Ignore storage failures in restricted browser modes.
      }
    }
    return;
  }
  await postJson<{ ok: boolean; deleted: number }>(`${baselinesEndpoint}/reset`, {}, signal);
}

export async function checkHealth(
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  const request = async (url: string) =>
    requestText(
      url,
      {
        method: 'GET',
        signal,
      },
      { timeoutMs: 6000 }
    );

  let response: { status: number; text: string; headers: Headers };
  try {
    response = await request(apiHealthUrl);
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 404 && apiHealthUrl !== apiLegacyHealthUrl) {
      response = await request(apiLegacyHealthUrl);
    } else {
      throw error;
    }
  }

  const parsed = parseJsonResponse<unknown>(response.text, apiHealthUrl, response.status, response.headers);
  if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
  return { ok: true };
}

export const getApiHealth = checkHealth;

export interface AiStatusResponse {
  ok?: boolean;
  azureOpenAIConfigured: boolean;
  missing?: string[];
}

export async function getAiStatus(signal?: AbortSignal): Promise<AiStatusResponse> {
  const raw = await getJson<unknown>(aiStatusEndpoint, signal);
  if (!raw || typeof raw !== 'object') {
    return { ok: false, azureOpenAIConfigured: false };
  }
  const record = raw as Record<string, unknown>;
  const missing = Array.isArray(record.missing)
    ? record.missing.map((entry) => String(entry || '').trim()).filter(Boolean)
    : undefined;
  return {
    ok: typeof record.ok === 'boolean' ? record.ok : true,
    azureOpenAIConfigured: Boolean(record.azureOpenAIConfigured),
    ...(missing && missing.length > 0 ? { missing } : {}),
  };
}
