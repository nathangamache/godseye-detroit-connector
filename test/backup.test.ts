/**
 * Review DS-6: backups must not retain location fixes beyond the live 24 h retention, and
 * revoking a device must purge its fixes from backups too.
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { purgeLocationBackups, writeBackup } from '../src/backup.js';
import { openDb } from '../src/db.js';
import { LocationStore } from '../src/location/store.js';
import { DETROIT } from './helpers.js';
import { ownerJar, startTailscaleGateway, type TestGateway } from './oauth-helpers.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'gw-backup-'));
  dirs.push(d);
  return d;
};
/** The IEEE-754 bytes SQLite stores for a REAL (big-endian). */
const realBytes = (v: number) => {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(v);
  return b;
};
const count = (file: string, table: string) => {
  const db = new Database(file, { readonly: true });
  try {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  } finally {
    db.close();
  }
};

function seeded(dir: string) {
  const db = openDb(path.join(dir, 'gateway.sqlite'));
  const store = new LocationStore(db, { retentionHours: 24 });
  const dev = store.createDevice('phone');
  for (let i = 0; i < 5; i++)
    store.insert({
      deviceId: dev.id,
      ...DETROIT,
      accuracyM: 5,
      fixTs: Date.now() - i,
      source: 'api',
    });
  db.prepare(
    "INSERT INTO clients(client_id, kind, client_name, redirect_uris, created_at) VALUES ('c1', 'dcr', 'x', '[]', 1)",
  ).run();
  return { db, store, dev };
}

describe('backups carry no location fixes', () => {
  it('writeBackup strips fixes (and session hashes) but keeps the rest; mode 600', async () => {
    const dir = tmp();
    const { db } = seeded(dir);
    const dest = path.join(dir, 'backups', 'gateway-20261114T031700.sqlite');
    await writeBackup(db, dest);
    db.close();
    expect(count(dest, 'locations')).toBe(0);
    expect(count(dest, 'devices')).toBe(1);
    expect(count(dest, 'clients')).toBe(1);
    expect(statSync(dest).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(dest)).mode & 0o777).toBe(0o700);
    // Not even freed pages hold the coordinates (secure_delete + VACUUM).
    const bytes = readFileSync(dest);
    expect(bytes.includes(realBytes(DETROIT.lat))).toBe(false);
    expect(bytes.includes(realBytes(DETROIT.lon))).toBe(false);
  });

  it('purgeLocationBackups strips older backups that still hold fixes', async () => {
    const dir = tmp();
    const { db } = seeded(dir);
    const legacy = path.join(dir, 'backups', 'gateway-20261101T031700.sqlite');
    // An old-style full copy, as made before this fix.
    await writeBackup(db, path.join(dir, 'backups', 'gateway-20261102T031700.sqlite'));
    await db.backup(legacy);
    db.close();
    expect(count(legacy, 'locations')).toBe(5);
    expect(purgeLocationBackups(path.join(dir, 'backups'))).toEqual({ files: 1, fixes: 5 });
    expect(count(legacy, 'locations')).toBe(0);
    expect(readFileSync(legacy).includes(realBytes(DETROIT.lat))).toBe(false);
    expect(purgeLocationBackups(path.join(dir, 'backups'))).toEqual({ files: 0, fixes: 0 });
  });
});

describe('device revoke purges backups', () => {
  let t: TestGateway | undefined;
  afterEach(async () => {
    await t?.close();
    t = undefined;
  });

  it('revoking a device on /oauth/admin strips its fixes from backups too', async () => {
    t = await startTailscaleGateway();
    const dev = t.gw.locations.createDevice('lost-phone');
    t.gw.locations.insert({ deviceId: dev.id, ...DETROIT, fixTs: Date.now(), source: 'api' });
    const legacy = path.join(t.dir, 'backups', 'gateway-20261101T031700.sqlite');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(path.dirname(legacy), { recursive: true });
    await t.gw.db.backup(legacy);
    expect(count(legacy, 'locations')).toBe(1);

    const jar = await ownerJar(t);
    const page = await fetch(`${t.privateOrigin}/oauth/admin`, { headers: t.auth(jar) });
    jar.store(page);
    const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())![1]!;
    const r = await fetch(`${t.privateOrigin}/oauth/admin/revoke-device`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        ...t.auth(jar),
        'content-type': 'application/x-www-form-urlencoded',
        origin: t.privateOrigin,
      },
      body: new URLSearchParams({ csrf, device_id: String(dev.id) }),
    });
    expect(r.status).toBe(303);
    expect(t.gw.locations.latest()).toBeUndefined();
    expect(count(legacy, 'locations')).toBe(0);
  });
});
