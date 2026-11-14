/**
 * Gateway-side geocoding chain, biased to south-east Michigan:
 *   1. intersections ("I-94 and M-10") through a self-hosted Overpass, when OVERPASS_URL is set
 *   2. street addresses through the US Census Geocoder (public domain)
 *   3. place names through Photon (photon.komoot.io, fair use)
 *   4. public Nominatim, last resort: at most 1 request/s and GEOCODER_NOMINATIM_DAILY_MAX a day
 * Answers are cached on disk in the gateway data volume (Nominatim's policy requires caching).
 * The cache key is the query only: a caller's "near" point only re-ranks cached answers, so the
 * cache never holds the user's position. Also: reverse lookups of street names (cached).
 */
import { haversineM } from '../../util/geo.js';
import type { DailyCounter, DiskCache, Http, Pacer } from './http.js';
import { errorText } from './http.js';
import {
  SE_MICHIGAN,
  bboxCenter,
  distanceToLinesM,
  inBox,
  round4,
  samplePoints,
  type LonLat,
  type Point,
} from './geo.js';
import { cleanText, normRoad } from './text.js';

/**
 * Grade-separated roads (no shared node) still "meet" where one passes within this of the other:
 * a freeway crossing over another has its centre line within a few metres of the other's.
 */
export const INTERCHANGE_M = 30;

export const OSM_ATTRIBUTION = '© OpenStreetMap contributors (ODbL), openstreetmap.org/copyright';
export const ATTRIBUTION = {
  census: 'U.S. Census Bureau Geocoder (public domain)',
  photon: `Photon by komoot; ${OSM_ATTRIBUTION}`,
  nominatim: `Nominatim (OpenStreetMap Foundation); ${OSM_ATTRIBUTION}`,
  overpass: `Overpass API (self-hosted); ${OSM_ATTRIBUTION}`,
} as const;

export type GeoSource = keyof typeof ATTRIBUTION;

export interface Place {
  name: string;
  address: string | null;
  lat: number;
  lon: number;
  kind: string;
  source: GeoSource;
  attribution: string;
  /** Inside the south-east Michigan box results are biased to. */
  in_region: boolean;
  distance_km?: number;
}

export interface GeocodeAttempt {
  source: GeoSource;
  status: 'ok' | 'no_match' | 'error' | 'not_configured' | 'quota' | 'skipped';
  note?: string;
}

export interface GeocodeResult {
  places: Place[];
  attempts: GeocodeAttempt[];
  cached: boolean;
}

interface Cached {
  places: Place[];
  attempts: GeocodeAttempt[];
}

export interface GeocoderOptions {
  http: Http;
  censusUrl: string;
  photonUrl: string;
  nominatimUrl: string;
  overpassUrl?: string;
  cache: DiskCache<Cached>;
  reverseCache: DiskCache<string | null>;
  nominatimDaily: DailyCounter;
  nominatimPacer: Pacer;
  photonPacer: Pacer;
  /** The policy's shared "nominatim" quota bucket (GEV place lookups use it too). */
  nominatimBucket?: () => boolean;
}

const HIT_TTL = 30 * 86_400_000;
/** An answer found while an earlier link in the chain errored (a better source may come back). */
const PARTIAL_HIT_TTL = 86_400_000;
const MISS_TTL = 86_400_000;
const REVERSE_TTL = 30 * 86_400_000;
const BIAS = bboxCenter(SE_MICHIGAN);

/**
 * How long to keep a lookup, or 0 to keep nothing. Every answer with places is kept (Nominatim's
 * policy requires its results to be cached, whatever failed before it); an empty answer is kept
 * briefly, and not at all when it may be empty only because a source errored or a budget ran out.
 */
function cacheTtl(r: Cached): number {
  const failed = r.attempts.some((a) => a.status === 'error' || a.status === 'quota');
  if (r.places.length) return failed ? PARTIAL_HIT_TTL : HIT_TTL;
  return failed ? 0 : MISS_TTL;
}

/** "2100 Woodward Ave" (but not "8 Mile Rd"). */
export function looksLikeAddress(q: string): boolean {
  return /^\s*\d+[A-Za-z]?\s+[A-Za-z0-9]/.test(q) && !/^\s*\d+\s+mile\b/i.test(q);
}

/** "I-94 and M-10", "Woodward & 8 Mile", "Gratiot at Conner" -> the two roads. */
export function parseIntersection(q: string): [string, string] | undefined {
  if (looksLikeAddress(q)) return undefined;
  const m = /^\s*(.{2,60}?)(?:\s*[&@/]\s*|\s+(?:and|at)\s+)(.{2,60}?)\s*(?:,.*)?$/i.exec(q);
  if (!m) return undefined;
  const a = m[1]!.trim();
  const b = m[2]!.trim();
  return a && b && !/[;"\\]/.test(a + b) ? [a, b] : undefined;
}

const SUFFIX_TOKENS = new Set([
  'ave',
  'st',
  'rd',
  'blvd',
  'dr',
  'fwy',
  'hwy',
  'pkwy',
  'ln',
  'ct',
  'pl',
  'expy',
]);
const DIRS = new Set(['n', 's', 'e', 'w']);
const NUM_WORD = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
  'twenty',
];

/** An Overpass tag filter for one road, and the same test in JS. Undefined if unusable. */
export function roadFilter(
  road: string,
): { ql: string; test: (tags: Record<string, string>) => boolean } | undefined {
  const n = normRoad(road);
  const ref = /^(i|us|m|hwy) (\d{1,4}[a-z]?)$/.exec(n);
  if (ref) {
    const prefix = { i: 'I', us: 'US', m: 'M', hwy: '' }[ref[1] as 'i' | 'us' | 'm' | 'hwy'];
    const num = ref[2]!.toUpperCase();
    const body = prefix ? `${prefix}[ -]?${num}` : num;
    const re = new RegExp(`(^|;) *${body}( |;|$)`, 'i');
    return {
      ql: `["ref"~"(^|;) *${body}( |;|$)",i]`,
      test: (t) => re.test(t.ref ?? ''),
    };
  }
  const tokens = n.split(' ').filter(Boolean);
  while (
    tokens.length > 1 &&
    (SUFFIX_TOKENS.has(tokens[tokens.length - 1]!) || DIRS.has(tokens[tokens.length - 1]!))
  )
    tokens.pop();
  while (tokens.length > 1 && DIRS.has(tokens[0]!)) tokens.shift();
  if (!tokens.length || tokens.join('').length < 2) return undefined;
  const parts = tokens.map((tk, i) => {
    const w = NUM_WORD[Number(tk)];
    return /^\d+$/.test(tk) && tokens[i + 1] === 'mile' && w ? `(${tk}|${w})` : tk;
  });
  const core = parts.join(' ');
  const re = new RegExp(`(^| )${core}( |$)`, 'i');
  return { ql: `["name"~"(^| )${core}( |$)",i]`, test: (t) => re.test(t.name ?? '') };
}

function region(lat: number, lon: number): boolean {
  return inBox([lon, lat], SE_MICHIGAN);
}

function place(p: Omit<Place, 'attribution' | 'in_region'>): Place {
  return { ...p, attribution: ATTRIBUTION[p.source], in_region: region(p.lat, p.lon) };
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};

export class Geocoder {
  constructor(private readonly o: GeocoderOptions) {}

  get overpassConfigured(): boolean {
    return Boolean(this.o.overpassUrl);
  }

  async search(
    query: string,
    opts: { near?: Point; limit: number },
    signal?: AbortSignal,
  ): Promise<GeocodeResult> {
    const q = cleanText(query, 200) ?? '';
    if (q.length < 2) return { places: [], attempts: [], cached: false };
    // The query alone (never a caller's point); intersections answer differently with Overpass
    // (v2: shared node, then ways within INTERCHANGE_M).
    const key = `${this.o.overpassUrl ? 'v2|op|' : 'v1|'}${q.toLowerCase()}`;
    let cached = true;
    let hit = this.o.cache.get(key);
    if (!hit) {
      cached = false;
      hit = await this.lookup(q, signal);
      const ttl = cacheTtl(hit);
      if (ttl) this.o.cache.set(key, hit, ttl);
    }
    let places = hit.places.map((p) => ({ ...p }));
    if (opts.near) {
      const near = opts.near;
      for (const p of places)
        p.distance_km = Math.round(haversineM(near.lat, near.lon, p.lat, p.lon) / 100) / 10;
      places.sort((a, b) => (a.distance_km ?? 0) - (b.distance_km ?? 0));
    } else {
      places = [...places.filter((p) => p.in_region), ...places.filter((p) => !p.in_region)];
    }
    return { places: places.slice(0, opts.limit), attempts: hit.attempts, cached };
  }

  private async lookup(q: string, signal?: AbortSignal): Promise<Cached> {
    const attempts: GeocodeAttempt[] = [];
    const run = async (source: GeoSource, fn: () => Promise<Place[]>): Promise<Place[]> => {
      try {
        const out = await fn();
        attempts.push({ source, status: out.length ? 'ok' : 'no_match' });
        return out;
      } catch (err) {
        attempts.push({ source, status: 'error', note: errorText(err) });
        return [];
      }
    };
    const pair = parseIntersection(q);
    if (pair) {
      if (this.o.overpassUrl) {
        const hits = await run('overpass', () => this.intersection(pair, signal));
        if (hits.length) return { places: hits, attempts };
      } else {
        attempts.push({
          source: 'overpass',
          status: 'not_configured',
          note: 'intersections need a self-hosted Overpass: set OVERPASS_URL in deploy/secrets/gateway.env',
        });
      }
    }
    if (looksLikeAddress(q) && !/\b(on|ontario|windsor|canada)\b/i.test(q)) {
      const hits = await run('census', () => this.census(q, signal));
      if (hits.length) return { places: hits, attempts };
    }
    const photon = await run('photon', () => this.photon(q, signal));
    if (photon.length) return { places: photon, attempts };
    if (this.o.nominatimDaily.max === 0) {
      attempts.push({
        source: 'nominatim',
        status: 'not_configured',
        note: 'GEOCODER_NOMINATIM_DAILY_MAX=0',
      });
      return { places: [], attempts };
    }
    if ((this.o.nominatimBucket && !this.o.nominatimBucket()) || !this.o.nominatimDaily.take()) {
      attempts.push({
        source: 'nominatim',
        status: 'quota',
        note: `public Nominatim's budget is spent (at most ${this.o.nominatimDaily.max}/day and the shared nominatim bucket)`,
      });
      return { places: [], attempts };
    }
    const nom = await run('nominatim', () => this.nominatim(q, signal));
    return { places: nom, attempts };
  }

  private async census(q: string, signal?: AbortSignal): Promise<Place[]> {
    const address = /\b(mi|michigan)\b|,\s*[a-z]{2}\b/i.test(q) ? q : `${q}, MI`;
    const u = new URL(`${this.o.censusUrl}/locations/onelineaddress`);
    u.searchParams.set('address', address);
    u.searchParams.set('benchmark', 'Public_AR_Current');
    u.searchParams.set('format', 'json');
    const j = await this.o.http.json<{ result?: { addressMatches?: unknown[] } }>(
      'Census geocoder',
      u,
      { signal },
    );
    const out: Place[] = [];
    for (const m of (j.result?.addressMatches ?? []).slice(0, 10)) {
      const r = m as { matchedAddress?: unknown; coordinates?: { x?: unknown; y?: unknown } };
      const lat = num(r.coordinates?.y);
      const lon = num(r.coordinates?.x);
      const name = cleanText(r.matchedAddress, 160);
      if (lat === undefined || lon === undefined || !name) continue;
      out.push(place({ name, address: name, lat, lon, kind: 'address', source: 'census' }));
    }
    return out;
  }

  private async photon(q: string, signal?: AbortSignal): Promise<Place[]> {
    await this.o.photonPacer.wait(signal);
    const u = new URL(`${this.o.photonUrl}/api/`);
    u.searchParams.set('q', q);
    u.searchParams.set('limit', '10');
    u.searchParams.set('lat', String(BIAS.lat));
    u.searchParams.set('lon', String(BIAS.lon));
    u.searchParams.set('lang', 'en');
    const j = await this.o.http.json<{ features?: unknown[] }>('Photon', u, { signal });
    const out: Place[] = [];
    for (const f of (j.features ?? []).slice(0, 10)) {
      const ft = f as {
        geometry?: { coordinates?: unknown[] };
        properties?: Record<string, unknown>;
      };
      const c = ft.geometry?.coordinates ?? [];
      const lon = num(c[0]);
      const lat = num(c[1]);
      const pr = ft.properties ?? {};
      if (lat === undefined || lon === undefined) continue;
      const street = [pr.housenumber, pr.street].filter((x) => typeof x === 'string').join(' ');
      const name = cleanText(pr.name, 120) ?? cleanText(street, 120) ?? cleanText(pr.city, 120);
      if (!name) continue;
      const address = cleanText(
        [street, pr.city ?? pr.locality, pr.state, pr.postcode, pr.country]
          .filter((x) => typeof x === 'string' && x)
          .join(', '),
        200,
      );
      const kind =
        cleanText([pr.osm_key, pr.osm_value].filter(Boolean).join(':') || pr.type, 60) ?? 'place';
      out.push(place({ name, address, lat, lon, kind, source: 'photon' }));
    }
    return out;
  }

  private async nominatim(q: string, signal?: AbortSignal): Promise<Place[]> {
    await this.o.nominatimPacer.wait(signal);
    const u = new URL(`${this.o.nominatimUrl}/search`);
    u.searchParams.set('q', q);
    u.searchParams.set('format', 'jsonv2');
    u.searchParams.set('limit', '5');
    u.searchParams.set('addressdetails', '0');
    const [w, s, e, n] = SE_MICHIGAN;
    u.searchParams.set('viewbox', `${w},${n},${e},${s}`);
    u.searchParams.set('bounded', '0');
    u.searchParams.set('countrycodes', 'us,ca');
    const j = await this.o.http.json<unknown[]>('Nominatim', u, {
      signal,
      headers: { 'accept-language': 'en' },
    });
    const out: Place[] = [];
    for (const r of Array.isArray(j) ? j.slice(0, 10) : []) {
      const x = r as Record<string, unknown>;
      const lat = num(x.lat);
      const lon = num(x.lon);
      const display = cleanText(x.display_name, 200);
      const name = cleanText(x.name, 120) || display;
      if (lat === undefined || lon === undefined || !name) continue;
      const kind = cleanText([x.category, x.type].filter(Boolean).join(':'), 60) ?? 'place';
      out.push(place({ name, address: display, lat, lon, kind, source: 'nominatim' }));
    }
    return out;
  }

  private async overpass(
    ql: string,
    signal?: AbortSignal,
  ): Promise<Array<Record<string, unknown>>> {
    const j = await this.o.http.json<{ elements?: unknown[] }>('Overpass', this.o.overpassUrl!, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ data: ql }).toString(),
      maxBytes: 8 * 1024 * 1024,
      timeoutMs: 30_000,
      signal,
    });
    return (j.elements ?? []).filter(
      (e): e is Record<string, unknown> => Boolean(e) && typeof e === 'object',
    );
  }

  /**
   * Where two roads meet. First a node both roads' ways share (one query that returns only
   * those nodes): a junction at grade. Without one (freeway interchanges are grade-separated:
   * the roads cross on a bridge, on different layers, with no common node), the ways of one
   * road within INTERCHANGE_M of the other, and where they come closest.
   */
  private async intersection(pair: [string, string], signal?: AbortSignal): Promise<Place[]> {
    const fa = roadFilter(pair[0]);
    const fb = roadFilter(pair[1]);
    if (!fa || !fb) return [];
    const [w, s, e, n] = SE_MICHIGAN;
    const skip =
      '["highway"!~"^(footway|cycleway|path|steps|service|track|pedestrian|bridleway|corridor|platform|construction|proposed)$"]';
    const head = `[out:json][timeout:25][bbox:${s},${w},${n},${e}];`;
    const wayA = `way["highway"]${skip}${fa.ql}`;
    const wayB = `way["highway"]${skip}${fb.ql}`;
    const name = `${cleanText(pair[0], 60)} & ${cleanText(pair[1], 60)}`;
    const hits: Array<{ p: LonLat; kind: string }> = [];

    const shared = await this.overpass(
      `${head}${wayA}->.a;${wayB}->.b;node(w.a)->.na;node(w.b)->.nb;node.na.nb;out skel;`,
      signal,
    );
    for (const nd of shared) {
      const lat = num(nd.lat);
      const lon = num(nd.lon);
      if (nd.type === 'node' && lat !== undefined && lon !== undefined)
        hits.push({ p: [lon, lat], kind: 'intersection' });
    }

    if (!hits.length) {
      const near = await this.overpass(
        `${head}${wayB}->.b;${wayA}(around.b:${INTERCHANGE_M})->.a;way.b(around.a:${INTERCHANGE_M})->.bn;(.a;.bn;);out tags geom;`,
        signal,
      );
      const A: LonLat[][] = [];
      const B: LonLat[][] = [];
      for (const wy of near) {
        if (wy.type !== 'way') continue;
        const tags = (wy.tags ?? {}) as Record<string, string>;
        const geom = (Array.isArray(wy.geometry) ? wy.geometry : [])
          .map((g: { lat?: unknown; lon?: unknown }) => [num(g?.lon), num(g?.lat)])
          .filter((c): c is LonLat => c[0] !== undefined && c[1] !== undefined);
        if (geom.length < 2) continue;
        if (fa.test(tags)) A.push(geom);
        if (fb.test(tags)) B.push(geom);
      }
      // Overpass's "around" is the filter; the distance itself is measured here, on 10 m
      // samples of road A against road B's segments, closest first.
      const close: Array<{ p: LonLat; d: number }> = [];
      for (const a of A)
        for (const pt of samplePoints(a, 10, 4000)) {
          const best = distanceToLinesM(pt, B);
          if (best.distM <= INTERCHANGE_M)
            close.push({
              p: [(pt.lon + best.at.lon) / 2, (pt.lat + best.at.lat) / 2],
              d: best.distM,
            });
        }
      close.sort((x, y) => x.d - y.d);
      for (const c of close)
        hits.push({
          p: c.p,
          kind: `interchange (grade-separated: the roads pass within ${Math.round(c.d)} m)`,
        });
    }
    // One answer per place where they meet (points within 500 m are the same junction).
    const out: Place[] = [];
    for (const h of hits) {
      if (out.some((o) => haversineM(o.lat, o.lon, h.p[1], h.p[0]) < 500)) continue;
      out.push(
        place({
          name,
          address: null,
          lat: round4(h.p[1]),
          lon: round4(h.p[0]),
          kind: h.kind,
          source: 'overpass',
        }),
      );
      if (out.length >= 5) break;
    }
    return out;
  }

  /** The street at a point (Overpass when configured, else Photon reverse), cached. */
  async reverseStreet(p: Point, signal?: AbortSignal): Promise<string | null> {
    const key = `${round4(p.lat)},${round4(p.lon)}`;
    const hit = this.o.reverseCache.get(key);
    if (hit !== undefined) return hit;
    let name: string | null;
    if (this.o.overpassUrl) {
      const els = await this.overpass(
        `[out:json][timeout:10];way(around:30,${p.lat.toFixed(6)},${p.lon.toFixed(6)})["highway"]["name"];out tags 5;`,
        signal,
      );
      const tags = els.find((e) => e.type === 'way')?.tags as Record<string, unknown> | undefined;
      name = cleanText(tags?.name, 80);
    } else {
      await this.o.photonPacer.wait(signal);
      const u = new URL(`${this.o.photonUrl}/reverse`);
      u.searchParams.set('lat', p.lat.toFixed(6));
      u.searchParams.set('lon', p.lon.toFixed(6));
      u.searchParams.set('limit', '1');
      u.searchParams.set('layer', 'street');
      u.searchParams.set('lang', 'en');
      const j = await this.o.http.json<{
        features?: Array<{ properties?: Record<string, unknown> }>;
      }>('Photon reverse', u, { signal });
      const pr = j.features?.[0]?.properties;
      name = cleanText(pr?.name ?? pr?.street, 80);
    }
    this.o.reverseCache.set(key, name, name ? REVERSE_TTL : 7 * 86_400_000);
    return name;
  }
}
