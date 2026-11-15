/**
 * Valhalla routing (FOSSGIS valhalla1.openstreetmap.de by default; VALHALLA_URL) that avoids
 * live closures: route once, find the full closures the route runs through (open-data sources
 * only), then route again with small exclude_polygons around them. At most one request a
 * second to the server, from every caller together.
 */
import { haversineM } from '../../util/geo.js';
import {
  reportSentence,
  type ClosureQuery,
  type ClosureService,
  type ClosureSource,
  type RoadItem,
  type SourceId,
  type SourceReport,
} from './closures.js';
import {
  COVERAGE,
  SegmentGrid,
  bboxOf,
  decodePolyline,
  ringPerimeterM,
  samplePoints,
  segmentRing,
  type LonLat,
  type Point,
} from './geo.js';
import { HttpError, errorText, type Http, type Pacer } from './http.js';
import { cleanText } from './text.js';

export const VALHALLA_ATTRIBUTION =
  'Routing: Valhalla/FOSSGIS, data © OpenStreetMap contributors (ODbL); fix the map: https://www.openstreetmap.org/fixthemap';

/** Valhalla caps the total perimeter of exclude_polygons (10 km by default); stay under it. */
export const EXCLUDE_BUDGET_M = 9_000;
/** A closure within this distance of the route counts as on it. */
const ON_ROUTE_M = 35;
/** Closures this close to the start or the end can't be avoided. */
const ENDPOINT_M = 150;

export interface Maneuver {
  instruction: string;
  street_names: string[];
  length: number;
  duration_s: number;
}

interface Trip {
  distance: number;
  duration_s: number;
  maneuvers: Maneuver[];
  shape: LonLat[];
}

export class RouteError extends Error {
  constructor(
    message: string,
    readonly noRoute = false,
  ) {
    super(message);
  }
}

export interface Router {
  route(
    from: Point,
    to: Point,
    units: 'mi' | 'km',
    exclude: LonLat[][],
    signal: AbortSignal,
  ): Promise<Trip>;
}

export function valhallaRouter(o: { http: Http; baseUrl: string; pacer: Pacer }): Router {
  return {
    async route(from, to, units, exclude, signal) {
      await o.pacer.wait(signal);
      const body = {
        locations: [
          { lat: from.lat, lon: from.lon },
          { lat: to.lat, lon: to.lon },
        ],
        costing: 'auto',
        units: units === 'mi' ? 'miles' : 'kilometers',
        language: 'en-US',
        directions_options: { units: units === 'mi' ? 'miles' : 'kilometers', language: 'en-US' },
        ...(exclude.length ? { exclude_polygons: exclude } : {}),
      };
      let text: string;
      try {
        text = await o.http.text('Valhalla', `${o.baseUrl}/route`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          maxBytes: 4 * 1024 * 1024,
          signal,
        });
      } catch (err) {
        // 400 with error_code 442 etc. means no path; the body is not passed on.
        if (err instanceof HttpError && err.status === 400)
          throw new RouteError('no route could be found between those points', true);
        throw new RouteError(errorText(err));
      }
      let j: { trip?: { summary?: { length?: unknown; time?: unknown }; legs?: unknown[] } };
      try {
        j = JSON.parse(text);
      } catch {
        throw new RouteError('Valhalla returned invalid JSON');
      }
      const trip = j.trip;
      if (!trip?.legs?.length) throw new RouteError('Valhalla returned no route', true);
      const maneuvers: Maneuver[] = [];
      const shape: LonLat[] = [];
      for (const leg of trip.legs.slice(0, 5) as Array<{
        maneuvers?: unknown[];
        shape?: unknown;
      }>) {
        if (typeof leg.shape === 'string') shape.push(...decodePolyline(leg.shape, 6, 50_000));
        for (const m of (leg.maneuvers ?? []).slice(0, 500) as Array<Record<string, unknown>>) {
          maneuvers.push({
            instruction: cleanText(m.instruction, 200) ?? '',
            street_names: Array.isArray(m.street_names)
              ? m.street_names
                  .map((s) => cleanText(s, 80))
                  .filter((s): s is string => Boolean(s))
                  .slice(0, 4)
              : [],
            length: Math.round((Number(m.length) || 0) * 100) / 100,
            duration_s: Math.round(Number(m.time) || 0),
          });
        }
      }
      return {
        distance: Math.round((Number(trip.summary?.length) || 0) * 10) / 10,
        duration_s: Math.round(Number(trip.summary?.time) || 0),
        maneuvers,
        shape,
      };
    },
  };
}

/** The points (20 m apart) of a closure that lie on the route. */
function onRoute(it: RoadItem, grid: SegmentGrid): Point[] {
  return it.lines.flatMap((l) =>
    samplePoints(l, 20, 400).filter((p) => grid.distanceM(p) <= ON_ROUTE_M),
  );
}

/** The closures (and lane closures) a route's shape runs through. */
export function closuresOnRoute(items: RoadItem[], shape: LonLat[]): RoadItem[] {
  if (shape.length < 2) return [];
  const grid = new SegmentGrid(shape);
  return items.filter((it) => onRoute(it, grid).length > 0);
}

/** True when every on-route part of the closure is at the trip's start or end. */
export function atTripEnds(it: RoadItem, shape: LonLat[], ends: Point[]): boolean {
  const pts = onRoute(it, new SegmentGrid(shape));
  return (
    pts.length > 0 &&
    pts.every((p) => ends.some((e) => haversineM(e.lat, e.lon, p.lat, p.lon) <= ENDPOINT_M))
  );
}

/**
 * Small square rings on the closed road where the route uses it. Valhalla drops every edge a
 * ring touches, so a few rings inside the closed stretch are enough; rings stay away from the
 * closure's own ends, where they would also catch the cross streets a detour needs. The total
 * perimeter stays within Valhalla's limit.
 */
export function excludeRings(
  items: RoadItem[],
  shape: LonLat[],
): { rings: LonLat[][]; kept: RoadItem[]; dropped: RoadItem[] } {
  const grid = new SegmentGrid(shape);
  const rings: LonLat[][] = [];
  const kept: RoadItem[] = [];
  const dropped: RoadItem[] = [];
  let used = 0;
  for (const it of items) {
    const near = onRoute(it, grid);
    const ends = it.lines.flatMap((l) => (l.length > 1 ? [l[0]!, l[l.length - 1]!] : []));
    const inner = near.filter(
      (p) => !ends.some(([lon, lat]) => haversineM(lat, lon, p.lat, p.lon) < 30),
    );
    const pool = inner.length ? inner : near;
    const picks =
      pool.length <= 3
        ? pool
        : [pool[0]!, pool[Math.floor(pool.length / 2)]!, pool[pool.length - 1]!];
    const mine = picks.map((p) => segmentRing([p.lon, p.lat], [p.lon, p.lat], 12));
    const cost = mine.reduce((m, r) => m + ringPerimeterM(r), 0);
    if (!mine.length || used + cost > EXCLUDE_BUDGET_M) {
      dropped.push(it);
      continue;
    }
    used += cost;
    rings.push(...mine);
    kept.push(it);
  }
  return { rings, kept, dropped };
}

export interface RouteAnswer {
  distance: number;
  units: 'mi' | 'km';
  duration_min: number;
  maneuvers: Maneuver[];
  maneuvers_truncated?: string;
  closures_avoided: Array<{
    road: string | null;
    description: string | null;
    type: string;
    source: string;
  }>;
  warnings: string[];
  sources?: SourceReport[];
  /**
   * "used": at least one closure source answered (the route accounts for what it reported);
   * "none": closures were to be avoided but no source answered (down, excluded, not
   * configured or not covering the route); "not_checked": avoid_closures=false.
   */
  closure_data: 'used' | 'none' | 'not_checked';
  /** TomTom is on but left out, its licence excluding navigation use. */
  tomtom_excluded: boolean;
  /** The closure sources whose items (or counts of them) the answer reports. */
  closureSources: SourceId[];
  /** Their attribution lines, in source order. */
  attributions: string[];
}

const MAX_MANEUVERS = 60;

/** The closure sources routing may use (TomTom, for one, skips every route query). */
export function routingSources(closures: ClosureService): ClosureSource[] {
  const probe: ClosureQuery = {
    bbox: COVERAGE,
    when: 'now',
    include: new Set(['incident', 'work_zone']),
    now: 0,
    purpose: 'route',
  };
  return closures.sources.filter((s) => !s.skip?.(probe));
}

function describe(it: RoadItem): string {
  const where = it.road
    ? ` on ${it.road}${it.direction ? ` ${it.direction}` : ''}`
    : it.direction
      ? ` (${it.direction})`
      : '';
  return `${it.type}${where} (${it.source})${it.description ? `: ${it.description.slice(0, 140)}` : ''}`;
}

/** Street names for the items a route reports (Detroit permits have none), a few at a time. */
async function nameAll(items: RoadItem[], signal: AbortSignal): Promise<void> {
  const todo = items.filter((it) => !it.road && it.resolveRoad).slice(0, 8);
  await Promise.all(
    todo.map(async (it) => {
      it.road = await it.resolveRoad!(signal).catch(() => null);
      if (it.road) it.roadLookedUp = true;
    }),
  );
}

/** Warnings shown per route for open-road work on the way (city permits are many downtown). */
const MAX_OPEN_WARNINGS = 6;
const MAX_PERMIT_WARNINGS = 3;

export async function routeAvoidingClosures(
  deps: { router: Router; closures?: ClosureService; now: () => number },
  from: Point,
  to: Point,
  opts: { units: 'mi' | 'km'; avoid: boolean },
  signal: AbortSignal,
): Promise<RouteAnswer> {
  const warnings: string[] = [];
  const first = await deps.router.route(from, to, opts.units, [], signal);
  let trip = first;
  const avoided: RouteAnswer['closures_avoided'] = [];
  let sources: SourceReport[] | undefined;
  let attributions: string[] = [];
  const used = new Set<SourceId>();
  if (opts.avoid && deps.closures && first.shape.length > 1) {
    const box = bboxOf(first.shape, 1)!;
    const ans = await deps.closures.query(
      {
        bbox: box,
        when: 'now',
        include: new Set(['incident', 'work_zone']),
        now: deps.now(),
        purpose: 'route',
      },
      1000,
      signal,
    );
    sources = ans.reports;
    const on = closuresOnRoute(ans.items, first.shape);
    // Every on-route item is reported: avoided, in a warning, or in the count of the rest.
    for (const it of on) used.add(it.source);
    attributions = deps.closures.sources.filter((s) => used.has(s.id)).map((s) => s.attribution);
    const nearEnd = (it: RoadItem) => atTripEnds(it, first.shape, [from, to]);
    const blocking = on.filter((it) => it.full_closure && !nearEnd(it));
    const atEnds = on.filter((x) => x.full_closure && nearEnd(x));
    // Open-road work on the way: other sources first, then a few city permits, then a count.
    const open = on.filter((x) => !x.full_closure);
    const permits = open.filter((x) => x.source === 'detroit_row');
    const shown = [
      ...open.filter((x) => x.source !== 'detroit_row'),
      ...permits.slice(0, MAX_PERMIT_WARNINGS),
    ].slice(0, MAX_OPEN_WARNINGS);
    const { rings, kept, dropped } = blocking.length
      ? excludeRings(blocking, first.shape)
      : { rings: [], kept: [], dropped: [] };
    await nameAll([...kept, ...atEnds, ...dropped, ...shown], signal);
    // A street name looked up on a map carries that map's credit.
    for (const it of [...kept, ...atEnds, ...dropped, ...shown])
      if (it.roadLookedUp && it.roadCredit && !attributions.includes(it.roadCredit))
        attributions.push(it.roadCredit);
    for (const it of atEnds)
      warnings.push(`Closure at the start or end of the trip, can't be avoided: ${describe(it)}`);
    for (const it of dropped)
      warnings.push(`Not avoided (too many closures to exclude at once): ${describe(it)}`);
    for (const it of shown)
      warnings.push(`On the route (not avoided, the road stays open): ${describe(it)}`);
    const more = open.length - shown.length;
    if (more > 0)
      warnings.push(
        `${more} more work site(s) on the route that leave the road open (mostly City of Detroit permits, e.g. curb-lane work); call road_closures for the list.`,
      );
    if (blocking.length) {
      if (rings.length) {
        try {
          trip = await deps.router.route(from, to, opts.units, rings, signal);
          for (const it of kept)
            avoided.push({
              road: it.road,
              description: it.description,
              type: it.type,
              source: it.source,
            });
          const still = closuresOnRoute(kept, trip.shape);
          for (const it of still)
            warnings.push(
              `The route still passes this closure (no way around it found): ${describe(it)}`,
            );
        } catch (err) {
          if (!(err instanceof RouteError)) throw err;
          warnings.push(
            `No route around ${kept.length} closure(s) was found (${err.message}); this route passes them: ${kept.map(describe).join('; ')}`,
          );
        }
      }
    }
  } else if (!opts.avoid) {
    warnings.push('Closures were not checked (avoid_closures=false).');
  }
  const maneuvers = trip.maneuvers.slice(0, MAX_MANEUVERS);
  const closure_data = !opts.avoid
    ? 'not_checked'
    : sources?.some((r) => r.status === 'ok')
      ? 'used'
      : 'none';
  return {
    distance: trip.distance,
    units: opts.units,
    duration_min: Math.round(trip.duration_s / 6) / 10,
    maneuvers,
    ...(trip.maneuvers.length > MAX_MANEUVERS
      ? { maneuvers_truncated: `${trip.maneuvers.length - MAX_MANEUVERS} more maneuver(s) omitted` }
      : {}),
    closures_avoided: avoided,
    warnings,
    ...(sources ? { sources } : {}),
    closure_data,
    tomtom_excluded: Boolean(sources?.some((r) => r.source === 'tomtom' && r.status === 'skipped')),
    closureSources: [...used],
    attributions,
  };
}

export function routeSummary(r: RouteAnswer, fromLabel: string, toLabel: string): string {
  const dist = `${r.distance} ${r.units}`;
  // Said plainly when the route could not take closures into account, and why.
  const why = (r.sources ?? [])
    .filter((x) => !(x.source === 'tomtom' && x.status === 'skipped'))
    .map(reportSentence)
    .join('; ');
  const none =
    r.closure_data === 'none'
      ? ` No closure data was available to avoid, so this route does not account for closures${why ? ` (${why})` : ''}.`
      : '';
  const tomtom = r.tomtom_excluded
    ? " Closures from TomTom are not used for routing (TomTom's licence excludes navigation use)."
    : '';
  const avoided = r.closures_avoided.length
    ? ` Avoids ${r.closures_avoided.length} closure(s): ${r.closures_avoided
        .slice(0, 3)
        .map((c) => [c.type, c.road].filter(Boolean).join(' on '))
        .join('; ')}.`
    : '';
  const warn = r.warnings.length
    ? ` ${r.warnings.length} warning(s): ${r.warnings.slice(0, 2).join(' ')}`
    : '';
  return `Driving route from ${fromLabel} to ${toLabel}: ${dist}, about ${Math.round(r.duration_min)} min without live traffic, ${r.maneuvers.length} step(s).${none}${tomtom}${avoided}${warn}`;
}
