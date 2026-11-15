/**
 * geocode_place (Census -> Photon -> capped Nominatim, Overpass intersections, disk cache),
 * route_avoiding_closures (Valhalla with exclude_polygons from road_closures geometry) and
 * mdot_camera_link (a Mi Drive link, nothing fetched). All HTTP is mocked.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RoadItem } from '../src/extra/roads/closures.js';
import { decodePolyline, ringPerimeterM } from '../src/extra/roads/geo.js';
import { Pacer } from '../src/extra/roads/http.js';
import {
  ATTRIBUTION as GEO_ATTRIBUTION,
  parseIntersection,
  roadFilter,
} from '../src/extra/roads/geocode.js';
import {
  VALHALLA_ATTRIBUTION,
  atTripEnds,
  closuresOnRoute,
  excludeRings,
} from '../src/extra/roads/route.js';
import { DETROIT_ATTRIBUTION } from '../src/extra/roads/sources/detroitRow.js';
import { MDOT_ATTRIBUTION } from '../src/extra/roads/sources/mdotRide.js';
import { ONTARIO_ATTRIBUTION, ONTARIO_DISCLAIMER } from '../src/extra/roads/sources/ontario511.js';
import {
  ALL_KEYS,
  COMERICA_PARK,
  MDOT_WORK_ZONES,
  NOW,
  ONTARIO_CONSTRUCTION,
  encodePolyline,
  harness,
  header,
  json,
  line,
  type Harness,
} from './fixtures/roads.js';
import { BELLE_ISLE, DETROIT } from './helpers.js';

const made: Harness[] = [];
const h = (...a: Parameters<typeof harness>) => {
  const x = harness(...a);
  made.push(x);
  return x;
};
afterEach(() => {
  for (const x of made.splice(0)) rmSync(x.dir, { recursive: true, force: true });
});

type Place = {
  name: string;
  lat: number;
  lon: number;
  source: string;
  kind: string;
  attribution: string;
  in_region: boolean;
  distance_km?: number;
};
const placesOf = (out: { data?: unknown }) => (out.data as { places: Place[] }).places;
const triedOf = (out: { data?: unknown }) =>
  (out.data as { tried: Array<{ source: string; status: string; note?: string }> }).tried;

describe('geocode_place', () => {
  it('sends street addresses to the Census Geocoder first', async () => {
    const x = h();
    const out = await x.run('geocode_place', { query: '2100 Woodward Ave, Detroit' });
    expect(out.isError).toBeFalsy();
    expect(placesOf(out)[0]).toMatchObject({
      name: '2100 WOODWARD AVE, DETROIT, MI, 48201',
      source: 'census',
      kind: 'address',
      in_region: true,
      attribution: 'U.S. Census Bureau Geocoder (public domain)',
    });
    expect(x.mock.count(/photon/)).toBe(0);
    const q = x.mock.last(/census/)!.url.searchParams;
    expect(q.get('benchmark')).toBe('Public_AR_Current');
    expect(q.get('address')).toBe('2100 Woodward Ave, Detroit, MI');
  });

  it('sends place names to Photon, in-region first, with ODbL attribution', async () => {
    const x = h();
    const out = await x.run('geocode_place', { query: 'Comerica Park' });
    expect(x.mock.count(/census/)).toBe(0);
    const ps = placesOf(out);
    expect(ps[0]).toMatchObject({
      name: 'Comerica Park',
      source: 'photon',
      kind: 'leisure:stadium',
      in_region: true,
    });
    expect(ps[0]!.attribution).toContain('© OpenStreetMap contributors (ODbL)');
    expect(ps[1]!.in_region).toBe(false);
    // The summary names the place, not the geocoder (that is in data and the attribution).
    expect(out.summary).toContain(
      'Best: Comerica Park (2100 Woodward Avenue, Detroit, MI, 48201, United States) at 42.33922, -83.04886.',
    );
    // Biased to SE Michigan, not to anything about the user.
    const q = x.mock.last(/photon\.komoot\.io\/api/)!.url.searchParams;
    expect(Number(q.get('lat'))).toBeCloseTo(42.45, 2);
    expect(Number(q.get('lon'))).toBeCloseTo(-83.3, 2);
  });

  it('sorts by distance from "near" without putting the point in the cache', async () => {
    const x = h();
    // Downtown Grand Rapids: the Grand Rapids match comes first.
    const out = await x.run('geocode_place', {
      query: 'Comerica Park',
      near: { lat: 42.9634, lon: -85.6681 },
      limit: 2,
    });
    expect(placesOf(out).map((p) => p.name)).toEqual(['Comerica', 'Comerica Park']);
    expect(placesOf(out)[0]!.distance_km).toBe(0.4);
    expect(out.summary).toContain(
      'Best: Comerica (Grand Rapids, Michigan) at 42.96000, -85.67000, 0.4 km away.',
    );
    const again = await x.run('geocode_place', { query: 'comerica park', near: DETROIT });
    expect(again.summary).toContain('(cached answer)');
    expect(placesOf(again)[0]!.name).toBe('Comerica Park');
    expect(x.mock.count(/photon/)).toBe(1);
    const file = readFileSync(path.join(x.dir, 'cache', 'geocode.json'), 'utf8');
    expect(file).not.toContain('42.9634');
    expect(file).not.toContain('-85.6681');
    expect(file).not.toContain(String(DETROIT.lat));
  });

  it('falls back to Nominatim at most 1/s and N/day, and caches it on disk', async () => {
    const x = h({ GEOCODER_NOMINATIM_DAILY_MAX: '2' });
    const out = await x.run('geocode_place', { query: 'Belle Isle Park' });
    expect(placesOf(out)[0]).toMatchObject({
      name: 'Belle Isle Park',
      source: 'nominatim',
      in_region: true,
    });
    expect(triedOf(out).map((t) => `${t.source}:${t.status}`)).toEqual([
      'photon:no_match',
      'nominatim:ok',
    ]);
    const q = x.mock.last(/nominatim/)!;
    expect(q.url.searchParams.get('viewbox')).toBe('-84.2,43.2,-82.4,41.7');
    expect(q.url.searchParams.get('bounded')).toBe('0');
    expect(header(q.init, 'user-agent')).toBe(
      'godseye-connector/0.1 (personal non-commercial MCP gateway)',
    );
    // Cached on disk (mode 600): a restarted gateway answers without asking again.
    const file = path.join(x.dir, 'cache', 'geocode.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    const y = h({ GEOCODER_NOMINATIM_DAILY_MAX: '2' }, { dir: x.dir });
    const again = await y.run('geocode_place', { query: 'Belle Isle Park' });
    expect(again.summary).toContain('(cached answer)');
    expect(y.mock.calls).toHaveLength(0);
    // The daily cap: one more lookup, then "quota".
    await y.run('geocode_place', { query: 'Nowhere One' });
    const third = await y.run('geocode_place', { query: 'Nowhere Two' });
    expect(triedOf(third).find((t) => t.source === 'nominatim')!.status).toBe('quota');
    expect(y.mock.count(/nominatim/)).toBe(1);
    expect(
      JSON.parse(readFileSync(path.join(x.dir, 'cache', 'nominatim-usage.json'), 'utf8')).count,
    ).toBe(2);
  });

  it('caches a Nominatim answer even when an earlier geocoder errored', async () => {
    const x = h({}, { routes: [[/photon\.komoot\.io\/api/, () => json({}, 503)]] });
    const out = await x.run('geocode_place', { query: 'Belle Isle' });
    expect(placesOf(out)[0]).toMatchObject({ name: 'Belle Isle Park', source: 'nominatim' });
    expect(triedOf(out).map((t) => `${t.source}:${t.status}`)).toEqual([
      'photon:error',
      'nominatim:ok',
    ]);
    const again = await x.run('geocode_place', { query: 'Belle Isle' });
    expect(placesOf(again)[0]!.name).toBe('Belle Isle Park');
    expect((again.data as { cached: boolean }).cached).toBe(true);
    expect(again.summary).toContain('(cached answer)');
    expect(x.mock.count(/nominatim/)).toBe(1);
    expect(x.mock.count(/photon/)).toBe(1);
    // Kept for a day, not a month: Photon gets another chance once it is back.
    x.clock.now += 86_400_000 + 1_000;
    await x.run('geocode_place', { query: 'Belle Isle' });
    expect(x.mock.count(/photon/)).toBe(2);
  });

  it('does not cache an empty answer when a geocoder errored', async () => {
    const x = h(
      {},
      {
        routes: [
          [/photon\.komoot\.io\/api/, () => json({}, 503)],
          [/nominatim\.openstreetmap\.org\/search/, () => json({}, 503)],
        ],
      },
    );
    const out = await x.run('geocode_place', { query: 'Belle Isle' });
    expect(out).toMatchObject({ isError: true, errorKind: 'upstream' });
    await x.run('geocode_place', { query: 'Belle Isle' });
    expect(x.mock.count(/photon/)).toBe(2);
    expect(x.mock.count(/nominatim/)).toBe(2);
  });

  it('never calls Nominatim when its daily max is 0', async () => {
    const x = h({ GEOCODER_NOMINATIM_DAILY_MAX: '0' });
    const out = await x.run('geocode_place', { query: 'Belle Isle Park' });
    expect(x.mock.count(/nominatim/)).toBe(0);
    expect(placesOf(out)).toEqual([]);
    expect(out.summary).toContain('No match');
  });

  it('spaces Nominatim and Valhalla requests at least a second apart', async () => {
    let now = 0;
    const waits: number[] = [];
    const p = new Pacer(
      1100,
      () => now,
      async (ms) => {
        waits.push(ms);
        now += ms;
      },
    );
    await p.wait();
    await p.wait();
    now += 300;
    await p.wait();
    expect(waits).toEqual([1100, 800]);
  });

  /** The Overpass query text of each call to the mock, in order. */
  const overpassQueries = (x: ReturnType<typeof h>) =>
    x.mock.calls
      .filter((c) => /overpass/.test(c.url.href))
      .map((c) => new URLSearchParams(String(c.init.body)).get('data')!);
  const SHARED_NODE = /node\.na\.nb;/;
  const PROXIMITY = /\(around\.b:30\)/;

  it('finds a street intersection by a node both roads share, in one Overpass query', async () => {
    const x = h(
      { OVERPASS_URL: 'http://overpass.invalid/api/interpreter' },
      {
        routes: [
          [
            /overpass\.invalid/,
            (_u, init) => {
              const q = new URLSearchParams(String(init.body)).get('data')!;
              return SHARED_NODE.test(q)
                ? json({ elements: [{ type: 'node', id: 11, lat: 42.4453, lon: -83.1252 }] })
                : json({ elements: [] });
            },
          ],
        ],
      },
    );
    const out = await x.run('geocode_place', { query: 'Woodward & 8 Mile' });
    expect(placesOf(out)[0]).toMatchObject({
      source: 'overpass',
      kind: 'intersection',
      lat: 42.4453,
      lon: -83.1252,
    });
    const qs = overpassQueries(x);
    expect(qs).toHaveLength(1);
    expect(qs[0]).toMatch(SHARED_NODE);
    expect(qs[0]).toContain('["name"~"(^| )woodward( |$)",i]');
    expect(qs[0]).toContain('["name"~"(^| )(8|eight) mile( |$)",i]');
    expect(qs[0]).toMatch(/node\(w\.a\)->\.na;node\(w\.b\)->\.nb;/);
    expect(x.mock.last(/overpass/)!.init.method).toBe('POST');
  });

  it('falls back to ways of one road within 30 m of the other for grade-separated interchanges', async () => {
    const i94 = line({ lat: 42.36, lon: -83.1 }, { lat: 42.37, lon: -83.0 }, 20).map(
      ([lon, lat]) => ({ lat, lon }),
    );
    const m10 = line({ lat: 42.32, lon: -83.0603 }, { lat: 42.42, lon: -83.0597 }, 20).map(
      ([lon, lat]) => ({ lat: lat + 0.0001, lon }),
    );
    const ways = {
      elements: [
        {
          type: 'way',
          tags: { highway: 'motorway', ref: 'I 94', layer: '1' },
          nodes: i94.map((_, i) => i + 1),
          geometry: i94,
        },
        {
          type: 'way',
          tags: { highway: 'motorway', ref: 'M 10' },
          nodes: m10.map((_, i) => i + 100),
          geometry: m10,
        },
      ],
    };
    const x = h(
      { OVERPASS_URL: 'http://overpass.invalid/api/interpreter' },
      {
        routes: [
          [
            /overpass\.invalid/,
            (_u, init) => {
              const q = new URLSearchParams(String(init.body)).get('data')!;
              // No shared node (the freeways cross on a bridge); the proximity query finds them.
              return SHARED_NODE.test(q) ? json({ elements: [] }) : json(ways);
            },
          ],
        ],
      },
    );
    const out = await x.run('geocode_place', { query: 'I-94 and M-10' });
    const p = placesOf(out)[0]!;
    // The roads cross (one over the other): no distance worth giving.
    expect(p).toMatchObject({ name: 'interchange of I-94 and M-10', kind: 'interchange' });
    expect(out.summary).toContain('Best: interchange of I-94 and M-10 at 42.36');
    expect(JSON.stringify(out)).not.toMatch(/within \d+ m/);
    expect(p.lat).toBeCloseTo(42.364, 2);
    expect(p.lon).toBeCloseTo(-83.06, 2);
    const qs = overpassQueries(x);
    expect(qs).toHaveLength(2);
    expect(qs[0]).toMatch(SHARED_NODE);
    expect(qs[1]).toMatch(PROXIMITY);
    expect(qs[1]).toContain('["ref"~"(^|;) *I[ -]?94( |;|$)",i]');
    expect(qs[1]).toMatch(/way\.b\(around\.a:30\)/);
  });

  it('gives the closest approach of an interchange only when it is more than 10 m', async () => {
    // Road B ends 18 m short of road A (a ramp that never meets it).
    const a = line({ lat: 42.4, lon: -83.1 }, { lat: 42.4, lon: -83.05 }, 10).map(([lon, lat]) => ({
      lat,
      lon,
    }));
    const b = [
      { lat: 42.40016, lon: -83.075 },
      { lat: 42.45, lon: -83.075 },
    ];
    const x = h(
      { OVERPASS_URL: 'http://overpass.invalid/api/interpreter' },
      {
        routes: [
          [
            /overpass\.invalid/,
            (_u, init) =>
              SHARED_NODE.test(new URLSearchParams(String(init.body)).get('data')!)
                ? json({ elements: [] })
                : json({
                    elements: [
                      {
                        type: 'way',
                        tags: { highway: 'primary', name: 'Alpha Road' },
                        geometry: a,
                      },
                      {
                        type: 'way',
                        tags: { highway: 'primary', name: 'Bravo Road' },
                        geometry: b,
                      },
                    ],
                  }),
          ],
        ],
      },
    );
    const out = await x.run('geocode_place', { query: 'Alpha Road and Bravo Road' });
    expect(placesOf(out)[0]).toMatchObject({
      name: 'interchange of Alpha Road and Bravo Road',
      kind: 'interchange (the roads come within 18 m of each other)',
    });
  });

  it('does not serve an intersection answer cached with the old wording', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gw-roads-'));
    mkdirSync(path.join(dir, 'cache'), { recursive: true, mode: 0o700 });
    const old = {
      places: [
        {
          name: 'I-94 & M-10',
          address: null,
          lat: 42.364,
          lon: -83.06,
          kind: 'interchange (grade-separated: the roads pass within 0 m)',
          source: 'overpass',
          attribution: GEO_ATTRIBUTION.overpass,
          in_region: true,
        },
      ],
      attempts: [{ source: 'overpass', status: 'ok' }],
    };
    writeFileSync(
      path.join(dir, 'cache', 'geocode.json'),
      JSON.stringify({ 'v2|op|i-94 and m-10': { v: old, exp: NOW + 86_400_000 } }),
      { mode: 0o600 },
    );
    const x = h(
      { OVERPASS_URL: 'http://overpass.invalid/api/interpreter' },
      {
        dir,
        routes: [
          [
            /overpass\.invalid/,
            () => json({ elements: [{ type: 'node', id: 1, lat: 42.3641, lon: -83.0601 }] }),
          ],
        ],
      },
    );
    const out = await x.run('geocode_place', { query: 'I-94 and M-10' });
    expect(out.summary).not.toContain('(cached answer)');
    expect(x.mock.count(/overpass\.invalid/)).toBe(1);
    expect(JSON.stringify(out)).not.toContain('pass within');
  });

  it('roads that never come within 30 m are no intersection: the other geocoders are tried', async () => {
    const far = (lat: number) =>
      line({ lat, lon: -83.1 }, { lat, lon: -83.0 }, 10).map(([lon, la]) => ({ lat: la, lon }));
    const x = h(
      { OVERPASS_URL: 'http://overpass.invalid/api/interpreter' },
      {
        routes: [
          [
            /overpass\.invalid/,
            (_u, init) => {
              const q = new URLSearchParams(String(init.body)).get('data')!;
              if (SHARED_NODE.test(q)) return json({ elements: [] });
              // Overpass's around is generous; the gateway checks the 30 m itself.
              return json({
                elements: [
                  {
                    type: 'way',
                    tags: { highway: 'primary', name: 'Alpha Road' },
                    geometry: far(42.4),
                  },
                  {
                    type: 'way',
                    tags: { highway: 'primary', name: 'Bravo Road' },
                    geometry: far(42.401),
                  },
                ],
              });
            },
          ],
        ],
      },
    );
    const out = await x.run('geocode_place', { query: 'Alpha Road and Bravo Road' });
    expect(triedOf(out)[0]).toMatchObject({ source: 'overpass', status: 'no_match' });
    expect(overpassQueries(x)).toHaveLength(2);
  });

  it('says intersections need Overpass when it is not configured', async () => {
    const x = h();
    const out = await x.run('geocode_place', { query: 'I-94 and M-10' });
    expect(triedOf(out)[0]).toMatchObject({ source: 'overpass', status: 'not_configured' });
    expect(out.summary).toContain('set OVERPASS_URL');
  });

  it('parses intersections and road filters', () => {
    expect(parseIntersection('I-94 and M-10')).toEqual(['I-94', 'M-10']);
    expect(parseIntersection('Gratiot at Conner, Detroit')).toEqual(['Gratiot', 'Conner']);
    expect(parseIntersection('I-94/M-10')).toEqual(['I-94', 'M-10']);
    expect(parseIntersection('Woodward&Grand River')).toEqual(['Woodward', 'Grand River']);
    expect(parseIntersection('2100 Woodward and more')).toBeUndefined();
    expect(parseIntersection('Comerica Park')).toBeUndefined();
    expect(roadFilter('US-24')!.test({ ref: 'US 24;M 10' })).toBe(true);
    expect(roadFilter('US-24')!.test({ ref: 'US 240' })).toBe(false);
    expect(roadFilter('Hwy 401')!.test({ ref: '401' })).toBe(true);
  });

  it('reads the phone for near: "here"', async () => {
    const x = h({}, { deps: { locations: { latest: () => undefined } as never } });
    const out = await x.run('geocode_place', { query: 'Comerica Park', near: 'here' });
    expect(out.isError).toBe(true);
    expect(x.mock.calls).toHaveLength(0);
  });
});

/** A route from downtown Detroit to Belle Isle, straight through the M-10 closure fixture. */
function valhallaRoutes(seen: Array<Record<string, unknown>>, opts: { failSecond?: boolean } = {}) {
  const closure = MDOT_WORK_ZONES.features[1]!.geometry.coordinates as Array<[number, number]>;
  const direct = [
    ...line(DETROIT, { lat: closure[0]![1], lon: closure[0]![0] }, 10),
    ...line(
      { lat: closure[0]![1], lon: closure[0]![0] },
      { lat: closure[1]![1], lon: closure[1]![0] },
      4,
    ),
    ...line({ lat: closure[1]![1], lon: closure[1]![0] }, BELLE_ISLE, 10),
  ];
  const detour = line(DETROIT, { lat: 42.36, lon: -83.02 }, 10).concat(
    line({ lat: 42.36, lon: -83.02 }, BELLE_ISLE, 10),
  );
  const answer = (shape: Array<[number, number]>, km: number) =>
    json({
      trip: {
        summary: { length: km, time: 900 },
        units: 'miles',
        status: 0,
        legs: [
          {
            shape: encodePolyline(shape, 6),
            maneuvers: [
              {
                type: 1,
                instruction: 'Drive northeast on East Montcalm Street.',
                street_names: ['East Montcalm Street'],
                length: 0.09,
                time: 19.4,
              },
              {
                type: 10,
                instruction: 'Turn right onto <b>Brush Street</b>.',
                street_names: ['Brush Street'],
                length: 0.26,
                time: 43,
              },
            ],
          },
        ],
      },
    });
  return [
    [
      /valhalla1\.openstreetmap\.de\/route/,
      (_u: URL, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        seen.push(body);
        if (body.exclude_polygons && opts.failSecond)
          return json(
            { error_code: 442, error: 'No path could be found for input', status_code: 400 },
            400,
          );
        return body.exclude_polygons ? answer(detour, 5.2) : answer(direct, 4.9);
      },
    ],
  ] as Array<[RegExp, (u: URL, init: RequestInit) => Response]>;
}

describe('route_avoiding_closures', () => {
  it('routes around a full closure on the way, and says so', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const x = h({ ...ALL_KEYS }, { routes: valhallaRoutes(seen) });
    const out = await x.run('route_avoiding_closures', { from: DETROIT, to: BELLE_ISLE });
    expect(out.isError).toBeFalsy();
    expect(seen).toHaveLength(2);
    expect(seen[0]!.exclude_polygons).toBeUndefined();
    expect(seen[0]).toMatchObject({ costing: 'auto', units: 'miles' });
    const rings = seen[1]!.exclude_polygons as Array<Array<[number, number]>>;
    expect(rings.length).toBeGreaterThan(0);
    for (const r of rings) {
      expect(r[0]).toEqual(r[r.length - 1]);
      // Small rings around the closure (lon, lat order), nowhere near the endpoints.
      for (const [lon, lat] of r) {
        expect(lon).toBeGreaterThan(-83.06);
        expect(lon).toBeLessThan(-83.05);
        expect(lat).toBeGreaterThan(42.33);
        expect(lat).toBeLessThan(42.34);
      }
    }
    const d = out.data as {
      distance: number;
      units: string;
      duration_min: number;
      maneuvers: Array<{ instruction: string; street_names: string[] }>;
      closures_avoided: Array<{ road: string; source: string }>;
      warnings: string[];
      attribution: string;
    };
    expect(d.distance).toBe(5.2);
    expect(d.units).toBe('mi');
    expect(d.duration_min).toBe(15);
    expect(d.maneuvers[1]).toMatchObject({
      instruction: 'Turn right onto Brush Street.',
      street_names: ['Brush Street'],
    });
    expect(d.closures_avoided).toEqual([
      expect.objectContaining({
        road: 'M-10',
        source: 'mdot_ride',
        description: 'All lanes closed, follow detour',
      }),
    ]);
    // Valhalla's credit, and MDOT's for the closure text it returns (never TomTom's: unused).
    expect(d.attribution).toEqual([
      'Routing: Valhalla/FOSSGIS, data © OpenStreetMap contributors (ODbL); fix the map: https://www.openstreetmap.org/fixthemap',
      MDOT_ATTRIBUTION,
    ]);
    expect(out.summary).toContain(`Closure data: ${MDOT_ATTRIBUTION}.`);
    expect(out.data).not.toHaveProperty('disclaimer');
    expect(out.summary).not.toContain('"as is"');
    expect(out.summary).toContain('Avoids 1 closure(s)');
    // TomTom is never used for routing (no navigation use under its terms).
    expect(x.mock.count(/tomtom/)).toBe(0);
    const src = (out.data as { closure_sources: Array<{ source: string; status: string }> })
      .closure_sources;
    expect(src.find((s) => s.source === 'tomtom')!.status).toBe('skipped');
    // The summary says so, and that this route does account for the other sources.
    expect(out.summary).toContain(
      "Closures from TomTom are not used for routing (TomTom's licence excludes navigation use).",
    );
    expect(out.summary).not.toContain('No closure data');
    expect((out.data as { closures_accounted_for: boolean }).closures_accounted_for).toBe(true);
  });

  it('says plainly when no closure data was available to avoid', async () => {
    const seen: Array<Record<string, unknown>> = [];
    // The city permits fail and every other source is off: the route ignores closures.
    const x = h({}, { routes: [...valhallaRoutes(seen), [/arcgis/, () => json({}, 500)]] });
    const out = await x.run('route_avoiding_closures', { from: DETROIT, to: BELLE_ISLE });
    expect(out.isError).toBeFalsy();
    expect(seen).toHaveLength(1);
    expect(out.summary).toContain(
      'No closure data was available to avoid, so this route does not account for closures (City of Detroit permits: City of Detroit permits returned HTTP 500; MDOT RIDE: not configured: set MDOT_RIDE_API_KEY in deploy/secrets/gateway.env;',
    );
    expect(out.summary).not.toContain('TomTom are not used');
    expect((out.data as { closures_accounted_for: boolean }).closures_accounted_for).toBe(false);
    // TomTom on but excluded for routing, everything else off: both are said.
    const y = h(
      { TOMTOM_API_KEY: 'k', ALLOW_TOMTOM_INCIDENTS: 'true', DETROIT_ROW_ENABLED: 'false' },
      { routes: valhallaRoutes([]) },
    );
    const out2 = await y.run('route_avoiding_closures', { from: DETROIT, to: BELLE_ISLE });
    expect(out2.summary).toContain(
      'No closure data was available to avoid, so this route does not account for closures (City of Detroit permits: off (DETROIT_ROW_ENABLED=false); MDOT RIDE: not configured',
    );
    expect(out2.summary).toContain(
      "Closures from TomTom are not used for routing (TomTom's licence excludes navigation use).",
    );
    expect(out2.summary).not.toContain('TomTom incidents:');
    expect(y.mock.count(/tomtom/)).toBe(0);
  });

  it('does not claim missing closure data when a source answered with none', async () => {
    const x = h(
      { MDOT_RIDE_API_KEY: 'k', DETROIT_ROW_ENABLED: 'false' },
      {
        routes: [
          ...valhallaRoutes([]),
          [/work_zone_information/, () => json({ type: 'FeatureCollection', features: [] })],
          [/traffic_events/, () => json({ data: [] })],
        ],
      },
    );
    const out = await x.run('route_avoiding_closures', { from: DETROIT, to: BELLE_ISLE });
    expect(out.summary).not.toContain('No closure data');
    expect((out.data as { closures_accounted_for: boolean }).closures_accounted_for).toBe(true);
  });

  it('keeps the first route, with a warning, when no way around exists', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const x = h({ MDOT_RIDE_API_KEY: 'k' }, { routes: valhallaRoutes(seen, { failSecond: true }) });
    const out = await x.run('route_avoiding_closures', {
      from: DETROIT,
      to: BELLE_ISLE,
      units: 'mi',
    });
    expect(out.isError).toBeFalsy();
    const d = out.data as { distance: number; closures_avoided: unknown[]; warnings: string[] };
    expect(d.distance).toBe(4.9);
    expect(d.closures_avoided).toEqual([]);
    expect(d.warnings.join(' ')).toContain('No route around 1 closure(s) was found');
  });

  it('skips the closure check with avoid_closures=false', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const x = h({ MDOT_RIDE_API_KEY: 'k' }, { routes: valhallaRoutes(seen) });
    const out = await x.run('route_avoiding_closures', {
      from: DETROIT,
      to: BELLE_ISLE,
      avoid_closures: false,
      units: 'km',
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.units).toBe('kilometers');
    expect(x.mock.count(/mdotridedata|arcgis/)).toBe(0);
    expect((out.data as { warnings: string[] }).warnings).toEqual([
      'Closures were not checked (avoid_closures=false).',
    ]);
    // No closure data used: Valhalla's credit only.
    expect((out.data as { attribution: string[] }).attribution).toEqual([VALHALLA_ATTRIBUTION]);
    expect(out.summary).not.toContain('Closure data:');
  });

  it('credits Ontario 511, with its "as is" disclaimer, for an Ontario closure it avoids', async () => {
    // A Windsor route straight along the Hwy 401 full-closure fixture, and a detour south of it.
    const closure = decodePolyline(ONTARIO_CONSTRUCTION[0]!.EncodedPolyline);
    const from = { lat: 42.225, lon: -82.99 };
    const to = { lat: 42.255, lon: -82.93 };
    const at = (p: [number, number]) => ({ lat: p[1], lon: p[0] });
    const direct = [
      ...line(from, at(closure[0]!), 10),
      ...line(at(closure[0]!), at(closure[closure.length - 1]!), 10),
      ...line(at(closure[closure.length - 1]!), to, 10),
    ];
    const detour = line(from, { lat: 42.2, lon: -82.95 }, 10).concat(
      line({ lat: 42.2, lon: -82.95 }, to, 10),
    );
    const seen: Array<Record<string, unknown>> = [];
    const x = h(
      { ...ALL_KEYS },
      {
        routes: [
          [
            /valhalla/,
            (_u, init) => {
              const body = JSON.parse(String(init.body)) as Record<string, unknown>;
              seen.push(body);
              return json({
                trip: {
                  summary: { length: 4, time: 600 },
                  legs: [
                    {
                      shape: encodePolyline(body.exclude_polygons ? detour : direct, 6),
                      maneuvers: [],
                    },
                  ],
                },
              });
            },
          ],
        ],
      },
    );
    const out = await x.run('route_avoiding_closures', { from, to });
    expect(out.isError).toBeFalsy();
    expect(seen).toHaveLength(2);
    const d = out.data as {
      closures_avoided: Array<{ road: string; source: string }>;
      attribution: string[];
      disclaimer?: string;
    };
    expect(d.closures_avoided).toEqual([
      expect.objectContaining({ road: 'Hwy 401', source: 'ontario511' }),
    ]);
    expect(d.attribution).toEqual([VALHALLA_ATTRIBUTION, ONTARIO_ATTRIBUTION]);
    expect(d.disclaimer).toBe(ONTARIO_DISCLAIMER);
    expect(out.summary).toContain(ONTARIO_ATTRIBUTION);
    expect(out.summary).toContain(ONTARIO_DISCLAIMER);
    // The tool's own credit line names every closure source routing can use (not TomTom).
    const credit = x.tools.route_avoiding_closures!.attribution!;
    for (const a of [
      VALHALLA_ATTRIBUTION,
      DETROIT_ATTRIBUTION,
      MDOT_ATTRIBUTION,
      ONTARIO_ATTRIBUTION,
    ])
      expect(credit).toContain(a);
    expect(credit).not.toContain('TomTom');
  });

  it('geocodes place names for from and to', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const x = h({}, { routes: valhallaRoutes(seen) });
    const out = await x.run('route_avoiding_closures', {
      from: 'Comerica Park',
      to: { ...BELLE_ISLE },
      avoid_closures: false,
    });
    expect(out.isError).toBeFalsy();
    const locs = seen[0]!.locations as Array<{ lat: number; lon: number }>;
    expect(locs[0]!.lat).toBeCloseTo(COMERICA_PARK.lat, 3);
    // The label is the place's name; which geocoder found it is in data and the attribution.
    expect(out.summary).toContain('Driving route from Comerica Park to 42.3405, -82.9850:');
    expect(out.summary).not.toMatch(/\[(photon|census|nominatim|overpass)\]/);
    expect(out.data).toMatchObject({
      from: 'Comerica Park',
      located_by: { from: 'photon', to: 'coordinates' },
    });
    // The geocoder that placed an endpoint is credited too.
    expect((out.data as { attribution: string[] }).attribution).toEqual([
      VALHALLA_ATTRIBUTION,
      GEO_ATTRIBUTION.photon,
    ]);
    const bad = await x.run('route_avoiding_closures', { from: 'Nowhere Atall', to: BELLE_ISLE });
    expect(bad.isError).toBe(true);
    expect(bad.summary).toContain('Could not find "Nowhere Atall"');
  });

  it('excludes a long closure with a few small rings inside it, within the budget', () => {
    const route = line(DETROIT, BELLE_ISLE, 200);
    // A 4 km closed stretch lying on the route, and a closure elsewhere.
    const closed = route.slice(20, 160);
    const item = (lines: Array<Array<[number, number]>>, full = true): RoadItem => ({
      source: 'mdot_ride',
      id: 'x',
      kind: 'work_zone',
      type: 'work-zone',
      road: 'Test Rd',
      direction: null,
      lanes: null,
      vehicle_impact: null,
      full_closure: full,
      description: null,
      from_cross_street: null,
      to_cross_street: null,
      start: null,
      end: null,
      updated: null,
      lines,
    });
    const elsewhere = item([
      [
        [-83.2, 42.5],
        [-83.21, 42.5],
      ],
    ]);
    expect(closuresOnRoute([item([closed]), elsewhere], route)).toHaveLength(1);
    const { rings, kept, dropped } = excludeRings([item([closed])], route);
    expect(kept).toHaveLength(1);
    expect(dropped).toHaveLength(0);
    expect(rings).toHaveLength(3);
    for (const r of rings) expect(ringPerimeterM(r)).toBeLessThan(120);
    // Rings stay off the closure's own ends (the cross streets a detour needs).
    const [lon0, lat0] = closed[0]!;
    for (const r of rings)
      expect(Math.abs(r[0]![0] - lon0) + Math.abs(r[0]![1] - lat0)).toBeGreaterThan(0.0003);
    // A closure only at the very start of the trip can't be routed around.
    const atStart = item([route.slice(0, 2)]);
    expect(atTripEnds(atStart, route, [DETROIT, BELLE_ISLE])).toBe(true);
    expect(atTripEnds(item([closed]), route, [DETROIT, BELLE_ISLE])).toBe(false);
    // Too many closures for Valhalla's perimeter limit: the extras are reported, not sent.
    // 100 point closures at about 96 m of ring each: more than 9 km in all.
    const many = Array.from({ length: 100 }, (_, i) => item([[route[i * 2]!]]));
    const r2 = excludeRings(many, route);
    expect(r2.dropped.length).toBeGreaterThan(0);
    expect(r2.rings.reduce((m, r) => m + ringPerimeterM(r), 0)).toBeLessThanOrEqual(9_000);
  });

  it('warns about lane closures on the way and closures it cannot avoid', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const onRoute = line(DETROIT, BELLE_ISLE, 40);
    const zones = {
      type: 'FeatureCollection',
      features: [
        {
          id: 'lane',
          properties: {
            core_details: {
              event_type: 'work-zone',
              road_names: ['Jefferson Ave'],
              description: 'Right lane closed',
            },
            vehicle_impact: 'some-lanes-closed',
            start_date: '2026-11-01T00:00:00Z',
          },
          geometry: { type: 'LineString', coordinates: onRoute.slice(15, 20) },
        },
        {
          id: 'start',
          properties: {
            core_details: {
              event_type: 'work-zone',
              road_names: ['Monroe St'],
              description: 'Closed',
            },
            vehicle_impact: 'all-lanes-closed',
            start_date: '2026-11-01T00:00:00Z',
          },
          geometry: { type: 'LineString', coordinates: onRoute.slice(0, 2) },
        },
      ],
    };
    const x = h(
      { MDOT_RIDE_API_KEY: 'k', DETROIT_ROW_ENABLED: 'false' },
      {
        routes: [
          [/work_zone_information/, () => json(zones)],
          [/traffic_events/, () => json({ data: [] })],
          [
            /valhalla/,
            (_u, init) => {
              seen.push(JSON.parse(String(init.body)));
              return json({
                trip: {
                  summary: { length: 4, time: 600 },
                  legs: [{ shape: encodePolyline(onRoute, 6), maneuvers: [] }],
                },
              });
            },
          ],
        ],
      },
    );
    const out = await x.run('route_avoiding_closures', { from: DETROIT, to: BELLE_ISLE });
    const w = (out.data as { warnings: string[] }).warnings.join('\n');
    expect(seen).toHaveLength(1);
    expect(w).toContain("Closure at the start or end of the trip, can't be avoided");
    expect(w).toContain(
      'On the route (not avoided, the road stays open): work-zone on Jefferson Ave',
    );
  });

  it('names the work it reports and keeps city-permit warnings short', async () => {
    const onRoute = line(DETROIT, BELLE_ISLE, 40);
    const permits = {
      features: Array.from({ length: 10 }, (_, i) => ({
        attributes: {
          permit_id: 70000 + i,
          permit_type: 'Annual Valet',
          work_description: `Valet staging in the curb lane ${i}`,
          start_date: '2026-11-01',
          end_date: '2026-12-31',
          roadway_direction_impact: 'Eastbound',
          is_sidewalk: 0,
        },
        geometry: { paths: [onRoute.slice(2 + i * 3, 4 + i * 3)] },
      })),
    };
    const x = h(
      {},
      {
        routes: [
          [/FeatureServer\/4\/query/, () => json(permits)],
          [/FeatureServer\/5\/query/, () => json({ features: [] })],
          [
            /valhalla/,
            () =>
              json({
                trip: {
                  summary: { length: 4, time: 600 },
                  legs: [{ shape: encodePolyline(onRoute, 6), maneuvers: [] }],
                },
              }),
          ],
        ],
      },
    );
    const out = await x.run('route_avoiding_closures', { from: DETROIT, to: BELLE_ISLE });
    const w = (out.data as { warnings: string[] }).warnings;
    expect(w).toHaveLength(4);
    expect(
      w
        .slice(0, 3)
        .every((s) => /permit: Annual Valet on (First Street|Woodward Avenue) Eastbound/.test(s)),
    ).toBe(true);
    expect(w[3]).toContain('7 more work site(s) on the route');
    expect(x.mock.count(/photon\.komoot\.io\/reverse/)).toBe(3);
    // City permit text in the warnings carries the city's credit, the street names the map's.
    expect((out.data as { attribution: string[] }).attribution).toEqual([
      VALHALLA_ATTRIBUTION,
      DETROIT_ATTRIBUTION,
      GEO_ATTRIBUTION.photon,
    ]);
    expect(out.summary).toContain(
      `Closure data: ${DETROIT_ATTRIBUTION}; ${GEO_ATTRIBUTION.photon}.`,
    );
  });

  it('reports Valhalla failures as errors', async () => {
    const x = h(
      {},
      { routes: [[/valhalla/, () => json({ error_code: 171, error: 'No suitable edges' }, 400)]] },
    );
    const out = await x.run('route_avoiding_closures', { from: DETROIT, to: BELLE_ISLE });
    expect(out).toMatchObject({ isError: true, errorKind: 'not_found' });
    const y = h({}, { routes: [[/valhalla/, () => json({}, 503)]] });
    const out2 = await y.run('route_avoiding_closures', { from: DETROIT, to: BELLE_ISLE });
    expect(out2.summary).toContain('Valhalla returned HTTP 503');
  });
});

describe('mdot_camera_link', () => {
  it('builds a Mi Drive link and fetches nothing', async () => {
    const x = h();
    const out = await x.run('mdot_camera_link', { ...DETROIT, zoom: 15 });
    expect(x.mock.calls).toHaveLength(0);
    const u = new URL((out.data as { url: string }).url);
    expect(u.origin + u.pathname).toBe('https://mdotjboss.state.mi.us/MiDrive/map');
    expect(u.searchParams.get('cameras')).toBe('true');
    expect(u.searchParams.get('lat')).toBe('42.33140');
    expect(u.searchParams.get('lon')).toBe('-83.04580');
    expect(u.searchParams.get('zoom')).toBe('15');
    expect(out.summary).toContain('no image is fetched');
  });

  it('centres on a named road through the geocoder', async () => {
    const x = h();
    const out = await x.run('mdot_camera_link', { road: 'Comerica Park' });
    expect(x.mock.count(/photon/)).toBe(1);
    expect(out.data).toMatchObject({
      located_by: 'Comerica Park',
      geocoder: 'photon',
      geocoder_attribution: GEO_ATTRIBUTION.photon,
    });
    expect(out.summary).toContain('Mi Drive map centred on Comerica Park, with cameras');
    const none = await x.run('mdot_camera_link', { road: 'Nowhere Atall' });
    expect(none.isError).toBe(true);
    const bad = await x.run('mdot_camera_link', {});
    expect(bad.errorKind).toBe('invalid_arguments');
  });
});

describe('disk state', () => {
  it('writes nothing until a lookup needs it', () => {
    const x = h();
    expect(existsSync(path.join(x.dir, 'cache'))).toBe(false);
  });
});
