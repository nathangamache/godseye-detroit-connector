import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, parseRateLimits } from '../src/config.js';
import { createLogger, sanitize } from '../src/log.js';

describe('config', () => {
  it('has safe defaults', () => {
    const c = loadConfig({});
    expect(c.HOST).toBe('127.0.0.1');
    expect(c.PORT).toBe(7700);
    expect(c.mcpResource).toBe('https://godseye.gamachecloud.com/mcp');
    expect(c.mode).toBe('development');
    expect(c.loginProvider).toBe('none');
    expect(c.allowedHosts).toContain('godseye.gamachecloud.com');
    expect(c.privateOrigin).toBe('http://127.0.0.1:7702');
    expect(c.authorizationEndpoint).toBe('http://127.0.0.1:7702/oauth/authorize');
    expect(c.ALLOW_OPENSKY_TOOLS).toBe(false);
  });

  it('fails closed in production without the Tailscale owner login', () => {
    expect(() => loadConfig({ GATEWAY_MODE: 'production' })).toThrow(ConfigError);
    const ok = loadConfig({
      GATEWAY_MODE: 'production',
      PRIVATE_ORIGIN: 'https://godseye.t.ts.net',
      OWNER_TAILSCALE_LOGIN: 'Owner@Example.com',
      HOST: '172.30.77.20',
      PRIVATE_HOST: '127.0.0.2',
      TRUSTED_PROXY_IPS: '172.30.77.10',
      TAILSCALE_TRUSTED_PROXY_IPS: '127.0.0.1',
      STEPUP_TOTP: 'off',
    });
    expect(ok.loginProvider).toBe('tailscale');
    expect(ok.ownerTailscaleLogin).toBe('owner@example.com');
  });

  it('rejects http public origins in production', () => {
    expect(() =>
      loadConfig({
        GATEWAY_MODE: 'production',
        PUBLIC_ORIGIN: 'http://example.com',
        PRIVATE_ORIGIN: 'https://godseye.t.ts.net',
        OWNER_TAILSCALE_LOGIN: 'o@e.com',
      }),
    ).toThrow(/https/);
  });

  it('parses rate limits', () => {
    expect(parseRateLimits('a=2/h, b_c=10/m')).toEqual([
      { bucket: 'a', limit: 2, windowMs: 3_600_000 },
      { bucket: 'b_c', limit: 10, windowMs: 60_000 },
    ]);
    expect(() => parseRateLimits('nope')).toThrow();
  });

  it('composes one quota list: TOOL_RATE_LIMITS, then every family default it does not name', () => {
    const key = (l: { bucket: string; windowMs: number }) => `${l.bucket}/${l.windowMs}`;
    const c = loadConfig({});
    const buckets = c.toolRateLimits.map((l) => l.bucket);
    for (const b of [
      'get_traffic_flow',
      'nominatim',
      'flights_near',
      'aircraft_lookup',
      'weather_alerts',
      'air_quality',
      'road_closures',
      'geocode_place',
      'border_wait_times',
      'dpd_calls_near',
      'transit_vehicles_near',
      'local_headlines',
    ])
      expect(buckets).toContain(b);
    const keys = c.toolRateLimits.map(key);
    expect(new Set(keys).size).toBe(keys.length);
    // An operator entry replaces every window of that bucket's family default.
    const own = loadConfig({
      TOOL_RATE_LIMITS: 'local_headlines=5/h,flights_near=1/h,road_closures=2/h,weather_alerts=3/h',
    }).toolRateLimits;
    for (const [b, limit] of [
      ['local_headlines', 5],
      ['flights_near', 1],
      ['road_closures', 2],
      ['weather_alerts', 3],
    ] as const)
      expect(own.filter((l) => l.bucket === b)).toEqual([
        { bucket: b, limit, windowMs: 3_600_000 },
      ]);
    // A bucket two families both name keeps the first family's default only.
    const shared = loadConfig({
      AVIATION_RATE_LIMITS: 'shared_bucket=4/h',
      CIVIC_TOOL_RATE_LIMITS: 'shared_bucket=9/h,shared_bucket=90/d',
    }).toolRateLimits;
    expect(shared.filter((l) => l.bucket === 'shared_bucket')).toEqual([
      { bucket: 'shared_bucket', limit: 4, windowMs: 3_600_000 },
    ]);
    for (const k of [
      'AVIATION_RATE_LIMITS',
      'WEATHER_TOOL_RATE_LIMITS',
      'ROADS_TOOL_RATE_LIMITS',
      'CIVIC_TOOL_RATE_LIMITS',
    ])
      expect(() => loadConfig({ [k]: 'nonsense' })).toThrow(new RegExp(k));
  });
});

describe('log sanitizer', () => {
  it('rounds coordinates and redacts secrets', () => {
    const out = sanitize({
      lat: 42.331412,
      lon: -83.045834,
      nested: { latitude: 42.28081, access_token: 'gat_abcdefghijklmnop', ok: 1 },
      authorization: 'Bearer xyz',
      note: 'used token gat_ABCDEFGH12345678 here',
    }) as {
      lat: number;
      lon: number;
      nested: Record<string, unknown>;
      authorization: string;
      note: string;
    };
    expect(out.lat).toBe(42.33);
    expect(out.lon).toBe(-83.05);
    expect(out.nested.latitude).toBe(42.28);
    expect(out.nested.access_token).toBe('[redacted]');
    expect(out.authorization).toBe('[redacted]');
    expect(out.note).not.toContain('gat_ABCDEFGH12345678');
  });

  it('emits JSON lines', () => {
    const lines: string[] = [];
    const log = createLogger({ sink: (l) => lines.push(l), level: 'info' });
    log.debug('hidden');
    log.info('shown', { lat: 1.23456 });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: 'info', event: 'shown', lat: 1.23 });
  });
});
