import { callLLMJsonWithRetry, LLMMessage } from '../llm/client';
import { getAoaiConfig } from '../llm/modelRegistry';
import { routeModel } from '../llm/router';
import { analyzeRisk } from '../shared/riskModel';
import { RiskAgentRequest, RiskAgentResponse } from '../shared/types';

export interface RiskAgentRunResult {
  output: RiskAgentResponse;
  model: string;
  fallbacksUsed: string[];
}

type RiskSeverity = 'LOW' | 'MED' | 'HIGH' | 'CRITICAL';

type LLMRiskOutput = {
  severity: RiskSeverity | string;
  riskScore: number;
  headline: string;
  explanation: string;
  recommendation: string;
  signals: string[];
  injuryRiskLevel?: string;
  noBallRiskLevel?: string;
};

const normalizeSeverity = (value: unknown): RiskSeverity => {
  const upper = String(value || '').toUpperCase();
  if (upper === 'CRITICAL') return 'CRITICAL';
  if (upper === 'HIGH') return 'HIGH';
  if (upper === 'MED' || upper === 'MEDIUM') return 'MED';
  return 'LOW';
};

const isLLMRiskOutput = (value: unknown): value is LLMRiskOutput => {
  const candidate = value as LLMRiskOutput;
  return Boolean(
    candidate &&
      typeof candidate === 'object' &&
      typeof candidate.severity === 'string' &&
      Number.isFinite(Number(candidate.riskScore)) &&
      typeof candidate.headline === 'string' &&
      typeof candidate.explanation === 'string' &&
      typeof candidate.recommendation === 'string' &&
      Array.isArray(candidate.signals) &&
      candidate.signals.every((signal) => typeof signal === 'string')
  );
};

export function buildRiskFallback(input: RiskAgentRequest, reason: string): RiskAgentRunResult {
  const fallback = analyzeRisk(input);
  return {
    output: {
      ...fallback,
      status: 'fallback',
    },
    model: 'rule:fallback',
    fallbacksUsed: [reason],
  };
}

export async function runRiskAgent(input: RiskAgentRequest): Promise<RiskAgentRunResult> {
  const routing = routeModel({ task: 'risk', needsJson: true, complexity: 'medium' });
  const aoai = getAoaiConfig();
  if (!aoai.ok || !routing.deployment) {
    return buildRiskFallback(input, `missing:${aoai.ok ? 'AZURE_OPENAI_DEPLOYMENT' : aoai.missing.join(',')}`);
  }

  const baseline = analyzeRisk(input);
  const messages: LLMMessage[] = [
    {
      role: 'system',
      content:
        'You are the Risk Agent for cricket tactical coaching. Return only valid JSON. ' +
        'Required keys: severity, riskScore, headline, explanation, recommendation, signals, injuryRiskLevel, noBallRiskLevel. ' +
        'severity must be one of LOW, MED, HIGH, CRITICAL. riskScore must be 0..10.',
    },
    {
      role: 'user',
      content: JSON.stringify({
        task: 'Assess injury and no-ball risk with an action recommendation.',
        telemetry: input,
      }),
    },
  ];

  try {
    const result = await callLLMJsonWithRetry<LLMRiskOutput>({
      deployment: routing.deployment,
      fallbackDeployment: routing.fallbackDeployment,
      baseMessages: messages,
      strictSystemMessage:
        'Return ONLY valid JSON with keys severity, riskScore, headline, explanation, recommendation, signals, injuryRiskLevel, noBallRiskLevel. No markdown.',
      validate: isLLMRiskOutput,
      temperature: routing.temperature,
      maxTokens: routing.maxTokens,
    });

    const severity = normalizeSeverity(result.parsed.severity);
    const riskScore = Math.max(0, Math.min(10, Number(result.parsed.riskScore)));
    const criticalHeadline = severity === 'HIGH' || severity === 'CRITICAL';

    return {
      output: {
        agent: 'risk',
        status: 'ok',
        severity,
        riskScore: Number(riskScore.toFixed(1)),
        headline: criticalHeadline ? 'CRITICAL RISK DETECTED' : (result.parsed.headline.trim() || baseline.headline),
        explanation: result.parsed.explanation.trim() || baseline.explanation,
        recommendation: result.parsed.recommendation.trim() || baseline.recommendation,
        signals: result.parsed.signals.slice(0, 8),
        echo: baseline.echo,
      },
      model: result.deploymentUsed,
      fallbacksUsed: result.fallbacksUsed,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'llm-error';
    return buildRiskFallback(input, `llm-error:${message}`);
  }
}

