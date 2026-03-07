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

const DOMAIN_REFUSAL_REPLY =
  "I'm designed to help with cricket tactics, player performance, match analysis, workload, fatigue, recovery, and injury-risk decisions. Ask me anything in the cricket and coaching domain.";

const DOMAIN_ALLOWED_KEYWORDS = [
  'cricket',
  'cricketer',
  'cricketers',
  'match',
  'all-time',
  'all time',
  'greatest',
  'goat',
  'inning',
  'innings',
  'test cricket',
  'odi',
  't20',
  'ipl',
  'world cup',
  'over',
  'overs',
  'death overs',
  'death-over',
  'bowler',
  'bowlers',
  'batter',
  'batters',
  'batsman',
  'batsmen',
  'all-rounder',
  'all rounder',
  'spinner',
  'spinners',
  'pace',
  'fast bowler',
  'seam',
  'swing',
  'fielding',
  'captaincy',
  'batting order',
  'finisher',
  'finishers',
  'anchor',
  'anchors',
  'player comparison',
  'compare players',
  'best player',
  'best bowler',
  'best batter',
  'batting',
  'bowling',
  'wicket',
  'field',
  'target',
  'strike rate',
  'economy rate',
  'dot ball',
  'boundary',
  'run rate',
  'pressure',
  'phase',
  'powerplay',
  'death over',
  'rotation',
  'tactical',
  'strategy',
  'fatigue',
  'strain',
  'workload',
  'load management',
  'training load',
  'recovery',
  'injury',
  'injuries',
  'sports medicine',
  'performance science',
  'biomechanics',
  'biomechanic',
  'mechanics',
  'bowling mechanics',
  'batting strain',
  'readiness',
  'rehab',
  'prehab',
  'conditioning',
  'soft tissue',
  'hamstring',
  'side strain',
  'stress fracture',
  'back stress',
  'shoulder',
  'elbow',
  'wrist',
  'ankle',
  'knee',
  'no-ball',
  'noball',
  'fitness',
  'readiness',
  'risk',
  'spell',
  'coach',
];

const DOMAIN_BLOCKED_KEYWORDS = [
  'movie',
  'movies',
  'netflix',
  'series',
  'cinema',
  'song',
  'music',
  'politics',
  'election',
  'president',
  'government',
  'trivia',
  'general knowledge',
  'capital of',
  'recipe',
  'restaurant',
  'travel',
  'weather',
  'bitcoin',
  'crypto',
  'stock',
  'investment',
  'dating',
  'relationship',
  'joke',
  'meme',
  'football',
  'soccer',
  'basketball',
  'tennis',
  'hockey',
  'baseball',
  'nfl',
  'nba',
];

const FOLLOW_UP_PATTERNS = [
  /are you sure/,
  /are u sure/,
  /are you even ai/,
  /are u even ai/,
  /\bwhy\b/,
  /\bexplain\b/,
  /\belaborate\b/,
  /\bwhat if\b/,
  /\bhow sure\b/,
  /\bcan you justify\b/,
];

const includesKeyword = (text, keyword) => {
  if (!text || !keyword) return false;
  return text.includes(keyword);
};

const DOMAIN_INTENT_KEYWORDS = [
  'cricket',
  'cricketer',
  'greatest',
  'all-time',
  'all time',
  'goat',
  't20',
  'odi',
  'test cricket',
  'ipl',
  'world cup',
  'strike rate',
  'economy rate',
  'death over',
  'death overs',
  'powerplay',
  'captaincy',
  'fielding',
  'all-rounder',
  'all rounder',
  'spinner',
  'pace',
  'fast bowler',
  'player comparison',
  'best player',
  'best bowler',
  'best batter',
  'bowling',
  'batting',
  'bowler',
  'bowlers',
  'batter',
  'batters',
  'batsman',
  'batsmen',
  'wicket',
  'over',
  'spell',
  'tactical',
  'strategy',
  'pressure',
  'run rate',
  'fatigue',
  'workload',
  'training load',
  'load management',
  'recovery',
  'strain',
  'injur',
  'risk',
  'sports medicine',
  'biomechan',
  'mechanics',
  'readiness',
  'performance science',
  'no-ball',
  'noball',
];

const collectAllowedKeywordHits = (normalizedMessage) =>
  DOMAIN_ALLOWED_KEYWORDS.filter((keyword) => includesKeyword(normalizedMessage, keyword));

const collectBlockedKeywordHits = (normalizedMessage) =>
  DOMAIN_BLOCKED_KEYWORDS.filter((keyword) => includesKeyword(normalizedMessage, keyword));

const collectDomainIntentHits = (normalizedMessage) =>
  DOMAIN_INTENT_KEYWORDS.filter((keyword) => includesKeyword(normalizedMessage, keyword));

const hasCopilotContextSignals = (snapshot) => {
  const matchContext = asRecord(snapshot.matchContext);
  const telemetry = asRecord(snapshot.telemetry);
  const players = asRecord(snapshot.players);
  const coachOutput = asRecord(snapshot.coachOutput);
  return Boolean(
    Object.keys(matchContext).length > 0 ||
      Object.keys(telemetry).length > 0 ||
      Object.keys(players).length > 0 ||
      Object.keys(coachOutput).length > 0
  );
};

const classifyCopilotDomain = (message, history, snapshot) => {
  const normalizedMessage = String(message || '').trim().toLowerCase();
  const allowedHits = collectAllowedKeywordHits(normalizedMessage);
  const blockedHits = collectBlockedKeywordHits(normalizedMessage);
  const domainIntentHits = collectDomainIntentHits(normalizedMessage);
  const followUpDetected = FOLLOW_UP_PATTERNS.some((pattern) => pattern.test(normalizedMessage));
  const hasRecentTurns = Array.isArray(history) && history.length > 0;
  const hasContextSignals = hasCopilotContextSignals(snapshot);
  const hasDomainIntent = domainIntentHits.length > 0;

  if (blockedHits.length > 0 && !hasDomainIntent) {
    return {
      allowed: false,
      reason: 'blocked_keyword',
      allowedHits,
      blockedHits,
      domainIntentHits,
      followUpDetected,
    };
  }

  if (hasDomainIntent) {
    return {
      allowed: true,
      reason: 'allowed_domain_intent',
      allowedHits,
      blockedHits,
      domainIntentHits,
      followUpDetected,
    };
  }

  if (allowedHits.length > 0) {
    return {
      allowed: true,
      reason: 'allowed_keyword',
      allowedHits,
      blockedHits,
      domainIntentHits,
      followUpDetected,
    };
  }

  if (followUpDetected && (hasRecentTurns || hasContextSignals)) {
    return {
      allowed: true,
      reason: 'contextual_follow_up',
      allowedHits,
      blockedHits,
      domainIntentHits,
      followUpDetected,
    };
  }

  return {
    allowed: false,
    reason: 'out_of_domain',
    allowedHits,
    blockedHits,
    domainIntentHits,
    followUpDetected,
  };
};

const buildCopilotSystemPrompt = () =>
  [
    'You are tactIQ Coach Copilot, a cricket tactical and performance intelligence assistant.',
    'You are not a general chatbot.',
    'You can answer questions about live match state, cricket tactics, format strategy (T20/ODI/Test), player comparisons, and cricket performance science.',
    'Also answer questions about fatigue, workload, recovery, readiness, biomechanics, and injury-risk in cricket.',
    'Ground responses in provided context when relevant, but do not force match-state references when the user asks broader cricket knowledge questions.',
    'Do not invent unavailable metrics; if a key value is missing, state that briefly.',
    'Your response style must be coach-facing: clear answer, cricket-specific reasoning, subtle signal, and practical implication.',
    'Be concise but insightful (typically 3-6 sentences).',
    'If a question is unrelated to this domain, refuse politely and redirect to cricket match guidance.',
  ].join(' ');

const buildCopilotSignalSummary = (snapshot) => {
  const matchContextSnapshot = asRecord(snapshot.matchContextSnapshot);
  const matchContext = asRecord(snapshot.matchContext);
  const telemetry = asRecord(snapshot.telemetry);
  const players = asRecord(snapshot.players);
  const coachOutput = asRecord(snapshot.coachOutput);
  const tacticalRecommendation = asRecord(coachOutput.tacticalRecommendation);
  const combinedDecision = asRecord(coachOutput.combinedDecision);

  const lines = [
    `mode=${toText(matchContext.matchMode, matchContextSnapshot.matchMode, 'unknown')}`,
    `format=${toText(matchContext.format, matchContextSnapshot.format, 'unknown')}`,
    `phase=${toText(matchContext.phase, matchContextSnapshot.phase, 'unknown')}`,
    `score=${toText(matchContext.scoreRuns, matchContextSnapshot.scoreRuns, '?')}/${toText(matchContext.wicketsInHand, matchContextSnapshot.wickets, '?')}`,
    `overs=${toText(matchContext.overs, matchContextSnapshot.overs, '?')}.${toText(matchContext.balls, matchContextSnapshot.balls, '0')}`,
    `requiredRunRate=${toText(matchContext.requiredRunRate, matchContextSnapshot.requiredRunRate, 'n/a')}`,
    `selectedPlayer=${toText(telemetry.playerName, players.bowler, players.striker, 'unknown')}`,
    `role=${toText(telemetry.role, 'unknown')}`,
    `fatigueIndex=${toText(telemetry.fatigueIndex, 'n/a')}`,
    `strainIndex=${toText(telemetry.strainIndex, 'n/a')}`,
    `injuryRisk=${toText(telemetry.injuryRisk, 'n/a')}`,
    `noBallRisk=${toText(telemetry.noBallRisk, 'n/a')}`,
    `heartRateRecovery=${toText(telemetry.heartRateRecovery, 'n/a')}`,
    `latestAction=${toText(
      tacticalRecommendation.nextAction,
      tacticalRecommendation.primary,
      combinedDecision.immediateAction,
      'n/a'
    )}`,
    `latestRationale=${toText(
      tacticalRecommendation.why,
      combinedDecision.rationale,
      coachOutput.summary,
      'n/a'
    )}`,
  ];

  return lines.join('\n');
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

  const domain = classifyCopilotDomain(message, history, contextSnapshot);
  context.log?.('[copilot-chat] domain_guard', {
    traceId,
    routeCalled,
    allowed: domain.allowed,
    reason: domain.reason,
    allowedHits: domain.allowedHits,
    blockedHits: domain.blockedHits,
    domainIntentHits: domain.domainIntentHits,
    followUpDetected: domain.followUpDetected,
  });

  if (!domain.allowed) {
    return respond(
      jsonResponse(
        200,
        {
          ok: true,
          source: 'fallback',
          mode: 'domain_guard',
          routeCalled,
          fallbackReason: `domain_guard:${domain.reason}`,
          analysisIdUsed,
          reply: DOMAIN_REFUSAL_REPLY,
          messagesUsed: Math.min(10, countUserTurns(history) + 1),
        },
        {},
        req
      )
    );
  }

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

  const systemPrompt = buildCopilotSystemPrompt();
  const signalSummary = buildCopilotSignalSummary(contextSnapshot);

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'system', content: `High-signal coaching context:\n${signalSummary}` },
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
