# tactIQ

## Live Demo
https://tactiq-mahrosh-ai-fzdpe3hrc2a6bmgx.uaenorth-01.azurewebsites.net/


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
- `POST http://localhost:7071/api/orchestrate`
- `GET  http://localhost:7071/api/health`
- Frontend calls relative paths like `/api/orchestrate` via Vite proxy.

If you change Vite proxy settings, restart the Vite dev server.

## Production API Base URL

- If backend APIs are hosted separately from the frontend (for example Azure Functions on another host), set `VITE_API_BASE_URL` in Azure App Service -> Configuration.
- The frontend builds API URLs as `${VITE_API_BASE_URL}/api/...` when configured, and defaults to same-origin `/api/...` when empty (so local Vite proxy still works).
- If `/api/health` fails and `VITE_API_BASE_URL` is empty, the Coach panel now shows an explicit error suggesting this configuration.

## LLM Setup

Fatigue Agent supports two modes:
- Rule based fallback 
- Azure OpenAI LLM analysis 

Set these in `api/local.settings.json` (or environment):
- `AZURE_OPENAI_ENDPOINT`
- `AZURE_OPENAI_API_KEY`
- `AZURE_OPENAI_API_VERSION` (defaults to `2024-10-21` if not set)
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

## Application Architecture 
```txt

Users (Coach / Analyst)
        |
        v
+---------------------------+
| Web UI (Vite + React)     |
| - Run Coach Agent         |
| - Player / Match Inputs   |
+-------------+-------------+
              |
              v
+---------------------------+
| Node.js + Express API     |
| - validates request       |
| - creates session context |
+-------------+-------------+
              |
              v
+------------------------------------------------------+
| Agent Framework Orchestrator (Supervisor)            |
| - maintains session state                            |
| - decides which specialist agent(s) to run           |
| - merges outputs into one final recommendation       |
+----------------------+-------------------------------+
                       |
                       v
            +----------------------------------+
            | Model Router / Policy Layer      |
            | - cost-aware routing             |
            | - selects model tier             |
            +---------+-----------+------------+
                      |           |
                      v           v
        +------------------+   +------------------+
        | Fatigue Agent    |   | Risk Agent       |
        | - workload trend |   | - injury flags   |
        | - safe spell     |   | - risk scoring   |
        +--------+---------+   +--------+---------+
                 \              /
                  \            /
                   v          v
              +----------------------+
              | Tactical Agent       |
              | - match context      |
              | - field/bowler plan  |
              | - substitution logic |
              +----------+-----------+
                         |
                         v
              +----------------------+
              | Final Output         |
              | - recommendation     |
              | - Next Best Action  |
              +----------+-----------+
                         |
                         v
                  UI renders result
```


                 ##                    MICROSOFT-BASED ARCHITECTURE (tactIQ)
                   (Microsoft Foundry + Agent Framework + Azure Services + GitHub/Copilot)
```txt
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ Users (Coach / Analyst / Judges)                                                                        │
│ Web UI: Vite + React (Dashboard + “Run Agent” + “Run All Agents” controls)                              │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
                                          │ HTTPS
                                          v
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ Azure Cloud                                                                                              │
│                                                                                                          │
│  ┌───────────────────────────────┐         ┌────────────────────────────────────────────────────────┐   │
│  │ Azure App Service (Web/API)   │  REST   │ Node.js / Express API Layer                              │   │
│  │ - Hosts UI + API endpoints    ├────────►│ - Validates inputs, builds session context              │   │
│  │ - Public demo endpoint        │         │ - Exposes /api/orchestrate + /api/agent/* endpoints     │   │
│  └───────────────────────────────┘         └────────────────────────────────────────────────────────┘   │
│                                          │
│                                          │ invokes
│                                          v
│  ┌──────────────────────────────────────────────────────────────────────────────────────────────────┐   │
│  │ Microsoft Agent Framework (Agent Runtime + Tools)                                                 │   │
│  │ - Supervisor/Orchestrator agent (conversation state + routing policy)                              │   │
│  │ - Tools = callable specialist agents (Risk, Fatigue, Tactical)                                     │   │
│  │ - Supports “Run Selected Agent” and “Run All Agents” flows                                         │   │
│  └──────────────────────────────────────────────────────────────────────────────────────────────────┘   │
│                                          │
│                                          │ model calls
│                                          v
│  ┌──────────────────────────────────────────────────────────────────────────────────────────────────┐   │
│  │ Microsoft Foundry (Azure AI Foundry / Azure OpenAI)                                                │   │
│  │ - Model deployments                                                                                │   │
│  │ - Secure endpoints + keys                                                                          │   │
│  │                                                                                                    │   │
│  │   ┌──────────────────────────────┐      ┌─────────────────────────────────────────────────────┐   │
│  │   │ Model Router / Policy Layer  │─────►│ Specialist Agents (3)                                │   │
│  │   │ - Intent detection           │      │ 1) Fatigue Agent  → workload + recovery drift        │   │
│  │   │ - Cost/latency-aware choice  │      │ 2) Risk Agent     → injury/no-ball risk + alerts     │   │
│  │   │ - Safe fallback routing      │      │ 3) Tactical Agent → substitution + next-action plan │   │
│  │   └──────────────────────────────┘      └─────────────────────────────────────────────────────┘   │
│  │                    │
│  │                    └──────────────► Final Recommendation Synthesizer
│  │                                     - Merges agent outputs into one decision
│  └──────────────────────────────────────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
                                          │
                                          │ response JSON
                                          v
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ UI “Analysis Output” Panel                                                                              │
│ - Shows router intent + signals                                                                          │
│ - Displays agent cards (skipped/ok/fallback)                                                              │
│ - “Run All Agents” button → forces full multi-agent pass + final output                                  │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘


DEV + DELIVERY TOOLING (MICROSOFT + GITHUB)
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ GitHub Repository                                                                                        │
│ - Source code, issues, README, architecture diagram                                                      │
│ GitHub Actions (CI/CD)                                                                                   │
│ - Build + deploy to Azure App Service                                                                     │
│ GitHub Copilot                                                                                           │
│ - Assisted coding for UI, API endpoints, Agent Framework glue code, tests, refactors                      │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
