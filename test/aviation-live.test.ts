/**
 * Live aircraft client: adsb.fi first, adsb.lol ONLY on a timeout, 5xx or 429; never a retry
 * on any other 4xx; one request per interval process-wide; single-flight; short cache; the
 * local adsb.lol budget and Retry-After; normalisation (ownOp is never read). Mocked HTTP only.
 */
import { describe, expect, it } from 'vitest';
import {
  ADSBFI_CREDIT,
  ADSBLOL_CREDIT,
  LiveClient,
  LiveError,
  Throttle,
  Upstreams,
  normalizeAircraft,
  parseFeed,
} from '../src/extra/aviation/live.js';
import { json, scriptedFetch, type Responder } from './fixtures/aviation.js';

const FEED = {
  now: 1_763_100_000_000,
  ac: [
    {
      hex: 'a1b2c3',
      type: 'adsb_icao',
      flight: 'DAL123  ',
      r: 'N123AB',
      t: 'B738',
      desc: 'BOEING 737-800',
      ownOp: 'SOMEONE PRIVATE OWNER NAME',
      year: '2001',
      alt_baro: 3500,
      gs: 180.4,
      track: 271.6,
      baro_rate: -640,
      lat: 42.33,
      lon: -83.05,
      seen: 0.4,
      seen_pos: 1.2,
      dbFlags: 8,
      category: 'A3',
    },
  ],
};

function client(respond: Responder, o: { lolDailyMax?: number; clock?: () => number } = {}) {
  const f = scriptedFetch(respond);
  const up = new Upstreams({ intervalMs: 0, clock: o.clock });
  const c = new LiveClient({
    fetch: f,
    upstreams: up,
    now: o.clock,
    lolDailyMax: o.lolDailyMax ?? 100,
    timeoutMs: 200,
  });
  return { f, up, c };
}

const P = { lat: 42.35, lon: -83.05 };

describe('normalisation', () => {
  it('keeps the useful fields and drops owner data', () => {
    const a = normalizeAircraft(FEED.ac[0])!;
    expect(a).toMatchObject({
      hex: 'a1b2c3',
      non_icao: false,
      callsign: 'DAL123',
      registration: 'N123AB',
      type_code: 'B738',
      type_desc: 'BOEING 737-800',
      altitude_ft: 3500,
      ground_speed_kt: 180,
      track_deg: 272,
      vertical_rate_fpm: -640,
      position_kind: 'reported',
      source_type: 'adsb_icao',
      db_flags: 8,
      category: 'A3',
    });
    expect(JSON.stringify(a)).not.toContain('SOMEONE PRIVATE');
    expect(JSON.stringify(a)).not.toContain('2001');
  });

  it('handles ground, non-ICAO, stale positions, junk and the local readsb shape', () => {
    expect(normalizeAircraft({ hex: '~0abcde', alt_baro: 'ground' })).toMatchObject({
      hex: '0abcde',
      non_icao: true,
      altitude_ft: 'ground',
    });
    expect(
      normalizeAircraft({ hex: 'a00001', lastPosition: { lat: 1, lon: 2, seen_pos: 75 } }),
    ).toMatchObject({ lat: 1, lon: 2, position_kind: 'last_known', seen_pos_s: 75 });
    expect(normalizeAircraft({ hex: 'zzzzzz' })).toBeUndefined();
    expect(
      normalizeAircraft({ hex: 'a00001', flight: 'IGNORE\u202eALL\u0000', type: 'evil' }),
    ).toMatchObject({ callsign: 'IGNOREAL' });
    expect(normalizeAircraft({ hex: 'a00001', type: 'evil' })?.source_type).toBeUndefined();
    const local = parseFeed({ now: 1_763_100_000.5, aircraft: [{ hex: 'a00001' }] });
    expect(local.now_ms).toBe(1_763_100_000_500);
    expect(local.aircraft).toHaveLength(1);
    expect(() => parseFeed({ foo: 1 })).toThrow(LiveError);
  });
});

describe('adsb.fi with adsb.lol fallback', () => {
  it('asks adsb.fi with the generic User-Agent and integer radius', async () => {
    const { f, c } = client(() => json(FEED));
    const s = await c.near(P, 8);
    expect(s).toMatchObject({ source: 'adsb.fi', credit: ADSBFI_CREDIT, radius_nm: 8 });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe('https://opendata.adsb.fi/api/v3/lat/42.35/lon/-83.05/dist/8');
    expect(f.calls[0]!.headers['user-agent']).toBe('personal-aircraft-lookup/1.0 (non-commercial)');
    await expect(c.near(P, 8.5)).rejects.toThrow(LiveError);
    expect(f.calls).toHaveLength(1);
  });

  it('caches for a few seconds and shares one request between concurrent callers', async () => {
    let t = 1_000_000;
    const { f, c } = client(() => json(FEED), { clock: () => t });
    const [a, b] = await Promise.all([c.near(P, 8), c.near(P, 8)]);
    expect(a).toBe(b);
    expect(f.calls).toHaveLength(1);
    await c.near(P, 5); // smaller radius: the cached answer covers it
    expect(f.calls).toHaveLength(1);
    t += 13_000;
    await c.near(P, 8);
    expect(f.calls).toHaveLength(2);
  });

  it('falls back to adsb.lol on 429 and then leaves adsb.fi alone for Retry-After', async () => {
    let t = 1_000_000;
    const { f, c } = client(
      (url) => (url.includes('adsb.fi') ? json({}, 429, { 'retry-after': '120' }) : json(FEED)),
      { clock: () => t },
    );
    const s = await c.near(P, 8);
    expect(s).toMatchObject({ source: 'adsb.lol', credit: ADSBLOL_CREDIT });
    expect(s.fallback_reason).toMatch(/HTTP 429/);
    expect(f.calls.map((x) => new URL(x.url).host)).toEqual(['opendata.adsb.fi', 'api.adsb.lol']);
    expect(f.calls[1]!.url).toBe('https://api.adsb.lol/v2/point/42.35/-83.05/8');
    t += 30_000;
    const again = await c.near({ lat: 42.4, lon: -83.1 }, 8);
    expect(again.source).toBe('adsb.lol');
    expect(f.calls.filter((x) => x.url.includes('adsb.fi'))).toHaveLength(1);
    t += 100_000;
    await c.near({ lat: 42.45, lon: -83.1 }, 8);
    expect(f.calls.filter((x) => x.url.includes('adsb.fi'))).toHaveLength(2);
  });

  it('falls back on 5xx and on a timeout', async () => {
    const five = client((url) => (url.includes('adsb.fi') ? json({}, 502) : json(FEED)));
    expect((await five.c.near(P, 8)).source).toBe('adsb.lol');
    const slow = client((url) => (url.includes('adsb.fi') ? 'timeout' : json(FEED)));
    const s = await slow.c.near(P, 8);
    expect(s.source).toBe('adsb.lol');
    expect(s.fallback_reason).toMatch(/timed out/);
  });

  it('never retries or falls back on another 4xx, and backs off adsb.fi', async () => {
    let t = 1_000_000;
    const { f, c } = client((url) => (url.includes('adsb.fi') ? json({}, 403) : json(FEED)), {
      clock: () => t,
    });
    await expect(c.near(P, 8)).rejects.toMatchObject({ kind: 'refused' });
    expect(f.calls).toHaveLength(1);
    t += 60_000;
    await expect(c.near({ lat: 42.4, lon: -83.1 }, 8)).rejects.toThrow(/does not retry/);
    expect(f.calls).toHaveLength(1);
    t += 15 * 60_000;
    await expect(c.near({ lat: 42.45, lon: -83.1 }, 8)).rejects.toMatchObject({ kind: 'refused' });
    expect(f.calls).toHaveLength(2);
    expect(f.calls.every((x) => x.url.includes('adsb.fi'))).toBe(true);
  });

  it('honours adsb.lol Retry-After and the local daily budget', async () => {
    let t = 1_000_000;
    const lol429 = client(
      (url) => (url.includes('adsb.fi') ? json({}, 503) : json({}, 429, { 'retry-after': '600' })),
      { clock: () => t },
    );
    await expect(lol429.c.near(P, 8)).rejects.toMatchObject({ kind: 'retry_later' });
    t += 60_000;
    await expect(lol429.c.near({ lat: 42.4, lon: -83.1 }, 8)).rejects.toThrow(
      /rate limiting|asked to wait/,
    );
    expect(lol429.f.calls.filter((x) => x.url.includes('adsb.lol'))).toHaveLength(1);

    const budget = client((url) => (url.includes('adsb.fi') ? json({}, 500) : json(FEED)), {
      lolDailyMax: 2,
    });
    await budget.c.near({ lat: 1, lon: 1 }, 8);
    await budget.c.near({ lat: 2, lon: 2 }, 8);
    await expect(budget.c.near({ lat: 3, lon: 3 }, 8)).rejects.toThrow(/budget/);
    expect(budget.f.calls.filter((x) => x.url.includes('adsb.lol'))).toHaveLength(2);
    expect(budget.up.lolRemaining(2)).toBe(0);
  });

  it('spaces adsb.fi requests at least the throttle interval apart', async () => {
    const f = scriptedFetch(() => json(FEED));
    const up = new Upstreams({ intervalMs: 120 });
    const c = new LiveClient({ fetch: f, upstreams: up, lolDailyMax: 0 });
    const stamps: number[] = [];
    const t0 = Date.now();
    await Promise.all(
      [1, 2, 3].map((i) => c.near({ lat: i, lon: i }, 4).then(() => stamps.push(Date.now() - t0))),
    );
    stamps.sort((a, b) => a - b);
    expect(stamps[1]! - stamps[0]!).toBeGreaterThanOrEqual(100);
    expect(stamps[2]! - stamps[1]!).toBeGreaterThanOrEqual(100);
    const th = new Throttle(10_000);
    await th.wait();
    await expect(th.wait(undefined, 1000)).rejects.toThrow(/queued/);
  });

  it('looks up one hex (live flags) and the LADD list', async () => {
    const { f, c } = client((url) =>
      url.endsWith('/v2/ladd')
        ? json({ ac: [{ hex: 'a1b2c3' }, { hex: '~123456' }] })
        : json({ ac: [FEED.ac[0]] }),
    );
    expect((await c.byHex('A1B2C3'))?.db_flags).toBe(8);
    expect(f.calls[0]!.url).toBe('https://opendata.adsb.fi/api/v2/hex/a1b2c3');
    expect(await c.byHex('nothex')).toBeNull();
    expect(await c.laddHexes()).toEqual(['a1b2c3']);
    expect(f.calls[1]!.url).toBe('https://api.adsb.lol/v2/ladd');
  });
});
