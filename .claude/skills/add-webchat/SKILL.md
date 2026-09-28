---
name: add-webchat
description: Add a local browser web chat channel to NanoClaw. Lobby with @agent patterns, per-agent DMs, and threading. Installs nanoclaw-webchat and a native web channel adapter.
---

# /add-webchat — Web Chat Channel

Adds a localhost browser chat desk wired through NanoClaw's normal router/delivery path.

See also: [QUICKSTART.md](../../QUICKSTART.md) in the npm package for a human-readable install guide.

## Prerequisites

- **Node.js 22 LTS** (matches verify/CI). Node 26+ requires host `better-sqlite3@>=12.10.0`
- **pnpm** and a working NanoClaw fork with **`better-sqlite3`** (native SQLite driver)
- Run **`pnpm exec nanoclaw-webchat verify`** after install — the CLI auto-rebuilds native bindings under your project's Node version (`.nvmrc`)

`nanoclaw-webchat install` scaffolds `.nvmrc` (22) and a pnpm `onlyBuiltDependencies` hint when missing.

## Architecture

```
Browser (nanoclaw-webchat)  ←HTTP/WS→  web.ts adapter  →  router  →  agents
                              webchat-sync.ts  →  DB wirings
```

## Install

NanoClaw does not ship webchat in trunk. This skill copies the adapter from the installed `nanoclaw-webchat` npm package.

### Pre-flight (idempotent)

Skip to **Credentials** if all of these are already in place:

- `src/channels/web.ts` and `src/webchat-store.ts` exist
- `src/channels/index.ts` contains `import './web.js';`
- `src/index.ts` contains `await startWebChat()` before `initChannelAdapters(`
- `nanoclaw-webchat` and `ws` are listed in `package.json`

Otherwise continue. Every step below is safe to re-run.

### 0. Copy this skill (first time only)

If `/add-webchat` is not already in your fork:

```bash
pnpm exec nanoclaw-webchat sync-skill
```

### 1. Install npm packages

```bash
pnpm add nanoclaw-webchat@0.1.0 ws@8.18.3
pnpm add -D @types/ws@8.18.1
```

If the package is not yet on npm, install from a local build:

```bash
pnpm add file:../nanoclaw-webchat
```

`nanoclaw-webchat install` also scaffolds `.nvmrc` (Node 22) and adds `onlyBuiltDependencies[]=better-sqlite3` to `.npmrc` when missing (pnpm rebuilds native bindings on install).

### 2. Copy adapter resources into `src/`

Adapter source lives in `packages/adapter/src` in the monorepo; the npm package ships a synced copy at `skills/add-webchat/resources/`. Copy from either path in your install:

Copy from `node_modules/nanoclaw-webchat/skills/add-webchat/resources/`:

```bash
PKG=node_modules/nanoclaw-webchat/skills/add-webchat/resources
cp "$PKG/web.ts" src/channels/web.ts
cp "$PKG/web.test.ts" src/channels/web.test.ts
cp "$PKG/web-registration.test.ts" src/channels/web-registration.test.ts
cp "$PKG/webchat-sync.ts" src/webchat-sync.ts
cp "$PKG/webchat-sync.test.ts" src/webchat-sync.test.ts
cp "$PKG/webchat-boot.ts" src/webchat-boot.ts
cp "$PKG/webchat-boot.test.ts" src/webchat-boot.test.ts
cp "$PKG/webchat-live.ts" src/webchat-live.ts
cp "$PKG/webchat-live.test.ts" src/webchat-live.test.ts
cp "$PKG/webchat-wiring.test.ts" src/webchat-wiring.test.ts
cp "$PKG/webchat-store.ts" src/webchat-store.ts
cp "$PKG/webchat-store.test.ts" src/webchat-store.test.ts
cp "$PKG/webchat-thread-cleanup.ts" src/webchat-thread-cleanup.ts
cp "$PKG/webchat-routing.ts" src/webchat-routing.ts
cp "$PKG/webchat-routing.test.ts" src/webchat-routing.test.ts
cp "$PKG/webchat-mentions.ts" src/webchat-mentions.ts
cp "$PKG/webchat-mentions.test.ts" src/webchat-mentions.test.ts
```

Or run the CLI (same result):

```bash
pnpm exec nanoclaw-webchat install
```

### 3. Append the self-registration import

Append to `src/channels/index.ts` (skip if present):

```typescript
import './web.js';
```

### 4. Wire into `src/index.ts`

Add this block inside `main()`, after DB migrations/backfill and **before** `initChannelAdapters(...)`:

```typescript
  const { startWebChat } = await import('./webchat-boot.js');
  await startWebChat();
```

### 5. Build and validate

```bash
pnpm run build
pnpm exec nanoclaw-webchat verify    # recommended — runs adapter tests; handles native deps
```

Or run vitest directly:

```bash
pnpm exec vitest run src/channels/web-registration.test.ts src/channels/web.test.ts src/webchat-sync.test.ts src/webchat-wiring.test.ts
```

Restart your NanoClaw host service after a clean build.

## Credentials

Add to `.env` (or let `nanoclaw-webchat install` scaffold these):

```bash
WEBCHAT_ENABLED=true
WEBCHAT_PORT=3200
WEBCHAT_SECRET=<random>
WEBCHAT_TEAM_FOLDER=dm-with-brad   # optional — enables @team on this agent
WEBCHAT_USER_ID=web:local          # optional
WEBCHAT_DISPLAY_NAME=Local         # optional
```

Generate secret: `node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"`

Local mode (the default, `WEBCHAT_AUTH_MODE=local`) is loopback-only: the host refuses to start if
`WEBCHAT_BIND_ADDRESS` or `WEBCHAT_PUBLIC_BASE_URL` points beyond localhost. To expose webchat on the
internet (e.g. behind nginx, see `deploy/nginx-bawdeclaw.bawapps.com.conf`) switch to public mode.

## Public mode

`WEBCHAT_AUTH_MODE=public` replaces the static secret with per-user sessions. In public mode the static
`WEBCHAT_SECRET` (bearer / `?token=`) is **ignored entirely**; only browser sessions and MCP OAuth access
tokens are accepted.

```bash
WEBCHAT_AUTH_MODE=public
WEBCHAT_PUBLIC_BASE_URL=https://chat.example.com   # exact public origin; WebSocket Origin must match
WEBCHAT_BIND_ADDRESS=127.0.0.1                     # keep loopback; the reverse proxy fronts it
WEBCHAT_SESSION_SECRET=<32+ random chars>          # HMAC key for session cookies + MCP tokens
WEBCHAT_SESSION_TTL_SECONDS=86400                  # optional
WEBCHAT_SECURE_COOKIES=true                        # default true; WEBCHAT_SESSION_INSECURE_COOKIES=true for plain-http dev

# Basic login (per-user hashes — preferred)
WEBCHAT_AUTH_BASIC_ENABLED=true
WEBCHAT_BASIC_USERS=alice:scrypt$...$...,bob:sha256$<hex>
WEBCHAT_BASIC_DISPLAY_NAMES=alice:Alice            # optional
# Legacy shared password (still supported; users without a hash fall back to it)
WEBCHAT_BASIC_PASSWORD=<password>
WEBCHAT_BASIC_ALLOWED_USERNAMES=alice,bob

# OIDC / OAuth login (optional)
WEBCHAT_AUTH_OIDC_ENABLED=true
WEBCHAT_OIDC_PROVIDERS='[{"id":"github","protocol":"oauth",...}]'   # or WEBCHAT_OIDC_PROVIDERS_FILE=path
WEBCHAT_OIDC_REDIRECT_URI=https://chat.example.com/api/auth/callback
WEBCHAT_OIDC_ALLOWED_EMAILS=you@example.com        # and/or _ALLOWED_EMAIL_DOMAINS / _ALLOWED_SUBS / _REQUIRED_GROUP

# MCP over HTTP (opt-in in every mode)
WEBCHAT_MCP_HTTP_ENABLED=false
WEBCHAT_MCP_ALLOW_DCR=false                        # OAuth dynamic client registration (/register); 403 when off
WEBCHAT_MCP_TOKEN_TTL_SECONDS=86400

WEBCHAT_MAX_UPLOAD_BYTES=52428800                  # 50 MiB default; match nginx client_max_body_size
```

Generate a password hash for `WEBCHAT_BASIC_USERS` (scrypt, random salt):

```bash
pnpm exec tsx -e "import('./src/webchat-auth.js').then(m => console.log(m.hashBasicPassword(process.argv[1])))" -- 'your-password'
```

Entries are `username:<hash>`; usernames are case-insensitive. `sha256$<hex>` hashes are also accepted
(`printf %s 'pw' | sha256sum`) but scrypt is preferred.

What public mode enforces:

- **Login rate limiting** — token bucket per client IP (`X-Real-IP` is trusted only when the request
  comes from a loopback proxy) plus exponential per-username backoff after 5 failed attempts (429 +
  `Retry-After`).
- **OIDC state binding** — the OAuth `state` is tied to a short-lived HttpOnly cookie; a callback from
  another browser is rejected. `id_token`s must carry `exp`; RS256 and ES256 are verified.
- **WebSocket Origin** — upgrades whose `Origin` differs from `WEBCHAT_PUBLIC_BASE_URL` are refused.
- **Attachments** — downloads require access to the room the message lives in; every attachment is
  served with `Content-Disposition: attachment`, `CSP: sandbox`, `nosniff`, and HTML/SVG/XML/JS as
  `text/plain`.
- **Lobby threads** — only the creator or an owner may delete a lobby thread.
- **MCP OAuth** — `/authorize` never issues a code directly: the user lands on a same-origin consent
  page (`/mcp/consent`) showing the client, redirect URI and scopes, and the code is issued only on the
  CSRF-checked Approve. Dynamic client registration is off unless `WEBCHAT_MCP_ALLOW_DCR=true` — set it
  temporarily while an MCP client registers, then turn it off (registered clients persist).
- **Uploads** — 50 MiB default, at most 32 in-flight chunked uploads (4 per user); staging lives under
  `data/webchat-uploads/` and is swept on boot.

## Verify

Open `http://127.0.0.1:3200` — auth token is injected by the host (no paste step).

- **Lobby:** `@sarah hello` routes to the sarah agent
- **DM:** pick an agent in the sidebar — all messages go to that agent
- **Threads:** use **New thread** in the lobby header

## Channel Info

| Field | Value |
|-------|-------|
| channel type | `web` |
| platform ids | `lobby`, `dm:<folder>` |
| terminology | room / thread |
| typical use | local browser desk for multi-agent @ routing |
| default isolation | separate sessions per thread; shared agent workspace per agent group |

## Upgrading

```bash
pnpm update nanoclaw-webchat
pnpm exec nanoclaw-webchat upgrade
pnpm run build
# restart host
```

UI-only updates may only require a host restart. Adapter changes require re-running install/upgrade.

## Troubleshooting

- **`better-sqlite3` / MODULE_NOT_FOUND / NODE_MODULE_VERSION:** Run `pnpm exec nanoclaw-webchat verify` (rebuilds under project Node). Ensure Node 22 (`nvm use`) or upgrade host to `better-sqlite3@^12.10.0` on Node 26+
- **401 in browser:** wrong `WEBCHAT_SECRET`
- **Messages dropped:** ensure `web:local` user has member access (sync adds this automatically)
- **Agent not engaging in lobby:** message must match `@<folder>` pattern (e.g. `@sarah`)
- **Package missing:** run step 1; build must pass before tests

See [REMOVE.md](REMOVE.md) to uninstall.
