/**
 * transit_vehicles_near: live SMART bus positions and service alerts from Swiftly's
 * GTFS-Realtime feeds (detroit-smartbus). Needs SWIFTLY_API_KEY, sent as the Authorization
 * header as Swiftly documents; without it the tool is OFF and fetches nothing.
 *
 * Swiftly's API licence grants display inside the licensee's application and bars sharing or
 * redistributing the content, so: one in-memory snapshot, at most 30 s old and deleted when it
 * expires, never written to disk, logged or exported; results are for showing to the user.
 * Route names and headsigns come from SMART's public static GTFS (in memory, refreshed daily).
 * DDOT and the QLINE have no public real-time feed this gateway can use.
 */
import { z } from 'zod';
import { bearingDeg, compassPoint, haversineM } from '../../util/geo.js';
import { humanAge } from '../../util/format.js';
import type { ToolDef, ToolOutput } from '../../tools/types.js';
import {
  civicTool,
  cleanText,
  fetchBytes,
  httpUrl,
  notConfigured,
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
import {
  ALERT_CAUSES,
  ALERT_EFFECTS,
  decodeFeed,
  ProtobufError,
  VEHICLE_STATUS,
  type Alert,
  type Feed,
  type TripUpdate,
} from './gtfsrt.js';
import { SMART_STATIC_GTFS_URL, scheduleNames, type ScheduleNames } from './gtfsStatic.js';

export const SWIFTLY_BASE = 'https://api.goswift.ly/real-time/detroit-smartbus';
export const TRANSIT_ATTRIBUTION =
  'SMART (via Swiftly): live data shown for display only, never stored or exported; route names and headsigns from the SMART GTFS schedule';

/** Swiftly content is never kept longer than this (Swiftly: cache at least 30 s server-side). */
export const SNAPSHOT_TTL_MS = 30_000;
const MAX_LISTED = 25;
const MAX_ALERTS = 10;
/** How long a call waits for the static GTFS names before answering without them. */
const SCHEDULE_WAIT_MS = 8_000;

const schema = z
  .strictObject({
    ...pointFields,
    radius_km: z.number().min(0.5).max(10).optional().describe('Radius in km (default 2)'),
    route: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .regex(/^[\p{L}\p{N} .&'/-]+$/u, "letters, digits, spaces and . & ' / - only")
      .optional()
      .describe(
        'Only this SMART route: its number (e.g. "125") or part of its name (e.g. "Gratiot")',
      ),
  })
  .superRefine((v, ctx) => refinePoint(v, ctx));

export interface TransitDeps extends PointDeps {
  fetch: FetchLike;
  apiKey?: string;
  /** Fetch SMART's static GTFS for route names and headsigns (SMART_STATIC_GTFS). */
  staticGtfs: boolean;
}

interface Snapshot {
  fetchedAt: number;
  feedTimestamp?: number;
  vehicles: Feed['vehicles'];
  byTrip: Map<string, TripUpdate>;
  byVehicle: Map<string, TripUpdate>;
  alerts: Alert[];
  warnings: string[];
}

export interface TransitVehicle {
  route?: string;
  route_name?: string;
  headsign?: string;
  vehicle_id?: string;
  lat: number;
  lon: number;
  distance_km: number;
  /** Bearing from the point to the vehicle. */
  bearing_deg: number;
  direction: string;
  /** Direction the vehicle is heading, as it reports. */
  heading_deg?: number;
  speed_kmh?: number;
  /** Seconds behind (+) or ahead of (-) schedule, from the trip update. */
  delay_s?: number;
  delay?: string;
  status?: string;
  updated?: string;
  age_s?: number;
}

function delayText(s: number | undefined): string | undefined {
  if (s === undefined) return undefined;
  const m = Math.round(Math.abs(s) / 60);
  if (m === 0) return 'on time';
  return `${m} min ${s > 0 ? 'late' : 'early'}`;
}

/** English text of a translated string (or the first). */
function english(t: Alert['header'], max: number): string | undefined {
  const pick = t.find((x) => !x.language || /^en/i.test(x.language)) ?? t[0];
  return cleanText(pick?.text, max);
}

export function transitTools(deps: TransitDeps): ToolDef[] {
  const snapshot = new TtlCache<Snapshot>(SNAPSHOT_TTL_MS, 1, deps.now);
  const schedule = new TtlCache<ScheduleNames | null>(24 * 3_600_000, 1, deps.now);

  const feed = async (path: string, maxBytes: number): Promise<Feed> => {
    const r = await fetchBytes(deps.fetch, `${SWIFTLY_BASE}/${path}`, 'Swiftly', {
      timeoutMs: 15_000,
      maxBytes,
      headers: { authorization: deps.apiKey ?? '', accept: 'application/x-protobuf' },
    });
    if (r.status === 401 || r.status === 403)
      throw new UpstreamError(
        'auth',
        `Swiftly rejected the API key (HTTP ${r.status}); check SWIFTLY_API_KEY in deploy/secrets/gateway.env`,
        r.status,
      );
    if (r.status === 429)
      throw new UpstreamError('rate_limited', 'Swiftly is rate limiting requests', 429);
    if (r.status < 200 || r.status >= 300)
      throw new UpstreamError('http', `Swiftly returned HTTP ${r.status}`, r.status);
    try {
      return decodeFeed(r.body);
    } catch (err) {
      if (err instanceof ProtobufError)
        throw new UpstreamError('bad_response', 'Swiftly sent a feed that could not be read');
      throw err;
    }
  };

  /** Static GTFS names; a failure is remembered for an hour as "none" so it isn't retried hot. */
  const names = (): Promise<ScheduleNames | null> => {
    if (!deps.staticGtfs) return Promise.resolve(null);
    return schedule.get('smart', async () => {
      try {
        const r = await fetchBytes(deps.fetch, SMART_STATIC_GTFS_URL, 'SMART GTFS', {
          timeoutMs: 60_000,
          maxBytes: 40 * 1024 * 1024,
        });
        if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
        return scheduleNames(r.body);
      } catch {
        const retry = setTimeout(() => schedule.clear(), 3_600_000);
        retry.unref();
        return null;
      }
    });
  };

  /**
   * Names if they are ready within a few seconds; otherwise answer without them (the first
   * download keeps going and later calls get them).
   */
  const namesSoon = (): Promise<ScheduleNames | null> => {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), SCHEDULE_WAIT_MS);
      timer.unref();
    });
    return Promise.race([names(), late]).finally(() => clearTimeout(timer));
  };

  const load = (): Promise<Snapshot> =>
    snapshot.get('smart', async () => {
      const fetchedAt = deps.now();
      const [vp, tu, al] = await Promise.allSettled([
        feed('gtfs-rt-vehicle-positions', 8 * 1024 * 1024),
        feed('gtfs-rt-trip-updates', 24 * 1024 * 1024),
        feed('gtfs-rt-alerts/v2', 4 * 1024 * 1024),
      ]);
      if (vp.status === 'rejected') throw vp.reason;
      const warnings: string[] = [];
      const byTrip = new Map<string, TripUpdate>();
      const byVehicle = new Map<string, TripUpdate>();
      if (tu.status === 'fulfilled') {
        for (const u of tu.value.tripUpdates) {
          if (u.trip?.trip_id) byTrip.set(u.trip.trip_id, u);
          if (u.vehicle_id) byVehicle.set(u.vehicle_id, u);
        }
      } else warnings.push('delays unavailable (the trip-update feed failed)');
      if (al.status === 'rejected')
        warnings.push('service alerts unavailable (the alerts feed failed)');
      return {
        fetchedAt,
        feedTimestamp: vp.value.timestamp,
        vehicles: vp.value.vehicles,
        byTrip,
        byVehicle,
        alerts: al.status === 'fulfilled' ? al.value.alerts : [],
        warnings,
      };
    });

  const description =
    'Live SMART (suburban Detroit) bus positions near a point, nearest first: route, headsign, vehicle id, position, distance and bearing from the point, heading, delay and when each vehicle last reported, plus active SMART service alerts for those routes. Data from SMART via Swiftly, for display only. DDOT and QLINE vehicles are not included (no public real-time feed this connector can use). Point: lat/lon or here: true.';

  return [
    civicTool({
      name: 'transit_vehicles_near',
      title: 'SMART buses near a point (live)',
      description: deps.apiKey
        ? description
        : `OFF: not configured (set SWIFTLY_API_KEY in deploy/secrets/gateway.env). ${description}`,
      schema,
      tags: [
        'bus',
        'buses',
        'smart',
        'smart bus',
        'suburban bus',
        'transit',
        'public transit',
        'where is my bus',
        'next bus',
        'bus late',
        'service alert',
        'detour',
        'realtime vehicles',
        'gtfs-rt',
        'swiftly',
      ],
      attribution: TRANSIT_ATTRIBUTION,
      async run(a, ctx): Promise<ToolOutput> {
        if (!deps.apiKey)
          return notConfigured(
            'transit_vehicles_near',
            'SWIFTLY_API_KEY',
            'a free Swiftly real-time API key for SMART',
          );
        const at = resolvePoint(deps, 'transit_vehicles_near', a, ctx);
        if (!at.ok) return at.output;
        const { lat, lon } = at.point;
        const radiusKm = a.radius_km ?? 2;
        let snap: Snapshot;
        let sched: ScheduleNames | null;
        try {
          [snap, sched] = await Promise.all([
            untilAborted(load(), ctx.signal),
            untilAborted(namesSoon(), ctx.signal).catch(() => null),
          ]);
        } catch (err) {
          return upstreamFailure(err, 'SMART real-time (Swiftly)');
        }
        const now = deps.now();
        const want = a.route?.toLowerCase();
        const routeOk = (routeId?: string, short?: string, long?: string) =>
          !want ||
          [routeId, short].some((x) => x?.toLowerCase() === want) ||
          Boolean(want.length >= 3 && long?.toLowerCase().includes(want));
        const near: Array<TransitVehicle & { route_keys: string[] }> = [];
        for (const v of snap.vehicles) {
          if (v.lat === undefined || v.lon === undefined) continue;
          if (!Number.isFinite(v.lat) || !Number.isFinite(v.lon)) continue;
          if (Math.abs(v.lat) < 1e-6 && Math.abs(v.lon) < 1e-6) continue;
          const d = haversineM(lat, lon, v.lat, v.lon);
          if (d > radiusKm * 1000) continue;
          const tripId = v.trip?.trip_id;
          const tu =
            (tripId ? snap.byTrip.get(tripId) : undefined) ??
            (v.vehicle_id ? snap.byVehicle.get(v.vehicle_id) : undefined);
          const st = tripId ? sched?.trips.get(tripId) : undefined;
          const routeId = v.trip?.route_id ?? tu?.trip?.route_id ?? st?.route_id;
          const r = routeId ? sched?.routes.get(routeId) : undefined;
          if (!routeOk(routeId, r?.short, r?.long)) continue;
          const brg = bearingDeg(lat, lon, v.lat, v.lon);
          const ts = v.timestamp ?? snap.feedTimestamp;
          near.push({
            route: cleanText(r?.short ?? routeId, 20),
            route_name: cleanText(r?.long, 80),
            headsign: cleanText(tu?.headsign ?? st?.headsign, 80),
            vehicle_id: cleanText(v.vehicle_label ?? v.vehicle_id, 30),
            lat: round(v.lat, 5),
            lon: round(v.lon, 5),
            distance_km: round(d / 1000, 2),
            bearing_deg: Math.round(brg),
            direction: compassPoint(brg),
            heading_deg:
              v.bearing !== undefined && Number.isFinite(v.bearing)
                ? Math.round(((v.bearing % 360) + 360) % 360)
                : undefined,
            speed_kmh:
              v.speed !== undefined && Number.isFinite(v.speed) && v.speed >= 0
                ? round(v.speed * 3.6, 0)
                : undefined,
            delay_s: tu?.delay,
            delay: delayText(tu?.delay),
            status: v.current_status !== undefined ? VEHICLE_STATUS[v.current_status] : undefined,
            updated: ts ? new Date(ts * 1000).toISOString() : undefined,
            age_s: ts ? Math.max(0, Math.round(now / 1000 - ts)) : undefined,
            route_keys: [routeId, r?.short].filter((x): x is string => Boolean(x)),
          });
        }
        near.sort((p, q) => p.distance_km - q.distance_km);
        const listed: TransitVehicle[] = near
          .slice(0, MAX_LISTED)
          .map(({ route_keys: _keys, ...v }) => v);
        // Routes whose alerts matter: those of the buses listed, and the one asked for.
        const routes = new Set(
          near
            .slice(0, MAX_LISTED)
            .flatMap((v) => v.route_keys)
            .map((x) => x.toLowerCase()),
        );
        if (want) routes.add(want);
        const nowS = now / 1000;
        const alerts = snap.alerts
          .filter(
            (al) =>
              !al.active.length ||
              al.active.some((p) => (p.start ?? 0) <= nowS && (p.end ?? Infinity) >= nowS),
          )
          .filter(
            (al) =>
              !al.informed.length ||
              al.informed.some(
                (e) =>
                  (!e.route_id && !e.stop_id && !e.trip) ||
                  (e.route_id !== undefined && routes.has(e.route_id.toLowerCase())),
              ),
          )
          .slice(0, MAX_ALERTS)
          .map((al) => ({
            header: english(al.header, 200),
            description: english(al.description, 600),
            effect: al.effect !== undefined ? ALERT_EFFECTS[al.effect] : undefined,
            cause: al.cause !== undefined ? ALERT_CAUSES[al.cause] : undefined,
            routes: [
              ...new Set(al.informed.map((e) => e.route_id).filter((x): x is string => !!x)),
            ].slice(0, 20),
            url: httpUrl(al.url[0]?.text),
          }));
        const where = at.point.fromPhone ? 'your phone location' : 'this point';
        const routeNote = a.route ? ` on route ${a.route}` : '';
        const first = listed
          .slice(0, 5)
          .map(
            (v) =>
              `route ${v.route ?? '?'}${v.headsign ? ` to ${v.headsign}` : ''}${v.vehicle_id ? ` (bus ${v.vehicle_id})` : ''}, ${v.distance_km} km ${v.direction}${v.delay ? `, ${v.delay}` : ''}${v.age_s !== undefined ? `, reported ${humanAge(v.age_s)} ago` : ''}`,
          )
          .join('; ');
        const head = listed.length
          ? `${near.length} SMART bus(es)${routeNote} within ${radiusKm} km of ${where}, nearest first: ${first}.`
          : `No SMART buses${routeNote} reporting within ${radiusKm} km of ${where} right now.`;
        const alertNote = alerts.length
          ? ` ${alerts.length} active SMART service alert(s): ${alerts
              .slice(0, 3)
              .map((x) => x.header ?? x.effect ?? 'alert')
              .join('; ')}.`
          : '';
        const warnings = [
          ...snap.warnings,
          ...(deps.staticGtfs && !sched && listed.length
            ? ['route names and headsigns unavailable (the SMART schedule is not loaded yet)']
            : []),
        ];
        const warn = warnings.length ? ` Note: ${warnings.join('; ')}.` : '';
        const feedAge = snap.feedTimestamp
          ? Math.max(0, Math.round(nowS - snap.feedTimestamp))
          : undefined;
        return {
          summary:
            `${head}${alertNote}${warn} Live data from SMART (via Swiftly), for display only` +
            `${feedAge !== undefined ? `; feed ${humanAge(feedAge)} old` : ''}. DDOT and QLINE vehicles are not included (no public real-time feed this connector can use).`,
          data: {
            radius_km: radiusKm,
            route: a.route ?? null,
            position: at.point.note,
            count: near.length,
            vehicles: listed,
            ...(near.length > listed.length
              ? { vehicles_truncated: `${near.length - listed.length} farther bus(es) omitted` }
              : {}),
            alerts,
            feed_timestamp: snap.feedTimestamp
              ? new Date(snap.feedTimestamp * 1000).toISOString()
              : null,
            display_only:
              'SMART real-time data via Swiftly: show it to the user; do not store or republish it',
            not_covered: 'DDOT and QLINE (no public real-time feed available to this connector)',
            ...(warnings.length ? { warnings } : {}),
          },
          observedAt: snap.feedTimestamp
            ? new Date(snap.feedTimestamp * 1000).toISOString()
            : undefined,
        };
      },
    }),
  ];
}
