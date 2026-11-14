/**
 * City of Detroit "Detroit Right of Way Permits" (ArcGIS FeatureServer: layer 4 lines, layer 5
 * points), keyless open data. Only permits that occupy the roadway (is_roadway=1) for the dates
 * asked. The layer has no street-name field: the street comes from a reverse lookup of the
 * segment's midpoint (cached), done only for the permits a result actually shows.
 */
import type { ClosureQuery, ClosureSource, FetchResult, RoadItem } from '../closures.js';
import type { Geocoder } from '../geocode.js';
import { DETROIT_CITY, lineMidpoint, distanceToLineM, round6, type LonLat } from '../geo.js';
import { localDay, TtlCache, type Http } from '../http.js';
import { cleanText } from '../text.js';

export const DETROIT_ATTRIBUTION =
  'City of Detroit Open Data: Detroit Right of Way Permits (data.detroitmi.gov)';

const FIELDS = [
  'permit_id',
  'permit_segment_id',
  'permit_type',
  'work_description',
  'start_date',
  'end_date',
  'agency_name',
  'roadway_direction_impact',
  'is_sidewalk',
].join(',');

interface Feature {
  attributes?: Record<string, unknown>;
  geometry?: { paths?: unknown; x?: unknown; y?: unknown };
}

/** ArcGIS DateOnly ("2026-11-30") or epoch ms -> YYYY-MM-DD (Detroit calendar). */
function day(v: unknown): string | null {
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  if (typeof v === 'number' && Number.isFinite(v)) return localDay(v);
  return null;
}

const STREET =
  '(?:st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|square|sq|pl|place|way|ct|court|pkwy|parkway|hwy|highway|fwy|freeway|ter|terrace|cir|circle)';
const FULL_CLOSURE = new RegExp(
  [
    String.raw`\b(?:full|complete|total)\s+(?:road\s+|street\s+)?closure\b`,
    String.raw`\b(?:road|street)\s+(?:is\s+|will\s+be\s+)?closed\b`,
    String.raw`\bdetour\b`,
    // "closing First St", "Closes WB Cadillac Square", "Closure of WB Cadillac Square"
    String.raw`\bclos(?:e|ed|es|ing|ure\s+of)\s+(?:the\s+)?(?:[\w.]+\s+){0,3}?${STREET}\b`,
  ].join('|'),
  'gi',
);

/**
 * A permit's own text says the street (or one direction of it), not just a lane, is closed.
 * Heuristic: every match is checked, and one that mentions a lane doesn't count.
 */
export function permitClosesRoad(type: string, text: string): boolean {
  for (const m of text.matchAll(FULL_CLOSURE)) {
    if (/\blanes?\b/i.test(m[0])) continue;
    if (/barricade|occupy/i.test(type) || /\bclosure\b|\bclosed\b|\bdetour\b/i.test(m[0]))
      return true;
  }
  return false;
}

export interface DetroitRowOptions {
  http: Http;
  baseUrl: string;
  enabled: boolean;
  geocoder: Geocoder;
  now: () => number;
}

export function detroitRowSource(o: DetroitRowOptions): ClosureSource {
  const cache = new TtlCache<{ features: Feature[]; more: boolean }>(120_000, o.now);
  const layer = async (id: 4 | 5, params: URLSearchParams, signal: AbortSignal) => {
    const u = new URL(`${o.baseUrl}/${id}/query`);
    u.search = params.toString();
    const j = await o.http.json<{
      features?: Feature[];
      exceededTransferLimit?: boolean;
      error?: unknown;
    }>('City of Detroit permits', u, { signal, maxBytes: 8 * 1024 * 1024 });
    if (j.error) throw new Error('City of Detroit permits rejected the query');
    return { features: j.features ?? [], more: j.exceededTransferLimit === true };
  };

  return {
    id: 'detroit_row',
    label: 'City of Detroit permits',
    attribution: DETROIT_ATTRIBUTION,
    coverage: DETROIT_CITY,
    unavailable: () =>
      o.enabled ? undefined : { status: 'off', note: 'off (DETROIT_ROW_ENABLED=false)' },
    skip: (q) => (q.include.has('work_zone') ? undefined : 'permits are work zones, not incidents'),
    async fetch(q: ClosureQuery, signal: AbortSignal): Promise<FetchResult> {
      const today = localDay(q.now);
      const dates =
        q.when === 'now'
          ? `start_date <= DATE '${today}' AND end_date >= DATE '${today}'`
          : `start_date > DATE '${today}'`;
      let where = `is_roadway = 1 AND ${dates}`;
      // A road-only search can't look up the street of every permit in the city: narrow it
      // with the permit text instead (server-side).
      let note: string | undefined;
      if (q.road && !q.center) {
        const kw = q.road.keyword.toUpperCase().replace(/[^A-Z0-9 ]/g, '');
        if (kw.length >= 3) {
          where += ` AND UPPER(work_description) LIKE '%${kw}%'`;
          note = 'matched on the permit text (no street lookup for a city-wide search)';
        }
      }
      const params = new URLSearchParams({
        where,
        geometry: q.bbox.map((v) => round6(v)).join(','),
        geometryType: 'esriGeometryEnvelope',
        inSR: '4326',
        spatialRel: 'esriSpatialRelIntersects',
        outSR: '4326',
        outFields: FIELDS,
        resultRecordCount: '1000',
        f: 'json',
      });
      const { value, ageMs } = await cache.get(params.toString(), async () => {
        const [lines, points] = await Promise.all([
          layer(4, params, signal),
          layer(5, params, signal),
        ]);
        return {
          features: [...lines.features, ...points.features],
          more: lines.more || points.more,
        };
      });
      const more = value.more;
      const byPermit = new Map<string, { attrs: Record<string, unknown>; lines: LonLat[][] }>();
      for (const f of value.features) {
        const a = f.attributes ?? {};
        const id = String(a.permit_id ?? a.permit_segment_id ?? '');
        if (!id) continue;
        const geomLines: LonLat[][] = [];
        const paths = f.geometry?.paths;
        if (Array.isArray(paths)) {
          for (const p of paths.slice(0, 50))
            if (Array.isArray(p))
              geomLines.push(
                p
                  .slice(0, 500)
                  .filter(
                    (c): c is [number, number] =>
                      Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number',
                  )
                  .map((c) => [c[0], c[1]] as LonLat),
              );
        } else if (typeof f.geometry?.x === 'number' && typeof f.geometry?.y === 'number') {
          geomLines.push([[f.geometry.x, f.geometry.y]]);
        }
        const entry = byPermit.get(id) ?? { attrs: a, lines: [] };
        entry.lines.push(...geomLines.filter((l) => l.length));
        byPermit.set(id, entry);
      }
      const items: RoadItem[] = [];
      for (const [id, { attrs, lines }] of byPermit) {
        if (!lines.length) continue;
        const type = cleanText(attrs.permit_type, 60) ?? 'permit';
        const description = cleanText(attrs.work_description, 300);
        const direction = cleanText(attrs.roadway_direction_impact, 30);
        const segs = lines.length;
        // The street at the segment nearest the point asked about (or the first one).
        const pick = q.center
          ? lines.reduce((best, l) =>
              distanceToLineM(q.center!, l).distM < distanceToLineM(q.center!, best).distM
                ? l
                : best,
            )
          : lines[0]!;
        const mid = lineMidpoint(pick);
        items.push({
          source: 'detroit_row',
          id: `detroit_row:${id}`,
          kind: 'work_zone',
          type: `permit: ${type}`,
          road: null,
          direction,
          lanes: null,
          vehicle_impact: `roadway occupied by permitted work${attrs.is_sidewalk === 1 ? '; sidewalk too' : ''}`,
          full_closure: permitClosesRoad(type, description ?? ''),
          description,
          from_cross_street: null,
          to_cross_street: null,
          start: day(attrs.start_date),
          end: day(attrs.end_date),
          updated: null,
          lines,
          dateOnly: true,
          resolveRoad: (sig) => o.geocoder.reverseStreet(mid, sig),
          note: `${segs} permit segment(s); street name looked up from the map${segs > 1 ? ' at the segment shown' : ''}; full_closure is inferred from the permit text`,
        });
      }
      const extra = more
        ? 'more permits matched than one query returns; narrow the area'
        : undefined;
      return {
        items,
        cacheAgeMs: ageMs,
        note: [note, extra].filter(Boolean).join('; ') || undefined,
      };
    },
  };
}
