const express = require("express");
const path = require("path");
const fs = require("fs");
const { demoAgentMiddleware, mockAgentResponses } = require("./middleware/demoAgentMiddleware");

const app = express();
const PORT = process.env.PORT || 8080;
const NODE_ENV = process.env.NODE_ENV || "development";
const AGENTS_BASE_URL = process.env.AGENTS_BASE_URL || "";

app.use(express.json());

// Lightweight health check:
// Keep this endpoint dependency-free (no DB/Azure/external calls) so probes stay fast and reliable.
app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

async function proxyToUpstream(req, res, upstreamPath) {
  if (!AGENTS_BASE_URL) {
    return null;
  }

  try {
    const base = AGENTS_BASE_URL.replace(/\/$/, "");
    const query = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    const upstream = `${base}${upstreamPath}${query}`;
    const hasBody = req.method !== "GET" && req.method !== "HEAD";

    const response = await fetch(upstream, {
      method: req.method,
      headers: { "Content-Type": "application/json" },
      ...(hasBody ? { body: JSON.stringify(req.body || {}) } : {}),
    });

    const text = await response.text();
    if (!response.ok) {
      return res.status(response.status).json({
        error: "Upstream API request failed",
        upstream,
        details: text,
      });
    }

    try {
      return res.status(response.status).json(JSON.parse(text));
    } catch {
      return res.status(response.status).send(text);
    }
  } catch (error) {
    return null;
  }
}

function getLocalAgentResponse(agent) {
  const key = String(agent || "").toLowerCase();
  if (key === "fatigue") {
    return {
      severity: "MED",
      headline: "Fatigue Trend Rising",
      explanation: "Workload and consecutive overs are pushing fatigue above baseline tolerance.",
      recommendation: "Rotate within the next over and reduce intensity for recovery window.",
      signals: ["FATIGUE_RISING", "SPELL_LOAD", "CONSEC_OVERS"],
      echo: {
        fatigueIndex: 6.2,
        injuryRisk: "MED",
        noBallRisk: "LOW",
        oversBowled: 4,
        consecutiveOvers: 2,
      },
    };
  }
  if (key === "risk") {
    return {
      agent: "risk",
      severity: "HIGH",
      riskScore: 8,
      headline: "High Composite Risk",
      explanation: "Composite risk is elevated due to control risk, spell load, and match pressure.",
      recommendation: "Avoid high-pressure overs now; substitute or rest immediately.",
      signals: ["CONTROL_RISK", "SPELL_LOAD", "CHASE_PRESSURE"],
      echo: {
        fatigueIndex: 6.2,
        injuryRisk: "HIGH",
        noBallRisk: "MED",
        oversBowled: 4,
        consecutiveOvers: 2,
      },
    };
  }
  if (key === "tactical") {
    return {
      immediateAction: "Rotate bowler and tighten boundary field",
      rationale: "Current pressure profile favors control over attacking variance.",
      suggestedAdjustments: [
        "Use variation-heavy over plan.",
        "Protect square boundaries with deep fielders.",
        "Reassess after next over."
      ],
      confidence: 0.74,
      keySignalsUsed: ["PHASE_PRESSURE", "SPELL_LOAD", "CONTROL_RISK"],
    };
  }
  return null;
}

function buildLocalOrchestrateResponse(body) {
  const mode = body?.mode === "full" ? "full" : "auto";
  const fatigue = getLocalAgentResponse("fatigue");
  const risk = getLocalAgentResponse("risk");
  const tactical = getLocalAgentResponse("tactical");
  const executedAgents = mode === "full" ? ["fatigue", "risk", "tactical"] : ["fatigue", "risk"];

  return {
    ...(fatigue ? { fatigue } : {}),
    ...(risk ? { risk } : {}),
    ...(mode === "full" && tactical ? { tactical } : {}),
    combinedDecision: mode === "full" && tactical
      ? {
          immediateAction: tactical.immediateAction,
          substitutionAdvice: null,
          suggestedAdjustments: tactical.suggestedAdjustments,
          confidence: tactical.confidence,
          rationale: tactical.rationale,
        }
      : {
          immediateAction: "Monitor fatigue and risk in next over",
          substitutionAdvice: null,
          suggestedAdjustments: [
            "Keep current plan with controlled intensity.",
            "Re-check telemetry after next over."
          ],
          confidence: 0.62,
          rationale: "Derived from local fatigue and risk summaries.",
        },
    errors: [],
    meta: {
      mode,
      executedAgents,
      requestId: `local-${Date.now()}`,
      modelRouting: {
        fatigueModel: "local-rule",
        riskModel: "local-rule",
        tacticalModel: mode === "full" ? "local-rule" : "n/a",
        fallbacksUsed: ["local-dev-fallback"],
      },
      timingsMs: {
        fatigue: 2,
        risk: 1,
        ...(mode === "full" ? { tactical: 1 } : {}),
        total: 4,
      },
    },
  };
}

// Agent endpoint with demo mode support:
// - /api/agents/fatigue?demo=true  -> mock fatigue response
// - /api/agents/risk?demo=true     -> mock risk response
// - /api/agents/tactical?demo=true -> mock tactical response
// Without demo mode, this calls upstream Azure Functions backend.
app.post("/api/agents/:agent", demoAgentMiddleware, async (req, res) => {
  const agent = encodeURIComponent(String(req.params.agent || "").toLowerCase());
  const upstream = await proxyToUpstream(req, res, `/api/agents/${agent}`);
  if (upstream) return upstream;

  const local = getLocalAgentResponse(agent) || mockAgentResponses[String(agent).toLowerCase()];
  if (!local) {
    return res.status(404).json({
      error: `Unknown local agent '${agent}'`,
      availableAgents: ["fatigue", "risk", "tactical"],
    });
  }
  return res.status(200).json(local);
});

app.post("/api/orchestrate", async (req, res) => {
  const upstream = await proxyToUpstream(req, res, "/api/orchestrate");
  if (upstream) return upstream;
  return res.status(200).json(buildLocalOrchestrateResponse(req.body || {}));
});

app.post("/api/tactical", async (req, res) => {
  const upstream = await proxyToUpstream(req, res, "/api/tactical");
  if (upstream) return upstream;
  return res.status(200).json(getLocalAgentResponse("tactical"));
});

app.get("/api/health", async (req, res) => {
  const upstream = await proxyToUpstream(req, res, "/api/health");
  if (upstream) return upstream;
  return res.status(200).json({
    status: "ok",
    service: "tactiq-server",
    upstreamProxyEnabled: Boolean(AGENTS_BASE_URL),
    timestamp: new Date().toISOString(),
  });
});

// Forward all other API routes (e.g. /api/orchestrate, /api/tactical) to upstream backend.
app.all("/api/*", async (req, res) => {
  const upstream = await proxyToUpstream(req, res, req.path);
  if (upstream) return upstream;
  return res.status(404).json({ error: `Unknown API route: ${req.path}` });
});

const distPath = path.join(__dirname, "dist");
const canServeDist = NODE_ENV === "production" && fs.existsSync(distPath);

if (canServeDist) {
  app.use(express.static(distPath));

  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    return res.sendFile(path.join(distPath, "index.html"));
  });
} else {
  app.get("/", (_req, res) => {
    res.status(200).send("tactIQ server is running.");
  });
}

// Basic error logging middleware.
app.use((err, req, res, _next) => {
  console.error("[server] Unhandled error", {
    path: req.path,
    method: req.method,
    message: err?.message || String(err),
  });
  res.status(500).json({ error: "Internal Server Error" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[server] API listening on http://localhost:${PORT} (NODE_ENV=${NODE_ENV})`);
  console.log(`[server] Health: http://localhost:${PORT}/health`);
  if (AGENTS_BASE_URL) {
    console.log(`[server] Upstream proxy enabled -> ${AGENTS_BASE_URL}`);
  } else {
    console.log("[server] Upstream proxy disabled. Using local dev API fallbacks.");
  }
});
