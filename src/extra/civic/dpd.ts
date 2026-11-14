/**
 * dpd_calls_near: City of Detroit "Police Serviced 911 Calls" (open data, ArcGIS FeatureServer,
 * keyless). Official but published with a delay of hours, located only by the nearest
 * intersection (never a house address), Detroit city limits only.
 *
 * The layer's point geometry is empty, so a spatial filter returns nothing: the query filters
 * a bounding box on its latitude/longitude fields (numbers the gateway computes, never caller
 * text) and the exact radius and any category are applied here.
 */
import { z } from 'zod';
import { bearingDeg, compassPoint, degreeBox, haversineM } from '../../util/geo.js';
import { humanAge } from '../../util/format.js';
import type { ToolDef, ToolOutput } from '../../tools/types.js';
import {
  civicTool,
  cleanText,
  fetchBytes,
  pointFields,
  refinePoint,
  resolvePoint,
  round,
  TtlCache,
  untilAborted,
  upstreamFailure,
  UpstreamError,
  type FetchLike,
  type PointDeps,
} from './common.js';

export const DPD_CALLS_LAYER =
  'https://services2.arcgis.com/qvkbeam7Wirps6zC/arcgis/rest/services/Police_Serviced_911_Calls/FeatureServer/0';

export const DPD_ATTRIBUTION =
  'City of Detroit Open Data (data.detroitmi.gov), Police Serviced 911 Calls: official, delayed a few hours; nearest intersection only';

/** Detroit city limits, padded slightly: outside it the dataset has nothing. */
export const DETROIT_BOX = { minLat: 42.25, maxLat: 42.456, minLon: -83.293, maxLon: -82.905 };

/** The layer's maxRecordCount. */
const PAGE = 2000;
/** Calls listed in a result (the counts cover all of them). */
const MAX_LISTED = 50;
const TIMEOUT_MS = 20_000;

/** Friendly words for the city's nature codes (matched against code and description). */
const CATEGORY_WORDS: Record<string, string[]> = {
  CRASH: ['AUTO X', 'ACC', 'HIT& RUN', 'HIT & RUN', 'OVR'],
  ACCIDENT: ['AUTO X', 'ACC', 'HIT& RUN', 'HIT & RUN', 'OVR'],
  SHOOTING: ['SHOT', 'SHOOTING', 'GSW'],
  SHOTS: ['SHOT'],
  GUN: ['SHOT', 'SHOOTING', 'WEAPON', 'GSW'],
  ASSAULT: ['ASSAULT', 'A/B', 'FA IP', 'AB IP', 'F/A'],
  BURGLARY: ['BURGLARY', 'HI1', 'HI2', 'HI3'],
  'BREAK IN': ['BURGLARY'],
  THEFT: ['LARCENY', 'UDAA'],
  'CAR THEFT': ['UDAA'],
  'STOLEN CAR': ['UDAA'],
  CARJACKING: ['CARJACK'],
  ROBBERY: ['ROBBERY', 'ROB'],
  FIRE: ['FIRE'],
  OVERDOSE: ['OVERDOSE', 'ONE DOWN'],
  ALARM: ['ALARM', 'ALR'],
  TRAFFIC: ['TRAFFIC', 'AUTO X', 'PARK'],
  DISTURBANCE: ['DISTURB'],
  'DOMESTIC VIOLENCE': ['DV '],
};

const schema = z
  .strictObject({
    ...pointFields,
    radius_km: z.number().min(0.2).max(5).optional().describe('Radius in km (default 1)'),
    hours: z
      .int()
      .min(1)
      .max(48)
      .optional()
      .describe(
        'Look back this many hours from now (default 24). The city publishes with a delay of hours, so short windows are often empty.',
      ),
    category: z
      .string()
      .trim()
      .min(2)
      .max(40)
      .regex(/^[A-Za-z0-9 /&'-]+$/, "letters, digits, spaces and / & ' - only")
      .optional()
      .describe(
        'Only calls whose code or description matches, e.g. "shots", "assault", "crash", "burglary", "alarm", "UDAA"',
      ),
  })
  .superRefine((v, ctx) => refinePoint(v, ctx));

interface Attrs {
  incident_location?: unknown;
  call_description?: unknown;
  category?: unknown;
  priority?: unknown;
  called_at?: unknown;
  total_response_time?: unknown;
  neighborhood_name?: unknown;
  latitude?: unknown;
  longitude?: unknown;
}

export interface DpdCall {
  called_at: string;
  description?: string;
  category?: string;
  priority?: string;
  nearest_intersection?: string;
  neighborhood?: string;
  /** Minutes from the call to the first unit on scene, as the city reports it. */
  response_min: number | null;
  distance_km: number;
  direction: string;
}

export interface DpdDeps extends PointDeps {
  fetch: FetchLike;
}

/** "2026-11-14 10:10:46" (UTC; the layer's dates are UTC). */
function sqlTimestamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** ArcGIS answers errors with HTTP 200 and {error: {code, message}}. */
function parseArcgis(status: number, body: Buffer): Record<string, unknown> {
  if (status === 429) throw new UpstreamError('rate_limited', 'is rate limiting requests', status);
  if (status < 200 || status >= 300)
    throw new UpstreamError('http', `returned HTTP ${status}`, status);
  let j: unknown;
  try {
    j = JSON.parse(body.toString('utf8'));
  } catch {
    throw new UpstreamError('bad_response', 'returned something that is not JSON');
  }
  if (!j || typeof j !== 'object') throw new UpstreamError('bad_response', 'returned no data');
  const err = (j as { error?: { code?: unknown } }).error;
  if (err) {
    const code = typeof err.code === 'number' ? ` ${err.code}` : '';
    throw new UpstreamError('http', `returned an error${code}`);
  }
  return j as Record<string, unknown>;
}

/** A nearest intersection ("A St & B St"); anything else is withheld (never an address). */
function intersection(v: unknown): string | undefined {
  const s = cleanText(v, 120);
  if (!s) return undefined;
  return /\s(&|and)\s/i.test(s) ? s : undefined;
}

function matchesCategory(
  want: string | undefined,
  description?: string,
  category?: string,
): boolean {
  if (!want) return true;
  const w = want.toUpperCase().replace(/\s+/g, ' ');
  const terms = [w, ...(CATEGORY_WORDS[w] ?? [])];
  const hay = `${description ?? ''} | ${category ?? ''}`.toUpperCase();
  return terms.some((t) => hay.includes(t));
}

export function dpdTools(deps: DpdDeps): ToolDef[] {
  const newest = new TtlCache<number | undefined>(10 * 60_000, 1, deps.now);

  async function query(params: Record<string, string>, signal?: AbortSignal) {
    const url = `${DPD_CALLS_LAYER}/query?${new URLSearchParams({ ...params, f: 'json' })}`;
    const r = await fetchBytes(deps.fetch, url, 'City of Detroit open data', {
      timeoutMs: TIMEOUT_MS,
      maxBytes: 6 * 1024 * 1024,
      headers: { accept: 'application/json' },
      signal,
    });
    try {
      return parseArcgis(r.status, r.body);
    } catch (err) {
      if (err instanceof UpstreamError)
        throw new UpstreamError(err.kind, `City of Detroit open data ${err.message}`, err.status);
      throw err;
    }
  }

  /** Newest called_at in the whole dataset: how far behind the city's publication is. */
  const datasetNewest = (signal?: AbortSignal) =>
    untilAborted(
      newest.get('max', async () => {
        const j = await query({
          where: '1=1',
          outStatistics: JSON.stringify([
            {
              statisticType: 'max',
              onStatisticField: 'called_at',
              outStatisticFieldName: 'newest',
            },
          ]),
        });
        const f = (j.features as Array<{ attributes?: { newest?: unknown } }> | undefined)?.[0];
        return num(f?.attributes?.newest);
      }),
      signal,
    );

  return [
    civicTool({
      name: 'dpd_calls_near',
      title: 'Detroit police 911 calls near a point (official, delayed)',
      description:
        'Official Detroit Police Department 911 calls for service near a point (City of Detroit open data), newest first: time called, description, category code, priority (P highest, then 1-5), nearest intersection, neighborhood and response minutes. Official but delayed a few hours (the result says how far behind the dataset is), Detroit city limits only, located only by the nearest intersection, never a house address. Use to cross-check scanner incidents (incidents_near). Point: lat/lon or here: true.',
      schema,
      tags: [
        'police',
        '911',
        '911 calls',
        'dpd',
        'detroit police',
        'calls for service',
        'dispatch',
        'official',
        'crime',
        'shooting',
        'shots fired',
        'assault',
        'crash',
        'incident',
        'what happened',
        'police activity',
        'open data',
      ],
      attribution: DPD_ATTRIBUTION,
      async run(a, ctx): Promise<ToolOutput> {
        const at = resolvePoint(deps, 'dpd_calls_near', a, ctx);
        if (!at.ok) return at.output;
        const { lat, lon } = at.point;
        const radiusKm = a.radius_km ?? 1;
        const hours = a.hours ?? 24;
        const radiusM = radiusKm * 1000;
        const { dLat, dLon } = degreeBox(lat, radiusM);
        const box = {
          minLat: Math.max(lat - dLat, DETROIT_BOX.minLat),
          maxLat: Math.min(lat + dLat, DETROIT_BOX.maxLat),
          minLon: Math.max(lon - dLon, DETROIT_BOX.minLon),
          maxLon: Math.min(lon + dLon, DETROIT_BOX.maxLon),
        };
        const where = at.point.fromPhone ? 'your phone location' : 'this point';
        if (box.minLat > box.maxLat || box.minLon > box.maxLon) {
          return {
            summary: `No Detroit 911 data for ${where}: it is more than ${radiusKm} km outside the City of Detroit, and the Detroit Police Department's open 911 data covers the city only. Nothing was fetched.`,
            data: { covered: false, radius_km: radiusKm, position: at.point.note },
          };
        }
        const now = deps.now();
        const since = now - hours * 3_600_000;
        const f6 = (v: number) => v.toFixed(6);
        let j: Record<string, unknown>;
        let newestMs: number | undefined;
        try {
          const [calls, max] = await Promise.all([
            query(
              {
                where:
                  `called_at >= TIMESTAMP '${sqlTimestamp(since)}'` +
                  ` AND latitude >= ${f6(box.minLat)} AND latitude <= ${f6(box.maxLat)}` +
                  ` AND longitude >= ${f6(box.minLon)} AND longitude <= ${f6(box.maxLon)}`,
                outFields:
                  'incident_location,call_description,category,priority,called_at,total_response_time,neighborhood_name,latitude,longitude',
                orderByFields: 'called_at DESC',
                resultRecordCount: String(PAGE),
                returnGeometry: 'false',
              },
              ctx.signal,
            ),
            datasetNewest(ctx.signal).catch(() => undefined),
          ]);
          j = calls;
          newestMs = max;
        } catch (err) {
          return upstreamFailure(err, 'Detroit 911 calls');
        }
        const features = Array.isArray(j.features)
          ? (j.features as Array<{ attributes?: Attrs }>)
          : [];
        const truncated = j.exceededTransferLimit === true;
        const all: DpdCall[] = [];
        for (const f of features) {
          const x = f.attributes ?? {};
          const t = num(x.called_at);
          const cLat = num(x.latitude);
          const cLon = num(x.longitude);
          if (t === undefined || cLat === undefined || cLon === undefined) continue;
          const d = haversineM(lat, lon, cLat, cLon);
          if (d > radiusM) continue;
          const description = cleanText(x.call_description, 80);
          const category = cleanText(x.category, 20);
          if (!matchesCategory(a.category, description, category)) continue;
          const resp = num(x.total_response_time);
          all.push({
            called_at: new Date(t).toISOString(),
            description,
            category,
            priority: cleanText(x.priority, 4),
            nearest_intersection: intersection(x.incident_location),
            neighborhood: cleanText(x.neighborhood_name, 80),
            response_min: resp !== undefined && resp >= 0 ? round(resp, 1) : null,
            distance_km: round(d / 1000, 2),
            direction: compassPoint(bearingDeg(lat, lon, cLat, cLon)),
          });
        }
        all.sort((p, q) => q.called_at.localeCompare(p.called_at));
        const listed = all.slice(0, MAX_LISTED);
        const counts = new Map<string, number>();
        for (const c of all) {
          const k = c.description ?? c.category ?? 'unknown';
          counts.set(k, (counts.get(k) ?? 0) + 1);
        }
        const top = [...counts]
          .sort((p, q) => q[1] - p[1])
          .slice(0, 5)
          .map(([k, n]) => `${k} (${n})`)
          .join(', ');
        const lag =
          newestMs !== undefined
            ? ` The newest call in the whole dataset was placed ${new Date(newestMs).toISOString()} (${humanAge(Math.max(0, Math.round((now - newestMs) / 1000)))} ago); later calls are not published yet.`
            : ' How far behind the dataset is could not be checked just now.';
        const filter = a.category ? ` matching "${a.category}"` : '';
        const head = all.length
          ? `${all.length} DPD 911 call(s)${filter} within ${radiusKm} km of ${where} in the last ${hours} h, newest first. Most common: ${top}.`
          : `No DPD 911 calls${filter} within ${radiusKm} km of ${where} in the last ${hours} h.`;
        const latest = listed[0]
          ? ` Latest: ${listed[0].description ?? listed[0].category ?? 'call'} at ${listed[0].nearest_intersection ?? 'an unlisted location'} (${listed[0].called_at}).`
          : '';
        const more = all.length > listed.length ? ` Listing the newest ${listed.length}.` : '';
        const cut = truncated
          ? ` More than ${PAGE} calls matched the search box, so only the newest ${PAGE} were checked.`
          : '';
        return {
          summary:
            `${head}${latest}${more}${cut} Official City of Detroit data, delayed a few hours.${lag}` +
            ' Locations are the nearest intersection only, never a house address; Detroit city limits only.',
          data: {
            label: 'official, delayed a few hours',
            radius_km: radiusKm,
            hours,
            category: a.category ?? null,
            position: at.point.note,
            count: all.length,
            dataset_newest_call: newestMs !== undefined ? new Date(newestMs).toISOString() : null,
            priority_scale: 'P is highest, then 1 (most urgent number) to 5',
            calls: listed,
            ...(truncated ? { calls_truncated: `only the newest ${PAGE} calls were checked` } : {}),
          },
          observedAt:
            newestMs !== undefined ? new Date(newestMs).toISOString() : listed[0]?.called_at,
        };
      },
    }),
  ];
}
