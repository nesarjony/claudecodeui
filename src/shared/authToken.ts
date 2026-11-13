/**
 * The client's half of the JWT session: parsing, expiry, storage and the two
 * events the auth context listens to.
 *
 * Extracted from api.ts, which is meant to be the endpoint map plus its request
 * helpers. This is the security-sensitive part and it is what WebSocketContext,
 * AuthContext, the shell socket and the file-tree uploader actually import.
 */

export const AUTH_TOKEN_REFRESHED_EVENT = 'auth-token-refreshed';
export const AUTH_SESSION_EXPIRED_EVENT = 'auth-session-expired';

// Only accept a refreshed token that has this app's issued JWT shape
// (three base64url segments). An attacker-injected/malformed header value
// must never overwrite the stored auth token.
export const isValidRefreshedToken = (token: unknown): token is string =>
  typeof token === 'string' &&
  /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);

type TokenClaims = {
  issuedAt: number;
  expiresAt: number;
};

const readTokenClaims = (token: unknown): TokenClaims | null => {
  if (!isValidRefreshedToken(token)) {
    return null;
  }

  try {
    const encodedPayload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const paddedPayload = encodedPayload.padEnd(
      encodedPayload.length + ((4 - (encodedPayload.length % 4)) % 4),
      '=',
    );
    const payload = JSON.parse(atob(paddedPayload)) as { iat?: unknown; exp?: unknown };

    if (
      typeof payload.iat !== 'number' ||
      !Number.isFinite(payload.iat) ||
      typeof payload.exp !== 'number' ||
      !Number.isFinite(payload.exp)
    ) {
      return null;
    }

    return { issuedAt: payload.iat * 1000, expiresAt: payload.exp * 1000 };
  } catch {
    return null;
  }
};

// Tolerance for client/server clock skew. The server's own jwt.verify is the
// real authority; this check only decides whether the client should discard a
// token locally. Without an allowance, a browser clock running slightly ahead
// reads a still-server-valid token as expired and drops the session.
export const TOKEN_EXPIRY_SKEW_MS = 60_000;

export const isAuthTokenExpired = (token: unknown): boolean => {
  const claims = readTokenClaims(token);
  return claims ? Date.now() >= claims.expiresAt + TOKEN_EXPIRY_SKEW_MS : false;
};

export const getAuthTokenRefreshDelay = (token: unknown): number | null => {
  const claims = readTokenClaims(token);
  if (!claims) {
    return null;
  }

  const refreshAt = claims.issuedAt + ((claims.expiresAt - claims.issuedAt) / 2);
  return Math.max(0, refreshAt - Date.now());
};

// Why recent sessions on this device ended. A sign-out on a phone happens
// where nobody can watch the console, so the reason is kept here, shown on the
// login screen and copied to the server preferences on the next sign-in.
const SIGN_OUT_LOG_KEY = 'auth-sign-out-log';
const SIGN_OUT_LOG_LIMIT = 10;

export type SignOutRecord = {
  at: string;
  reason: string;
  path: string;
  tokenIssuedAt?: string;
  tokenExpiresAt?: string;
};

export const readSignOutLog = (): SignOutRecord[] => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SIGN_OUT_LOG_KEY) ?? '[]');
    return Array.isArray(parsed) ? (parsed as SignOutRecord[]) : [];
  } catch {
    return [];
  }
};

// Set while this browser holds a signed-in session, so a page that opens with
// no token at all (storage wiped by the browser) is told apart from one that
// was never signed in.
const SIGNED_IN_MARKER_KEY = 'auth-signed-in';

export const markSignedIn = (): void => {
  try {
    localStorage.setItem(SIGNED_IN_MARKER_KEY, '1');
  } catch {
    // Ignore storage failures; the marker only feeds diagnostics.
  }
};

export const wasSignedIn = (): boolean => {
  try {
    return localStorage.getItem(SIGNED_IN_MARKER_KEY) === '1';
  } catch {
    return false;
  }
};

export const recordSignOut = (reason: string, token: unknown = localStorage.getItem('auth-token')): void => {
  try {
    localStorage.removeItem(SIGNED_IN_MARKER_KEY);
    const claims = readTokenClaims(token);
    const record: SignOutRecord = {
      at: new Date().toISOString(),
      reason,
      path: typeof window !== 'undefined' ? window.location.pathname : '',
      ...(claims && {
        tokenIssuedAt: new Date(claims.issuedAt).toISOString(),
        tokenExpiresAt: new Date(claims.expiresAt).toISOString(),
      }),
    };
    const log = [...readSignOutLog(), record].slice(-SIGN_OUT_LOG_LIMIT);
    localStorage.setItem(SIGN_OUT_LOG_KEY, JSON.stringify(log));
  } catch {
    // Diagnostics must never get in the way of signing out.
  }
};

/**
 * Ends the session because `expiredToken` (the credential a request or socket
 * actually used) has expired. Every tab shares one stored token, so a tab
 * holding an old token in memory - a phone tab resumed after weeks in the
 * background - must not delete the fresh token another tab is using. When the
 * stored token is newer and still valid, this tab adopts it instead.
 */
export const expireAuthSession = (reason: string, expiredToken?: unknown): void => {
  const stored = localStorage.getItem('auth-token');
  if (expiredToken !== undefined && stored && stored !== expiredToken && !isAuthTokenExpired(stored)) {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(AUTH_TOKEN_REFRESHED_EVENT, { detail: stored }));
    }
    return;
  }

  recordSignOut(reason, expiredToken ?? stored);
  localStorage.removeItem('auth-token');
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(AUTH_SESSION_EXPIRED_EVENT));
  }
};

export const getStoredAuthToken = (): string | null => {
  const token = localStorage.getItem('auth-token');
  if (token && isAuthTokenExpired(token)) {
    expireAuthSession('the stored token was past its expiry when a request was about to use it', token);
    return null;
  }
  return token;
};

export const storeAuthToken = (token: unknown): boolean => {
  if (!isValidRefreshedToken(token)) {
    return false;
  }

  localStorage.setItem('auth-token', token);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(AUTH_TOKEN_REFRESHED_EVENT, { detail: token }));
  }
  return true;
};
