const { ensureUser, getIdentity, listBaselines, saveBaselines, getStorageMode } = require('../shared/store');

const unauthorized = {
  ok: false,
  error: 'unauthorized',
  message: 'Sign in with Microsoft to access baselines.',
};

module.exports = async function baselines(context, req) {
  try {
    const identity = getIdentity(req);
    if (!identity) {
      context.log.warn('[baselines] 401 unauthorized');
      context.res = { status: 401, body: unauthorized };
      return;
    }

    const user = await ensureUser(identity);
    if (!user || !user.teamId) {
      context.res = {
        status: 500,
        body: {
          ok: false,
          error: 'scope_resolve_failed',
          message: 'Unable to resolve team scope.',
        },
      };
      return;
    }

    const method = String(req.method || 'GET').toUpperCase();
    if (method === 'GET') {
      const players = await listBaselines({ userId: user.userId, teamId: user.teamId });
      context.res = {
        status: 200,
        body: {
          ok: true,
          items: players,
          players,
          source: getStorageMode(),
        },
      };
      return;
    }

    if (method === 'POST') {
      const players = await saveBaselines({
        userId: user.userId,
        teamId: user.teamId,
        payload: req.body,
      });
      context.res = {
        status: 200,
        body: {
          success: true,
          ok: true,
          players,
          source: getStorageMode(),
        },
      };
      return;
    }

    context.res = {
      status: 405,
      headers: { Allow: 'GET, POST' },
      body: { ok: false, error: 'method_not_allowed' },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isValidation = error && typeof error === 'object' && error.code === 'VALIDATION_ERROR';
    context.log.error('[baselines] error', message);
    context.res = {
      status: isValidation ? 400 : 500,
      body: {
        ok: false,
        error: isValidation ? 'validation_error' : 'baselines_failed',
        message,
      },
    };
  }
};
