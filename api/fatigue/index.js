const { randomUUID } = require('crypto');
const {
  jsonResponse,
  optionsResponse,
  normalizeBody,
  resolveAiExecution,
  isLlmConfigured,
} = require('../shared/agentRuntime');
const { runFatigueFallback } = require('../shared/simpleAgents');

let fatigueCore = null;
try {
  fatigueCore = require('../dist/agents/fatigueAgent');
} catch {
  fatigueCore = null;
}

const toNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toRisk = (value, fallback = 'MEDIUM') => {
  const token = String(value || fallback).trim().toUpperCase();
  if (token === 'LOW' || token === 'MED' || token === 'MEDIUM' || token === 'HIGH' || token === 'UNKNOWN') {
    return token;
  }
  return fallback;
};

const sanitizeRequest = (payload) => ({
  playerId: String(payload?.playerId || 'UNKNOWN'),
  playerName: String(payload?.playerName || 'Unknown Player'),
  role: String(payload?.role || 'Unknown Role'),
  oversBowled: Math.max(0, toNumber(payload?.oversBowled, 0)),
  consecutiveOvers: Math.max(0, toNumber(payload?.consecutiveOvers, 0)),
  oversRemaining: Math.max(0, toNumber(payload?.oversRemaining, 0)),
  maxOvers: Math.max(1, toNumber(payload?.maxOvers, 4)),
  quotaComplete: payload?.quotaComplete === true,
  fatigueIndex: Math.max(0, Math.min(10, toNumber(payload?.fatigueIndex, 3))),
  injuryRisk: toRisk(payload?.injuryRisk, 'MEDIUM'),
  noBallRisk: toRisk(payload?.noBallRisk, 'MEDIUM'),
  heartRateRecovery: String(payload?.heartRateRecovery || 'Moderate'),
  fatigueLimit: Math.max(0, toNumber(payload?.fatigueLimit, 6)),
  sleepHours: Math.max(0, toNumber(payload?.sleepHours, 7)),
  recoveryMinutes: Math.max(0, toNumber(payload?.recoveryMinutes, 45)),
  snapshotId: String(payload?.snapshotId || `fatigue-${Date.now()}`),
  matchContext: {
    format: String(payload?.matchContext?.format || 'T20'),
    phase: String(payload?.matchContext?.phase || 'middle'),
    over: toNumber(payload?.matchContext?.over, 0),
    intensity: String(payload?.matchContext?.intensity || 'Medium'),
  },
  ...(payload?.context && typeof payload.context === 'object' ? { fullMatchContext: payload.context } : {}),
  ...(Array.isArray(payload?.replacementCandidates) ? { replacementCandidates: payload.replacementCandidates } : {}),
});

const dedupeReasons = (values) => Array.from(new Set((Array.isArray(values) ? values : []).map((entry) => String(entry || '').trim()).filter(Boolean)));

const buildFallbackResponse = (payload, execution, reason, requestId, startedAt) => {
  const fallback = runFatigueFallback(payload);
  const reasons = dedupeReasons([reason, ...(execution?.reasons || [])]);
  return {
    ok: true,
    ...fallback,
    status: 'fallback',
    mode: 'fallback',
    dataMode: execution.dataMode,
    llmMode: execution.llmMode,
    routingMode: 'fallback',
    reasons,
    coachOutput: String(fallback.recommendation || fallback.explanation || fallback.headline || 'Fatigue analysis completed.').trim(),
    agents: {
      fatigue: { status: 'FALLBACK' },
    },
    meta: {
      requestId,
      llmMode: execution.llmMode,
      dataMode: execution.dataMode,
      model: 'rules-based-fallback',
      fallbacksUsed: reasons,
      timingsMs: {
        total: Date.now() - startedAt,
        fatigue: Date.now() - startedAt,
      },
    },
  };
};

module.exports = async function fatigue(context, req) {
  const startedAt = Date.now();
  const requestId = randomUUID();
  const method = String(req?.method || 'POST').trim().toUpperCase();
  const url = String(req?.url || '/api/agents/fatigue').trim() || '/api/agents/fatigue';
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
          message: 'Use POST for fatigue analysis.',
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

  context.log?.('[fatigue] request', {
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
    const body = buildFallbackResponse(payload, execution, 'llm_mode_rules', requestId, startedAt);
    return respond(jsonResponse(200, body, {}, req));
  }

  if (!llm.ok) {
    const body = buildFallbackResponse(payload, execution, 'missing_aoai_config', requestId, startedAt);
    return respond(jsonResponse(200, body, {}, req));
  }

  if (!fatigueCore || typeof fatigueCore.runFatigueAgent !== 'function') {
    const body = {
      ok: false,
      error: 'backend_not_ready',
      message: 'API dist modules are unavailable. Run npm --prefix api run build.',
      mode: 'fallback',
      dataMode: execution.dataMode,
      llmMode: execution.llmMode,
      routingMode: 'fallback',
      reasons: ['backend_not_ready'],
      requestId,
    };
    const status = execution.strictAi ? 502 : 200;
    if (status === 200) {
      return respond(jsonResponse(status, buildFallbackResponse(payload, execution, 'backend_not_ready', requestId, startedAt), {}, req));
    }
    return respond(jsonResponse(status, body, {}, req));
  }

  try {
    const input = sanitizeRequest(payload);
    const result = await fatigueCore.runFatigueAgent(input);
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
            message: 'Azure OpenAI fatigue analysis failed in strict ai mode.',
            mode: 'live',
            dataMode: execution.dataMode,
            llmMode: execution.llmMode,
            routingMode: 'ai',
            reasons: fallbackReasons.length > 0 ? fallbackReasons : ['upstream_unavailable'],
            requestId,
            agents: {
              fatigue: { status: 'ERROR' },
            },
            meta: {
              requestId,
              timingsMs: {
                total: Date.now() - startedAt,
                fatigue: Date.now() - startedAt,
              },
            },
          },
          {},
          req
        )
      );
    }

    if (fallbackActive && execution.requestedMode === 'auto') {
      const body = buildFallbackResponse(payload, execution, fallbackReasons[0] || 'upstream_unavailable', requestId, startedAt);
      return respond(jsonResponse(200, body, {}, req));
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
      coachOutput: String(output.recommendation || output.explanation || output.headline || 'Fatigue analysis completed.').trim(),
      agents: {
        fatigue: { status: routingMode === 'ai' ? 'OK' : 'FALLBACK' },
      },
      meta: {
        requestId,
        llmMode: execution.llmMode,
        dataMode: execution.dataMode,
        model: result?.model || (routingMode === 'ai' ? 'llm' : 'rules-based-fallback'),
        fallbacksUsed: fallbackReasons,
        timingsMs: {
          total: Date.now() - startedAt,
          fatigue: Date.now() - startedAt,
        },
      },
    };

    context.log?.('[fatigue] response', {
      requestId,
      status: 200,
      routingMode,
      aoaiConfigured: llm.ok,
      durationMs: Date.now() - startedAt,
    });

    return respond(jsonResponse(200, responseBody, {}, req));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || 'unknown_error');
    context.error?.('[fatigue] error', { requestId, message });

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

    const body = buildFallbackResponse(payload, execution, `upstream_error:${message}`, requestId, startedAt);
    return respond(jsonResponse(200, body, {}, req));
  }
};
