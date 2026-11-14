/**
 * Ontario 511 developer API: "event" (incidents, closures, roadwork) and "constructionprojects".
 * Off until ONTARIO_511_API_KEY is set. Each endpoint returns the whole province: the answer is
 * cached ONTARIO_511_CACHE_S (1-5 min) and only the Windsor/Essex part is kept. The API allows
 * ten calls every 60 seconds; this source stays at nine.
 *
 * Licence: Open Government Licence - Ontario, with the attribution and the "as is" disclaimer
 * every result that uses this data carries.
 */
import { RateLimiter } from '../../../util/ratelimit.js';
import {
  QuotaError,
  type ClosureQuery,
  type ClosureSource,
  type FetchResult,
  type Kind,
  type RoadItem,
} from '../closures.js';
import { WINDSOR_ESSEX, decodePolyline, inBox, type LonLat } from '../geo.js';
import { TtlCache, errorText, type Http } from '../http.js';
import { cleanText } from '../text.js';

export const ONTARIO_ATTRIBUTION =
  'Contains information licensed under the Open Government Licence – Ontario (Ontario 511)';
export const ONTARIO_DISCLAIMER =
  'Ontario 511 data is provided "as is", without warranty of any kind; the Province of Ontario is not liable for its use and does not endorse this service.';

export interface OntarioOptions {
  http: Http;
  baseUrl: string;
  key?: string;
  cacheMs: number;
  now: () => number;
  /** Calls per 60 s (default 9, under the API's 10). */
  perMinute?: number;
}

type Json = Record<string, unknown>;

const unix = (v: unknown): string | null =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? new Date(v * 1000).toISOString() : null;

const TYPE: Record<string, string> = {
  roadwork: 'roadwork',
  closures: 'road closure',
  accidentsAndIncidents: 'incident',
};

/** "… between KENNEDY RD and HWY 403." -> the two cross streets. */
export function betweenStreets(s: string | null): [string | null, string | null] {
  const m = s ? /\bbetween\s+(.{2,80}?)\s+and\s+(.{2,80}?)(?:[.,;]|$)/i.exec(s) : null;
  return m ? [cleanText(m[1], 80), cleanText(m[2], 80)] : [null, null];
}

export function parseOntario(
  list: unknown,
  endpoint: 'event' | 'constructionprojects',
): RoadItem[] {
  if (!Array.isArray(list)) return [];
  const out: RoadItem[] = [];
  for (const raw of list.slice(0, 20_000)) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as Json;
    const lat = Number(e.Latitude);
    const lon = Number(e.Longitude);
    let line: LonLat[] = [];
    if (typeof e.EncodedPolyline === 'string' && e.EncodedPolyline)
      line = decodePolyline(e.EncodedPolyline, 5, 2000);
    if (!line.length && Number.isFinite(lat) && Number.isFinite(lon)) {
      line = [[lon, lat]];
      const lat2 = Number(e.LatitudeSecondary);
      const lon2 = Number(e.LongitudeSecondary);
      if (e.LatitudeSecondary != null && Number.isFinite(lat2) && Number.isFinite(lon2))
        line.push([lon2, lat2]);
    }
    // Windsor/Essex only (the API has no area filter: this is the server-side filter).
    if (!line.length || !line.some((p) => inBox(p, WINDSOR_ESSEX))) continue;
    const evType = String(e.EventType ?? '');
    const kind: Kind =
      endpoint === 'constructionprojects' || evType === 'roadwork' ? 'work_zone' : 'incident';
    const description = cleanText(
      [e.Description, e.Comment].filter((x) => typeof x === 'string' && x).join(' — '),
      300,
    );
    const [from, to] = betweenStreets(cleanText(e.Description, 400));
    const lanes = cleanText(e.LanesAffected, 80);
    const road = cleanText(e.RoadwayName, 60);
    out.push({
      source: 'ontario511',
      id: `ontario511:${endpoint}:${cleanText(e.ID, 30) ?? out.length}`,
      kind,
      type:
        cleanText(e.EventSubType, 60) ??
        (endpoint === 'constructionprojects'
          ? 'construction project'
          : (TYPE[evType] ?? (cleanText(evType, 40) || 'event'))),
      road: road && /^\d+[A-Z]?$/i.test(road) ? `Hwy ${road}` : road,
      direction: cleanText(e.DirectionOfTravel, 30),
      lanes: lanes && !/^no data$/i.test(lanes) ? lanes : null,
      vehicle_impact:
        cleanText(e.Impact, 120) ?? (e.IsFullClosure === true ? 'all lanes closed' : null),
      full_closure: e.IsFullClosure === true,
      description,
      from_cross_street: from,
      to_cross_street: to,
      start: unix(e.StartDate),
      end: unix(e.PlannedEndDate),
      updated: unix(e.LastUpdated),
      lines: [line],
    });
  }
  return out;
}

export function ontario511Source(o: OntarioOptions): ClosureSource {
  const cache = new TtlCache<RoadItem[]>(o.cacheMs, o.now, 60_000);
  const throttle = new RateLimiter(o.now);
  const perMinute = o.perMinute ?? 9;
  const load = async (endpoint: 'event' | 'constructionprojects'): Promise<RoadItem[]> => {
    if (!throttle.hit('ontario511', perMinute, 60_000, { global: true }).ok)
      throw new QuotaError('Ontario 511 allows ten calls a minute; try again shortly');
    const u = new URL(`${o.baseUrl}/${endpoint}`);
    u.searchParams.set('key', o.key!);
    u.searchParams.set('format', 'json');
    u.searchParams.set('lang', 'en');
    const j = await o.http.json('Ontario 511', u, {
      maxBytes: 16 * 1024 * 1024,
      timeoutMs: 20_000,
    });
    return parseOntario(j, endpoint);
  };
  return {
    id: 'ontario511',
    label: 'Ontario 511',
    attribution: ONTARIO_ATTRIBUTION,
    coverage: WINDSOR_ESSEX,
    unavailable: () =>
      o.key
        ? undefined
        : {
            status: 'not_configured',
            note: 'not configured: set ONTARIO_511_API_KEY in deploy/secrets/gateway.env',
          },
    async fetch(q: ClosureQuery, signal: AbortSignal): Promise<FetchResult> {
      const wanted: Array<'event' | 'constructionprojects'> = ['event'];
      if (q.include.has('work_zone')) wanted.push('constructionprojects');
      const abort = new Promise<never>((_, rej) =>
        signal.addEventListener('abort', () => rej(new Error('Ontario 511 timed out')), {
          once: true,
        }),
      );
      abort.catch(() => undefined);
      const got = await Promise.allSettled(
        wanted.map((ep) => Promise.race([cache.get(ep, () => load(ep)), abort])),
      );
      const items: RoadItem[] = [];
      const notes: string[] = [];
      let age = 0;
      got.forEach((g, i) => {
        if (g.status === 'fulfilled') {
          items.push(...g.value.value);
          age = Math.max(age, g.value.ageMs);
        } else notes.push(`${wanted[i]}: ${errorText(g.reason)}`);
      });
      if (got.every((g) => g.status === 'rejected')) {
        const first = (got[0] as PromiseRejectedResult).reason;
        if (first instanceof QuotaError) throw first;
        throw new Error(notes.join('; '));
      }
      return { items, cacheAgeMs: age, note: notes.join('; ') || undefined };
    },
  };
}
