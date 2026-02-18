import { analyzeRisk } from '../shared/riskModel';
import { RiskAgentRequest, RiskAgentResponse } from '../shared/types';
import { routeModel } from '../llm/router';

export interface RiskAgentRunResult {
  output: RiskAgentResponse;
  model: string;
  fallbacksUsed: string[];
}

export async function runRiskAgent(input: RiskAgentRequest): Promise<RiskAgentRunResult> {
  const routing = routeModel({ task: 'risk', needsJson: true, complexity: 'low' });
  const output: RiskAgentResponse = analyzeRisk(input);
  return {
    output,
    model: `rule:${routing.deployment || 'n/a'}`,
    fallbacksUsed: [],
  };
}
