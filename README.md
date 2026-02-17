# tactIQ

## 🚀 Live Demo
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
2. Start frontend + Azure Functions API:
   - `npm run dev`

Frontend runs on `http://localhost:3000` and API runs on `http://localhost:7072`.

## Fatigue Agent endpoint

- `POST http://localhost:7072/api/agents/fatigue`
- Frontend can call `/api/agents/fatigue` (proxied by Vite in dev).

If you change Vite proxy settings, restart the Vite dev server.

## LLM Setup

Fatigue Agent supports two modes:
- Rule based fallback 
- Azure OpenAI LLM analysis 

Set these in `api/local.settings.json` (or environment):
- `AZURE_OPENAI_ENDPOINT`
- `AZURE_OPENAI_API_KEY`
- `AZURE_OPENAI_DEPLOYMENT`

The function auto-switches to LLM mode only when all three required values are present.

Quick setup:
1. Copy `api/local.settings.json.example` to `api/local.settings.json`
2. Add your Azure OpenAI values
3. Run `cd api && func start`

## Deployment
Deployed on Azure App Service via GitHub Actions (CI/CD).
Every push to `main` triggers build + deploy.

