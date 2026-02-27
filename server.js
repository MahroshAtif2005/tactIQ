const express = require("express");
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { execSync } = require("child_process");
const dotenv = require("dotenv");
const {
  normalizeFullMatchContext,
  buildContextSummary,
  compactContextForPrompt,
  pickReplacementCandidates,
} = require("./server/lib/matchContext");
let OpenAI = null;
try {
  // eslint-disable-next-line global-require
  OpenAI = require("openai").default;
} catch {
  OpenAI = null;
}
let CosmosClient = null;
try {
  // eslint-disable-next-line global-require
  ({ CosmosClient } = require("@azure/cosmos"));
} catch {
  CosmosClient = null;
}
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

const rootEnvPath = path.resolve(__dirname, ".env");
const agentFrameworkEnvPath = path.resolve(__dirname, "server/agent-framework/.env");
const loadedEnvFiles = [];
const loadEnvFile = (envPath) => {
  if (!fs.existsSync(envPath)) return false;
  const result = dotenv.config({ path: envPath, override: false });
  if (result.error) {
    console.warn(`[env] failed loading ${envPath}: ${result.error.message}`);
    return false;
  }
  loadedEnvFiles.push(envPath);
  return true;
};
const rootEnvLoaded = loadEnvFile(rootEnvPath);
const agentFrameworkEnvLoaded = loadEnvFile(agentFrameworkEnvPath);
const envLoaded = rootEnvLoaded || agentFrameworkEnvLoaded;
const loadedEnvPath = loadedEnvFiles.length > 0 ? loadedEnvFiles.join(",") : null;
const serverBootTimeMs = Date.now();

const requiredAzureEnvVars = [
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_DEPLOYMENT",
];
const isNonEmptyEnv = (value) => typeof value === "string" && value.trim().length > 0;
const applyEnvAlias = (canonicalKey, aliases) => {
  if (isNonEmptyEnv(process.env[canonicalKey])) return;
  for (const aliasKey of aliases) {
    if (!isNonEmptyEnv(process.env[aliasKey])) continue;
    process.env[canonicalKey] = String(process.env[aliasKey] || "").trim();
    return;
  }
};
// Normalize Cosmos env aliases once so downstream modules read a canonical set.
applyEnvAlias("COSMOS_ENDPOINT", ["AZURE_COSMOS_ENDPOINT"]);
applyEnvAlias("COSMOS_KEY", ["AZURE_COSMOS_KEY"]);
applyEnvAlias("COSMOS_DB", [
  "COSMOS_DATABASE",
  "AZURE_COSMOS_DATABASE",
  "COSMOS_DATABASE_NAME",
  "COSMOS_DATABASE_ID",
  "COSMOS_DB_NAME",
]);
applyEnvAlias("COSMOS_CONTAINER", [
  "AZURE_COSMOS_CONTAINER",
  "COSMOS_CONTAINER_NAME",
  "COSMOS_CONTAINER_ID",
  "COSMOS_CONTAINER_PLAYERS",
]);
const getAzureDeployment = () =>
  [
    process.env.AZURE_OPENAI_DEPLOYMENT,
    process.env.AZURE_OPENAI_MODEL,
    process.env.AOAI_DEPLOYMENT_STRONG,
    process.env.AOAI_DEPLOYMENT_FAST,
    process.env.AOAI_DEPLOYMENT_FALLBACK,
  ].find(isNonEmptyEnv) || "";
const getAzureApiVersion = () =>
  String(process.env.AZURE_OPENAI_API_VERSION || process.env.OPENAI_API_VERSION || "2024-02-15-preview");
const getMissingAzureEnvVars = () =>
  requiredAzureEnvVars.filter((name) => {
    if (name === "AZURE_OPENAI_DEPLOYMENT") return !isNonEmptyEnv(getAzureDeployment());
    return !isNonEmptyEnv(process.env[name]);
  });
const getAzureEnvPresence = () => ({
  endpointPresent: isNonEmptyEnv(process.env.AZURE_OPENAI_ENDPOINT),
  apiKeyPresent: isNonEmptyEnv(process.env.AZURE_OPENAI_API_KEY),
  deploymentPresent: isNonEmptyEnv(getAzureDeployment()),
  apiVersionPresent: isNonEmptyEnv(getAzureApiVersion()),
});
const isMockAllowed = () => String(process.env.ALLOW_MOCK || "false").trim().toLowerCase() === "true";
const isDebugContextEnabled = () => String(process.env.DEBUG_CONTEXT || "false").trim().toLowerCase() === "true";
const getMissingRequiredCosmosEnv = () =>
  ["COSMOS_ENDPOINT", "COSMOS_KEY", "COSMOS_DB", "COSMOS_CONTAINER"].filter(
    (name) => !isNonEmptyEnv(process.env[name])
  );
const getCosmosEndpointHost = () => {
  const rawEndpoint = String(process.env.COSMOS_ENDPOINT || process.env.AZURE_COSMOS_ENDPOINT || "").trim();
  if (!rawEndpoint) return "missing";
  try {
    return new URL(rawEndpoint).host || rawEndpoint;
  } catch {
    return rawEndpoint;
  }
};
const extractErrorCause = (error) => {
  if (!error) return null;
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && "message" in error) return String(error.message || "unknown error");
  return String(error);
};
const isConnectionRefusedError = (error) => {
  if (!error) return false;
  if (typeof error === "object" && "code" in error && String(error.code || "").toUpperCase() === "ECONNREFUSED") {
    return true;
  }
  if (typeof AggregateError !== "undefined" && error instanceof AggregateError && Array.isArray(error.errors)) {
    return error.errors.some((inner) => isConnectionRefusedError(inner));
  }
  if (typeof error === "object" && Array.isArray(error.errors)) {
    return error.errors.some((inner) => isConnectionRefusedError(inner));
  }
  const message = error instanceof Error ? error.message : String(error);
  return /ECONNREFUSED/i.test(message);
};
const getCosmosErrorStatusCode = (error, fallbackCode) => {
  if (fallbackCode === "COSMOS_NOT_CONFIGURED") return 503;
  if (isConnectionRefusedError(error)) return 503;
  return 500;
};
const getCosmosEnvStatus = () => ({
  endpoint: isNonEmptyEnv(process.env.COSMOS_ENDPOINT) ? "set" : "missing",
  db: isNonEmptyEnv(process.env.COSMOS_DB) ? "set" : "missing",
  container: isNonEmptyEnv(process.env.COSMOS_CONTAINER) ? "set" : "missing",
});
const buildCosmosNotConfiguredError = (missingRequired = getMissingRequiredCosmosEnv()) => ({
  ok: false,
  code: "COSMOS_NOT_CONFIGURED",
  message: `Missing ${missingRequired.join("/")}`,
  diagnostics: {
    envLoaded,
    requiredMissing: missingRequired,
    endpointHost: getCosmosEndpointHost(),
    db: process.env.COSMOS_DB || "",
    container: process.env.COSMOS_CONTAINER || "",
  },
});
const buildCosmosConnectionError = (error, fallbackMessage) => {
  const details = error && typeof error === "object" ? error : {};
  const codeValue = details && "code" in details ? details.code : null;
  return {
    ok: false,
    code: "COSMOS_CONNECTION_FAILED",
    message:
      typeof fallbackMessage === "string" && fallbackMessage.trim().length > 0
        ? fallbackMessage
        : error instanceof Error
          ? error.message
          : "Cosmos connection failed.",
    diagnostics: {
      endpointHost: getCosmosEndpointHost(),
      db: process.env.COSMOS_DB || "",
      container: process.env.COSMOS_CONTAINER || "",
      cause: extractErrorCause(error),
      errorName: error instanceof Error ? error.name : details && typeof details.name === "string" ? details.name : "Error",
      errorCode: codeValue === undefined ? null : codeValue,
    },
    env: getCosmosEnvStatus(),
  };
};
const formatProcessError = (error) => {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
    };
  }
  return { message: String(error) };
};

process.on("unhandledRejection", (reason) => {
  console.error("[PROCESS] unhandledRejection", formatProcessError(reason));
});

process.on("uncaughtException", (error) => {
  console.error("[PROCESS] uncaughtException", formatProcessError(error));
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
const firstNonEmpty = (...values) => {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const normalized = value.trim();
    if (normalized.length > 0) return normalized;
  }
  return "";
};
const getCosmosDbName = () =>
  firstNonEmpty(
    process.env.COSMOS_DB,
    process.env.COSMOS_DATABASE,
    process.env.COSMOS_DATABASE_NAME,
    process.env.COSMOS_DATABASE_ID,
    process.env.COSMOS_DB_NAME
  );
const getCosmosContainerName = () =>
  firstNonEmpty(
    process.env.COSMOS_CONTAINER,
    process.env.COSMOS_CONTAINER_NAME,
    process.env.COSMOS_CONTAINER_ID,
    process.env.COSMOS_CONTAINER_PLAYERS
  );
const getCosmosConnectionSettings = () => ({
  connectionString: firstNonEmpty(process.env.COSMOS_CONNECTION_STRING),
  endpoint: firstNonEmpty(process.env.COSMOS_ENDPOINT),
  key: firstNonEmpty(process.env.COSMOS_KEY),
  dbName: getCosmosDbName(),
  container: getCosmosContainerName(),
});
const getCorsOriginSet = () => {
  const defaultOrigins = [
    "http://localhost:5176",
    "http://127.0.0.1:5176",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:5177",
    "http://127.0.0.1:5177",
  ];
  const configuredOrigins = String(process.env.CORS_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  const deployedOrigins = [
    process.env.FRONTEND_ORIGIN,
    process.env.WEB_ORIGIN,
    process.env.VITE_FRONTEND_ORIGIN,
    process.env.APP_ORIGIN,
  ]
    .map((origin) => String(origin || "").trim())
    .filter((origin) => origin.length > 0);
  return new Set([...defaultOrigins, ...configuredOrigins, ...deployedOrigins]);
};
const corsOriginSet = getCorsOriginSet();
const isCorsOriginAllowed = (origin) => {
  if (!origin) return false;
  return corsOriginSet.has(origin);
};
const setCorsHeaders = (res, origin) => {
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
};
const normalizeEndpoint = (value) => String(value || "").trim().replace(/\/+$/, "");
const buildDeploymentBaseUrl = (endpoint, deployment) =>
  `${normalizeEndpoint(endpoint)}/openai/deployments/${deployment}`;
const buildOrchestrateError = (traceId, message, detail) => ({
  traceId,
  error: message,
  detail: String(detail || ""),
});
const setProofHeaders = (res, traceId, source) => {
  res.setHeader("X-Trace-Id", traceId);
  res.setHeader("X-Source", source);
};
const extractModelText = (content) => {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && typeof part.text === "string") return part.text;
      return "";
    })
    .join("")
    .trim();
};
const createAzureClient = () => {
  if (!OpenAI) {
    throw new Error("openai package is not installed");
  }
  const endpoint = normalizeEndpoint(process.env.AZURE_OPENAI_ENDPOINT || "");
  const apiKey = String(process.env.AZURE_OPENAI_API_KEY || "");
  const deployment = String(getAzureDeployment() || "");
  const apiVersion = getAzureApiVersion();
  return {
    endpoint,
    apiKey,
    deployment,
    apiVersion,
    client: new OpenAI({
      apiKey,
      baseURL: buildDeploymentBaseUrl(endpoint, deployment),
      defaultQuery: { "api-version": apiVersion },
      defaultHeaders: { "api-key": apiKey },
    }),
  };
};
const toLegacyAgent = (value) => {
  const token = String(value || "").trim().toUpperCase();
  if (token === "RISK") return "risk";
  if (token === "FATIGUE") return "fatigue";
  if (token === "TACTICAL") return "tactical";
  return null;
};
const getDecisionSelectedAgents = (decision) => {
  if (Array.isArray(decision?.selectedAgents)) {
    return decision.selectedAgents
      .map((value) => String(value || "").trim().toLowerCase())
      .filter((value) => value === "risk" || value === "fatigue" || value === "tactical");
  }
  if (Array.isArray(decision?.agentsToRun)) {
    return decision.agentsToRun
      .map((value) => toLegacyAgent(value))
      .filter((value) => value === "risk" || value === "fatigue" || value === "tactical");
  }
  return [];
};
const buildRouterProof = (decision, validated, fullContext) => {
  if (Array.isArray(decision?.rulesFired) && isRecord(decision?.inputsUsed)) {
    return {
      intent: String(decision?.intent || "GENERAL"),
      rulesFired: decision.rulesFired.map((rule) => String(rule)),
      inputsUsed: decision.inputsUsed,
    };
  }

  const signals = isRecord(decision?.signals) ? decision.signals : {};
  const match = fullContext?.match || {};
  const activeTelemetry = fullContext?.roster?.find((entry) => entry?.playerId === fullContext?.activePlayerId)?.live || {};
  const phase = String(signals.phase || match.phase || validated?.matchContext?.phase || "middle");
  const intensity = String(match.intensity || validated?.matchContext?.intensity || "Medium");
  const inputsUsed = {
    fatigueIndex: Number(
      activeTelemetry.fatigueIndex || signals.fatigueIndex || validated?.telemetry?.fatigueIndex || 0
    ),
    injuryRisk: String(
      activeTelemetry.injuryRisk || signals.injuryRisk || validated?.telemetry?.injuryRisk || "UNKNOWN"
    ).toUpperCase(),
    noBallRisk: String(
      activeTelemetry.noBallRisk || signals.noBallRisk || validated?.telemetry?.noBallRisk || "UNKNOWN"
    ).toUpperCase(),
    oversBowled: Number(signals.oversBowled || validated?.telemetry?.oversBowled || 0),
    oversRemaining: Number(signals.oversRemaining || validated?.telemetry?.oversRemaining || 0),
    maxOvers: Number(signals.maxOvers || validated?.telemetry?.maxOvers || 0),
    quotaComplete: Boolean(signals.quotaComplete || validated?.telemetry?.quotaComplete),
    phase,
    intensity,
    requiredRunRate: Number(validated?.matchContext?.requiredRunRate || 0),
    currentRunRate: Number(validated?.matchContext?.currentRunRate || 0),
    wicketsInHand: Number(signals.wicketsInHand || validated?.matchContext?.wicketsInHand || 0),
    rosterCount: Array.isArray(fullContext?.roster) ? fullContext.roster.length : 0,
    scoreRuns: Number(match.scoreRuns || validated?.matchContext?.score || 0),
    wickets: Number(match.wickets || 0),
    targetRuns: Number(match.targetRuns || validated?.matchContext?.target || 0),
    requestedIntent: String(validated?.intent || "monitor"),
  };
  const rulesFired = [];
  if (inputsUsed.quotaComplete) rulesFired.push("quotaComplete");
  if (inputsUsed.injuryRisk === "HIGH" || inputsUsed.injuryRisk === "CRITICAL") rulesFired.push("injuryHigh");
  if (inputsUsed.noBallRisk === "HIGH") rulesFired.push("noBallHigh");
  if (inputsUsed.fatigueIndex >= 6) rulesFired.push("fatigue>=6");
  if (String(inputsUsed.phase).toLowerCase() === "powerplay" && inputsUsed.fatigueIndex >= 5) {
    rulesFired.push("powerplayConservative");
  }
  if (inputsUsed.oversRemaining <= 1) rulesFired.push("oversRemaining<=1");
  if (inputsUsed.requiredRunRate > inputsUsed.currentRunRate) rulesFired.push("requiredRunRate>currentRunRate");
  if (String(inputsUsed.phase).toLowerCase() === "death" && inputsUsed.requiredRunRate > inputsUsed.currentRunRate) {
    rulesFired.push("deathOversChasePressure");
  }
  rulesFired.push(`route:${String(decision?.intent || "GENERAL")}`);
  return {
    intent: String(decision?.intent || "GENERAL"),
    rulesFired,
    inputsUsed,
  };
};
const normalizeAgentStatus = (value) => {
  const normalized = String(value || "").trim().toUpperCase();
  if (normalized === "DONE") return "OK";
  if (normalized === "IDLE") return "SKIPPED";
  return normalized || "OK";
};
const deriveAgentStatus = (result, agent) => {
  const status = result?.agentResults?.[agent]?.status;
  if (typeof status === "string") return normalizeAgentStatus(status);
  if (Array.isArray(result?.meta?.executedAgents) && !result.meta.executedAgents.includes(agent)) return "SKIPPED";
  if (Array.isArray(result?.errors) && result.errors.some((entry) => entry?.agent === agent)) return "ERROR";
  return "OK";
};
const sanitizeErrorMessage = (error) => {
  const raw = error instanceof Error ? error.message : String(error || "unknown error");
  return raw.replace(/\s+/g, " ").trim().slice(0, 220);
};
const withTimeout = async (promise, timeoutMs, label) => {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};
const normalizeRiskToken = (value) => {
  const token = String(value || "").trim().toUpperCase();
  if (token === "HIGH" || token === "CRITICAL") return "HIGH";
  if (token === "MED" || token === "MEDIUM") return "MEDIUM";
  return "LOW";
};
const toLegacyAgentFromCode = (code) => {
  const token = String(code || "").trim().toUpperCase();
  if (token === "RISK") return "risk";
  if (token === "FATIGUE") return "fatigue";
  if (token === "TACTICAL") return "tactical";
  return null;
};
const toAgentCode = (legacy) => {
  const token = String(legacy || "").trim().toLowerCase();
  if (token === "risk") return "RISK";
  if (token === "fatigue") return "FATIGUE";
  return "TACTICAL";
};
const normalizeSelectedLegacyAgents = (inputAgents, forceAll) => {
  const normalized = Array.isArray(inputAgents)
    ? inputAgents
        .map((agent) => String(agent || "").trim().toLowerCase())
        .filter((agent) => agent === "fatigue" || agent === "risk" || agent === "tactical")
    : [];
  const set = new Set(normalized);
  if (forceAll) {
    set.add("fatigue");
    set.add("risk");
  }
  set.add("tactical");
  return ["fatigue", "risk", "tactical"].filter((agent) => set.has(agent));
};
const buildDeterministicRouterDecision = (mode, validatedValue) => {
  const fatigueIndex = Number(validatedValue?.telemetry?.fatigueIndex || 0);
  const strainIndex = Number(validatedValue?.telemetry?.strainIndex || 0);
  const oversBowled = Number(validatedValue?.telemetry?.oversBowled || 0);
  const injuryRisk = normalizeRiskToken(validatedValue?.telemetry?.injuryRisk);
  const noBallRisk = normalizeRiskToken(validatedValue?.telemetry?.noBallRisk);
  const selected = new Set(["tactical"]);
  const triggers = [];

  if (fatigueIndex >= 5 || strainIndex >= 3 || oversBowled >= 2) {
    selected.add("fatigue");
    triggers.push("fatigue_or_workload_signal");
  }
  if (injuryRisk !== "LOW" || noBallRisk !== "LOW" || fatigueIndex >= 6 || strainIndex >= 4) {
    selected.add("risk");
    triggers.push("risk_or_control_signal");
  }
  triggers.push("tactical_always_on");
  if (mode === "full") {
    selected.add("fatigue");
    selected.add("risk");
    triggers.push("full_mode_forced_all_agents");
  }

  let intent = "Monitor";
  if (noBallRisk !== "LOW") intent = "Control No-Balls";
  else if (injuryRisk !== "LOW") intent = "Injury Prevention";
  else if (fatigueIndex >= 5) intent = "Workload Control";

  const selectedAgents = ["fatigue", "risk", "tactical"].filter((agent) => selected.has(agent));
  return {
    intent,
    agentsToRun: selectedAgents.map((agent) => toAgentCode(agent)),
    selectedAgents,
    rulesFired: triggers,
    inputsUsed: {
      activePlayerId: String(validatedValue?.telemetry?.playerId || ""),
      active: {
        fatigueIndex,
        strainIndex,
        injuryRisk,
        noBallRisk,
      },
      match: {
        matchMode: String(validatedValue?.matchContext?.matchMode || validatedValue?.matchContext?.teamMode || ""),
        format: String(validatedValue?.matchContext?.format || ""),
        phase: String(validatedValue?.matchContext?.phase || ""),
        overs: Number(validatedValue?.matchContext?.overs || 0),
        balls: Number(validatedValue?.matchContext?.balls || 0),
        scoreRuns: Number(validatedValue?.matchContext?.score || 0),
        wickets: Number(validatedValue?.matchContext?.wickets || 0),
        targetRuns: Number(validatedValue?.matchContext?.target || 0),
        intensity: String(validatedValue?.matchContext?.intensity || ""),
      },
    },
    reason: "Routing: rules-based (safe fallback)",
    signals: {
      fatigueIndex,
      strainIndex,
      injuryRisk,
      noBallRisk,
      oversBowled,
    },
  };
};
const callAzureProof = async ({ traceId, payload, routerProof, compactContext, replacementCandidates }) => {
  const { client, deployment, apiVersion } = createAzureClient();
  const startedAt = Date.now();
  console.log(`[orchestrate:${traceId}] azure start`, { deployment, apiVersion });
  const request = client.chat.completions.create({
    model: deployment,
    temperature: 0.1,
    max_tokens: 280,
    messages: [
      {
        role: "system",
        content:
          `TRACE_NONCE: ${traceId}\n` +
          "You are the tactIQ combined coach model. Return plain text with two sections: " +
          "RISK_AGENT and TACTICAL_AGENT. Keep it concise.",
      },
      {
        role: "user",
        content: JSON.stringify({
          traceId,
          routerIntent: routerProof.intent,
          rulesFired: routerProof.rulesFired,
          telemetry: payload.telemetry,
          matchContext: payload.matchContext,
          context: compactContext,
          replacementCandidates,
        }),
      },
    ],
  });

  let completion;
  let response;
  if (request && typeof request.withResponse === "function") {
    const wrapped = await request.withResponse();
    completion = wrapped.data;
    response = wrapped.response;
  } else {
    completion = await request;
  }

  const azureRequestId =
    completion?._request_id ||
    response?.headers?.get?.("x-request-id") ||
    response?.headers?.get?.("apim-request-id") ||
    response?.headers?.get?.("x-ms-request-id") ||
    undefined;
  const contentType = response?.headers?.get?.("content-type") || null;
  const text = extractModelText(completion?.choices?.[0]?.message?.content);
  const elapsedMs = Date.now() - startedAt;
  console.log(`[orchestrate:${traceId}] azure end`, {
    elapsedMs,
    azureRequestId: azureRequestId || null,
    contentType,
    parsedField: "choices[0].message.content",
  });
  return { text, elapsedMs, azureRequestId };
};

console.log("[env] files", {
  rootEnvPath,
  rootEnvLoaded,
  agentFrameworkEnvPath,
  agentFrameworkEnvLoaded,
  loadedEnvFiles,
  loadedEnvPath,
  envLoaded,
});
console.log("[env] azure-openai", getAzureEnvPresence());
console.log("[env] orchestrate", { allowMock: isMockAllowed(), debugContext: isDebugContextEnabled() });
console.log("Cosmos env loaded:", {
  endpoint: !!process.env.COSMOS_ENDPOINT,
  key: !!process.env.COSMOS_KEY,
  db: process.env.COSMOS_DB,
  container: process.env.COSMOS_CONTAINER
});
const missingRequiredCosmosEnv = getMissingRequiredCosmosEnv();
if (missingRequiredCosmosEnv.length > 0) {
  console.error(
    `[CONFIG] Missing required Cosmos env vars: ${missingRequiredCosmosEnv.join(", ")}. ` +
      "GET /api/health remains available; baseline routes will return 503 until fixed."
  );
}
const cosmosDiagnostics = getCosmosDiagnostics();
console.log("[env] cosmos", {
  configured: cosmosDiagnostics.configured,
  account: cosmosDiagnostics.account || null,
  database: cosmosDiagnostics.databaseId,
  container: cosmosDiagnostics.containerId,
  sdkAvailable: cosmosDiagnostics.sdkAvailable,
});
const cosmosConfiguredAtBoot = getMissingRequiredCosmosEnv().length === 0;
console.log(
  `[BOOT] cosmosConfigured=${cosmosConfiguredAtBoot} endpointHost=${getCosmosEndpointHost()} ` +
    `db=${process.env.COSMOS_DB || ""} container=${process.env.COSMOS_CONTAINER || ""} ` +
    `envFileLoaded=${loadedEnvPath || "none"}`
);
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
const parsedPort = Number(process.env.PORT || process.env.API_PORT || 5176);
const PORT = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 5176;

app.use((req, res, next) => {
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
  if (origin && isCorsOriginAllowed(origin)) {
    setCorsHeaders(res, origin);
  }
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  return next();
});

app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  if (!req.path.startsWith("/api/")) return next();
  const startedAt = Date.now();
  res.on("finish", () => {
    const elapsedMs = Date.now() - startedAt;
    console.log(`[api] ${req.method} ${req.path} -> ${res.statusCode} (${elapsedMs}ms)`);
  });
  return next();
});

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

  const normalizedContextResult = normalizeFullMatchContext(payload.context);
  const fullMatchContext = normalizedContextResult.ok ? normalizedContextResult.value : undefined;
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
    ...(fullMatchContext ? { fullMatchContext } : {}),
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

  const normalizedContextResult = normalizeFullMatchContext(payload.context);
  const fullMatchContext = normalizedContextResult.ok ? normalizedContextResult.value : undefined;
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
    ...(fullMatchContext ? { fullMatchContext } : {}),
  };
};

const isCosmosUnavailableError = (error) =>
  Boolean(error) &&
  typeof error === "object" &&
  ("code" in error && error.code === "COSMOS_NOT_CONFIGURED");

const ensureCosmosBaselinesReady = async () => {
  const missingRequired = getMissingRequiredCosmosEnv();
  if (missingRequired.length > 0) {
    return {
      ok: false,
      status: 503,
      body: buildCosmosNotConfiguredError(missingRequired),
    };
  }
  if (!isCosmosConfigured()) {
    return {
      ok: false,
      status: 503,
      body: buildCosmosNotConfiguredError(missingRequired),
    };
  }
  try {
    const container = await getContainer();
    if (!container) {
      const diagnostics = getCosmosDiagnostics();
      const initError = diagnostics.initError ? new Error(String(diagnostics.initError)) : new Error("Cosmos container unavailable.");
      const status = getCosmosErrorStatusCode(initError);
      return {
        ok: false,
        status,
        body: buildCosmosConnectionError(initError, "Cosmos unavailable for baselines."),
      };
    }
    return { ok: true, container };
  } catch (error) {
    const status = getCosmosErrorStatusCode(error);
    return {
      ok: false,
      status,
      body: buildCosmosConnectionError(error, "Cosmos unavailable for baselines."),
    };
  }
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
  res.json({
    ok: true,
    service: "tactiq-backend",
    port: String(process.env.PORT || PORT),
  });
});

app.get("/api/health", async (_req, res) => {
  const aoai = backend?.getAoaiConfig ? backend.getAoaiConfig() : { ok: false, missing: ["api-dist-not-loaded"] };
  const diagnostics = getCosmosDiagnostics();
  const cosmosConfigured = getMissingRequiredCosmosEnv().length === 0;
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
    uptimeSeconds: Number(((Date.now() - serverBootTimeMs) / 1000).toFixed(1)),
    envLoaded,
    cosmosConfigured,
    endpointHost: getCosmosEndpointHost(),
    db: process.env.COSMOS_DB || diagnostics.databaseId || "",
    container: process.env.COSMOS_CONTAINER || diagnostics.containerId || "",
    port: Number(PORT),
    time: new Date().toISOString(),
    service: "tactIQ-agent-backend",
    status: "ok",
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

const cosmosHealthHandler = async (_req, res) => {
  const startedAt = Date.now();
  const config = getCosmosConnectionSettings();
  const missing = [];
  const hasAccountAuth = config.connectionString.length > 0 || (config.endpoint.length > 0 && config.key.length > 0);
  if (!hasAccountAuth) {
    missing.push("COSMOS_CONNECTION_STRING or COSMOS_ENDPOINT/COSMOS_KEY");
  }
  if (!config.dbName) {
    missing.push("COSMOS_DB or COSMOS_DATABASE or COSMOS_DATABASE_NAME or COSMOS_DATABASE_ID");
  }
  if (!config.container) {
    missing.push("COSMOS_CONTAINER or COSMOS_CONTAINER_NAME or COSMOS_CONTAINER_ID");
  }
  if (missing.length > 0) {
    return res.status(500).json({
      ok: false,
      error: "Cosmos configuration is incomplete.",
      missing,
      hint: "check COSMOS_* env",
    });
  }
  if (!CosmosClient) {
    return res.status(500).json({
      ok: false,
      error: "Cosmos SDK unavailable.",
      hint: "Install @azure/cosmos and restart backend.",
    });
  }

  try {
    const client = config.connectionString
      ? new CosmosClient(config.connectionString)
      : new CosmosClient({ endpoint: config.endpoint, key: config.key });
    const database = client.database(config.dbName);
    const container = database.container(config.container);
    // Health check uses metadata reads only (no writes), so dev diagnostics don't mutate state.
    await database.read();
    await container.read();
    return res.status(200).json({
      ok: true,
      dbName: config.dbName,
      container: config.container,
      latencyMs: Date.now() - startedAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({
      ok: false,
      error: message,
      hint: "check COSMOS_* env",
    });
  }
};

app.get("/cosmos/health", cosmosHealthHandler);
app.get("/api/cosmos/health", cosmosHealthHandler);

const readBaselinesPayload = async () => {
  const readiness = await ensureCosmosBaselinesReady();
  if (!readiness.ok) {
    return { ok: false, status: readiness.status, body: readiness.body, where: "ensureCosmosBaselinesReady" };
  }
  const players = await getAllBaselines();
  const diagnostics = getCosmosDiagnostics();
  return {
    ok: true,
    status: 200,
    body: { ok: true, items: players, players, source: "cosmos" },
    where: "getAllBaselines",
    diagnostics: {
      endpointHost: getCosmosEndpointHost(),
      db: diagnostics.databaseId,
      container: diagnostics.containerId,
      count: players.length,
    },
  };
};

app.get("/api/baselines", async (_req, res) => {
  try {
    const result = await readBaselinesPayload();
    if (!result.ok) {
      return res.status(result.status).json(result.body);
    }
    console.log("[baselines] GET", {
      endpointHost: result.diagnostics?.endpointHost || null,
      database: result.diagnostics?.db || null,
      container: result.diagnostics?.container || null,
      count: result.diagnostics?.count || 0,
    });
    return res.status(200).json(result.body);
  } catch (error) {
    console.error("Baselines GET error", error);
    const status = getCosmosErrorStatusCode(error);
    return res.status(status).json(buildCosmosConnectionError(error, "Failed to load baselines."));
  }
});

app.get("/api/_debug/baselines", async (_req, res) => {
  try {
    const result = await readBaselinesPayload();
    if (!result.ok) {
      return res.status(result.status).json({
        ok: false,
        where: result.where,
        error: result.body,
        diagnostics: {
          endpointHost: getCosmosEndpointHost(),
          db: process.env.COSMOS_DB || "",
          container: process.env.COSMOS_CONTAINER || "",
          envLoaded,
        },
      });
    }
    return res.status(200).json({
      ok: true,
      where: result.where,
      diagnostics: result.diagnostics,
      body: result.body,
    });
  } catch (error) {
    const status = getCosmosErrorStatusCode(error);
    return res.status(status).json({
      ok: false,
      where: "readBaselinesPayload.catch",
      error: buildCosmosConnectionError(error, "Debug baselines failed."),
    });
  }
});

app.get(["/api/roster", "/roster"], async (_req, res) => {
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
    const status = getCosmosErrorStatusCode(error, isCosmosUnavailableError(error) ? "COSMOS_NOT_CONFIGURED" : undefined);
    return res.status(status).json(buildCosmosConnectionError(error, "Failed to load roster."));
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
    const status = getCosmosErrorStatusCode(error, isCosmosUnavailableError(error) ? "COSMOS_NOT_CONFIGURED" : undefined);
    return res.status(status).json(buildCosmosConnectionError(error, "Failed to load baseline."));
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
    if (error && typeof error === "object" && "code" in error && error.code === "VALIDATION_ERROR") {
      return res.status(400).json({
        error: "Invalid baselines payload.",
        details: Array.isArray(error.details) ? error.details : [String(error.message || error)],
      });
    }
    if (isCosmosUnavailableError(error)) {
      return res.status(503).json(buildCosmosNotConfiguredError());
    }
    const status = getCosmosErrorStatusCode(error);
    return res.status(status).json(buildCosmosConnectionError(error, "Failed to save baselines."));
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
    if (error && typeof error === "object" && "code" in error && Number(error.code) === 404) {
      return res.status(404).json({ error: `Baseline ${req.params.id} not found.` });
    }
    if (error && typeof error === "object" && "code" in error && error.code === "VALIDATION_ERROR") {
      return res.status(400).json({
        error: "Invalid baseline patch payload.",
        details: Array.isArray(error.details) ? error.details : [String(error.message || error)],
      });
    }
    if (isCosmosUnavailableError(error)) {
      return res.status(503).json(buildCosmosNotConfiguredError());
    }
    const status = getCosmosErrorStatusCode(error);
    return res.status(status).json(buildCosmosConnectionError(error, "Failed to update baseline."));
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
    const code = error && typeof error === "object" && "code" in error ? Number(error.code) : undefined;
    if (code === 404) {
      return res.status(404).json({ error: `Baseline ${req.params.id} not found.` });
    }
    if (isCosmosUnavailableError(error)) {
      return res.status(503).json(buildCosmosNotConfiguredError());
    }
    const status = getCosmosErrorStatusCode(error);
    return res.status(status).json(buildCosmosConnectionError(error, "Failed to delete baseline."));
  }
});

const resetBaselinesHandler = async (_req, res) => {
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
      return res.status(503).json(buildCosmosNotConfiguredError());
    }
    const status = getCosmosErrorStatusCode(error);
    return res.status(status).json(buildCosmosConnectionError(error, "Failed to reset baselines."));
  }
};

app.post("/api/baselines/reset", resetBaselinesHandler);
app.post("/api/reset-db", resetBaselinesHandler);

app.post("/api/router", async (req, res) => {
  try {
    const rawPayload = isRecord(req.body) ? req.body : {};
    const telemetry = isRecord(rawPayload.telemetry) ? rawPayload.telemetry : {};
    const mode = String(rawPayload.mode || "auto").toLowerCase() === "full" ? "full" : "auto";
    const decision = buildDeterministicRouterDecision(mode, {
      telemetry: {
        fatigueIndex: toNum(telemetry.fatigueIndex, toNum(rawPayload?.signals?.fatigueIndex, 0)),
        strainIndex: toNum(telemetry.strainIndex, toNum(rawPayload?.signals?.strainIndex, 0)),
        oversBowled: toNum(telemetry.oversBowled, toNum(rawPayload?.signals?.oversBowled, 0)),
        injuryRisk: telemetry.injuryRisk ?? rawPayload?.signals?.injuryRisk,
        noBallRisk: telemetry.noBallRisk ?? rawPayload?.signals?.noBallRisk,
        playerId: telemetry.playerId || "",
      },
      matchContext: {
        matchMode: rawPayload?.matchContext?.matchMode || rawPayload?.teamMode || "",
        format: rawPayload?.matchContext?.format || "",
        phase: rawPayload?.matchContext?.phase || "",
        overs: toNum(rawPayload?.matchContext?.overs, 0),
        balls: toNum(rawPayload?.matchContext?.balls, 0),
        score: toNum(rawPayload?.matchContext?.score, 0),
        wickets: toNum(rawPayload?.matchContext?.wickets, 0),
        target: toNum(rawPayload?.matchContext?.target, 0),
        intensity: rawPayload?.matchContext?.intensity || "",
      },
    });
    const selectedAgents = normalizeSelectedLegacyAgents(decision.selectedAgents, mode === "full");
    return res.status(200).json({
      ok: true,
      intent: decision.intent,
      selectedAgents,
      agentsToRun: selectedAgents.map((agent) => toAgentCode(agent)),
      signalSummaryBullets: decision.rulesFired,
      rationale: "Routing: rules-based (safe fallback)",
      reason: "Routing: rules-based (safe fallback)",
      signals: decision.signals,
      run: {
        fatigue: selectedAgents.includes("fatigue"),
        risk: selectedAgents.includes("risk"),
        tactical: selectedAgents.includes("tactical"),
      },
      router: {
        available: true,
        usedFallback: true,
        intent: decision.intent,
        selectedAgents,
        triggers: decision.rulesFired,
      },
    });
  } catch (error) {
    console.error("Router error", error);
    return res.status(200).json({
      ok: true,
      intent: "Monitor",
      selectedAgents: ["tactical"],
      agentsToRun: ["TACTICAL"],
      signalSummaryBullets: ["router_error_fallback"],
      rationale: "Routing: rules-based (safe fallback)",
      reason: "Routing: rules-based (safe fallback)",
      signals: {},
      run: { fatigue: false, risk: false, tactical: true },
      router: {
        available: true,
        usedFallback: true,
        intent: "Monitor",
        selectedAgents: ["tactical"],
        triggers: ["router_error_fallback"],
      },
    });
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
    const normalizedContextResult = normalizeFullMatchContext(req.body?.context);
    const fullMatchContext = normalizedContextResult.ok ? normalizedContextResult.value : undefined;
    const replacementCandidates = fullMatchContext ? pickReplacementCandidates(fullMatchContext, 2) : [];
    const tacticalInput = {
      ...validated.value,
      requestId: validated.value.requestId || randomUUID(),
      ...(fullMatchContext ? { context: fullMatchContext } : {}),
      ...(replacementCandidates.length > 0 ? { replacementCandidates } : {}),
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

const orchestrateHandler = async (req, res) => {
  const startedAt = Date.now();
  const traceId = randomUUID();
  const routingLabel = "Routing: rules-based (safe fallback)";

  try {
    const rawPayload = isRecord(req.body) ? req.body : {};
    const telemetry = isRecord(rawPayload.telemetry) ? rawPayload.telemetry : {};
    const matchContext = isRecord(rawPayload.matchContext) ? rawPayload.matchContext : {};
    const players = isRecord(rawPayload.players) ? rawPayload.players : {};
    const mode = String(rawPayload.mode || "auto").toLowerCase() === "full" ? "full" : "auto";

    const fatigueIndex = Math.max(
      0,
      Math.min(10, toNum(telemetry.fatigueIndex, toNum(rawPayload?.signals?.fatigueIndex, 0)))
    );
    const strainIndex = Math.max(
      0,
      Math.min(10, toNum(telemetry.strainIndex, toNum(rawPayload?.signals?.strainIndex, 0)))
    );
    const oversBowled = Math.max(0, toNum(telemetry.oversBowled, toNum(rawPayload?.signals?.oversBowled, 0)));
    const injuryRisk = normalizeRiskToken(telemetry.injuryRisk ?? rawPayload?.signals?.injuryRisk);
    const noBallRisk = normalizeRiskToken(telemetry.noBallRisk ?? rawPayload?.signals?.noBallRisk);

    const decision = buildDeterministicRouterDecision(mode, {
      telemetry: {
        fatigueIndex,
        strainIndex,
        oversBowled,
        injuryRisk,
        noBallRisk,
        playerId: telemetry.playerId || "",
      },
      matchContext: {
        matchMode: matchContext.matchMode || rawPayload.teamMode || "",
        format: matchContext.format || "",
        phase: matchContext.phase || "",
        overs: toNum(matchContext.overs, 0),
        balls: toNum(matchContext.balls, 0),
        score: toNum(matchContext.score, 0),
        wickets: toNum(matchContext.wickets, 0),
        target: toNum(matchContext.target, 0),
        intensity: matchContext.intensity || "",
      },
    });
    const selectedAgents = normalizeSelectedLegacyAgents(decision.selectedAgents, mode === "full");
    const runFlags = {
      fatigue: selectedAgents.includes("fatigue"),
      risk: selectedAgents.includes("risk"),
      tactical: true,
    };

    const normalizedContextResult = normalizeFullMatchContext(rawPayload.context);
    const fullMatchContext = normalizedContextResult.ok ? normalizedContextResult.value : undefined;
    const replacementCandidates = fullMatchContext ? pickReplacementCandidates(fullMatchContext, 2) : [];

    const fatigueRequest = sanitizeFatigueRequest({
      ...telemetry,
      matchContext,
      context: fullMatchContext,
    });
    const riskRequest = sanitizeRiskRequest({
      ...telemetry,
      ...matchContext,
      context: fullMatchContext,
    });
    const tacticalInput = {
      requestId: traceId,
      intent: String(rawPayload.intent || "monitor"),
      teamMode: String(rawPayload.teamMode || matchContext.matchMode || "BOWLING"),
      focusRole: String(rawPayload.focusRole || "BOWLER"),
      telemetry: {
        playerId: String(telemetry.playerId || "UNKNOWN"),
        playerName: String(telemetry.playerName || "Unknown Player"),
        role: String(telemetry.role || "Unknown Role"),
        fatigueIndex,
        strainIndex,
        injuryRisk,
        noBallRisk,
        oversBowled,
        consecutiveOvers: Math.max(0, toNum(telemetry.consecutiveOvers, 0)),
        oversRemaining: Math.max(0, toNum(telemetry.oversRemaining, 0)),
        maxOvers: Math.max(1, toNum(telemetry.maxOvers, 4)),
        quotaComplete: Boolean(telemetry.quotaComplete),
        heartRateRecovery: String(telemetry.heartRateRecovery || "Moderate"),
        fatigueLimit: Math.max(0, toNum(telemetry.fatigueLimit, 6)),
        sleepHours: Math.max(0, toNum(telemetry.sleepHours, 7)),
        recoveryMinutes: Math.max(0, toNum(telemetry.recoveryMinutes, 45)),
        isUnfit: Boolean(telemetry.isUnfit),
      },
      matchContext: {
        matchMode: String(matchContext.matchMode || rawPayload.teamMode || "BOWLING"),
        format: String(matchContext.format || "T20"),
        phase: String(matchContext.phase || "middle"),
        intensity: String(matchContext.intensity || "Medium"),
        requiredRunRate: toNum(matchContext.requiredRunRate, 0),
        currentRunRate: toNum(matchContext.currentRunRate, 0),
        wicketsInHand: toNum(matchContext.wicketsInHand, 0),
        oversRemaining: toNum(matchContext.oversRemaining, 0),
        target: Number.isFinite(toNum(matchContext.target, NaN)) ? toNum(matchContext.target, 0) : undefined,
        score: Number.isFinite(toNum(matchContext.score, NaN)) ? toNum(matchContext.score, 0) : undefined,
        over: Number.isFinite(toNum(matchContext.over, NaN)) ? toNum(matchContext.over, 0) : undefined,
        balls: Number.isFinite(toNum(matchContext.balls, NaN)) ? toNum(matchContext.balls, 0) : undefined,
      },
      players: {
        striker: String(players.striker || "Striker"),
        nonStriker: String(players.nonStriker || "Non-striker"),
        bowler: String(players.bowler || telemetry.playerName || "Bowler"),
        bench: Array.isArray(players.bench) ? players.bench : [],
      },
      ...(fullMatchContext ? { context: fullMatchContext } : {}),
      ...(replacementCandidates.length > 0 ? { replacementCandidates } : {}),
    };

    const fatiguePromise =
      runFlags.fatigue && backend
        ? withTimeout(backend.runFatigueAgent(fatigueRequest), 12000, "fatigue-agent")
        : Promise.resolve(null);
    const riskPromise =
      runFlags.risk && backend
        ? withTimeout(backend.runRiskAgent(riskRequest), 12000, "risk-agent")
        : Promise.resolve(null);
    const tacticalPromise =
      runFlags.tactical && backend
        ? withTimeout(backend.runTacticalAgent(tacticalInput), 12000, "tactical-agent")
        : Promise.resolve(null);

    const [fatigueSettled, riskSettled, tacticalSettled] = await Promise.allSettled([
      fatiguePromise,
      riskPromise,
      tacticalPromise,
    ]);

    const errors = [];
    const warnings = [];
    const usedFallbackAgents = [];
    const getErrorMessage = (reason) => sanitizeErrorMessage(reason || "Agent call failed");

    let fatigueOutput;
    let riskOutput;
    let tacticalOutput;
    let fatigueStatus = runFlags.fatigue ? "ERROR" : "SKIPPED";
    let riskStatus = runFlags.risk ? "ERROR" : "SKIPPED";
    let tacticalStatus = "ERROR";

    if (runFlags.fatigue) {
      if (fatigueSettled.status === "fulfilled" && isRecord(fatigueSettled.value?.output)) {
        fatigueOutput = fatigueSettled.value.output;
        const token = String(fatigueOutput.status || "ok").toUpperCase();
        fatigueStatus = token === "FALLBACK" ? "FALLBACK" : token === "ERROR" ? "ERROR" : "OK";
      } else {
        const message =
          fatigueSettled.status === "rejected"
            ? getErrorMessage(fatigueSettled.reason)
            : backend
              ? "Fatigue agent returned no output."
              : "Fatigue agent unavailable.";
        errors.push({ agent: "fatigue", message });
      }
    }

    if (runFlags.risk) {
      if (riskSettled.status === "fulfilled" && isRecord(riskSettled.value?.output)) {
        riskOutput = riskSettled.value.output;
        const token = String(riskOutput.status || "ok").toUpperCase();
        riskStatus = token === "FALLBACK" ? "FALLBACK" : token === "ERROR" ? "ERROR" : "OK";
      } else {
        const message =
          riskSettled.status === "rejected"
            ? getErrorMessage(riskSettled.reason)
            : backend
              ? "Risk agent returned no output."
              : "Risk agent unavailable.";
        errors.push({ agent: "risk", message });
      }
    }

    if (tacticalSettled.status === "fulfilled" && isRecord(tacticalSettled.value?.output)) {
      tacticalOutput = tacticalSettled.value.output;
      const token = String(tacticalOutput.status || "ok").toUpperCase();
      tacticalStatus = token === "FALLBACK" ? "FALLBACK" : token === "ERROR" ? "ERROR" : "OK";
    } else {
      if (tacticalSettled.status === "rejected") {
        errors.push({ agent: "tactical", message: getErrorMessage(tacticalSettled.reason) });
      }
      tacticalOutput = {
        status: "fallback",
        immediateAction: "Apply tactical control and reassess after one over.",
        rationale: "Rules-based routing kept tactical guidance active while deeper modules were partially unavailable.",
        suggestedAdjustments: [
          "Reduce execution variance in the next over and protect line and length.",
          "Shorten high-intensity spell duration and re-check signals after one over.",
          "Rotate if no-ball or injury trend rises in the next phase.",
        ],
        confidence: 0.64,
        keySignalsUsed: decision.rulesFired,
      };
      tacticalStatus = "FALLBACK";
      usedFallbackAgents.push("tactical");
      warnings.push("Tactical fallback used.");
    }

    const combinedSignals = Array.from(
      new Set([
        ...decision.rulesFired,
        ...(Array.isArray(fatigueOutput?.signals) ? fatigueOutput.signals.map((entry) => String(entry || "")) : []),
        ...(Array.isArray(riskOutput?.signals) ? riskOutput.signals.map((entry) => String(entry || "")) : []),
        ...(Array.isArray(tacticalOutput?.keySignalsUsed)
          ? tacticalOutput.keySignalsUsed.map((entry) => String(entry || ""))
          : []),
      ])
    )
      .map((entry) => entry.trim())
      .filter(Boolean)
      .slice(0, 7);

    const combined = {
      signals: combinedSignals,
      fatigueAnalysis: fatigueOutput
        ? String(fatigueOutput.recommendation || fatigueOutput.explanation || "Fatigue signal reviewed.")
        : "Fatigue module did not return output in this run; tactical guidance is based on available workload signals.",
      injuryRiskAnalysis: riskOutput
        ? String(riskOutput.recommendation || riskOutput.explanation || riskOutput.headline || "Risk signal reviewed.")
        : "Risk module did not return output in this run; control-first tactical guidance is active.",
      tacticalRecommendation: {
        nextAction: String(tacticalOutput.immediateAction || "Apply tactical control and reassess after one over."),
        why: String(tacticalOutput.rationale || "Rules-based tactical fallback is active."),
        ifIgnored:
          String(tacticalOutput.suggestedAdjustments?.[0] || "")
            .trim() || "Execution risk may compound in the next phase.",
        alternatives: Array.isArray(tacticalOutput.suggestedAdjustments)
          ? tacticalOutput.suggestedAdjustments.map((entry) => String(entry)).slice(0, 4)
          : [],
      },
      coachNote: "Routing uses deterministic safety rules to guarantee tactical continuity.",
    };

    const responseBody = {
      ok: true,
      traceId,
      source: "mock",
      router: {
        available: true,
        usedFallback: true,
        intent: decision.intent,
        selectedAgents,
        triggers: decision.rulesFired,
      },
      routerDecision: {
        intent: decision.intent,
        agentsToRun: selectedAgents.map((agent) => toAgentCode(agent)),
        selectedAgents,
        signalSummaryBullets: combined.signals,
        rationale: routingLabel,
        rulesFired: decision.rulesFired,
        inputsUsed: decision.inputsUsed,
        reason: routingLabel,
        signals: decision.signals,
      },
      agentsRun: selectedAgents.map((agent) => toAgentCode(agent)),
      agents: {
        fatigue: { status: fatigueStatus },
        risk: { status: riskStatus },
        tactical: { status: tacticalStatus },
      },
      outputs: {
        fatigue: runFlags.fatigue
          ? fatigueOutput
            ? { ok: true, data: fatigueOutput, text: String(fatigueOutput.recommendation || fatigueOutput.headline || "") }
            : { ok: false, error: errors.find((entry) => entry.agent === "fatigue")?.message || "Fatigue agent failed." }
          : { ok: false, error: "Fatigue agent not selected." },
        risk: runFlags.risk
          ? riskOutput
            ? { ok: true, data: riskOutput, text: String(riskOutput.recommendation || riskOutput.headline || "") }
            : { ok: false, error: errors.find((entry) => entry.agent === "risk")?.message || "Risk agent failed." }
          : { ok: false, error: "Risk agent not selected." },
        tactical: tacticalOutput
          ? {
              ok: true,
              data: tacticalOutput,
              recommendation: {
                nextAction: String(tacticalOutput.immediateAction || ""),
                why: String(tacticalOutput.rationale || ""),
                ifIgnored: String(tacticalOutput.suggestedAdjustments?.[0] || ""),
                alternatives: Array.isArray(tacticalOutput.suggestedAdjustments)
                  ? tacticalOutput.suggestedAdjustments.slice(0, 3).map((entry) => String(entry))
                  : [],
              },
            }
          : { ok: false, error: "Tactical output unavailable." },
      },
      ...(fatigueOutput ? { fatigue: fatigueOutput } : {}),
      ...(riskOutput ? { risk: riskOutput } : {}),
      tactical: tacticalOutput,
      combined,
      strategicAnalysis: combined,
      finalDecision: {
        immediateAction: String(combined.tacticalRecommendation.nextAction || ""),
        suggestedAdjustments: combined.tacticalRecommendation.alternatives,
        confidence: Number.isFinite(Number(tacticalOutput?.confidence)) ? Number(tacticalOutput.confidence) : 0.64,
        rationale: String(combined.tacticalRecommendation.why || ""),
      },
      combinedDecision: {
        immediateAction: String(combined.tacticalRecommendation.nextAction || ""),
        suggestedAdjustments: combined.tacticalRecommendation.alternatives,
        confidence: Number.isFinite(Number(tacticalOutput?.confidence)) ? Number(tacticalOutput.confidence) : 0.64,
        rationale: String(combined.tacticalRecommendation.why || ""),
      },
      errors,
      meta: {
        requestId: traceId,
        mode,
        executedAgents: selectedAgents,
        modelRouting: {
          fatigueModel: runFlags.fatigue ? "rules-based-router" : "skipped:not-selected",
          riskModel: runFlags.risk ? "rules-based-router" : "skipped:not-selected",
          tacticalModel: "rules-based-router",
          fallbacksUsed: ["rules-based-router"],
        },
        usedFallbackAgents,
        routerFallbackMessage: routingLabel,
        timingsMs: {
          total: Date.now() - startedAt,
        },
      },
      ...(warnings.length > 0 ? { warnings } : {}),
      timingsMs: {
        total: Date.now() - startedAt,
      },
    };

    return res.status(200).json(responseBody);
  } catch (error) {
    console.error("[orchestrate][deterministic-crash]", error?.stack || error);
    const tacticalFallback = {
      status: "fallback",
      immediateAction: "Apply tactical control and reassess after one over.",
      rationale: "Rules-based fallback remained active after orchestrate error.",
      suggestedAdjustments: [
        "Use conservative tactical execution for the next over.",
        "Re-run analysis after one over.",
      ],
      confidence: 0.58,
      keySignalsUsed: ["orchestrate_error_fallback"],
    };
    return res.status(200).json({
      ok: true,
      traceId,
      source: "mock",
      router: {
        available: true,
        usedFallback: true,
        intent: "Monitor",
        selectedAgents: ["tactical"],
        triggers: ["orchestrate_error_fallback"],
      },
      routerDecision: {
        intent: "Monitor",
        agentsToRun: ["TACTICAL"],
        selectedAgents: ["tactical"],
        signalSummaryBullets: ["orchestrate_error_fallback"],
        rationale: routingLabel,
        rulesFired: ["orchestrate_error_fallback"],
        inputsUsed: { active: {}, match: {} },
        reason: routingLabel,
        signals: {},
      },
      agentsRun: ["TACTICAL"],
      agents: {
        fatigue: { status: "SKIPPED" },
        risk: { status: "SKIPPED" },
        tactical: { status: "FALLBACK" },
      },
      outputs: {
        fatigue: { ok: false, error: "Fatigue agent not selected." },
        risk: { ok: false, error: "Risk agent not selected." },
        tactical: { ok: true, data: tacticalFallback },
      },
      tactical: tacticalFallback,
      strategicAnalysis: {
        signals: ["orchestrate_error_fallback"],
        fatigueAnalysis: "Fatigue analysis unavailable in this run.",
        injuryRiskAnalysis: "Risk analysis unavailable in this run.",
        tacticalRecommendation: {
          nextAction: tacticalFallback.immediateAction,
          why: tacticalFallback.rationale,
          ifIgnored: tacticalFallback.suggestedAdjustments[0],
          alternatives: tacticalFallback.suggestedAdjustments,
        },
        coachNote: "Routing uses deterministic fallback while recovering from a transient backend error.",
      },
      combinedDecision: {
        immediateAction: tacticalFallback.immediateAction,
        suggestedAdjustments: tacticalFallback.suggestedAdjustments,
        confidence: tacticalFallback.confidence,
        rationale: tacticalFallback.rationale,
      },
      errors: [],
      meta: {
        requestId: traceId,
        mode: "auto",
        executedAgents: ["tactical"],
        modelRouting: {
          fatigueModel: "skipped:not-selected",
          riskModel: "skipped:not-selected",
          tacticalModel: "rules-based-router",
          fallbacksUsed: ["rules-based-router", "orchestrate_error_fallback"],
        },
        usedFallbackAgents: ["tactical"],
        routerFallbackMessage: routingLabel,
        timingsMs: { total: Date.now() - startedAt },
      },
      warnings: ["Routing: rules-based (safe fallback)"],
      timingsMs: { total: Date.now() - startedAt },
    });
  }
};

app.post("/orchestrate", orchestrateHandler);
app.post("/api/orchestrate", orchestrateHandler);
app.post("/orchestrate-probe", orchestrateHandler);
app.post("/api/orchestrate-probe", orchestrateHandler);

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

const isApiLikePath = (requestPath) => {
  const pathValue = String(requestPath || "");
  const apiPrefixes = ["/api", "/orchestrate", "/health", "/cosmos", "/roster"];
  return apiPrefixes.some((prefix) => pathValue === prefix || pathValue.startsWith(`${prefix}/`));
};

app.use((req, res, next) => {
  if (!isApiLikePath(req.path)) return next();
  return res.status(404).json({ error: "API route not found." });
});

/* STATIC FILES */
const distPath = path.join(__dirname, "dist");
app.use(express.static(distPath));

/* SPA FALLBACK (ONLY FOR NON-API ROUTES) */
app.get("*", (req, res, next) => {
  if (isApiLikePath(req.path)) return next();
  res.sendFile(path.join(distPath, "index.html"));
});

app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }
  const status = Number.isFinite(Number(err?.status)) ? Number(err.status) : 500;
  return res.status(status).json({
    ok: false,
    code: "UNHANDLED_ERROR",
    message: err?.message || "Unhandled server error",
    stack: process.env.NODE_ENV === "development" ? err?.stack : undefined,
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[BOOT] API server on ${PORT} file: ${__filename}`);
  console.log(`[BOOT] API listening on http://localhost:${PORT}`);
  console.log("[BOOT] runtime config", {
    envLoaded,
    envFilePath: loadedEnvPath || "not found",
    cosmosEndpoint: isNonEmptyEnv(process.env.COSMOS_ENDPOINT) ? "set" : "missing",
    cosmosDb: process.env.COSMOS_DB || "",
    cosmosContainer: process.env.COSMOS_CONTAINER || "",
    port: PORT,
    host: "0.0.0.0",
  });
  console.log(`Server running on port ${PORT}`);
});
