/**
 * road_closures' engine: asks every source that is configured and covers the area, each on its
 * own (one failing or timing out never sinks the others), then filters, merges and ranks.
 */
import { humanDistance } from '../../util/format.js';
import { errorText, localDay } from './http.js';
import {
  distanceToLinesM,
  inBox,
  intersects,
  lineLengthM,
  lineMidpoint,
  round4,
  type BBox,
  type LonLat,
  type Point,
} from './geo.js';
import { mergeDirections } from './merge.js';
import { mentionsRoad, type RoadQuery } from './text.js';

export type SourceId = 'detroit_row' | 'tomtom' | 'mdot_ride' | 'ontario511';
export type Kind = 'incident' | 'work_zone';
export type When = 'now' | 'planned';

export interface RoadItem {
  source: SourceId;
  id: string;
  kind: Kind;
  type: string;
  road: string | null;
  direction: string | null;
  lanes: string | null;
  vehicle_impact: string | null;
  /** Every lane in the affected direction(s) is blocked (as the source says, or inferred). */
  full_closure: boolean;
  description: string | null;
  from_cross_street: string | null;
  to_cross_street: string | null;
  start: string | null;
  end: string | null;
  updated: string | null;
  /** Geometry, GeoJSON order; a point is a one-vertex line. Never output as is. */
  lines: LonLat[][];
  /** Merged reports (merge.ts): one report's lines, for the length shown (lines holds all). */
  primaryLines?: LonLat[][];
  /** How many source reports this item merges (one per direction, typically). */
  merged?: number;
  /** start/end are local calendar dates (YYYY-MM-DD), not instants. */
  dateOnly?: boolean;
  /** Looks up the street name when the source has none (Detroit permits, TomTom). */
  resolveRoad?: (signal: AbortSignal) => Promise<string | null>;
  /** Credit for the map a looked-up name comes from (shown once a name was found). */
  roadCredit?: string;
  /** Set when road came from resolveRoad. */
  roadLookedUp?: boolean;
  note?: string;
}

export interface ClosureQuery {
  bbox: BBox;
  center?: Point;
  radiusKm?: number;
  road?: RoadQuery;
  when: When;
  include: Set<Kind>;
  now: number;
  /** "route": sources whose terms don't allow navigation use are skipped (TomTom). */
  purpose: 'list' | 'route';
  /** Sources a composite leaves out of this query, each with the note its report gives. */
  skip?: Readonly<Partial<Record<SourceId, string>>>;
}

export type SourceStatus =
  'ok' | 'not_configured' | 'off' | 'error' | 'quota' | 'out_of_area' | 'skipped';

export interface SourceReport {
  source: SourceId;
  label: string;
  status: SourceStatus;
  /** Items of this source in the answer (after the limit). */
  count: number;
  /**
   * Items of this source in range before the limit, after merging (point searches without a
   * road only).
   */
  found?: number;
  note?: string;
  retrieved_at?: string;
  cache_age_s?: number;
  /** A metered source that was asked (or refused for its cap): requests left today. */
  quota?: { remaining: number; max: number };
}

export interface FetchResult {
  items: RoadItem[];
  cacheAgeMs?: number;
  note?: string;
}

/** Thrown by a source whose own budget (daily cap, throttle) is spent. */
export class QuotaError extends Error {}

/** Thrown by a source still loading its data when the call's time is up (its message says so). */
export class NotReadyError extends Error {}

export interface ClosureSource {
  id: SourceId;
  label: string;
  attribution: string;
  coverage: BBox;
  /** Undefined when usable; otherwise why not (status not_configured or off, and the fix). */
  unavailable(): { status: 'not_configured' | 'off'; note: string } | undefined;
  /** Skip for this query (e.g. TomTom for routing), with the reason. */
  skip?(q: ClosureQuery): string | undefined;
  /** A source with a daily request cap: what is left of it. */
  quota?(): { remaining: number; max: number };
  fetch(q: ClosureQuery, signal: AbortSignal): Promise<FetchResult>;
}

/** What callers see for one item (geometry reduced to a point and a summary). */
export interface PublicItem {
  source: SourceId;
  kind: Kind;
  type: string;
  road: string | null;
  direction: string | null;
  lanes: string | null;
  vehicle_impact: string | null;
  full_closure: boolean;
  description: string | null;
  from_cross_street: string | null;
  to_cross_street: string | null;
  start: string | null;
  end: string | null;
  updated: string | null;
  distance_km: number | null;
  at: Point | null;
  geometry_summary: string;
  /** Reports of this stretch merged into this item (one per direction), when more than one. */
  merged_reports?: number;
  note?: string;
}

/** Active now, or planned (starts later), against the item's own clock or calendar. */
export function timeState(
  it: Pick<RoadItem, 'start' | 'end' | 'dateOnly'>,
  now: number,
): 'active' | 'planned' | 'ended' {
  if (it.dateOnly) {
    const today = localDay(now);
    if (it.end && it.end < today) return 'ended';
    if (it.start && it.start > today) return 'planned';
    return 'active';
  }
  const s = it.start ? Date.parse(it.start) : NaN;
  const e = it.end ? Date.parse(it.end) : NaN;
  if (Number.isFinite(e) && e < now) return 'ended';
  if (Number.isFinite(s) && s > now) return 'planned';
  return 'active';
}

export function toPublic(it: RoadItem, center?: Point): PublicItem {
  // A merged item is summed up by one of its reports (both directions are one stretch).
  const shape = it.primaryLines ?? it.lines;
  const verts = shape.reduce((n, l) => n + l.length, 0);
  let at: Point | null = null;
  let distance: number | null = null;
  if (center) {
    const d = distanceToLinesM(center, it.lines);
    if (Number.isFinite(d.distM)) {
      distance = Math.round(d.distM / 100) / 10;
      at = { lat: round4(d.at.lat), lon: round4(d.at.lon) };
    }
  } else if (shape[0]?.length) {
    const m = lineMidpoint(shape[0]);
    at = { lat: round4(m.lat), lon: round4(m.lon) };
  }
  const len = shape.reduce((m, l) => m + lineLengthM(l), 0);
  const geometry_summary =
    verts <= shape.length
      ? shape.length > 1
        ? `${shape.length} points`
        : 'point'
      : `${shape.length > 1 ? `${shape.length} segments, ` : ''}${humanDistance(len)} long`;
  return {
    source: it.source,
    kind: it.kind,
    type: it.type,
    road: it.road,
    direction: it.direction,
    lanes: it.lanes,
    vehicle_impact: it.vehicle_impact,
    full_closure: it.full_closure,
    description: it.description,
    from_cross_street: it.from_cross_street,
    to_cross_street: it.to_cross_street,
    start: it.start,
    end: it.end,
    updated: it.updated,
    distance_km: distance,
    at,
    geometry_summary,
    ...(it.merged && it.merged > 1 ? { merged_reports: it.merged } : {}),
    ...(it.note ? { note: it.note } : {}),
  };
}

export interface ClosureAnswer {
  items: RoadItem[];
  /** Items in range before the limit; undefined for a road search (names are checked lazily). */
  total?: number;
  reports: SourceReport[];
  /** Items with no road name that were not checked against the road asked for (lookup cap). */
  unchecked: number;
  /**
   * Source reports folded into the items counted (one stretch reported per direction): every
   * item in range for a point search (its total), the items listed for a road search.
   */
  merged: number;
  attributions: string[];
}

export interface ClosureServiceOptions {
  sources: ClosureSource[];
  /** Per-source time budget (ms). */
  sourceTimeoutMs: number;
  /** Most street-name lookups one call may make. */
  maxLookups?: number;
  onSourceError?: (source: SourceId, err: unknown) => void;
}

export class ClosureService {
  constructor(private readonly o: ClosureServiceOptions) {}

  get sources(): ClosureSource[] {
    return this.o.sources;
  }

  async query(q: ClosureQuery, limit: number, signal: AbortSignal): Promise<ClosureAnswer> {
    const reports: SourceReport[] = [];
    const runs = this.o.sources.map(async (src): Promise<RoadItem[]> => {
      const base = { source: src.id, label: src.label, count: 0 };
      const off = src.unavailable();
      if (off) {
        reports.push({ ...base, ...off });
        return [];
      }
      const skip = q.skip?.[src.id] ?? src.skip?.(q);
      if (skip) {
        reports.push({ ...base, status: 'skipped', note: skip });
        return [];
      }
      if (!intersects(q.bbox, src.coverage)) {
        reports.push({ ...base, status: 'out_of_area', note: 'does not cover this area' });
        return [];
      }
      const timeout = AbortSignal.timeout(this.o.sourceTimeoutMs);
      const sig = AbortSignal.any([signal, timeout]);
      try {
        const r = await src.fetch(q, sig);
        const kept = r.items.filter((it) => this.keep(it, q));
        reports.push({
          ...base,
          status: 'ok',
          count: kept.length,
          retrieved_at: new Date(q.now - (r.cacheAgeMs ?? 0)).toISOString(),
          ...(r.cacheAgeMs !== undefined ? { cache_age_s: Math.round(r.cacheAgeMs / 1000) } : {}),
          ...(r.note ? { note: r.note } : {}),
          ...(src.quota ? { quota: src.quota() } : {}),
        });
        return kept;
      } catch (err) {
        const quota = src.quota ? { quota: src.quota() } : {};
        if (err instanceof QuotaError) {
          reports.push({ ...base, status: 'quota', note: err.message, ...quota });
        } else {
          this.o.onSourceError?.(src.id, err);
          reports.push({
            ...base,
            status: 'error',
            note:
              err instanceof NotReadyError
                ? err.message
                : timeout.aborted
                  ? `${src.label} timed out`
                  : errorText(err),
            ...quota,
          });
        }
        return [];
      }
    });
    // One item per closed stretch: reports of it per direction are merged first.
    const all = mergeDirections((await Promise.all(runs)).flat());
    // What each source found in range, counted as the total is: after merging.
    if (!q.road)
      for (const r of reports)
        if (r.status === 'ok') r.found = all.filter((i) => i.source === r.source).length;
    const order = new Map(this.o.sources.map((s, i) => [s.id, i]));
    reports.sort((a, b) => (order.get(a.source) ?? 0) - (order.get(b.source) ?? 0));

    // Nearest first for a point; for a road-only search, full closures first, then newest.
    const dist = new Map<RoadItem, number>();
    if (q.center) for (const it of all) dist.set(it, distanceToLinesM(q.center, it.lines).distM);
    all.sort((a, b) =>
      q.center
        ? dist.get(a)! - dist.get(b)!
        : Number(b.full_closure) - Number(a.full_closure) ||
          (b.updated ?? b.start ?? '').localeCompare(a.updated ?? a.start ?? ''),
    );

    const out: RoadItem[] = [];
    let lookups = 0;
    let unchecked = 0;
    // Routing looks up names only for the closures it actually avoids.
    const maxLookups = q.purpose === 'route' ? 0 : (this.o.maxLookups ?? 8);
    // In order, a few at a time: names for the next items are looked up together.
    const BATCH = 4;
    let i = 0;
    while (i < all.length && out.length < limit) {
      const batch = all.slice(i, i + Math.min(BATCH, limit - out.length));
      i += batch.length;
      const need = batch.filter((it) => !it.road && it.resolveRoad);
      const take = need.slice(0, Math.max(0, maxLookups - lookups));
      lookups += take.length;
      if (take.length && !signal.aborted)
        await Promise.all(
          take.map(async (it) => {
            it.road = await it.resolveRoad!(signal).catch(() => null);
            if (it.road) it.roadLookedUp = true;
          }),
        );
      for (const it of batch) {
        if (out.length >= limit) break;
        if (
          q.road &&
          !mentionsRoad(q.road, [it.road, it.from_cross_street, it.to_cross_street, it.description])
        ) {
          if (!it.road && it.resolveRoad) unchecked++;
          continue;
        }
        out.push(it);
      }
    }
    const used = new Set(out.map((i) => i.source));
    const attributions = this.o.sources.filter((s) => used.has(s.id)).map((s) => s.attribution);
    // A street name looked up on a map carries that map's credit (ODbL for OpenStreetMap).
    for (const it of out)
      if (it.roadLookedUp && it.roadCredit && !attributions.includes(it.roadCredit))
        attributions.push(it.roadCredit);
    for (const r of reports)
      if (r.status === 'ok') r.count = out.filter((i) => i.source === r.source).length;
    // Reports behind the items counted: all in range for a point search (its total), else those
    // listed.
    const merged = (q.road ? out : all).reduce((n, it) => n + (it.merged ?? 1) - 1, 0);
    return {
      items: out,
      ...(q.road ? {} : { total: all.length }),
      reports,
      unchecked,
      merged,
      attributions,
    };
  }

  private keep(it: RoadItem, q: ClosureQuery): boolean {
    if (!q.include.has(it.kind)) return false;
    const t = timeState(it, q.now);
    if (q.when === 'now' ? t !== 'active' : t !== 'planned') return false;
    if (!it.lines.some((l) => l.length)) return false;
    if (q.center && q.radiusKm !== undefined)
      return distanceToLinesM(q.center, it.lines).distM <= q.radiusKm * 1000;
    return it.lines.some((l) => l.some((p) => inBox(p, q.bbox)));
  }
}

/** One sentence per source: "City of Detroit permits: 3", "MDOT RIDE: not configured: set …". */
export function reportSentence(r: SourceReport): string {
  switch (r.status) {
    case 'ok':
      return `${r.label}: ${r.count}${r.note ? ` (${r.note})` : ''}`;
    case 'out_of_area':
      return `${r.label}: not this area`;
    default:
      return `${r.label}: ${r.note ?? r.status}`;
  }
}
