export type RequestedExecutionMode = 'auto' | 'ai' | 'demo';
export type ResponseRoutingMode = 'ai' | 'fallback' | 'demo';
export type DataMode = 'demo' | 'live';
export type LlmMode = 'ai' | 'rules';

const normalizeToken = (value: unknown): string => String(value || '').trim().toLowerCase();

export const resolveRequestedExecutionMode = (value: unknown): RequestedExecutionMode => {
  const token = normalizeToken(value);
  if (token === 'demo') return 'demo';
  if (token === 'ai') return 'ai';
  return 'auto';
};

export const resolveDataMode = (value: unknown): DataMode => {
  const token = normalizeToken(value);
  if (token === 'demo') return 'demo';
  return 'live';
};

export const resolveLlmMode = (value: unknown): LlmMode => {
  const token = normalizeToken(value);
  if (token === 'ai') return 'ai';
  return 'rules';
};

export const normalizeRoutingReason = (value: unknown): string => {
  const token = normalizeToken(value);
  if (!token) return '';
  if (token.includes('demo_mode_requested') || token === 'demo') return 'demo_mode_requested';
  if (
    token.includes('missing_aoai_config') ||
    (token.includes('missing') && token.includes('azure_openai')) ||
    (token.includes('missing') && token.includes('aoai'))
  ) {
    return 'missing_aoai_config';
  }
  if (
    token.includes('openai_http_') ||
    token.includes('llm-error') ||
    token.includes('openai_error') ||
    token.includes('upstream') ||
    token.includes('timeout') ||
    token.includes('deployment not found') ||
    token.includes('invalid subscription key') ||
    token.includes('orchestrate_exception') ||
    token.includes('agent_http_error')
  ) {
    return 'upstream_unavailable';
  }
  return token.replace(/[^a-z0-9_:-]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
};

export const dedupeRoutingReasons = (values: unknown[], fallbackReason?: string): string[] => {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const reason = normalizeRoutingReason(value);
    if (!reason || seen.has(reason)) continue;
    seen.add(reason);
    normalized.push(reason);
  }
  if (normalized.length === 0 && fallbackReason) {
    const fallback = normalizeRoutingReason(fallbackReason);
    if (fallback && !seen.has(fallback)) normalized.push(fallback);
  }
  return normalized;
};

export const toResponseMode = (routingMode: ResponseRoutingMode): 'live' | 'fallback' | 'demo' =>
  routingMode === 'ai' ? 'live' : routingMode;

export const extractAoaiStatusCode = (value: unknown): number | undefined => {
  const raw = String(value || '');
  const matches = [
    raw.match(/openai_http_(\d{3})/i),
    raw.match(/\((\d{3})\)/),
    raw.match(/status[:=\s]+(\d{3})/i),
  ];
  for (const match of matches) {
    if (!match) continue;
    const parsed = Number(match[1]);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
};

export const extractAoaiStatusFromValues = (values: unknown[]): number | undefined => {
  for (const value of values) {
    const status = extractAoaiStatusCode(value);
    if (typeof status === 'number') return status;
  }
  return undefined;
};
