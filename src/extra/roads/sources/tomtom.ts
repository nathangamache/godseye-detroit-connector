/**
 * TomTom Traffic Incident Details v5, on only when ALLOW_TOMTOM_INCIDENTS=true (the owner's
 * licence decision) and TOMTOM_API_KEY is set. One bbox request (at most 10,000 km², the API's
 * limit) returns the incidents with their details, so the POST-by-id step is not needed.
 *
 * An incident's direction is the one its text names, else the way its line heads: TomTom draws
 * an incident in the direction of travel it affects (both directions come as two incidents).
 *
 * Never cached: TomTom's terms allow caching only as the response's Cache-Control headers say,
 * and Incident Details sends none. A hard daily cap (TOMTOM_INCIDENTS_DAILY_MAX, counted on disk
 * so a restart does not reset it) bounds use. Not used for routing (TomTom's terms exclude
 * navigation use from the free grant).
 *
 * An incident on a road without a route number has no road name in the API (only roadNumbers;
 * from/to are the cross streets). Its road is then the named road nearest the incident's
 * midpoint in our own OpenStreetMap copy (the self-hosted Overpass, never an outside geocoder),
 * looked up only for the items a result shows and never cached.
 */
import {
  QuotaError,
  type ClosureQuery,
  type ClosureSource,
  type FetchResult,
  type RoadItem,
} from '../closures.js';
import { ATTRIBUTION as GEO_ATTRIBUTION } from '../geocode.js';
import {
  clampBox,
  clampToWorld,
  inMichigan,
  lineMidpoint,
  round6,
  travelDirection,
  type BBox,
  type LonLat,
  type Point,
} from '../geo.js';
import type { DailyCounter, Http } from '../http.js';
import { cleanText, roadText } from '../text.js';

export const TOMTOM_ATTRIBUTION = 'Traffic incidents © TomTom';

/** The API's bbox limit is 10,000 km²; stay just under it. */
export const TOMTOM_MAX_KM2 = 9_900;

/** Accident, jam, lane closed, road closed, road works, broken-down vehicle. */
export const TOMTOM_CATEGORIES = '1,6,7,8,9,14';

const FIELDS =
  '{incidents{type,geometry{type,coordinates},properties{id,iconCategory,magnitudeOfDelay,events{description,code,iconCategory},startTime,endTime,from,to,length,delay,roadNumbers,timeValidity,lastReportTime}}}';

const TYPE: Record<number, string> = {
  1: 'crash',
  6: 'traffic jam',
  7: 'lane closure',
  8: 'road closed',
  9: 'road works',
  14: 'broken-down vehicle',
};
const MAGNITUDE: Record<number, string> = {
  1: 'minor delay',
  2: 'moderate delay',
  3: 'major delay',
};

/** How far from the incident's midpoint the road it is on may be (OpenStreetMap lookup). */
export const TOMTOM_ROAD_RADIUS_M = 25;

/** The named road at a point, from the self-hosted Overpass (uncached), or null. */
export type RoadAt = (p: Point, radiusM: number, signal: AbortSignal) => Promise<string | null>;

export interface TomTomOptions {
  http: Http;
  baseUrl: string;
  key?: string;
  allowed: boolean;
  daily: DailyCounter;
  /** Unset (no OVERPASS_URL): an incident without a route number stays unnamed. */
  roadAt?: RoadAt;
}

function coords(g: { type?: unknown; coordinates?: unknown } | undefined): LonLat[] {
  const c = g?.coordinates;
  if (!Array.isArray(c)) return [];
  const ok = (p: unknown): p is [number, number] =>
    Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number';
  if (g?.type === 'Point' && ok(c)) return [[c[0], c[1]]];
  return c
    .filter(ok)
    .slice(0, 2000)
    .map((p) => [p[0], p[1]] as LonLat);
}

export function parseTomTom(j: unknown, roadAt?: RoadAt): RoadItem[] {
  const list = (j as { incidents?: unknown })?.incidents;
  if (!Array.isArray(list)) return [];
  const out: RoadItem[] = [];
  for (const raw of list.slice(0, 1000)) {
    const f = raw as {
      geometry?: { type?: unknown; coordinates?: unknown };
      properties?: Record<string, unknown>;
    };
    const p = f.properties ?? {};
    const line = coords(f.geometry);
    if (!line.length) continue;
    const cat = typeof p.iconCategory === 'number' ? p.iconCategory : 0;
    const mag = typeof p.magnitudeOfDelay === 'number' ? p.magnitudeOfDelay : 0;
    const delayMin = typeof p.delay === 'number' && p.delay > 0 ? Math.round(p.delay / 60) : 0;
    const events = Array.isArray(p.events) ? p.events : [];
    const desc = events
      .map((e) => cleanText((e as { description?: unknown })?.description, 120))
      .filter(Boolean)
      .join('; ');
    // "M-10", "MI-10" (and in Michigan "SR-10") are one route: each number once, in the
    // Michigan form.
    const mid = lineMidpoint(line);
    const michigan = inMichigan([mid.lon, mid.lat]);
    const roads = Array.isArray(p.roadNumbers)
      ? [
          ...new Set(
            p.roadNumbers.map((r) => roadText(cleanText(r, 20), { michigan })).filter(Boolean),
          ),
        ]
          .slice(0, 4)
          .join(' / ')
      : '';
    const impact = [MAGNITUDE[mag], delayMin ? `about ${delayMin} min delay` : '']
      .filter(Boolean)
      .join(', ');
    out.push({
      source: 'tomtom',
      id: `tomtom:${cleanText(p.id, 80) ?? out.length}`,
      kind: cat === 9 ? 'work_zone' : 'incident',
      type: TYPE[cat] ?? 'incident',
      road: roads || null,
      direction: directionOf(desc, line),
      lanes: cat === 7 ? 'lane(s) closed' : cat === 8 ? 'all lanes' : null,
      vehicle_impact: cat === 8 ? 'road closed' : impact || null,
      full_closure: cat === 8,
      description: cleanText(desc, 300),
      from_cross_street: cleanText(p.from, 100),
      to_cross_street: cleanText(p.to, 100),
      start: cleanText(p.startTime, 40),
      end: cleanText(p.endTime, 40),
      updated: cleanText(p.lastReportTime, 40),
      lines: [line],
      ...(roads ? {} : unnamed(line, roadAt)),
    });
  }
  return out;
}

/**
 * The direction an incident is in: as TomTom's text says it ("Closed northbound"), else the way
 * its line heads (TomTom draws an incident in the direction of travel it affects), else null.
 */
export function directionOf(text: string, line: LonLat[]): string | null {
  if (/\bboth directions\b/i.test(text)) return 'both directions';
  const m = /\b(north|south|east|west)[ -]?bound\b/i.exec(text);
  return m ? `${m[1]!.toLowerCase()}bound` : travelDirection(line);
}

/**
 * An incident TomTom gives no road for: the lookup, its credit, and what its note says (the road
 * comes from OpenStreetMap only when the lookup found one).
 */
function unnamed(line: LonLat[], roadAt?: RoadAt): Partial<RoadItem> {
  const none = 'TomTom gives no road name here';
  if (!roadAt)
    return {
      roadNote: { skipped: `${none}; set OVERPASS_URL to name the road from OpenStreetMap` },
    };
  const mid = lineMidpoint(line);
  const within = `within ${TOMTOM_ROAD_RADIUS_M} m of the incident's midpoint`;
  return {
    resolveRoad: (signal) => roadAt(mid, TOMTOM_ROAD_RADIUS_M, signal),
    roadCredit: GEO_ATTRIBUTION.overpass,
    roadNote: {
      found: `${none}; the road is the nearest named road in OpenStreetMap ${within}`,
      none: `${none}, and OpenStreetMap has no named road ${within}`,
      failed: `${none}; the OpenStreetMap lookup of its road failed`,
      skipped: `${none}; not looked up in OpenStreetMap (street-name lookups are capped per call)`,
    },
  };
}

export function tomtomSource(o: TomTomOptions): ClosureSource {
  return {
    id: 'tomtom',
    label: 'TomTom incidents',
    attribution: TOMTOM_ATTRIBUTION,
    coverage: [-180, -90, 180, 90],
    unavailable() {
      if (!o.key)
        return {
          status: 'not_configured',
          note: 'not configured: set TOMTOM_API_KEY in deploy/secrets/gateway.env',
        };
      if (!o.allowed)
        return {
          status: 'off',
          note: "off: set ALLOW_TOMTOM_INCIDENTS=true in deploy/secrets/gateway.env to accept TomTom's licence terms",
        };
      if (o.daily.max === 0) return { status: 'off', note: 'off (TOMTOM_INCIDENTS_DAILY_MAX=0)' };
      return undefined;
    },
    skip: (q) =>
      q.purpose === 'route'
        ? "not used for routing (TomTom's terms exclude navigation use)"
        : undefined,
    quota: () => ({ remaining: o.daily.remaining(), max: o.daily.max }),
    async fetch(q: ClosureQuery, signal: AbortSignal): Promise<FetchResult> {
      // Valid coordinates first (TomTom refuses lon > 180 or lat > 90, and the refusal would
      // still spend a call of the daily cap), then the area limit around the trimmed centre.
      const world = clampToWorld(q.bbox);
      const box: BBox = clampBox(world, TOMTOM_MAX_KM2);
      if (!o.daily.take())
        throw new QuotaError(
          `daily cap of ${o.daily.max} TomTom incident requests reached; resets at midnight (Detroit time)`,
        );
      const u = new URL(`${o.baseUrl}/traffic/services/5/incidentDetails`);
      u.searchParams.set('key', o.key!);
      u.searchParams.set('bbox', box.map(round6).join(','));
      u.searchParams.set('fields', FIELDS);
      u.searchParams.set('language', 'en-US');
      u.searchParams.set('categoryFilter', TOMTOM_CATEGORIES);
      u.searchParams.set('timeValidityFilter', 'present,future');
      const j = await o.http.json('TomTom incidents', u, { signal, maxBytes: 4 * 1024 * 1024 });
      const trimmed =
        world !== q.bbox ? 'the search area was trimmed at the antimeridian or a pole' : undefined;
      const clipped =
        box !== world ? 'searched the 10,000 km² TomTom allows around the centre' : undefined;
      return {
        items: parseTomTom(j, o.roadAt),
        note: [trimmed, clipped, `${o.daily.remaining()} of ${o.daily.max} requests left today`]
          .filter(Boolean)
          .join('; '),
      };
    },
  };
}
