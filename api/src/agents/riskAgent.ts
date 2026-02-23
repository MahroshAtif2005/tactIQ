import { analyzeRisk } from '../shared/riskModel';
import { RiskAgentRequest, RiskAgentResponse } from '../shared/types';

export interface RiskAgentRunResult {
  output: RiskAgentResponse;
  model: string;
  fallbacksUsed: string[];
}

export function buildRiskFallback(input: RiskAgentRequest, reason: string): RiskAgentRunResult {
  const fallback = analyzeRisk(input);
  return {
    output: {
      ...fallback,
      status: 'fallback',
    },
    model: 'rule:fallback',
    fallbacksUsed: [reason],
  };
}

export async function runRiskAgent(input: RiskAgentRequest): Promise<RiskAgentRunResult> {
  const output = analyzeRisk(input);
  return {
    output: {
      ...output,
      status: 'ok',
    },
    model: 'deterministic:risk-v2',
    fallbacksUsed: [],
  };
}
