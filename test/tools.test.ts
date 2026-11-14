import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { loadConfig } from '../src/config.js';
import { nullLogger } from '../src/log.js';
import { shrinkImage } from '../src/tools/images.js';
import { ToolPolicy, hasPlaceArgument } from '../src/tools/policy.js';
import {
  fitJson,
  fromUpstream,
  postprocess,
  rewriteLinks,
  stripView,
} from '../src/tools/postprocess.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { ToolRunner } from '../src/tools/runner.js';
import { stem } from '../src/tools/search.js';
import { metaFor } from '../src/tools/tags.js';
import type { ToolDef } from '../src/tools/types.js';
import { SchemaValidator } from '../src/tools/validate.js';

const POINT = {
  type: 'object',
  properties: {
    lat: { type: 'number', minimum: -90, maximum: 90 },
    lon: { type: 'number', minimum: -180, maximum: 180 },
    place: { type: 'string' },
  },
  additionalProperties: false,
};
const upstream = (
  name: string,
  description: string,
  props: Record<string, unknown> = { location: POINT },
) => ({
  name,
  description,
  inputSchema: {
    type: 'object',
    properties: props,
    required: Object.keys(props),
    additionalProperties: false,
  },
});
const GEV_TOOLS = [
  upstream(
    'get_weather',
    'Current weather at a location: conditions, temperature, wind and visibility.',
  ),
  upstream('find_cctv_cameras', 'Public cameras in an area, nearest first.', { area: POINT }),
  upstream('get_traffic_flow', 'TomTom speed vs free-flow for roads in an area.', { area: POINT }),
  upstream('search_places', 'Google Places text search.', { query: { type: 'string' } }),
  upstream('places_nearby', 'Notable places near a point.'),
  upstream('aircraft_in_area', 'Aircraft in an area, nearest first.', { area: POINT }),
  upstream('find_alpr_cameras', 'OSM-mapped licence plate readers.', { area: POINT }),
  upstream('panel_request', 'Panel-only proxy into the app.', { key: { type: 'string' } }),
  upstream('get_transit_vehicles', 'GTFS-RT vehicle positions: bus, train, tram.', { area: POINT }),
  upstream('brand_new_tool', 'Something upstream added later.', {}),
];

function nativeDef(name: string, description: string): ToolDef {
  return {
    name,
    description,
    source: 'gateway',
    family: 'pulse',
    inputSchema: {
      type: 'object',
      properties: { lat: { type: 'number' }, lon: { type: 'number' } },
      required: ['lat', 'lon'],
      additionalProperties: false,
    },
    tags: metaFor(name).tags,
    attribution: metaFor(name).attribution,
    run: async () => ({ summary: 'ok', data: { ok: true } }),
  };
}

function setup(env: Record<string, string> = {}) {
  const config = loadConfig(env);
  const policy = new ToolPolicy(config);
  const registry = new ToolRegistry(policy);
  registry.register(
    nativeDef('nearest_rail', 'Nearest railroad line and at-grade crossing to a point.'),
  );
  registry.register(nativeDef('crossings_near', 'Railroad grade crossings within a radius.'));
  registry.setGevTools(
    GEV_TOOLS,
    async (name, args) => ({ summary: `${name} called`, data: { args } }),
    5000,
  );
  return { config, policy, registry };
}

describe('search', () => {
  it('stems plurals', () => {
    expect(stem('Trains')).toBe('train');
    expect(stem('crossings')).toBe('crossing');
    expect(stem('cameras')).toBe('camera');
    expect(stem('batteries')).toBe('battery');
    expect(stem('gas')).toBe('gas');
  });

  it('finds nearest_rail for "train crossing"', () => {
    const { registry } = setup();
    const hits = registry.find('train crossing', 8).map((h) => h.tool.name);
    expect(hits.slice(0, 2)).toEqual(expect.arrayContaining(['nearest_rail', 'crossings_near']));
    expect(registry.find('freight train stopped', 3)[0]?.tool.name).toBe('nearest_rail');
  });

  it('matches synonyms and hides denied tools', () => {
    const { registry } = setup();
    expect(registry.find('traffic cam', 3)[0]?.tool.name).toBe('find_cctv_cameras');
    expect(registry.find('jam backup gridlock', 3)[0]?.tool.name).toBe('get_traffic_flow');
    const all = registry.find('', 100).map((h) => h.tool.name);
    expect(all).not.toContain('search_places');
    expect(all).not.toContain('panel_request');
    expect(all).not.toContain('aircraft_in_area');
    expect(all).not.toContain('find_alpr_cameras');
    expect(all).not.toContain('brand_new_tool');
  });
});

describe('policy', () => {
  it('denies Google, OpenSky, ALPR, unknown GEV tools and never registers panel_request', () => {
    const { policy, registry } = setup();
    expect(registry.get('panel_request')).toBeUndefined();
    const deny = (n: string) => policy.evaluate({ name: n, source: 'gev' });
    expect(deny('search_places')).toMatchObject({
      allowed: false,
      reason: expect.stringMatching(/Google/),
    });
    expect(deny('places_nearby').allowed).toBe(false);
    expect(deny('aircraft_in_area')).toMatchObject({
      allowed: false,
      reason: expect.stringMatching(/OpenSky/),
    });
    expect(deny('situation_brief').allowed).toBe(false);
    expect(deny('find_alpr_cameras').allowed).toBe(false);
    expect(deny('brand_new_tool')).toMatchObject({
      allowed: false,
      reason: expect.stringMatching(/allowlist/),
    });
    expect(deny('get_hud_caption').allowed).toBe(false);
    expect(deny('get_weather').allowed).toBe(true);
  });

  it('licensing switches are configurable but Google is not', () => {
    const { policy } = setup({
      ALLOW_OPENSKY_TOOLS: 'true',
      ALLOW_ALPR_TOOLS: 'true',
      GEV_TOOL_ALLOWLIST: 'aircraft_in_area,find_alpr_cameras,search_places',
    });
    expect(policy.evaluate({ name: 'aircraft_in_area', source: 'gev' }).allowed).toBe(true);
    expect(policy.evaluate({ name: 'find_alpr_cameras', source: 'gev' }).allowed).toBe(true);
    expect(policy.evaluate({ name: 'search_places', source: 'gev' }).allowed).toBe(false);
    expect(policy.evaluate({ name: 'get_weather', source: 'gev' }).allowed).toBe(false); // not on custom allowlist
  });

  it('applies the deny list', () => {
    const { policy } = setup({ TOOL_DENYLIST: 'get_weather' });
    expect(policy.evaluate({ name: 'get_weather', source: 'gev' }).allowed).toBe(false);
  });

  it('rate-limits per bucket across windows', () => {
    const { policy } = setup({ TOOL_RATE_LIMITS: 'get_traffic_flow=2/h,get_traffic_flow=3/d' });
    const b = ['get_traffic_flow'];
    expect(policy.consumeRate(b).ok).toBe(true);
    expect(policy.consumeRate(b).ok).toBe(true);
    const third = policy.consumeRate(b);
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.retryAfterS).toBeGreaterThan(0);
  });

  it('detects place-name arguments', () => {
    expect(hasPlaceArgument({ area: { place: 'Detroit' } })).toBe(true);
    expect(hasPlaceArgument({ area: { lat: 1, lon: 2 } })).toBe(false);
    const { policy } = setup();
    expect(
      policy.checkArguments(
        { name: 'get_weather', source: 'gev' },
        { location: { place: 'Detroit' } },
      ),
    ).toMatch(/coordinates/);
    expect(
      policy.bucketsFor({ name: 'get_weather', source: 'gev' }, { location: { place: 'X' } }),
    ).toEqual(['get_weather', 'nominatim']);
  });
});

describe('schema validation', () => {
  it('reports readable errors', () => {
    const v = new SchemaValidator();
    const schema = GEV_TOOLS[0]!.inputSchema;
    expect(v.validate('get_weather', schema, { location: { lat: 42.37, lon: -83.47 } }).ok).toBe(
      true,
    );
    const bad = v.validate('get_weather', schema, { location: { lat: 142 }, extra: 1 });
    expect(bad.ok).toBe(false);
    expect(bad.errors.join(' ')).toMatch(/unexpected property "extra"/);
    expect(bad.errors.join(' ')).toMatch(/location\.lat/);
  });

  it('run_tool returns the schema on a validation error', async () => {
    const { registry } = setup();
    const runner = new ToolRunner(registry, {
      timeoutMs: 5000,
      maxConcurrent: 2,
      logger: nullLogger,
      post: postOpts(),
    });
    const r = await runner.run(
      'get_weather',
      { location: { lat: 'x' } },
      { signal: new AbortController().signal },
    );
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/Invalid arguments/);
    expect(JSON.parse(r.content[1]!.text!)).toHaveProperty('input_schema.properties.location');
  });

  it('run_tool refuses denied and unknown tools', async () => {
    const { registry } = setup();
    const runner = new ToolRunner(registry, {
      timeoutMs: 5000,
      maxConcurrent: 2,
      logger: nullLogger,
      post: postOpts(),
    });
    const sig = new AbortController().signal;
    expect(
      (await runner.run('search_places', { query: 'x' }, { signal: sig })).content[0]!.text,
    ).toMatch(/Google/);
    expect(
      (await runner.run('panel_request', { key: 'x' }, { signal: sig })).content[0]!.text,
    ).toMatch(/Unknown tool/);
    expect(
      (await runner.run('get_weather', { location: { place: 'Detroit' } }, { signal: sig }))
        .content[0]!.text,
    ).toMatch(/Place names/);
  });

  it('run_tool times out', async () => {
    const config = loadConfig({});
    const registry = new ToolRegistry(new ToolPolicy(config));
    registry.register({
      ...nativeDef('slowpoke', 'slow'),
      inputSchema: { type: 'object' },
      run: () => new Promise(() => {}),
    });
    const runner = new ToolRunner(registry, {
      timeoutMs: 100,
      maxConcurrent: 1,
      logger: nullLogger,
      post: postOpts(),
    });
    const r = await runner.run('slowpoke', {}, { signal: new AbortController().signal });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/did not finish/);
  });
});

function postOpts() {
  return {
    publicOrigin: 'https://godseye.gamachecloud.com',
    gevOrigins: ['http://127.0.0.1:7701', 'http://localhost:7701'],
    maxResultChars: 20_000,
    imageMaxDim: 512,
    imageMaxBase64Chars: 40_000,
    maxImages: 1,
    now: () => new Date('2026-11-14T12:00:00Z'),
  };
}

describe('post-processing', () => {
  it('dedupes GEV output, strips view and rewrites links', async () => {
    const data = {
      view: { url: 'http://127.0.0.1:7701/#v=2&lat=42.37', camera: {} },
      link: 'see http://localhost:7701/x',
      n: 1,
    };
    const out = fromUpstream({
      content: [
        { type: 'text', text: 'Summary at http://127.0.0.1:7701/' },
        { type: 'text', text: JSON.stringify(data) },
      ],
      structuredContent: data,
    });
    expect(out.summary).toBe('Summary at http://127.0.0.1:7701/');
    const r = await postprocess(
      { name: 'get_weather', source: 'gev', attribution: 'Weather data by Open-Meteo.com' },
      out,
      postOpts(),
    );
    const text = r.content.map((c) => c.text).join('\n');
    expect(text).not.toContain('127.0.0.1');
    expect(text).not.toContain('localhost:7701');
    expect(text).toContain('https://godseye.gamachecloud.com/#v=2&lat=42.37');
    expect(text).toContain('retrieved 2026-11-14T12:00:00.000Z');
    expect(text).toContain('Attribution: Weather data by Open-Meteo.com');
    const json = JSON.parse(r.content[1]!.text!);
    expect(json).not.toHaveProperty('view');
    expect(json.map_url).toBe('https://godseye.gamachecloud.com/#v=2&lat=42.37');
    expect(r.content).toHaveLength(2);
  });

  it('helpers', () => {
    expect(
      rewriteLinks({ a: ['http://127.0.0.1:7701/x'] }, ['http://127.0.0.1:7701'], 'https://p'),
    ).toEqual({ a: ['https://p/x'] });
    expect(stripView({ view: { url: 'u' }, x: 1 })).toEqual({ x: 1, map_url: 'u' });
    const big = { items: Array.from({ length: 2000 }, (_, i) => ({ i, pad: 'x'.repeat(40) })) };
    const fit = fitJson(big, 10_000);
    expect(fit.truncated).toBe(true);
    expect(fit.json.length).toBeLessThanOrEqual(10_000);
    expect(JSON.parse(fit.json).items_truncated).toMatch(/omitted/);
  });

  it('suppresses Street View fallback frames', async () => {
    const out = fromUpstream({
      content: [
        { type: 'text', text: 'Street View fallback for Mill St' },
        { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' },
      ],
      structuredContent: { id: 'sv-1', provider: 'Google Street View', source_kind: 'streetview' },
    });
    const r = await postprocess({ name: 'get_cctv_snapshot', source: 'gev' }, out, postOpts());
    expect(r.content.some((c) => c.type === 'image')).toBe(false);
    expect(r.content[0]!.text).toMatch(/suppressed/);
    expect(r.content.map((c) => c.text).join('')).not.toMatch(/Google Street View"/);
  });
});

describe('image downscaling', () => {
  async function bigJpeg() {
    const w = 1600,
      h = 1200;
    const raw = Buffer.alloc(w * h * 3);
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) >>> 24;
    return (
      await sharp(raw, { raw: { width: w, height: h, channels: 3 } })
        .jpeg({ quality: 95 })
        .toBuffer()
    ).toString('base64');
  }

  it('shrinks large images under the limit', async () => {
    const data = await bigJpeg();
    expect(data.length).toBeGreaterThan(500_000);
    const r = await shrinkImage(
      { mimeType: 'image/jpeg', data },
      { maxDim: 768, maxBase64Chars: 60_000 },
    );
    expect('image' in r).toBe(true);
    if ('image' in r) {
      expect(r.image.data.length).toBeLessThanOrEqual(60_000);
      const meta = await sharp(Buffer.from(r.image.data, 'base64')).metadata();
      expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(768);
    }
  });

  it('drops oversized images when sharp is unavailable', async () => {
    const r = await shrinkImage(
      { mimeType: 'image/jpeg', data: 'A'.repeat(100_000) },
      { maxDim: 768, maxBase64Chars: 60_000, loader: async () => null },
    );
    expect(r).toMatchObject({ dropped: expect.stringMatching(/omitted/) });
    const small = await shrinkImage(
      { mimeType: 'image/png', data: 'AAAA' },
      { maxDim: 768, maxBase64Chars: 60_000, loader: async () => null },
    );
    expect(small).toMatchObject({ image: { data: 'AAAA' }, resized: false });
  });
});
