const {
  jsonResponse,
  normalizeBody,
  tryInvokeDistHandler,
  getMissingRuntimeConfig,
  logMissingRuntimeConfig,
} = require('../shared/agentRuntime');
const { runFatigueFallback, runRiskFallback } = require('../shared/simpleAgents');

module.exports = async function risk(context, req) {
  try {
    const missing = getMissingRuntimeConfig();
    if (missing.length > 0) {
      logMissingRuntimeConfig(context, 'risk', missing);
      context.res = jsonResponse(500, { ok: false, error: 'missing_config', missing });
      return;
    }

    const distResponse = await tryInvokeDistHandler({
      context,
      req,
      relativePath: 'dist/functions/risk.js',
      exportName: 'riskHandler',
    });

    if (distResponse) {
      context.res = distResponse;
      return;
    }

    const payload = normalizeBody(req);
    const fatigue = runFatigueFallback(payload);
    context.res = jsonResponse(200, runRiskFallback(payload, fatigue));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context.log?.('[risk] error', message);
    context.res = jsonResponse(500, { ok: false, error: message });
  }
};
