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
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2024-02-15-preview';
  const defaultDeployment = process.env.AZURE_OPENAI_DEPLOYMENT || process.env.AZURE_OPENAI_MODEL || '';
  const strongDeployment = process.env.AOAI_DEPLOYMENT_STRONG || defaultDeployment;
  const fallbackDeployment = process.env.AOAI_DEPLOYMENT_FALLBACK || strongDeployment || defaultDeployment;
  const missing: string[] = [];
  if (!endpoint) missing.push('AZURE_OPENAI_ENDPOINT');
  if (!apiKey) missing.push('AZURE_OPENAI_API_KEY');
  if (!defaultDeployment) missing.push('AZURE_OPENAI_DEPLOYMENT');

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
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2024-02-15-preview';
  const defaultDeployment = process.env.AZURE_OPENAI_DEPLOYMENT || process.env.AZURE_OPENAI_MODEL || '';
  const fastDeployment = process.env.AOAI_DEPLOYMENT_FAST || defaultDeployment;
  const strongDeployment = process.env.AOAI_DEPLOYMENT_STRONG || fastDeployment || defaultDeployment;
  const fallbackDeployment = process.env.AOAI_DEPLOYMENT_FALLBACK || strongDeployment || fastDeployment || defaultDeployment;
  const aoai = getAoaiConfig();

  return {
    endpoint,
    apiKey,
    apiVersion,
    fastDeployment,
    strongDeployment,
    fallbackDeployment,
    enabled: aoai.ok && Boolean(defaultDeployment || fastDeployment || strongDeployment || fallbackDeployment),
  };
}
