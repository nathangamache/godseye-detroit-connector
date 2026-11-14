import { existsSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../src/config.js';

export const MOCK_GEV = path.join(REPO_ROOT, 'test', 'fixtures', 'mock-gev-mcp.mjs');
export const REAL_GEV_ROOT = process.env.GEV_ROOT ?? path.resolve(REPO_ROOT, '..', 'gods-eye-view');
export const HAVE_REAL_GEV = existsSync(path.join(REAL_GEV_ROOT, 'node_modules', 'vite'));

/** Public test points only (never a home location). */
export const DETROIT = { lat: 42.3314, lon: -83.0458 };
export const ANN_ARBOR = { lat: 42.2808, lon: -83.743 };
export const BELLE_ISLE = { lat: 42.3405, lon: -82.9850 };

export async function waitFor(fn: () => boolean, timeoutMs = 10_000, stepMs = 25): Promise<void> {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
