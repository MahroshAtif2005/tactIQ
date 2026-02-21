const express = require("express");
const path = require("path");
const { randomUUID } = require("crypto");
const { execSync } = require("child_process");
require("dotenv").config();

let adapter = null;
let bot = null;
let botRuntimeLoadError = null;
try {
  ({ adapter } = require("./server/bot/adapter"));
  ({ bot } = require("./server/bot/TactIQBot"));
} catch (error) {
  botRuntimeLoadError = error;
  console.error("Bot runtime modules unavailable:", error.message);
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

  return {
    playerId: String(payload.playerId || "UNKNOWN"),
    playerName: String(payload.playerName || "Unknown Player"),
    role: String(payload.role || "Unknown Role"),
    oversBowled: Math.max(0, toNum(payload.oversBowled, 0)),
    consecutiveOvers: Math.max(0, toNum(payload.consecutiveOvers, 0)),
    fatigueIndex: Math.max(0, Math.min(10, toNum(payload.fatigueIndex, 3))),
    injuryRisk: toRisk(payload.injuryRisk, "MEDIUM"),
    noBallRisk: toRisk(payload.noBallRisk, "MEDIUM"),
    heartRateRecovery: String(payload.heartRateRecovery || "Moderate"),
    fatigueLimit: Math.max(0, toNum(payload.fatigueLimit, 6)),
    sleepHours: Math.max(0, toNum(payload.sleepHours, 7)),
    recoveryMinutes: Math.max(0, toNum(payload.recoveryMinutes, 0)),
    snapshotId: String(payload.snapshotId || ""),
    matchContext: {
      format: String(payload.matchContext?.format || "T20"),
      phase: String(payload.matchContext?.phase || "Middle"),
      over: toNum(payload.matchContext?.over, 0),
      intensity: String(payload.matchContext?.intensity || "Medium"),
    },
  };
};

const sanitizeRiskRequest = (payload = {}) => ({
  playerId: String(payload.playerId || "UNKNOWN"),
  fatigueIndex: Math.max(0, Math.min(10, toNum(payload.fatigueIndex, 0))),
  injuryRisk: String(payload.injuryRisk || "LOW").toUpperCase(),
  noBallRisk: String(payload.noBallRisk || "LOW").toUpperCase(),
  oversBowled: Math.max(0, toNum(payload.oversBowled, 0)),
  consecutiveOvers: Math.max(0, toNum(payload.consecutiveOvers, 0)),
  heartRateRecovery: payload.heartRateRecovery ? String(payload.heartRateRecovery) : undefined,
  format: String(payload.format || payload.match?.format || "T20"),
  phase: String(payload.phase || payload.match?.phase || "Middle"),
  intensity: String(payload.intensity || payload.match?.intensity || "Medium"),
  conditions: payload.conditions ? String(payload.conditions) : payload.match?.conditions ? String(payload.match.conditions) : undefined,
  target: Number.isFinite(toNum(payload.target, NaN)) ? toNum(payload.target, 0) : undefined,
  score: Number.isFinite(toNum(payload.score, NaN)) ? toNum(payload.score, 0) : undefined,
  over: Number.isFinite(toNum(payload.over, NaN)) ? toNum(payload.over, 0) : undefined,
  balls: Number.isFinite(toNum(payload.balls, NaN)) ? toNum(payload.balls, 0) : undefined,
});

/* API ROUTES FIRST */
app.get("/api/health", (_req, res) => {
  const aoai = backend?.getAoaiConfig ? backend.getAoaiConfig() : { ok: false, missing: ["api-dist-not-loaded"] };
  res.json({
    status: "ok",
    service: "tactiq-express",
    timestamp: new Date().toISOString(),
    routes: ["/api/health", "/api/router", "/api/agents/fatigue", "/api/agents/risk", "/api/agents/tactical", "/api/orchestrate", "/api/messages"],
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
    const validated = backend.validateOrchestrateRequest(req.body);
    if (!validated.ok) {
      return res.status(400).json({ error: validated.message });
    }
    const result = await backend.orchestrateAgents(validated.value, createInvocationContext());
    return res.status(Array.isArray(result.errors) && result.errors.length > 0 ? 207 : 200).json(result);
  } catch (error) {
    console.error("Orchestrator error", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/api/messages", async (req, res) => {
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
