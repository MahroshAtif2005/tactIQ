const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(express.json({ limit: "1mb" }));

// ---- LOG REQUESTS FOR DEBUG ON AZURE ----
app.use((req, _res, next) => {
  console.log(`[req] ${req.method} ${req.url}`);
  next();
});

// ---- API FIRST ----
app.get("/api/health", (_req, res) => {
  res.status(200).json({ status: "ok", env: process.env.NODE_ENV || "unknown" });
});

app.post("/api/orchestrate", async (req, res) => {
  try {
    const mode = req.body?.mode === "full" ? "full" : "auto";
    return res.status(200).json({
      ok: true,
      mode: "fallback",
      message: "orchestrate route hit (JSON)",
      input: req.body ?? null,
      combinedDecision: {
        immediateAction: "Continue with monitored plan",
        substitutionAdvice: null,
        suggestedAdjustments: [
          "Backend route is correctly mounted.",
          "Wire Azure OpenAI later if needed.",
        ],
        confidence: 0.64,
        rationale: "Fallback response confirms production API route and JSON pipeline are working.",
      },
      errors: [],
      meta: {
        requestId: `fallback-${Date.now()}`,
        mode,
        executedAgents: [],
        modelRouting: {
          fatigueModel: "fallback",
          riskModel: "fallback",
          tacticalModel: "fallback",
          fallbacksUsed: ["orchestrate-route-fallback"],
        },
        usedFallbackAgents: [],
        timingsMs: {
          total: 1,
        },
      },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "orchestrate_failed", message: e?.message || String(e) });
  }
});

// ---- STATIC UI ----
const distPath = path.join(__dirname, "dist");
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
}

// ---- SPA FALLBACK (SKIP /api) ----
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api")) return next();
  const indexFile = path.join(distPath, "index.html");
  if (fs.existsSync(indexFile)) return res.sendFile(indexFile);
  return res.status(404).send("Not found");
});

// ---- API 404 GUARANTEE ----
app.use("/api", (_req, res) => res.status(404).json({ error: "api_not_found" }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`[server] listening on ${PORT}`);
  console.log(`[server] NODE_ENV=${process.env.NODE_ENV || "unknown"}`);
  console.log(`[server] distPath=${distPath} exists=${fs.existsSync(distPath)}`);
});
