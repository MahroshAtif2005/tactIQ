import { AzureOpenAIError, chatComplete } from '../lib/azureOpenAI';

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

const extractJsonCodeFenceBlock = (raw: string): string | null => {
  const text = String(raw || '');
  const fencedMatch = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```\s*([\s\S]*?)```/i);
  if (!fencedMatch || typeof fencedMatch[1] !== 'string') return null;
  const candidate = fencedMatch[1].trim();
  return candidate.length > 0 ? candidate : null;
};

const extractFirstJsonObject = (raw: string): string | null => {
  const text = String(raw || '');
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }
  return null;
};

export const safeJsonParse = <T = unknown>(raw: string): SafeJsonParseResult<T> => {
  const normalized = stripCodeFence(String(raw || ''));
  try {
    const parsed = JSON.parse(normalized) as T;
    return { ok: true, data: parsed, raw: normalized };
  } catch (error) {
    const fenced = extractJsonCodeFenceBlock(String(raw || ''));
    if (fenced) {
      try {
        const parsed = JSON.parse(fenced) as T;
        return { ok: true, data: parsed, raw: fenced };
      } catch {
        // continue
      }
    }
    const extracted = extractFirstJsonObject(normalized);
    if (extracted) {
      try {
        const parsed = JSON.parse(extracted) as T;
        return { ok: true, data: parsed, raw: extracted };
      } catch {
        // continue
      }
    }
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
  response_format?: { type: 'json_object' };
  timeoutMs?: number;
}

export async function callAzureChat(options: AzureChatOptions): Promise<string> {
  const maxTokens = options.response_format?.type === 'json_object'
    ? Math.min(800, Math.max(320, options.max_tokens ?? 400))
    : Math.min(240, Math.max(1, options.max_tokens ?? 200));

  const completion = await chatComplete(options.messages, {
    deployment: options.deployment,
    temperature: options.temperature ?? 0.2,
    max_tokens: maxTokens,
    response_format: options.response_format,
    timeoutMs: options.timeoutMs,
  });

  const choices = Array.isArray(completion.choices) ? completion.choices : [];
  const firstChoice = choices[0] as Record<string, unknown> | undefined;
  const message = firstChoice && typeof firstChoice === 'object'
    ? (firstChoice.message as Record<string, unknown> | undefined)
    : undefined;
  const content = message?.content;

  if (typeof content === 'string' && content.trim().length > 0) {
    return content;
  }

  if (Array.isArray(content)) {
    const joined = content
      .map((entry) => {
        if (typeof entry === 'string') return entry;
        if (entry && typeof entry === 'object' && 'text' in entry) {
          return String((entry as { text?: unknown }).text || '');
        }
        return '';
      })
      .join(' ')
      .trim();
    if (joined) return joined;
  }

  if (content && typeof content === 'object') {
    return JSON.stringify(content);
  }

  throw new AzureOpenAIError('Azure OpenAI response missing content');
}

export const getAzureErrorStatus = (error: unknown): number | undefined => {
  if (error instanceof AzureOpenAIError) return error.status;
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as { status?: unknown; code?: unknown };
  if (typeof candidate.status === 'number') return candidate.status;
  if (typeof candidate.code === 'number') return candidate.code;
  return undefined;
};

export const isFallbackStatus = (status?: number): boolean =>
  status === 401 || status === 403 || status === 429 || (typeof status === 'number' && status >= 500);
