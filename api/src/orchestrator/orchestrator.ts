import { randomUUID } from 'crypto';
import { InvocationContext } from '@azure/functions';
import { runFatigueAgent } from '../agents/fatigueAgent';
import { runRiskAgent } from '../agents/riskAgent';
import { runTacticalAgent } from '../agents/tacticalAgent';
import {
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

const severityToConfidence = (severity?: string): number => {
  const upper = String(severity || '').toUpperCase();
  if (upper === 'CRITICAL') return 0.52;
  if (upper === 'HIGH') return 0.58;
  if (upper === 'MED' || upper === 'MEDIUM') return 0.68;
  return 0.78;
};

function computeTriggers(input: OrchestrateRequest): TriggerScores {
  const fatigueIndex = clamp(Number(input.telemetry.fatigueIndex) || 0, 0, 10);
  const consecutiveOvers = Math.max(0, Number(input.telemetry.consecutiveOvers) || 0);
  const oversBowled = Math.max(0, Number(input.telemetry.oversBowled) || 0);
  const recovery = String(input.telemetry.heartRateRecovery || 'Moderate').toLowerCase();
  const injuryRisk = String(input.telemetry.injuryRisk || 'MEDIUM').toUpperCase();
  const noBallRisk = String(input.telemetry.noBallRisk || 'MEDIUM').toUpperCase();
  const rrGap = Math.max(0, input.matchContext.requiredRunRate - input.matchContext.currentRunRate);
  const phase = String(input.matchContext.phase || 'middle').toLowerCase();
  const wicketsInHand = Math.max(0, Number(input.matchContext.wicketsInHand) || 0);
  const intent = (input.intent || 'monitor') as OrchestrateIntent;

  const fatigueTrigger = clamp(
    fatigueIndex * 8 +
      consecutiveOvers * 4 +
      oversBowled * 1.2 +
      (recovery === 'poor' ? 12 : recovery === 'moderate' ? 6 : 0),
    0,
    100
  );

  const riskTrigger = clamp(
    (injuryRisk === 'HIGH' ? 40 : injuryRisk === 'MED' || injuryRisk === 'MEDIUM' ? 20 : 8) +
      (noBallRisk === 'HIGH' ? 25 : noBallRisk === 'MED' || noBallRisk === 'MEDIUM' ? 12 : 4) +
      fatigueIndex * 3 +
      consecutiveOvers * 4,
    0,
    100
  );

  const tacticalTrigger = clamp(
    rrGap * 12 +
      (phase === 'death' ? 25 : phase === 'powerplay' ? 10 : 8) +
      (wicketsInHand <= 3 ? 20 : wicketsInHand <= 5 ? 10 : 4) +
      (intent === 'strategy' || intent === 'substitution' || intent === 'full' ? 18 : 0),
    0,
    100
  );

  return {
    fatigue: Math.round(fatigueTrigger),
    risk: Math.round(riskTrigger),
    tactical: Math.round(tacticalTrigger),
  };
}

function buildRouterDecision(mode: 'auto' | 'full', input: OrchestrateRequest): RouterDecision {
  if (mode === 'full') {
    return {
      intent: 'full',
      selectedAgents: ['fatigue', 'risk', 'tactical'],
      reason: 'Full combined analysis requested; running all agents.',
      signals: {
        fatigueIndex: clamp(Number(input.telemetry.fatigueIndex) || 0, 0, 10),
        injuryRisk: String(input.telemetry.injuryRisk || 'MEDIUM').toUpperCase(),
        noBallRisk: String(input.telemetry.noBallRisk || 'MEDIUM').toUpperCase(),
        heartRateRecovery: String(input.telemetry.heartRateRecovery || 'Moderate'),
        oversBowled: Math.max(0, Number(input.telemetry.oversBowled) || 0),
        consecutiveOvers: Math.max(0, Number(input.telemetry.consecutiveOvers) || 0),
        phase: String(input.matchContext.phase || 'middle'),
        wicketsInHand: Math.max(0, Number(input.matchContext.wicketsInHand) || 0),
        oversRemaining: Math.max(0, Number(input.matchContext.oversRemaining) || 0),
        isUnfit: Boolean(input.telemetry.isUnfit),
      },
    };
  }

  const fatigueIndex = clamp(Number(input.telemetry.fatigueIndex) || 0, 0, 10);
  const recovery = String(input.telemetry.heartRateRecovery || 'Moderate');
  const injuryRisk = String(input.telemetry.injuryRisk || 'MEDIUM').toUpperCase();
  const noBallRisk = String(input.telemetry.noBallRisk || 'MEDIUM').toUpperCase();
  const oversBowled = Math.max(0, Number(input.telemetry.oversBowled) || 0);
  const consecutiveOvers = Math.max(0, Number(input.telemetry.consecutiveOvers) || 0);
  const isUnfit = Boolean(input.telemetry.isUnfit);

  let intent: RouterDecision['intent'];
  let selectedAgents: Array<'fatigue' | 'risk' | 'tactical'>;
  let reason: string;

  if (isUnfit || injuryRisk === 'HIGH' || injuryRisk === 'CRITICAL' || fatigueIndex >= 7 || recovery.toLowerCase() === 'poor') {
    intent = 'substitution';
    selectedAgents = ['risk', 'tactical'];
    reason = 'Safety-critical signals detected; prioritizing risk + tactical substitution guidance.';
  } else if (fatigueIndex >= 4 || consecutiveOvers >= 2 || oversBowled >= 4) {
    intent = 'fatigue_check';
    selectedAgents = ['fatigue'];
    reason = 'Workload trend indicates fatigue check is required.';
  } else if (noBallRisk === 'HIGH') {
    intent = 'risk_check';
    selectedAgents = ['risk'];
    reason = 'No-ball risk is elevated; routing to risk agent.';
  } else {
    intent = 'substitution';
    selectedAgents = ['tactical'];
    reason = 'No immediate red flags; tactical next-step recommendation only.';
  }

  return {
    intent,
    selectedAgents,
    reason,
    signals: {
      fatigueIndex,
      injuryRisk,
      noBallRisk,
      heartRateRecovery: recovery,
      oversBowled,
      consecutiveOvers,
      phase: String(input.matchContext.phase || 'middle'),
      wicketsInHand: Math.max(0, Number(input.matchContext.wicketsInHand) || 0),
      oversRemaining: Math.max(0, Number(input.matchContext.oversRemaining) || 0),
      isUnfit,
    },
  };
}

function buildCombinedDecision(result: {
  fatigue?: OrchestrateResponse['fatigue'];
  risk?: OrchestrateResponse['risk'];
  tactical?: OrchestrateResponse['tactical'];
}) {
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
    immediateAction:
      String(result.risk?.severity || '').toUpperCase() === 'CRITICAL' || String(result.risk?.severity || '').toUpperCase() === 'HIGH'
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

  if (executedAgents.includes('fatigue')) {
    const fatigueStart = Date.now();
    try {
      const fatigueResult = await runFatigueAgent(toFatigueRequest(input, `${input.telemetry.playerId}:${Date.now()}`));
      fatigue = { ...fatigueResult.output, status: fatigueResult.fallbacksUsed.length > 0 ? 'fallback' : 'ok' };
      fatigueModel = fatigueResult.model;
      timingsMs.fatigue = Date.now() - fatigueStart;
      fallbacksUsed.push(...fatigueResult.fallbacksUsed);
    } catch (error) {
      timingsMs.fatigue = Date.now() - fatigueStart;
      const message = error instanceof Error ? error.message : 'Fatigue agent failed';
      errors.push({ agent: 'fatigue', message });
      context.error('orchestrator fatigue failed', { requestId, message });
    }
  }

  if (executedAgents.includes('risk')) {
    const riskStart = Date.now();
    try {
      const riskResult = await runRiskAgent(toRiskRequest(input));
      risk = { ...riskResult.output, status: 'ok' };
      riskModel = riskResult.model;
      timingsMs.risk = Date.now() - riskStart;
      fallbacksUsed.push(...riskResult.fallbacksUsed);
    } catch (error) {
      timingsMs.risk = Date.now() - riskStart;
      const message = error instanceof Error ? error.message : 'Risk agent failed';
      errors.push({ agent: 'risk', message });
      context.error('orchestrator risk failed', { requestId, message });
    }
  }

  if (executedAgents.includes('tactical')) {
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
    } catch (error) {
      timingsMs.tactical = Date.now() - tacticalStart;
      const message = error instanceof Error ? error.message : 'Tactical agent failed';
      tactical = {
        status: 'error',
        immediateAction: 'Tactical recommendation unavailable',
        rationale: message,
        suggestedAdjustments: ['Continue with conservative plan until tactical service is restored.'],
        confidence: 0.4,
        keySignalsUsed: ['error'],
      };
      errors.push({ agent: 'tactical', message });
      context.error('orchestrator tactical failed', { requestId, message });
    }
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
      tactical = {
        status: 'error',
        immediateAction: 'Tactical recommendation unavailable',
        rationale: message,
        suggestedAdjustments: ['Continue with conservative plan until tactical service is restored.'],
        confidence: 0.4,
        keySignalsUsed: ['error'],
      };
      errors.push({ agent: 'tactical', message });
      context.error('orchestrator tactical failed (suggestFullAnalysis)', { requestId, message });
    }
  }

  const combinedDecision = buildCombinedDecision({ fatigue, risk, tactical });
  const finalDecision = combinedDecision;
  const usedFallbackAgents: Array<'fatigue' | 'risk' | 'tactical'> = [];
  if (fatigue?.status === 'fallback') usedFallbackAgents.push('fatigue');
  if (risk?.status === 'fallback') usedFallbackAgents.push('risk');
  if (tactical?.status === 'fallback') usedFallbackAgents.push('tactical');

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
    errors,
    routerDecision: {
      ...routerDecision,
      selectedAgents: executedAgents,
      reason:
        mode === 'full'
          ? routerDecision.reason
          : hasRiskOrFatigueTrigger && !routerDecision.selectedAgents.includes('tactical')
            ? `${routerDecision.reason} Tactical agent auto-appended for action synthesis.`
            : routerDecision.reason,
    },
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
