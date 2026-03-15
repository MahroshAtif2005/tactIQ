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
const trimToSentenceBoundary = (value: unknown, maxChars: number): string => {
  const normalized = normalizeText(value);
  if (!normalized || normalized.length <= maxChars) return normalized;
  const clipped = normalized.slice(0, Math.max(0, maxChars)).trim();
  const punctuationIndex = Math.max(clipped.lastIndexOf('.'), clipped.lastIndexOf('!'), clipped.lastIndexOf('?'));
  if (punctuationIndex >= Math.floor(maxChars * 0.45)) {
    return clipped.slice(0, punctuationIndex + 1).trim();
  }
  const lastSpace = clipped.lastIndexOf(' ');
  if (lastSpace >= Math.floor(maxChars * 0.55)) {
    return clipped.slice(0, lastSpace).trim();
  }
  return clipped;
};
const sanitizeSentenceTail = (value: unknown): string =>
  String(value || '')
    .replace(/(?:\.\.\.|…)+\s*$/g, '')
    .replace(/[,:;/-]\s*$/g, '')
    .replace(/\b(?:based on|instead of|if|because|while|with)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
const isIncompleteSentence = (value: string): boolean => {
  const normalized = normalizeText(value);
  if (!normalized) return true;
  if (/(?:\.\.\.|…)\s*$/.test(normalized)) return true;
  if (/\b(?:based on|instead of|if|because|while|with)\.?\s*$/i.test(normalized)) return true;
  if (/\b(?:based|instead|after|before|during|for|to|with|if|because|while|the|a|an)\.?\s*$/i.test(normalized)) return true;
  if (/[,:;/-]\.?\s*$/.test(normalized)) return true;
  if (/\b(?:to|and|or)\.?\s*$/i.test(normalized)) return true;
  return false;
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
const getFormatMaxOvers = (format?: string): number => {
  const token = String(format || '').trim().toUpperCase();
  if (token === 'T20') return 4;
  if (token === 'ODI') return 10;
  return 12;
};
type CoachRiskBand = 'LOW' | 'MODERATE' | 'HIGH';
const normalizeRecoveryToken = (value: unknown): 'GOOD' | 'MODERATE' | 'POOR' => {
  const token = String(value || '').trim().toUpperCase();
  if (token.includes('POOR') || token.includes('SLOW') || token.includes('VERY')) return 'POOR';
  if (token.includes('MODERATE') || token.includes('FAIR')) return 'MODERATE';
  return 'GOOD';
};
const toCoachRiskBand = (score: number): CoachRiskBand => {
  if (score >= 0.67) return 'HIGH';
  if (score >= 0.36) return 'MODERATE';
  return 'LOW';
};
const buildTacticalDecisionInputs = (
  input: TacticalAgentInput,
  teamMode: 'BATTING' | 'BOWLING',
  focusRole: 'BOWLER' | 'BATTER',
  baselineDirective: {
    profile: {
      sleepHours?: number;
      recoveryMinutes?: number;
      fatigueLimit?: number;
      role?: string;
      control?: number;
      speed?: number;
      power?: number;
    };
    constrained: boolean;
  }
) => {
  const requiredRunRate = Number(input.matchContext?.requiredRunRate || 0);
  const currentRunRate = Number(input.matchContext?.currentRunRate || 0);
  const runRatePressure = Number((requiredRunRate - currentRunRate).toFixed(2));
  const scoreboardPressureScore = Math.max(0, Math.min(1, runRatePressure > 0 ? runRatePressure / 2.4 : 0));
  const scoreboardPressure = toCoachRiskBand(scoreboardPressureScore);

  const fatigueIndex = Math.max(0, Number(input.telemetry?.fatigueIndex || 0));
  const strainIndex = Math.max(0, Number(input.telemetry?.strainIndex || 0));
  const injuryRiskToken = normalizeRisk(input.telemetry?.injuryRisk);
  const noBallRiskToken = normalizeRisk(input.telemetry?.noBallRisk);
  const recoveryToken = normalizeRecoveryToken(input.telemetry?.heartRateRecovery);
  const oversBowled = Math.max(0, Number(input.telemetry?.oversBowled || 0));
  const oversRemaining = Number.isFinite(Number(input.telemetry?.oversRemaining))
    ? Math.max(0, Number(input.telemetry?.oversRemaining))
    : undefined;
  const maxOvers = Number.isFinite(Number(input.telemetry?.maxOvers))
    ? Math.max(1, Number(input.telemetry?.maxOvers))
    : getFormatMaxOvers(input.matchContext?.format);
  const fatigueLimit = Number.isFinite(Number(input.telemetry?.fatigueLimit))
    ? Math.max(1, Number(input.telemetry?.fatigueLimit))
    : undefined;

  const injuryWeight = injuryRiskToken === 'HIGH' ? 0.22 : injuryRiskToken === 'MEDIUM' ? 0.1 : 0.03;
  const noBallWeight = noBallRiskToken === 'HIGH' ? 0.26 : noBallRiskToken === 'MEDIUM' ? 0.12 : 0.03;
  const recoveryWeight = recoveryToken === 'POOR' ? 0.18 : recoveryToken === 'MODERATE' ? 0.09 : 0.03;
  const fatigueWeight = Math.max(0, Math.min(1, fatigueIndex / 10));
  const strainWeight = Math.max(0, Math.min(1, strainIndex / 10));

  const dismissalRiskScore = Math.max(
    0,
    Math.min(1, fatigueWeight * 0.36 + strainWeight * 0.24 + scoreboardPressureScore * 0.22 + injuryWeight + recoveryWeight * 0.7)
  );
  const controlExecutionRiskScore = Math.max(
    0,
    Math.min(1, fatigueWeight * 0.26 + strainWeight * 0.24 + noBallWeight + recoveryWeight + scoreboardPressureScore * 0.14)
  );
  const dismissalRisk = toCoachRiskBand(dismissalRiskScore);
  const controlExecutionRisk = toCoachRiskBand(controlExecutionRiskScore);

  const alternatives = listEligibleReplacements(input, teamMode).slice(0, 3).map((candidate) => ({
    playerId: candidate.playerId,
    name: candidate.name,
    role: candidate.role,
    reason: candidate.reason,
  }));

  return {
    matchState: {
      teamMode,
      focusRole,
      phase: String(input.matchContext?.phase || '').toLowerCase(),
      format: String(input.matchContext?.format || ''),
      score: Number.isFinite(Number(input.matchContext?.score)) ? Number(input.matchContext?.score) : undefined,
      wicketsInHand: Number.isFinite(Number(input.matchContext?.wicketsInHand))
        ? Number(input.matchContext?.wicketsInHand)
        : undefined,
      over: Number.isFinite(Number(input.matchContext?.over)) ? Number(input.matchContext?.over) : undefined,
      balls: Number.isFinite(Number(input.matchContext?.balls)) ? Number(input.matchContext?.balls) : undefined,
      target: Number.isFinite(Number(input.matchContext?.target)) ? Number(input.matchContext?.target) : undefined,
      intensity: String(input.matchContext?.intensity || ''),
      conditions: String(input.matchContext?.conditions || ''),
      requiredRunRate: Number(requiredRunRate.toFixed(2)),
      currentRunRate: Number(currentRunRate.toFixed(2)),
      runRatePressure,
      scoreboardPressure,
    },
    playerPhysicalRisk: {
      playerId: String(input.telemetry?.playerId || ''),
      playerName: String(input.telemetry?.playerName || ''),
      role: String(input.telemetry?.role || ''),
      fatigueIndex: Number(fatigueIndex.toFixed(1)),
      strainIndex: Number(strainIndex.toFixed(1)),
      injuryRisk: injuryRiskToken,
      noBallRisk: noBallRiskToken,
      heartRateRecovery: recoveryToken,
      oversBowled: Number(oversBowled.toFixed(1)),
      oversRemaining,
      maxOvers,
      fatigueLimit,
      sleepHours: baselineDirective.profile.sleepHours,
      recoveryMinutes: baselineDirective.profile.recoveryMinutes,
      baselineConstrained: baselineDirective.constrained,
      dismissalRisk,
      controlExecutionRisk,
    },
    alternatives,
    fatigueSignalSummary: input.fatigueOutput
      ? {
          headline: input.fatigueOutput.headline,
          severity: input.fatigueOutput.severity,
          recommendation: input.fatigueOutput.recommendation,
        }
      : undefined,
    riskSignalSummary: input.riskOutput
      ? {
          headline: input.riskOutput.headline,
          severity: input.riskOutput.severity,
          recommendation: input.riskOutput.recommendation,
        }
      : undefined,
  };
};
const sanitizeLine = (value: unknown, fallback: string, maxChars = 120): string => {
  const normalized = String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/\b([a-z]+)(?:\s*,\s*\1\b)+/gi, '$1')
    .replace(/\b([a-z]+)(?:\s+\1\b){1,}/gi, '$1')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();
  const broken =
    !normalized ||
    /(?:\bof\.?$|\bof$| of and )/i.test(normalized) ||
    /\bis\s*,\s*is\b/i.test(normalized);
  const finalize = (candidate: unknown): string => {
    const bounded = trimToSentenceBoundary(candidate, maxChars);
    const cleaned = sanitizeSentenceTail(
      String(bounded || '')
        .replace(/\s+([,.;:!?])/g, '$1')
        .trim()
    );
    if (!cleaned) return '';
    return /[.!?]$/.test(cleaned) ? cleaned : `${cleaned}.`;
  };
  if (broken) {
    const safeFallback = finalize(fallback);
    return safeFallback && !isIncompleteSentence(safeFallback) ? safeFallback : '';
  }
  const primary = finalize(normalized);
  if (primary && !isIncompleteSentence(primary)) return primary;
  const safeFallback = finalize(fallback);
  if (safeFallback && !isIncompleteSentence(safeFallback)) return safeFallback;
  return '';
};
const sanitizeBullets = (items: Array<unknown>, max = 3): string[] =>
  dedupeTextList(
    items
      .map((entry) => sanitizeLine(entry, '', 90))
      .filter((entry) => entry.length > 0)
      .filter((entry) => !/(?:\bof\.?$|\bof$| of and )/i.test(entry))
  ).slice(0, max);
const buildStructuredTradeoff = (
  teamMode: 'BATTING' | 'BOWLING',
  decisionInputs: ReturnType<typeof buildTacticalDecisionInputs>,
  playerName: string
): string => {
  const subject = sanitizeLine(playerName, 'the current player', 40).replace(/[.!?]$/g, '') || 'the current player';
  const dismissalRisk = String(decisionInputs.playerPhysicalRisk.dismissalRisk || 'MODERATE').toLowerCase();
  const controlRisk = String(decisionInputs.playerPhysicalRisk.controlExecutionRisk || 'MODERATE').toLowerCase();
  const phaseToken = String(decisionInputs.matchState.phase || '').trim().toLowerCase();
  const phaseLabel = phaseToken ? `${phaseToken} phase` : 'current phase';
  const pressureToken = String(decisionInputs.matchState.scoreboardPressure || 'MODERATE').toLowerCase();

  if (teamMode === 'BATTING') {
    const battingRiskClause =
      dismissalRisk === 'high'
        ? `high dismissal exposure can rise further if ${pressureToken} pressure spikes`
        : dismissalRisk === 'moderate'
          ? `moderate dismissal exposure remains if ${pressureToken} pressure rises`
          : `dismissal exposure can still rise if workload and pressure drift upward`;
    return `Keeping ${subject} preserves continuity at the crease and avoids exposing a new batter, but ${battingRiskClause}.`;
  }

  const bowlingRiskClause =
    controlRisk === 'high'
      ? 'fatigue drift is now increasing control execution risk'
      : controlRisk === 'moderate'
        ? 'ongoing fatigue drift can push execution risk higher under pressure'
        : 'continued workload can still elevate control risk if pressure increases';
  return `Allowing another over preserves the matchup value in the ${phaseLabel}, but ${bowlingRiskClause}.`;
};
const normalizeTradeoffSentence = (
  value: unknown,
  teamMode: 'BATTING' | 'BOWLING',
  decisionInputs: ReturnType<typeof buildTacticalDecisionInputs>,
  playerName: string
): string => {
  const fallback = buildStructuredTradeoff(teamMode, decisionInputs, playerName);
  const cleaned = sanitizeLine(value, fallback, 200);
  if (!cleaned) return fallback;
  const lower = cleaned.toLowerCase();
  const circular =
    /(risk|exposure)\s+(?:due to|because of)\s+(risk|exposure)/i.test(cleaned) ||
    /dismissal risk[^.]{0,80}dismissal risk/i.test(cleaned) ||
    /control risk[^.]{0,80}control risk/i.test(cleaned);
  const weakBenefit = /stability in the batting order/i.test(cleaned);
  const missingContrast = !/\bbut\b/i.test(cleaned);
  const nonCricketGeneric = !/(crease|batter|phase|fatigue drift|control risk|dismissal exposure|matchup)/i.test(lower);
  if (circular || weakBenefit || missingContrast || nonCricketGeneric) return fallback;
  return cleaned;
};
const applyTacticalDefaults = (input: TacticalAgentInput): TacticalAgentInput => {
  const bowlerName = sanitizeLine(input.telemetry?.playerName || input.players?.bowler, 'Current bowler', 80);
  const fatigueIndex = Number.isFinite(Number(input.telemetry?.fatigueIndex)) ? Number(input.telemetry?.fatigueIndex) : 0;
  const fatigueLimit = Number.isFinite(Number(input.telemetry?.fatigueLimit)) ? Number(input.telemetry?.fatigueLimit) : 7;
  const oversBowled = Number.isFinite(Number(input.telemetry?.oversBowled)) ? Number(input.telemetry?.oversBowled) : 0;
  const strainIndex = Number.isFinite(Number(input.telemetry?.strainIndex)) ? Number(input.telemetry?.strainIndex) : 0;
  const injuryRisk = normalizeRisk(input.telemetry?.injuryRisk) === 'UNKNOWN' ? 'LOW' : normalizeRisk(input.telemetry?.injuryRisk);
  const noBallRisk = normalizeRisk(input.telemetry?.noBallRisk) === 'UNKNOWN' ? 'LOW' : normalizeRisk(input.telemetry?.noBallRisk);
  const recovery = sanitizeLine(input.telemetry?.heartRateRecovery, 'Good', 16);
  return {
    ...input,
    players: {
      ...input.players,
      bowler: sanitizeLine(input.players?.bowler || bowlerName, 'Current bowler', 80),
    },
    telemetry: {
      ...input.telemetry,
      playerName: bowlerName,
      fatigueIndex,
      fatigueLimit,
      oversBowled,
      strainIndex,
      injuryRisk,
      noBallRisk,
      heartRateRecovery: recovery,
    },
  };
};
const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const normalizeModeToken = (value: unknown): 'auto' | 'full' =>
  String(value || '').trim().toLowerCase() === 'full' ? 'full' : 'auto';
const normalizeDataModeToken = (value: unknown): 'demo' | 'live' =>
  String(value || '').trim().toLowerCase() === 'demo' ? 'demo' : 'live';
const isManualCoachRequest = (input: TacticalAgentInput): boolean => {
  const signals = asRecord(input.signals);
  const actionToken = normalizeText(input.userAction || signals.userAction).toLowerCase();
  if (/(^|[^a-z])(run[_\s-]?coach|manual|button[_\s-]?click|coach_analysis|coach)([^a-z]|$)/i.test(actionToken)) {
    return true;
  }
  return (
    signals.manual === true ||
    signals.manualRequest === true ||
    signals.manualTrigger === true ||
    normalizeText(signals.requestOrigin).toLowerCase() === 'manual' ||
    normalizeText(signals.requestType).toLowerCase() === 'manual' ||
    normalizeText(signals.trigger).toLowerCase() === 'manual' ||
    normalizeText(signals.trigger).toLowerCase() === 'button'
  );
};
type StableContinueGuardrailDecision = {
  stableState: boolean;
  applied: boolean;
  requestType: 'manual' | 'automatic';
  bypassReason?: 'manual_request' | 'demo_auto_mode';
  oversBowled: number;
  fatigueIndex: number;
  injuryRisk: 'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN';
  requestMode: 'auto' | 'full';
  dataMode: 'demo' | 'live';
};
const evaluateStableContinueGuardrail = (
  input: TacticalAgentInput,
  teamMode: 'BATTING' | 'BOWLING'
): StableContinueGuardrailDecision => {
  const oversBowled = Number(input.telemetry?.oversBowled || 0);
  const fatigueIndex = Number(input.telemetry?.fatigueIndex || 0);
  const injuryRisk = normalizeRisk(input.telemetry?.injuryRisk);
  const requestMode = normalizeModeToken(input.requestMode);
  const dataMode = normalizeDataModeToken(input.dataMode);
  const manualRequest = isManualCoachRequest(input);
  const stableState =
    teamMode === 'BOWLING' &&
    (oversBowled === 0 || (fatigueIndex <= 4 && injuryRisk === 'LOW'));
  const bypassReason = manualRequest
    ? 'manual_request'
    : dataMode === 'demo' && requestMode === 'auto'
      ? 'demo_auto_mode'
      : undefined;
  return {
    stableState,
    applied: stableState && !bypassReason,
    requestType: manualRequest ? 'manual' : 'automatic',
    bypassReason,
    oversBowled,
    fatigueIndex,
    injuryRisk,
    requestMode,
    dataMode,
  };
};
const logStableContinueGuardrail = (
  decision: StableContinueGuardrailDecision,
  input: TacticalAgentInput,
  reason: string
): void => {
  if (!decision.stableState) return;
  console.log('[tactical] guardrail:stable_continue', {
    applied: decision.applied,
    reason: decision.applied ? reason : decision.bypassReason || 'bypassed',
    requestType: decision.requestType,
    requestMode: decision.requestMode,
    dataMode: decision.dataMode,
    userAction: normalizeText(input.userAction) || undefined,
    oversBowled: decision.oversBowled,
    fatigueIndex: decision.fatigueIndex,
    injuryRisk: decision.injuryRisk,
  });
};
const shouldForceContinueGuardrail = (input: TacticalAgentInput, teamMode: 'BATTING' | 'BOWLING'): boolean => {
  return evaluateStableContinueGuardrail(input, teamMode).applied;
};
const buildContinueGuardrailOutput = (input: TacticalAgentInput, status: TacticalAgentOutput['status']): TacticalAgentOutput => {
  const teamMode = normalizeTeamMode(input);
  const bowlerName = sanitizeLine(input.telemetry?.playerName || input.players?.bowler, 'Current bowler', 80);
  const oversBowled = Number(input.telemetry?.oversBowled || 0);
  const fatigueIndex = Number(input.telemetry?.fatigueIndex || 0);
  const recovery = sanitizeLine(input.telemetry?.heartRateRecovery, 'Good', 16);
  const maxOvers = Number.isFinite(Number(input.telemetry?.maxOvers))
    ? Number(input.telemetry.maxOvers)
    : getFormatMaxOvers(input.matchContext?.format);
  const alternatives = listEligibleReplacements(input, teamMode)
    .slice(0, 3)
    .map((candidate) => candidate.name)
    .filter(Boolean);
  const whyBullets = [
    `Overs bowled: ${oversBowled.toFixed(1)}/${Math.max(1, maxOvers)}; no overuse signal.`,
    `Fatigue: ${fatigueIndex.toFixed(1)}/10; recovery: ${recovery}.`,
    'Risk is low; maintain control-focused lines.',
  ];
  const optionsLine = alternatives.length > 0 ? `Other options: ${alternatives.join(', ')}.` : '';
  return {
    status,
    immediateAction: `Continue with ${bowlerName} for the next over — projected fatigue remains within safe range.`,
    nextAction: `Continue with ${bowlerName} for the next over — projected fatigue remains within safe range.`,
    decision: `Continue with ${bowlerName} for the next over — projected fatigue remains within safe range.`,
    assessment: `${bowlerName} remains within safe workload and recovery boundaries for this phase.`,
    tradeoff:
      `Keeping ${bowlerName} preserves control continuity in this phase, but cumulative workload can still increase execution risk if intensity rises.`,
    decisionRationale: 'Control stability and workload profile support one controlled continuation over.',
    rationale: `${bowlerName} is in a safe state to continue this spell.`,
    suggestedAdjustments: optionsLine ? [...whyBullets, optionsLine] : [...whyBullets],
    why: [...whyBullets],
    ifIgnored: 'Minimal risk; monitor strain if tempo increases.',
    coachNote: alternatives.length > 0 ? optionsLine : 'No immediate replacement required.',
    confidence: 0.82,
    keySignalsUsed: ['oversBowled', 'fatigueIndex', 'injuryRisk', 'heartRateRecovery', 'guardrail:stable_continue'],
  };
};
const sanitizeTacticalOutput = (output: TacticalAgentOutput): TacticalAgentOutput => {
  const immediateAction = sanitizeLine(output.immediateAction, 'Continue with monitored tactical plan', 70);
  const rationale = sanitizeLine(output.rationale, 'Tactical recommendation generated from live telemetry.', 90);
  const assessment = sanitizeLine(output.assessment, rationale || 'Tactical assessment generated from live context.', 160);
  const tradeoff = sanitizeLine(
    output.tradeoff,
    'Maintaining continuity supports the current phase plan, but cumulative workload can still elevate execution risk.',
    200
  );
  const decision = sanitizeLine(output.decision || output.nextAction || immediateAction, immediateAction, 160);
  const decisionRationale = sanitizeLine(output.decisionRationale || rationale, rationale, 170);
  const why = sanitizeBullets(output.why || [rationale], 3);
  const suggestedAdjustments = sanitizeBullets(output.suggestedAdjustments || why, 6);
  const ifIgnored = sanitizeLine(output.ifIgnored, 'Minimal risk; continue monitoring for workload changes.', 90);
  const coachNote = sanitizeLine(output.coachNote, 'Apply this plan for one over, then reassess live risk signals.', 110);
  return {
    ...output,
    immediateAction,
    nextAction: sanitizeLine(output.nextAction || immediateAction, immediateAction, 70),
    assessment,
    tradeoff,
    decision,
    decisionRationale,
    rationale,
    why,
    suggestedAdjustments,
    ifIgnored,
    coachNote,
    substitutionAdvice: output.substitutionAdvice
      ? {
          out: sanitizeLine(output.substitutionAdvice.out, 'Current player', 80),
          in: sanitizeLine(output.substitutionAdvice.in, 'No eligible replacement', 80),
          reason: sanitizeLine(output.substitutionAdvice.reason, 'Substitution recommended from tactical model.', 90),
        }
      : undefined,
    swap: output.swap
      ? {
          out: sanitizeLine(output.swap.out, 'Current player', 80),
          in: sanitizeLine(output.swap.in, 'No eligible replacement', 80),
          reason: sanitizeLine(output.swap.reason, 'Substitution recommended from tactical model.', 90),
        }
      : undefined,
  };
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
    decision: forbiddenPattern.test(String(output.decision || output.nextAction || output.immediateAction))
      ? teamMode === 'BOWLING'
        ? 'Execute bowling control plan and monitor workload'
        : 'Execute batting tempo plan and preserve wicket value'
      : output.decision,
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
    decision: 'Continue current bowler with monitored plan',
    assessment: 'Current bowler remains in a low-risk state for immediate continuation.',
    tradeoff:
      'Keeping the current bowler preserves matchup continuity in this phase, but workload drift can still raise execution risk if pressure spikes.',
    decisionRationale: 'No acute safety trigger is present, so maintain one-over continuity and reassess.',
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
  assessment?: unknown;
  tradeoff?: unknown;
  decision?: unknown;
  decisionRationale?: unknown;
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
const tacticalErrorDetailSuffix = (error: unknown): string => {
  let status: number | undefined;
  let code = '';
  let body = '';
  let message = '';
  if (error instanceof LLMRequestError) {
    status = error.status;
    code = String((error as LLMRequestError & { code?: unknown }).code || '').trim();
    body = normalizeText(error.bodySnippet || '').slice(0, 200);
    message = normalizeText(error.message).slice(0, 220);
  } else if (error instanceof LLMJsonResponseError) {
    code = `json_${error.phase}`;
    body = normalizeText(error.rawSnippet || '').slice(0, 200);
    message = normalizeText(error.message).slice(0, 220);
  } else if (error instanceof Error) {
    const parsedStatus = parseStatusFromErrorMessage(error.message);
    status = typeof parsedStatus === 'number' ? parsedStatus : undefined;
    message = normalizeText(error.message).slice(0, 220);
  } else if (error && typeof error === 'object') {
    const candidate = error as { status?: unknown; statusCode?: unknown; code?: unknown; bodySnippet?: unknown; message?: unknown };
    const statusParsed = Number(candidate.status ?? candidate.statusCode);
    status = Number.isFinite(statusParsed) ? statusParsed : undefined;
    code = String(candidate.code || '').trim();
    body = normalizeText(String(candidate.bodySnippet || '')).slice(0, 200);
    message = normalizeText(String(candidate.message || '')).slice(0, 220);
  }
  const parts = [
    message ? `message=${message}` : '',
    typeof status === 'number' ? `status=${status}` : '',
    code ? `code=${code}` : '',
    body ? `body=${body}` : '',
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(';') : '';
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
  const assessment = truncateChars(raw.assessment || raw.rationale || whyBullets[0] || 'Tactical assessment generated from live context.', 160)
    || 'Tactical assessment generated from live context.';
  const tradeoff = truncateChars(
    raw.tradeoff || 'Maintaining continuity supports the current phase plan, but cumulative workload can still elevate execution risk.',
    200
  ) || 'Maintaining continuity supports the current phase plan, but cumulative workload can still elevate execution risk.';
  const decision = truncateChars(raw.decision || raw.nextAction || raw.immediateAction || immediateAction, 160) || immediateAction;
  const decisionRationale = truncateChars(
    raw.decisionRationale || raw.rationale || whyBullets[0] || 'Decision grounded in current match leverage and player physical risk.',
    170
  ) || 'Decision grounded in current match leverage and player physical risk.';
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
    assessment,
    tradeoff,
    decision,
    decisionRationale,
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
  const safeInput = applyTacticalDefaults(input);
  const teamMode = normalizeTeamMode(safeInput);
  const guardrailDecision = evaluateStableContinueGuardrail(safeInput, teamMode);
  logStableContinueGuardrail(guardrailDecision, safeInput, reason);
  if (guardrailDecision.applied) {
    return {
      output: sanitizeTacticalOutput(buildContinueGuardrailOutput(safeInput, 'fallback')),
      model: 'fallback-heuristic',
      fallbacksUsed: [reason, 'guardrail:stable_continue'],
    };
  }
  const fatigueIndex = Number(safeInput.telemetry.fatigueIndex) || 0;
  const injuryRisk = String(safeInput.telemetry.injuryRisk || 'MEDIUM').toUpperCase();
  const noBallRisk = String(safeInput.telemetry.noBallRisk || 'MEDIUM').toUpperCase();
  const telemetryBasis = buildTelemetryBasis(safeInput);
  const baselineDirective = deriveBaselineDirective(safeInput);
  const fallbackFocusRole = normalizeFocusRole(safeInput, teamMode);
  const fallbackDecisionInputs = buildTacticalDecisionInputs(safeInput, teamMode, fallbackFocusRole, baselineDirective);
  const poorRecovery = ['poor', 'very poor'].includes(String(safeInput.telemetry.heartRateRecovery || '').toLowerCase());
  const replacementCandidate = listEligibleReplacements(safeInput, teamMode)[0];
  const replacement = replacementCandidate?.name || pickBenchReplacement(safeInput, teamMode);
  const hasEligibleReplacement = Boolean(replacementCandidate) && !/^No eligible/i.test(replacement);
  const outToken = String(
    safeInput.telemetry.playerId || safeInput.telemetry.playerName || safeInput.players.bowler || 'Current player'
  );
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
    output: sanitizeTacticalOutput({
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
      decision:
        teamMode === 'BATTING'
          ? 'Adjust batting plan and protect wicket value'
          : shouldSubstitute
            ? 'Substitute now and rotate workload'
            : 'Continue with monitored plan',
      assessment:
        teamMode === 'BATTING'
          ? 'Batting continuity decision is driven by current pressure phase and physical readiness profile.'
          : shouldSubstitute
            ? 'Bowling continuation risk is elevated enough to justify immediate workload rotation.'
            : 'Bowling continuation remains viable with controlled execution and one-over reassessment.',
      tradeoff:
        teamMode === 'BATTING'
          ? normalizeTradeoffSentence(
              'Keeping the current batter preserves continuity at the crease and avoids exposing a new batter, but dismissal exposure can tighten under pressure.',
              teamMode,
              fallbackDecisionInputs,
              String(safeInput.telemetry.playerName || safeInput.players.bowler || 'the current player')
            )
          : shouldSubstitute
            ? normalizeTradeoffSentence(
                'Changing now protects control and safety in this phase, but it also gives up current-bowler continuity.',
                teamMode,
                fallbackDecisionInputs,
                String(safeInput.telemetry.playerName || safeInput.players.bowler || 'the current player')
              )
            : normalizeTradeoffSentence(
                'Allowing another over preserves the current matchup in this phase, but fatigue drift can still increase execution risk.',
                teamMode,
                fallbackDecisionInputs,
                String(safeInput.telemetry.playerName || safeInput.players.bowler || 'the current player')
              ),
      decisionRationale:
        teamMode === 'BATTING'
          ? 'Decision balances scoreboard pressure, baseline readiness, and dismissal exposure.'
          : shouldSubstitute
            ? 'Decision prioritizes safety and control stability over short-term matchup continuity.'
            : 'Decision prioritizes controlled continuation with an explicit reassessment checkpoint.',
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
    }),
    model: 'fallback-heuristic',
    fallbacksUsed: [reason],
  };
}

export async function runTacticalAgent(input: TacticalAgentInput): Promise<TacticalAgentResult> {
  const safeInput = applyTacticalDefaults(input);
  const teamMode = normalizeTeamMode(safeInput);
  const guardrailDecision = evaluateStableContinueGuardrail(safeInput, teamMode);
  const routing = routeModel({ task: 'tactical', needsJson: true, complexity: 'high' });
  const aoai = getAoaiConfig();
  if (!aoai.ok || !routing.deployment) {
    console.log('[tactical][openai] config', {
      hasEndpoint: aoai.ok ? true : !aoai.missing.includes('AZURE_OPENAI_ENDPOINT'),
      hasDeployment: Boolean(routing.deployment),
      hasApiVersion: aoai.ok,
      missing: aoai.ok ? [] : aoai.missing,
    });
    return buildTacticalFallback(safeInput, `missing:${(aoai.ok ? ['AZURE_OPENAI_DEPLOYMENT'] : aoai.missing).join(',')}`);
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
  console.log('[tactical][openai] attempt', {
    attempted: true,
    requestType: guardrailDecision.requestType,
    requestMode: guardrailDecision.requestMode,
    dataMode: guardrailDecision.dataMode,
    userAction: normalizeText(safeInput.userAction) || undefined,
    guardrailStableState: guardrailDecision.stableState,
    guardrailWillApply: guardrailDecision.applied,
    ...(guardrailDecision.bypassReason ? { guardrailBypassReason: guardrailDecision.bypassReason } : {}),
    deployment: routing.deployment,
    endpointHost,
  });
  const focusRole = normalizeFocusRole(safeInput, teamMode);
  const telemetryBasis = buildTelemetryBasis(safeInput);
  const baselineDirective = deriveBaselineDirective(safeInput);
  const decisionInputs = buildTacticalDecisionInputs(safeInput, teamMode, focusRole, baselineDirective);
  const teamModeInstruction =
    teamMode === 'BOWLING'
      ? 'Team mode is BOWLING. Recommend only bowling actions (next safe bowler, bowling field plan, workload safety). Never mention next batter.'
      : 'Team mode is BATTING. Recommend only batting actions (next batter only as wicket-fall contingency, chase strategy, strike rotation). Never mention next bowler.';

  const messages: LLMMessage[] = [
    {
      role: 'system',
      content:
        'You are a cricket tactical coach agent. Return only valid JSON. ' +
        'Required keys: assessment (<=160 chars), tradeoff (<=200 chars), decision (<=160 chars), nextAction (<=70 chars), why (array with exactly 2 bullets, each <=90 chars), ifIgnored (<=90 chars), coachNote (<=110 chars). ' +
        'Optional key: swap object {out: playerId, in: playerId, reason <=90 chars}. ' +
        'Also include compatibility keys: immediateAction, rationale, decisionRationale, suggestedAdjustments when possible. ' +
        `${teamModeInstruction} Use telemetry and baseline as evidence, but do not just restate raw stats. ` +
        'Focus on tactical implications: scoreboard pressure, control stability, momentum, workload compounding, and next-over consequence. ' +
        'Your tradeoff and decision must be grounded in the provided decisionInputs.matchState and decisionInputs.playerPhysicalRisk signals. ' +
        'TRADEOFF must be one concise sentence in ADVANTAGE vs RISK format: "<advantage>, but <risk>". ' +
        'Avoid circular wording like "dismissal risk due to dismissal risk" and avoid generic phrases like "stability in the batting order". ' +
        'Use cricket-specific concepts such as continuity at the crease, exposing a new batter, phase pressure, fatigue drift, control risk, and dismissal exposure. ' +
        'Use available alternatives when deciding continuity vs change. ' +
        'Do not produce generic "monitor closely" output unless all pressure and risk signals are low. ' +
        'Prefer coach-briefing language and include a short tactical sequence when useful (next over, then following over/backup). ' +
        'Every field must be a complete sentence or complete tactical clause. ' +
        'Do not output unfinished endings like "based on...", "instead of...", "if...", "because...", "while...", or "with...". ' +
        'If uncertain, write a shorter complete sentence. Never leave trailing ellipses. ' +
        'Do not mention internal ranking scores in coach-facing text. ' +
        'If oversBowled is 0 and fatigueIndex/strainIndex are safe with no HIGH risk flag, do not call immediate rotation. ' +
        'When baseline exists, incorporate sleep/recovery/fatigueLimit meaningfully, but mention numbers only when critical to justify the move. ' +
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
          requiredOutputs: ['assessment', 'tradeoff', 'decision', 'nextAction', 'why', 'ifIgnored', 'coachNote'],
          baselineRequired:
            'When baseline exists, use sleepHours + recoveryMinutes + fatigueLimit to shape tactical reasoning without repeating every metric.',
          noImmediateRotationRule:
            'If oversBowled=0 and fatigueIndex<=4 and strainIndex<=2 and injury/no-ball risk are not HIGH, avoid immediate bowler rotation.',
        },
        baseline: baselineDirective.profile,
        decisionInputs,
        input: safeInput,
        context: compactTacticalContext(safeInput),
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
          'Return ONLY valid JSON. No markdown. Required keys: assessment, tradeoff, decision, nextAction, why, ifIgnored, coachNote. Optional key: swap {out,in,reason}. Keep text short. TRADEOFF must be one sentence in "advantage, but risk" form. Include compatibility keys immediateAction/rationale/decisionRationale if present.',
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

    if (!parsed.rationale || parsed.rationale.trim().length < 20) {
      parsed.rationale = truncateChars(
        `${parsed.rationale || ''} Tactical call grounded in workload trend and match-phase pressure.`.trim(),
        90
      );
    }
    if (!parsed.assessment || parsed.assessment.trim().length < 20) {
      parsed.assessment = truncateChars(
        `${parsed.rationale || ''} Current decision uses live scoreboard and player-risk context.`.trim(),
        160
      );
    }
    if (!parsed.tradeoff || parsed.tradeoff.trim().length < 20) {
      const scorePressure = String(decisionInputs.matchState.scoreboardPressure || 'MODERATE').toLowerCase();
      const riskToken =
        teamMode === 'BATTING'
          ? String(decisionInputs.playerPhysicalRisk.dismissalRisk || 'MODERATE').toLowerCase()
          : String(decisionInputs.playerPhysicalRisk.controlExecutionRisk || 'MODERATE').toLowerCase();
      parsed.tradeoff = truncateChars(
        `Tradeoff: ${scorePressure} scoreboard pressure must be balanced against ${riskToken} physical risk for the active player.`,
        200
      );
    }
    if (!parsed.decision || parsed.decision.trim().length < 10) {
      parsed.decision = truncateChars(parsed.nextAction || parsed.immediateAction, 160) || parsed.immediateAction;
    }
    if (!parsed.decisionRationale || parsed.decisionRationale.trim().length < 16) {
      parsed.decisionRationale = truncateChars(parsed.rationale, 170);
    }
    if (!parsed.coachNote || !/baseline|sleep|recovery|fatigue ceiling|fatigue limit/i.test(parsed.coachNote)) {
      parsed.coachNote = truncateChars(
        `${baselineDirective.text} Use a one-over checkpoint, then reassess control quality before committing the following spell.`.trim(),
        110
      );
    }
    if (baselineDirective.constrained && teamMode === 'BOWLING' && !/rotate|substitut|switch/i.test(parsed.immediateAction.toLowerCase())) {
      parsed.immediateAction = `Rotate ${safeInput.telemetry.playerName || 'current bowler'} now and shorten the next spell`;
    }
    parsed = applyRotationGuardrail(parsed, safeInput, telemetryBasis);
    parsed = enforceSubstitutionEligibility(parsed, safeInput, teamMode);
    logStableContinueGuardrail(guardrailDecision, safeInput, 'llm_postprocess');
    if (guardrailDecision.applied) {
      parsed = buildContinueGuardrailOutput(safeInput, parsed.status);
      fallbacksUsed = [...new Set([...fallbacksUsed, 'guardrail:stable_continue'])];
    }
    parsed.nextAction = truncateChars(parsed.nextAction || parsed.immediateAction, 70) || parsed.immediateAction;
    parsed.decision = truncateChars(parsed.decision || parsed.nextAction || parsed.immediateAction, 160) || parsed.immediateAction;
    parsed.decisionRationale = truncateChars(parsed.decisionRationale || parsed.rationale, 170);
    parsed.assessment = truncateChars(parsed.assessment || parsed.rationale, 160);
    parsed.tradeoff = normalizeTradeoffSentence(
      truncateChars(
        parsed.tradeoff || 'Maintaining continuity supports the current phase plan, but cumulative workload can still elevate execution risk.',
        200
      ),
      teamMode,
      decisionInputs,
      String(safeInput.telemetry.playerName || safeInput.players.bowler || 'the current player')
    );
    parsed.why = dedupeTextList((parsed.why || [parsed.rationale]).map((entry) => truncateChars(entry, 90))).slice(0, 2);
    parsed.ifIgnored = truncateChars(parsed.ifIgnored || parsed.suggestedAdjustments?.[0] || 'Risk may increase if unchanged.', 90);
    parsed.coachNote = truncateChars(parsed.coachNote || `${baselineDirective.text} ${telemetryBasis}`, 110);
    parsed.rationale = truncateChars(parsed.rationale, 90);
    parsed = sanitizeTacticalOutput(parsed);

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
    const reasonToken = classifyTacticalFallbackReason(error);
    const detailSuffix = tacticalErrorDetailSuffix(error);
    const reason = detailSuffix ? `${reasonToken};${detailSuffix}` : reasonToken;
    console.log('[tactical] fallback reason:', reason);
    return buildTacticalFallback(safeInput, reason);
  }
}
