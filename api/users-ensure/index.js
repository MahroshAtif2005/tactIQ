const { ensureUser, getIdentity, getStorageDiagnostics } = require('../shared/store');
const { jsonResponse, optionsResponse } = require('../shared/agentRuntime');

const isDemoRequest = (req) =>
  String(req?.headers?.['x-tactiq-demo'] || req?.headers?.['X-TACTIQ-DEMO'] || '')
    .trim()
    .toLowerCase() === 'true';

module.exports = async function usersEnsure(context, req) {
  try {
    const method = String(req?.method || 'POST').trim().toUpperCase();
    const diagnostics = getStorageDiagnostics();
    context.log('[users/ensure] request', {
      method,
      storageMode: diagnostics.mode,
      db: diagnostics.databaseId,
      container: diagnostics.playersContainerId,
      endpointHost: diagnostics.endpointHost || 'n/a',
    });
    if (method === 'OPTIONS') {
      context.res = optionsResponse('POST,OPTIONS', {}, req);
      return;
    }
    if (isDemoRequest(req)) {
      context.res = jsonResponse(200, {
        ok: true,
        id: 'demo-local',
        userId: 'demo-local',
        teamId: 'demo-local-team',
        name: 'Demo Coach',
        email: 'demo@local',
        role: 'coach',
        source: 'demo-local',
        warning: 'Demo mode uses localStorage only. Cosmos is bypassed.',
      });
      return;
    }

    const identity = getIdentity(req);
    if (!identity) {
      context.log.warn('[users/ensure] 401 unauthorized');
      context.res = jsonResponse(401, {
        ok: false,
        error: 'unauthorized',
        message: 'Sign in with Microsoft to access coach profile.',
      });
      return;
    }

    const user = await ensureUser(identity);
    const postEnsureDiagnostics = getStorageDiagnostics();
    context.log('[users/ensure] identity', {
      source: String(identity?.source || '').trim() || null,
      userId: String(user?.userId || '').trim() || null,
      teamId: String(user?.teamId || '').trim() || null,
      hasEmail: Boolean(String(user?.email || '').trim()),
      storageMode: postEnsureDiagnostics.mode,
    });
    context.res = jsonResponse(200, {
      ok: true,
      id: user.id,
      userId: user.userId,
      email: user.email || null,
      name: user.name || null,
      teamId: user.teamId,
      role: user.role || 'coach',
      createdAt: user.createdAt || null,
      updatedAt: user.updatedAt || null,
      source: postEnsureDiagnostics.mode,
      storage: {
        mode: postEnsureDiagnostics.mode,
        db: postEnsureDiagnostics.databaseId,
        container: postEnsureDiagnostics.playersContainerId,
        requestedContainer: postEnsureDiagnostics.requestedPlayersContainerId || postEnsureDiagnostics.playersContainerId,
        endpointHost: postEnsureDiagnostics.endpointHost || 'n/a',
        authMode: postEnsureDiagnostics.authMode || null,
        requiredAppSettings: postEnsureDiagnostics.requiredAppSettings || [],
        optionalAppSettings: postEnsureDiagnostics.optionalAppSettings || [],
      },
      ...(postEnsureDiagnostics.initFailure
        ? {
            storageError:
              (postEnsureDiagnostics.initFailureDetail && postEnsureDiagnostics.initFailureDetail.error) ||
              {
                code: postEnsureDiagnostics.initFailure,
                message: postEnsureDiagnostics.initFailure,
                missingKeys:
                  postEnsureDiagnostics.missingAuthKeys || postEnsureDiagnostics.missingRequiredAppSettings || [],
                requiredAppSettings: postEnsureDiagnostics.requiredAppSettings || [],
              },
          }
        : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context.log.error('[users/ensure] error', message);
    context.res = jsonResponse(500, {
      ok: false,
      error: 'profile_ensure_failed',
      message,
    });
  }
};
