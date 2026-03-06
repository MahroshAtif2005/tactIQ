const { randomUUID } = require('crypto');
const {
  jsonResponse,
  optionsResponse,
  normalizeBody,
  resolveAiExecution,
  isLlmConfigured,
} = require('../shared/agentRuntime');
const { buildAoaiChatUrl } = require('../shared/aoaiConfig');
const { runOrchestrateFallback } = require('../shared/simpleAgents');

let orchestratorCore = null;
let validationCore = null;
try {
  orchestratorCore = require('../dist/orchestrator/orchestrator');
} catch {
  orchestratorCore = null;
}
try {
  validationCore = require('../dist/orchestrator/validation');
} catch {
  validationCore = null;
}

const asRecord = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const asArray = (value) => (Array.isArray(value) ? value : []);
const firstText = (...values) => {
  for (const value of values) {
    const normalized = String(value || '').trim();
    if (normalized) return normalized;
  }
  return '';
};

const dedupeReasons = (values) =>
  Array.from(new Set((Array.isArray(values) ? values : []).map((entry) => String(entry || '').trim()).filter(Boolean)));

const nowIso = () => new Date().toISOString();
const isDevelopmentRuntime = () => {
  const nodeEnv = String(process.env.NODE_ENV || '').trim().toLowerCase();
  const functionsEnv = String(process.env.AZURE_FUNCTIONS_ENVIRONMENT || process.env.FUNCTIONS_ENVIRONMENT || '').trim().toLowerCase();
  return functionsEnv === 'development' || functionsEnv === 'dev' || nodeEnv !== 'production';
};
const parseStatusCode = (value) => {
  const token = String(value || '').trim();
  if (!token) return undefined;
  const direct = Number(token);
  if (Number.isFinite(direct) && direct >= 100 && direct <= 599) return direct;
  const match =
    token.match(/openai_http_(\d{3})/i) ||
    token.match(/status[:= ]+(\d{3})/i) ||
    token.match(/\((\d{3})\)/);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
};
const normalizeSnippet = (value, max = 320) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
const extractErrorDetails = (error) => {
  const record = asRecord(error);
  const status = parseStatusCode(record.status || record.statusCode || record.code);
  const codeToken = String(record.code || '').trim();
  const message = error instanceof Error ? error.message : String(record.message || error || 'unknown_error');
  const bodySnippet = normalizeSnippet(
    record.bodySnippet ||
      record.responseBody ||
      asRecord(record.response).body ||
      asRecord(record.response).data ||
      record.body
  );
  return {
    message,
    ...(typeof status === 'number' ? { status } : {}),
    ...(codeToken ? { code: codeToken } : {}),
    ...(bodySnippet ? { responseBody: bodySnippet } : {}),
  };
};
const classifyFallbackKind = (reasons = []) => {
  const reasonTokens = asArray(reasons).map((entry) => String(entry || '').trim()).filter(Boolean);
  const lowered = reasonTokens.map((entry) => entry.toLowerCase());
  if (lowered.some((entry) => entry.includes('guardrail:stable_continue'))) {
    return 'guardrail_stable_continue';
  }
  if (lowered.some((entry) => entry.includes('missing_aoai_config') || entry.startsWith('missing:') || entry.includes('ai_enabled=false'))) {
    return 'missing_config';
  }
  if (
    lowered.some(
      (entry) =>
        entry.includes('json_schema') ||
        entry.includes('json_parse') ||
        entry.includes('schema validation')
    )
  ) {
    return 'model_output_invalid';
  }
  if (
    lowered.some(
      (entry) =>
        entry.includes('openai_http_') ||
        entry.includes('openai_error') ||
        entry.includes('openai_timeout') ||
        entry.includes('upstream_error') ||
        entry.includes('upstream_unavailable') ||
        entry.includes('orchestrator-error') ||
        entry.includes('llm_failed') ||
        /llm-error:.*status=\d{3}/.test(entry)
    )
  ) {
    return 'openai_call_failed';
  }
  return 'rules_fallback';
};
const extractFallbackErrorDetails = (reasons = []) => {
  const reasonTokens = asArray(reasons).map((entry) => String(entry || '').trim()).filter(Boolean);
  if (reasonTokens.length === 0) return null;
  const primary = reasonTokens.find((entry) => /llm-error:|upstream_error:|openai_|orchestrator-error:/i.test(entry)) || reasonTokens[0];
  const status = parseStatusCode(primary);
  const messageMatch = primary.match(/(?:llm-error:|upstream_error:|orchestrator-error:)(.+)$/i);
  const bodyMatch = primary.match(/body(?:snippet)?[:=]([^;]+)$/i);
  const codeMatch = primary.match(/code[:=]([a-z0-9_.-]+)/i);
  const message = normalizeSnippet(messageMatch ? messageMatch[1] : primary, 360);
  const responseBody = normalizeSnippet(bodyMatch ? bodyMatch[1] : '', 320);
  const code = codeMatch ? String(codeMatch[1] || '').trim() : '';
  return {
    reason: primary,
    message,
    ...(typeof status === 'number' ? { status } : {}),
    ...(code ? { code } : {}),
    ...(responseBody ? { responseBody } : {}),
  };
};
const endpointHostFromConfig = (endpoint) => {
  try {
    return endpoint ? new URL(endpoint).host : '';
  } catch {
    return '';
  }
};
const logError = (context, message, payload) => {
  if (typeof context?.error === 'function') {
    context.error(message, payload);
    return;
  }
  context.log?.(message, payload);
};
const normalizeToken = (value) => String(value || '').trim().toLowerCase();
const resolveRequestOrigin = (payload) => {
  const record = asRecord(payload);
  const signals = asRecord(record.signals);
  const userAction = firstText(record.userAction, signals.userAction);
  const actionToken = normalizeToken(userAction);
  const manualViaAction = /(^|[^a-z])(run[_\s-]?coach|manual|button[_\s-]?click|coach_analysis|coach)([^a-z]|$)/.test(actionToken);
  const manualViaSignals =
    signals.manual === true ||
    signals.manualRequest === true ||
    signals.manualTrigger === true ||
    normalizeToken(signals.requestOrigin) === 'manual' ||
    normalizeToken(signals.requestType) === 'manual' ||
    normalizeToken(signals.trigger) === 'manual' ||
    normalizeToken(signals.trigger) === 'button';
  const requestMode = normalizeToken(record.mode) === 'full' ? 'full' : 'auto';
  const manualRequest = manualViaAction || manualViaSignals || requestMode === 'full';
  return {
    requestType: manualRequest ? 'manual' : 'automatic',
    manualRequest,
    requestMode,
    userAction: userAction || '',
  };
};

const buildDefaultRequestPayload = (execution) => {
  const timestamp = nowIso();
  const mode = execution?.dataMode === 'demo' ? 'demo' : 'live';
  return {
    mode,
    dataMode: execution?.dataMode || 'live',
    llmMode: execution?.llmMode || 'ai',
    intent: 'monitor',
    teamMode: 'BOWLING',
    focusRole: 'BOWLER',
    text: 'Run coach analysis for active bowler.',
    context: {
      match: {
        matchMode: 'BOWL',
        format: 'T20',
        phase: 'Middle',
        intensity: 'Medium',
        tempState: 'Normal',
        scoreRuns: 74,
        wickets: 2,
        overs: 10,
        balls: 0,
        targetRuns: 0,
        requiredRunRate: 0,
        timestamp,
      },
      roster: [
        {
          playerId: 'P1',
          name: 'Demo Bowler',
          role: 'BOWLER',
          baseline: {
            sleepHours: 7,
            recoveryScore: 45,
            fatigueLimit: 6,
            controlBaseline: 78,
            speed: 7,
            power: 6,
          },
          live: {
            fatigueIndex: 3,
            strainIndex: 2,
            injuryRisk: 'LOW',
            noBallRisk: 'LOW',
            heartRateRecovery: 'Good',
            oversBowled: 1,
            lastUpdated: timestamp,
          },
        },
      ],
      activePlayerId: 'P1',
      contextVersion: 'v1',
    },
    telemetry: {
      playerId: 'P1',
      playerName: 'Demo Bowler',
      role: 'BOWLER',
      fatigueIndex: 3,
      strainIndex: 2,
      heartRateRecovery: 'Good',
      oversBowled: 1,
      consecutiveOvers: 1,
      oversRemaining: 3,
      maxOvers: 4,
      quotaComplete: false,
      injuryRisk: 'LOW',
      noBallRisk: 'LOW',
      fatigueLimit: 6,
      sleepHours: 7,
      recoveryMinutes: 45,
      isUnfit: false,
    },
    matchContext: {
      teamMode: 'BOWLING',
      matchMode: 'BOWL',
      phase: 'middle',
      requiredRunRate: 0,
      currentRunRate: 0,
      wicketsInHand: 8,
      oversRemaining: 10,
      format: 'T20',
      over: 10,
      intensity: 'Medium',
      conditions: 'Normal',
      target: 0,
      score: 74,
      balls: 0,
    },
    players: {
      striker: 'Batter A',
      nonStriker: 'Batter B',
      bowler: 'Demo Bowler',
      bench: ['Support Bowler'],
    },
    signals: {},
  };
};

const mergeRequestPayload = (payload, execution) => {
  const defaults = buildDefaultRequestPayload(execution);
  const source = asRecord(payload);
  const merged = {
    ...defaults,
    ...source,
    dataMode: source.dataMode || defaults.dataMode,
    llmMode: source.llmMode || defaults.llmMode,
    mode: source.mode || defaults.mode,
    context: source.context && typeof source.context === 'object' ? source.context : defaults.context,
    telemetry: source.telemetry && typeof source.telemetry === 'object' ? source.telemetry : defaults.telemetry,
    matchContext: source.matchContext && typeof source.matchContext === 'object' ? source.matchContext : defaults.matchContext,
    players: source.players && typeof source.players === 'object' ? source.players : defaults.players,
    signals: source.signals && typeof source.signals === 'object' ? source.signals : defaults.signals,
  };
  return merged;
};

const collectRoutingReasons = (result, fallbackReason) => {
  const record = asRecord(result);
  const meta = asRecord(record.meta);
  const modelRouting = asRecord(meta.modelRouting);
  return dedupeReasons([
    ...(asArray(record.reasons)),
    ...(asArray(modelRouting.fallbacksUsed)),
    ...(asArray(meta.usedFallbackAgents).map((entry) => `${String(entry || '').trim()}:fallback`)),
    meta.routerFallbackMessage,
    fallbackReason,
  ]);
};

const isAiFailureReasonToken = (value) => {
  const token = String(value || '').trim().toLowerCase();
  if (!token) return false;
  return (
    token.includes('llm_failed') ||
    token.includes('llm-error') ||
    token.includes('openai_') ||
    token.includes('openai_http_') ||
    token.includes('json_schema') ||
    token.includes('json_parse') ||
    token.includes('schema_validation') ||
    token.includes('upstream_') ||
    token.includes('orchestrator-error') ||
    token.includes('agent_http_error')
  );
};

const collectAgentAiFailures = (result) => {
  const record = asRecord(result);
  const agentResults = asRecord(record.agentResults);
  const failures = {};
  ['fatigue', 'risk', 'tactical'].forEach((agent) => {
    const agentResult = asRecord(agentResults[agent]);
    const routedTo = String(agentResult.routedTo || '').trim().toLowerCase();
    const status = String(agentResult.status || '').trim().toLowerCase();
    const reason = firstText(agentResult.reason, agentResult.error);
    if (
      routedTo === 'rules' &&
      (status === 'fallback' || status === 'error' || isAiFailureReasonToken(reason))
    ) {
      failures[agent] = reason || 'llm_failed';
    }
  });
  return failures;
};

const collectAgentStatuses = (result, fallbackMode) => {
  const record = asRecord(result);
  const agents = asRecord(record.agents);
  const agentResults = asRecord(record.agentResults);

  const toStatus = (agent) => {
    const direct = asRecord(agents[agent]);
    const directStatus = String(direct.status || '').trim().toUpperCase();
    if (directStatus === 'OK' || directStatus === 'FALLBACK' || directStatus === 'ERROR' || directStatus === 'SKIPPED') {
      return directStatus;
    }
    const resultStatus = String(asRecord(agentResults[agent]).status || '').trim().toLowerCase();
    if (resultStatus === 'success') return 'OK';
    if (resultStatus === 'fallback') return 'FALLBACK';
    if (resultStatus === 'error') return fallbackMode ? 'FALLBACK' : 'ERROR';
    if (resultStatus === 'skipped') return 'SKIPPED';
    return fallbackMode ? 'FALLBACK' : 'OK';
  };

  return {
    fatigue: { status: toStatus('fatigue') },
    risk: { status: toStatus('risk') },
    tactical: { status: toStatus('tactical') },
  };
};

const isFallbackReasonToken = (value) => {
  const token = String(value || '').trim().toLowerCase();
  if (!token) return false;
  return (
    token.includes('rules_fallback') ||
    token.includes('guardrail:stable_continue') ||
    token.includes('llm_failed') ||
    token.includes('openai_') ||
    token.includes('upstream_') ||
    token.includes('missing_aoai_config') ||
    token.startsWith('missing:') ||
    token.includes('backend_not_ready') ||
    token.includes('invalid_payload') ||
    token.includes('orchestrator-error') ||
    token.includes('agent_http_error') ||
    token.includes('fallback')
  );
};

const deriveRoutingMode = (result, reasons) => {
  const record = asRecord(result);
  const modeToken = String(record.routingMode || asRecord(record.routing).mode || '').trim().toLowerCase();
  const agentStatuses = collectAgentStatuses(result, false);
  const hasFallbackAgent =
    agentStatuses.fatigue.status === 'FALLBACK' ||
    agentStatuses.risk.status === 'FALLBACK' ||
    agentStatuses.tactical.status === 'FALLBACK';
  const hasFallbackReason = asArray(reasons).some((reason) => isFallbackReasonToken(reason));
  if (modeToken === 'fallback' || hasFallbackReason || hasFallbackAgent) return 'fallback';
  return 'ai';
};

const toCoachOutput = (result) => {
  const record = asRecord(result);
  const coach = asRecord(record.coachOutput);
  const summary = firstText(
    coach.summary,
    coach.explanation,
    record.summary,
    record.combinedBriefing,
    asRecord(record.combinedDecision).rationale,
    'Coach analysis completed.'
  );
  const tacticalRecommendation = firstText(
    coach.tacticalRecommendation,
    coach.recommendation,
    record.tacticalRecommendation,
    asRecord(record.combinedDecision).immediateAction,
    'Continue with monitored plan'
  );
  const confidenceCandidate = Number(coach.confidence ?? record.confidence ?? asRecord(record.combinedDecision).confidence ?? 0.62);
  const confidence = Number.isFinite(confidenceCandidate)
    ? Math.max(0, Math.min(1, confidenceCandidate > 1 ? confidenceCandidate / 100 : confidenceCandidate))
    : 0.62;
  return {
    ...coach,
    summary,
    tacticalRecommendation,
    confidence,
    explanation: firstText(coach.explanation, summary),
  };
};

const normalizeSourceToken = (value) => {
  const token = String(value || '').trim().toLowerCase();
  if (token === 'ai' || token === 'rules' || token === 'fallback') return token;
  return '';
};

const inferSource = (record, execution, sourceHint = '') => {
  const explicit = normalizeSourceToken(record.source || sourceHint);
  if (explicit) return explicit;
  const routingMode = String(record.routingMode || asRecord(record.routing).mode || '').trim().toLowerCase();
  const llmMode = String(record.llmMode || execution?.llmMode || '').trim().toLowerCase();
  if (routingMode === 'fallback') return llmMode === 'rules' ? 'rules' : 'fallback';
  if (llmMode === 'rules') return 'rules';
  return 'ai';
};

const ensureAnalysisEnvelope = (record) => {
  const coach = toCoachOutput(record);
  const combinedDecisionRecord = asRecord(record.combinedDecision);
  const finalDecisionRecord = asRecord(record.finalDecision);
  const confidenceCandidate = Number(
    record.confidence ??
      coach.confidence ??
      combinedDecisionRecord.confidence ??
      finalDecisionRecord.confidence ??
      0.62
  );
  const confidence = Number.isFinite(confidenceCandidate)
    ? Math.max(0, Math.min(1, confidenceCandidate > 1 ? confidenceCandidate / 100 : confidenceCandidate))
    : 0.62;
  const summary = firstText(
    record.summary,
    record.combinedBriefing,
    coach.summary,
    coach.explanation,
    combinedDecisionRecord.rationale,
    finalDecisionRecord.rationale,
    'Coach analysis completed.'
  );
  const tacticalRecommendation = firstText(
    record.tacticalRecommendation,
    coach.tacticalRecommendation,
    coach.recommendation,
    combinedDecisionRecord.immediateAction,
    finalDecisionRecord.immediateAction,
    'Continue with monitored plan'
  );
  const combinedDecision = Object.keys(combinedDecisionRecord).length > 0
    ? combinedDecisionRecord
    : Object.keys(finalDecisionRecord).length > 0
      ? finalDecisionRecord
      : {
          immediateAction: tacticalRecommendation || 'Continue with monitored plan',
          suggestedAdjustments: summary ? [summary] : [],
          confidence,
          rationale: summary || 'Coach analysis completed.',
        };
  const analysis = {
    summary,
    tacticalRecommendation,
    confidence,
    combinedDecision,
    combinedBriefing: firstText(record.combinedBriefing, summary),
    strategicAnalysis: record.strategicAnalysis || null,
    coachOutput: {
      ...coach,
      summary,
      tacticalRecommendation,
      confidence,
      explanation: firstText(coach.explanation, summary),
    },
  };
  const hasAnyAnalysis = Boolean(
    summary ||
      tacticalRecommendation ||
      Object.keys(asRecord(combinedDecision)).length > 0 ||
      record.strategicAnalysis ||
      record.tactical ||
      record.fatigue ||
      record.risk
  );

  return {
    ...record,
    summary,
    tacticalRecommendation,
    confidence,
    combinedDecision,
    coachOutput: analysis.coachOutput,
    analysis,
    hasAnyAnalysis,
  };
};

const finalizeOrchestrateSuccessBody = (body, options) => {
  const { requestId, execution, sourceHint } = options || {};
  const base = ensureAnalysisEnvelope(asRecord(body));
  const source = inferSource(base, execution, sourceHint);
  const meta = asRecord(base.meta);
  const errors = asArray(base.errors);
  const resolvedAnalysisId =
    firstText(
      meta.analysisId,
      base.analysisBundleId,
      base.analysisId,
      base.traceId,
      meta.requestId,
      requestId
    ) || `local-orchestrate-${Date.now()}`;
  const reasons = dedupeReasons([
    ...(asArray(base.reasons)),
    ...(asArray(asRecord(base.routing).reasons)),
  ]);
  const fallbackReason = firstText(
    meta.reason,
    meta.routerFallbackMessage,
    reasons[0],
    source !== 'ai' ? 'rules_fallback' : ''
  );
  const llmMode = String(base.llmMode || execution?.llmMode || (source === 'rules' ? 'rules' : 'ai')).trim().toLowerCase();
  const normalizedLlmMode = llmMode === 'rules' ? 'rules' : 'ai';
  const normalizedRoutingMode = source === 'ai' ? 'ai' : 'fallback';
  const normalizedMode = source === 'ai' ? 'ai' : 'fallback';

  return {
    ...base,
    errors,
    source,
    analysisId: resolvedAnalysisId,
    analysisBundleId: String(base.analysisBundleId || resolvedAnalysisId),
    traceId: String(base.traceId || requestId || resolvedAnalysisId),
    mode: normalizedMode,
    llmMode: normalizedLlmMode,
    routingMode: normalizedRoutingMode,
    routing: {
      ...asRecord(base.routing),
      mode: normalizedRoutingMode,
      reasons: reasons.length > 0 ? reasons : (source === 'ai' ? [] : [fallbackReason || 'rules_fallback']),
    },
    reasons: reasons.length > 0 ? reasons : (source === 'ai' ? [] : [fallbackReason || 'rules_fallback']),
    meta: {
      ...meta,
      requestId: String(meta.requestId || requestId || resolvedAnalysisId),
      analysisId: resolvedAnalysisId,
      source,
      llmMode: normalizedLlmMode,
      dataMode: String(base.dataMode || execution?.dataMode || 'live').trim().toLowerCase() === 'demo' ? 'demo' : 'live',
      ...(source === 'ai' ? {} : { reason: fallbackReason || 'rules_fallback' }),
    },
  };
};

const logReturnShape = (context, body, requestId) => {
  const record = asRecord(body);
  const source = normalizeSourceToken(record.source) || 'fallback';
  const analysisId = firstText(asRecord(record.meta).analysisId, record.analysisId, record.analysisBundleId);
  const analysisPayload = asRecord(record.analysis);
  const analysisPayloadPresent = Boolean(
    firstText(
      analysisPayload.summary,
      analysisPayload.tacticalRecommendation,
      asRecord(analysisPayload.combinedDecision).immediateAction,
      record.summary,
      asRecord(record.combinedDecision).immediateAction
    ) ||
      record.strategicAnalysis ||
      record.tactical ||
      record.fatigue ||
      record.risk
  );
  context.log?.('[orchestrate] return_shape', {
    requestId: requestId || analysisId,
    source,
    analysisId,
    usedAi: source === 'ai',
    usedRules: source === 'rules',
    usedFallback: source === 'fallback',
    analysisPayloadPresent,
  });
};

const respondSuccess = (respond, status, body, req, context, requestId, execution, sourceHint = '') => {
  const finalized = finalizeOrchestrateSuccessBody(body, { requestId, execution, sourceHint });
  logReturnShape(context, finalized, requestId);
  return respond(jsonResponse(status, finalized, {}, req));
};

const buildFallbackBody = (payload, execution, reason, requestId, startedAt) => {
  const fallback = runOrchestrateFallback(payload);
  const reasons = dedupeReasons([reason, ...(execution?.reasons || [])]);
  const reasonToken = String(reason || '').trim();
  const azureAttempted =
    execution.llmMode === 'ai' &&
    (isAiFailureReasonToken(reasonToken) || /openai|upstream|llm-error|http_/i.test(reasonToken));
  const agents = {
    fatigue: { status: 'FALLBACK' },
    risk: { status: 'FALLBACK' },
    tactical: { status: 'FALLBACK' },
  };
  const coachOutput = toCoachOutput(fallback);
  return {
    ...fallback,
    ok: true,
    mode: 'fallback',
    dataMode: execution.dataMode,
    llmMode: execution.llmMode,
    routingMode: 'fallback',
    routing: {
      mode: 'fallback',
      reasons,
    },
    reasons,
    fallbackReason: reasonToken || reasons[0] || 'rules_fallback',
    azureAttempted,
    agentAiFailures: {
      fatigue: reasonToken || 'rules_fallback',
      risk: reasonToken || 'rules_fallback',
      tactical: reasonToken || 'rules_fallback',
    },
    coachOutput,
    agents,
    analysisBundleId: String(fallback.analysisBundleId || fallback.analysisId || requestId),
    meta: {
      ...asRecord(fallback.meta),
      requestId: String(asRecord(fallback.meta).requestId || requestId),
      llmMode: execution.llmMode,
      dataMode: execution.dataMode,
      routingDebug: {
        requestedMode: execution.requestedMode,
        llmMode: execution.llmMode,
        routingMode: 'fallback',
        fallbackReason: reasonToken || reasons[0] || 'rules_fallback',
        azureAttempted,
      },
      usedFallbackAgents: ['fatigue', 'risk', 'tactical'],
      modelRouting: {
        ...asRecord(asRecord(fallback.meta).modelRouting),
        fatigueModel: 'rules-based-fallback',
        riskModel: 'rules-based-fallback',
        tacticalModel: 'rules-based-fallback',
        fallbacksUsed: reasons,
      },
      timingsMs: {
        ...asRecord(asRecord(fallback.meta).timingsMs),
        total: Date.now() - startedAt,
      },
    },
    timings: {
      totalMs: Date.now() - startedAt,
      fatigueMs: Number(asRecord(asRecord(fallback.meta).timingsMs).fatigue || 0),
      riskMs: Number(asRecord(asRecord(fallback.meta).timingsMs).risk || 0),
      tacticalMs: Number(asRecord(asRecord(fallback.meta).timingsMs).tactical || 0),
      routerMs: Number(asRecord(asRecord(fallback.meta).timingsMs).router || 0),
      azureCallMs: Number(asRecord(asRecord(fallback.meta).timingsMs).azureCall || 0),
    },
  };
};

const buildAiBody = (result, execution, requestId, startedAt) => {
  const reasons = collectRoutingReasons(result);
  const routingMode = deriveRoutingMode(result, reasons);
  const fallbackMode = routingMode === 'fallback';
  const fallbackReason = fallbackMode ? firstText(reasons[0], 'rules_fallback') : '';
  const agentAiFailures = collectAgentAiFailures(result);
  const azureAttempted = execution.llmMode === 'ai';
  const agents = collectAgentStatuses(result, fallbackMode);
  const coachOutput = toCoachOutput(result);
  const meta = asRecord(result.meta);
  const metaTimings = asRecord(meta.timingsMs);
  const azureCallRaw = Number(metaTimings.azureCall || 0);
  const inferredAzureCallMs = routingMode === 'ai'
    ? Math.max(1, azureCallRaw, Number(metaTimings.tactical || 0))
    : Math.max(0, azureCallRaw);
  const timings = {
    totalMs: Date.now() - startedAt,
    fatigueMs: Number(metaTimings.fatigue || 0),
    riskMs: Number(metaTimings.risk || 0),
    tacticalMs: Number(metaTimings.tactical || 0),
    routerMs: Number(metaTimings.router || 0),
    azureCallMs: inferredAzureCallMs,
  };

  return {
    ...result,
    ok: result.ok !== false,
    mode: fallbackMode ? 'fallback' : 'ai',
    dataMode: execution.dataMode,
    llmMode: execution.llmMode,
    routingMode,
    routing: {
      ...asRecord(result.routing),
      mode: routingMode,
      ...(reasons.length > 0 ? { reasons } : {}),
    },
    reasons,
    ...(fallbackMode ? { fallbackReason } : {}),
    azureAttempted,
    agentAiFailures,
    analysisBundleId: String(result.analysisBundleId || result.analysisId || requestId),
    coachOutput,
    agents,
    timings,
    meta: {
      ...meta,
      requestId: String(meta.requestId || requestId),
      llmMode: execution.llmMode,
      dataMode: execution.dataMode,
      routingDebug: {
        requestedMode: execution.requestedMode,
        llmMode: execution.llmMode,
        routingMode,
        fallbackReason: fallbackReason || undefined,
        azureAttempted,
      },
      usedFallbackAgents: asArray(meta.usedFallbackAgents),
      timingsMs: {
        ...metaTimings,
        ...(routingMode === 'ai' ? { azureCall: inferredAzureCallMs } : {}),
        total: Date.now() - startedAt,
      },
    },
  };
};

module.exports = async function orchestrate(context, req) {
  const startedAt = Date.now();
  const requestId = randomUUID();
  const method = String(req?.method || '').trim().toUpperCase();
  const url = String(req?.url || '/api/orchestrate').trim() || '/api/orchestrate';
  const respond = (response) => {
    context.res = response;
    return response;
  };

  if (method === 'OPTIONS') {
    return respond(optionsResponse('GET,POST,OPTIONS', {}, req));
  }

  const payload = normalizeBody(req);
  const llm = isLlmConfigured();
  const execution = resolveAiExecution(payload, llm);
  const requestOrigin = resolveRequestOrigin(payload);
  const aoaiEndpointHost = endpointHostFromConfig(asRecord(llm.config).endpoint);
  const aoaiRequestUrl = buildAoaiChatUrl({
    endpoint: asRecord(llm.config).endpoint,
    deployment: asRecord(llm.config).deployment,
    apiVersion: asRecord(llm.config).apiVersion,
  });

  context.log?.('[orchestrate] request', {
    requestId,
    method,
    url,
    mode: execution.requestedMode,
    dataMode: execution.dataMode,
    llmMode: execution.llmMode,
    requestType: requestOrigin.requestType,
    manualRequest: requestOrigin.manualRequest,
    requestMode: requestOrigin.requestMode,
    userAction: requestOrigin.userAction || undefined,
    aiEnabled: execution.aiEnabled,
    llmConfigured: llm.ok,
    traceId: requestId,
  });
  if (execution.llmMode === 'ai') {
    context.log?.('[orchestrate] aoai_debug', {
      requestId,
      traceId: requestId,
      endpointHost: aoaiEndpointHost,
      apiVersion: asRecord(llm.config).apiVersion || '',
      deployment: asRecord(llm.config).deployment || '',
      requestUrl: aoaiRequestUrl,
      authHeader: 'api-key',
      requestType: requestOrigin.requestType,
      manualRequest: requestOrigin.manualRequest,
      requestMode: requestOrigin.requestMode,
      userAction: requestOrigin.userAction || undefined,
    });
  }
  context.log?.('[orchestrate] routing', {
    requestId,
    traceId: requestId,
    requestType: requestOrigin.requestType,
    manualRequest: requestOrigin.manualRequest,
    requestMode: requestOrigin.requestMode,
    userAction: requestOrigin.userAction || undefined,
    aiPathSelected: execution.llmMode === 'ai' && llm.ok,
    azureAttempted: execution.llmMode === 'ai' && llm.ok,
    fallbackReason: execution.llmMode !== 'ai' ? 'llm_mode_rules' : llm.ok ? '' : 'missing_config',
    aoai: {
      configured: llm.ok,
      endpointHost: aoaiEndpointHost,
      deployment: asRecord(llm.config).deployment || '',
      apiVersion: asRecord(llm.config).apiVersion || '',
      requestUrl: aoaiRequestUrl,
      authHeader: 'api-key',
    },
  });

  if (method === 'GET') {
    const body = {
      ok: true,
      service: 'tactiq_api',
      route: '/api/orchestrate',
      mode: 'fallback',
      routingMode: 'fallback',
      routing: {
        mode: 'fallback',
        reasons: ['health_probe'],
      },
      reasons: ['health_probe'],
      dataMode: execution.dataMode,
      llmMode: execution.llmMode,
      timestamp: nowIso(),
      coachOutput: {
        summary: 'Orchestrate endpoint is reachable.',
        tacticalRecommendation: 'POST match-state JSON to run coach analysis.',
        confidence: 0.62,
        explanation: 'Health-style orchestrate response for browser checks.',
      },
      agents: {
        fatigue: { status: 'SKIPPED' },
        risk: { status: 'SKIPPED' },
        tactical: { status: 'SKIPPED' },
      },
      meta: {
        requestId,
        mode: 'auto',
        executedAgents: [],
        usedFallbackAgents: [],
        timingsMs: { total: Date.now() - startedAt },
      },
      timings: {
        totalMs: Date.now() - startedAt,
        fatigueMs: 0,
        riskMs: 0,
        tacticalMs: 0,
        routerMs: 0,
        azureCallMs: 0,
      },
    };
    return respondSuccess(respond, 200, body, req, context, requestId, execution, 'fallback');
  }

  if (method !== 'POST') {
    return respondSuccess(
      respond,
      200,
      {
        ok: false,
        error: 'method_not_allowed',
        message: 'Use GET /api/orchestrate for route info or POST JSON to run analysis.',
        routingMode: 'fallback',
        routing: {
          mode: 'fallback',
          reasons: ['method_not_allowed'],
        },
        reasons: ['method_not_allowed'],
        dataMode: execution.dataMode,
        llmMode: execution.llmMode,
        meta: {
          requestId,
          reason: 'method_not_allowed',
        },
      },
      req,
      context,
      requestId,
      execution,
      'fallback'
    );
  }

  if (execution.llmMode !== 'ai') {
    context.log?.('[orchestrate] fallback_triggered', {
      requestId,
      traceId: requestId,
      requestType: requestOrigin.requestType,
      manualRequest: requestOrigin.manualRequest,
      userAction: requestOrigin.userAction || undefined,
      category: 'rules_fallback',
      reason: 'llm_mode_rules',
    });
    return respondSuccess(
      respond,
      200,
      buildFallbackBody(payload, execution, 'llm_mode_rules', requestId, startedAt),
      req,
      context,
      requestId,
      execution,
      'rules'
    );
  }

  if (!llm.ok) {
    context.log?.('[orchestrate] fallback_triggered', {
      requestId,
      traceId: requestId,
      requestType: requestOrigin.requestType,
      manualRequest: requestOrigin.manualRequest,
      userAction: requestOrigin.userAction || undefined,
      category: 'missing_config',
      reason: 'missing_aoai_config',
      missing: asArray(llm.missing),
      aoai: {
        endpointHost: aoaiEndpointHost,
        deployment: asRecord(llm.config).deployment || '',
        apiVersion: asRecord(llm.config).apiVersion || '',
      },
    });
    return respondSuccess(
      respond,
      200,
      buildFallbackBody(payload, execution, 'missing_aoai_config', requestId, startedAt),
      req,
      context,
      requestId,
      execution,
      'fallback'
    );
  }

  if (!orchestratorCore || typeof orchestratorCore.orchestrateAgents !== 'function') {
    if (execution.strictAi) {
      return respond(
        jsonResponse(
          502,
          {
            ok: false,
            error: 'backend_not_ready',
            message: 'API dist modules are unavailable. Run npm --prefix api run build.',
            mode: 'live',
            dataMode: execution.dataMode,
            llmMode: execution.llmMode,
            routingMode: 'ai',
            routing: {
              mode: 'ai',
              reasons: ['backend_not_ready'],
            },
            reasons: ['backend_not_ready'],
            requestId,
          },
          {},
          req
        )
      );
    }
    return respondSuccess(
      respond,
      200,
      buildFallbackBody(payload, execution, 'backend_not_ready', requestId, startedAt),
      req,
      context,
      requestId,
      execution,
      'fallback'
    );
  }

  try {
    const mergedPayload = mergeRequestPayload(payload, execution);

    let validatedValue = mergedPayload;
    if (validationCore && typeof validationCore.validateOrchestrateRequest === 'function') {
      const validated = validationCore.validateOrchestrateRequest(mergedPayload);
      if (!validated || validated.ok === false) {
        const message = firstText(validated?.message, 'Invalid orchestrate payload');
        if (execution.strictAi) {
          return respond(
            jsonResponse(
              400,
              {
                ok: false,
                error: 'invalid_payload',
                message,
                requestId,
              },
              {},
              req
            )
          );
        }
        return respondSuccess(
          respond,
          200,
          buildFallbackBody(mergedPayload, execution, 'invalid_payload', requestId, startedAt),
          req,
          context,
          requestId,
          execution,
          'fallback'
        );
      }
      validatedValue = validated.value;
    }

    const rawResult = await orchestratorCore.orchestrateAgents(validatedValue, context);
    const aiBody = buildAiBody(asRecord(rawResult), execution, requestId, startedAt);
    context.log?.('[orchestrate] ai_attempt', {
      requestId,
      traceId: requestId,
      requestType: requestOrigin.requestType,
      manualRequest: requestOrigin.manualRequest,
      userAction: requestOrigin.userAction || undefined,
      attempted: execution.llmMode === 'ai' && llm.ok,
      aiRouted: aiBody.routingMode === 'ai',
      sourceHint: aiBody.routingMode === 'ai' ? 'ai' : 'fallback',
      azureCallMs: Number(asRecord(aiBody.timings).azureCallMs || 0),
      reasons: asArray(aiBody.reasons),
    });

    const fallbackActive = aiBody.routingMode === 'fallback';
    const fallbackReasons = asArray(aiBody.reasons);
    const fallbackKind = classifyFallbackKind(fallbackReasons);
    const fallbackDetails = extractFallbackErrorDetails(fallbackReasons);
    if (fallbackActive) {
      const logPayload = {
        requestId,
        traceId: requestId,
        requestType: requestOrigin.requestType,
        manualRequest: requestOrigin.manualRequest,
        userAction: requestOrigin.userAction || undefined,
        category: fallbackKind,
        reasons: fallbackReasons,
        aoai: {
          endpointHost: aoaiEndpointHost,
          deployment: asRecord(llm.config).deployment || '',
          apiVersion: asRecord(llm.config).apiVersion || '',
        },
      };
      if (fallbackKind === 'openai_call_failed') {
        logError(context, '[orchestrate] openai_failure', {
          ...logPayload,
          ...(fallbackDetails || {}),
        });
      } else {
        context.log?.('[orchestrate] fallback_triggered', logPayload);
      }
    }

    if (fallbackActive && execution.strictAi) {
      return respond(
        jsonResponse(
          502,
          {
            ok: false,
            error: 'ai_upstream_failed',
            message: 'Azure OpenAI orchestrate analysis failed in strict ai mode.',
            mode: 'live',
            dataMode: execution.dataMode,
            llmMode: execution.llmMode,
            routingMode: 'ai',
            routing: {
              mode: 'ai',
              reasons: aiBody.reasons && aiBody.reasons.length > 0 ? aiBody.reasons : ['upstream_unavailable'],
            },
            reasons: aiBody.reasons && aiBody.reasons.length > 0 ? aiBody.reasons : ['upstream_unavailable'],
            requestId,
            meta: {
              requestId,
              timingsMs: { total: Date.now() - startedAt },
            },
            agents: {
              fatigue: { status: 'ERROR' },
              risk: { status: 'ERROR' },
              tactical: { status: 'ERROR' },
            },
          },
          {},
          req
        )
      );
    }

    if (fallbackActive && execution.requestedMode === 'auto') {
      if (fallbackKind === 'openai_call_failed' && isDevelopmentRuntime()) {
        return respond(
          jsonResponse(
            502,
            {
              ok: false,
              error: 'ai_upstream_failed',
              message: (fallbackDetails && fallbackDetails.message) || 'Azure OpenAI call failed while running orchestrate.',
              mode: 'live',
              dataMode: execution.dataMode,
              llmMode: execution.llmMode,
              routingMode: 'ai',
              routing: {
                mode: 'ai',
                reasons: fallbackReasons.length > 0 ? fallbackReasons : ['upstream_unavailable'],
              },
              reasons: fallbackReasons.length > 0 ? fallbackReasons : ['upstream_unavailable'],
              requestId,
              traceId: requestId,
              meta: {
                requestId,
                timingsMs: { total: Date.now() - startedAt },
              },
              ...(fallbackDetails ? { upstreamError: fallbackDetails } : {}),
            },
            {},
            req
          )
        );
      }
      return respondSuccess(
        respond,
        200,
        buildFallbackBody(mergedPayload, execution, aiBody.reasons[0] || 'upstream_unavailable', requestId, startedAt),
        req,
        context,
        requestId,
        execution,
        'fallback'
      );
    }

    context.log?.('[orchestrate] response', {
      requestId,
      status: 200,
      routingMode: aiBody.routingMode,
      aoaiConfigured: llm.ok,
      durationMs: Date.now() - startedAt,
    });

    return respondSuccess(respond, 200, aiBody, req, context, requestId, execution);
  } catch (error) {
    const details = extractErrorDetails(error);
    const message = details.message || 'unknown_error';
    logError(context, '[orchestrate] error', { requestId, traceId: requestId, ...details });

    if (execution.strictAi) {
      return respond(
        jsonResponse(
          502,
          {
            ok: false,
            error: 'ai_upstream_failed',
            message,
            mode: 'live',
            dataMode: execution.dataMode,
            llmMode: execution.llmMode,
            routingMode: 'ai',
            routing: {
              mode: 'ai',
              reasons: ['upstream_unavailable'],
            },
            reasons: ['upstream_unavailable'],
            requestId,
            ...(Object.prototype.hasOwnProperty.call(details, 'status') ? { status: details.status } : {}),
            ...(details.code ? { code: details.code } : {}),
            ...(details.responseBody ? { responseBody: details.responseBody } : {}),
          },
          {},
          req
        )
      );
    }

    if (isDevelopmentRuntime()) {
      return respond(
        jsonResponse(
          502,
          {
            ok: false,
            error: 'ai_upstream_failed',
            message,
            mode: 'live',
            dataMode: execution.dataMode,
            llmMode: execution.llmMode,
            routingMode: 'ai',
            routing: {
              mode: 'ai',
              reasons: ['upstream_unavailable'],
            },
            reasons: ['upstream_unavailable'],
            requestId,
            traceId: requestId,
            ...(Object.prototype.hasOwnProperty.call(details, 'status') ? { status: details.status } : {}),
            ...(details.code ? { code: details.code } : {}),
            ...(details.responseBody ? { responseBody: details.responseBody } : {}),
          },
          {},
          req
        )
      );
    }

    return respondSuccess(
      respond,
      200,
      buildFallbackBody(payload, execution, `upstream_error:${message}`, requestId, startedAt),
      req,
      context,
      requestId,
      execution,
      'fallback'
    );
  }
};
