/**
 * Public auth HTTP handlers: OIDC/OAuth, basic login, session cookies.
 */
import crypto from 'crypto';
import http from 'http';

import type { OidcAllowlistConfig, OidcProviderConfig, PublicAuthConfig } from './webchat-auth-config.js';
import { verifyIdToken, isJwksRetryableVerificationError, type JsonWebKey } from './webchat-auth-jwt.js';
import { log } from './log.js';
import {
  clearOAuthNonceCookieHeader,
  clearSessionCookieHeader,
  consumeOAuthState,
  createSession,
  deleteSession,
  getSession,
  hashOAuthNonce,
  oauthNonceCookieHeader,
  parseCookieHeader,
  parseSessionCookie,
  saveOAuthState,
  sessionCookieHeader,
  signSessionCookie,
  WEBCHAT_OAUTH_NONCE_COOKIE,
  WEBCHAT_SESSION_COOKIE,
  type WebchatSessionUser,
} from './webchat-auth-sessions.js';

export interface AuthConfigResponse {
  basic: { enabled: boolean };
  providers: Array<{ id: string; label: string }>;
}

export interface ResolvedWebUser {
  userId: string;
  displayName: string;
}

export interface ResolvedWebSession extends ResolvedWebUser {
  sessionId: string;
}

const MAX_LOGIN_BODY_BYTES = 4096;

// ---------------------------------------------------------------------------
// Login rate limiting (in-process): token bucket per client IP + exponential
// per-username backoff after LOGIN_BACKOFF_THRESHOLD consecutive failures.
// ---------------------------------------------------------------------------

/** Token bucket per IP: burst capacity and sustained refill (tokens per second). */
export const LOGIN_IP_BUCKET_CAPACITY = 10;
export const LOGIN_IP_BUCKET_REFILL_PER_SEC = 10 / 60;
/** Consecutive failures for one username before backoff kicks in. */
export const LOGIN_BACKOFF_THRESHOLD = 5;
const LOGIN_BACKOFF_BASE_MS = 2_000;
const LOGIN_BACKOFF_MAX_MS = 15 * 60 * 1000;
const LOGIN_LIMITER_MAX_KEYS = 10_000;

interface IpBucket {
  tokens: number;
  updatedAtMs: number;
}

interface UsernameBackoff {
  failures: number;
  blockedUntilMs: number;
}

const ipBuckets = new Map<string, IpBucket>();
const usernameBackoffs = new Map<string, UsernameBackoff>();

function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr.startsWith('127.');
}

/**
 * Client IP for rate limiting. `X-Real-IP` (set by the nginx front) is trusted
 * only when the TCP peer is loopback, i.e. the request came through the local
 * reverse proxy — a remote client cannot spoof its way into a fresh bucket.
 */
export function clientIpForRateLimit(req: http.IncomingMessage): string {
  const peer = req.socket?.remoteAddress;
  if (isLoopbackAddress(peer)) {
    const realIp = req.headers['x-real-ip'];
    const value = Array.isArray(realIp) ? realIp[0] : realIp;
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return peer ?? 'unknown';
}

function evictIfFull<K, V>(map: Map<K, V>): void {
  if (map.size < LOGIN_LIMITER_MAX_KEYS) return;
  const oldest = map.keys().next();
  if (!oldest.done) map.delete(oldest.value);
}

/** Take one token for `ip`; returns seconds to wait when the bucket is empty. */
function takeIpToken(ip: string, nowMs: number): number {
  let bucket = ipBuckets.get(ip);
  if (!bucket) {
    evictIfFull(ipBuckets);
    bucket = { tokens: LOGIN_IP_BUCKET_CAPACITY, updatedAtMs: nowMs };
    ipBuckets.set(ip, bucket);
  }
  const elapsedSec = Math.max(0, nowMs - bucket.updatedAtMs) / 1000;
  bucket.tokens = Math.min(LOGIN_IP_BUCKET_CAPACITY, bucket.tokens + elapsedSec * LOGIN_IP_BUCKET_REFILL_PER_SEC);
  bucket.updatedAtMs = nowMs;
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return 0;
  }
  return Math.ceil((1 - bucket.tokens) / LOGIN_IP_BUCKET_REFILL_PER_SEC);
}

/** Returns seconds to wait when `username` is in backoff, else 0. */
export function loginRetryAfterSeconds(req: http.IncomingMessage, username: string, nowMs = Date.now()): number {
  const ipWait = takeIpToken(clientIpForRateLimit(req), nowMs);
  if (ipWait > 0) return ipWait;
  const backoff = usernameBackoffs.get(username);
  if (backoff && backoff.blockedUntilMs > nowMs) {
    return Math.ceil((backoff.blockedUntilMs - nowMs) / 1000);
  }
  return 0;
}

export function recordLoginFailure(username: string, nowMs = Date.now()): void {
  if (!username) return;
  let backoff = usernameBackoffs.get(username);
  if (!backoff) {
    evictIfFull(usernameBackoffs);
    backoff = { failures: 0, blockedUntilMs: 0 };
    usernameBackoffs.set(username, backoff);
  }
  backoff.failures += 1;
  if (backoff.failures >= LOGIN_BACKOFF_THRESHOLD) {
    const exponent = backoff.failures - LOGIN_BACKOFF_THRESHOLD;
    const delay = Math.min(LOGIN_BACKOFF_MAX_MS, LOGIN_BACKOFF_BASE_MS * 2 ** exponent);
    backoff.blockedUntilMs = nowMs + delay;
  }
}

export function recordLoginSuccess(username: string): void {
  usernameBackoffs.delete(username);
}

/** @internal test helper */
export function resetLoginRateLimitForTests(): void {
  ipBuckets.clear();
  usernameBackoffs.clear();
}

// ---------------------------------------------------------------------------
// Password hashing for WEBCHAT_BASIC_USERS
// ---------------------------------------------------------------------------

const SCRYPT_KEYLEN = 32;
const SCRYPT_OPTIONS: crypto.ScryptOptions = { N: 16384, r: 8, p: 1 };

/**
 * Hash a basic-login password for WEBCHAT_BASIC_USERS: `scrypt$<salt>$<key>` (base64url).
 * Generate with: `pnpm exec tsx -e "import('./src/webchat-auth.js').then(m => console.log(m.hashBasicPassword(process.argv[1])))" -- '<password>'`
 */
export function hashBasicPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_OPTIONS);
  return `scrypt$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

/** Constant-time check of `password` against a `scrypt$…` or `sha256$…` stored hash. */
export function verifyBasicPasswordHash(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts[0] === 'scrypt' && parts.length === 3) {
    const salt = Buffer.from(parts[1]!, 'base64url');
    const expected = Buffer.from(parts[2]!, 'base64url');
    if (salt.length === 0 || expected.length === 0) return false;
    const actual = crypto.scryptSync(password, salt, expected.length, SCRYPT_OPTIONS);
    return crypto.timingSafeEqual(actual, expected);
  }
  if (parts[0] === 'sha256' && parts.length === 2) {
    const expected = Buffer.from(parts[1]!, 'hex');
    const actual = crypto.createHash('sha256').update(password, 'utf8').digest();
    if (expected.length !== actual.length) return false;
    return crypto.timingSafeEqual(actual, expected);
  }
  return false;
}

function readLimitedBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    req.on('data', (chunk: Buffer | string) => {
      const size = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
      bytes += size;
      if (bytes > maxBytes) {
        req.destroy();
        reject(new Error('body too large'));
        return;
      }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

type JsonResponder = (res: http.ServerResponse, status: number, data: unknown) => void;

interface OidcDiscovery {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  jwks_uri?: string;
}

const discoveryCache = new Map<string, OidcDiscovery>();
const jwksCache = new Map<string, JsonWebKey[]>();

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} from ${url}: ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<unknown>;
}

function base64Url(buf: Buffer): string {
  return buf.toString('base64url');
}

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64Url(crypto.randomBytes(32));
  const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

async function getOidcDiscovery(issuer: string): Promise<OidcDiscovery> {
  const key = issuer.replace(/\/$/, '');
  const cached = discoveryCache.get(key);
  if (cached) return cached;
  const url = `${key}/.well-known/openid-configuration`;
  const doc = (await fetchJson(url)) as OidcDiscovery;
  if (!doc.authorization_endpoint || !doc.token_endpoint) {
    throw new Error(`Invalid OIDC discovery document from ${url}`);
  }
  discoveryCache.set(key, doc);
  return doc;
}

async function fetchJwks(jwksUri: string): Promise<JsonWebKey[]> {
  const cached = jwksCache.get(jwksUri);
  if (cached) return cached;
  const doc = (await fetchJson(jwksUri)) as { keys?: JsonWebKey[] };
  const keys = doc.keys ?? [];
  if (keys.length === 0) throw new Error(`No keys in JWKS from ${jwksUri}`);
  jwksCache.set(jwksUri, keys);
  return keys;
}

async function verifyOidcIdToken(idToken: string, provider: OidcProviderConfig): Promise<Record<string, unknown>> {
  if (provider.protocol !== 'oidc' || !provider.issuer) {
    throw new Error('OIDC issuer required to verify id_token');
  }
  const discovery = await getOidcDiscovery(provider.issuer);
  if (!discovery.jwks_uri) throw new Error('OIDC discovery missing jwks_uri');
  const jwksUri = discovery.jwks_uri;
  const verifyOpts = {
    audience: provider.clientId,
    issuer: provider.issuer,
  };

  const verifyWithKeys = (keys: JsonWebKey[]) => verifyIdToken(idToken, keys, verifyOpts);

  let keys = await fetchJwks(jwksUri);
  try {
    return verifyWithKeys(keys);
  } catch (err) {
    if (!isJwksRetryableVerificationError(err)) throw err;
    jwksCache.delete(jwksUri);
    keys = await fetchJwks(jwksUri);
    return verifyWithKeys(keys);
  }
}

/** @internal test helper */
export async function verifyOidcIdTokenForTests(
  idToken: string,
  provider: OidcProviderConfig,
): Promise<Record<string, unknown>> {
  return verifyOidcIdToken(idToken, provider);
}

/** @internal test helper */
export function resetWebchatAuthCachesForTests(): void {
  discoveryCache.clear();
  jwksCache.clear();
}

function hasAllowlistRules(allowlist: OidcAllowlistConfig): boolean {
  return (
    allowlist.emailDomains.length > 0 ||
    allowlist.emails.length > 0 ||
    allowlist.subs.length > 0 ||
    allowlist.requiredGroup !== null
  );
}

function groupsFromClaims(claims: Record<string, unknown>): string[] {
  const groups = claims.groups;
  if (Array.isArray(groups)) return groups.map(String);
  if (typeof groups === 'string') return groups.split(',').map((g) => g.trim());
  return [];
}

export function checkOidcAllowlist(
  allowlist: OidcAllowlistConfig,
  providerId: string,
  claims: Record<string, unknown>,
): boolean {
  if (!hasAllowlistRules(allowlist)) return true;

  const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : '';
  const emailVerified = claims.email_verified === true || claims.email_verified === 'true';
  const sub = String(claims.sub ?? '');
  const subKey = `${providerId}:${sub}`;

  let allowed = false;
  if (allowlist.emailDomains.length > 0 && email && emailVerified) {
    const domain = email.split('@')[1];
    if (domain && allowlist.emailDomains.includes(domain.toLowerCase())) allowed = true;
  }
  if (allowlist.emails.length > 0 && email && emailVerified && allowlist.emails.includes(email)) {
    allowed = true;
  }
  if (allowlist.subs.length > 0 && allowlist.subs.includes(subKey)) allowed = true;

  if (!allowed) return false;

  if (allowlist.requiredGroup) {
    const groups = groupsFromClaims(claims);
    if (!groups.includes(allowlist.requiredGroup)) return false;
  }

  return true;
}

function identityFromOidcClaims(
  providerId: string,
  claims: Record<string, unknown>,
  fallbackLogin?: string,
): WebchatSessionUser {
  const sub = String(claims.sub ?? '');
  const name =
    (typeof claims.name === 'string' && claims.name.trim()) ||
    (typeof claims.preferred_username === 'string' && claims.preferred_username.trim()) ||
    (fallbackLogin ? `@${fallbackLogin}` : sub);
  const email = typeof claims.email === 'string' ? claims.email : undefined;
  return {
    userId: `web:${providerId}:${sub}`,
    displayName: name,
    authMethod: 'oidc',
    providerId,
    email,
    oidcSub: sub,
  };
}

async function fetchGitHubProfile(accessToken: string): Promise<{ claims: Record<string, unknown>; login: string }> {
  const user = (await fetchJson('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'User-Agent': 'nanoclaw-webchat' },
  })) as Record<string, unknown>;
  const login = String(user.login ?? '');
  let email = typeof user.email === 'string' ? user.email : '';
  let emailVerified = Boolean(email);
  if (!email) {
    const emails = (await fetchJson('https://api.github.com/user/emails', {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'User-Agent': 'nanoclaw-webchat' },
    })) as Array<{ email: string; primary: boolean; verified: boolean }>;
    const primary = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified);
    if (primary) {
      email = primary.email;
      emailVerified = primary.verified;
    }
  }
  return {
    login,
    claims: {
      sub: String(user.id ?? ''),
      name: user.name,
      email,
      email_verified: emailVerified,
    },
  };
}

function constantTimeEqual(a: string, b: string): boolean {
  // Hash to fixed-length digests so timingSafeEqual never early-returns on length
  // (which would leak allowlist/password length information).
  const ha = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hb = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

function isAllowedUsername(allowedUsernames: string[], normalized: string): boolean {
  let allowed = false;
  for (const candidate of allowedUsernames) {
    if (constantTimeEqual(normalized, candidate)) allowed = true;
  }
  return allowed;
}

export function validateBasicLogin(
  config: PublicAuthConfig,
  username: string,
  password: string,
): WebchatSessionUser | null {
  if (!config.basic.enabled) return null;
  const normalized = username.trim().toLowerCase();
  let ok: boolean;
  const userHash = normalized ? config.basic.users?.get(normalized) : undefined;
  if (userHash) {
    // Per-user hash (WEBCHAT_BASIC_USERS) takes precedence over the legacy shared password.
    ok = verifyBasicPasswordHash(password, userHash);
  } else {
    // Legacy shared password + allowlist. Run both comparisons unconditionally so
    // response timing does not reveal whether the username was in the allowlist.
    const usernameAllowed = !!normalized && isAllowedUsername(config.basic.allowedUsernames, normalized);
    const passwordOk = !!config.basic.password && constantTimeEqual(password, config.basic.password);
    ok = usernameAllowed && passwordOk;
  }
  if (!ok) return null;
  const displayName = config.basic.displayNames.get(normalized) ?? username.trim();
  return {
    userId: `web:basic:${normalized}`,
    displayName,
    authMethod: 'basic',
  };
}

export function buildAuthConfigResponse(config: PublicAuthConfig): AuthConfigResponse {
  return {
    basic: { enabled: config.basic.enabled },
    providers: config.oidcEnabled
      ? config.providers.map((p) => ({ id: p.id, label: p.label || `Login with ${p.id}` }))
      : [],
  };
}

/** Resolve the browser session (including its id) from the signed session cookie. */
export function resolveSessionRecord(config: PublicAuthConfig, req: http.IncomingMessage): ResolvedWebSession | null {
  const raw = parseCookieHeader(req.headers.cookie, WEBCHAT_SESSION_COOKIE);
  const sessionId = parseSessionCookie(raw, config.sessionSecret);
  if (!sessionId) return null;
  const session = getSession(sessionId);
  if (!session) return null;
  return { sessionId: session.id, userId: session.userId, displayName: session.displayName };
}

export function resolveSessionUser(config: PublicAuthConfig, req: http.IncomingMessage): ResolvedWebUser | null {
  const session = resolveSessionRecord(config, req);
  if (!session) return null;
  return { userId: session.userId, displayName: session.displayName };
}

function appendSetCookie(res: http.ServerResponse, value: string): void {
  const existing = res.getHeader('Set-Cookie');
  const list = existing === undefined ? [] : Array.isArray(existing) ? existing.map(String) : [String(existing)];
  res.setHeader('Set-Cookie', [...list, value]);
}

function writeSession(res: http.ServerResponse, config: PublicAuthConfig, user: WebchatSessionUser): void {
  const record = createSession(user, config.sessionTtlSeconds);
  const signed = signSessionCookie(record.id, config.sessionSecret);
  appendSetCookie(
    res,
    sessionCookieHeader(signed, { secure: config.secureCookies, maxAgeSeconds: config.sessionTtlSeconds }),
  );
}

function redirect(res: http.ServerResponse, location: string): void {
  res.writeHead(302, { Location: location });
  res.end();
}

import { normalizeWebchatPublicPath } from './webchat-public-path.js';

/** Normalize public path prefix for home redirects and Back links (empty → `/`). */
function webchatHomePath(publicPath?: string): string {
  const normalized = normalizeWebchatPublicPath(publicPath);
  return normalized ? `${normalized}/` : '/';
}

function htmlPage(res: http.ServerResponse, status: number, title: string, body: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`);
}

async function startOidcLogin(
  res: http.ServerResponse,
  config: PublicAuthConfig,
  provider: OidcProviderConfig,
): Promise<void> {
  const { verifier, challenge } = generatePkce();
  const state = base64Url(crypto.randomBytes(24));
  // Bind the state to this browser: the callback must present the cookie whose hash we store.
  const nonce = base64Url(crypto.randomBytes(24));
  saveOAuthState(state, provider.id, verifier, hashOAuthNonce(nonce));
  res.setHeader('Set-Cookie', oauthNonceCookieHeader(nonce, config.secureCookies));

  let authorizeUrl: URL;
  if (provider.protocol === 'oidc') {
    const discovery = await getOidcDiscovery(provider.issuer!);
    authorizeUrl = new URL(discovery.authorization_endpoint);
  } else {
    authorizeUrl = new URL(provider.authorizationUrl!);
  }

  authorizeUrl.searchParams.set('client_id', provider.clientId);
  authorizeUrl.searchParams.set('redirect_uri', config.redirectUri);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('scope', provider.scopes);
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('code_challenge', challenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');

  redirect(res, authorizeUrl.toString());
}

async function exchangeCode(
  config: PublicAuthConfig,
  provider: OidcProviderConfig,
  code: string,
  codeVerifier: string,
): Promise<WebchatSessionUser> {
  let tokenUrl: string;
  if (provider.protocol === 'oidc') {
    const discovery = await getOidcDiscovery(provider.issuer!);
    tokenUrl = discovery.token_endpoint;
  } else {
    tokenUrl = provider.tokenUrl!;
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirectUri,
    client_id: provider.clientId,
    client_secret: provider.clientSecret,
    code_verifier: codeVerifier,
  });

  const tokenRes = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
  });
  if (!tokenRes.ok) {
    const text = await tokenRes.text().catch(() => '');
    throw new Error(`Token exchange failed: ${text.slice(0, 200)}`);
  }
  const tokens = (await tokenRes.json()) as Record<string, unknown>;

  if (provider.protocol === 'oauth' && provider.id === 'github') {
    const accessToken = String(tokens.access_token ?? '');
    const { claims, login } = await fetchGitHubProfile(accessToken);
    if (!checkOidcAllowlist(config.allowlist, provider.id, claims)) {
      throw new AllowlistError();
    }
    return identityFromOidcClaims(provider.id, claims, login);
  }

  const idToken = typeof tokens.id_token === 'string' ? tokens.id_token : null;
  if (!idToken) throw new Error('Missing id_token');
  const claims = await verifyOidcIdToken(idToken, provider);
  if (!checkOidcAllowlist(config.allowlist, provider.id, claims)) {
    throw new AllowlistError();
  }
  return identityFromOidcClaims(provider.id, claims);
}

/** The callback must carry the nonce cookie set when the login started (same browser). */
function oauthNonceMatches(req: http.IncomingMessage, expectedHash: string | null): boolean {
  if (!expectedHash) return false;
  const nonce = parseCookieHeader(req.headers.cookie, WEBCHAT_OAUTH_NONCE_COOKIE);
  if (!nonce) return false;
  return constantTimeEqual(hashOAuthNonce(nonce), expectedHash);
}

export class AllowlistError extends Error {
  constructor() {
    super('Access denied');
    this.name = 'AllowlistError';
  }
}

export async function handlePublicAuthRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  config: PublicAuthConfig,
  json: JsonResponder,
  onLogin: (user: WebchatSessionUser) => void | Promise<void>,
  /** Public path prefix (e.g. `/webchat`) for post-login redirect under a stripPrefix mount. */
  publicPath?: string,
): Promise<boolean> {
  if (url.pathname === '/api/auth/config' && req.method === 'GET') {
    json(res, 200, buildAuthConfigResponse(config));
    return true;
  }

  if (url.pathname === '/api/auth/me' && req.method === 'GET') {
    const user = resolveSessionUser(config, req);
    if (!user) {
      json(res, 401, { error: 'Unauthorized' });
      return true;
    }
    json(res, 200, user);
    return true;
  }

  if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
    const raw = parseCookieHeader(req.headers.cookie, WEBCHAT_SESSION_COOKIE);
    const sessionId = parseSessionCookie(raw, config.sessionSecret);
    if (sessionId) deleteSession(sessionId);
    res.setHeader('Set-Cookie', clearSessionCookieHeader(config.secureCookies));
    json(res, 200, { ok: true });
    return true;
  }

  if (url.pathname === '/api/auth/login/basic' && req.method === 'POST') {
    let body: string;
    try {
      body = await readLimitedBody(req, MAX_LOGIN_BODY_BYTES);
    } catch {
      json(res, 413, { error: 'payload too large' });
      return true;
    }
    let parsed: { username?: string; password?: string };
    try {
      parsed = JSON.parse(body) as { username?: string; password?: string };
    } catch {
      json(res, 400, { error: 'Invalid JSON' });
      return true;
    }
    const username = (parsed.username ?? '').trim().toLowerCase();
    const retryAfter = loginRetryAfterSeconds(req, username);
    if (retryAfter > 0) {
      res.setHeader('Retry-After', String(retryAfter));
      json(res, 429, { error: 'Too many login attempts', retryAfterSeconds: retryAfter });
      return true;
    }
    const user = validateBasicLogin(config, parsed.username ?? '', parsed.password ?? '');
    if (!user) {
      recordLoginFailure(username);
      json(res, 401, { error: 'Invalid username or password' });
      return true;
    }
    recordLoginSuccess(username);
    // Wire before Set-Cookie so a wiring/db failure cannot leave a usable session cookie.
    try {
      await onLogin(user);
    } catch (err) {
      log.error('Webchat basic login onLogin failed', { err, userId: user.userId });
      json(res, 500, { error: 'Login failed' });
      return true;
    }
    writeSession(res, config, user);
    json(res, 200, { ok: true, user: { id: user.userId, displayName: user.displayName } });
    return true;
  }

  if (url.pathname === '/api/auth/login' && req.method === 'GET') {
    if (!config.oidcEnabled) {
      json(res, 404, { error: 'Not found' });
      return true;
    }
    const providerId = url.searchParams.get('provider') ?? '';
    const provider = config.providers.find((p) => p.id === providerId);
    if (!provider) {
      json(res, 400, { error: 'Unknown provider' });
      return true;
    }
    await startOidcLogin(res, config, provider);
    return true;
  }

  if (url.pathname === '/api/auth/callback' && req.method === 'GET') {
    if (!config.oidcEnabled) {
      json(res, 404, { error: 'Not found' });
      return true;
    }
    const home = webchatHomePath(publicPath);
    const backLink = `<p><a href="${home}">Back</a></p>`;
    const err = url.searchParams.get('error');
    if (err) {
      htmlPage(res, 403, 'Access denied', `<h1>Login cancelled</h1>${backLink}`);
      return true;
    }
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !state) {
      htmlPage(res, 400, 'Bad request', '<h1>Invalid callback</h1>');
      return true;
    }
    const oauthState = consumeOAuthState(state);
    if (!oauthState) {
      htmlPage(res, 400, 'Bad request', '<h1>Invalid or expired login state</h1>');
      return true;
    }
    res.setHeader('Set-Cookie', clearOAuthNonceCookieHeader(config.secureCookies));
    if (!oauthNonceMatches(req, oauthState.nonceHash)) {
      htmlPage(res, 400, 'Bad request', '<h1>Login state does not belong to this browser</h1>');
      return true;
    }
    const provider = config.providers.find((p) => p.id === oauthState.providerId);
    if (!provider) {
      htmlPage(res, 400, 'Bad request', '<h1>Unknown provider</h1>');
      return true;
    }
    try {
      const user = await exchangeCode(config, provider, code, oauthState.codeVerifier);
      // Wire before Set-Cookie so a wiring/db failure cannot leave a usable session cookie.
      await onLogin(user);
      writeSession(res, config, user);
      redirect(res, home);
    } catch (e) {
      if (e instanceof AllowlistError) {
        htmlPage(
          res,
          403,
          'Access denied',
          `<h1>Access denied</h1><p>Your account is not authorized for this webchat.</p>${backLink}`,
        );
        return true;
      }
      log.error('Webchat OIDC login failed', { err: e });
      htmlPage(res, 500, 'Login failed', `<h1>Login failed</h1>${backLink}`);
    }
    return true;
  }

  return false;
}

export function isPublicAuthPath(pathname: string): boolean {
  return pathname.startsWith('/api/auth/');
}

export function isPublicAuthExemptPath(pathname: string): boolean {
  return pathname === '/api/auth/config' || pathname === '/api/auth/login' || pathname === '/api/auth/callback';
}
