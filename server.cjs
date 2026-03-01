const express = require("express");
const path = require("path");

const shouldServeSpa = String(process.env.SERVE_SPA || "false").trim().toLowerCase() === "true";
const port = Number(process.env.SPA_PORT || 4173);

if (!shouldServeSpa) {
  console.log(`[BOOT] SPA server disabled; delegating to API server entrypoint (server.js) file: ${__filename}`);
  // Keep a single API implementation source of truth if this file is started by mistake.
  require("./server.js");
  return;
}

const app = express();

const distPath = path.join(__dirname, "dist");
app.use(express.static(distPath));

app.get("*", (req, res) => {
  res.sendFile(path.join(distPath, "index.html"));
});

app.listen(port, () => {
  console.log(`[BOOT] SPA server on ${port} file: ${__filename}`);
});
