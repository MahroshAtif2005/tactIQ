const fs = require('fs');
const path = require('path');

const DEFAULT_DATABASE = 'tactiq-db';
const DEFAULT_CONTAINER = 'players';
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

  const id = normalizeId(payload.id || payload.playerId || payload.name);
  if (!id && strict) {
    errors.push('id is required');
  }

  const role = normalizeRole(payload.role, strict, errors);

  const normalized = {
    id: id || 'Unknown Player',
    type: 'playerBaseline',
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

const getConfig = () => ({
  connectionString: String(process.env.COSMOS_CONNECTION_STRING || '').trim(),
  endpoint: String(process.env.COSMOS_ENDPOINT || '').trim(),
  key: String(process.env.COSMOS_KEY || '').trim(),
  databaseId:
    String(process.env.COSMOS_DATABASE_ID || process.env.COSMOS_DATABASE || DEFAULT_DATABASE).trim() || DEFAULT_DATABASE,
  containerId:
    String(
      process.env.COSMOS_CONTAINER_ID || process.env.COSMOS_CONTAINER_PLAYERS || process.env.COSMOS_CONTAINER || DEFAULT_CONTAINER
    ).trim() ||
    DEFAULT_CONTAINER,
});

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
  return config.connectionString.length > 0 || (config.endpoint.length > 0 && config.key.length > 0);
};

let cachedContainer = null;
let initPromise = null;
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

const chunk = (items, size) => {
  const batches = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
};

const getAllBaselines = async () => {
  logCosmosEnvOnce();
  if (!isCosmosConfigured()) return cloneFallbackBaselines().filter((item) => item.active !== false);

  const container = await getContainer();
  if (!container) return cloneFallbackBaselines().filter((item) => item.active !== false);

  let resources;
  try {
    const result = await container.items
      .query({
        query:
          'SELECT * FROM c WHERE (NOT IS_DEFINED(c.type) OR c.type = @type) AND (c.active = true OR NOT IS_DEFINED(c.active))',
        parameters: [{ name: '@type', value: 'playerBaseline' }],
      })
      .fetchAll();
    resources = result.resources;
  } catch (error) {
    logCosmosConnectFail(error);
    return cloneFallbackBaselines().filter((item) => item.active !== false);
  }

  const normalized = (Array.isArray(resources) ? resources : []).map(
    (item) => validateAndNormalizeBaseline(item, { strict: false }).value
  );
  return sortBaselines(normalized.filter((item) => item.active !== false));
};

const getRosterBaselines = async () => {
  logCosmosEnvOnce();
  if (!isCosmosConfigured()) {
    return cloneFallbackBaselines().filter((item) => item.active !== false && item.inRoster === true);
  }

  const container = await getContainer();
  if (!container) {
    return cloneFallbackBaselines().filter((item) => item.active !== false && item.inRoster === true);
  }

  let resources;
  try {
    const result = await container.items
      .query({
        query:
          'SELECT * FROM c WHERE (NOT IS_DEFINED(c.type) OR c.type = @type) AND (c.active = true OR NOT IS_DEFINED(c.active)) AND (c.inRoster = true OR c.roster = true)',
        parameters: [{ name: '@type', value: 'playerBaseline' }],
      })
      .fetchAll();
    resources = result.resources;
  } catch (error) {
    logCosmosConnectFail(error);
    return cloneFallbackBaselines().filter((item) => item.active !== false && item.inRoster === true);
  }

  const normalized = (Array.isArray(resources) ? resources : []).map(
    (item) => validateAndNormalizeBaseline(item, { strict: false }).value
  );
  return sortBaselines(normalized.filter((item) => item.active !== false && item.inRoster === true));
};

const fetchExistingOrderIndexMap = async (container) => {
  if (!container) return new Map();
  try {
    const result = await container.items
      .query({
        query: 'SELECT c.id, c.orderIndex FROM c WHERE (NOT IS_DEFINED(c.type) OR c.type = @type)',
        parameters: [{ name: '@type', value: 'playerBaseline' }],
      })
      .fetchAll();
    const map = new Map();
    (Array.isArray(result.resources) ? result.resources : []).forEach((row) => {
      const id = normalizeId(row?.id);
      if (!id) return;
      map.set(id.toLowerCase(), normalizeOrderIndex(row?.orderIndex));
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

const getBaseline = async (id) => {
  const normalizedId = normalizeId(id);
  if (!normalizedId) return null;

  if (!isCosmosConfigured()) {
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

const upsertBaselines = async (players) => {
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
    const key = normalizeId(entry.value.id).toLowerCase();
    if (!key) return;
    dedupedById.set(key, entry);
  });
  const dedupedEntries = [...dedupedById.values()];

  if (!isCosmosConfigured()) {
    const merged = new Map(
      fallbackBaselines.map((item) => [normalizeId(item.id).toLowerCase(), validateAndNormalizeBaseline(item, { strict: false }).value])
    );
    const maxFromExisting = getMaxOrderIndex([...merged.values()].map((item) => item.orderIndex));
    const maxFromIncoming = getMaxOrderIndex(
      dedupedEntries.map((entry) => (entry.hasIncomingOrderIndex ? entry.incomingOrderIndex : 0))
    );
    let nextOrderIndex = Math.max(maxFromExisting, maxFromIncoming);

    dedupedEntries.forEach((entry) => {
      const key = normalizeId(entry.value.id).toLowerCase();
      const existing = merged.get(key);
      const normalized = { ...entry.value };
      if (entry.hasIncomingOrderIndex) {
        normalized.orderIndex = entry.incomingOrderIndex;
      } else if (existing && hasPositiveOrderIndex(existing.orderIndex)) {
        normalized.orderIndex = normalizeOrderIndex(existing.orderIndex);
      } else {
        nextOrderIndex += 1;
        normalized.orderIndex = nextOrderIndex;
      }
      merged.set(key, normalized);
    });

    fallbackBaselines = sortBaselines([...merged.values()]);
    writeFallbackBaselinesToDisk();
    return { count: dedupedEntries.length };
  }

  const container = await getContainer();
  if (!container) {
    const merged = new Map(
      fallbackBaselines.map((item) => [normalizeId(item.id).toLowerCase(), validateAndNormalizeBaseline(item, { strict: false }).value])
    );
    const maxFromExisting = getMaxOrderIndex([...merged.values()].map((item) => item.orderIndex));
    const maxFromIncoming = getMaxOrderIndex(
      dedupedEntries.map((entry) => (entry.hasIncomingOrderIndex ? entry.incomingOrderIndex : 0))
    );
    let nextOrderIndex = Math.max(maxFromExisting, maxFromIncoming);

    dedupedEntries.forEach((entry) => {
      const key = normalizeId(entry.value.id).toLowerCase();
      const existing = merged.get(key);
      const normalized = { ...entry.value };
      if (entry.hasIncomingOrderIndex) {
        normalized.orderIndex = entry.incomingOrderIndex;
      } else if (existing && hasPositiveOrderIndex(existing.orderIndex)) {
        normalized.orderIndex = normalizeOrderIndex(existing.orderIndex);
      } else {
        nextOrderIndex += 1;
        normalized.orderIndex = nextOrderIndex;
      }
      merged.set(key, normalized);
    });

    fallbackBaselines = sortBaselines([...merged.values()]);
    writeFallbackBaselinesToDisk();
    return { count: dedupedEntries.length };
  }

  const existingOrderById = await fetchExistingOrderIndexMap(container);
  const maxFromExisting = getMaxOrderIndex([...existingOrderById.values()]);
  const maxFromIncoming = getMaxOrderIndex(
    dedupedEntries.map((entry) => (entry.hasIncomingOrderIndex ? entry.incomingOrderIndex : 0))
  );
  let nextOrderIndex = Math.max(maxFromExisting, maxFromIncoming);

  const itemsToUpsert = dedupedEntries.map((entry) => {
    const key = normalizeId(entry.value.id).toLowerCase();
    const existingOrder = existingOrderById.get(key);
    const normalized = { ...entry.value };
    if (entry.hasIncomingOrderIndex) {
      normalized.orderIndex = entry.incomingOrderIndex;
    } else if (hasPositiveOrderIndex(existingOrder)) {
      normalized.orderIndex = normalizeOrderIndex(existingOrder);
    } else {
      nextOrderIndex += 1;
      normalized.orderIndex = nextOrderIndex;
    }
    return normalized;
  });

  const batches = chunk(itemsToUpsert, 5);
  for (const batch of batches) {
    await Promise.all(
      batch.map((item) =>
        container.items.upsert(item, {
          partitionKey: item.id,
        })
      )
    );
  }

  return { count: itemsToUpsert.length };
};

const deleteBaseline = async (id) => {
  const normalizedId = normalizeId(id);
  if (!normalizedId) {
    const error = new Error('id is required');
    error.code = 'VALIDATION_ERROR';
    throw error;
  }

  await patchBaseline(normalizedId, { active: false, inRoster: false });
  return { ok: true, softDeleted: true };
};

const patchBaseline = async (id, patch) => {
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

  const existing = await getBaseline(normalizedId);
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

  await upsertBaselines([normalized.value]);
  return (await getBaseline(normalizedId)) || normalized.value;
};

const setBaselineActive = async (id, active) => patchBaseline(id, { active });

const resetBaselines = async (options = {}) => {
  const shouldSeed = options.seed !== false;

  if (!isCosmosConfigured()) {
    const deleted = fallbackBaselines.length;
    fallbackBaselines = shouldSeed ? buildDefaultBaselines() : [];
    writeFallbackBaselinesToDisk();
    return {
      deleted,
      seeded: shouldSeed ? fallbackBaselines.length : 0,
    };
  }

  const container = await getContainer();
  if (!container) {
    const deleted = fallbackBaselines.length;
    fallbackBaselines = shouldSeed ? buildDefaultBaselines() : [];
    writeFallbackBaselinesToDisk();
    return {
      deleted,
      seeded: shouldSeed ? fallbackBaselines.length : 0,
    };
  }

  const { resources } = await container.items
    .query({
      query: 'SELECT c.id FROM c WHERE (NOT IS_DEFINED(c.type) OR c.type = @type)',
      parameters: [{ name: '@type', value: 'playerBaseline' }],
    })
    .fetchAll();
  const ids = (Array.isArray(resources) ? resources : [])
    .map((row) => normalizeId(row.id))
    .filter(Boolean);

  const batches = chunk(ids, 10);
  for (const batch of batches) {
    await Promise.all(batch.map((id) => container.item(id, id).delete()));
  }

  let seeded = 0;
  if (shouldSeed) {
    const result = await upsertBaselines(buildDefaultBaselines());
    seeded = result.count;
  }

  return {
    deleted: ids.length,
    seeded,
  };
};

const getCosmosDiagnostics = () => {
  const config = getConfig();
  return {
    configured: isCosmosConfigured(),
    sdkAvailable: loadCosmosClientCtor() !== null,
    databaseId: config.databaseId,
    containerId: config.containerId,
    initialized: Boolean(cachedContainer),
    initError: initError ? String(initError.message || initError) : null,
  };
};

module.exports = {
  VALID_ROLES,
  buildDefaultBaselines,
  validateAndNormalizeBaseline,
  isCosmosConfigured,
  getContainer,
  getAllBaselines,
  getRosterBaselines,
  getBaseline,
  upsertBaselines,
  patchBaseline,
  setBaselineActive,
  deleteBaseline,
  resetBaselines,
  getCosmosDiagnostics,
};
