/**
 * Repo audit checklist (requested):
 * [x] Found `api/src/llm/azureOpenAI.ts` (single Azure client + `safeJsonParse`).
 * [x] Found `api/src/functions/router.ts` (router endpoint).
 * [x] Found `api/src/agents/fatigueAgent.ts`, `api/src/agents/riskAgent.ts`, `api/src/agents/tacticalAgent.ts`.
 * [x] Found `api/src/orchestrator/orchestrator.ts` (this merge/orchestration module).
 * [x] Found frontend caller at `src/lib/apiClient.ts`.
 * [x] Updated this file to emit compatibility aliases (`routerIntent`, `agentResults`, `finalRecommendation`) without breaking existing UI fields.
 */
import { randomUUID } from 'crypto';
import { InvocationContext } from '@azure/functions';
import { buildFatigueFallback, FatigueAgentRunResult, runFatigueAgent } from '../agents/fatigueAgent';
import { buildRiskFallback, RiskAgentRunResult, runRiskAgent } from '../agents/riskAgent';
import { buildTacticalFallback, runTacticalAgent } from '../agents/tacticalAgent';
import {
  AgentStatus,
  AgentError,
  OrchestrateIntent,
  OrchestrateRequest,
  OrchestrateResponse,
  RouterDecision,
  TriggerScores,
  toFatigueRequest,
  toRiskRequest,
} from '../agents/types';
import { getAoaiConfig } from '../llm/modelRegistry';

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const maxOversByFormat = (format?: string): number => {
  const normalized = String(format || '').trim().toUpperCase();
  if (normalized === 'T20') return 4;
  if (normalized === 'ODI') return 10;
  return 999;
};

const severityToConfidence = (severity?: string): number => {
  const upper = String(severity || '').toUpperCase();
  if (upper === 'CRITICAL') return 0.52;
  if (upper === 'HIGH') return 0.58;
  if (upper === 'MED' || upper === 'MEDIUM') return 0.68;
  return 0.78;
};

const toAgentStatus = (status: string | undefined, isSelected: boolean): AgentStatus => {
  if (!isSelected) return 'SKIPPED';
  if (status === 'fallback') return 'FALLBACK';
  if (status === 'error') return 'ERROR';
  return 'OK';
};

const toSummaryText = (value: unknown, fallback: string): string => {
  const text = String(value || '').trim();
  return text || fallback;
};

const toSummarySignals = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const signals = value.filter((item): item is string => typeof item === 'string').slice(0, 8);
  return signals.length > 0 ? signals : undefined;
};

function computeTriggers(input: OrchestrateRequest): TriggerScores {
  const fatigueIndex = clamp(Number(input.telemetry.fatigueIndex) || 0, 0, 10);
  const maxOvers = Math.max(1, Number(input.telemetry.maxOvers) || maxOversByFormat(input.matchContext.format));
  const oversBowled = clamp(Number(input.telemetry.oversBowled) || 0, 0, maxOvers);
  const oversRemaining = Number.isFinite(Number(input.telemetry.oversRemaining))
    ? clamp(Number(input.telemetry.oversRemaining), 0, maxOvers)
    : Math.max(0, maxOvers - oversBowled);
  const workloadRatio = maxOvers > 0 ? oversBowled / maxOvers : 0;
  const quotaComplete = input.telemetry.quotaComplete === true || (maxOvers < 999 && oversBowled >= maxOvers);
  const recovery = String(input.telemetry.heartRateRecovery || 'Moderate').toLowerCase();
  const injuryRisk = String(input.telemetry.injuryRisk || 'MEDIUM').toUpperCase();
  const noBallRisk = String(input.telemetry.noBallRisk || 'MEDIUM').toUpperCase();
  const rrGap = Math.max(0, input.matchContext.requiredRunRate - input.matchContext.currentRunRate);
  const phase = String(input.matchContext.phase || 'middle').toLowerCase();
  const wicketsInHand = Math.max(0, Number(input.matchContext.wicketsInHand) || 0);
  const intent = (input.intent || 'monitor') as OrchestrateIntent;

  const fatigueTrigger = clamp(
    fatigueIndex * 8 +
      workloadRatio * 18 +
      (oversRemaining <= 1 ? 8 : 0) +
      (recovery === 'poor' ? 12 : recovery === 'moderate' ? 6 : 0),
    0,
    100
  );

  const riskTrigger = clamp(
    (injuryRisk === 'HIGH' ? 40 : injuryRisk === 'MED' || injuryRisk === 'MEDIUM' ? 20 : 8) +
      (noBallRisk === 'HIGH' ? 25 : noBallRisk === 'MED' || noBallRisk === 'MEDIUM' ? 12 : 4) +
      fatigueIndex * 3 +
      workloadRatio * 12,
    0,
    100
  );

  const tacticalTrigger = clamp(
    rrGap * 12 +
      (phase === 'death' ? 25 : phase === 'powerplay' ? 10 : 8) +
      (wicketsInHand <= 3 ? 20 : wicketsInHand <= 5 ? 10 : 4) +
      (intent === 'strategy' || intent === 'substitution' || intent === 'full' ? 18 : 0) +
      (quotaComplete ? 30 : 0),
    0,
    100
  );

  return {
    fatigue: Math.round(fatigueTrigger),
    risk: Math.round(riskTrigger),
    tactical: Math.round(tacticalTrigger),
  };
}

export function buildRouterDecision(mode: 'auto' | 'full', input: OrchestrateRequest): RouterDecision {
  const maxOvers = Math.max(1, Number(input.telemetry.maxOvers) || maxOversByFormat(input.matchContext.format));
  const oversBowled = clamp(Number(input.telemetry.oversBowled) || 0, 0, maxOvers);
  const oversRemaining = Number.isFinite(Number(input.telemetry.oversRemaining))
    ? clamp(Number(input.telemetry.oversRemaining), 0, maxOvers)
    : Math.max(0, maxOvers - oversBowled);
  const workloadRatio = maxOvers > 0 ? oversBowled / maxOvers : 0;
  const legacyConsecutiveOvers = Math.max(0, Number(input.telemetry.consecutiveOvers) || 0);
  const quotaComplete = input.telemetry.quotaComplete === true || (maxOvers < 999 && oversBowled >= maxOvers);

  if (mode === 'full') {
    return {
      intent: 'full',
        selectedAgents: ['fatigue', 'risk', 'tactical'],
        reason: 'Full combined analysis requested; running all agents.',
        signals: {
          fatigueIndex: clamp(Number(input.telemetry.fatigueIndex) || 0, 0, 10),
          injuryRisk: String(input.telemetry.injuryRisk || 'UNKNOWN').toUpperCase(),
          noBallRisk: String(input.telemetry.noBallRisk || 'UNKNOWN').toUpperCase(),
          heartRateRecovery: String(input.telemetry.heartRateRecovery || 'Unknown'),
        oversBowled,
        consecutiveOvers: legacyConsecutiveOvers,
        maxOvers,
        quotaComplete,
        phase: String(input.matchContext.phase || 'middle'),
        wicketsInHand: Math.max(0, Number(input.matchContext.wicketsInHand) || 0),
        oversRemaining,
        isUnfit: Boolean(input.telemetry.isUnfit),
      },
    };
  }

  const fatigueIndex = clamp(Number(input.telemetry.fatigueIndex) || 0, 0, 10);
  const injuryRisk = String(input.telemetry.injuryRisk || 'UNKNOWN').toUpperCase();
  const noBallRisk = String(input.telemetry.noBallRisk || 'UNKNOWN').toUpperCase();
  const consecutiveOvers = legacyConsecutiveOvers;
  const isUnfit = Boolean(input.telemetry.isUnfit);
  const riskUnknown = injuryRisk === 'UNKNOWN' || noBallRisk === 'UNKNOWN';
  const substitutionTrigger = injuryRisk === 'HIGH' || (noBallRisk === 'HIGH' && fatigueIndex >= 6);

  let intent: RouterDecision['intent'];
  let selectedAgents: Array<'fatigue' | 'risk' | 'tactical'>;
  let reason: string;

  if (quotaComplete && substitutionTrigger) {
    intent = 'substitution';
    selectedAgents = ['risk', 'tactical'];
    reason = 'Bowling quota completed and medical substitution trigger met; tactical + risk review required.';
  } else if (quotaComplete) {
    intent = 'substitution';
    selectedAgents = ['tactical'];
    reason = 'Bowling quota completed for current format; substitution is required by rule limit.';
  } else if (substitutionTrigger) {
    intent = 'substitution';
    selectedAgents = ['risk', 'tactical'];
    reason = 'Substitution trigger met: injury is HIGH or no-ball risk is HIGH with fatigue >= 6.';
  } else if (riskUnknown) {
    intent = 'risk_check';
    selectedAgents = ['risk'];
    reason = 'Risk telemetry is incomplete (UNKNOWN); substitution routing is skipped until risk is known.';
  } else if (fatigueIndex >= 4 || workloadRatio >= 0.5 || oversRemaining <= 1) {
    intent = 'fatigue_check';
    selectedAgents = ['fatigue'];
    reason = 'Workload quota trend indicates fatigue check is required.';
  } else if (noBallRisk === 'HIGH') {
    intent = 'risk_check';
    selectedAgents = ['risk'];
    reason = 'No-ball risk is high but fatigue is below substitution threshold; routing to risk agent.';
  } else {
    intent = 'risk_check';
    selectedAgents = ['tactical'];
    reason = 'No substitution trigger met; tactical recommendation only.';
  }

  return {
    intent,
    selectedAgents,
    reason,
    signals: {
      fatigueIndex,
      injuryRisk,
      noBallRisk,
      heartRateRecovery: String(input.telemetry.heartRateRecovery || 'Unknown'),
      oversBowled,
      consecutiveOvers,
      maxOvers,
      quotaComplete,
      phase: String(input.matchContext.phase || 'middle'),
      wicketsInHand: Math.max(0, Number(input.matchContext.wicketsInHand) || 0),
      oversRemaining,
      isUnfit,
    },
  };
}

function buildCombinedDecision(result: {
  fatigue?: OrchestrateResponse['fatigue'];
  risk?: OrchestrateResponse['risk'];
  tactical?: OrchestrateResponse['tactical'];
}) {
  const riskSeverity = String(result.risk?.severity || '').toUpperCase();
  const riskIsCritical = riskSeverity === 'CRITICAL' || riskSeverity === 'HIGH';

  // Safety-first merge: critical/high risk overrides tactical creativity.
  if (riskIsCritical && result.risk) {
    const tacticalAdds = result.tactical?.suggestedAdjustments || [];
    return {
      immediateAction: result.risk.recommendation || 'Protect workload and rotate immediately',
      substitutionAdvice: result.tactical?.substitutionAdvice,
      suggestedAdjustments: [result.risk.recommendation, ...tacticalAdds].filter(Boolean).slice(0, 4) as string[],
      confidence: Math.max(0.7, result.tactical?.confidence || 0, severityToConfidence(result.risk.severity)),
      rationale: `Safety-first merge: ${result.risk.headline}${result.tactical ? ` | Tactical: ${result.tactical.immediateAction}` : ''}`,
    };
  }

  if (result.tactical) {
    return {
      immediateAction: result.tactical.immediateAction,
      substitutionAdvice: result.tactical.substitutionAdvice,
      suggestedAdjustments: result.tactical.suggestedAdjustments,
      confidence: result.tactical.confidence,
      rationale: result.tactical.rationale,
    };
  }

  return {
    immediateAction: riskIsCritical
      ? 'Protect workload and rotate immediately'
      : String(result.fatigue?.severity || '').toUpperCase() === 'HIGH'
        ? 'Reduce spell intensity and monitor closely'
        : 'Continue with monitored plan',
    suggestedAdjustments: [
      result.fatigue?.recommendation || 'Monitor fatigue trend over next over.',
      result.risk?.recommendation || 'Track risk indicators before next decision.',
    ],
    confidence: Math.max(severityToConfidence(result.fatigue?.severity), severityToConfidence(result.risk?.severity)),
    rationale: [result.fatigue?.headline, result.risk?.headline].filter(Boolean).join(' | ') || 'Derived from executed agents.',
  };
}

export async function orchestrateAgents(input: OrchestrateRequest, context: InvocationContext): Promise<OrchestrateResponse> {
  const requestId = randomUUID();
  const mode: 'auto' | 'full' = input.mode === 'full' ? 'full' : 'auto';
  const intent: OrchestrateIntent = input.intent || 'monitor';
  const startedAt = Date.now();
  const timingsMs: OrchestrateResponse['meta']['timingsMs'] = { total: 0 };
  const errors: AgentError[] = [];
  const fallbacksUsed: string[] = [];

  let fatigue: OrchestrateResponse['fatigue'];
  let risk: OrchestrateResponse['risk'];
  let tactical: OrchestrateResponse['tactical'];
  let fatigueModel = 'n/a';
  let riskModel = 'n/a';
  let tacticalModel = 'n/a';
  const aoai = getAoaiConfig();

  const triggers = computeTriggers(input);
  const routerDecision = buildRouterDecision(mode, input);
  const executedAgents: Array<'fatigue' | 'risk' | 'tactical'> = [...routerDecision.selectedAgents];
  const hasRiskOrFatigueTrigger = executedAgents.includes('fatigue') || executedAgents.includes('risk');
  if (mode === 'full' || hasRiskOrFatigueTrigger) {
    if (!executedAgents.includes('tactical')) executedAgents.push('tactical');
  }

  const fatiguePromise: Promise<FatigueAgentRunResult | undefined> = executedAgents.includes('fatigue')
    ? (async () => {
        const fatigueStart = Date.now();
        try {
          const result = await runFatigueAgent(toFatigueRequest(input, `${input.telemetry.playerId}:${Date.now()}`));
          timingsMs.fatigue = Date.now() - fatigueStart;
          return result;
        } catch (error) {
          timingsMs.fatigue = Date.now() - fatigueStart;
          const message = error instanceof Error ? error.message : 'Fatigue agent failed';
          context.error('orchestrator fatigue failed', { requestId, message });
          errors.push({ agent: 'fatigue', message });
          return buildFatigueFallback(toFatigueRequest(input, `${input.telemetry.playerId}:${Date.now()}`), `orchestrator-error:${message}`);
        }
      })()
    : Promise.resolve(undefined);

  const riskPromise: Promise<RiskAgentRunResult | undefined> = executedAgents.includes('risk')
    ? (async () => {
        const riskStart = Date.now();
        try {
          const result = await runRiskAgent(toRiskRequest(input));
          timingsMs.risk = Date.now() - riskStart;
          return result;
        } catch (error) {
          timingsMs.risk = Date.now() - riskStart;
          const message = error instanceof Error ? error.message : 'Risk agent failed';
          context.error('orchestrator risk failed', { requestId, message });
          errors.push({ agent: 'risk', message });
          return buildRiskFallback(toRiskRequest(input), `orchestrator-error:${message}`);
        }
      })()
    : Promise.resolve(undefined);

  const tacticalPromise = executedAgents.includes('tactical')
    ? (async () => {
        const tacticalStart = Date.now();
        const [fatigueResult, riskResult] = await Promise.all([fatiguePromise, riskPromise]);
        try {
          const result = await runTacticalAgent({
            requestId,
            intent,
            matchContext: input.matchContext,
            telemetry: input.telemetry,
            players: input.players,
            fatigueOutput: fatigueResult?.output,
            riskOutput: riskResult?.output,
          });
          timingsMs.tactical = Date.now() - tacticalStart;
          return result;
        } catch (error) {
          timingsMs.tactical = Date.now() - tacticalStart;
          const message = error instanceof Error ? error.message : 'Tactical agent failed';
          context.error('orchestrator tactical failed', { requestId, message });
          errors.push({ agent: 'tactical', message });
          return buildTacticalFallback(
            {
              requestId,
              intent,
              matchContext: input.matchContext,
              telemetry: input.telemetry,
              players: input.players,
              fatigueOutput: fatigueResult?.output,
              riskOutput: riskResult?.output,
            },
            `orchestrator-error:${message}`
          );
        }
      })()
    : Promise.resolve(undefined);

  const [fatigueResult, riskResult, tacticalResult] = await Promise.all([fatiguePromise, riskPromise, tacticalPromise]);

  if (fatigueResult) {
    fatigue = {
      ...fatigueResult.output,
      status: fatigueResult.output.status || (fatigueResult.fallbacksUsed.length > 0 ? 'fallback' : 'ok'),
    };
    fatigueModel = fatigueResult.model;
    fallbacksUsed.push(...fatigueResult.fallbacksUsed);
  }

  if (riskResult) {
    risk = {
      ...riskResult.output,
      status: riskResult.output.status || (riskResult.fallbacksUsed.length > 0 ? 'fallback' : 'ok'),
    };
    riskModel = riskResult.model;
    fallbacksUsed.push(...riskResult.fallbacksUsed);
  }

  if (tacticalResult) {
    tactical = tacticalResult.output;
    tacticalModel = tacticalResult.model;
    fallbacksUsed.push(...tacticalResult.fallbacksUsed);
  }

  timingsMs.total = Date.now() - startedAt;

  const sorted = [
    { key: 'fatigue', value: triggers.fatigue },
    { key: 'risk', value: triggers.risk },
    { key: 'tactical', value: triggers.tactical },
  ].sort((a, b) => b.value - a.value);
  const topGap = Math.abs(sorted[0].value - sorted[1].value);
  const confidenceSignals = [severityToConfidence(fatigue?.severity), severityToConfidence(risk?.severity), tactical?.confidence].filter(
    (v): v is number => typeof v === 'number'
  );
  const hasLowConfidence = confidenceSignals.some((value) => value < 0.55);
  const suggestFullAnalysis = mode === 'auto' && (topGap <= 10 || hasLowConfidence);

  if (mode === 'auto' && suggestFullAnalysis && !executedAgents.includes('tactical')) {
    const tacticalStart = Date.now();
    try {
      const tacticalResult = await runTacticalAgent({
        requestId,
        intent,
        matchContext: input.matchContext,
        telemetry: input.telemetry,
        players: input.players,
        fatigueOutput: fatigue,
        riskOutput: risk,
      });
      tactical = tacticalResult.output;
      tacticalModel = tacticalResult.model;
      timingsMs.tactical = Date.now() - tacticalStart;
      fallbacksUsed.push(...tacticalResult.fallbacksUsed);
      executedAgents.push('tactical');
    } catch (error) {
      timingsMs.tactical = Date.now() - tacticalStart;
      const message = error instanceof Error ? error.message : 'Tactical agent failed';
      const fallback = buildTacticalFallback(
        {
          requestId,
          intent,
          matchContext: input.matchContext,
          telemetry: input.telemetry,
          players: input.players,
          fatigueOutput: fatigue,
          riskOutput: risk,
        },
        `orchestrator-error:${message}`
      );
      tactical = fallback.output;
      tacticalModel = fallback.model;
      fallbacksUsed.push(...fallback.fallbacksUsed);
      errors.push({ agent: 'tactical', message });
      context.error('orchestrator tactical failed (suggestFullAnalysis)', { requestId, message });
    }
  }

  const maxOvers = Math.max(1, Number(input.telemetry.maxOvers) || maxOversByFormat(input.matchContext.format));
  const oversBowled = clamp(Number(input.telemetry.oversBowled) || 0, 0, maxOvers);
  const quotaComplete = input.telemetry.quotaComplete === true || (maxOvers < 999 && oversBowled >= maxOvers);
  const riskSeverityUpper = String(risk?.severity || '').toUpperCase();
  const medicalRiskCritical = riskSeverityUpper === 'HIGH' || riskSeverityUpper === 'CRITICAL';

  const combinedDecision = quotaComplete && !medicalRiskCritical
    ? {
        immediateAction: `Substitute ${input.telemetry.playerName || 'current bowler'} now (overs quota complete).`,
        substitutionAdvice: {
          out: input.players.bowler || input.telemetry.playerName || 'Current bowler',
          in: input.players.bench?.[0] || 'Available replacement',
          reason: 'Rule limit reached: bowler has completed maximum overs for this format.',
        },
        suggestedAdjustments: [
          `Quota reached: ${oversBowled}/${maxOvers} overs.`,
          'Rotate to the next eligible bowler immediately.',
          'Keep injury monitoring separate from quota-based substitution.',
        ],
        confidence: 0.9,
        rationale: 'Rule-lock substitution: bowling quota completed for current match format.',
      }
    : buildCombinedDecision({ fatigue, risk, tactical });
  const finalDecision = combinedDecision;
  const usedFallbackAgents: Array<'fatigue' | 'risk' | 'tactical'> = [];
  if (fatigue?.status === 'fallback') usedFallbackAgents.push('fatigue');
  if (risk?.status === 'fallback') usedFallbackAgents.push('risk');
  if (tactical?.status === 'fallback') usedFallbackAgents.push('tactical');
  const routerDecisionWithExecution = {
    ...routerDecision,
    selectedAgents: executedAgents,
    reason:
      mode === 'full'
        ? routerDecision.reason
        : hasRiskOrFatigueTrigger && !routerDecision.selectedAgents.includes('tactical')
          ? `${routerDecision.reason} Tactical agent auto-appended for action synthesis.`
          : routerDecision.reason,
  };
  const runFlags = {
    fatigue: executedAgents.includes('fatigue'),
    risk: executedAgents.includes('risk'),
    tactical: executedAgents.includes('tactical'),
  };
  const fatigueStatus = toAgentStatus(fatigue?.status, runFlags.fatigue);
  const riskStatus = toAgentStatus(risk?.status, runFlags.risk);
  const tacticalStatus = toAgentStatus(tactical?.status, runFlags.tactical);
  const hasFallback = fatigueStatus === 'FALLBACK' || riskStatus === 'FALLBACK' || tacticalStatus === 'FALLBACK';
  const finalRecommendation = {
    title: toSummaryText(combinedDecision.immediateAction, 'Continue with monitored plan'),
    bulletReasons: [
      toSummaryText(combinedDecision.rationale, 'Derived from executed agents.'),
      ...(combinedDecision.suggestedAdjustments || []).slice(0, 3).map((item) => toSummaryText(item, '')),
    ].filter(Boolean),
    confidence: Number(Math.max(0, Math.min(1, Number(combinedDecision.confidence) || 0.55)).toFixed(2)),
    source: (hasFallback ? 'FALLBACK' : 'MODEL') as 'MODEL' | 'FALLBACK',
  };
  const agentResults: OrchestrateResponse['agentResults'] = {
    fatigue: {
      status: fatigueStatus,
      summaryTitle: toSummaryText(fatigue?.headline, 'Fatigue analysis'),
      summary: toSummaryText(fatigue?.recommendation || fatigue?.explanation, runFlags.fatigue ? 'No fatigue summary available.' : 'Skipped by router.'),
      signals: toSummarySignals(fatigue?.signals),
      ...(fatigue ? { data: fatigue as unknown as Record<string, unknown> } : {}),
      ...(fatigueStatus === 'FALLBACK' ? { fallbackReason: 'Rule-based fallback used for fatigue analysis.' } : {}),
    },
    risk: {
      status: riskStatus,
      summaryTitle: toSummaryText(risk?.headline, 'Risk analysis'),
      summary: toSummaryText(risk?.recommendation || risk?.explanation, runFlags.risk ? 'No risk summary available.' : 'Skipped by router.'),
      signals: toSummarySignals(risk?.signals),
      ...(risk ? { data: risk as unknown as Record<string, unknown> } : {}),
      ...(riskStatus === 'FALLBACK' ? { fallbackReason: 'Rule-based fallback used for risk analysis.' } : {}),
    },
    tactical: {
      status: tacticalStatus,
      summaryTitle: toSummaryText(tactical?.immediateAction, 'Tactical recommendation'),
      summary: toSummaryText(tactical?.rationale, runFlags.tactical ? 'No tactical summary available.' : 'Skipped by router.'),
      signals: toSummarySignals(tactical?.keySignalsUsed),
      ...(tactical ? { data: tactical as unknown as Record<string, unknown> } : {}),
      ...(tacticalStatus === 'FALLBACK' ? { fallbackReason: 'Heuristic fallback used for tactical analysis.' } : {}),
    },
  };

  return {
    ...(fatigue ? { fatigue } : {}),
    ...(risk ? { risk } : {}),
    ...(tactical ? { tactical } : {}),
    agentOutputs: {
      ...(fatigue ? { fatigue: { ...fatigue, status: fatigue.status || 'ok' } } : {}),
      ...(risk ? { risk: { ...risk, status: risk.status || 'ok' } } : {}),
      ...(tactical ? { tactical } : {}),
    },
    finalDecision,
    combinedDecision,
    finalRecommendation,
    ...(risk?.riskDebug ? { riskDebug: risk.riskDebug } : {}),
    errors,
    routerIntent: routerDecisionWithExecution.intent,
    router: {
      status: 'OK',
      intent: routerDecisionWithExecution.intent,
      run: runFlags,
      reason: routerDecisionWithExecution.reason,
    },
    agentResults,
    routerDecision: routerDecisionWithExecution,
    meta: {
      requestId,
      mode,
      intent,
      executedAgents,
      triggers,
      suggestFullAnalysis,
      modelRouting: {
        fatigueModel,
        riskModel,
        tacticalModel,
        fallbacksUsed,
      },
      usedFallbackAgents,
      ...(aoai.ok ? {} : { aoai: { missing: aoai.missing } }),
      timingsMs,
    },
  };
}
