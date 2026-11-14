/**
 * Location device tokens.
 *
 *   npm run devices -- add <name>          new device token for OwnTracks (printed once)
 *   npm run devices -- add <name> --pwa    one-time setup link for the /locate PWA (15 min)
 *   npm run devices -- setup-link <name>   new setup link (re-keys the device when claimed)
 *   npm run devices -- list
 *   npm run devices -- revoke <name|id>    revokes the token and deletes its stored fixes
 *
 * In docker mode run it inside the gateway container:
 *   docker exec -it godseye-gateway node dist/scripts/devices.js add my-phone
 */
import { Audit } from '../src/audit.js';
import { loadConfig, loadEnvFile } from '../src/config.js';
import { openDb } from '../src/db.js';
import { LocationStore } from '../src/location/store.js';
import { createLogger } from '../src/log.js';

if (process.env.GATEWAY_ENV_FILE !== 'none') loadEnvFile(process.env.GATEWAY_ENV_FILE || undefined);
const config = loadConfig();
const db = openDb(config.dbPath);
const store = new LocationStore(db, { retentionHours: config.LOCATION_RETENTION_HOURS });
const audit = new Audit(db, createLogger({ level: 'warn' }));
const [cmd, name, ...rest] = process.argv.slice(2);
const validName = (n: string | undefined): n is string => Boolean(n && /^[A-Za-z0-9._-]{1,40}$/.test(n));

function usage(): never {
  console.error('usage: devices add <name> [--pwa] | setup-link <name> | list | revoke <name|id>');
  process.exit(2);
}

switch (cmd) {
  case 'add': {
    if (!validName(name)) usage();
    if (rest.includes('--pwa')) {
      const { code } = store.createSetupCode(name);
      audit.record('device_setup_link_created', { subject: 'cli', detail: { device: name } });
      console.log(`Open this on the phone within 15 minutes (single use):\n\n  ${config.PUBLIC_ORIGIN}/locate/#setup=${code}\n`);
    } else {
      try {
        const { token } = store.createDevice(name);
        audit.record('device_created', { subject: 'cli', detail: { device: name } });
        console.log(`Device "${name}" created. Its token is shown only once:\n\n  ${token}\n`);
        console.log(`OwnTracks (HTTP mode): URL ${config.PUBLIC_ORIGIN}/api/location, Authentication on,`);
        console.log(`  UserID "${name}", Password = the token above. See docs/phone-setup.md.`);
      } catch {
        console.error(`A device named "${name}" already exists; revoke it first or pick another name.`);
        process.exit(1);
      }
    }
    break;
  }
  case 'setup-link': {
    if (!validName(name)) usage();
    const { code } = store.createSetupCode(name);
    audit.record('device_setup_link_created', { subject: 'cli', detail: { device: name } });
    console.log(`${config.PUBLIC_ORIGIN}/locate/#setup=${code}`);
    break;
  }
  case 'list':
    for (const d of store.listDevices()) {
      const seen = d.last_seen_at ? new Date(d.last_seen_at).toISOString() : 'never';
      console.log(`${String(d.id).padStart(3)}  ${d.name.padEnd(24)} ${d.revoked_at ? 'REVOKED' : d.has_token ? 'active ' : 'pending'}  last fix: ${seen}`);
    }
    break;
  case 'revoke':
    if (!name) usage();
    if (store.revokeDevice(name)) {
      audit.record('device_revoked', { subject: 'cli', detail: { device: name } });
      console.log(`Revoked ${name} and deleted its stored fixes.`);
    } else {
      console.error(`No device ${name}.`);
      process.exit(1);
    }
    break;
  default:
    usage();
}
db.close();
