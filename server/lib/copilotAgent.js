const MATCH_ONLY_REFUSAL =
  'I can only discuss the current match state shown in tactIQ. Ask about rotation, workload, risk, pitch/weather, or current score.';

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const clipText = (value, max = 450) => {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 3)).trim()}...`;
};

const extractModelText = (content) => {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && typeof part.text === 'string') return part.text;
      return '';
    })
    .join('')
    .trim();
};

const compactJson = (value, maxChars = 6500) => {
  try {
    const encoded = JSON.stringify(value || {});
    if (encoded.length <= maxChars) return encoded;
    return `${encoded.slice(0, Math.max(0, maxChars - 3))}...`;
  } catch {
    return '{}';
  }
};

const normalizeRole = (value) =>
  String(value || '').trim().toLowerCase() === 'assistant' ? 'assistant' : 'user';

const sanitizeHistory = (history) => {
  if (!Array.isArray(history)) return [];
  return history
    .map((entry) => {
      const content = clipText(entry?.content, 600);
      if (!content) return null;
      return {
        role: normalizeRole(entry?.role),
        content,
      };
    })
    .filter(Boolean)
    .slice(-8);
};

const dedupeList = (items) => {
  const seen = new Set();
  const output = [];
  for (const item of items) {
    const normalized = String(item || '').replace(/\s+/g, ' ').trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
  }
  return output;
};

const buildConversationSoFar = (history) => {
  const rows = sanitizeHistory(history);
  if (rows.length === 0) return 'None yet.';
  return rows
    .slice(-8)
    .map((entry) => `${entry.role === 'assistant' ? 'Copilot' : 'User'}: ${clipText(entry.content, 220)}`)
    .join('\n');
};

const buildTacticalContextSnippet = (coachOutput) => {
  const tacticalRecommendation = isRecord(coachOutput?.tacticalRecommendation) ? coachOutput.tacticalRecommendation : {};
  const combinedDecision = isRecord(coachOutput?.combinedDecision) ? coachOutput.combinedDecision : {};
  const tactical = isRecord(coachOutput?.tactical) ? coachOutput.tactical : {};
  const whyList = Array.isArray(tacticalRecommendation.why) ? tacticalRecommendation.why : [];
  const nextOverPlan = Array.isArray(tactical.nextOverPlan) ? tactical.nextOverPlan : [];
  const adjustments = Array.isArray(combinedDecision.suggestedAdjustments) ? combinedDecision.suggestedAdjustments : [];
  const rawLines = [
    tacticalRecommendation.nextAction,
    tacticalRecommendation.recommendedMove,
    tacticalRecommendation.assessment,
    tacticalRecommendation.ifIgnored,
    tacticalRecommendation.swapSuggestion,
    combinedDecision.immediateAction,
    tactical.suggestion,
    nextOverPlan[0],
    adjustments[0],
    whyList[0],
    whyList[1],
  ];
  const lines = dedupeList(rawLines.map((line) => clipText(line, 150))).slice(0, 5);
  return lines.length > 0 ? lines.join('\n') : 'No tactical summary available.';
};

const toParagraphReply = (text) => {
  const cleaned = String(text || '')
    .replace(/\b(Recommendation|Reasoning|Projection|Caution|Assumption)\s*:\s*/gi, '')
    .replace(/^\s*[-•*]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  const sentences = dedupeList(
    cleaned
      .split(/(?<=[.!?])\s+/)
      .map((sentence) => sentence.trim())
      .filter(Boolean)
  ).slice(0, 8);
  if (sentences.length === 0) return clipText(cleaned, 1200);
  const paragraphs = [];
  for (let idx = 0; idx < sentences.length; idx += 2) {
    paragraphs.push(sentences.slice(idx, idx + 2).join(' '));
  }
  return clipText(paragraphs.join('\n\n'), 1200);
};

const toLower = (value) => String(value || '').toLowerCase();
const toUpper = (value) => String(value || '').trim().toUpperCase();
const toFinite = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const looksOutOfScope = (userMessage) => {
  const normalized = toLower(userMessage);
  if (!normalized) return false;
  const likelyGeneralTopic =
    /(recipe|movie|song|stocks|crypto|javascript|python|leetcode|travel|politics|capital of|translate|poem|joke|math homework)/i.test(
      normalized
    );
  const matchKeywords =
    /(match|over|bowler|batter|fatigue|strain|injury|risk|run rate|score|phase|wicket|rotation|spell|field|pitch|weather|recovery)/i.test(
      normalized
    );
  return likelyGeneralTopic && !matchKeywords;
};

const buildSystemPrompt = () => [
  'You are tactIQ Copilot: a cricket tactical coach having a conversation with a coach.',
  'Use the provided match snapshot and analysis outputs only as background context.',
  'Answer in a natural conversational style: 2–4 short paragraphs.',
  'Do not use headings (e.g., Recommendation/Reasoning/Projection/Caution/Assumption).',
  'Do not use bullet points or numbered lists.',
  'Do not repeat raw stats, dashboard labels, or copy/paste the tactical agent output. Summarize implicitly and add your own reasoning.',
  'Give one clear next action and why it makes sense, then what to watch for in the next over.',
  'Only mention exact numbers if the user explicitly asks for them.',
  'If a follow-up question is asked, use chat history + snapshot and stay consistent.',
].join(' ');

const extractSignals = (contextSnapshot, coachOutput) => {
  const telemetry = isRecord(contextSnapshot?.telemetry) ? contextSnapshot.telemetry : {};
  const matchContext = isRecord(contextSnapshot?.matchContext) ? contextSnapshot.matchContext : {};
  const players = isRecord(contextSnapshot?.players) ? contextSnapshot.players : {};
  const selectedPlayer = isRecord(contextSnapshot?.selectedPlayer) ? contextSnapshot.selectedPlayer : {};
  const tacticalReco = isRecord(coachOutput?.tacticalRecommendation) ? coachOutput.tacticalRecommendation : {};
  const alternatives = Array.isArray(tacticalReco.alternatives)
    ? tacticalReco.alternatives.map((entry) => String(entry || '').trim()).filter(Boolean)
    : [];

  return {
    playerName:
      String(telemetry.playerName || selectedPlayer.name || players.bowler || 'current bowler').trim() ||
      'current bowler',
    matchMode: String(matchContext.matchMode || '').toUpperCase() || 'BOWLING',
    phase: String(matchContext.phase || '').trim() || 'middle',
    format: String(matchContext.format || '').trim() || 'T20',
    fatigueIndex: toFinite(telemetry.fatigueIndex),
    strainIndex: toFinite(telemetry.strainIndex),
    oversBowled: toFinite(telemetry.oversBowled),
    oversRemaining: toFinite(matchContext.oversRemaining),
    injuryRisk: toUpper(telemetry.injuryRisk),
    noBallRisk: toUpper(telemetry.noBallRisk),
    fatigueTrend: String(telemetry.fatigueTrend || coachOutput?.fatigueAnalysis?.trend || '').trim().toLowerCase(),
    score: toFinite(matchContext.score),
    wickets: toFinite(matchContext.wickets),
    target: toFinite(matchContext.target),
    requiredRunRate: toFinite(matchContext.requiredRunRate),
    currentRunRate: toFinite(matchContext.currentRunRate),
    recoveryMinutes: toFinite(
      telemetry.recoveryMinutes ??
      matchContext.recoveryMinutes ??
      contextSnapshot?.selectedPlayer?.recoveryMinutes
    ),
    alternatives,
  };
};

const buildBestEffortCopilotReply = ({ contextSnapshot, coachOutput, userMessage }) => {
  const q = toLower(userMessage);
  const signals = extractSignals(contextSnapshot, coachOutput);
  const playerName = signals.playerName;
  const phaseLabel = String(signals.phase || 'middle').trim();
  const scoreLabel = Number.isFinite(signals.score) && Number.isFinite(signals.wickets)
    ? `Score ${signals.score}/${signals.wickets}`
    : 'Current scoreboard';
  const runRateDelta =
    Number.isFinite(signals.requiredRunRate) && Number.isFinite(signals.currentRunRate)
      ? signals.requiredRunRate - signals.currentRunRate
      : null;
  const pressureLabel = Number.isFinite(runRateDelta)
    ? runRateDelta > 1.5
      ? 'high chase pressure'
      : runRateDelta > 0.5
        ? 'moderate chase pressure'
        : 'stable run-rate pressure'
    : 'situational pressure';
  const hasLoadSignal =
    (Number.isFinite(signals.fatigueIndex) && signals.fatigueIndex >= 6) ||
    (Number.isFinite(signals.strainIndex) && signals.strainIndex >= 3) ||
    signals.injuryRisk === 'HIGH' ||
    signals.injuryRisk === 'MEDIUM' ||
    signals.noBallRisk === 'HIGH' ||
    signals.noBallRisk === 'MEDIUM';
  const fatigueTrendRising = /up|rising|increase/.test(signals.fatigueTrend);
  const compoundingRisk =
    hasLoadSignal ||
    fatigueTrendRising ||
    (Number.isFinite(signals.oversBowled) && signals.oversBowled >= 2) ||
    phaseLabel.toLowerCase() === 'death overs';
  const futureWindow = Number.isFinite(signals.oversRemaining)
    ? Math.max(1, Math.min(2, Math.floor(signals.oversRemaining)))
    : 2;

  let recommendation = `Recommendation: Use a control-first plan with ${playerName} in the ${phaseLabel} phase.`;
  let reasoningOne = `${scoreLabel} in ${phaseLabel} still rewards repeatable execution over raw pace changes.`;
  let reasoningTwo = `Current workload profile is ${compoundingRisk ? 'stacking' : 'stable'}, so preserving a controlled option now protects later overs.`;
  let projection = compoundingRisk
    ? `If this tempo continues, risk can step up within ${futureWindow} overs through accumulated workload.`
    : `If this tempo holds, control should stay stable over the next ${futureWindow} overs, but avoid back-to-back max-effort spells.`;
  let caution = 'Trigger rotation immediately if release point drifts for two balls or control errors repeat.';

  const asksRestAndReuse =
    /(rest|cool.?off|pause|10\s*min|ten\s*min)/.test(q) &&
    /(call|use|again|bring|return|reuse|back)/.test(q);

  if (asksRestAndReuse) {
    recommendation = `Recommendation: Give ${playerName} at least one over off, then reassess before recalling.`;
    reasoningOne = `A short break interrupts workload stacking and helps restore repeatability in ${phaseLabel}.`;
    reasoningTwo = `Using a fresher bowler now preserves ${playerName} for a higher-leverage spell later.`;
    projection = `If he returns after one controlled over off, execution is more likely to hold through the next ${futureWindow} overs.`;
    caution = 'If control is still loose on return, hold him back for one more over instead of forcing tempo.';
  } else if (/compare| vs |versus/.test(q)) {
    const compareCandidates = signals.alternatives.slice(0, 2);
    const preferred = compareCandidates[0] || 'the steadier control option';
    const backup = compareCandidates[1] || 'the pace-change option';
    recommendation = `Recommendation: Start next over with ${preferred}, keep ${backup} ready as the immediate change option.`;
    reasoningOne = `This keeps decision flexibility while matching ${pressureLabel} in the current phase.`;
    reasoningTwo = `Opening with the steadier option lowers early-ball volatility before introducing pace variation.`;
    projection = `If control holds in the first two balls, stay with the same option; otherwise rotate without waiting for a full over.`;
    caution = 'If no-ball pressure spikes or run-up rhythm shortens, move to the backup option at over end.';
  } else if (/no-?ball|wide|control|line|length/.test(q)) {
    recommendation = `Recommendation: Lower no-ball risk immediately with a rhythm-reset over for ${playerName}.`;
    reasoningOne = `In ${phaseLabel}, no-ball drift usually compounds when intent rises faster than rhythm control.`;
    reasoningTwo = `A tempo-reset now reduces technical leakage without sacrificing tactical pressure.`;
    projection = `If the reset holds for this over, control risk should stabilize over the next ${futureWindow} overs.`;
    caution = hasLoadSignal
      ? 'If front-foot errors repeat, rotate at over end before the risk compounds.'
      : 'If front-foot drift appears twice, switch to a simpler plan immediately.';
  } else if (/safest|next over|next-over|plan/.test(q)) {
    recommendation = hasLoadSignal
      ? `Recommendation: Run one low-variance over, then prepare a controlled rotation option.`
      : `Recommendation: Keep ${playerName} for one disciplined over with a low-risk field plan.`;
    reasoningOne = hasLoadSignal
      ? `Current load signals suggest protecting execution is more valuable than chasing extra pace right now.`
      : `Current profile supports one stable over while preserving flexibility for later pressure moments.`;
    reasoningTwo = `This sequencing protects momentum while keeping a bench option ready for tactical swing.`;
    projection = hasLoadSignal
      ? `Without rotation, fatigue and control risk can compound within ${futureWindow} overs.`
      : `With this plan, risk should stay contained through the next ${futureWindow} overs if rhythm remains clean.`;
    caution = signals.alternatives.length > 0
      ? `If control deteriorates, switch to ${signals.alternatives.slice(0, 2).join(', ')}.`
      : 'If control deteriorates, rotate to a fresher backup option at over end.';
  }

  const assumptions = [];
  if (!Number.isFinite(signals.fatigueIndex)) assumptions.push('fatigue index');
  if (!Number.isFinite(signals.oversBowled)) assumptions.push('overs bowled');
  if (!signals.injuryRisk) assumptions.push('injury risk tier');
  if (!signals.noBallRisk) assumptions.push('no-ball risk tier');
  if (!Number.isFinite(signals.requiredRunRate) || !Number.isFinite(signals.currentRunRate)) assumptions.push('run-rate delta');
  if (asksRestAndReuse && !Number.isFinite(signals.recoveryMinutes)) assumptions.push('recovery timer');

  const recommendationParagraph = recommendation.replace(/^Recommendation:\s*/i, '').trim();
  const reasoningParagraph = `${reasoningOne} ${reasoningTwo}`.trim();
  const projectionParagraph = `${projection} ${caution}`.trim();
  const assumptionParagraph =
    assumptions.length > 0
      ? `I do not have exact ${assumptions.join(', ')} in this snapshot, so this guidance leans on current phase, workload trend, and risk signals.`
      : '';

  return toParagraphReply(
    [recommendationParagraph, reasoningParagraph, projectionParagraph, assumptionParagraph]
      .filter(Boolean)
      .join('\n\n')
  );
};

const shouldUseBestEffortFallback = (text) => {
  const normalized = toLower(text);
  if (!normalized) return true;
  if (/i can only discuss the current match state/.test(normalized)) return true;
  if (/that detail isn'?t available/.test(normalized)) return true;
  if (/i don'?t have (that|this) information/.test(normalized)) return true;
  if (/not available in the current match state/.test(normalized)) return true;
  if (/don'?t have enough|insufficient|cannot determine/.test(normalized)) return true;
  if (normalized.length < 40) return true;
  const bulletCount = (String(text || '').match(/(^|\n)\s*[-•*]\s+/g) || []).length;
  if (bulletCount >= 3) return true;
  if (/tactical recommendation:/i.test(normalized)) return true;
  return false;
};

const requiresParagraphRewrite = (text) => {
  const source = String(text || '');
  if (!source.trim()) return false;
  if (/(^|\n)\s*(Recommendation|Reasoning|Projection|Caution|Assumption)\s*:/i.test(source)) return true;
  if (/(^|\n)\s*[-•*]\s+/.test(source)) return true;
  if (/(^|\n)\s*\d+\.\s+/.test(source)) return true;
  return false;
};

const rewriteAsConversationalParagraphs = async ({ client, deployment, text }) => {
  const original = String(text || '').trim();
  if (!original) return '';
  if (!requiresParagraphRewrite(original)) return original;
  try {
    const rewriteRequest = client.chat.completions.create({
      model: deployment,
      temperature: 0.35,
      max_tokens: 260,
      messages: [
        {
          role: 'system',
          content:
            'Rewrite the answer into 2–4 short paragraphs, no headings, no bullets, no stats repetition. Keep conversational cricket coaching tone.',
        },
        {
          role: 'user',
          content: `Original answer:\n${clipText(original, 1800)}`,
        },
      ],
    });
    let rewriteCompletion;
    if (rewriteRequest && typeof rewriteRequest.withResponse === 'function') {
      const wrapped = await rewriteRequest.withResponse();
      rewriteCompletion = wrapped.data;
    } else {
      rewriteCompletion = await rewriteRequest;
    }
    const rewritten = extractModelText(rewriteCompletion?.choices?.[0]?.message?.content);
    return rewritten || original;
  } catch {
    return original;
  }
};

const runMatchCopilot = async ({ createAzureClient, contextSnapshot, coachOutput, history, userMessage }) => {
  const prompt = clipText(userMessage, 600);
  if (!prompt) {
    throw new Error('message is required');
  }
  if (looksOutOfScope(prompt)) {
    return MATCH_ONLY_REFUSAL;
  }
  if (typeof createAzureClient !== 'function') {
    return buildBestEffortCopilotReply({ contextSnapshot, coachOutput, userMessage: prompt });
  }

  const sanitizedHistory = sanitizeHistory(history);
  let client;
  let deployment;
  try {
    const azureClient = createAzureClient();
    client = azureClient.client;
    deployment = azureClient.deployment;
  } catch {
    return buildBestEffortCopilotReply({ contextSnapshot, coachOutput, userMessage: prompt });
  }
  const snapshotPayload = compactJson(contextSnapshot, 5000);
  const tacticalContext = buildTacticalContextSnippet(coachOutput);
  const conversationSoFar = buildConversationSoFar(sanitizedHistory);

  const messages = [
    { role: 'system', content: buildSystemPrompt() },
    {
      role: 'user',
      content:
        `Match snapshot:\n${snapshotPayload}\n\n` +
        `Tactical agent output:\n${tacticalContext}\n\n` +
        `User question:\n${prompt}\n\n` +
        `Conversation so far:\n${conversationSoFar}\n\n` +
        'Use this context for inference. Do not quote tactical output verbatim.',
    },
  ];

  try {
    const request = client.chat.completions.create({
      model: deployment,
      temperature: 0.5,
      max_tokens: 300,
      messages,
    });

    let completion;
    if (request && typeof request.withResponse === 'function') {
      const wrapped = await request.withResponse();
      completion = wrapped.data;
    } else {
      completion = await request;
    }

    const text = extractModelText(completion?.choices?.[0]?.message?.content);
    if (!text) {
      return buildBestEffortCopilotReply({ contextSnapshot, coachOutput, userMessage: prompt });
    }
    const maybeRewritten = await rewriteAsConversationalParagraphs({ client, deployment, text });
    const paragraphReply = toParagraphReply(maybeRewritten);
    if (shouldUseBestEffortFallback(paragraphReply)) {
      return buildBestEffortCopilotReply({ contextSnapshot, coachOutput, userMessage: prompt });
    }
    return paragraphReply;
  } catch {
    return buildBestEffortCopilotReply({ contextSnapshot, coachOutput, userMessage: prompt });
  }
};

module.exports = {
  runMatchCopilot,
  MATCH_ONLY_REFUSAL,
  buildBestEffortCopilotReply,
};
