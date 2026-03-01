import { Baseline } from '../types/baseline';
import {
  FullMatchContext,
  PlayerBaselineContext,
  PlayerLiveTelemetry,
  RosterPlayerContext,
} from '../types/matchContext';

interface MatchContextInput {
  matchMode: 'BATTING' | 'BOWLING' | string;
  format: string;
  phase: string;
  pitch: string;
  weather: string;
}

interface MatchStateInput {
  runs: number;
  wickets: number;
  ballsBowled: number;
  totalOvers: number;
  target?: number;
}

interface PlayerContextInput {
  id: string;
  baselineId?: string;
  name: string;
  role: string;
  inRoster?: boolean;
  fatigue?: number;
  injuryRisk?: string;
  noBallRisk?: string;
  hrRecovery?: string;
  overs?: number;
  baselineFatigue?: number;
  sleepHours?: number;
  recoveryTime?: number;
  controlBaseline?: number;
  speed?: number;
  power?: number;
}

export interface MatchContextBuilderInput {
  matchContext: MatchContextInput;
  matchState: MatchStateInput;
  players: PlayerContextInput[];
  baselines: Baseline[];
  activePlayerId?: string;
  autoRouting: boolean;
}

export interface MatchContextSummary {
  rosterCount: number;
  hasBaselinesCount: number;
  hasTelemetryCount: number;
  match: {
    matchMode: 'BATTING' | 'BOWLING' | string;
    format: string;
    phase: string;
    intensity: string;
    scoreRuns: number;
    wickets: number;
    overs: number;
    balls: number;
    targetRuns?: number;
  };
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
const safeNumber = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const safeOptionalNumber = (value: unknown): number | undefined => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};
const normalizeKey = (value: unknown): string => String(value || '').trim().toUpperCase();
const toRiskLabel = (value: unknown): 'LOW' | 'MEDIUM' | 'HIGH' | undefined => {
  const token = String(value || '').trim().toUpperCase();
  if (token === 'LOW') return 'LOW';
  if (token === 'HIGH' || token === 'CRITICAL') return 'HIGH';
  if (token === 'MED' || token === 'MEDIUM') return 'MEDIUM';
  return undefined;
};
const toHeartRateLabel = (value: unknown): 'Poor' | 'Ok' | 'Good' | undefined => {
  const token = String(value || '').trim().toLowerCase();
  if (token === 'poor') return 'Poor';
  if (token === 'moderate' || token === 'ok' || token === 'okay') return 'Ok';
  if (token === 'good') return 'Good';
  return undefined;
};

const buildBaselineIndex = (rows: Baseline[]): Map<string, Baseline> => {
  const index = new Map<string, Baseline>();
  rows.forEach((row) => {
    const idKey = normalizeKey(row.id || row.playerId || row.name);
    const nameKey = normalizeKey(row.name);
    if (idKey && !index.has(idKey)) index.set(idKey, row);
    if (nameKey && !index.has(nameKey)) index.set(nameKey, row);
  });
  return index;
};

const toPlayerBaselineContext = (player: PlayerContextInput, baseline?: Baseline): PlayerBaselineContext => {
  const source = baseline;
  const baselineRecord = source ? source as Baseline & Record<string, unknown> : undefined;
  const playerRecord = player as Record<string, unknown>;
  return {
    playerId: player.id,
    name: player.name,
    role: player.role,
    sleepHours: source ? safeOptionalNumber(source.sleepHoursToday ?? source.sleep) : safeOptionalNumber(player.sleepHours),
    recoveryScore: source
      ? safeOptionalNumber(source.recoveryMinutes ?? source.recovery)
      : safeOptionalNumber(player.recoveryTime),
    workload7d: safeOptionalNumber((baselineRecord?.workload7d ?? playerRecord.workload7d)),
    workload28d: safeOptionalNumber((baselineRecord?.workload28d ?? playerRecord.workload28d)),
    injuryHistoryFlags: Array.isArray(baselineRecord?.injuryHistoryFlags)
      ? baselineRecord.injuryHistoryFlags.map((flag) => String(flag))
      : Array.isArray(playerRecord.injuryHistoryFlags)
        ? playerRecord.injuryHistoryFlags.map((flag) => String(flag))
        : undefined,
    fatigueLimit: source ? safeOptionalNumber(source.fatigueLimit) : safeOptionalNumber(player.baselineFatigue),
    controlBaseline: source
      ? safeOptionalNumber(source.controlBaseline ?? source.control)
      : safeOptionalNumber(player.controlBaseline),
    speed: source ? safeOptionalNumber(source.speed) : safeOptionalNumber(player.speed),
    power: source ? safeOptionalNumber(source.power) : safeOptionalNumber(player.power),
  };
};

const toPlayerLiveTelemetry = (player: PlayerContextInput, nowIso: string): PlayerLiveTelemetry => ({
  playerId: player.id,
  fatigueIndex: clamp(safeNumber(player.fatigue, 0), 0, 10),
  injuryRisk: toRiskLabel(player.injuryRisk),
  noBallRisk: toRiskLabel(player.noBallRisk),
  heartRateRecovery: toHeartRateLabel(player.hrRecovery),
  oversBowled: Math.max(0, safeNumber(player.overs, 0)),
  lastUpdated: nowIso,
});

const toRosterPlayerContext = (
  player: PlayerContextInput,
  baselineIndex: Map<string, Baseline>,
  nowIso: string
): RosterPlayerContext => {
  const baseline = baselineIndex.get(normalizeKey(player.baselineId || player.id)) || baselineIndex.get(normalizeKey(player.name));
  return {
    playerId: player.id,
    name: player.name,
    role: player.role,
    baseline: toPlayerBaselineContext(player, baseline),
    live: toPlayerLiveTelemetry(player, nowIso),
  };
};

const computeRequiredRunRate = (matchState: MatchStateInput): number | undefined => {
  if (!Number.isFinite(Number(matchState.target))) return undefined;
  const targetRuns = Number(matchState.target);
  const totalBalls = Math.max(1, Math.round(safeNumber(matchState.totalOvers, 0) * 6));
  const ballsBowled = clamp(Math.round(safeNumber(matchState.ballsBowled, 0)), 0, totalBalls);
  const ballsRemaining = Math.max(0, totalBalls - ballsBowled);
  if (ballsRemaining <= 0) return undefined;
  const runsRemaining = Math.max(0, targetRuns - safeNumber(matchState.runs, 0));
  return Number(((runsRemaining * 6) / ballsRemaining).toFixed(2));
};

export const buildMatchContext = (input: MatchContextBuilderInput): FullMatchContext => {
  const nowIso = new Date().toISOString();
  const baselineIndex = buildBaselineIndex(input.baselines);
  const rosterPlayers = input.players.filter((player) => player.inRoster !== false);
  const oversFloat = Number((safeNumber(input.matchState.ballsBowled, 0) / 6).toFixed(1));
  const phaseLabel = String(input.matchContext.phase || 'Middle');
  const matchMode = String(input.matchContext.matchMode || 'BOWLING').trim().toUpperCase();
  const normalizedMatchMode = matchMode === 'BAT' || matchMode === 'BATTING' ? 'BATTING' : 'BOWLING';

  return {
    match: {
      matchMode: normalizedMatchMode,
      format: String(input.matchContext.format || 'T20'),
      phase: phaseLabel,
      intensity: String(input.matchContext.pitch || 'Medium'),
      tempState: String(input.matchContext.weather || 'Normal'),
      scoreRuns: Math.max(0, Math.floor(safeNumber(input.matchState.runs, 0))),
      wickets: Math.max(0, Math.floor(safeNumber(input.matchState.wickets, 0))),
      overs: oversFloat,
      balls: Math.max(0, Math.floor(safeNumber(input.matchState.ballsBowled, 0))),
      targetRuns: Number.isFinite(Number(input.matchState.target))
        ? Math.max(0, Math.floor(Number(input.matchState.target)))
        : undefined,
      requiredRunRate: computeRequiredRunRate(input.matchState),
      timestamp: nowIso,
    },
    roster: rosterPlayers.map((player) => toRosterPlayerContext(player, baselineIndex, nowIso)),
    activePlayerId: input.activePlayerId || undefined,
    uiFlags: {
      powerplay: phaseLabel.toLowerCase() === 'powerplay',
      autoRouting: input.autoRouting,
    },
    contextVersion: 'v1',
  };
};

export const summarizeMatchContext = (context: FullMatchContext): MatchContextSummary => {
  const hasBaselinesCount = context.roster.filter((player) => {
    const baseline = player.baseline;
    return (
      baseline !== undefined &&
      (baseline.sleepHours !== undefined ||
        baseline.recoveryScore !== undefined ||
        baseline.fatigueLimit !== undefined ||
        baseline.workload7d !== undefined ||
        baseline.workload28d !== undefined)
    );
  }).length;

  const hasTelemetryCount = context.roster.filter((player) => {
    const live = player.live;
    return (
      live !== undefined &&
      (live.fatigueIndex !== undefined ||
        live.strainIndex !== undefined ||
        live.injuryRisk !== undefined ||
        live.noBallRisk !== undefined ||
        live.oversBowled !== undefined)
    );
  }).length;

  return {
    rosterCount: context.roster.length,
    hasBaselinesCount,
    hasTelemetryCount,
    match: {
      matchMode: String(context.match.matchMode || 'BOWLING'),
      format: context.match.format,
      phase: context.match.phase,
      intensity: context.match.intensity,
      scoreRuns: context.match.scoreRuns,
      wickets: context.match.wickets,
      overs: context.match.overs,
      balls: context.match.balls,
      targetRuns: context.match.targetRuns,
    },
  };
};
