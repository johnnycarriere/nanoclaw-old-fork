import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

import { loadWebAdapterAuthConfig, MIN_SESSION_SECRET_LENGTH } from './webchat-auth-config.js';
import { log } from './log.js';

const ENV_KEYS = [
  'WEBCHAT_ENABLED',
  'WEBCHAT_SECRET',
  'WEBCHAT_AUTH_MODE',
  'WEBCHAT_AUTH_BASIC_ENABLED',
  'WEBCHAT_AUTH_OIDC_ENABLED',
  'WEBCHAT_BASIC_PASSWORD',
  'WEBCHAT_BASIC_USERS',
  'WEBCHAT_BASIC_ALLOWED_USERNAMES',
  'WEBCHAT_BIND_ADDRESS',
  'WEBCHAT_MCP_HTTP_ENABLED',
  'WEBCHAT_MCP_ALLOW_DCR',
  'WEBCHAT_SESSION_SECRET',
  'WEBCHAT_SECURE_COOKIES',
  'WEBCHAT_SESSION_INSECURE_COOKIES',
  'WEBCHAT_PUBLIC_BASE_URL',
  'WEBCHAT_OIDC_REDIRECT_URI',
  'WEBCHAT_OIDC_PROVIDERS',
  'WEBCHAT_OIDC_ALLOWED_EMAIL_DOMAINS',
  'WEBCHAT_OIDC_ALLOWED_EMAILS',
  'WEBCHAT_OIDC_ALLOWED_SUBS',
  'WEBCHAT_OIDC_REQUIRED_GROUP',
  'NODE_ENV',
] as const;

const saved: Record<string, string | undefined> = {};

function setEnv(key: string, value: string | undefined): void {
  if (!(key in saved)) saved[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function publicEnv(): void {
  setEnv('WEBCHAT_ENABLED', 'true');
  setEnv('WEBCHAT_SECRET', 'web-secret');
  setEnv('WEBCHAT_AUTH_MODE', 'public');
  setEnv('WEBCHAT_AUTH_BASIC_ENABLED', 'true');
  setEnv('WEBCHAT_BASIC_PASSWORD', 'test-password');
  setEnv('WEBCHAT_BASIC_ALLOWED_USERNAMES', 'alice');
  setEnv('WEBCHAT_SESSION_SECRET', 'a'.repeat(MIN_SESSION_SECRET_LENGTH));
  setEnv('WEBCHAT_PUBLIC_BASE_URL', 'http://127.0.0.1:3200');
}

describe('loadWebAdapterAuthConfig', () => {
  afterEach(() => {
    for (const key of ENV_KEYS) {
      const prev = saved[key];
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
      delete saved[key];
    }
  });

  it('defaults secureCookies to true in public mode', () => {
    publicEnv();
    delete process.env.WEBCHAT_SECURE_COOKIES;
    delete process.env.WEBCHAT_SESSION_INSECURE_COOKIES;
    delete process.env.NODE_ENV;

    const cfg = loadWebAdapterAuthConfig();
    expect(cfg?.public?.secureCookies).toBe(true);
  });

  it('allows WEBCHAT_SESSION_INSECURE_COOKIES for local dev', () => {
    publicEnv();
    setEnv('WEBCHAT_SESSION_INSECURE_COOKIES', 'true');

    const cfg = loadWebAdapterAuthConfig();
    expect(cfg?.public?.secureCookies).toBe(false);
  });

  it('rejects short WEBCHAT_SESSION_SECRET', () => {
    publicEnv();
    setEnv('WEBCHAT_SESSION_SECRET', 'too-short');

    expect(() => loadWebAdapterAuthConfig()).toThrow(/at least/);
  });

  it('defaults MCP HTTP and dynamic client registration to off in both modes', () => {
    publicEnv();
    let cfg = loadWebAdapterAuthConfig();
    expect(cfg?.mcpHttpEnabled).toBe(false);
    expect(cfg?.mcpAllowDynamicClientRegistration).toBe(false);
    expect(cfg?.publicBaseUrl).toBe('http://127.0.0.1:3200');

    setEnv('WEBCHAT_AUTH_MODE', 'local');
    cfg = loadWebAdapterAuthConfig();
    expect(cfg?.mode).toBe('local');
    expect(cfg?.mcpHttpEnabled).toBe(false);

    setEnv('WEBCHAT_MCP_HTTP_ENABLED', 'true');
    setEnv('WEBCHAT_MCP_ALLOW_DCR', 'true');
    setEnv('WEBCHAT_AUTH_MODE', 'public');
    cfg = loadWebAdapterAuthConfig();
    expect(cfg?.mcpHttpEnabled).toBe(true);
    expect(cfg?.mcpAllowDynamicClientRegistration).toBe(true);
  });

  it('refuses local mode when bound or published beyond loopback', () => {
    publicEnv();
    setEnv('WEBCHAT_AUTH_MODE', 'local');
    setEnv('WEBCHAT_PUBLIC_BASE_URL', 'https://bawdeclaw.bawapps.com');
    expect(() => loadWebAdapterAuthConfig()).toThrow(/WEBCHAT_AUTH_MODE=public/);

    setEnv('WEBCHAT_PUBLIC_BASE_URL', 'http://localhost:3200');
    setEnv('WEBCHAT_BIND_ADDRESS', '0.0.0.0');
    expect(() => loadWebAdapterAuthConfig()).toThrow(/not loopback/);

    setEnv('WEBCHAT_BIND_ADDRESS', '127.0.0.1');
    expect(loadWebAdapterAuthConfig()?.mode).toBe('local');

    // Public mode is the supported way to expose it.
    setEnv('WEBCHAT_AUTH_MODE', 'public');
    setEnv('WEBCHAT_PUBLIC_BASE_URL', 'https://bawdeclaw.bawapps.com');
    setEnv('WEBCHAT_BIND_ADDRESS', '0.0.0.0');
    expect(loadWebAdapterAuthConfig()?.mode).toBe('public');
  });

  it('parses WEBCHAT_BASIC_USERS hashes and keeps the legacy password optional', () => {
    publicEnv();
    setEnv('WEBCHAT_BASIC_PASSWORD', undefined);
    setEnv('WEBCHAT_BASIC_ALLOWED_USERNAMES', undefined);
    setEnv('WEBCHAT_BASIC_USERS', 'Alice:scrypt$c2FsdA$aGFzaA,bob:sha256$' + 'a'.repeat(64));
    const cfg = loadWebAdapterAuthConfig();
    expect(cfg?.public?.basic.users?.get('alice')).toBe('scrypt$c2FsdA$aGFzaA');
    expect(cfg?.public?.basic.users?.get('bob')).toBe('sha256$' + 'a'.repeat(64));
    expect(cfg?.public?.basic.password).toBe('');

    setEnv('WEBCHAT_BASIC_USERS', 'alice:plaintext-password');
    expect(() => loadWebAdapterAuthConfig()).toThrow(/not a supported hash/);

    setEnv('WEBCHAT_BASIC_USERS', undefined);
    expect(() => loadWebAdapterAuthConfig()).toThrow(/WEBCHAT_BASIC_USERS or WEBCHAT_BASIC_PASSWORD/);

    // Legacy: shared password requires the allowlist.
    setEnv('WEBCHAT_BASIC_PASSWORD', 'legacy');
    expect(() => loadWebAdapterAuthConfig()).toThrow(/WEBCHAT_BASIC_ALLOWED_USERNAMES/);
    setEnv('WEBCHAT_BASIC_ALLOWED_USERNAMES', 'alice');
    expect(loadWebAdapterAuthConfig()?.public?.basic.password).toBe('legacy');
  });

  it('warns when public OIDC is enabled with an empty allowlist', () => {
    publicEnv();
    setEnv('WEBCHAT_AUTH_BASIC_ENABLED', undefined);
    setEnv('WEBCHAT_AUTH_OIDC_ENABLED', 'true');
    setEnv('WEBCHAT_OIDC_REDIRECT_URI', 'http://127.0.0.1:3200/api/auth/callback');
    setEnv(
      'WEBCHAT_OIDC_PROVIDERS',
      JSON.stringify([
        {
          id: 'github',
          label: 'GitHub',
          protocol: 'oauth',
          authorizationUrl: 'https://github.com/login/oauth/authorize',
          tokenUrl: 'https://github.com/login/oauth/access_token',
          userInfoUrl: 'https://api.github.com/user',
          clientId: 'id',
          clientSecret: 'secret',
          scopes: 'read:user user:email',
        },
      ]),
    );
    delete process.env.WEBCHAT_OIDC_ALLOWED_EMAIL_DOMAINS;
    delete process.env.WEBCHAT_OIDC_ALLOWED_EMAILS;
    delete process.env.WEBCHAT_OIDC_ALLOWED_SUBS;
    delete process.env.WEBCHAT_OIDC_REQUIRED_GROUP;

    vi.mocked(log.warn).mockClear();
    const cfg = loadWebAdapterAuthConfig();
    expect(cfg?.public?.oidcEnabled).toBe(true);
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining('OIDC allowlist is empty'));
  });
});
