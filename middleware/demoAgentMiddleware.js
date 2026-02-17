/**
 * Demo agent middleware for Express.
 *
 * Behavior:
 * - If `?demo=true` is present, responds immediately with mock agent output.
 * - Otherwise, passes control to the next handler (real agent call path).
 *
 * To add more mock responses:
 * 1) Add a new key under `mockAgentResponses` (e.g. `substitution`).
 * 2) Mount/use the same middleware on `/api/agents/:agent`.
 * 3) Ensure your real handler supports the same `:agent` name.
 */

const mockAgentResponses = {
  fatigue: {
    agent: "fatigue",
    severity: "MED",
    fatigueIndex: 6.2,
    headline: "Fatigue Trend Rising",
    explanation: "Workload and consecutive overs are pushing fatigue above baseline tolerance.",
    signals: ["FATIGUE_RISING", "SPELL_LOAD", "CONSEC_OVERS"],
    recommendation: "Rotate within the next over and reduce intensity for recovery window.",
  },
  risk: {
    agent: "risk",
    severity: "HIGH",
    riskScore: 8,
    headline: "High Composite Risk",
    explanation: "Composite risk is elevated due to control risk, spell load, and match pressure.",
    signals: ["CONTROL_RISK", "SPELL_LOAD", "CHASE_PRESSURE"],
    recommendation: "Avoid high-pressure overs now; substitute or rest immediately.",
  },
  tactical: {
    agent: "tactical",
    severity: "MED",
    headline: "Tactical Adjustment Recommended",
    explanation: "Current matchup favors rotation and defensive field protection this phase.",
    signals: ["MATCHUP_ALERT", "PHASE_PRESSURE"],
    recommendation: "Change field to protect square boundaries and use variation-heavy bowling.",
  },
};

function demoAgentMiddleware(req, res, next) {
  const demoEnabled = String(req.query.demo || "").toLowerCase() === "true";
  if (!demoEnabled) return next();

  const agent = String(req.params.agent || "").toLowerCase();
  const mock = mockAgentResponses[agent];
  if (!mock) {
    return res.status(404).json({
      error: `No mock response configured for agent '${agent}'`,
      availableMocks: Object.keys(mockAgentResponses),
    });
  }

  return res.status(200).json(mock);
}

module.exports = {
  demoAgentMiddleware,
  mockAgentResponses,
};

