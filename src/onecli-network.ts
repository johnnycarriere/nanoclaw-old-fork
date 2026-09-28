/**
 * FORK: OneCLI-in-Docker reachability on Linux hosts.
 *
 * On Linux, OneCLI itself runs in Docker (compose project `onecli`, network
 * `onecli_onecli`, service container `onecli-app-1` by default). Docker's
 * DOCKER-USER iptables chain commonly blocks container→docker0-bridge
 * traffic, so the gateway-injected proxy at `host.docker.internal:10255`
 * times out from inside an agent container. Joining the OneCLI compose
 * network gives the agent direct in-docker DNS to the app container, and the
 * proxy env the gateway contributes is rewritten to that hostname.
 *
 * Two consumers, ONE decision (`onecliNetworkJoin()`, cached ~60s per
 * process so a spawn's driver args and gateway env always agree):
 *   - `src/drivers/index.ts` (dockerNetworkArgs) adds `--network <network>`
 *   - `src/gateway-providers/onecli.ts` rewrites the contributed proxy env
 *
 * Settings (`process.env` wins, then `.env`): `ONECLI_COMPOSE_NETWORK`
 * (default `onecli_onecli`), `ONECLI_APP_CONTAINER` (default `onecli-app-1`).
 * Egress lockdown owns the network topology when enabled, so the join is
 * skipped there (warned once). macOS uses host networking for OneCLI, so
 * this is a Linux-only no-op there.
 */
import { execFileSync } from 'node:child_process';
import os from 'node:os';

import { EGRESS_LOCKDOWN } from './config.js';
import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';
import { readEnvFile } from './env.js';
import { log } from './log.js';

const SETTINGS = ['ONECLI_COMPOSE_NETWORK', 'ONECLI_APP_CONTAINER'] as const;
const HOST_GATEWAY_NAME = 'host.docker.internal';
const DECISION_TTL_MS = 60_000;

/** Env keys the OneCLI gateway contributes that carry the proxy host. */
const PROXY_ENV_KEYS = ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy', 'ONECLI_GATEWAY_URL', 'ONECLI_URL'];

function readSetting(key: (typeof SETTINGS)[number]): string {
  return process.env[key]?.trim() || readEnvFile([...SETTINGS])[key]?.trim() || '';
}

export function onecliComposeNetwork(): string {
  return readSetting('ONECLI_COMPOSE_NETWORK') || 'onecli_onecli';
}

export function onecliAppContainer(): string {
  return readSetting('ONECLI_APP_CONTAINER') || 'onecli-app-1';
}

export interface OnecliNetworkJoin {
  /** True when the agent container should join the compose network. */
  join: boolean;
  network: string;
  host: string;
}

let cached: { at: number; value: OnecliNetworkJoin } | null = null;
let lockdownWarned = false;

function networkExists(network: string): boolean {
  try {
    execFileSync(CONTAINER_RUNTIME_BIN, ['network', 'inspect', network], { stdio: 'pipe', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** The single join decision, cached for DECISION_TTL_MS. */
export function onecliNetworkJoin(now = Date.now()): OnecliNetworkJoin {
  if (cached && now - cached.at < DECISION_TTL_MS) return cached.value;
  const network = onecliComposeNetwork();
  const host = onecliAppContainer();
  let join = false;
  if (os.platform() === 'linux' && networkExists(network)) {
    if (EGRESS_LOCKDOWN) {
      if (!lockdownWarned) {
        lockdownWarned = true;
        log.warn('OneCLI compose network present but egress lockdown is on — not joining it', { network });
      }
    } else {
      join = true;
    }
  }
  cached = { at: now, value: { join, network, host } };
  return cached.value;
}

/** Test seam: drop the cached decision. */
export function resetOnecliNetworkDecision(): void {
  cached = null;
  lockdownWarned = false;
}

/**
 * Rewrite `host.docker.internal` → the in-network app hostname in the known
 * OneCLI proxy env keys only. Pure; returns a new map.
 */
export function rewriteGatewayHostForOnecliNetwork(
  env: Record<string, string>,
  host = onecliNetworkJoin().host,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    out[key] =
      PROXY_ENV_KEYS.includes(key) && value.includes(HOST_GATEWAY_NAME)
        ? value.split(HOST_GATEWAY_NAME).join(host)
        : value;
  }
  return out;
}
