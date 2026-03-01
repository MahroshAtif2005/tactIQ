import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { AgentCode, OrchestrateRequest, RouterDecision } from '../agents/types';
import { callLLMJsonWithRetry, LLMMessage } from '../llm/client';
import { routeModel } from '../llm/router';
import { validateOrchestrateRequest } from '../orchestrator/validation';
import { ROUTES } from '../routes/routes';

type StrategicIntent = 'InjuryPrevention' | 'PressureControl' | 'TacticalAttack' | 'General';
type RouterAgentKey = 'fatigue' | 'risk' | 'tactical';

interface RouterLlmDecision {
  intent: string;
  selectedAgents: string[];
  signalSummaryBullets: string[];
  rationale: string;
}

const AGENT_PRIORITY: RouterAgentKey[] = ['fatigue', 'risk', 'tactical'];

const toNumber = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
};

const normalizeRiskToken = (value: unknown): string => String(value || '').trim().toUpperCase();

const resolveTeamMode = (value: unknown): 'BOWLING' | 'BATTING' => {
  const token = String(value || '').trim().toUpperCase();
  if (token === 'BAT' || token === 'BATTING') return 'BATTING';
  return 'BOWLING';
};

const isNoBallControlSignal = (signals: Record<string, unknown>): boolean => {
  const noBallRisk = normalizeRiskToken(signals.noBallRisk);
  const noBallTrendUp =
    signals.noBallTrendUp === true ||
    String(signals.noBallTrend || '').toUpperCase() === 'UP' ||
    String(signals.noBallSignal || '').toLowerCase() === 'true';
  const recentEvents =
    signals.recentEvents && typeof signals.recentEvents === 'object' && !Array.isArray(signals.recentEvents)
      ? (signals.recentEvents as Record<string, unknown>)
      : {};
  const lastBall = String(signals.lastBall || recentEvents.lastBall || '').toUpperCase();
  const recentNoBallEvent = lastBall === 'NOBALL' || lastBall === 'WIDE';
  return (
    noBallRisk === 'HIGH' ||
    noBallRisk === 'MEDIUM' ||
    noBallRisk === 'MED' ||
    noBallTrendUp ||
    recentNoBallEvent
  );
};

const strongestIntentFromSignals = (signals: Record<string, unknown>): StrategicIntent => {
  const fatigue = toNumber(signals.fatigueIndex);
  const strain = toNumber(signals.strainIndex);
  const injuryRisk = normalizeRiskToken(signals.injuryRisk);
  const pressure = toNumber(signals.pressureIndex);
  if (
    injuryRisk === 'HIGH' ||
    injuryRisk === 'CRITICAL' ||
    (Number.isFinite(fatigue) && fatigue >= 6) ||
    (Number.isFinite(strain) && strain >= 6)
  ) {
    return 'InjuryPrevention';
  }
  if (isNoBallControlSignal(signals)) return 'PressureControl';
  if (Number.isFinite(pressure) && pressure >= 6.5) return 'TacticalAttack';
  return 'General';
};

const toStrategicIntent = (intent: string, signals: Record<string, unknown>): StrategicIntent => {
  const token = String(intent || '').trim().toUpperCase();
  if (token === 'SUBSTITUTION' || token === 'SAFETY_ALERT' || token === 'INJURYPREVENTION') return 'InjuryPrevention';
  if (token === 'BOWLING_NEXT' || token === 'BATTING_NEXT' || token === 'BOTH_NEXT' || token === 'TACTICALATTACK') {
    return 'TacticalAttack';
  }
  if (token === 'PRESSURECONTROL') {
    return isNoBallControlSignal(signals) ? 'PressureControl' : strongestIntentFromSignals(signals);
  }
  return strongestIntentFromSignals(signals);
};

const buildSignalSummaryBullets = (signals: Record<string, unknown>, mode: 'BOWLING' | 'BATTING'): string[] => {
  const bullets: string[] = [];
  const fatigue = toNumber(signals.fatigueIndex);
  const strain = toNumber(signals.strainIndex);
  const noBallRisk = normalizeRiskToken(signals.noBallRisk);
  const injuryRisk = normalizeRiskToken(signals.injuryRisk);
  const hrr = String(signals.heartRateRecovery || '').toLowerCase();
  const oversBowled = toNumber(signals.oversBowled);
  const sleepHours = toNumber(signals.sleepHours);
  const pressure = toNumber(signals.pressureIndex);
  const phase = String(signals.phase || '').toLowerCase();

  if (Number.isFinite(fatigue) && fatigue >= 6.5) bullets.push('Fatigue is approaching the upper workload limit.');
  else if (Number.isFinite(fatigue) && fatigue >= 5) bullets.push('Fatigue is trending upward from recent workload.');
  if (Number.isFinite(strain) && strain >= 6) bullets.push('Strain is elevated and may compromise execution quality.');
  if (injuryRisk === 'HIGH' || injuryRisk === 'CRITICAL') bullets.push('Injury exposure is elevated if the current pattern continues.');
  if (noBallRisk === 'HIGH') bullets.push('No-ball control risk is elevated under pressure.');
  if (hrr.includes('poor') || hrr.includes('slow')) bullets.push('Recovery is lagging between efforts.');
  if (Number.isFinite(oversBowled) && oversBowled >= 3) bullets.push('Current spell workload is high for this phase.');
  if (Number.isFinite(sleepHours) && sleepHours > 0 && sleepHours < 6) bullets.push('Sleep is below baseline, reducing recovery buffer.');
  if (Number.isFinite(pressure) && pressure >= 6.5) bullets.push('Pressure is increasing and reducing control margin.');
  if (phase === 'death') bullets.push('Death phase context amplifies execution and injury trade-offs.');
  if (bullets.length === 0) {
    bullets.push(
      mode === 'BOWLING'
        ? 'Bowling signals are stable; maintain tactical control.'
        : 'Batting signals are stable; maintain tactical continuity.'
    );
  }

  return Array.from(new Set(bullets)).slice(0, 7);
};

const normalizeSelectedAgents = (value: unknown): RouterAgentKey[] => {
  const selected = Array.isArray(value) ? value : [];
  const normalized = selected
    .map((entry) => String(entry).trim().toLowerCase())
    .map((token): RouterAgentKey | null => {
      if (token === 'fatigue' || token === 'fatigueagent') return 'fatigue';
      if (token === 'risk' || token === 'riskagent' || token === 'injury') return 'risk';
      if (token === 'tactical' || token === 'tacticalagent' || token === 'strategy') return 'tactical';
      return null;
    })
    .filter((entry): entry is RouterAgentKey => entry !== null);
  const deduped = AGENT_PRIORITY.filter((agent) => normalized.includes(agent));
  if (!deduped.includes('tactical')) deduped.push('tactical');
  return AGENT_PRIORITY.filter((agent) => deduped.includes(agent));
};

const toAgentCodes = (selectedAgents: RouterAgentKey[]): AgentCode[] =>
  selectedAgents.map((agent): AgentCode => {
    if (agent === 'fatigue') return 'FATIGUE';
    if (agent === 'risk') return 'RISK';
    return 'TACTICAL';
  });

const isRouterLlmDecision = (value: unknown): value is RouterLlmDecision => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as RouterLlmDecision;
  return Boolean(
    typeof candidate.intent === 'string' &&
      Array.isArray(candidate.selectedAgents) &&
      candidate.selectedAgents.every((agent) => typeof agent === 'string') &&
      Array.isArray(candidate.signalSummaryBullets) &&
      candidate.signalSummaryBullets.every((entry) => typeof entry === 'string') &&
      typeof candidate.rationale === 'string'
  );
};

const extractStatusFromErrorMessage = (message: string): number | undefined => {
  const match = message.match(/\((\d{3})\)/);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const buildHardFallbackDecision = (
  mode: 'auto' | 'full',
  validatedValue: OrchestrateRequest
): RouterDecision => {
  const signals: Record<string, unknown> = {
    fatigueIndex: toNumber(validatedValue.telemetry?.fatigueIndex),
    strainIndex: toNumber(validatedValue.telemetry?.strainIndex),
    injuryRisk: validatedValue.telemetry?.injuryRisk,
    noBallRisk: validatedValue.telemetry?.noBallRisk,
    heartRateRecovery: validatedValue.telemetry?.heartRateRecovery,
    oversBowled: validatedValue.telemetry?.oversBowled,
    sleepHours: validatedValue.telemetry?.sleepHours,
    phase: validatedValue.matchContext?.phase,
  };
  return {
    intent: 'GENERAL',
    agentsToRun: ['TACTICAL'],
    selectedAgents: ['tactical'],
    rulesFired: [`mode=${mode}`, 'hardFallback'],
    inputsUsed: {
      activePlayerId: validatedValue.context?.activePlayerId || validatedValue.telemetry?.playerId,
      active: {
        fatigueIndex: toNumber(validatedValue.telemetry?.fatigueIndex),
        strainIndex: toNumber(validatedValue.telemetry?.strainIndex),
        injuryRisk: String(validatedValue.telemetry?.injuryRisk || ''),
        noBallRisk: String(validatedValue.telemetry?.noBallRisk || ''),
      },
      match: {
        matchMode: String(validatedValue.matchContext?.matchMode || validatedValue.matchContext?.teamMode || ''),
        format: String(validatedValue.matchContext?.format || ''),
        phase: String(validatedValue.matchContext?.phase || ''),
        overs: toNumber(validatedValue.matchContext?.over),
        balls: toNumber(validatedValue.matchContext?.balls),
        scoreRuns: toNumber(validatedValue.matchContext?.score),
        wickets: toNumber(validatedValue.matchContext?.wicketsInHand),
        targetRuns: toNumber(validatedValue.matchContext?.target),
        intensity: String(validatedValue.matchContext?.intensity || ''),
      },
    },
    reason: 'Hard fallback router decision used.',
    signals,
  };
};

const buildDeterministicRouterFallback = (
  mode: 'auto' | 'full',
  validatedValue: OrchestrateRequest
): RouterDecision => {
  const teamMode = resolveTeamMode(validatedValue.matchContext?.teamMode || validatedValue.matchContext?.matchMode);
  const fatigueIndex = toNumber(validatedValue.telemetry?.fatigueIndex);
  const strainIndex = toNumber(validatedValue.telemetry?.strainIndex);
  const oversBowled = toNumber(validatedValue.telemetry?.oversBowled);
  const pressureIndex = Math.max(
    toNumber(validatedValue.matchContext?.requiredRunRate) - toNumber(validatedValue.matchContext?.currentRunRate),
    toNumber(validatedValue.signals?.pressureIndex)
  );
  const injuryRisk = normalizeRiskToken(validatedValue.telemetry?.injuryRisk);
  const noBallRisk = normalizeRiskToken(validatedValue.telemetry?.noBallRisk);
  const strainTrendUp =
    validatedValue.signals?.strainTrendUp === true ||
    String(validatedValue.signals?.strainTrend || '').toUpperCase() === 'UP';

  const fatigueSignal =
    (Number.isFinite(fatigueIndex) && fatigueIndex >= 6) ||
    (Number.isFinite(oversBowled) && oversBowled >= 3) ||
    strainTrendUp;
  const riskSignal =
    injuryRisk === 'MED' ||
    injuryRisk === 'MEDIUM' ||
    injuryRisk === 'HIGH' ||
    injuryRisk === 'CRITICAL' ||
    noBallRisk === 'MED' ||
    noBallRisk === 'MEDIUM' ||
    noBallRisk === 'HIGH' ||
    (Number.isFinite(pressureIndex) && pressureIndex >= 6.5) ||
    (Number.isFinite(fatigueIndex) && fatigueIndex >= 6);

  const selectedSet = new Set<RouterAgentKey>();
  selectedSet.add('tactical');
  if (fatigueSignal) selectedSet.add('fatigue');
  if (riskSignal) selectedSet.add('risk');

  if (mode === 'full') {
    selectedSet.add('fatigue');
    selectedSet.add('risk');
  }

  const selectedAgents = AGENT_PRIORITY.filter((agent) => selectedSet.has(agent));
  const intent: RouterDecision['intent'] =
    injuryRisk === 'HIGH' || injuryRisk === 'CRITICAL'
      ? 'SAFETY_ALERT'
      : teamMode === 'BATTING'
        ? 'BATTING_NEXT'
        : 'GENERAL';

  const signals: Record<string, unknown> = {
    fatigueIndex: Number.isFinite(fatigueIndex) ? fatigueIndex : undefined,
    strainIndex: Number.isFinite(strainIndex) ? strainIndex : undefined,
    injuryRisk: validatedValue.telemetry?.injuryRisk,
    noBallRisk: validatedValue.telemetry?.noBallRisk,
    heartRateRecovery: validatedValue.telemetry?.heartRateRecovery,
    oversBowled: validatedValue.telemetry?.oversBowled,
    sleepHours: validatedValue.telemetry?.sleepHours,
    pressureIndex: Number.isFinite(pressureIndex) ? pressureIndex : undefined,
    phase: validatedValue.matchContext?.phase,
    mode: teamMode,
  };

  return {
    intent,
    agentsToRun: toAgentCodes(selectedAgents),
    selectedAgents,
    rulesFired: [`mode=${mode}`, 'deterministicFallback'],
    inputsUsed: {
      activePlayerId: validatedValue.context?.activePlayerId || validatedValue.telemetry?.playerId,
      active: {
        fatigueIndex: Number.isFinite(fatigueIndex) ? fatigueIndex : undefined,
        strainIndex: Number.isFinite(strainIndex) ? strainIndex : undefined,
        injuryRisk: String(validatedValue.telemetry?.injuryRisk || ''),
        noBallRisk: String(validatedValue.telemetry?.noBallRisk || ''),
      },
      match: {
        matchMode: String(validatedValue.matchContext?.matchMode || validatedValue.matchContext?.teamMode || ''),
        format: String(validatedValue.matchContext?.format || ''),
        phase: String(validatedValue.matchContext?.phase || ''),
        overs: toNumber(validatedValue.matchContext?.over),
        balls: toNumber(validatedValue.matchContext?.balls),
        scoreRuns: toNumber(validatedValue.matchContext?.score),
        wickets: toNumber(validatedValue.matchContext?.wicketsInHand),
        targetRuns: toNumber(validatedValue.matchContext?.target),
        intensity: String(validatedValue.matchContext?.intensity || ''),
      },
    },
    reason: 'Deterministic routing selected agents from live signal rules.',
    signals,
  };
};

const buildRouterLlmMessages = (
  mode: 'auto' | 'full',
  teamMode: 'BOWLING' | 'BATTING',
  validatedValue: OrchestrateRequest,
  signals: Record<string, unknown>
): LLMMessage[] => [
  {
    role: 'system',
    content:
      'You are a cricket router that decides which agents to run. ' +
      'Return ONLY valid JSON. No markdown. No explanation. ' +
      'Schema: {"intent":string,"selectedAgents":string[],"signalSummaryBullets":string[],"rationale":string}. ' +
      'selectedAgents must only contain fatigue, risk, tactical. tactical must be included unless all signals are empty. ' +
      'Keep signalSummaryBullets coach-friendly and concise (3-7 bullets).',
  },
  {
    role: 'user',
    content: JSON.stringify({
      task: 'Route tactical coaching agents for current match state.',
      mode,
      teamMode,
      context: {
        activePlayerId: validatedValue.context?.activePlayerId || validatedValue.telemetry?.playerId,
      },
      telemetry: validatedValue.telemetry || {},
      matchContext: validatedValue.matchContext || {},
      incomingSignals: validatedValue.signals || {},
      derivedSignals: signals,
      rules: {
        alwaysIncludeTactical: true,
        includeFatigueWhen: 'fatigueIndex>=6 OR oversBowled high OR strain trend up',
        includeRiskWhen: 'injury/no-ball risk medium+ OR pressure high OR fatigueIndex>=6',
      },
    }),
  },
];

export async function routerHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const requestContentType = String(request.headers.get('content-type') || '').toLowerCase() || 'unknown';
    const body = await request.json();
    const validated = validateOrchestrateRequest(body);
    if (!validated.ok) {
      return {
        status: 400,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        jsonBody: {
          error: validated.message,
          code: 'ROUTER_INVALID_PAYLOAD',
        },
      };
    }

    const mode = validated.value.mode === 'full' ? 'full' : 'auto';
    const teamMode = resolveTeamMode(validated.value.matchContext?.teamMode || validated.value.matchContext?.matchMode);
    const selectedPlayerId = validated.value.context?.activePlayerId || validated.value.telemetry?.playerId || 'UNKNOWN';
    const payloadSummary = {
      playerId: selectedPlayerId,
      mode: teamMode,
      over: Number(validated.value.matchContext?.over || 0),
      fatigue: Number(toNumber(validated.value.telemetry?.fatigueIndex)),
      strain: Number(toNumber(validated.value.telemetry?.strainIndex)),
    };
    context.log('ROUTER_ENDPOINT_HIT', { requestContentType, payload: payloadSummary });
    context.log('ROUTER_LLM_PARSE_TARGET', {
      responseFormat: 'json_object',
      expectedContentType: 'application/json',
      parseField: 'choices[0].message.content',
    });

    let deterministicDecision: RouterDecision;
    try {
      deterministicDecision = buildDeterministicRouterFallback(mode, validated.value);
    } catch (fallbackError) {
      const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      context.error('COACH_ANALYSIS_ROUTER_DETERMINISTIC_FAILED', { message: fallbackMessage });
      deterministicDecision = buildHardFallbackDecision(mode, validated.value);
    }

    let decision = deterministicDecision;
    let rawIntentToken = String(deterministicDecision.intent || 'GENERAL');
    let signalSummaryBullets = buildSignalSummaryBullets(deterministicDecision.signals || {}, teamMode);
    let fallbackRoutingUsed = false;
    let routerUnavailable = false;

    try {
      const routing = routeModel({ task: 'tactical', needsJson: true, complexity: 'medium' });
      const llmMessages = buildRouterLlmMessages(mode, teamMode, validated.value, deterministicDecision.signals || {});
      const llmDecision = await callLLMJsonWithRetry<RouterLlmDecision>({
        deployment: routing.deployment,
        fallbackDeployment: routing.fallbackDeployment,
        baseMessages: llmMessages,
        strictSystemMessage:
          'Return ONLY valid JSON. No markdown. No explanation. Required keys: intent, selectedAgents, signalSummaryBullets, rationale.',
        validate: isRouterLlmDecision,
        temperature: routing.temperature,
        maxTokens: Math.max(280, routing.maxTokens),
      });
      const llmSelectedAgents = normalizeSelectedAgents(llmDecision.parsed.selectedAgents);
      decision = {
        ...deterministicDecision,
        agentsToRun: toAgentCodes(llmSelectedAgents),
        selectedAgents: llmSelectedAgents,
        rulesFired: [...(deterministicDecision.rulesFired || []), 'llmRouter'],
        reason: llmDecision.parsed.rationale || deterministicDecision.reason,
      };
      rawIntentToken = llmDecision.parsed.intent || rawIntentToken;
      signalSummaryBullets =
        llmDecision.parsed.signalSummaryBullets && llmDecision.parsed.signalSummaryBullets.length > 0
          ? llmDecision.parsed.signalSummaryBullets
              .map((entry) => String(entry).trim())
              .filter(Boolean)
              .slice(0, 7)
          : signalSummaryBullets;
      context.log('ROUTER_LLM_SUCCESS', {
        selectedAgents: llmSelectedAgents,
        deploymentUsed: llmDecision.deploymentUsed,
        fallbackModels: llmDecision.fallbacksUsed,
      });
    } catch (llmError) {
      fallbackRoutingUsed = true;
      const message = llmError instanceof Error ? llmError.message : String(llmError);
      context.error('COACH_ANALYSIS_ROUTER_FAILED', {
        status: extractStatusFromErrorMessage(message),
        message: message.slice(0, 240),
        parseField: 'choices[0].message.content',
        responseFormat: 'json_object',
      });
      decision = deterministicDecision;
      rawIntentToken = String(deterministicDecision.intent || rawIntentToken);
      signalSummaryBullets = buildSignalSummaryBullets(deterministicDecision.signals || {}, teamMode);
    }

    if (!decision || !Array.isArray(decision.selectedAgents) || decision.selectedAgents.length === 0) {
      fallbackRoutingUsed = true;
      decision = deterministicDecision;
      rawIntentToken = String(deterministicDecision.intent || rawIntentToken);
      signalSummaryBullets = buildSignalSummaryBullets(deterministicDecision.signals || {}, teamMode);
    }

    const selectedSet = new Set<RouterAgentKey>(normalizeSelectedAgents(decision.selectedAgents));
    const fatigueValue = toNumber(decision.signals?.fatigueIndex);
    const strainValue = toNumber(decision.signals?.strainIndex);
    const noBallControlSignal = isNoBallControlSignal(decision.signals || {});
    const injuryRisk = normalizeRiskToken(decision.signals?.injuryRisk);
    const pressureValue = toNumber(decision.signals?.pressureIndex);

    if ((Number.isFinite(fatigueValue) && fatigueValue >= 6) || (Number.isFinite(strainValue) && strainValue >= 6)) {
      selectedSet.add('fatigue');
    }
    if (
      noBallControlSignal ||
      injuryRisk === 'MED' ||
      injuryRisk === 'MEDIUM' ||
      injuryRisk === 'HIGH' ||
      injuryRisk === 'CRITICAL' ||
      (Number.isFinite(pressureValue) && pressureValue >= 6.5) ||
      (Number.isFinite(fatigueValue) && fatigueValue >= 6)
    ) {
      selectedSet.add('risk');
    }
    selectedSet.add('tactical');

    const finalSelectedAgents: RouterAgentKey[] = AGENT_PRIORITY.filter((agent) => selectedSet.has(agent));
    const finalAgentCodes = toAgentCodes(finalSelectedAgents);
    const normalizedSignals = { ...(decision.signals || {}) };
    const strategicIntent = toStrategicIntent(rawIntentToken, normalizedSignals);
    const rationalePrefix = fallbackRoutingUsed ? 'Fallback routing used due temporary LLM issue. ' : '';
    const rationale =
      `${rationalePrefix}${decision.reason} Router intent mapped to ${strategicIntent} for coach briefing clarity.`.trim();

    if (!Array.isArray(finalSelectedAgents) || finalSelectedAgents.length === 0) {
      routerUnavailable = true;
    }

    return {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      jsonBody: {
        intent: strategicIntent,
        run: {
          fatigue: finalSelectedAgents.includes('fatigue'),
          risk: finalSelectedAgents.includes('risk'),
          tactical: finalSelectedAgents.includes('tactical'),
        },
        agentsToRun: finalAgentCodes,
        selectedAgents: finalSelectedAgents,
        signalSummaryBullets,
        rationale,
        reason: decision.reason,
        signals: normalizedSignals,
        rulesFired: decision.rulesFired,
        inputsUsed: decision.inputsUsed,
        fallbackRoutingUsed,
        routerUnavailable,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Router handler failed';
    context.error('ROUTER_HANDLER_ERROR', { message: message.slice(0, 240) });
    return {
      status: 500,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      jsonBody: {
        error: 'Router request failed',
        code: 'ROUTER_HANDLER_ERROR',
      },
    };
  }
}

app.http('router', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: ROUTES.router,
  handler: routerHandler,
});
