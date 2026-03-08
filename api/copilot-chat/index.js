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

const DOMAIN_REFUSAL_REPLY =
  "I'm designed to help with cricket tactics, player performance, match analysis, workload, fatigue, recovery, and injury-risk decisions. Ask me anything in the cricket and coaching domain.";

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

const collectLiveScopeHits = (normalizedMessage) =>
  LIVE_SCOPE_KEYWORDS.filter((keyword) => includesKeyword(normalizedMessage, keyword));

const collectCricketEntityHits = (normalizedMessage) =>
  CRICKET_ENTITY_KEYWORDS.filter((keyword) => includesKeyword(normalizedMessage, keyword));

const collectPerformanceIntentHits = (normalizedMessage) =>
  PERFORMANCE_INTENT_KEYWORDS.filter((keyword) => includesKeyword(normalizedMessage, keyword));

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
  const liveScopeHits = collectLiveScopeHits(normalizedMessage);
  const cricketEntityHits = collectCricketEntityHits(normalizedMessage);
  const performanceIntentHits = collectPerformanceIntentHits(normalizedMessage);
  const comparisonDetected =
    /\b(better|best|compare|comparison|vs|versus)\b/.test(normalizedMessage) && /\bor\b/.test(normalizedMessage);
  const followUpDetected = FOLLOW_UP_PATTERNS.some((pattern) => pattern.test(normalizedMessage));
  const hasRecentTurns = Array.isArray(history) && history.length > 0;
  const hasContextSignals = hasCopilotContextSignals(snapshot);
  const hasDomainIntent = domainIntentHits.length > 0;
  const hasCricketSignal = hasDomainIntent || allowedHits.length > 0 || cricketEntityHits.length > 0;
  const hasLiveScopeSignal = liveScopeHits.length > 0;
  const hasPerformanceIntent = performanceIntentHits.length > 0;

  if (blockedHits.length > 0 && !hasCricketSignal) {
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
      comparisonDetected,
      followUpDetected,
    };
  }

  if (hasPerformanceIntent && (hasContextSignals || hasCricketSignal)) {
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
      comparisonDetected,
      followUpDetected,
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
      comparisonDetected,
      followUpDetected,
    };
  }

  if (followUpDetected && (hasRecentTurns || hasContextSignals)) {
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
      comparisonDetected,
      followUpDetected,
    };
  }

  if (hasCricketSignal || (comparisonDetected && cricketEntityHits.length > 0)) {
    return {
      allowed: true,
      handling: 'full',
      reason: hasPerformanceIntent ? 'cricket_performance_question' : 'cricket_general',
      allowedHits,
      blockedHits,
      domainIntentHits,
      liveScopeHits,
      cricketEntityHits,
      performanceIntentHits,
      comparisonDetected,
      followUpDetected,
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
    comparisonDetected,
    followUpDetected,
  };
};

const buildCopilotSystemPrompt = () =>
  [
    'You are tactIQ Coach Copilot, a cricket tactical and performance intelligence assistant.',
    'You are not a general chatbot.',
    'You can answer questions about live match state, cricket tactics, format strategy (T20/ODI/Test), player comparisons, and cricket performance science.',
    'Also answer questions about fatigue, workload, recovery, readiness, biomechanics, and injury-risk in cricket.',
    'Treat player-reliability/readiness questions as in-domain and use provided roster metrics directly.',
    'For player comparisons or reliability ranking, prioritize fatigue, fatigue limit, recovery, sleep, control, speed, power, injury risk, and no-ball risk.',
    'Ground responses in provided context when relevant, but do not force match-state references when the user asks broader cricket knowledge questions.',
    'Always use the structured live context block (match state, selected players, roster metrics, coach context) before giving advice.',
    'When context is missing, state exactly which metric is missing in one short sentence.',
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
  ].join('\n');
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
      comparisonDetected: domain.comparisonDetected,
      followUpDetected: domain.followUpDetected,
    });

    if (domain.handling === 'blocked') {
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
            answer: DOMAIN_REFUSAL_REPLY,
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

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'system', content: `High-signal coaching context:\n${signalSummary}` },
      { role: 'system', content: `Structured live context:\n${structuredContext}` },
      ...history.map((turn) => ({ role: turn.role, content: turn.content })),
      { role: 'user', content: message },
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
        const reply = buildFallbackReply(message, payload, fallbackReason);
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
      const reply = extractCompletionText(parsed);
      if (!reply) {
        const fallbackReason = 'aoai_empty_response';
        context.log?.('[copilot-chat] fallback', {
          traceId,
          routeCalled,
          source: 'fallback',
          reason: fallbackReason,
        });
        const fallbackReply = buildFallbackReply(message, payload, fallbackReason);
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
      const reply = buildFallbackReply(message, payload, fallbackReason);
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
