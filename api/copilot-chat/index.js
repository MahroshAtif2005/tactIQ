const { randomUUID } = require('crypto');
const {
  jsonResponse,
  optionsResponse,
  normalizeBody,
  resolveAoaiRuntimeConfig,
} = require('../shared/agentRuntime');
const { buildAoaiChatUrl } = require('../shared/aoaiConfig');

const asRecord = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const asArray = (value) => (Array.isArray(value) ? value : []);

const toText = (...values) => {
  for (const value of values) {
    const normalized = String(value || '').trim();
    if (normalized.length > 0) return normalized;
  }
  return '';
};

const resolveCopilotRoute = (rawUrl) => {
  const normalized = toText(rawUrl);
  if (!normalized) return '/api/copilot';
  try {
    const parsed = new URL(normalized, 'http://localhost');
    const path = toText(parsed.pathname);
    if (path.startsWith('/api/')) return path;
    if (path.startsWith('/')) return `/api${path}`;
  } catch {
    // Ignore malformed URLs and fall back to canonical route.
  }
  return '/api/copilot';
};

const parseRequestJson = async (req) => {
  if (typeof req?.json !== 'function') return {};
  try {
    const parsed = await req.json();
    return asRecord(parsed);
  } catch {
    return {};
  }
};

const normalizeCopilotPayload = async (req) => {
  const normalizedBody = asRecord(normalizeBody(req));
  const parsedJson = Object.keys(normalizedBody).length > 0 ? {} : await parseRequestJson(req);
  const payload = { ...(Object.keys(parsedJson).length > 0 ? parsedJson : normalizedBody) };

  const question = toText(payload.question);
  if (!toText(payload.message) && question) {
    payload.message = question;
  }

  const matchState = asRecord(payload.matchState);
  if (!payload.matchContext && Object.keys(matchState).length > 0) {
    payload.matchContext = matchState;
  }

  const roster = payload.roster;
  if (!payload.players) {
    if (Array.isArray(roster)) {
      payload.players = { rosterMetrics: roster };
    } else {
      const rosterRecord = asRecord(roster);
      if (Object.keys(rosterRecord).length > 0) {
        payload.players = rosterRecord;
      }
    }
  }

  return payload;
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

const OFF_TOPIC_REDIRECT_REPLY =
  "I'm focused on the current match state, player risk, substitutions, and tactical decisions. Ask me about the selected player or next-over plan.";

const NO_ACTIVE_PLAYER_REPLY =
  "I need a selected player to assess that. Choose a player from the roster and I'll evaluate their workload, risk, and next-over decision.";

const GREETING_REPLIES = [
  "Hey! I'm the tactIQ coaching assistant. Ask me anything about match tactics, fatigue, or player workload in this match.",
  "Hi! I'm here to help with tactical calls, workload risk, and next-over planning. Share the current match situation and I'll break it down.",
  'Hello! Ready when you are. Ask about the next over, bowling options, or player readiness and I will give a match-focused recommendation.',
];

const PERFORMANCE_INTENT_KEYWORDS = [
  'reliable',
  'reliability',
  'lowest fatigue',
  'low fatigue',
  'fatigue risk',
  'safest bowler',
  'safest batter',
  'safest player',
  'best condition',
  'best prepared',
  'ready to bowl',
  'ready to bat',
  'in best condition',
  'lowest injury risk',
  'workload risk',
  'readiness',
  'workload',
  'recovery',
  'sleep',
  'performance',
  'consistency',
  'most reliable player',
  'who should bowl',
  'who should bat',
];

const LIVE_SCOPE_KEYWORDS = [
  'this match',
  'current match',
  'match state',
  'current state',
  'next over',
  'this over',
  'over plan',
  'over planning',
  'pressure phase',
  'required run rate',
  'current run rate',
  'target',
  'wickets in hand',
  'score',
  'rotation',
  'rotate',
  'switch',
  'spell',
  'quota',
  'overs remaining',
  'no-ball risk',
  'noball risk',
  'injury risk',
  'fatigue',
  'strain',
  'workload',
  'recovery',
  'readiness',
  'coach recommendation',
  'coaching recommendation',
];

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

const CRICKET_ENTITY_KEYWORDS = [
  'afridi',
  'shaheen',
  'shahid',
  'kohli',
  'virat',
  'babar',
  'azam',
  'dhoni',
  'rohit',
  'bumrah',
  'stokes',
  'ben stokes',
  'root',
  'joe root',
  'smith',
  'steve smith',
  'williamson',
  'kane williamson',
  'jadeja',
  'rashid',
  'malinga',
  'sachin',
  'tendulkar',
  'dravid',
  'sehwag',
  'gavaskar',
  'lara',
  'ponting',
  'warne',
  'muralitharan',
  'akram',
  'waqar',
  'imran khan',
  'buttler',
  'livingstone',
  'maxwell',
  'gayle',
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
  'celebrity',
  'celebrities',
  'gossip',
  'dating',
  'relationship',
  'joke',
  'meme',
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

const GREETING_PATTERNS = [
  /^(hi|hey|hello|yo|hiya|howdy)[\s!.?]*$/,
  /^(good\s(morning|afternoon|evening))[\s!.?]*$/,
  /^(hi|hey|hello).{0,20}(coach|copilot|tactiq)?[\s!.?]*$/,
];

const hashText = (value) =>
  String(value || '')
    .split('')
    .reduce((acc, char) => ((acc * 31) + char.charCodeAt(0)) >>> 0, 7);

const pickReplyVariant = (variants, seedText) => {
  if (!Array.isArray(variants) || variants.length === 0) return '';
  return variants[hashText(seedText) % variants.length];
};

const isGreetingMessage = (message) => {
  const normalized = String(message || '').trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.length > 42) return false;
  return GREETING_PATTERNS.some((pattern) => pattern.test(normalized));
};

const buildCricketSmallTalkReply = (message) => {
  const normalized = String(message || '').trim().toLowerCase();
  if (/\b(best|better|greatest|goat|all[-\s]?time|versus|vs|compare|comparison)\b/.test(normalized)) {
    return 'That depends on role, era, and format. Reputation matters, but match context matters more. If you want, I can compare options for this exact phase and recommend the best tactical move.';
  }
  if (/\b(team|teams|player|players|captain|captaincy|format|t20|odi|test)\b/.test(normalized)) {
    return 'Both teams and players can look strong on paper, but tactical timing usually decides the result. If you share the current state, I can map the best move for this phase.';
  }
  return 'Good cricket question. Context usually matters more than reputation in live decisions. If you want, I can turn this into a match-specific tactical recommendation.';
};

const normalizeForKeywordMatch = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const compactForKeywordMatch = (value) => normalizeForKeywordMatch(value).replace(/\s+/g, '');

const includesKeyword = (text, keyword) => {
  const normalizedText = normalizeForKeywordMatch(text);
  const normalizedKeyword = normalizeForKeywordMatch(keyword);
  if (!normalizedText || !normalizedKeyword) return false;
  return normalizedText.includes(normalizedKeyword);
};

const REPLACEMENT_INTENT_PATTERNS = [
  /\bwho\s+should\s+i\s+change\b/,
  /\bwho\s+should\s+replace\b/,
  /\bwho\s+do\s+i\s+sub(?:stitute)?\s+in\b/,
  /\bwho\s+should\s+i\s+sub(?:stitute)?\s+in\b/,
  /\bchange\s+.+\s+with\b/,
  /\breplace\s+.+\s+with\b/,
  /\bswap\s+.+\s+with\b/,
  /\bsub(?:stitute)?\s+in\s+.+\s+for\b/,
  /\btake\s+.+\s+off\b/,
  /\bbring\s+.+\s+in\b/,
  /\bbring\s+.+\s+to\s+(?:bowl|bat)\b/,
  /\bnext\s+bowler\b/,
  /\bwho\s+after\b/,
];

const TACTICAL_QUERY_PATTERNS = [
  /\bsafest\s+plan\b/,
  /\bsafest\s+next\s+over\b/,
  /\bplan\s+the\s+next\b/,
  /\bnext\s+2\s+overs?\b/,
  /\bnext\s+two\s+overs?\b/,
  /\bwho\s+should\s+bowl\s+next\b/,
  /\brotate\s+now\b/,
];

const matchesAnyPattern = (text, patterns) => {
  if (!text) return false;
  return patterns.some((pattern) => pattern.test(text));
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

const SPORTS_DOMAIN_KEYWORDS = [
  'sport',
  'sports',
  'athlete',
  'athletic',
  'coaching',
  'coach',
  'fitness',
  'conditioning',
  'injury prevention',
  'workload',
  'recovery',
  'training',
  'performance',
  'football',
  'soccer',
  'basketball',
  'tennis',
  'hockey',
  'baseball',
];

const collectAllowedKeywordHits = (normalizedMessage) =>
  DOMAIN_ALLOWED_KEYWORDS.filter((keyword) => includesKeyword(normalizedMessage, keyword));

const collectBlockedKeywordHits = (normalizedMessage) =>
  DOMAIN_BLOCKED_KEYWORDS.filter((keyword) => includesKeyword(normalizedMessage, keyword));

const collectDomainIntentHits = (normalizedMessage) =>
  DOMAIN_INTENT_KEYWORDS.filter((keyword) => includesKeyword(normalizedMessage, keyword));

const collectLiveScopeHits = (normalizedMessage) =>
  LIVE_SCOPE_KEYWORDS.filter((keyword) => includesKeyword(normalizedMessage, keyword));

const collectCricketEntityHits = (normalizedMessage) =>
  CRICKET_ENTITY_KEYWORDS.filter((keyword) => includesKeyword(normalizedMessage, keyword));

const collectPerformanceIntentHits = (normalizedMessage) =>
  PERFORMANCE_INTENT_KEYWORDS.filter((keyword) => includesKeyword(normalizedMessage, keyword));

const collectSportsDomainHits = (normalizedMessage) =>
  SPORTS_DOMAIN_KEYWORDS.filter((keyword) => includesKeyword(normalizedMessage, keyword));

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

const collectSnapshotPlayerNames = (snapshot) => {
  const telemetry = asRecord(snapshot.telemetry);
  const players = asRecord(snapshot.players);
  const snapshotPlayers = asRecord(asRecord(snapshot.matchContextSnapshot).players);
  const tacticalState = asRecord(snapshot.tacticalRecommendationState);
  const names = [];
  const pushName = (...values) => {
    const value = toText(...values);
    if (value) names.push(value);
  };
  pushName(telemetry.playerName, telemetry.name);
  pushName(players.selectedBowler, snapshotPlayers.selectedBowler, players.bowler, snapshotPlayers.bowler);
  pushName(players.selectedBatter, snapshotPlayers.selectedBatter, players.striker, snapshotPlayers.striker);
  pushName(players.nonStriker, snapshotPlayers.nonStriker);
  pushName(
    tacticalState.recommendedOutgoingPlayer,
    tacticalState.recommendedReplacementPlayer,
    tacticalState.replacementOut,
    tacticalState.out,
    tacticalState.recommendedIncomingPlayer,
    tacticalState.replacementIn,
    tacticalState.in
  );

  const ingestRoster = (source) => {
    if (!Array.isArray(source)) return;
    for (const entry of source) {
      const row = asRecord(entry);
      pushName(row.name, row.playerName);
    }
  };
  ingestRoster(players.rosterMetrics);
  ingestRoster(snapshotPlayers.rosterMetrics);

  const dedupe = new Set();
  return names.filter((name) => {
    const key = normalizeForKeywordMatch(name);
    if (!key || key.length < 3 || dedupe.has(key)) return false;
    dedupe.add(key);
    return true;
  });
};

const hasContextPlayerMention = (message, snapshot) => {
  const normalizedMessage = normalizeForKeywordMatch(message);
  const compactMessage = compactForKeywordMatch(message);
  if (!normalizedMessage) return false;
  const playerNames = collectSnapshotPlayerNames(snapshot);
  return playerNames.some((name) => {
    const normalizedName = normalizeForKeywordMatch(name);
    if (!normalizedName || normalizedName.length < 3) return false;
    if (normalizedMessage.includes(normalizedName)) return true;
    const compactName = normalizedName.replace(/\s+/g, '');
    return compactName.length >= 3 && compactMessage.includes(compactName);
  });
};

const classifyCopilotDomain = (message, history, snapshot) => {
  const normalizedMessage = String(message || '').trim().toLowerCase();
  const allowedHits = collectAllowedKeywordHits(normalizedMessage);
  const blockedHits = collectBlockedKeywordHits(normalizedMessage);
  const domainIntentHits = collectDomainIntentHits(normalizedMessage);
  const liveScopeHits = collectLiveScopeHits(normalizedMessage);
  const cricketEntityHits = collectCricketEntityHits(normalizedMessage);
  const performanceIntentHits = collectPerformanceIntentHits(normalizedMessage);
  const sportsDomainHits = collectSportsDomainHits(normalizedMessage);
  const comparisonDetected =
    /\b(better|best|compare|comparison|vs|versus)\b/.test(normalizedMessage) && /\bor\b/.test(normalizedMessage);
  const followUpDetected = FOLLOW_UP_PATTERNS.some((pattern) => pattern.test(normalizedMessage));
  const replacementIntentDetected = matchesAnyPattern(normalizedMessage, REPLACEMENT_INTENT_PATTERNS);
  const tacticalPromptDetected = matchesAnyPattern(normalizedMessage, TACTICAL_QUERY_PATTERNS);
  const hasRecentTurns = Array.isArray(history) && history.length > 0;
  const hasContextSignals = hasCopilotContextSignals(snapshot);
  const contextPlayerMention = hasContextPlayerMention(normalizedMessage, snapshot);
  const hasDomainIntent = domainIntentHits.length > 0;
  const hasCricketSignal =
    hasDomainIntent ||
    allowedHits.length > 0 ||
    cricketEntityHits.length > 0 ||
    replacementIntentDetected ||
    tacticalPromptDetected ||
    contextPlayerMention;
  const hasSportsSignal = sportsDomainHits.length > 0;
  const hasLiveScopeSignal = liveScopeHits.length > 0 || replacementIntentDetected || tacticalPromptDetected;
  const hasPerformanceIntent = performanceIntentHits.length > 0;
  const greetingDetected = isGreetingMessage(normalizedMessage);
  const hasDomainSignal = hasCricketSignal || hasSportsSignal || hasPerformanceIntent || contextPlayerMention;

  if (blockedHits.length > 0 && !hasDomainSignal) {
    return {
      allowed: false,
      handling: 'blocked',
      reason: 'blocked_keyword',
      allowedHits,
      blockedHits,
      domainIntentHits,
      liveScopeHits,
      cricketEntityHits,
      performanceIntentHits,
      sportsDomainHits,
      comparisonDetected,
      followUpDetected,
      replacementIntentDetected,
      tacticalPromptDetected,
      contextPlayerMention,
    };
  }

  if (greetingDetected) {
    return {
      allowed: true,
      handling: 'greeting',
      reason: 'greeting',
      allowedHits,
      blockedHits,
      domainIntentHits,
      liveScopeHits,
      cricketEntityHits,
      performanceIntentHits,
      sportsDomainHits,
      comparisonDetected,
      followUpDetected,
      replacementIntentDetected,
      tacticalPromptDetected,
      contextPlayerMention,
    };
  }

  if (hasPerformanceIntent && (hasContextSignals || hasDomainSignal)) {
    return {
      allowed: true,
      handling: 'full',
      reason: 'player_performance_intent',
      allowedHits,
      blockedHits,
      domainIntentHits,
      liveScopeHits,
      cricketEntityHits,
      performanceIntentHits,
      sportsDomainHits,
      comparisonDetected,
      followUpDetected,
      replacementIntentDetected,
      tacticalPromptDetected,
      contextPlayerMention,
    };
  }

  if (hasLiveScopeSignal) {
    return {
      allowed: true,
      handling: 'full',
      reason: 'live_scope_keyword',
      allowedHits,
      blockedHits,
      domainIntentHits,
      liveScopeHits,
      cricketEntityHits,
      performanceIntentHits,
      sportsDomainHits,
      comparisonDetected,
      followUpDetected,
      replacementIntentDetected,
      tacticalPromptDetected,
      contextPlayerMention,
    };
  }

  if (followUpDetected && (hasRecentTurns || hasContextSignals || hasDomainSignal)) {
    return {
      allowed: true,
      handling: 'full',
      reason: 'contextual_follow_up',
      allowedHits,
      blockedHits,
      domainIntentHits,
      liveScopeHits,
      cricketEntityHits,
      performanceIntentHits,
      sportsDomainHits,
      comparisonDetected,
      followUpDetected,
      replacementIntentDetected,
      tacticalPromptDetected,
      contextPlayerMention,
    };
  }

  if (hasCricketSignal || hasSportsSignal || (comparisonDetected && cricketEntityHits.length > 0)) {
    return {
      allowed: true,
      handling: 'full',
      reason: hasSportsSignal && !hasCricketSignal ? 'sports_general' : hasPerformanceIntent ? 'cricket_performance_question' : 'cricket_general',
      allowedHits,
      blockedHits,
      domainIntentHits,
      liveScopeHits,
      cricketEntityHits,
      performanceIntentHits,
      sportsDomainHits,
      comparisonDetected,
      followUpDetected,
      replacementIntentDetected,
      tacticalPromptDetected,
      contextPlayerMention,
    };
  }

  return {
    allowed: false,
    handling: 'blocked',
    reason: 'out_of_domain',
    allowedHits,
    blockedHits,
    domainIntentHits,
    liveScopeHits,
    cricketEntityHits,
    performanceIntentHits,
    sportsDomainHits,
    comparisonDetected,
    followUpDetected,
    replacementIntentDetected,
    tacticalPromptDetected,
    contextPlayerMention,
  };
};

const buildCopilotSystemPrompt = () =>
  [
    'You are Tactical Coach AI inside the tactIQ live cricket decision-support app.',
    'Answer only within the scope of current match state, selected player fitness/workload/risk, substitutions, next-over tactics, bowling decisions, and matchup recommendations.',
    'Use provided live UI context as the source of truth for every answer, including the first user message.',
    'If the user says "he", "him", "the player", or "this bowler", resolve that to the active selected player when one exists.',
    'If the question is ambiguous and no active player exists, ask for player selection instead of guessing.',
    'Treat tactical recommendation engine output as the primary decision source for immediate rotation/substitution choices.',
    'Do not contradict an explicit recommended replacement (out/in) provided in context.',
    'If the user asks why rotation is recommended, acknowledge strengths briefly but explain why the rotation is still safer now.',
    'Keep responses concise, conversational, and coach-facing.',
    'Synthesize a fresh answer; do not paste raw recommendation blocks unless the user explicitly asks for full detail.',
    'If a question is unrelated to match/tactical context, do not answer as a general chatbot; redirect to match-related help.',
  ].join(' ');

const buildCopilotSignalSummary = (snapshot) => {
  const matchContextSnapshot = asRecord(snapshot.matchContextSnapshot);
  const matchContext = asRecord(snapshot.matchContext);
  const telemetry = asRecord(snapshot.telemetry);
  const players = asRecord(snapshot.players);
  const coachOutput = asRecord(snapshot.coachOutput);
  const tacticalRecommendation = asRecord(coachOutput.tacticalRecommendation);
  const combinedDecision = asRecord(coachOutput.combinedDecision);
  const tacticalState = resolveTacticalRecommendationState(snapshot);

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
    `recommendedOut=${toText(tacticalState.recommendedReplacementPlayer, 'n/a')}`,
    `recommendedIn=${toText(tacticalState.recommendedIncomingPlayer, 'n/a')}`,
    `recommendedMove=${toText(tacticalState.recommendedMove, 'n/a')}`,
    `recommendationConfidence=${toText(tacticalState.confidence, 'n/a')}`,
  ];

  return lines.join('\n');
};

const readOptionalNumber = (value, digits = 1) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return '';
  return Number(parsed.toFixed(digits)).toString();
};

const collectRosterMetrics = (snapshot) => {
  const players = asRecord(snapshot.players);
  const snapshotPlayers = asRecord(asRecord(snapshot.matchContextSnapshot).players);
  const sources = [players.rosterMetrics, snapshotPlayers.rosterMetrics];
  const seen = new Set();
  const rows = [];
  for (const source of sources) {
    if (!Array.isArray(source)) continue;
    for (const entry of source) {
      const record = asRecord(entry);
      const id = toText(record.id);
      const name = toText(record.name, record.playerName);
      const dedupeKey = toText(id, name).toLowerCase();
      if (!dedupeKey || seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      rows.push(record);
    }
  }
  return rows;
};

const buildCopilotContextBlock = (snapshot) => {
  const matchContext = asRecord(snapshot.matchContext);
  const snapshotContext = asRecord(asRecord(snapshot.matchContextSnapshot).matchContext);
  const players = asRecord(snapshot.players);
  const snapshotPlayers = asRecord(asRecord(snapshot.matchContextSnapshot).players);
  const telemetry = asRecord(snapshot.telemetry);
  const coachOutput = asRecord(snapshot.coachOutput);
  const tacticalRecommendation = asRecord(coachOutput.tacticalRecommendation);
  const combinedDecision = asRecord(coachOutput.combinedDecision);

  const scoreRuns = toText(matchContext.scoreRuns, matchContext.score, snapshotContext.scoreRuns, snapshotContext.score, 'n/a');
  const wickets = toText(matchContext.wickets, matchContext.wicketsInHand, snapshotContext.wickets, snapshotContext.wicketsInHand, 'n/a');
  const overs = toText(matchContext.overs, snapshotContext.overs);
  const ballsBowled = readOptionalNumber(matchContext.ballsBowled, 0) || readOptionalNumber(snapshotContext.ballsBowled, 0);
  const overDisplay = overs || (ballsBowled ? `${Math.floor(Number(ballsBowled) / 6)}.${Number(ballsBowled) % 6}` : 'n/a');
  const selectedBatter = toText(players.selectedBatter, snapshotPlayers.selectedBatter, players.striker, snapshotPlayers.striker, 'unknown');
  const selectedBowler = toText(
    players.selectedBowler,
    snapshotPlayers.selectedBowler,
    players.bowler,
    snapshotPlayers.bowler,
    telemetry.playerName,
    'unknown'
  );

  const rosterRows = collectRosterMetrics(snapshot);
  const playerLines = rosterRows.length > 0
    ? rosterRows.map((row) => {
        const name = toText(row.name, row.playerName, 'Player');
        const segments = [];
        const role = toText(row.role);
        if (role) segments.push(`role=${role}`);
        const fatigue = readOptionalNumber(row.fatigueIndex, 1);
        const fatigueLimit = readOptionalNumber(row.fatigueLimit, 1);
        if (fatigue || fatigueLimit) {
          segments.push(`fatigue=${fatigue || 'n/a'}/${fatigueLimit || 'n/a'}`);
        }
        const sleepHours = readOptionalNumber(row.sleepHours, 1);
        if (sleepHours) segments.push(`sleep=${sleepHours}h`);
        const recoveryMinutes = readOptionalNumber(row.recoveryMinutes, 0);
        if (recoveryMinutes) segments.push(`recovery=${recoveryMinutes}m`);
        const hr = toText(row.heartRateRecovery);
        if (hr) segments.push(`hr=${hr}`);
        const control = readOptionalNumber(row.control, 1);
        if (control) segments.push(`control=${control}`);
        const speed = readOptionalNumber(row.speed, 1);
        if (speed) segments.push(`speed=${speed}`);
        const power = readOptionalNumber(row.power, 1);
        if (power) segments.push(`power=${power}`);
        const injury = toText(row.injuryRisk);
        if (injury) segments.push(`injuryRisk=${injury}`);
        const noBall = toText(row.noBallRisk);
        if (noBall) segments.push(`noBallRisk=${noBall}`);
        const unavailable = Boolean(row.isUnfit) || Boolean(row.isInjured) || Boolean(row.isSub);
        if (unavailable) segments.push('available=false');
        return `- ${name}: ${segments.join(', ') || 'metrics unavailable'}`;
      })
      : ['- None'];

  const latestRecommendation = toText(
    tacticalRecommendation.nextAction,
    tacticalRecommendation.primary,
    combinedDecision.immediateAction,
    coachOutput.combinedBriefing,
    'None'
  );
  const latestRationale = toText(
    tacticalRecommendation.why,
    combinedDecision.rationale,
    coachOutput.summary,
    'None'
  );
  const tacticalState = resolveTacticalRecommendationState(snapshot);

  return [
    'MATCH STATE',
    `- Score: ${scoreRuns}/${wickets}`,
    `- Overs: ${overDisplay}`,
    `- Target: ${toText(matchContext.target, snapshotContext.target, 'n/a')}`,
    `- Phase: ${toText(matchContext.phase, snapshotContext.phase, 'n/a')}`,
    `- Format: ${toText(matchContext.format, snapshotContext.format, 'n/a')}`,
    `- Mode: ${toText(matchContext.matchMode, snapshotContext.matchMode, 'n/a')}`,
    `- Intensity: ${toText(matchContext.intensity, snapshotContext.intensity, 'n/a')}`,
    `- Weather: ${toText(matchContext.weather, snapshotContext.weather, 'n/a')}`,
    `- Current RR: ${toText(matchContext.currentRunRate, snapshotContext.currentRunRate, 'n/a')}`,
    `- Required RR: ${toText(matchContext.requiredRunRate, snapshotContext.requiredRunRate, 'n/a')}`,
    `- Balls remaining: ${toText(matchContext.ballsRemaining, snapshotContext.ballsRemaining, 'n/a')}`,
    `- Situation: ${toText(matchContext.currentSituation, snapshotContext.currentSituation, 'n/a')}`,
    '',
    'SELECTED PLAYERS',
    `- Batter: ${selectedBatter}`,
    `- Bowler: ${selectedBowler}`,
    '',
    'PLAYER BASELINES',
    ...playerLines,
    '',
    'COACH CONTEXT',
    `- Latest recommendation: ${latestRecommendation}`,
    `- Latest rationale: ${latestRationale}`,
    `- Agents run: ${toText(
      asArray(coachOutput.agentsRun).map((entry) => String(entry || '').trim().toUpperCase()).join(', '),
      'n/a'
    )}`,
    `- Routing mode: ${toText(coachOutput.routingMode, 'n/a')}`,
    `- LLM mode: ${toText(coachOutput.llmMode, 'n/a')}`,
    '',
    'TACTICAL RECOMMENDATION STATE',
    `- recommendedOutgoingPlayer: ${toText(tacticalState.recommendedOutgoingPlayer, tacticalState.recommendedReplacementPlayer, 'n/a')}`,
    `- recommendedReplacementPlayer: ${toText(tacticalState.recommendedReplacementPlayer, 'n/a')}`,
    `- recommendedIncomingPlayer: ${toText(tacticalState.recommendedIncomingPlayer, 'n/a')}`,
    `- recommendedMove: ${toText(tacticalState.recommendedMove, 'n/a')}`,
    `- tacticalPlan: ${toText(tacticalState.tacticalPlan, 'n/a')}`,
    `- assessment: ${toText(tacticalState.assessment, 'n/a')}`,
    `- whyThisIsSmart: ${toText(tacticalState.whyThisIsSmart, 'n/a')}`,
    `- riskIfIgnored: ${toText(tacticalState.riskIfIgnored, 'n/a')}`,
    `- matchSituation: ${toText(tacticalState.matchSituation, 'n/a')}`,
    `- priority: ${toText(tacticalState.priority, 'n/a')}`,
    `- reason: ${toText(tacticalState.reason, 'n/a')}`,
    `- fatigueIndex: ${toText(tacticalState.fatigueIndex, 'n/a')}`,
    `- riskLevel: ${toText(tacticalState.riskLevel, 'n/a')}`,
    `- confidence: ${toText(tacticalState.confidence, 'n/a')}`,
  ].join('\n');
};

const cleanPlayerName = (value) =>
  String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/^[^a-z0-9]+|[^a-z0-9. ]+$/gi, '')
    .trim();

const sanitizeSwapName = (value) =>
  cleanPlayerName(value)
    .replace(/\b(?:next|this|following|coming)\s+over.*$/i, '')
    .replace(/\b(?:for|to|because|based on|if)\b.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();

const extractSwapFromText = (text) => {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return { out: '', in: '' };

  const patterns = [
    {
      re: /\bbring in\s+([^,!?;]+?)\s+for\s+([^,!?;]+?)(?:\s+(?:next|this|following|coming)\s+over\b|[,!?;]|$)/i,
      parse: (match) => ({ in: match[1], out: match[2] }),
    },
    {
      re: /\breplace\s+([^,!?;]+?)\s+with\s+([^,!?;]+?)(?:\s+(?:next|this|following|coming)\s+over\b|[,!?;]|$)/i,
      parse: (match) => ({ out: match[1], in: match[2] }),
    },
    {
      re: /\bswap\s+(?:out\s+)?([^,!?;]+?)\s+(?:for|with)\s+([^,!?;]+?)(?:\s+(?:next|this|following|coming)\s+over\b|[,!?;]|$)/i,
      parse: (match) => ({ out: match[1], in: match[2] }),
    },
    {
      re: /\b([a-z][a-z.\s'-]{1,40})\s+for\s+([a-z][a-z.\s'-]{1,40})(?:\s+(?:next|this|following|coming)\s+over\b|[,!?;]|$)/i,
      parse: (match) => ({ in: match[1], out: match[2] }),
    },
  ];

  for (const entry of patterns) {
    const match = normalized.match(entry.re);
    if (!match) continue;
    const parsed = entry.parse(match);
    const out = sanitizeSwapName(parsed.out);
    const incoming = sanitizeSwapName(parsed.in);
    if (!out || !incoming) continue;
    if (normalizeForKeywordMatch(out) === normalizeForKeywordMatch(incoming)) continue;
    return { out, in: incoming };
  }

  return { out: '', in: '' };
};

const resolveReplacementSuggestion = (tacticalRecommendation, combinedDecision, coachOutput) => {
  const structuredCandidates = [
    asRecord(tacticalRecommendation.swap),
    asRecord(tacticalRecommendation.substitutionAdvice),
    asRecord(combinedDecision.substitutionAdvice),
    asRecord(coachOutput.substitutionAdvice),
  ];

  for (const candidate of structuredCandidates) {
    const out = cleanPlayerName(candidate.out);
    const incoming = cleanPlayerName(candidate.in);
    if (out && incoming && normalizeForKeywordMatch(out) !== normalizeForKeywordMatch(incoming)) {
      return {
        out,
        in: incoming,
        reason: toText(candidate.reason),
      };
    }
  }

  const textCandidates = [
    toText(tacticalRecommendation.nextAction),
    toText(tacticalRecommendation.primary),
    toText(combinedDecision.immediateAction),
    toText(coachOutput.summary),
    toText(coachOutput.combinedBriefing),
  ];

  for (const line of textCandidates) {
    const parsed = extractSwapFromText(line);
    if (parsed.in && parsed.out) {
      return {
        out: parsed.out,
        in: parsed.in,
        reason: '',
      };
    }
  }

  return { out: '', in: '', reason: '' };
};

const resolveMentionedPlayerName = (question, names) => {
  const normalizedQuestion = normalizeForKeywordMatch(question);
  const compactQuestion = compactForKeywordMatch(question);
  for (const name of names) {
    const normalizedName = normalizeForKeywordMatch(name);
    if (!normalizedName || normalizedName.length < 3) continue;
    if (normalizedQuestion.includes(normalizedName)) return name;
    const compactName = normalizedName.replace(/\s+/g, '');
    if (compactName.length >= 3 && compactQuestion.includes(compactName)) return name;
  }
  return '';
};

const collectAvailableContextPlayerNames = (snapshot) => {
  const players = asRecord(snapshot.players);
  const snapshotPlayers = asRecord(asRecord(snapshot.matchContextSnapshot).players);
  const matchContext = asRecord(snapshot.matchContext);
  const snapshotMatchContext = asRecord(asRecord(snapshot.matchContextSnapshot).matchContext);
  const names = [];
  const seen = new Set();

  const pushName = (...values) => {
    for (const value of values) {
      const normalized = cleanPlayerName(value);
      const key = normalizeForKeywordMatch(normalized);
      if (!key || key.length < 2 || seen.has(key)) continue;
      seen.add(key);
      names.push(normalized);
    }
  };

  const ingestNameList = (source) => {
    if (!Array.isArray(source)) return;
    for (const entry of source) {
      if (typeof entry === 'string') {
        pushName(entry);
        continue;
      }
      const record = asRecord(entry);
      pushName(record.name, record.playerName, record.displayName);
    }
  };

  const rosterRows = collectRosterMetrics(snapshot);
  for (const row of rosterRows) {
    pushName(row.name, row.playerName, row.displayName);
  }

  ingestNameList(players.bench);
  ingestNameList(snapshotPlayers.bench);
  ingestNameList(matchContext.bench);
  ingestNameList(snapshotMatchContext.bench);

  const snapshotNames = collectSnapshotPlayerNames(snapshot);
  for (const name of snapshotNames) {
    pushName(name);
  }

  return names;
};

const PLAYER_REFERENCE_EXTRACT_PATTERNS = [
  /\bwho\s+(?:should|do)\s+i\s+change\s+([a-z][a-z.'-]*(?:\s+[a-z][a-z.'-]*){0,2})\s+with\b/i,
  /\bwho\s+should\s+replace\s+([a-z][a-z.'-]*(?:\s+[a-z][a-z.'-]*){0,2})\b/i,
  /\breplace\s+([a-z][a-z.'-]*(?:\s+[a-z][a-z.'-]*){0,2})\s+with\s+([a-z][a-z.'-]*(?:\s+[a-z][a-z.'-]*){0,2})\b/i,
  /\bchange\s+([a-z][a-z.'-]*(?:\s+[a-z][a-z.'-]*){0,2})\s+with\s+([a-z][a-z.'-]*(?:\s+[a-z][a-z.'-]*){0,2})\b/i,
  /\bswap\s+(?:out\s+)?([a-z][a-z.'-]*(?:\s+[a-z][a-z.'-]*){0,2})\s+(?:for|with)\s+([a-z][a-z.'-]*(?:\s+[a-z][a-z.'-]*){0,2})\b/i,
  /\bbring\s+(?:in\s+)?([a-z][a-z.'-]*(?:\s+[a-z][a-z.'-]*){0,2})\s+for\s+([a-z][a-z.'-]*(?:\s+[a-z][a-z.'-]*){0,2})\b/i,
  /\bbring\s+([a-z][a-z.'-]*(?:\s+[a-z][a-z.'-]*){0,2})\s+to\s+(?:bowl|bat)\b/i,
  /\bsub(?:stitute)?\s+(?:in\s+)?([a-z][a-z.'-]*(?:\s+[a-z][a-z.'-]*){0,2})\b/i,
  /\bswitch\s+to\s+([a-z][a-z.'-]*(?:\s+[a-z][a-z.'-]*){0,2})\b/i,
  /\b(?:continue|keep|stick)\s+with\s+([a-z][a-z.'-]*(?:\s+[a-z][a-z.'-]*){0,2})\b/i,
  /\btake\s+([a-z][a-z.'-]*(?:\s+[a-z][a-z.'-]*){0,2})\s+off\b/i,
  /\b([a-z][a-z.'-]*(?:\s+[a-z][a-z.'-]*){0,2})\s+vs\.?\s+([a-z][a-z.'-]*(?:\s+[a-z][a-z.'-]*){0,2})\b/i,
];

const INVALID_PLAYER_MENTION_TOKENS = new Set([
  'bowler',
  'batter',
  'batters',
  'batsman',
  'batsmen',
  'player',
  'players',
  'spinner',
  'spinners',
  'pacer',
  'pacers',
  'seamer',
  'seamers',
  'allrounder',
  'all rounder',
  'match',
  'team',
  'squad',
  'bench',
  'over',
  'overs',
  'phase',
  'plan',
  'risk',
  'fatigue',
  'workload',
  'injury',
  'control',
  'pressure',
  'option',
  'options',
  'current',
  'he',
  'him',
  'his',
  'her',
  'hers',
  'they',
  'them',
  'their',
  'next',
  'this',
  'following',
  'coming',
]);

const sanitizeMentionCandidate = (value) => {
  const cleaned = sanitizeSwapName(value);
  if (!cleaned) return '';
  const normalized = normalizeForKeywordMatch(cleaned);
  if (!normalized) return '';
  if (INVALID_PLAYER_MENTION_TOKENS.has(normalized)) return '';
  if (normalized.split(' ').every((token) => INVALID_PLAYER_MENTION_TOKENS.has(token))) return '';
  return cleaned;
};

const extractLikelyPlayerReferences = (message) => {
  const rawText = String(message || '').trim();
  if (!rawText) return [];
  const mentions = [];
  const seen = new Set();

  const pushMention = (value) => {
    const cleaned = sanitizeMentionCandidate(value);
    if (!cleaned) return;
    const key = normalizeForKeywordMatch(cleaned);
    if (!key || key.length < 3 || seen.has(key)) return;
    seen.add(key);
    mentions.push(cleaned);
  };

  const parsedSwap = extractSwapFromText(rawText);
  pushMention(parsedSwap.out);
  pushMention(parsedSwap.in);

  for (const basePattern of PLAYER_REFERENCE_EXTRACT_PATTERNS) {
    const flags = basePattern.flags.includes('g') ? basePattern.flags : `${basePattern.flags}g`;
    const pattern = new RegExp(basePattern.source, flags);
    let match;
    while ((match = pattern.exec(rawText)) !== null) {
      for (let index = 1; index < match.length; index += 1) {
        pushMention(match[index]);
      }
      if (pattern.lastIndex === match.index) {
        pattern.lastIndex += 1;
      }
    }
  }

  return mentions;
};

const resolveReferencedPlayerMatch = (mention, availableNames) => {
  const normalizedMention = normalizeForKeywordMatch(mention);
  const compactMention = compactForKeywordMatch(mention);
  if (!normalizedMention) return '';

  for (const name of availableNames) {
    const normalizedName = normalizeForKeywordMatch(name);
    if (!normalizedName) continue;
    if (normalizedName === normalizedMention) return name;
  }

  for (const name of availableNames) {
    const compactName = compactForKeywordMatch(name);
    if (!compactName || !compactMention) continue;
    if (compactName === compactMention) return name;
  }

  const mentionTokens = normalizedMention.split(' ').filter(Boolean);
  if (mentionTokens.length === 1 && mentionTokens[0].length >= 3) {
    const token = mentionTokens[0];
    for (const name of availableNames) {
      const normalizedName = normalizeForKeywordMatch(name);
      if (!normalizedName) continue;
      const nameTokens = normalizedName.split(' ').filter(Boolean);
      if (nameTokens.includes(token) || nameTokens[nameTokens.length - 1] === token) return name;
    }
  }

  if (mentionTokens.length >= 2) {
    const mentionFirst = mentionTokens[0];
    const mentionLast = mentionTokens[mentionTokens.length - 1];
    for (const name of availableNames) {
      const normalizedName = normalizeForKeywordMatch(name);
      if (!normalizedName) continue;
      const nameTokens = normalizedName.split(' ').filter(Boolean);
      const nameFirst = nameTokens[0] || '';
      const nameLast = nameTokens[nameTokens.length - 1] || '';
      const firstMatches =
        mentionFirst === nameFirst ||
        (mentionFirst.length === 1 && nameFirst.startsWith(mentionFirst)) ||
        (nameFirst.length === 1 && mentionFirst.startsWith(nameFirst));
      if (mentionLast.length >= 3 && mentionLast === nameLast && firstMatches) {
        return name;
      }
    }
  }

  for (const name of availableNames) {
    const normalizedName = normalizeForKeywordMatch(name);
    if (!normalizedName || normalizedName.length < 4 || normalizedMention.length < 4) continue;
    if (normalizedName.includes(normalizedMention) || normalizedMention.includes(normalizedName)) {
      return name;
    }
  }

  return '';
};

const computeEditDistance = (leftValue, rightValue) => {
  const left = String(leftValue || '');
  const right = String(rightValue || '');
  if (!left) return right.length;
  if (!right) return left.length;
  const rows = left.length + 1;
  const cols = right.length + 1;
  const table = Array.from({ length: rows }, () => Array(cols).fill(0));
  for (let row = 0; row < rows; row += 1) table[row][0] = row;
  for (let col = 0; col < cols; col += 1) table[0][col] = col;
  for (let row = 1; row < rows; row += 1) {
    for (let col = 1; col < cols; col += 1) {
      const substitutionCost = left[row - 1] === right[col - 1] ? 0 : 1;
      table[row][col] = Math.min(
        table[row - 1][col] + 1,
        table[row][col - 1] + 1,
        table[row - 1][col - 1] + substitutionCost
      );
    }
  }
  return table[rows - 1][cols - 1];
};

const resolveClosestPlayerSuggestion = (mention, availableNames) => {
  if (!Array.isArray(availableNames) || availableNames.length === 0) return '';
  const normalizedMention = normalizeForKeywordMatch(mention);
  if (!normalizedMention) return '';

  const mentionTokens = normalizedMention.split(' ').filter(Boolean);
  const mentionLast = mentionTokens[mentionTokens.length - 1] || '';
  if (mentionLast.length >= 3) {
    const surnameMatches = availableNames.filter((candidate) => {
      const tokens = normalizeForKeywordMatch(candidate).split(' ').filter(Boolean);
      return tokens[tokens.length - 1] === mentionLast;
    });
    if (surnameMatches.length === 1) return surnameMatches[0];
    if (surnameMatches.length > 1 && mentionTokens[0]) {
      const mentionFirst = mentionTokens[0];
      const initialMatch = surnameMatches.find((candidate) => {
        const firstToken = normalizeForKeywordMatch(candidate).split(' ').filter(Boolean)[0] || '';
        return firstToken.startsWith(mentionFirst.charAt(0));
      });
      if (initialMatch) return initialMatch;
    }
  }

  let bestCandidate = '';
  let bestDistance = Number.POSITIVE_INFINITY;
  const compactMention = compactForKeywordMatch(mention);
  for (const candidate of availableNames) {
    const compactCandidate = compactForKeywordMatch(candidate);
    if (!compactCandidate) continue;
    const distance = computeEditDistance(compactMention, compactCandidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestCandidate = candidate;
    }
  }

  if (!bestCandidate) return '';
  const maxLength = Math.max(compactMention.length, compactForKeywordMatch(bestCandidate).length);
  const threshold = Math.max(1, Math.floor(maxLength * 0.4));
  return bestDistance <= threshold ? bestCandidate : '';
};

const shouldValidatePlayerReferences = (message, domain) => {
  const normalizedMessage = normalizeForKeywordMatch(message);
  if (!normalizedMessage) return false;
  const liveScopeHits = Array.isArray(domain.liveScopeHits) ? domain.liveScopeHits : [];
  if (domain.replacementIntentDetected || domain.tacticalPromptDetected || liveScopeHits.length > 0) {
    return true;
  }
  return /\b(?:bring|replace|change|swap|sub(?:stitute)?|switch|rotate|take|continue|keep|rest)\b/.test(
    normalizedMessage
  );
};

const validatePlayerReferencesForMatchContext = (message, snapshot, domain) => {
  if (!shouldValidatePlayerReferences(message, domain)) {
    return { hasUnknownPlayers: false, unknownPlayers: [] };
  }

  const availableNames = collectAvailableContextPlayerNames(snapshot);
  if (availableNames.length === 0) {
    return { hasUnknownPlayers: false, unknownPlayers: [] };
  }

  const mentions = extractLikelyPlayerReferences(message);
  if (mentions.length === 0) {
    return { hasUnknownPlayers: false, unknownPlayers: [] };
  }

  const unknownPlayers = [];
  for (const mention of mentions) {
    const matchedPlayer = resolveReferencedPlayerMatch(mention, availableNames);
    if (matchedPlayer) continue;
    unknownPlayers.push({
      mention,
      suggestion: resolveClosestPlayerSuggestion(mention, availableNames),
    });
  }

  return {
    hasUnknownPlayers: unknownPlayers.length > 0,
    unknownPlayers,
    mentions,
    availableNames,
  };
};

const AMBIGUOUS_PLAYER_REFERENCE_PATTERNS = [
  /\bthe player\b/,
  /\bthis player\b/,
  /\bthat player\b/,
  /\bthis bowler\b/,
  /\bthat bowler\b/,
  /\bcurrent player\b/,
  /\bcurrent bowler\b/,
  /\bis he\b/,
  /\bis him\b/,
  /\bshould he\b/,
  /\bcan he continue\b/,
  /\bshould i rotate him\b/,
  /\bcan him continue\b/,
];

const AMBIGUOUS_PLAYER_INTENT_PATTERNS = [
  /\b(?:continue|bowl|bat|replace|change|swap|sub(?:stitute)?|switch|rotate|rest|remove|assess|evaluate)\b/,
  /\b(?:unfit|fit|injur|risk|fatigue|strain|recovery|workload|availability)\b/,
  /\b(?:next over|next bowler|spell)\b/,
];

const normalizeRiskToken = (value) => {
  const token = String(value || '').trim().toUpperCase();
  if (token === 'CRITICAL') return 'CRITICAL';
  if (token === 'HIGH') return 'HIGH';
  if (token === 'MED' || token === 'MEDIUM') return 'MEDIUM';
  if (token === 'LOW') return 'LOW';
  return '';
};

const deriveFlaggedPlayerState = (row) => {
  const availabilityToken = String(toText(row.availabilityStatus, row.status, row.markedFitStatus) || '').trim().toUpperCase();
  const isUnfit = Boolean(row.isUnfit) || Boolean(row.isInjured) || availabilityToken === 'UNFIT';
  if (isUnfit) return { bucket: 'unfit', status: 'unfit' };

  const injuryRisk = normalizeRiskToken(row.injuryRisk);
  if (injuryRisk === 'CRITICAL') return { bucket: 'critical', status: 'critical injury risk' };

  const substitutionRequired = Boolean(row.substitutionRequired);
  if (substitutionRequired || availabilityToken === 'UNAVAILABLE') {
    return { bucket: 'limited', status: 'substitution required' };
  }

  const fatigue = Number(row.fatigueIndex);
  const fatigueLimit = Number(row.fatigueLimit);
  const strain = Number(row.strainIndex);
  const hasElevatedWorkload =
    availabilityToken === 'LIMITED' ||
    availabilityToken === 'TACTICAL_RISK' ||
    (Number.isFinite(fatigue) && Number.isFinite(fatigueLimit) && fatigueLimit > 0 && fatigue >= fatigueLimit) ||
    (Number.isFinite(strain) && strain >= 7);
  if (hasElevatedWorkload) return { bucket: 'limited', status: 'elevated workload' };

  return null;
};

const buildPlayerReferenceResolutionContext = (snapshot) => {
  const telemetry = asRecord(snapshot.telemetry);
  const players = asRecord(snapshot.players);
  const snapshotPlayers = asRecord(asRecord(snapshot.matchContextSnapshot).players);
  const rosterRows = collectRosterMetrics(snapshot);

  const selectedPlayerId = toText(telemetry.playerId, telemetry.id);
  const selectedPlayerNameHint = toText(
    telemetry.playerName,
    players.selectedBowler,
    snapshotPlayers.selectedBowler,
    players.selectedBatter,
    snapshotPlayers.selectedBatter,
    players.bowler,
    snapshotPlayers.bowler,
    players.striker,
    snapshotPlayers.striker
  );

  let activeRow = rosterRows.find((entry) => asRecord(entry).active === true);
  if (!activeRow && selectedPlayerId) {
    activeRow = rosterRows.find((entry) => toText(asRecord(entry).id) === selectedPlayerId);
  }
  if (!activeRow && selectedPlayerNameHint) {
    const selectedNameToken = normalizeForKeywordMatch(selectedPlayerNameHint);
    activeRow = rosterRows.find(
      (entry) => normalizeForKeywordMatch(toText(asRecord(entry).name, asRecord(entry).playerName)) === selectedNameToken
    );
  }

  const activeName = toText(asRecord(activeRow).name, asRecord(activeRow).playerName, selectedPlayerNameHint);
  const activeId = toText(asRecord(activeRow).id, selectedPlayerId);

  const flaggedPlayers = [];
  const unfitPlayers = [];
  const criticalPlayers = [];
  const limitedPlayers = [];
  const seen = new Set();
  for (const row of rosterRows) {
    const record = asRecord(row);
    const name = toText(record.name, record.playerName);
    if (!name) continue;
    const key = normalizeForKeywordMatch(name);
    if (!key || seen.has(key)) continue;

    const flaggedState = deriveFlaggedPlayerState(record);
    if (!flaggedState) continue;

    const playerFlag = {
      name,
      status: flaggedState.status,
      id: toText(record.id),
    };
    flaggedPlayers.push(playerFlag);
    seen.add(key);
    if (flaggedState.bucket === 'unfit') unfitPlayers.push(playerFlag);
    if (flaggedState.bucket === 'critical') criticalPlayers.push(playerFlag);
    if (flaggedState.bucket === 'limited') limitedPlayers.push(playerFlag);
  }

  return {
    activePlayer: activeName
      ? {
          id: activeId,
          name: activeName,
        }
      : null,
    selectedPlayerId: activeId,
    flaggedPlayers,
    unfitPlayers,
    criticalPlayers,
    limitedPlayers,
  };
};

const hasAmbiguousPlayerReference = (message, snapshot, domain) => {
  const normalizedMessage = normalizeForKeywordMatch(message);
  if (!normalizedMessage) return false;
  const hasExplicitNameMention = hasContextPlayerMention(message, snapshot);
  if (hasExplicitNameMention) return false;

  const hasNamedMentions = extractLikelyPlayerReferences(message).length > 0;
  if (hasNamedMentions) return false;

  const hasAmbiguousCue = AMBIGUOUS_PLAYER_REFERENCE_PATTERNS.some((pattern) => pattern.test(normalizedMessage))
    || /\b(?:he|him|his)\b/.test(normalizedMessage);
  if (!hasAmbiguousCue) return false;

  const liveScopeHits = Array.isArray(domain?.liveScopeHits) ? domain.liveScopeHits : [];
  const hasDomainIntent =
    Boolean(domain?.replacementIntentDetected) ||
    Boolean(domain?.tacticalPromptDetected) ||
    liveScopeHits.length > 0 ||
    AMBIGUOUS_PLAYER_INTENT_PATTERNS.some((pattern) => pattern.test(normalizedMessage));

  return hasDomainIntent;
};

const formatFlaggedPlayerCandidates = (players) => {
  const labels = asArray(players)
    .map((entry) => {
      const record = asRecord(entry);
      const name = toText(record.name);
      const status = toText(record.status);
      if (!name) return '';
      return status ? `${name} (${status})` : name;
    })
    .filter(Boolean)
    .slice(0, 4);
  if (labels.length === 0) return '';
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`;
};

const buildResolvedPlayerPrompt = (message, playerName) => {
  const baseMessage = String(message || '').trim();
  const resolvedName = toText(playerName);
  if (!baseMessage || !resolvedName) return baseMessage;
  const normalizedMessage = normalizeForKeywordMatch(baseMessage);
  const normalizedName = normalizeForKeywordMatch(resolvedName);
  if (normalizedName && normalizedMessage.includes(normalizedName)) {
    return baseMessage;
  }
  return `${baseMessage}\n\nResolved player reference: ${resolvedName}.`;
};

const applyResolutionAssumptionToReply = (reply, resolution) => {
  const baseReply = String(reply || '').trim();
  if (!baseReply) return baseReply;
  const assumptionPrefix = toText(resolution?.assumptionPrefix);
  if (!assumptionPrefix) return baseReply;
  const normalizedReply = normalizeForKeywordMatch(baseReply);
  const normalizedPrefix = normalizeForKeywordMatch(assumptionPrefix);
  if (normalizedPrefix && normalizedReply.startsWith(normalizedPrefix)) return baseReply;
  return `${assumptionPrefix} ${baseReply}`.trim();
};

const resolveAmbiguousPlayerReference = (message, snapshot, domain) => {
  const resolutionContext = buildPlayerReferenceResolutionContext(snapshot);
  if (!hasAmbiguousPlayerReference(message, snapshot, domain)) {
    return {
      applies: false,
      context: resolutionContext,
    };
  }

  const activePlayerName = toText(asRecord(resolutionContext.activePlayer).name);
  if (activePlayerName) {
    return {
      applies: true,
      resolvedPlayerName: activePlayerName,
      resolutionSource: 'active_selected_player',
      context: resolutionContext,
    };
  }

  const flaggedPlayers = asArray(resolutionContext.flaggedPlayers);
  if (flaggedPlayers.length === 1) {
    const candidate = asRecord(flaggedPlayers[0]);
    const candidateName = toText(candidate.name);
    if (candidateName) {
      return {
        applies: true,
        resolvedPlayerName: candidateName,
        resolutionSource: 'single_flagged_player',
        assumptionPrefix: `If you mean ${candidateName},`,
        context: resolutionContext,
      };
    }
  }

  if (flaggedPlayers.length > 1) {
    const candidateSummary = formatFlaggedPlayerCandidates(flaggedPlayers);
    return {
      applies: true,
      needsClarification: true,
      clarificationReply: candidateSummary
        ? `I see multiple flagged players right now: ${candidateSummary}. Which player should I assess?`
        : NO_ACTIVE_PLAYER_REPLY,
      resolutionSource: 'multiple_flagged_players',
      context: resolutionContext,
    };
  }

  return {
    applies: true,
    needsClarification: true,
    clarificationReply: NO_ACTIVE_PLAYER_REPLY,
    resolutionSource: 'no_resolution_candidate',
    context: resolutionContext,
  };
};

const HISTORICAL_TRIVIA_PATTERNS = [
  /\bwho\s+won\b/,
  /\bwhen\s+did\b/,
  /\bwhat\s+happened\s+in\b/,
  /\bworld\s+cup\b.*\b(?:19|20)\d{2}\b/,
  /\b(?:19|20)\d{2}\b.*\bworld\s+cup\b/,
];

const isHistoricalTriviaQuestion = (normalizedMessage) => {
  if (!normalizedMessage) return false;
  return HISTORICAL_TRIVIA_PATTERNS.some((pattern) => pattern.test(normalizedMessage));
};

const classifyMessageIntentBucket = (message, domain, playerResolution) => {
  const normalizedMessage = normalizeForKeywordMatch(message);
  if (!normalizedMessage) return 'OFF_TOPIC';

  const liveScopeHits = Array.isArray(domain.liveScopeHits) ? domain.liveScopeHits : [];
  const cricketEntityHits = Array.isArray(domain.cricketEntityHits) ? domain.cricketEntityHits : [];
  const performanceIntentHits = Array.isArray(domain.performanceIntentHits) ? domain.performanceIntentHits : [];
  const tacticalSignal =
    Boolean(domain.replacementIntentDetected) ||
    Boolean(domain.tacticalPromptDetected) ||
    Boolean(domain.contextPlayerMention) ||
    liveScopeHits.length > 0 ||
    performanceIntentHits.length > 0 ||
    cricketEntityHits.length > 0;

  if (isHistoricalTriviaQuestion(normalizedMessage)) {
    return 'OFF_TOPIC';
  }

  if (domain.handling === 'blocked' && !playerResolution.applies) {
    return 'OFF_TOPIC';
  }

  if (
    playerResolution.applies &&
    (Boolean(playerResolution.resolvedPlayerName) || Boolean(playerResolution.needsClarification))
  ) {
    return 'AMBIGUOUS_BUT_POSSIBLY_MATCH_RELATED';
  }

  if (tacticalSignal || domain.handling === 'full' || domain.handling === 'domain_redirect') {
    return 'MATCH_RELATED';
  }

  return 'OFF_TOPIC';
};

const buildActivePlayerGroundingContext = (snapshot, tacticalState) => {
  const telemetry = asRecord(snapshot.telemetry);
  const players = asRecord(snapshot.players);
  const snapshotPlayers = asRecord(asRecord(snapshot.matchContextSnapshot).players);
  const matchContext = asRecord(snapshot.matchContext);
  const snapshotContext = asRecord(asRecord(snapshot.matchContextSnapshot).matchContext);

  const activePlayerName = toText(
    telemetry.playerName,
    players.selectedBowler,
    snapshotPlayers.selectedBowler,
    players.selectedBatter,
    snapshotPlayers.selectedBatter,
    players.bowler,
    snapshotPlayers.bowler
  );
  const activePlayerRole = toText(telemetry.role, 'unknown');
  const activePlayerStatus = toText(
    telemetry.availabilityStatus,
    telemetry.markedFitStatus,
    telemetry.status,
    Boolean(telemetry.isUnfit) || normalizeRiskToken(telemetry.injuryRisk) === 'CRITICAL' ? 'UNFIT' : 'AVAILABLE'
  );

  const currentRecommendation = toText(
    tacticalState.recommendedMove,
    tacticalState.tacticalPlan,
    tacticalState.reason,
    'n/a'
  );

  const lines = [
    `activePlayerName=${toText(activePlayerName, 'n/a')}`,
    `activePlayerRole=${toText(activePlayerRole, 'n/a')}`,
    `activePlayerStatus=${toText(activePlayerStatus, 'n/a')}`,
    `oversBowled=${toText(telemetry.oversBowled, 'n/a')}`,
    `fatigueIndex=${toText(telemetry.fatigueIndex, 'n/a')}`,
    `injuryRisk=${toText(telemetry.injuryRisk, 'n/a')}`,
    `recoveryStatus=${toText(telemetry.heartRateRecovery, 'n/a')}`,
    `controlRisk=${toText(telemetry.noBallRisk, telemetry.controlRisk, 'n/a')}`,
    `currentRecommendation=${currentRecommendation}`,
    `score=${toText(matchContext.scoreRuns, matchContext.score, snapshotContext.scoreRuns, snapshotContext.score, 'n/a')}`,
    `wickets=${toText(matchContext.wickets, snapshotContext.wickets, 'n/a')}`,
    `target=${toText(matchContext.target, snapshotContext.target, 'n/a')}`,
    `over=${toText(matchContext.overs, snapshotContext.overs, 'n/a')}`,
    `phase=${toText(matchContext.phase, snapshotContext.phase, 'n/a')}`,
    `mode=${toText(matchContext.matchMode, snapshotContext.matchMode, 'n/a')}`,
    activePlayerName
      ? `pronounRule=When the user says he/him/the player/this bowler, resolve to ${activePlayerName}.`
      : 'pronounRule=No active player selected; ask for player selection if reference is ambiguous.',
  ];

  return lines.join('\n');
};

const toConfidenceLabel = (value) => {
  const token = String(value || '').trim();
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

const resolveRiskLevel = (telemetry) => {
  const injury = String(toText(telemetry.injuryRisk) || '').trim().toUpperCase();
  const noBall = String(toText(telemetry.noBallRisk) || '').trim().toUpperCase();
  if (injury === 'HIGH' || injury === 'CRITICAL' || noBall === 'HIGH' || noBall === 'CRITICAL') return 'High';
  if (injury === 'MED' || injury === 'MEDIUM' || noBall === 'MED' || noBall === 'MEDIUM') return 'Moderate';
  if (injury || noBall) return 'Low';
  return '';
};

const resolveTacticalRecommendationState = (snapshot) => {
  const tacticalState = asRecord(snapshot.tacticalRecommendationState);
  const coachOutput = asRecord(snapshot.coachOutput);
  const tacticalRecommendation = asRecord(coachOutput.tacticalRecommendation);
  const combinedDecision = asRecord(coachOutput.combinedDecision);
  const telemetry = asRecord(snapshot.telemetry);

  const explicitOut = toText(
    tacticalState.recommendedOutgoingPlayer,
    tacticalState.recommendedReplacementPlayer,
    tacticalState.replacementOut,
    tacticalState.out
  );
  const explicitIn = toText(
    tacticalState.recommendedIncomingPlayer,
    tacticalState.replacementIn,
    tacticalState.in
  );
  let replacement = {
    out: explicitOut,
    in: explicitIn,
    reason: toText(tacticalState.reason, tacticalState.reasoning),
  };

  if (!replacement.out || !replacement.in) {
    replacement = resolveReplacementSuggestion(tacticalRecommendation, combinedDecision, coachOutput);
  }

  const fatigueIndex = toText(tacticalState.fatigueIndex, telemetry.fatigueIndex);
  const riskLevel = toText(tacticalState.riskLevel, resolveRiskLevel(telemetry));
  const reason = toText(
    replacement.reason,
    tacticalState.reason,
    tacticalState.reasoning,
    tacticalState.assessment,
    tacticalRecommendation.why,
    combinedDecision.rationale,
    coachOutput.summary
  );
  const confidence = toText(
    toConfidenceLabel(tacticalState.confidence),
    toConfidenceLabel(tacticalRecommendation.confidence),
    toConfidenceLabel(combinedDecision.confidence)
  );

  const recommendedMove = toText(
    tacticalState.recommendedMove,
    tacticalState.nextAction,
    tacticalRecommendation.nextAction,
    tacticalRecommendation.primary,
    combinedDecision.immediateAction
  );
  const tacticalPlan = toText(
    tacticalState.tacticalPlan,
    tacticalState.swapReason,
    tacticalState.plan,
    asRecord(tacticalRecommendation.swap).reason,
    asRecord(combinedDecision.substitutionAdvice).reason
  );
  const assessment = toText(
    tacticalState.assessment,
    ...(Array.isArray(tacticalState.assessmentLines) ? tacticalState.assessmentLines : []),
    ...(Array.isArray(tacticalState.matchAssessment) ? tacticalState.matchAssessment : []),
    tacticalRecommendation.assessment
  );
  const whyThisIsSmart = toText(
    tacticalState.whyThisIsSmart,
    ...(Array.isArray(tacticalState.whyThisIsSmart) ? tacticalState.whyThisIsSmart : []),
    ...(Array.isArray(tacticalState.why) ? tacticalState.why : []),
    tacticalRecommendation.why
  );
  const riskIfIgnored = toText(
    tacticalState.riskIfIgnored,
    tacticalState.ifIgnored,
    tacticalState.ifYouIgnore,
    tacticalRecommendation.ifIgnored
  );
  const matchSituation = toText(
    tacticalState.matchSituation,
    ...(Array.isArray(tacticalState.matchSituationLines) ? tacticalState.matchSituationLines : [])
  );
  const priority = toText(tacticalState.priority);

  return {
    recommendedReplacementPlayer: replacement.out,
    recommendedOutgoingPlayer: replacement.out,
    recommendedIncomingPlayer: replacement.in,
    reason,
    fatigueIndex,
    riskLevel,
    confidence,
    recommendedMove,
    tacticalPlan,
    assessment,
    whyThisIsSmart,
    riskIfIgnored,
    matchSituation,
    priority,
  };
};

const isDetailedTacticalRequest = (message) => {
  const normalized = normalizeForKeywordMatch(message);
  if (!normalized) return false;
  return /\b(full reasoning|full detail|detailed|breakdown|step by step|show all|all reasons|deep dive|give full)\b/.test(
    normalized
  );
};

const buildAlignedTacticalReply = (state, message = '') => {
  const replacementOut = toText(state.recommendedOutgoingPlayer, state.recommendedReplacementPlayer);
  const replacementIn = toText(state.recommendedIncomingPlayer);
  if (!replacementOut || !replacementIn) return '';

  const normalizedMessage = normalizeForKeywordMatch(message);
  const reason = toText(
    state.reason,
    state.assessment,
    state.whyThisIsSmart,
    'Rotation is recommended now to prevent control drift in this phase.'
  );
  const recommendedMove = toText(
    state.recommendedMove,
    `Bring in ${replacementIn} for ${replacementOut} next over.`
  );
  const confidence = toText(state.confidence, 'Moderate');
  const tacticalPlan = toText(state.tacticalPlan);
  const riskIfIgnored = toText(state.riskIfIgnored);
  const fatigueDetail = toText(state.fatigueIndex);
  const riskDetail = toText(state.riskLevel);

  const isWhyQuestion = /\b(why|reason|because|justify|explain)\b/.test(normalizedMessage);
  const isReplacementQuestion = matchesAnyPattern(normalizedMessage, REPLACEMENT_INTENT_PATTERNS);
  const isNextBowlerQuestion = /\b(best next bowler|who bowls next|who should bowl next|next bowler)\b/.test(
    normalizedMessage
  );
  const isContinueQuestion = /\b(continue|keep|stay|still okay|ok to continue)\b/.test(normalizedMessage);
  const wantsDetailedBreakdown = isDetailedTacticalRequest(normalizedMessage);

  let response = '';
  if (isReplacementQuestion || isNextBowlerQuestion) {
    response = `${recommendedMove} ${reason}`;
  } else if (isWhyQuestion) {
    response = `${replacementOut} is still effective, but rotating now is safer because ${reason}`;
  } else if (isContinueQuestion) {
    response = `${replacementOut} is still capable, but the tactical recommendation is to rotate now. ${recommendedMove}`;
  } else {
    response = `${recommendedMove} ${reason}`;
  }
  response = clipText(response, 320);

  if (!wantsDetailedBreakdown) {
    return response;
  }

  const detailLines = [
    `Recommended move: ${recommendedMove}`,
    `Why this is smart: ${toText(state.whyThisIsSmart, reason)}`,
    tacticalPlan ? `Tactical plan: ${tacticalPlan}` : '',
    riskIfIgnored ? `Risk if ignored: ${riskIfIgnored}` : '',
    fatigueDetail ? `Fatigue index: ${fatigueDetail}` : '',
    riskDetail ? `Risk level: ${riskDetail}` : '',
    `Confidence: ${confidence}.`,
  ].filter(Boolean);

  return `${response}\n\n${detailLines.join('\n')}`.trim();
};

const isAlignmentSensitiveQuestion = (message, state) => {
  const normalizedMessage = normalizeForKeywordMatch(message);
  if (!normalizedMessage) return false;
  const replacementOut = normalizeForKeywordMatch(
    toText(state.recommendedOutgoingPlayer, state.recommendedReplacementPlayer)
  );
  const replacementIn = normalizeForKeywordMatch(state.recommendedIncomingPlayer);
  const hasReplacementIntent =
    matchesAnyPattern(normalizedMessage, REPLACEMENT_INTENT_PATTERNS) ||
    matchesAnyPattern(normalizedMessage, TACTICAL_QUERY_PATTERNS) ||
    /\b(rotate|rotation|replace|swap|sub(?:stitute)?|change|next over|next bowler|safest|who should|should we|why)\b/.test(
      normalizedMessage
    );
  if (hasReplacementIntent) return true;
  if (replacementOut && normalizedMessage.includes(replacementOut)) return true;
  if (replacementIn && normalizedMessage.includes(replacementIn)) return true;
  return false;
};

const enforceAlignmentOnReply = (message, reply, state) => {
  const baseReply = String(reply || '').trim();
  if (!baseReply) return baseReply;
  if (!toText(state.recommendedIncomingPlayer)) return baseReply;
  if (!isAlignmentSensitiveQuestion(message, state)) return baseReply;

  const normalizedMessage = normalizeForKeywordMatch(message);
  const normalizedReply = normalizeForKeywordMatch(baseReply);
  const outgoing = normalizeForKeywordMatch(
    toText(state.recommendedOutgoingPlayer, state.recommendedReplacementPlayer)
  );
  const incoming = normalizeForKeywordMatch(state.recommendedIncomingPlayer);
  const mentionsIncoming = incoming && normalizedReply.includes(incoming);
  const mentionsOutgoing = outgoing && normalizedReply.includes(outgoing);
  const replacementIntent = matchesAnyPattern(normalizedMessage, REPLACEMENT_INTENT_PATTERNS);
  const asksAboutOutgoing = Boolean(outgoing && normalizedMessage.includes(outgoing));
  const contradiction =
    mentionsOutgoing &&
    /\b(keep|continue|stay|stick|persist|back)\b/.test(normalizedReply) &&
    !mentionsIncoming;
  const missingRecommendedMove = replacementIntent && !mentionsIncoming;
  const missingRecommendationForOutgoing = asksAboutOutgoing && !mentionsIncoming;

  if (contradiction || missingRecommendedMove || missingRecommendationForOutgoing) {
    const aligned = buildAlignedTacticalReply(state, message);
    if (aligned) return aligned;
  }

  return baseReply;
};

const buildFallbackReply = (userMessage, payload, fallbackReason = '') => {
  const coachOutput = asRecord(payload.coachOutput);
  const tacticalRecommendation = asRecord(coachOutput.tacticalRecommendation);
  const combinedDecision = asRecord(coachOutput.combinedDecision);
  const players = asRecord(payload.players);
  const telemetry = asRecord(payload.telemetry);
  const tacticalState = resolveTacticalRecommendationState({
    coachOutput,
    telemetry,
    players,
    matchContextSnapshot: asRecord(payload.matchContextSnapshot),
    tacticalRecommendationState: asRecord(payload.tacticalRecommendationState),
  });
  const playerName = toText(telemetry.playerName, players.bowler, 'the current bowler');
  const nextAction = toText(
    tacticalRecommendation.nextAction,
    tacticalRecommendation.primary,
    combinedDecision.immediateAction,
    'continue with monitored execution and reassess after this over'
  );
  const rationale = toText(
    tacticalState.reason,
    tacticalRecommendation.why,
    combinedDecision.rationale,
    coachOutput.summary,
    fallbackReason ? `Fallback reason: ${fallbackReason}.` : ''
  );
  const normalizedQuestion = String(userMessage || '').trim().toLowerCase();

  const readRiskBand = (value) => {
    const token = String(value || '').trim().toUpperCase();
    if (token === 'HIGH' || token === 'CRITICAL') return 'HIGH';
    if (token === 'MED' || token === 'MEDIUM') return 'MED';
    return 'LOW';
  };

  const normalizeRosterMetrics = (value) => {
    if (!Array.isArray(value)) return [];
    return value
      .map((entry) => {
        const row = asRecord(entry);
        const name = toText(row.name, row.playerName);
        if (!name) return null;
        const fatigue = Number(row.fatigueIndex);
        const fatigueLimit = Number(row.fatigueLimit);
        const sleepHours = Number(row.sleepHours);
        const recoveryMinutes = Number(row.recoveryMinutes);
        const control = Number(row.control);
        const injuryRisk = readRiskBand(row.injuryRisk);
        const noBallRisk = readRiskBand(row.noBallRisk);
        const recoveryBand = toText(row.heartRateRecovery, row.recoveryBand, 'Moderate');
        const isUnavailable = Boolean(row.isUnfit) || Boolean(row.isInjured) || Boolean(row.isSub);
        return {
          name,
          role: toText(row.role, 'Player'),
          fatigue: Number.isFinite(fatigue) ? Math.max(0, fatigue) : 0,
          fatigueLimit: Number.isFinite(fatigueLimit) ? Math.max(1, fatigueLimit) : 6,
          sleepHours: Number.isFinite(sleepHours) ? Math.max(0, sleepHours) : 7,
          recoveryMinutes: Number.isFinite(recoveryMinutes) ? Math.max(0, recoveryMinutes) : 45,
          control: Number.isFinite(control) ? Math.max(0, control) : 75,
          injuryRisk,
          noBallRisk,
          recoveryBand,
          isUnavailable,
        };
      })
      .filter(Boolean);
  };

  const isReliabilityPrompt = /(reliable|reliability|lowest fatigue|fatigue risk|safest (bowler|batter|player)|best condition|ready to bowl|ready to bat|in best condition|lowest injury risk|workload risk|who should bowl|who should bat)/.test(
    normalizedQuestion
  );
  const isReplacementPrompt =
    matchesAnyPattern(normalizedQuestion, REPLACEMENT_INTENT_PATTERNS) ||
    matchesAnyPattern(normalizedQuestion, TACTICAL_QUERY_PATTERNS);

  if (isAlignmentSensitiveQuestion(normalizedQuestion, tacticalState)) {
    const aligned = buildAlignedTacticalReply(tacticalState, normalizedQuestion);
    if (aligned) return aligned;
  }

  if (isReliabilityPrompt) {
    const snapshotPlayers = asRecord(payload.matchContextSnapshot).players;
    const directPlayers = players;
    const rosterMetrics = normalizeRosterMetrics(
      asRecord(directPlayers).rosterMetrics || asRecord(snapshotPlayers).rosterMetrics
    ).filter((row) => !row.isUnavailable);
    if (rosterMetrics.length > 0) {
      const scorePlayer = (row) => {
        const fatigueHeadroom = Math.max(-1, Math.min(1, (row.fatigueLimit - row.fatigue) / Math.max(1, row.fatigueLimit)));
        const sleepScore = Math.max(0, Math.min(1, row.sleepHours / 8));
        const recoveryScore = row.recoveryBand.toLowerCase() === 'good' ? 1 : row.recoveryBand.toLowerCase() === 'moderate' ? 0.65 : 0.35;
        const recoveryMinutesScore = Math.max(0, Math.min(1, row.recoveryMinutes / 60));
        const controlScore = Math.max(0, Math.min(1, row.control > 10 ? row.control / 100 : row.control / 10));
        const injuryPenalty = row.injuryRisk === 'HIGH' ? 0.45 : row.injuryRisk === 'MED' ? 0.2 : 0;
        const noBallPenalty = row.noBallRisk === 'HIGH' ? 0.2 : row.noBallRisk === 'MED' ? 0.1 : 0;
        return (fatigueHeadroom * 0.36) + (sleepScore * 0.15) + (recoveryScore * 0.16) + (recoveryMinutesScore * 0.1) + (controlScore * 0.23) - injuryPenalty - noBallPenalty;
      };
      const ranked = [...rosterMetrics]
        .map((row) => ({ row, score: scorePlayer(row) }))
        .sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          return a.row.name.localeCompare(b.row.name);
        });
      const best = ranked[0]?.row;
      const runnerUp = ranked[1]?.row;
      if (best) {
        const comparisonLine = runnerUp
          ? `Compared with ${runnerUp.name}, ${best.name} has a stronger control-risk balance right now.`
          : `${best.name} currently shows the strongest readiness profile in the available squad metrics.`;
        return `Based on current recovery and fatigue metrics, ${best.name} appears the most reliable option today. ${best.name}'s fatigue is ${best.fatigue.toFixed(1)}/${best.fatigueLimit.toFixed(1)}, recovery is ${best.recoveryBand}, and injury/no-ball risk remains ${best.injuryRisk}/${best.noBallRisk}. ${comparisonLine}`;
      }
    }
  }

  if (isReplacementPrompt) {
    const payloadSnapshot = {
      players: asRecord(payload.players),
      matchContextSnapshot: asRecord(payload.matchContextSnapshot),
    };
    const rosterNames = collectRosterMetrics(payloadSnapshot)
      .map((row) => toText(row.name, row.playerName))
      .filter(Boolean);
    const mentionedPlayer = resolveMentionedPlayerName(normalizedQuestion, rosterNames);
    const replacement = resolveReplacementSuggestion(tacticalRecommendation, combinedDecision, coachOutput);
    const outPlayer = toText(
      replacement.out,
      tacticalState.recommendedOutgoingPlayer,
      tacticalState.recommendedReplacementPlayer,
      tacticalState.replacementOut,
      tacticalState.out,
      mentionedPlayer,
      playerName
    );
    const inPlayer = toText(
      replacement.in,
      tacticalState.recommendedIncomingPlayer,
      tacticalState.replacementIn,
      tacticalState.in
    );
    const reason = clipText(
      toText(
        replacement.reason,
        tacticalState.reason,
        tacticalState.reasoning,
        tacticalRecommendation.why,
        combinedDecision.rationale,
        coachOutput.summary,
        rationale,
        'This is the safest pressure reset based on current workload and control signals.'
      ),
      220
    );

    if (inPlayer) {
      return `Replace ${outPlayer || playerName} with ${inPlayer} next over. ${reason}`;
    }

    const directAction = clipText(nextAction, 220);
    return `Best next-over move: ${directAction}. ${reason}`;
  }

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
  const url = String(req?.url || '').trim();
  const routeCalled = resolveCopilotRoute(url);
  const requestUrl = url || routeCalled;
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
          message: 'Use POST /api/copilot (or /api/copilot-chat).',
          routeCalled,
        },
        {},
        req
      )
    );
  }

  try {
    const payload = await normalizeCopilotPayload(req);
    const message = toText(payload.message);
    if (!message) {
      return respond(
        jsonResponse(
          400,
          {
            ok: false,
            error: 'invalid_request',
            message: 'message/question must be a non-empty string',
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
      tacticalRecommendationState: asRecord(payload.tacticalRecommendationState),
      matchId: toText(payload.matchId),
      sessionId: toText(payload.sessionId),
    };
    context.log?.('[copilot-chat] submit', {
      traceId,
      routeCalled,
      url: requestUrl,
      analysisId: analysisIdUsed,
      prompt: message,
      historyTurns: history.length,
    });
    const tacticalState = resolveTacticalRecommendationState(contextSnapshot);

    const domain = classifyCopilotDomain(message, history, contextSnapshot);
    context.log?.('[copilot-chat] domain_guard', {
      traceId,
      routeCalled,
      allowed: domain.allowed,
      handling: domain.handling,
      reason: domain.reason,
      allowedHits: domain.allowedHits,
      blockedHits: domain.blockedHits,
      domainIntentHits: domain.domainIntentHits,
      liveScopeHits: domain.liveScopeHits,
      cricketEntityHits: domain.cricketEntityHits,
      performanceIntentHits: domain.performanceIntentHits,
      sportsDomainHits: domain.sportsDomainHits,
      comparisonDetected: domain.comparisonDetected,
      followUpDetected: domain.followUpDetected,
      replacementIntentDetected: domain.replacementIntentDetected,
      tacticalPromptDetected: domain.tacticalPromptDetected,
      contextPlayerMention: domain.contextPlayerMention,
      tacticalRecommendationState: tacticalState,
    });

    const playerReferenceResolution = resolveAmbiguousPlayerReference(message, contextSnapshot, domain);
    const bypassBlockedDomainGuard = domain.handling === 'blocked' && playerReferenceResolution.applies;
    const intentBucket = classifyMessageIntentBucket(message, domain, playerReferenceResolution);
    const effectiveMessage = playerReferenceResolution.resolvedPlayerName
      ? buildResolvedPlayerPrompt(message, playerReferenceResolution.resolvedPlayerName)
      : message;
    context.log?.('[copilot-chat] intent', {
      traceId,
      routeCalled,
      intentBucket,
      handling: domain.handling,
      bypassBlockedDomainGuard,
    });
    if (playerReferenceResolution.applies) {
      context.log?.('[copilot-chat] player_reference_resolution', {
        traceId,
        routeCalled,
        prompt: message,
        resolutionSource: playerReferenceResolution.resolutionSource || 'resolved',
        resolvedPlayerName: toText(playerReferenceResolution.resolvedPlayerName) || undefined,
        needsClarification: Boolean(playerReferenceResolution.needsClarification),
        selectedPlayerId: toText(asRecord(playerReferenceResolution.context).selectedPlayerId) || undefined,
        activePlayer: toText(asRecord(asRecord(playerReferenceResolution.context).activePlayer).name) || undefined,
        flaggedPlayers: asArray(asRecord(playerReferenceResolution.context).flaggedPlayers)
          .map((entry) => `${toText(asRecord(entry).name)}:${toText(asRecord(entry).status)}`)
          .filter(Boolean),
      });
    }

    if (domain.handling === 'greeting') {
      const greetingReply =
        pickReplyVariant(GREETING_REPLIES, `${message}:${history.length}`) ||
        GREETING_REPLIES[0];
      return respond(
        jsonResponse(
          200,
          {
            ok: true,
            source: 'ai',
            mode: 'domain_greeting',
            routeCalled,
            analysisIdUsed,
            reply: greetingReply,
            answer: greetingReply,
            messagesUsed: Math.min(10, countUserTurns(history) + 1),
          },
          {},
          req
        )
      );
    }

    if (intentBucket === 'OFF_TOPIC' || (domain.handling === 'blocked' && !bypassBlockedDomainGuard)) {
      const redirectReply = OFF_TOPIC_REDIRECT_REPLY;
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
            reply: redirectReply,
            answer: redirectReply,
            messagesUsed: Math.min(10, countUserTurns(history) + 1),
          },
          {},
          req
        )
      );
    }

    if (playerReferenceResolution.needsClarification) {
      const clarificationReply = toText(playerReferenceResolution.clarificationReply, 'Which player do you mean?');
      return respond(
        jsonResponse(
          200,
          {
            ok: true,
            source: 'ai',
            mode: 'player_reference_clarify',
            routeCalled,
            analysisIdUsed,
            reply: clarificationReply,
            answer: clarificationReply,
            messagesUsed: Math.min(10, countUserTurns(history) + 1),
          },
          {},
          req
        )
      );
    }

    if (domain.handling === 'domain_redirect') {
      const redirectReply = buildCricketSmallTalkReply(message);
      return respond(
        jsonResponse(
          200,
          {
            ok: true,
            source: 'ai',
            mode: 'domain_redirect',
            routeCalled,
            analysisIdUsed,
            reply: redirectReply,
            answer: redirectReply,
            messagesUsed: Math.min(10, countUserTurns(history) + 1),
          },
          {},
          req
        )
      );
    }

    const playerValidation = validatePlayerReferencesForMatchContext(message, contextSnapshot, domain);
    if (playerValidation.hasUnknownPlayers) {
      const firstUnknown = asRecord(playerValidation.unknownPlayers[0]);
      const unknownName = cleanPlayerName(firstUnknown.mention) || 'that player';
      const suggestion = cleanPlayerName(firstUnknown.suggestion);
      const validationReply = suggestion
        ? `I can't evaluate ${unknownName} because that player is not in the current roster for this match. Please choose a player from the active squad or bench. Did you mean ${suggestion}?`
        : `I can't evaluate ${unknownName} because that player is not in the current roster for this match. Please choose a player from the active squad or bench.`;
      context.log?.('[copilot-chat] player_validation', {
        traceId,
        routeCalled,
        prompt: message,
        unknownPlayer: unknownName,
        suggestedPlayer: suggestion || undefined,
      });
      return respond(
        jsonResponse(
          200,
          {
            ok: true,
            source: 'ai',
            mode: 'player_validation',
            routeCalled,
            analysisIdUsed,
            reply: validationReply,
            answer: validationReply,
            messagesUsed: Math.min(10, countUserTurns(history) + 1),
          },
          {},
          req
        )
      );
    }

    const aoai = resolveAoaiRuntimeConfig();
    const aoaiRequestUrl = buildAoaiChatUrl(aoai);
    const aiPathSelected = Boolean(aoai.ok && aoaiRequestUrl);
    context.log?.('[copilot-chat] routing', {
      traceId,
      routeCalled,
      aiPathSelected,
      fallbackPath: !aiPathSelected,
      endpointHost: aoai.endpointHost || '',
      deployment: aoai.deployment || '',
      apiVersion: aoai.apiVersion || '',
      requestUrl: aoaiRequestUrl,
      authHeader: 'api-key',
    });

    if (!aiPathSelected) {
      const fallbackReason = aoai.missing && aoai.missing.length > 0
        ? `missing_config:${aoai.missing.join(',')}`
        : 'aoai_not_available';
      const rawFallbackReply = buildFallbackReply(effectiveMessage, payload, fallbackReason);
      const alignedReply = enforceAlignmentOnReply(effectiveMessage, rawFallbackReply, tacticalState);
      const reply = applyResolutionAssumptionToReply(alignedReply, playerReferenceResolution);
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
            answer: reply,
            messagesUsed: Math.min(10, countUserTurns(history) + 1),
          },
          {},
          req
        )
      );
    }

    const systemPrompt = buildCopilotSystemPrompt();
    const signalSummary = buildCopilotSignalSummary(contextSnapshot);
    const structuredContext = buildCopilotContextBlock(contextSnapshot);
    const activePlayerGroundingContext = buildActivePlayerGroundingContext(contextSnapshot, tacticalState);
    const tacticalStateJson = compactJson(tacticalState, 1200);

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'system', content: `Active live context (first-message grounding):\n${activePlayerGroundingContext}` },
      { role: 'system', content: `High-signal coaching context:\n${signalSummary}` },
      { role: 'system', content: `Structured live context:\n${structuredContext}` },
      {
        role: 'system',
        content:
          `Tactical recommendation state (prioritize this for immediate move consistency):\n${tacticalStateJson}\n` +
          'Do not contradict this tactical recommendation when answering replacement/rotation questions.',
      },
      ...(playerReferenceResolution.resolvedPlayerName
        ? [
            {
              role: 'system',
              content:
                `Player reference resolution for the latest user message: treat ambiguous references like "the player", ` +
                `"he", "him", or "this bowler" as "${playerReferenceResolution.resolvedPlayerName}". ` +
                (playerReferenceResolution.assumptionPrefix
                  ? `Signal this as a brief assumption once at the start (for example: "${playerReferenceResolution.assumptionPrefix} ...").`
                  : 'Do not ask the user to repeat the player name.'),
            },
          ]
        : []),
      ...history.map((turn) => ({ role: turn.role, content: turn.content })),
      { role: 'user', content: effectiveMessage },
    ];

    try {
      const upstreamResponse = await fetch(aoaiRequestUrl, {
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
        const rawFallbackReply = buildFallbackReply(effectiveMessage, payload, fallbackReason);
        const alignedReply = enforceAlignmentOnReply(effectiveMessage, rawFallbackReply, tacticalState);
        const reply = applyResolutionAssumptionToReply(alignedReply, playerReferenceResolution);
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
              answer: reply,
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
      const rawReply = extractCompletionText(parsed);
      const alignedReply = enforceAlignmentOnReply(effectiveMessage, rawReply, tacticalState);
      const reply = applyResolutionAssumptionToReply(alignedReply, playerReferenceResolution);
      if (!reply) {
        const fallbackReason = 'aoai_empty_response';
        context.log?.('[copilot-chat] fallback', {
          traceId,
          routeCalled,
          source: 'fallback',
          reason: fallbackReason,
        });
        const rawFallbackReply = buildFallbackReply(effectiveMessage, payload, fallbackReason);
        const alignedFallbackReply = enforceAlignmentOnReply(effectiveMessage, rawFallbackReply, tacticalState);
        const fallbackReply = applyResolutionAssumptionToReply(alignedFallbackReply, playerReferenceResolution);
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
              reply: fallbackReply,
              answer: fallbackReply,
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
            answer: reply,
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
      const rawFallbackReply = buildFallbackReply(effectiveMessage, payload, fallbackReason);
      const alignedReply = enforceAlignmentOnReply(effectiveMessage, rawFallbackReply, tacticalState);
      const reply = applyResolutionAssumptionToReply(alignedReply, playerReferenceResolution);
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
            answer: reply,
            messagesUsed: Math.min(10, countUserTurns(history) + 1),
            ...(typeof status === 'number' ? { upstream: { status } } : {}),
          },
          {},
          req
        )
      );
    }
  } catch (handlerError) {
    const messageText =
      handlerError instanceof Error ? handlerError.message : String(handlerError || 'unknown_handler_error');
    context.log?.('[copilot-chat] handler_error', {
      traceId,
      routeCalled,
      error: clipText(messageText, 300),
    });
    return respond(
      jsonResponse(
        500,
        {
          ok: false,
          error: 'copilot_backend_failed',
          details: clipText(messageText, 300),
          routeCalled,
        },
        {},
        req
      )
    );
  }
};
