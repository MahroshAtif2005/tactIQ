import { ActivityHandler, MessageFactory, TurnContext } from 'botbuilder';
import { orchestrateAgents } from '../../api/dist/orchestrator/orchestrator';
import { validateOrchestrateRequest } from '../../api/dist/orchestrator/validation';

type LooseRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is LooseRecord =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const parsePayloadFromText = (text: string): LooseRecord | null => {
  const trimmed = text.trim();
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const resolveMode = (text: string, modeValue: unknown): 'auto' | 'full' => {
  const normalizedMode = String(modeValue || '').trim().toLowerCase();
  const normalizedText = text.trim().toLowerCase();

  if (normalizedMode === 'all' || normalizedMode === 'full') return 'full';
  if (normalizedMode === 'route' || normalizedMode === 'auto') return 'auto';

  if (
    normalizedText.includes('run all') ||
    normalizedText.includes('all agents') ||
    normalizedText === 'all' ||
    normalizedText === 'full'
  ) {
    return 'full';
  }

  return 'auto';
};

const createInvocationContext = () => ({
  error: (...args: unknown[]) => console.error('[TactIQBot]', ...args),
});

const summarizeResult = (result: any): string => {
  const intent = result?.routerDecision?.intent || 'monitor';
  const executedAgents = Array.isArray(result?.meta?.executedAgents)
    ? result.meta.executedAgents.join(', ')
    : 'none';
  const action = result?.combinedDecision?.immediateAction || 'No immediate action';
  const errorCount = Array.isArray(result?.errors) ? result.errors.length : 0;

  return `Router intent: ${intent}. Executed: ${executedAgents}. Action: ${action}. Errors: ${errorCount}.`;
};

const buildOrchestrateInput = (context: TurnContext): LooseRecord => {
  const text = String(context.activity.text || '').trim();
  const value = isRecord(context.activity.value) ? context.activity.value : {};
  const payload = isRecord(value.payload)
    ? value.payload
    : (Object.keys(value).length > 0 ? value : parsePayloadFromText(text) || {});
  const mode = resolveMode(text, value.mode);

  return {
    ...payload,
    mode,
  };
};

export class TactIQBot extends ActivityHandler {
  constructor() {
    super();

    this.onMessage(async (context, next) => {
      const input = buildOrchestrateInput(context);
      const validation = validateOrchestrateRequest(input);

      if (!validation.ok) {
        await context.sendActivity(
          `Unable to run orchestrator from this message. ${validation.message}`
        );
        await next();
        return;
      }

      const result = await orchestrateAgents(validation.value, createInvocationContext() as any);
      const summary = summarizeResult(result);
      const jsonBlock = `\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``;
      const response = MessageFactory.text(`${summary}\n\n${jsonBlock}`);
      await context.sendActivity(response);
      await next();
    });
  }
}

