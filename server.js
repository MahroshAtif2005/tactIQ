const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || "development";

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
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
