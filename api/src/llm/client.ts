import { callAzureChat, getAzureErrorStatus, safeJsonParse } from './azureOpenAI';
import { getModelRegistry } from './modelRegistry';

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CallLLMInput {
  deployment: string;
  messages: LLMMessage[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: { type: 'json_object' };
  timeoutMs?: number;
}

export class LLMRequestError extends Error {
  status?: number;
  bodySnippet?: string;

  constructor(message: string, status?: number, bodySnippet?: string) {
    super(message);
    this.name = 'LLMRequestError';
    this.status = status;
    this.bodySnippet = bodySnippet;
  }
}

export class LLMJsonResponseError extends Error {
  phase: 'parse' | 'schema';
  rawSnippet?: string;
  deployment?: string;

  constructor(message: string, options: { phase: 'parse' | 'schema'; rawSnippet?: string; deployment?: string }) {
    super(message);
    this.name = 'LLMJsonResponseError';
    this.phase = options.phase;
    this.rawSnippet = options.rawSnippet;
    this.deployment = options.deployment;
  }
}

export async function callLLM(input: CallLLMInput): Promise<string> {
  const registry = getModelRegistry();
  if (!registry.enabled) {
    throw new Error('Azure OpenAI not configured');
  }
  if (!input.deployment) {
    throw new Error('No deployment selected');
  }

  try {
    return await callAzureChat({
      deployment: input.deployment,
      messages: input.messages,
      temperature: input.temperature ?? 0.2,
      max_tokens: input.maxTokens ?? 200,
      ...(input.responseFormat ? { response_format: input.responseFormat } : {}),
      timeoutMs: input.timeoutMs,
    });
  } catch (error) {
    const status = getAzureErrorStatus(error);
    const message = error instanceof Error ? error.message : 'Unknown Azure OpenAI error';
    const bodyCandidate =
      (typeof (error as { response?: { data?: unknown } })?.response?.data === 'string'
        ? (error as { response?: { data?: unknown } }).response?.data
        : undefined) ||
      (typeof (error as { body?: unknown })?.body === 'string' ? (error as { body?: unknown }).body : undefined) ||
      (typeof (error as { error?: { message?: unknown } })?.error?.message === 'string'
        ? (error as { error?: { message?: unknown } }).error?.message
        : undefined);
    const bodySnippet =
      typeof bodyCandidate === 'string'
        ? bodyCandidate.replace(/\s+/g, ' ').trim().slice(0, 200)
        : undefined;
    if (typeof status === 'number') {
      throw new LLMRequestError(`LLM request failed (${status}): ${message}`, status, bodySnippet);
    }
    throw new LLMRequestError(`LLM request failed: ${message}`, undefined, bodySnippet);
  }
}

export interface JsonRetryInput<T> {
  deployment: string;
  fallbackDeployment: string;
  baseMessages: LLMMessage[];
  strictSystemMessage: string;
  validate: (value: unknown) => value is T;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  retryOnTransient?: boolean;
}

export interface JsonRetryResult<T> {
  parsed: T;
  fallbacksUsed: string[];
  deploymentUsed: string;
}

const extractStatusFromMessage = (message: string): number | undefined => {
  const match = message.match(/\((\d{3})\)/);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const isTransientStatus = (status: number | undefined): boolean =>
  status === 429 || (typeof status === 'number' && status >= 500 && status < 600);

export async function callLLMJsonWithRetry<T>(input: JsonRetryInput<T>): Promise<JsonRetryResult<T>> {
  const jsonOnlyInstruction = 'Return ONLY valid JSON. No markdown. No explanation.';
  const strictMessages: LLMMessage[] = [
    { role: 'system', content: `${jsonOnlyInstruction} ${input.strictSystemMessage}`.trim() },
    ...input.baseMessages,
  ];

  const runOnce = async (deployment: string): Promise<T> => {
    const execute = async (): Promise<T> => {
      const text = await callLLM({
        deployment,
        messages: strictMessages,
        temperature: input.temperature,
        maxTokens: input.maxTokens,
        responseFormat: { type: 'json_object' },
        timeoutMs: input.timeoutMs ?? 10000,
      });
      const parsedResult = safeJsonParse(text);
      if (!parsedResult.ok) {
        throw new LLMJsonResponseError(`Invalid JSON from LLM: ${parsedResult.error || 'parse-failed'}`, {
          phase: 'parse',
          rawSnippet: String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200),
          deployment,
        });
      }
      const parsed = parsedResult.data;
      if (!input.validate(parsed)) {
        throw new LLMJsonResponseError('LLM JSON failed schema validation', {
          phase: 'schema',
          rawSnippet: String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200),
          deployment,
        });
      }
      return parsed;
    };

    try {
      return await execute();
    } catch (error) {
      if (input.retryOnTransient === false) throw error;
      const status =
        error instanceof LLMRequestError
          ? error.status
          : error instanceof Error
            ? extractStatusFromMessage(error.message)
            : undefined;
      if (!isTransientStatus(status)) throw error;
      return execute();
    }
  };

  try {
    const parsed = await runOnce(input.deployment);
    return {
      parsed,
      fallbacksUsed: [],
      deploymentUsed: input.deployment,
    };
  } catch (primaryError) {
    if (!input.fallbackDeployment || input.fallbackDeployment === input.deployment) {
      throw primaryError;
    }

    try {
      const parsed = await runOnce(input.fallbackDeployment);
      return {
        parsed,
        fallbacksUsed: [`${input.fallbackDeployment}:fallback`],
        deploymentUsed: input.fallbackDeployment,
      };
    } catch (fallbackError) {
      if (fallbackError instanceof Error) throw fallbackError;
      throw new Error(String(fallbackError) || 'LLM JSON call failed');
    }
  }
}
