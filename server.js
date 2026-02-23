const express = require("express");
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { execSync } = require("child_process");
const dotenv = require("dotenv");
require("dotenv").config({ path: "server/agent-framework/.env" });
const {
  deleteBaseline,
  getAllBaselines,
  getBaseline,
  getBaselineCount,
  getContainer,
  getRosterBaselines,
  getCosmosDiagnostics,
  isCosmosConfigured,
  patchBaseline,
  resetBaselines,
  upsertBaselines,
  validateAndNormalizeBaseline,
} = require("./server/db/cosmos");

const rootEnvPath = path.resolve(process.cwd(), ".env");
const rootEnvResult = dotenv.config({ path: rootEnvPath });
const agentFrameworkEnvPath = path.resolve(process.cwd(), "server/agent-framework/.env");
let agentFrameworkEnvLoaded = false;
if (fs.existsSync(agentFrameworkEnvPath)) {
  dotenv.config({ path: agentFrameworkEnvPath, override: false });
  agentFrameworkEnvLoaded = true;
}

const requiredAzureEnvVars = [
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_DEPLOYMENT",
  "AZURE_OPENAI_API_VERSION",
];
const isNonEmptyEnv = (value) => typeof value === "string" && value.trim().length > 0;
const getMissingAzureEnvVars = () => requiredAzureEnvVars.filter((name) => !isNonEmptyEnv(process.env[name]));
const getAzureEnvPresence = () => ({
  endpointPresent: isNonEmptyEnv(process.env.AZURE_OPENAI_ENDPOINT),
  apiKeyPresent: isNonEmptyEnv(process.env.AZURE_OPENAI_API_KEY),
  deploymentPresent: isNonEmptyEnv(process.env.AZURE_OPENAI_DEPLOYMENT),
  apiVersionPresent: isNonEmptyEnv(process.env.AZURE_OPENAI_API_VERSION),
});
const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const hasAnyKeys = (value) => isRecord(value) && Object.keys(value).length > 0;
const getMissingOrchestrateFields = (payload) =>
  ["telemetry", "matchContext", "players"].filter((field) => payload[field] === undefined || payload[field] === null);
const normalizePlayerId = (value) => String(value || "").trim().toUpperCase();
const normalizeBaselineId = (value) => String(value || "").trim();
const parseNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

console.log("[env] files", {
  rootEnvPath,
  rootEnvLoaded: !rootEnvResult.error,
  agentFrameworkEnvPath,
  agentFrameworkEnvLoaded,
});
console.log("[env] azure-openai", getAzureEnvPresence());
console.log("Cosmos env loaded:", {
  endpoint: !!process.env.COSMOS_ENDPOINT,
  key: !!process.env.COSMOS_KEY,
  db: process.env.COSMOS_DB,
  container: process.env.COSMOS_CONTAINER
});
const cosmosDiagnostics = getCosmosDiagnostics();
console.log("[env] cosmos", {
  configured: cosmosDiagnostics.configured,
  account: cosmosDiagnostics.account || null,
  database: cosmosDiagnostics.databaseId,
  container: cosmosDiagnostics.containerId,
  sdkAvailable: cosmosDiagnostics.sdkAvailable,
});
getContainer()
  .then((container) => {
    if (container) {
      const { account, databaseId, containerId } = getCosmosDiagnostics();
      console.log(`Cosmos connected: account=${account || "unknown"} db=${databaseId} container=${containerId}`);
      console.log("[cosmos] container ready.");
    } else {
      console.warn("[cosmos] not configured or unavailable.");
    }
  })
  .catch((error) => {
    console.warn("[cosmos] init failed.", error instanceof Error ? error.message : String(error));
  });

let adapter = null;
let bot = null;
let botRuntimeLoadError = null;
const isBotEnabled = String(process.env.ENABLE_BOT || "").toLowerCase() === "true";
if (isBotEnabled) {
  try {
    ({ adapter } = require("./server/bot/adapter"));
    ({ bot } = require("./server/bot/TactIQBot"));
  } catch (error) {
    botRuntimeLoadError = error;
    console.error("Bot runtime modules unavailable:", error.message);
  }
}

let backend = null;
let backendLoadError = null;
const loadBackendModules = () => {
  const { orchestrateAgents, buildRouterDecision } = require("./api/dist/orchestrator/orchestrator");
  const { validateOrchestrateRequest, validateTacticalRequest } = require("./api/dist/orchestrator/validation");
  const { runFatigueAgent } = require("./api/dist/agents/fatigueAgent");
  const { runRiskAgent } = require("./api/dist/agents/riskAgent");
  const { runTacticalAgent } = require("./api/dist/agents/tacticalAgent");
  const { getAoaiConfig } = require("./api/dist/llm/modelRegistry");
  return {
    orchestrateAgents,
    buildRouterDecision,
    validateOrchestrateRequest,
    validateTacticalRequest,
    runFatigueAgent,
    runRiskAgent,
    runTacticalAgent,
    getAoaiConfig,
  };
};

try {
  backend = loadBackendModules();
} catch (firstError) {
  try {
    execSync("npm --prefix api run build", { stdio: "ignore" });
    backend = loadBackendModules();
  } catch (secondError) {
    backendLoadError = secondError;
    console.error("Backend modules unavailable:", secondError.message || firstError.message);
  }
}

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json({ limit: "1mb" }));

const createInvocationContext = () => ({
  log: (...args) => console.log("[orchestrator]", ...args),
  error: (...args) => console.error("[orchestrator]", ...args),
});

const ensureBackendLoaded = (res) => {
  if (backend) return true;
  res.status(500).json({
    error: "Backend modules are not ready. Run `npm --prefix api run build` and restart the server.",
    details: backendLoadError ? String(backendLoadError.message || backendLoadError) : "unknown",
  });
  return false;
};

const toNum = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const sanitizeFatigueRequest = (payload = {}) => {
  const toRisk = (value, fallback) => {
    const upper = String(value || fallback).toUpperCase();
    return upper === "LOW" || upper === "MEDIUM" || upper === "HIGH" ? upper : fallback;
  };

  const format = String(payload.matchContext?.format || "T20");
  const formatMaxOvers =
    format.toUpperCase().includes("T20") ? 4 : format.toUpperCase().includes("ODI") ? 10 : 999;
  const maxOvers = Math.max(1, Math.floor(toNum(payload.maxOvers ?? payload.matchContext?.maxOvers, formatMaxOvers)));
  const oversBowled = Math.min(maxOvers, Math.max(0, toNum(payload.oversBowled, 0)));
  const oversRemaining = Math.max(
    0,
    Math.min(maxOvers, toNum(payload.oversRemaining ?? payload.matchContext?.oversRemaining, maxOvers - oversBowled))
  );

  return {
    playerId: String(payload.playerId || "UNKNOWN"),
    playerName: String(payload.playerName || "Unknown Player"),
    role: String(payload.role || "Unknown Role"),
    oversBowled,
    consecutiveOvers: Math.max(0, toNum(payload.consecutiveOvers, 0)),
    oversRemaining,
    maxOvers,
    quotaComplete: payload.quotaComplete === true,
    fatigueIndex: Math.max(0, Math.min(10, toNum(payload.fatigueIndex, 3))),
    injuryRisk: toRisk(payload.injuryRisk, "MEDIUM"),
    noBallRisk: toRisk(payload.noBallRisk, "MEDIUM"),
    heartRateRecovery: String(payload.heartRateRecovery || "Moderate"),
    fatigueLimit: Math.max(0, toNum(payload.fatigueLimit, 6)),
    sleepHours: Math.max(0, toNum(payload.sleepHours, 7)),
    recoveryMinutes: Math.max(0, toNum(payload.recoveryMinutes, 0)),
    snapshotId: String(payload.snapshotId || ""),
    matchContext: {
      format,
      phase: String(payload.matchContext?.phase || "Middle"),
      over: toNum(payload.matchContext?.over, 0),
      intensity: String(payload.matchContext?.intensity || "Medium"),
    },
  };
};

const sanitizeRiskRequest = (payload = {}) => {
  const format = String(payload.format || payload.match?.format || "T20");
  const formatMaxOvers =
    format.toUpperCase().includes("T20") ? 4 : format.toUpperCase().includes("ODI") ? 10 : 999;
  const maxOvers = Math.max(1, Math.floor(toNum(payload.maxOvers, formatMaxOvers)));
  const oversBowled = toNum(payload.oversBowled, Number.NaN);
  const spellOvers = toNum(payload.consecutiveOvers, Number.NaN);
  const normalizedOvers = Number.isFinite(oversBowled) ? Math.min(maxOvers, Math.max(0, oversBowled)) : Number.NaN;
  const normalizedSpellOvers = Number.isFinite(spellOvers) ? Math.max(0, spellOvers) : Number.NaN;
  const clampedSpellOvers =
    Number.isFinite(normalizedOvers) && Number.isFinite(normalizedSpellOvers)
      ? Math.min(normalizedSpellOvers, normalizedOvers)
      : normalizedSpellOvers;
  const oversRemainingRaw = toNum(payload.oversRemaining, Number.NaN);
  const oversRemaining = Number.isFinite(oversRemainingRaw)
    ? Math.min(maxOvers, Math.max(0, oversRemainingRaw))
    : Number.isFinite(normalizedOvers)
      ? Math.max(0, maxOvers - normalizedOvers)
      : Number.NaN;

  return {
    playerId: String(payload.playerId || "UNKNOWN"),
    fatigueIndex: Math.max(0, Math.min(10, toNum(payload.fatigueIndex, Number.NaN))),
    injuryRisk: ["LOW", "MED", "MEDIUM", "HIGH", "UNKNOWN"].includes(String(payload.injuryRisk || "").toUpperCase())
      ? String(payload.injuryRisk || "").toUpperCase()
      : "UNKNOWN",
    noBallRisk: ["LOW", "MED", "MEDIUM", "HIGH", "UNKNOWN"].includes(String(payload.noBallRisk || "").toUpperCase())
      ? String(payload.noBallRisk || "").toUpperCase()
      : "UNKNOWN",
    oversBowled: normalizedOvers,
    consecutiveOvers: clampedSpellOvers,
    oversRemaining,
    maxOvers,
    quotaComplete: payload.quotaComplete === true,
    heartRateRecovery: payload.heartRateRecovery ? String(payload.heartRateRecovery) : undefined,
    isUnfit: payload.isUnfit === true,
    format,
    phase: String(payload.phase || payload.match?.phase || "Middle"),
    intensity: String(payload.intensity || payload.match?.intensity || "Medium"),
    conditions: payload.conditions ? String(payload.conditions) : payload.match?.conditions ? String(payload.match.conditions) : undefined,
    target: Number.isFinite(toNum(payload.target, NaN)) ? toNum(payload.target, 0) : undefined,
    score: Number.isFinite(toNum(payload.score, NaN)) ? toNum(payload.score, 0) : undefined,
    over: Number.isFinite(toNum(payload.over, NaN)) ? toNum(payload.over, 0) : undefined,
    balls: Number.isFinite(toNum(payload.balls, NaN)) ? toNum(payload.balls, 0) : undefined,
  };
};

const isCosmosUnavailableError = (error) =>
  Boolean(error) &&
  typeof error === "object" &&
  ("code" in error && error.code === "COSMOS_NOT_CONFIGURED");

const ensureCosmosBaselinesReady = async () => {
  if (!isCosmosConfigured()) {
    return {
      ok: false,
      status: 503,
      body: { error: "Cosmos not configured for baselines." },
    };
  }
  const container = await getContainer();
  if (!container) {
    return {
      ok: false,
      status: 503,
      body: { error: "Cosmos unavailable for baselines." },
    };
  }
  return { ok: true, container };
};

const normalizeBaselinesForSave = (body) => {
  const items = Array.isArray(body?.players)
    ? body.players
    : Array.isArray(body?.baselines)
      ? body.baselines
      : null;

  if (!Array.isArray(items)) {
    return {
      ok: false,
      message: "Body must be { players: PlayerBaseline[] }.",
      players: [],
      errors: ["players must be an array"],
    };
  }

  const players = [];
  const errors = [];

  for (let index = 0; index < items.length; index += 1) {
    const result = validateAndNormalizeBaseline(
      {
        ...items[index],
        updatedAt: new Date().toISOString(),
      },
      { strict: true }
    );

    if (!result.ok) {
      errors.push(`players[${index}]: ${result.errors.join(", ")}`);
      continue;
    }
    players.push(result.value);
  }

  if (errors.length > 0) {
    return {
      ok: false,
      message: "Invalid baselines payload.",
      players: [],
      errors,
    };
  }

  return { ok: true, message: null, players, errors: [] };
};

const applyStoredBaselineToPayload = async (payload) => {
  if (!isRecord(payload)) return payload;

  const telemetry = isRecord(payload.telemetry) ? { ...payload.telemetry } : {};
  const candidateIds = [
    normalizeBaselineId(telemetry.playerId),
    normalizeBaselineId(payload.playerId),
    normalizeBaselineId(payload.player?.playerId),
    normalizeBaselineId(payload.player?.id),
    normalizeBaselineId(telemetry.playerName),
  ].filter(Boolean);
  const uniqueCandidates = [...new Set(candidateIds)];

  if (uniqueCandidates.length === 0) {
    return payload;
  }

  let baseline = null;
  for (const candidateId of uniqueCandidates) {
    // Point-read first match to keep RU usage low.
    // eslint-disable-next-line no-await-in-loop
    baseline = await getBaseline(candidateId);
    if (baseline) break;
  }

  if (!baseline) {
    return {
      ...payload,
      telemetry: {
        ...telemetry,
      },
    };
  }

  return {
    ...payload,
    telemetry: {
      ...telemetry,
      playerId: telemetry.playerId || baseline.id,
      playerName: telemetry.playerName || baseline.name || baseline.id,
      fatigueLimit: parseNumber(baseline.fatigueLimit, parseNumber(telemetry.fatigueLimit, 6)),
      sleepHours: parseNumber(baseline.sleep, parseNumber(telemetry.sleepHours, 7)),
      recoveryMinutes: parseNumber(baseline.recovery, parseNumber(telemetry.recoveryMinutes, 45)),
    },
  };
};

/* API ROUTES FIRST */
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/health", async (_req, res) => {
  const aoai = backend?.getAoaiConfig ? backend.getAoaiConfig() : { ok: false, missing: ["api-dist-not-loaded"] };
  const diagnostics = getCosmosDiagnostics();
  let cosmosConnected = false;
  let count = 0;
  try {
    count = await getBaselineCount();
    cosmosConnected = true;
  } catch {
    cosmosConnected = false;
    count = 0;
  }
  res.json({
    ok: true,
    status: "ok",
    service: "tactiq-express",
    timestamp: new Date().toISOString(),
    cosmosConnected,
    account: diagnostics.account || null,
    database: diagnostics.databaseId,
    container: diagnostics.containerId,
    count,
    routes: [
      "/api/health",
      "/api/baselines",
      "/api/roster",
      "/api/baselines/:id",
      "/api/baselines/reset",
      "/api/router",
      "/api/agents/fatigue",
      "/api/agents/risk",
      "/api/agents/tactical",
      "/api/orchestrate",
      "/api/messages",
    ],
    aoai: aoai.ok
      ? {
          configured: true,
          deployment: process.env.AZURE_OPENAI_DEPLOYMENT || "",
        }
      : {
          configured: false,
          missing: aoai.missing,
        },
  });
});

app.get("/api/baselines", async (_req, res) => {
  try {
    const readiness = await ensureCosmosBaselinesReady();
    if (!readiness.ok) {
      return res.status(readiness.status).json(readiness.body);
    }
    const players = await getAllBaselines();
    const diagnostics = getCosmosDiagnostics();
    console.log("[baselines] GET", {
      account: diagnostics.account || null,
      database: diagnostics.databaseId,
      container: diagnostics.containerId,
      count: players.length,
    });
    return res.status(200).json({
      players,
      source: "cosmos",
    });
  } catch (error) {
    console.error("Baselines GET error", error);
    if (isCosmosUnavailableError(error)) {
      return res.status(503).json({ error: "Cosmos unavailable for baselines." });
    }
    return res.status(500).json({ error: "Failed to load baselines." });
  }
});

app.get("/api/roster", async (_req, res) => {
  try {
    const readiness = await ensureCosmosBaselinesReady();
    if (!readiness.ok) {
      return res.status(readiness.status).json(readiness.body);
    }
    const players = await getRosterBaselines();
    const diagnostics = getCosmosDiagnostics();
    console.log("[roster] GET", {
      account: diagnostics.account || null,
      database: diagnostics.databaseId,
      container: diagnostics.containerId,
      count: players.length,
    });
    return res.status(200).json({
      players,
      source: "cosmos",
    });
  } catch (error) {
    console.error("Roster GET error", error);
    if (isCosmosUnavailableError(error)) {
      return res.status(503).json({ error: "Cosmos unavailable for roster." });
    }
    return res.status(500).json({ error: "Failed to load roster." });
  }
});

app.get("/api/baselines/:id", async (req, res) => {
  try {
    const readiness = await ensureCosmosBaselinesReady();
    if (!readiness.ok) {
      return res.status(readiness.status).json(readiness.body);
    }
    const id = normalizeBaselineId(decodeURIComponent(String(req.params.id || "")));
    if (!id) {
      return res.status(400).json({ error: "id is required." });
    }
    const baseline = await getBaseline(id);
    if (!baseline) {
      return res.status(404).json({ error: `Baseline ${id} not found.` });
    }
    return res.status(200).json(baseline);
  } catch (error) {
    console.error("Baseline by id GET error", error);
    if (isCosmosUnavailableError(error)) {
      return res.status(503).json({ error: "Cosmos unavailable for baselines." });
    }
    return res.status(500).json({ error: "Failed to load baseline." });
  }
});

const saveBaselinesHandler = async (req, res) => {
  try {
    const readiness = await ensureCosmosBaselinesReady();
    if (!readiness.ok) {
      return res.status(readiness.status).json(readiness.body);
    }
    const normalized = normalizeBaselinesForSave(req.body);
    if (!normalized.ok) {
      return res.status(400).json({
        error: normalized.message,
        details: normalized.errors,
      });
    }

    await upsertBaselines(normalized.players);
    const players = await getAllBaselines();
    return res.status(200).json({ ok: true, players });
  } catch (error) {
    console.error("Baselines PUT error", error);
    if (isCosmosUnavailableError(error)) {
      return res.status(503).json({ error: "Cosmos unavailable for baselines." });
    }
    if (error && typeof error === "object" && "code" in error && error.code === "VALIDATION_ERROR") {
      return res.status(400).json({
        error: "Invalid baselines payload.",
        details: Array.isArray(error.details) ? error.details : [String(error.message || error)],
      });
    }
    return res.status(500).json({ error: "Failed to save baselines." });
  }
};

app.post("/api/baselines", saveBaselinesHandler);
app.put("/api/baselines", saveBaselinesHandler);

app.patch("/api/baselines/:id", async (req, res) => {
  try {
    const readiness = await ensureCosmosBaselinesReady();
    if (!readiness.ok) {
      return res.status(readiness.status).json(readiness.body);
    }
    const id = normalizeBaselineId(decodeURIComponent(String(req.params.id || "")));
    if (!id) {
      return res.status(400).json({ error: "id is required." });
    }

    if (!isRecord(req.body)) {
      return res.status(400).json({ error: "Body must include at least one patch field." });
    }
    const hasActive = Object.prototype.hasOwnProperty.call(req.body, "active");
    const hasInRoster =
      Object.prototype.hasOwnProperty.call(req.body, "inRoster") ||
      Object.prototype.hasOwnProperty.call(req.body, "roster");
    if (!hasActive && !hasInRoster) {
      return res.status(400).json({ error: "Body must include active and/or inRoster." });
    }
    if (hasActive && typeof req.body.active !== "boolean") {
      return res.status(400).json({ error: "Field active must be boolean." });
    }
    const nextInRoster = Object.prototype.hasOwnProperty.call(req.body, "inRoster")
      ? req.body.inRoster
      : req.body.roster;
    if (hasInRoster && typeof nextInRoster !== "boolean") {
      return res.status(400).json({ error: "Field inRoster must be boolean." });
    }

    const updated = await patchBaseline(id, {
      ...(hasActive ? { active: req.body.active } : {}),
      ...(hasInRoster ? { inRoster: nextInRoster } : {}),
    });
    if (process.env.NODE_ENV !== "production") {
      console.log("[baselines] patch", { id, status: 200, hasActive, hasInRoster });
    }
    return res.status(200).json({ ok: true, player: updated });
  } catch (error) {
    console.error("Baselines PATCH error", error);
    if (isCosmosUnavailableError(error)) {
      return res.status(503).json({ error: "Cosmos unavailable for baselines." });
    }
    if (error && typeof error === "object" && "code" in error && Number(error.code) === 404) {
      return res.status(404).json({ error: `Baseline ${req.params.id} not found.` });
    }
    if (error && typeof error === "object" && "code" in error && error.code === "VALIDATION_ERROR") {
      return res.status(400).json({
        error: "Invalid baseline patch payload.",
        details: Array.isArray(error.details) ? error.details : [String(error.message || error)],
      });
    }
    return res.status(500).json({ error: "Failed to update baseline." });
  }
});

app.delete("/api/baselines/:id", async (req, res) => {
  try {
    const readiness = await ensureCosmosBaselinesReady();
    if (!readiness.ok) {
      return res.status(readiness.status).json(readiness.body);
    }
    const id = normalizeBaselineId(decodeURIComponent(String(req.params.id || "")));
    if (!id) {
      return res.status(400).json({ error: "id is required." });
    }

    await deleteBaseline(id);
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Baselines DELETE error", error);
    if (isCosmosUnavailableError(error)) {
      return res.status(503).json({ error: "Cosmos unavailable for baselines." });
    }
    const code = error && typeof error === "object" && "code" in error ? Number(error.code) : undefined;
    if (code === 404) {
      return res.status(404).json({ error: `Baseline ${req.params.id} not found.` });
    }
    return res.status(500).json({ error: "Failed to delete baseline." });
  }
});

app.post("/api/baselines/reset", async (_req, res) => {
  try {
    const readiness = await ensureCosmosBaselinesReady();
    if (!readiness.ok) {
      return res.status(readiness.status).json(readiness.body);
    }
    const result = await resetBaselines({ seed: true });
    return res.status(200).json({
      ok: true,
      deleted: result.deleted,
      seeded: result.seeded,
      players: await getAllBaselines(),
    });
  } catch (error) {
    console.error("Baselines reset error", error);
    if (isCosmosUnavailableError(error)) {
      return res.status(503).json({ error: "Cosmos unavailable for baselines." });
    }
    return res.status(500).json({ error: "Failed to reset baselines." });
  }
});

app.post("/api/router", async (req, res) => {
  if (!ensureBackendLoaded(res)) return;
  try {
    const validated = backend.validateOrchestrateRequest(req.body);
    if (!validated.ok) {
      return res.status(400).json({ error: validated.message });
    }
    const mode = validated.value.mode === "full" ? "full" : "auto";
    const decision = backend.buildRouterDecision(mode, validated.value);
    return res.status(200).json({
      intent: decision.intent,
      run: {
        fatigue: decision.selectedAgents.includes("fatigue"),
        risk: decision.selectedAgents.includes("risk"),
        tactical: decision.selectedAgents.includes("tactical"),
      },
      selectedAgents: decision.selectedAgents,
      reason: decision.reason,
      signals: decision.signals,
    });
  } catch (error) {
    console.error("Router error", error);
    return res.status(500).json({ error: "Router failed" });
  }
});

app.post("/api/agents/fatigue", async (req, res) => {
  if (!ensureBackendLoaded(res)) return;
  try {
    const input = sanitizeFatigueRequest(req.body);
    const result = await backend.runFatigueAgent(input);
    const response = {
      ...result.output,
      status: result.output.status || (result.fallbacksUsed.length > 0 ? "fallback" : "ok"),
    };
    return res.status(200).json({
      ...response,
      meta: {
        model: result.model,
        fallbacksUsed: result.fallbacksUsed,
      },
    });
  } catch (error) {
    console.error("Fatigue agent error", error);
    return res.status(400).json({ error: "Invalid request payload" });
  }
});

app.post("/api/agents/risk", async (req, res) => {
  if (!ensureBackendLoaded(res)) return;
  try {
    const input = sanitizeRiskRequest(req.body);
    const result = await backend.runRiskAgent(input);
    const response = {
      ...result.output,
      status: result.output.status || (result.fallbacksUsed.length > 0 ? "fallback" : "ok"),
    };
    return res.status(200).json({
      ...response,
      meta: {
        model: result.model,
        fallbacksUsed: result.fallbacksUsed,
      },
    });
  } catch (error) {
    console.error("Risk agent error", error);
    return res.status(400).json({ error: "Invalid request payload" });
  }
});

app.post("/api/agents/tactical", async (req, res) => {
  if (!ensureBackendLoaded(res)) return;
  try {
    const validated = backend.validateTacticalRequest(req.body);
    if (!validated.ok) {
      return res.status(400).json({ error: validated.message });
    }
    const tacticalInput = {
      ...validated.value,
      requestId: validated.value.requestId || randomUUID(),
    };
    const result = await backend.runTacticalAgent(tacticalInput);
    const aoai = backend.getAoaiConfig();
    return res.status(200).json({
      ...result.output,
      meta: {
        requestId: tacticalInput.requestId,
        model: result.model,
        fallbacksUsed: result.fallbacksUsed,
        ...(aoai.ok ? {} : { aoai: { missing: aoai.missing } }),
      },
    });
  } catch (error) {
    console.error("Tactical agent error", error);
    return res.status(400).json({ error: "Invalid request payload" });
  }
});

app.post("/api/orchestrate", async (req, res) => {
  if (!ensureBackendLoaded(res)) return;
  try {
    const rawPayload = isRecord(req.body) ? req.body : {};
    const payload = await applyStoredBaselineToPayload(rawPayload);
    const missingEnv = getMissingAzureEnvVars();
    const missingRequestFields = getMissingOrchestrateFields(payload);
    const hasMinimalPayload = (typeof payload.text === "string" && payload.text.trim().length > 0) || hasAnyKeys(payload.signals);
    const hasFullPayload = payload.telemetry !== undefined && payload.matchContext !== undefined && payload.players !== undefined;

    if (!hasMinimalPayload && !hasFullPayload) {
      return res.status(400).json({
        error: "Invalid orchestrate payload",
        message: "Provide minimal payload { text, mode, signals } or full payload { telemetry, matchContext, players }.",
        missingFields: missingRequestFields,
        missingEnv,
      });
    }

    if (missingEnv.length > 0) {
      return res.status(400).json({
        error: "Missing Azure OpenAI environment variables",
        missingEnv,
        missingFields: missingRequestFields,
      });
    }

    const validated = backend.validateOrchestrateRequest(payload);
    if (!validated.ok) {
      return res.status(400).json({
        error: validated.message,
        missingFields: missingRequestFields,
        missingEnv,
      });
    }

    const result = await backend.orchestrateAgents(validated.value, createInvocationContext());
    return res.status(Array.isArray(result.errors) && result.errors.length > 0 ? 207 : 200).json(result);
  } catch (error) {
    console.error("Orchestrator error", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/api/messages", async (req, res) => {
  if (!isBotEnabled) {
    return res.status(501).json({
      error: "Bot disabled",
      message: "Set ENABLE_BOT=true to enable Bot Framework runtime.",
    });
  }
  if (botRuntimeLoadError || !adapter || !bot) {
    return res.status(500).json({
      error: "Bot runtime unavailable",
      details: botRuntimeLoadError ? String(botRuntimeLoadError.message || botRuntimeLoadError) : "missing adapter/bot",
    });
  }
  try {
    await adapter.process(req, res, async (context) => {
      await bot.run(context);
    });
  } catch (err) {
    console.error("Bot Framework /api/messages error", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Bot runtime error" });
    }
  }
});

app.use("/api", (_req, res) => {
  res.status(404).json({ error: "API route not found." });
});

/* STATIC FILES */
const distPath = path.join(__dirname, "dist");
app.use(express.static(distPath));

/* SPA FALLBACK (ONLY FOR NON-API ROUTES) */
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api")) return next();
  res.sendFile(path.join(distPath, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
