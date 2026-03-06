const { randomUUID } = require('crypto');

let CosmosClient = null;
try {
  ({ CosmosClient } = require('@azure/cosmos'));
} catch {
  CosmosClient = null;
}

const DEFAULT_DB = 'tactiq-db';
const DEFAULT_PLAYERS_CONTAINER = 'playersByUser';
const DEFAULT_USERS_CONTAINER = 'users';
const VALID_ROLES = new Set(['BAT', 'FAST', 'SPIN', 'AR']);

const DEFAULT_BASELINES = [
  { id: 'J. Archer', name: 'J. Archer', role: 'FAST', sleep: 7.5, recovery: 45, fatigueLimit: 6, control: 80, speed: 9, power: 0, active: true, inRoster: true, orderIndex: 1 },
  { id: 'R. Khan', name: 'R. Khan', role: 'SPIN', sleep: 7.1, recovery: 40, fatigueLimit: 6, control: 86, speed: 8, power: 0, active: true, inRoster: true, orderIndex: 2 },
  { id: 'M. Starc', name: 'M. Starc', role: 'FAST', sleep: 6.8, recovery: 50, fatigueLimit: 6, control: 79, speed: 9, power: 0, active: true, inRoster: true, orderIndex: 3 },
];

const memoryUsers = new Map();
const memoryBaselinesByUser = new Map();
let cosmosPromise = null;
let cosmosEnabled = false;
let cosmosConfigLogged = false;

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

const normalizeAuthHeader = (req) => {
  const headers = (req && req.headers) || {};
  const raw = headers.authorization || headers.Authorization;
  return normalizeId(Array.isArray(raw) ? raw[0] : raw);
};

const parseBase64UrlJson = (input) => {
  const raw = String(input || '').trim();
  if (!raw) return null;
  try {
    const padded = raw.replace(/-/g, '+').replace(/_/g, '/');
    const normalized = padded + '='.repeat((4 - (padded.length % 4 || 4)) % 4);
    const decoded = Buffer.from(normalized, 'base64').toString('utf8');
    const parsed = JSON.parse(decoded);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
};

const extractBearerPayload = (req) => {
  const authHeader = normalizeAuthHeader(req);
  if (!/^bearer\s+/i.test(authHeader)) return null;
  const token = authHeader.replace(/^bearer\s+/i, '').trim();
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  return parseBase64UrlJson(parts[1]);
};

const getJwtClaim = (payload, ...keys) => {
  if (!payload || typeof payload !== 'object') return '';
  for (const key of keys) {
    const value = normalizeId(payload[key]);
    if (value) return value;
  }
  return '';
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

const isLocalHostRequest = (req) => {
  const headers = (req && req.headers) || {};
  const hostHeader = headers['x-forwarded-host'] || headers['X-FORWARDED-HOST'] || headers.host || headers.Host;
  const host = normalizeId(Array.isArray(hostHeader) ? hostHeader[0] : hostHeader).toLowerCase();
  return host.includes('localhost') || host.includes('127.0.0.1');
};

const isProductionRuntime = () => {
  const functionsEnv = normalizeId(process.env.AZURE_FUNCTIONS_ENVIRONMENT).toLowerCase();
  if (functionsEnv) return functionsEnv === 'production';
  const nodeEnv = normalizeId(process.env.NODE_ENV).toLowerCase();
  return nodeEnv === 'production';
};

const getIdentity = (req) => {
  const principal = extractPrincipal(req);
  if (principal) {
    const claims = Array.isArray(principal.claims) ? principal.claims : [];
    const email = normalizeId(getClaim(claims, 'emails', 'email', 'preferred_username', 'upn'));
    const userId = normalizeId(
      principal.userId ||
      getClaim(
        claims,
        'http://schemas.microsoft.com/identity/claims/objectidentifier',
        'oid',
        'sub',
        'nameidentifier'
      ) ||
      email
    );
    if (userId) {
      return {
        userId,
        name: normalizeId(principal.userDetails || getClaim(claims, 'name', 'given_name')),
        email,
        source: 'swa',
      };
    }
  }

  const bearerPayload = extractBearerPayload(req);
  if (bearerPayload) {
    const email = normalizeId(getJwtClaim(bearerPayload, 'email', 'preferred_username', 'upn'));
    const userId = normalizeId(
      getJwtClaim(
        bearerPayload,
        'oid',
        'sub',
        'nameid',
        'nameidentifier',
        'http://schemas.microsoft.com/identity/claims/objectidentifier'
      ) ||
      email
    );
    if (userId) {
      return {
        userId,
        name: normalizeId(getJwtClaim(bearerPayload, 'name', 'given_name')),
        email,
        source: 'bearer',
      };
    }
  }

  const localRuntime = !isProductionRuntime() || isLocalHostRequest(req);
  if (localRuntime) {
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

    const allowAnonymousLocal = String(process.env.ALLOW_LOCAL_ANON_IDENTITY || 'true').trim().toLowerCase() !== 'false';
    if (allowAnonymousLocal) {
      return {
        userId: 'demo-local',
        name: 'Local Demo Coach',
        email: '',
        source: 'local-anon',
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
    normalizeId(process.env.COSMOS_CONTAINER_PLAYERS || DEFAULT_PLAYERS_CONTAINER) ||
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

const logCosmosConfigOnce = (config) => {
  if (cosmosConfigLogged) return;
  cosmosConfigLogged = true;
  console.log('[functions][cosmos] storage config', {
    database: config.databaseId,
    playersContainer: config.playersContainerId,
    usersContainer: config.usersContainerId,
  });
};

const getCosmos = async () => {
  if (cosmosPromise) return cosmosPromise;

  cosmosPromise = (async () => {
    const config = getConfig();
    logCosmosConfigOnce(config);
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

const getMemoryBaselines = (userId) => {
  const key = normalizeId(userId);
  if (!memoryBaselinesByUser.has(key)) {
    const seeded = DEFAULT_BASELINES.map((row) => ({ ...row }));
    memoryBaselinesByUser.set(key, seeded);
  }
  return memoryBaselinesByUser.get(key) || [];
};

const ensureUser = async (identity) => {
  if (!identity || !normalizeId(identity.userId)) {
    return null;
  }

  const now = new Date().toISOString();
  const defaultTeamId = identity.userId;
  const cosmos = await getCosmos();
  if (cosmos) {
    const { usersContainer } = cosmos;
    let existingUser = null;
    try {
      const result = await usersContainer.item(identity.userId, identity.userId).read();
      existingUser = result && result.resource ? result.resource : null;
    } catch (error) {
      const code = Number(error && error.code);
      const statusCode = Number(error && error.statusCode);
      const notFound = code === 404 || statusCode === 404;
      if (!notFound) throw error;
    }

    const userDoc = {
      id: identity.userId,
      type: 'userAccount',
      userId: identity.userId,
      email: identity.email || (existingUser && existingUser.email) || null,
      name: identity.name || (existingUser && existingUser.name) || null,
      teamId: normalizeId((existingUser && existingUser.teamId) || defaultTeamId) || defaultTeamId,
      role: normalizeId(existingUser && existingUser.role) || 'coach',
      createdAt: normalizeIsoDate((existingUser && existingUser.createdAt) || now),
      updatedAt: now,
    };

    await usersContainer.items.upsert(userDoc, { partitionKey: identity.userId });
    return userDoc;
  }

  const existing = memoryUsers.get(identity.userId);
  const userDoc = {
    id: identity.userId,
    type: 'userAccount',
    userId: identity.userId,
    email: identity.email || (existing && existing.email) || null,
    name: identity.name || (existing && existing.name) || null,
    teamId: normalizeId((existing && existing.teamId) || defaultTeamId) || defaultTeamId,
    role: normalizeId(existing && existing.role) || 'coach',
    createdAt: normalizeIsoDate((existing && existing.createdAt) || now),
    updatedAt: now,
  };
  memoryUsers.set(identity.userId, userDoc);
  return userDoc;
};

const queryBaselinesByScope = async ({ userId, teamId }) => {
  const normalizedUserId = normalizeId(userId);
  if (!normalizedUserId) {
    const error = new Error('userId is required.');
    error.code = 'VALIDATION_ERROR';
    throw error;
  }
  const cosmos = await getCosmos();
  if (!cosmos) {
    return getMemoryBaselines(normalizedUserId).map((row) => ({ ...row, userId: normalizedUserId, teamId }));
  }

  const { playersContainer } = cosmos;
  const query = {
    query: 'SELECT * FROM c WHERE c.type = @type AND c.userId = @userId',
    parameters: [
      { name: '@type', value: 'playerBaseline' },
      { name: '@userId', value: normalizedUserId },
    ],
  };
  const result = await playersContainer.items.query(query, { partitionKey: normalizedUserId }).fetchAll();
  return Array.isArray(result.resources) ? result.resources : [];
};

const listBaselines = async ({ userId, teamId }) => {
  const docs = await queryBaselinesByScope({ userId, teamId });
  const normalized = docs
    .map((doc) => baselineForClient(doc))
    .filter(Boolean);
  return sortBaselines(normalized);
};

const getTeamBaselineDocs = async ({ userId, teamId }) => {
  const normalizedUserId = requireUserId(userId);
  const cosmos = await getCosmos();
  if (!cosmos) return [];
  const { playersContainer } = cosmos;
  const query = {
    query: 'SELECT * FROM c WHERE c.type = @type AND c.userId = @userId',
    parameters: [
      { name: '@type', value: 'playerBaseline' },
      { name: '@userId', value: normalizedUserId },
    ],
  };
  const result = await playersContainer.items.query(query, { partitionKey: normalizedUserId }).fetchAll();
  return Array.isArray(result.resources)
    ? result.resources
    : [];
};

const requireUserId = (userId) => {
  const normalizedUserId = normalizeId(userId);
  if (normalizedUserId) return normalizedUserId;
  const error = new Error('userId is required.');
  error.code = 'VALIDATION_ERROR';
  throw error;
};

const getWriteVerificationMeta = () => {
  const config = getConfig();
  return {
    db: config.databaseId,
    container: config.playersContainerId,
    note: 'Safe to delete old players container after verification.',
  };
};

const logPlayersWriteVerification = (op, userId, count = 0) => {
  const mode = String(process.env.NODE_ENV || '').trim().toLowerCase();
  if (mode === 'test') return;
  const meta = getWriteVerificationMeta();
  console.log('[playersByUser][verify]', {
    op,
    userId: normalizeId(userId),
    count: Number.isFinite(Number(count)) ? Number(count) : 0,
    db: meta.db,
    container: meta.container,
    note: meta.note,
  });
};

const queryBaselineDocsForUser = async ({ userId, baselineId }) => {
  const normalizedUserId = requireUserId(userId);
  const normalizedId = normalizeId(baselineId);
  if (!normalizedId) return [];

  const cosmos = await getCosmos();
  if (!cosmos) {
    const rows = getMemoryBaselines(normalizedUserId).filter((row) => {
      const key = normalizeId(row.id || row.playerId || row.baselineId || row.name);
      return key === normalizedId;
    });
    return rows.map((row) => ({ ...row, userId: normalizedUserId }));
  }

  const { playersContainer } = cosmos;
  const result = await playersContainer.items
    .query({
      query: 'SELECT * FROM c WHERE c.type = @type AND c.userId = @userId AND (c.baselineId = @id OR c.playerId = @id OR c.name = @id OR c.id = @id)',
      parameters: [
        { name: '@type', value: 'playerBaseline' },
        { name: '@userId', value: normalizedUserId },
        { name: '@id', value: normalizedId },
      ],
    }, { partitionKey: normalizedUserId })
    .fetchAll();
  return Array.isArray(result.resources) ? result.resources : [];
};

const queryAnyUserBaselineDoc = async (baselineId) => {
  const normalizedId = normalizeId(baselineId);
  if (!normalizedId) return null;
  const cosmos = await getCosmos();
  if (!cosmos) return null;

  const { playersContainer } = cosmos;
  const result = await playersContainer.items
    .query({
      query: 'SELECT TOP 1 c.id, c.userId FROM c WHERE c.type = @type AND (c.baselineId = @id OR c.playerId = @id OR c.name = @id OR c.id = @id)',
      parameters: [
        { name: '@type', value: 'playerBaseline' },
        { name: '@id', value: normalizedId },
      ],
    })
    .fetchAll();
  const row = Array.isArray(result.resources) ? result.resources[0] : null;
  if (!row || typeof row !== 'object') return null;
  return {
    id: normalizeId(row.id),
    userId: normalizeId(row.userId),
  };
};

const checkBaselineOwnership = async ({ userId, baselineId }) => {
  const normalizedUserId = requireUserId(userId);
  const normalizedId = normalizeId(baselineId);
  if (!normalizedId) return { exists: false, owned: false };

  const ownedRows = await queryBaselineDocsForUser({ userId: normalizedUserId, baselineId: normalizedId });
  if (ownedRows.length > 0) {
    return { exists: true, owned: true, ownerUserId: normalizedUserId };
  }

  const owner = await queryAnyUserBaselineDoc(normalizedId);
  if (owner && owner.userId && owner.userId !== normalizedUserId) {
    return { exists: true, owned: false, ownerUserId: owner.userId };
  }

  return { exists: false, owned: false };
};

const saveBaselines = async ({ userId, teamId, payload }) => {
  const scopedUserId = requireUserId(userId);
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
    for (const row of getMemoryBaselines(scopedUserId)) {
      map.set(normalizeId(row.id).toLowerCase(), { ...row });
    }
    for (const incoming of items) {
      const existing = map.get(normalizeId(incoming && (incoming.id || incoming.playerId || incoming.name)).toLowerCase()) || null;
      const normalized = normalizeBaseline(incoming, { userId: scopedUserId, teamId }, existing);
      if (!normalized) continue;
      map.set(normalizeId(normalized.baselineId).toLowerCase(), {
        ...normalized,
        id: normalized.baselineId,
      });
    }
    const savedRows = [...map.values()].map((row) => ({ ...row, id: row.baselineId }));
    memoryBaselinesByUser.set(scopedUserId, sortBaselines(savedRows));
    logPlayersWriteVerification('save.memory', scopedUserId, savedRows.length);
    return listBaselines({ userId: scopedUserId, teamId });
  }

  const { playersContainer } = cosmos;
  const now = new Date().toISOString();
  let upsertedCount = 0;
  for (const incoming of items) {
    const incomingId = normalizeId(incoming && (incoming.id || incoming.playerId || incoming.baselineId || incoming.name));
    if (!incomingId) continue;

    const existingQuery = await playersContainer.items
      .query({
        query: 'SELECT TOP 1 * FROM c WHERE c.type = @type AND c.userId = @userId AND (c.baselineId = @id OR c.playerId = @id OR c.name = @id)',
        parameters: [
          { name: '@type', value: 'playerBaseline' },
          { name: '@userId', value: scopedUserId },
          { name: '@id', value: incomingId },
        ],
      }, { partitionKey: scopedUserId })
      .fetchAll();

    const existing = Array.isArray(existingQuery.resources) ? existingQuery.resources[0] : null;
    const normalized = normalizeBaseline(
      { ...incoming, updatedAt: now },
      { userId: scopedUserId, teamId },
      existing
    );
    if (!normalized) continue;

    await playersContainer.items.upsert(normalized, {
      partitionKey: scopedUserId,
    });
    upsertedCount += 1;
  }

  logPlayersWriteVerification('save.cosmos', scopedUserId, upsertedCount);
  return listBaselines({ userId: scopedUserId, teamId });
};

const replaceBaselines = async ({ userId, teamId, payload }) => {
  const scopedUserId = requireUserId(userId);
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
    const nextRows = items
      .map((incoming, index) => normalizeBaseline(
        { ...(incoming && typeof incoming === 'object' ? incoming : {}), orderIndex: incoming?.orderIndex ?? index + 1 },
        { userId: scopedUserId, teamId },
        null
      ))
      .filter(Boolean)
      .map((row) => ({ ...row, id: row.baselineId }));
    memoryBaselinesByUser.set(scopedUserId, sortBaselines(nextRows));
    logPlayersWriteVerification('replace.memory', scopedUserId, nextRows.length);
    return listBaselines({ userId: scopedUserId, teamId });
  }

  const { playersContainer } = cosmos;
  const existingRows = await getTeamBaselineDocs({ userId: scopedUserId, teamId });
  for (const row of existingRows) {
    const docId = normalizeId(row && row.id);
    if (!docId) continue;
    await playersContainer.item(docId, scopedUserId).delete();
  }

  const now = new Date().toISOString();
  let upsertedCount = 0;
  for (let index = 0; index < items.length; index += 1) {
    const incoming = items[index];
    const normalized = normalizeBaseline(
      { ...(incoming && typeof incoming === 'object' ? incoming : {}), orderIndex: incoming?.orderIndex ?? index + 1, updatedAt: now },
      { userId: scopedUserId, teamId },
      null
    );
    if (!normalized) continue;
    await playersContainer.items.upsert(normalized, { partitionKey: scopedUserId });
    upsertedCount += 1;
  }

  logPlayersWriteVerification('replace.cosmos', scopedUserId, upsertedCount);
  return listBaselines({ userId: scopedUserId, teamId });
};

const deleteBaselineById = async ({ userId, teamId, baselineId }) => {
  const scopedUserId = requireUserId(userId);
  const normalizedId = normalizeId(baselineId);
  if (!normalizedId) return listBaselines({ userId: scopedUserId, teamId });

  const cosmos = await getCosmos();
  if (!cosmos) {
    const current = getMemoryBaselines(scopedUserId);
    const filtered = current.filter((row) => normalizeId(row.id || row.playerId || row.baselineId || row.name) !== normalizedId);
    if (filtered.length === current.length) {
      const ownership = await checkBaselineOwnership({ userId: scopedUserId, baselineId: normalizedId });
      if (ownership.exists && !ownership.owned) {
        const error = new Error('Forbidden: baseline belongs to a different user.');
        error.code = 403;
        throw error;
      }
    }
    memoryBaselinesByUser.set(scopedUserId, filtered);
    logPlayersWriteVerification('delete.memory', scopedUserId, current.length - filtered.length);
    return listBaselines({ userId: scopedUserId, teamId });
  }

  const { playersContainer } = cosmos;
  const rows = await queryBaselineDocsForUser({ userId: scopedUserId, baselineId: normalizedId });
  if (rows.length === 0) {
    const ownership = await checkBaselineOwnership({ userId: scopedUserId, baselineId: normalizedId });
    if (ownership.exists && !ownership.owned) {
      const error = new Error('Forbidden: baseline belongs to a different user.');
      error.code = 403;
      throw error;
    }
  }
  for (const row of rows) {
    const docId = normalizeId(row && row.id);
    if (!docId) continue;
    await playersContainer.item(docId, scopedUserId).delete();
  }
  logPlayersWriteVerification('delete.cosmos', scopedUserId, rows.length);
  return listBaselines({ userId: scopedUserId, teamId });
};

const resetBaselines = async ({ userId, teamId }) => {
  return replaceBaselines({
    userId,
    teamId,
    payload: { players: DEFAULT_BASELINES.map((row) => ({ ...row })) },
  });
};

const getStorageMode = () => (cosmosEnabled ? 'cosmos' : 'memory');

module.exports = {
  getIdentity,
  ensureUser,
  listBaselines,
  saveBaselines,
  replaceBaselines,
  deleteBaselineById,
  checkBaselineOwnership,
  resetBaselines,
  getStorageMode,
};
