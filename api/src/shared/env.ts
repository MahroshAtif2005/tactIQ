export interface AoaiEnvConfig {
  endpoint: string;
  apiKey: string;
  deployment: string;
  apiVersion: string;
  endpointHost: string;
  missing: string[];
  aiEnabled: boolean;
  aiEnabledOverride?: boolean;
}

const DEFAULT_API_VERSION = '2024-02-15-preview';
const AOAI_ALIAS_MAP = {
  endpoint: [
    'AZURE_OPENAI_ENDPOINT',
    'AZURE_OPENAI_BASE_URL',
    'OPENAI_ENDPOINT',
    'AOAI_ENDPOINT',
    'AZURE_OPENAI_BASE',
  ],
  apiKey: [
    'AZURE_OPENAI_API_KEY',
    'AZURE_OPENAI_KEY',
    'OPENAI_API_KEY',
    'AOAI_KEY',
    'AOAI_API_KEY',
  ],
  deployment: [
    'AZURE_OPENAI_DEPLOYMENT',
    'AZURE_OPENAI_DEPLOYMENT_NAME',
    'OPENAI_DEPLOYMENT',
    'AZURE_OPENAI_MODEL',
    'OPENAI_MODEL',
    'AOAI_DEPLOYMENT_STRONG',
    'AOAI_DEPLOYMENT_FAST',
    'AOAI_DEPLOYMENT',
  ],
  apiVersion: [
    'AZURE_OPENAI_API_VERSION',
    'OPENAI_API_VERSION',
    'AOAI_API_VERSION',
  ],
  aiEnabled: ['AI_ENABLED'],
} as const;

const stripQuotes = (value: string): string => {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
};

const firstNonEmpty = (...values: Array<unknown>): string => {
  for (const value of values) {
    const normalized = stripQuotes(String(value || '')).trim();
    if (normalized.length > 0) return normalized;
  }
  return '';
};

const normalizeEndpoint = (endpoint: string): string => stripQuotes(endpoint).replace(/\/+$/, '');

const readAlias = (aliases: string[]): string => firstNonEmpty(...aliases.map((key) => process.env[key]));
const parseBooleanToken = (value: string): boolean | undefined => {
  const token = stripQuotes(value).trim().toLowerCase();
  if (!token) return undefined;
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(token)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(token)) return false;
  return undefined;
};

export const loadAoaiEnv = (): AoaiEnvConfig => {
  const endpoint = normalizeEndpoint(readAlias([...AOAI_ALIAS_MAP.endpoint]));
  const apiKey = readAlias([...AOAI_ALIAS_MAP.apiKey]);
  const deployment = readAlias([...AOAI_ALIAS_MAP.deployment]);
  const apiVersion = readAlias([...AOAI_ALIAS_MAP.apiVersion]) || DEFAULT_API_VERSION;
  const aiEnabledOverride = parseBooleanToken(readAlias([...AOAI_ALIAS_MAP.aiEnabled]));

  if (endpoint) process.env.AZURE_OPENAI_ENDPOINT = endpoint;
  if (apiKey) process.env.AZURE_OPENAI_API_KEY = apiKey;
  if (deployment) process.env.AZURE_OPENAI_DEPLOYMENT = deployment;
  if (apiVersion) process.env.AZURE_OPENAI_API_VERSION = apiVersion;
  if (typeof aiEnabledOverride === 'boolean') {
    process.env.AI_ENABLED = aiEnabledOverride ? 'true' : 'false';
  }

  const configMissing: string[] = [];
  if (!endpoint) configMissing.push('AZURE_OPENAI_ENDPOINT');
  if (!apiKey) configMissing.push('AZURE_OPENAI_API_KEY');
  if (!deployment) configMissing.push('AZURE_OPENAI_DEPLOYMENT');
  const missing = aiEnabledOverride === false ? [...configMissing, 'AI_ENABLED=false'] : configMissing;

  let endpointHost = '';
  try {
    endpointHost = endpoint ? new URL(endpoint).host : '';
  } catch {
    endpointHost = '';
  }

  return {
    endpoint,
    apiKey,
    deployment,
    apiVersion,
    endpointHost,
    missing,
    aiEnabled: missing.length === 0,
    aiEnabledOverride,
  };
};

export const isAoaiConfigured = (): boolean => loadAoaiEnv().aiEnabled;
