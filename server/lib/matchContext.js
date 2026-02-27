const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const toNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const toOptionalNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};
const normalizeId = (value) => String(value || "").trim();
const normalizeRisk = (value) => {
  const token = String(value || "").trim().toUpperCase();
  if (token === "LOW") return "LOW";
  if (token === "HIGH" || token === "CRITICAL") return "HIGH";
  if (token === "MED" || token === "MEDIUM") return "MEDIUM";
  return undefined;
};
const normalizeHeartRate = (value) => {
  const token = String(value || "").trim().toLowerCase();
  if (token === "poor") return "Poor";
  if (token === "good") return "Good";
  if (token === "ok" || token === "okay" || token === "moderate") return "Ok";
  return undefined;
};

const normalizeBaseline = (raw, playerId, fallbackName, fallbackRole) => {
  const value = isRecord(raw) ? raw : {};
  return {
    playerId: normalizeId(value.playerId || playerId || ""),
    name: String(value.name || fallbackName || "Unknown Player"),
    role: String(value.role || fallbackRole || ""),
    sleepHours: toOptionalNumber(value.sleepHours),
    recoveryScore: toOptionalNumber(value.recoveryScore),
    workload7d: toOptionalNumber(value.workload7d),
    workload28d: toOptionalNumber(value.workload28d),
    injuryHistoryFlags: Array.isArray(value.injuryHistoryFlags)
      ? value.injuryHistoryFlags.map((flag) => String(flag))
      : undefined,
    fatigueLimit: toOptionalNumber(value.fatigueLimit),
    controlBaseline: toOptionalNumber(value.controlBaseline),
    speed: toOptionalNumber(value.speed),
    power: toOptionalNumber(value.power),
  };
};

const normalizeLive = (raw, playerId) => {
  const value = isRecord(raw) ? raw : {};
  return {
    playerId: normalizeId(value.playerId || playerId || ""),
    fatigueIndex: toOptionalNumber(value.fatigueIndex),
    strainIndex: toOptionalNumber(value.strainIndex),
    injuryRisk: normalizeRisk(value.injuryRisk),
    noBallRisk: normalizeRisk(value.noBallRisk),
    heartRateRecovery: normalizeHeartRate(value.heartRateRecovery),
    oversBowled: toOptionalNumber(value.oversBowled),
    lastUpdated: String(value.lastUpdated || new Date().toISOString()),
  };
};

const normalizeRosterEntry = (raw) => {
  if (!isRecord(raw)) return null;
  const playerId = normalizeId(raw.playerId || raw.id);
  if (!playerId) return null;
  const name = String(raw.name || playerId).trim() || playerId;
  const role = String(raw.role || "").trim();
  return {
    playerId,
    name,
    role: role || undefined,
    baseline: normalizeBaseline(raw.baseline, playerId, name, role),
    live: normalizeLive(raw.live, playerId),
  };
};

const normalizeMatch = (raw) => {
  if (!isRecord(raw)) return null;
  const matchModeToken = String(raw.matchMode || "BOWLING").trim().toUpperCase();
  return {
    matchMode: matchModeToken === "BAT" || matchModeToken === "BATTING" ? "BAT" : "BOWL",
    format: String(raw.format || "T20"),
    phase: String(raw.phase || "Middle"),
    intensity: String(raw.intensity || "Medium"),
    tempState: String(raw.tempState || "Normal"),
    scoreRuns: Math.max(0, Math.floor(toNumber(raw.scoreRuns, 0))),
    wickets: Math.max(0, Math.floor(toNumber(raw.wickets, 0))),
    overs: Math.max(0, toNumber(raw.overs, 0)),
    balls: Math.max(0, Math.floor(toNumber(raw.balls, 0))),
    targetRuns: toOptionalNumber(raw.targetRuns),
    requiredRunRate: toOptionalNumber(raw.requiredRunRate),
    timestamp: String(raw.timestamp || new Date().toISOString()),
  };
};

const normalizeFullMatchContext = (raw) => {
  if (!isRecord(raw)) {
    return { ok: false, message: "Missing context payload." };
  }
  if (!isRecord(raw.match) || !Array.isArray(raw.roster)) {
    return { ok: false, message: "context.match and context.roster are required." };
  }

  const match = normalizeMatch(raw.match);
  if (!match) return { ok: false, message: "context.match is invalid." };
  const roster = raw.roster.map(normalizeRosterEntry).filter(Boolean);
  if (roster.length === 0) {
    return { ok: false, message: "context.roster must include at least one player." };
  }

  return {
    ok: true,
    value: {
      match,
      roster,
      activePlayerId: normalizeId(raw.activePlayerId) || undefined,
      uiFlags: isRecord(raw.uiFlags)
        ? {
            powerplay: raw.uiFlags.powerplay === true,
            autoRouting: raw.uiFlags.autoRouting === true,
          }
        : undefined,
      contextVersion: String(raw.contextVersion || "v1"),
    },
  };
};

const buildContextSummary = (context) => {
  const hasBaselinesCount = context.roster.filter(
    (entry) =>
      entry.baseline &&
      (entry.baseline.sleepHours !== undefined ||
        entry.baseline.recoveryScore !== undefined ||
        entry.baseline.fatigueLimit !== undefined)
  ).length;
  const hasTelemetryCount = context.roster.filter(
    (entry) =>
      entry.live &&
      (entry.live.fatigueIndex !== undefined ||
        entry.live.oversBowled !== undefined ||
        entry.live.injuryRisk !== undefined)
  ).length;
  return {
    rosterCount: context.roster.length,
    activePlayerId: context.activePlayerId,
    match: {
      matchMode: context.match.matchMode,
      format: context.match.format,
      phase: context.match.phase,
      intensity: context.match.intensity,
      scoreRuns: context.match.scoreRuns,
      wickets: context.match.wickets,
      overs: context.match.overs,
      balls: context.match.balls,
      targetRuns: context.match.targetRuns,
    },
    hasBaselinesCount,
    hasTelemetryCount,
  };
};

const scoreCandidate = (candidate, activeRole, activeId) => {
  if (candidate.playerId === activeId) return Number.NEGATIVE_INFINITY;
  const roleMatch =
    String(candidate.role || "").trim().toLowerCase() === String(activeRole || "").trim().toLowerCase() ? 2 : 0;
  const fatigue = toNumber(candidate.live?.fatigueIndex, 10);
  const fatigueScore = Math.max(0, 10 - Math.max(0, Math.min(10, fatigue)));
  const sleepScore = Math.max(0, toNumber(candidate.baseline?.sleepHours, 0)) / 2;
  const recoveryScore = Math.max(0, toNumber(candidate.baseline?.recoveryScore, 0)) / 25;
  return roleMatch + fatigueScore + sleepScore + recoveryScore;
};

const pickReplacementCandidates = (context, limit = 2) => {
  const active = context.roster.find((entry) => entry.playerId === context.activePlayerId);
  const activeRole = active?.role || "";
  return [...context.roster]
    .map((entry) => ({
      playerId: entry.playerId,
      name: entry.name,
      role: entry.role,
      fatigueIndex: entry.live?.fatigueIndex,
      score: scoreCandidate(entry, activeRole, context.activePlayerId),
      reason:
        String(entry.role || "").toLowerCase() === String(activeRole || "").toLowerCase()
          ? "role-match"
          : "freshest-option",
    }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, limit))
    .map((entry) => ({
      ...entry,
      score: Number(entry.score.toFixed(2)),
    }));
};

const compactContextForPrompt = (context) => {
  const active = context.roster.find((entry) => entry.playerId === context.activePlayerId);
  return {
    contextVersion: context.contextVersion,
    match: context.match,
    active: active
      ? {
          playerId: active.playerId,
          role: active.role,
          fatigueIndex: active.live?.fatigueIndex,
          injuryRisk: active.live?.injuryRisk,
          noBallRisk: active.live?.noBallRisk,
          oversBowled: active.live?.oversBowled,
        }
      : undefined,
    replacementCandidates: pickReplacementCandidates(context, 3).map((entry) => ({
      playerId: entry.playerId,
      role: entry.role,
      fatigueIndex: entry.fatigueIndex,
      reason: entry.reason,
    })),
  };
};

module.exports = {
  normalizeFullMatchContext,
  buildContextSummary,
  compactContextForPrompt,
  pickReplacementCandidates,
};
