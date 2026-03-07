const {
  ensureUser,
  getIdentity,
  listBaselines,
  saveBaselines,
  replaceBaselines,
  deleteBaselineById,
  checkBaselineOwnership,
  resetBaselines,
  getStorageDiagnostics,
} = require('../shared/store');
const { jsonResponse, optionsResponse } = require('../shared/agentRuntime');

const unauthorized = {
  ok: false,
  error: 'unauthorized',
  message: 'Sign in with Microsoft to access baselines.',
};

const isDemoRequest = (req) =>
  String(req?.headers?.['x-tactiq-demo'] || req?.headers?.['X-TACTIQ-DEMO'] || '')
    .trim()
    .toLowerCase() === 'true';

const getStorageResponseMeta = () => {
  const diagnostics = getStorageDiagnostics();
  const storageError = diagnostics.initFailureDetail && typeof diagnostics.initFailureDetail === 'object'
    ? diagnostics.initFailureDetail.error || null
    : null;
  const responseMeta = {
    source: diagnostics.mode,
    storage: {
      mode: diagnostics.mode,
      db: diagnostics.databaseId,
      container: diagnostics.playersContainerId,
      endpointHost: diagnostics.endpointHost || 'n/a',
      authMode: diagnostics.authMode || null,
      requiredAppSettings: diagnostics.requiredAppSettings || [],
      optionalAppSettings: diagnostics.optionalAppSettings || [],
    },
  };
  if (diagnostics.mode === 'memory') {
    const reason = diagnostics.initFailure ? ` (${diagnostics.initFailure})` : '';
    const missingKeysSuffix =
      storageError && Array.isArray(storageError.missingKeys) && storageError.missingKeys.length > 0
        ? ` Missing: ${storageError.missingKeys.join(', ')}.`
        : '';
    responseMeta.warning =
      `Cosmos unavailable${reason}. Using in-memory fallback only; data is not persisted to playersByUser.${missingKeysSuffix}`;
  }
  if (diagnostics.initFailure) {
    responseMeta.storageInitFailure = diagnostics.initFailure;
    responseMeta.storageInitFailureDetail = diagnostics.initFailureDetail || null;
    responseMeta.storageError =
      storageError ||
      {
        code: diagnostics.initFailure,
        message: diagnostics.initFailure,
        missingKeys: diagnostics.missingAuthKeys || diagnostics.missingRequiredAppSettings || [],
        requiredAppSettings: diagnostics.requiredAppSettings || [],
      };
  }
  return responseMeta;
};

const logStorageFallback = (context, method, user) => {
  const diagnostics = getStorageDiagnostics();
  if (diagnostics.mode !== 'memory') return;
  context.log.warn('[baselines] storage_fallback', {
    method,
    userId: String(user?.userId || '').trim() || null,
    teamId: String(user?.teamId || '').trim() || null,
    reason: diagnostics.initFailure || 'cosmos_unavailable',
    detail: diagnostics.initFailureDetail || null,
    db: diagnostics.databaseId,
    container: diagnostics.playersContainerId,
    endpointHost: diagnostics.endpointHost || 'n/a',
    configSource: diagnostics.configSource || null,
  });
};

module.exports = async function baselines(context, req) {
  try {
    const method = String(req.method || 'GET').toUpperCase();
    const diagnostics = getStorageDiagnostics();
    context.log('[baselines] request', {
      method,
      routeId: String(req?.params?.id || '').trim() || null,
      demoRequest: isDemoRequest(req),
      storageMode: diagnostics.mode,
      db: diagnostics.databaseId,
      container: diagnostics.playersContainerId,
    });
    if (method === 'OPTIONS') {
      context.res = optionsResponse('GET,POST,PATCH,DELETE,OPTIONS', {}, req);
      return;
    }
    const baselineId = String(req?.params?.id || '').trim();
    const isResetRoute = baselineId.toLowerCase() === 'reset';
    if (isDemoRequest(req)) {
      if (method === 'GET') {
        if (baselineId && !isResetRoute) {
          context.res = jsonResponse(404, {
            ok: false,
            error: 'not_found',
            message: `Baseline '${baselineId}' not found in demo local mode.`,
            source: 'demo-local',
          });
          return;
        }
        context.res = jsonResponse(200, {
          ok: true,
          items: [],
          players: [],
          source: 'demo-local',
          warning: 'Demo mode uses localStorage only. Cosmos is bypassed.',
        });
        return;
      }
      context.res = jsonResponse(200, {
        ok: true,
        players: [],
        source: 'demo-local',
        warning: 'Demo mode uses localStorage only. Cosmos is bypassed.',
      });
      return;
    }

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
    context.log('[baselines] identity', {
      source: String(identity?.source || '').trim() || null,
      userId: String(user.userId || '').trim() || null,
      teamId: String(user.teamId || '').trim() || null,
      hasEmail: Boolean(String(user.email || '').trim()),
    });

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
          ...getStorageResponseMeta(),
        });
        return;
      }
      context.res = jsonResponse(200, {
        ok: true,
        items: players,
        players,
        ...getStorageResponseMeta(),
      });
      return;
    }

    if (method === 'POST') {
      if (isResetRoute) {
        const players = await resetBaselines({ userId: user.userId, teamId: user.teamId, userEmail: user.email || '' });
        logStorageFallback(context, method, user);
        context.res = jsonResponse(200, {
          ok: true,
          deleted: players.length,
          players,
          ...getStorageResponseMeta(),
        });
        return;
      }
      const players = await saveBaselines({
        userId: user.userId,
        teamId: user.teamId,
        userEmail: user.email || '',
        payload: req.body,
      });
      logStorageFallback(context, method, user);
      context.res = jsonResponse(200, {
        success: true,
        ok: true,
        players,
        ...getStorageResponseMeta(),
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
        const ownership = await checkBaselineOwnership({ userId: user.userId, baselineId });
        if (ownership.exists && !ownership.owned) {
          context.res = jsonResponse(403, {
            ok: false,
            error: 'forbidden',
            message: `Baseline '${baselineId}' belongs to a different user.`,
          });
          return;
        }
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
        userEmail: user.email || '',
        payload: { players: nextPlayers },
      });
      logStorageFallback(context, method, user);
      const player = saved.find((row) => String(row.id || '').trim() === baselineId) || null;
      context.res = jsonResponse(200, {
        ok: true,
        player,
        ...getStorageResponseMeta(),
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
      logStorageFallback(context, method, user);
      context.res = jsonResponse(200, {
        ok: true,
        deleted: 1,
        players,
        ...getStorageResponseMeta(),
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
    const isForbidden = error && typeof error === 'object' && Number(error.code) === 403;
    context.log.error('[baselines] error', message);
    context.res = jsonResponse(isForbidden ? 403 : isValidation ? 400 : 500, {
      ok: false,
      error: isForbidden ? 'forbidden' : isValidation ? 'validation_error' : 'baselines_failed',
      message,
    });
  }
};
