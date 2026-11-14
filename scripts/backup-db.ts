/**
 * Online SQLite backup (better-sqlite3's backup API: consistent while the gateway runs).
 * Writes DATA_DIR/backups/gateway-<timestamp>.sqlite (mode 600) and keeps the newest 14.
 *
 *   dev:    npm run build && npm run backup
 *   docker: docker exec godseye-gateway node dist/scripts/backup-db.js
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { loadConfig, loadEnvFile } from '../src/config.js';
import { openDb } from '../src/db.js';

if (process.env.GATEWAY_ENV_FILE !== 'none') loadEnvFile(process.env.GATEWAY_ENV_FILE || undefined);
const config = loadConfig();
const keep = Number(process.env.BACKUP_KEEP ?? 14);
const dir = process.env.BACKUP_DIR ?? path.join(config.DATA_DIR, 'backups');
if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
const dest = path.join(dir, `gateway-${stamp}.sqlite`);
const db = openDb(config.dbPath);
await db.backup(dest);
db.close();
chmodSync(dest, 0o600);
const old = readdirSync(dir)
  .filter((f) => /^gateway-\d{8}T\d{6}\.sqlite$/.test(f))
  .sort()
  .reverse()
  .slice(keep);
for (const f of old) rmSync(path.join(dir, f));
console.log(`backup written: ${dest} (kept ${keep}, removed ${old.length})`);
