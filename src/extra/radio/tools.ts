/**
 * radio_stations_near: internet radio stations near a point from the public Radio Browser
 * directory (community-maintained, public domain under PDDL), nearest first.
 *
 * Unlike GEV's find_radio_stations (a catalog of the directory's most popular stations
 * worldwide), this asks the directory about the area itself, so small local stations appear.
 * The directory is asked about a coarse grid point (browser.ts); stations are then filtered,
 * measured and sorted here from the exact point, and the query words are matched here (never
 * sent). Station names, tags and places are third-party text: cleaned, capped, and data only.
 * Nothing here fetches a stream or a homepage.
 */
import { z } from 'zod';
import type { JsonSchema, ToolContext, ToolDef, ToolOutput } from '../../tools/types.js';
import { humanAge } from '../../util/format.js';
import { bearingDeg, compassPoint, haversineM, isValidLatLon } from '../../util/geo.js';
import { isPrivateIp, parseIp } from '../../util/net.js';
import {
  cleanText,
  failure,
  pointFields,
  refinePoint,
  resolvePoint,
  round,
  UpstreamError,
  type PointDeps,
} from '../civic/common.js';
import {
  QUERY_GRID_DEG,
  QUERY_PAD_KM,
  SEARCH_LIMIT,
  type RadioBrowser,
  type SearchResult,
} from './browser.js';

export const RADIO_ATTRIBUTION =
  "Radio Browser (radio-browser.info), community directory data, public domain (PDDL). Stations and streams belong to their broadcasters (each station's homepage is listed with it); each stream's own terms apply.";

export const LISTENING_NOTE =
  "Claude can't listen to audio. The user can play stream_url in a browser or media player; on the God's Eye View globe only https MP3/AAC streams that are not HLS can play (plays_on_globe).";

/**
 * Codecs the God's Eye View globe player handles, as GEV's own radio filter: MP3 and AAC with its
 * plus, low-complexity and high-efficiency labels, compared without separators.
 */
const GLOBE_CODECS = new Set(['MP3', 'AAC', 'AAC+', 'AACLC', 'AACHE', 'HEAAC']);
const codecKey = (c: string) => c.replace(/[^A-Z0-9+]/g, '');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TAGS = 12;
const MAX_LANGUAGES = 6;
const MAX_URL = 1000;
/** Stations named in the summary (all of them are in data). */
const IN_SUMMARY = 5;

const schema = z
  .strictObject({
    ...pointFields,
    radius_km: z.number().min(1).max(150).optional().describe('Radius in km, 1-150 (default 50)'),
    query: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .optional()
      .describe(
        'Words that must all appear in the station name, tags or language, e.g. "news", "public radio", "college", "talk". Matched by the gateway, never sent to the directory.',
      ),
    https_only: z
      .boolean()
      .optional()
      .describe('true: only stations with an https stream (default false)'),
    limit: z
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe('Most stations to list, nearest first (default 20)'),
  })
  .superRefine((v, ctx) => refinePoint(v, ctx));

export interface RadioStation {
  id: string;
  name: string;
  distance_km: number;
  bearing_deg: number;
  direction: string;
  /** The directory's free-text state or region (it has no city field; this sometimes holds one). */
  state: string | null;
  country: string | null;
  country_code: string | null;
  tags: string[];
  languages: string[];
  codec: string | null;
  bitrate_kbps: number | null;
  https: boolean;
  hls: boolean;
  plays_on_globe: boolean;
  stream_url: string;
  homepage: string | null;
  last_check_ok: boolean;
  last_checked_at: string | null;
}

const LOCAL_SUFFIX = /(^|\.)(localhost|local|internal|lan|localdomain|home\.arpa)$/;

/**
 * An http(s) URL to a public host, or undefined: no credentials, no loopback, private or
 * link-local address (however spelled), no single-label or local name. Never fetched here; this
 * keeps a directory entry from pointing the user at their own network.
 */
export function publicHttpUrl(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (!s || s.length > MAX_URL) return undefined;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
  if (u.username || u.password) return undefined;
  const host = u.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (!host || LOCAL_SUFFIX.test(host)) return undefined;
  if (parseIp(host)) return isPrivateIp(host) ? undefined : u.href;
  return host.includes('.') && u.href.length <= MAX_URL ? u.href : undefined;
}

/** Lower case without accents, for matching query words. */
const fold = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();

/** A comma-separated directory list: cleaned, de-duplicated (ignoring case), capped. */
function list(v: unknown, max: number): string[] {
  if (typeof v !== 'string') return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of v.slice(0, 4000).split(',')) {
    const t = cleanText(part, 40);
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

const isoOrNull = (v: unknown): string | null =>
  typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v)) ? v : null;

type Skip = 'malformed' | 'no_coordinates' | 'unusable_stream_url' | 'outside_radius' | 'http_only';

/** One directory row as a station measured from the point, or why it was left out. */
export function parseStation(
  row: unknown,
  at: { lat: number; lon: number },
  radiusKm: number,
  httpsOnly: boolean,
): { station: RadioStation; haystack: string } | { skip: Skip } {
  if (!row || typeof row !== 'object') return { skip: 'malformed' };
  const r = row as Record<string, unknown>;
  const id = typeof r.stationuuid === 'string' ? r.stationuuid.trim() : '';
  const name = cleanText(r.name, 120);
  if (!UUID_RE.test(id) || !name) return { skip: 'malformed' };
  const lat = typeof r.geo_lat === 'number' ? r.geo_lat : NaN;
  const lon = typeof r.geo_long === 'number' ? r.geo_long : NaN;
  if (!isValidLatLon(lat, lon)) return { skip: 'no_coordinates' };
  // url_resolved is the stream itself; url (often a playlist) only when it is missing.
  const raw = typeof r.url_resolved === 'string' && r.url_resolved.trim() ? r.url_resolved : r.url;
  const stream = publicHttpUrl(raw);
  if (!stream) return { skip: 'unusable_stream_url' };
  const d = haversineM(at.lat, at.lon, lat, lon);
  if (d > radiusKm * 1000) return { skip: 'outside_radius' };
  const https = stream.startsWith('https:');
  if (httpsOnly && !https) return { skip: 'http_only' };
  const codecRaw = cleanText(r.codec, 16)?.toUpperCase();
  const codec = codecRaw && codecRaw !== 'UNKNOWN' ? codecRaw : null;
  const bitrate = typeof r.bitrate === 'number' && r.bitrate > 0 ? Math.round(r.bitrate) : null;
  const hls =
    r.hls === 1 || r.hls === true || r.hls === '1' || /\.m3u8$/i.test(new URL(stream).pathname);
  const languages = list(r.language, MAX_LANGUAGES);
  const cc = typeof r.countrycode === 'string' ? r.countrycode.trim().toUpperCase() : '';
  const bearing = bearingDeg(at.lat, at.lon, lat, lon);
  const homepage = publicHttpUrl(r.homepage) ?? null;
  return {
    station: {
      id: id.toLowerCase(),
      name,
      distance_km: round(d / 1000, 1),
      bearing_deg: Math.round(bearing),
      direction: compassPoint(bearing),
      state: cleanText(r.state, 80) ?? null,
      country: cleanText(r.country, 80) ?? null,
      country_code: /^[A-Z]{2}$/.test(cc) ? cc : null,
      tags: list(r.tags, MAX_TAGS),
      languages: languages.length ? languages : list(r.languagecodes, MAX_LANGUAGES),
      codec,
      bitrate_kbps: bitrate,
      https,
      hls,
      plays_on_globe: https && !hls && codec !== null && GLOBE_CODECS.has(codecKey(codec)),
      stream_url: stream,
      homepage,
      last_check_ok: r.lastcheckok === 1 || r.lastcheckok === true,
      last_checked_at: isoOrNull(r.lastchecktime_iso8601),
    },
    // Every tag counts for matching, not only the ones listed.
    haystack: fold(
      [
        name,
        cleanText(typeof r.tags === 'string' ? r.tags.slice(0, 4000) : '', 4000) ?? '',
        cleanText(r.language, 400) ?? '',
        cleanText(r.languagecodes, 100) ?? '',
      ].join('\n'),
    ),
  };
}

function directoryFailure(err: unknown): ToolOutput {
  if (!(err instanceof UpstreamError)) throw err;
  const s = err.status ?? 0;
  const kind =
    err.kind === 'rate_limited' || (err.kind === 'http' && (s >= 500 || (s >= 300 && s < 400)))
      ? 'retry_later'
      : err.kind === 'timeout' || err.kind === 'cancelled'
        ? 'timeout'
        : err.kind === 'unreachable'
          ? 'unavailable'
          : 'upstream';
  return failure(`Radio station directory: ${err.message}.`, kind);
}

function stationPhrase(s: RadioStation): string {
  const fmt = s.codec ? `, ${s.codec}${s.bitrate_kbps ? ` ${s.bitrate_kbps} kbps` : ''}` : '';
  const how = s.hls ? ', HLS' : s.https ? '' : ', http only';
  return `${s.name} (${s.distance_km} km ${s.direction}${fmt}${how})`;
}

export interface RadioToolDeps extends PointDeps {
  directory: RadioBrowser;
}

function jsonSchema(s: z.ZodType): JsonSchema {
  const json = z.toJSONSchema(s, { io: 'input' }) as JsonSchema;
  delete json.$schema;
  return json;
}

export function radioStationTools(deps: RadioToolDeps): ToolDef[] {
  const name = 'radio_stations_near';
  const def: ToolDef = {
    name,
    title: 'Radio stations near a place (Radio Browser directory)',
    description:
      "Radio stations near a place or the user: internet radio stations around a point from the public Radio Browser community directory, nearest first, including small local stations (public, college, community, news and talk). For popular stations worldwide by genre or name, use find_radio_stations instead. Each station: name, distance and bearing, state/region and country, tags, languages, codec and bitrate, whether the stream is https or HLS, the stream URL, the homepage, and whether the directory last found it working. Only stations whose directory entry has coordinates appear, and names, tags and places are community-entered (sometimes wrong). Claude cannot listen to the audio; the user can play the stream (on the God's Eye View globe only https MP3/AAC streams that are not HLS play). Point: lat/lon (for a place name, get its coordinates with geocode_place first) or here: true (the exact position is never sent: the directory is asked about a nearby grid point).",
    source: 'gateway',
    family: 'radio',
    nearIntent: true,
    inputSchema: jsonSchema(schema),
    tags: [
      'radio',
      'radio station',
      'radio stations',
      'local radio',
      'stations near me',
      'nearby',
      'closest',
      'fm',
      'am',
      'internet radio',
      'stream',
      'streaming',
      'listen',
      'what can i listen to',
      'public radio',
      'npr',
      'college radio',
      'community radio',
      'news radio',
      'talk radio',
      'sports radio',
      'music',
      'radio browser',
    ],
    attribution: RADIO_ATTRIBUTION,
    untrustedText: true,
    async run(args, ctx: ToolContext): Promise<ToolOutput> {
      const parsed = schema.safeParse(args);
      if (!parsed.success) {
        const why = parsed.error.issues
          .slice(0, 5)
          .map((i) => `${i.path.length ? i.path.join('.') : '(arguments)'}: ${i.message}`)
          .join('; ');
        return failure(
          `Invalid arguments for ${name}: ${why}. Fix them to match input_schema and call run_tool again.`,
          'invalid_arguments',
        );
      }
      const a = parsed.data;
      const at = resolvePoint(deps, name, a, ctx);
      if (!at.ok) return at.output;
      const radiusKm = a.radius_km ?? 50;
      const limit = a.limit ?? 20;
      const httpsOnly = a.https_only === true;
      let res: SearchResult;
      try {
        res = await deps.directory.search(
          { lat: at.point.lat, lon: at.point.lon, radiusKm, httpsOnly },
          ctx.signal,
        );
      } catch (err) {
        return directoryFailure(err);
      }
      const skipped: Record<Skip, number> = {
        malformed: 0,
        no_coordinates: 0,
        unusable_stream_url: 0,
        outside_radius: 0,
        http_only: 0,
      };
      const seen = new Set<string>();
      const inRange: Array<{ station: RadioStation; haystack: string }> = [];
      for (const row of res.rows) {
        const p = parseStation(row, at.point, radiusKm, httpsOnly);
        if ('skip' in p) skipped[p.skip]++;
        else if (!seen.has(p.station.id)) {
          seen.add(p.station.id);
          inRange.push(p);
        }
      }
      const query = a.query ? (cleanText(a.query, 80) ?? undefined) : undefined;
      const terms = query
        ? fold(query)
            .split(/[\s,]+/)
            .filter(Boolean)
            .slice(0, 8)
        : [];
      const matched = inRange
        .filter((p) => terms.every((t) => p.haystack.includes(t)))
        .map((p) => p.station)
        .sort((x, y) => x.distance_km - y.distance_km || x.name.localeCompare(y.name));
      const listed = matched.slice(0, limit);

      const where = at.point.fromPhone
        ? `the user's phone location (${at.point.note})`
        : 'the given point';
      const filter = query ? ` matching "${query}"` : '';
      const truncated = res.rows.length >= SEARCH_LIMIT;
      const parts: string[] = [];
      if (matched.length) {
        parts.push(
          `${matched.length} radio station${matched.length === 1 ? '' : 's'}${filter} within ${radiusKm} km of ${where} in the Radio Browser directory, nearest first: ${listed
            .slice(0, IN_SUMMARY)
            .map(stationPhrase)
            .join(
              '; ',
            )}${listed.length > IN_SUMMARY ? `; and ${listed.length - IN_SUMMARY} more (all in data)` : ''}.`,
        );
        if (matched.length > listed.length)
          parts.push(`Listing the nearest ${listed.length} of ${matched.length}.`);
      } else {
        parts.push(
          `No stations${filter} within ${radiusKm} km of ${where} in the Radio Browser directory${query && inRange.length ? ` (${inRange.length} in range without the query words)` : ''}.`,
        );
      }
      if (truncated)
        parts.push(
          `The directory has more stations with coordinates in range than one answer holds: only its ${SEARCH_LIMIT} most-played were checked (by its 24 h click count), so a less popular station nearby can be missing; a smaller radius helps.`,
        );
      parts.push(
        'Only stations whose directory entry has coordinates appear (some well-known stations have none); names, tags and places are community-entered and can be wrong.',
      );
      parts.push(LISTENING_NOTE);
      const age = Math.max(0, Math.round((deps.now() - res.fetchedAt) / 1000));
      if (age >= 60) parts.push(`Directory data fetched ${humanAge(age)} ago.`);
      return {
        summary: parts.join(' '),
        data: {
          radius_km: radiusKm,
          query: query ?? null,
          https_only: httpsOnly,
          position: at.point.note,
          count: matched.length,
          listed: listed.length,
          ...(query ? { in_range_without_query: inRange.length } : {}),
          skipped,
          directory: {
            source: 'Radio Browser',
            mirror: res.mirror,
            fetched_at: new Date(res.fetchedAt).toISOString(),
            rows_checked: res.rows.length,
            truncated,
            asked_about: `a ${QUERY_GRID_DEG}° grid point near ${at.point.fromPhone ? 'the phone fix' : 'the given point'}, radius ${res.queryRadiusKm} km (${QUERY_PAD_KM} km more than asked), so it never saw the exact position`,
          },
          listening_note: LISTENING_NOTE,
          stations: listed,
        },
        observedAt: new Date(res.fetchedAt).toISOString(),
      };
    },
  };
  return [def];
}
