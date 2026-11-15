/**
 * whats_happening_here sections: NWS alerts, road closures (top 5 within ~5 km), border waits
 * near a Detroit/Windsor or Port Huron crossing, air quality when configured, cameras only when
 * one is in range; each section fails on its own within a short timeout and an overall budget,
 * and the rail and Pulse sections read exactly as before. Fake tools only (no HTTP).
 */
import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { ONTARIO_ATTRIBUTION, ONTARIO_DISCLAIMER } from '../src/extra/roads/sources/ontario511.js';
import { nullLogger } from '../src/log.js';
import {
  harness as roadsHarness,
  ALL_KEYS,
  CLOSED_NB,
  CLOSED_SB,
  TOMTOM,
  json,
  unnamedClosure,
} from './fixtures/roads.js';
import {
  IntervalGate,
  TOMTOM_SUMMARY_INTERVAL_MS,
  railLine,
  whatsHappeningHere,
} from '../src/mcp/whatsHappening.js';
import { ToolPolicy } from '../src/tools/policy.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { ToolRunner } from '../src/tools/runner.js';
import type { ToolContext, ToolDef, ToolOutput } from '../src/tools/types.js';
import { ANN_ARBOR, DETROIT } from './helpers.js';

/** Downtown Port Huron (public), about 3 km from the Blue Water Bridge. */
const PORT_HURON = { lat: 42.9709, lon: -82.4249 };

type Behaviour = (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolOutput>;

const RAIL_DATA = {
  line: {
    railroad: 'CPKC (Canadian Pacific Kansas City) (CPKC)',
    subdivision: 'WINDSOR',
    line_names: [{ dataset: 'NARN', name: 'WINDSOR' }],
    kind: 'main line',
    distance_m: 640,
    direction: 'S',
  },
  crossing: {
    fra_crossing_id: '284190P',
    street: 'RIVARD ST',
    railroad: 'CPKC',
    line_names: [],
    distance_m: 900,
    direction: 'SE',
    warning_devices: 'gates',
  },
  dataset_as_of: '2025-07-21',
};
const RAIL_RADIO =
  "Rail radio: Can't confirm quiet on this line (NARN: Windsor Sub), per Pulse's verdict: line_road: no receiver has ever reported.";
const INCIDENTS =
  "0 incidents within 3 km in the last 120 min. Scanner radio: Can't confirm quiet.";

function closureItem(i: number) {
  return {
    source: i % 2 ? 'mdot_ride' : 'detroit_row',
    kind: 'work_zone',
    type: i === 0 ? 'Road closed' : 'Lane closure',
    road: `Road ${i}`,
    direction: i === 0 ? 'NB' : null,
    lanes: null,
    vehicle_impact: null,
    full_closure: i === 0,
    description: `third-party text ${i}`,
    from_cross_street: i === 1 ? 'Cross A' : null,
    to_cross_street: i === 1 ? 'Cross B' : null,
    ...(i === 1
      ? { text: 'Lane closure on Road 1 between Cross A and Cross B (MDOT RIDE, 1.5 km away)' }
      : {}),
    start: '2026-11-01T00:00:00Z',
    end: null,
    updated: '2026-11-14T11:00:00Z',
    distance_km: 0.5 + i,
    at: null,
    geometry_summary: 'line',
  };
}

const CLOSURES: ToolOutput = {
  summary: 'long road_closures summary',
  data: {
    count: 7,
    total: 11,
    items: Array.from({ length: 7 }, (_, i) => closureItem(i)),
    sources: [
      { source: 'detroit_row', label: 'City of Detroit permits', status: 'ok', count: 4 },
      { source: 'tomtom', label: 'TomTom incidents', status: 'off', count: 0, note: 'off' },
      { source: 'mdot_ride', label: 'MDOT RIDE', status: 'ok', count: 3 },
      {
        source: 'ontario511',
        label: 'Ontario 511',
        status: 'not_configured',
        count: 0,
        note: 'not configured: set ONTARIO_511_API_KEY',
      },
    ],
    attribution: ['City of Detroit Open Data', 'Michigan Department of Transportation (MDOT RIDE)'],
  },
};

const row = (crossing: string, name: string, direction: string, delay: number) => ({
  crossing,
  crossing_name: name,
  direction,
  lane_type: 'passenger',
  delay_min: delay,
  lanes_open: 2,
  status: 'open',
  updated: '2026-11-14T11:50:00-05:00',
  source: direction === 'to_us' ? 'CBP' : 'CBSA',
});
const BORDER: ToolOutput = {
  summary: 'border summary',
  data: {
    rows: [
      row('ambassador', 'Ambassador Bridge', 'to_us', 10),
      row('tunnel', 'Detroit-Windsor Tunnel', 'to_us', 5),
      row('gordie_howe', 'Gordie Howe International Bridge', 'to_canada', 0),
      row('blue_water', 'Blue Water Bridge', 'to_us', 25),
    ],
    errors: [],
  },
  observedAt: '2026-11-14T16:50:00.000Z',
};

const ALERTS: ToolOutput = {
  // As weather_alerts words it for {lat, lon} (whats_happening_here always passes the point).
  summary:
    '1 active NWS alert(s) for zone MIZ076 (Wayne, MI), at the given point:\n- Winter Weather Advisory (Moderate, Expected, Likely) until 2026-11-15T06:00:00-05:00: snow',
  data: {
    count: 1,
    alerts: [
      {
        event: 'Winter Weather Advisory',
        severity: 'Moderate',
        urgency: 'Expected',
        certainty: 'Likely',
        headline: 'snow',
        description: 'long text',
        instruction: 'slow down',
        ends: '2026-11-15T06:00:00-05:00',
        expires: null,
      },
    ],
    zone: { forecast_zone: 'MIZ076', zone_name: 'Wayne' },
  },
  observedAt: '2026-11-14T16:58:00.000Z',
};

interface Harness {
  run: (args: { lat?: number; lon?: number; radius_km?: number }) => Promise<{
    text: string;
    data: { sources: Array<{ source: string; status: string; summary: string; data?: unknown }> };
    ms: number;
  }>;
  calls: Array<{ name: string; args: Record<string, unknown>; ctx: ToolContext }>;
  policy: ToolPolicy;
  clock: { now: number };
}

function harness(
  over: Record<string, Behaviour> = {},
  opts: {
    env?: Record<string, string>;
    budgetMs?: number;
    airQuality?: boolean;
    /** A phone fix this many seconds old at the test point (the call then gives no lat/lon). */
    fixAgeS?: number;
    /** A real tool in place of the fake road_closures. */
    roadClosures?: ToolDef;
    tomtomGate?: IntervalGate;
  } = {},
): Harness {
  const config = loadConfig({ GATEWAY_MODE: 'test', ...opts.env });
  const clock = { now: Date.parse('2026-11-14T17:00:00Z') };
  const gate = opts.tomtomGate ?? new IntervalGate(TOMTOM_SUMMARY_INTERVAL_MS);
  const policy = new ToolPolicy(config);
  const registry = new ToolRegistry(policy);
  const calls: Harness['calls'] = [];
  const ok =
    (out: ToolOutput): Behaviour =>
    async () =>
      out;
  const behaviours: Record<string, Behaviour> = {
    nearest_rail: ok({ summary: 'rail', data: RAIL_DATA }),
    rail_activity_near: ok({ summary: RAIL_RADIO, data: { coverage_check: {} } }),
    incidents_near: ok({ summary: INCIDENTS, data: { incidents: [] } }),
    weather_alerts: ok(ALERTS),
    air_quality: ok({
      summary: 'Air quality near 42.3314, -83.0458: AQI 42 (Good), PM2.5',
      data: { note: 'EGLE', observations: [{ reporting_area: 'Detroit', values: [] }] },
    }),
    road_closures: ok(CLOSURES),
    border_wait_times: ok(BORDER),
    get_weather: ok({ summary: 'Clear, 5 C', data: { observed_at: '2026-11-14T16:45:00Z' } }),
    get_traffic_flow: ok({ summary: 'Traffic moving', data: { congested_km: 0 } }),
    find_cctv_cameras: ok({ summary: 'No cameras', data: { cameras: [], total: 0 } }),
    ...over,
  };
  const def = (name: string, source: ToolDef['source']): ToolDef => ({
    name,
    description: name,
    source,
    family: source === 'gev' ? 'gev' : 'test',
    inputSchema: { type: 'object' },
    tags: [],
    attribution: `${name} credit`,
    run: (args, ctx) => {
      calls.push({ name, args, ctx });
      return behaviours[name]!(args, ctx);
    },
  });
  for (const n of [
    'nearest_rail',
    'weather_alerts',
    'air_quality',
    'road_closures',
    'border_wait_times',
  ])
    registry.register({
      ...(n === 'road_closures' && opts.roadClosures ? opts.roadClosures : def(n, 'gateway')),
      // As registerWeatherTools does without AIRNOW_API_KEY.
      ...(n === 'air_quality' && opts.airQuality === false
        ? { needsKey: { env: 'AIRNOW_API_KEY', what: 'a free EPA AirNow API key' } }
        : {}),
    });
  for (const n of ['rail_activity_near', 'incidents_near']) registry.register(def(n, 'pulse'));
  registry.setGevTools(
    ['get_weather', 'get_traffic_flow', 'find_cctv_cameras'].map((name) => ({
      name,
      description: name,
      inputSchema: { type: 'object' },
    })),
    (name, args, ctx) => {
      calls.push({ name, args, ctx });
      return behaviours[name]!(args, ctx);
    },
    60_000,
  );
  const runner = new ToolRunner(registry, {
    timeoutMs: 60_000,
    maxConcurrent: 4,
    logger: nullLogger,
    post: {
      publicOrigin: 'https://ui.example',
      gevOrigins: ['http://127.0.0.1:7701'],
      maxResultChars: 100_000,
      imageMaxDim: 768,
      imageMaxBase64Chars: 60_000,
      maxImages: 1,
    },
  });
  const fix =
    opts.fixAgeS === undefined
      ? undefined
      : { ...DETROIT, accuracy_m: 12, device: 'phone', source: 'pwa' };
  return {
    calls,
    policy,
    clock,
    async run(args) {
      const t0 = Date.now();
      const r = await whatsHappeningHere(
        {
          config,
          runner,
          locations: {
            latest: () => (fix ? { ...fix, fix_ts: clock.now - opts.fixAgeS! * 1000 } : undefined),
          } as never,
          budgetMs: opts.budgetMs,
          now: () => clock.now,
          tomtomGate: gate,
        },
        args,
        { signal: new AbortController().signal },
      );
      const text = r.content.map((c) => c.text ?? '').join('\n');
      const json = r.content
        .map((c) => c.text ?? '')
        .find((t) => t.startsWith('{') && t.includes('"sources"'))!;
      return { text, data: JSON.parse(json), ms: Date.now() - t0 };
    },
  };
}

const sourceNames = (d: { sources: Array<{ source: string }> }) => d.sources.map((s) => s.source);
const line = (text: string, label: string) =>
  text.split('\n').find((l) => l.startsWith(`- ${label}`));

describe('whats_happening_here sections', () => {
  it('adds NWS alerts, the top 5 road closures within 5 km and nearby border waits', async () => {
    const h = harness();
    const { text, data } = await h.run(DETROIT);
    expect(sourceNames(data)).toEqual([
      'rail',
      'rail_radio',
      'incidents',
      'weather_alerts',
      'weather',
      'air_quality',
      'traffic',
      'road_closures',
      'border',
      'cameras',
    ]);
    // NWS alerts for the point.
    expect(h.calls.find((c) => c.name === 'weather_alerts')!.args).toEqual({
      lat: DETROIT.lat,
      lon: DETROIT.lon,
    });
    expect(line(text, 'Weather alerts (NWS)')).toMatch(/Winter Weather Advisory/);
    expect(line(text, 'Weather alerts (NWS)')).toMatch(/, at the given point: /);
    // Road closures: every enabled source, top 5 within 5 km.
    expect(h.calls.find((c) => c.name === 'road_closures')!.args).toEqual({
      lat: DETROIT.lat,
      lon: DETROIT.lon,
      radius_km: 5,
      limit: 5,
    });
    const roads = line(text, 'Road closures')!;
    // The total and how many are shown; each line keeps its road and cross streets.
    expect(roads).toMatch(
      /^- Road closures: 11 closures within 5 km; 5 nearest shown \(1 full closure\): /,
    );
    expect(roads).toMatch(
      /FULL CLOSURE: Road closed on Road 0 NB \(City of Detroit permits, 0\.5 km away\)/,
    );
    expect(roads).toContain(
      'Lane closure on Road 1 between Cross A and Cross B (MDOT RIDE, 1.5 km away)',
    );
    expect(roads).toMatch(/Lane closure on Road 4 \(City of Detroit permits, 4\.5 km away\)/);
    expect(roads).not.toMatch(/Road 5/);
    expect(roads).toMatch(/Sources checked: City of Detroit permits: 4; MDOT RIDE: 3\./);
    expect(roads).toMatch(/road_closures lists the rest/);
    expect(roads).not.toMatch(/TomTom|Ontario/);
    const rc = data.sources.find((s) => s.source === 'road_closures')!.data as {
      items: unknown[];
      total: number;
    };
    expect(rc.items).toHaveLength(5);
    expect(rc.total).toBe(11);
    // Border waits: the Detroit/Windsor crossings within 8 km only.
    const border = line(text, 'Border waits')!;
    expect(border).toMatch(/Ambassador Bridge into the US passenger: 10 min/);
    expect(border).toMatch(/Detroit-Windsor Tunnel into the US passenger: 5 min/);
    expect(border).toMatch(/Gordie Howe International Bridge into Canada passenger: no delay/);
    expect(border).not.toMatch(/Blue Water/);
    // Credits for what was shown.
    expect(text).toMatch(/weather_alerts credit/);
    expect(text).toMatch(/City of Detroit Open Data/);
    expect(text).toMatch(/border_wait_times credit/);
  });

  it('passes on the Ontario 511 "as is" disclaimer with its credit when an Ontario item is shown', async () => {
    const ontarioItem = {
      ...closureItem(1),
      text: undefined,
      from_cross_street: null,
      to_cross_street: null,
      source: 'ontario511',
      type: 'Lane closure',
      road: 'Ontario Road',
      distance_km: 4.2,
    };
    const withOntario = (disclaimer: boolean): ToolOutput => ({
      summary: 'road_closures summary',
      data: {
        count: 2,
        items: [closureItem(0), ontarioItem],
        sources: [
          { source: 'detroit_row', label: 'City of Detroit permits', status: 'ok', count: 1 },
          { source: 'ontario511', label: 'Ontario 511', status: 'ok', count: 1 },
        ],
        attribution: ['City of Detroit Open Data', ONTARIO_ATTRIBUTION],
        ...(disclaimer ? { disclaimer: ONTARIO_DISCLAIMER } : {}),
      },
    });
    // As road_closures answers (disclaimer in its data), and from the item's source alone.
    for (const disclaimer of [true, false]) {
      const { text, data } = await harness({
        road_closures: async () => withOntario(disclaimer),
      }).run(DETROIT);
      const roads = line(text, 'Road closures')!;
      const why = `disclaimer in road_closures data: ${disclaimer}`;
      expect(roads, why).toMatch(/Lane closure on Ontario Road \(Ontario 511, 4\.2 km away\)/);
      expect(roads, why).toMatch(/^- Road closures: 2 closures within 5 km; all 2 shown/);
      expect(roads, why).toContain(ONTARIO_DISCLAIMER);
      const rc = data.sources.find((s) => s.source === 'road_closures')!;
      expect(rc.summary).toContain(ONTARIO_DISCLAIMER);
      expect((rc.data as { disclaimer?: string }).disclaimer).toBe(ONTARIO_DISCLAIMER);
      expect(text).toContain(ONTARIO_ATTRIBUTION);
    }
    // Without an Ontario item: no disclaimer.
    const { text, data } = await harness().run(DETROIT);
    expect(text).not.toContain(ONTARIO_DISCLAIMER);
    expect(data.sources.find((s) => s.source === 'road_closures')!.data).not.toHaveProperty(
      'disclaimer',
    );
  });

  it('the weather line is in °F and mph (GEV reports °C and km/h)', async () => {
    const { text, data } = await harness({
      get_weather: async () => ({
        summary: 'Weather at 42.3314, -83.0458: light snow, -1°C, wind 19 km/h.',
        data: {
          weather: {
            observed_at: '2026-11-14T16:45:00Z',
            conditions: 'light snow',
            temperature_c: -1.2,
            wind_kph: 19.3,
          },
        },
      }),
    }).run(DETROIT);
    expect(line(text, 'Weather:')).toMatch(
      /^- Weather: Weather at 42\.3314, -83\.0458: light snow, 30°F \(-1°C\), wind 12 mph\./,
    );
    // No temperature in °C alone, and no km/h.
    expect(text).not.toMatch(/(?<!°F \(-?)\d+°C|km\/h/);
    const w = data.sources.find((s) => s.source === 'weather')!.data as {
      weather: Record<string, number>;
    };
    expect(w.weather).toMatchObject({ temperature_f: 29.8, wind_mph: 12 });
  });

  it('the rail and Pulse sections read exactly as before', async () => {
    const { text, data } = await harness().run(DETROIT);
    expect(line(text, 'Rail line & crossing')).toBe(
      `- Rail line & crossing: ${railLine(RAIL_DATA as never)}`,
    );
    expect(line(text, 'Rail radio (Pulse)')).toBe(`- Rail radio (Pulse): ${RAIL_RADIO}`);
    expect(line(text, 'Incidents (Pulse)')).toBe(`- Incidents (Pulse): ${INCIDENTS}`);
    expect(data.sources.find((s) => s.source === 'rail_radio')).toMatchObject({
      status: 'ok',
      summary: RAIL_RADIO,
    });
  });

  it('border waits only near a crossing: none in Ann Arbor, the Blue Water Bridge in Port Huron', async () => {
    const aa = harness();
    const r = await aa.run(ANN_ARBOR);
    // Not asked away from a crossing, but never dropped silently.
    expect(aa.calls.some((c) => c.name === 'border_wait_times')).toBe(false);
    expect(line(r.text, 'Border waits')).toBe(
      '- Border waits: none: no Detroit/Windsor or Port Huron crossing within 8 km',
    );
    const ph = await harness().run(PORT_HURON);
    const border = line(ph.text, 'Border waits')!;
    expect(border).toMatch(/Blue Water Bridge into the US passenger: 25 min/);
    expect(border).not.toMatch(/Ambassador|Tunnel|Gordie/);
  });

  it('air quality: the AQI when configured, "not configured (AIRNOW_API_KEY)" without its key', async () => {
    const off = harness({}, { airQuality: false });
    const r = await off.run(DETROIT);
    // Never dropped silently, and nothing is fetched.
    expect(off.calls.some((c) => c.name === 'air_quality')).toBe(false);
    expect(line(r.text, 'Air quality')).toBe(
      '- Air quality (AirNow): not configured (AIRNOW_API_KEY)',
    );
    expect(r.data.sources.find((s) => s.source === 'air_quality')).toMatchObject({
      status: 'not_configured',
    });
    const on = await harness().run(DETROIT);
    expect(line(on.text, 'Air quality (AirNow)')).toMatch(/AQI 42 \(Good\)/);
  });

  it('cameras: listed when in range, "none in range" or the error otherwise (never dropped)', async () => {
    const none = await harness().run(DETROIT);
    expect(line(none.text, 'Cameras')).toBe('- Cameras: none in range (within 3 km)');
    expect(none.data.sources.find((s) => s.source === 'cameras')).toMatchObject({
      status: 'ok',
      data: { total: 0, cameras: [] },
    });
    const failing = await harness({
      find_cctv_cameras: async () => ({ summary: 'GEV error', isError: true }),
    }).run(DETROIT);
    expect(line(failing.text, 'Cameras')).toBe('- Cameras (error): GEV error');
    const one = await harness({
      find_cctv_cameras: async () => ({
        summary: '1 camera',
        data: {
          total: 1,
          cameras: [{ id: 'c1', name: 'Bridge cam', distance_km: 1.2, provider: 'x', extra: 'y' }],
        },
      }),
    }).run(DETROIT);
    expect(line(one.text, 'Cameras')).toBe('- Cameras: 1 camera');
    expect(one.data.sources.find((s) => s.source === 'cameras')!.data).toEqual({
      total: 1,
      cameras: [{ id: 'c1', name: 'Bridge cam', distance_km: 1.2, provider: 'x' }],
    });
  });

  it('the alert line says "at your location (phone fix N old)" for the phone, "at the given point" otherwise', async () => {
    const phone = await harness({}, { fixAgeS: 240 }).run({});
    expect(line(phone.text, 'Weather alerts (NWS)')).toMatch(
      /^- Weather alerts \(NWS\): 1 active NWS alert\(s\) for zone MIZ076 \(Wayne, MI\), at your location \(phone fix 4 min old\): /,
    );
    expect(phone.text).not.toMatch(/given point/);
    const given = await harness({}, { fixAgeS: 240 }).run(DETROIT);
    expect(line(given.text, 'Weather alerts (NWS)')).toMatch(/, at the given point: /);
    // No active alerts reads the same way.
    const quiet = await harness(
      {
        weather_alerts: async () => ({
          summary: 'No active alerts for zone MIZ076 (Wayne, MI), at the given point.',
          data: { count: 0, alerts: [] },
        }),
      },
      { fixAgeS: 120 },
    ).run({});
    expect(line(quiet.text, 'Weather alerts (NWS)')).toBe(
      '- Weather alerts (NWS): No active alerts for zone MIZ076 (Wayne, MI), at your location (phone fix 2 min old).',
    );
  });

  it('asks TomTom at most every 15 min (no caching) and shows the requests left when it does', async () => {
    const TOMTOM_ON = { TOMTOM_API_KEY: 'k', ALLOW_TOMTOM_INCIDENTS: 'true' };
    let left = 60;
    const closures: Behaviour = async (_a, ctx) => {
      const skip = ctx.skipRoadSources?.tomtom;
      if (!skip) left--;
      return {
        summary: 'road_closures',
        data: {
          count: 1,
          total: 1,
          items: [closureItem(0)],
          sources: [
            { source: 'detroit_row', label: 'City of Detroit permits', status: 'ok', count: 1 },
            skip
              ? {
                  source: 'tomtom',
                  label: 'TomTom incidents',
                  status: 'skipped',
                  count: 0,
                  note: skip,
                }
              : {
                  source: 'tomtom',
                  label: 'TomTom incidents',
                  status: 'ok',
                  count: 0,
                  found: 2,
                  quota: { remaining: left, max: 60 },
                },
          ],
        },
      };
    };
    const h = harness({ road_closures: closures }, { env: TOMTOM_ON });
    const first = await h.run(DETROIT);
    expect(line(first.text, 'Road closures')).toMatch(
      /TomTom incidents: 2 \(59 of 60 requests left today\)/,
    );
    // Within 15 min: TomTom is left out of the call (not served from a cache) and the line says so.
    h.clock.now += 14 * 60_000;
    const second = await h.run(DETROIT);
    expect(line(second.text, 'Road closures')).toContain(
      'TomTom incidents skipped to save the daily quota; ask road_closures for them',
    );
    expect(left).toBe(59);
    const ctxs = h.calls.filter((c) => c.name === 'road_closures').map((c) => c.ctx);
    expect(ctxs[0]!.skipRoadSources).toBeUndefined();
    expect(ctxs[1]!.skipRoadSources).toEqual({
      tomtom: 'skipped to save the daily quota; ask road_closures for them',
    });
    // 15 min after the last use: asked again.
    h.clock.now += 60_000;
    const third = await h.run(DETROIT);
    expect(line(third.text, 'Road closures')).toMatch(
      /TomTom incidents: 2 \(58 of 60 requests left today\)/,
    );
    // Without TomTom configured nothing is held back.
    const off = harness({ road_closures: closures });
    await off.run(DETROIT);
    await off.run(DETROIT);
    expect(
      off.calls.filter((c) => c.name === 'road_closures').map((c) => c.ctx.skipRoadSources),
    ).toEqual([undefined, undefined]);
  });

  it('a slot TomTom did not use (daily cap reached) is given back', async () => {
    const env = { TOMTOM_API_KEY: 'k', ALLOW_TOMTOM_INCIDENTS: 'true' };
    let capped = true;
    const h = harness(
      {
        road_closures: async () => ({
          summary: 'road_closures',
          data: {
            count: 0,
            items: [],
            sources: [
              capped
                ? {
                    source: 'tomtom',
                    label: 'TomTom incidents',
                    status: 'quota',
                    count: 0,
                    note: 'daily cap of 60 TomTom incident requests reached; resets at midnight (Detroit time)',
                    quota: { remaining: 0, max: 60 },
                  }
                : {
                    source: 'tomtom',
                    label: 'TomTom incidents',
                    status: 'ok',
                    count: 0,
                    quota: { remaining: 12, max: 60 },
                  },
            ],
          },
        }),
      },
      { env },
    );
    const r = await h.run(DETROIT);
    expect(line(r.text, 'Road closures')).toMatch(/TomTom incidents: daily cap of 60 .* reached/);
    capped = false;
    h.clock.now += 60_000;
    const again = await h.run(DETROIT);
    expect(line(again.text, 'Road closures')).toMatch(
      /TomTom incidents: 0 \(12 of 60 requests left today\)/,
    );
  });

  it('with the real road_closures: one TomTom request across calls 5 min apart, two after 15 min', async () => {
    const roads = roadsHarness(ALL_KEYS);
    try {
      const h = harness({}, { env: ALL_KEYS, roadClosures: roads.tools.road_closures });
      const a = await h.run(DETROIT);
      expect(roads.mock.count(/tomtom/)).toBe(1);
      expect(line(a.text, 'Road closures')).toMatch(
        /TomTom incidents: \d+ \(59 of 60 requests left today\)/,
      );
      h.clock.now += 5 * 60_000;
      const b = await h.run(DETROIT);
      expect(roads.mock.count(/tomtom/)).toBe(1);
      expect(line(b.text, 'Road closures')).toContain(
        'TomTom incidents skipped to save the daily quota; ask road_closures for them',
      );
      // road_closures itself still asks TomTom (never answered from a cache).
      await roads.run('road_closures', { ...DETROIT, radius_km: 5 });
      expect(roads.mock.count(/tomtom/)).toBe(2);
      h.clock.now += 15 * 60_000;
      await h.run(DETROIT);
      expect(roads.mock.count(/tomtom/)).toBe(3);
    } finally {
      rmSync(roads.dir, { recursive: true, force: true });
    }
  });

  it('with the real road_closures: a stretch reported per direction is one closure, counted once', async () => {
    const env = {
      ...ALL_KEYS,
      MDOT_RIDE_API_KEY: '',
      ONTARIO_511_API_KEY: '',
      DETROIT_ROW_ENABLED: 'false',
    };
    // TomTom's two items plus one stretch reported once per direction: four reports, three closures.
    const roads = roadsHarness(env, {
      routes: [
        [
          /api\.tomtom\.com/,
          () =>
            json({
              incidents: [
                ...TOMTOM.incidents,
                unnamedClosure('tt-nb', CLOSED_NB, 'Alpha St', 'Bravo St'),
                unnamedClosure('tt-sb', CLOSED_SB, 'Bravo St', 'Alpha St'),
              ],
            }),
        ],
      ],
    });
    try {
      const h = harness({}, { env, roadClosures: roads.tools.road_closures });
      const roadsLine = line((await h.run(DETROIT)).text, 'Road closures')!;
      expect(roadsLine).toMatch(
        /^- Road closures: 3 closures within 5 km; all 3 shown \(2 full closures\): /,
      );
      // road_closures' own line for the item, its source named last.
      expect(roadsLine).toContain(
        'Unknown road: road closed between Alpha St and Bravo St (both directions, 0.5 km away, TomTom incidents)',
      );
      // The source's count agrees with the total: stretches, not reports.
      expect(roadsLine).toContain(
        'Sources checked: TomTom incidents: 3 (59 of 60 requests left today).',
      );
    } finally {
      rmSync(roads.dir, { recursive: true, force: true });
    }
  });

  it('each section fails on its own, within its timeout and the overall budget', async () => {
    const hang: Behaviour = (_a, ctx) =>
      new Promise((_resolve, reject) =>
        ctx.signal.addEventListener('abort', () => reject(new Error('aborted'))),
      );
    const h = harness(
      {
        weather_alerts: hang,
        road_closures: async () => {
          throw new Error('upstream exploded');
        },
        border_wait_times: async () => ({ summary: 'CBP down', isError: true }),
        get_traffic_flow: hang,
      },
      { budgetMs: 1_500 },
    );
    const { text, data, ms } = await h.run(DETROIT);
    expect(ms).toBeLessThan(4_000);
    const by = (s: string) => data.sources.find((x) => x.source === s)!;
    expect(by('weather_alerts').status).toBe('error');
    expect(by('weather_alerts').summary).toMatch(/did not finish within/);
    expect(by('traffic').status).toBe('error');
    expect(by('road_closures').status).toBe('error');
    expect(by('road_closures').summary).toMatch(/upstream exploded/);
    expect(by('border').status).toBe('error');
    // The others are unaffected.
    for (const s of ['rail', 'rail_radio', 'incidents', 'weather', 'air_quality'])
      expect(by(s).status, s).toBe('ok');
    expect(line(text, 'Weather alerts (NWS) (error)')).toBeDefined();
  });
});
