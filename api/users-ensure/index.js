const { ensureUser, getIdentity } = require('../shared/store');

module.exports = async function usersEnsure(context, req) {
  try {
    const identity = getIdentity(req);
    if (!identity) {
      context.log.warn('[users/ensure] 401 unauthorized');
      context.res = {
        status: 401,
        body: {
          ok: false,
          error: 'unauthorized',
          message: 'Sign in with Microsoft to access coach profile.',
        },
      };
      return;
    }

    const user = await ensureUser(identity);
    context.res = {
      status: 200,
      body: {
        ok: true,
        id: user.id,
        userId: user.userId,
        email: user.email || null,
        name: user.name || null,
        teamId: user.teamId,
        role: user.role || 'coach',
        createdAt: user.createdAt || null,
        updatedAt: user.updatedAt || null,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context.log.error('[users/ensure] error', message);
    context.res = {
      status: 500,
      body: {
        ok: false,
        error: 'profile_ensure_failed',
        message,
      },
    };
  }
};
