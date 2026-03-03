const { randomUUID } = require("crypto");

let CosmosClient = null;
try {
  // eslint-disable-next-line global-require
  ({ CosmosClient } = require("@azure/cosmos"));
} catch {
  CosmosClient = null;
}

const memoryAnalysisBundles = new Map();
const memoryChatsByAnalysis = new Map();

const normalizeId = (value) => String(value || "").trim();
const toIso = (value) => {
  const parsed = Date.parse(String(value || ""));
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  return new Date().toISOString();
};

const getConfig = () => {
  const connectionString = String(process.env.COSMOS_CONNECTION_STRING || "").trim();
  const endpoint = String(process.env.COSMOS_ENDPOINT || process.env.AZURE_COSMOS_ENDPOINT || "").trim();
  const key = String(process.env.COSMOS_KEY || process.env.AZURE_COSMOS_KEY || "").trim();
  const databaseId = String(
    process.env.COSMOS_DB ||
      process.env.COSMOS_DATABASE ||
      process.env.AZURE_COSMOS_DATABASE ||
      process.env.COSMOS_DATABASE_NAME ||
      "tactiq-db"
  ).trim();
  const analysisContainerId = String(process.env.COSMOS_ANALYSIS_CONTAINER || "analysisBundles").trim();
  const chatContainerId = String(process.env.COSMOS_COPILOT_CHAT_CONTAINER || "copilotChats").trim();
  return {
    connectionString,
    endpoint,
    key,
    databaseId,
    analysisContainerId,
    chatContainerId,
  };
};

const isCosmosConfigured = () => {
  if (!CosmosClient) return false;
  const config = getConfig();
  const hasAuth = config.connectionString.length > 0 || (config.endpoint.length > 0 && config.key.length > 0);
  return hasAuth && config.databaseId.length > 0;
};

let cachedClient = null;
let cachedAnalysisContainer = null;
let cachedChatContainer = null;
let initPromise = null;

const ensureContainers = async () => {
  if (!isCosmosConfigured()) return null;
  if (cachedAnalysisContainer && cachedChatContainer) {
    return { analysisContainer: cachedAnalysisContainer, chatContainer: cachedChatContainer };
  }
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const config = getConfig();
    const client =
      config.connectionString.length > 0
        ? new CosmosClient(config.connectionString)
        : new CosmosClient({ endpoint: config.endpoint, key: config.key });
    const { database } = await client.databases.createIfNotExists({ id: config.databaseId });
    const { container: analysisContainer } = await database.containers.createIfNotExists({
      id: config.analysisContainerId,
      partitionKey: { paths: ["/analysisId"] },
    });
    const { container: chatContainer } = await database.containers.createIfNotExists({
      id: config.chatContainerId,
      partitionKey: { paths: ["/analysisId"] },
    });
    cachedClient = client;
    cachedAnalysisContainer = analysisContainer;
    cachedChatContainer = chatContainer;
    return { analysisContainer, chatContainer };
  })().catch((error) => {
    console.warn("[copilot-store] cosmos unavailable; using memory fallback.", error instanceof Error ? error.message : String(error));
    return null;
  });

  return initPromise;
};

const toMemoryBundle = (bundle) => {
  const analysisId = normalizeId(bundle?.analysisId) || randomUUID();
  return {
    id: analysisId,
    analysisId,
    type: "analysisBundle",
    timestamp: toIso(bundle?.timestamp),
    matchContextSnapshot: bundle?.matchContextSnapshot || {},
    coachOutput: bundle?.coachOutput || {},
    routingMeta: bundle?.routingMeta || {},
    createdAt: toIso(bundle?.createdAt),
    updatedAt: toIso(bundle?.updatedAt),
  };
};

const toMemoryChat = (turn) => {
  const analysisId = normalizeId(turn?.analysisId);
  return {
    id: normalizeId(turn?.id) || randomUUID(),
    analysisId,
    type: "copilotMessage",
    role: turn?.role === "assistant" ? "assistant" : "user",
    content: String(turn?.content || "").trim(),
    createdAt: toIso(turn?.createdAt),
  };
};

const sortByCreatedAt = (rows) =>
  [...rows].sort((a, b) => Date.parse(String(a.createdAt || 0)) - Date.parse(String(b.createdAt || 0)));

const getMemoryChatRows = (analysisId) => {
  const rows = memoryChatsByAnalysis.get(analysisId);
  return Array.isArray(rows) ? rows : [];
};

const setMemoryChatRows = (analysisId, rows) => {
  memoryChatsByAnalysis.set(analysisId, sortByCreatedAt(rows));
};

const saveAnalysisBundle = async (bundleInput) => {
  const bundle = toMemoryBundle(bundleInput || {});
  memoryAnalysisBundles.set(bundle.analysisId, bundle);
  const containers = await ensureContainers();
  if (!containers) {
    return { analysisId: bundle.analysisId, storage: "memory", bundle };
  }
  try {
    await containers.analysisContainer.items.upsert(bundle, { partitionKey: bundle.analysisId });
    return { analysisId: bundle.analysisId, storage: "cosmos", bundle };
  } catch (error) {
    console.warn("[copilot-store] failed to persist analysis bundle; using memory.", error instanceof Error ? error.message : String(error));
    return { analysisId: bundle.analysisId, storage: "memory", bundle };
  }
};

const getAnalysisBundle = async (analysisIdInput) => {
  const analysisId = normalizeId(analysisIdInput);
  if (!analysisId) return null;
  const cached = memoryAnalysisBundles.get(analysisId);
  if (cached) return cached;
  const containers = await ensureContainers();
  if (!containers) return null;
  try {
    const { resource } = await containers.analysisContainer.item(analysisId, analysisId).read();
    if (!resource) return null;
    const normalized = toMemoryBundle(resource);
    memoryAnalysisBundles.set(analysisId, normalized);
    return normalized;
  } catch {
    return null;
  }
};

const appendCopilotMessage = async (turnInput) => {
  const analysisId = normalizeId(turnInput?.analysisId);
  if (!analysisId) throw new Error("analysisId is required");
  const normalized = toMemoryChat({ ...turnInput, analysisId });
  if (!normalized.content) throw new Error("message content is required");

  const currentRows = getMemoryChatRows(analysisId);
  setMemoryChatRows(analysisId, [...currentRows, normalized]);

  const containers = await ensureContainers();
  if (containers) {
    try {
      await containers.chatContainer.items.upsert(normalized, { partitionKey: analysisId });
    } catch (error) {
      console.warn("[copilot-store] failed to persist chat turn; using memory.", error instanceof Error ? error.message : String(error));
    }
  }
  return normalized;
};

const listCopilotMessages = async (analysisIdInput, limit = 8) => {
  const analysisId = normalizeId(analysisIdInput);
  if (!analysisId) return [];

  const fromMemory = getMemoryChatRows(analysisId);
  const memorySlice = sortByCreatedAt(fromMemory).slice(-Math.max(1, limit));
  const containers = await ensureContainers();
  if (!containers) return memorySlice;

  try {
    const query = await containers.chatContainer.items
      .query({
        query: "SELECT * FROM c WHERE c.analysisId = @analysisId AND c.type = @type ORDER BY c.createdAt ASC",
        parameters: [
          { name: "@analysisId", value: analysisId },
          { name: "@type", value: "copilotMessage" },
        ],
      })
      .fetchAll();
    const rows = (Array.isArray(query.resources) ? query.resources : []).map((entry) => toMemoryChat(entry));
    setMemoryChatRows(analysisId, rows);
    return rows.slice(-Math.max(1, limit));
  } catch {
    return memorySlice;
  }
};

const countCopilotUserMessages = async (analysisIdInput) => {
  const analysisId = normalizeId(analysisIdInput);
  if (!analysisId) return 0;
  const containers = await ensureContainers();
  if (!containers) {
    return getMemoryChatRows(analysisId).filter((entry) => entry.role === "user").length;
  }
  try {
    const query = await containers.chatContainer.items
      .query({
        query:
          "SELECT VALUE COUNT(1) FROM c WHERE c.analysisId = @analysisId AND c.type = @type AND c.role = @role",
        parameters: [
          { name: "@analysisId", value: analysisId },
          { name: "@type", value: "copilotMessage" },
          { name: "@role", value: "user" },
        ],
      })
      .fetchAll();
    const count = Array.isArray(query.resources) ? Number(query.resources[0] || 0) : 0;
    return Number.isFinite(count) ? count : 0;
  } catch {
    return getMemoryChatRows(analysisId).filter((entry) => entry.role === "user").length;
  }
};

const pickBundleTimestamp = (bundle) => {
  const parsed = Date.parse(String(bundle?.updatedAt || bundle?.timestamp || bundle?.createdAt || ""));
  return Number.isFinite(parsed) ? parsed : 0;
};

const bundleMatchesScope = (bundle, { matchId, sessionId }) => {
  const bundleSessionId = normalizeId(
    bundle?.sessionId || bundle?.routingMeta?.sessionId || bundle?.matchContextSnapshot?.matchContext?.sessionId
  );
  const bundleMatchId = normalizeId(
    bundle?.matchId || bundle?.routingMeta?.matchId || bundle?.matchContextSnapshot?.matchContext?.matchId
  );
  if (sessionId && bundleSessionId && sessionId === bundleSessionId) return true;
  if (matchId && bundleMatchId && matchId === bundleMatchId) return true;
  return false;
};

const findLatestAnalysisBundleByScope = async (scopeInput) => {
  const matchId = normalizeId(scopeInput?.matchId);
  const sessionId = normalizeId(scopeInput?.sessionId);
  if (!matchId && !sessionId) return null;

  const memoryCandidates = [...memoryAnalysisBundles.values()].filter((bundle) =>
    bundleMatchesScope(bundle, { matchId, sessionId })
  );
  const memoryLatest =
    memoryCandidates.length > 0
      ? memoryCandidates.sort((a, b) => pickBundleTimestamp(b) - pickBundleTimestamp(a))[0]
      : null;

  const containers = await ensureContainers();
  if (!containers) return memoryLatest;

  const runQuery = async (parameterName, parameterValue) => {
    if (!parameterValue) return null;
    try {
      const query = await containers.analysisContainer.items
        .query({
          query:
            "SELECT TOP 1 * FROM c WHERE c.type = @type AND (" +
            `(IS_DEFINED(c.${parameterName}) AND c.${parameterName} = @value) OR ` +
            `(IS_DEFINED(c.routingMeta.${parameterName}) AND c.routingMeta.${parameterName} = @value) OR ` +
            `(IS_DEFINED(c.matchContextSnapshot.matchContext.${parameterName}) AND c.matchContextSnapshot.matchContext.${parameterName} = @value)` +
            ") ORDER BY c.timestamp DESC",
          parameters: [
            { name: "@type", value: "analysisBundle" },
            { name: "@value", value: parameterValue },
          ],
        })
        .fetchAll();
      const row = Array.isArray(query.resources) && query.resources.length > 0 ? query.resources[0] : null;
      return row ? toMemoryBundle(row) : null;
    } catch {
      return null;
    }
  };

  const cosmosBySession = await runQuery("sessionId", sessionId);
  const cosmosByMatch = cosmosBySession ? null : await runQuery("matchId", matchId);
  const cosmosLatest = cosmosBySession || cosmosByMatch;
  if (cosmosLatest) {
    memoryAnalysisBundles.set(cosmosLatest.analysisId, cosmosLatest);
    return cosmosLatest;
  }
  return memoryLatest;
};

module.exports = {
  saveAnalysisBundle,
  getAnalysisBundle,
  appendCopilotMessage,
  listCopilotMessages,
  countCopilotUserMessages,
  findLatestAnalysisBundleByScope,
};
