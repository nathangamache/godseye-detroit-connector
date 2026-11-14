/**
 * MDOT RIDE (Real-Time Data Exchange): "Work Zone Location Information" (WZDx v4, listed in the
 * USDOT WZDx registry as mdot_4: GeoJSON, 5-minute updates, api_key header) and "Traffic
 * Events". Off until MDOT_RIDE_API_KEY is set. Polled at most every MDOT_RIDE_CACHE_S (≥ 5 min)
 * per dataset, whoever asks, whether the last poll worked or failed.
 *
 * The RIDE documentation sits behind a MiLogin for Business login, so the Traffic Events dataset
 * name and its record shape are unverified: the slug is configurable and the parser accepts
 * WZDx-style GeoJSON as well as flat records with the usual field names.
 */
import type { ClosureQuery, ClosureSource, FetchResult, Kind, RoadItem } from '../closures.js';
import { MICHIGAN, decodePolyline, type LonLat } from '../geo.js';
import { TtlCache, errorText, type Http } from '../http.js';
import { cleanText } from '../text.js';

export const MDOT_ATTRIBUTION = 'Michigan Department of Transportation (MDOT RIDE)';

export interface MdotOptions {
  http: Http;
  baseUrl: string;
  key?: string;
  workZonesDataset: string;
  eventsDataset: string;
  limit: number;
  cacheMs: number;
  now: () => number;
}

type Json = Record<string, unknown>;

function pick(o: Json, keys: string[]): unknown {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
  return undefined;
}

function text(o: Json, keys: string[], max = 120): string | null {
  const v = pick(o, keys);
  if (Array.isArray(v))
    return cleanText(
      v
        .filter((x) => typeof x === 'string')
        .slice(0, 4)
        .join(' / '),
      max,
    );
  return cleanText(v, max);
}

function when(o: Json, keys: string[]): string | null {
  const v = pick(o, keys);
  if (typeof v === 'number' && Number.isFinite(v))
    return new Date(v > 1e12 ? v : v * 1000).toISOString();
  if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) return cleanText(v, 40);
  return null;
}

function geometryLines(g: unknown): LonLat[][] {
  const geo = g as { type?: unknown; coordinates?: unknown; geometries?: unknown } | undefined;
  const ok = (p: unknown): p is [number, number] =>
    Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number';
  const line = (c: unknown): LonLat[] =>
    Array.isArray(c)
      ? c
          .filter(ok)
          .slice(0, 2000)
          .map((p) => [p[0], p[1]] as LonLat)
      : [];
  switch (geo?.type) {
    case 'Point':
      return ok(geo.coordinates) ? [[[geo.coordinates[0], geo.coordinates[1]]]] : [];
    case 'LineString':
    case 'MultiPoint':
      return [line(geo.coordinates)];
    case 'MultiLineString':
      return Array.isArray(geo.coordinates) ? geo.coordinates.slice(0, 50).map(line) : [];
    case 'GeometryCollection':
      return Array.isArray(geo.geometries)
        ? geo.geometries.slice(0, 20).flatMap(geometryLines)
        : [];
    default:
      return [];
  }
}

/** The records of a RIDE answer: a FeatureCollection, an array, or one wrapped in data/results. */
export function recordsOf(j: unknown, depth = 0): unknown[] {
  if (depth > 3 || !j) return [];
  if (Array.isArray(j)) return j;
  if (typeof j !== 'object') return [];
  const o = j as Json;
  for (const k of ['features', 'data', 'results', 'items', 'events', 'records'])
    if (o[k] !== undefined) return recordsOf(o[k], depth + 1);
  return [];
}

function lanesSummary(lanes: unknown): { text: string | null; allClosed: boolean } {
  if (!Array.isArray(lanes) || !lanes.length) return { text: null, allClosed: false };
  const travel = lanes.filter((l) => !/shoulder/i.test(String((l as Json)?.type ?? ''))) as Json[];
  if (!travel.length) return { text: null, allClosed: false };
  const closed = travel.filter((l) => String(l.status ?? '').toLowerCase() === 'closed').length;
  return {
    text: closed
      ? `${closed} of ${travel.length} lane(s) closed`
      : `${travel.length} lane(s), none closed`,
    allClosed: closed === travel.length,
  };
}

/** One RIDE record (WZDx v4 feature or a flat event) -> an item, or undefined. */
export function parseRideRecord(
  raw: unknown,
  defaultKind: Kind,
  index: number,
): RoadItem | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const rec = raw as Json;
  const props = (
    rec.properties && typeof rec.properties === 'object' ? rec.properties : rec
  ) as Json;
  const core = (
    props.core_details && typeof props.core_details === 'object' ? props.core_details : props
  ) as Json;
  let lines = geometryLines(rec.geometry ?? props.geometry);
  if (!lines.some((l) => l.length)) {
    const poly = pick(props, ['encoded_polyline', 'EncodedPolyline', 'polyline']);
    if (typeof poly === 'string') lines = [decodePolyline(poly, 5)];
  }
  if (!lines.some((l) => l.length)) {
    const lat = Number(pick(props, ['latitude', 'lat', 'Latitude', 'start_latitude']));
    const lon = Number(pick(props, ['longitude', 'lon', 'lng', 'Longitude', 'start_longitude']));
    if (Number.isFinite(lat) && Number.isFinite(lon) && (lat || lon)) lines = [[[lon, lat]]];
  }
  lines = lines.filter((l) => l.length);
  if (!lines.length) return undefined;
  const eventType = text(core, ['event_type', 'eventType', 'EventType', 'type', 'category'], 60);
  const kind: Kind =
    eventType && /work[-\s_]?zone|construction|roadwork|maintenance/i.test(eventType)
      ? 'work_zone'
      : eventType
        ? 'incident'
        : defaultKind;
  const impact = text(props, ['vehicle_impact', 'impact', 'Impact', 'lane_impact'], 80);
  const lanes = lanesSummary(props.lanes);
  const lanesText =
    lanes.text ?? text(props, ['lanes_affected', 'LanesAffected', 'lanes_blocked'], 80);
  const description = cleanText(
    [
      text(core, ['description', 'Description', 'headline', 'name', 'details'], 300),
      text(props, ['comment', 'Comment'], 200),
    ]
      .filter(Boolean)
      .join(' — '),
    300,
  );
  const full =
    lanes.allClosed ||
    /all[-\s]lanes[-\s]closed|road[-\s]closed|full[-\s]closure/i.test(
      `${impact ?? ''} ${lanesText ?? ''}`,
    ) ||
    props.is_full_closure === true ||
    props.IsFullClosure === true;
  const types = Array.isArray(props.types_of_work)
    ? (props.types_of_work as Json[])
        .map((t) => cleanText(t?.type_name, 40))
        .filter(Boolean)
        .slice(0, 3)
        .join(', ')
    : '';
  const id =
    cleanText(rec.id ?? props.id ?? core.data_source_id ?? props.event_id, 80) ?? String(index);
  return {
    source: 'mdot_ride',
    id: `mdot_ride:${id}`,
    kind,
    type:
      cleanText(
        [eventType ?? (kind === 'work_zone' ? 'work zone' : 'incident'), types]
          .filter(Boolean)
          .join(': '),
        80,
      ) ?? kind,
    road: text(
      core,
      ['road_names', 'road_name', 'roadName', 'roadway', 'roadway_name', 'RoadwayName', 'route'],
      80,
    ),
    direction: text(
      core,
      ['direction', 'DirectionOfTravel', 'direction_of_travel', 'directionOfTravel'],
      30,
    ),
    lanes: lanesText,
    vehicle_impact: impact,
    full_closure: full,
    description,
    from_cross_street: text(
      props,
      ['beginning_cross_street', 'from_cross_street', 'cross_street_from', 'from'],
      100,
    ),
    to_cross_street: text(
      props,
      ['ending_cross_street', 'to_cross_street', 'cross_street_to', 'to'],
      100,
    ),
    start: when(props, ['start_date', 'startDate', 'start_time', 'StartDate', 'start']),
    end: when(props, ['end_date', 'endDate', 'end_time', 'PlannedEndDate', 'end']),
    updated:
      when(core, ['update_date', 'updated', 'last_updated', 'LastUpdated', 'updateDate']) ??
      when(props, ['update_date', 'updated', 'last_updated']),
    lines,
  };
}

export function mdotRideSource(o: MdotOptions): ClosureSource {
  // A failed poll is held as long as a good one, so a failing dataset (an unverified events
  // slug, an outage) is still asked at most once per MDOT_RIDE_CACHE_S.
  const caches = {
    work_zones: new TtlCache<RoadItem[]>(o.cacheMs, o.now, o.cacheMs),
    events: new TtlCache<RoadItem[]>(o.cacheMs, o.now, o.cacheMs),
  };
  const load = async (dataset: string, kind: Kind): Promise<RoadItem[]> => {
    const u = new URL(`${o.baseUrl}/${encodeURIComponent(dataset)}/query`);
    u.searchParams.set('limit', String(o.limit));
    u.searchParams.set('_format', 'json');
    // Not tied to one caller's signal: the answer is shared for the cache period.
    const j = await o.http.json('MDOT RIDE', u, {
      headers: { api_key: o.key! },
      maxBytes: 8 * 1024 * 1024,
      timeoutMs: 20_000,
    });
    return recordsOf(j)
      .slice(0, 5000)
      .map((r, i) => parseRideRecord(r, kind, i))
      .filter((x): x is RoadItem => Boolean(x));
  };
  return {
    id: 'mdot_ride',
    label: 'MDOT RIDE',
    attribution: MDOT_ATTRIBUTION,
    coverage: MICHIGAN,
    unavailable: () =>
      o.key
        ? undefined
        : {
            status: 'not_configured',
            note: 'not configured: set MDOT_RIDE_API_KEY in deploy/secrets/gateway.env',
          },
    async fetch(q: ClosureQuery, signal: AbortSignal): Promise<FetchResult> {
      const wanted: Array<['work_zones' | 'events', string, Kind]> = [];
      if (q.include.has('work_zone')) wanted.push(['work_zones', o.workZonesDataset, 'work_zone']);
      if (q.include.has('incident')) wanted.push(['events', o.eventsDataset, 'incident']);
      const abort = new Promise<never>((_, rej) =>
        signal.addEventListener('abort', () => rej(new Error('MDOT RIDE timed out')), {
          once: true,
        }),
      );
      abort.catch(() => undefined);
      const got = await Promise.allSettled(
        wanted.map(([k, ds, kind]) =>
          Promise.race([caches[k].get(k, () => load(ds, kind)), abort]),
        ),
      );
      const items: RoadItem[] = [];
      const notes: string[] = [];
      let age = 0;
      got.forEach((g, i) => {
        const [k, ds] = wanted[i]!;
        if (g.status === 'fulfilled') {
          items.push(...g.value.value);
          age = Math.max(age, g.value.ageMs);
        } else {
          const hint =
            k === 'events'
              ? ` (the dataset name is unverified: set MDOT_RIDE_EVENTS_DATASET if "${ds}" is wrong)`
              : '';
          notes.push(
            `${k === 'events' ? 'traffic events' : 'work zones'}: ${errorText(g.reason)}${hint}`,
          );
        }
      });
      if (got.length && got.every((g) => g.status === 'rejected'))
        throw new Error(notes.join('; '));
      return { items, cacheAgeMs: age, note: notes.join('; ') || undefined };
    },
  };
}
