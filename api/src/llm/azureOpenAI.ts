import { getModelRegistry } from './modelRegistry';
// Use runtime require so TypeScript build can proceed before dependencies are installed.
let OpenAI: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  OpenAI = require('openai').default;
} catch {
  OpenAI = null;
}

export interface SafeJsonParseResult<T = unknown> {
  ok: boolean;
  data?: T;
  raw: string;
  error?: string;
}

const stripCodeFence = (raw: string): string => {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  return trimmed.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
};

export const safeJsonParse = <T = unknown>(raw: string): SafeJsonParseResult<T> => {
  const normalized = stripCodeFence(String(raw || ''));
  try {
    const parsed = JSON.parse(normalized) as T;
    return { ok: true, data: parsed, raw: normalized };
  } catch (error) {
    return {
      ok: false,
      raw: normalized,
      error: error instanceof Error ? error.message : 'Invalid JSON',
    };
  }
};

const normalizeEndpoint = (endpoint: string): string => endpoint.replace(/\/+$/, '');

export const buildDeploymentBaseUrl = (endpoint: string, deployment: string): string =>
  `${normalizeEndpoint(endpoint)}/openai/deployments/${deployment}`;

export interface AzureChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AzureChatOptions {
  deployment: string;
  messages: AzureChatMessage[];
  temperature?: number;
  max_tokens?: number;
}

export function createAzureOpenAIClient(deployment: string): any {
  if (!OpenAI) {
    throw new Error('openai package is not installed');
  }
  const registry = getModelRegistry();
  return new OpenAI({
    apiKey: registry.apiKey || 'missing-api-key',
    baseURL: buildDeploymentBaseUrl(registry.endpoint, deployment),
    defaultQuery: { 'api-version': registry.apiVersion },
    defaultHeaders: {
      'api-key': registry.apiKey,
    },
  });
}

export async function callAzureChat(options: AzureChatOptions): Promise<string> {
  const client = createAzureOpenAIClient(options.deployment);
  const completion = await client.chat.completions.create({
    model: options.deployment,
    messages: options.messages,
    temperature: options.temperature ?? 0.2,
    max_tokens: Math.min(200, Math.max(1, options.max_tokens ?? 200)),
  });
  const content = completion?.choices?.[0]?.message?.content;
  if (!content || typeof content !== 'string') {
    throw new Error('Azure OpenAI response missing content');
  }
  return content;
}

export const getAzureErrorStatus = (error: unknown): number | undefined => {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as { status?: unknown; code?: unknown };
  if (typeof candidate.status === 'number') return candidate.status;
  if (typeof candidate.code === 'number') return candidate.code;
  return undefined;
};

export const isFallbackStatus = (status?: number): boolean =>
  status === 401 || status === 403 || status === 429 || (typeof status === 'number' && status >= 500);
