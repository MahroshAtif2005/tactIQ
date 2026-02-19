const express = require("express");
const path = require("path");
const fs = require("fs");
const { demoAgentMiddleware, mockAgentResponses } = require("./middleware/demoAgentMiddleware");

const app = express();
const PORT = process.env.PORT || 8080;
const AGENTS_BASE_URL = process.env.AGENTS_BASE_URL || "";

app.use(express.json({ limit: "1mb" }));

const safeParseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

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
    const trimmed = text.trim();
    const parsed = trimmed ? safeParseJson(trimmed) : {};

    if (!response.ok) {
      return res.status(response.status).json({
        error: "upstream_request_failed",
        upstream,
        details: parsed ?? trimmed,
      });
    }

    if (parsed === null) {
      return res.status(502).json({
        error: "upstream_non_json",
        message: "Upstream API returned non-JSON response.",
        upstream,
        preview: trimmed.slice(0, 250),
      });
    }

    return res.status(response.status).json(parsed);
  } catch {
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
        "Reassess after next over.",
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
    combinedDecision:
      mode === "full" && tactical
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
              "Re-check telemetry after next over.",
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

// ---------- API ROUTES FIRST ----------
app.get("/api/health", (_req, res) => {
  return res.status(200).json({
    status: "ok",
    service: "tactiq-server",
    upstreamProxyEnabled: Boolean(AGENTS_BASE_URL),
  });
});

app.post("/api/orchestrate", async (req, res) => {
  try {
    const upstream = await proxyToUpstream(req, res, "/api/orchestrate");
    if (upstream) return upstream;
    return res.status(200).json(buildLocalOrchestrateResponse(req.body || {}));
  } catch (err) {
    return res.status(500).json({
      error: "orchestrate_failed",
      message: err?.message || String(err),
    });
  }
});

app.post("/api/tactical", async (req, res) => {
  const upstream = await proxyToUpstream(req, res, "/api/tactical");
  if (upstream) return upstream;
  return res.status(200).json(getLocalAgentResponse("tactical"));
});

app.post("/api/agents/:agent", demoAgentMiddleware, async (req, res) => {
  const agent = encodeURIComponent(String(req.params.agent || "").toLowerCase());
  const upstream = await proxyToUpstream(req, res, `/api/agents/${agent}`);
  if (upstream) return upstream;

  const local = getLocalAgentResponse(agent) || mockAgentResponses[String(agent).toLowerCase()];
  if (!local) {
    return res.status(404).json({
      error: `unknown_agent_${agent}`,
      availableAgents: ["fatigue", "risk", "tactical"],
    });
  }
  return res.status(200).json(local);
});

// Optional platform health endpoint.
app.get("/health", (_req, res) => {
  return res.status(200).json({ status: "ok" });
});

// ---------- STATIC SERVING ----------
const distPath = path.join(__dirname, "dist");
const indexFile = path.join(distPath, "index.html");

if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
}

// ---------- SPA FALLBACK (MUST SKIP /api) ----------
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api")) return next();
  if (fs.existsSync(indexFile)) return res.sendFile(indexFile);
  return res.status(404).send("Not found");
});

// ---------- API 404 SAFETY ----------
app.use("/api", (_req, res) =>
  res.status(404).json({ error: "api_not_found" })
);

// Basic error logging middleware.
app.use((err, req, res, _next) => {
  console.error("[server] Unhandled error", {
    path: req.path,
    method: req.method,
    message: err?.message || String(err),
  });
  res.status(500).json({ error: "internal_server_error" });
});

app.listen(PORT, () => {
  console.log(`[server] listening on ${PORT}`);
});
