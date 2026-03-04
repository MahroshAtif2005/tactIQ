const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const DEFAULT_DATABASE = 'tactiq-db';
const DEFAULT_CONTAINER = 'players';
const DEFAULT_COACH_CONTAINER = 'playersByCoach';
const DEFAULT_USERS_CONTAINER = 'users';
const FALLBACK_BASELINES_PATH =
  process.env.BASELINE_FALLBACK_FILE ||
  path.resolve(process.cwd(), 'server/data/baselines.json');

const VALID_ROLES = new Set(['BAT', 'FAST', 'SPIN', 'AR']);

const DEFAULT_SEED_BASELINES = [
  {
    id: 'J. Archer',
    orderIndex: 1,
    role: 'FAST',
    sleep: 7.5,
    recovery: 45,
    fatigueLimit: 6,
    control: 80,
    speed: 9,
    power: 0,
    active: true,
  },
  {
    id: 'R. Khan',
    orderIndex: 2,
    role: 'SPIN',
    sleep: 7.1,
    recovery: 40,
    fatigueLimit: 6,
    control: 86,
    speed: 8,
    power: 0,
    active: true,
  },
  {
    id: 'B. Stokes',
    orderIndex: 3,
    role: 'AR',
    sleep: 7.3,
    recovery: 55,
    fatigueLimit: 6,
    control: 75,
    speed: 8,
    power: 7,
    active: true,
  },
  {
    id: 'M. Starc',
    orderIndex: 4,
    role: 'FAST',
    sleep: 6.8,
    recovery: 50,
    fatigueLimit: 6,
    control: 79,
    speed: 9,
    power: 0,
    active: true,
  },
  {
    id: 'V. Kohli',
    orderIndex: 5,
    role: 'BAT',
    sleep: 7.6,
    recovery: 35,
    fatigueLimit: 5,
    control: 90,
    speed: 7,
    power: 6,
    active: true,
  },
];

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const normalizeId = (value) => String(value || '').trim();
const normalizeUserId = (value) => String(value || '').trim();
const normalizeTeamId = (value) => String(value || '').trim();
const normalizeBaselineKey = (value) => String(value || '').trim().toLowerCase();
const normalizeOrderIndex = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
};
const hasPositiveOrderIndex = (value) => normalizeOrderIndex(value) > 0;

const normalizeIsoTimestamp = (value) => {
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return new Date().toISOString();
};

const parseNumericField = (raw, fieldName, min, max, fallback, strict, errors) => {
  if (raw === undefined || raw === null || raw === '') {
    if (strict) {
      errors.push(`${fieldName} is required`);
    }
    return clamp(fallback, min, max);
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    errors.push(`${fieldName} must be a valid number`);
    return clamp(fallback, min, max);
  }

  return clamp(parsed, min, max);
};

const normalizeRole = (raw, strict, errors) => {
  const role = String(raw || '').trim().toUpperCase();
  if (!role) {
    if (strict) errors.push('role is required');
    return 'FAST';
  }
  if (!VALID_ROLES.has(role)) {
    errors.push('role must be one of BAT, FAST, SPIN, AR');
    return 'FAST';
  }
  return role;
};

const normalizeActive = (raw, strict, errors) => {
  if (typeof raw === 'boolean') return raw;
  if (raw === undefined || raw === null) {
    return true;
  }

  if (strict) {
    errors.push('active must be a boolean');
    return true;
  }
  return Boolean(raw);
};

const normalizeInRoster = (raw, fallbackRaw, strict, errors) => {
  if (typeof raw === 'boolean') return raw;
  if (typeof fallbackRaw === 'boolean') return fallbackRaw;
  if (raw === undefined || raw === null) {
    return false;
  }

  if (strict) {
    errors.push('inRoster must be a boolean');
    return false;
  }
  return Boolean(raw);
};

const validateAndNormalizeBaseline = (raw, options = {}) => {
  const strict = options.strict === true;
  const errors = [];
  const payload = isRecord(raw) ? raw : {};

  const id = normalizeId(payload.baselineId || payload.playerId || payload.id || payload.name);
  if (!id && strict) {
    errors.push('id is required');
  }

  const role = normalizeRole(payload.role, strict, errors);

  const normalized = {
    id: id || 'Unknown Player',
    baselineId: id || 'Unknown Player',
    type: 'playerBaseline',
    userId: normalizeUserId(payload.userId),
    teamId: normalizeTeamId(payload.teamId),
    name: String(payload.name || id || 'Unknown Player').trim() || 'Unknown Player',
    role,
    sleep: parseNumericField(
      payload.sleep !== undefined ? payload.sleep : payload.sleepHoursToday,
      'sleep',
      0,
      12,
      7,
      strict,
      errors
    ),
    recovery: parseNumericField(
      payload.recovery !== undefined ? payload.recovery : payload.recoveryMinutes,
      'recovery',
      0,
      240,
      45,
      strict,
      errors
    ),
    fatigueLimit: parseNumericField(payload.fatigueLimit, 'fatigueLimit', 0, 10, 6, strict, errors),
    control: parseNumericField(
      payload.control !== undefined ? payload.control : payload.controlBaseline,
      'control',
      0,
      100,
      78,
      strict,
      errors
    ),
    speed: parseNumericField(payload.speed, 'speed', 0, 100, 7, strict, errors),
    power: parseNumericField(payload.power, 'power', 0, 100, 0, strict, errors),
    active: normalizeActive(payload.active !== undefined ? payload.active : payload.isActive, strict, errors),
    inRoster: normalizeInRoster(payload.inRoster, payload.roster, strict, errors),
    orderIndex: normalizeOrderIndex(payload.orderIndex),
    createdAt: normalizeIsoTimestamp(payload.createdAt),
    updatedAt: normalizeIsoTimestamp(payload.updatedAt),
  };

  if (errors.length > 0) {
    return { ok: false, errors, value: normalized };
  }
  return { ok: true, errors: [], value: normalized };
};

const buildDefaultBaselines = () =>
  sortByOrderIndex(DEFAULT_SEED_BASELINES.map((item) => validateAndNormalizeBaseline(item, { strict: false }).value));

const sortByOrderIndex = (rows) =>
  [...rows]
    .map((row, index) => ({
      row,
      index,
      orderIndex: normalizeOrderIndex(row?.orderIndex),
    }))
    .sort((a, b) => {
      if (a.orderIndex !== b.orderIndex) return a.orderIndex - b.orderIndex;
      return a.index - b.index;
    })
    .map((entry) => entry.row);

const sortBaselines = (rows) => sortByOrderIndex(rows);

const dedupeBaselinesById = (rows) => {
  const deduped = new Map();
  rows.forEach((row) => {
    const normalized = validateAndNormalizeBaseline(row, { strict: false }).value;
    const key = normalizeId(normalized.id).toLowerCase();
    if (!key) return;
    deduped.set(key, normalized);
  });
  return sortBaselines([...deduped.values()]);
};

const writeFallbackBaselinesToDisk = () => {
  try {
    fs.mkdirSync(path.dirname(FALLBACK_BASELINES_PATH), { recursive: true });
    fs.writeFileSync(FALLBACK_BASELINES_PATH, JSON.stringify(sortBaselines(fallbackBaselines), null, 2), 'utf8');
  } catch (error) {
    console.warn('[cosmos-fallback] failed to write baselines file:', error.message || String(error));
  }
};

const readFallbackBaselinesFromDisk = () => {
  if (!fs.existsSync(FALLBACK_BASELINES_PATH)) return null;
  try {
    const raw = fs.readFileSync(FALLBACK_BASELINES_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const normalized = dedupeBaselinesById(parsed);
    return normalized.length > 0 ? normalized : null;
  } catch (error) {
    console.warn('[cosmos-fallback] failed to read baselines file:', error.message || String(error));
    return null;
  }
};

let fallbackBaselines = readFallbackBaselinesFromDisk() || buildDefaultBaselines();
writeFallbackBaselinesToDisk();

const cloneFallbackBaselines = () => fallbackBaselines.map((item) => ({ ...item }));

const firstNonEmptyEnv = (...values) => {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const normalized = value.trim();
    if (normalized.length > 0) return normalized;
  }
  return '';
};

const getConfig = () => ({
  connectionString: String(process.env.COSMOS_CONNECTION_STRING || '').trim(),
  endpoint: firstNonEmptyEnv(process.env.COSMOS_ENDPOINT, process.env.AZURE_COSMOS_ENDPOINT),
  key: firstNonEmptyEnv(process.env.COSMOS_KEY, process.env.AZURE_COSMOS_KEY),
  databaseId: firstNonEmptyEnv(
    process.env.COSMOS_DB,
    process.env.COSMOS_DATABASE,
    process.env.AZURE_COSMOS_DATABASE,
    process.env.COSMOS_DATABASE_NAME,
    process.env.COSMOS_DATABASE_ID,
    process.env.COSMOS_DB_NAME
  ),
  containerId: firstNonEmptyEnv(
    process.env.COSMOS_CONTAINER,
    process.env.AZURE_COSMOS_CONTAINER,
    process.env.COSMOS_CONTAINER_NAME,
    process.env.COSMOS_CONTAINER_ID,
    process.env.COSMOS_CONTAINER_PLAYERS
  ),
  coachContainerId: firstNonEmptyEnv(
    process.env.COSMOS_COACH_CONTAINER,
    process.env.COSMOS_CONTAINER_BY_COACH,
    process.env.COSMOS_CONTAINER_PLAYERS_BY_COACH,
    DEFAULT_COACH_CONTAINER
  ),
  usersContainerId: firstNonEmptyEnv(
    process.env.COSMOS_USERS_CONTAINER,
    process.env.COSMOS_CONTAINER_USERS,
    DEFAULT_USERS_CONTAINER
  ),
});

const parseCosmosAccount = (config) => {
  if (config.endpoint) {
    try {
      const { host } = new URL(config.endpoint);
      return host || null;
    } catch {
      return null;
    }
  }
  if (config.connectionString) {
    const match = config.connectionString.match(/AccountEndpoint=https?:\/\/([^;\/]+)/i);
    return match && match[1] ? match[1] : null;
  }
  return null;
};

const createCosmosUnavailableError = (message = 'Cosmos not configured or unavailable.') => {
  const error = new Error(message);
  error.code = 'COSMOS_NOT_CONFIGURED';
  error.statusCode = 503;
  return error;
};

let cosmosEnvLogged = false;
const logCosmosEnvOnce = () => {
  if (cosmosEnvLogged) return;
  cosmosEnvLogged = true;
  const config = getConfig();
  console.log('COSMOS_ENV', {
    endpointPresent: config.endpoint.length > 0 || config.connectionString.length > 0,
    keyPresent: config.key.length > 0 || config.connectionString.length > 0,
    db: config.databaseId,
    container: config.containerId,
  });
};

const logCosmosConnectFail = (error) => {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const statusCode = error && typeof error === 'object' && 'statusCode' in error ? error.statusCode : undefined;
  const message = error instanceof Error ? error.message : String(error);
  console.error('COSMOS_CONNECT_FAIL', { code, message, statusCode });
};

const isCosmosConfigured = () => {
  logCosmosEnvOnce();
  const config = getConfig();
  const hasAccountAuth = config.connectionString.length > 0 || (config.endpoint.length > 0 && config.key.length > 0);
  return hasAccountAuth && config.databaseId.length > 0 && config.containerId.length > 0;
};

let cachedContainer = null;
let cachedCoachContainer = null;
let cachedUsersContainer = null;
let initPromise = null;
let coachInitPromise = null;
let usersInitPromise = null;
let initError = null;
let cosmosCtor = null;

const loadCosmosClientCtor = () => {
  if (cosmosCtor) return cosmosCtor;
  try {
    const { CosmosClient } = require('@azure/cosmos');
    cosmosCtor = CosmosClient;
    return cosmosCtor;
  } catch (error) {
    initError = error;
    return null;
  }
};

const getContainer = async () => {
  logCosmosEnvOnce();
  if (!isCosmosConfigured()) return null;
  if (cachedContainer) return cachedContainer;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const CosmosClient = loadCosmosClientCtor();
    if (!CosmosClient) return null;

    const { connectionString, endpoint, key, databaseId, containerId } = getConfig();
    const client = connectionString
      ? new CosmosClient(connectionString)
      : new CosmosClient({ endpoint, key });

    const { database } = await client.databases.createIfNotExists({ id: databaseId });
    const { container } = await database.containers.createIfNotExists({
      id: containerId,
      partitionKey: { paths: ['/id'] },
    });

    cachedContainer = container;
    initError = null;
    return container;
  })().catch((error) => {
    initError = error;
    logCosmosConnectFail(error);
    return null;
  });

  return initPromise;
};

const getCoachContainer = async () => {
  logCosmosEnvOnce();
  if (!isCosmosConfigured()) return null;
  if (cachedCoachContainer) return cachedCoachContainer;
  if (coachInitPromise) return coachInitPromise;

  coachInitPromise = (async () => {
    const CosmosClient = loadCosmosClientCtor();
    if (!CosmosClient) return null;

    const { connectionString, endpoint, key, databaseId, coachContainerId } = getConfig();
    const client = connectionString
      ? new CosmosClient(connectionString)
      : new CosmosClient({ endpoint, key });

    const { database } = await client.databases.createIfNotExists({ id: databaseId });
    const { container } = await database.containers.createIfNotExists({
      id: coachContainerId || DEFAULT_COACH_CONTAINER,
      partitionKey: { paths: ['/userId'] },
    });

    cachedCoachContainer = container;
    return container;
  })().catch((error) => {
    initError = error;
    logCosmosConnectFail(error);
    return null;
  });

  return coachInitPromise;
};

const getUsersContainer = async () => {
  logCosmosEnvOnce();
  if (!isCosmosConfigured()) return null;
  if (cachedUsersContainer) return cachedUsersContainer;
  if (usersInitPromise) return usersInitPromise;

  usersInitPromise = (async () => {
    const CosmosClient = loadCosmosClientCtor();
    if (!CosmosClient) return null;

    const { connectionString, endpoint, key, databaseId, usersContainerId } = getConfig();
    const client = connectionString
      ? new CosmosClient(connectionString)
      : new CosmosClient({ endpoint, key });

    const { database } = await client.databases.createIfNotExists({ id: databaseId });
    const { container } = await database.containers.createIfNotExists({
      id: usersContainerId || DEFAULT_USERS_CONTAINER,
      partitionKey: { paths: ['/userId'] },
    });

    cachedUsersContainer = container;
    return container;
  })().catch((error) => {
    initError = error;
    logCosmosConnectFail(error);
    return null;
  });

  return usersInitPromise;
};

const chunk = (items, size) => {
  const batches = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
};

const resolveScope = (scope = {}) => ({
  userId: normalizeUserId(scope?.userId),
  teamId: normalizeTeamId(scope?.teamId),
});

const buildScopeFilter = (scope = {}, alias = 'c') => {
  const { userId, teamId } = resolveScope(scope);
  if (teamId) {
    return {
      query: `${alias}.teamId = @teamId`,
      parameters: [{ name: '@teamId', value: teamId }],
      partitionKey: userId || undefined,
    };
  }
  if (userId) {
    return {
      query: `${alias}.userId = @userId`,
      parameters: [{ name: '@userId', value: userId }],
      partitionKey: userId,
    };
  }
  return {
    query: '',
    parameters: [],
    partitionKey: undefined,
  };
};

const normalizeCoachUser = (raw, fallback = {}) => {
  const payload = isRecord(raw) ? raw : {};
  const fallbackRecord = isRecord(fallback) ? fallback : {};
  const now = new Date().toISOString();
  const userId = normalizeUserId(payload.userId || payload.id || fallbackRecord.userId || fallbackRecord.id);
  const teamId = normalizeTeamId(payload.teamId || fallbackRecord.teamId) || randomUUID();
  return {
    id: userId,
    type: 'coachUser',
    userId,
    teamId,
    email: String(payload.email || fallbackRecord.email || '').trim() || null,
    name: String(payload.name || fallbackRecord.name || '').trim() || null,
    role: String(payload.role || fallbackRecord.role || 'coach').trim() || 'coach',
    createdAt: normalizeIsoTimestamp(payload.createdAt || fallbackRecord.createdAt || now),
    updatedAt: normalizeIsoTimestamp(now),
  };
};

const ensureCoachUserProfile = async ({ userId, email, name } = {}) => {
  const normalizedUserId = normalizeUserId(userId);
  if (!normalizedUserId) {
    const error = new Error('userId is required to ensure coach profile.');
    error.code = 'VALIDATION_ERROR';
    throw error;
  }
  if (!isCosmosConfigured()) {
    throw createCosmosUnavailableError('Cannot ensure coach profile: Cosmos is not configured.');
  }
  const container = await getUsersContainer();
  if (!container) {
    throw createCosmosUnavailableError('Cannot ensure coach profile: users container unavailable.');
  }

  let existing = null;
  try {
    const { resource } = await container.item(normalizedUserId, normalizedUserId).read();
    existing = resource || null;
  } catch (error) {
    const statusCode = Number(error?.code || error?.statusCode);
    if (statusCode !== 404) throw error;
  }

  const merged = normalizeCoachUser(
    {
      ...(existing || {}),
      id: normalizedUserId,
      userId: normalizedUserId,
      ...(typeof email === 'string' && email.trim().length > 0 ? { email: email.trim() } : {}),
      ...(typeof name === 'string' && name.trim().length > 0 ? { name: name.trim() } : {}),
    },
    existing || {}
  );
  await container.items.upsert(merged, { partitionKey: normalizedUserId });
  return merged;
};

const backfillBaselinesTeamId = async ({ userId, teamId } = {}) => {
  const normalizedUserId = normalizeUserId(userId);
  const normalizedTeamId = normalizeTeamId(teamId);
  if (!normalizedUserId || !normalizedTeamId) return { updated: 0 };
  if (!isCosmosConfigured()) {
    throw createCosmosUnavailableError('Cannot backfill teamId: Cosmos is not configured.');
  }

  const container = await getCoachContainer();
  if (!container) {
    throw createCosmosUnavailableError('Cannot backfill teamId: coach container unavailable.');
  }

  const result = await container.items
    .query({
      query:
        'SELECT * FROM c WHERE c.type = @type AND c.userId = @userId AND (NOT IS_DEFINED(c.teamId) OR c.teamId = "")',
      parameters: [
        { name: '@type', value: 'playerBaseline' },
        { name: '@userId', value: normalizedUserId },
      ],
    })
    .fetchAll();

  const docs = Array.isArray(result.resources) ? result.resources : [];
  if (docs.length === 0) return { updated: 0 };

  const batches = chunk(docs, 5);
  for (const batch of batches) {
    await Promise.all(
      batch.map((doc) =>
        container.items.upsert(
          {
            ...doc,
            teamId: normalizedTeamId,
            updatedAt: new Date().toISOString(),
          },
          { partitionKey: normalizedUserId }
        )
      )
    );
  }
  return { updated: docs.length };
};

const getAllBaselines = async (scope = {}) => {
  const { userId, teamId } = resolveScope(scope);
  logCosmosEnvOnce();
  if (!isCosmosConfigured()) {
    throw createCosmosUnavailableError('Cosmos baselines are unavailable: missing configuration.');
  }

  const container = userId || teamId ? await getCoachContainer() : await getContainer();
  if (!container) {
    throw createCosmosUnavailableError('Cosmos baselines are unavailable: container not initialized.');
  }

  let resources;
  try {
    const scopeFilter = buildScopeFilter({ userId, teamId });
    const queryText = scopeFilter.query
      ? `SELECT * FROM c WHERE c.type = @type AND ${scopeFilter.query}`
      : 'SELECT * FROM c WHERE c.type = @type';
    const parameters = [{ name: '@type', value: 'playerBaseline' }, ...scopeFilter.parameters];
    const result = await container.items
      .query({
        query: queryText,
        parameters,
        ...(scopeFilter.partitionKey ? { partitionKey: scopeFilter.partitionKey } : {}),
      })
      .fetchAll();
    resources = result.resources;
  } catch (error) {
    logCosmosConnectFail(error);
    throw error;
  }

  const normalized = (Array.isArray(resources) ? resources : []).map(
    (item) => validateAndNormalizeBaseline(item, { strict: false }).value
  );
  return sortBaselines(normalized);
};

const getRosterBaselines = async (scope = {}) => {
  const { userId, teamId } = resolveScope(scope);
  logCosmosEnvOnce();
  if (!isCosmosConfigured()) {
    throw createCosmosUnavailableError('Cosmos baselines are unavailable: missing configuration.');
  }

  const container = userId || teamId ? await getCoachContainer() : await getContainer();
  if (!container) {
    throw createCosmosUnavailableError('Cosmos baselines are unavailable: container not initialized.');
  }

  let resources;
  try {
    const scopeFilter = buildScopeFilter({ userId, teamId });
    const queryText = scopeFilter.query
      ? `SELECT * FROM c WHERE c.type = @type AND ${scopeFilter.query} AND (c.active = true OR NOT IS_DEFINED(c.active)) AND (c.inRoster = true OR c.roster = true)`
      : 'SELECT * FROM c WHERE (NOT IS_DEFINED(c.type) OR c.type = @type) AND (c.active = true OR NOT IS_DEFINED(c.active)) AND (c.inRoster = true OR c.roster = true)';
    const parameters = [{ name: '@type', value: 'playerBaseline' }, ...scopeFilter.parameters];
    const result = await container.items
      .query({
        query: queryText,
        parameters,
        ...(scopeFilter.partitionKey ? { partitionKey: scopeFilter.partitionKey } : {}),
      })
      .fetchAll();
    resources = result.resources;
  } catch (error) {
    logCosmosConnectFail(error);
    throw error;
  }

  const normalized = (Array.isArray(resources) ? resources : []).map(
    (item) => validateAndNormalizeBaseline(item, { strict: false }).value
  );
  return sortBaselines(normalized.filter((item) => item.inRoster === true));
};

const fetchExistingOrderIndexMap = async (container, scope = {}) => {
  const { userId, teamId } = resolveScope(scope);
  if (!container) return new Map();
  try {
    const scopeFilter = buildScopeFilter({ userId, teamId });
    const queryText = scopeFilter.query
      ? `SELECT c.id, c.baselineId, c.playerId, c.orderIndex, c.createdAt FROM c WHERE c.type = @type AND ${scopeFilter.query}`
      : 'SELECT c.id, c.orderIndex FROM c WHERE (NOT IS_DEFINED(c.type) OR c.type = @type)';
    const parameters = [{ name: '@type', value: 'playerBaseline' }, ...scopeFilter.parameters];
    const result = await container.items
      .query({
        query: queryText,
        parameters,
        ...(scopeFilter.partitionKey ? { partitionKey: scopeFilter.partitionKey } : {}),
      })
      .fetchAll();
    const map = new Map();
    (Array.isArray(result.resources) ? result.resources : []).forEach((row) => {
      const key = userId || teamId
        ? normalizeBaselineKey(row?.baselineId || row?.playerId || row?.name || row?.id)
        : normalizeBaselineKey(row?.id);
      if (!key) return;
      map.set(key, {
        orderIndex: normalizeOrderIndex(row?.orderIndex),
        docId: normalizeId(row?.id),
        createdAt: normalizeIsoTimestamp(row?.createdAt),
      });
    });
    return map;
  } catch (error) {
    logCosmosConnectFail(error);
    return new Map();
  }
};

const getMaxOrderIndex = (values) => {
  let max = 0;
  values.forEach((value) => {
    const normalized = normalizeOrderIndex(value);
    if (normalized > max) max = normalized;
  });
  return max;
};

const getBaseline = async (id, scope = {}) => {
  const { userId, teamId } = resolveScope(scope);
  const normalizedId = normalizeId(id);
  if (!normalizedId) return null;

  if (!isCosmosConfigured() || userId || teamId) {
    if (userId || teamId) {
      const container = await getCoachContainer();
      if (!container) {
        throw createCosmosUnavailableError('Cosmos baselines are unavailable: coach container not initialized.');
      }
      try {
        const scopeFilter = buildScopeFilter({ userId, teamId });
        if (!scopeFilter.query) return null;
        const queryText = `SELECT TOP 1 * FROM c WHERE c.type = @type AND ${scopeFilter.query} AND (c.baselineId = @id OR c.playerId = @id OR c.name = @id)`;
        const result = await container.items
          .query({
            query: queryText,
            parameters: [{ name: '@type', value: 'playerBaseline' }, ...scopeFilter.parameters, { name: '@id', value: normalizedId }],
            ...(scopeFilter.partitionKey ? { partitionKey: scopeFilter.partitionKey } : {}),
          })
          .fetchAll();
        const resource = Array.isArray(result.resources) ? result.resources[0] : null;
        if (!resource) return null;
        return validateAndNormalizeBaseline(resource, { strict: false }).value;
      } catch (error) {
        const statusCode = Number(error?.code || error?.statusCode);
        if (statusCode === 404) return null;
        throw error;
      }
    }

    const lowered = normalizedId.toLowerCase();
    return cloneFallbackBaselines().find((item) => normalizeId(item.id).toLowerCase() === lowered) || null;
  }

  const container = await getContainer();
  if (!container) {
    const lowered = normalizedId.toLowerCase();
    return cloneFallbackBaselines().find((item) => normalizeId(item.id).toLowerCase() === lowered) || null;
  }

  try {
    const { resource } = await container.item(normalizedId, normalizedId).read();
    if (!resource) return null;
    return validateAndNormalizeBaseline(resource, { strict: false }).value;
  } catch (error) {
    const statusCode = Number(error?.code || error?.statusCode);
    if (statusCode === 404) return null;
    throw error;
  }
};

const upsertBaselines = async (players, scope = {}) => {
  const { userId, teamId } = resolveScope(scope);
  const rows = Array.isArray(players) ? players : [];
  const normalizedEntries = [];
  const errors = [];

  rows.forEach((row, index) => {
    const incomingOrderIndex = normalizeOrderIndex(row?.orderIndex);
    const hasIncomingOrderIndex = hasPositiveOrderIndex(incomingOrderIndex);
    const result = validateAndNormalizeBaseline(
      {
        ...row,
        updatedAt: new Date().toISOString(),
      },
      { strict: true }
    );

    if (!result.ok) {
      errors.push(`players[${index}]: ${result.errors.join(', ')}`);
      return;
    }
    normalizedEntries.push({
      value: result.value,
      hasIncomingOrderIndex,
      incomingOrderIndex,
    });
  });

  if (errors.length > 0) {
    const error = new Error('Invalid baselines payload.');
    error.code = 'VALIDATION_ERROR';
    error.details = errors;
    throw error;
  }

  const dedupedById = new Map();
  normalizedEntries.forEach((entry) => {
    const key = normalizeBaselineKey(entry.value.id);
    if (!key) return;
    dedupedById.set(key, entry);
  });
  const dedupedEntries = [...dedupedById.values()];

  if (!isCosmosConfigured()) {
    throw createCosmosUnavailableError('Cannot save baselines: Cosmos is not configured.');
  }

  const container = userId || teamId ? await getCoachContainer() : await getContainer();
  if (!container) {
    throw createCosmosUnavailableError('Cannot save baselines: Cosmos container unavailable.');
  }

  const existingOrderById = await fetchExistingOrderIndexMap(container, userId || teamId ? { userId, teamId } : {});
  const maxFromExisting = getMaxOrderIndex(
    [...existingOrderById.values()].map((entry) =>
      entry && typeof entry === 'object' ? normalizeOrderIndex(entry.orderIndex) : normalizeOrderIndex(entry)
    )
  );
  const maxFromIncoming = getMaxOrderIndex(
    dedupedEntries.map((entry) => (entry.hasIncomingOrderIndex ? entry.incomingOrderIndex : 0))
  );
  let nextOrderIndex = Math.max(maxFromExisting, maxFromIncoming);

  const itemsToUpsert = dedupedEntries.map((entry) => {
    const key = normalizeBaselineKey(entry.value.id);
    const existingOrder = existingOrderById.get(key);
    const normalized = { ...entry.value };
    const existingOrderValue =
      existingOrder && typeof existingOrder === 'object'
        ? normalizeOrderIndex(existingOrder.orderIndex)
        : normalizeOrderIndex(existingOrder);
    if (entry.hasIncomingOrderIndex) {
      normalized.orderIndex = entry.incomingOrderIndex;
    } else if (hasPositiveOrderIndex(existingOrderValue)) {
      normalized.orderIndex = existingOrderValue;
    } else {
      nextOrderIndex += 1;
      normalized.orderIndex = nextOrderIndex;
    }
    if (userId || teamId) {
      const existingDocId = existingOrder && typeof existingOrder === 'object' ? normalizeId(existingOrder.docId) : '';
      const existingCreatedAt =
        existingOrder && typeof existingOrder === 'object' ? normalizeIsoTimestamp(existingOrder.createdAt) : undefined;
      normalized.baselineId = normalized.id;
      normalized.playerId = normalized.id;
      normalized.userId = userId;
      normalized.teamId = teamId;
      normalized.id = existingDocId || randomUUID();
      normalized.createdAt = existingCreatedAt || normalizeIsoTimestamp(normalized.createdAt);
      normalized.updatedAt = new Date().toISOString();
    }
    return normalized;
  });

  const batches = chunk(itemsToUpsert, 5);
  for (const batch of batches) {
    await Promise.all(
      batch.map((item) =>
        container.items.upsert(item, {
          partitionKey: userId || item.userId || item.id,
        })
      )
    );
  }

  return { count: itemsToUpsert.length };
};

const deleteBaseline = async (id, scope = {}) => {
  const normalizedId = normalizeId(id);
  if (!normalizedId) {
    const error = new Error('id is required');
    error.code = 'VALIDATION_ERROR';
    throw error;
  }

  await patchBaseline(normalizedId, { active: false, inRoster: false }, scope);
  return { ok: true, softDeleted: true };
};

const patchBaseline = async (id, patch, scope = {}) => {
  const normalizedId = normalizeId(id);
  if (!normalizedId) {
    const error = new Error('id is required');
    error.code = 'VALIDATION_ERROR';
    throw error;
  }
  const patchObj = isRecord(patch) ? patch : {};
  const hasActive = Object.prototype.hasOwnProperty.call(patchObj, 'active');
  const hasInRoster = Object.prototype.hasOwnProperty.call(patchObj, 'inRoster') || Object.prototype.hasOwnProperty.call(patchObj, 'roster');
  if (!hasActive && !hasInRoster) {
    const error = new Error('patch must include active and/or inRoster');
    error.code = 'VALIDATION_ERROR';
    throw error;
  }
  if (hasActive && typeof patchObj.active !== 'boolean') {
    const error = new Error('active must be boolean');
    error.code = 'VALIDATION_ERROR';
    throw error;
  }
  const nextInRosterValue = Object.prototype.hasOwnProperty.call(patchObj, 'inRoster')
    ? patchObj.inRoster
    : patchObj.roster;
  if (hasInRoster && typeof nextInRosterValue !== 'boolean') {
    const error = new Error('inRoster must be boolean');
    error.code = 'VALIDATION_ERROR';
    throw error;
  }

  const existing = await getBaseline(normalizedId, scope);
  if (!existing) {
    const error = new Error(`Baseline ${normalizedId} not found.`);
    error.code = 404;
    throw error;
  }

  const normalized = validateAndNormalizeBaseline(
    {
      ...existing,
      ...(hasActive ? { active: patchObj.active, isActive: patchObj.active } : {}),
      ...(hasInRoster ? { inRoster: nextInRosterValue, roster: nextInRosterValue } : {}),
      updatedAt: new Date().toISOString(),
    },
    { strict: true }
  );

  if (!normalized.ok) {
    const error = new Error('Invalid baseline patch payload.');
    error.code = 'VALIDATION_ERROR';
    error.details = normalized.errors;
    throw error;
  }

  await upsertBaselines([normalized.value], scope);
  return (await getBaseline(normalizedId, scope)) || normalized.value;
};

const setBaselineActive = async (id, active, scope = {}) => patchBaseline(id, { active }, scope);

const resetBaselines = async (options = {}) => {
  const shouldSeed = options.seed !== false;
  const { userId, teamId } = resolveScope(options);

  if (!isCosmosConfigured()) {
    throw createCosmosUnavailableError('Cannot reset baselines: Cosmos is not configured.');
  }

  const container = userId || teamId ? await getCoachContainer() : await getContainer();
  if (!container) {
    throw createCosmosUnavailableError('Cannot reset baselines: Cosmos container unavailable.');
  }

  const scopeFilter = buildScopeFilter({ userId, teamId });
  const queryText = scopeFilter.query
    ? `SELECT c.id FROM c WHERE c.type = @type AND ${scopeFilter.query}`
    : 'SELECT c.id FROM c WHERE (NOT IS_DEFINED(c.type) OR c.type = @type)';
  const queryParams = [{ name: '@type', value: 'playerBaseline' }, ...scopeFilter.parameters];
  const { resources } = await container.items
    .query({
      query: queryText,
      parameters: queryParams,
      ...(scopeFilter.partitionKey ? { partitionKey: scopeFilter.partitionKey } : {}),
    })
    .fetchAll();
  const ids = (Array.isArray(resources) ? resources : [])
    .map((row) => normalizeId(row.id))
    .filter(Boolean);

  const batches = chunk(ids, 10);
  for (const batch of batches) {
    await Promise.all(batch.map((id) => container.item(id, userId || id).delete()));
  }

  let seeded = 0;
  if (shouldSeed) {
    const result = await upsertBaselines(buildDefaultBaselines(), userId || teamId ? { userId, teamId } : {});
    seeded = result.count;
  }

  return {
    deleted: ids.length,
    seeded,
  };
};

const getCosmosDiagnostics = () => {
  const config = getConfig();
  const account = parseCosmosAccount(config);
  const missing = [];
  if (!config.connectionString && !config.endpoint) {
    missing.push('COSMOS_CONNECTION_STRING or COSMOS_ENDPOINT or AZURE_COSMOS_ENDPOINT');
  }
  if (!config.connectionString && !config.key) {
    missing.push('COSMOS_KEY or AZURE_COSMOS_KEY (or use COSMOS_CONNECTION_STRING)');
  }
  if (!config.databaseId) {
    missing.push(
      'COSMOS_DB or COSMOS_DATABASE or AZURE_COSMOS_DATABASE or COSMOS_DATABASE_NAME or COSMOS_DATABASE_ID'
    );
  }
  if (!config.containerId) {
    missing.push('COSMOS_CONTAINER or AZURE_COSMOS_CONTAINER or COSMOS_CONTAINER_NAME or COSMOS_CONTAINER_ID');
  }
  return {
    configured: isCosmosConfigured(),
    sdkAvailable: loadCosmosClientCtor() !== null,
    account,
    databaseId: config.databaseId,
    containerId: config.containerId,
    coachContainerId: config.coachContainerId || DEFAULT_COACH_CONTAINER,
    usersContainerId: config.usersContainerId || DEFAULT_USERS_CONTAINER,
    missing,
    initialized: Boolean(cachedContainer),
    initError: initError ? String(initError.message || initError) : null,
  };
};

const getBaselineCount = async (scope = {}) => {
  const { userId, teamId } = resolveScope(scope);
  if (!isCosmosConfigured()) {
    throw createCosmosUnavailableError('Cannot count baselines: Cosmos is not configured.');
  }
  const container = userId || teamId ? await getCoachContainer() : await getContainer();
  if (!container) {
    throw createCosmosUnavailableError('Cannot count baselines: Cosmos container unavailable.');
  }
  const scopeFilter = buildScopeFilter({ userId, teamId });
  const queryText = scopeFilter.query
    ? `SELECT VALUE COUNT(1) FROM c WHERE c.type = @type AND ${scopeFilter.query}`
    : 'SELECT VALUE COUNT(1) FROM c WHERE c.type = @type';
  const parameters = [{ name: '@type', value: 'playerBaseline' }, ...scopeFilter.parameters];
  const result = await container.items
    .query({
      query: queryText,
      parameters,
      ...(scopeFilter.partitionKey ? { partitionKey: scopeFilter.partitionKey } : {}),
    })
    .fetchAll();
  const count = Array.isArray(result.resources) ? Number(result.resources[0] || 0) : 0;
  return Number.isFinite(count) ? count : 0;
};

module.exports = {
  VALID_ROLES,
  buildDefaultBaselines,
  validateAndNormalizeBaseline,
  isCosmosConfigured,
  getContainer,
  getCoachContainer,
  getUsersContainer,
  ensureCoachUserProfile,
  backfillBaselinesTeamId,
  getAllBaselines,
  getRosterBaselines,
  getBaseline,
  upsertBaselines,
  patchBaseline,
  setBaselineActive,
  deleteBaseline,
  resetBaselines,
  getCosmosDiagnostics,
  getBaselineCount,
};
