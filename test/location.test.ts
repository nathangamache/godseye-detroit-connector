import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { deviceTokenFrom, parseLocation } from '../src/location/routes.js';
import { LocationStore } from '../src/location/store.js';
import { createLogger } from '../src/log.js';
import { whereAmI } from '../src/mcp/whatsHappening.js';
import { ANN_ARBOR, PLYMOUTH } from './helpers.js';
import {
  passwordLogin,
  startPasswordGateway,
  type Jar,
  type TestGateway,
} from './oauth-helpers.js';

const NOW = Date.parse('2026-11-14T12:00:00Z');

describe('payload parsing', () => {
  it('accepts OwnTracks location messages', () => {
    const fix = parseLocation(
      {
        _type: 'location',
        lat: PLYMOUTH.lat,
        lon: PLYMOUTH.lon,
        acc: 8,
        tst: NOW / 1000 - 5,
        batt: 77,
        vel: 42,
        tid: 'np',
      },
      NOW,
    );
    expect(fix).toEqual({
      lat: PLYMOUTH.lat,
      lon: PLYMOUTH.lon,
      accuracyM: 8,
      fixTs: NOW - 5000,
      battery: 77,
      speedKmh: 42,
      source: 'owntracks',
    });
  });

  it('ignores other OwnTracks message types', () => {
    expect(parseLocation({ _type: 'transition', event: 'enter' }, NOW)).toBeNull();
    expect(parseLocation({ _type: 'lwt', tst: 1 }, NOW)).toBeNull();
  });

  it('accepts the PWA format with ms or s timestamps', () => {
    expect(
      parseLocation(
        { lat: ANN_ARBOR.lat, lon: ANN_ARBOR.lon, accuracy: 15, timestamp: NOW - 1000 },
        NOW,
      ),
    ).toMatchObject({ fixTs: NOW - 1000, accuracyM: 15, source: 'pwa' });
    expect(
      parseLocation({ lat: ANN_ARBOR.lat, lon: ANN_ARBOR.lon, timestamp: NOW / 1000 }, NOW),
    ).toMatchObject({ fixTs: NOW });
  });

  it('validates ranges', () => {
    expect(parseLocation({ lat: 91, lon: 0 }, NOW)).toMatch(/out of range/);
    expect(parseLocation({ lat: 'x', lon: 0 }, NOW)).toMatch(/lat\/lon/);
    expect(parseLocation({ lat: 1, lon: 1, accuracy: -2 }, NOW)).toMatch(/accuracy/);
    expect(parseLocation({ _type: 'location', lat: 1, lon: 1 }, NOW)).toMatch(/tst/);
    expect(
      parseLocation({ _type: 'location', lat: 1, lon: 1, tst: NOW / 1000 - 30 * 86400 }, NOW),
    ).toMatch(/timestamp/);
    expect(parseLocation([1, 2], NOW)).toMatch(/object/);
  });

  it('reads Bearer and Basic device credentials', () => {
    const mk = (authorization?: string) => ({ headers: { authorization } }) as never;
    expect(deviceTokenFrom(mk('Bearer gdt_abc'))).toBe('gdt_abc');
    expect(deviceTokenFrom(mk(`Basic ${Buffer.from('np:gdt_xyz').toString('base64')}`))).toBe(
      'gdt_xyz',
    );
    expect(deviceTokenFrom(mk())).toBeUndefined();
  });
});

describe('store, retention and where_am_i', () => {
  it('returns only the latest fix, flags staleness and prunes old fixes', () => {
    let now = NOW;
    const db = openDb(':memory:');
    const store = new LocationStore(db, { retentionHours: 24 }, () => now);
    const dev = store.createDevice('phone');
    store.insert({
      deviceId: dev.id,
      lat: ANN_ARBOR.lat,
      lon: ANN_ARBOR.lon,
      fixTs: NOW - 25 * 3600_000,
      source: 'pwa',
    });
    expect(store.latest()).toBeUndefined();
    store.insert({
      deviceId: dev.id,
      lat: PLYMOUTH.lat,
      lon: PLYMOUTH.lon,
      accuracyM: 20,
      fixTs: NOW - 15 * 60_000,
      source: 'owntracks',
    });
    const config = loadConfig({});
    const r = whereAmI(store, config, now);
    const data = JSON.parse(r.content[1]!.text!);
    expect(data).toMatchObject({
      found: true,
      lat: PLYMOUTH.lat,
      lon: PLYMOUTH.lon,
      accuracy_m: 20,
      age_s: 900,
      stale: true,
      device: 'phone',
    });
    expect(r.content[0]!.text).toMatch(/STALE/);
    expect(store.prune()).toBe(1);
    now += 24 * 3600_000;
    expect(store.prune()).toBe(1);
    expect(store.latest()).toBeUndefined();
  });

  it('revoked devices disappear from where_am_i', () => {
    const db = openDb(':memory:');
    const store = new LocationStore(db, { retentionHours: 24 }, () => NOW);
    const dev = store.createDevice('phone');
    store.insert({
      deviceId: dev.id,
      lat: PLYMOUTH.lat,
      lon: PLYMOUTH.lon,
      fixTs: NOW,
      source: 'pwa',
    });
    expect(store.latest()).toBeDefined();
    store.revokeDevice('phone');
    expect(store.latest()).toBeUndefined();
    expect(store.verifyDeviceToken(dev.token)).toBeNull();
  });
});

describe('HTTP ingest and /locate', () => {
  let t: TestGateway;
  let jar: Jar;
  let token: string;
  const lines: string[] = [];

  beforeAll(async () => {
    t = await startPasswordGateway(
      {},
      {},
      createLogger({ level: 'debug', sink: (l) => lines.push(l) }),
    );
    jar = await passwordLogin(t);
    token = t.gw.locations.createDevice('iphone').token;
  });
  afterAll(async () => t?.close());

  const post = (
    body: unknown,
    auth?: string,
    extra: Record<string, string> = {},
    base = t.origin,
  ) =>
    fetch(`${base}/api/location`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(auth ? { authorization: auth } : {}),
        ...extra,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  it('stores an OwnTracks fix (Basic auth) and answers []', async () => {
    const r = await post(
      {
        _type: 'location',
        lat: PLYMOUTH.lat,
        lon: PLYMOUTH.lon,
        acc: 9,
        tst: Math.floor(Date.now() / 1000),
      },
      `Basic ${Buffer.from(`iphone:${token}`).toString('base64')}`,
    );
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('[]');
    expect(t.gw.locations.latest()).toMatchObject({
      lat: PLYMOUTH.lat,
      lon: PLYMOUTH.lon,
      accuracy_m: 9,
      source: 'owntracks',
      device: 'iphone',
    });
  });

  it('stores a PWA fix (Bearer) posted same-origin on the private listener', async () => {
    const r = await post(
      { lat: ANN_ARBOR.lat, lon: ANN_ARBOR.lon, accuracy: 30, timestamp: Date.now() },
      `Bearer ${token}`,
      {},
      t.privateOrigin,
    );
    expect(r.status).toBe(200);
    expect(t.gw.locations.latest()).toMatchObject({ lat: ANN_ARBOR.lat, source: 'pwa' });
  });

  it('rejects missing/invalid tokens, bad payloads and oversized bodies', async () => {
    const none = await post({ lat: 1, lon: 1 });
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toMatch(/^Basic realm=/);
    expect((await post({ lat: 1, lon: 1 }, 'Bearer gdt_notarealtokenatallxxxxxxxx')).status).toBe(
      401,
    );
    expect((await post({ lat: 100, lon: 1 }, `Bearer ${token}`)).status).toBe(400);
    expect((await post('{"lat":' + '1'.repeat(20_000) + '}', `Bearer ${token}`)).status).toBe(413);
  });

  it('never logs full coordinates or tokens', () => {
    const all = lines.join('\n');
    expect(all).toMatch(/location_fix/);
    expect(all).not.toContain('42.3714');
    expect(all).not.toContain('-83.4702');
    expect(all).not.toContain(token);
  });

  it('/locate requires login and is served with a strict CSP', async () => {
    const anon = await fetch(`${t.privateOrigin}/locate/`, { redirect: 'manual' });
    expect(anon.status).toBe(302);
    expect((await fetch(`${t.origin}/locate/`, { headers: { cookie: jar.header() } })).status).toBe(
      404,
    ); // never on the public listener
    const r = await fetch(`${t.privateOrigin}/locate/`, { headers: { cookie: jar.header() } });
    expect(r.status).toBe(200);
    expect(await r.text()).toMatch(/Update My Location/);
    expect(r.headers.get('content-security-policy')).toMatch(/script-src 'self'/);
    expect(r.headers.get('permissions-policy')).toMatch(/geolocation=\(self\)/);
    const sw = await fetch(`${t.privateOrigin}/locate/sw.js`, {
      headers: { cookie: jar.header() },
    });
    expect(sw.status).toBe(200);
  });

  it('one-time setup code claim', async () => {
    const { code } = t.gw.locations.createSetupCode('ipad');
    const claim = (headers: Record<string, string>, cookie = jar.header()) =>
      fetch(`${t.privateOrigin}/locate/claim`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: t.privateOrigin,
          cookie,
          ...headers,
        },
        body: JSON.stringify({ code }),
      });
    expect((await claim({ 'x-requested-with': 'godseye-locate' }, '')).status).toBe(403); // not logged in
    expect((await claim({})).status).toBe(403); // missing CSRF header
    const ok = await claim({ 'x-requested-with': 'godseye-locate' });
    expect(ok.status).toBe(200);
    const { device_token } = (await ok.json()) as { device_token: string };
    expect(device_token).toMatch(/^gdt_/);
    expect((await claim({ 'x-requested-with': 'godseye-locate' })).status).toBe(400); // single use
    expect(
      (await post({ lat: PLYMOUTH.lat, lon: PLYMOUTH.lon }, `Bearer ${device_token}`)).status,
    ).toBe(200);
  });
});
