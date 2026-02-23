export type BaselineRole = 'BAT' | 'SPIN' | 'FAST' | 'AR';

export interface PlayerBaselineDoc {
  id: string;
  type: 'playerBaseline';
  name: string;
  role: BaselineRole;
  sleep: number;
  recovery: number;
  fatigueLimit: number;
  control: number;
  speed: number;
  power: number;
  active: boolean;
  updatedAt: string;
}

interface CosmosConfig {
  endpoint: string;
  key: string;
  dbId: string;
  containerId: string;
}

const ROLE_SET = new Set<BaselineRole>(['BAT', 'SPIN', 'FAST', 'AR']);

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

const toNumber = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toBool = (value: unknown, fallback: boolean): boolean => {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return Boolean(value);
};

const normalizeRole = (value: unknown): BaselineRole => {
  const normalized = String(value || '').trim().toUpperCase() as BaselineRole;
  return ROLE_SET.has(normalized) ? normalized : 'BAT';
};

const getConfig = (): CosmosConfig => ({
  endpoint: String(process.env.COSMOS_ENDPOINT || '').trim(),
  key: String(process.env.COSMOS_KEY || '').trim(),
  dbId: String(
    process.env.COSMOS_DB_NAME ||
    process.env.COSMOS_DB ||
    process.env.COSMOS_DATABASE_ID ||
    'tactiq-db'
  ).trim() || 'tactiq-db',
  containerId: String(
    process.env.COSMOS_CONTAINER_NAME ||
    process.env.COSMOS_CONTAINER ||
    process.env.COSMOS_CONTAINER_ID ||
    'players'
  ).trim() || 'players',
});

let cosmosEnvLogged = false;
const logCosmosEnvOnce = (): void => {
  if (cosmosEnvLogged) return;
  cosmosEnvLogged = true;
  const config = getConfig();
  console.log('COSMOS_ENV', {
    endpointPresent: config.endpoint.length > 0,
    keyPresent: config.key.length > 0,
    db: config.dbId,
    container: config.containerId,
  });
};

const logCosmosConnectFail = (error: unknown): void => {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
  const statusCode =
    typeof error === 'object' && error !== null && 'statusCode' in error
      ? (error as { statusCode?: unknown }).statusCode
      : undefined;
  const message = error instanceof Error ? error.message : String(error);
  console.error('COSMOS_CONNECT_FAIL', { code, message, statusCode });
};

export const isCosmosConfigured = (): boolean => {
  logCosmosEnvOnce();
  const config = getConfig();
  return config.endpoint.length > 0 && config.key.length > 0;
};

let cachedClient: any | null = null;
let cachedContainer: unknown | null = null;
let cosmosClientCtor: any | null | undefined;

const loadCosmosClientCtor = (): any | null => {
  if (cosmosClientCtor !== undefined) return cosmosClientCtor;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sdk = require('@azure/cosmos') as { CosmosClient?: any };
    cosmosClientCtor = sdk.CosmosClient || null;
    return cosmosClientCtor;
  } catch {
    cosmosClientCtor = null;
    return null;
  }
};

const getClient = (): any | null => {
  if (!isCosmosConfigured()) return null;
  const CosmosClient = loadCosmosClientCtor();
  if (!CosmosClient) return null;
  if (cachedClient) return cachedClient;
  const { endpoint, key } = getConfig();
  cachedClient = new (CosmosClient as any)({ endpoint, key });
  return cachedClient;
};

export const getContainer = async (): Promise<any | null> => {
  logCosmosEnvOnce();
  if (cachedContainer) return cachedContainer;
  const client = getClient();
  if (!client) return null;
  try {
    const { dbId, containerId } = getConfig();
    const container = client.database(dbId).container(containerId);
    await container.read();
    cachedContainer = container;
    return cachedContainer;
  } catch (error) {
    logCosmosConnectFail(error);
    return null;
  }
};

export const getCosmosDiagnostics = (): { configured: boolean; dbId: string; containerId: string; sdkAvailable: boolean } => {
  const config = getConfig();
  return {
    configured: isCosmosConfigured(),
    dbId: config.dbId,
    containerId: config.containerId,
    sdkAvailable: loadCosmosClientCtor() !== null,
  };
};

export const normalizeBaselineDoc = (raw: unknown): PlayerBaselineDoc => {
  const row = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const name = String(row.name || row.id || '').trim();
  const id = String(row.id || name).trim();
  if (!id) {
    throw new Error('Baseline id/name is required.');
  }

  return {
    id,
    type: 'playerBaseline',
    name: name || id,
    role: normalizeRole(row.role),
    sleep: clamp(toNumber(row.sleep, 7), 0, 12),
    recovery: clamp(toNumber(row.recovery, 45), 0, 240),
    fatigueLimit: clamp(toNumber(row.fatigueLimit, 6), 0, 10),
    control: clamp(toNumber(row.control, 78), 0, 100),
    speed: clamp(toNumber(row.speed, 7), 0, 100),
    power: clamp(toNumber(row.power, 6), 0, 100),
    active: toBool(row.active, true),
    updatedAt: new Date().toISOString(),
  };
};

export const toPublicBaseline = (row: Partial<PlayerBaselineDoc>): PlayerBaselineDoc => ({
  id: String(row.id || '').trim(),
  type: 'playerBaseline',
  name: String(row.name || row.id || '').trim(),
  role: normalizeRole(row.role),
  sleep: clamp(toNumber(row.sleep, 7), 0, 12),
  recovery: clamp(toNumber(row.recovery, 45), 0, 240),
  fatigueLimit: clamp(toNumber(row.fatigueLimit, 6), 0, 10),
  control: clamp(toNumber(row.control, 78), 0, 100),
  speed: clamp(toNumber(row.speed, 7), 0, 100),
  power: clamp(toNumber(row.power, 6), 0, 100),
  active: toBool(row.active, true),
  updatedAt: typeof row.updatedAt === 'string' && row.updatedAt.trim().length > 0 ? row.updatedAt : new Date().toISOString(),
});
