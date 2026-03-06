import { loadAoaiEnv } from '../shared/env';

export interface AzureChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AzureChatCompletionOptions {
  temperature?: number;
  max_tokens?: number;
  deployment?: string;
  timeoutMs?: number;
  response_format?: { type: 'json_object' };
}

export class AzureOpenAIError extends Error {
  status?: number;
  bodySnippet?: string;

  constructor(message: string, status?: number, bodySnippet?: string) {
    super(message);
    this.name = 'AzureOpenAIError';
    this.status = status;
    this.bodySnippet = bodySnippet;
  }
}

const toBodySnippet = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, 240);
const shouldLogAoaiDebug = (): boolean => {
  const explicit = String(process.env.AOAI_DEBUG || '').trim().toLowerCase();
  if (explicit === 'true' || explicit === '1' || explicit === 'yes') return true;
  return String(process.env.NODE_ENV || '').trim().toLowerCase() !== 'production';
};

export const isAoaiConfigured = (): boolean => loadAoaiEnv().aiEnabled;

export const chatComplete = async (
  messages: AzureChatMessage[],
  opts: AzureChatCompletionOptions = {}
): Promise<Record<string, unknown>> => {
  const env = loadAoaiEnv();
  if (!env.aiEnabled) {
    throw new AzureOpenAIError(`Missing Azure OpenAI config: ${env.missing.join(', ') || 'unknown'}`);
  }

  const deployment = String(opts.deployment || env.deployment).trim();
  const url = `${env.endpoint}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(env.apiVersion)}`;
  if (shouldLogAoaiDebug()) {
    console.log('[aoai-debug] request', {
      endpointHost: env.endpointHost || '',
      apiVersion: env.apiVersion,
      deployment,
      requestUrl: url,
      authHeader: 'api-key',
    });
  }
  const timeoutMs = Number(opts.timeoutMs);
  const controller = Number.isFinite(timeoutMs) && timeoutMs > 0 ? new AbortController() : undefined;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  if (controller && Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': env.apiKey,
      },
      body: JSON.stringify({
        messages,
        temperature: opts.temperature ?? 0.2,
        max_tokens: opts.max_tokens ?? 512,
        ...(opts.response_format ? { response_format: opts.response_format } : {}),
      }),
      ...(controller ? { signal: controller.signal } : {}),
    });
  } catch (error) {
    if (controller?.signal.aborted) {
      throw new AzureOpenAIError(`Azure OpenAI request timed out after ${Math.round(timeoutMs)}ms`);
    }
    const message = error instanceof Error ? error.message : 'Azure OpenAI request failed';
    throw new AzureOpenAIError(message);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }

  const raw = await response.text();
  const snippet = toBodySnippet(raw);
  if (shouldLogAoaiDebug()) {
    console.log('[aoai-debug] response', {
      endpointHost: env.endpointHost || '',
      apiVersion: env.apiVersion,
      deployment,
      requestUrl: url,
      authHeader: 'api-key',
      status: response.status,
      ok: response.ok,
    });
  }

  if (!response.ok) {
    if (response.status === 404) {
      throw new AzureOpenAIError(
        'Deployment not found (check AZURE_OPENAI_DEPLOYMENT name in Azure).',
        response.status,
        snippet
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new AzureOpenAIError(
        'Invalid subscription key or wrong endpoint (check key + endpoint).',
        response.status,
        snippet
      );
    }
    throw new AzureOpenAIError(
      `Azure OpenAI chat completion failed (${response.status}).`,
      response.status,
      snippet
    );
  }

  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new AzureOpenAIError('Azure OpenAI returned non-JSON response.', response.status, snippet);
  }
};
