const parseBase64Json = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf8');
    const parsed = JSON.parse(decoded);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
};

const parseBase64UrlJson = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const normalized = raw.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4 || 4)) % 4);
    const decoded = Buffer.from(padded, 'base64').toString('utf8');
    const parsed = JSON.parse(decoded);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
};

const getClaimValue = (claims, ...types) => {
  if (!Array.isArray(claims)) return '';
  const typeSet = new Set(types.map((entry) => String(entry || '').toLowerCase()));
  for (const claim of claims) {
    const typ = String(claim?.typ || claim?.type || '').toLowerCase();
    if (!typeSet.has(typ)) continue;
    const val = String(claim?.val || claim?.value || '').trim();
    if (val) return val;
  }
  return '';
};

const parseClientPrincipal = (req) => {
  const headerValue = req?.headers?.['x-ms-client-principal'];
  if (!headerValue) return null;
  const serialized = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  return parseBase64Json(serialized);
};

const parseBearerPayload = (req) => {
  const headerValue = req?.headers?.authorization || req?.headers?.Authorization;
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  const auth = String(raw || '').trim();
  if (!/^bearer\s+/i.test(auth)) return null;
  const token = auth.replace(/^bearer\s+/i, '').trim();
  if (!token) return null;
  const segments = token.split('.');
  if (segments.length < 2) return null;
  return parseBase64UrlJson(segments[1]);
};

const getPayloadClaim = (payload, ...keys) => {
  if (!payload || typeof payload !== 'object') return '';
  for (const key of keys) {
    const value = String(payload[key] || '').trim();
    if (value) return value;
  }
  return '';
};

const shouldAllowDevBypass = () => {
  if (String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production') return false;
  const toggle = String(process.env.ALLOW_DEV_AUTH_BYPASS || 'false').trim().toLowerCase();
  return toggle !== 'false' && toggle !== '0' && toggle !== 'no';
};

const extractIdentityFromPrincipal = (principal) => {
  if (!principal || typeof principal !== 'object') return null;
  const claims = Array.isArray(principal.claims) ? principal.claims : [];
  const email = getClaimValue(claims, 'emails', 'email', 'preferred_username', 'upn');
  const userId =
    String(principal.userId || '').trim() ||
    getClaimValue(
      claims,
      'http://schemas.microsoft.com/identity/claims/objectidentifier',
      'oid',
      'sub',
      'nameidentifier'
    ) ||
    email;
  if (!userId) return null;

  const name =
    String(principal.userDetails || '').trim() ||
    getClaimValue(claims, 'name', 'given_name', 'preferred_username');
  return {
    isAuthenticated: true,
    userId,
    ...(name ? { name } : {}),
    ...(email ? { email } : {}),
    authSource: 'entra',
  };
};

const extractIdentityFromBearer = (payload) => {
  if (!payload || typeof payload !== 'object') return null;
  const email = getPayloadClaim(payload, 'email', 'preferred_username', 'upn');
  const userId = getPayloadClaim(
    payload,
    'oid',
    'sub',
    'nameid',
    'nameidentifier',
    'http://schemas.microsoft.com/identity/claims/objectidentifier'
  ) || email;
  if (!userId) return null;

  const name = getPayloadClaim(payload, 'name', 'given_name', 'preferred_username');
  return {
    isAuthenticated: true,
    userId,
    ...(name ? { name } : {}),
    ...(email ? { email } : {}),
    authSource: 'bearer',
  };
};

const getRequestIdentity = (req) => {
  const principal = parseClientPrincipal(req);
  const fromHeader = extractIdentityFromPrincipal(principal);
  if (fromHeader) return fromHeader;

  const bearerPayload = parseBearerPayload(req);
  const fromBearer = extractIdentityFromBearer(bearerPayload);
  if (fromBearer) return fromBearer;

  if (shouldAllowDevBypass()) {
    const devUserIdHeader = req?.headers?.['x-dev-user-id'];
    const devUserIdRaw = Array.isArray(devUserIdHeader) ? devUserIdHeader[0] : devUserIdHeader;
    const devUserId = String(devUserIdRaw || process.env.DEV_AUTH_USER_ID || 'local-dev-coach').trim();
    if (devUserId) {
      return {
        isAuthenticated: true,
        userId: devUserId,
        name: 'Local Dev Coach',
        authSource: 'dev-bypass',
      };
    }
  }

  return {
    isAuthenticated: false,
    userId: '',
    authSource: 'none',
  };
};

module.exports = {
  getRequestIdentity,
};
