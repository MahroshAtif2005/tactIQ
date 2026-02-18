import { OrchestrateIntent, OrchestrateRequest, TacticalAgentInput } from '../agents/types';

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const validIntents: OrchestrateIntent[] = ['monitor', 'substitution', 'strategy', 'full'];

function normalizeIntent(intent: unknown): OrchestrateIntent {
  const value = String(intent || 'monitor').toLowerCase() as OrchestrateIntent;
  return validIntents.includes(value) ? value : 'monitor';
}

function toReqObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object') return {};
  return body as Record<string, unknown>;
}

export const validateOrchestrateRequest = (body: unknown): { ok: true; value: OrchestrateRequest } | { ok: false; message: string } => {
  const payload = toReqObject(body);

  // New schema
  const telemetry = toReqObject(payload.telemetry);
  const matchContext = toReqObject(payload.matchContext);
  const players = toReqObject(payload.players);
  const hasNewSchema = Object.keys(telemetry).length > 0 && Object.keys(matchContext).length > 0 && Object.keys(players).length > 0;

  // Backward compatible schema mapper (player+match -> telemetry+matchContext)
  const legacyPlayer = toReqObject(payload.player);
  const legacyMatch = toReqObject(payload.match);
  const legacyTactical = toReqObject(legacyMatch.tactical);
  const hasLegacySchema = Object.keys(legacyPlayer).length > 0 && Object.keys(legacyMatch).length > 0 && Object.keys(players).length > 0;

  const sourceTelemetry = hasNewSchema ? telemetry : legacyPlayer;
  const sourceMatchContext = hasNewSchema
    ? matchContext
    : {
        phase: legacyTactical.phase ?? legacyMatch.phase,
        requiredRunRate: legacyTactical.requiredRunRate,
        currentRunRate: legacyTactical.currentRunRate,
        wicketsInHand: legacyTactical.wicketsInHand,
        oversRemaining: legacyTactical.oversRemaining,
        format: legacyMatch.format,
        over: legacyMatch.over,
        intensity: legacyMatch.intensity,
        conditions: legacyMatch.conditions,
        target: legacyMatch.target,
        score: legacyMatch.score,
        balls: legacyMatch.balls,
      };

  if (!hasNewSchema && !hasLegacySchema) {
    return { ok: false, message: 'Body must include telemetry, matchContext, and players' };
  }

  const modeRaw = payload.mode;
  if (modeRaw !== undefined && modeRaw !== 'auto' && modeRaw !== 'full') {
    return { ok: false, message: 'mode must be "auto" or "full"' };
  }

  const requiredTelemetry = ['playerId', 'playerName', 'role', 'fatigueIndex', 'heartRateRecovery', 'oversBowled', 'consecutiveOvers', 'injuryRisk', 'noBallRisk'];
  for (const field of requiredTelemetry) {
    if (sourceTelemetry[field] === undefined || sourceTelemetry[field] === null || sourceTelemetry[field] === '') {
      return { ok: false, message: `Missing required telemetry field: ${field}` };
    }
  }

  if (
    !isFiniteNumber(sourceTelemetry.fatigueIndex) ||
    !isFiniteNumber(sourceTelemetry.oversBowled) ||
    !isFiniteNumber(sourceTelemetry.consecutiveOvers)
  ) {
    return { ok: false, message: 'telemetry.fatigueIndex, telemetry.oversBowled, telemetry.consecutiveOvers must be numbers' };
  }

  const requiredMatchContext = ['phase', 'requiredRunRate', 'currentRunRate', 'wicketsInHand', 'oversRemaining'];
  for (const field of requiredMatchContext) {
    if (sourceMatchContext[field] === undefined || sourceMatchContext[field] === null || sourceMatchContext[field] === '') {
      return { ok: false, message: `Missing required matchContext field: ${field}` };
    }
  }

  if (
    !isFiniteNumber(sourceMatchContext.requiredRunRate) ||
    !isFiniteNumber(sourceMatchContext.currentRunRate) ||
    !isFiniteNumber(sourceMatchContext.wicketsInHand) ||
    !isFiniteNumber(sourceMatchContext.oversRemaining)
  ) {
    return { ok: false, message: 'matchContext requiredRunRate/currentRunRate/wicketsInHand/oversRemaining must be numbers' };
  }

  if (!players.striker || !players.nonStriker || !players.bowler) {
    return { ok: false, message: 'players.striker, players.nonStriker and players.bowler are required' };
  }

  const value: OrchestrateRequest = {
    mode: modeRaw === 'full' ? 'full' : 'auto',
    intent: normalizeIntent(payload.intent),
    telemetry: {
      playerId: String(sourceTelemetry.playerId),
      playerName: String(sourceTelemetry.playerName),
      role: String(sourceTelemetry.role),
      fatigueIndex: Number(sourceTelemetry.fatigueIndex),
      heartRateRecovery: String(sourceTelemetry.heartRateRecovery),
      oversBowled: Number(sourceTelemetry.oversBowled),
      consecutiveOvers: Number(sourceTelemetry.consecutiveOvers),
      injuryRisk: String(sourceTelemetry.injuryRisk).toUpperCase() as OrchestrateRequest['telemetry']['injuryRisk'],
      noBallRisk: String(sourceTelemetry.noBallRisk).toUpperCase() as OrchestrateRequest['telemetry']['noBallRisk'],
      fatigueLimit: sourceTelemetry.fatigueLimit !== undefined ? Number(sourceTelemetry.fatigueLimit) : undefined,
      sleepHours: sourceTelemetry.sleepHours !== undefined ? Number(sourceTelemetry.sleepHours) : undefined,
      recoveryMinutes: sourceTelemetry.recoveryMinutes !== undefined ? Number(sourceTelemetry.recoveryMinutes) : undefined,
      isUnfit: sourceTelemetry.isUnfit === true,
    },
    matchContext: {
      phase: String(sourceMatchContext.phase).toLowerCase() as OrchestrateRequest['matchContext']['phase'],
      requiredRunRate: Number(sourceMatchContext.requiredRunRate),
      currentRunRate: Number(sourceMatchContext.currentRunRate),
      wicketsInHand: Number(sourceMatchContext.wicketsInHand),
      oversRemaining: Number(sourceMatchContext.oversRemaining),
      format: sourceMatchContext.format ? String(sourceMatchContext.format) : undefined,
      over: sourceMatchContext.over !== undefined ? Number(sourceMatchContext.over) : undefined,
      intensity: sourceMatchContext.intensity ? String(sourceMatchContext.intensity) : undefined,
      conditions: sourceMatchContext.conditions ? String(sourceMatchContext.conditions) : undefined,
      target: sourceMatchContext.target !== undefined ? Number(sourceMatchContext.target) : undefined,
      score: sourceMatchContext.score !== undefined ? Number(sourceMatchContext.score) : undefined,
      balls: sourceMatchContext.balls !== undefined ? Number(sourceMatchContext.balls) : undefined,
    },
    players: {
      striker: String(players.striker),
      nonStriker: String(players.nonStriker),
      bowler: String(players.bowler),
      bench: Array.isArray(players.bench) ? players.bench.map((x) => String(x)) : undefined,
    },
  };

  return { ok: true, value };
};

export const validateTacticalRequest = (body: unknown): { ok: true; value: TacticalAgentInput } | { ok: false; message: string } => {
  const payload = toReqObject(body);
  const telemetry = toReqObject(payload.telemetry);
  const matchContext = toReqObject(payload.matchContext);
  const players = toReqObject(payload.players);
  if (!matchContext.phase || !isFiniteNumber(matchContext.requiredRunRate) || !isFiniteNumber(matchContext.currentRunRate)) {
    return { ok: false, message: 'Missing required field: matchContext (phase, requiredRunRate, currentRunRate)' };
  }
  if (!players.striker || !players.nonStriker || !players.bowler) {
    return { ok: false, message: 'players.striker, players.nonStriker and players.bowler are required' };
  }
  if (!telemetry.playerId) {
    return { ok: false, message: 'telemetry.playerId is required' };
  }

  return {
    ok: true,
    value: {
      requestId: String(payload.requestId || 'manual'),
      intent: normalizeIntent(payload.intent),
      matchContext: {
        phase: String(matchContext.phase).toLowerCase() as TacticalAgentInput['matchContext']['phase'],
        requiredRunRate: Number(matchContext.requiredRunRate),
        currentRunRate: Number(matchContext.currentRunRate),
        wicketsInHand: Number(matchContext.wicketsInHand || 0),
        oversRemaining: Number(matchContext.oversRemaining || 0),
        format: matchContext.format ? String(matchContext.format) : undefined,
        over: matchContext.over !== undefined ? Number(matchContext.over) : undefined,
        intensity: matchContext.intensity ? String(matchContext.intensity) : undefined,
        conditions: matchContext.conditions ? String(matchContext.conditions) : undefined,
        target: matchContext.target !== undefined ? Number(matchContext.target) : undefined,
        score: matchContext.score !== undefined ? Number(matchContext.score) : undefined,
        balls: matchContext.balls !== undefined ? Number(matchContext.balls) : undefined,
      },
      telemetry: {
        playerId: String(telemetry.playerId),
        playerName: String(telemetry.playerName || 'Unknown Player'),
        role: String(telemetry.role || 'Unknown Role'),
        fatigueIndex: Number(telemetry.fatigueIndex || 0),
        heartRateRecovery: String(telemetry.heartRateRecovery || 'Moderate'),
        oversBowled: Number(telemetry.oversBowled || 0),
        consecutiveOvers: Number(telemetry.consecutiveOvers || 0),
        injuryRisk: String(telemetry.injuryRisk || 'MEDIUM').toUpperCase() as TacticalAgentInput['telemetry']['injuryRisk'],
        noBallRisk: String(telemetry.noBallRisk || 'MEDIUM').toUpperCase() as TacticalAgentInput['telemetry']['noBallRisk'],
        fatigueLimit: telemetry.fatigueLimit !== undefined ? Number(telemetry.fatigueLimit) : undefined,
        sleepHours: telemetry.sleepHours !== undefined ? Number(telemetry.sleepHours) : undefined,
        recoveryMinutes: telemetry.recoveryMinutes !== undefined ? Number(telemetry.recoveryMinutes) : undefined,
      },
      players: {
        striker: String(players.striker),
        nonStriker: String(players.nonStriker),
        bowler: String(players.bowler),
        bench: Array.isArray(players.bench) ? players.bench.map((x) => String(x)) : undefined,
      },
      fatigueOutput: payload.fatigueOutput as TacticalAgentInput['fatigueOutput'],
      riskOutput: payload.riskOutput as TacticalAgentInput['riskOutput'],
    },
  };
};
