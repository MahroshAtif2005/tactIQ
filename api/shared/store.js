const { randomUUID } = require('crypto');

let CosmosClient = null;
try {
  ({ CosmosClient } = require('@azure/cosmos'));
} catch {
  CosmosClient = null;
}

const DEFAULT_DB = 'tactiq-db';
const DEFAULT_PLAYERS_CONTAINER = 'players';
const DEFAULT_USERS_CONTAINER = 'users';
const VALID_ROLES = new Set(['BAT', 'FAST', 'SPIN', 'AR']);

const DEFAULT_BASELINES = [
  { id: 'J. Archer', name: 'J. Archer', role: 'FAST', sleep: 7.5, recovery: 45, fatigueLimit: 6, control: 80, speed: 9, power: 0, active: true, inRoster: true, orderIndex: 1 },
  { id: 'R. Khan', name: 'R. Khan', role: 'SPIN', sleep: 7.1, recovery: 40, fatigueLimit: 6, control: 86, speed: 8, power: 0, active: true, inRoster: true, orderIndex: 2 },
  { id: 'M. Starc', name: 'M. Starc', role: 'FAST', sleep: 6.8, recovery: 50, fatigueLimit: 6, control: 79, speed: 9, power: 0, active: true, inRoster: true, orderIndex: 3 },
];

const memoryUsers = new Map();
const memoryBaselinesByTeam = new Map();
let cosmosPromise = null;
let cosmosEnabled = false;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const normalizeId = (value) => String(value || '').trim();
const normalizeIsoDate = (value) => {
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return new Date().toISOString();
};

const parseNumber = (value, fallback, min, max) => {
  const parsed = Number(value);
  const safe = Number.isFinite(parsed) ? parsed : fallback;
  return clamp(safe, min, max);
};

const parseBoolean = (value, fallback) => {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null) return fallback;
  const token = String(value).trim().toLowerCase();
  if (token === 'true' || token === '1' || token === 'yes') return true;
  if (token === 'false' || token === '0' || token === 'no') return false;
  return fallback;
};

const normalizeRole = (value) => {
  const role = String(value || '').trim().toUpperCase();
  return VALID_ROLES.has(role) ? role : 'FAST';
};

const normalizeBaseline = (raw, scope = {}, existing = null) => {
  const record = raw && typeof raw === 'object' ? raw : {};
  const baselineId = normalizeId(record.id || record.playerId || record.baselineId || record.name);
  if (!baselineId) return null;
  const now = new Date().toISOString();
  const existingRecord = existing && typeof existing === 'object' ? existing : {};

  const sleep = parseNumber(record.sleep ?? record.sleepHoursToday, parseNumber(existingRecord.sleep, 7, 0, 12), 0, 12);
  const recovery = parseNumber(record.recovery ?? record.recoveryMinutes, parseNumber(existingRecord.recovery, 45, 0, 240), 0, 240);
  const fatigueLimit = parseNumber(record.fatigueLimit, parseNumber(existingRecord.fatigueLimit, 6, 0, 10), 0, 10);
  const control = parseNumber(record.control ?? record.controlBaseline, parseNumber(existingRecord.control, 78, 0, 100), 0, 100);
  const speed = parseNumber(record.speed, parseNumber(existingRecord.speed, 7, 0, 100), 0, 100);
  const power = parseNumber(record.power, parseNumber(existingRecord.power, 0, 0, 100), 0, 100);
  const orderIndexRaw = Number(record.orderIndex ?? existingRecord.orderIndex ?? 0);

  return {
    id: normalizeId(existingRecord.id) || randomUUID(),
    baselineId,
    playerId: baselineId,
    name: String(record.name || existingRecord.name || baselineId).trim() || baselineId,
    role: normalizeRole(record.role || existingRecord.role),
    sleep,
    recovery,
    fatigueLimit,
    control,
    speed,
    power,
    active: parseBoolean(record.active ?? record.isActive, parseBoolean(existingRecord.active, true)),
    inRoster: parseBoolean(record.inRoster ?? record.roster, parseBoolean(existingRecord.inRoster, false)),
    orderIndex: Number.isFinite(orderIndexRaw) ? Math.max(0, Math.floor(orderIndexRaw)) : 0,
    type: 'playerBaseline',
    userId: normalizeId(scope.userId || existingRecord.userId),
    teamId: normalizeId(scope.teamId || existingRecord.teamId),
    createdAt: normalizeIsoDate(existingRecord.createdAt || record.createdAt || now),
    updatedAt: normalizeIsoDate(record.updatedAt || now),
  };
};

const baselineForClient = (doc) => {
  const normalized = normalizeBaseline(doc, {
    userId: normalizeId(doc && doc.userId),
    teamId: normalizeId(doc && doc.teamId),
  }, doc);
  if (!normalized) return null;
  const baselineId = normalized.baselineId;
  return {
    id: baselineId,
    baselineId,
    playerId: baselineId,
    name: normalized.name,
    role: normalized.role,
    sleep: normalized.sleep,
    recovery: normalized.recovery,
    fatigueLimit: normalized.fatigueLimit,
    control: normalized.control,
    speed: normalized.speed,
    power: normalized.power,
    sleepHoursToday: normalized.sleep,
    recoveryMinutes: normalized.recovery,
    controlBaseline: normalized.control,
    active: normalized.active,
    isActive: normalized.active,
    inRoster: normalized.inRoster,
    orderIndex: normalized.orderIndex,
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
  };
};

const extractPrincipal = (req) => {
  const headers = (req && req.headers) || {};
  const raw = headers['x-ms-client-principal'] || headers['X-MS-CLIENT-PRINCIPAL'];
  if (!raw) return null;
  const value = Array.isArray(raw) ? raw[0] : raw;
  try {
    const decoded = Buffer.from(String(value), 'base64').toString('utf8');
    const parsed = JSON.parse(decoded);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
};

const getClaim = (claims, ...types) => {
  if (!Array.isArray(claims)) return '';
  const valid = new Set(types.map((entry) => String(entry || '').toLowerCase()));
  for (const claim of claims) {
    const typ = String(claim && (claim.typ || claim.type) || '').toLowerCase();
    if (!valid.has(typ)) continue;
    const value = String(claim && (claim.val || claim.value) || '').trim();
    if (value) return value;
  }
  return '';
};

const getIdentity = (req) => {
  const principal = extractPrincipal(req);
  if (principal) {
    const claims = Array.isArray(principal.claims) ? principal.claims : [];
    const userId = normalizeId(
      principal.userId ||
      getClaim(
        claims,
        'http://schemas.microsoft.com/identity/claims/objectidentifier',
        'oid',
        'sub',
        'nameidentifier'
      )
    );
    if (userId) {
      return {
        userId,
        name: normalizeId(principal.userDetails || getClaim(claims, 'name', 'given_name')),
        email: normalizeId(getClaim(claims, 'emails', 'email', 'preferred_username', 'upn')),
        source: 'swa',
      };
    }
  }

  if (String(process.env.NODE_ENV || '').toLowerCase() !== 'production') {
    const headers = (req && req.headers) || {};
    const devHeader = headers['x-dev-user-id'] || headers['X-DEV-USER-ID'];
    const devUserId = normalizeId(Array.isArray(devHeader) ? devHeader[0] : devHeader);
    if (devUserId) {
      return {
        userId: devUserId,
        name: 'Local Dev Coach',
        email: '',
        source: 'dev-header',
      };
    }
  }

  return null;
};

const getConfig = () => {
  const connectionString = normalizeId(process.env.COSMOS_CONNECTION_STRING);
  const endpoint = normalizeId(process.env.COSMOS_ENDPOINT);
  const key = normalizeId(process.env.COSMOS_KEY);
  const databaseId = normalizeId(process.env.COSMOS_DATABASE || process.env.COSMOS_DB || DEFAULT_DB) || DEFAULT_DB;
  const playersContainerId =
    normalizeId(process.env.COSMOS_CONTAINER_PLAYERS || process.env.COSMOS_CONTAINER || DEFAULT_PLAYERS_CONTAINER) ||
    DEFAULT_PLAYERS_CONTAINER;
  const usersContainerId =
    normalizeId(process.env.COSMOS_CONTAINER_USERS || DEFAULT_USERS_CONTAINER) || DEFAULT_USERS_CONTAINER;

  const hasAuth = Boolean(connectionString || (endpoint && key));
  return {
    connectionString,
    endpoint,
    key,
    databaseId,
    playersContainerId,
    usersContainerId,
    hasAuth,
  };
};

const getCosmos = async () => {
  if (cosmosPromise) return cosmosPromise;

  cosmosPromise = (async () => {
    const config = getConfig();
    if (!CosmosClient || !config.hasAuth) {
      cosmosEnabled = false;
      return null;
    }

    try {
      const client = config.connectionString
        ? new CosmosClient(config.connectionString)
        : new CosmosClient({ endpoint: config.endpoint, key: config.key });
      const { database } = await client.databases.createIfNotExists({ id: config.databaseId });
      const { container: playersContainer } = await database.containers.createIfNotExists({
        id: config.playersContainerId,
        partitionKey: { paths: ['/userId'] },
      });
      const { container: usersContainer } = await database.containers.createIfNotExists({
        id: config.usersContainerId,
        partitionKey: { paths: ['/userId'] },
      });

      cosmosEnabled = true;
      return { client, database, playersContainer, usersContainer };
    } catch (error) {
      cosmosEnabled = false;
      console.warn('[functions][cosmos] init failed, using memory fallback:', error && error.message ? error.message : String(error));
      return null;
    }
  })();

  return cosmosPromise;
};

const sortBaselines = (rows) => {
  return [...rows]
    .map((row, index) => ({ row, index, orderIndex: Number.isFinite(Number(row.orderIndex)) ? Number(row.orderIndex) : 0 }))
    .sort((a, b) => (a.orderIndex !== b.orderIndex ? a.orderIndex - b.orderIndex : a.index - b.index))
    .map((entry) => entry.row);
};

const getMemoryBaselines = (teamId) => {
  const key = normalizeId(teamId);
  if (!memoryBaselinesByTeam.has(key)) {
    const seeded = DEFAULT_BASELINES.map((row) => ({ ...row }));
    memoryBaselinesByTeam.set(key, seeded);
  }
  return memoryBaselinesByTeam.get(key) || [];
};

const ensureUser = async (identity) => {
  if (!identity || !normalizeId(identity.userId)) {
    return null;
  }

  const now = new Date().toISOString();
  const cosmos = await getCosmos();
  if (cosmos) {
    const { usersContainer } = cosmos;
    const query = {
      query: 'SELECT TOP 1 * FROM c WHERE c.userId = @userId',
      parameters: [{ name: '@userId', value: identity.userId }],
    };
    const result = await usersContainer.items.query(query).fetchAll();
    const existing = Array.isArray(result.resources) ? result.resources[0] : null;

    const userDoc = {
      id: identity.userId,
      type: 'coachUser',
      userId: identity.userId,
      email: identity.email || existing && existing.email || null,
      name: identity.name || existing && existing.name || null,
      role: existing && existing.role ? existing.role : 'coach',
      teamId: normalizeId(existing && existing.teamId) || randomUUID(),
      createdAt: normalizeIsoDate(existing && existing.createdAt || now),
      updatedAt: now,
    };

    await usersContainer.items.upsert(userDoc, { partitionKey: identity.userId });
    return userDoc;
  }

  const existing = memoryUsers.get(identity.userId);
  const doc = {
    id: identity.userId,
    type: 'coachUser',
    userId: identity.userId,
    email: identity.email || (existing && existing.email) || null,
    name: identity.name || (existing && existing.name) || null,
    role: (existing && existing.role) || 'coach',
    teamId: normalizeId(existing && existing.teamId) || randomUUID(),
    createdAt: normalizeIsoDate((existing && existing.createdAt) || now),
    updatedAt: now,
  };
  memoryUsers.set(identity.userId, doc);
  return doc;
};

const queryBaselinesByScope = async ({ userId, teamId }) => {
  const cosmos = await getCosmos();
  if (!cosmos) {
    return getMemoryBaselines(teamId).map((row) => ({ ...row, userId, teamId }));
  }

  const { playersContainer } = cosmos;
  const query = {
    query: 'SELECT * FROM c WHERE c.type = @type AND c.teamId = @teamId',
    parameters: [
      { name: '@type', value: 'playerBaseline' },
      { name: '@teamId', value: teamId },
    ],
  };
  const result = await playersContainer.items.query(query).fetchAll();
  let resources = Array.isArray(result.resources) ? result.resources : [];

  if (resources.length === 0) {
    const legacy = await playersContainer.items
      .query({
        query: 'SELECT * FROM c WHERE c.type = @type AND c.userId = @userId AND (NOT IS_DEFINED(c.teamId) OR c.teamId = "")',
        parameters: [
          { name: '@type', value: 'playerBaseline' },
          { name: '@userId', value: userId },
        ],
      })
      .fetchAll();
    const legacyRows = Array.isArray(legacy.resources) ? legacy.resources : [];
    if (legacyRows.length > 0) {
      const now = new Date().toISOString();
      for (const row of legacyRows) {
        await playersContainer.items.upsert({ ...row, teamId, updatedAt: now }, { partitionKey: userId });
      }
      resources = legacyRows.map((row) => ({ ...row, teamId }));
    }
  }

  return resources;
};

const listBaselines = async ({ userId, teamId }) => {
  const docs = await queryBaselinesByScope({ userId, teamId });
  const normalized = docs
    .map((doc) => baselineForClient(doc))
    .filter(Boolean);
  return sortBaselines(normalized);
};

const saveBaselines = async ({ userId, teamId, payload }) => {
  const body = payload && typeof payload === 'object' ? payload : {};
  const items = Array.isArray(body.players)
    ? body.players
    : Array.isArray(body.baselines)
      ? body.baselines
      : null;

  if (!Array.isArray(items)) {
    const error = new Error('Body must include players array.');
    error.code = 'VALIDATION_ERROR';
    throw error;
  }

  const cosmos = await getCosmos();
  if (!cosmos) {
    const map = new Map();
    for (const row of getMemoryBaselines(teamId)) {
      map.set(normalizeId(row.id).toLowerCase(), { ...row });
    }
    for (const incoming of items) {
      const existing = map.get(normalizeId(incoming && (incoming.id || incoming.playerId || incoming.name)).toLowerCase()) || null;
      const normalized = normalizeBaseline(incoming, { userId, teamId }, existing);
      if (!normalized) continue;
      map.set(normalizeId(normalized.baselineId).toLowerCase(), {
        ...normalized,
        id: normalized.baselineId,
      });
    }
    const savedRows = [...map.values()].map((row) => ({ ...row, id: row.baselineId }));
    memoryBaselinesByTeam.set(teamId, sortBaselines(savedRows));
    return listBaselines({ userId, teamId });
  }

  const { playersContainer } = cosmos;
  const now = new Date().toISOString();
  for (const incoming of items) {
    const incomingId = normalizeId(incoming && (incoming.id || incoming.playerId || incoming.baselineId || incoming.name));
    if (!incomingId) continue;

    const existingQuery = await playersContainer.items
      .query({
        query: 'SELECT TOP 1 * FROM c WHERE c.type = @type AND c.teamId = @teamId AND (c.baselineId = @id OR c.playerId = @id OR c.name = @id)',
        parameters: [
          { name: '@type', value: 'playerBaseline' },
          { name: '@teamId', value: teamId },
          { name: '@id', value: incomingId },
        ],
      })
      .fetchAll();

    const existing = Array.isArray(existingQuery.resources) ? existingQuery.resources[0] : null;
    const normalized = normalizeBaseline(
      { ...incoming, updatedAt: now },
      { userId, teamId },
      existing
    );
    if (!normalized) continue;

    await playersContainer.items.upsert(normalized, {
      partitionKey: userId,
    });
  }

  return listBaselines({ userId, teamId });
};

const getStorageMode = () => (cosmosEnabled ? 'cosmos' : 'memory');

module.exports = {
  getIdentity,
  ensureUser,
  listBaselines,
  saveBaselines,
  getStorageMode,
};
