/**
 * border_wait_times (CBP U.S.-bound + CBSA Canada-bound, cached 5 min), and how the roads
 * family plugs into the gateway: registration, find_tools categories and search, run_tool
 * validation, per-tool quotas through the policy, attribution and labels on every result.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { registerRoads } from '../src/extra/roads/index.js';
import { buildCore } from '../src/gateway.js';
import { nullLogger } from '../src/log.js';
import { ToolPolicy } from '../src/tools/policy.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { ToolRunner } from '../src/tools/runner.js';
import { categoryFor } from '../src/tools/tags.js';
import { cbpTime, parseCbsa } from '../src/extra/roads/border.js';
import {
  CBSA_CSV,
  NOW,
  defaultRoutes,
  harness,
  json,
  mockFetch,
  type Harness,
} from './fixtures/roads.js';
import { DETROIT } from './helpers.js';

const dirs: string[] = [];
const made: Harness[] = [];
const h = (...a: Parameters<typeof harness>) => {
  const x = harness(...a);
  made.push(x);
  return x;
};
afterEach(() => {
  for (const x of made.splice(0)) rmSync(x.dir, { recursive: true, force: true });
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Row = {
  crossing: string;
  direction: string;
  lane_type: string;
  delay_min: number | null;
  lanes_open: number | null;
  status: string;
  updated: string | null;
  source: string;
};
const rowsOf = (out: { data?: unknown }) => (out.data as { rows: Row[] }).rows;

describe('border_wait_times', () => {
  it('lists both directions at the four crossings, and nothing else', async () => {
    const x = h();
    const out = await x.run('border_wait_times', {});
    const rows = rowsOf(out);
    expect(new Set(rows.map((r) => r.crossing))).toEqual(
      new Set(['ambassador', 'tunnel', 'gordie_howe', 'blue_water']),
    );
    expect(new Set(rows.map((r) => r.source))).toEqual(new Set(['CBP', 'CBSA']));
    const usPv = rows.find(
      (r) => r.crossing === 'ambassador' && r.source === 'CBP' && r.lane_type === 'passenger',
    )!;
    expect(usPv).toMatchObject({
      direction: 'to_us',
      delay_min: 10,
      lanes_open: 4,
      status: 'delay',
      updated: '2026-11-14T16:00:00-05:00',
    });
    const ready = rows.find(
      (r) => r.crossing === 'ambassador' && r.lane_type === 'passenger Ready Lane',
    )!;
    expect(ready).toMatchObject({ delay_min: null, lanes_open: 0, status: 'Lanes Closed' });
    expect(rows.some((r) => r.lane_type === 'pedestrian')).toBe(false);
    expect(out.observedAt).toBe('2026-11-14T16:00:00-05:00');
    expect(out.summary).toContain(
      'Ambassador Bridge into the US passenger: 10 min, 4 lane(s) open',
    );
  });

  it('filters by crossing and direction', async () => {
    const x = h();
    const out = await x.run('border_wait_times', {
      crossing: 'ambassador',
      direction: 'to_canada',
    });
    expect(rowsOf(out)).toEqual([
      expect.objectContaining({
        source: 'CBSA',
        lane_type: 'commercial',
        delay_min: 45,
        updated: '2026-11-14T14:12:00-05:00',
      }),
      expect.objectContaining({
        source: 'CBSA',
        lane_type: 'passenger',
        delay_min: 0,
        status: 'no delay',
      }),
    ]);
    const gh = await x.run('border_wait_times', { crossing: 'gordie_howe', direction: 'to_us' });
    expect(rowsOf(gh).every((r) => r.source === 'CBP' && r.crossing === 'gordie_howe')).toBe(true);
  });

  it('caches both feeds for 5 minutes', async () => {
    const x = h();
    await x.run('border_wait_times', {});
    await x.run('border_wait_times', { crossing: 'tunnel' });
    expect(x.mock.count(/bwt\.cbp\.gov/)).toBe(1);
    expect(x.mock.count(/cbsa/)).toBe(1);
    x.clock.now += 301_000;
    await x.run('border_wait_times', {});
    expect(x.mock.count(/bwt\.cbp\.gov/)).toBe(2);
  });

  it('keeps one direction when the other feed is down, and fails when both are', async () => {
    const x = h({}, { routes: [[/cbsa/, () => new Response('down', { status: 503 })]] });
    const out = await x.run('border_wait_times', {});
    expect(out.isError).toBeFalsy();
    expect(out.summary).toContain('Canada-bound (CBSA): CBSA border wait times returned HTTP 503');
    const only = await x.run('border_wait_times', { direction: 'to_canada' });
    expect(only.isError).toBe(true);
  });

  it('parses the CBSA CSV and CBP times', () => {
    expect(parseCbsa(CBSA_CSV).map((r) => r.crossing)).toEqual([
      'blue_water',
      'blue_water',
      'tunnel',
      'tunnel',
      'ambassador',
      'ambassador',
      'gordie_howe',
      'gordie_howe',
    ]);
    expect(parseCbsa('')).toEqual([]);
    expect(cbpTime('11/14/2026', 'At 12:05 am EDT')).toBe('2026-11-14T00:05:00-04:00');
    expect(cbpTime('11/14/2026', 'At 12:30 pm EST')).toBe('2026-11-14T12:30:00-05:00');
    expect(cbpTime('11/14/2026', '')).toBeNull();
  });
});

function gateway(env: Record<string, string> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'gw-roads-reg-'));
  dirs.push(dir);
  const config = loadConfig({ DATA_DIR: dir, ...env });
  const registry = new ToolRegistry(new ToolPolicy(config));
  const mock = mockFetch(defaultRoutes());
  registerRoads(registry, {
    config,
    fetch: mock.fetch,
    now: () => NOW,
    sleep: async () => undefined,
  });
  const runner = new ToolRunner(registry, {
    timeoutMs: 10_000,
    maxConcurrent: 2,
    logger: nullLogger,
    post: {
      publicOrigin: 'https://ui.example',
      gevOrigins: [],
      maxResultChars: 20_000,
      imageMaxDim: 256,
      imageMaxBase64Chars: 10_000,
      maxImages: 0,
    },
  });
  return { config, registry, runner, mock };
}

const ctx = () => ({ signal: new AbortController().signal });
const text = (r: { content: Array<{ text?: string }> }) =>
  r.content.map((c) => c.text ?? '').join('\n');

describe('roads family in the gateway', () => {
  it('registers five tools in the find_tools categories', () => {
    const { registry } = gateway();
    const cats = Object.fromEntries(registry.catalog().map((e) => [e.tool.name, e.category]));
    expect(cats).toEqual({
      road_closures: 'traffic',
      route_avoiding_closures: 'traffic',
      border_wait_times: 'traffic',
      mdot_camera_link: 'cameras',
      geocode_place: 'places',
    });
    expect(categoryFor('geocode_place', 'gateway')).toBe('places');
  });

  it('is found by what people ask', () => {
    const { registry } = gateway();
    const top = (q: string) => registry.find(q, 3)[0]?.tool.name;
    expect(top('is I-94 closed')).toBe('road_closures');
    expect(top('construction on I-696')).toBe('road_closures');
    expect(top('border wait ambassador bridge')).toBe('border_wait_times');
    expect(top('geocode this address')).toBe('geocode_place');
    expect(top('mdot traffic camera')).toBe('mdot_camera_link');
    expect(registry.find('detour around the closure', 3).map((x) => x.tool.name)).toContain(
      'route_avoiding_closures',
    );
  });

  it('is wired into the real gateway', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gw-roads-core-'));
    dirs.push(dir);
    const core = buildCore(
      loadConfig({ GATEWAY_MODE: 'test', DATA_DIR: dir, PULSE_URL: 'http://127.0.0.1:9' }),
      {
        logger: nullLogger,
      },
    );
    try {
      for (const n of [
        'road_closures',
        'geocode_place',
        'route_avoiding_closures',
        'mdot_camera_link',
        'border_wait_times',
      ])
        expect(core.registry.isAllowed(core.registry.get(n)!), n).toBe(true);
      expect(core.config.toolRateLimits.some((l) => l.bucket === 'road_closures')).toBe(true);
    } finally {
      core.db.close();
    }
  });

  it('validates arguments against the JSON schema before running', async () => {
    const { runner, mock } = gateway();
    const r = await runner.run('border_wait_times', { crossing: 'peace_bridge' }, ctx());
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('Invalid arguments for border_wait_times');
    expect(text(r)).toContain('input_schema');
    const r2 = await runner.run('road_closures', { lat: 'north', lon: 1 }, ctx());
    expect(r2.isError).toBe(true);
    expect(mock.calls).toHaveLength(0);
  });

  it('labels and credits every result', async () => {
    const { runner } = gateway();
    const r = await runner.run('road_closures', { ...DETROIT, radius_km: 2 }, ctx());
    const t = text(r);
    expect(t).toContain('[source: gateway · tool road_closures');
    expect(t).toContain('[contains third-party text');
    expect(t).toContain('Attribution: City of Detroit Open Data');
    const b = text(await runner.run('border_wait_times', {}, ctx()));
    expect(b).toContain('Attribution: U.S.-bound: U.S. Customs and Border Protection');
    const m = text(await runner.run('mdot_camera_link', { ...DETROIT }, ctx()));
    expect(m).toContain('[third-party links (mdotjboss.state.mi.us)');
    expect(m.length).toBeLessThan(20_000);
  });

  it('applies the family quotas through the policy; TOOL_RATE_LIMITS wins', async () => {
    const def = gateway({ ROADS_TOOL_RATE_LIMITS: 'border_wait_times=2/h' });
    expect(def.config.toolRateLimits.find((l) => l.bucket === 'border_wait_times')).toMatchObject({
      limit: 2,
    });
    await def.runner.run('border_wait_times', {}, ctx());
    await def.runner.run('border_wait_times', {}, ctx());
    const third = await def.runner.run('border_wait_times', {}, ctx());
    expect(third.isError).toBe(true);
    expect(text(third)).toContain('Rate limit reached for border_wait_times');

    const op = gateway({
      TOOL_RATE_LIMITS: 'border_wait_times=1/h',
      ROADS_TOOL_RATE_LIMITS: 'border_wait_times=50/h',
    });
    expect(op.config.toolRateLimits.filter((l) => l.bucket === 'border_wait_times')).toEqual([
      { bucket: 'border_wait_times', limit: 1, windowMs: 3_600_000 },
    ]);
    await op.runner.run('border_wait_times', {}, ctx());
    expect(text(await op.runner.run('border_wait_times', {}, ctx()))).toContain(
      'Rate limit reached',
    );
  });

  it('shares the policy nominatim bucket with GEV place lookups', async () => {
    const { runner, registry, mock } = gateway({ TOOL_RATE_LIMITS: 'nominatim=1/h' });
    registry.policy.consumeRate(['nominatim']);
    const r = await runner.run('geocode_place', { query: 'Belle Isle Park' }, ctx());
    expect(text(r)).toContain('nominatim quota');
    expect(mock.count(/nominatim/)).toBe(0);
  });

  it('rejects bad roads settings at startup', () => {
    expect(() => loadConfig({ VALHALLA_URL: 'ftp://x' })).toThrow(/VALHALLA_URL/);
    expect(() => loadConfig({ MDOT_RIDE_CACHE_S: '60' })).toThrow(/MDOT_RIDE_CACHE_S/);
    expect(() => loadConfig({ MDOT_RIDE_EVENTS_DATASET: '../x' })).toThrow(
      /MDOT_RIDE_EVENTS_DATASET/,
    );
    expect(() => loadConfig({ GEOCODER_NOMINATIM_DAILY_MAX: '500' })).toThrow(
      /GEOCODER_NOMINATIM_DAILY_MAX/,
    );
    const c = loadConfig({ OVERPASS_URL: '' });
    expect(c.OVERPASS_URL).toBeUndefined();
    expect(c.ALLOW_TOMTOM_INCIDENTS).toBe(false);
    expect(c.TOMTOM_INCIDENTS_DAILY_MAX).toBe(60);
    expect(c.TOMTOM_WHATS_HAPPENING_RESERVE).toBe(20);
    expect(c.VALHALLA_URL).toBe('https://valhalla1.openstreetmap.de');
  });

  it('caps an oversized upstream answer', async () => {
    const big = mockFetch([
      [
        /bwt\.cbp\.gov/,
        () => json(Array.from({ length: 1 }, () => ({ pad: 'x'.repeat(5 * 1024 * 1024) }))),
      ],
    ]);
    const x = h({}, { routes: [[/bwt\.cbp\.gov/, (u, i) => big.fetch(u, i)]] });
    const out = await x.run('border_wait_times', { direction: 'to_us' });
    expect(out.isError).toBe(true);
    expect(out.summary).toContain('response too large');
  });
});
