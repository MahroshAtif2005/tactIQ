import { callLLMJsonWithRetry, LLMJsonResponseError, LLMMessage, LLMRequestError } from '../llm/client';
import { getAoaiConfig } from '../llm/modelRegistry';
import { routeModel } from '../llm/router';
import { analyzeRisk } from '../shared/riskModel';
import { RiskAgentRequest, RiskAgentResponse } from '../shared/types';

export interface RiskAgentRunResult {
  output: RiskAgentResponse;
  model: string;
  fallbacksUsed: string[];
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

type LLMRiskOutput = {
  injuryRisk: number;
  riskLevel: 'low' | 'medium' | 'high';
  primaryRiskType: string;
  whyThisRiskIsEmerging: string[];
  performanceImpactIfContinued: string;
  recommendedAction: string;
  confidence: number | 'low' | 'med' | 'medium' | 'high';
};

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const isLLMRiskOutput = (value: unknown): value is LLMRiskOutput => {
  const candidate = value as LLMRiskOutput;
  return Boolean(
    candidate &&
      typeof candidate === 'object' &&
      typeof candidate.injuryRisk === 'number' &&
      typeof candidate.riskLevel === 'string' &&
      typeof candidate.primaryRiskType === 'string' &&
      Array.isArray(candidate.whyThisRiskIsEmerging) &&
      candidate.whyThisRiskIsEmerging.every((entry) => typeof entry === 'string') &&
      typeof candidate.performanceImpactIfContinued === 'string' &&
      typeof candidate.recommendedAction === 'string' &&
      (typeof candidate.confidence === 'number' || typeof candidate.confidence === 'string')
  );
};
const normalizeText = (value: unknown): string => String(value || '').replace(/\s+/g, ' ').trim();
const toSingleSentence = (value: unknown): string => {
  const normalized = normalizeText(value);
  if (!normalized) return '';
  const match = normalized.match(/^(.+?[.!?])(?:\s|$)/);
  return match ? match[1].trim() : normalized;
};
const dedupeTextList = (values: string[]): string[] => {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = normalizeText(value);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
  }
  return output;
};
const normalizeConfidenceScore = (value: unknown): number => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return clamp(value, 0, 1);
  }
  const token = String(value || '').trim().toLowerCase();
  if (token === 'high') return 0.85;
  if (token === 'med' || token === 'medium') return 0.65;
  if (token === 'low') return 0.4;
  return 0.65;
};

const parseNumericRiskScore = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value <= 10 ? clamp(value * 10, 0, 100) : clamp(value, 0, 100);
  }
  const token = String(value || '').trim();
  if (!token) return undefined;
  const match = token.match(/-?\d+(\.\d+)?/);
  if (!match) return undefined;
  const parsed = Number(match[0]);
  if (!Number.isFinite(parsed)) return undefined;
  return parsed <= 10 && !/%/.test(token) ? clamp(parsed * 10, 0, 100) : clamp(parsed, 0, 100);
};

const normalizeWhyLines = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeText(entry)).filter(Boolean);
  }
  const normalized = normalizeText(value);
  if (!normalized) return [];
  const cleaned = normalized
    .replace(/^\s*[-*•]\s*/g, '')
    .replace(/\s*[-*•]\s*/g, ' | ');
  const segments = cleaned
    .split(/\s*\|\s*|\s*;\s*|\n+/)
    .map((entry) => normalizeText(entry))
    .filter(Boolean);
  return segments.length > 0 ? segments : [normalized];
};

const parseStatusFromErrorMessage = (message: string): number | undefined => {
  const match = String(message || '').match(/\((\d{3})\)|status[:= ]+(\d{3})/i);
  if (!match) return undefined;
  const parsed = Number(match[1] || match[2]);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const classifyRiskFallbackCategory = (error: unknown): string => {
  if (error instanceof LLMJsonResponseError) {
    return error.phase === 'parse' ? 'json_parse_failed' : 'json_schema_failed';
  }
  if (error instanceof LLMRequestError) {
    if (error.status === 408 || /timeout/i.test(error.message || '')) return 'openai_timeout';
    if (typeof error.status === 'number') return `openai_http_${error.status}`;
    if (/timeout/i.test(error.message || '')) return 'openai_timeout';
    return 'openai_request_failed';
  }
  const message = error instanceof Error ? error.message : String(error || '');
  if (/timeout/i.test(message)) return 'openai_timeout';
  return 'runtime_exception';
};

const extractRiskFailureDetails = (
  error: unknown
): {
  category: string;
  message: string;
  status?: number;
  code?: string;
  phase?: 'parse' | 'schema';
  bodySnippet?: string;
  rawSnippet?: string;
} => {
  const category = classifyRiskFallbackCategory(error);
  let status: number | undefined;
  let code = '';
  let phase: 'parse' | 'schema' | undefined;
  let bodySnippet = '';
  let rawSnippet = '';
  const message = normalizeText(error instanceof Error ? error.message : String(error || 'risk_llm_error')).slice(0, 240);

  if (error instanceof LLMRequestError) {
    status = error.status;
    code = String((error as LLMRequestError & { code?: unknown }).code || '').trim();
    bodySnippet = normalizeText(error.bodySnippet || '').slice(0, 220);
  } else if (error instanceof LLMJsonResponseError) {
    phase = error.phase;
    code = `json_${error.phase}`;
    rawSnippet = normalizeText(error.rawSnippet || '').slice(0, 220);
  } else if (error && typeof error === 'object') {
    const candidate = error as {
      status?: unknown;
      statusCode?: unknown;
      code?: unknown;
      bodySnippet?: unknown;
      rawSnippet?: unknown;
    };
    const parsedStatus = Number(candidate.status ?? candidate.statusCode);
    status = Number.isFinite(parsedStatus) ? parsedStatus : undefined;
    code = String(candidate.code || '').trim();
    bodySnippet = normalizeText(candidate.bodySnippet || '').slice(0, 220);
    rawSnippet = normalizeText(candidate.rawSnippet || '').slice(0, 220);
  }

  if (typeof status !== 'number') {
    status = parseStatusFromErrorMessage(message);
  }

  return {
    category,
    message,
    ...(typeof status === 'number' ? { status } : {}),
    ...(code ? { code } : {}),
    ...(phase ? { phase } : {}),
    ...(bodySnippet ? { bodySnippet } : {}),
    ...(rawSnippet ? { rawSnippet } : {}),
  };
};

const llmFallbackReason = (error: unknown): string => {
  const message = normalizeText(error instanceof Error ? error.message : String(error || 'llm-error')).slice(0, 240);
  let status: number | undefined;
  let code = '';
  let body = '';
  if (error instanceof LLMRequestError) {
    status = error.status;
    code = String((error as LLMRequestError & { code?: unknown }).code || '').trim();
    body = normalizeText(error.bodySnippet || '').slice(0, 200);
  } else if (error instanceof LLMJsonResponseError) {
    code = `json_${error.phase}`;
    body = normalizeText(error.rawSnippet || '').slice(0, 200);
  } else if (error && typeof error === 'object') {
    const candidate = error as { status?: unknown; statusCode?: unknown; code?: unknown; bodySnippet?: unknown };
    const statusParsed = Number(candidate.status ?? candidate.statusCode);
    status = Number.isFinite(statusParsed) ? statusParsed : undefined;
    code = String(candidate.code || '').trim();
    body = normalizeText(String(candidate.bodySnippet || '')).slice(0, 200);
  }
  const suffix = [
    typeof status === 'number' ? `status=${status}` : '',
    code ? `code=${code}` : '',
    body ? `body=${body}` : '',
  ]
    .filter(Boolean)
    .join(';');
  return suffix ? `llm-error:${message};${suffix}` : `llm-error:${message}`;
};

const normalizeRiskLevel = (value: unknown, fallbackScore: number): 'low' | 'medium' | 'high' => {
  const token = String(value || '').trim().toLowerCase();
  if (!token) {
    if (fallbackScore >= 70) return 'high';
    if (fallbackScore >= 40) return 'medium';
    return 'low';
  }
  if (token === 'high') return 'high';
  if (token === 'medium' || token === 'med' || token === 'moderate' || token === 'elevated') return 'medium';
  if (token === 'low' || token === 'stable') return 'low';
  if (token.includes('high concern')) return 'high';
  if (token.includes('elevated') || token.includes('moderate')) return 'medium';
  if (token.includes('stable') || token.includes('low')) return 'low';
  if (fallbackScore >= 70) return 'high';
  if (fallbackScore >= 40) return 'medium';
  return 'low';
};

const coerceLLMRiskOutput = (
  value: unknown
): { output: LLMRiskOutput; normalizationNotes: string[] } | null => {
  if (!isObjectRecord(value)) return null;
  const pick = (...keys: string[]): unknown => {
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        const candidate = value[key];
        if (candidate !== undefined && candidate !== null && String(candidate).trim() !== '') return candidate;
      }
    }
    return undefined;
  };

  const notes: string[] = [];
  const injuryRiskRaw = pick('injuryRisk', 'riskScore', 'risk', 'score');
  const normalizedRiskScore = parseNumericRiskScore(injuryRiskRaw);
  if (normalizedRiskScore === undefined) {
    notes.push('injuryRisk_missing_or_non_numeric');
  } else if (!isLLMRiskOutput(value)) {
    notes.push('injuryRisk_coerced');
  }

  const riskLevelRaw = pick('riskLevel', 'risk_level', 'riskLabel', 'riskBand');
  const riskLevel = normalizeRiskLevel(riskLevelRaw, normalizedRiskScore ?? 35);
  if (String(riskLevelRaw || '').trim() && !isLLMRiskOutput(value)) {
    notes.push('riskLevel_normalized');
  }

  const primaryRiskTypeRaw = pick('primaryRiskType', 'primaryRisk', 'riskType', 'primaryConcern');
  const whyRaw = pick('whyThisRiskIsEmerging', 'why', 'signals', 'keySignals');
  const impactRaw = pick('performanceImpactIfContinued', 'performanceImpact', 'impactIfContinued', 'ifContinuedImpact');
  const actionRaw = pick('recommendedAction', 'recommendation', 'nextAction', 'action');
  const confidenceRaw = pick('confidence', 'confidenceLevel', 'confidenceScore');

  const whyLines = normalizeWhyLines(whyRaw).map((entry) => toSingleSentence(entry)).filter(Boolean).slice(0, 4);
  if (whyLines.length === 0 && String(whyRaw || '').trim()) {
    notes.push('why_lines_empty_after_normalization');
  } else if (!isLLMRiskOutput(value) && whyLines.length > 0) {
    notes.push('why_lines_normalized');
  }

  const primaryRiskType = normalizeText(primaryRiskTypeRaw);
  const performanceImpactIfContinued = toSingleSentence(impactRaw);
  const recommendedAction = toSingleSentence(actionRaw);
  const confidence: LLMRiskOutput['confidence'] = (() => {
    if (typeof confidenceRaw === 'number' && Number.isFinite(confidenceRaw)) {
      return clamp(confidenceRaw, 0, 1);
    }
    const token = String(confidenceRaw || '').trim().toLowerCase();
    if (token === 'high') return 'high';
    if (token === 'med' || token === 'medium' || token === 'moderate') return 'medium';
    if (token === 'low') return 'low';
    return 'medium';
  })();
  const injuryRisk =
    typeof normalizedRiskScore === 'number'
      ? normalizedRiskScore
      : riskLevel === 'high'
        ? 78
        : riskLevel === 'medium'
          ? 55
          : 28;

  const defaultPrimaryRisk = riskLevel === 'low' ? 'No immediate injury threat detected' : 'Lower-back overload';
  const defaultImpact = 'Control can drop through the spell, forcing defensive field plans.';
  const defaultAction =
    riskLevel === 'high'
      ? 'Rotate immediately, shorten the spell, and switch to a control-first plan.'
      : riskLevel === 'medium'
        ? 'Shorten this spell and schedule a proactive rotation at the next over break.'
        : 'No immediate injury threat detected; continue while monitoring action quality each over.';

  const hasAnySignal =
    Boolean(primaryRiskType) ||
    whyLines.length > 0 ||
    Boolean(performanceImpactIfContinued) ||
    Boolean(recommendedAction) ||
    typeof normalizedRiskScore === 'number' ||
    Boolean(String(riskLevelRaw || '').trim());

  if (!hasAnySignal) return null;

  return {
    output: {
      injuryRisk: clamp(injuryRisk, 0, 100),
      riskLevel,
      primaryRiskType: primaryRiskType || defaultPrimaryRisk,
      whyThisRiskIsEmerging: whyLines,
      performanceImpactIfContinued: performanceImpactIfContinued || defaultImpact,
      recommendedAction: recommendedAction || defaultAction,
      confidence,
    },
    normalizationNotes: notes,
  };
};

const normalizeRiskToken = (value: unknown): 'LOW' | 'MED' | 'HIGH' | 'UNKNOWN' => {
  const token = String(value || '').trim().toUpperCase();
  if (token === 'HIGH' || token === 'CRITICAL') return 'HIGH';
  if (token === 'MED' || token === 'MEDIUM') return 'MED';
  if (token === 'LOW') return 'LOW';
  return 'UNKNOWN';
};

const normalizeRole = (value: unknown): 'FAST_BOWLER' | 'SPINNER' | 'ALL_ROUNDER' | 'BATSMAN' | 'BOWLER' | 'UNKNOWN' => {
  const token = String(value || '').trim().toLowerCase();
  if (!token) return 'UNKNOWN';
  if (token.includes('fast')) return 'FAST_BOWLER';
  if (token.includes('spin')) return 'SPINNER';
  if (token.includes('all-rounder') || token.includes('all rounder')) return 'ALL_ROUNDER';
  if (token.includes('bat')) return 'BATSMAN';
  if (token.includes('bowl')) return 'BOWLER';
  return 'UNKNOWN';
};

const normalizePhase = (value: unknown): 'powerplay' | 'middle overs' | 'death overs' => {
  const token = String(value || '').trim().toLowerCase();
  if (token.includes('death')) return 'death overs';
  if (token.includes('middle')) return 'middle overs';
  return 'powerplay';
};

const deriveRecoveryTrend = (value: unknown): 'stable' | 'declining' | 'poor' => {
  const token = String(value || '').trim().toLowerCase();
  if (token === 'poor' || token === 'very poor') return 'poor';
  if (token === 'moderate' || token === 'ok') return 'declining';
  return 'stable';
};

const sanitizeCoachText = (value: unknown): string =>
  String(value || '')
    .replace(/\b(fatigueindex|strainindex|injuryrisk|noballrisk|oversbowled|baseline|sleep|recovery)\b/gi, '')
    .replace(/\b\d+(\.\d+)?\b/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();

const toRiskLevelLabel = (severity: RiskAgentResponse['severity']): 'Stable' | 'Elevated' | 'High Concern' => {
  const token = String(severity || '').toUpperCase();
  if (token === 'HIGH' || token === 'CRITICAL') return 'High Concern';
  if (token === 'MED' || token === 'MEDIUM') return 'Elevated';
  return 'Stable';
};

const toConfidenceLabel = (confidence: unknown): 'Low' | 'Moderate' | 'High' => {
  const score = normalizeConfidenceScore(confidence);
  if (score >= 0.78) return 'High';
  if (score >= 0.52) return 'Moderate';
  return 'Low';
};

const derivePrimaryRiskType = (args: {
  role: ReturnType<typeof normalizeRole>;
  riskLevelLabel: 'Stable' | 'Elevated' | 'High Concern';
  matchPhase: ReturnType<typeof normalizePhase>;
  recoveryTrend: ReturnType<typeof deriveRecoveryTrend>;
  noBallRisk: 'LOW' | 'MED' | 'HIGH' | 'UNKNOWN';
}): string => {
  if (args.riskLevelLabel === 'Stable') return 'No immediate injury threat detected';
  if (args.role === 'FAST_BOWLER') {
    if (args.recoveryTrend === 'poor' || args.matchPhase === 'death overs') return 'Side strain';
    if (args.noBallRisk === 'HIGH') return 'Groin strain';
    return 'Lower-back overload';
  }
  if (args.role === 'SPINNER') {
    if (args.noBallRisk === 'HIGH') return 'Shoulder fatigue';
    return 'Lower-back overload';
  }
  if (args.role === 'BATSMAN') return args.recoveryTrend === 'poor' ? 'Hamstring strain' : 'Calf tightness';
  if (args.role === 'ALL_ROUNDER') return 'Hamstring strain';
  return 'Lower-back overload';
};

const trimToWordLimit = (value: string, limit: number): string => {
  const raw = String(value || '').trim();
  const words = raw.split(/\s+/).filter(Boolean);
  if (words.length <= limit) return raw;
  return `${words.slice(0, limit).join(' ')}...`;
};

const composeRiskNarrative = (args: {
  playerName: string;
  role: ReturnType<typeof normalizeRole>;
  severity: RiskAgentResponse['severity'];
  matchPhase: ReturnType<typeof normalizePhase>;
  recoveryTrend: ReturnType<typeof deriveRecoveryTrend>;
  injuryRisk: 'LOW' | 'MED' | 'HIGH' | 'UNKNOWN';
  noBallRisk: 'LOW' | 'MED' | 'HIGH' | 'UNKNOWN';
  primaryRiskType?: string;
  why?: string[];
  performanceImpact?: string;
  recommendedAction?: string;
  confidence?: unknown;
}): {
  headline: string;
  explanation: string;
  recommendation: string;
  signals: string[];
} => {
  const riskLevelLabel = toRiskLevelLabel(args.severity);
  const derivedPrimaryRiskType = derivePrimaryRiskType({
    role: args.role,
    riskLevelLabel,
    matchPhase: args.matchPhase,
    recoveryTrend: args.recoveryTrend,
    noBallRisk: args.noBallRisk,
  });
  let primaryRiskType = sanitizeCoachText(args.primaryRiskType || derivedPrimaryRiskType);
  if (riskLevelLabel === 'Stable') {
    primaryRiskType = 'No immediate injury threat detected';
  }
  if (
    !primaryRiskType ||
    (riskLevelLabel !== 'Stable' && /no immediate injury threat detected/i.test(primaryRiskType))
  ) {
    primaryRiskType = derivedPrimaryRiskType;
  }
  if (
    riskLevelLabel !== 'Stable' &&
    !/(lower-back overload|side strain|hamstring strain|shoulder fatigue|calf tightness|groin strain)/i.test(
      primaryRiskType
    )
  ) {
    primaryRiskType = derivedPrimaryRiskType;
  }

  const defaultWhy = [
    args.matchPhase === 'death overs'
      ? `${args.playerName} is operating in a phase where intent increases loading on mechanics.`
      : args.matchPhase === 'middle overs'
        ? `${args.playerName} is deep in the spell and mechanical sharpness is harder to repeat.`
        : `${args.playerName} is pushing early tempo, so action quality needs tight monitoring.`,
    args.recoveryTrend === 'poor'
      ? 'Recovery trend shows carry-over load between efforts.'
      : args.recoveryTrend === 'declining'
        ? 'Recovery trend is slipping and resilience is tapering.'
        : 'Recovery trend remains stable but workload needs close management.',
    args.noBallRisk === 'HIGH' || args.noBallRisk === 'MED'
      ? 'Release-point stability is drifting, a precursor to soft-tissue strain.'
      : args.injuryRisk === 'HIGH' || args.injuryRisk === 'MED'
        ? 'Repeated effort is building tissue stress through the spell.'
        : 'Monitor movement quality for any early signs of compensation.',
  ];
  const whyLines = dedupeTextList([...(args.why || []), ...defaultWhy].map((entry) => sanitizeCoachText(entry)))
    .filter((entry) => entry.length >= 8)
    .slice(0, 3);

  const defaultImpact =
    args.role === 'BATSMAN'
      ? 'Footwork timing can dip, lowering shot control and running sharpness.'
      : args.noBallRisk === 'HIGH' || args.noBallRisk === 'MED'
        ? 'Release consistency can fade, causing no-ball drift and line-length errors.'
        : 'Control can drop through the spell, forcing defensive field plans.';
  const performanceImpact = sanitizeCoachText(args.performanceImpact || defaultImpact) || defaultImpact;

  const defaultAction =
    riskLevelLabel === 'High Concern'
      ? 'Rotate immediately, shorten the spell, and switch to a control-first plan.'
      : riskLevelLabel === 'Elevated'
        ? 'Shorten this spell and schedule a proactive rotation at the next over break.'
        : 'No immediate injury threat detected; continue while monitoring action quality each over.';
  const recommendedAction = sanitizeCoachText(args.recommendedAction || defaultAction) || defaultAction;
  const confidenceLabel = toConfidenceLabel(args.confidence);

  const explanation = trimToWordLimit(
    [
      'INJURY RISK ANALYSIS',
      '',
      'Risk Level:',
      riskLevelLabel,
      '',
      'Primary Risk Type:',
      primaryRiskType,
      '',
      'Why This Risk Is Emerging:',
      ...whyLines.map((entry) => `- ${entry}`),
      '',
      'Performance Impact If Continued:',
      performanceImpact,
    ].join('\n'),
    110
  );
  const recommendation = [
    'Recommended Action:',
    recommendedAction,
    '',
    'Confidence:',
    confidenceLabel,
  ].join('\n');

  return {
    headline: 'INJURY RISK ANALYSIS',
    explanation,
    recommendation,
    signals: whyLines,
  };
};

const escalateSeverity = (severity: RiskAgentResponse['severity']): RiskAgentResponse['severity'] => {
  if (severity === 'LOW') return 'MED';
  if (severity === 'MED') return 'HIGH';
  if (severity === 'HIGH') return 'CRITICAL';
  return severity;
};

const deriveReplacementCandidates = (input: RiskAgentRequest): Array<{ name: string; role?: string; fatigueIndex?: number }> => {
  if (Array.isArray(input.replacementCandidates) && input.replacementCandidates.length > 0) {
    return input.replacementCandidates
      .slice(0, 2)
      .map((entry) => ({ name: entry.name, role: entry.role, fatigueIndex: entry.fatigueIndex }));
  }
  const context = input.fullMatchContext;
  if (!context || !Array.isArray(context.roster)) return [];
  const activeId = context.activePlayerId || input.playerId;
  const activeRole = String(
    context.roster.find((entry) => entry.playerId === activeId)?.role || ''
  ).trim().toLowerCase();
  return context.roster
    .filter((entry) => entry.playerId !== activeId)
    .map((entry) => ({
      name: entry.name,
      role: entry.role,
      fatigueIndex: Number(entry.live?.fatigueIndex ?? 10),
      score:
        (String(entry.role || '').trim().toLowerCase() === activeRole ? 2 : 0) +
        (10 - clamp(Number(entry.live?.fatigueIndex ?? 10), 0, 10)) +
        (Number(entry.baseline?.sleepHours ?? 0) / 2),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
    .map((entry) => ({ name: entry.name, role: entry.role, fatigueIndex: entry.fatigueIndex }));
};

const enrichWithContext = (input: RiskAgentRequest, base: RiskAgentResponse): RiskAgentResponse => {
  const context = input.fullMatchContext;
  const activeId = context?.activePlayerId || input.playerId;
  const active = context?.roster?.find((entry) => entry.playerId === activeId);
  const playerName = String(active?.name || input.playerId || 'Current player').trim();
  const role = normalizeRole(active?.role);
  const matchPhase = normalizePhase(input.phase || context?.match?.phase);
  const recoveryTrend = deriveRecoveryTrend(input.heartRateRecovery);
  const injuryRisk = normalizeRiskToken(input.injuryRisk);
  const noBallRisk = normalizeRiskToken(input.noBallRisk);
  const sleepHours = Number(active?.baseline?.sleepHours);
  const recoveryScore = Number(active?.baseline?.recoveryScore);
  const lowResilienceBaseline =
    (Number.isFinite(sleepHours) && sleepHours < 6.5) ||
    (Number.isFinite(recoveryScore) && recoveryScore < 35);
  let severity = base.severity;
  let riskScore = base.riskScore;
  if (lowResilienceBaseline) {
    severity = escalateSeverity(severity);
    riskScore = Number(clamp(riskScore + 0.4, 0, 10).toFixed(2));
  }
  if ((injuryRisk === 'HIGH' || noBallRisk === 'HIGH') && severity === 'LOW') {
    severity = 'MED';
    riskScore = Number(clamp(riskScore + 0.3, 0, 10).toFixed(2));
  }
  if (injuryRisk === 'HIGH' && severity === 'MED') {
    severity = 'HIGH';
    riskScore = Number(clamp(riskScore + 0.3, 0, 10).toFixed(2));
  }
  if (input.isUnfit && severity !== 'CRITICAL') {
    severity = escalateSeverity(severity);
    riskScore = Number(clamp(riskScore + 0.5, 0, 10).toFixed(2));
  }

  const narrative = composeRiskNarrative({
    playerName,
    role,
    severity,
    matchPhase,
    recoveryTrend,
    injuryRisk,
    noBallRisk,
    confidence: severity === 'HIGH' || severity === 'CRITICAL' ? 0.82 : severity === 'MED' ? 0.67 : 0.58,
  });

  const contextSignals = [
    lowResilienceBaseline ? 'recovery trend is under strain' : '',
    matchPhase === 'death overs' ? 'death-over pressure is amplifying workload' : '',
    noBallRisk === 'HIGH' || noBallRisk === 'MED' ? 'release stability needs tighter control' : '',
  ].filter(Boolean);

  return {
    ...base,
    severity,
    riskScore,
    headline: narrative.headline,
    explanation: narrative.explanation,
    recommendation: narrative.recommendation,
    signals: dedupeTextList([...narrative.signals, ...contextSignals]).slice(0, 8),
  };
};

export function buildRiskFallback(input: RiskAgentRequest, reason: string): RiskAgentRunResult {
  const fallback = enrichWithContext(input, analyzeRisk(input));
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
  const rulesBaseline = enrichWithContext(input, analyzeRisk(input));
  const routing = routeModel({ task: 'risk', needsJson: true, complexity: 'medium' });
  const aoai = getAoaiConfig();

  if (!aoai.ok || !routing.deployment) {
    return buildRiskFallback(input, `missing:${aoai.ok ? 'AZURE_OPENAI_DEPLOYMENT' : aoai.missing.join(',')}`);
  }
  const endpointHost = (() => {
    try {
      return new URL(aoai.config.endpoint).host;
    } catch {
      return String(aoai.config.endpoint || '').replace(/^https?:\/\//i, '').split('/')[0] || 'unknown';
    }
  })();
  console.log('[risk][openai] config', {
    endpointHost,
    deployment: routing.deployment,
    fallbackDeployment: routing.fallbackDeployment,
    apiVersion: aoai.config.apiVersion,
  });
  console.log('[risk][openai] attempt', {
    attempted: true,
    deployment: routing.deployment,
    fallbackDeployment: routing.fallbackDeployment,
    timeoutMs: 10000,
    playerId: String(input.playerId || ''),
    phase: String(input.phase || ''),
  });

  const messages: LLMMessage[] = [
    {
      role: 'system',
      content:
        'You are the Injury Risk Analyst for an elite cricket tactical AI system. Return only valid JSON. ' +
        'Required keys: injuryRisk, riskLevel, primaryRiskType, whyThisRiskIsEmerging, performanceImpactIfContinued, recommendedAction, confidence. ' +
        'injuryRisk must be a number from 0..100 and riskLevel must be low, medium, or high. ' +
        'Do NOT repeat telemetry numbers or raw metric labels. Use cricket-specific terminology. ' +
        'For MED/HIGH riskLevel, primaryRiskType must be a specific cricket injury type (for example lower-back overload, side strain, hamstring strain, shoulder fatigue, calf tightness, groin strain). ' +
        'For LOW riskLevel, use "No immediate injury threat detected" and include what to monitor.',
    },
    {
      role: 'user',
      content: JSON.stringify({
        task:
          'Assess workload-driven cricket injury risk with coach-friendly interpretation. Keep language concise and professional. No telemetry number repetition.',
        outputFormat: {
          title: 'INJURY RISK ANALYSIS',
          sections: [
            'Risk Level',
            'Primary Risk Type',
            'Why This Risk Is Emerging',
            'Performance Impact If Continued',
            'Recommended Action',
            'Confidence',
          ],
          wordLimit: 150,
        },
        telemetry: input,
        deterministicBaseline: {
          riskScore: rulesBaseline.riskScore,
          severity: rulesBaseline.severity,
          headline: rulesBaseline.headline,
          recommendation: rulesBaseline.recommendation,
          signals: rulesBaseline.signals,
        },
      }),
    },
  ];
  console.log('[risk][openai] prompt_payload', {
    deployment: routing.deployment,
    fallbackDeployment: routing.fallbackDeployment,
    systemPrompt: normalizeText(messages[0]?.content || '').slice(0, 520),
    userPayload: normalizeText(messages[1]?.content || '').slice(0, 2000),
    messageCount: messages.length,
  });

  try {
    const result = await callLLMJsonWithRetry<Record<string, unknown>>({
      deployment: routing.deployment,
      fallbackDeployment: routing.fallbackDeployment,
      baseMessages: messages,
      strictSystemMessage:
        'Return ONLY valid JSON with keys injuryRisk, riskLevel, primaryRiskType, whyThisRiskIsEmerging, performanceImpactIfContinued, recommendedAction, confidence. No markdown.',
      validate: isObjectRecord,
      temperature: routing.temperature,
      maxTokens: Math.max(320, routing.maxTokens),
      timeoutMs: 10000,
      retryOnTransient: true,
      onRawResponse: ({ deployment, text }) => {
        console.log('[risk][openai] raw_response', {
          deployment,
          length: String(text || '').length,
          snippet: normalizeText(text).slice(0, 560),
        });
      },
      onValidation: ({ deployment, parseOk, schemaOk, error, parsed }) => {
        const parsedKeys = isObjectRecord(parsed) ? Object.keys(parsed).slice(0, 20) : [];
        console.log('[risk][openai] validation', {
          deployment,
          parseOk,
          schemaOk,
          ...(error ? { error } : {}),
          parsedKeys,
        });
      },
    });
    const normalized = coerceLLMRiskOutput(result.parsed);
    if (!normalized) {
      const rawSnippet = normalizeText(JSON.stringify(result.parsed || {})).slice(0, 220);
      console.error('[risk][openai] schema_validation_failed', {
        deploymentUsed: result.deploymentUsed,
        parsedKeys: Object.keys(result.parsed || {}).slice(0, 20),
        rawSnippet,
      });
      throw new LLMJsonResponseError('LLM JSON failed schema validation', {
        phase: 'schema',
        rawSnippet,
        deployment: result.deploymentUsed,
      });
    }
    console.log('[risk][openai] success', {
      deploymentUsed: result.deploymentUsed,
      fallbacksUsed: result.fallbacksUsed,
    });
    if (normalized.normalizationNotes.length > 0) {
      console.log('[risk][openai] schema_normalized', {
        deploymentUsed: result.deploymentUsed,
        notes: normalized.normalizationNotes,
      });
    }

    const normalizedRisk = clamp(Number(normalized.output.injuryRisk) || 0, 0, 100);
    const riskLevel = normalizeRiskLevel(normalized.output.riskLevel, normalizedRisk);
    const severity: RiskAgentResponse['severity'] =
      riskLevel === 'high' ? 'HIGH' : riskLevel === 'medium' ? 'MED' : 'LOW';
    const confidence = normalizeConfidenceScore(normalized.output.confidence);
    const context = input.fullMatchContext;
    const activeId = context?.activePlayerId || input.playerId;
    const active = context?.roster?.find((entry) => entry.playerId === activeId);
    const narrative = composeRiskNarrative({
      playerName: String(active?.name || input.playerId || 'Current player'),
      role: normalizeRole(active?.role),
      severity,
      matchPhase: normalizePhase(input.phase || context?.match?.phase),
      recoveryTrend: deriveRecoveryTrend(input.heartRateRecovery),
      injuryRisk: normalizeRiskToken(input.injuryRisk),
      noBallRisk: normalizeRiskToken(input.noBallRisk),
      primaryRiskType: normalized.output.primaryRiskType,
      why: (normalized.output.whyThisRiskIsEmerging || []).map((entry) => toSingleSentence(entry)),
      performanceImpact: toSingleSentence(normalized.output.performanceImpactIfContinued),
      recommendedAction: toSingleSentence(normalized.output.recommendedAction),
      confidence,
    });

    return {
      output: {
        ...rulesBaseline,
        status: 'ok',
        severity,
        riskScore: Number((normalizedRisk / 10).toFixed(2)),
        headline: narrative.headline,
        explanation: narrative.explanation,
        recommendation: narrative.recommendation,
        signals: [...narrative.signals].slice(0, 8),
      },
      model: result.deploymentUsed,
      fallbacksUsed: result.fallbacksUsed,
    };
  } catch (error) {
    const details = extractRiskFailureDetails(error);
    console.error('[risk][openai] failure', {
      ...details,
      attempted: true,
      endpointHost,
      deployment: routing.deployment,
      fallbackDeployment: routing.fallbackDeployment,
      apiVersion: aoai.config.apiVersion,
    });
    return buildRiskFallback(input, llmFallbackReason(error));
  }
}
