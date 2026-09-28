import crypto from 'crypto';
import fs from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-web-auth-test' };
});

import { authConfigForTests } from './webchat-auth-config.js';
import {
  checkOidcAllowlist,
  handlePublicAuthRequest,
  hashBasicPassword,
  LOGIN_BACKOFF_THRESHOLD,
  LOGIN_IP_BUCKET_CAPACITY,
  resetLoginRateLimitForTests,
  resetWebchatAuthCachesForTests,
  validateBasicLogin,
  verifyBasicPasswordHash,
  verifyOidcIdTokenForTests,
} from './webchat-auth.js';
import {
  createSession,
  getSession,
  hashOAuthNonce,
  parseSessionCookie,
  resetWebchatAuthSchemaForTests,
  saveOAuthState,
  signSessionCookie,
  WEBCHAT_OAUTH_NONCE_COOKIE,
} from './webchat-auth-sessions.js';
import type { IncomingMessage, ServerResponse } from 'http';

const TEST_DATA = '/tmp/nanoclaw-web-auth-test';

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function signRs256Jwt(payload: Record<string, unknown>, privateKey: crypto.KeyObject, kid = 'test-key'): string {
  const header = { alg: 'RS256', typ: 'JWT', kid };
  const encodedHeader = base64UrlJson(header);
  const encodedPayload = base64UrlJson(payload);
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), privateKey);
  return `${signingInput}.${signature.toString('base64url')}`;
}

function rsaJwkFromPublicKey(publicKey: crypto.KeyObject, kid: string) {
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  return { ...jwk, kid, use: 'sig', alg: 'RS256' };
}

describe('webchat-auth', () => {
  beforeEach(() => {
    resetWebchatAuthCachesForTests();
    resetLoginRateLimitForTests();
    resetWebchatAuthSchemaForTests();
    if (fs.existsSync(TEST_DATA)) fs.rmSync(TEST_DATA, { recursive: true, force: true });
    fs.mkdirSync(TEST_DATA, { recursive: true });
  });

  it('validates basic login against allowlist and password', () => {
    const cfg = authConfigForTests({
      mode: 'public',
      public: {
        sessionSecret: 'secret',
        sessionTtlSeconds: 3600,
        redirectUri: 'http://localhost/cb',
        oidcEnabled: false,
        providers: [],
        allowlist: { emailDomains: [], emails: [], subs: [], requiredGroup: null },
        basic: {
          enabled: true,
          password: 'hunter2',
          allowedUsernames: ['alice'],
          displayNames: new Map([['alice', 'Alice']]),
        },
        secureCookies: false,
      },
    }).public!;

    expect(validateBasicLogin(cfg, 'alice', 'hunter2')?.displayName).toBe('Alice');
    expect(validateBasicLogin(cfg, 'bob', 'hunter2')).toBeNull();
    expect(validateBasicLogin(cfg, 'alice', 'wrong')).toBeNull();
    expect(validateBasicLogin(cfg, 'alic', 'hunter2')).toBeNull();
  });

  it('validates per-user password hashes from WEBCHAT_BASIC_USERS and keeps the legacy password working', () => {
    const aliceHash = hashBasicPassword('alice-pw');
    expect(aliceHash).toMatch(/^scrypt\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
    expect(verifyBasicPasswordHash('alice-pw', aliceHash)).toBe(true);
    expect(verifyBasicPasswordHash('wrong', aliceHash)).toBe(false);
    const sha = `sha256$${crypto.createHash('sha256').update('carol-pw').digest('hex')}`;
    expect(verifyBasicPasswordHash('carol-pw', sha)).toBe(true);
    expect(verifyBasicPasswordHash('x', 'bogus')).toBe(false);

    const cfg = authConfigForTests({
      mode: 'public',
      public: {
        sessionSecret: 'secret',
        sessionTtlSeconds: 3600,
        redirectUri: 'http://localhost/cb',
        oidcEnabled: false,
        providers: [],
        allowlist: { emailDomains: [], emails: [], subs: [], requiredGroup: null },
        basic: {
          enabled: true,
          password: 'legacy-pw',
          allowedUsernames: ['bob'],
          displayNames: new Map([['alice', 'Alice']]),
          users: new Map([
            ['alice', aliceHash],
            ['carol', sha],
          ]),
        },
        secureCookies: false,
      },
    }).public!;

    expect(validateBasicLogin(cfg, 'Alice', 'alice-pw')?.displayName).toBe('Alice');
    expect(validateBasicLogin(cfg, 'alice', 'legacy-pw')).toBeNull();
    expect(validateBasicLogin(cfg, 'carol', 'carol-pw')?.userId).toBe('web:basic:carol');
    // Legacy shared password still works for allowlisted usernames without a hash.
    expect(validateBasicLogin(cfg, 'bob', 'legacy-pw')?.userId).toBe('web:basic:bob');
    expect(validateBasicLogin(cfg, 'bob', 'alice-pw')).toBeNull();
  });

  it('rate limits basic login by IP bucket and per-username backoff', async () => {
    const cfg = authConfigForTests({
      mode: 'public',
      public: {
        sessionSecret: 'secret',
        sessionTtlSeconds: 3600,
        redirectUri: 'http://localhost/cb',
        oidcEnabled: false,
        providers: [],
        allowlist: { emailDomains: [], emails: [], subs: [], requiredGroup: null },
        basic: { enabled: true, password: 'hunter2', allowedUsernames: ['alice'], displayNames: new Map() },
        secureCookies: false,
      },
    }).public!;

    async function attempt(ip: string, username: string, password: string): Promise<number> {
      const { Readable } = await import('stream');
      const body = Readable.from([Buffer.from(JSON.stringify({ username, password }))]) as unknown as IncomingMessage;
      Object.assign(body, {
        method: 'POST',
        headers: { 'x-real-ip': ip },
        socket: { remoteAddress: '127.0.0.1' },
      });
      let status = 0;
      const json = (_res: ServerResponse, code: number) => {
        status = code;
      };
      const res = { setHeader() {}, getHeader() {}, writeHead() {}, end() {} } as unknown as ServerResponse;
      await handlePublicAuthRequest(body, res, new URL('http://localhost/api/auth/login/basic'), cfg, json, () => {});
      return status;
    }

    // Per-username backoff: after LOGIN_BACKOFF_THRESHOLD failures the next attempt is 429
    // even with the right password and from a different IP.
    for (let i = 0; i < LOGIN_BACKOFF_THRESHOLD; i++) {
      expect(await attempt(`10.0.0.${i}`, 'alice', 'wrong')).toBe(401);
    }
    expect(await attempt('10.0.0.99', 'alice', 'hunter2')).toBe(429);

    // IP bucket: one IP burning through its burst capacity gets 429 regardless of username.
    for (let i = 0; i < LOGIN_IP_BUCKET_CAPACITY; i++) {
      expect(await attempt('10.9.9.9', `user${i}`, 'wrong')).toBe(401);
    }
    expect(await attempt('10.9.9.9', 'someone-else', 'wrong')).toBe(429);
  });

  it('matches allowed usernames with constant-time comparison across the list', () => {
    const cfg = authConfigForTests({
      mode: 'public',
      public: {
        sessionSecret: 'secret',
        sessionTtlSeconds: 3600,
        redirectUri: 'http://localhost/cb',
        oidcEnabled: false,
        providers: [],
        allowlist: { emailDomains: [], emails: [], subs: [], requiredGroup: null },
        basic: {
          enabled: true,
          password: 'hunter2',
          allowedUsernames: ['bob', 'alice'],
          displayNames: new Map([
            ['alice', 'Alice'],
            ['bob', 'Bob'],
          ]),
        },
        secureCookies: false,
      },
    }).public!;

    expect(validateBasicLogin(cfg, 'alice', 'hunter2')?.displayName).toBe('Alice');
    expect(validateBasicLogin(cfg, 'bob', 'hunter2')?.displayName).toBe('Bob');
  });

  it('refetches JWKS after signature failure (key rotation)', async () => {
    const issuer = 'https://issuer.example';
    const jwksUri = `${issuer}/jwks`;
    const staleKeys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const currentKeys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const staleJwk = rsaJwkFromPublicKey(staleKeys.publicKey, 'stale');
    const currentJwk = rsaJwkFromPublicKey(currentKeys.publicKey, 'current');

    const now = Math.floor(Date.now() / 1000);
    const idToken = signRs256Jwt(
      { iss: issuer, aud: 'client-id', sub: 'user-1', exp: now + 3600 },
      currentKeys.privateKey,
      'current',
    );

    let jwksFetchCount = 0;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === `${issuer}/.well-known/openid-configuration`) {
        return new Response(
          JSON.stringify({
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            jwks_uri: jwksUri,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url === jwksUri) {
        jwksFetchCount += 1;
        const keys = jwksFetchCount === 1 ? [staleJwk] : [currentJwk];
        return new Response(JSON.stringify({ keys }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    });

    try {
      const claims = await verifyOidcIdTokenForTests(idToken, {
        id: 'test',
        label: 'Test',
        protocol: 'oidc',
        issuer,
        clientId: 'client-id',
        clientSecret: 'secret',
        scopes: 'openid profile email',
      });

      expect(claims.sub).toBe('user-1');
      expect(jwksFetchCount).toBe(2);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('creates and validates signed session cookies', () => {
    const record = createSession({ userId: 'web:basic:alice', displayName: 'Alice', authMethod: 'basic' }, 3600);
    const signed = signSessionCookie(record.id, 'session-secret');
    const parsed = parseSessionCookie(signed, 'session-secret');
    expect(parsed).toBe(record.id);
    expect(getSession(record.id)?.userId).toBe('web:basic:alice');
  });

  it('checks oidc allowlist by email domain', () => {
    const allowlist = {
      emailDomains: ['company.com'],
      emails: [],
      subs: [],
      requiredGroup: null,
    };
    expect(
      checkOidcAllowlist(allowlist, 'google', {
        sub: '1',
        email: 'alice@company.com',
        email_verified: true,
      }),
    ).toBe(true);
    expect(
      checkOidcAllowlist(allowlist, 'google', {
        sub: '2',
        email: 'bob@other.com',
        email_verified: true,
      }),
    ).toBe(false);
  });

  it('OIDC callback redirects to WEBCHAT_PUBLIC_PATH home after login', async () => {
    const cfg = authConfigForTests({
      mode: 'public',
      public: {
        sessionSecret: 'secret',
        sessionTtlSeconds: 3600,
        redirectUri: 'http://localhost/api/auth/callback',
        oidcEnabled: true,
        providers: [
          {
            id: 'github',
            label: 'GitHub',
            protocol: 'oauth',
            authorizationUrl: 'https://github.com/login/oauth/authorize',
            tokenUrl: 'https://github.com/login/oauth/access_token',
            clientId: 'client-id',
            clientSecret: 'client-secret',
            scopes: 'read:user user:email',
          },
        ],
        allowlist: {
          emailDomains: [],
          emails: ['alice@example.com'],
          subs: [],
          requiredGroup: null,
        },
        basic: {
          enabled: false,
          password: '',
          allowedUsernames: [],
          displayNames: new Map(),
        },
        secureCookies: false,
      },
    }).public!;

    const nonce = 'browser-nonce';
    saveOAuthState('test-state', 'github', 'verifier', hashOAuthNonce(nonce));

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === 'https://github.com/login/oauth/access_token') {
        return new Response(JSON.stringify({ access_token: 'gh-token' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url === 'https://api.github.com/user') {
        return new Response(JSON.stringify({ id: 42, login: 'alice', email: 'alice@example.com', name: 'Alice' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    });

    const headers: Record<string, string | number | string[]> = {};
    let statusCode = 0;
    const res = {
      writeHead(status: number, h?: Record<string, string | number | string[]>) {
        statusCode = status;
        if (h) Object.assign(headers, h);
        return res;
      },
      setHeader(name: string, value: string | number | readonly string[]) {
        headers[name] = value as string;
      },
      getHeader(name: string) {
        return headers[name];
      },
      end() {},
    } as unknown as ServerResponse;

    const req = {
      method: 'GET',
      headers: { cookie: `${WEBCHAT_OAUTH_NONCE_COOKIE}=${nonce}` },
    } as IncomingMessage;
    const url = new URL('http://localhost/api/auth/callback?code=abc&state=test-state');

    try {
      const handled = await handlePublicAuthRequest(
        req,
        res,
        url,
        cfg,
        () => {},
        () => {},
        '/webchat',
      );
      expect(handled).toBe(true);
      expect(statusCode).toBe(302);
      expect(headers.Location).toBe('/webchat/');

      saveOAuthState('test-state-root', 'github', 'verifier', hashOAuthNonce(nonce));
      statusCode = 0;
      delete headers.Location;
      const handledRoot = await handlePublicAuthRequest(
        req,
        res,
        new URL('http://localhost/api/auth/callback?code=abc&state=test-state-root'),
        cfg,
        () => {},
        () => {},
      );
      expect(handledRoot).toBe(true);
      expect(statusCode).toBe(302);
      expect(headers.Location).toBe('/');

      let htmlBody = '';
      const htmlRes = {
        writeHead(status: number) {
          statusCode = status;
          return htmlRes;
        },
        setHeader() {},
        end(chunk?: string) {
          htmlBody = chunk ?? '';
        },
      } as unknown as ServerResponse;
      statusCode = 0;
      const cancelled = await handlePublicAuthRequest(
        req,
        htmlRes,
        new URL('http://localhost/api/auth/callback?error=access_denied'),
        cfg,
        () => {},
        () => {},
        '/webchat',
      );
      expect(cancelled).toBe(true);
      expect(statusCode).toBe(403);
      expect(htmlBody).toContain('href="/webchat/"');

      // State nonce bound to another browser (missing / different cookie) is rejected.
      saveOAuthState('test-state-other', 'github', 'verifier', hashOAuthNonce('other-browser'));
      statusCode = 0;
      const mismatched = await handlePublicAuthRequest(
        req,
        htmlRes,
        new URL('http://localhost/api/auth/callback?code=abc&state=test-state-other'),
        cfg,
        () => {},
        () => {},
      );
      expect(mismatched).toBe(true);
      expect(statusCode).toBe(400);
      expect(htmlBody).toContain('does not belong to this browser');

      saveOAuthState('test-state-nocookie', 'github', 'verifier', hashOAuthNonce(nonce));
      statusCode = 0;
      const noCookie = await handlePublicAuthRequest(
        { method: 'GET', headers: {} } as IncomingMessage,
        htmlRes,
        new URL('http://localhost/api/auth/callback?code=abc&state=test-state-nocookie'),
        cfg,
        () => {},
        () => {},
      );
      expect(noCookie).toBe(true);
      expect(statusCode).toBe(400);
    } finally {
      fetchMock.mockRestore();
    }
  });
});
