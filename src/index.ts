/** Gateway entry point: node dist/src/index.js */
import { ConfigError, loadConfig, loadEnvFile } from './config.js';
import { createLogger } from './log.js';
import { installAllRoutes } from './routes.js';
import { startGateway } from './gateway.js';

async function main() {
  if (process.env.GATEWAY_ENV_FILE !== 'none') loadEnvFile(process.env.GATEWAY_ENV_FILE || undefined);
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`[godseye-gateway] ${err.message}`);
      process.exit(78); // EX_CONFIG
    }
    throw err;
  }
  const logger = createLogger({ level: config.LOG_LEVEL, base: { app: 'godseye-gateway' } });
  if (config.loginProvider === 'none') {
    logger.warn('no_login_provider', {
      note: 'Neither CF_ACCESS_* nor GATEWAY_PASSWORD_HASH/GATEWAY_TOTP_SECRET is set: UI and /oauth/authorize will refuse all logins.',
    });
  }
  const gw = await startGateway(config, { logger, mount: installAllRoutes() });
  const shutdown = (sig: string) => {
    logger.info('shutdown', { signal: sig });
    gw.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[godseye-gateway] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
