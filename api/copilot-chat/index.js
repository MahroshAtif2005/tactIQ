const { randomUUID } = require('crypto');
const {
  jsonResponse,
  optionsResponse,
  normalizeBody,
  resolveAoaiRuntimeConfig,
} = require('../shared/agentRuntime');
const { buildAoaiChatUrl } = require('../shared/aoaiConfig');

const asRecord = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

const toText = (...values) => {
  for (const value of values) {
    const normalized = String(value || '').trim();
    if (normalized.length > 0) return normalized;
  }
  return '';
};

const clipText = (value, max = 420) => {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 3)).trim()}...`;
};

const compactJson = (value, max = 2800) => {
  try {
    const encoded = JSON.stringify(value || {});
    if (encoded.length <= max) return encoded;
    return `${encoded.slice(0, Math.max(0, max - 3))}...`;
  } catch {
    return '{}';
  }
};

const normalizeRole = (value) => (String(value || '').trim().toLowerCase() === 'assistant' ? 'assistant' : 'user');

const sanitizeHistory = (value) => {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      const record = asRecord(entry);
      const content = clipText(record.content, 800);
      if (!content) return null;
      return {
        role: normalizeRole(record.role),
        content,
      };
    })
    .filter(Boolean)
    .slice(-8);
};

const countUserTurns = (history = []) =>
  history.reduce((total, turn) => total + (turn.role === 'user' ? 1 : 0), 0);

const extractCompletionText = (payload) => {
  const record = asRecord(payload);
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const firstChoice = asRecord(choices[0]);
  const message = asRecord(firstChoice.message);
  const content = message.content;

  if (typeof content === 'string' && content.trim().length > 0) {
    return content.trim();
  }

  if (Array.isArray(content)) {
    const joined = content
      .map((entry) => {
        if (typeof entry === 'string') return entry;
        const part = asRecord(entry);
        if (typeof part.text === 'string') return part.text;
        return '';
      })
      .join(' ')
      .trim();
    if (joined) return joined;
  }

  if (content && typeof content === 'object') {
    try {
      const encoded = JSON.stringify(content);
      if (encoded.trim().length > 0) return encoded;
    } catch {
      // Ignore conversion failures.
    }
  }

  return '';
};

const parseStatusCode = (value) => {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed >= 100 && parsed <= 599) return parsed;
  return undefined;
};

const summarizeRawBody = (value) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 360);

const parseUpstreamCode = (rawBody) => {
  try {
    const parsed = JSON.parse(rawBody);
    return toText(asRecord(parsed.error).code);
  } catch {
    return '';
  }
};

const buildFallbackReply = (userMessage, payload, fallbackReason = '') => {
  const coachOutput = asRecord(payload.coachOutput);
  const tacticalRecommendation = asRecord(coachOutput.tacticalRecommendation);
  const combinedDecision = asRecord(coachOutput.combinedDecision);
  const players = asRecord(payload.players);
  const telemetry = asRecord(payload.telemetry);
  const playerName = toText(telemetry.playerName, players.bowler, 'the current bowler');
  const nextAction = toText(
    tacticalRecommendation.nextAction,
    tacticalRecommendation.primary,
    combinedDecision.immediateAction,
    'continue with monitored execution and reassess after this over'
  );
  const rationale = toText(
    tacticalRecommendation.why,
    combinedDecision.rationale,
    coachOutput.summary,
    fallbackReason ? `Fallback reason: ${fallbackReason}.` : ''
  );
  const normalizedQuestion = String(userMessage || '').trim().toLowerCase();

  if (/are you sure|are u sure|are you even ai|are u even ai|are you ai/.test(normalizedQuestion)) {
    return `Copilot is currently in fallback/local mode, so this reply is not from Azure OpenAI. Based on the latest match state, ${nextAction}. ${rationale}`.trim();
  }

  if (/why|reason|because/.test(normalizedQuestion)) {
    return `I am in fallback/local mode right now. The safest recommendation is to ${nextAction}. ${rationale}`.trim();
  }

  return `Copilot is in fallback/local mode for this message. Recommended action: ${nextAction}. ${rationale}`.trim();
};

module.exports = async function copilotChat(context, req) {
  const startedAt = Date.now();
  const traceId = randomUUID();
  const method = String(req?.method || '').trim().toUpperCase();
  const routeCalled = '/api/copilot-chat';
  const url = String(req?.url || routeCalled).trim() || routeCalled;
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
        405,
        {
          ok: false,
          error: 'method_not_allowed',
          message: 'Use POST /api/copilot-chat.',
          routeCalled,
        },
        {},
        req
      )
    );
  }

  const payload = normalizeBody(req);
  const message = toText(payload.message);
  if (!message) {
    return respond(
      jsonResponse(
        400,
        {
          ok: false,
          error: 'invalid_request',
          message: 'message must be a non-empty string',
          routeCalled,
        },
        {},
        req
      )
    );
  }

  const analysisIdUsed = toText(payload.analysisId, `local-copilot-${Date.now()}`);
  const history = sanitizeHistory(payload.history);
  const contextSnapshot = {
    matchContextSnapshot: asRecord(payload.matchContextSnapshot),
    telemetry: asRecord(payload.telemetry),
    matchContext: asRecord(payload.matchContext),
    players: asRecord(payload.players),
    coachOutput: asRecord(payload.coachOutput),
    matchId: toText(payload.matchId),
    sessionId: toText(payload.sessionId),
  };
  const contextJson = compactJson(contextSnapshot, 2800);

  context.log?.('[copilot-chat] submit', {
    traceId,
    routeCalled,
    url,
    analysisId: analysisIdUsed,
    prompt: message,
    historyTurns: history.length,
  });

  const aoai = resolveAoaiRuntimeConfig();
  const requestUrl = buildAoaiChatUrl(aoai);
  const aiPathSelected = Boolean(aoai.ok && requestUrl);
  context.log?.('[copilot-chat] routing', {
    traceId,
    routeCalled,
    aiPathSelected,
    fallbackPath: !aiPathSelected,
    endpointHost: aoai.endpointHost || '',
    deployment: aoai.deployment || '',
    apiVersion: aoai.apiVersion || '',
    requestUrl,
    authHeader: 'api-key',
  });

  if (!aiPathSelected) {
    const fallbackReason = aoai.missing && aoai.missing.length > 0
      ? `missing_config:${aoai.missing.join(',')}`
      : 'aoai_not_available';
    const reply = buildFallbackReply(message, payload, fallbackReason);
    context.log?.('[copilot-chat] fallback', {
      traceId,
      routeCalled,
      source: 'fallback',
      reason: fallbackReason,
      latencyMs: Date.now() - startedAt,
    });
    return respond(
      jsonResponse(
        200,
        {
          ok: true,
          source: 'fallback',
          mode: 'fallback',
          routeCalled,
          fallbackReason,
          analysisIdUsed,
          reply,
          messagesUsed: Math.min(10, countUserTurns(history) + 1),
        },
        {},
        req
      )
    );
  }

  const systemPrompt = [
    'You are tactIQ Copilot, a cricket tactical assistant.',
    'Use the latest match context JSON as supporting context, but answer the current user message directly.',
    'Do not recycle static tactical text; adapt to the exact user question and recent chat turns.',
    'Keep responses concise, practical, and coaching-focused.',
  ].join(' ');

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'system', content: `Current tactIQ context snapshot JSON:\n${contextJson}` },
    ...history.map((turn) => ({ role: turn.role, content: turn.content })),
    { role: 'user', content: message },
  ];

  try {
    const upstreamResponse = await fetch(requestUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': String(aoai.apiKey || ''),
      },
      body: JSON.stringify({
        messages,
        temperature: 0.25,
        max_tokens: 420,
      }),
    });
    const rawBody = await upstreamResponse.text();

    if (!upstreamResponse.ok) {
      const status = parseStatusCode(upstreamResponse.status);
      const code = parseUpstreamCode(rawBody);
      const body = summarizeRawBody(rawBody);
      context.log?.('[copilot-chat] fallback', {
        traceId,
        routeCalled,
        source: 'fallback',
        reason: 'aoai_http_error',
        status,
        code: code || undefined,
        body,
      });
      const fallbackReason = `aoai_http_${String(status || 'error')}`;
      return respond(
        jsonResponse(
          200,
          {
            ok: true,
            source: 'fallback',
            mode: 'fallback',
            routeCalled,
            fallbackReason,
            analysisIdUsed,
            reply: buildFallbackReply(message, payload, fallbackReason),
            messagesUsed: Math.min(10, countUserTurns(history) + 1),
            upstream: {
              ...(typeof status === 'number' ? { status } : {}),
              ...(code ? { code } : {}),
              ...(body ? { body } : {}),
            },
          },
          {},
          req
        )
      );
    }

    let parsed;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      parsed = {};
    }
    const reply = extractCompletionText(parsed);
    if (!reply) {
      const fallbackReason = 'aoai_empty_response';
      context.log?.('[copilot-chat] fallback', {
        traceId,
        routeCalled,
        source: 'fallback',
        reason: fallbackReason,
      });
      return respond(
        jsonResponse(
          200,
          {
            ok: true,
            source: 'fallback',
            mode: 'fallback',
            routeCalled,
            fallbackReason,
            analysisIdUsed,
            reply: buildFallbackReply(message, payload, fallbackReason),
            messagesUsed: Math.min(10, countUserTurns(history) + 1),
          },
          {},
          req
        )
      );
    }

    const messagesUsed = Math.min(10, countUserTurns(history) + 1);
    context.log?.('[copilot-chat] reply', {
      traceId,
      routeCalled,
      source: 'ai',
      analysisId: analysisIdUsed,
      messagesUsed,
      latencyMs: Date.now() - startedAt,
    });
    return respond(
      jsonResponse(
        200,
        {
          ok: true,
          source: 'ai',
          mode: 'ai',
          routeCalled,
          analysisIdUsed,
          reply,
          messagesUsed,
        },
        {},
        req
      )
    );
  } catch (error) {
    const status = parseStatusCode(error && typeof error === 'object' ? error.status : undefined);
    const messageText = error instanceof Error ? error.message : String(error || 'unknown_error');
    const fallbackReason = `aoai_error:${clipText(messageText, 120)}`;
    context.log?.('[copilot-chat] fallback', {
      traceId,
      routeCalled,
      source: 'fallback',
      reason: fallbackReason,
      ...(typeof status === 'number' ? { status } : {}),
    });
    return respond(
      jsonResponse(
        200,
        {
          ok: true,
          source: 'fallback',
          mode: 'fallback',
          routeCalled,
          fallbackReason,
          analysisIdUsed,
          reply: buildFallbackReply(message, payload, fallbackReason),
          messagesUsed: Math.min(10, countUserTurns(history) + 1),
          ...(typeof status === 'number' ? { upstream: { status } } : {}),
        },
        {},
        req
      )
    );
  }
};
