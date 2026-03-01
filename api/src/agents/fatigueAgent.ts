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

const toFinite = (value: unknown): number | undefined => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const deriveBaselineProfile = (input: FatigueAgentRequest): {
  sleepHours?: number;
  recoveryMinutes?: number;
  fatigueLimit?: number;
  role?: string;
  control?: number;
  speed?: number;
  power?: number;
} => {
  const context = input.fullMatchContext;
  const active = context?.roster?.find((entry) => entry.playerId === (context.activePlayerId || input.playerId));
  return {
    sleepHours: toFinite(active?.baseline?.sleepHours ?? input.sleepHours),
    recoveryMinutes: toFinite(active?.baseline?.recoveryScore ?? input.recoveryMinutes),
    fatigueLimit: toFinite(active?.baseline?.fatigueLimit ?? input.fatigueLimit),
    role: String(active?.role || input.role || '').trim() || undefined,
    control: toFinite(active?.baseline?.controlBaseline),
    speed: toFinite(active?.baseline?.speed),
    power: toFinite(active?.baseline?.power),
  };
};

const buildBaselineDirective = (input: FatigueAgentRequest): string => {
  const profile = deriveBaselineProfile(input);
  const sleep = profile.sleepHours;
  const recovery = profile.recoveryMinutes;
  const fatigueLimit = profile.fatigueLimit;
  const playerName = String(input.playerName || 'the player');
  const hasBaseline = Number.isFinite(sleep) || Number.isFinite(recovery) || Number.isFinite(fatigueLimit);
  if (!hasBaseline) {
    return 'Baseline not available — using live telemetry only.';
  }
  return [
    Number.isFinite(sleep)
      ? `Given ${playerName} only had ~${sleep!.toFixed(1)}h sleep today, control quality can decay earlier in the spell.`
      : null,
    Number.isFinite(recovery)
      ? `Recovery window today is ~${Math.round(recovery!)}min, so residual fatigue is likely to carry into the next effort.`
      : null,
    Number.isFinite(fatigueLimit)
      ? `Fatigue ceiling for this player is ${fatigueLimit!.toFixed(1)}/10; recommendations must avoid running too close to that cap.`
      : null,
  ]
    .filter((entry): entry is string => Boolean(entry))
    .join(' ');
};

const projectedFatigueNextOver = (input: FatigueAgentRequest): number => {
  const context = input.fullMatchContext;
  const active = context?.roster?.find((entry) => entry.playerId === (context.activePlayerId || input.playerId));
  const baselineSleep = Number(active?.baseline?.sleepHours ?? input.sleepHours ?? 7);
  const baselineRecovery = Number(active?.baseline?.recoveryScore ?? input.recoveryMinutes ?? 45);
  const current = Math.max(0, Math.min(10, Number(input.fatigueIndex) || 0));
  const intensity = String(context?.match?.intensity || input.matchContext?.intensity || 'Medium').toLowerCase();
  const intensityDelta = intensity === 'high' ? 0.8 : intensity === 'low' ? 0.25 : 0.5;
  const sleepRelief = baselineSleep >= 7 ? 0.2 : 0;
  const recoveryRelief = baselineRecovery >= 45 ? 0.2 : 0;
  return Number(Math.max(0, Math.min(10, current + intensityDelta - sleepRelief - recoveryRelief)).toFixed(1));
};

type LLMFatigueOutput = {
  headline: string;
  summary: string;
  why: string[];
  action: string;
  projection: string;
  signals?: string[];
};

const isLLMFatigueOutput = (value: unknown): value is LLMFatigueOutput => {
  const candidate = value as LLMFatigueOutput;
  return Boolean(
    candidate &&
      typeof candidate === 'object' &&
      typeof candidate.headline === 'string' &&
      typeof candidate.summary === 'string' &&
      Array.isArray(candidate.why) &&
      candidate.why.every((entry) => typeof entry === 'string') &&
      typeof candidate.action === 'string' &&
      typeof candidate.projection === 'string' &&
      (candidate.signals === undefined ||
        (Array.isArray(candidate.signals) && candidate.signals.every((signal) => typeof signal === 'string')))
  );
};

const normalizeText = (value: unknown): string => String(value || '').replace(/\s+/g, ' ').trim();
const truncateChars = (value: string, max: number): string => {
  const normalized = normalizeText(value);
  if (normalized.length <= max) return normalized;
  return normalized.slice(0, max).trim();
};
const truncateWords = (value: string, maxWords: number): string => {
  const words = normalizeText(value).split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(' ');
  return words.slice(0, maxWords).join(' ');
};
const toSingleSentence = (value: string): string => {
  const normalized = normalizeText(value);
  if (!normalized) return '';
  const match = normalized.match(/^(.+?[.!?])(?:\s|$)/);
  return match ? match[1].trim() : normalized;
};
const dedupeTextList = (values: string[]): string[] => {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const raw of values) {
    const normalized = normalizeText(raw);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
  }
  return output;
};
const dedupeSentencePair = (first: string, second: string, fallbackSecond: string): [string, string] => {
  const normalizedFirst = normalizeText(first);
  const normalizedSecond = normalizeText(second);
  if (!normalizedFirst && !normalizedSecond) return ['', fallbackSecond];
  if (normalizedFirst.toLowerCase() === normalizedSecond.toLowerCase()) {
    const fallback = normalizeText(fallbackSecond);
    return [normalizedFirst || fallback, fallback];
  }
  return [normalizedFirst, normalizedSecond];
};
const deriveSeverityFromInput = (input: FatigueAgentRequest): 'LOW' | 'MED' | 'HIGH' => {
  const fatigue = Number(input.fatigueIndex) || 0;
  const injury = normalizeSeverity(input.injuryRisk);
  if (injury === 'HIGH' || fatigue >= 7) return 'HIGH';
  if (injury === 'MED' || fatigue >= 4) return 'MED';
  return 'LOW';
};

export function buildFatigueFallback(input: FatigueAgentRequest, reason: string): FatigueAgentRunResult {
  const fallback = analyzeFatigueRuleBased(input);
  const projected = projectedFatigueNextOver(input);
  const baselineDirective = buildBaselineDirective(input);
  const fatigueValue = Math.max(0, Math.min(10, Number(input.fatigueIndex) || 0));
  const fatigueLimit = Number.isFinite(Number(input.fatigueLimit)) ? Number(input.fatigueLimit) : 6;
  const summary = truncateChars(
    toSingleSentence(`${fallback.explanation} ${baselineDirective.toLowerCase().startsWith('baseline not available') ? '' : baselineDirective}`.trim()),
    220
  ) || 'Fatigue trend reviewed from current telemetry.';
  const why = dedupeTextList(
    [
      `Fatigue ${fatigueValue.toFixed(1)}/10 versus limit ${fatigueLimit.toFixed(1)}/10.`,
      `Injury risk ${normalizeRiskEcho(input.injuryRisk)} and no-ball risk ${normalizeRiskEcho(input.noBallRisk)}.`,
      baselineDirective,
    ].map((entry) => truncateChars(entry, 90))
  ).slice(0, 3);
  const action = truncateChars(toSingleSentence(fallback.recommendation || 'Manage workload in the next over.'), 120)
    || 'Manage workload in the next over.';
  const [summaryDeduped, actionDeduped] = dedupeSentencePair(summary, action, 'Manage workload in the next over.');
  const projection = truncateChars(`Next over: ${projected.toFixed(1)}/10`, 60);
  return {
    output: {
      ...fallback,
      status: 'fallback',
      echo: buildEcho(input),
      headline: truncateWords(fallback.headline || 'Fatigue advisory', 8) || 'Fatigue advisory',
      summary: summaryDeduped || summary,
      why,
      action: actionDeduped || action,
      projection,
      explanation: summaryDeduped || summary,
      recommendation: truncateChars(`${actionDeduped || action} ${projection}`.trim(), 220) || actionDeduped || action,
      signals: dedupeTextList([...(fallback.signals || []), `projection:${projected.toFixed(1)}`]).slice(0, 8),
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
        'You are the Fatigue Agent for a cricket tactical coaching system. Return ONLY valid JSON and no markdown. ' +
        'Schema only: {"headline":"string <=8 words","summary":"string <=220 chars, 1 sentence assessment","why":["max 3 bullets, each <=90 chars"],"action":"string <=120 chars, 1 sentence","projection":"string like Next over: 6.6/10","signals":["optional short strings"],"swap":"optional string","confidence":"optional low|med|high"}. ' +
        'Do NOT repeat the same sentence across fields. Each field must add new info. ' +
        'Use simple language. You MUST use baseline sleepHours, recoveryMinutes, and fatigueLimit when provided.',
    },
    {
      role: 'user',
      content: JSON.stringify({
        task: 'Analyze fatigue and workload risk.',
        telemetry: input,
        baseline: deriveBaselineProfile(input),
      }),
    },
  ];

  try {
    const projected = projectedFatigueNextOver(input);
    const result = await callLLMJsonWithRetry<LLMFatigueOutput>({
      deployment: routing.deployment,
      fallbackDeployment: routing.fallbackDeployment,
      baseMessages: messages,
      strictSystemMessage:
        'Return ONLY valid JSON matching this schema exactly: {"headline":"string <=8 words","summary":"string <=220 chars","why":["max 3 bullets, each <=90 chars"],"action":"string <=120 chars","projection":"string","signals":["optional short strings"],"swap":"optional string","confidence":"optional low|med|high"}. Do NOT repeat sentences across fields.',
      validate: isLLMFatigueOutput,
      temperature: routing.temperature,
      maxTokens: routing.maxTokens,
    });
    const headline = truncateWords(result.parsed.headline || 'Fatigue advisory', 8) || 'Fatigue advisory';
    const summary = truncateChars(toSingleSentence(result.parsed.summary || 'Fatigue analysis available.'), 220)
      || 'Fatigue analysis available.';
    const why = dedupeTextList((result.parsed.why || []).map((entry) => truncateChars(entry, 90))).slice(0, 3);
    const action = truncateChars(toSingleSentence(result.parsed.action || 'Manage workload in the next over.'), 120)
      || 'Manage workload in the next over.';
    const [summaryDeduped, actionDeduped] = dedupeSentencePair(summary, action, 'Manage workload in the next over.');
    const projection = truncateChars(result.parsed.projection || `Next over: ${projected.toFixed(1)}/10`, 60)
      || `Next over: ${projected.toFixed(1)}/10`;
    const signals = dedupeTextList([...(result.parsed.signals || []), `projection:${projected.toFixed(1)}`]).slice(0, 8);

    return {
      output: {
        status: 'ok',
        severity: deriveSeverityFromInput(input),
        headline,
        summary: summaryDeduped || summary,
        why,
        action: actionDeduped || action,
        projection,
        explanation: summaryDeduped || summary,
        recommendation: truncateChars(`${actionDeduped || action} ${projection}`.trim(), 220) || actionDeduped || action,
        signals,
        echo: buildEcho(input),
      },
      model: result.deploymentUsed,
      fallbacksUsed: result.fallbacksUsed,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'llm-error';
    return buildFatigueFallback(input, `llm-error:${message}`);
  }
}
