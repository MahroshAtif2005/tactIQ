import { callLLMJsonWithRetry, LLMMessage } from '../llm/client';
import { getAoaiConfig } from '../llm/modelRegistry';
import { routeModel } from '../llm/router';
import { analyzeFatigueRuleBased } from '../shared/analysisProvider';
import { FatigueAgentRequest, FatigueAgentResponse } from '../shared/types';

export interface FatigueAgentRunResult {
  output: FatigueAgentResponse;
  model: string;
  fallbacksUsed: string[];
}

const normalizeSeverity = (value: unknown): 'LOW' | 'MED' | 'HIGH' => {
  const upper = String(value || '').toUpperCase();
  if (upper === 'HIGH') return 'HIGH';
  if (upper === 'MED' || upper === 'MEDIUM') return 'MED';
  return 'LOW';
};

const normalizeRiskEcho = (value: unknown): 'LOW' | 'MED' | 'HIGH' => {
  const upper = String(value || '').toUpperCase();
  if (upper === 'HIGH') return 'HIGH';
  if (upper === 'MED' || upper === 'MEDIUM') return 'MED';
  return 'LOW';
};

const buildEcho = (input: FatigueAgentRequest): FatigueAgentResponse['echo'] => ({
  playerId: String(input.playerId || 'UNKNOWN'),
  fatigueIndex: Math.max(0, Math.min(10, Number(input.fatigueIndex) || 0)),
  injuryRisk: normalizeRiskEcho(input.injuryRisk),
  noBallRisk: normalizeRiskEcho(input.noBallRisk),
  oversBowled: Math.max(0, Number(input.oversBowled) || 0),
  consecutiveOvers: Math.max(0, Number(input.consecutiveOvers) || 0),
  heartRateRecovery: String(input.heartRateRecovery || 'Moderate'),
});

type LLMFatigueOutput = {
  severity: string;
  headline: string;
  explanation: string;
  recommendation: string;
  signals: string[];
  suggestedTweaks?: {
    suggestedRestOvers?: number;
    suggestedSubRole?: string;
    notes?: string;
  };
};

const isLLMFatigueOutput = (value: unknown): value is LLMFatigueOutput => {
  const candidate = value as LLMFatigueOutput;
  return Boolean(
    candidate &&
      typeof candidate === 'object' &&
      typeof candidate.severity === 'string' &&
      typeof candidate.headline === 'string' &&
      typeof candidate.explanation === 'string' &&
      typeof candidate.recommendation === 'string' &&
      Array.isArray(candidate.signals) &&
      candidate.signals.every((signal) => typeof signal === 'string')
  );
};

export function buildFatigueFallback(input: FatigueAgentRequest, reason: string): FatigueAgentRunResult {
  const fallback = analyzeFatigueRuleBased(input);
  return {
    output: {
      ...fallback,
      status: 'fallback',
      echo: buildEcho(input),
    },
    model: 'rule:fallback',
    fallbacksUsed: [reason],
  };
}

export async function runFatigueAgent(input: FatigueAgentRequest): Promise<FatigueAgentRunResult> {
  const routing = routeModel({ task: 'fatigue', needsJson: true, complexity: 'low' });
  const aoai = getAoaiConfig();
  if (!aoai.ok || !routing.deployment) {
    return buildFatigueFallback(input, `missing:${aoai.ok ? 'AZURE_OPENAI_DEPLOYMENT' : aoai.missing.join(',')}`);
  }

  const messages: LLMMessage[] = [
    {
      role: 'system',
      content:
        'You are the Fatigue Agent for a cricket tactical coaching system. Return only valid JSON. ' +
        'Required keys: severity, headline, explanation, recommendation, signals, suggestedTweaks. ' +
        'severity must be LOW, MED, or HIGH. signals must be short strings.',
    },
    {
      role: 'user',
      content: JSON.stringify({
        task: 'Analyze fatigue and workload risk.',
        telemetry: input,
      }),
    },
  ];

  try {
    const result = await callLLMJsonWithRetry<LLMFatigueOutput>({
      deployment: routing.deployment,
      fallbackDeployment: routing.fallbackDeployment,
      baseMessages: messages,
      strictSystemMessage:
        'Return ONLY valid JSON with keys severity, headline, explanation, recommendation, signals, suggestedTweaks. No markdown.',
      validate: isLLMFatigueOutput,
      temperature: routing.temperature,
      maxTokens: routing.maxTokens,
    });

    return {
      output: {
        status: 'ok',
        severity: normalizeSeverity(result.parsed.severity),
        headline: result.parsed.headline.trim() || 'Fatigue advisory',
        explanation: result.parsed.explanation.trim() || 'Fatigue analysis available.',
        recommendation: result.parsed.recommendation.trim() || 'Monitor workload trend.',
        signals: result.parsed.signals.slice(0, 6),
        echo: buildEcho(input),
        ...(result.parsed.suggestedTweaks ? { suggestedTweaks: result.parsed.suggestedTweaks } : {}),
      },
      model: result.deploymentUsed,
      fallbacksUsed: result.fallbacksUsed,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'llm-error';
    return buildFatigueFallback(input, `llm-error:${message}`);
  }
}

