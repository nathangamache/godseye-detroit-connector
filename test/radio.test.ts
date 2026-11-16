/**
 * radio_stations_near (src/extra/radio): the Radio Browser directory near a point.
 * Every upstream is mocked (no live calls); test points are public landmarks, stations are
 * made up (example hosts only).
 */
import { describe, expect, it } from 'vitest';
import { Audit } from '../src/audit.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { USER_AGENT, type FetchLike } from '../src/extra/civic/common.js';
import {
  FALLBACK_MIRRORS,
  MIRROR_CACHE_MS,
  QUERY_GRID_DEG,
  QUERY_PAD_KM,
  RADIO_BROWSER_SERVERS_URL,
  RadioBrowser,
  SEARCH_CACHE_MS,
  SEARCH_LIMIT,
  coarsenSearch,
  mirrorHost,
} from '../src/extra/radio/browser.js';
import { radioTools } from '../src/extra/radio/index.js';
import {
  STATE_COUNTRY_MISMATCH,
  stateCountryCheck,
  withRadioChecks,
} from '../src/extra/radio/regions.js';
import { RADIO_ATTRIBUTION, publicHttpUrl } from '../src/extra/radio/tools.js';
import { LocationStore } from '../src/location/store.js';
import { nullLogger } from '../src/log.js';
import { TokenStore } from '../src/oauth/tokens.js';
import { ToolPolicy } from '../src/tools/policy.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { ToolRunner } from '../src/tools/runner.js';
import { categoryFor } from '../src/tools/tags.js';
import type { ToolContext, ToolOutput } from '../src/tools/types.js';
import { haversineM } from '../src/util/geo.js';
import { BELLE_ISLE, DETROIT } from './helpers.js';

const T0 = Date.parse('2026-11-14T21:00:00Z');
const ctx = (extra: Partial<ToolContext> = {}): ToolContext => ({
  signal: new AbortController().signal,
  clientId: 'c1',
  ...extra,
});

// ------------------------------------------------------------------------------------
// Mock HTTP

interface Call {
  url: string;
  headers: Record<string, string>;
  redirect?: RequestInit['redirect'];
}

type Handler = (url: URL) => Response | Promise<Response>;

const json = (v: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(v), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

function mockFetch(handler: Handler) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    calls.push({ url, headers, redirect: init.redirect });
    return handler(new URL(url));
  };
  return { fetch, calls };
}

const SERVERS = [
  { ip: '192.0.2.10', name: 'de1.api.radio-browser.info' },
  { ip: '192.0.2.10', name: 'de1.api.radio-browser.info' },
  { ip: '192.0.2.11', name: 'de2.api.radio-browser.info' },
  { ip: '192.0.2.12', name: 'evil.example' },
  { ip: '192.0.2.13', name: 'de1.api.radio-browser.info.evil.example' },
  { ip: '192.0.2.14', name: '127.0.0.1' },
  { ip: '192.0.2.15', name: 'x.api.radio-browser.info/../../evil' },
];

/** A made-up station `km` away from `from` in direction `bearing` (0 = north, 90 = east). */
function station(
  name: string,
  km: number,
  bearing: number,
  extra: Record<string, unknown> = {},
  from = DETROIT,
): Record<string, unknown> {
  const rad = (bearing * Math.PI) / 180;
  const dLat = (km / 111.195) * Math.cos(rad);
  const dLon = ((km / 111.195) * Math.sin(rad)) / Math.cos((from.lat * Math.PI) / 180);
  const n = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const hex = h.toString(16).padStart(8, '0').slice(0, 8);
  return {
    changeuuid: `${hex}-0000-4000-8000-000000000000`,
    stationuuid: `${hex}-1111-4111-8111-111111111111`,
    name,
    url: `https://stream.example/${n}`,
    url_resolved: `https://stream.example/${n}.mp3`,
    homepage: `https://${n}.example/`,
    favicon: `https://${n}.example/icon.png`,
    tags: 'news,talk,public radio',
    country: 'The United States Of America',
    countrycode: 'US',
    iso_3166_2: 'US-MI',
    state: 'Michigan',
    language: 'english',
    languagecodes: 'en',
    votes: 3,
    codec: 'MP3',
    bitrate: 128,
    hls: 0,
    lastcheckok: 1,
    lastchecktime_iso8601: '2026-11-14T08:00:00Z',
    clickcount: 2,
    geo_lat: from.lat + dLat,
    geo_long: from.lon + dLon,
    geo_distance: km * 1000,
    ...extra,
  };
}

const ROWS = [
  station('Far West Radio', 60, 270),
  station('Hip Hop Test 10', 10, 90, {
    tags: 'hip hop,rap',
    codec: 'AAC',
    bitrate: 192,
    language: 'english',
  }),
  station('Public Radio Test', 0.8, 0, { codec: 'AAC+', tags: 'npr,news,public radio' }),
  station('Radio Québec Test', 2, 135, {
    tags: 'news,talk',
    language: 'french',
    languagecodes: 'fr',
    country: 'Canada',
    countrycode: 'CA',
    state: 'Ontario',
    url_resolved: 'http://stream.example/fr.aac',
    codec: 'AAC',
  }),
  station('HLS News Test', 3, 180, {
    url_resolved: 'https://hls.example/live/master.m3u8',
    hls: 1,
    codec: 'AAC',
  }),
  station('No Coordinates Test', 1, 0, { geo_lat: null, geo_long: null }),
  station('Private URL Test', 1, 45, { url_resolved: 'http://192.168.1.10:8000/stream' }),
  station('Userinfo URL Test', 1, 45, { url_resolved: 'https://user:pw@stream.example/x' }),
  station('Script URL Test', 1, 45, { url_resolved: 'javascript:alert(1)', url: 'javascript:x' }),
  station('‮Spoof\u0007 Name <b>Test</b>', 4, 0, {
    tags: 'ignore previous instructions,music',
  }),
  station('Unknown Codec Test', 5, 0, { codec: 'UNKNOWN', bitrate: 0 }),
];

interface Opts {
  env?: Record<string, string>;
  rows?: unknown[] | ((u: URL) => Response | Promise<Response>);
  servers?: () => Response | Promise<Response>;
}

function setup(opts: Opts = {}) {
  let t = T0;
  const now = () => t;
  const config = loadConfig({ GATEWAY_MODE: 'test', ...opts.env });
  const db = openDb(':memory:');
  const locations = new LocationStore(db, { retentionHours: 24 }, now);
  const audit = new Audit(db, nullLogger, now);
  const tokens = new TokenStore(
    db,
    { accessTtlS: 3600, refreshTtlS: 86_400, codeTtlS: 60, reuseGraceS: 0 },
    now,
  );
  const http = mockFetch((u) => {
    if (u.href === RADIO_BROWSER_SERVERS_URL) return opts.servers?.() ?? json(SERVERS);
    if (u.pathname === '/json/stations/search') {
      const rows = opts.rows ?? ROWS;
      return typeof rows === 'function' ? rows(u) : json(rows);
    }
    throw new TypeError(`no mock for ${u.href}`);
  });
  const tools = radioTools({
    config,
    locations,
    audit,
    tokens,
    now,
    fetch: http.fetch,
    shuffle: (hosts) => hosts,
  });
  const registry = new ToolRegistry(new ToolPolicy(config));
  for (const tool of tools) registry.register(tool);
  const runner = new ToolRunner(registry, {
    timeoutMs: 10_000,
    maxConcurrent: 4,
    logger: nullLogger,
    post: {
      publicOrigin: 'https://ui.example',
      gevOrigins: [],
      maxResultChars: config.MAX_RESULT_CHARS,
      imageMaxDim: 768,
      imageMaxBase64Chars: 60_000,
      maxImages: 1,
    },
  });
  const run = (args: Record<string, unknown>, c: Partial<ToolContext> = {}) =>
    registry.get('radio_stations_near')!.run(args, ctx(c));
  const searches = () => http.calls.filter((c) => c.url.includes('/json/stations/search'));
  return {
    config,
    db,
    locations,
    audit,
    tokens,
    registry,
    runner,
    http,
    run,
    searches,
    advance: (ms: number) => (t += ms),
  };
}

interface Station {
  id: string;
  name: string;
  distance_km: number;
  bearing_deg: number;
  direction: string;
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
type Data = Record<string, unknown> & { stations: Station[] };
const data = (o: ToolOutput) => o.data as Data;
const names = (o: ToolOutput) => data(o).stations.map((s) => s.name);

// ------------------------------------------------------------------------------------

describe('radio_stations_near: registration', () => {
  it('is a gateway tool in family "radio", category news, with a strict zod-derived schema', () => {
    const { registry } = setup();
    const t = registry.get('radio_stations_near')!;
    expect(t).toMatchObject({ source: 'gateway', family: 'radio', untrustedText: true });
    expect(t.attribution).toBe(RADIO_ATTRIBUTION);
    expect(RADIO_ATTRIBUTION).toMatch(/Radio Browser \(radio-browser\.info\)/);
    expect(RADIO_ATTRIBUTION).toMatch(/PDDL/);
    expect(RADIO_ATTRIBUTION).toMatch(/homepage/);
    expect(t.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
    expect(t.inputSchema.$schema).toBeUndefined();
    expect(Object.keys(t.inputSchema.properties as object).sort()).toEqual([
      'here',
      'https_only',
      'lat',
      'limit',
      'lon',
      'query',
      'radius_km',
    ]);
    expect(categoryFor('radio_stations_near', 'gateway')).toBe('news');
    expect(registry.catalog('news').map((e) => e.tool.name)).toContain('radio_stations_near');
    expect(registry.find('local radio stations near me', 3)[0]?.tool.name).toBe(
      'radio_stations_near',
    );
  });

  it('quotas come from RADIO_TOOL_RATE_LIMITS through the existing policy', async () => {
    const defaults = loadConfig({}).toolRateLimits.filter(
      (l) => l.bucket === 'radio_stations_near',
    );
    expect(defaults).toEqual([
      { bucket: 'radio_stations_near', limit: 60, windowMs: 3_600_000 },
      { bucket: 'radio_stations_near', limit: 300, windowMs: 86_400_000 },
    ]);
    expect(() => loadConfig({ RADIO_TOOL_RATE_LIMITS: 'nonsense' })).toThrow(
      /RADIO_TOOL_RATE_LIMITS/,
    );
    // A TOOL_RATE_LIMITS entry for the same bucket wins.
    expect(
      loadConfig({ TOOL_RATE_LIMITS: 'radio_stations_near=2/h' }).toolRateLimits.filter(
        (l) => l.bucket === 'radio_stations_near',
      ),
    ).toEqual([{ bucket: 'radio_stations_near', limit: 2, windowMs: 3_600_000 }]);
    const { runner } = setup({ env: { RADIO_TOOL_RATE_LIMITS: 'radio_stations_near=1/h' } });
    expect((await runner.run('radio_stations_near', { ...DETROIT }, ctx())).isError).toBeFalsy();
    const second = await runner.run('radio_stations_near', { ...DETROIT }, ctx());
    expect(second.isError).toBe(true);
    expect(second.content[0]!.text).toMatch(/Rate limit reached for radio_stations_near/);
  });

  it('validates arguments before anything is sent', async () => {
    const { run, runner, http } = setup();
    for (const bad of [
      {},
      { lat: DETROIT.lat },
      { ...DETROIT, here: true },
      { lat: 91, lon: 0 },
      { ...DETROIT, radius_km: 0.5 },
      { ...DETROIT, radius_km: 151 },
      { ...DETROIT, limit: 0 },
      { ...DETROIT, limit: 51 },
      { ...DETROIT, limit: 2.5 },
      { ...DETROIT, query: '' },
      { ...DETROIT, query: 'x'.repeat(81) },
      { ...DETROIT, https_only: 'yes' },
      { ...DETROIT, bogus: 1 },
    ]) {
      const r = await run(bad);
      expect(r, JSON.stringify(bad)).toMatchObject({
        isError: true,
        errorKind: 'invalid_arguments',
      });
    }
    const viaRunner = await runner.run('radio_stations_near', { ...DETROIT, bogus: 1 }, ctx());
    expect(viaRunner.content[0]!.text).toMatch(/unexpected property "bogus"/);
    expect(http.calls).toHaveLength(0);
  });
});

describe('radio_stations_near: Radio Browser requests', () => {
  it('discovers mirrors, then asks one geo search with the documented parameters', async () => {
    const { run, http } = setup();
    const r = await run({ ...DETROIT });
    expect(r.isError).toBeFalsy();
    expect(http.calls.map((c) => new URL(c.url).hostname)).toEqual([
      'all.api.radio-browser.info',
      'de1.api.radio-browser.info',
    ]);
    const u = new URL(http.calls[1]!.url);
    expect(u.protocol).toBe('https:');
    expect(u.pathname).toBe('/json/stations/search');
    expect(Object.fromEntries(u.searchParams)).toEqual({
      geo_lat: '42.35',
      geo_long: '-83.05',
      geo_distance: String((50 + QUERY_PAD_KM) * 1000),
      has_geo_info: 'true',
      hidebroken: 'true',
      order: 'clickcount',
      reverse: 'true',
      limit: String(SEARCH_LIMIT),
    });
    expect(SEARCH_LIMIT).toBeLessThanOrEqual(500);
    for (const c of http.calls) {
      expect(c.headers['user-agent']).toBe(USER_AGENT);
      expect(c.headers.accept).toBe('application/json');
      expect(c.redirect).toBe('error');
    }
    // Generic: no person, e-mail, host or address in it, and in the appname/version form.
    expect(USER_AGENT).toMatch(/^[\w.-]+\/[\d.]+ /);
    expect(USER_AGENT).not.toMatch(/@|https?:|\d+\.\d+\.\d+\.\d+/);
  });

  it('https_only adds is_https=true (a separate cache entry) and drops http streams here too', async () => {
    const { run, searches } = setup();
    const all = await run({ ...DETROIT });
    expect(names(all)).toContain('Radio Québec Test');
    const r = await run({ ...DETROIT, https_only: true });
    expect(searches()).toHaveLength(2);
    expect(new URL(searches()[1]!.url).searchParams.get('is_https')).toBe('true');
    // The mock ignores is_https, so this shows the local filter.
    expect(names(r)).not.toContain('Radio Québec Test');
    expect(data(r).stations.every((s) => s.https)).toBe(true);
    expect(data(r)).toMatchObject({ https_only: true });
  });

  it('ignores server-list names outside *.api.radio-browser.info and de-duplicates the rest', () => {
    expect(SERVERS.map((s) => mirrorHost(s.name))).toEqual([
      'de1.api.radio-browser.info',
      'de1.api.radio-browser.info',
      'de2.api.radio-browser.info',
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(mirrorHost('DE1.API.Radio-Browser.Info.')).toBe('de1.api.radio-browser.info');
    expect(mirrorHost(42)).toBeUndefined();
    expect(mirrorHost('api.radio-browser.info')).toBeUndefined();
  });

  it('by default shuffles the discovered mirrors (Radio Browser asks clients to spread load)', async () => {
    const http = mockFetch(() =>
      json(['a', 'b', 'c', 'd', 'e', 'f'].map((x) => ({ name: `${x}1.api.radio-browser.info` }))),
    );
    const orders = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const hosts = await new RadioBrowser({ fetch: http.fetch, now: () => T0 }).mirrors();
      expect(hosts.slice(6)).toEqual([...FALLBACK_MIRRORS]);
      expect([...hosts.slice(0, 6)].sort()).toEqual(
        ['a', 'b', 'c', 'd', 'e', 'f'].map((x) => `${x}1.api.radio-browser.info`),
      );
      orders.add(hosts.slice(0, 6).join());
    }
    expect(orders.size).toBeGreaterThan(1);
  });

  it('tries the next mirror on a failure, at most 3 in all, discovered ones first', async () => {
    let n = 0;
    const { run, searches } = setup({
      rows: () => (++n < 3 ? json({ error: 'busy' }, 503) : json(ROWS)),
    });
    const r = await run({ ...DETROIT });
    expect(r.isError).toBeFalsy();
    expect(searches().map((c) => new URL(c.url).hostname)).toEqual([
      'de1.api.radio-browser.info',
      'de2.api.radio-browser.info',
      'nl1.api.radio-browser.info',
    ]);
    expect(data(r)).toMatchObject({ directory: { mirror: 'nl1.api.radio-browser.info' } });
  });

  it('gives up after 3 failed mirrors with a retry-later error', async () => {
    const { run, searches } = setup({ rows: () => json({}, 502) });
    const r = await run({ ...DETROIT });
    expect(r).toMatchObject({ isError: true, errorKind: 'retry_later' });
    expect(r.summary).toMatch(/Radio Browser returned HTTP 502/);
    expect(r.summary).toMatch(/3 mirrors/);
    expect(searches()).toHaveLength(3);
  });

  it('falls back to de1, de2 and nl1 when the server list cannot be had', async () => {
    for (const servers of [
      () => json({}, 500),
      () => json({ not: 'a list' }),
      () => json([{ name: 'evil.example' }]),
      () => Promise.reject(new TypeError('network down')),
    ]) {
      const h = setup({ servers, rows: () => json({}, 503) });
      await h.run({ ...DETROIT });
      expect(h.searches().map((c) => new URL(c.url).hostname)).toEqual([...FALLBACK_MIRRORS]);
    }
    expect(FALLBACK_MIRRORS).toEqual([
      'de1.api.radio-browser.info',
      'de2.api.radio-browser.info',
      'nl1.api.radio-browser.info',
    ]);
  });

  it('refuses redirects: the next mirror is tried, the redirect target never contacted', async () => {
    let n = 0;
    const { run, http } = setup({
      rows: () =>
        ++n === 1
          ? new Response(null, {
              status: 302,
              headers: { location: 'https://evil.example/json/stations/search' },
            })
          : json(ROWS),
    });
    const r = await run({ ...DETROIT });
    expect(r.isError).toBeFalsy();
    const hosts = http.calls.map((c) => new URL(c.url).hostname);
    expect(hosts).not.toContain('evil.example');
    expect(hosts.slice(1)).toEqual(['de1.api.radio-browser.info', 'de2.api.radio-browser.info']);
  });

  it('a 4xx answer or an oversize body is not retried on other mirrors', async () => {
    const bad = setup({ rows: () => json({ error: 'bad request' }, 400) });
    expect(await bad.run({ ...DETROIT })).toMatchObject({ isError: true });
    expect(bad.searches()).toHaveLength(1);
    const big = setup({ rows: () => new Response('['.padEnd(3 * 1024 * 1024, ' ') + ']') });
    const r = await big.run({ ...DETROIT });
    expect(r).toMatchObject({ isError: true });
    expect(r.summary).toMatch(/KB/);
    expect(big.searches()).toHaveLength(1);
  });

  it('caches the server list 6 h and each cell + radius + https_only search 30 min', async () => {
    const h = setup();
    const servers = () => h.http.calls.filter((c) => c.url === RADIO_BROWSER_SERVERS_URL).length;
    await h.run({ ...DETROIT });
    // Same cell, same radius: the cached directory answer, whatever the query words or limit.
    await h.run({ ...DETROIT, query: 'news', limit: 3 });
    await h.run({ lat: DETROIT.lat + 0.01, lon: DETROIT.lon, query: 'jazz' });
    expect(h.searches()).toHaveLength(1);
    // Another cell, another radius: new searches; the server list is still cached.
    await h.run({ ...BELLE_ISLE });
    await h.run({ ...DETROIT, radius_km: 20 });
    expect(h.searches()).toHaveLength(3);
    expect(servers()).toBe(1);
    h.advance(SEARCH_CACHE_MS + 1);
    await h.run({ ...DETROIT });
    expect(h.searches()).toHaveLength(4);
    expect(servers()).toBe(1);
    h.advance(MIRROR_CACHE_MS);
    await h.run({ ...DETROIT });
    expect(servers()).toBe(2);
    expect(MIRROR_CACHE_MS).toBe(6 * 3_600_000);
    expect(SEARCH_CACHE_MS).toBe(30 * 60_000);
  });

  it('never fetches a stream, a homepage or /json/url (that counts a play)', async () => {
    const { run, http } = setup();
    await run({ ...DETROIT, limit: 50 });
    await run({ ...DETROIT, query: 'news' });
    for (const c of http.calls) {
      const u = new URL(c.url);
      expect(u.hostname).toMatch(/\.api\.radio-browser\.info$/);
      expect(u.pathname).toMatch(/^\/json\/(servers|stations\/search)$/);
    }
  });
});

describe('radio_stations_near: answers', () => {
  it('lists stations in range nearest first, measured from the exact point', async () => {
    const { run } = setup();
    const r = await run({ ...DETROIT });
    const d = data(r);
    // 60 km is inside the enlarged query (56 km) but outside 50 km of the point.
    expect(names(r)).not.toContain('Far West Radio');
    expect(names(r)).toEqual([
      'Public Radio Test',
      'Radio Québec Test',
      'HLS News Test',
      'Spoof Name Test',
      'Unknown Codec Test',
      'Hip Hop Test 10',
    ]);
    const km = d.stations.map((s) => s.distance_km);
    expect([...km].sort((a, b) => a - b)).toEqual(km);
    const first = d.stations[0]!;
    expect(first).toMatchObject({
      name: 'Public Radio Test',
      distance_km: 0.8,
      direction: 'N',
      state: 'Michigan',
      country: 'The United States Of America',
      country_code: 'US',
      tags: ['npr', 'news', 'public radio'],
      languages: ['english'],
      codec: 'AAC+',
      bitrate_kbps: 128,
      https: true,
      hls: false,
      plays_on_globe: true,
      stream_url: 'https://stream.example/public-radio-test.mp3',
      homepage: 'https://public-radio-test.example/',
      last_check_ok: true,
      last_checked_at: '2026-11-14T08:00:00Z',
    });
    expect(first.id).toMatch(/^[0-9a-f]{8}-/);
    expect(first.bearing_deg).toBeLessThan(2);
    const east = d.stations.find((s) => s.name === 'Hip Hop Test 10')!;
    expect(east).toMatchObject({ direction: 'E', distance_km: 10, codec: 'AAC' });
    expect(Math.abs(east.bearing_deg - 90)).toBeLessThan(1);
    expect(d).toMatchObject({
      radius_km: 50,
      count: 6,
      listed: 6,
      position: 'point given by the caller',
      skipped: { no_coordinates: 1, unusable_stream_url: 3, outside_radius: 1 },
      directory: { rows_checked: ROWS.length, truncated: false },
    });
    expect(r.observedAt).toBe(new Date(T0).toISOString());
    expect(r.summary).toMatch(
      /^6 radio stations within 50 km of the given point in the Radio Browser directory, nearest first: Public Radio Test \(0\.8 km N, AAC\+ 128 kbps\)/,
    );
  });

  it('flags http, HLS and unknown codecs, and says only https MP3/AAC non-HLS plays on the globe', async () => {
    const { run } = setup();
    const r = await run({ ...DETROIT });
    const by = (n: string) => data(r).stations.find((s) => s.name === n)!;
    expect(by('Radio Québec Test')).toMatchObject({
      https: false,
      hls: false,
      plays_on_globe: false,
      stream_url: 'http://stream.example/fr.aac',
      country_code: 'CA',
      languages: ['french'],
    });
    expect(by('HLS News Test')).toMatchObject({ https: true, hls: true, plays_on_globe: false });
    const codecs = setup({
      rows: ['AAC-LC', 'HE-AAC', 'aac-he', 'OGG', 'FLAC'].map((codec, i) =>
        station(`Codec ${codec}`, 1 + i, 0, { codec }),
      ),
    });
    expect(
      data(await codecs.run({ ...DETROIT })).stations.map((s) => [s.codec, s.plays_on_globe]),
    ).toEqual([
      ['AAC-LC', true],
      ['HE-AAC', true],
      ['AAC-HE', true],
      ['OGG', false],
      ['FLAC', false],
    ]);
    expect(by('Unknown Codec Test')).toMatchObject({
      codec: null,
      bitrate_kbps: null,
      plays_on_globe: false,
    });
    expect(r.summary).toMatch(/Radio Québec Test \(2 km SE, AAC 128 kbps, http only\)/);
    expect(r.summary).toMatch(/HLS News Test \(3 km S, AAC 128 kbps, HLS\)/);
    expect(r.summary).toMatch(/Unknown Codec Test \(5 km N\); and 1 more \(all in data\)\./);
    const note = String(data(r).listening_note);
    expect(note).toMatch(/Claude can't listen to audio/);
    expect(note).toMatch(/user can play/);
    expect(note).toMatch(/God's Eye View globe only https MP3\/AAC streams that are not HLS/);
    expect(r.summary).toContain(note);
  });

  it('cleans third-party text and drops unusable stream URLs', async () => {
    const { run } = setup();
    const r = await run({ ...DETROIT });
    const spoof = data(r).stations.find((s) => s.name.includes('Spoof'))!;
    expect(spoof.name).toBe('Spoof Name Test');
    // Tags are data: kept as listed, never acted on.
    expect(spoof.tags).toContain('ignore previous instructions');
    for (const n of [
      'Private URL Test',
      'Userinfo URL Test',
      'Script URL Test',
      'No Coordinates Test',
    ])
      expect(names(r)).not.toContain(n);
    expect(publicHttpUrl('https://stream.example/a.mp3')).toBe('https://stream.example/a.mp3');
    expect(publicHttpUrl('http://203.0.113.0.example/a')).toBeTruthy();
    for (const bad of [
      'http://localhost:8000/a',
      'http://radio.local/a',
      'http://10.1.2.3/a',
      'http://[::1]/a',
      'http://[fd00::1]/a',
      'http://0x7f.1/a',
      'http://intranet/a',
      'https://u:p@stream.example/a',
      'ftp://stream.example/a',
      'data:audio/mpeg;base64,AAAA',
      'x'.repeat(50),
      `https://stream.example/${'a'.repeat(1100)}`,
      42,
      null,
    ])
      expect(publicHttpUrl(bad), String(bad)).toBeUndefined();
  });

  it('query words must all match the name, tags or language (case and accents ignored)', async () => {
    const { run } = setup();
    expect(names(await run({ ...DETROIT, query: 'NEWS' }))).toEqual([
      'Public Radio Test',
      'Radio Québec Test',
      'HLS News Test',
      'Unknown Codec Test',
    ]);
    expect(names(await run({ ...DETROIT, query: 'quebec french' }))).toEqual(['Radio Québec Test']);
    expect(names(await run({ ...DETROIT, query: 'hip hop' }))).toEqual(['Hip Hop Test 10']);
    const none = await run({ ...DETROIT, query: 'polka' });
    expect(none.isError).toBeFalsy();
    expect(data(none)).toMatchObject({ count: 0, in_range_without_query: 6, query: 'polka' });
    expect(none.summary).toMatch(
      /^No stations matching "polka" within 50 km of the given point in the Radio Browser directory \(6 in range without the query words\)/,
    );
  });

  it('limit lists the nearest few, and count still covers every match', async () => {
    const { run } = setup();
    const r = await run({ ...DETROIT, limit: 2 });
    expect(names(r)).toEqual(['Public Radio Test', 'Radio Québec Test']);
    expect(data(r)).toMatchObject({ count: 6, listed: 2 });
    expect(r.summary).toMatch(/Listing the nearest 2 of 6/);
  });

  it('says when the directory answer hit the row limit', async () => {
    const many = Array.from({ length: SEARCH_LIMIT }, (_, i) =>
      station(`Filler ${i}`, 1 + (i % 40), (i * 7) % 360),
    );
    const { run } = setup({ rows: many });
    const r = await run({ ...DETROIT, limit: 5 });
    expect(data(r)).toMatchObject({ directory: { rows_checked: SEARCH_LIMIT, truncated: true } });
    expect(r.summary).toMatch(/only its 500 most-played were checked/);
  });

  it('no stations at all is a normal answer that says why that can happen', async () => {
    const { run } = setup({ rows: [] });
    const r = await run({ ...DETROIT, radius_km: 5 });
    expect(r.isError).toBeFalsy();
    expect(r.summary).toMatch(/^No stations within 5 km of the given point/);
    expect(r.summary).toMatch(/only stations whose directory entry has coordinates/i);
  });

  it('answers a malformed directory reply with an error, not a crash', async () => {
    const { run } = setup({ rows: () => new Response('<html>oops</html>') });
    const r = await run({ ...DETROIT });
    expect(r).toMatchObject({ isError: true });
    expect(r.summary).toMatch(/not JSON/);
    const junk = setup({ rows: [null, 7, 'x', { name: 'No uuid', geo_lat: 1 }] });
    const j = await junk.run({ ...DETROIT });
    expect(j.isError).toBeFalsy();
    expect(data(j)).toMatchObject({ count: 0, skipped: { malformed: 4 } });
  });
});

describe('radio directory rows: state and country that disagree', () => {
  it('flags, never hides, a station whose state belongs to another country', async () => {
    const { run } = setup({
      rows: [
        station('Mismatch Test', 1, 0, {
          state: 'Niederösterreich',
          country: 'The United States Of America',
          countrycode: 'US',
        }),
        station('Across The River Test', 2, 90, { state: 'Ontario' }),
        station('Consistent Test', 3, 180),
        station('City In State Test', 4, 270, { state: 'Detroit' }),
        station('Code Test', 5, 0, { state: 'MI' }),
        station('Canada Test', 6, 0, { state: 'Ontario', country: 'Canada', countrycode: 'CA' }),
      ],
    });
    const r = await run({ ...DETROIT });
    const by = (n: string) =>
      data(r).stations.find((s) => s.name === n)! as Station & {
        check?: string;
        check_detail?: string;
      };
    expect(data(r).count).toBe(6);
    expect(by('Mismatch Test')).toMatchObject({
      state: 'Niederösterreich',
      country: 'The United States Of America',
      check: 'state/country mismatch',
      check_detail:
        'the state "Niederösterreich" is a region of Austria, but the country given is The United States Of America (country code US); the directory entry may be wrong',
    });
    expect(by('Across The River Test')).toMatchObject({
      check: 'state/country mismatch',
      check_detail: expect.stringMatching(/"Ontario" is a region of Canada/),
    });
    for (const n of ['Consistent Test', 'City In State Test', 'Code Test', 'Canada Test'])
      expect(by(n).check, n).toBeUndefined();
    expect(r.summary).toContain(
      'Mismatch Test (1 km N, MP3 128 kbps, check: state/country mismatch)',
    );
    expect(r.summary).toMatch(
      /2 stations are flagged "check: state\/country mismatch": their directory state and country disagree/,
    );
  });

  it('knows regions by their own and English names, and leaves ambiguous names alone', () => {
    const us = { name: 'The United States Of America', code: 'US' };
    expect(stateCountryCheck('Steiermark', us)?.check).toBe(STATE_COUNTRY_MISMATCH);
    expect(stateCountryCheck('styria', us)?.check).toBe(STATE_COUNTRY_MISMATCH);
    expect(stateCountryCheck('Bavaria', { name: 'Japan' })?.check_detail).toMatch(/of Germany/);
    expect(stateCountryCheck('Michigan', { name: 'Austria' })?.check_detail).toMatch(
      /of the United States/,
    );
    expect(stateCountryCheck('Graz, Steiermark', { name: 'Austria' })).toBeUndefined();
    expect(stateCountryCheck('Wien', { name: 'Österreich' })).toBeUndefined();
    expect(stateCountryCheck('Ohio', { name: 'United States' })).toBeUndefined();
    expect(
      stateCountryCheck('Nordrhein-Westfalen', { name: 'Germany', code: 'DE' }),
    ).toBeUndefined();
    // Also a place elsewhere: never flagged.
    for (const st of ['Georgia', 'Victoria', 'Vienna', 'Berlin', 'Washington', 'Durango', 'Mexico'])
      expect(stateCountryCheck(st, { name: 'Canada', code: 'CA' }), st).toBeUndefined();
    // Nothing to compare.
    expect(stateCountryCheck('Bayern', {})).toBeUndefined();
    expect(stateCountryCheck(null, us)).toBeUndefined();
    expect(stateCountryCheck('Some Town', us)).toBeUndefined();
  });

  it("flags the rows of GEV's find_radio_stations the same way, and leaves other tools alone", async () => {
    const rows = [
      { name: 'Vienna Test', state: 'Wien', country: 'The United States Of America' },
      { name: 'Fine Test', state: 'Michigan', country: 'The United States Of America' },
    ];
    const gev = withRadioChecks(async (name) => ({
      summary: `2 radio stations (from a directory of 500 popular stations).`,
      data: {
        total: 2,
        returned: 2,
        truncated: false,
        rows: name === 'find_radio_stations' ? rows : [],
      },
    }));
    const c = { ...ctx(), timeoutMs: 1000 };
    const out = await gev('find_radio_stations', { query: 'news' }, c);
    const got = (out.data as { rows: Array<Record<string, unknown>> }).rows;
    expect(got[0]).toMatchObject({
      name: 'Vienna Test',
      check: 'state/country mismatch',
      check_detail: expect.stringMatching(/"Wien" is a region of Austria/),
    });
    expect(got[1]!.check).toBeUndefined();
    expect(out.summary).toBe(
      '2 radio stations (from a directory of 500 popular stations).\n1 station is flagged "check: state/country mismatch": its directory state and country disagree (data.rows[].check_detail); the directory is community-entered.',
    );
    // The input rows are not changed in place; other tools pass through.
    expect(rows[0]).not.toHaveProperty('check');
    const other = await gev('get_weather', {}, c);
    expect(other.summary).not.toMatch(/mismatch/);
  });
});

describe('radio_stations_near: privacy', () => {
  it('coarsens every query to a 0.05 degree grid point with a 6 km larger radius', () => {
    expect(QUERY_GRID_DEG).toBe(0.05);
    expect(QUERY_PAD_KM).toBe(6);
    expect(coarsenSearch(DETROIT, 50)).toEqual({ lat: 42.35, lon: -83.05, radiusKm: 56 });
    expect(coarsenSearch({ lat: 0.01, lon: 179.99 }, 2.5)).toEqual({
      lat: 0,
      lon: 180,
      radiusKm: 9,
    });
    expect(coarsenSearch({ lat: -0.01, lon: -179.99 }, 1).lon).toBe(-180);
    // The grid point is always well inside the padding, at any latitude.
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    for (let i = 0; i < 2000; i++) {
      const p = { lat: rnd() * 89.9, lon: rnd() * 180 };
      const q = coarsenSearch(p, 10);
      expect(haversineM(p.lat, p.lon, q.lat, q.lon)).toBeLessThan(4_000);
      expect(q.radiusKm).toBe(16);
    }
  });

  it('here: true reads the phone fix, audits it, and never sends or echoes the exact position', async () => {
    const h = setup();
    const { familyId } = h.tokens.issue({
      clientId: 'c1',
      subject: 'owner',
      scope: 'mcp',
      resource: 'r',
    });
    const none = await h.run({ here: true }, { familyId });
    expect(none).toMatchObject({ isError: true, errorKind: 'unavailable' });
    expect(none.summary).toMatch(/No phone location fix/);
    expect(h.http.calls).toHaveLength(0);
    const dev = h.locations.createDevice('phone');
    h.locations.insert({
      deviceId: dev.id,
      ...DETROIT,
      accuracyM: 9,
      fixTs: T0 - 120_000,
      source: 'api',
    });
    const r = await h.run({ here: true, radius_km: 20 }, { familyId });
    expect(r.isError).toBeFalsy();
    expect(names(r)[0]).toBe('Public Radio Test');
    expect(data(r).position).toBe('phone fix 2 min old, ±9 m');
    expect(r.summary).toMatch(/within 20 km of the user's phone location \(phone fix 2 min old/);
    const sent = new URL(h.searches()[0]!.url);
    expect(sent.searchParams.get('geo_lat')).toBe('42.35');
    expect(sent.searchParams.get('geo_long')).toBe('-83.05');
    expect(sent.searchParams.get('geo_distance')).toBe('26000');
    for (const c of h.http.calls) expect(c.url).not.toMatch(/42\.33|83\.04/);
    const out = JSON.stringify({ summary: r.summary, data: r.data });
    expect(out).not.toMatch(/42\.33|83\.04/);
    const reads = h.audit.recent(10, 'access');
    expect(reads.map((x) => JSON.parse(x.detail!))).toEqual([
      { family: familyId, tool: 'radio_stations_near', fix: true },
      { family: familyId, tool: 'radio_stations_near', fix: false },
    ]);
    for (const x of reads) expect(x.detail).not.toMatch(/42\.3|83\.0/);
    expect(h.tokens.listFamilies().find((f) => f.family_id === familyId)!.location_reads).toBe(2);
  });

  it('a stale phone fix is used but flagged', async () => {
    const h = setup();
    const dev = h.locations.createDevice('phone');
    h.locations.insert({ deviceId: dev.id, ...DETROIT, fixTs: T0 - 3 * 3_600_000, source: 'api' });
    const r = await h.run({ here: true });
    expect(r.isError).toBeFalsy();
    expect(data(r).position).toMatch(/STALE/);
  });
});
