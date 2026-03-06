const { randomUUID } = require('crypto');
const {
  jsonResponse,
  optionsResponse,
  normalizeBody,
  resolveAiExecution,
  isLlmConfigured,
} = require('../shared/agentRuntime');
const { runFatigueFallback, runRiskFallback } = require('../shared/simpleAgents');

let riskCore = null;
try {
  riskCore = require('../dist/agents/riskAgent');
} catch {
  riskCore = null;
}

const toNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toRisk = (value, fallback = 'UNKNOWN') => {
  const token = String(value || fallback).trim().toUpperCase();
  if (token === 'LOW' || token === 'MED' || token === 'MEDIUM' || token === 'HIGH' || token === 'UNKNOWN') {
    return token;
  }
  return fallback;
};

const dedupeReasons = (values) => Array.from(new Set((Array.isArray(values) ? values : []).map((entry) => String(entry || '').trim()).filter(Boolean)));

const sanitizeRequest = (payload) => {
  const format = String(payload?.format || payload?.match?.format || 'T20');
  const formatMaxOvers = format.toUpperCase().includes('T20') ? 4 : format.toUpperCase().includes('ODI') ? 10 : 12;
  const maxOvers = Math.max(1, Math.floor(toNumber(payload?.maxOvers, formatMaxOvers)));
  const oversBowled = Math.min(maxOvers, Math.max(0, toNumber(payload?.oversBowled, 0)));
  const rawSpellOvers = toNumber(payload?.consecutiveOvers, 0);
  const consecutiveOvers = Math.max(0, Math.min(rawSpellOvers, oversBowled));
  const oversRemaining = Math.max(0, Math.min(maxOvers, toNumber(payload?.oversRemaining, maxOvers - oversBowled)));

  return {
    playerId: String(payload?.playerId || 'UNKNOWN'),
    fatigueIndex: Math.max(0, Math.min(10, toNumber(payload?.fatigueIndex, 0))),
    strainIndex: Math.max(0, Math.min(10, toNumber(payload?.strainIndex, 0))),
    injuryRisk: toRisk(payload?.injuryRisk, 'UNKNOWN'),
    noBallRisk: toRisk(payload?.noBallRisk, 'UNKNOWN'),
    oversBowled,
    consecutiveOvers,
    oversRemaining,
    maxOvers,
    quotaComplete: payload?.quotaComplete === true,
    heartRateRecovery: payload?.heartRateRecovery ? String(payload.heartRateRecovery) : undefined,
    isUnfit: payload?.isUnfit === true,
    format,
    phase: String(payload?.phase || payload?.match?.phase || 'Middle'),
    intensity: String(payload?.intensity || payload?.match?.intensity || 'Medium'),
    conditions: payload?.conditions ? String(payload.conditions) : payload?.match?.conditions ? String(payload.match.conditions) : undefined,
    target: Number.isFinite(toNumber(payload?.target, Number.NaN)) ? toNumber(payload?.target, 0) : undefined,
    score: Number.isFinite(toNumber(payload?.score, Number.NaN)) ? toNumber(payload?.score, 0) : undefined,
    over: Number.isFinite(toNumber(payload?.over, Number.NaN)) ? toNumber(payload?.over, 0) : undefined,
    balls: Number.isFinite(toNumber(payload?.balls, Number.NaN)) ? toNumber(payload?.balls, 0) : undefined,
    ...(payload?.context && typeof payload.context === 'object' ? { fullMatchContext: payload.context } : {}),
    ...(Array.isArray(payload?.replacementCandidates) ? { replacementCandidates: payload.replacementCandidates } : {}),
  };
};

const buildFallbackResponse = (payload, execution, reason, requestId, startedAt) => {
  const fatigue = runFatigueFallback(payload);
  const risk = runRiskFallback(payload, fatigue);
  const reasons = dedupeReasons([reason, ...(execution?.reasons || [])]);
  return {
    ok: true,
    ...risk,
    status: 'fallback',
    mode: 'fallback',
    dataMode: execution.dataMode,
    llmMode: execution.llmMode,
    routingMode: 'fallback',
    reasons,
    coachOutput: String(risk.recommendation || risk.explanation || risk.headline || 'Risk analysis completed.').trim(),
    agents: {
      risk: { status: 'FALLBACK' },
    },
    meta: {
      requestId,
      llmMode: execution.llmMode,
      dataMode: execution.dataMode,
      model: 'rules-based-fallback',
      fallbacksUsed: reasons,
      timingsMs: {
        total: Date.now() - startedAt,
        risk: Date.now() - startedAt,
      },
    },
  };
};

module.exports = async function risk(context, req) {
  const startedAt = Date.now();
  const requestId = randomUUID();
  const method = String(req?.method || 'POST').trim().toUpperCase();
  const url = String(req?.url || '/api/agents/risk').trim() || '/api/agents/risk';
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
          message: 'Use POST for risk analysis.',
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

  context.log?.('[risk] request', {
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

  if (!riskCore || typeof riskCore.runRiskAgent !== 'function') {
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
    const input = sanitizeRequest(payload);
    const result = await riskCore.runRiskAgent(input);
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
            message: 'Azure OpenAI risk analysis failed in strict ai mode.',
            mode: 'live',
            dataMode: execution.dataMode,
            llmMode: execution.llmMode,
            routingMode: 'ai',
            reasons: fallbackReasons.length > 0 ? fallbackReasons : ['upstream_unavailable'],
            requestId,
            agents: {
              risk: { status: 'ERROR' },
            },
            meta: {
              requestId,
              timingsMs: {
                total: Date.now() - startedAt,
                risk: Date.now() - startedAt,
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
      coachOutput: String(output.recommendation || output.explanation || output.headline || 'Risk analysis completed.').trim(),
      agents: {
        risk: { status: routingMode === 'ai' ? 'OK' : 'FALLBACK' },
      },
      meta: {
        requestId,
        llmMode: execution.llmMode,
        dataMode: execution.dataMode,
        model: result?.model || (routingMode === 'ai' ? 'llm' : 'rules-based-fallback'),
        fallbacksUsed: fallbackReasons,
        timingsMs: {
          total: Date.now() - startedAt,
          risk: Date.now() - startedAt,
        },
      },
    };

    context.log?.('[risk] response', {
      requestId,
      status: 200,
      routingMode,
      aoaiConfigured: llm.ok,
      durationMs: Date.now() - startedAt,
    });

    return respond(jsonResponse(200, responseBody, {}, req));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || 'unknown_error');
    context.error?.('[risk] error', { requestId, message });

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
