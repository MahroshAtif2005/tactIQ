# tactIQ

## Live Demo



### AI Tactical Coach for Player and Match Decisions

tactIQ is a real time tactical assistant that functions like a digital coach for cricket teams.  
It focuses on player suitability, fatigue tracking, substitution decisions, and match situation awareness to support smarter on field strategy.

For now tactIQ is built for cricket, but the system is designed to extend to multiple sports such as football, basketball, and other real time decision environments.

---

## What tactIQ Does

tactIQ helps captains and analysts answer key tactical questions

- Is the current player fit enough to continue  
- Should a substitution be made right now  
- Which player is most suitable for the current match context  
- How fatigue is impacting performance and injury risk  
- Whether the team is tactically on track or under pressure  

It converts match context and player state into coach like actionable guidance.

---

## Player Intelligence System

### Fatigue Awareness
- Real time fatigue increase and decrease controls  
- Performance impact simulation  
- Injury risk indication  

### Suitability Engine
- Evaluates whether a player should continue  
- Identifies when a player becomes tactically unfit  
- Suggests substitution scenarios based on fatigue and match pressure  

### Role Based Context
- Different logic for batters and bowlers  
- Tactical panels that adapt to the selected player role  

---

## Tactical Decision Support

- On track vs under pressure match states  
- Required vs current performance comparison  
- Projection awareness for decision timing  
- Substitution timing indicators  

The goal is not just to show numbers but to guide decisions.

---

## Tech Stack

- Frontend React + TypeScript + Vite  
- UI Components Radix UI + Tailwind CSS  
- Icons Lucide React  
- Backend Azure Functions
- Azure OpenAI 

---

## Use Cases

- Live tactical coaching support  
- Player workload management  
- Substitution decision systems  
- AI sports assistant platforms  
- Simulation and strategy tools  

---

## Run locally

1. Install dependencies:
   - `npm install`
   - `npm --prefix api install`
2. Start Azure Functions API:
   - Terminal 1: `cd api && func start`
3. Start frontend:
   - Terminal 2: `npm run dev`
4. Verify Functions health:
   - `curl http://localhost:7071/api/health`

If port `7071` is busy, run with a different port:
- `FUNCTION_PORT=7072 npm run dev`
- `VITE_FUNCTIONS_PORT=7072 FUNCTION_PORT=7072 npm run dev`

Frontend runs on `http://localhost:5173` and Azure Functions runs on `http://localhost:7071`.

### Player Baselines (Cosmos DB, Express API)

If you are using the Express backend (`node server.js`) for Player Baseline Models:

1. Configure environment in repo root `.env`:
   - `COSMOS_CONNECTION_STRING` (preferred) or `COSMOS_ENDPOINT` + `COSMOS_KEY`
   - `COSMOS_DATABASE=tactiq-db`
   - `COSMOS_CONTAINER_PLAYERS=players`
2. Start backend API:
   - `npm run server` (or `node server.js`, defaults to `http://localhost:8080`)
3. Start frontend:
   - `npm run dev`
   - Set `VITE_API_BASE_URL=http://localhost:8080` in `.env` (default).
4. Important:
   - Keep Vite on its own dev port (for example `5177`).
   - Do not run SPA preview/static server on `8080` while backend API is running.
5. Manual verification:
   - Load baselines: `curl http://localhost:8080/api/baselines`
   - Save baselines (bulk upsert):
     - `curl -X POST http://localhost:8080/api/baselines -H \"Content-Type: application/json\" -d '{\"players\":[{\"id\":\"J. Archer\",\"role\":\"FAST\",\"sleep\":7.5,\"recovery\":45,\"fatigueLimit\":6,\"control\":80,\"speed\":9,\"power\":0,\"active\":true}]}'`
   - Delete one baseline:
     - `curl -X DELETE \"http://localhost:8080/api/baselines/J.%20Archer\"`
   - Reset baselines to seed defaults:
     - `curl -X POST http://localhost:8080/api/baselines/reset`

### Baselines API quick checks

Use these commands to confirm local DELETE/RESET routes are live:

- `curl -X POST http://localhost:8080/api/baselines/reset`
- `curl -X DELETE "http://localhost:8080/api/baselines/Ben%20Ten"`
- `curl http://localhost:8080/api/baselines`

### Optional Agent Framework orchestration layer

This repo now supports an opt-in Microsoft Bot Framework orchestration service that forwards to the existing tactIQ agent endpoints.

1. Install Agent Framework service dependencies:
   - `npm --prefix server/agent-framework install`
2. Configure Agent Framework env:
   - `cp server/agent-framework/.env.example server/agent-framework/.env`
   - Keep `EXISTING_API_BASE_URL=http://localhost:7071` (or your Functions URL)
3. Start services:
   - Terminal 1: `cd api && func start`
   - Terminal 2: `npm --prefix server/agent-framework run dev`
   - Terminal 3: `VITE_USE_AGENT_FRAMEWORK=true npm run dev`

Notes:
- Default behavior is unchanged (`VITE_USE_AGENT_FRAMEWORK=false`): frontend keeps calling `/api/orchestrate`.
- When `VITE_USE_AGENT_FRAMEWORK=true`, frontend sends orchestration through `/api/messages` (proxied to `http://localhost:3978` by Vite in dev).
- If Agent Framework is hosted elsewhere, set `VITE_AGENT_FRAMEWORK_BASE_URL`.

## Production Preview (Important)

- `npm run dev` runs Vite dev mode, which is not identical to production behavior.
- To reproduce live/Azure UI issues (for example CSS differences after production build), use:
  - `npm run build`
  - `npm run preview`
- To force a specific preview port:
  - `npm run preview -- --port 4173`

## API endpoints

- `POST http://localhost:7071/api/agents/fatigue`
- `POST http://localhost:7071/api/agents/risk`
- `POST http://localhost:7071/api/agents/tactical`
- `POST http://localhost:7071/api/router`
- `POST http://localhost:7071/api/orchestrate`
- `GET  http://localhost:7071/api/health`
- Frontend calls relative paths like `/api/orchestrate` via Vite proxy.

### Full Match Context

- `POST /orchestrate` and `POST /api/orchestrate` now expect `context: FullMatchContext` in the request body.
- Router + fatigue/risk/tactical agents consume this context (match setup + roster baselines + live telemetry).
- Orchestrate responses include `contextSummary` for safe debugging.
- Set `DEBUG_CONTEXT=true` to include full `debugContext` in orchestrate responses.

### How to verify FullMatchContext wiring

1. Open browser DevTools -> Network and trigger **Run Coach Agent** or **Run Full Combined Analysis**.
2. Inspect the `/orchestrate` request payload and confirm:
   - `context.match` exists
   - `context.roster` exists and has current roster players
3. Inspect the `/orchestrate` response and confirm:
   - `contextSummary.rosterCount` matches roster shown in UI
   - `contextSummary.hasBaselinesCount` and `contextSummary.hasTelemetryCount` are populated
   - `routerDecision` and `agentsRun` are present

## Bot Framework runtime layer

- Endpoint: `POST /api/messages`
- This endpoint adds Microsoft Bot Framework runtime support on top of the existing orchestration.
- Current UI flow is unchanged: the dashboard can continue calling existing orchestrator endpoints exactly as before.

If you change Vite proxy settings, restart the Vite dev server.

## Production API Base URL

- If backend APIs are hosted separately from the frontend (for example Azure Functions on another host), set `VITE_API_BASE_URL` in Azure App Service -> Configuration.
- Frontend orchestrate/health calls resolve to `${VITE_API_BASE_URL}/orchestrate` and `${VITE_API_BASE_URL}/health` (with legacy `/api/orchestrate` fallback if needed).
- If `/health` fails, the Coach panel shows an explicit backend reachability error.

## LLM Setup

Fatigue Agent supports two modes:
- Rule based fallback 
- Azure OpenAI LLM analysis 

Set these in `api/local.settings.json` (or environment):
- `AZURE_OPENAI_ENDPOINT`
- `AZURE_OPENAI_API_KEY`
- `AZURE_OPENAI_DEPLOYMENT`
- `AZURE_OPENAI_API_VERSION` (defaults to `2024-02-15-preview` if not set)
- `AOAI_DEPLOYMENT_STRONG`
- `AOAI_DEPLOYMENT_FALLBACK`

When AOAI config is missing, Tactical Agent now returns deterministic fallback recommendations instead of failing offline.

Quick setup:
1. Copy `api/local.settings.example.json` to `api/local.settings.json`
2. Add your Azure OpenAI values
3. Run `cd api && func start`

## Deployment
Deployed on Azure App Service via GitHub Actions (CI/CD).
Every push to `main` triggers build + deploy.


                                     ARCHITECTURE (tactIQ)
                   (Microsoft Foundry + Agent Framework + Azure Services + GitHub/Copilot)
```txt
┌──────────────────────────────────────────────────────────────────────────────┐
│ USERS (Coach / Analyst / Judges)                                             │
│ Web UI: Vite + React                                                        │
│  - Dashboard: Match context + Players + Signals                              │
│  - Controls: "Run Selected Agent" | "Run All Agents"                         │
│  - Output: Agent cards + Final Recommendation + Trace/Router info            │
└──────────────────────────────────────────────────────────────────────────────┘
                                   │ HTTPS
                                   ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ AZURE CLOUD                                                                  │
│                                                                              │
│  ┌───────────────────────────────┐        REST        ┌────────────────────┐ │
│  │ Azure App Service (Web/API)   │ ───────────────▶   │ Node.js/Express API│ │
│  │  - Hosts UI + API endpoints   │                    │  - Validates inputs │ │
│  │  - Public demo endpoint       │                    │  - Builds session   │ │
│  └───────────────────────────────┘                    │    context          │ │
│                                                       │  - Endpoints:       │ │
│                                                       │    /api/orchestrate │ │
│                                                       │    /api/agent/:name │ │
│                                                       └─────────┬──────────┘ │
│                                                                 │ invokes
│                                                                 ▼
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │ MICROSOFT AGENT FRAMEWORK (Agent Runtime + Tools)                        │ │
│  │  - Supervisor/Orchestrator Agent                                         │ │
│  │     • conversation state + routing policy                                │ │
│  │     • can run: single specialist OR full multi-agent pass                │ │
│  │  - Specialist Agents (callable tools)                                    │ │
│  │     1) Fatigue Agent  → workload + recovery drift                         │ │
│  │     2) Risk Agent     → injury/no-ball risk + alerts                      │ │
│  │     3) Tactical Agent → substitution + next-action recommendations        │ │
│  │  - Final Recommendation Synthesizer                                      │ │
│  │     • merges outputs into one decision + confidence + rationale           │ │
│  └───────────────────────────────┬─────────────────────────────────────────┘ │
│                                  │ model calls                              │
│                                  ▼                                          │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │ MICROSOFT AI FOUNDRY (Azure AI Foundry / Azure OpenAI)                    │ │
│  │  - Model deployments + secure endpoints                                   │ │
│  │  - Policy/Router Layer (optional)                                         │ │
│  │     • intent detection                                                    │ │
│  │     • cost/latency-aware model choice                                     │ │
│  │     • safe fallback routing                                               │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │ AZURE COSMOS DB (Primary Data Store)                                      │ │
│  │  Stores:                                                                  │ │
│  │   - Baseline Player Model (active/inactive flags)                         │ │
│  │   - Rosters per team/match                                                │ │
│  │   - Match state snapshots (overs, wickets, partnerships, etc.)            │ │
│  │   - Agent runs + outputs (trace logs + structured results)                │ │
│  │   - Recommendations history + feedback (coach accept/reject)              │ │
│  │                                                                           │ │
│  │  Read/Write patterns:                                                     │ │
│  │   - UI → API: roster edits, run agent requests                            │ │
│  │   - API ↔ Cosmos: persist roster + match state + agent results            │ │
│  │   - Orchestrator/Agents: fetch context, write outputs + traces            │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  Response: JSON (agent cards + final decision + trace + saved run id)         │
└──────────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ UI "ANALYSIS OUTPUT" PANEL                                                   │
│  - Shows router intent + signals                                              │
│  - Shows agent status: skipped / ok / fallback                                │
│  - Shows final recommendation + confidence                                    │
│  - Links: "View saved run" (Cosmos run id)                                    │
└──────────────────────────────────────────────────────────────────────────────┘

DEV + DELIVERY TOOLING (MICROSOFT + GITHUB)
┌──────────────────────────────────────────────────────────────────────────────┐
│ GitHub Repo                                                                   │
│  - Source code, issues, README, architecture diagram                          │
│ GitHub Actions (CI/CD)                                                        │
│  - Build + deploy to Azure App Service                                        │
│ GitHub Copilot                                                                │
│  - Assisted coding: UI, API endpoints, Agent Framework glue, tests, refactors │
└──────────────────────────────────────────────────────────────────────────────┘
