import { getModelRegistry } from './modelRegistry';

export type RouteTask = 'fatigue' | 'risk' | 'tactical';
export type RouteComplexity = 'low' | 'medium' | 'high';

export interface RouteModelInput {
  task: RouteTask;
  needsJson: boolean;
  complexity: RouteComplexity;
}

export interface RouteModelResult {
  deployment: string;
  fallbackDeployment: string;
  temperature: number;
  maxTokens: number;
}

export function routeModel(input: RouteModelInput): RouteModelResult {
  const registry = getModelRegistry();
  const useStrong = input.task === 'tactical' || input.complexity === 'high';

  const deployment = useStrong ? registry.strongDeployment : registry.fastDeployment;
  const fallbackDeployment = registry.fallbackDeployment || deployment;
  const temperature = 0.2;
  const maxTokens = 200;

  return {
    deployment,
    fallbackDeployment,
    temperature,
    maxTokens,
  };
}
