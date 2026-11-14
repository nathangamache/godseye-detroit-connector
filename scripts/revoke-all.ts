/**
 * Emergency: revoke every OAuth grant (and optionally every location device).
 * claude.ai will have to reconnect; devices need new tokens.
 *
 *   npm run build && node dist/scripts/revoke-all.js [--devices]
 *   docker exec godseye-gateway node dist/scripts/revoke-all.js [--devices]
 */
import { Audit } from '../src/audit.js';
import { loadConfig, loadEnvFile } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createLogger } from '../src/log.js';

if (process.env.GATEWAY_ENV_FILE !== 'none') loadEnvFile(process.env.GATEWAY_ENV_FILE || undefined);
const config = loadConfig();
const db = openDb(config.dbPath);
const t = Date.now();
const fams = db
  .prepare(
    "UPDATE token_families SET revoked_at = ?, revoked_reason = 'revoke_all' WHERE revoked_at IS NULL",
  )
  .run(t).changes;
db.prepare('UPDATE tokens SET revoked_at = ? WHERE revoked_at IS NULL').run(t);
db.prepare('DELETE FROM sessions').run();
db.prepare('UPDATE auth_codes SET used_at = ? WHERE used_at IS NULL').run(t);
let devices = 0;
if (process.argv.includes('--devices')) {
  devices = db
    .prepare(
      'UPDATE devices SET revoked_at = ?, token_hash = NULL, setup_code_hash = NULL WHERE revoked_at IS NULL',
    )
    .run(t).changes;
  db.prepare('DELETE FROM locations').run();
}
new Audit(db, createLogger({ level: 'warn' })).record('admin_revoke_all', {
  subject: 'cli',
  detail: { families: fams, devices },
});
db.close();
console.log(
  `Revoked ${fams} token grant(s), all sessions and pending codes${devices ? `, ${devices} device(s) and all stored fixes` : ''}.`,
);
