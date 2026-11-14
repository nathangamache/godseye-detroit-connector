/**
 * Live aircraft from community ADS-B aggregators, normalised to one shape.
 *
 * Primary: adsb.fi open data (no key; personal, non-commercial use; cite adsb.fi with a link).
 * Its public endpoints allow 1 request/second, and 400/401/403/404/429 answers count toward a
 * temporary IP ban, so: one request at a time with at least 1.1 s between them across the whole
 * process, identical requests share one flight (single-flight) and a 12 s cache, inputs are
 * validated before any request, and a 4xx is never retried (after one, adsb.fi is left alone
 * for 15 minutes).
 *
 * Fallback: adsb.lol (ODbL 1.0), ONLY when adsb.fi times out, fails with a 5xx or answers 429.
 * It allows a few hundred keyless calls a day per IP (shared with anything else on this host)
 * and sends no quota headers, so calls are counted here (ADSBLOL_DAILY_MAX) and Retry-After is
 * honoured.
 *
 * Both return the readsb/ADSBx v2 "ac" array. adsb.fi's ownOp (owner/operator) is never read.
 */
import type { Logger } from '../../log.js';
import { RateLimiter } from '../../util/ratelimit.js';
import { POSITION_SOURCES } from './codes.js';
import { HttpError, cleanText, finite, getJson, sleep, type FetchFn } from './http.js';

export const ADSBFI_BASE = 'https://opendata.adsb.fi/api';
export const ADSBLOL_BASE = 'https://api.adsb.lol';
export const ADSBFI_CREDIT = 'adsb.fi (https://adsb.fi)';
export const ADSBLOL_CREDIT = 'adsb.lol (https://adsb.lol), ODbL 1.0';

export type LiveSource = 'adsb.fi' | 'adsb.lol';

export interface LiveAircraft {
  hex: string;
  non_icao: boolean;
  lat?: number;
  lon?: number;
  /** "reported" (current), "last_known" (older than readsb's 60 s) or "rough" (receiver range). */
  position_kind?: 'reported' | 'last_known' | 'rough';
  callsign?: string;
  registration?: string;
  type_code?: string;
  type_desc?: string;
  altitude_ft?: number | 'ground';
  altitude_geom_ft?: number;
  ground_speed_kt?: number;
  track_deg?: number;
  vertical_rate_fpm?: number;
  squawk?: string;
  emergency?: string;
  category?: string;
  seen_s?: number;
  seen_pos_s?: number;
  source_type?: string;
  db_flags: number;
}

export interface LiveSnapshot {
  source: LiveSource;
  credit: string;
  fetched_at: number;
  /** The feed's own clock (ms), when it sent one. */
  feed_now_ms?: number;
  aircraft: LiveAircraft[];
  /** Why adsb.lol answered instead of adsb.fi. */
  fallback_reason?: string;
  /** Query radius actually sent (nm). */
  radius_nm: number;
}

export class LiveError extends Error {
  constructor(
    /** retry_later: try again later; refused: a 4xx (not retried); unavailable: no usable answer */
    readonly kind: 'retry_later' | 'refused' | 'unavailable' | 'cancelled',
    message: string,
  ) {
    super(message);
  }
}

/** At most one request per interval, in arrival order. */
export class Throttle {
  private nextAt = 0;
  constructor(
    readonly intervalMs: number,
    private readonly clock: () => number = Date.now,
  ) {}

  async wait(signal?: AbortSignal, maxWaitMs = 10_000): Promise<void> {
    const now = this.clock();
    const at = Math.max(now, this.nextAt);
    if (at - now > maxWaitMs)
      throw new LiveError(
        'retry_later',
        'too many aircraft requests are queued; try again shortly',
      );
    this.nextAt = at + this.intervalMs;
    await sleep(at - now, signal);
  }
}

/** Upstream state shared by every client in the process (bans and quotas are per IP). */
export class Upstreams {
  readonly fiThrottle: Throttle;
  readonly lolThrottle: Throttle;
  /** adsb.lol calls in the last 24 h (adsb.lol sends no quota headers). */
  readonly lolCalls: RateLimiter;
  fiCooldownUntil = 0;
  fiBlockedUntil = 0;
  fiBlockedStatus?: number;
  lolCooldownUntil = 0;
  readonly inflight = new Map<string, Promise<unknown>>();
  readonly cache = new Map<string, { at: number; value: LiveSnapshot }>();

  constructor(opts: { intervalMs?: number; clock?: () => number } = {}) {
    this.fiThrottle = new Throttle(opts.intervalMs ?? 1100, opts.clock);
    this.lolThrottle = new Throttle(opts.intervalMs ?? 1100, opts.clock);
    this.lolCalls = new RateLimiter(opts.clock);
  }

  /** adsb.lol calls still allowed in the rolling 24 h under `max`. */
  lolRemaining(max: number): number {
    return this.lolCalls.peek('adsb.lol', max, 86_400_000).remaining;
  }
}

let shared: Upstreams | undefined;
/** The process-wide upstream state. */
export function sharedUpstreams(): Upstreams {
  shared ??= new Upstreams();
  return shared;
}

const HEX = /^(~?)([0-9a-f]{6})$/;
const inRange = (lat: unknown, lon: unknown): boolean =>
  typeof lat === 'number' &&
  typeof lon === 'number' &&
  Number.isFinite(lat) &&
  Number.isFinite(lon) &&
  Math.abs(lat) <= 90 &&
  Math.abs(lon) <= 180;

/** One aircraft from a readsb-style record. Unknown and owner fields are dropped. */
export function normalizeAircraft(raw: unknown): LiveAircraft | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const a = raw as Record<string, unknown>;
  const m = HEX.exec(typeof a.hex === 'string' ? a.hex.trim().toLowerCase() : '');
  if (!m) return undefined;
  const out: LiveAircraft = { hex: m[2]!, non_icao: m[1] === '~', db_flags: 0 };
  const last = a.lastPosition as Record<string, unknown> | undefined;
  if (inRange(a.lat, a.lon)) {
    Object.assign(out, { lat: a.lat, lon: a.lon, position_kind: 'reported' });
  } else if (last && typeof last === 'object' && inRange(last.lat, last.lon)) {
    Object.assign(out, { lat: last.lat, lon: last.lon, position_kind: 'last_known' });
    const s = finite(last.seen_pos);
    if (s !== undefined) out.seen_pos_s = Math.round(s);
  } else if (inRange(a.rr_lat, a.rr_lon)) {
    Object.assign(out, { lat: a.rr_lat, lon: a.rr_lon, position_kind: 'rough' });
  }
  const callsign = cleanText(a.flight, 32)
    ?.toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8);
  if (callsign) out.callsign = callsign;
  const reg = cleanText(a.r, 32)
    ?.toUpperCase()
    .replace(/[^A-Z0-9-]/g, '')
    .slice(0, 10);
  if (reg) out.registration = reg;
  const t = cleanText(a.t, 32)
    ?.toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 4);
  if (t) out.type_code = t;
  const desc = cleanText(a.desc, 60, /[^\w .,/()&'+-]/g);
  if (desc) out.type_desc = desc;
  if (a.alt_baro === 'ground') out.altitude_ft = 'ground';
  else if (finite(a.alt_baro) !== undefined) out.altitude_ft = Math.round(a.alt_baro as number);
  if (finite(a.alt_geom) !== undefined) out.altitude_geom_ft = Math.round(a.alt_geom as number);
  if (finite(a.gs) !== undefined) out.ground_speed_kt = Math.round(a.gs as number);
  if (finite(a.track) !== undefined) out.track_deg = Math.round(a.track as number) % 360;
  const vr = finite(a.baro_rate) ?? finite(a.geom_rate);
  if (vr !== undefined) out.vertical_rate_fpm = Math.round(vr);
  if (typeof a.squawk === 'string' && /^[0-7]{4}$/.test(a.squawk)) out.squawk = a.squawk;
  const em = cleanText(a.emergency, 20)?.toLowerCase();
  if (em && em !== 'none' && /^[a-z]+$/.test(em)) out.emergency = em;
  if (typeof a.category === 'string' && /^[A-D][0-7]$/.test(a.category)) out.category = a.category;
  const seen = finite(a.seen);
  if (seen !== undefined) out.seen_s = Math.round(seen * 10) / 10;
  const seenPos = finite(a.seen_pos);
  if (seenPos !== undefined && out.seen_pos_s === undefined)
    out.seen_pos_s = Math.round(seenPos * 10) / 10;
  if (typeof a.type === 'string' && Object.hasOwn(POSITION_SOURCES, a.type))
    out.source_type = a.type;
  if (typeof a.dbFlags === 'number' && Number.isInteger(a.dbFlags) && a.dbFlags > 0)
    out.db_flags = a.dbFlags & 0xff;
  return out;
}

/** A feed response: "ac" (aggregators) or "aircraft" (a local readsb), "now" in ms or s. */
export function parseFeed(json: unknown): { aircraft: LiveAircraft[]; now_ms?: number } {
  if (!json || typeof json !== 'object')
    throw new LiveError('unavailable', 'the feed sent an unexpected response');
  const j = json as Record<string, unknown>;
  const list = Array.isArray(j.ac) ? j.ac : Array.isArray(j.aircraft) ? j.aircraft : undefined;
  if (!list) throw new LiveError('unavailable', 'the feed sent no aircraft list');
  const now = finite(j.now);
  const aircraft: LiveAircraft[] = [];
  for (const raw of list.slice(0, 5000)) {
    const a = normalizeAircraft(raw);
    if (a) aircraft.push(a);
  }
  return {
    aircraft,
    ...(now !== undefined ? { now_ms: now < 1e12 ? Math.round(now * 1000) : Math.round(now) } : {}),
  };
}

export interface LiveClientOptions {
  fetch?: FetchFn;
  upstreams?: Upstreams;
  now?: () => number;
  logger?: Logger;
  /** adsb.lol calls allowed per rolling 24 h. */
  lolDailyMax: number;
  cacheMs?: number;
  timeoutMs?: number;
  fiBase?: string;
  lolBase?: string;
}

const MAX_BYTES = 6 * 1024 * 1024;

function describe(e: HttpError): string {
  if (e.kind === 'status') return `HTTP ${e.status}`;
  if (e.kind === 'timeout') return 'timed out';
  if (e.kind === 'network') return 'unreachable';
  return e.message;
}

const hhmm = (t: number) => new Date(t).toISOString().slice(11, 16) + ' UTC';

export class LiveClient {
  readonly up: Upstreams;
  private readonly now: () => number;

  constructor(private readonly o: LiveClientOptions) {
    this.up = o.upstreams ?? sharedUpstreams();
    this.now = o.now ?? Date.now;
  }

  private get fiBase() {
    return this.o.fiBase ?? ADSBFI_BASE;
  }
  private get lolBase() {
    return this.o.lolBase ?? ADSBLOL_BASE;
  }

  private once<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const hit = this.up.inflight.get(key) as Promise<T> | undefined;
    if (hit) return hit;
    const p = fn().finally(() => this.up.inflight.delete(key));
    this.up.inflight.set(key, p);
    return p;
  }

  private get(url: string, signal?: AbortSignal): Promise<unknown> {
    return getJson(url, {
      fetch: this.o.fetch,
      timeoutMs: this.o.timeoutMs ?? 8000,
      maxBytes: MAX_BYTES,
      signal,
    });
  }

  /** Refuses (without a request) while adsb.fi is backed off after a 4xx. */
  private fiRefusal(): LiveError | undefined {
    if (this.up.fiBlockedUntil > this.now())
      return new LiveError(
        'refused',
        `adsb.fi refused the last request (HTTP ${this.up.fiBlockedStatus ?? '4xx'}); this connector does not retry it before ${hhmm(this.up.fiBlockedUntil)}`,
      );
    return undefined;
  }

  /** One adsb.fi GET with the throttle and the 4xx/429 bookkeeping. */
  private async fiGet(url: string, signal?: AbortSignal): Promise<unknown> {
    const refused = this.fiRefusal();
    if (refused) throw refused;
    await this.up.fiThrottle.wait(signal);
    try {
      return await this.get(url, signal);
    } catch (err) {
      if (err instanceof HttpError && err.kind === 'status') {
        if (err.status === 429) {
          this.up.fiCooldownUntil = this.now() + (err.retryAfterS ?? 60) * 1000;
        } else if (err.status! < 500) {
          this.up.fiBlockedUntil = this.now() + 15 * 60_000;
          this.up.fiBlockedStatus = err.status;
        }
      }
      this.o.logger?.warn('aviation_upstream', {
        source: 'adsb.fi',
        error: err instanceof HttpError ? describe(err) : 'error',
      });
      throw err;
    }
  }

  private async lolGet(url: string, signal?: AbortSignal): Promise<unknown> {
    const now = this.now();
    if (this.up.lolCooldownUntil > now)
      throw new LiveError(
        'retry_later',
        `adsb.lol asked to wait (rate limit) until ${hhmm(this.up.lolCooldownUntil)}`,
      );
    const max = this.o.lolDailyMax;
    if (max <= 0 || !this.up.lolCalls.hit('adsb.lol', max, 86_400_000, { global: true }).ok)
      throw new LiveError(
        'retry_later',
        `the local adsb.lol budget (${max} calls per 24 h, ADSBLOL_DAILY_MAX) is used up`,
      );
    await this.up.lolThrottle.wait(signal);
    try {
      return await this.get(url, signal);
    } catch (err) {
      if (err instanceof HttpError && err.kind === 'status' && err.status === 429) {
        this.up.lolCooldownUntil = this.now() + (err.retryAfterS ?? 600) * 1000;
        throw new LiveError(
          'retry_later',
          `adsb.lol is rate limiting this server until ${hhmm(this.up.lolCooldownUntil)}`,
        );
      }
      this.o.logger?.warn('aviation_upstream', {
        source: 'adsb.lol',
        error: err instanceof HttpError ? describe(err) : 'error',
      });
      throw err;
    }
  }

  /**
   * Aircraft within `radiusNm` (an integer, 1-250) of a point that the caller has already
   * coarsened: this never sees the user's exact position.
   */
  async near(center: { lat: number; lon: number }, radiusNm: number, signal?: AbortSignal) {
    if (
      !inRange(center.lat, center.lon) ||
      !Number.isInteger(radiusNm) ||
      radiusNm < 1 ||
      radiusNm > 250
    )
      throw new LiveError('unavailable', 'internal error: invalid aircraft query');
    const lat = center.lat.toFixed(2);
    const lon = center.lon.toFixed(2);
    const cell = `${lat},${lon}`;
    const cached = this.up.cache.get(cell);
    if (
      cached &&
      this.now() - cached.at <= (this.o.cacheMs ?? 12_000) &&
      cached.value.radius_nm >= radiusNm
    )
      return cached.value;
    return this.once(`near:${cell}:${radiusNm}`, async () => {
      const snap = await this.fetchNear(lat, lon, radiusNm, signal);
      this.up.cache.set(cell, { at: this.now(), value: snap });
      if (this.up.cache.size > 500) this.up.cache.delete(this.up.cache.keys().next().value!);
      return snap;
    });
  }

  private async fetchNear(lat: string, lon: string, r: number, signal?: AbortSignal) {
    let fallback: string;
    if (this.up.fiCooldownUntil > this.now()) {
      fallback = `adsb.fi asked to wait (rate limit) until ${hhmm(this.up.fiCooldownUntil)}`;
    } else {
      try {
        const json = await this.fiGet(`${this.fiBase}/v3/lat/${lat}/lon/${lon}/dist/${r}`, signal);
        const feed = parseFeed(json);
        return this.snapshot('adsb.fi', feed, r);
      } catch (err) {
        if (err instanceof LiveError) throw err;
        if (!(err instanceof HttpError)) throw err;
        if (err.kind === 'cancelled') throw new LiveError('cancelled', 'cancelled');
        if (!err.transient) {
          throw new LiveError(
            err.kind === 'status' ? 'refused' : 'unavailable',
            `adsb.fi answered ${describe(err)}; not retried`,
          );
        }
        fallback = `adsb.fi ${describe(err)}`;
      }
    }
    try {
      const json = await this.lolGet(`${this.lolBase}/v2/point/${lat}/${lon}/${r}`, signal);
      return { ...this.snapshot('adsb.lol', parseFeed(json), r), fallback_reason: fallback };
    } catch (err) {
      if (err instanceof LiveError)
        throw new LiveError(err.kind, `${fallback}, and the fallback failed: ${err.message}`);
      if (err instanceof HttpError && err.kind === 'cancelled')
        throw new LiveError('cancelled', 'cancelled');
      const why = err instanceof HttpError ? describe(err) : 'error';
      throw new LiveError('retry_later', `${fallback}, and the fallback adsb.lol ${why}`);
    }
  }

  private snapshot(
    source: LiveSource,
    feed: ReturnType<typeof parseFeed>,
    radiusNm: number,
  ): LiveSnapshot {
    return {
      source,
      credit: source === 'adsb.fi' ? ADSBFI_CREDIT : ADSBLOL_CREDIT,
      fetched_at: this.now(),
      ...(feed.now_ms !== undefined ? { feed_now_ms: feed.now_ms } : {}),
      aircraft: feed.aircraft,
      radius_nm: radiusNm,
    };
  }

  /** One aircraft by ICAO hex from adsb.fi (live flags), or undefined when not tracked or on error. */
  async byHex(hex: string, signal?: AbortSignal): Promise<LiveAircraft | undefined | null> {
    const h = hex.toLowerCase();
    if (!/^[0-9a-f]{6}$/.test(h)) return null;
    const key = `hex:${h}`;
    const cached = this.up.cache.get(key);
    if (cached && this.now() - cached.at <= 30_000) return cached.value.aircraft[0];
    if (this.up.fiCooldownUntil > this.now() || this.fiRefusal()) return null;
    try {
      return await this.once(key, async () => {
        const feed = parseFeed(await this.fiGet(`${this.fiBase}/v2/hex/${h}`, signal));
        const snap = this.snapshot(
          'adsb.fi',
          { aircraft: feed.aircraft.filter((a) => a.hex === h) },
          0,
        );
        this.up.cache.set(key, { at: this.now(), value: snap });
        return snap.aircraft[0];
      });
    } catch {
      return null;
    }
  }

  /** ICAO hexes on adsb.lol's list of LADD aircraft it currently tracks, or null on error. */
  async laddHexes(signal?: AbortSignal): Promise<string[] | null> {
    try {
      return await this.once('ladd', async () => {
        const feed = parseFeed(await this.lolGet(`${this.lolBase}/v2/ladd`, signal));
        return feed.aircraft.filter((a) => !a.non_icao).map((a) => a.hex);
      });
    } catch {
      return null;
    }
  }
}
