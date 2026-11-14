/**
 * One FAA registry sync by hand (the gateway also runs it daily at about 06:15 UTC).
 *
 *   docker exec godseye-gateway node dist/scripts/aircraft-registry-sync.js            # If-Modified-Since
 *   docker exec godseye-gateway node dist/scripts/aircraft-registry-sync.js --force    # full download
 *   ... aircraft-registry-sync.js --file /data/aviation/ReleasableAircraft.zip         # a manual download
 *
 * --file is the fallback when registry.faa.gov refuses automated clients: download the ZIP in a
 * browser, copy it into the data volume, import it, then delete it (it holds owner addresses;
 * only the fields the tools use are imported). The running gateway picks up the new copy within
 * 30 s.
 */
import { loadConfig, loadEnvFile } from '../src/config.js';
import { aviationDir } from '../src/extra/aviation/index.js';
import { RegistryStore } from '../src/extra/aviation/registry-store.js';
import { RegistrySync } from '../src/extra/aviation/registry-sync.js';
import { createLogger } from '../src/log.js';

process.umask(0o077);
if (process.env.GATEWAY_ENV_FILE !== 'none') loadEnvFile(process.env.GATEWAY_ENV_FILE || undefined);
const config = loadConfig();
const args = process.argv.slice(2);
const fileAt = args.indexOf('--file');
const file = fileAt >= 0 ? args[fileAt + 1] : undefined;
if (fileAt >= 0 && !file) {
  console.error('usage: aircraft-registry-sync [--force] [--file ReleasableAircraft.zip]');
  process.exit(64);
}
const dir = aviationDir(config);
const store = new RegistryStore(dir);
const sync = new RegistrySync(
  {
    dir,
    url: config.AIRCRAFT_REGISTRY_URL,
    logger: createLogger({ level: config.LOG_LEVEL, base: { app: 'aircraft-registry-sync' } }),
    storePrivateNames: config.AIRCRAFT_OWNER_DISCLOSURE === 'full',
  },
  store,
);
const r = await sync.run({ force: args.includes('--force'), file });
store.close();
if (r.outcome === 'imported')
  console.log(`imported ${r.rows} aircraft (FAA data as of ${r.as_of ?? 'unknown'}) into ${dir}`);
else if (r.outcome === 'not_modified')
  console.log('the FAA file has not changed since the last sync');
else if (r.outcome === 'busy') console.log('another sync is running');
else {
  console.error(`sync failed, the last good copy is kept: ${r.reason}`);
  process.exit(1);
}
if (file) console.log(`delete ${file} now: it holds owner addresses the copy does not keep`);
