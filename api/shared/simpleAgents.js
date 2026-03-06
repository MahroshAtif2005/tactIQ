const { randomUUID } = require('crypto');

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const toNum = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const toText = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};
const normalizeRisk = (value, fallback = 'LOW') => {
  const token = String(value || fallback).trim().toUpperCase();
  if (token === 'HIGH') return 'HIGH';
  if (token === 'MEDIUM' || token === 'MED') return 'MED';
  if (token === 'LOW') return 'LOW';
  return fallback;
};
const riskPoints = (token) => (token === 'HIGH' ? 22 : token === 'MED' ? 12 : 4);

const pickTelemetry = (payload) => {
  if (payload && typeof payload.telemetry === 'object' && payload.telemetry !== null) {
    return payload.telemetry;
  }
  return payload && typeof payload === 'object' ? payload : {};
};

const pickMatchContext = (payload) => {
  if (payload && typeof payload.matchContext === 'object' && payload.matchContext !== null) {
    return payload.matchContext;
  }
  if (payload && typeof payload.match === 'object' && payload.match !== null) {
    return payload.match;
  }
  return {};
};

const runFatigueFallback = (payload) => {
  const telemetry = pickTelemetry(payload);
  const fatigueIndex = clamp(toNum(telemetry.fatigueIndex, 3), 0, 10);
  const strainIndex = clamp(toNum(telemetry.strainIndex, 2), 0, 10);
  const oversBowled = Math.max(0, toNum(telemetry.oversBowled, 0));
  const projected = clamp(fatigueIndex + strainIndex * 0.25 + oversBowled * 0.1, 0, 10);
  const severity = projected >= 7 ? 'HIGH' : projected >= 5 ? 'MED' : 'LOW';
  const injuryRisk = normalizeRisk(telemetry.injuryRisk, projected >= 6 ? 'MED' : 'LOW');
  const noBallRisk = normalizeRisk(telemetry.noBallRisk, projected >= 6.5 ? 'MED' : 'LOW');
  const playerId = toText(telemetry.playerId || telemetry.bowlerId, 'UNKNOWN');
  const playerName = toText(telemetry.playerName || telemetry.bowlerName, 'Current bowler');
  const recovery = toText(telemetry.heartRateRecovery || telemetry.recovery || 'Moderate');

  return {
    status: 'fallback',
    severity,
    headline: projected >= 6 ? `${playerName} workload is building` : `${playerName} workload remains stable`,
    summary: projected >= 6
      ? 'Fatigue trend is rising and can affect control in the next over.'
      : 'Fatigue profile remains stable for the next over.',
    why: [
      `Current workload is ${oversBowled.toFixed(1)} overs with strain trend ${strainIndex.toFixed(1)}.`,
      projected >= 6 ? 'Fatigue trajectory suggests control can dip under pressure.' : 'No immediate overuse signal detected.',
      `Recovery status is ${recovery}.`,
    ],
    action: projected >= 6
      ? `Rotate or shorten ${playerName}'s spell before the next pressure phase.`
      : `Continue with ${playerName} and reassess after the next over.`,
    projection: `Next over: ${projected.toFixed(1)}/10`,
    explanation: projected >= 6
      ? 'Workload and strain together indicate rising fatigue pressure.'
      : 'Current load is manageable with low short-term fatigue escalation.',
    recommendation: projected >= 6
      ? 'Reduce consecutive overs and prepare a replacement option.'
      : 'Proceed with current bowler and monitor control consistency.',
    signals: [
      `fatigue_index_${fatigueIndex.toFixed(1)}`,
      `strain_index_${strainIndex.toFixed(1)}`,
      `overs_bowled_${oversBowled.toFixed(1)}`,
    ],
    echo: {
      playerId,
      fatigueIndex,
      injuryRisk,
      noBallRisk,
      oversBowled,
      consecutiveOvers: Math.max(0, toNum(telemetry.consecutiveOvers, oversBowled)),
      oversRemaining: Math.max(0, toNum(telemetry.oversRemaining, 0)),
      maxOvers: Math.max(1, toNum(telemetry.maxOvers, 4)),
      heartRateRecovery: recovery,
    },
    suggestedTweaks: {
      suggestedRestOvers: projected >= 7 ? 2 : projected >= 6 ? 1 : 0,
      suggestedSubRole: 'Control bowler',
      notes: projected >= 6 ? 'Prioritize control over pace in next over.' : 'Stay on the same plan and track release consistency.',
    },
  };
};

const runRiskFallback = (payload, fatigueOutput) => {
  const telemetry = pickTelemetry(payload);
  const fatigueIndex = clamp(
    toNum(fatigueOutput?.echo?.fatigueIndex, toNum(telemetry.fatigueIndex, 3)),
    0,
    10
  );
  const strainIndex = clamp(toNum(telemetry.strainIndex, 2), 0, 10);
  const injuryRisk = normalizeRisk(telemetry.injuryRisk, fatigueIndex >= 6 ? 'MED' : 'LOW');
  const noBallRisk = normalizeRisk(telemetry.noBallRisk, fatigueIndex >= 6 ? 'MED' : 'LOW');
  const riskScore = clamp(
    Math.round(fatigueIndex * 7 + strainIndex * 8 + riskPoints(injuryRisk) + riskPoints(noBallRisk)),
    0,
    100
  );
  const severity = riskScore >= 85 ? 'CRITICAL' : riskScore >= 65 ? 'HIGH' : riskScore >= 40 ? 'MED' : 'LOW';
  const match = pickMatchContext(payload);

  return {
    status: 'fallback',
    agent: 'risk',
    severity,
    riskScore,
    headline: severity === 'HIGH' || severity === 'CRITICAL'
      ? 'Injury/control risk is elevated'
      : 'Risk profile is manageable',
    explanation: severity === 'HIGH' || severity === 'CRITICAL'
      ? 'Accumulated workload indicators suggest elevated execution and injury risk.'
      : 'Current load signals remain inside manageable bounds.',
    recommendation: severity === 'HIGH' || severity === 'CRITICAL'
      ? 'Reduce intensity, avoid back-to-back overs, and prepare rotation now.'
      : 'Maintain current plan and monitor release rhythm next over.',
    signals: [
      `injury_risk_${injuryRisk.toLowerCase()}`,
      `noball_risk_${noBallRisk.toLowerCase()}`,
      `fatigue_${fatigueIndex.toFixed(1)}`,
    ],
    echo: {
      playerId: toText(telemetry.playerId || telemetry.bowlerId, 'UNKNOWN'),
      fatigueIndex,
      injuryRisk,
      noBallRisk,
      oversBowled: Math.max(0, toNum(telemetry.oversBowled, 0)),
      consecutiveOvers: Math.max(0, toNum(telemetry.consecutiveOvers, 0)),
      oversRemaining: Math.max(0, toNum(telemetry.oversRemaining, 0)),
      maxOvers: Math.max(1, toNum(telemetry.maxOvers, 4)),
      heartRateRecovery: toText(telemetry.heartRateRecovery || telemetry.recovery, 'Moderate'),
      format: toText(match.format, 'T20'),
      phase: toText(match.phase, 'middle'),
      intensity: toText(match.intensity, 'Medium'),
      conditions: toText(match.conditions || match.weather),
      target: toNum(match.target, Number.NaN),
      score: toNum(match.score, Number.NaN),
      over: toNum(match.over, Number.NaN),
      balls: toNum(match.balls, Number.NaN),
    },
  };
};

const runTacticalFallback = (payload, fatigueOutput, riskOutput) => {
  const telemetry = pickTelemetry(payload);
  const fatigue = fatigueOutput || runFatigueFallback(payload);
  const risk = riskOutput || runRiskFallback(payload, fatigue);
  const playerName = toText(telemetry.playerName || telemetry.bowlerName, 'Current bowler');
  const riskHigh = risk.severity === 'HIGH' || risk.severity === 'CRITICAL';
  const fatigueHigh = toNum(fatigue.echo?.fatigueIndex, 0) >= 6;

  const immediateAction = riskHigh || fatigueHigh
    ? `Rotate ${playerName} before the next high-pressure sequence.`
    : `Continue with ${playerName} for the next over and reassess quickly.`;

  const rationale = riskHigh || fatigueHigh
    ? 'Workload and control risk signals indicate reduced stability if spell continues unchanged.'
    : 'Current signals support one more over with controlled execution.';

  return {
    status: 'fallback',
    immediateAction,
    rationale,
    suggestedAdjustments: [
      riskHigh ? 'Use a control-focused replacement bowler.' : 'Keep a replacement option ready.',
      'Set a control field to reduce boundary pressure.',
      'Reassess fatigue and no-ball trend after the over.',
    ],
    nextAction: immediateAction,
    why: [
      riskHigh ? 'Risk profile is elevated under current spell intensity.' : 'Risk profile is currently manageable.',
      fatigueHigh ? 'Fatigue trajectory is rising and may hurt release consistency.' : 'Fatigue remains inside safe operating range.',
      'Early adjustment preserves flexibility for later overs.',
    ],
    ifIgnored: riskHigh
      ? 'Control drift and no-ball risk can escalate quickly in the next over.'
      : 'Monitor control closely; rotate if line-length starts dropping.',
    confidence: riskHigh || fatigueHigh ? 0.7 : 0.62,
    keySignalsUsed: [
      ...Array.isArray(fatigue.signals) ? fatigue.signals : [],
      ...Array.isArray(risk.signals) ? risk.signals : [],
      'rules:tactical-fallback',
    ].filter(Boolean).slice(0, 8),
  };
};

const runOrchestrateFallback = (payload) => {
  const fatigue = runFatigueFallback(payload);
  const risk = runRiskFallback(payload, fatigue);
  const tactical = runTacticalFallback(payload, fatigue, risk);
  const mode = String(payload?.mode || '').trim().toLowerCase() === 'full' ? 'full' : 'auto';
  const traceId = randomUUID();
  const match = pickMatchContext(payload);
  const matchMode = toText(match.matchMode || match.mode || 'BOWLING', 'BOWLING').toUpperCase();

  return {
    ok: true,
    analysisId: traceId,
    analysisBundleId: traceId,
    traceId,
    fatigue,
    risk,
    tactical,
    summary: toText(
      tactical.rationale ||
      fatigue.summary ||
      fatigue.explanation ||
      risk.explanation ||
      'Coach analysis generated using rules fallback.'
    ),
    tacticalRecommendation: toText(tactical.immediateAction || tactical.nextAction || 'Continue with monitored plan'),
    confidence: Number.isFinite(Number(tactical.confidence)) ? Number(tactical.confidence) : 0.62,
    agentOutputs: { fatigue, risk, tactical },
    combinedDecision: {
      immediateAction: tactical.immediateAction,
      suggestedAdjustments: tactical.suggestedAdjustments || [],
      confidence: tactical.confidence || 0.62,
      rationale: tactical.rationale || 'rules_fallback',
    },
    routerDecision: {
      mode,
      intent: 'GENERAL',
      reason: 'rules_fallback',
      rulesFired: ['rules_fallback'],
      selectedAgents: ['fatigue', 'risk', 'tactical'],
      inputsUsed: {
        active: {
          fatigueIndex: fatigue.echo?.fatigueIndex,
          strainIndex: toNum(pickTelemetry(payload).strainIndex, 0),
          injuryRisk: fatigue.echo?.injuryRisk,
          noBallRisk: fatigue.echo?.noBallRisk,
        },
        match: {
          matchMode,
          format: toText(match.format, 'T20'),
          phase: toText(match.phase, 'middle'),
          intensity: toText(match.intensity, 'Medium'),
        },
      },
      agents: {
        fatigue: { routedTo: 'rules', reason: 'rules_fallback' },
        risk: { routedTo: 'rules', reason: 'rules_fallback' },
        tactical: { routedTo: 'rules', reason: 'rules_fallback' },
      },
      signals: {},
    },
    agentResults: {
      fatigue: { status: 'fallback', routedTo: 'rules', output: fatigue, reason: 'rules_fallback' },
      risk: { status: 'fallback', routedTo: 'rules', output: risk, reason: 'rules_fallback' },
      tactical: { status: 'fallback', routedTo: 'rules', output: tactical, reason: 'rules_fallback' },
    },
    errors: [],
    meta: {
      requestId: traceId,
      mode,
      executedAgents: ['fatigue', 'risk', 'tactical'],
      modelRouting: {
        fatigueModel: 'rules',
        riskModel: 'rules',
        tacticalModel: 'rules',
        fallbacksUsed: ['rules_fallback'],
      },
      usedFallbackAgents: ['fatigue', 'risk', 'tactical'],
      timingsMs: {
        total: 0,
      },
    },
  };
};

module.exports = {
  runFatigueFallback,
  runRiskFallback,
  runTacticalFallback,
  runOrchestrateFallback,
};
