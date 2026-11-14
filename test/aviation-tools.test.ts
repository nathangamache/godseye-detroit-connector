/**
 * flights_near and aircraft_lookup through the real run_tool pipeline (schema validation,
 * policy, rate limits, post-processing), with a synthetic FAA copy and mocked HTTP:
 *  - the exact position never leaves the gateway (snapped centre, enlarged radius) and is never
 *    logged; distances come from the exact point;
 *  - `here` reads the phone fix like where_am_i and is audited the same way;
 *  - owner disclosure: government by name, companies by name only in a single lookup, private
 *    owners as "private individual" + city/state, never street or ZIP, LADD withholding, FAA
 *    blanks never filled (not from DEREG, not from adsb.fi's ownOp);
 *  - lookup order and the non-US / military answers; attribution in every result;
 *  - the aviation tools are listed by find_tools under "aviation".
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Audit } from '../src/audit.js';
import { loadConfig, type Config } from '../src/config.js';
import { openDb, type DB } from '../src/db.js';
import { registerAviation, type AviationHandle } from '../src/extra/aviation/index.js';
import { globeLink } from '../src/extra/aviation/links.js';
import { Upstreams } from '../src/extra/aviation/live.js';
import { nNumberToIcao, toHex } from '../src/extra/aviation/nnumber.js';
import { REGISTRY_FILE } from '../src/extra/aviation/registry-store.js';
import { importRegistryZip } from '../src/extra/aviation/registry-sync.js';
import { coarsenQuery } from '../src/extra/aviation/tools.js';
import { startGateway, type Gateway } from '../src/gateway.js';
import { LocationStore } from '../src/location/store.js';
import { createLogger, nullLogger } from '../src/log.js';
import { TokenStore } from '../src/oauth/tokens.js';
import { ToolPolicy } from '../src/tools/policy.js';
import type { McpToolResult } from '../src/tools/postprocess.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { ToolRunner } from '../src/tools/runner.js';
import { haversineM } from '../src/util/geo.js';
import {
  FAKE_FLEET,
  SECRET_STREET,
  SECRET_ZIP,
  fakeRegistryZip,
  json,
  scriptedFetch,
  type Responder,
} from './fixtures/aviation.js';
import { BELLE_ISLE, DETROIT, HAVE_REAL_GEV, REAL_GEV_ROOT } from './helpers.js';

const LINK_ORIGIN = 'https://globe.example-tailnet.ts.net:8443';
const hexOf = (n: string) => toHex(nNumberToIcao(n)!).toLowerCase();

/** Aircraft positions offset from a point by metres north/east. */
function offset(p: { lat: number; lon: number }, northM: number, eastM: number) {
  return {
    lat: p.lat + northM / 111_195,
    lon: p.lon + eastM / (111_195 * Math.cos((p.lat * Math.PI) / 180)),
  };
}

/** Aircraft around the downtown Detroit test point (a public landmark). */
function feedAround(p: { lat: number; lon: number }) {
  const at = (n: number, e: number) => offset(p, n, e);
  return {
    now: Date.now(),
    ac: [
      {
        hex: hexOf('N202SP'),
        flight: 'SHERIFF1',
        r: 'N202SP',
        t: 'B407',
        type: 'adsb_icao',
        alt_baro: 900,
        gs: 70,
        track: 90,
        ...at(800, 0),
        seen: 0.5,
        seen_pos: 0.9,
        category: 'A7',
      },
      {
        hex: hexOf('N101AA'),
        r: 'N101AA',
        t: 'C172',
        desc: 'CESSNA 172 SKYHAWK',
        type: 'mlat',
        alt_baro: 2500,
        ...at(0, 3000),
        ownOp: 'PRIVATE EXAMPLE PERSON',
      },
      {
        hex: hexOf('N303CC'),
        r: 'N303CC',
        t: 'C172',
        alt_baro: 'ground',
        ...at(-1500, 0),
        ownOp: 'EXAMPLE CHARTER CORP',
      },
      { hex: hexOf('N404LL'), r: 'N404LL', t: 'C172', alt_baro: 4000, dbFlags: 8, ...at(0, -2000) },
      {
        hex: hexOf('N505WH'),
        r: 'N505WH',
        t: 'C172',
        alt_baro: 3000,
        ...at(2000, 2000),
        ownOp: 'WITHHELD OWNER LEAK',
      },
      { hex: 'a12345', t: 'GLF5', alt_baro: 41000, dbFlags: 4, ...at(-3000, -3000) },
      { hex: 'ae1234', flight: 'RCH123', t: 'C17', alt_baro: 12000, dbFlags: 1, ...at(4000, 0) },
      { hex: '~2abcde', type: 'tisb_trackfile', alt_baro: 1500, ...at(0, 4500) },
      {
        hex: 'c01234',
        r: 'C-GABC',
        t: 'DH8D',
        desc: 'DE HAVILLAND DHC-8-400',
        alt_baro: 9000,
        ...at(5000, 5000),
      },
      // 30 km away: inside the enlarged query radius, outside the 5 nm the user asked for.
      { hex: hexOf('N707AL'), r: 'N707AL', t: 'B738', alt_baro: 20000, ...at(30_000, 0) },
      { hex: 'a54321', alt_baro: 5000 },
    ],
  };
}

interface Harness {
  config: Config;
  db: DB;
  runner: ToolRunner;
  aviation: AviationHandle;
  locations: LocationStore;
  audit: Audit;
  tokens: TokenStore;
  fetch: ReturnType<typeof scriptedFetch>;
  logs: string[];
  run(
    name: string,
    args: Record<string, unknown>,
    ctx?: Record<string, string>,
  ): Promise<McpToolResult>;
}

let dir: string;
async function harness(
  respond: Responder,
  env: Record<string, string> = {},
  opts: { registry?: boolean } = {},
): Promise<Harness> {
  const config = loadConfig({
    GATEWAY_MODE: 'test',
    DATA_DIR: dir,
    LINK_ORIGIN,
    PULSE_URL: 'http://127.0.0.1:9',
    ...env,
  });
  const db = openDb(':memory:');
  const logs: string[] = [];
  const logger = createLogger({ level: 'debug', sink: (l) => logs.push(l) });
  const locations = new LocationStore(db, { retentionHours: 24 });
  const audit = new Audit(db, logger);
  const tokens = new TokenStore(db, {
    accessTtlS: 3600,
    refreshTtlS: 86_400,
    codeTtlS: 60,
    reuseGraceS: 0,
  });
  const registry = new ToolRegistry(new ToolPolicy(config));
  const runner = new ToolRunner(registry, {
    timeoutMs: 20_000,
    maxConcurrent: 4,
    logger,
    post: {
      publicOrigin: config.linkOrigin,
      gevOrigins: config.gevApiOrigins,
      maxResultChars: config.MAX_RESULT_CHARS,
      imageMaxDim: 64,
      imageMaxBase64Chars: 1000,
      maxImages: 0,
    },
  });
  const f = scriptedFetch(respond);
  const aviation = registerAviation(registry, {
    config,
    locations,
    audit,
    tokens,
    logger,
    fetch: f,
    upstreams: new Upstreams({ intervalMs: 0 }),
  });
  if (opts.registry !== false) {
    mkdirSync(aviation.dir, { recursive: true });
    const zip = path.join(dir, 'fleet.zip');
    writeFileSync(zip, fakeRegistryZip());
    await importRegistryZip(zip, path.join(aviation.dir, REGISTRY_FILE), {
      storePrivateNames: config.AIRCRAFT_OWNER_DISCLOSURE === 'full',
      minRows: 1,
    });
    aviation.store.refresh(true);
  }
  return {
    config,
    db,
    runner,
    aviation,
    locations,
    audit,
    tokens,
    fetch: f,
    logs,
    run: (name, args, ctx = {}) =>
      runner.run(name, args, { signal: new AbortController().signal, ...ctx }),
  };
}

const text = (r: McpToolResult) => r.content.map((c) => c.text ?? '').join('\n');
/** Parsed tool JSON, loosely typed on purpose: the assertions check its shape. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;
const data = (r: McpToolResult) => JSON.parse(r.content[1]!.text!) as Loose;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'gw-aviation-tools-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('flights_near', () => {
  const live: Responder = (url) =>
    url.includes('/v2/hex/') ? json({ ac: [] }) : json(feedAround(DETROIT));

  it('never sends the exact position: a 0.05 degree grid point and a 3 nm larger radius', async () => {
    const h = await harness(live);
    const r = await h.run('flights_near', { lat: DETROIT.lat, lon: DETROIT.lon, radius_nm: 5 });
    expect(r.isError).toBeUndefined();
    expect(h.fetch.calls).toHaveLength(1);
    const url = h.fetch.calls[0]!.url;
    expect(url).toBe('https://opendata.adsb.fi/api/v3/lat/42.35/lon/-83.05/dist/8');
    expect(url).not.toContain('42.3314');
    expect(url).not.toContain('83.0458');
    // The snap never moves the centre further than the padding covers.
    for (const p of [
      DETROIT,
      BELLE_ISLE,
      { lat: 42.374999, lon: -83.024999 },
      { lat: 0.025, lon: 179.99 },
    ]) {
      const q = coarsenQuery(p, 5);
      expect(haversineM(p.lat, p.lon, q.center.lat, q.center.lon) / 1852).toBeLessThan(3);
      expect(q.radiusNm).toBe(8);
    }
    // Neither the position nor the aircraft are logged.
    for (const l of h.logs) expect(l).not.toMatch(/42\.33|83\.04|SHERIFF1/);
  });

  it('measures from the exact point, filters to the radius and decodes flags', async () => {
    const h = await harness(live);
    const r = await h.run('flights_near', { lat: DETROIT.lat, lon: DETROIT.lon });
    const d = data(r);
    const rows = d.aircraft as Loose[];
    expect(d.source).toBe('adsb.fi');
    expect(rows.map((x) => x.registration ?? x.hex)).not.toContain('N707AL');
    expect(rows.find((x) => x.hex === 'a54321')).toBeUndefined();
    const first = rows[0]!;
    expect(first).toMatchObject({
      callsign: 'SHERIFF1',
      registration: 'N202SP',
      type: 'B407',
      type_name: 'BELL 407',
      type_name_source: 'faa',
      category_label: 'rotorcraft (helicopter)',
      altitude_ft: 900,
      compass: 'N',
      position_source: 'adsb_icao',
      flags: { military: false, ladd: false, pia: false },
    });
    expect(first.distance_nm).toBeCloseTo(800 / 1852, 1);
    expect(first.bearing_deg === 0 || first.bearing_deg === 359).toBe(true);
    // The globe link is centred on the aircraft, not on the user.
    const sheriff = offset(DETROIT, 800, 0);
    expect(first.map_url).toBe(globeLink(LINK_ORIGIN, sheriff.lat, sheriff.lon));
    expect(first.map_url).toMatch(/^https:\/\/globe\.example-tailnet\.ts\.net:8443\/#v=2&lat=/);
    expect(first.map_url).not.toMatch(/follow|layers|flights/);
    const ground = rows.find((x) => x.registration === 'N303CC')!;
    expect(ground.altitude_ft).toBe('ground');
    expect(rows.find((x) => x.hex === 'ae1234')).toMatchObject({
      flags: { military: true },
      registry: { note: expect.stringMatching(/military/) },
    });
    expect(rows.find((x) => x.hex === 'a12345')).toMatchObject({
      flags: { pia: true },
      registry: { note: expect.stringMatching(/PIA/) },
    });
    expect(rows.find((x) => x.hex === '~2abcde')).toMatchObject({ non_icao: true });
    expect(rows.find((x) => x.hex === '~2abcde')!.registry).toBeUndefined();
    expect(rows.find((x) => x.hex === 'c01234')).toMatchObject({
      type_name: 'DE HAVILLAND DHC-8-400',
      type_name_source: 'adsb.fi',
    });
    expect(rows.find((x) => x.registration === 'N101AA')).toMatchObject({
      position_source: 'mlat',
      type_name: 'CESSNA 172S',
    });
    // Sorted nearest first.
    const dists = rows.map((x) => x.distance_nm as number);
    expect([...dists].sort((a, b) => a - b)).toEqual(dists);
    expect(text(r)).toMatch(/Attribution: Live aircraft: adsb\.fi \(https:\/\/adsb\.fi\)/);
    expect(d.attribution).toMatch(
      /adsb\.fi \(https:\/\/adsb\.fi\); FAA Releasable Aircraft Database/,
    );
  });

  it('shows registrant type, city and state; names only for government; never ownOp', async () => {
    const h = await harness(live);
    const r = await h.run('flights_near', { lat: DETROIT.lat, lon: DETROIT.lon });
    const rows = data(r).aircraft as Loose[];
    const reg = (n: string) => rows.find((x) => x.registration === n)!.registry;
    expect(reg('N202SP')).toMatchObject({
      n_number: 'N202SP',
      registrant_type: 'government',
      owner: 'EXAMPLE COUNTY SHERIFF OFFICE',
      government: true,
      law_enforcement_hint: true,
    });
    expect(reg('N101AA')).toEqual({
      n_number: 'N101AA',
      registrant_type: 'individual',
      owner: 'private individual',
      city: 'LANSING',
      state: 'MI',
    });
    expect(reg('N303CC')).toMatchObject({
      registrant_type: 'corporation',
      owner: 'corporation',
      city: 'GRAND RAPIDS',
    });
    expect(reg('N505WH')).toMatchObject({ owner_withheld_by_faa: true });
    expect(reg('N505WH').owner).toBeUndefined();
    const all = text(r);
    for (const leak of [
      'PRIVATE EXAMPLE PERSON',
      'EXAMPLE CHARTER CORP',
      'WITHHELD OWNER LEAK',
      SECRET_STREET,
      SECRET_ZIP,
      'DEREG EXAMPLE',
    ])
      expect(all).not.toContain(leak);
    expect(all).toMatch(/GOVERNMENT-REGISTERED: EXAMPLE COUNTY SHERIFF OFFICE/);
  });

  it('uses the phone fix with here: true and audits it like where_am_i', async () => {
    const h = await harness(live);
    const { familyId } = h.tokens.issue({
      clientId: 'c1',
      subject: 'owner',
      scope: 'mcp',
      resource: 'r',
    });
    const none = await h.run('flights_near', { here: true }, { clientId: 'c1', familyId });
    expect(none.isError).toBe(true);
    expect(text(none)).toMatch(/No phone location fix/);
    const dev = h.locations.createDevice('phone');
    h.locations.insert({
      deviceId: dev.id,
      ...DETROIT,
      accuracyM: 9,
      fixTs: Date.now() - 30_000,
      source: 'api',
    });
    const r = await h.run(
      'flights_near',
      { here: true, radius_nm: 3 },
      { clientId: 'c1', familyId },
    );
    expect(r.isError).toBeUndefined();
    const d = data(r);
    expect(d.query).toMatchObject({ point: 'phone fix', fix_stale: false, radius_nm: 3 });
    expect(JSON.stringify(d.query)).not.toMatch(/42\.33|83\.04/);
    expect(text(r)).toMatch(/the phone's latest fix \(30 s old, ±9 m\)/);
    expect(h.fetch.calls.at(-1)!.url).toBe(
      'https://opendata.adsb.fi/api/v3/lat/42.35/lon/-83.05/dist/6',
    );
    const reads = h.audit.recent(10, 'access');
    expect(reads.map((x) => JSON.parse(x.detail!))).toEqual([
      { family: familyId, tool: 'flights_near', fix: true },
      { family: familyId, tool: 'flights_near', fix: false },
    ]);
    for (const x of reads) expect(x.detail).not.toMatch(/42\.3|83\.0/);
    expect(h.tokens.listFamilies().find((f) => f.family_id === familyId)!.location_reads).toBe(2);
  });

  it('validates arguments before anything is sent', async () => {
    const h = await harness(live);
    for (const bad of [
      {},
      { lat: 42.3 },
      { lat: 42.3, lon: -83, here: true },
      { lat: 91, lon: 0 },
      { lat: 42.3, lon: -83, radius_nm: 26 },
      { lat: 42.3, lon: -83, radius_nm: 0.5 },
      { lat: 42.3, lon: -83, max: 0 },
      { lat: 42.3, lon: -83, extra: 1 },
    ]) {
      const r = await h.run('flights_near', bad);
      expect(r.isError).toBe(true);
    }
    expect(h.fetch.calls).toHaveLength(0);
  });

  it('reports the fallback, and fails cleanly with no data', async () => {
    const fb = await harness((url) =>
      url.includes('adsb.fi') ? json({}, 429) : json(feedAround(DETROIT)),
    );
    const r = await fb.run('flights_near', { lat: DETROIT.lat, lon: DETROIT.lon });
    expect(data(r)).toMatchObject({
      source: 'adsb.lol',
      fallback_reason: expect.stringMatching(/429/),
    });
    expect(data(r).attribution).toMatch(/adsb\.lol \(https:\/\/adsb\.lol\), ODbL 1\.0/);
    expect(fb.fetch.calls.at(-1)!.url).toBe('https://api.adsb.lol/v2/point/42.35/-83.05/8');
    const down = await harness(() => json({}, 404));
    const e = await down.run('flights_near', { lat: DETROIT.lat, lon: DETROIT.lon });
    expect(e.isError).toBe(true);
    expect(text(e)).toMatch(/not retried/);
    expect(down.fetch.calls).toHaveLength(1);
  });

  it('works before the first registry sync, and rate limits through the policy', async () => {
    const h = await harness(
      live,
      { AVIATION_RATE_LIMITS: 'flights_near=2/h' },
      { registry: false },
    );
    const r = await h.run('flights_near', { lat: DETROIT.lat, lon: DETROIT.lon });
    expect(r.isError).toBeUndefined();
    expect(data(r).registry).toMatchObject({ available: false });
    expect(data(r).aircraft[0].registry).toBeUndefined();
    await h.run('flights_near', { lat: DETROIT.lat, lon: DETROIT.lon });
    const limited = await h.run('flights_near', { lat: DETROIT.lat, lon: DETROIT.lon });
    expect(text(limited)).toMatch(/Rate limit reached for flights_near/);
    // TOOL_RATE_LIMITS wins for a bucket it names.
    const own = await harness(
      live,
      { TOOL_RATE_LIMITS: 'flights_near=1/h', AVIATION_RATE_LIMITS: 'flights_near=50/h' },
      { registry: false },
    );
    await own.run('flights_near', { lat: DETROIT.lat, lon: DETROIT.lon });
    expect(text(await own.run('flights_near', { lat: DETROIT.lat, lon: DETROIT.lon }))).toMatch(
      /Rate limit/,
    );
  });
});

describe('aircraft_lookup', () => {
  const liveNone: Responder = (url) =>
    url.includes('/v2/ladd') ? json({ ac: [] }) : json({ ac: [] });

  it('finds a record by hex and by N-number, with the registry date and FAA credit', async () => {
    const h = await harness(liveNone);
    const r = await h.run('aircraft_lookup', { hex: hexOf('N202SP').toUpperCase() });
    const d = data(r);
    expect(d.match).toBe('mode_s_hex');
    expect(d.aircraft).toMatchObject({
      n_number: 'N202SP',
      mode_s_hex: hexOf('N202SP').toUpperCase(),
      manufacturer: 'BELL',
      model: '407',
      aircraft_type: 'rotorcraft',
      year_manufactured: 2005,
      registrant: {
        registrant_type: 'government',
        owner: 'EXAMPLE COUNTY SHERIFF OFFICE',
        government: true,
        law_enforcement_hint: true,
      },
      status: { code: 'V', label: 'valid registration' },
      airworthiness: { class: 'restricted', operations: ['patrolling'], date: '2005-05-06' },
      certificate_issued: '2019-06-10',
      registration_expires: '2031-06-30',
    });
    expect(d.registry).toMatchObject({
      name: 'FAA Releasable Aircraft Database',
      as_of: '2026-11-13',
    });
    expect(text(r)).toMatch(/GOVERNMENT-REGISTERED/);
    expect(text(r)).toMatch(/Attribution: FAA Releasable Aircraft Database/);
    expect(text(r)).toMatch(/FAA registry as of 2026-11-13/);
    const byN = data(await h.run('aircraft_lookup', { registration: 'n303cc' }));
    expect(byN).toMatchObject({
      match: 'n_number',
      aircraft: {
        n_number: 'N303CC',
        registrant: { owner: 'EXAMPLE CHARTER CORP', city: 'GRAND RAPIDS', state: 'MI' },
      },
    });
    expect(byN.algorithm).toEqual({ n_number: 'N303CC', hex: hexOf('N303CC').toUpperCase() });
    // No Mode S code in the file at all: found through the N-number algorithm.
    const algo = data(await h.run('aircraft_lookup', { hex: hexOf('N919NM') }));
    expect(algo).toMatchObject({
      match: 'n_number_from_algorithm',
      aircraft: { n_number: 'N919NM' },
    });
  });

  it('applies the owner rules: private, blank, drones, never street or ZIP', async () => {
    const h = await harness(liveNone);
    const priv = await h.run('aircraft_lookup', { registration: 'N101AA' });
    expect(data(priv).aircraft.registrant).toMatchObject({
      owner: 'private individual',
      owner_is_name: false,
      city: 'LANSING',
      state: 'MI',
      withheld: 'policy',
    });
    const co = await h.run('aircraft_lookup', { registration: 'N606CW' });
    expect(data(co).aircraft.registrant.owner).toBe('private owners (co-owned)');
    const blank = await h.run('aircraft_lookup', { registration: 'N505WH' });
    expect(data(blank).aircraft.registrant).toMatchObject({
      withheld: 'faa_blank',
      owner_is_name: false,
    });
    expect(data(blank).aircraft.registrant.owner).toBeUndefined();
    expect(text(blank)).toMatch(/44114\(b\)/);
    const drone = await h.run('aircraft_lookup', { registration: 'N808UA' });
    expect(data(drone).aircraft).toMatchObject({
      drone: true,
      weight_class: 'UAV (drone) up to 55 lb',
    });
    for (const r of [priv, co, blank, drone]) {
      const t = text(r);
      for (const leak of [
        'PRIVATE EXAMPLE PERSON',
        'COOWNED EXAMPLE PERSON',
        'COOWNER EXAMPLE',
        SECRET_STREET,
        SECRET_ZIP,
        'DEREG EXAMPLE PERSON',
      ])
        expect(t).not.toContain(leak);
    }
  });

  it('withholds non-government owner names for LADD aircraft (live flag or list)', async () => {
    const h = await harness((url) =>
      url.includes(`/v2/hex/${hexOf('N404LL')}`)
        ? json({
            ac: [{ hex: hexOf('N404LL'), dbFlags: 8, alt_baro: 4000, lat: 42.3, lon: -83.1 }],
          })
        : url.endsWith('/v2/ladd')
          ? json({ ac: [{ hex: hexOf('N303CC') }] })
          : json({ ac: [] }),
    );
    const live = data(await h.run('aircraft_lookup', { registration: 'N404LL' }));
    expect(live.aircraft.registrant).toMatchObject({
      withheld: 'ladd',
      owner_is_name: false,
      city: 'DETROIT',
    });
    expect(live.ladd.flagged).toBe(true);
    expect(live.live).toMatchObject({
      tracked: true,
      flags: { ladd: true },
      map_url: expect.stringContaining(LINK_ORIGIN),
    });
    const listed = await h.run('aircraft_lookup', { registration: 'N303CC' });
    expect(data(listed).aircraft.registrant.withheld).toBe('ladd');
    expect(text(listed)).not.toContain('EXAMPLE CHARTER CORP');
    // Government registrants keep their name even on LADD.
    const gov = await harness((url) =>
      url.includes('/v2/hex/')
        ? json({ ac: [{ hex: hexOf('N202SP'), dbFlags: 8 }] })
        : json({ ac: [] }),
    );
    expect(
      data(await gov.run('aircraft_lookup', { registration: 'N202SP' })).aircraft.registrant.owner,
    ).toBe('EXAMPLE COUNTY SHERIFF OFFICE');
    // AIRCRAFT_LADD_WITHHOLD=false shows it.
    const off = await harness(
      (url) =>
        url.includes('/v2/hex/')
          ? json({ ac: [{ hex: hexOf('N404LL'), dbFlags: 8 }] })
          : json({ ac: [] }),
      { AIRCRAFT_LADD_WITHHOLD: 'false' },
    );
    expect(
      data(await off.run('aircraft_lookup', { registration: 'N404LL' })).aircraft.registrant.owner,
    ).toBe('EXAMPLE HOLDINGS LLC');
  });

  it('AIRCRAFT_OWNER_DISCLOSURE: type_only hides city/state; full names private owners', async () => {
    const t = await harness(liveNone, { AIRCRAFT_OWNER_DISCLOSURE: 'type_only' });
    const r = data(await t.run('aircraft_lookup', { registration: 'N101AA' })).aircraft.registrant;
    expect(r).toMatchObject({ owner: 'private individual' });
    expect(r.city).toBeUndefined();
    const full = await harness(
      (url) => (url.includes('/v3/') ? json(feedAround(DETROIT)) : json({ ac: [] })),
      { AIRCRAFT_OWNER_DISCLOSURE: 'full' },
    );
    expect(
      data(await full.run('aircraft_lookup', { registration: 'N101AA' })).aircraft.registrant,
    ).toMatchObject({
      owner: 'PRIVATE EXAMPLE PERSON',
      owner_is_name: true,
      city: 'LANSING',
    });
    // Lists still never name private owners.
    const list = await full.run('flights_near', { lat: DETROIT.lat, lon: DETROIT.lon });
    expect(data(list).aircraft.length).toBeGreaterThan(3);
    expect(text(list)).not.toContain('PRIVATE EXAMPLE PERSON');
  });

  it('answers for military, foreign, non-ICAO and unknown addresses without the registry', async () => {
    const h = await harness(liveNone);
    expect(text(await h.run('aircraft_lookup', { hex: 'ae1234' }))).toMatch(
      /US military\/federal address block .*no civil registry record/,
    );
    expect(text(await h.run('aircraft_lookup', { hex: 'c01234' }))).toMatch(
      /not a US registration.*Canada/,
    );
    expect(text(await h.run('aircraft_lookup', { registration: 'C-GABC' }))).toMatch(
      /not a US registration/,
    );
    expect(text(await h.run('aircraft_lookup', { hex: '~a1b2c3' }))).toMatch(/non-ICAO/);
    const unknown = await h.run('aircraft_lookup', { registration: 'N4321' });
    expect(text(unknown)).toMatch(/no FAA registry record.*unassigned, deregistered or reserved/);
    expect(data(unknown).algorithm).toEqual({
      n_number: 'N4321',
      hex: toHex(nNumberToIcao('N4321')!),
    });
    const bad = await h.run('aircraft_lookup', { registration: 'N12IO' });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/not a valid US N-number/);
    expect((await h.run('aircraft_lookup', { hex: 'a1b2c3', registration: 'N1' })).isError).toBe(
      true,
    );
    expect((await h.run('aircraft_lookup', { hex: 'xyz' })).isError).toBe(true);
    // Military/foreign/non-ICAO answers need no request at all.
    expect(h.fetch.calls.every((c) => !/ae1234|c01234/.test(c.url))).toBe(true);
  });

  it('gives the address arithmetic when no registry copy exists yet', async () => {
    const h = await harness(liveNone, {}, { registry: false });
    const r = await h.run('aircraft_lookup', { registration: 'N303CC' });
    expect(text(r)).toMatch(/not available yet/);
    expect(data(r).algorithm.hex).toBe(hexOf('N303CC').toUpperCase());
  });
});

describe('in the gateway', () => {
  let gw: Gateway;
  let gdir: string;
  const realFetch = globalThis.fetch;
  const outbound: string[] = [];

  beforeAll(async () => {
    gdir = mkdtempSync(path.join(tmpdir(), 'gw-aviation-e2e-'));
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith('http://127.0.0.1')) return realFetch(input, init);
      outbound.push(url);
      return Promise.resolve(json(feedAround(DETROIT)));
    });
    const config = loadConfig({
      GATEWAY_MODE: 'test',
      PORT: '0',
      PRIVATE_PORT: '0',
      UI_PORT: '0',
      DATA_DIR: gdir,
      LINK_ORIGIN,
      PULSE_URL: 'http://127.0.0.1:9',
    });
    gw = await startGateway(config, { logger: nullLogger, gevChild: false });
    const dev = gw.locations.createDevice('phone');
    gw.locations.insert({
      deviceId: dev.id,
      ...DETROIT,
      accuracyM: 8,
      fixTs: Date.now(),
      source: 'api',
    });
  });
  afterAll(async () => {
    await gw?.close();
    vi.unstubAllGlobals();
    rmSync(gdir, { recursive: true, force: true });
  });

  it('lists both tools under "aviation" and runs flights_near with here: true over MCP', async () => {
    expect(
      gw.registry
        .catalog('aviation')
        .map((e) => e.tool.name)
        .sort(),
    ).toEqual(['aircraft_lookup', 'flights_near']);
    expect(gw.registry.find('who owns that helicopter', 3).map((h) => h.tool.name)).toContain(
      'aircraft_lookup',
    );
    expect(gw.registry.find('what plane is flying over me', 3).map((h) => h.tool.name)).toContain(
      'flights_near',
    );
    const { tokens, familyId } = gw.tokens.issue({
      clientId: 'c-e2e',
      subject: 'owner',
      scope: 'mcp',
      resource: gw.config.mcpResource,
    });
    const c = new Client({ name: 't', version: '1' });
    await c.connect(
      new StreamableHTTPClientTransport(new URL(`${gw.url}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } },
      }),
    );
    try {
      const list = await c.callTool({ name: 'find_tools', arguments: { category: 'aviation' } });
      expect(JSON.stringify(list)).toMatch(/flights_near/);
      const r = (await c.callTool({
        name: 'run_tool',
        arguments: { name: 'flights_near', arguments: { here: true } },
      })) as McpToolResult;
      expect(r.isError).toBeFalsy();
      expect(text(r)).toMatch(/aircraft within 5 nm of the phone's latest fix/);
      expect(outbound).toEqual(['https://opendata.adsb.fi/api/v3/lat/42.35/lon/-83.05/dist/8']);
      const reads = gw.audit.recent(5, 'access').map((x) => JSON.parse(x.detail!));
      expect(reads[0]).toEqual({ family: familyId, tool: 'flights_near', fix: true });
    } finally {
      await c.close();
    }
  });
});

describe.skipIf(!HAVE_REAL_GEV)("globe links (real God's Eye View)", () => {
  it("match GEV's own share-link builder and decode to a camera with nothing followed", async () => {
    const view = (await import(
      pathToFileURL(path.join(REAL_GEV_ROOT, 'src/view/index.js')).href
    )) as {
      createView(v: unknown): unknown;
      viewUrl(base: string, v: unknown): string;
      viewFromParams(p: URLSearchParams): {
        camera: { lat: number; lon: number };
        follow: unknown;
        layers: unknown[];
      };
    };
    for (const p of [DETROIT, BELLE_ISLE, { lat: -33.8568, lon: 151.2153 }]) {
      const ours = globeLink(LINK_ORIGIN, p.lat, p.lon);
      expect(ours).toBe(
        view.viewUrl(
          LINK_ORIGIN,
          view.createView({ camera: { lat: p.lat, lon: p.lon, altitude_m: 6000 } }),
        ),
      );
      const back = view.viewFromParams(new URLSearchParams(new URL(ours).hash.slice(1)));
      expect(back.follow).toBeNull();
      expect(back.layers).toEqual([]);
      expect(back.camera.lat).toBeCloseTo(p.lat, 3);
    }
  });
});

it('the fixture fleet is fictitious', () => {
  expect(FAKE_FLEET.every((a) => /EXAMPLE|^$/.test(a.name))).toBe(true);
});
