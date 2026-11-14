/**
 * Database backups WITHOUT location fixes (review DS-6).
 *
 * The live database keeps at most LOCATION_RETENTION_HOURS (24 h) of fixes, and revoking
 * a device deletes its fixes. Nightly full copies would have kept about two weeks of
 * movements, revoked devices included. So a backup is written to a temporary file, its
 * `locations` table (plus login and step-up session hashes, which a restore doesn't need) is
 * emptied and the file VACUUMed (secure_delete is on, so no old pages linger), and only then
 * is it renamed into place. purgeLocationBackups() strips any older backup that still holds
 * fixes; it runs on every backup and whenever a device is revoked.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Config } from './config.js';
import type { DB } from './db.js';

export const BACKUP_FILE = /^gateway-\d{8}T\d{6}\.sqlite$/;

export function backupDirFor(config: Pick<Config, 'DATA_DIR'>, env = process.env): string {
  return env.BACKUP_DIR ?? path.join(config.DATA_DIR, 'backups');
}

/**
 * Empties the tables a backup must not carry; returns the number of fixes removed.
 * With onlyIfFixes, a file that holds no fixes is left untouched.
 */
export function stripBackupFile(file: string, onlyIfFixes = false): number {
  const db = new Database(file);
  try {
    const has = (t: string) =>
      Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t));
    if (
      onlyIfFixes &&
      (!has('locations') ||
        (db.prepare('SELECT COUNT(*) AS n FROM locations').get() as { n: number }).n === 0)
    )
      return 0;
    db.pragma('secure_delete = ON');
    db.pragma('journal_mode = DELETE');
    let removed = 0;
    db.transaction(() => {
      if (has('locations')) removed = db.prepare('DELETE FROM locations').run().changes;
      if (has('sessions')) db.prepare('DELETE FROM sessions').run();
      if (has('stepup_sessions')) db.prepare('DELETE FROM stepup_sessions').run();
    })();
    db.exec('VACUUM');
    return removed;
  } finally {
    db.close();
  }
}

/** Online backup to `dest` (mode 600) with no location fixes in it. */
export async function writeBackup(db: DB, dest: string): Promise<void> {
  const dir = path.dirname(dest);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${dest}.partial`;
  rmSync(tmp, { force: true });
  await db.backup(tmp);
  chmodSync(tmp, 0o600);
  try {
    stripBackupFile(tmp);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  for (const ext of ['-wal', '-shm', '-journal']) rmSync(tmp + ext, { force: true });
  renameSync(tmp, dest);
}

/** Strips fixes from every backup in `dir` (older backups, or after a device revoke). */
export function purgeLocationBackups(dir: string): { files: number; fixes: number } {
  if (!existsSync(dir)) return { files: 0, fixes: 0 };
  let files = 0;
  let fixes = 0;
  for (const f of readdirSync(dir)) {
    if (f.endsWith('.partial')) {
      rmSync(path.join(dir, f), { force: true });
      continue;
    }
    if (!BACKUP_FILE.test(f)) continue;
    const n = stripBackupFile(path.join(dir, f), true);
    if (n) {
      files++;
      fixes += n;
    }
  }
  return { files, fixes };
}
