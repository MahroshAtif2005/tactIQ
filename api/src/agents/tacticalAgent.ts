import { callLLMJsonWithRetry, LLMJsonResponseError, LLMMessage, LLMRequestError } from '../llm/client';
import { getAoaiConfig } from '../llm/modelRegistry';
import { routeModel } from '../llm/router';
import { isEligibleForMode } from '../lib/safetyRank';
import { TacticalAgentInput, TacticalAgentOutput, TacticalAgentResult } from './types';

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
const normalizeText = (value: unknown): string => String(value || '').replace(/\s+/g, ' ').trim();
const truncateChars = (value: unknown, maxChars: number): string => {
  const normalized = normalizeText(value);
  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trim()}…`;
};
const toSingleSentence = (value: unknown): string => truncateChars(value, 120);
const dedupeTextList = (values: string[]): string[] => {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const entry of values) {
    const normalized = normalizeText(entry);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
  }
  return output;
};
const normalizeConfidenceScore = (value: unknown): number => {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return clamp01(numeric);
  const token = String(value || '').trim().toLowerCase();
  if (token === 'high') return 0.85;
  if (token === 'med' || token === 'medium') return 0.65;
  if (token === 'low') return 0.4;
  return 0.68;
};
const normalizeTeamMode = (input: TacticalAgentInput): 'BATTING' | 'BOWLING' => {
  const raw =
    input.teamMode ||
    input.matchContext?.teamMode ||
    input.matchContext?.matchMode ||
    input.context?.match?.matchMode ||
    'BOWLING';
  const token = String(raw).trim().toUpperCase();
  return token === 'BAT' || token === 'BATTING' ? 'BATTING' : 'BOWLING';
};
const normalizeFocusRole = (input: TacticalAgentInput, teamMode: 'BATTING' | 'BOWLING'): 'BOWLER' | 'BATTER' => {
  const explicit = String(input.focusRole || '').trim().toUpperCase();
  if (explicit === 'BOWLER' || explicit === 'BATTER') return explicit;
  const roleToken = String(input.telemetry?.role || '').trim().toUpperCase().replace(/[^A-Z]/g, '');
  if (roleToken.includes('BOWL') || roleToken.includes('FAST') || roleToken.includes('SPIN')) return 'BOWLER';
  if (roleToken.includes('ALLROUNDER') || roleToken === 'AR') return teamMode === 'BOWLING' ? 'BOWLER' : 'BATTER';
  return 'BATTER';
};
const normalizeRisk = (value: unknown): 'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN' => {
  const token = String(value || '').trim().toUpperCase();
  if (token === 'LOW') return 'LOW';
  if (token === 'HIGH' || token === 'CRITICAL') return 'HIGH';
  if (token === 'MED' || token === 'MEDIUM') return 'MEDIUM';
  return 'UNKNOWN';
};
const buildTelemetryBasis = (input: TacticalAgentInput): string => {
  const oversBowled = Number(input.telemetry?.oversBowled || 0);
  const fatigueIndex = Number(input.telemetry?.fatigueIndex || 0);
  const strainIndex = Number(input.telemetry?.strainIndex || 0);
  return `Telemetry basis: oversBowled=${oversBowled.toFixed(1)}, fatigueIndex=${fatigueIndex.toFixed(1)}, strainIndex=${strainIndex.toFixed(1)}.`;
};
const toFinite = (value: unknown): number | undefined => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};
const deriveBaselineDirective = (input: TacticalAgentInput): {
  profile: {
    sleepHours?: number;
    recoveryMinutes?: number;
    fatigueLimit?: number;
    role?: string;
    control?: number;
    speed?: number;
    power?: number;
  };
  text: string;
  constrained: boolean;
} => {
  const active = input.context?.roster?.find((entry) => entry.playerId === (input.context?.activePlayerId || input.telemetry?.playerId));
  const sleepHours = toFinite(active?.baseline?.sleepHours ?? input.telemetry?.sleepHours);
  const recoveryMinutes = toFinite(active?.baseline?.recoveryScore ?? input.telemetry?.recoveryMinutes);
  const fatigueLimit = toFinite(active?.baseline?.fatigueLimit ?? input.telemetry?.fatigueLimit);
  const profile = {
    sleepHours,
    recoveryMinutes,
    fatigueLimit,
    role: String(active?.role || input.telemetry?.role || '').trim() || undefined,
    control: toFinite(active?.baseline?.controlBaseline),
    speed: toFinite(active?.baseline?.speed),
    power: toFinite(active?.baseline?.power),
  };
  const hasBaseline =
    Number.isFinite(profile.sleepHours) ||
    Number.isFinite(profile.recoveryMinutes) ||
    Number.isFinite(profile.fatigueLimit);
  if (!hasBaseline) {
    return {
      profile,
      text: 'Baseline not available — using live telemetry only.',
      constrained: false,
    };
  }
  const playerName = String(input.telemetry?.playerName || 'the player');
  const sleepConstrained = Number.isFinite(profile.sleepHours) ? profile.sleepHours! < 7 : false;
  const recoveryConstrained = Number.isFinite(profile.recoveryMinutes) ? profile.recoveryMinutes! < 50 : false;
  const lowCeiling = Number.isFinite(profile.fatigueLimit) ? profile.fatigueLimit! <= 6 : false;
  return {
    profile,
    constrained: sleepConstrained || recoveryConstrained || lowCeiling,
    text: [
      Number.isFinite(profile.sleepHours)
        ? `Given ${playerName} only had ~${profile.sleepHours!.toFixed(1)}h sleep today, control under pressure is less reliable.`
        : null,
      Number.isFinite(profile.recoveryMinutes)
        ? `Recovery window today is ~${Math.round(profile.recoveryMinutes!)}min, so residual load will carry into the next effort.`
        : null,
      Number.isFinite(profile.fatigueLimit)
        ? `Fatigue ceiling for this player is ${profile.fatigueLimit!.toFixed(1)}/10, so recommendations must avoid crossing that threshold.`
        : null,
    ]
      .filter((entry): entry is string => Boolean(entry))
      .join(' '),
  };
};
const outputTextBlob = (output: TacticalAgentOutput): string => {
  const lines = [
    output.immediateAction,
    output.rationale,
    ...(output.suggestedAdjustments || []),
    output.substitutionAdvice?.reason,
    output.substitutionAdvice?.out,
    output.substitutionAdvice?.in,
  ]
    .filter(Boolean)
    .join(' ');
  return lines.toLowerCase();
};
const hasModeViolation = (output: TacticalAgentOutput, teamMode: 'BATTING' | 'BOWLING'): boolean => {
  const text = outputTextBlob(output);
  if (teamMode === 'BOWLING') {
    return /next\s+(safe\s+)?batt(er|sman)|next\s+batter|if wicket falls|send .*batt/.test(text);
  }
  return /next\s+(safe\s+)?bowl(er)?|rotate .*bowl|change .*bowl|substitut.*bowler|switch .*bowler/.test(text);
};
const sanitizeByMode = (
  output: TacticalAgentOutput,
  teamMode: 'BATTING' | 'BOWLING',
  telemetryBasis: string
): TacticalAgentOutput => {
  const forbiddenPattern =
    teamMode === 'BOWLING'
      ? /next\s+(safe\s+)?batt(er|sman)|next\s+batter|if wicket falls|send .*batt/i
      : /next\s+(safe\s+)?bowl(er)?|rotate .*bowl|change .*bowl|substitut.*bowler|switch .*bowler/i;
  const safeAdjustments = (output.suggestedAdjustments || [])
    .filter((item) => !forbiddenPattern.test(item))
    .slice(0, 6);
  if (safeAdjustments.length === 0) {
    if (teamMode === 'BOWLING') {
      safeAdjustments.push(
        'Use a control-first bowling plan for the next over.',
        'Monitor workload and line-length execution after each over.',
        'Escalate rotation only if injury/no-ball risk rises.'
      );
    } else {
      safeAdjustments.push(
        'Adjust batting tempo with low-risk strike rotation.',
        'Plan boundary options by matchup while preserving wicket value.',
        'Name the next batter only as a wicket-fall contingency.'
      );
    }
  }
  return {
    ...output,
    immediateAction: forbiddenPattern.test(output.immediateAction)
      ? teamMode === 'BOWLING'
        ? 'Execute bowling control plan and monitor workload'
        : 'Execute batting tempo plan and preserve wicket value'
      : output.immediateAction,
    rationale: `${output.rationale} ${telemetryBasis}`.trim(),
    suggestedAdjustments: safeAdjustments,
    substitutionAdvice:
      teamMode === 'BATTING' && output.substitutionAdvice && /bowler/i.test(String(output.substitutionAdvice.reason || ''))
        ? undefined
        : output.substitutionAdvice,
    swap:
      teamMode === 'BATTING' && output.swap && /bowler/i.test(String(output.swap.reason || ''))
        ? undefined
        : output.swap,
  };
};
const shouldAvoidImmediateRotation = (input: TacticalAgentInput, teamMode: 'BATTING' | 'BOWLING'): boolean => {
  if (teamMode !== 'BOWLING') return false;
  const oversBowled = Number(input.telemetry?.oversBowled || 0);
  const fatigueIndex = Number(input.telemetry?.fatigueIndex || 0);
  const strainIndex = Number(input.telemetry?.strainIndex || 0);
  const injuryRisk = normalizeRisk(input.telemetry?.injuryRisk);
  const noBallRisk = normalizeRisk(input.telemetry?.noBallRisk);
  return oversBowled <= 0 && fatigueIndex <= 4 && strainIndex <= 2 && injuryRisk !== 'HIGH' && noBallRisk !== 'HIGH';
};
const hasImmediateRotationDirective = (output: TacticalAgentOutput): boolean =>
  /substitut|rotate|switch now|change bowler|immediate/.test(outputTextBlob(output));
const applyRotationGuardrail = (
  output: TacticalAgentOutput,
  input: TacticalAgentInput,
  telemetryBasis: string
): TacticalAgentOutput => {
  if (!shouldAvoidImmediateRotation(input, normalizeTeamMode(input)) || !hasImmediateRotationDirective(output)) {
    return output;
  }
  return {
    ...output,
    immediateAction: 'Continue current bowler with monitored plan',
    rationale:
      `No immediate rotation: oversBowled is 0 and risk signals are not high. ${telemetryBasis}`.trim(),
    suggestedAdjustments: [
      'Continue current bowler for the next over with control-focused lines.',
      'Reassess after one over using oversBowled, fatigueIndex and strainIndex.',
      'Escalate rotation only if injuryRisk or noBallRisk moves to HIGH.',
    ],
    substitutionAdvice: undefined,
    swap: undefined,
  };
};

type TacticalLLMOutput = {
  status?: unknown;
  suggestion?: unknown;
  nextOverPlan?: unknown;
  nextAction?: unknown;
  why?: unknown;
  swap?: unknown;
  ifIgnored?: unknown;
  coachNote?: unknown;
  immediateAction?: unknown;
  rationale?: unknown;
  suggestedAdjustments?: unknown;
  substitutionAdvice?: unknown;
  confidence?: unknown;
  keySignalsUsed?: unknown;
};

const isTacticalOutput = (value: unknown): value is TacticalLLMOutput => {
  const candidate = value as TacticalLLMOutput;
  if (!candidate || typeof candidate !== 'object') return false;
  const hasStructured =
    typeof candidate.nextAction === 'string' &&
    Array.isArray(candidate.why) &&
    candidate.why.every((item) => typeof item === 'string');
  const hasLegacy = (
    typeof candidate.suggestion === 'string' || typeof candidate.immediateAction === 'string'
  ) && (
    Array.isArray(candidate.nextOverPlan) || Array.isArray(candidate.suggestedAdjustments)
  );
  if (hasStructured) return true;
  if (!hasLegacy) return false;
  const nextOverPlan = Array.isArray(candidate.nextOverPlan) ? candidate.nextOverPlan : candidate.suggestedAdjustments;
  return Array.isArray(nextOverPlan) && nextOverPlan.every((item) => typeof item === 'string');
};

const parseStatusFromErrorMessage = (message: string): number | undefined => {
  const match = message.match(/\((\d{3})\)/);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const classifyTacticalFallbackReason = (error: unknown): string => {
  if (error instanceof LLMJsonResponseError) {
    if (error.phase === 'parse') return 'json_parse_failed';
    if (error.phase === 'schema') return 'json_schema_failed';
  }
  if (error instanceof LLMRequestError) {
    if (typeof error.status === 'number') return `openai_http_${error.status}`;
    if (/timed out/i.test(error.message)) return 'openai_timeout';
    return 'openai_error';
  }
  if (error instanceof Error) {
    if (/timed out|abort/i.test(error.message)) return 'openai_timeout';
    const status = parseStatusFromErrorMessage(error.message);
    if (typeof status === 'number') return `openai_http_${status}`;
    if (/json/i.test(error.message)) return 'json_parse_failed';
    return 'openai_error';
  }
  return 'openai_error';
};

const coerceSubstitutionAdvice = (
  value: unknown
): TacticalAgentOutput['substitutionAdvice'] | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const out = String(candidate.out || '').trim();
  const incoming = String(candidate.in || '').trim();
  const reason = String(candidate.reason || '').trim();
  if (!out && !incoming && !reason) return undefined;
  return {
    out: out || 'Current player',
    in: incoming || 'No eligible replacement',
    reason: reason || 'Substitution recommended from tactical model.',
  };
};
const coerceWhyBullets = (value: unknown): string[] => {
  const source = Array.isArray(value) ? value : [];
  return dedupeTextList(source.map((entry) => truncateChars(entry, 90))).slice(0, 2);
};
const coerceIfIgnored = (value: unknown, fallback: string): string =>
  truncateChars(value || fallback, 90) || truncateChars(fallback, 90);
const coerceCoachNote = (value: unknown, fallback: string): string =>
  truncateChars(value || fallback, 110) || truncateChars(fallback, 110);

const coerceTacticalOutput = (
  raw: TacticalLLMOutput,
  teamMode: 'BATTING' | 'BOWLING'
): TacticalAgentOutput => {
  const defaultAdjustments =
    teamMode === 'BATTING'
      ? [
          'Adjust batting tempo and strike rotation for the next over.',
          'Protect wicket value while pressure is rising.',
          'Reassess risk and workload after one over.',
        ]
      : [
          'Apply a control-first bowling plan for the next over.',
          'Monitor workload drift and recovery ball-by-ball.',
          'Reassess rotation decision after one over.',
        ];
  const suggestedAdjustmentsSource = Array.isArray(raw.suggestedAdjustments)
    ? raw.suggestedAdjustments
    : Array.isArray(raw.nextOverPlan)
      ? raw.nextOverPlan
      : [];
  const suggestedAdjustments = suggestedAdjustmentsSource
        .map((entry) => String(entry || '').trim())
        .filter(Boolean)
        .slice(0, 6);
  const dedupedAdjustments = dedupeTextList(suggestedAdjustments.map((entry) => toSingleSentence(entry)));
  const rawWhyBullets = coerceWhyBullets(raw.why);
  const whyBullets = rawWhyBullets.length > 0
    ? rawWhyBullets
    : dedupeTextList([
        truncateChars(raw.rationale, 90),
        truncateChars(raw.suggestion, 90),
        truncateChars(raw.immediateAction, 90),
      ]).slice(0, 2);
  const keySignalsUsed = Array.isArray(raw.keySignalsUsed)
    ? raw.keySignalsUsed.map((entry) => String(entry || '').trim()).filter(Boolean).slice(0, 8)
    : ['oversBowled', 'fatigueIndex', 'strainIndex'];
  const immediateAction = truncateChars(
    raw.nextAction || raw.immediateAction || raw.suggestion || 'Continue with monitored tactical plan',
    70
  ) || 'Continue with monitored tactical plan';
  let rationale = truncateChars(raw.rationale || whyBullets[0] || 'Tactical recommendation generated from live telemetry.', 90)
    || 'Tactical recommendation generated from live telemetry.';
  if (rationale.toLowerCase() === immediateAction.toLowerCase()) {
    rationale = 'Action selected from current telemetry and risk context.';
  }
  const swap = coerceSubstitutionAdvice(raw.swap) || coerceSubstitutionAdvice(raw.substitutionAdvice);
  const ifIgnored = coerceIfIgnored(raw.ifIgnored, 'Execution risk may increase if this plan is delayed.');
  const coachNote = coerceCoachNote(raw.coachNote, 'Apply this plan for one over, then reassess live risk signals.');
  return {
    status: 'ok',
    immediateAction,
    rationale,
    suggestedAdjustments: dedupedAdjustments.length > 0 ? dedupedAdjustments.slice(0, 6) : defaultAdjustments,
    substitutionAdvice: swap,
    nextAction: immediateAction,
    why: whyBullets,
    swap,
    ifIgnored,
    coachNote,
    confidence: Number(normalizeConfidenceScore(raw.confidence).toFixed(2)),
    keySignalsUsed,
  };
};

const normalizeNameKey = (value: unknown): string => String(value || '').trim().toLowerCase();
const listEligibleReplacements = (
  input: TacticalAgentInput,
  teamMode: 'BATTING' | 'BOWLING'
): Array<{ playerId: string; name: string; role?: string; reason?: string }> => {
  const fromReplacementCandidates = Array.isArray(input.replacementCandidates)
    ? input.replacementCandidates
        .filter((candidate) => isEligibleForMode(candidate, teamMode))
        .map((candidate) => ({
          playerId: candidate.playerId,
          name: candidate.name,
          role: candidate.role,
          reason: candidate.reason,
        }))
    : [];

  const fromContextRoster = Array.isArray(input.context?.roster)
    ? input.context.roster
        .filter(
          (player) =>
            player.playerId !== input.context?.activePlayerId &&
            isEligibleForMode(player, teamMode)
        )
        .map((player) => ({
          playerId: player.playerId,
          name: player.name,
          role: player.role,
          reason: `Mode-eligible ${teamMode.toLowerCase()} replacement from roster.`,
        }))
    : [];

  const seen = new Set<string>();
  const merged: Array<{ playerId: string; name: string; role?: string; reason?: string }> = [];
  [...fromReplacementCandidates, ...fromContextRoster].forEach((candidate) => {
    const key = candidate.playerId || normalizeNameKey(candidate.name);
    if (!key || seen.has(key)) return;
    seen.add(key);
    merged.push(candidate);
  });

  return merged;
};

const pickBenchReplacement = (input: TacticalAgentInput, teamMode: 'BATTING' | 'BOWLING'): string => {
  const eligible = listEligibleReplacements(input, teamMode);
  if (eligible.length > 0) return eligible[0].name;
  return teamMode === 'BOWLING'
    ? 'No eligible bowler available for current mode'
    : 'No eligible batter available for current mode';
};

const isNamedReplacementEligible = (
  replacementToken: string,
  input: TacticalAgentInput,
  teamMode: 'BATTING' | 'BOWLING'
): boolean =>
  listEligibleReplacements(input, teamMode).some(
    (candidate) =>
      normalizeNameKey(candidate.name) === normalizeNameKey(replacementToken) ||
      normalizeNameKey(candidate.playerId) === normalizeNameKey(replacementToken)
  );

const enforceSubstitutionEligibility = (
  output: TacticalAgentOutput,
  input: TacticalAgentInput,
  teamMode: 'BATTING' | 'BOWLING'
): TacticalAgentOutput => {
  if (!output.substitutionAdvice) return output;

  const replacementName = String(output.substitutionAdvice.in || '').trim();
  if (replacementName && isNamedReplacementEligible(replacementName, input, teamMode)) {
    return output;
  }

  const fallbackReplacement = pickBenchReplacement(input, teamMode);
  if (/^No eligible/i.test(fallbackReplacement)) {
    return {
      ...output,
      substitutionAdvice: undefined,
      swap: undefined,
      rationale: `${output.rationale} Mode guard: ${fallbackReplacement}.`.trim(),
      suggestedAdjustments: [
        ...output.suggestedAdjustments.filter(Boolean),
        'No eligible replacement available for current mode.',
      ].slice(0, 6),
    };
  }

  return {
    ...output,
    substitutionAdvice: {
      ...output.substitutionAdvice,
      in: fallbackReplacement,
      reason: `${String(output.substitutionAdvice.reason || '').trim()} Mode guard selected an eligible replacement.`
        .trim(),
    },
    swap: {
      ...(output.swap || output.substitutionAdvice),
      in: fallbackReplacement,
      reason: `${String(output.substitutionAdvice.reason || '').trim()} Mode guard selected an eligible replacement.`
        .trim(),
    },
  };
};

const compactTacticalContext = (input: TacticalAgentInput) => {
  if (!input.context) return undefined;
  const active = input.context.roster.find((entry) => entry.playerId === input.context?.activePlayerId);
  return {
    match: input.context.match,
    active: active
      ? {
          playerId: active.playerId,
          role: active.role,
          fatigueIndex: active.live.fatigueIndex,
          injuryRisk: active.live.injuryRisk,
          noBallRisk: active.live.noBallRisk,
          oversBowled: active.live.oversBowled,
        }
      : undefined,
    replacementCandidates: (input.replacementCandidates || []).slice(0, 3),
  };
};

export function buildTacticalFallback(input: TacticalAgentInput, reason: string): TacticalAgentResult {
  const fatigueIndex = Number(input.telemetry.fatigueIndex) || 0;
  const injuryRisk = String(input.telemetry.injuryRisk || 'MEDIUM').toUpperCase();
  const noBallRisk = String(input.telemetry.noBallRisk || 'MEDIUM').toUpperCase();
  const teamMode = normalizeTeamMode(input);
  const telemetryBasis = buildTelemetryBasis(input);
  const baselineDirective = deriveBaselineDirective(input);
  const poorRecovery = ['poor', 'very poor'].includes(String(input.telemetry.heartRateRecovery || '').toLowerCase());
  const replacementCandidate = listEligibleReplacements(input, teamMode)[0];
  const replacement = replacementCandidate?.name || pickBenchReplacement(input, teamMode);
  const hasEligibleReplacement = Boolean(replacementCandidate) && !/^No eligible/i.test(replacement);
  const outToken = String(input.telemetry.playerId || input.telemetry.playerName || input.players.bowler || 'Current player');
  const inToken = String(replacementCandidate?.playerId || replacement);
  const shouldSubstitute = hasEligibleReplacement && (injuryRisk === 'HIGH' || injuryRisk === 'CRITICAL' || fatigueIndex >= 7 || poorRecovery);
  const whyBullets = shouldSubstitute
    ? [
        truncateChars(`Fatigue ${fatigueIndex.toFixed(1)} with injury risk ${injuryRisk}.`, 90),
        truncateChars('Baseline recovery is constrained for repeated high-load spells.', 90),
      ]
    : [
        truncateChars(`Risk is ${injuryRisk} and fatigue is ${fatigueIndex.toFixed(1)}.`, 90),
        truncateChars('One controlled over is acceptable with immediate reassessment.', 90),
      ];
  const ifIgnored = truncateChars('Risk can escalate quickly in the next over under sustained load.', 90);
  const coachNote = truncateChars(`${baselineDirective.text} ${telemetryBasis}`, 110);
  const suggestedAdjustments =
    teamMode === 'BATTING'
      ? [
          'Adjust batting tempo and strike rotation for the next over.',
          'Avoid high-risk boundary attempts until pressure stabilizes.',
          'If wicket falls next, send the safest available batting option from bench.',
        ]
      : shouldSubstitute
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
      immediateAction:
        teamMode === 'BATTING'
          ? 'Adjust batting plan and protect wicket value'
          : shouldSubstitute
            ? 'Substitute now and rotate workload'
            : 'Continue with monitored plan',
      nextAction:
        teamMode === 'BATTING'
          ? 'Adjust batting plan and protect wicket value'
          : shouldSubstitute
            ? 'Substitute now and rotate workload'
            : 'Continue with monitored plan',
      rationale: shouldSubstitute
        ? `Heuristic fallback: elevated risk (injury ${injuryRisk}, fatigue ${fatigueIndex.toFixed(1)}, no-ball ${noBallRisk}). ${baselineDirective.text} ${telemetryBasis}`
        : `Heuristic fallback: current risk remains manageable (injury ${injuryRisk}, fatigue ${fatigueIndex.toFixed(1)}). ${baselineDirective.text} ${telemetryBasis}`,
      why: whyBullets,
      suggestedAdjustments,
      ifIgnored,
      coachNote,
      swap: shouldSubstitute
        ? {
            out: outToken,
            in: inToken,
            reason: truncateChars('Workload protection recommended due to elevated fatigue and risk.', 90),
          }
        : undefined,
      substitutionAdvice: shouldSubstitute
        ? {
            out: outToken,
            in: inToken,
            reason: truncateChars('Workload protection recommended due to elevated fatigue and risk.', 90),
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
    console.log('[tactical][openai] config', {
      hasEndpoint: aoai.ok ? true : !aoai.missing.includes('AZURE_OPENAI_ENDPOINT'),
      hasDeployment: Boolean(routing.deployment),
      hasApiVersion: aoai.ok,
      missing: aoai.ok ? [] : aoai.missing,
    });
    return buildTacticalFallback(input, `missing:${(aoai.ok ? ['AZURE_OPENAI_DEPLOYMENT'] : aoai.missing).join(',')}`);
  }
  const endpointHost = (() => {
    try {
      return new URL(aoai.config.endpoint).host;
    } catch {
      return String(aoai.config.endpoint || '').replace(/^https?:\/\//i, '').split('/')[0] || 'unknown';
    }
  })();
  console.log('[tactical][openai] config', {
    endpointHost,
    deployment: routing.deployment,
    apiVersion: aoai.config.apiVersion,
  });
  const teamMode = normalizeTeamMode(input);
  const focusRole = normalizeFocusRole(input, teamMode);
  const telemetryBasis = buildTelemetryBasis(input);
  const baselineDirective = deriveBaselineDirective(input);
  const teamModeInstruction =
    teamMode === 'BOWLING'
      ? 'Team mode is BOWLING. Recommend only bowling actions (next safe bowler, bowling field plan, workload safety). Never mention next batter.'
      : 'Team mode is BATTING. Recommend only batting actions (next batter only as wicket-fall contingency, chase strategy, strike rotation). Never mention next bowler.';

  const messages: LLMMessage[] = [
    {
      role: 'system',
      content:
        'You are a cricket tactical coach agent. Return only valid JSON. ' +
        'Required keys: nextAction (<=70 chars), why (array with exactly 2 bullets, each <=90 chars), ifIgnored (<=90 chars), coachNote (<=110 chars). ' +
        'Optional key: swap object {out: playerId, in: playerId, reason <=90 chars}. ' +
        'Also include compatibility keys: immediateAction, rationale, suggestedAdjustments when possible. ' +
        `${teamModeInstruction} Always justify recommendations with telemetry values oversBowled, fatigueIndex, strainIndex. ` +
        'If oversBowled is 0 and fatigueIndex/strainIndex are safe with no HIGH risk flag, do not call immediate rotation. ' +
        'You MUST explicitly reference baseline sleepHours, recoveryMinutes, and fatigueLimit when provided. ' +
        'Your answer will be rejected if you do not mention baseline sleep and recovery when provided. ' +
        'If baseline is missing, say: "Baseline not available — using live telemetry only."',
    },
    {
      role: 'user',
      content: JSON.stringify({
        task: 'Provide immediate tactical coaching recommendation using only the input data and constraints.',
        teamMode,
        focusRole,
        constraints: {
          modeStrictness: teamModeInstruction,
          telemetryRequired: ['oversBowled', 'fatigueIndex', 'strainIndex'],
          baselineRequired:
            'When baseline exists, mention sleepHours + recoveryMinutes + fatigueLimit and explain how they change the action.',
          noImmediateRotationRule:
            'If oversBowled=0 and fatigueIndex<=4 and strainIndex<=2 and injury/no-ball risk are not HIGH, avoid immediate bowler rotation.',
        },
        baseline: baselineDirective.profile,
        input,
        context: compactTacticalContext(input),
      }),
    },
  ];

  try {
    const llmCall = (baseMessages: LLMMessage[]) =>
      callLLMJsonWithRetry<TacticalLLMOutput>({
        deployment: routing.deployment,
        fallbackDeployment: routing.fallbackDeployment,
        baseMessages,
        strictSystemMessage:
          'Return ONLY valid JSON. No markdown. Required keys: nextAction, why, ifIgnored, coachNote. Optional key: swap {out,in,reason}. Keep text short. Include compatibility keys immediateAction/rationale if present.',
        validate: isTacticalOutput,
        temperature: routing.temperature,
        maxTokens: routing.maxTokens,
        timeoutMs: 10000,
        retryOnTransient: true,
      });

    const initial = await llmCall(messages);
    let parsed: TacticalAgentOutput = coerceTacticalOutput(initial.parsed, teamMode);
    let deploymentUsed = initial.deploymentUsed;
    let fallbacksUsed = [...initial.fallbacksUsed];

    if (hasModeViolation(parsed, teamMode)) {
      const correctionMessages: LLMMessage[] = [
        ...messages,
        { role: 'assistant', content: JSON.stringify(parsed) },
        {
          role: 'user',
          content:
            `Correction required: output violated ${teamMode} constraints. ` +
            `${teamModeInstruction} Reissue compliant JSON only.`,
        },
      ];
      const corrected = await llmCall(correctionMessages);
      parsed = coerceTacticalOutput(corrected.parsed, teamMode);
      deploymentUsed = corrected.deploymentUsed;
      fallbacksUsed = [...new Set([...fallbacksUsed, ...corrected.fallbacksUsed, 'mode-correction-retry'])];
    }

    if (hasModeViolation(parsed, teamMode)) {
      parsed = sanitizeByMode(parsed, teamMode, telemetryBasis);
      fallbacksUsed = [...new Set([...fallbacksUsed, 'mode-sanitized'])];
    }

    if (!/oversbowled|fatigueindex|strainindex/i.test(parsed.rationale)) {
      parsed.rationale = truncateChars(`${parsed.rationale} ${telemetryBasis}`.trim(), 90);
    }
    if (!parsed.coachNote || !/baseline|sleep|recovery|fatigue ceiling|fatigue limit/i.test(parsed.coachNote)) {
      parsed.coachNote = truncateChars(`${baselineDirective.text} ${telemetryBasis}`.trim(), 110);
    }
    if (baselineDirective.constrained && teamMode === 'BOWLING' && !/rotate|substitut|switch/i.test(parsed.immediateAction.toLowerCase())) {
      parsed.immediateAction = `Rotate ${input.telemetry.playerName || 'current bowler'} now and shorten the next spell`;
    }
    parsed = applyRotationGuardrail(parsed, input, telemetryBasis);
    parsed = enforceSubstitutionEligibility(parsed, input, teamMode);
    parsed.nextAction = truncateChars(parsed.nextAction || parsed.immediateAction, 70) || parsed.immediateAction;
    parsed.why = dedupeTextList((parsed.why || [parsed.rationale]).map((entry) => truncateChars(entry, 90))).slice(0, 2);
    parsed.ifIgnored = truncateChars(parsed.ifIgnored || parsed.suggestedAdjustments?.[0] || 'Risk may increase if unchanged.', 90);
    parsed.coachNote = truncateChars(parsed.coachNote || `${baselineDirective.text} ${telemetryBasis}`, 110);
    parsed.rationale = truncateChars(parsed.rationale, 90);

    return {
      output: parsed,
      model: deploymentUsed,
      fallbacksUsed,
    };
  } catch (error) {
    const status =
      error instanceof LLMRequestError ? error.status : parseStatusFromErrorMessage(error instanceof Error ? error.message : '');
    if (typeof status === 'number') {
      console.log('[tactical][openai] status', status);
    }
    if (error instanceof LLMJsonResponseError && error.rawSnippet) {
      console.log('[tactical][openai] body', error.rawSnippet.slice(0, 200));
    } else if (error instanceof LLMRequestError && error.bodySnippet) {
      console.log('[tactical][openai] body', error.bodySnippet.slice(0, 200));
    }
    const reason = classifyTacticalFallbackReason(error);
    console.log('[tactical] fallback reason:', reason);
    return buildTacticalFallback(input, reason);
  }
}
