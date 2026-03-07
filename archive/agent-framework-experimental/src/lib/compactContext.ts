import { FullMatchContext, RosterPlayerContext } from '../types/matchContext';

const scoreReplacementCandidate = (
  player: RosterPlayerContext,
  activeRole: string,
  activePlayerId?: string
): number => {
  if (player.playerId === activePlayerId) return Number.NEGATIVE_INFINITY;
  const roleMatch = String(player.role || '').toLowerCase() === String(activeRole || '').toLowerCase() ? 2 : 0;
  const fatigueScore = 10 - Math.max(0, Math.min(10, Number(player.live.fatigueIndex ?? 0)));
  const sleepScore = Math.max(0, Number(player.baseline.sleepHours ?? 0)) / 2;
  const recoveryScore = Math.max(0, Number(player.baseline.recoveryScore ?? 0)) / 25;
  return roleMatch + fatigueScore + sleepScore + recoveryScore;
};

export const pickReplacementCandidates = (context: FullMatchContext, limit = 2) => {
  const active = context.roster.find((player) => player.playerId === context.activePlayerId);
  const activeRole = active?.role || '';
  return [...context.roster]
    .map((player) => ({ player, score: scoreReplacementCandidate(player, activeRole, context.activePlayerId) }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, limit))
    .map((entry) => ({
      playerId: entry.player.playerId,
      name: entry.player.name,
      role: entry.player.role,
      fatigueIndex: entry.player.live.fatigueIndex,
      score: Number(entry.score.toFixed(2)),
    }));
};

export const buildContextSummary = (context: FullMatchContext) => {
  const hasBaselinesCount = context.roster.filter((entry) =>
    entry.baseline &&
      (entry.baseline.sleepHours !== undefined ||
        entry.baseline.recoveryScore !== undefined ||
        entry.baseline.fatigueLimit !== undefined)
  ).length;
  const hasTelemetryCount = context.roster.filter((entry) =>
    entry.live &&
      (entry.live.fatigueIndex !== undefined ||
        entry.live.oversBowled !== undefined ||
        entry.live.injuryRisk !== undefined)
  ).length;
  return {
    rosterCount: context.roster.length,
    activePlayerId: context.activePlayerId,
    match: {
      format: context.match.format,
      scoreRuns: context.match.scoreRuns,
      wickets: context.match.wickets,
      overs: context.match.overs,
      targetRuns: context.match.targetRuns,
    },
    hasBaselinesCount,
    hasTelemetryCount,
  };
};

export const compactContextForPrompt = (context: FullMatchContext) => {
  const replacementCandidates = pickReplacementCandidates(context, 3).map((entry) => ({
    playerId: entry.playerId,
    role: entry.role,
    fatigueIndex: entry.fatigueIndex,
  }));
  const active = context.roster.find((entry) => entry.playerId === context.activePlayerId);
  return {
    contextVersion: context.contextVersion,
    match: context.match,
    active: active
      ? {
          playerId: active.playerId,
          role: active.role,
          fatigueIndex: active.live.fatigueIndex,
          injuryRisk: active.live.injuryRisk,
          noBallRisk: active.live.noBallRisk,
          oversBowled: active.live.oversBowled,
        }
      : undefined,
    replacementCandidates,
  };
};

