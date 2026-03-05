const {
  jsonResponse,
  normalizeBody,
  tryInvokeDistHandler,
  getMissingRuntimeConfig,
  logMissingRuntimeConfig,
} = require('../shared/agentRuntime');
const { runOrchestrateFallback } = require('../shared/simpleAgents');

module.exports = async function orchestrate(context, req) {
  try {
    const missing = getMissingRuntimeConfig();
    if (missing.length > 0) {
      logMissingRuntimeConfig(context, 'orchestrate', missing);
      context.res = jsonResponse(500, { ok: false, error: 'missing_config', missing });
      return;
    }

    const distResponse = await tryInvokeDistHandler({
      context,
      req,
      relativePath: 'dist/functions/orchestrate.js',
      exportName: 'orchestrateHandler',
    });

    if (distResponse) {
      context.res = distResponse;
      return;
    }

    const payload = normalizeBody(req);
    context.res = jsonResponse(200, runOrchestrateFallback(payload));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context.log?.('[orchestrate] error', message);
    context.res = jsonResponse(500, { ok: false, error: message });
  }
};
