import React, { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { copilotChatUrl, postCopilotChat } from '../lib/apiClient';

type CopilotRole = 'user' | 'assistant';

interface CopilotTurn {
  id: string;
  role: CopilotRole;
  content: string;
}

interface CopilotChatPanelProps {
  analysisReady: boolean;
  analysisId?: string;
  resetKey?: string;
  suggestedQuestions?: string[];
  onAnalysisIdSync?: (analysisId: string) => void;
  forceFallbackMode?: boolean;
  analysisExecuted?: boolean;
  analysisStale?: boolean;
  fallbackContext?: {
    matchContextSnapshot?: Record<string, unknown>;
    telemetry?: Record<string, unknown>;
    matchContext?: Record<string, unknown>;
    players?: Record<string, unknown>;
    coachOutput?: Record<string, unknown>;
    matchId?: string;
    sessionId?: string;
  };
  tacticalRecommendationState?: Record<string, unknown>;
}

const DEFAULT_QUESTIONS = [
  'Rotate now or hold one over?',
  'Safest next over?',
  'Plan next 2 overs',
  'Risk drivers right now',
];

const nextTurnId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
};

const readNumber = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const readText = (value: unknown, fallback = ''): string => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const normalizeRisk = (value: unknown): 'LOW' | 'MED' | 'HIGH' => {
  const token = String(value || '').trim().toUpperCase();
  if (token === 'HIGH' || token === 'CRITICAL') return 'HIGH';
  if (token === 'MED' || token === 'MEDIUM') return 'MED';
  return 'LOW';
};

const normalizeForCopilotMatch = (value: unknown): string =>
  String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const compactForCopilotMatch = (value: unknown): string =>
  normalizeForCopilotMatch(value).replace(/\s+/g, '');

const REPLACEMENT_PROMPT_PATTERNS = [
  /\bwho\s+should\s+i\s+change\b/i,
  /\bwho\s+should\s+replace\b/i,
  /\bwho\s+do\s+i\s+sub(?:stitute)?\s+in\b/i,
  /\bchange\s+.+\s+with\b/i,
  /\breplace\s+.+\s+with\b/i,
  /\bswap\s+.+\s+with\b/i,
  /\bsub(?:stitute)?\s+in\s+.+\s+for\b/i,
  /\btake\s+.+\s+off\b/i,
  /\bnext\s+bowler\b/i,
  /\bsafest\s+next\s+over\b/i,
];

const extractSwapFromCopilotText = (value: unknown): { out: string; in: string } => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return { out: '', in: '' };
  const sanitizeName = (name: string): string =>
    name
      .replace(/\b(?:next|this|following|coming)\s+over.*$/i, '')
      .replace(/\b(?:for|to|because|based on|if)\b.*$/i, '')
      .replace(/\s+/g, ' ')
      .trim();
  const patterns = [
    {
      regex: /\bbring in\s+([^,!?;]+?)\s+for\s+([^,!?;]+?)(?:\s+(?:next|this|following|coming)\s+over\b|[,!?;]|$)/i,
      parse: (match: RegExpMatchArray) => ({ in: match[1], out: match[2] }),
    },
    {
      regex: /\breplace\s+([^,!?;]+?)\s+with\s+([^,!?;]+?)(?:\s+(?:next|this|following|coming)\s+over\b|[,!?;]|$)/i,
      parse: (match: RegExpMatchArray) => ({ out: match[1], in: match[2] }),
    },
    {
      regex: /\bswap\s+(?:out\s+)?([^,!?;]+?)\s+(?:for|with)\s+([^,!?;]+?)(?:\s+(?:next|this|following|coming)\s+over\b|[,!?;]|$)/i,
      parse: (match: RegExpMatchArray) => ({ out: match[1], in: match[2] }),
    },
    {
      regex: /\b([a-z][a-z.\s'-]{1,40})\s+for\s+([a-z][a-z.\s'-]{1,40})(?:\s+(?:next|this|following|coming)\s+over\b|[,!?;]|$)/i,
      parse: (match: RegExpMatchArray) => ({ in: match[1], out: match[2] }),
    },
  ];
  for (const entry of patterns) {
    const match = text.match(entry.regex);
    if (!match) continue;
    const parsed = entry.parse(match);
    const out = sanitizeName(String(parsed.out || '').replace(/\s+/g, ' ').trim());
    const incoming = sanitizeName(String(parsed.in || '').replace(/\s+/g, ' ').trim());
    if (!out || !incoming) continue;
    if (normalizeForCopilotMatch(out) === normalizeForCopilotMatch(incoming)) continue;
    return { out, in: incoming };
  }
  return { out: '', in: '' };
};

const resolveMentionedRosterName = (message: string, names: string[]): string => {
  const normalizedMessage = normalizeForCopilotMatch(message);
  const compactMessage = compactForCopilotMatch(message);
  for (const name of names) {
    const normalizedName = normalizeForCopilotMatch(name);
    if (!normalizedName || normalizedName.length < 3) continue;
    if (normalizedMessage.includes(normalizedName)) return name;
    const compactName = normalizedName.replace(/\s+/g, '');
    if (compactName.length >= 3 && compactMessage.includes(compactName)) return name;
  }
  return '';
};

const resolveCopilotSwapSuggestion = (...sources: unknown[]): { out: string; in: string } => {
  for (const source of sources) {
    if (!source) continue;
    if (typeof source === 'object' && !Array.isArray(source)) {
      const record = source as Record<string, unknown>;
      const out = String(record.out ?? '').replace(/\s+/g, ' ').trim();
      const incoming = String(record.in ?? '').replace(/\s+/g, ' ').trim();
      if (out && incoming && normalizeForCopilotMatch(out) !== normalizeForCopilotMatch(incoming)) {
        return { out, in: incoming };
      }
      const reasonText = String(record.reason ?? '').trim();
      if (reasonText) {
        const parsed = extractSwapFromCopilotText(reasonText);
        if (parsed.in && parsed.out) return parsed;
      }
    }
    const parsed = extractSwapFromCopilotText(source);
    if (parsed.in && parsed.out) return parsed;
  }
  return { out: '', in: '' };
};

const normalizeRiskBand = (value: unknown): 'Low' | 'Moderate' | 'High' | '' => {
  const token = String(value ?? '').trim().toUpperCase();
  if (!token) return '';
  if (token === 'HIGH' || token === 'CRITICAL') return 'High';
  if (token === 'MED' || token === 'MEDIUM') return 'Moderate';
  return 'Low';
};

const toConfidenceLabel = (value: unknown): string => {
  const token = String(value ?? '').trim();
  if (!token) return '';
  const numeric = Number(token);
  if (Number.isFinite(numeric)) {
    if (numeric >= 0.75) return 'High';
    if (numeric >= 0.45) return 'Moderate';
    return 'Low';
  }
  const normalized = token.toLowerCase();
  if (normalized === 'high' || normalized === 'moderate' || normalized === 'low') {
    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
  }
  return token;
};

const buildTacticalRecommendationState = (
  context?: CopilotChatPanelProps['fallbackContext'],
  override?: Record<string, unknown>
): Record<string, unknown> | undefined => {
  const provided = override && typeof override === 'object' ? override : undefined;
  if (provided && Object.keys(provided).length > 0) {
    return provided;
  }
  if (!context) return undefined;
  const telemetry = ((context.telemetry || {}) as Record<string, unknown>);
  const coachOutput = ((context.coachOutput || {}) as Record<string, unknown>);
  const tacticalRecommendation = ((coachOutput.tacticalRecommendation || {}) as Record<string, unknown>);
  const combinedDecision = ((coachOutput.combinedDecision || {}) as Record<string, unknown>);
  const swap = resolveCopilotSwapSuggestion(
    tacticalRecommendation.swap,
    tacticalRecommendation.substitutionAdvice,
    tacticalRecommendation.nextAction,
    tacticalRecommendation.primary,
    combinedDecision.substitutionAdvice,
    combinedDecision.immediateAction,
    coachOutput.substitutionAdvice,
    coachOutput.summary
  );

  const recommendedReplacementPlayer = readText(swap.out);
  const recommendedIncomingPlayer = readText(swap.in);
  const recommendedMove = readText(
    tacticalRecommendation.recommendedMove,
    tacticalRecommendation.nextAction,
    tacticalRecommendation.primary,
    combinedDecision.immediateAction
  );
  const tacticalPlan = readText(
    tacticalRecommendation.tacticalPlan,
    tacticalRecommendation.swapReason,
    (tacticalRecommendation.swap as Record<string, unknown> | undefined)?.reason,
    (combinedDecision.substitutionAdvice as Record<string, unknown> | undefined)?.reason
  );
  const assessment = readText(
    tacticalRecommendation.assessment,
    ...(Array.isArray((tacticalRecommendation as Record<string, unknown>).assessment)
      ? (tacticalRecommendation as Record<string, unknown>).assessment as unknown[]
      : [])
  );
  const whyThisIsSmart = readText(
    tacticalRecommendation.whyThisIsSmart,
    ...(Array.isArray((tacticalRecommendation as Record<string, unknown>).whyThisIsSmart)
      ? (tacticalRecommendation as Record<string, unknown>).whyThisIsSmart as unknown[]
      : []),
    tacticalRecommendation.why
  );
  const riskIfIgnored = readText(
    tacticalRecommendation.riskIfIgnored,
    tacticalRecommendation.ifIgnored,
    tacticalRecommendation.ifYouIgnore
  );
  const matchSituation = readText(
    tacticalRecommendation.matchSituation,
    ...(Array.isArray((tacticalRecommendation as Record<string, unknown>).matchSituation)
      ? (tacticalRecommendation as Record<string, unknown>).matchSituation as unknown[]
      : [])
  );
  const priority = readText(
    tacticalRecommendation.priority,
    (coachOutput.priority as unknown),
    (coachOutput.riskLevel as unknown)
  );
  const reason = readText(
    tacticalRecommendation.reason,
    tacticalRecommendation.why,
    whyThisIsSmart,
    assessment,
    combinedDecision.rationale,
    coachOutput.summary
  );
  const fatigueIndexRaw = telemetry.fatigueIndex;
  const fatigueIndex = Number.isFinite(Number(fatigueIndexRaw)) ? Number(fatigueIndexRaw) : undefined;
  const injuryRisk = normalizeRiskBand(telemetry.injuryRisk);
  const noBallRisk = normalizeRiskBand(telemetry.noBallRisk);
  const riskLevel =
    injuryRisk === 'High' || noBallRisk === 'High'
      ? 'High'
      : injuryRisk === 'Moderate' || noBallRisk === 'Moderate'
        ? 'Moderate'
        : (injuryRisk || noBallRisk || '');
  const confidence = toConfidenceLabel(
    tacticalRecommendation.confidence || combinedDecision.confidence
  );

  const state: Record<string, unknown> = {};
  if (recommendedReplacementPlayer) state.recommendedOutgoingPlayer = recommendedReplacementPlayer;
  if (recommendedReplacementPlayer) state.recommendedReplacementPlayer = recommendedReplacementPlayer;
  if (recommendedIncomingPlayer) state.recommendedIncomingPlayer = recommendedIncomingPlayer;
  if (recommendedMove) state.recommendedMove = recommendedMove;
  if (tacticalPlan) state.tacticalPlan = tacticalPlan;
  if (assessment) state.assessment = assessment;
  if (whyThisIsSmart) state.whyThisIsSmart = whyThisIsSmart;
  if (riskIfIgnored) state.riskIfIgnored = riskIfIgnored;
  if (matchSituation) state.matchSituation = matchSituation;
  if (priority) state.priority = priority;
  if (reason) state.reason = reason;
  if (typeof fatigueIndex === 'number') state.fatigueIndex = fatigueIndex;
  if (riskLevel) state.riskLevel = riskLevel;
  if (confidence) state.confidence = confidence;
  return Object.keys(state).length > 0 ? state : undefined;
};

const isAlignmentSensitivePrompt = (prompt: string, tacticalState?: Record<string, unknown>): boolean => {
  const normalizedPrompt = normalizeForCopilotMatch(prompt);
  if (!normalizedPrompt) return false;
  if (REPLACEMENT_PROMPT_PATTERNS.some((pattern) => pattern.test(normalizedPrompt))) return true;
  if (/\b(rotate|rotation|replace|swap|change|next over|next bowler|who should|why|keep|continue)\b/.test(normalizedPrompt)) {
    return true;
  }
  const outgoing = normalizeForCopilotMatch(
    tacticalState?.recommendedOutgoingPlayer || tacticalState?.recommendedReplacementPlayer
  );
  const incoming = normalizeForCopilotMatch(tacticalState?.recommendedIncomingPlayer);
  return Boolean((outgoing && normalizedPrompt.includes(outgoing)) || (incoming && normalizedPrompt.includes(incoming)));
};

const isDetailedTacticalPrompt = (prompt: string): boolean => {
  const normalizedPrompt = normalizeForCopilotMatch(prompt);
  if (!normalizedPrompt) return false;
  return /\b(full reasoning|full detail|detailed|breakdown|step by step|show all|all reasons|deep dive|give full)\b/.test(
    normalizedPrompt
  );
};

const buildGroundedCoachReplyFromState = (
  prompt: string,
  tacticalState: Record<string, unknown>,
  fallbackPlayerName: string
): string => {
  const outgoing = readText(
    tacticalState.recommendedOutgoingPlayer,
    tacticalState.recommendedReplacementPlayer,
    fallbackPlayerName
  );
  const incoming = readText(tacticalState.recommendedIncomingPlayer);
  if (!outgoing || !incoming) return '';

  const normalizedPrompt = normalizeForCopilotMatch(prompt);
  const reason = readText(
    tacticalState.reason,
    tacticalState.assessment,
    tacticalState.whyThisIsSmart,
    'Rotation is recommended now to prevent control drift in this phase.'
  );
  const recommendedMove = readText(
    tacticalState.recommendedMove,
    `Bring in ${incoming} for ${outgoing} next over.`
  );
  const confidence = readText(tacticalState.confidence, 'Moderate');
  const tacticalPlan = readText(tacticalState.tacticalPlan);
  const riskIfIgnored = readText(tacticalState.riskIfIgnored);
  const fatigue = typeof tacticalState.fatigueIndex === 'number' ? Number(tacticalState.fatigueIndex).toFixed(1) : '';
  const risk = readText(tacticalState.riskLevel);

  const isWhyQuestion = /\b(why|reason|because|justify|explain)\b/.test(normalizedPrompt);
  const isReplacementQuestion = REPLACEMENT_PROMPT_PATTERNS.some((pattern) => pattern.test(normalizedPrompt));
  const isNextBowlerQuestion = /\b(best next bowler|who bowls next|who should bowl next|next bowler)\b/.test(normalizedPrompt);
  const isContinueQuestion = /\b(continue|keep|stay|still okay|ok to continue)\b/.test(normalizedPrompt);
  const detailed = isDetailedTacticalPrompt(normalizedPrompt);

  let response = '';
  if (isReplacementQuestion || isNextBowlerQuestion) {
    response = `${recommendedMove} ${reason}`;
  } else if (isWhyQuestion) {
    response = `${outgoing} is still effective, but rotating now is safer because ${reason}`;
  } else if (isContinueQuestion) {
    response = `${outgoing} is still capable, but the tactical recommendation is to rotate now. ${recommendedMove}`;
  } else {
    response = `${recommendedMove} ${reason}`;
  }
  response = response.replace(/\s+/g, ' ').trim();

  if (!detailed) return response;

  const detailLines = [
    `Recommended move: ${recommendedMove}`,
    `Why this is smart: ${readText(tacticalState.whyThisIsSmart, reason)}`,
    tacticalPlan ? `Tactical plan: ${tacticalPlan}` : '',
    riskIfIgnored ? `Risk if ignored: ${riskIfIgnored}` : '',
    fatigue ? `Fatigue index: ${fatigue}` : '',
    risk ? `Risk level: ${risk}` : '',
    `Confidence: ${confidence}.`,
  ].filter(Boolean);
  return `${response}\n\n${detailLines.join('\n')}`.trim();
};

const buildDemoCopilotReply = (
  prompt: string,
  context?: CopilotChatPanelProps['fallbackContext'],
  tacticalStateOverride?: Record<string, unknown>
): string => {
  const snapshot = (context?.matchContextSnapshot || {}) as Record<string, unknown>;
  const telemetry = ((context?.telemetry || snapshot.telemetry || {}) as Record<string, unknown>);
  const match = ((context?.matchContext || snapshot.matchContext || {}) as Record<string, unknown>);
  const players = ((context?.players || snapshot.players || {}) as Record<string, unknown>);
  const coachOutput = (context?.coachOutput || {}) as Record<string, unknown>;
  const tacticalRecommendation = (coachOutput.tacticalRecommendation || {}) as Record<string, unknown>;
  const combinedDecision = (coachOutput.combinedDecision || {}) as Record<string, unknown>;
  const tacticalState = buildTacticalRecommendationState(context, tacticalStateOverride);

  const playerName =
    readText(telemetry.playerName)
    || readText(players.bowler)
    || 'the current bowler';
  const fatigueIndex = readNumber(telemetry.fatigueIndex, 0);
  const strainIndex = readNumber(telemetry.strainIndex, 0);
  const oversBowled = readNumber(telemetry.oversBowled, 0);
  const injuryRisk = normalizeRisk(telemetry.injuryRisk);
  const noBallRisk = normalizeRisk(telemetry.noBallRisk);
  const phase = readText(match.phase, 'middle overs');
  const recovery = readText((telemetry.heartRateRecovery || telemetry.recovery), 'Moderate');
  const tacticalNextAction = readText(
    tacticalRecommendation.nextAction || tacticalRecommendation.primary || combinedDecision.immediateAction
  );
  const benchList = Array.isArray(players.bench)
    ? players.bench.map((entry) => String(entry || '').trim()).filter(Boolean).slice(0, 3)
    : [];
  const benchHint = benchList.length > 0 ? ` Keep ${benchList.join(', ')} ready as rotation options.` : '';

  const promptLower = prompt.toLowerCase();
  const isReplacementPrompt = REPLACEMENT_PROMPT_PATTERNS.some((pattern) => pattern.test(promptLower));
  const isReliabilityPrompt = /(reliable|reliability|lowest fatigue|fatigue risk|safest (bowler|batter|player)|best condition|ready to bowl|ready to bat|in best condition|lowest injury risk|workload risk|who should bowl|who should bat)/.test(
    promptLower
  );
  const safeToContinue = oversBowled === 0 || (fatigueIndex <= 4 && injuryRisk === 'LOW');
  const elevatedRisk = injuryRisk !== 'LOW' || noBallRisk === 'HIGH' || fatigueIndex >= 6 || strainIndex >= 4;

  const rosterMetrics = Array.isArray(players.rosterMetrics)
    ? players.rosterMetrics
        .map((entry) => (entry && typeof entry === 'object' ? entry as Record<string, unknown> : null))
        .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    : [];
  if (tacticalState && isAlignmentSensitivePrompt(promptLower, tacticalState)) {
    const groundedReply = buildGroundedCoachReplyFromState(promptLower, tacticalState, playerName);
    if (groundedReply) {
      return groundedReply;
    }
  }

  if (isReplacementPrompt) {
    const rosterNames = rosterMetrics
      .map((row) => readText(row.name, row.playerName))
      .filter(Boolean);
    const mentionedPlayer = resolveMentionedRosterName(promptLower, rosterNames);
    const swap = resolveCopilotSwapSuggestion(
      tacticalRecommendation.swap,
      tacticalRecommendation.substitutionAdvice,
      tacticalRecommendation.nextAction,
      tacticalRecommendation.primary,
      combinedDecision.substitutionAdvice,
      combinedDecision.immediateAction,
      coachOutput.summary
    );
    const replacementIn = readText(swap.in);
    const replacementOut = readText(swap.out, mentionedPlayer, playerName);
    const replacementReason = readText(
      tacticalRecommendation.reason,
      tacticalRecommendation.why,
      combinedDecision.rationale,
      coachOutput.summary,
      'This is the safest pressure reset based on current workload and control signals.'
    );

    if (replacementIn) {
      return `Replace ${replacementOut || playerName} with ${replacementIn} next over. ${replacementReason}`;
    }

    if (tacticalNextAction) {
      return `Best next-over move: ${tacticalNextAction}. ${replacementReason}`;
    }
  }

  if (isReliabilityPrompt && rosterMetrics.length > 0) {
    const normalizeRiskBand = (value: unknown): 'LOW' | 'MED' | 'HIGH' => {
      const token = String(value || '').trim().toUpperCase();
      if (token === 'HIGH' || token === 'CRITICAL') return 'HIGH';
      if (token === 'MED' || token === 'MEDIUM') return 'MED';
      return 'LOW';
    };
    const scored = rosterMetrics
      .map((row) => {
        const name = readText(row.name);
        if (!name) return null;
        const isUnavailable = Boolean(row.isUnfit) || Boolean(row.isInjured) || Boolean(row.isSub);
        if (isUnavailable) return null;
        const fatigueNow = readNumber(row.fatigueIndex, 0);
        const fatigueLimitNow = Math.max(1, readNumber(row.fatigueLimit, 6));
        const sleepNow = readNumber(row.sleepHours, 7);
        const recoveryMinutesNow = readNumber(row.recoveryMinutes, 45);
        const recoveryBandNow = readText(row.heartRateRecovery, 'Moderate');
        const injuryRiskNow = normalizeRiskBand(row.injuryRisk);
        const noBallRiskNow = normalizeRiskBand(row.noBallRisk);
        const controlNow = readNumber(row.control, 75);
        const fatigueHeadroom = Math.max(-1, Math.min(1, (fatigueLimitNow - fatigueNow) / fatigueLimitNow));
        const sleepScore = Math.max(0, Math.min(1, sleepNow / 8));
        const recoveryBandScore = recoveryBandNow.toLowerCase() === 'good' ? 1 : recoveryBandNow.toLowerCase() === 'moderate' ? 0.65 : 0.35;
        const recoveryMinutesScore = Math.max(0, Math.min(1, recoveryMinutesNow / 60));
        const controlScore = Math.max(0, Math.min(1, controlNow > 10 ? controlNow / 100 : controlNow / 10));
        const injuryPenalty = injuryRiskNow === 'HIGH' ? 0.45 : injuryRiskNow === 'MED' ? 0.2 : 0;
        const noBallPenalty = noBallRiskNow === 'HIGH' ? 0.2 : noBallRiskNow === 'MED' ? 0.1 : 0;
        const score = (fatigueHeadroom * 0.36) + (sleepScore * 0.15) + (recoveryBandScore * 0.16) + (recoveryMinutesScore * 0.1) + (controlScore * 0.23) - injuryPenalty - noBallPenalty;
        return {
          name,
          fatigueNow,
          fatigueLimitNow,
          recoveryBandNow,
          injuryRiskNow,
          noBallRiskNow,
          score,
        };
      })
      .filter((entry): entry is {
        name: string;
        fatigueNow: number;
        fatigueLimitNow: number;
        recoveryBandNow: string;
        injuryRiskNow: 'LOW' | 'MED' | 'HIGH';
        noBallRiskNow: 'LOW' | 'MED' | 'HIGH';
        score: number;
      } => Boolean(entry))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.name.localeCompare(b.name);
      });
    const best = scored[0];
    const runnerUp = scored[1];
    if (best) {
      const comparison = runnerUp
        ? `Compared with ${runnerUp.name}, ${best.name} currently has the stronger readiness profile.`
        : `${best.name} currently profiles as the safest high-readiness option.`;
      return `Based on current recovery and fatigue metrics, ${best.name} appears the most reliable option today. ${best.name}'s fatigue is ${best.fatigueNow.toFixed(1)}/${best.fatigueLimitNow.toFixed(1)}, recovery is ${best.recoveryBandNow}, and injury/no-ball risk is ${best.injuryRiskNow}/${best.noBallRiskNow}. ${comparison}`;
    }
  }

  let action = safeToContinue
    ? `Continue with ${playerName} for the next over and focus on repeatable release points.`
    : elevatedRisk
      ? `Rotate ${playerName} after this over and shift to a control-first option.`
      : `Use ${playerName} for one controlled over, then reassess before committing to another spell.`;

  if (promptLower.includes('no-ball')) {
    action = safeToContinue
      ? `Keep ${playerName} on, slow the run-up slightly, and commit to a shorter, repeatable run-up marker this over.`
      : `Take one over off ${playerName}, then bring him back with a simplified run-up and yorker target plan.`;
  } else if (promptLower.includes('next 2 overs') || promptLower.includes('two overs') || promptLower.includes('2 overs')) {
    action = elevatedRisk
      ? `Split the next two overs between a control bowler now and ${playerName} only if rhythm is stable after the break.`
      : `Keep ${playerName} for one over, then use a change-up bowler for the following over to protect late-phase flexibility.`;
  } else if (promptLower.includes('safest plan')) {
    action = elevatedRisk
      ? `Safest plan is to rotate now, protect execution quality, and avoid back-to-back high-intensity overs.`
      : `Safest plan is one more controlled over from ${playerName}, with a pre-committed rotation trigger on any control drop.`;
  }

  const whyLine = elevatedRisk
    ? `${phase} pressure plus current workload signals can compound quickly if you extend the spell unchanged.`
    : `${phase} context is manageable, and current workload signals still support controlled execution.`;
  const watchLine = elevatedRisk
    ? `Watch for line-length drift or rushed run-up rhythm; rotate immediately if either appears.`
    : `Watch recovery and front-foot discipline; rotate if rhythm drops or no-ball pressure rises.`;
  const recoveryLine = `Recovery trend is ${recovery}, so keep the reassessment window short.${benchHint}`;
  const tacticalLine = tacticalNextAction
    ? `This stays aligned with the latest tactical guidance while keeping options open.`
    : `This keeps tactical flexibility for the next decision point.`;

  return `${action}\n\n${whyLine} ${recoveryLine} ${watchLine} ${tacticalLine}`;
};

export default function CopilotChatPanel({
  analysisReady,
  analysisId,
  resetKey,
  suggestedQuestions,
  onAnalysisIdSync,
  forceFallbackMode = false,
  analysisExecuted = false,
  analysisStale = false,
  fallbackContext,
  tacticalRecommendationState: tacticalRecommendationStateProp,
}: CopilotChatPanelProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<CopilotTurn[]>([]);
  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [messagesUsed, setMessagesUsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [lastPrompt, setLastPrompt] = useState<string>('');
  const [runtimeSource, setRuntimeSource] = useState<'ai' | 'fallback'>(forceFallbackMode ? 'fallback' : 'ai');
  const [runtimeNote, setRuntimeNote] = useState<string | null>(
    forceFallbackMode ? 'Copilot is running in fallback/local mode because Azure OpenAI is unavailable.' : null
  );
  const [hoveredSuggestionIndex, setHoveredSuggestionIndex] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const railRef = useRef<HTMLDivElement | null>(null);

  const promptLimit = 10;
  const limitReached = messagesUsed >= promptLimit;
  const localRulesMode = forceFallbackMode;
  const hasFallbackContext = Boolean(
    fallbackContext?.coachOutput ||
    fallbackContext?.matchContextSnapshot ||
    fallbackContext?.telemetry ||
    fallbackContext?.matchContext
  );
  const canSend = analysisReady || String(analysisId || '').trim().length > 0 || (localRulesMode && hasFallbackContext);
  const resolvedSuggestions = useMemo(
    () => (Array.isArray(suggestedQuestions) && suggestedQuestions.length > 0 ? suggestedQuestions.slice(0, 6) : DEFAULT_QUESTIONS),
    [suggestedQuestions]
  );
  const copilotStyle: React.CSSProperties = {
    background: 'linear-gradient(135deg, rgba(16,185,129,0.18) 0%, rgba(34,211,238,0.14) 55%, rgba(99,102,241,0.10) 100%)',
    border: '1px solid rgba(16,185,129,0.22)',
    boxShadow: '0 0 0 1px rgba(16,185,129,0.10), 0 10px 30px rgba(16,185,129,0.10)',
    borderRadius: '16px',
  };
  const userStyle: React.CSSProperties = {
    background: 'rgba(255,255,255,0.05)',
    border: '1px solid rgba(255,255,255,0.10)',
    borderRadius: '16px',
  };

  useEffect(() => {
    setIsOpen(false);
    setMessages([]);
    setInput('');
    setMessagesUsed(0);
    setError(null);
    setLastPrompt('');
    setRuntimeSource(localRulesMode ? 'fallback' : 'ai');
    setRuntimeNote(localRulesMode ? 'Copilot is running in fallback/local mode because Azure OpenAI is unavailable.' : null);
  }, [resetKey]);

  useEffect(() => {
    if (localRulesMode) {
      setRuntimeSource('fallback');
      setRuntimeNote('Copilot is running in fallback/local mode because Azure OpenAI is unavailable.');
      return;
    }
    setRuntimeSource('ai');
    setRuntimeNote((prev) => {
      if (!prev) return null;
      if (/Azure OpenAI is unavailable/i.test(prev)) return null;
      return prev;
    });
  }, [localRulesMode]);

  useEffect(() => {
    if (!isOpen) return;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [isOpen, messages, isSending]);

  useEffect(() => {
    const el = railRef.current;
    if (!el) return;

    const onWheel = (event: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth) return;
      event.preventDefault();
      event.stopPropagation();
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      el.scrollLeft += delta;
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const sendMessage = async (promptOverride?: string) => {
    const prompt = String(promptOverride ?? input).trim();
    if (!prompt || isSending || limitReached) return;
    if (!canSend) {
      setError('Run Coach Analysis first to unlock Copilot Chat.');
      return;
    }
    const resolvedAnalysisId = String(analysisId || '').trim() || `local-copilot-${Date.now()}`;

    const userTurn: CopilotTurn = {
      id: nextTurnId(),
      role: 'user',
      content: prompt,
    };

    setError(null);
    setLastPrompt(prompt);
    setInput('');
    setMessages((prev) => [...prev, userTurn]);
    setIsSending(true);

    try {
      const history = [...messages.slice(-7), userTurn].map((turn) => ({
        role: turn.role,
        content: turn.content,
      }));
      if (import.meta.env.DEV) {
        console.log('[copilot] submit', {
          prompt,
          analysisId: resolvedAnalysisId,
          routeCalled: localRulesMode ? 'local-fallback(no request)' : copilotChatUrl,
          localRulesMode,
          historyTurns: history.length,
        });
      }
      const tacticalRecommendationState = buildTacticalRecommendationState(
        fallbackContext,
        tacticalRecommendationStateProp
      );
      const basePayload = {
        analysisId: resolvedAnalysisId,
        message: prompt,
        history,
        ...(fallbackContext?.matchContextSnapshot ? { matchContextSnapshot: fallbackContext.matchContextSnapshot } : {}),
        ...(fallbackContext?.telemetry ? { telemetry: fallbackContext.telemetry } : {}),
        ...(fallbackContext?.matchContext ? { matchContext: fallbackContext.matchContext } : {}),
        ...(fallbackContext?.players ? { players: fallbackContext.players } : {}),
        ...(fallbackContext?.coachOutput ? { coachOutput: fallbackContext.coachOutput } : {}),
        ...(tacticalRecommendationState ? { tacticalRecommendationState } : {}),
        ...(fallbackContext?.matchId ? { matchId: fallbackContext.matchId } : {}),
        ...(fallbackContext?.sessionId ? { sessionId: fallbackContext.sessionId } : {}),
      };
      if (localRulesMode) {
        if (import.meta.env.DEV) {
          console.warn('[copilot] fallback_local', {
            prompt,
            analysisId: resolvedAnalysisId,
            routeCalled: 'local-fallback(no request)',
            reason: 'forceFallbackMode',
          });
        }
        const assistantTurn: CopilotTurn = {
          id: nextTurnId(),
          role: 'assistant',
          content: buildDemoCopilotReply(prompt, fallbackContext, tacticalRecommendationState),
        };
        setMessages((prev) => [...prev, assistantTurn]);
        setMessagesUsed((prev) => Math.min(promptLimit, prev + 1));
        setRuntimeSource('fallback');
        setRuntimeNote('Copilot is running in fallback/local mode because Azure OpenAI is unavailable.');
        onAnalysisIdSync?.(resolvedAnalysisId);
        return;
      }
      const response = await postCopilotChat(basePayload);
      const reply = String(response?.reply || '').trim() || 'No reply returned from Copilot.';
      const responseMode = String(response?.mode || '').trim().toLowerCase();
      const responseSource = String(response?.source || '').trim().toLowerCase() === 'ai' ? 'ai' : 'fallback';
      const assistantTurn: CopilotTurn = {
        id: nextTurnId(),
        role: 'assistant',
        content: reply,
      };
      setMessages((prev) => [...prev, assistantTurn]);
      setRuntimeSource(responseSource);
      setRuntimeNote(
        responseMode === 'domain_guard'
          ? 'Copilot is domain-restricted to match tactics, fatigue, workload, and injury-risk guidance.'
          : responseMode === 'domain_redirect'
          ? 'Copilot handled this as a broader cricket question and redirected to tactical context.'
          : responseSource === 'fallback'
          ? 'Copilot response came from fallback/local mode.'
          : null
      );
      if (import.meta.env.DEV) {
        console.log('[copilot] response', {
          routeCalled: String(response?.routeCalled || copilotChatUrl || '').trim() || '/api/copilot',
          source: responseSource,
          mode: response?.mode || null,
          fallbackReason: response?.fallbackReason || null,
        });
      }
      const analysisIdUsed = String(response?.analysisIdUsed || '').trim();
      if (analysisIdUsed.length > 0) {
        onAnalysisIdSync?.(analysisIdUsed);
      }
      if (typeof response?.messagesUsed === 'number' && Number.isFinite(response.messagesUsed)) {
        setMessagesUsed(Math.max(0, Math.min(promptLimit, Math.floor(response.messagesUsed))));
      } else {
        setMessagesUsed((prev) => Math.min(promptLimit, prev + 1));
      }
    } catch (sendError) {
      if (import.meta.env.DEV) {
        console.error('[copilot] send failed', {
          routeCalled: copilotChatUrl,
          error: sendError instanceof Error ? sendError.message : String(sendError),
        });
      }
      const fallbackReply = buildDemoCopilotReply(
        prompt,
        fallbackContext,
        buildTacticalRecommendationState(fallbackContext, tacticalRecommendationStateProp)
      );
      const assistantTurn: CopilotTurn = {
        id: nextTurnId(),
        role: 'assistant',
        content: fallbackReply,
      };
      setMessages((prev) => [...prev, assistantTurn]);
      setMessagesUsed((prev) => Math.min(promptLimit, prev + 1));
      setRuntimeSource('fallback');
      setRuntimeNote('Copilot API request failed; showing local fallback response.');
      setError('Live Copilot unavailable right now; showing local fallback response.');
    } finally {
      setIsSending(false);
    }
  };

  if (!analysisReady) return null;

  return (
    <div className="w-full">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold text-white">Copilot Chat</h3>
          <p className="text-[11px] text-slate-400">Discuss this match state</p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`text-[10px] px-2 py-0.5 rounded border ${
              runtimeSource === 'ai'
                ? 'border-emerald-400/40 text-emerald-100 bg-emerald-500/10'
                : 'border-amber-400/40 text-amber-100 bg-amber-500/10'
            }`}
          >
            {runtimeSource === 'ai' ? 'Live AI' : 'Fallback/local'}
          </span>
          <span className="text-[10px] px-2 py-0.5 rounded border border-slate-600 text-slate-300 bg-slate-800/70">
            {messagesUsed}/{promptLimit}
          </span>
          <button
            type="button"
            onClick={() => setIsOpen((prev) => !prev)}
            disabled={!canSend}
            className="text-[10px] px-2 py-0.5 rounded border border-cyan-400/35 text-cyan-200 bg-cyan-500/10 hover:bg-cyan-500/20 transition-colors"
          >
            {isOpen ? 'Close' : 'Open'}
          </button>
        </div>
      </div>

      <div
        ref={railRef}
        style={{
          display: 'flex',
          flexWrap: 'nowrap',
          gap: '8px',
          overflowX: 'auto',
          overflowY: 'hidden',
          maxWidth: '100%',
          padding: '8px 2px 8px 2px',
          WebkitOverflowScrolling: 'touch',
          scrollbarWidth: 'none',
          msOverflowStyle: 'none',
        }}
      >
        {resolvedSuggestions.map((question, index) => (
          <button
            type="button"
            key={`copilot-question-${index}`}
            onMouseEnter={() => setHoveredSuggestionIndex(index)}
            onMouseLeave={() => setHoveredSuggestionIndex((prev) => (prev === index ? null : prev))}
            onClick={() => {
              if (!canSend) return;
              if (!isOpen) setIsOpen(true);
              void sendMessage(question);
            }}
            disabled={!canSend || isSending || limitReached}
            className={`flex-[0_0_auto] whitespace-nowrap rounded-full px-4 py-2 text-sm font-medium transition ${
              !canSend || isSending || limitReached
                ? 'bg-white/5 border border-white/10 text-slate-400 cursor-not-allowed opacity-55'
                : 'bg-white/5 border border-white/10 text-slate-200 hover:text-white hover:bg-white/[0.08] hover:border-white/15 hover:shadow-[0_0_0_1px_rgba(99,102,241,0.25),0_0_18px_rgba(99,102,241,0.12)]'
            }`}
            style={
              !canSend || isSending || limitReached
                ? undefined
                : {
                    background:
                      hoveredSuggestionIndex === index
                        ? 'linear-gradient(180deg, rgba(34,54,102,0.44) 0%, rgba(20,35,72,0.30) 100%)'
                        : 'linear-gradient(180deg, rgba(24,40,78,0.32) 0%, rgba(16,28,58,0.22) 100%)',
                    boxShadow:
                      hoveredSuggestionIndex === index
                        ? '0 0 0 1px rgba(110,150,255,0.08), inset 0 1px 0 rgba(255,255,255,0.03), 0 8px 22px rgba(0,0,0,0.16)'
                        : '0 0 0 1px rgba(110,150,255,0.05), inset 0 1px 0 rgba(255,255,255,0.02), 0 6px 18px rgba(0,0,0,0.14)',
                    color: '#f2f6ff',
                    borderColor: 'rgba(120,150,210,0.22)',
                  }
            }
          >
            {question}
          </button>
        ))}
      </div>

      {!canSend && (
        <div className="rounded-md border border-amber-400/35 bg-amber-500/10 px-3 py-2 mt-1">
          <p className="text-[11px] text-amber-100">Run Coach Analysis first to unlock Copilot Chat.</p>
        </div>
      )}
      {runtimeSource === 'fallback' && runtimeNote && (
        <div className="rounded-md border border-amber-400/35 bg-amber-500/10 px-3 py-2 mt-1">
          <p className="text-[11px] text-amber-100">{runtimeNote}</p>
        </div>
      )}

      {isOpen && (
        <div className="mt-2 rounded-xl border border-white/10 bg-slate-900/40 p-3">
          {analysisExecuted && analysisStale && (
            <div
              style={{
                marginBottom: '10px',
                padding: '8px 10px',
                borderRadius: '10px',
                background: 'rgba(255,184,77,0.08)',
                border: '1px solid rgba(255,184,77,0.25)',
                color: '#ffd38a',
                fontSize: '12.5px',
                lineHeight: '1.4',
              }}
            >
              ⚠️ Inputs changed since the last AI analysis. Rerun or dismiss analysis for updated guidance.
            </div>
          )}
          <div ref={scrollRef} className="max-h-56 overflow-y-auto space-y-3 pr-1 pb-6">
            {messages.map((turn) => (
              <div
                key={turn.id}
                className={`text-[12px] p-4 ${turn.role === 'user' ? 'ml-8' : 'mr-8'}`}
                style={turn.role === 'assistant' ? copilotStyle : userStyle}
              >
                {turn.role === 'assistant' && (
                  <div style={{ fontSize: 11, letterSpacing: 2, fontWeight: 700, color: 'rgba(167,243,208,0.95)', marginBottom: 4 }}>COPILOT</div>
                )}
                {turn.role === 'assistant' ? (
                  <div className="prose prose-invert max-w-none" style={{ color: 'rgba(255,255,255,0.92)', lineHeight: 1.65, wordBreak: 'break-word' }}>
                    <ReactMarkdown>{turn.content}</ReactMarkdown>
                  </div>
                ) : (
                  <div style={{ color: 'rgba(255,255,255,0.92)', lineHeight: 1.65, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    <span>{turn.content}</span>
                  </div>
                )}
              </div>
            ))}
            {isSending && (
              <div className="text-[12px] mr-8" style={copilotStyle}>
                <div className="p-4">
                  <div style={{ fontSize: 11, letterSpacing: 2, fontWeight: 700, color: 'rgba(167,243,208,0.95)', marginBottom: 4 }}>COPILOT</div>
                  <div style={{ color: 'rgba(255,255,255,0.92)', lineHeight: 1.65 }}>Thinking…</div>
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2" style={{ marginTop: 18 }}>
            <input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void sendMessage();
                }
              }}
              placeholder={limitReached ? 'Session limit reached' : 'Ask about this match state...'}
              disabled={!canSend || isSending || limitReached}
              className="flex-1 rounded-lg border border-slate-700 bg-slate-900/70 px-3 py-2 text-[12px] text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-cyan-400/60"
            />
            <button
              type="button"
              onClick={() => void sendMessage()}
              disabled={!canSend || isSending || limitReached || input.trim().length === 0}
              className="rounded-lg border border-cyan-400/35 bg-cyan-500/15 px-3 py-2 text-[12px] font-semibold text-cyan-100 hover:bg-cyan-500/25 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Send
            </button>
          </div>

          <p className="mt-2 text-[10px] text-slate-500">Limit: 10 messages per session</p>

          {error && (
            <div className="mt-2 flex items-center justify-between gap-2 rounded-md border border-rose-500/35 bg-rose-500/10 px-2 py-1">
              <p className="text-[11px] text-rose-100">{error}</p>
              {lastPrompt && !isSending && !limitReached && (
                <button
                  type="button"
                  onClick={() => void sendMessage(lastPrompt)}
                  className="text-[10px] px-2 py-0.5 rounded border border-rose-300/45 text-rose-100 hover:bg-rose-500/20 transition-colors"
                >
                  Retry
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
