/**
 * Phone location fixes and the devices allowed to post them.
 * Only the latest fix is ever exposed (where_am_i); history is pruned after
 * LOCATION_RETENTION_HOURS. Device tokens and setup codes are stored hashed.
 */
import type { DB } from '../db.js';
import { randomToken, sha256hex } from '../util/crypto.js';

export interface Fix {
  deviceId: number;
  lat: number;
  lon: number;
  accuracyM?: number;
  fixTs: number; // ms epoch
  battery?: number;
  speedKmh?: number;
  source: 'owntracks' | 'pwa' | 'api';
}

export interface LatestFix {
  lat: number;
  lon: number;
  accuracy_m: number | null;
  fix_ts: number;
  device: string;
  source: string;
}

export interface Device {
  id: number;
  name: string;
  created_at: number;
  last_seen_at: number | null;
  revoked_at: number | null;
  has_token: boolean;
  setup_pending: boolean;
}

export class LocationStore {
  constructor(
    private readonly db: DB,
    private readonly opts: { retentionHours: number },
    private readonly now: () => number = Date.now,
  ) {}

  insert(fix: Fix): void {
    const t = this.now();
    this.db
      .prepare(
        'INSERT INTO locations(device_id, lat, lon, accuracy_m, fix_ts, received_at, battery, speed_kmh, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        fix.deviceId,
        fix.lat,
        fix.lon,
        fix.accuracyM ?? null,
        fix.fixTs,
        t,
        fix.battery ?? null,
        fix.speedKmh ?? null,
        fix.source,
      );
    this.db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(t, fix.deviceId);
  }

  /** Most recent fix from any non-revoked device, within the retention window. */
  latest(): LatestFix | undefined {
    const cutoff = this.now() - this.opts.retentionHours * 3_600_000;
    return this.db
      .prepare(
        `SELECT l.lat, l.lon, l.accuracy_m, l.fix_ts, d.name AS device, l.source
           FROM locations l JOIN devices d ON d.id = l.device_id
          WHERE d.revoked_at IS NULL AND l.fix_ts >= ?
          ORDER BY l.fix_ts DESC, l.id DESC LIMIT 1`,
      )
      .get(cutoff) as LatestFix | undefined;
  }

  prune(): number {
    const cutoff = this.now() - this.opts.retentionHours * 3_600_000;
    const r = this.db
      .prepare('DELETE FROM locations WHERE fix_ts < ? OR received_at < ?')
      .run(cutoff, cutoff);
    return r.changes;
  }

  // ---------- devices ----------
  /** Creates a device and returns its bearer token (shown once). */
  createDevice(name: string): { id: number; token: string } {
    const token = randomToken('gdt');
    const r = this.db
      .prepare('INSERT INTO devices(name, token_hash, created_at) VALUES (?, ?, ?)')
      .run(name, sha256hex(token), this.now());
    return { id: Number(r.lastInsertRowid), token };
  }

  /** Creates a device (or reuses a name) with a one-time setup code for the /locate PWA. */
  createSetupCode(name: string, ttlMs = 15 * 60_000): { id: number; code: string } {
    const code = randomToken('gsc', 24);
    const t = this.now();
    const existing = this.db.prepare('SELECT id FROM devices WHERE name = ?').get(name) as
      { id: number } | undefined;
    if (existing) {
      this.db
        .prepare(
          'UPDATE devices SET setup_code_hash = ?, setup_expires_at = ?, revoked_at = NULL WHERE id = ?',
        )
        .run(sha256hex(code), t + ttlMs, existing.id);
      return { id: existing.id, code };
    }
    const r = this.db
      .prepare(
        'INSERT INTO devices(name, setup_code_hash, setup_expires_at, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(name, sha256hex(code), t + ttlMs, t);
    return { id: Number(r.lastInsertRowid), code };
  }

  /** Exchanges a setup code for a fresh device token. Single use. */
  claimSetupCode(code: string): { id: number; name: string; token: string } | null {
    if (!/^gsc_[A-Za-z0-9_-]{16,64}$/.test(code)) return null;
    const row = this.db
      .prepare('SELECT id, name, setup_expires_at FROM devices WHERE setup_code_hash = ?')
      .get(sha256hex(code)) as { id: number; name: string; setup_expires_at: number } | undefined;
    if (!row) return null;
    this.db
      .prepare('UPDATE devices SET setup_code_hash = NULL, setup_expires_at = NULL WHERE id = ?')
      .run(row.id);
    if (row.setup_expires_at < this.now()) return null;
    const token = randomToken('gdt');
    this.db
      .prepare('UPDATE devices SET token_hash = ?, revoked_at = NULL WHERE id = ?')
      .run(sha256hex(token), row.id);
    return { id: row.id, name: row.name, token };
  }

  verifyDeviceToken(token: string): { id: number; name: string } | null {
    if (!/^gdt_[A-Za-z0-9_-]{20,80}$/.test(token)) return null;
    const row = this.db
      .prepare('SELECT id, name FROM devices WHERE token_hash = ? AND revoked_at IS NULL')
      .get(sha256hex(token)) as { id: number; name: string } | undefined;
    return row ?? null;
  }

  revokeDevice(idOrName: string | number): boolean {
    const t = this.now();
    const r =
      typeof idOrName === 'number' || /^\d+$/.test(String(idOrName))
        ? this.db
            .prepare(
              'UPDATE devices SET revoked_at = ?, token_hash = NULL, setup_code_hash = NULL WHERE id = ?',
            )
            .run(t, Number(idOrName))
        : this.db
            .prepare(
              'UPDATE devices SET revoked_at = ?, token_hash = NULL, setup_code_hash = NULL WHERE name = ?',
            )
            .run(t, idOrName);
    if (r.changes) {
      this.db
        .prepare(
          'DELETE FROM locations WHERE device_id IN (SELECT id FROM devices WHERE revoked_at IS NOT NULL)',
        )
        .run();
    }
    return r.changes > 0;
  }

  listDevices(): Device[] {
    const rows = this.db
      .prepare(
        'SELECT id, name, created_at, last_seen_at, revoked_at, token_hash IS NOT NULL AS has_token, setup_code_hash IS NOT NULL AS setup_pending FROM devices ORDER BY id',
      )
      .all() as Array<
      Omit<Device, 'has_token' | 'setup_pending'> & { has_token: number; setup_pending: number }
    >;
    return rows.map((r) => ({
      ...r,
      has_token: Boolean(r.has_token),
      setup_pending: Boolean(r.setup_pending),
    }));
  }
}
