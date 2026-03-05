const {
  jsonResponse,
  normalizeBody,
  tryInvokeDistHandler,
  getMissingRuntimeConfig,
  logMissingRuntimeConfig,
} = require('../shared/agentRuntime');
const { runFatigueFallback } = require('../shared/simpleAgents');

module.exports = async function fatigue(context, req) {
  try {
    const missing = getMissingRuntimeConfig();
    if (missing.length > 0) {
      logMissingRuntimeConfig(context, 'fatigue', missing);
      context.res = jsonResponse(500, { ok: false, error: 'missing_config', missing });
      return;
    }

    const distResponse = await tryInvokeDistHandler({
      context,
      req,
      relativePath: 'dist/functions/fatigue.js',
      exportName: 'fatigueHandler',
    });

    if (distResponse) {
      context.res = distResponse;
      return;
    }

    const payload = normalizeBody(req);
    context.res = jsonResponse(200, runFatigueFallback(payload));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context.log?.('[fatigue] error', message);
    context.res = jsonResponse(500, { ok: false, error: message });
  }
};
