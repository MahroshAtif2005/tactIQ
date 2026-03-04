export interface AuthUser {
  isAuthenticated: boolean;
  userId: string;
  name?: string;
  email?: string;
}

const SWA_ME_URL = '/.auth/me';
export const DEMO_MODE_STORAGE_KEY = 'tactiq:demo';

interface ClientPrincipalClaim {
  typ?: string;
  val?: string;
}

interface ClientPrincipal {
  identityProvider?: string;
  userId?: string;
  userDetails?: string;
  claims?: ClientPrincipalClaim[];
}

const getClaim = (claims: ClientPrincipalClaim[] | undefined, ...types: string[]): string => {
  if (!Array.isArray(claims)) return '';
  const typeSet = new Set(types.map((type) => type.toLowerCase()));
  for (const claim of claims) {
    const typ = String(claim?.typ || '').toLowerCase();
    if (!typeSet.has(typ)) continue;
    const val = String(claim?.val || '').trim();
    if (val) return val;
  }
  return '';
};

const toAuthUser = (principal: ClientPrincipal | null): AuthUser => {
  if (!principal) return { isAuthenticated: false, userId: '' };
  const claims = Array.isArray(principal.claims) ? principal.claims : [];
  const userId =
    String(principal.userId || '').trim() ||
    getClaim(
      claims,
      'http://schemas.microsoft.com/identity/claims/objectidentifier',
      'oid',
      'sub',
      'nameidentifier'
    );
  if (!userId) return { isAuthenticated: false, userId: '' };
  const name =
    String(principal.userDetails || '').trim() ||
    getClaim(claims, 'name', 'given_name');
  const email = getClaim(claims, 'emails', 'email', 'preferred_username', 'upn');
  return {
    isAuthenticated: true,
    userId,
    ...(name ? { name } : {}),
    ...(email ? { email } : {}),
  };
};

export const isDemoModeEnabled = (): boolean => {
  if (typeof window === 'undefined') return false;
  try {
    return String(window.localStorage.getItem(DEMO_MODE_STORAGE_KEY) || '').trim() === 'true';
  } catch {
    return false;
  }
};

export const setDemoModeEnabled = (enabled: boolean): void => {
  if (typeof window === 'undefined') return;
  try {
    if (enabled) {
      window.localStorage.setItem(DEMO_MODE_STORAGE_KEY, 'true');
    } else {
      window.localStorage.removeItem(DEMO_MODE_STORAGE_KEY);
    }
  } catch {
    // Ignore storage failures in restricted browser modes.
  }
};

export const getUser = async (): Promise<AuthUser> => {
  if (typeof window === 'undefined') return { isAuthenticated: false, userId: '' };
  if (isDemoModeEnabled()) {
    return {
      isAuthenticated: true,
      userId: 'demo-local',
      name: 'Demo Coach',
      email: 'demo@local',
    };
  }

  try {
    const response = await fetch(SWA_ME_URL, {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return { isAuthenticated: false, userId: '' };
    const payload = await response.json();
    const principal = payload && typeof payload === 'object'
      ? ((payload.clientPrincipal || (Array.isArray(payload.clientPrincipal) ? payload.clientPrincipal[0] : null)) as ClientPrincipal | null)
      : null;
    return toAuthUser(principal);
  } catch {
    return { isAuthenticated: false, userId: '' };
  }
};

export const getMicrosoftLoginUrl = (): string =>
  '/.auth/login/aad?post_login_redirect_uri=/';

export const getMicrosoftLogoutUrl = (): string =>
  '/.auth/logout?post_logout_redirect_uri=/auth';

