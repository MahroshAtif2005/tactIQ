import { FullMatchContext, RosterPlayerContext } from "../types/matchContext";

export interface SafetyCandidate {
  playerId: string;
  name: string;
  role: string;
  score: number;
  reason: string;
}

export interface SafetyRankResult {
  nextSafeBowler?: SafetyCandidate;
  nextSafeBatter?: SafetyCandidate;
  bowlerCandidates: SafetyCandidate[];
  batterCandidates: SafetyCandidate[];
  benchOptions: SafetyCandidate[];
}

const BOWLING_ROLE_HINTS = ["BOWLER", "SPINNER", "SPIN", "PACER", "PACE", "SEAM", "FAST", "ALL-ROUNDER", "AR"];
const BATTING_ROLE_HINTS = ["BATTER", "BATSMAN", "BAT", "ALL-ROUNDER", "AR"];

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
const toNumber = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const normalizeRole = (value: unknown): string => String(value || "").trim().toUpperCase();
const normalizeRisk = (value: unknown): "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN" => {
  const token = String(value || "").trim().toUpperCase();
  if (token === "LOW") return "LOW";
  if (token === "HIGH" || token === "CRITICAL") return "HIGH";
  if (token === "MED" || token === "MEDIUM") return "MEDIUM";
  return "UNKNOWN";
};
const riskBonus = (value: unknown): number => {
  const normalized = normalizeRisk(value);
  if (normalized === "LOW") return 2;
  if (normalized === "MEDIUM") return 0.8;
  if (normalized === "HIGH") return -2.2;
  return 0;
};
const includesHint = (role: string, hints: string[]): boolean => hints.some((hint) => role.includes(hint));

export const isBowlingCapable = (role?: string): boolean => includesHint(normalizeRole(role), BOWLING_ROLE_HINTS);
export const isBattingCapable = (role?: string): boolean => includesHint(normalizeRole(role), BATTING_ROLE_HINTS);

const buildReason = (player: RosterPlayerContext): string => {
  const fatigue = toNumber(player.live?.fatigueIndex, 5);
  const injury = normalizeRisk(player.live?.injuryRisk);
  const recovery = toNumber(player.baseline?.recoveryScore, 0);
  return `Fatigue ${fatigue.toFixed(1)}/10, injury ${injury}, recovery ${recovery.toFixed(0)}.`;
};

const scoreBowler = (player: RosterPlayerContext, intensity: string): number => {
  const fatigue = clamp(toNumber(player.live?.fatigueIndex, 5), 0, 10);
  const sleep = clamp(toNumber(player.baseline?.sleepHours, 6), 0, 12);
  const recovery = clamp(toNumber(player.baseline?.recoveryScore, 45), 0, 100);
  const workload7d = Math.max(0, toNumber(player.baseline?.workload7d, 0));
  const workload28d = Math.max(0, toNumber(player.baseline?.workload28d, 0));
  const oversBowled = Math.max(0, toNumber(player.live?.oversBowled, 0));
  const intensityFactor = String(intensity || "").toLowerCase() === "high" ? 1.2 : 1;
  const fatigueScore = 10 - fatigue;
  const sleepBonus = (sleep - 6) * 0.6;
  const recoveryBonus = (recovery - 40) / 20;
  const workloadPenalty = (workload7d / 12 + workload28d / 28 + oversBowled * 0.45) * intensityFactor;
  return Number((fatigueScore + riskBonus(player.live?.injuryRisk) + sleepBonus + recoveryBonus - workloadPenalty).toFixed(2));
};

const scoreBatter = (player: RosterPlayerContext, intensity: string): number => {
  const fatigue = clamp(toNumber(player.live?.fatigueIndex, 5), 0, 10);
  const sleep = clamp(toNumber(player.baseline?.sleepHours, 6), 0, 12);
  const recovery = clamp(toNumber(player.baseline?.recoveryScore, 45), 0, 100);
  const workload7d = Math.max(0, toNumber(player.baseline?.workload7d, 0));
  const workload28d = Math.max(0, toNumber(player.baseline?.workload28d, 0));
  const intensityIsHigh = String(intensity || "").toLowerCase() === "high";
  const fatigueScore = (10 - fatigue) * 0.95;
  const sleepBonus = (sleep - 6) * 0.55;
  const recoveryBonus = ((recovery - 40) / 18) * (intensityIsHigh ? 1.15 : 1);
  const workloadPenalty = workload7d / 14 + workload28d / 35;
  return Number((fatigueScore + riskBonus(player.live?.injuryRisk) + sleepBonus + recoveryBonus - workloadPenalty).toFixed(2));
};

const buildCandidates = (
  roster: RosterPlayerContext[],
  scorer: (player: RosterPlayerContext, intensity: string) => number,
  intensity: string
): SafetyCandidate[] =>
  roster
    .map((player) => ({
      playerId: player.playerId,
      name: player.name,
      role: String(player.role || "Unknown"),
      score: scorer(player, intensity),
      reason: buildReason(player),
    }))
    .sort((a, b) => b.score - a.score);

export const rankSafetyCandidates = (
  context: FullMatchContext,
  options?: { activePlayerId?: string; limit?: number }
): SafetyRankResult => {
  const activePlayerId = options?.activePlayerId || context.activePlayerId;
  const intensity = String(context.match?.intensity || "Medium");
  const limit = Math.max(1, options?.limit || 3);
  const eligible = context.roster.filter((player) => player.playerId !== activePlayerId);
  const fallbackPool = eligible.length > 0 ? eligible : context.roster;

  const bowlers = fallbackPool.filter((player) => isBowlingCapable(player.role));
  const batters = fallbackPool.filter((player) => isBattingCapable(player.role));
  const bowlingPool = bowlers.length > 0 ? bowlers : fallbackPool;
  const battingPool = batters.length > 0 ? batters : fallbackPool;

  const bowlerCandidates = buildCandidates(bowlingPool, scoreBowler, intensity).slice(0, limit);
  const batterCandidates = buildCandidates(battingPool, scoreBatter, intensity).slice(0, limit);

  const benchMap = new Map<string, SafetyCandidate>();
  [...bowlerCandidates, ...batterCandidates].forEach((candidate) => {
    if (!benchMap.has(candidate.playerId)) benchMap.set(candidate.playerId, candidate);
  });
  const benchOptions = [...benchMap.values()].sort((a, b) => b.score - a.score).slice(0, limit);

  return {
    nextSafeBowler: bowlerCandidates[0],
    nextSafeBatter: batterCandidates[0],
    bowlerCandidates,
    batterCandidates,
    benchOptions,
  };
};
