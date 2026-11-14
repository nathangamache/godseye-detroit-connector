/**
 * Entry point of the `gev-mcp` container: the GEV MCP relay (src/gev/relay.ts).
 *
 *   node dist/scripts/gev-relay.js
 *
 * Environment: GEV_RELAY_HOST (default 0.0.0.0), GEV_RELAY_PORT (7704),
 * GEV_RELAY_ALLOWED_PEERS (the gateway's address; required), GEV_ROOT (/gev),
 * GEV_URL (http://gev:7701), GEV_WRAPPER (/app/gev/stdio-all-surfaces.mjs), LOG_LEVEL.
 */
import { isIP } from 'node:net';
import { startRelay } from '../src/gev/relay.js';
import { createLogger } from '../src/log.js';

process.umask(0o077);
const env = process.env;
const level = (['debug', 'info', 'warn', 'error'] as const).find((l) => l === env.LOG_LEVEL);
const logger = createLogger({ level: level ?? 'info', base: { app: 'godseye-gev-relay' } });
const peers = (env.GEV_RELAY_ALLOWED_PEERS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (!peers.length || !peers.every((p) => isIP(p))) {
  console.error('[gev-relay] GEV_RELAY_ALLOWED_PEERS must list the gateway address(es)');
  process.exit(78);
}
const relay = await startRelay({
  host: env.GEV_RELAY_HOST || '0.0.0.0',
  port: Number(env.GEV_RELAY_PORT || 7704),
  allowedPeers: peers,
  gevRoot: env.GEV_ROOT || '/gev',
  gevUrl: env.GEV_URL || 'http://gev:7701',
  wrapper: env.GEV_WRAPPER || '/app/gev/stdio-all-surfaces.mjs',
  log: (event, fields) =>
    event === 'gev_child_stderr' ? logger.debug(event, fields) : logger.info(event, fields),
});
logger.info('relay_listening', { port: relay.port, peers });
const stop = () => {
  relay.close().then(
    () => process.exit(0),
    () => process.exit(1),
  );
  setTimeout(() => process.exit(1), 5000).unref();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
