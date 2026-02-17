const express = require("express");
const path = require("path");
const fs = require("fs");
const { demoAgentMiddleware } = require("./middleware/demoAgentMiddleware");

const app = express();
const PORT = process.env.PORT || 8080;
const NODE_ENV = process.env.NODE_ENV || "development";

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

// Agent endpoint with demo mode support:
// - /api/agents/fatigue?demo=true  -> mock fatigue response
// - /api/agents/risk?demo=true     -> mock risk response
// - /api/agents/tactical?demo=true -> mock tactical response
// Without demo mode, this calls a real agent backend if AGENTS_BASE_URL is configured.
app.post("/api/agents/:agent", demoAgentMiddleware, async (req, res) => {
  try {
    const baseUrl = process.env.AGENTS_BASE_URL;
    if (!baseUrl) {
      return res.status(503).json({
        error: "Real agent backend not configured",
        hint: "Set AGENTS_BASE_URL or use ?demo=true",
      });
    }

    const agent = encodeURIComponent(String(req.params.agent || "").toLowerCase());
    const upstream = `${baseUrl.replace(/\/$/, "")}/api/agents/${agent}`;
    const response = await fetch(upstream, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body || {}),
    });

    const text = await response.text();
    if (!response.ok) {
      return res.status(response.status).json({
        error: "Real agent request failed",
        upstream,
        details: text,
      });
    }

    try {
      return res.status(200).json(JSON.parse(text));
    } catch {
      return res.status(200).send(text);
    }
  } catch (error) {
    return res.status(500).json({
      error: "Unhandled real-agent call failure",
      message: error?.message || String(error),
    });
  }
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
  console.log(`[server] Listening on port ${PORT} (NODE_ENV=${NODE_ENV})`);
});
