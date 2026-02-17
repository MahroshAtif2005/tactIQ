import { scoreFatigue } from './fatigueModel';
import { FatigueAgentRequest, FatigueAgentResponse, Severity } from './types';

const API_VERSION = process.env.AZURE_OPENAI_API_VERSION || '2024-06-01';
let hasLoggedMode = false;

const normalizeSeverity = (value: unknown): Severity => {
  const upper = String(value || '').toUpperCase();
  if (upper === 'HIGH') return 'HIGH';
  if (upper === 'MED' || upper === 'MEDIUM') return 'MED';
  return 'LOW';
};

const clampFatigue = (value: unknown): number => {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(10, n));
};

const buildEcho = (input: FatigueAgentRequest): FatigueAgentResponse['echo'] => ({
  playerId: input.playerId || undefined,
  fatigueIndex: clampFatigue(input.fatigueIndex),
  injuryRisk: normalizeSeverity(input.injuryRisk),
  noBallRisk: normalizeSeverity(input.noBallRisk),
  oversBowled: Math.max(0, Number(input.oversBowled) || 0),
  consecutiveOvers: Math.max(0, Number(input.consecutiveOvers) || 0),
  heartRateRecovery: input.heartRateRecovery || undefined,
});

export const analyzeFatigueRuleBased = (input: FatigueAgentRequest): FatigueAgentResponse => {
  const model = scoreFatigue(input);
  return {
    severity: model.severity,
    headline: model.headline,
    explanation: model.explanation,
    recommendation: model.recommendation,
    signals: model.signals,
    echo: buildEcho(input),
    suggestedTweaks: model.suggestedTweaks,
  };
};

const parseJsonResponse = (content: string): unknown => {
  const trimmed = content.trim();
  if (trimmed.startsWith('```')) {
    const stripped = trimmed.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    return JSON.parse(stripped);
  }
  return JSON.parse(trimmed);
};

const validateLLMShape = (candidate: any): candidate is {
  severity: string;
  headline: string;
  explanation: string;
  recommendation: string;
  signals: string[];
  suggestedTweaks?: { suggestedRestOvers?: number; suggestedSubRole?: string; notes?: string };
} => {
  return (
    candidate &&
    typeof candidate === 'object' &&
    typeof candidate.severity === 'string' &&
    typeof candidate.headline === 'string' &&
    typeof candidate.explanation === 'string' &&
    typeof candidate.recommendation === 'string' &&
    Array.isArray(candidate.signals) &&
    candidate.signals.every((s: unknown) => typeof s === 'string')
  );
};

const isTransientStatus = (status: number) => status === 429 || status >= 500;

export const analyzeFatigueLLM = async (input: FatigueAgentRequest): Promise<FatigueAgentResponse | null> => {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT || process.env.AZURE_OPENAI_MODEL;
  if (!endpoint || !apiKey || !deployment) return null;

  const url = `${endpoint.replace(/\/$/, '')}/openai/deployments/${deployment}/chat/completions?api-version=${API_VERSION}`;
  const systemPrompt =
    'You are a cricket tactical coach. Option B rules: telemetry is authoritative and must not be overridden. ' +
    'Return ONLY valid JSON (no markdown) with keys: severity, headline, explanation, recommendation, signals, echo, suggestedTweaks. ' +
    'echo must exactly match telemetry values and must not be changed.';
  const userPrompt = JSON.stringify({
    instruction: 'Analyze telemetry and return advisory output only.',
    telemetry: input,
  });

  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': apiKey,
        },
        body: JSON.stringify({
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.2,
          max_tokens: 250,
        }),
      });

      if (!response.ok) {
        if (isTransientStatus(response.status) && attempt === 0) continue;
        return null;
      }

      const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = data.choices?.[0]?.message?.content?.trim();
      if (!content) return null;
      const parsed = parseJsonResponse(content);
      if (!validateLLMShape(parsed)) return null;

      return {
        severity: normalizeSeverity(parsed.severity),
        headline: parsed.headline.trim() || 'Advisory Update',
        explanation: parsed.explanation.trim() || 'No explanation available.',
        recommendation: parsed.recommendation.trim() || 'No recommendation available.',
        signals: parsed.signals,
        echo: buildEcho(input),
        suggestedTweaks: parsed.suggestedTweaks,
      };
    } catch (error) {
      lastError = error;
      if (attempt === 0) continue;
    }
  }

  if (process.env.NODE_ENV !== 'production') {
    console.error('LLM analysis failed after retry; using fallback', lastError);
  }
  return null;
};

export async function analyzeFatigue(input: FatigueAgentRequest): Promise<{ output: FatigueAgentResponse; mode: 'llm' | 'rule' }> {
  const useLLM = Boolean(
    process.env.AZURE_OPENAI_API_KEY &&
      process.env.AZURE_OPENAI_ENDPOINT &&
      (process.env.AZURE_OPENAI_DEPLOYMENT || process.env.AZURE_OPENAI_MODEL)
  );

  if (!hasLoggedMode) {
    console.log(`LLM mode: ${useLLM ? 'ON' : 'OFF'}`);
    hasLoggedMode = true;
  }

  if (useLLM) {
    const llm = await analyzeFatigueLLM(input);
    if (llm) return { output: llm, mode: 'llm' };
    console.warn('LLM parse/fetch failed, falling back to rule-based output');
  } else {
    console.warn('LLM fallback in use due to missing Azure OpenAI env vars');
  }

  return { output: analyzeFatigueRuleBased(input), mode: 'rule' };
}
