import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/config.js';
import { GevChild, childSpawnSpec } from '../src/gev/child.js';
import { nullLogger } from '../src/log.js';
import { HAVE_REAL_GEV, MOCK_GEV, REAL_GEV_ROOT, waitFor } from './helpers.js';

let child: GevChild | undefined;
afterEach(async () => {
  await child?.stop();
  child = undefined;
});

function mockChild() {
  const spec = childSpawnSpec({ gevRoot: REPO_ROOT, gevUrl: 'http://127.0.0.1:7701', wrapper: MOCK_GEV });
  return new GevChild({ ...spec, logger: nullLogger, minBackoffMs: 50, maxBackoffMs: 200 });
}

describe('GEV child supervisor', () => {
  it('lists tools and calls them (out-of-order responses)', async () => {
    child = mockChild();
    await child.start();
    expect(child.isReady()).toBe(true);
    expect(child.tools.map((t) => t.name)).toContain('get_weather');
    const [slow, fast] = await Promise.all([
      child.callTool('slow_tool', { ms: 150 }, { timeoutMs: 5000 }),
      child.callTool('get_weather', { location: { lat: 42.33, lon: -83.05 } }, { timeoutMs: 5000 }),
    ]);
    expect((slow.content[0] as { text: string }).text).toBe('slow done');
    expect((fast.content[0] as { text: string }).text).toMatch(/Clear/);
  });

  it('passes a minimal explicit environment', () => {
    const spec = childSpawnSpec({ gevRoot: '/x', gevUrl: 'http://127.0.0.1:7701', wrapper: '/w.mjs' });
    expect(Object.keys(spec.env).sort()).toEqual(['GEV_ROOT', 'NODE_ENV', 'NODE_OPTIONS', 'PATH', 'UV_THREADPOOL_SIZE']);
    expect(spec.command).toBe(process.execPath);
    expect(spec.args).toEqual(['/w.mjs', '--api-base', 'http://127.0.0.1:7701']);
  });

  it('restarts the child after it dies', async () => {
    child = mockChild();
    await child.start();
    await child.callTool('crash_child', {}, { timeoutMs: 5000 }).catch(() => undefined);
    await waitFor(() => child!.restarts >= 1, 5000);
    await waitFor(() => child!.isReady(), 10_000);
    const r = await child.callTool('plan_route', { from: { lat: 1, lon: 1 }, to: { lat: 2, lon: 2 } }, { timeoutMs: 5000 });
    expect((r.content[0] as { text: string }).text).toMatch(/Route/);
  });

  it('surfaces a JSON-RPC error for unknown tools', async () => {
    child = mockChild();
    await child.start();
    await expect(child.callTool('nope', {}, { timeoutMs: 5000 })).rejects.toThrow();
  });

  it.runIf(HAVE_REAL_GEV)('real wrapper lists all 40 GEV tools', async () => {
    const spec = childSpawnSpec({
      gevRoot: REAL_GEV_ROOT,
      gevUrl: 'http://127.0.0.1:7701',
      wrapper: path.join(REPO_ROOT, 'gev', 'stdio-all-surfaces.mjs'),
    });
    child = new GevChild({ ...spec, logger: nullLogger });
    await child.start();
    expect(child.tools).toHaveLength(40);
    expect(child.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['get_weather', 'plan_route', 'panel_request']));
  });
});
