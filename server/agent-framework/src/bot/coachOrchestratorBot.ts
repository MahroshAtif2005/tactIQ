import { Activity, ActivityHandler, MessageFactory, TurnContext } from 'botbuilder';
import { AgentFrameworkMode, ExistingAgentsClient } from '../lib/existingAgents';

type LooseRecord = Record<string, unknown>;

const asRecord = (value: unknown): LooseRecord => (value && typeof value === 'object' ? (value as LooseRecord) : {});

const parseModeFromActivity = (activity: Activity): AgentFrameworkMode => {
  const text = String(activity.text || '').trim().toLowerCase();
  const activityValue = asRecord(activity.value);
  const modeFromValue = String(activityValue.mode || '').trim().toLowerCase();

  if (modeFromValue === 'all' || text === 'all' || text.includes('run all')) {
    return 'all';
  }

  return 'route';
};

const parsePayloadFromActivity = (activity: Activity): unknown => {
  const activityValue = asRecord(activity.value);
  if (activityValue.payload && typeof activityValue.payload === 'object') {
    return activityValue.payload;
  }

  if (Object.keys(activityValue).length > 0) {
    return activityValue;
  }

  return {};
};

export class CoachOrchestratorBot extends ActivityHandler {
  constructor(private readonly agentsClient: ExistingAgentsClient) {
    super();

    this.onMessage(async (turnContext: TurnContext, next) => {
      const mode = parseModeFromActivity(turnContext.activity);
      const payload = parsePayloadFromActivity(turnContext.activity);
      const result = await this.agentsClient.run(mode, payload);

      const response = MessageFactory.text(JSON.stringify(result));
      response.value = result;
      await turnContext.sendActivity(response);
      await next();
    });
  }
}
