/**
 * Online SQLite backup (better-sqlite3's backup API: consistent while the gateway runs).
 * Writes DATA_DIR/backups/gateway-<timestamp>.sqlite (mode 600, directory 700) and keeps the
 * newest BACKUP_KEEP (14). Backups never contain location fixes (src/backup.ts): the live
 * database keeps at most 24 h of them, and backups must not stretch that to two weeks.
 *
 *   dev:    npm run build && npm run backup
 *   docker: docker exec godseye-gateway node dist/scripts/backup-db.js
 */
import { chmodSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { BACKUP_FILE, backupDirFor, purgeLocationBackups, writeBackup } from '../src/backup.js';
import { loadConfig, loadEnvFile } from '../src/config.js';
import { openDb } from '../src/db.js';

process.umask(0o077);
if (process.env.GATEWAY_ENV_FILE !== 'none') loadEnvFile(process.env.GATEWAY_ENV_FILE || undefined);
const config = loadConfig();
const keep = Number(process.env.BACKUP_KEEP ?? 14);
const dir = backupDirFor(config);
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
const dest = path.join(dir, `gateway-${stamp}.sqlite`);
const db = openDb(config.dbPath);
try {
  await writeBackup(db, dest);
} finally {
  db.close();
}
chmodSync(dir, 0o700);
// Older backups made before fixes were stripped: strip them now.
const legacy = purgeLocationBackups(dir);
const old = readdirSync(dir)
  .filter((f) => BACKUP_FILE.test(f))
  .sort()
  .reverse()
  .slice(keep);
for (const f of old) rmSync(path.join(dir, f));
console.log(
  `backup written (no location fixes): ${dest} (kept ${keep}, removed ${old.length}` +
    (legacy.fixes
      ? `, stripped ${legacy.fixes} fix(es) from ${legacy.files} older backup(s)`
      : '') +
    ')',
);
