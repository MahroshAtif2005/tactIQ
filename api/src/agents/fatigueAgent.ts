import { analyzeFatigue } from '../shared/analysisProvider';
import { FatigueAgentRequest, FatigueAgentResponse } from '../shared/types';
import { routeModel } from '../llm/router';

export interface FatigueAgentRunResult {
  output: FatigueAgentResponse;
  model: string;
  fallbacksUsed: string[];
}

export async function runFatigueAgent(input: FatigueAgentRequest): Promise<FatigueAgentRunResult> {
  const routing = routeModel({ task: 'fatigue', needsJson: true, complexity: 'low' });
  const { output, mode } = await analyzeFatigue(input);
  return {
    output,
    model: mode === 'llm' ? routing.deployment : `rule:${routing.deployment || 'n/a'}`,
    fallbacksUsed: mode === 'llm' ? [] : ['fatigue:rule-fallback'],
  };
}
