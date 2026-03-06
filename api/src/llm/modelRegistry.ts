import { loadAoaiEnv } from '../shared/env';

export interface ModelRegistry {
  endpoint: string;
  apiKey: string;
  apiVersion: string;
  fastDeployment: string;
  strongDeployment: string;
  fallbackDeployment: string;
  enabled: boolean;
}

export interface AoaiConfig {
  endpoint: string;
  apiKey: string;
  apiVersion: string;
  strongDeployment: string;
  fallbackDeployment: string;
}

export type AoaiConfigResult =
  | { ok: true; config: AoaiConfig; missing: [] }
  | { ok: false; missing: string[] };

const firstNonEmpty = (...values: Array<unknown>): string => {
  for (const value of values) {
    const normalized = String(value || '').trim();
    if (normalized.length > 0) return normalized;
  }
  return '';
};

interface ResolvedAoaiEnv {
  endpoint: string;
  apiKey: string;
  apiVersion: string;
  deployment: string;
  fastDeployment: string;
  strongDeployment: string;
  fallbackDeployment: string;
}

const resolveAoaiEnv = (): ResolvedAoaiEnv => {
  const base = loadAoaiEnv();
  const endpoint = base.endpoint;
  const apiKey = base.apiKey;
  const apiVersion = base.apiVersion || '2024-02-15-preview';
  const deployment = base.deployment;
  const fastDeployment =
    firstNonEmpty(process.env.AOAI_DEPLOYMENT_FAST, process.env.AZURE_OPENAI_DEPLOYMENT_FAST, deployment);
  const strongDeployment =
    firstNonEmpty(
      process.env.AOAI_DEPLOYMENT_STRONG,
      process.env.AZURE_OPENAI_DEPLOYMENT_STRONG,
      fastDeployment,
      deployment
    );
  const fallbackDeployment =
    firstNonEmpty(
      process.env.AOAI_DEPLOYMENT_FALLBACK,
      process.env.AZURE_OPENAI_DEPLOYMENT_FALLBACK,
      strongDeployment,
      fastDeployment,
      deployment
    );

  // Keep canonical names hydrated so downstream modules can read one consistent key.
  if (endpoint) process.env.AZURE_OPENAI_ENDPOINT = endpoint;
  if (apiKey) process.env.AZURE_OPENAI_API_KEY = apiKey;
  if (apiVersion) process.env.AZURE_OPENAI_API_VERSION = apiVersion;
  if (deployment) process.env.AZURE_OPENAI_DEPLOYMENT = deployment;
  if (fastDeployment) process.env.AOAI_DEPLOYMENT_FAST = fastDeployment;
  if (strongDeployment) process.env.AOAI_DEPLOYMENT_STRONG = strongDeployment;
  if (fallbackDeployment) process.env.AOAI_DEPLOYMENT_FALLBACK = fallbackDeployment;

  return {
    endpoint,
    apiKey,
    apiVersion,
    deployment,
    fastDeployment,
    strongDeployment,
    fallbackDeployment,
  };
};

export function getAoaiConfig(): AoaiConfigResult {
  const resolved = resolveAoaiEnv();
  const missing: string[] = [];
  if (!resolved.endpoint) missing.push('AZURE_OPENAI_ENDPOINT');
  if (!resolved.apiKey) missing.push('AZURE_OPENAI_API_KEY');
  if (!resolved.deployment) missing.push('AZURE_OPENAI_DEPLOYMENT');

  if (missing.length > 0) {
    return { ok: false, missing };
  }

  return {
    ok: true,
    config: {
      endpoint: resolved.endpoint,
      apiKey: resolved.apiKey,
      apiVersion: resolved.apiVersion,
      strongDeployment: resolved.strongDeployment || resolved.deployment,
      fallbackDeployment:
        resolved.fallbackDeployment || resolved.strongDeployment || resolved.fastDeployment || resolved.deployment,
    },
    missing: [],
  };
}

export function getModelRegistry(): ModelRegistry {
  const resolved = resolveAoaiEnv();
  const aoai = getAoaiConfig();

  return {
    endpoint: resolved.endpoint,
    apiKey: resolved.apiKey,
    apiVersion: resolved.apiVersion,
    fastDeployment: resolved.fastDeployment || resolved.deployment,
    strongDeployment: resolved.strongDeployment || resolved.fastDeployment || resolved.deployment,
    fallbackDeployment:
      resolved.fallbackDeployment || resolved.strongDeployment || resolved.fastDeployment || resolved.deployment,
    enabled: aoai.ok && Boolean(resolved.deployment || resolved.fastDeployment || resolved.strongDeployment),
  };
}
