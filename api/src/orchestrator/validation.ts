import { OrchestrateIntent, OrchestrateRequest, OrchestrateRequestBody, TacticalAgentInput } from '../agents/types';
import { FullMatchContext, RosterPlayerContext } from '../shared/matchContext';

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const validIntents: OrchestrateIntent[] = ['monitor', 'substitution', 'strategy', 'full'];
const validPhases = new Set(['powerplay', 'middle', 'death']);
const validRisks = new Set(['LOW', 'MED', 'MEDIUM', 'HIGH', 'UNKNOWN']);
const BOWLING_ROLE_HINTS = ['BOWL', 'BOWLER', 'FAST', 'SPIN', 'PACE', 'PACER', 'SEAM'];

function toReqObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
  return body as Record<string, unknown>;
}

function toNum(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toOptionalNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeIntent(intent: unknown): OrchestrateIntent {
  const value = String(intent || 'monitor').toLowerCase() as OrchestrateIntent;
  return validIntents.includes(value) ? value : 'monitor';
}

function normalizeMode(mode: unknown): 'route' | 'auto' | 'full' {
  const value = String(mode ?? 'route').toLowerCase().trim();
  if (value === 'full' || value === 'all') return 'full';
  if (value === 'auto') return 'auto';
  return 'route';
}

function normalizeRisk(value: unknown, fallback: 'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN' = 'UNKNOWN'): 'LOW' | 'MED' | 'HIGH' | 'UNKNOWN' {
  const upper = String(value || fallback).toUpperCase();
  if (upper === 'UNKNOWN') return 'UNKNOWN';
  if (!validRisks.has(upper)) return fallback === 'MEDIUM' ? 'MED' : fallback;
  if (upper === 'MEDIUM') return 'MED';
  return upper as 'LOW' | 'MED' | 'HIGH';
}

function normalizePhase(value: unknown): 'powerplay' | 'middle' | 'death' {
  const lower = String(value || 'middle').toLowerCase();
  if (!validPhases.has(lower)) return 'middle';
  return lower as 'powerplay' | 'middle' | 'death';
}

function normalizeTeamMode(value: unknown): 'BATTING' | 'BOWLING' {
  const upper = String(value || '').trim().toUpperCase();
  if (upper === 'BAT' || upper === 'BATTING') return 'BATTING';
  return 'BOWLING';
}

function normalizeMatchMode(value: unknown): 'BAT' | 'BOWL' {
  return normalizeTeamMode(value) === 'BATTING' ? 'BAT' : 'BOWL';
}

function inferFocusRole(role: unknown, teamMode: 'BATTING' | 'BOWLING'): 'BOWLER' | 'BATTER' {
  const normalizedRole = String(role || '').trim().toUpperCase();
  const normalizedToken = normalizedRole.replace(/[^A-Z]/g, '');
  const isBowler = BOWLING_ROLE_HINTS.some((hint) => normalizedToken.includes(hint));
  if (isBowler) return 'BOWLER';
  if (normalizedToken.includes('ALLROUNDER') || normalizedToken === 'AR') {
    return teamMode === 'BOWLING' ? 'BOWLER' : 'BATTER';
  }
  return 'BATTER';
}

function normalizeFocusRole(value: unknown, fallbackRole: unknown, teamMode: 'BATTING' | 'BOWLING'): 'BOWLER' | 'BATTER' {
  const upper = String(value || '').trim().toUpperCase();
  if (upper === 'BOWLER' || upper === 'BATTER') return upper;
  return inferFocusRole(fallbackRole, teamMode);
}

function maxOversByFormat(format: unknown): number {
  const upper = String(format || '').toUpperCase().trim();
  if (upper === 'T20') return 4;
  if (upper === 'ODI') return 10;
  return 999;
}

function inferIntent(
  requestedIntent: unknown,
  text: string,
  injuryRisk: 'LOW' | 'MED' | 'HIGH' | 'UNKNOWN',
  fatigueIndex: number,
  noBallRisk: 'LOW' | 'MED' | 'HIGH' | 'UNKNOWN'
): OrchestrateIntent {
  const normalizedRequested = normalizeIntent(requestedIntent);
  if (requestedIntent !== undefined && requestedIntent !== null && String(requestedIntent).trim() !== '') {
    return normalizedRequested;
  }

  const lowerText = text.toLowerCase();
  if (lowerText.includes('strategy') || lowerText.includes('plan')) return 'strategy';
  if (
    lowerText.includes('substitut') ||
    lowerText.includes('injur') ||
    injuryRisk === 'HIGH' ||
    fatigueIndex >= 7 ||
    noBallRisk === 'HIGH'
  ) {
    return 'substitution';
  }
  return 'monitor';
}

function normalizePlayers(rawPlayers: unknown, fallbackBowler: string): OrchestrateRequest['players'] {
  const playersObject = toReqObject(rawPlayers);
  const playersList = Array.isArray(rawPlayers) ? rawPlayers.map((entry) => String(entry)) : [];
  const benchFromObject = Array.isArray(playersObject.bench) ? playersObject.bench.map((entry) => String(entry)) : [];
  const benchFromList = playersList.slice(3);
  const bench = [...benchFromObject, ...benchFromList].filter(Boolean);

  return {
    striker: String(playersObject.striker || playersList[0] || 'Unknown Striker'),
    nonStriker: String(playersObject.nonStriker || playersList[1] || 'Unknown Non-Striker'),
    bowler: String(playersObject.bowler || playersList[2] || fallbackBowler || 'Current Bowler'),
    bench: bench.length > 0 ? bench : undefined,
  };
}

const normalizeRosterEntry = (raw: unknown): RosterPlayerContext | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  const playerId = String(entry.playerId || entry.id || '').trim();
  if (!playerId) return null;
  const name = String(entry.name || playerId).trim() || playerId;
  const role = entry.role ? String(entry.role) : undefined;
  const baselineRaw = (entry.baseline && typeof entry.baseline === 'object' && !Array.isArray(entry.baseline))
    ? entry.baseline as Record<string, unknown>
    : {};
  const liveRaw = (entry.live && typeof entry.live === 'object' && !Array.isArray(entry.live))
    ? entry.live as Record<string, unknown>
    : {};
  return {
    playerId,
    name,
    role,
    baseline: {
      playerId,
      name,
      role,
      sleepHours: Number.isFinite(Number(baselineRaw.sleepHours)) ? Number(baselineRaw.sleepHours) : undefined,
      recoveryScore: Number.isFinite(Number(baselineRaw.recoveryScore)) ? Number(baselineRaw.recoveryScore) : undefined,
      workload7d: Number.isFinite(Number(baselineRaw.workload7d)) ? Number(baselineRaw.workload7d) : undefined,
      workload28d: Number.isFinite(Number(baselineRaw.workload28d)) ? Number(baselineRaw.workload28d) : undefined,
      injuryHistoryFlags: Array.isArray(baselineRaw.injuryHistoryFlags)
        ? baselineRaw.injuryHistoryFlags.map((flag) => String(flag))
        : undefined,
      fatigueLimit: Number.isFinite(Number(baselineRaw.fatigueLimit)) ? Number(baselineRaw.fatigueLimit) : undefined,
      controlBaseline: Number.isFinite(Number(baselineRaw.controlBaseline)) ? Number(baselineRaw.controlBaseline) : undefined,
      speed: Number.isFinite(Number(baselineRaw.speed)) ? Number(baselineRaw.speed) : undefined,
      power: Number.isFinite(Number(baselineRaw.power)) ? Number(baselineRaw.power) : undefined,
    },
    live: {
      playerId,
      fatigueIndex: Number.isFinite(Number(liveRaw.fatigueIndex)) ? Number(liveRaw.fatigueIndex) : undefined,
      strainIndex: Number.isFinite(Number(liveRaw.strainIndex)) ? Number(liveRaw.strainIndex) : undefined,
      injuryRisk: liveRaw.injuryRisk ? String(liveRaw.injuryRisk) : undefined,
      noBallRisk: liveRaw.noBallRisk ? String(liveRaw.noBallRisk) : undefined,
      heartRateRecovery: liveRaw.heartRateRecovery ? String(liveRaw.heartRateRecovery) : undefined,
      oversBowled: Number.isFinite(Number(liveRaw.oversBowled)) ? Number(liveRaw.oversBowled) : undefined,
      lastUpdated: String(liveRaw.lastUpdated || new Date().toISOString()),
    },
  };
};

const normalizeFullMatchContext = (raw: unknown): { ok: true; value: FullMatchContext } | { ok: false; message: string } => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, message: 'context.match and context.roster are required' };
  }
  const record = raw as Record<string, unknown>;
  if (!record.match || typeof record.match !== 'object' || Array.isArray(record.match)) {
    return { ok: false, message: 'context.match is required' };
  }
  if (!Array.isArray(record.roster) || record.roster.length === 0) {
    return { ok: false, message: 'context.roster must include at least one player' };
  }
  const match = record.match as Record<string, unknown>;
  const roster = record.roster
    .map((entry) => normalizeRosterEntry(entry))
    .filter((entry): entry is RosterPlayerContext => Boolean(entry));
  if (roster.length === 0) {
    return { ok: false, message: 'context.roster is invalid' };
  }

  return {
    ok: true,
    value: {
      match: {
        matchMode: normalizeMatchMode(match.matchMode),
        format: String(match.format || 'T20'),
        phase: String(match.phase || 'Middle'),
        intensity: String(match.intensity || 'Medium'),
        tempState: String(match.tempState || 'Normal'),
        scoreRuns: Number.isFinite(Number(match.scoreRuns)) ? Number(match.scoreRuns) : 0,
        wickets: Number.isFinite(Number(match.wickets)) ? Number(match.wickets) : 0,
        overs: Number.isFinite(Number(match.overs)) ? Number(match.overs) : 0,
        balls: Number.isFinite(Number(match.balls)) ? Number(match.balls) : 0,
        targetRuns: Number.isFinite(Number(match.targetRuns)) ? Number(match.targetRuns) : undefined,
        requiredRunRate: Number.isFinite(Number(match.requiredRunRate)) ? Number(match.requiredRunRate) : undefined,
        timestamp: String(match.timestamp || new Date().toISOString()),
      },
      roster,
      activePlayerId: record.activePlayerId ? String(record.activePlayerId) : undefined,
      uiFlags:
        record.uiFlags && typeof record.uiFlags === 'object' && !Array.isArray(record.uiFlags)
          ? {
              powerplay: (record.uiFlags as Record<string, unknown>).powerplay === true,
              autoRouting: (record.uiFlags as Record<string, unknown>).autoRouting === true,
            }
          : undefined,
      contextVersion: 'v1',
    },
  };
};

export const validateOrchestrateRequest = (body: unknown): { ok: true; value: OrchestrateRequest } | { ok: false; message: string } => {
  const payload = toReqObject(body) as OrchestrateRequestBody;
  const telemetry = toReqObject(payload.telemetry);
  const matchContext = toReqObject(payload.matchContext);
  const signals = toReqObject(payload.signals);

  // Backward compatible schema mapper (player+match -> telemetry+matchContext)
  const legacyPlayer = toReqObject(payload.player);
  const legacyMatch = toReqObject(payload.match);
  const legacyTactical = toReqObject(legacyMatch.tactical);
  const sourceTelemetry = Object.keys(telemetry).length > 0 ? telemetry : legacyPlayer;
  const sourceMatchContext =
    Object.keys(matchContext).length > 0
      ? matchContext
      : {
          phase: legacyTactical.phase ?? legacyMatch.phase,
          matchMode: legacyTactical.matchMode ?? legacyMatch.matchMode,
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

  const text = String(payload.text || '').trim();
  const lowerText = text.toLowerCase();
  const rawMode = normalizeMode(payload.mode);
  const normalizedMode: OrchestrateRequest['mode'] = rawMode === 'full' ? 'full' : 'auto';

  const fatigueSignal = signals.fatigue ?? signals.fatigueIndex;
  const rawFatigueIndex = toNum(sourceTelemetry.fatigueIndex ?? fatigueSignal, Number.NaN);
  const fatigueIndex = Number.isFinite(rawFatigueIndex) ? Math.max(0, Math.min(10, rawFatigueIndex)) : Number.NaN;
  const injuryFlag =
    sourceTelemetry.isUnfit === true ||
    signals.isUnfit === true ||
    signals.injury === true ||
    signals.injured === true;
  const injuryRisk = normalizeRisk(sourceTelemetry.injuryRisk ?? signals.injuryRisk, 'UNKNOWN');
  const noBallRisk = normalizeRisk(sourceTelemetry.noBallRisk ?? signals.noBallRisk, 'UNKNOWN');
  const intent = inferIntent(payload.intent, text, injuryRisk, fatigueIndex, noBallRisk);
  const normalizedContext = normalizeFullMatchContext(payload.context);
  if (!normalizedContext.ok) return { ok: false, message: normalizedContext.message };
  const teamMode = normalizeTeamMode(
    payload.teamMode ??
      sourceMatchContext.teamMode ??
      sourceMatchContext.matchMode ??
      normalizedContext.value.match.matchMode
  );
  const focusRole = normalizeFocusRole(
    payload.focusRole,
    sourceTelemetry.role ?? sourceTelemetry.playerRole,
    teamMode
  );

  const value: OrchestrateRequest = {
    mode: normalizedMode,
    rawMode,
    intent,
    teamMode,
    focusRole,
    text,
    signals,
    telemetry: {
      ...(function () {
        const format = sourceMatchContext.format || legacyMatch.format || signals.format || 'T20';
        const derivedMaxOvers = maxOversByFormat(format);
        const rawMaxOvers = toNum(sourceTelemetry.maxOvers ?? signals.maxOvers, derivedMaxOvers);
        const maxOvers = Math.max(1, Math.floor(rawMaxOvers));
        const rawOvers = toNum(sourceTelemetry.oversBowled ?? signals.oversBowled, Number.NaN);
        const oversBowled = Number.isFinite(rawOvers) ? Math.min(maxOvers, Math.max(0, rawOvers)) : Number.NaN;
        const rawOversRemaining = toNum(sourceTelemetry.oversRemaining ?? signals.oversRemaining, Number.NaN);
        const oversRemaining = Number.isFinite(rawOversRemaining)
          ? Math.min(maxOvers, Math.max(0, rawOversRemaining))
          : Number.isFinite(oversBowled)
            ? Math.max(0, maxOvers - oversBowled)
            : Number.NaN;
        const rawSpell = toNum(sourceTelemetry.consecutiveOvers ?? signals.consecutiveOvers, Number.NaN);
        const consecutiveOvers = Number.isFinite(rawSpell)
          ? Math.min(Math.max(0, rawSpell), Number.isFinite(oversBowled) ? oversBowled : maxOvers)
          : 0;
        return {
          oversBowled,
          consecutiveOvers,
          oversRemaining,
          maxOvers,
        };
      })(),
      playerId: String(sourceTelemetry.playerId || sourceTelemetry.id || 'UNKNOWN'),
      playerName: String(sourceTelemetry.playerName || sourceTelemetry.name || 'Unknown Player'),
      role: String(sourceTelemetry.role || sourceTelemetry.playerRole || 'Unknown Role'),
      fatigueIndex,
      strainIndex: toOptionalNumber(sourceTelemetry.strainIndex ?? signals.strainIndex),
      heartRateRecovery: String(
        sourceTelemetry.heartRateRecovery || signals.heartRateRecovery || ''
      ),
      injuryRisk: injuryRisk as OrchestrateRequest['telemetry']['injuryRisk'],
      noBallRisk: noBallRisk as OrchestrateRequest['telemetry']['noBallRisk'],
      fatigueLimit: toOptionalNumber(sourceTelemetry.fatigueLimit ?? signals.fatigueLimit),
      sleepHours: toOptionalNumber(sourceTelemetry.sleepHours ?? signals.sleepHours),
      recoveryMinutes: toOptionalNumber(sourceTelemetry.recoveryMinutes ?? signals.recoveryMinutes),
      isUnfit: injuryFlag,
      quotaComplete:
        sourceTelemetry.quotaComplete === true ||
        signals.quotaComplete === true ||
        false,
    },
    matchContext: {
      teamMode,
      matchMode: normalizeMatchMode(sourceMatchContext.matchMode || sourceMatchContext.teamMode || teamMode),
      phase: normalizePhase(sourceMatchContext.phase ?? signals.phase),
      requiredRunRate: toNum(sourceMatchContext.requiredRunRate ?? signals.requiredRunRate, 0),
      currentRunRate: toNum(sourceMatchContext.currentRunRate ?? signals.currentRunRate, 0),
      wicketsInHand: Math.max(0, toNum(sourceMatchContext.wicketsInHand ?? signals.wicketsInHand, 7)),
      oversRemaining: Math.max(0, toNum(sourceMatchContext.oversRemaining ?? signals.oversRemaining, 10)),
      format: String(sourceMatchContext.format || legacyMatch.format || signals.format || 'T20'),
      over: toOptionalNumber(sourceMatchContext.over ?? legacyMatch.over ?? signals.over),
      intensity: String(sourceMatchContext.intensity || legacyMatch.intensity || signals.intensity || 'Medium'),
      conditions: sourceMatchContext.conditions
        ? String(sourceMatchContext.conditions)
        : signals.conditions
          ? String(signals.conditions)
          : undefined,
      target: toOptionalNumber(sourceMatchContext.target ?? legacyMatch.target ?? signals.target),
      score: toOptionalNumber(sourceMatchContext.score ?? legacyMatch.score ?? signals.score),
      balls: toOptionalNumber(sourceMatchContext.balls ?? legacyMatch.balls ?? signals.balls),
    },
    players: normalizePlayers(payload.players ?? [], String(sourceTelemetry.playerName || 'Current Bowler')),
    context: normalizedContext.value,
    userAction: payload.userAction ? String(payload.userAction) : undefined,
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
      teamMode: normalizeTeamMode(payload.teamMode ?? matchContext.teamMode ?? matchContext.matchMode),
      focusRole: normalizeFocusRole(payload.focusRole, telemetry.role, normalizeTeamMode(payload.teamMode ?? matchContext.teamMode ?? matchContext.matchMode)),
      matchContext: {
        teamMode: matchContext.teamMode ? String(matchContext.teamMode) : undefined,
        matchMode: matchContext.matchMode ? String(matchContext.matchMode) : undefined,
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
        strainIndex: telemetry.strainIndex !== undefined ? Number(telemetry.strainIndex) : undefined,
        heartRateRecovery: String(telemetry.heartRateRecovery || 'Moderate'),
        oversBowled: Number(telemetry.oversBowled || 0),
        consecutiveOvers: Number(telemetry.consecutiveOvers || 0),
        oversRemaining: telemetry.oversRemaining !== undefined ? Number(telemetry.oversRemaining) : undefined,
        maxOvers: telemetry.maxOvers !== undefined ? Number(telemetry.maxOvers) : undefined,
        quotaComplete: telemetry.quotaComplete === true,
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
