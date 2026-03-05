const {
  ensureUser,
  getIdentity,
  listBaselines,
  saveBaselines,
  replaceBaselines,
  deleteBaselineById,
  resetBaselines,
  getStorageMode,
} = require('../shared/store');

const unauthorized = {
  ok: false,
  error: 'unauthorized',
  message: 'Sign in with Microsoft to access baselines.',
};

const jsonResponse = (status, payload, headers = {}) => ({
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    ...headers,
  },
  body: JSON.stringify(payload),
});

module.exports = async function baselines(context, req) {
  try {
    const identity = getIdentity(req);
    if (!identity) {
      context.log.warn('[baselines] 401 unauthorized');
      context.res = jsonResponse(401, unauthorized);
      return;
    }

    const user = await ensureUser(identity);
    if (!user || !user.teamId) {
      context.res = jsonResponse(500, {
        ok: false,
        error: 'scope_resolve_failed',
        message: 'Unable to resolve team scope.',
      });
      return;
    }

    const method = String(req.method || 'GET').toUpperCase();
    const baselineId = String(req?.params?.id || '').trim();
    const isResetRoute = baselineId.toLowerCase() === 'reset';
    if (method === 'GET') {
      const players = await listBaselines({ userId: user.userId, teamId: user.teamId });
      if (baselineId && !isResetRoute) {
        const player = players.find((row) => String(row.id || '').trim() === baselineId) || null;
        if (!player) {
          context.res = jsonResponse(404, {
            ok: false,
            error: 'not_found',
            message: `Baseline '${baselineId}' not found.`,
          });
          return;
        }
        context.res = jsonResponse(200, {
          ok: true,
          player,
          source: getStorageMode(),
        });
        return;
      }
      context.res = jsonResponse(200, {
        ok: true,
        items: players,
        players,
        source: getStorageMode(),
      });
      return;
    }

    if (method === 'POST') {
      if (isResetRoute) {
        const players = await resetBaselines({ userId: user.userId, teamId: user.teamId });
        context.res = jsonResponse(200, {
          ok: true,
          deleted: players.length,
          players,
          source: getStorageMode(),
        });
        return;
      }
      const players = await saveBaselines({
        userId: user.userId,
        teamId: user.teamId,
        payload: req.body,
      });
      context.res = jsonResponse(200, {
        success: true,
        ok: true,
        players,
        source: getStorageMode(),
      });
      return;
    }

    if (method === 'PATCH') {
      if (!baselineId || isResetRoute) {
        context.res = jsonResponse(400, {
          ok: false,
          error: 'validation_error',
          message: 'Missing baseline id for patch.',
        });
        return;
      }
      const patch = req?.body && typeof req.body === 'object' ? req.body : {};
      const players = await listBaselines({ userId: user.userId, teamId: user.teamId });
      const target = players.find((row) => String(row.id || '').trim() === baselineId);
      if (!target) {
        context.res = jsonResponse(404, {
          ok: false,
          error: 'not_found',
          message: `Baseline '${baselineId}' not found.`,
        });
        return;
      }
      const updated = {
        ...target,
        ...(Object.prototype.hasOwnProperty.call(patch, 'active') ? { active: Boolean(patch.active), isActive: Boolean(patch.active) } : {}),
        ...(Object.prototype.hasOwnProperty.call(patch, 'isActive') ? { active: Boolean(patch.isActive), isActive: Boolean(patch.isActive) } : {}),
        ...(Object.prototype.hasOwnProperty.call(patch, 'inRoster') ? { inRoster: Boolean(patch.inRoster) } : {}),
        updatedAt: new Date().toISOString(),
      };
      const nextPlayers = players.map((row) =>
        String(row.id || '').trim() === baselineId ? updated : row
      );
      const saved = await replaceBaselines({
        userId: user.userId,
        teamId: user.teamId,
        payload: { players: nextPlayers },
      });
      const player = saved.find((row) => String(row.id || '').trim() === baselineId) || null;
      context.res = jsonResponse(200, {
        ok: true,
        player,
        source: getStorageMode(),
      });
      return;
    }

    if (method === 'DELETE') {
      if (!baselineId || isResetRoute) {
        context.res = jsonResponse(400, {
          ok: false,
          error: 'validation_error',
          message: 'Missing baseline id for delete.',
        });
        return;
      }
      const players = await deleteBaselineById({
        userId: user.userId,
        teamId: user.teamId,
        baselineId,
      });
      context.res = jsonResponse(200, {
        ok: true,
        deleted: 1,
        players,
        source: getStorageMode(),
      });
      return;
    }

    context.res = jsonResponse(
      405,
      { ok: false, error: 'method_not_allowed' },
      { Allow: 'GET, POST, PATCH, DELETE' }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isValidation = error && typeof error === 'object' && error.code === 'VALIDATION_ERROR';
    context.log.error('[baselines] error', message);
    context.res = jsonResponse(isValidation ? 400 : 500, {
      ok: false,
      error: isValidation ? 'validation_error' : 'baselines_failed',
      message,
    });
  }
};
