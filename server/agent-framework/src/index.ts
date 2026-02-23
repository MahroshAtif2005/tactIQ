import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import express from 'express';
import { BotFrameworkAdapter, TurnContext } from 'botbuilder';
import { CoachOrchestratorBot } from './bot/coachOrchestratorBot';
import { getContainer, getCosmosDiagnostics, isCosmosConfigured } from './db/cosmosClient';
import {
  normalizeBaselineDoc,
  type PlayerBaselineDoc,
  toPublicBaseline,
} from './db/cosmos';
import { ExistingAgentsClient } from './lib/existingAgents';

const loadEnvFiles = (): string[] => {
  const candidates = [
    path.resolve(__dirname, '../.env'),
    path.resolve(process.cwd(), 'server/agent-framework/.env'),
    path.resolve(process.cwd(), '.env'),
  ];
  const loaded: string[] = [];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    dotenv.config({ path: candidate, override: false });
    loaded.push(candidate);
  }
  return loaded;
};

const loadedEnvFiles = loadEnvFiles();

const appId = process.env.MicrosoftAppId || process.env.MICROSOFT_APP_ID || '';
const appPassword = process.env.MicrosoftAppPassword || process.env.MICROSOFT_APP_PASSWORD || '';
const port = Number(process.env.PORT || 8080);
const existingApiBaseUrl = process.env.EXISTING_API_BASE_URL || 'http://localhost:7071';
const cosmosDiagnostics = getCosmosDiagnostics();

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
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

const apiRouter = express.Router();
const COSMOS_FALLBACK_WARNING = 'Cosmos not configured. Using in-memory fallback baselines.';

const FALLBACK_SEED_ROWS: unknown[] = [
  { id: 'J. Archer', name: 'J. Archer', role: 'FAST', active: true, sleep: 7.2, recovery: 48, fatigueLimit: 6, control: 82, speed: 9, power: 4 },
  { id: 'R. Khan', name: 'R. Khan', role: 'SPIN', active: true, sleep: 7.6, recovery: 42, fatigueLimit: 5, control: 90, speed: 6, power: 5 },
  { id: 'B. Stokes', name: 'B. Stokes', role: 'AR', active: true, sleep: 7.1, recovery: 55, fatigueLimit: 6, control: 76, speed: 8, power: 8 },
  { id: 'M. Starc', name: 'M. Starc', role: 'FAST', active: true, sleep: 6.9, recovery: 50, fatigueLimit: 6, control: 80, speed: 9, power: 4 },
];

const sortBaselines = (rows: PlayerBaselineDoc[]): PlayerBaselineDoc[] =>
  [...rows].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

const dedupeBaselinesById = (rows: PlayerBaselineDoc[]): PlayerBaselineDoc[] => {
  const map = new Map<string, PlayerBaselineDoc>();
  rows.forEach((row) => {
    map.set(String(row.id).trim().toLowerCase(), row);
  });
  return sortBaselines([...map.values()]);
};

const normalizeRows = (rows: unknown[]): { normalized: PlayerBaselineDoc[]; errors: string[] } => {
  const normalized: PlayerBaselineDoc[] = [];
  const errors: string[] = [];

  rows.forEach((row, index) => {
    try {
      normalized.push(normalizeBaselineDoc(row));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`baselines[${index}]: ${message}`);
    }
  });

  return {
    normalized: dedupeBaselinesById(normalized),
    errors,
  };
};

const FALLBACK_FILE_PATH = path.resolve(process.cwd(), 'server/agent-framework/data/baselines.json');

const persistFallbackBaselines = (rows: PlayerBaselineDoc[]): void => {
  try {
    fs.mkdirSync(path.dirname(FALLBACK_FILE_PATH), { recursive: true });
    fs.writeFileSync(FALLBACK_FILE_PATH, JSON.stringify(sortBaselines(rows), null, 2), 'utf8');
  } catch (error) {
    console.warn('[agent-framework] failed to persist fallback baselines:', error instanceof Error ? error.message : String(error));
  }
};

const seedFallbackBaselines = (): PlayerBaselineDoc[] => normalizeRows(FALLBACK_SEED_ROWS).normalized;

const loadFallbackBaselines = (): PlayerBaselineDoc[] => {
  if (!fs.existsSync(FALLBACK_FILE_PATH)) {
    const seeded = seedFallbackBaselines();
    persistFallbackBaselines(seeded);
    return seeded;
  }

  try {
    const raw = fs.readFileSync(FALLBACK_FILE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('fallback file is not an array');
    const { normalized } = normalizeRows(parsed);
    if (normalized.length > 0) {
      return normalized;
    }
  } catch (error) {
    console.warn('[agent-framework] failed to read fallback baselines file, reseeding:', error instanceof Error ? error.message : String(error));
  }

  const seeded = seedFallbackBaselines();
  persistFallbackBaselines(seeded);
  return seeded;
};

let fallbackBaselines: PlayerBaselineDoc[] = loadFallbackBaselines();

apiRouter.get('/health', (_req, res) => {
  res.json({
    ok: true,
    status: 'ok',
    service: 'agent-framework',
    loadedEnvFiles,
    existingApiBaseUrl,
    cosmos: {
      configured: cosmosDiagnostics.configured,
      databaseId: cosmosDiagnostics.dbId,
      containerId: cosmosDiagnostics.containerId,
    },
  });
});

const getFallbackWarning = (): string => {
  const diagnostics = getCosmosDiagnostics();
  if (!diagnostics.configured) return COSMOS_FALLBACK_WARNING;
  if (!diagnostics.sdkAvailable) return 'Cosmos SDK unavailable. Using in-memory fallback baselines.';
  return 'Cosmos is unavailable. Using in-memory fallback baselines.';
};

const getCosmosContainerOrNull = async (): Promise<any | null> => {
  if (!isCosmosConfigured()) return null;
  const container = await getContainer();
  return container ?? null;
};

const deleteInChunks = async (ids: string[], deleter: (id: string) => Promise<void>): Promise<void> => {
  const chunkSize = 10;
  for (let index = 0; index < ids.length; index += chunkSize) {
    const chunk = ids.slice(index, index + chunkSize);
    await Promise.all(chunk.map((id) => deleter(id)));
  }
};

apiRouter.get('/baselines', async (_req, res) => {
  try {
    const container = await getCosmosContainerOrNull();
    if (!container) {
      fallbackBaselines = loadFallbackBaselines();
      const players = fallbackBaselines
        .map((row) => toPublicBaseline(row))
        .filter((row) => row.active === true);
      res.status(200).json({
        players,
        source: 'fallback',
        warning: getFallbackWarning(),
      });
      return;
    }

    const querySpec = {
      query:
        'SELECT * FROM c WHERE c.type = @type AND (c.active = true OR NOT IS_DEFINED(c.active)) ORDER BY c.name',
      parameters: [{ name: '@type', value: 'playerBaseline' }],
    };
    const { resources } = await container.items.query(querySpec).fetchAll();
    const players = (Array.isArray(resources) ? resources : []).map((row) => toPublicBaseline(row));
    res.status(200).json({ players, source: 'cosmos' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: 'Failed to load baselines', details: message });
  }
});

apiRouter.get('/roster', async (_req, res) => {
  try {
    const container = await getCosmosContainerOrNull();
    if (!container) {
      fallbackBaselines = loadFallbackBaselines();
      const players = fallbackBaselines
        .map((row) => toPublicBaseline(row))
        .filter((row) => row.active === true && row.inRoster === true);
      res.status(200).json({
        players,
        source: 'fallback',
        warning: getFallbackWarning(),
      });
      return;
    }

    const querySpec = {
      query:
        'SELECT * FROM c WHERE c.type = @type AND (c.active = true OR NOT IS_DEFINED(c.active)) AND (c.inRoster = true OR c.roster = true) ORDER BY c.name',
      parameters: [{ name: '@type', value: 'playerBaseline' }],
    };
    const { resources } = await container.items.query(querySpec).fetchAll();
    const players = (Array.isArray(resources) ? resources : []).map((row) => toPublicBaseline(row));
    res.status(200).json({ players, source: 'cosmos' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: 'Failed to load roster', details: message });
  }
});

const saveBaselines = async (req: express.Request, res: express.Response) => {
  try {
    const rows = Array.isArray(req.body?.baselines)
      ? req.body.baselines
      : Array.isArray(req.body?.players)
        ? req.body.players
        : null;

    if (!Array.isArray(rows)) {
      res.status(400).json({ error: 'Body must include baselines or players array' });
      return;
    }

    const { normalized, errors } = normalizeRows(rows);

    if (errors.length > 0) {
      res.status(400).json({ error: 'Invalid baselines payload', details: errors });
      return;
    }

    const container = await getCosmosContainerOrNull();
    if (!container) {
      fallbackBaselines = dedupeBaselinesById(normalized.map((row) => toPublicBaseline(row)));
      persistFallbackBaselines(fallbackBaselines);
      res.status(200).json({
        ok: true,
        count: fallbackBaselines.length,
        players: fallbackBaselines,
        source: 'fallback',
        warning: getFallbackWarning(),
      });
      return;
    }

    await Promise.all(
      normalized.map((doc) =>
        container.items.upsert(doc, {
          partitionKey: doc.id,
        })
      )
    );

    res.status(200).json({
      ok: true,
      count: normalized.length,
      players: normalized.map((row) => toPublicBaseline(row)),
      source: 'cosmos',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: 'Failed to save baselines', details: message });
  }
};

apiRouter.post('/baselines', saveBaselines);
apiRouter.put('/baselines', saveBaselines);

apiRouter.delete('/baselines/:id', async (req, res) => {
  try {
    const idRaw = String(req.params.id || '');
    const id = decodeURIComponent(idRaw).trim();
    if (!id) {
      res.status(400).json({ error: 'Baseline id is required' });
      return;
    }

    const container = await getCosmosContainerOrNull();
    if (!container) {
      const lowered = id.toLowerCase();
      const before = fallbackBaselines.length;
      fallbackBaselines = fallbackBaselines.filter((row) => row.id.toLowerCase() !== lowered);
      if (before === fallbackBaselines.length) {
        res.status(404).json({ error: 'Baseline not found', source: 'fallback' });
        return;
      }
      persistFallbackBaselines(fallbackBaselines);
      res.status(200).json({ ok: true, id, source: 'fallback' });
      return;
    }

    await container.item(id, id).delete();
    res.status(200).json({ ok: true, id, source: 'cosmos' });
  } catch (error: unknown) {
    const maybeCode =
      typeof error === 'object' && error !== null && 'code' in error
        ? Number((error as { code?: number | string }).code)
        : Number.NaN;
    if (maybeCode === 404) {
      res.status(404).json({ error: 'Baseline not found' });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: 'Failed to delete baseline', details: message });
  }
});

apiRouter.patch('/baselines/:id', async (req, res) => {
  try {
    const idRaw = String(req.params.id || '');
    const id = decodeURIComponent(idRaw).trim();
    if (!id) {
      res.status(400).json({ error: 'Baseline id is required' });
      return;
    }

    const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
    const hasActive = Object.prototype.hasOwnProperty.call(body, 'active');
    const hasInRoster =
      Object.prototype.hasOwnProperty.call(body, 'inRoster') ||
      Object.prototype.hasOwnProperty.call(body, 'roster');
    if (!hasActive && !hasInRoster) {
      res.status(400).json({ error: 'Body must include active and/or inRoster' });
      return;
    }
    if (hasActive && typeof body.active !== 'boolean') {
      res.status(400).json({ error: 'active must be boolean' });
      return;
    }
    const inRosterValue = Object.prototype.hasOwnProperty.call(body, 'inRoster') ? body.inRoster : body.roster;
    if (hasInRoster && typeof inRosterValue !== 'boolean') {
      res.status(400).json({ error: 'inRoster must be boolean' });
      return;
    }

    const container = await getCosmosContainerOrNull();
    if (!container) {
      const lowered = id.toLowerCase();
      const target = fallbackBaselines.find((row) => row.id.toLowerCase() === lowered);
      if (!target) {
        res.status(404).json({ error: 'Baseline not found', source: 'fallback' });
        return;
      }
      const patched = normalizeBaselineDoc({
        ...target,
        ...(hasActive ? { active: body.active } : {}),
        ...(hasInRoster ? { inRoster: inRosterValue } : {}),
        updatedAt: typeof body.updatedAt === 'string' ? body.updatedAt : new Date().toISOString(),
      });
      fallbackBaselines = dedupeBaselinesById(
        fallbackBaselines.map((row) => (row.id.toLowerCase() === lowered ? patched : row))
      );
      persistFallbackBaselines(fallbackBaselines);
      if (process.env.NODE_ENV !== 'production') {
        console.log('[agent-framework] PATCH /api/baselines/:id', { id, status: 200, source: 'fallback' });
      }
      res.status(200).json({ ok: true, player: toPublicBaseline(patched), source: 'fallback' });
      return;
    }

    let existing: Record<string, unknown> | null = null;
    try {
      const { resource } = await container.item(id, id).read();
      existing = resource ? (resource as Record<string, unknown>) : null;
    } catch (error: unknown) {
      const maybeCode =
        typeof error === 'object' && error !== null && 'code' in error
          ? Number((error as { code?: number | string }).code)
          : Number.NaN;
      if (maybeCode === 404) {
        res.status(404).json({ error: 'Baseline not found' });
        return;
      }
      throw error;
    }

    if (!existing) {
      res.status(404).json({ error: 'Baseline not found' });
      return;
    }

    const patchedDoc = normalizeBaselineDoc({
      ...existing,
      ...(hasActive ? { active: body.active } : {}),
      ...(hasInRoster ? { inRoster: inRosterValue } : {}),
      updatedAt: typeof body.updatedAt === 'string' ? body.updatedAt : new Date().toISOString(),
    });
    await container.items.upsert(patchedDoc, { partitionKey: patchedDoc.id });
    if (process.env.NODE_ENV !== 'production') {
      console.log('[agent-framework] PATCH /api/baselines/:id', { id, status: 200, source: 'cosmos' });
    }
    res.status(200).json({ ok: true, player: toPublicBaseline(patchedDoc), source: 'cosmos' });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: 'Failed to patch baseline', details: message });
  }
});

apiRouter.post('/baselines/reset', async (_req, res) => {
  try {
    const container = await getCosmosContainerOrNull();
    if (!container) {
      const deleted = fallbackBaselines.length;
      fallbackBaselines = seedFallbackBaselines();
      persistFallbackBaselines(fallbackBaselines);
      res.status(200).json({
        ok: true,
        deleted,
        seeded: fallbackBaselines.length,
        players: fallbackBaselines.map((row) => toPublicBaseline(row)),
        source: 'fallback',
        warning: getFallbackWarning(),
      });
      return;
    }

    const querySpec = {
      query: 'SELECT c.id FROM c WHERE c.type = @type',
      parameters: [{ name: '@type', value: 'playerBaseline' }],
    };
    const { resources } = await container.items.query(querySpec).fetchAll();
    const ids = (Array.isArray(resources) ? resources : [])
      .map((row) => String(row.id || '').trim())
      .filter((id) => id.length > 0);

    await deleteInChunks(ids, async (id) => {
      await container.item(id, id).delete();
    });

    const seeded = seedFallbackBaselines();
    await Promise.all(
      seeded.map((doc) =>
        container.items.upsert(doc, {
          partitionKey: doc.id,
        })
      )
    );

    res.status(200).json({
      ok: true,
      deleted: ids.length,
      seeded: seeded.length,
      players: seeded.map((row) => toPublicBaseline(row)),
      source: 'cosmos',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: 'Failed to reset baselines', details: message });
  }
});

apiRouter.post('/messages', async (req, res) => {
  await adapter.processActivity(req, res, async (turnContext) => {
    await bot.run(turnContext);
  });
});

app.use('/api', apiRouter);
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'API route not found' });
});

app.listen(port, () => {
  console.log(`[agent-framework] listening on http://localhost:${port}`);
  console.log('[agent-framework] mounted routes: GET /api/baselines, GET /api/roster, POST /api/baselines, PUT /api/baselines, PATCH /api/baselines/:id, DELETE /api/baselines/:id, POST /api/baselines/reset');
  console.log(`[agent-framework] forwarding agent calls to ${existingApiBaseUrl}`);
  if (!cosmosDiagnostics.configured || !cosmosDiagnostics.sdkAvailable) {
    console.warn(`[agent-framework] Cosmos baseline routes running in fallback mode (${getFallbackWarning()}).`);
  } else {
    console.log(
      `[agent-framework] Cosmos baselines enabled (db=${cosmosDiagnostics.dbId}, container=${cosmosDiagnostics.containerId}).`
    );
  }
});
