import { FatigueAgentResponse, OrchestrateResponse, RiskAgentResponse } from '../types/agents';
import { Baseline, PlayerBaseline } from '../types/baseline';

export type ApiClientErrorKind = 'network' | 'timeout' | 'cors' | 'http' | 'parse';
export type AgentFrameworkMode = 'route' | 'all';

const trimTrailingSlashes = (value: string): string => value.replace(/\/+$/, '');
const ensureLeadingSlash = (value: string): string => (value.startsWith('/') ? value : `/${value}`);

const rawBaseUrl = String(import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? '/api' : '')).trim();
export const BASE_URL = trimTrailingSlashes(rawBaseUrl);
export const apiBaseUrl = BASE_URL;

const resolveApiUrl = (path: string): string => {
  const normalizedPath = ensureLeadingSlash(path);
  if (!BASE_URL) return normalizedPath;

  if (!/^https?:\/\//i.test(BASE_URL)) {
    const relativeBase = ensureLeadingSlash(BASE_URL);
    if (normalizedPath === relativeBase || normalizedPath.startsWith(`${relativeBase}/`)) {
      return normalizedPath;
    }
    if (relativeBase === '/api' && normalizedPath.startsWith('/api/')) {
      return normalizedPath;
    }
    return `${relativeBase}${normalizedPath}`;
  }

  try {
    return new URL(normalizedPath, BASE_URL).toString();
  } catch {
    return `${BASE_URL}${normalizedPath}`;
  }
};
export const apiHealthPath = '/health';
export const apiLegacyHealthPath = '/api/health';
export const apiOrchestratePath = '/api/orchestrate';
export const apiMessagesPath = '/api/messages';
export const apiHealthUrl = resolveApiUrl(apiHealthPath);
export const apiLegacyHealthUrl = resolveApiUrl(apiLegacyHealthPath);
export const apiOrchestrateUrl = resolveApiUrl(apiOrchestratePath);
export const apiAgentFrameworkMessagesUrl = resolveApiUrl(apiMessagesPath);

const fatigueEndpoint = resolveApiUrl('/api/agents/fatigue');
const riskEndpoint = resolveApiUrl('/api/agents/risk');
const orchestrateEndpoint = apiOrchestrateUrl;
const baselinesEndpoint = resolveApiUrl('/api/baselines');

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

async function putJson<TResponse>(
  url: string,
  payload: unknown,
  signal?: AbortSignal
): Promise<TResponse> {
  const { status, text } = await requestText(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
  return parseJsonResponse<TResponse>(text, url, status);
}

async function deleteJson<TResponse>(
  url: string,
  signal?: AbortSignal
): Promise<TResponse> {
  const { status, text } = await requestText(url, {
    method: 'DELETE',
    signal,
  });
  return parseJsonResponse<TResponse>(text, url, status);
}

async function patchJson<TResponse>(
  url: string,
  payload: unknown,
  signal?: AbortSignal
): Promise<TResponse> {
  const { status, text } = await requestText(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
  return parseJsonResponse<TResponse>(text, url, status);
}

async function getJson<TResponse>(
  url: string,
  signal?: AbortSignal
): Promise<TResponse> {
  const { status, text } = await requestText(url, {
    method: 'GET',
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
  const isActive = typeof item.active === 'boolean' ? item.active : Boolean(item.isActive);
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

export async function saveBaselines(baselines: Baseline[], signal?: AbortSignal): Promise<Baseline[]> {
  const players: PlayerBaseline[] = baselines.map((row) => ({
    id: String(row.id || row.playerId || '').trim(),
    role: row.role,
    sleep: clamp(toNumberOr(row.sleep ?? row.sleepHoursToday, 7), 0, 12),
    recovery: clamp(toNumberOr(row.recovery ?? row.recoveryMinutes, 45), 0, 240),
    fatigueLimit: clamp(toNumberOr(row.fatigueLimit, 6), 0, 10),
    control: clamp(toNumberOr(row.control ?? row.controlBaseline, 78), 0, 100),
    speed: clamp(toNumberOr(row.speed, 7), 0, 100),
    power: clamp(toNumberOr(row.power, 0), 0, 100),
    active: typeof row.active === 'boolean' ? row.active : Boolean(row.isActive),
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
  const id = encodeURIComponent(String(baselineId || '').trim());
  const raw = await patchJson<unknown>(`${baselinesEndpoint}/${id}`, { active }, signal);
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
