/**
 * The GEV MCP child outside the gateway (review: "GEV stdio child runs inside the gateway
 * container") and the child-side tool allowlist (MCP-1: show_in_gods_eye_view following an
 * aircraft ran the denied find_aircraft, i.e. OpenSky, inside GEV).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { REPO_ROOT, loadConfig } from '../src/config.js';
import { startGateway } from '../src/gateway.js';
import { GevChild, childSpawnSpec } from '../src/gev/child.js';
import { parseHello, startRelay, type Relay } from '../src/gev/relay.js';
import { nullLogger } from '../src/log.js';
import { ToolPolicy } from '../src/tools/policy.js';
import { HAVE_REAL_GEV, MOCK_GEV, REAL_GEV_ROOT, waitFor } from './helpers.js';

let relay: Relay | undefined;
let child: GevChild | undefined;
afterEach(async () => {
  await child?.stop();
  child = undefined;
  await relay?.close();
  relay = undefined;
});

const mockRelay = (allowedPeers = ['127.0.0.1']) =>
  startRelay({
    host: '127.0.0.1',
    port: 0,
    allowedPeers,
    healthPeers: [],
    gevRoot: REPO_ROOT,
    gevUrl: 'http://127.0.0.1:7701',
    wrapper: MOCK_GEV,
  });

describe('GEV relay (child in its own container)', () => {
  it('validates the hello line', () => {
    expect(parseHello('{"godseye_gev_relay":1,"allow":["get_weather"]}')).toEqual(['get_weather']);
    expect(parseHello('nope')).toMatch(/JSON/);
    expect(parseHello('{"godseye_gev_relay":2,"allow":[]}')).toMatch(/unknown/);
    expect(parseHello('{"godseye_gev_relay":1,"allow":["x; rm -rf /"]}')).toMatch(/bad tool/);
    expect(parseHello('{"godseye_gev_relay":1,"allow":"get_weather"}')).toMatch(/array/);
  });

  it('runs the child with only the allowed tools and a minimal environment', async () => {
    relay = await mockRelay();
    child = new GevChild({
      connect: { host: '127.0.0.1', port: relay.port, allow: ['get_weather', 'env_keys'] },
      logger: nullLogger,
    });
    await child.start();
    expect(child.isReady()).toBe(true);
    expect(child.tools.map((t) => t.name).sort()).toEqual(['env_keys', 'get_weather']);
    const w = await child.callTool(
      'get_weather',
      { location: { lat: 42.33, lon: -83.05 } },
      {
        timeoutMs: 5000,
      },
    );
    expect((w.content[0] as { text: string }).text).toMatch(/Clear/);
    const env = await child.callTool('env_keys', {}, { timeoutMs: 5000 });
    const data = env.structuredContent as { keys: string[]; argv: string[] };
    // (VIPSHOME is set inside the mock process by sharp itself.)
    expect(data.keys.filter((k) => k !== 'VIPSHOME')).toEqual([
      'GEV_ROOT',
      'NODE_ENV',
      'NODE_OPTIONS',
      'PATH',
      'UV_THREADPOOL_SIZE',
    ]);
    expect(data.argv).toEqual([
      '--api-base',
      'http://127.0.0.1:7701',
      '--allow',
      'get_weather,env_keys',
    ]);
    await expect(child.callTool('panel_request', {}, { timeoutMs: 5000 })).rejects.toThrow();
    expect(relay.sessions()).toBe(1);
  });

  it('survives a child that cannot be spawned', async () => {
    const events: string[] = [];
    relay = await startRelay({
      host: '127.0.0.1',
      port: 0,
      allowedPeers: ['127.0.0.1'],
      healthPeers: [],
      gevRoot: '/nonexistent-gev-root',
      gevUrl: 'http://127.0.0.1:7701',
      wrapper: MOCK_GEV,
      log: (e) => events.push(e),
    });
    child = new GevChild({
      connect: { host: '127.0.0.1', port: relay.port, allow: ['get_weather'] },
      logger: nullLogger,
      minBackoffMs: 10_000,
    });
    await child.start();
    expect(child.isReady()).toBe(false);
    await waitFor(() => events.includes('relay_spawn_failed'), 5000);
    expect(relay.sessions()).toBe(0);
    // The relay still serves the next session.
    expect(relay.server.listening).toBe(true);
  });

  it('refuses peers other than the gateway', async () => {
    relay = await mockRelay(['127.0.0.9']);
    child = new GevChild({
      connect: {
        host: '127.0.0.1',
        port: relay.port,
        allow: ['get_weather'],
        localAddress: '127.0.0.5',
      },
      logger: nullLogger,
      minBackoffMs: 10_000,
    });
    await child.start();
    expect(child.isReady()).toBe(false);
    expect(relay.sessions()).toBe(0);
  });

  it('the gateway uses the relay when GEV_CHILD_URL is set (no local child)', async () => {
    relay = await mockRelay();
    const dir = mkdtempSync(path.join(tmpdir(), 'gw-relay-'));
    const config = loadConfig({
      GATEWAY_MODE: 'test',
      PORT: '0',
      PRIVATE_PORT: '0',
      UI_PORT: '0',
      DATA_DIR: dir,
      PULSE_URL: 'http://127.0.0.1:9',
      PUBLIC_ORIGIN: 'https://godseye.gamachecloud.com',
      GEV_CHILD_URL: `tcp://127.0.0.1:${relay.port}`,
      // A wrapper path that doesn't exist: proves nothing is spawned locally.
      GEV_WRAPPER: '/nonexistent/stdio-all-surfaces.mjs',
    });
    const gw = await startGateway(config, { logger: nullLogger });
    try {
      await waitFor(() => gw.registry.hasGev(), 10_000);
      const allowed = new ToolPolicy(config).allowedGevTools();
      const gevTools = gw.registry
        .all()
        .filter((t) => t.source === 'gev')
        .map((t) => t.name);
      expect(gevTools.length).toBeGreaterThan(0);
      expect(gevTools.every((n) => allowed.includes(n))).toBe(true);
      const token = gw.tokens.issue({
        clientId: 'test',
        subject: 'owner',
        scope: 'mcp',
        resource: config.mcpResource,
      }).tokens.access_token;
      const c = new Client({ name: 't', version: '1' });
      await c.connect(
        new StreamableHTTPClientTransport(new URL(`${gw.url}/mcp`), {
          requestInit: { headers: { authorization: `Bearer ${token}` } },
        }),
      );
      const r = (await c.callTool({
        name: 'run_tool',
        arguments: {
          name: 'get_weather',
          arguments: { location: { lat: 42.3314, lon: -83.0458 } },
        },
      })) as { content: Array<{ text: string }>; isError?: boolean };
      expect(r.isError).toBeFalsy();
      expect(r.content[0]!.text).toMatch(/Clear/);
      await c.close();
    } finally {
      await gw.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('MCP-1: no aircraft follow while OpenSky is off', () => {
  it('the gateway policy refuses follow.kind aircraft (also nested in view)', () => {
    const off = new ToolPolicy(loadConfig({}));
    const on = new ToolPolicy(loadConfig({ ALLOW_OPENSKY_TOOLS: 'true' }));
    const tool = { name: 'show_in_gods_eye_view', source: 'gev' as const };
    for (const args of [
      { follow: { kind: 'aircraft', id: 'abc123' } },
      { follow: { kind: 'military_aircraft', id: 'ae0000' } },
      { view: { follow: { kind: 'Aircraft', id: 'abc123' } } },
      { camera: { lat: 42.33, lon: -83.05 }, follow: { kind: 'aircraft', id: 'abc123' } },
    ]) {
      expect(off.checkArguments(tool, args), JSON.stringify(args)).toMatch(/OpenSky/);
      expect(on.checkArguments(tool, args)).toBeNull();
    }
    expect(off.checkArguments(tool, { camera: { lat: 42.33, lon: -83.05 } })).toBeNull();
    expect(off.checkArguments(tool, { follow: { kind: 'vessel', id: '123' } })).toBeNull();
    expect(off.allowedGevTools()).not.toContain('find_aircraft');
    expect(on.allowedGevTools()).toContain('find_aircraft');
  });

  /** Mock GEV /api: records hits; /api/flights reports one aircraft. */
  async function mockApi(): Promise<{ url: string; hits: string[]; server: Server }> {
    const hits: string[] = [];
    const server = createServer((req, res) => {
      hits.push(req.url ?? '');
      const now = Math.floor(Date.now() / 1000);
      res.setHeader('content-type', 'application/json');
      if (req.url?.startsWith('/api/flights')) {
        res.end(
          JSON.stringify({
            time: now,
            states: [
              [
                'abc123',
                'TEST123 ',
                'United States',
                now,
                now,
                -83.0458,
                42.3314,
                1200,
                false,
                120,
                90,
                0,
                null,
                1250,
                '1200',
                false,
                0,
              ],
            ],
          }),
        );
        return;
      }
      res.statusCode = 503;
      res.end('{"error":"mock"}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, hits, server };
  }

  async function followAircraft(allow: string[], apiUrl: string) {
    const spec = childSpawnSpec({
      gevRoot: REAL_GEV_ROOT,
      gevUrl: apiUrl,
      wrapper: path.join(REPO_ROOT, 'gev', 'stdio-all-surfaces.mjs'),
      allow,
    });
    child = new GevChild({ ...spec, logger: nullLogger });
    await child.start();
    expect(child.isReady()).toBe(true);
    try {
      const r = await child.callTool(
        'show_in_gods_eye_view',
        { follow: { kind: 'aircraft', id: 'abc123' } },
        { timeoutMs: 20_000 },
      );
      return JSON.stringify(r);
    } catch (err) {
      return String(err);
    } finally {
      await child.stop();
      child = undefined;
    }
  }

  it.runIf(HAVE_REAL_GEV)(
    'the real wrapper, built from the policy allowlist, never reaches OpenSky through a composite',
    async () => {
      const api = await mockApi();
      try {
        const allow = new ToolPolicy(loadConfig({})).allowedGevTools();
        expect(allow).toContain('show_in_gods_eye_view');
        const out = await followAircraft(allow, api.url);
        expect(out).not.toMatch(/42\.33/);
        expect(api.hits.filter((h) => /\/api\/(flights|military)/.test(h))).toEqual([]);
        // Control: with find_aircraft in the child (the old all-tools catalog) the same call
        // reaches /api/flights and returns the aircraft's position.
        const leaky = await followAircraft([...allow, 'find_aircraft'], api.url);
        expect(api.hits.some((h) => h.startsWith('/api/flights'))).toBe(true);
        expect(leaky).toMatch(/42\.33/);
      } finally {
        api.server.close();
      }
    },
    60_000,
  );
});
