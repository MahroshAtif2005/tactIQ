const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());

/* API ROUTES FIRST */
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/api/orchestrate", (req, res) => {
  try {
    // TODO: replace with real orchestrator logic
    return res.json({
      success: true,
      message: "Orchestrator working in production"
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
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
