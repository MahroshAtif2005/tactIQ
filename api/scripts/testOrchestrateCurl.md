# Orchestrate Endpoint Quick Tests

## A) Minimal payload (text + mode + optional signals)

This should return HTTP `200` (or `207` if fallback warnings are present), not `400`.

```bash
curl -i -X POST http://localhost:8080/api/orchestrate \
  -H "Content-Type: application/json" \
  -d '{"text":"substitution needed: bowler looks injured and fatigue is high","mode":"route","signals":{"injury":true,"fatigue":7.8,"noBallRisk":"HIGH"}}'
```

## B) Full payload (telemetry + matchContext + players)

This should return HTTP `200` (or `207` if fallback warnings are present).

```bash
curl -i -X POST http://localhost:8080/api/orchestrate \
  -H "Content-Type: application/json" \
  -d '{"mode":"full","intent":"monitor","telemetry":{"playerId":"P1","playerName":"Player 1","role":"Bowler","fatigueIndex":6.2,"heartRateRecovery":"Moderate","oversBowled":3,"consecutiveOvers":2,"injuryRisk":"MEDIUM","noBallRisk":"HIGH"},"matchContext":{"phase":"middle","requiredRunRate":8.1,"currentRunRate":7.4,"wicketsInHand":6,"oversRemaining":8,"format":"T20"},"players":{"striker":"Batter A","nonStriker":"Batter B","bowler":"Player 1","bench":["Bench Bowler"]}}'
```
