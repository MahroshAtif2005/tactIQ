import { callLLMJsonWithRetry, LLMMessage } from '../llm/client';
import { getAoaiConfig } from '../llm/modelRegistry';
import { routeModel } from '../llm/router';
import { TacticalAgentInput, TacticalAgentOutput, TacticalAgentResult } from './types';

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

const isTacticalOutput = (value: unknown): value is TacticalAgentOutput => {
  const candidate = value as TacticalAgentOutput;
  return Boolean(
    candidate &&
      typeof candidate === 'object' &&
      (candidate.status === 'ok' || candidate.status === 'fallback' || candidate.status === 'error') &&
      typeof candidate.immediateAction === 'string' &&
      typeof candidate.rationale === 'string' &&
      Array.isArray(candidate.suggestedAdjustments) &&
      candidate.suggestedAdjustments.every((item) => typeof item === 'string') &&
      typeof candidate.confidence === 'number' &&
      Array.isArray(candidate.keySignalsUsed)
  );
};

const pickBenchReplacement = (input: TacticalAgentInput): string => {
  const bench = input.players.bench || [];
  if (bench.length === 0) return 'Best available bench player';
  const role = String(input.telemetry.role || '').toLowerCase();
  if (role.includes('bowler') || role.includes('spinner')) {
    const bowlingCandidate = bench.find((name) => {
      const lower = name.toLowerCase();
      return lower.includes('bowler') || lower.includes('pacer') || lower.includes('spinner');
    });
    if (bowlingCandidate) return bowlingCandidate;
  }
  return bench[0];
};

export function buildTacticalFallback(input: TacticalAgentInput, reason: string): TacticalAgentResult {
  const fatigueIndex = Number(input.telemetry.fatigueIndex) || 0;
  const injuryRisk = String(input.telemetry.injuryRisk || 'MEDIUM').toUpperCase();
  const noBallRisk = String(input.telemetry.noBallRisk || 'MEDIUM').toUpperCase();
  const poorRecovery = ['poor', 'very poor'].includes(String(input.telemetry.heartRateRecovery || '').toLowerCase());
  const shouldSubstitute = injuryRisk === 'HIGH' || injuryRisk === 'CRITICAL' || fatigueIndex >= 7 || poorRecovery;
  const replacement = pickBenchReplacement(input);
  const suggestedAdjustments = shouldSubstitute
    ? [
        'Substitute the current bowler before the next over.',
        'Use a fresher bowler to protect execution under pressure.',
        'Reduce high-risk line-length plans for the next spell.',
        'Reassess fatigue and risk after one over.',
      ]
    : [
        'Continue with current player for one over.',
        'Monitor fatigue trend and recovery markers ball-by-ball.',
        'Keep a bench substitute warm for rapid swap if risk rises.',
      ];

  return {
    output: {
      status: 'fallback',
      immediateAction: shouldSubstitute ? 'Substitute now and rotate workload' : 'Continue with monitored plan',
      rationale: shouldSubstitute
        ? `Heuristic fallback: elevated risk (injury ${injuryRisk}, fatigue ${fatigueIndex.toFixed(1)}, no-ball ${noBallRisk}).`
        : `Heuristic fallback: current risk remains manageable (injury ${injuryRisk}, fatigue ${fatigueIndex.toFixed(1)}).`,
      suggestedAdjustments,
      substitutionAdvice: shouldSubstitute
        ? {
            out: input.telemetry.playerName || input.players.bowler,
            in: replacement,
            reason: 'Heuristic fallback recommends workload protection due to elevated fatigue/risk.',
          }
        : undefined,
      confidence: shouldSubstitute ? 0.72 : 0.67,
      keySignalsUsed: ['fatigueIndex', 'injuryRisk', 'noBallRisk', 'heartRateRecovery', 'phase', reason],
    },
    model: 'fallback-heuristic',
    fallbacksUsed: [reason],
  };
}

export async function runTacticalAgent(input: TacticalAgentInput): Promise<TacticalAgentResult> {
  const routing = routeModel({ task: 'tactical', needsJson: true, complexity: 'high' });
  const aoai = getAoaiConfig();
  if (!aoai.ok || !routing.deployment) {
    return buildTacticalFallback(input, `missing:${(aoai.ok ? ['AZURE_OPENAI_DEPLOYMENT'] : aoai.missing).join(',')}`);
  }

  const messages: LLMMessage[] = [
    {
      role: 'system',
      content:
        'You are a cricket tactical coach agent. Return only JSON with keys: status, immediateAction, rationale, suggestedAdjustments, substitutionAdvice, confidence, keySignalsUsed. ' +
        'status must be "ok". ' +
        'suggestedAdjustments must have 3 to 6 short items. confidence is a number 0..1.',
    },
    {
      role: 'user',
      content: JSON.stringify({
        task: 'Provide immediate tactical coaching recommendation using only the input data.',
        input,
      }),
    },
  ];

  try {
    const result = await callLLMJsonWithRetry<TacticalAgentOutput>({
      deployment: routing.deployment,
      fallbackDeployment: routing.fallbackDeployment,
      baseMessages: messages,
      strictSystemMessage:
        'Return ONLY valid JSON. No markdown, no prose, no extra keys. Required keys: status, immediateAction, rationale, suggestedAdjustments, substitutionAdvice, confidence, keySignalsUsed. status must be "ok".',
      validate: isTacticalOutput,
      temperature: routing.temperature,
      maxTokens: routing.maxTokens,
    });

    return {
      output: {
        ...result.parsed,
        status: 'ok',
        confidence: Number(clamp01(result.parsed.confidence).toFixed(2)),
        suggestedAdjustments: result.parsed.suggestedAdjustments.slice(0, 6),
      },
      model: result.deploymentUsed,
      fallbacksUsed: result.fallbacksUsed,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'llm-error';
    return buildTacticalFallback(input, `llm-error:${message}`);
  }
}
