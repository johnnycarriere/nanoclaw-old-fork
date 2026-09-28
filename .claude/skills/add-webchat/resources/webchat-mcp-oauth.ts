/**
 * MCP OAuth authorization server backend: client registration, auth codes, JWT access tokens.
 *
 * Tokens are HS256 JWTs with explicit typ/alg/iss/aud validation (defence-in-depth against
 * alg-confusion across the shared WEBCHAT_SESSION_SECRET used for browser sessions).
 */
import crypto from 'crypto';
import http from 'http';

import type { PublicAuthConfig } from './webchat-auth-config.js';
import { resolveSessionRecord } from './webchat-auth.js';
import { ensureWebchatAuthSchema, getAuthDbInternal } from './webchat-auth-sessions.js';

/** Default MCP access-token lifetime (24h). Override with WEBCHAT_MCP_TOKEN_TTL_SECONDS. */
export const MCP_ACCESS_TOKEN_TTL_SECONDS = 86_400;
export const MCP_DEFAULT_SCOPE = 'mcp:tools';
/** Purge unused dynamic clients older than this (30 days). */
export const MCP_OAUTH_CLIENT_TTL_SECONDS = 30 * 24 * 60 * 60;
export const MCP_JWT_TYP = 'MCP+JWT';
export const MCP_JWT_ALG = 'HS256';
/** Same-origin consent interstitial served by the web adapter (outside the MCP SDK router). */
export const MCP_CONSENT_PATH = '/mcp/consent';
/** Pending consent requests expire after this (ms). */
export const MCP_CONSENT_TTL_MS = 10 * 60 * 1000;

export interface McpAccessTokenUser {
  userId: string;
  displayName: string;
  clientId: string;
  scopes: string[];
  resource?: string;
  /** Unix seconds — required by MCP SDK requireBearerAuth. */
  expiresAt: number;
}

export interface McpOAuthClientRecord {
  client_id: string;
  client_secret?: string;
  client_id_issued_at?: number;
  client_secret_expires_at?: number;
  redirect_uris: string[];
  client_name?: string;
  token_endpoint_auth_method?: string;
  grant_types?: string[];
  response_types?: string[];
  scope?: string;
}

export interface McpAuthorizationParams {
  state?: string;
  scopes: string[];
  codeChallenge: string;
  redirectUri: string;
  resource?: string;
}

export interface McpOAuthTokens {
  access_token: string;
  token_type: 'bearer';
  expires_in: number;
  scope: string;
}

export interface McpExchangeOptions {
  codeVerifier?: string;
  redirectUri?: string;
}

export interface WebchatMcpOAuthConfig {
  publicAuth: PublicAuthConfig;
  publicBaseUrl: string;
  resourceServerUrl: string;
  tokenTtlSeconds?: number;
  /** Expose `clientsStore.registerClient` (OAuth dynamic client registration). Default false. */
  allowDynamicClientRegistration?: boolean;
  /** Path of the consent page (prefixed with the public path when mounted under one). */
  consentPath?: string;
}

/** A pending authorization awaiting the user's explicit consent on the interstitial. */
export interface McpPendingConsent {
  id: string;
  clientId: string;
  clientName?: string;
  userId: string;
  displayName: string;
  redirectUri: string;
  scopes: string[];
  resource: string;
  state?: string;
  /** CSRF token bound to this consent + the browser session; embed in the consent form. */
  csrfToken: string;
}

interface JwtHeader {
  alg: string;
  typ?: string;
}

interface JwtPayload {
  sub: string;
  name: string;
  aud: string;
  iss: string;
  scope: string;
  client_id: string;
  exp: number;
  iat: number;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function signJwt(payload: JwtPayload, secret: string): string {
  const header = base64UrlJson({ alg: MCP_JWT_ALG, typ: MCP_JWT_TYP });
  const body = base64UrlJson(payload);
  const sig = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

function verifyJwt(token: string, secret: string, iss: string, aud: string): JwtPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sig] = parts;
  if (!headerB64 || !payloadB64 || !sig) return null;

  const expected = crypto.createHmac('sha256', secret).update(`${headerB64}.${payloadB64}`).digest('base64url');
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;

  try {
    const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8')) as JwtHeader;
    // Reject alg/typ confusion with browser session cookies that share WEBCHAT_SESSION_SECRET.
    if (header.alg !== MCP_JWT_ALG) return null;
    if (header.typ !== MCP_JWT_TYP) return null;

    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as JwtPayload;
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== 'number' || payload.exp <= now) return null;
    if (typeof payload.iat !== 'number' || payload.iat > now + 60) return null;
    if (payload.iss !== iss) return null;
    if (payload.aud !== aud) return null;
    if (typeof payload.sub !== 'string' || typeof payload.name !== 'string') return null;
    if (typeof payload.client_id !== 'string') return null;
    return payload;
  } catch {
    return null;
  }
}

function verifyPkceS256(codeVerifier: string, codeChallenge: string): boolean {
  const computed = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  if (computed.length !== codeChallenge.length) return false;
  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(codeChallenge));
}

/**
 * IPv6 loopback hostnames vary by runtime: Node's WHATWG URL currently keeps
 * brackets (`[::1]`), while some environments omit them (`::1`). Accept both.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * RFC 8252 §7.3 — loopback redirect URIs of the same host may differ by port.
 * Identical URIs also match. Cross-host aliases (localhost vs 127.0.0.1) are
 * intentionally NOT accepted here — that belongs only on the resource (aud) check.
 * (Same same-host/any-port rule as the MCP SDK authorize handler.)
 */
export function mcpRedirectUriMatches(requested: string, registered: string): boolean {
  if (requested === registered) return true;
  let req: URL;
  let reg: URL;
  try {
    req = new URL(requested);
    reg = new URL(registered);
  } catch {
    return false;
  }
  if (!LOOPBACK_HOSTS.has(req.hostname) || !LOOPBACK_HOSTS.has(reg.hostname)) return false;
  return (
    req.protocol === reg.protocol &&
    req.hostname === reg.hostname &&
    req.pathname === reg.pathname &&
    req.search === reg.search
  );
}

/** Treat localhost / 127.0.0.1 / ::1 as the same resource host for local MCP OAuth. */
export function mcpResourceUrlMatches(requested: string, expected: string): boolean {
  if (requested === expected) return true;
  let req: URL;
  let exp: URL;
  try {
    req = new URL(requested);
    exp = new URL(expected);
  } catch {
    return false;
  }
  if (
    req.protocol !== exp.protocol ||
    req.port !== exp.port ||
    req.pathname !== exp.pathname ||
    req.search !== exp.search
  ) {
    return false;
  }
  if (req.hostname === exp.hostname) return true;
  return LOOPBACK_HOSTS.has(req.hostname) && LOOPBACK_HOSTS.has(exp.hostname);
}

function purgeExpiredMcpCodes(): void {
  const db = getAuthDbInternal();
  const cutoff = Date.now() - 10 * 60 * 1000;
  db.prepare('DELETE FROM web_mcp_oauth_codes WHERE created_at_ms < ?').run(cutoff);
  db.prepare('DELETE FROM web_mcp_oauth_consents WHERE created_at_ms < ?').run(Date.now() - MCP_CONSENT_TTL_MS);
}

/** CSRF token = HMAC(sessionSecret, sessionId:consentId:nonce) — only the owning browser session can approve. */
function consentCsrfToken(secret: string, sessionId: string, consentId: string, nonce: string): string {
  return crypto.createHmac('sha256', secret).update(`${sessionId}:${consentId}:${nonce}`).digest('base64url');
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hb = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

interface ConsentRow {
  id: string;
  client_id: string;
  client_name: string | null;
  session_id: string;
  user_id: string;
  display_name: string;
  code_challenge: string;
  redirect_uri: string;
  scopes_json: string;
  resource: string | null;
  state: string | null;
  csrf_nonce: string;
  created_at_ms: number;
}

function loadConsentRow(id: string): ConsentRow | undefined {
  purgeExpiredMcpCodes();
  const db = getAuthDbInternal();
  return db.prepare('SELECT * FROM web_mcp_oauth_consents WHERE id = ?').get(id) as ConsentRow | undefined;
}

/** Drop unused dynamic clients after MCP_OAUTH_CLIENT_TTL_SECONDS. */
export function purgeStaleMcpOAuthClients(nowSeconds = Math.floor(Date.now() / 1000)): number {
  const db = getAuthDbInternal();
  const cutoff = nowSeconds - MCP_OAUTH_CLIENT_TTL_SECONDS;
  const result = db.prepare('DELETE FROM web_mcp_oauth_clients WHERE client_id_issued_at < ?').run(cutoff);
  return Number(result.changes ?? 0);
}

function rowToClient(row: {
  client_id: string;
  client_secret: string | null;
  client_id_issued_at: number;
  client_secret_expires_at: number | null;
  redirect_uris_json: string;
  client_name: string | null;
  token_endpoint_auth_method: string | null;
  grant_types_json: string | null;
  response_types_json: string | null;
  scope: string | null;
}): McpOAuthClientRecord {
  return {
    client_id: row.client_id,
    client_secret: row.client_secret ?? undefined,
    client_id_issued_at: row.client_id_issued_at,
    client_secret_expires_at: row.client_secret_expires_at ?? undefined,
    redirect_uris: JSON.parse(row.redirect_uris_json) as string[],
    client_name: row.client_name ?? undefined,
    token_endpoint_auth_method: row.token_endpoint_auth_method ?? undefined,
    grant_types: row.grant_types_json ? (JSON.parse(row.grant_types_json) as string[]) : undefined,
    response_types: row.response_types_json ? (JSON.parse(row.response_types_json) as string[]) : undefined,
    scope: row.scope ?? undefined,
  };
}

export function ensureWebchatMcpOAuthSchema(): void {
  ensureWebchatAuthSchema();
}

export function verifyMcpAccessToken(
  token: string,
  config: Pick<WebchatMcpOAuthConfig, 'publicAuth' | 'resourceServerUrl' | 'publicBaseUrl'> & {
    publicBaseUrl?: string;
  },
): McpAccessTokenUser | null {
  const issuer = (config.publicBaseUrl ?? new URL(config.resourceServerUrl).origin).replace(/\/$/, '');
  const payload = verifyJwt(token, config.publicAuth.sessionSecret, issuer, config.resourceServerUrl);
  if (!payload) return null;
  const scopes = payload.scope ? payload.scope.split(' ').filter(Boolean) : [MCP_DEFAULT_SCOPE];
  return {
    userId: payload.sub,
    displayName: payload.name,
    clientId: payload.client_id,
    scopes,
    resource: payload.aud,
    expiresAt: payload.exp,
  };
}

export function createWebchatMcpOAuthBackend(config: WebchatMcpOAuthConfig) {
  ensureWebchatMcpOAuthSchema();
  const tokenTtlSeconds = config.tokenTtlSeconds ?? MCP_ACCESS_TOKEN_TTL_SECONDS;
  const issuer = config.publicBaseUrl.replace(/\/$/, '');

  const allowDcr = config.allowDynamicClientRegistration === true;
  const consentPath = config.consentPath ?? MCP_CONSENT_PATH;

  async function registerClient(
    client: Omit<McpOAuthClientRecord, 'client_id'> & { client_id?: string },
  ): Promise<McpOAuthClientRecord> {
    purgeStaleMcpOAuthClients();
    const db = getAuthDbInternal();
    const clientId = client.client_id ?? crypto.randomUUID();
    const issuedAt = client.client_id_issued_at ?? Math.floor(Date.now() / 1000);
    const record: McpOAuthClientRecord = {
      ...client,
      client_id: clientId,
      client_id_issued_at: issuedAt,
      redirect_uris: client.redirect_uris.map(String),
    };
    db.prepare(
      `INSERT INTO web_mcp_oauth_clients
       (client_id, client_secret, client_id_issued_at, client_secret_expires_at,
        redirect_uris_json, client_name, token_endpoint_auth_method,
        grant_types_json, response_types_json, scope)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      record.client_id,
      record.client_secret ?? null,
      record.client_id_issued_at!,
      record.client_secret_expires_at ?? null,
      JSON.stringify(record.redirect_uris),
      record.client_name ?? null,
      record.token_endpoint_auth_method ?? null,
      record.grant_types ? JSON.stringify(record.grant_types) : null,
      record.response_types ? JSON.stringify(record.response_types) : null,
      record.scope ?? null,
    );
    return record;
  }

  const clientsStore: {
    getClient(clientId: string): Promise<McpOAuthClientRecord | undefined>;
    /** Only present when dynamic client registration is allowed (WEBCHAT_MCP_ALLOW_DCR=true). */
    registerClient?: typeof registerClient;
  } = {
    async getClient(clientId: string): Promise<McpOAuthClientRecord | undefined> {
      purgeStaleMcpOAuthClients();
      const db = getAuthDbInternal();
      const row = db
        .prepare(
          `SELECT client_id, client_secret, client_id_issued_at, client_secret_expires_at,
                  redirect_uris_json, client_name, token_endpoint_auth_method,
                  grant_types_json, response_types_json, scope
           FROM web_mcp_oauth_clients WHERE client_id = ?`,
        )
        .get(clientId) as
        | {
            client_id: string;
            client_secret: string | null;
            client_id_issued_at: number;
            client_secret_expires_at: number | null;
            redirect_uris_json: string;
            client_name: string | null;
            token_endpoint_auth_method: string | null;
            grant_types_json: string | null;
            response_types_json: string | null;
            scope: string | null;
          }
        | undefined;
      return row ? rowToClient(row) : undefined;
    },
    ...(allowDcr ? { registerClient } : {}),
  };

  function issueCode(row: ConsentRow): string {
    const code = crypto.randomBytes(32).toString('hex');
    const db = getAuthDbInternal();
    db.prepare(
      `INSERT INTO web_mcp_oauth_codes
       (code, client_id, user_id, display_name, code_challenge, redirect_uri, scopes_json, resource, state, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      code,
      row.client_id,
      row.user_id,
      row.display_name,
      row.code_challenge,
      row.redirect_uri,
      row.scopes_json,
      row.resource ?? config.resourceServerUrl,
      row.state,
      Date.now(),
    );
    return code;
  }

  function consentFromRow(row: ConsentRow): McpPendingConsent {
    return {
      id: row.id,
      clientId: row.client_id,
      clientName: row.client_name ?? undefined,
      userId: row.user_id,
      displayName: row.display_name,
      redirectUri: row.redirect_uri,
      scopes: JSON.parse(row.scopes_json) as string[],
      resource: row.resource ?? config.resourceServerUrl,
      state: row.state ?? undefined,
      csrfToken: consentCsrfToken(config.publicAuth.sessionSecret, row.session_id, row.id, row.csrf_nonce),
    };
  }

  return {
    clientsStore,
    config,
    /** Operator/test path: always available regardless of the DCR setting. */
    registerClient,
    allowDynamicClientRegistration: allowDcr,
    consentPath,

    buildAuthorizeReturnUrl(req: http.IncomingMessage & { originalUrl?: string | null }): string {
      const path = req.originalUrl ?? req.url ?? '/authorize';
      return new URL(path, `${config.publicBaseUrl}/`).toString();
    },

    /**
     * SDK authorize hook. Never issues a code directly: records a pending consent
     * and redirects to the same-origin consent page, which issues the code only
     * on a CSRF-checked POST from the logged-in browser.
     */
    authorize(
      req: http.IncomingMessage,
      client: McpOAuthClientRecord,
      params: McpAuthorizationParams,
    ): { type: 'redirect'; location: string } {
      const session = resolveSessionRecord(config.publicAuth, req);
      if (!session) {
        const returnTo = this.buildAuthorizeReturnUrl(req);
        return {
          type: 'redirect',
          location: `/?returnTo=${encodeURIComponent(returnTo)}`,
        };
      }

      if (!client.redirect_uris.some((registered) => mcpRedirectUriMatches(params.redirectUri, registered))) {
        throw new Error('Unregistered redirect_uri');
      }

      if (params.resource && !mcpResourceUrlMatches(params.resource, config.resourceServerUrl)) {
        throw new Error('Invalid resource');
      }

      purgeExpiredMcpCodes();
      const consentId = crypto.randomBytes(24).toString('base64url');
      const db = getAuthDbInternal();
      db.prepare(
        `INSERT INTO web_mcp_oauth_consents
         (id, client_id, client_name, session_id, user_id, display_name, code_challenge, redirect_uri,
          scopes_json, resource, state, csrf_nonce, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        consentId,
        client.client_id,
        client.client_name ?? null,
        session.sessionId,
        session.userId,
        session.displayName,
        params.codeChallenge,
        params.redirectUri,
        JSON.stringify(params.scopes.length ? params.scopes : [MCP_DEFAULT_SCOPE]),
        params.resource ?? config.resourceServerUrl,
        params.state ?? null,
        crypto.randomBytes(16).toString('base64url'),
        Date.now(),
      );

      return { type: 'redirect', location: `${consentPath}?id=${encodeURIComponent(consentId)}` };
    },

    /** Load a pending consent for the consent page; null when missing/expired or not this session's. */
    getPendingConsent(req: http.IncomingMessage, consentId: string): McpPendingConsent | null {
      const session = resolveSessionRecord(config.publicAuth, req);
      if (!session) return null;
      const row = loadConsentRow(consentId);
      if (!row || row.session_id !== session.sessionId) return null;
      return consentFromRow(row);
    },

    /**
     * Resolve a consent decision from the consent form POST. Approve issues the
     * authorization code; deny redirects back with `error=access_denied`. Both
     * require the owning browser session and a matching CSRF token.
     */
    decideConsent(
      req: http.IncomingMessage,
      consentId: string,
      csrfToken: string,
      approve: boolean,
    ): { type: 'redirect'; location: string } | { type: 'error'; status: number; message: string } {
      const session = resolveSessionRecord(config.publicAuth, req);
      if (!session) return { type: 'error', status: 401, message: 'Login required' };
      const row = loadConsentRow(consentId);
      if (!row || row.session_id !== session.sessionId) {
        return { type: 'error', status: 400, message: 'Unknown or expired consent request' };
      }
      const expected = consentCsrfToken(config.publicAuth.sessionSecret, session.sessionId, row.id, row.csrf_nonce);
      if (!csrfToken || !timingSafeStringEqual(csrfToken, expected)) {
        return { type: 'error', status: 403, message: 'Invalid CSRF token' };
      }
      const db = getAuthDbInternal();
      db.prepare('DELETE FROM web_mcp_oauth_consents WHERE id = ?').run(row.id);

      const target = new URL(row.redirect_uri);
      if (approve) {
        target.searchParams.set('code', issueCode(row));
      } else {
        target.searchParams.set('error', 'access_denied');
        target.searchParams.set('error_description', 'The user denied the request');
      }
      if (row.state) target.searchParams.set('state', row.state);
      return { type: 'redirect', location: target.toString() };
    },

    async challengeForAuthorizationCode(_client: McpOAuthClientRecord, code: string): Promise<string> {
      purgeExpiredMcpCodes();
      const db = getAuthDbInternal();
      const row = db.prepare(`SELECT code_challenge FROM web_mcp_oauth_codes WHERE code = ?`).get(code) as
        | { code_challenge: string }
        | undefined;
      if (!row) throw new Error('Invalid authorization code');
      return row.code_challenge;
    },

    async exchangeAuthorizationCode(
      client: McpOAuthClientRecord,
      authorizationCode: string,
      resource?: string,
      options?: McpExchangeOptions,
    ): Promise<McpOAuthTokens> {
      purgeExpiredMcpCodes();
      const db = getAuthDbInternal();
      const row = db
        .prepare(
          `SELECT client_id, user_id, display_name, redirect_uri, code_challenge, scopes_json, resource
           FROM web_mcp_oauth_codes WHERE code = ?`,
        )
        .get(authorizationCode) as
        | {
            client_id: string;
            user_id: string;
            display_name: string;
            redirect_uri: string;
            code_challenge: string;
            scopes_json: string;
            resource: string | null;
          }
        | undefined;
      if (!row) throw new Error('Invalid authorization code');
      if (row.client_id !== client.client_id) {
        throw new Error('Authorization code was not issued to this client');
      }
      // OAuth 2.1 §4.1.3 — redirect_uri on the token request must match the authorize request.
      if (options?.redirectUri != null && options.redirectUri !== row.redirect_uri) {
        throw new Error('redirect_uri mismatch');
      }
      // Defence-in-depth: SDK also verifies PKCE via challengeForAuthorizationCode before
      // calling exchange; we re-check S256 when a verifier is provided.
      if (options?.codeVerifier != null) {
        if (!verifyPkceS256(options.codeVerifier, row.code_challenge)) {
          throw new Error('Invalid PKCE code_verifier');
        }
      }
      const expectedResource = resource ?? row.resource ?? config.resourceServerUrl;
      if (!mcpResourceUrlMatches(expectedResource, config.resourceServerUrl)) {
        throw new Error('Invalid resource');
      }
      db.prepare('DELETE FROM web_mcp_oauth_codes WHERE code = ?').run(authorizationCode);

      const scopes = JSON.parse(row.scopes_json) as string[];
      const now = Math.floor(Date.now() / 1000);
      const payload: JwtPayload = {
        sub: row.user_id,
        name: row.display_name,
        aud: config.resourceServerUrl,
        iss: issuer,
        scope: scopes.join(' '),
        client_id: client.client_id,
        iat: now,
        exp: now + tokenTtlSeconds,
      };
      const accessToken = signJwt(payload, config.publicAuth.sessionSecret);
      return {
        access_token: accessToken,
        token_type: 'bearer',
        expires_in: tokenTtlSeconds,
        scope: scopes.join(' '),
      };
    },

    verifyAccessToken(token: string): McpAccessTokenUser | null {
      return verifyMcpAccessToken(token, config);
    },
  };
}

export type WebchatMcpOAuthBackend = ReturnType<typeof createWebchatMcpOAuthBackend>;

/** @internal test helper */
export function resetWebchatMcpOAuthForTests(): void {
  ensureWebchatMcpOAuthSchema();
  const db = getAuthDbInternal();
  db.exec('DELETE FROM web_mcp_oauth_clients; DELETE FROM web_mcp_oauth_codes; DELETE FROM web_mcp_oauth_consents;');
}
