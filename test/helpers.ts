import { existsSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../src/config.js';

export const MOCK_GEV = path.join(REPO_ROOT, 'test', 'fixtures', 'mock-gev-mcp.mjs');
export const REAL_GEV_ROOT = process.env.GEV_ROOT ?? path.resolve(REPO_ROOT, '..', 'gods-eye-view');
export const HAVE_REAL_GEV = existsSync(path.join(REAL_GEV_ROOT, 'node_modules', 'vite'));

/** Public test points only (never a home location). */
export const DETROIT = { lat: 42.3314, lon: -83.0458 };
export const ANN_ARBOR = { lat: 42.2808, lon: -83.743 };
export const BELLE_ISLE = { lat: 42.3405, lon: -82.985 };

/**
 * Production-mode listener settings for tests. Loopback aliases stand in for the compose
 * addresses: 127.0.0.3 for the gateway's bridge address (HOST), 127.0.0.10 for cloudflared's
 * fixed address. The private listener binds 127.0.0.2 exactly as in deploy/docker-compose.yml.
 */
export const PROD_ENV: Record<string, string> = {
  GATEWAY_MODE: 'production',
  GATEWAY_ENV_FILE: 'none',
  HOST: '127.0.0.3',
  PRIVATE_HOST: '127.0.0.2',
  TRUSTED_PROXY_IPS: '127.0.0.10',
  TAILSCALE_TRUSTED_PROXY_IPS: '127.0.0.1',
  PUBLIC_ORIGIN: 'https://godseye.gamachecloud.com',
  PRIVATE_ORIGIN: 'https://godseye.example-tailnet.ts.net',
  OWNER_TAILSCALE_LOGIN: 'owner@example.com',
  PULSE_URL: 'http://127.0.0.1:9',
};

export async function waitFor(fn: () => boolean, timeoutMs = 10_000, stepMs = 25): Promise<void> {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
