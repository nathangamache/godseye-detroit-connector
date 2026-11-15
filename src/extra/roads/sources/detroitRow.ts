/**
 * City of Detroit "Detroit Right of Way Permits" (ArcGIS FeatureServer: layer 4 lines, layer 5
 * points), keyless open data whose terms allow retrieval and re-use. Asking the layers per call
 * was too slow (calls timed out), so the gateway keeps a snapshot of every permit that occupies
 * the roadway (is_roadway=1) and has not ended: loaded at start, refreshed every 15 minutes with
 * a generous timeout, paged past the layer's 1,000-record limit, and kept as the last good copy
 * when a refresh fails. Calls are answered from memory with a box filter, and say how old the
 * snapshot is. The layer has no street-name field: the street comes from a reverse lookup of the
 * segment's midpoint (cached), done only for the permits a result actually shows.
 */
import { humanAge } from '../../../util/format.js';
import {
  NotReadyError,
  type ClosureQuery,
  type ClosureSource,
  type FetchResult,
  type RoadItem,
} from '../closures.js';
import { ATTRIBUTION as GEO_ATTRIBUTION, type Geocoder } from '../geocode.js';
import {
  DETROIT_CITY,
  bboxOf,
  distanceToLineM,
  intersects,
  lineMidpoint,
  type BBox,
  type LonLat,
} from '../geo.js';
import { errorText, localDay, type Http } from '../http.js';
import { cleanText } from '../text.js';

export const DETROIT_ATTRIBUTION =
  'City of Detroit Open Data: Detroit Right of Way Permits (data.detroitmi.gov)';

/** How often the snapshot is refreshed. */
export const DETROIT_REFRESH_MS = 15 * 60_000;
/** Each page request of a refresh may take this long (the layers answer slowly). */
export const DETROIT_PAGE_TIMEOUT_MS = 120_000;
/** The layers' maxRecordCount: one page. */
export const DETROIT_PAGE_SIZE = 1000;
/** After a failed refresh, the next try comes this much later. */
const RETRY_MS = 60_000;
/** Pages per layer per refresh (a bound on memory, far above today's count). */
const MAX_PAGES = 40;
/** A refresh after start waits this long, so a gateway that stops at once fetches nothing. */
const STARTUP_DELAY_MS = 3_000;

const FIELDS = [
  'ObjectId',
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

/** One permit of the snapshot: its segments from both layers, and a box for the filter. */
export interface Permit {
  id: string;
  type: string;
  description: string | null;
  direction: string | null;
  sidewalk: boolean;
  start: string | null;
  end: string | null;
  lines: LonLat[][];
  box: BBox;
}

export interface PermitSnapshotData {
  /** When the snapshot was taken (ms). */
  at: number;
  permits: Permit[];
  /** More features matched than MAX_PAGES pages hold. */
  truncated: boolean;
}

function geometryLines(f: Feature): LonLat[][] {
  const out: LonLat[][] = [];
  const paths = f.geometry?.paths;
  if (Array.isArray(paths)) {
    for (const p of paths.slice(0, 50))
      if (Array.isArray(p))
        out.push(
          p
            .slice(0, 500)
            .filter(
              (c): c is [number, number] =>
                Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number',
            )
            .map((c) => [c[0], c[1]] as LonLat),
        );
  } else if (typeof f.geometry?.x === 'number' && typeof f.geometry?.y === 'number') {
    out.push([[f.geometry.x, f.geometry.y]]);
  }
  return out.filter((l) => l.length);
}

/** Groups the features of both layers by permit (a permit has one or more segments). */
export function permitsOf(features: Feature[]): Permit[] {
  const byPermit = new Map<string, { attrs: Record<string, unknown>; lines: LonLat[][] }>();
  for (const f of features) {
    const a = f.attributes ?? {};
    const id = String(a.permit_id ?? a.permit_segment_id ?? '');
    if (!id) continue;
    const entry = byPermit.get(id) ?? { attrs: a, lines: [] };
    entry.lines.push(...geometryLines(f));
    byPermit.set(id, entry);
  }
  const out: Permit[] = [];
  for (const [id, { attrs, lines }] of byPermit) {
    const box = bboxOf(lines.flat());
    if (!box) continue;
    out.push({
      id,
      type: cleanText(attrs.permit_type, 60) ?? 'permit',
      description: cleanText(attrs.work_description, 300),
      direction: cleanText(attrs.roadway_direction_impact, 30),
      sidewalk: attrs.is_sidewalk === 1,
      start: day(attrs.start_date),
      end: day(attrs.end_date),
      lines,
      box,
    });
  }
  return out;
}

export interface PermitSnapshotOptions {
  http: Http;
  baseUrl: string;
  now: () => number;
  refreshMs?: number;
  pageTimeoutMs?: number;
  pageSize?: number;
  retryMs?: number;
  startupDelayMs?: number;
  onError?: (err: unknown) => void;
}

/**
 * The active roadway permits, in memory. refresh() is single-flight; a failed refresh keeps the
 * previous snapshot. start() refreshes in the background (timers never hold the process open);
 * without it, a call that finds the snapshot missing or stale starts a refresh itself.
 */
export class PermitSnapshot {
  private snap: PermitSnapshotData | undefined;
  private inflight: Promise<PermitSnapshotData> | undefined;
  private lastError: { at: number; message: string } | undefined;
  private lastAttempt = -Infinity;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private abort = new AbortController();

  constructor(private readonly o: PermitSnapshotOptions) {}

  get refreshMs(): number {
    return this.o.refreshMs ?? DETROIT_REFRESH_MS;
  }

  private get retryMs(): number {
    return this.o.retryMs ?? RETRY_MS;
  }

  /** Background refresh: soon after start, then every refreshMs (a minute after a failure). */
  start(): void {
    if (this.timer || this.stopped) return;
    this.schedule(this.o.startupDelayMs ?? STARTUP_DELAY_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.abort.abort();
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh().then(
        () => this.schedule(this.refreshMs),
        () => this.schedule(this.retryMs),
      );
    }, ms);
    this.timer.unref?.();
  }

  /** Loads both layers, every page; the previous snapshot stays if this fails. */
  refresh(): Promise<PermitSnapshotData> {
    if (this.inflight) return this.inflight;
    this.lastAttempt = this.o.now();
    const p = this.load().then(
      (s) => {
        this.snap = s;
        this.lastError = undefined;
        return s;
      },
      (err: unknown) => {
        this.lastError = { at: this.o.now(), message: errorText(err) };
        this.o.onError?.(err);
        throw err;
      },
    );
    this.inflight = p;
    void p.then(
      () => (this.inflight = undefined),
      () => (this.inflight = undefined),
    );
    return p;
  }

  private async load(): Promise<PermitSnapshotData> {
    const at = this.o.now();
    // Not ended by today (Detroit calendar): today's work and planned work alike.
    const where = `is_roadway = 1 AND end_date >= DATE '${localDay(at)}'`;
    const [lines, points] = await Promise.all([this.layer(4, where), this.layer(5, where)]);
    return {
      at,
      permits: permitsOf([...lines.features, ...points.features]),
      truncated: lines.truncated || points.truncated,
    };
  }

  /** One layer, page by page (resultOffset) while the server says more records matched. */
  private async layer(
    id: 4 | 5,
    where: string,
  ): Promise<{ features: Feature[]; truncated: boolean }> {
    const size = this.o.pageSize ?? DETROIT_PAGE_SIZE;
    const features: Feature[] = [];
    const seen = new Set<string>();
    for (let page = 0; page < MAX_PAGES; page++) {
      const u = new URL(`${this.o.baseUrl}/${id}/query`);
      u.search = new URLSearchParams({
        where,
        outFields: FIELDS,
        outSR: '4326',
        orderByFields: 'ObjectId',
        resultOffset: String(page * size),
        resultRecordCount: String(size),
        f: 'json',
      }).toString();
      const j = await this.o.http.json<{
        features?: Feature[];
        exceededTransferLimit?: boolean;
        error?: unknown;
      }>('City of Detroit permits', u, {
        signal: this.abort.signal,
        timeoutMs: this.o.pageTimeoutMs ?? DETROIT_PAGE_TIMEOUT_MS,
        maxBytes: 16 * 1024 * 1024,
      });
      if (j.error) throw new Error('City of Detroit permits rejected the query');
      const got = Array.isArray(j.features) ? j.features : [];
      for (const f of got) {
        // A record shifted across a page boundary while paging is kept once.
        const key = String(f.attributes?.ObjectId ?? f.attributes?.permit_segment_id ?? '');
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);
        features.push(f);
      }
      if (j.exceededTransferLimit !== true || !got.length) return { features, truncated: false };
    }
    return { features, truncated: true };
  }

  /**
   * The snapshot for a call: the one in memory (starting a refresh when it is stale), or, before
   * the first one has loaded, the load in progress, for as long as the call can wait.
   */
  async current(
    signal: AbortSignal,
  ): Promise<{ snap: PermitSnapshotData; ageMs: number; refreshError?: string }> {
    const t = this.o.now();
    const due = !this.inflight && t - this.lastAttempt >= this.retryMs;
    if (this.snap) {
      if (due && t - this.snap.at >= this.refreshMs) void this.refresh().catch(() => undefined);
      const failed = this.lastError && this.lastError.at >= this.snap.at;
      return {
        snap: this.snap,
        ageMs: Math.max(0, t - this.snap.at),
        ...(failed ? { refreshError: this.lastError!.message } : {}),
      };
    }
    if (!this.inflight && !due && this.lastError)
      throw new Error(
        `${this.lastError.message}; the permit list will be fetched again within a minute`,
      );
    const p = this.inflight ?? this.refresh();
    const snap = await new Promise<PermitSnapshotData>((resolve, reject) => {
      const onAbort = () =>
        reject(
          new NotReadyError(
            'still loading the city permit list (first load since the gateway started); try again in a minute',
          ),
        );
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
      p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
    return { snap, ageMs: Math.max(0, this.o.now() - snap.at) };
  }
}

export interface DetroitRowOptions {
  enabled: boolean;
  geocoder: Geocoder;
  snapshot: PermitSnapshot;
}

/** Permits in effect today (now) or starting later (planned), as the old server query had it. */
function inWindow(p: Permit, when: ClosureQuery['when'], today: string): boolean {
  if (!p.start) return false;
  return when === 'now' ? p.start <= today && (p.end ?? '') >= today : p.start > today;
}

export function detroitRowSource(o: DetroitRowOptions): ClosureSource {
  return {
    id: 'detroit_row',
    label: 'City of Detroit permits',
    attribution: DETROIT_ATTRIBUTION,
    coverage: DETROIT_CITY,
    unavailable: () =>
      o.enabled ? undefined : { status: 'off', note: 'off (DETROIT_ROW_ENABLED=false)' },
    skip: (q) => (q.include.has('work_zone') ? undefined : 'permits are work zones, not incidents'),
    async fetch(q: ClosureQuery, signal: AbortSignal): Promise<FetchResult> {
      const { snap, ageMs, refreshError } = await o.snapshot.current(signal);
      const today = localDay(q.now);
      // A road-only search can't look up the street of every permit in the city: narrow it
      // with the permit text instead.
      let textNote: string | undefined;
      let keyword: string | undefined;
      if (q.road && !q.center) {
        const kw = q.road.keyword.toUpperCase().replace(/[^A-Z0-9 ]/g, '');
        if (kw.length >= 3) {
          keyword = kw;
          textNote = 'matched on the permit text (no street lookup for a city-wide search)';
        }
      }
      const items: RoadItem[] = [];
      for (const p of snap.permits) {
        if (!intersects(p.box, q.bbox) || !inWindow(p, q.when, today)) continue;
        if (keyword && !(p.description ?? '').toUpperCase().includes(keyword)) continue;
        const segs = p.lines.length;
        // The street at the segment nearest the point asked about (or the first one).
        const pick = q.center
          ? p.lines.reduce((best, l) =>
              distanceToLineM(q.center!, l).distM < distanceToLineM(q.center!, best).distM
                ? l
                : best,
            )
          : p.lines[0]!;
        const mid = lineMidpoint(pick);
        items.push({
          source: 'detroit_row',
          id: `detroit_row:${p.id}`,
          kind: 'work_zone',
          type: `permit: ${p.type}`,
          road: null,
          direction: p.direction,
          lanes: null,
          vehicle_impact: `roadway occupied by permitted work${p.sidewalk ? '; sidewalk too' : ''}`,
          full_closure: permitClosesRoad(p.type, p.description ?? ''),
          description: p.description,
          from_cross_street: null,
          to_cross_street: null,
          start: p.start,
          end: p.end,
          updated: null,
          lines: p.lines,
          dateOnly: true,
          resolveRoad: (sig) => o.geocoder.reverseStreet(mid, sig),
          roadCredit: o.geocoder.overpassConfigured
            ? GEO_ATTRIBUTION.overpass
            : GEO_ATTRIBUTION.photon,
          note: `${segs} permit segment(s); street name looked up from the map${segs > 1 ? ' at the segment shown' : ''}; full_closure is inferred from the permit text`,
        });
      }
      const howOld = ageMs < 60_000 ? 'under a minute' : humanAge(Math.round(ageMs / 1000));
      const age = `permit snapshot ${howOld} old (refreshed every ${Math.round(o.snapshot.refreshMs / 60_000)} min)`;
      const stale = refreshError
        ? `the last refresh failed (${refreshError}), so this is the last good copy`
        : undefined;
      const truncated = snap.truncated
        ? 'the city lists more active permits than the snapshot holds'
        : undefined;
      return {
        items,
        cacheAgeMs: ageMs,
        note: [age, stale, truncated, textNote].filter(Boolean).join('; '),
      };
    },
  };
}
