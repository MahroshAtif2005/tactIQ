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

export function getAoaiConfig(): AoaiConfigResult {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT || '';
  const apiKey = process.env.AZURE_OPENAI_API_KEY || '';
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2024-10-21';
  const legacyDeployment = process.env.AZURE_OPENAI_DEPLOYMENT || process.env.AZURE_OPENAI_MODEL || '';
  const strongDeployment = process.env.AOAI_DEPLOYMENT_STRONG || legacyDeployment;
  const fallbackDeployment = process.env.AOAI_DEPLOYMENT_FALLBACK || strongDeployment || legacyDeployment;
  const missing: string[] = [];
  if (!endpoint) missing.push('AZURE_OPENAI_ENDPOINT');
  if (!apiKey) missing.push('AZURE_OPENAI_API_KEY');
  if (!strongDeployment) missing.push('AOAI_DEPLOYMENT_STRONG');
  if (!fallbackDeployment) missing.push('AOAI_DEPLOYMENT_FALLBACK');

  if (missing.length > 0) {
    return { ok: false, missing };
  }

  return {
    ok: true,
    config: {
      endpoint,
      apiKey,
      apiVersion,
      strongDeployment,
      fallbackDeployment,
    },
    missing: [],
  };
}

export function getModelRegistry(): ModelRegistry {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT || '';
  const apiKey = process.env.AZURE_OPENAI_API_KEY || '';
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2024-10-21';
  const legacyDeployment = process.env.AZURE_OPENAI_DEPLOYMENT || process.env.AZURE_OPENAI_MODEL || '';
  const fastDeployment = process.env.AOAI_DEPLOYMENT_FAST || legacyDeployment;
  const strongDeployment = process.env.AOAI_DEPLOYMENT_STRONG || fastDeployment || legacyDeployment;
  const fallbackDeployment = process.env.AOAI_DEPLOYMENT_FALLBACK || strongDeployment || fastDeployment || legacyDeployment;
  const aoai = getAoaiConfig();

  return {
    endpoint,
    apiKey,
    apiVersion,
    fastDeployment,
    strongDeployment,
    fallbackDeployment,
    enabled: aoai.ok && Boolean(fastDeployment || strongDeployment || fallbackDeployment),
  };
}
