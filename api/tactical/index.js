const {
  jsonResponse,
  normalizeBody,
  tryInvokeDistHandler,
  getMissingRuntimeConfig,
  logMissingRuntimeConfig,
} = require('../shared/agentRuntime');
const { runFatigueFallback, runRiskFallback, runTacticalFallback } = require('../shared/simpleAgents');

module.exports = async function tactical(context, req) {
  try {
    const missing = getMissingRuntimeConfig();
    if (missing.length > 0) {
      logMissingRuntimeConfig(context, 'tactical', missing);
      context.res = jsonResponse(500, { ok: false, error: 'missing_config', missing });
      return;
    }

    const distResponse = await tryInvokeDistHandler({
      context,
      req,
      relativePath: 'dist/functions/tactical.js',
      exportName: 'tacticalHandler',
    });

    if (distResponse) {
      context.res = distResponse;
      return;
    }

    const payload = normalizeBody(req);
    const fatigue = runFatigueFallback(payload);
    const risk = runRiskFallback(payload, fatigue);
    context.res = jsonResponse(200, runTacticalFallback(payload, fatigue, risk));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context.log?.('[tactical] error', message);
    context.res = jsonResponse(500, { ok: false, error: message });
  }
};
