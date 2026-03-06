const { randomUUID } = require('crypto');
const {
  jsonResponse,
  optionsResponse,
  normalizeBody,
  resolveAiExecution,
  isLlmConfigured,
} = require('../shared/agentRuntime');
const { runFatigueFallback, runRiskFallback, runTacticalFallback } = require('../shared/simpleAgents');

let tacticalCore = null;
let validationCore = null;
try {
  tacticalCore = require('../dist/agents/tacticalAgent');
} catch {
  tacticalCore = null;
}
try {
  validationCore = require('../dist/orchestrator/validation');
} catch {
  validationCore = null;
}

const dedupeReasons = (values) => Array.from(new Set((Array.isArray(values) ? values : []).map((entry) => String(entry || '').trim()).filter(Boolean)));

const normalizePayload = (payload, requestId) => {
  const telemetry = payload?.telemetry && typeof payload.telemetry === 'object' ? payload.telemetry : {};
  const matchContext = payload?.matchContext && typeof payload.matchContext === 'object' ? payload.matchContext : {};
  const players = payload?.players && typeof payload.players === 'object' ? payload.players : {};

  return {
    requestId: String(payload?.requestId || requestId),
    intent: String(payload?.intent || 'monitor'),
    teamMode: String(payload?.teamMode || matchContext.teamMode || 'BOWLING').toUpperCase() === 'BATTING' ? 'BATTING' : 'BOWLING',
    focusRole: String(payload?.focusRole || '').toUpperCase() === 'BATTER' ? 'BATTER' : 'BOWLER',
    matchContext: {
      teamMode: String(matchContext.teamMode || matchContext.matchMode || 'BOWLING'),
      matchMode: String(matchContext.matchMode || matchContext.teamMode || 'BOWL'),
      phase: String(matchContext.phase || 'middle'),
      requiredRunRate: Number(matchContext.requiredRunRate || 0),
      currentRunRate: Number(matchContext.currentRunRate || 0),
      wicketsInHand: Number(matchContext.wicketsInHand || 7),
      oversRemaining: Number(matchContext.oversRemaining || 10),
      format: String(matchContext.format || 'T20'),
      over: Number(matchContext.over || 0),
      intensity: String(matchContext.intensity || 'Medium'),
      conditions: String(matchContext.conditions || ''),
      target: Number.isFinite(Number(matchContext.target)) ? Number(matchContext.target) : undefined,
      score: Number.isFinite(Number(matchContext.score)) ? Number(matchContext.score) : undefined,
      balls: Number.isFinite(Number(matchContext.balls)) ? Number(matchContext.balls) : undefined,
    },
    telemetry: {
      playerId: String(telemetry.playerId || 'UNKNOWN'),
      playerName: String(telemetry.playerName || players.bowler || 'Current player'),
      role: String(telemetry.role || 'BOWLER'),
      fatigueIndex: Number(telemetry.fatigueIndex || 0),
      strainIndex: Number(telemetry.strainIndex || 0),
      heartRateRecovery: String(telemetry.heartRateRecovery || 'Moderate'),
      oversBowled: Number(telemetry.oversBowled || 0),
      consecutiveOvers: Number(telemetry.consecutiveOvers || 0),
      oversRemaining: Number.isFinite(Number(telemetry.oversRemaining)) ? Number(telemetry.oversRemaining) : undefined,
      maxOvers: Number.isFinite(Number(telemetry.maxOvers)) ? Number(telemetry.maxOvers) : undefined,
      quotaComplete: telemetry.quotaComplete === true,
      injuryRisk: String(telemetry.injuryRisk || 'LOW').toUpperCase(),
      noBallRisk: String(telemetry.noBallRisk || 'LOW').toUpperCase(),
      fatigueLimit: Number.isFinite(Number(telemetry.fatigueLimit)) ? Number(telemetry.fatigueLimit) : undefined,
      sleepHours: Number.isFinite(Number(telemetry.sleepHours)) ? Number(telemetry.sleepHours) : undefined,
      recoveryMinutes: Number.isFinite(Number(telemetry.recoveryMinutes)) ? Number(telemetry.recoveryMinutes) : undefined,
      isUnfit: telemetry.isUnfit === true,
    },
    players: {
      striker: String(players.striker || 'A'),
      nonStriker: String(players.nonStriker || 'B'),
      bowler: String(players.bowler || telemetry.playerName || 'Current player'),
      bench: Array.isArray(players.bench) ? players.bench.map((entry) => String(entry || '')).filter(Boolean) : [],
    },
    ...(payload?.context && typeof payload.context === 'object' ? { context: payload.context } : {}),
    ...(Array.isArray(payload?.replacementCandidates) ? { replacementCandidates: payload.replacementCandidates } : {}),
    ...(payload?.fatigueOutput && typeof payload.fatigueOutput === 'object' ? { fatigueOutput: payload.fatigueOutput } : {}),
    ...(payload?.riskOutput && typeof payload.riskOutput === 'object' ? { riskOutput: payload.riskOutput } : {}),
  };
};

const buildFallbackResponse = (payload, execution, reason, requestId, startedAt) => {
  const fatigue = runFatigueFallback(payload);
  const risk = runRiskFallback(payload, fatigue);
  const tactical = runTacticalFallback(payload, fatigue, risk);
  const reasons = dedupeReasons([reason, ...(execution?.reasons || [])]);
  return {
    ok: true,
    ...tactical,
    status: 'fallback',
    mode: 'fallback',
    dataMode: execution.dataMode,
    llmMode: execution.llmMode,
    routingMode: 'fallback',
    reasons,
    coachOutput: String(tactical.immediateAction || tactical.rationale || 'Tactical analysis completed.').trim(),
    agents: {
      tactical: { status: 'FALLBACK' },
    },
    meta: {
      requestId,
      llmMode: execution.llmMode,
      dataMode: execution.dataMode,
      model: 'rules-based-fallback',
      fallbacksUsed: reasons,
      timingsMs: {
        total: Date.now() - startedAt,
        tactical: Date.now() - startedAt,
      },
    },
  };
};

module.exports = async function tactical(context, req) {
  const startedAt = Date.now();
  const requestId = randomUUID();
  const method = String(req?.method || 'POST').trim().toUpperCase();
  const url = String(req?.url || '/api/agents/tactical').trim() || '/api/agents/tactical';
  const respond = (response) => {
    context.res = response;
    return response;
  };

  if (method === 'OPTIONS') {
    return respond(optionsResponse('POST,OPTIONS', {}, req));
  }

  if (method !== 'POST') {
    return respond(
      jsonResponse(
        200,
        {
          ok: false,
          error: 'method_not_allowed',
          message: 'Use POST for tactical analysis.',
          routingMode: 'fallback',
          reasons: ['method_not_allowed'],
        },
        {},
        req
      )
    );
  }

  const payload = normalizeBody(req);
  const llm = isLlmConfigured();
  const execution = resolveAiExecution(payload, llm);

  context.log?.('[tactical] request', {
    requestId,
    method,
    url,
    mode: execution.requestedMode,
    dataMode: execution.dataMode,
    llmMode: execution.llmMode,
    aiEnabled: execution.aiEnabled,
    llmConfigured: llm.ok,
  });

  if (execution.llmMode !== 'ai') {
    return respond(jsonResponse(200, buildFallbackResponse(payload, execution, 'llm_mode_rules', requestId, startedAt), {}, req));
  }

  if (!llm.ok) {
    return respond(jsonResponse(200, buildFallbackResponse(payload, execution, 'missing_aoai_config', requestId, startedAt), {}, req));
  }

  if (!tacticalCore || typeof tacticalCore.runTacticalAgent !== 'function') {
    const status = execution.strictAi ? 502 : 200;
    if (status === 200) {
      return respond(jsonResponse(200, buildFallbackResponse(payload, execution, 'backend_not_ready', requestId, startedAt), {}, req));
    }
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
          reasons: ['backend_not_ready'],
          requestId,
        },
        {},
        req
      )
    );
  }

  try {
    const normalized = normalizePayload(payload, requestId);

    if (validationCore && typeof validationCore.validateTacticalRequest === 'function') {
      const validated = validationCore.validateTacticalRequest(normalized);
      if (validated && validated.ok === false) {
        const message = String(validated.message || 'Invalid tactical payload');
        if (execution.strictAi) {
          return respond(jsonResponse(400, { ok: false, error: 'invalid_payload', message, requestId }, {}, req));
        }
        return respond(jsonResponse(200, buildFallbackResponse(payload, execution, 'invalid_payload', requestId, startedAt), {}, req));
      }
    }

    const result = await tacticalCore.runTacticalAgent(normalized);
    const output = result?.output && typeof result.output === 'object' ? result.output : {};
    const fallbackReasons = dedupeReasons(result?.fallbacksUsed || []);
    const fallbackActive = String(output.status || '').toLowerCase() === 'fallback' || fallbackReasons.length > 0;

    if (fallbackActive && execution.strictAi) {
      return respond(
        jsonResponse(
          502,
          {
            ok: false,
            error: 'ai_upstream_failed',
            message: 'Azure OpenAI tactical analysis failed in strict ai mode.',
            mode: 'live',
            dataMode: execution.dataMode,
            llmMode: execution.llmMode,
            routingMode: 'ai',
            reasons: fallbackReasons.length > 0 ? fallbackReasons : ['upstream_unavailable'],
            requestId,
            agents: {
              tactical: { status: 'ERROR' },
            },
            meta: {
              requestId,
              timingsMs: {
                total: Date.now() - startedAt,
                tactical: Date.now() - startedAt,
              },
            },
          },
          {},
          req
        )
      );
    }

    if (fallbackActive && execution.requestedMode === 'auto') {
      return respond(jsonResponse(200, buildFallbackResponse(payload, execution, fallbackReasons[0] || 'upstream_unavailable', requestId, startedAt), {}, req));
    }

    const routingMode = fallbackActive ? 'fallback' : 'ai';
    const responseBody = {
      ok: true,
      ...output,
      status: fallbackActive ? 'fallback' : 'ok',
      mode: routingMode === 'ai' ? 'live' : 'fallback',
      dataMode: execution.dataMode,
      llmMode: execution.llmMode,
      routingMode,
      reasons: fallbackActive ? (fallbackReasons.length > 0 ? fallbackReasons : ['upstream_unavailable']) : [],
      coachOutput: String(output.immediateAction || output.rationale || 'Tactical analysis completed.').trim(),
      agents: {
        tactical: { status: routingMode === 'ai' ? 'OK' : 'FALLBACK' },
      },
      meta: {
        requestId,
        llmMode: execution.llmMode,
        dataMode: execution.dataMode,
        model: result?.model || (routingMode === 'ai' ? 'llm' : 'rules-based-fallback'),
        fallbacksUsed: fallbackReasons,
        timingsMs: {
          total: Date.now() - startedAt,
          tactical: Date.now() - startedAt,
        },
      },
    };

    context.log?.('[tactical] response', {
      requestId,
      status: 200,
      routingMode,
      aoaiConfigured: llm.ok,
      durationMs: Date.now() - startedAt,
    });

    return respond(jsonResponse(200, responseBody, {}, req));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || 'unknown_error');
    context.error?.('[tactical] error', { requestId, message });

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
            reasons: ['upstream_unavailable'],
            requestId,
          },
          {},
          req
        )
      );
    }

    return respond(jsonResponse(200, buildFallbackResponse(payload, execution, `upstream_error:${message}`, requestId, startedAt), {}, req));
  }
};
