/**
 * Radio Browser directory client (api.radio-browser.info), used the way its operator asks:
 *  - Mirrors are discovered, never hard-coded alone: the server list from
 *    https://all.api.radio-browser.info/json/servers, cached 6 h and shuffled; de1, de2 and nl1
 *    when the list can't be had (and the list is asked again after 30 min).
 *  - A request that fails moves on to the next mirror, at most 3 tries in all.
 *  - Redirects are refused, so a request never ends up at a host outside
 *    *.api.radio-browser.info; server-list names outside that zone are ignored.
 *  - The generic User-Agent of the civic tools (appname/version, no person, host or contact),
 *    12 s per try, small body caps, 30 min caching (public directory metadata, no rate limit is
 *    published and the service is run by volunteers).
 * Only directory metadata is fetched: never a stream, a homepage, or /json/url (it counts a play).
 *
 * Privacy: search() snaps the point to a 0.05 degree grid and adds 6 km to the radius (more than
 * the largest snap offset, about 3.9 km), so the exact position (a phone fix, with here: true)
 * never leaves the gateway; the caller filters and measures from the exact point.
 */
import {
  fetchBytes,
  TtlCache,
  untilAborted,
  UpstreamError,
  type FetchLike,
} from '../civic/common.js';

export const RADIO_BROWSER_SERVERS_URL = 'https://all.api.radio-browser.info/json/servers';
/** Used when the server list can't be had, after any discovered mirror otherwise. */
export const FALLBACK_MIRRORS = [
  'de1.api.radio-browser.info',
  'de2.api.radio-browser.info',
  'nl1.api.radio-browser.info',
] as const;
export const MIRROR_CACHE_MS = 6 * 3_600_000;
/** After a failed discovery the fallbacks serve, and the list is asked again this much later. */
export const MIRROR_RETRY_MS = 30 * 60_000;
export const MAX_TRIES = 3;
export const RADIO_TIMEOUT_MS = 12_000;
const SERVERS_MAX_BYTES = 64 * 1024;
/** About 1.3 KB per row: 500 rows fit with room for long tag lists. */
export const SEARCH_MAX_BYTES = 2 * 1024 * 1024;
/** Rows per search (Radio Browser's order is by its 24 h click count, most first). */
export const SEARCH_LIMIT = 500;
export const SEARCH_CACHE_MS = 30 * 60_000;
const SEARCH_CACHE_ENTRIES = 200;

/** The grid the query centre is snapped to (degrees) and what is added to the radius (km). */
export const QUERY_GRID_DEG = 0.05;
export const QUERY_PAD_KM = 6;

const MIRROR_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.api\.radio-browser\.info$/;

/** A mirror host from the server list, or undefined for anything outside *.api.radio-browser.info. */
export function mirrorHost(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const h = v.trim().toLowerCase().replace(/\.$/, '');
  return MIRROR_RE.test(h) ? h : undefined;
}

/** The point and radius the directory is asked about: a grid node and radius + 6 km (whole km). */
export function coarsenSearch(
  p: { lat: number; lon: number },
  radiusKm: number,
): { lat: number; lon: number; radiusKm: number } {
  const snap = (v: number) => Number((Math.round(v / QUERY_GRID_DEG) * QUERY_GRID_DEG).toFixed(2));
  const lat = Math.min(90, Math.max(-90, snap(p.lat)));
  let lon = snap(p.lon);
  if (lon > 180) lon -= 360;
  if (lon < -180) lon += 360;
  // (|| 0: no "-0" in a query string or a cache key.)
  return { lat: lat || 0, lon: lon || 0, radiusKm: Math.ceil(radiusKm + QUERY_PAD_KM) };
}

export interface SearchQuery {
  /** The exact point: snapped here before anything is sent. */
  lat: number;
  lon: number;
  radiusKm: number;
  httpsOnly: boolean;
}

export interface SearchResult {
  rows: unknown[];
  mirror: string;
  fetchedAt: number;
  /** The radius (km) the directory was asked about. */
  queryRadiusKm: number;
}

export interface RadioBrowserDeps {
  fetch: FetchLike;
  now: () => number;
  /** Order of the discovered mirrors (default: random, as Radio Browser asks). */
  shuffle?: (hosts: string[]) => string[];
}

function shuffled(hosts: string[]): string[] {
  const out = [...hosts];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Worth asking the next mirror: the network, a timeout, a 5xx or 429, a redirect, a broken body. */
function tryNext(err: unknown): boolean {
  if (!(err instanceof UpstreamError)) return false;
  if (['timeout', 'unreachable', 'rate_limited', 'bad_response'].includes(err.kind)) return true;
  const s = err.status ?? 0;
  return err.kind === 'http' && (s >= 500 || (s >= 300 && s < 400));
}

export class RadioBrowser {
  private mirrorList?: { hosts: string[]; until: number };
  private discovering?: Promise<string[]>;
  private readonly searches: TtlCache<SearchResult>;
  private readonly shuffle: (hosts: string[]) => string[];

  constructor(private readonly deps: RadioBrowserDeps) {
    this.searches = new TtlCache(SEARCH_CACHE_MS, SEARCH_CACHE_ENTRIES, deps.now);
    this.shuffle = deps.shuffle ?? shuffled;
  }

  /** Mirrors in the order they are tried: the discovered ones, then the fallbacks. */
  mirrors(): Promise<string[]> {
    if (this.mirrorList && this.deps.now() < this.mirrorList.until)
      return Promise.resolve(this.mirrorList.hosts);
    this.discovering ??= this.discover().finally(() => {
      this.discovering = undefined;
    });
    return this.discovering;
  }

  /**
   * Stations with coordinates within the coarsened radius, most played first (cached per grid
   * cell, radius and https_only). The shared request is not cancelled with one caller.
   */
  search(q: SearchQuery, signal?: AbortSignal): Promise<SearchResult> {
    const c = coarsenSearch(q, q.radiusKm);
    const params = new URLSearchParams({
      geo_lat: c.lat.toFixed(2),
      geo_long: c.lon.toFixed(2),
      geo_distance: String(c.radiusKm * 1000),
      has_geo_info: 'true',
      hidebroken: 'true',
      order: 'clickcount',
      reverse: 'true',
      limit: String(SEARCH_LIMIT),
    });
    if (q.httpsOnly) params.set('is_https', 'true');
    const key = `${params.get('geo_lat')},${params.get('geo_long')},${c.radiusKm},${q.httpsOnly ? 1 : 0}`;
    return untilAborted(
      this.searches.get(key, async () => {
        const { body, mirror } = await this.fromMirrors(`/json/stations/search?${params}`);
        return { rows: body, mirror, fetchedAt: this.deps.now(), queryRadiusKm: c.radiusKm };
      }),
      signal,
    );
  }

  private async discover(): Promise<string[]> {
    let found: string[] = [];
    try {
      const rows = await this.getJson(RADIO_BROWSER_SERVERS_URL, SERVERS_MAX_BYTES);
      const names = rows.map((r) =>
        r && typeof r === 'object' ? mirrorHost((r as { name?: unknown }).name) : undefined,
      );
      found = [...new Set(names.filter((h): h is string => h !== undefined))];
    } catch {
      // The fallbacks below serve until the next attempt.
    }
    const hosts = [...this.shuffle(found), ...FALLBACK_MIRRORS.filter((h) => !found.includes(h))];
    this.mirrorList = {
      hosts,
      until: this.deps.now() + (found.length ? MIRROR_CACHE_MS : MIRROR_RETRY_MS),
    };
    return hosts;
  }

  private async fromMirrors(pathAndQuery: string): Promise<{ body: unknown[]; mirror: string }> {
    const hosts = (await this.mirrors()).slice(0, MAX_TRIES);
    let last: unknown;
    for (const [i, host] of hosts.entries()) {
      try {
        return {
          body: await this.getJson(`https://${host}${pathAndQuery}`, SEARCH_MAX_BYTES),
          mirror: host,
        };
      } catch (err) {
        last = err;
        if (!tryNext(err)) break;
        if (i === hosts.length - 1 && err instanceof UpstreamError)
          throw new UpstreamError(
            err.kind,
            `${err.message} (tried ${hosts.length} mirror${hosts.length === 1 ? '' : 's'})`,
            err.status,
          );
      }
    }
    throw last;
  }

  /** One GET: a JSON array, or UpstreamError (a redirect is refused, never followed). */
  private async getJson(url: string, maxBytes: number): Promise<unknown[]> {
    const r = await fetchBytes(this.deps.fetch, url, 'Radio Browser', {
      timeoutMs: RADIO_TIMEOUT_MS,
      maxBytes,
      headers: { accept: 'application/json' },
    });
    if (r.status >= 300 && r.status < 400)
      throw new UpstreamError('http', 'Radio Browser tried to redirect (refused)', r.status);
    if (r.status === 429)
      throw new UpstreamError('rate_limited', 'Radio Browser is rate limiting requests', 429);
    if (r.status < 200 || r.status >= 300)
      throw new UpstreamError('http', `Radio Browser returned HTTP ${r.status}`, r.status);
    let j: unknown;
    try {
      j = JSON.parse(r.body.toString('utf8'));
    } catch {
      throw new UpstreamError('bad_response', 'Radio Browser sent something that is not JSON');
    }
    if (!Array.isArray(j))
      throw new UpstreamError('bad_response', 'Radio Browser sent an unexpected answer');
    return j;
  }
}
