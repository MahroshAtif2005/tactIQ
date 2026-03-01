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

const normalizeRiskLevel = (value: unknown, fallbackScore: number): 'low' | 'medium' | 'high' => {
  const token = String(value || '').trim().toLowerCase();
  if (token === 'high') return 'high';
  if (token === 'medium' || token === 'med') return 'medium';
  if (token === 'low') return 'low';
  if (fallbackScore >= 70) return 'high';
  if (fallbackScore >= 40) return 'medium';
  return 'low';
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

  try {
    const result = await callLLMJsonWithRetry<LLMRiskOutput>({
      deployment: routing.deployment,
      fallbackDeployment: routing.fallbackDeployment,
      baseMessages: messages,
      strictSystemMessage:
        'Return ONLY valid JSON with keys injuryRisk, riskLevel, primaryRiskType, whyThisRiskIsEmerging, performanceImpactIfContinued, recommendedAction, confidence. No markdown.',
      validate: isLLMRiskOutput,
      temperature: routing.temperature,
      maxTokens: Math.max(320, routing.maxTokens),
      timeoutMs: 10000,
      retryOnTransient: true,
    });

    const normalizedRisk = clamp(Number(result.parsed.injuryRisk) || 0, 0, 100);
    const riskLevel = normalizeRiskLevel(result.parsed.riskLevel, normalizedRisk);
    const severity: RiskAgentResponse['severity'] =
      riskLevel === 'high' ? 'HIGH' : riskLevel === 'medium' ? 'MED' : 'LOW';
    const confidence = normalizeConfidenceScore(result.parsed.confidence);
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
      primaryRiskType: result.parsed.primaryRiskType,
      why: (result.parsed.whyThisRiskIsEmerging || []).map((entry) => toSingleSentence(entry)),
      performanceImpact: toSingleSentence(result.parsed.performanceImpactIfContinued),
      recommendedAction: toSingleSentence(result.parsed.recommendedAction),
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
    const message = error instanceof Error ? error.message : 'llm-error';
    return buildRiskFallback(input, `llm-error:${message}`);
  }
}
