import path from 'node:path';
import dotenv from 'dotenv';
import express from 'express';
import { BotFrameworkAdapter, TurnContext } from 'botbuilder';
import { CoachOrchestratorBot } from './bot/coachOrchestratorBot';
import { ExistingAgentsClient } from './lib/existingAgents';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const appId = process.env.MicrosoftAppId || '';
const appPassword = process.env.MicrosoftAppPassword || '';
const port = Number(process.env.PORT || 3978);
const existingApiBaseUrl = process.env.EXISTING_API_BASE_URL || 'http://localhost:7071';

const adapter = new BotFrameworkAdapter({
  appId,
  appPassword,
});

adapter.onTurnError = async (turnContext: TurnContext, error: Error) => {
  const errorResult = {
    error: error.message || 'Agent Framework bot failure',
    timestamp: new Date().toISOString(),
  };
  await turnContext.sendActivity({
    type: 'message',
    text: JSON.stringify(errorResult),
    value: errorResult,
  });
};

const agentsClient = new ExistingAgentsClient(existingApiBaseUrl);
const bot = new CoachOrchestratorBot(agentsClient);

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'agent-framework',
    existingApiBaseUrl,
  });
});

app.post('/api/messages', async (req, res) => {
  await adapter.processActivity(req, res, async (turnContext) => {
    await bot.run(turnContext);
  });
});

app.listen(port, () => {
  console.log(`[agent-framework] listening on http://localhost:${port}`);
  console.log(`[agent-framework] forwarding agent calls to ${existingApiBaseUrl}`);
});
