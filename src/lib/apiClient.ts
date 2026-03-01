import { FatigueAgentResponse, OrchestrateResponse, RiskAgentResponse, TacticalAgentResponse } from '../types/agents';
import { Baseline, PlayerBaseline } from '../types/baseline';

export type ApiClientErrorKind = 'network' | 'timeout' | 'cors' | 'http' | 'parse';
export type AgentFrameworkMode = 'route' | 'all';

const trimTrailingSlashes = (value: string): string => value.replace(/\/+$/, '');
const ensureLeadingSlash = (value: string): string => (value.startsWith('/') ? value : `/${value}`);

const BASE = (String(import.meta.env.VITE_API_BASE_URL || '/api').trim() || '/api').replace(/\/+$/, '');
export const BASE_URL = BASE || '/api';
export const apiBaseUrl = BASE_URL;
const baseEndsWithApi = /\/api$/i.test(BASE_URL);

const joinUrl = (base: string, path: string): string => {
  const normalizedBase = trimTrailingSlashes(String(base || '').trim());
  const normalizedPath = ensureLeadingSlash(path);
  if (!normalizedBase) return normalizedPath;

  if (!/^https?:\/\//i.test(normalizedBase)) {
    const relativeBase = ensureLeadingSlash(normalizedBase);
    if (normalizedPath === relativeBase || normalizedPath.startsWith(`${relativeBase}/`)) {
      return normalizedPath;
    }
    if (relativeBase === '/api' && normalizedPath.startsWith('/api/')) {
      return normalizedPath;
    }
    return `${relativeBase}${normalizedPath}`;
  }

  return `${normalizedBase}${normalizedPath}`;
};
const normalizePathForBase = (path: string): string => {
  const normalizedPath = ensureLeadingSlash(path);
  if (baseEndsWithApi && normalizedPath === '/api') return '/';
  if (baseEndsWithApi && normalizedPath.startsWith('/api/')) return normalizedPath.slice(4);
  return normalizedPath;
};
const resolveApiUrl = (path: string): string => joinUrl(BASE_URL, normalizePathForBase(path));
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
const baselinesEndpoint = resolveApiUrl('/baselines');

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
    throw new ApiClientError({
      message: snippet
        ? `HTTP ${response.status}: ${snippet}`
        : `HTTP ${response.status} ${response.statusText || ''}`.trim(),
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
  const snippet = summarizeErrorText(text);
  const contentType = String(headers?.get('content-type') || '').toLowerCase();
  if (contentType && !contentType.includes('application/json')) {
    throw new ApiClientError({
      message: `Expected JSON response (status ${status}) but received ${contentType || 'unknown'}${snippet ? `: ${snippet}` : '.'}`,
      kind: 'parse',
      url,
      status,
      body: text,
    });
  }

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
  } catch (error) {
    devWarn('[API] Invalid JSON response', { url, status });
    throw new ApiClientError({
      message: `Invalid JSON response (status ${status})${snippet ? `: ${snippet}` : '.'}`,
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
    agentResults: {
      fatigue: { status: 'error', routedTo: 'rules', error: message, reason: 'normalized-simple-orchestrate-response' },
      risk: { status: 'error', routedTo: 'rules', error: message, reason: 'normalized-simple-orchestrate-response' },
      tactical: { status: 'error', routedTo: 'rules', error: message, reason: 'normalized-simple-orchestrate-response' },
    },
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

export async function getBaselinesWithMeta(signal?: AbortSignal): Promise<BaselinesResponse> {
  const raw = await getJson<unknown>(baselinesEndpoint, signal);
  if (Array.isArray(raw)) {
    const baselines = raw.map(normalizeBaseline).filter((entry): entry is Baseline => Boolean(entry));
    return { baselines, source: 'cosmos' };
  }

  if (raw && typeof raw === 'object') {
    const record = raw as Record<string, unknown>;
    const rows = Array.isArray(record.players)
      ? record.players
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
  await postJson<{ ok: boolean; deleted: number }>(`${baselinesEndpoint}/reset`, {}, signal);
}

export async function checkHealth(
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  const request = async (url: string) => requestText(
    url,
    {
      method: 'GET',
      signal,
    },
    { timeoutMs: 6000 }
  );

  let text: string;
  try {
    ({ text } = await request(apiHealthUrl));
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 404 && apiHealthUrl !== apiLegacyHealthUrl) {
      ({ text } = await request(apiLegacyHealthUrl));
    } else {
      throw error;
    }
  }

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
