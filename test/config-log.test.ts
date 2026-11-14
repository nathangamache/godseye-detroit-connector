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
