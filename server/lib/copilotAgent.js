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
  'You are tactIQ Copilot for cricket coaching decisions.',
  'You must answer ONLY from the current match snapshot and latest coach analysis provided.',
  'If a question is outside match context, refuse briefly and steer back to match questions.',
  'Best-effort reasoning is mandatory: infer from phase, workload trend, overs remaining, pressure, role, and risk labels.',
  'Do not repeat the Tactical Recommendation panel verbatim; add fresh interpretation and implications.',
  'Forward inference is required: include a short projection of what happens over the next 1-2 overs if tempo stays unchanged.',
  'Never invent numbers or exact metrics that are not present in the provided snapshot.',
  'If a value is missing, include one short Assumption line and continue with tactical guidance.',
  'Output format is mandatory: "Recommendation:" (1 sentence), "Reasoning:" (2 bullets), "Projection:" (1 bullet), "Caution:" (1 bullet), optional "Assumption:".',
  'Never mention backend internals, code, tools, or model details.',
  'Keep replies concise, decisive, coach-friendly, and tactical (no long paragraphs).',
  'When possible, cite only concrete values that already exist in the provided context.',
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

  return [
    recommendation,
    'Reasoning:',
    `- ${reasoningOne}`,
    `- ${reasoningTwo}`,
    'Projection:',
    `- ${projection}`,
    'Caution:',
    `- ${caution}`,
    assumptions.length > 0
      ? `Assumption: I don't have exact ${assumptions.join(', ')} in the current snapshot, but this plan uses available phase and risk signals.`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
};

const shouldUseBestEffortFallback = (text) => {
  const normalized = toLower(text);
  if (!normalized) return true;
  if (/i can only discuss the current match state/.test(normalized)) return true;
  if (/that detail isn'?t available/.test(normalized)) return true;
  if (/i don'?t have (that|this) information/.test(normalized)) return true;
  if (/not available in the current match state/.test(normalized)) return true;
  if (/don'?t have enough|insufficient|cannot determine/.test(normalized)) return true;
  if (!/recommendation:/i.test(normalized)) return true;
  if (!/reasoning:/i.test(normalized)) return true;
  if (!/projection:/i.test(normalized)) return true;
  if (!/caution:/i.test(normalized)) return true;
  if (/tactical recommendation:/i.test(normalized)) return true;
  return false;
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
  const coachPayload = compactJson(coachOutput, 2600);

  const messages = [
    { role: 'system', content: buildSystemPrompt() },
    {
      role: 'user',
      content:
        `Current match snapshot (JSON): ${snapshotPayload}\n` +
        `Latest coach output (JSON): ${coachPayload}\n` +
        'Use only this information to answer follow-up questions.',
    },
    ...sanitizedHistory,
    {
      role: 'user',
      content: `Question: ${prompt}`,
    },
  ];

  try {
    const request = client.chat.completions.create({
      model: deployment,
      temperature: 0.15,
      max_tokens: 420,
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
    if (shouldUseBestEffortFallback(text)) {
      return buildBestEffortCopilotReply({ contextSnapshot, coachOutput, userMessage: prompt });
    }
    return clipText(text, 1400);
  } catch {
    return buildBestEffortCopilotReply({ contextSnapshot, coachOutput, userMessage: prompt });
  }
};

module.exports = {
  runMatchCopilot,
  MATCH_ONLY_REFUSAL,
  buildBestEffortCopilotReply,
};
