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
}

export async function callLLM(input: CallLLMInput): Promise<string> {
  const registry = getModelRegistry();
  if (!registry.enabled) {
    throw new Error('Azure OpenAI not configured');
  }
  if (!input.deployment) {
    throw new Error('No deployment selected');
  }

  const url = `${registry.endpoint.replace(/\/$/, '')}/openai/deployments/${input.deployment}/chat/completions?api-version=${registry.apiVersion}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': registry.apiKey,
    },
    body: JSON.stringify({
      messages: input.messages,
      temperature: input.temperature ?? 0.2,
      max_tokens: input.maxTokens ?? 400,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LLM request failed (${response.status}): ${errorText.slice(0, 300)}`);
  }

  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('LLM response missing content');
  }
  return content;
}

const parseJsonContent = (raw: string): unknown => {
  const trimmed = raw.trim();
  if (trimmed.startsWith('```')) {
    const stripped = trimmed.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    return JSON.parse(stripped);
  }
  return JSON.parse(trimmed);
};

export interface JsonRetryInput<T> {
  deployment: string;
  fallbackDeployment: string;
  baseMessages: LLMMessage[];
  strictSystemMessage: string;
  validate: (value: unknown) => value is T;
  temperature?: number;
  maxTokens?: number;
}

export interface JsonRetryResult<T> {
  parsed: T;
  fallbacksUsed: string[];
  deploymentUsed: string;
}

export async function callLLMJsonWithRetry<T>(input: JsonRetryInput<T>): Promise<JsonRetryResult<T>> {
  const fallbacksUsed: string[] = [];
  const strictMessages: LLMMessage[] = [
    { role: 'system', content: input.strictSystemMessage },
    ...input.baseMessages,
  ];

  const attempts: Array<{ deployment: string; messages: LLMMessage[]; marker: string }> = [
    { deployment: input.deployment, messages: input.baseMessages, marker: `${input.deployment}:initial` },
    { deployment: input.deployment, messages: strictMessages, marker: `${input.deployment}:strict-retry` },
    { deployment: input.fallbackDeployment, messages: strictMessages, marker: `${input.fallbackDeployment}:fallback` },
  ];

  let lastError: unknown;
  for (let i = 0; i < attempts.length; i += 1) {
    const attempt = attempts[i];
    try {
      const text = await callLLM({
        deployment: attempt.deployment,
        messages: attempt.messages,
        temperature: input.temperature,
        maxTokens: input.maxTokens,
      });
      const parsed = parseJsonContent(text);
      if (!input.validate(parsed)) {
        throw new Error('LLM JSON failed schema validation');
      }
      if (i > 0) {
        fallbacksUsed.push(attempt.marker);
      }
      return {
        parsed,
        fallbacksUsed,
        deploymentUsed: attempt.deployment,
      };
    } catch (error) {
      lastError = error;
      if (i > 0) {
        fallbacksUsed.push(attempt.marker);
      }
    }
  }

  const message = lastError instanceof Error ? lastError.message : 'Unknown LLM error';
  throw new Error(`LLM JSON retries exhausted: ${message}`);
}
