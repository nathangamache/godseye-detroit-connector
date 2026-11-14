/**
 * FAA registry copy: the N-number <-> ICAO address scheme, the ZIP reader, the importer
 * (what it keeps and, above all, what it never keeps) and the daily sync (conditional GET,
 * honest User-Agent, atomic swap, last good copy kept on every failure). No live requests.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nullLogger } from '../src/log.js';
import {
  US_CIVIL_FIRST,
  US_CIVIL_LAST,
  classifyIcao,
  icaoToNNumber,
  nNumberToIcao,
  normalizeNNumber,
  parseHex,
  toHex,
} from '../src/extra/aviation/nnumber.js';
import { RegistryStore } from '../src/extra/aviation/registry-store.js';
import {
  RegistrySync,
  importRegistryZip,
  msUntilUtc,
  parseFaaHeader,
  splitFaaLine,
} from '../src/extra/aviation/registry-sync.js';
import { openZipEntry, readZipEntries } from '../src/extra/aviation/zip.js';
import {
  FAKE_FLEET,
  SECRET_COOWNER,
  SECRET_STREET,
  SECRET_ZIP,
  fakeRegistryZip,
  makeZip,
  scriptedFetch,
} from './fixtures/aviation.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'gw-aviation-reg-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('N-number <-> ICAO address (US allocation scheme)', () => {
  it('maps the block boundaries and the first suffixes', () => {
    expect(toHex(US_CIVIL_FIRST)).toBe('A00001');
    expect(toHex(US_CIVIL_LAST)).toBe('ADF7C7');
    expect(icaoToNNumber(0xa00001)).toBe('N1');
    expect(icaoToNNumber(0xa00002)).toBe('N1A');
    expect(icaoToNNumber(0xa00003)).toBe('N1AA');
    expect(icaoToNNumber(0xa0001a)).toBe('N1AZ');
    expect(icaoToNNumber(0xa0001b)).toBe('N1B');
    // After N1's 601 suffix slots come N10, then its 601, then N100 ...
    expect(icaoToNNumber(0xa00001 + 601)).toBe('N10');
    expect(icaoToNNumber(0xa00001 + 1202)).toBe('N100');
    expect(icaoToNNumber(0xa00001 + 1803)).toBe('N1000');
    expect(icaoToNNumber(0xa00001 + 1804)).toBe('N1000A');
    expect(icaoToNNumber(0xa00001 + 1828)).toBe('N10000');
    expect(icaoToNNumber(0xa00001 + 101_711)).toBe('N2');
    expect(icaoToNNumber(US_CIVIL_LAST)).toBe('N99999');
    expect(icaoToNNumber(US_CIVIL_LAST + 1)).toBeNull();
    expect(icaoToNNumber(0xa00000)).toBeNull();
    expect(nNumberToIcao('N99999')).toBe(US_CIVIL_LAST);
    expect(nNumberToIcao('n1000a')).toBe(0xa00001 + 1804);
  });

  it('round-trips every civil address and never produces I or O', () => {
    for (let i = US_CIVIL_FIRST; i <= US_CIVIL_LAST; i++) {
      const n = icaoToNNumber(i)!;
      if (nNumberToIcao(n) !== i || /[IO]/.test(n.slice(1))) throw new Error(`mismatch at ${i}`);
    }
  });

  it('applies the FAA N-number rules', () => {
    for (const ok of ['N1', 'N12345', 'N1234Z', 'N123AB', 'n 12-ab'])
      expect(normalizeNNumber(ok)).not.toBeNull();
    for (const bad of ['N0123', 'N123456', 'N12345A', 'N1234AB', 'N12I', 'N1O', 'NABC', 'N'])
      expect(normalizeNNumber(bad)).toBeNull();
    expect(nNumberToIcao('C-GABC')).toBeNull();
  });

  it('classifies address blocks', () => {
    expect(classifyIcao(0xa1b2c3).kind).toBe('us_civil');
    expect(classifyIcao(0xadf7c8).kind).toBe('us_military_federal');
    expect(classifyIcao(0xafffff).kind).toBe('us_military_federal');
    expect(classifyIcao(0xa00000).kind).toBe('us_unassigned');
    expect(classifyIcao(0xc01234)).toEqual({ kind: 'foreign', country: 'Canada' });
    expect(classifyIcao(0x0d0001)).toEqual({ kind: 'foreign', country: 'Mexico' });
    expect(classifyIcao(0x400000)).toEqual({ kind: 'foreign' });
    expect(parseHex('~A1B2C3')).toEqual({ icao: 0xa1b2c3, hex: 'A1B2C3', nonIcao: true });
    expect(parseHex('a1b2c')).toBeNull();
  });
});

describe('FAA file format', () => {
  it('strips the BOM, trims header names and drops the trailing empty field', () => {
    expect(parseFaaHeader('\ufeffN-NUMBER,SERIAL NUMBER, KIT MODEL,MODE S CODE HEX,\r')).toEqual([
      'N-NUMBER',
      'SERIAL NUMBER',
      'KIT MODEL',
      'MODE S CODE HEX',
    ]);
    expect(splitFaaLine('12345,SN1   , ,A061D9    ,\r')).toEqual(['12345', 'SN1', '', 'A061D9']);
  });

  it('reads and inflates zip entries with CRC checks', async () => {
    const file = path.join(dir, 'a.zip');
    writeFileSync(
      file,
      makeZip([
        { name: 'STORED.txt', data: Buffer.from('hello'), method: 0 },
        { name: 'DEFLATED.txt', data: Buffer.from('x'.repeat(100_000)) },
        { name: 'BAD.txt', data: Buffer.from('corrupt me'), badCrc: true },
      ]),
    );
    const entries = await readZipEntries(file);
    expect(entries.map((e) => e.name)).toEqual(['STORED.txt', 'DEFLATED.txt', 'BAD.txt']);
    expect(entries[0]!.modified).toBe('2026-11-13T23:22');
    const read = async (i: number) => {
      const chunks: Buffer[] = [];
      for await (const c of await openZipEntry(file, entries[i]!)) chunks.push(c as Buffer);
      return Buffer.concat(chunks).toString();
    };
    expect(await read(0)).toBe('hello');
    expect((await read(1)).length).toBe(100_000);
    await expect(read(2)).rejects.toThrow(/CRC/);
    writeFileSync(path.join(dir, 'b.zip'), 'not a zip at all, just text');
    await expect(readZipEntries(path.join(dir, 'b.zip'))).rejects.toThrow(/not a zip/);
  });
});

describe('importer', () => {
  const build = async (storePrivateNames: boolean) => {
    const zip = path.join(dir, 'r.zip');
    writeFileSync(zip, fakeRegistryZip());
    const out = path.join(dir, 'faa-registry.sqlite');
    const r = await importRegistryZip(zip, out, { storePrivateNames, minRows: 1 });
    return { r, out };
  };

  it('keeps MASTER, ACFTREF and ENGINE, indexed by hex and N-number', async () => {
    const { r } = await build(false);
    expect(r).toMatchObject({
      rows: FAKE_FLEET.length,
      acftref: 4,
      engine: 1,
      as_of: '2026-11-13',
    });
    const store = new RegistryStore(dir);
    const hex = toHex(nNumberToIcao('N303CC')!);
    const rec = store.byHex(hex.toLowerCase())!;
    expect(rec).toMatchObject({
      n_number: '303CC',
      name: 'EXAMPLE CHARTER CORP',
      city: 'GRAND RAPIDS',
      ref_mfr: 'CESSNA',
      ref_model: '172S',
      eng_mfr: 'LYCOMING',
    });
    expect(store.byNNumber('N303CC')?.mode_s_hex).toBe(hex);
    // A blank MODE S CODE HEX is rebuilt from the octal MODE S CODE.
    expect(store.byNNumber('909NH')?.mode_s_hex).toBe(toHex(nNumberToIcao('N909NH')!));
    expect(store.byNNumber('919NM')?.mode_s_hex).toBeNull();
    expect(store.meta()).toMatchObject({ rows: FAKE_FLEET.length, private_names_stored: false });
    store.close();
  });

  it('never stores a street, ZIP code, co-owner name or (by default) a private name', async () => {
    const { out } = await build(false);
    const bytes = readFileSync(out).toString('latin1');
    for (const secret of [SECRET_STREET, SECRET_ZIP, SECRET_COOWNER, 'DEREG EXAMPLE PERSON'])
      expect(bytes).not.toContain(secret);
    expect(bytes).not.toContain('PRIVATE EXAMPLE PERSON');
    expect(bytes).not.toContain('COOWNED EXAMPLE PERSON');
    const store = new RegistryStore(dir);
    const priv = store.byNNumber('N101AA')!;
    expect(priv).toMatchObject({ name: null, name_blank: 0, city: 'LANSING', state: 'MI' });
    // Withheld at the FAA: blank stays blank, and DEREG is never read.
    expect(store.byNNumber('N505WH')).toMatchObject({
      name: null,
      name_blank: 1,
      type_registrant: '1',
    });
    store.close();
  });

  it('keeps private names only for AIRCRAFT_OWNER_DISCLOSURE=full', async () => {
    const { out } = await build(true);
    const bytes = readFileSync(out).toString('latin1');
    expect(bytes).toContain('PRIVATE EXAMPLE PERSON');
    expect(bytes).not.toContain(SECRET_STREET);
    const store = new RegistryStore(dir);
    expect(store.meta()?.private_names_stored).toBe(true);
    store.close();
  });

  it('refuses truncated or implausible archives', async () => {
    const zip = path.join(dir, 'r.zip');
    const out = path.join(dir, 'x.sqlite');
    writeFileSync(zip, fakeRegistryZip());
    await expect(
      importRegistryZip(zip, out, { storePrivateNames: false, minRows: 100 }),
    ).rejects.toThrow(/expected 100\+/);
    await expect(
      importRegistryZip(zip, out, { storePrivateNames: false, minRows: 1, previousRows: 1000 }),
    ).rejects.toThrow(/under half/);
    writeFileSync(zip, fakeRegistryZip(FAKE_FLEET, { noAcftref: true }));
    await expect(
      importRegistryZip(zip, out, { storePrivateNames: false, minRows: 1 }),
    ).rejects.toThrow(/ACFTREF/);
  });
});

describe('daily sync', () => {
  const LAST_MODIFIED = 'Sat, 14 Nov 2026 05:58:13 GMT';
  const zipResponse = (body = fakeRegistryZip()) =>
    new Response(new Uint8Array(body), {
      status: 200,
      headers: { 'content-type': 'application/zip', 'last-modified': LAST_MODIFIED },
    });

  const makeSync = (f: typeof fetch, store = new RegistryStore(dir)) => ({
    store,
    sync: new RegistrySync(
      { dir, fetch: f, logger: nullLogger, storePrivateNames: false, minRows: 1 },
      store,
    ),
  });

  it('downloads with an honest User-Agent, imports, then asks If-Modified-Since (304)', async () => {
    const f = scriptedFetch((_url, n) =>
      n === 1 ? zipResponse() : new Response(null, { status: 304 }),
    );
    const { store, sync } = makeSync(f);
    expect(store.available).toBe(false);
    const first = await sync.run();
    expect(first).toMatchObject({
      outcome: 'imported',
      rows: FAKE_FLEET.length,
      as_of: '2026-11-13',
    });
    expect(f.calls[0]!.url).toBe('https://registry.faa.gov/database/ReleasableAircraft.zip');
    expect(f.calls[0]!.headers['user-agent']).toBe('aircraft-registry-sync/1.0');
    expect(f.calls[0]!.headers['if-modified-since']).toBeUndefined();
    expect(store.available).toBe(true);
    expect(store.meta()).toMatchObject({ last_modified: LAST_MODIFIED, as_of: '2026-11-13' });
    const gen = store.generation;
    const second = await sync.run();
    expect(second.outcome).toBe('not_modified');
    expect(f.calls[1]!.headers['if-modified-since']).toBe(LAST_MODIFIED);
    expect(store.generation).toBe(gen);
    // Nothing left behind but the copy and the small state file: the archive (addresses) is gone.
    expect(readdirSync(dir).sort()).toEqual(['faa-registry.sqlite', 'sync-state.json']);
    expect(JSON.parse(readFileSync(path.join(dir, 'sync-state.json'), 'utf8'))).toMatchObject({
      last_outcome: 'not_modified',
      failures: 0,
    });
    store.close();
  });

  it('keeps the last good copy when a run fails, whatever the failure', async () => {
    const good = scriptedFetch(() => zipResponse());
    const { store, sync } = makeSync(good);
    expect((await sync.run()).outcome).toBe('imported');
    const before = readFileSync(path.join(dir, 'faa-registry.sqlite'));
    const failures: Array<() => Response | 'timeout'> = [
      () => new Response('Access Denied', { status: 403 }),
      () => new Response('oops', { status: 503 }),
      () => zipResponse(fakeRegistryZip(FAKE_FLEET, { badCrc: true })),
      () => zipResponse(Buffer.from('truncated garbage')),
      () => zipResponse(fakeRegistryZip(FAKE_FLEET.slice(0, 1))),
    ];
    for (const fail of failures) {
      const f = scriptedFetch(() => fail());
      const s = new RegistrySync(
        { dir, fetch: f, logger: nullLogger, storePrivateNames: false, minRows: 1 },
        store,
      );
      const r = await s.run({ force: true });
      expect(r.outcome).toBe('failed');
      expect(readFileSync(path.join(dir, 'faa-registry.sqlite')).equals(before)).toBe(true);
      expect(store.byNNumber('N303CC')?.name).toBe('EXAMPLE CHARTER CORP');
      expect(existsSync(path.join(dir, 'ReleasableAircraft.zip.part'))).toBe(false);
      expect(existsSync(path.join(dir, 'faa-registry.sqlite.new'))).toBe(false);
    }
    const st = JSON.parse(readFileSync(path.join(dir, 'sync-state.json'), 'utf8'));
    expect(st.last_outcome).toBe('failed');
    store.close();
  });

  it('swaps the copy atomically and lookups see the new one', async () => {
    const f = scriptedFetch((_u, n) =>
      zipResponse(
        n === 1
          ? fakeRegistryZip()
          : fakeRegistryZip([
              ...FAKE_FLEET,
              { n: 'N4242', type: '3', name: 'NEWER EXAMPLE CORP', city: 'DETROIT', state: 'MI' },
            ]),
      ),
    );
    const { store, sync } = makeSync(f);
    await sync.run();
    expect(store.byNNumber('N4242')).toBeUndefined();
    const gen = store.generation;
    await sync.run({ force: true });
    expect(store.generation).toBeGreaterThan(gen);
    expect(store.byNNumber('N4242')?.name).toBe('NEWER EXAMPLE CORP');
    store.close();
  });

  it('runs one sync at a time, and imports a manually downloaded archive', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const f = scriptedFetch(async () => {
      await gate;
      return zipResponse();
    });
    const { store, sync } = makeSync(f);
    const a = sync.run();
    expect((await sync.run()).outcome).toBe('busy');
    release();
    expect((await a).outcome).toBe('imported');
    const manual = path.join(dir, 'manual.zip');
    writeFileSync(manual, fakeRegistryZip());
    const m = await new RegistrySync(
      {
        dir,
        fetch: scriptedFetch(() => new Response(null, { status: 500 })),
        logger: nullLogger,
        storePrivateNames: false,
        minRows: 1,
      },
      store,
    ).run({ file: manual });
    expect(m.outcome).toBe('imported');
    expect(existsSync(manual)).toBe(true);
    expect(store.meta()?.source_url).toMatch(/manual import/);
    store.close();
  });

  it('schedules daily at about 06:15 UTC', () => {
    const at = Date.UTC(2026, 10, 14, 5, 0);
    expect(msUntilUtc(at, 6, 15)).toBe(75 * 60_000);
    expect(msUntilUtc(Date.UTC(2026, 10, 14, 6, 15), 6, 15)).toBe(86_400_000);
  });
});
