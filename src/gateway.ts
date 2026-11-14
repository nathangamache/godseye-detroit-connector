/** Wires storage, tool backends, the MCP surface and HTTP routes into a running gateway. */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Express } from 'express';
import { createPrivateApp, createPublicApp, createUiApp, hardenServer } from './app.js';
import { Audit } from './audit.js';
import { StepUp, deriveStepUpKey, parseStepUpKey } from './auth/stepup.js';
import { parseRelayUrl, type Config } from './config.js';
import { kvGet, kvSet, openDb, type DB } from './db.js';
import { GevChild, childSpawnSpec, type GevChildOptions } from './gev/child.js';
import { makeGevCaller } from './gev/tools.js';
import { LocationStore } from './location/store.js';
import { createLogger, type Logger } from './log.js';
import { TokenStore } from './oauth/tokens.js';
import { RailIndex } from './rail/index.js';
import { railTools } from './rail/tools.js';
import { PulseClient } from './pulse/client.js';
import { pulseTools } from './pulse/tools.js';
import { ToolPolicy } from './tools/policy.js';
import { ToolRegistry } from './tools/registry.js';
import { ToolRunner } from './tools/runner.js';
import type { ToolDef } from './tools/types.js';
import { RateLimiter } from './util/ratelimit.js';
import { bind, type RouteSet } from './routes.js';

export interface GatewayOverrides {
  logger?: Logger;
  now?: () => number;
  /** Replace the GEV child command (tests use a mock MCP server). */
  gevChild?: { command: string; args: string[]; cwd: string; env: Record<string, string> } | false;
  /** Extra tools to register (tests). */
  extraTools?: ToolDef[];
  /** Route installers for the two listeners (src/routes.ts installAllRoutes()). */
  routes?: RouteSet;
}

export interface GatewayCore {
  config: Config;
  db: DB;
  logger: Logger;
  audit: Audit;
  tokens: TokenStore;
  locations: LocationStore;
  registry: ToolRegistry;
  runner: ToolRunner;
  limiter: RateLimiter;
  sessionSecret: string;
  stepup: StepUp;
  gev?: GevChild;
  rail?: RailIndex;
  now: () => number;
}

export interface Gateway extends GatewayCore {
  app: Express;
  privateApp: Express;
  uiApp: Express;
  server: Server;
  privateServer: Server;
  uiServer: Server;
  /** Public listener port and URL (127.0.0.1 or the bind host). */
  port: number;
  url: string;
  privatePort: number;
  privateUrl: string;
  uiPort: number;
  uiUrl: string;
  close(): Promise<void>;
}

export function sessionSecretFor(config: Config, db: DB): string {
  if (config.SESSION_SECRET) return config.SESSION_SECRET;
  let s = kvGet(db, 'session_secret');
  if (!s) {
    s = randomBytes(32).toString('base64url');
    kvSet(db, 'session_secret', s);
  }
  return s;
}

export function buildCore(config: Config, overrides: GatewayOverrides = {}): GatewayCore {
  const logger = overrides.logger ?? createLogger({ level: config.LOG_LEVEL });
  const now = overrides.now ?? Date.now;
  const db = openDb(config.dbPath);
  const audit = new Audit(db, logger, now);
  const tokens = new TokenStore(
    db,
    {
      accessTtlS: config.ACCESS_TOKEN_TTL_S,
      refreshTtlS: config.REFRESH_TOKEN_TTL_S,
      codeTtlS: config.AUTH_CODE_TTL_S,
      reuseGraceS: config.REFRESH_REUSE_GRACE_S,
    },
    now,
  );
  const locations = new LocationStore(db, { retentionHours: config.LOCATION_RETENTION_HOURS }, now);
  const limiter = new RateLimiter();
  const policy = new ToolPolicy(config);
  const registry = new ToolRegistry(policy);
  const runner = new ToolRunner(registry, {
    timeoutMs: config.TOOL_TIMEOUT_MS,
    maxConcurrent: config.MAX_CONCURRENT_TOOL_CALLS,
    logger,
    post: {
      publicOrigin: config.linkOrigin,
      gevOrigins: config.gevApiOrigins,
      maxResultChars: config.MAX_RESULT_CHARS,
      imageMaxDim: config.IMAGE_MAX_DIM,
      imageMaxBase64Chars: config.IMAGE_MAX_BASE64_CHARS,
      maxImages: config.MAX_IMAGES_PER_RESULT,
    },
  });
  let rail: RailIndex | undefined;
  if (existsSync(path.join(config.RAIL_DATA_DIR, 'meta.json'))) {
    rail = RailIndex.load(config.RAIL_DATA_DIR);
    for (const t of railTools(rail)) registry.register(t);
    logger.info('rail_data_loaded', {
      lines: rail.lines.length,
      crossings: rail.crossings.length,
      as_of: rail.datasetAsOf(),
    });
  } else {
    logger.warn('rail_data_missing', { dir: config.RAIL_DATA_DIR });
  }
  const pulse = new PulseClient({
    baseUrl: config.PULSE_URL,
    token: config.PULSE_API_TOKEN,
    timeoutMs: config.PULSE_TIMEOUT_MS,
  });
  for (const t of pulseTools(pulse)) registry.register(t);
  for (const t of overrides.extraTools ?? []) registry.register(t);
  const sessionSecret = sessionSecretFor(config, db);
  const stepup = new StepUp(
    db,
    {
      enabled: config.STEPUP_TOTP === 'on',
      windowS: config.STEPUP_WINDOW_S,
      // Production requires STEPUP_KEY (config.ts); dev/test may derive one.
      key: config.STEPUP_KEY ? parseStepUpKey(config.STEPUP_KEY) : deriveStepUpKey(sessionSecret),
    },
    now,
  );
  if (!stepup.enabled) logger.warn('stepup_disabled', { note: 'STEPUP_TOTP=off' });
  else if (!stepup.isEnrolled())
    logger.warn('stepup_not_enrolled', {
      note: 'Consent approval and /oauth/admin refuse until you run: node dist/scripts/stepup.js enroll',
    });
  return {
    config,
    db,
    logger,
    audit,
    tokens,
    locations,
    registry,
    runner,
    limiter,
    sessionSecret,
    stepup,
    rail,
    now,
  };
}

export async function startGateway(
  config: Config,
  overrides: GatewayOverrides = {},
): Promise<Gateway> {
  const core = buildCore(config, overrides);
  const { logger } = core;

  // The child only ever gets the tools the policy allows (it builds its catalog from them),
  // so a composite GEV tool can't call a denied one internally.
  const allow = core.registry.policy.allowedGevTools();
  if (config.GEV_MCP_ENABLED && overrides.gevChild !== false && allow.length) {
    const relay = config.GEV_CHILD_URL ? parseRelayUrl(config.GEV_CHILD_URL) : null;
    let opts: Omit<GevChildOptions, 'logger'>;
    if (relay && !overrides.gevChild) opts = { connect: { ...relay, allow } };
    else {
      const spec =
        overrides.gevChild ??
        childSpawnSpec({
          gevRoot: config.GEV_ROOT,
          gevUrl: config.GEV_URL,
          wrapper: config.GEV_WRAPPER,
          command: config.GEV_CHILD_COMMAND,
          extraArgs: config.GEV_CHILD_ARGS,
        });
      const args = spec.args.includes('--allow')
        ? spec.args
        : [...spec.args, '--allow', allow.join(',')];
      opts = { ...spec, args };
    }
    const child = new GevChild({ ...opts, logger: logger.child({ component: 'gev' }) });
    child.on('catalog', (tools) =>
      core.registry.setGevTools(tools, makeGevCaller(child), config.TOOL_TIMEOUT_MS),
    );
    core.gev = child;
    void child.start();
  }

  const deps = { ...core };
  const app = createPublicApp(deps, bind(overrides.routes?.public ?? [], core));
  const privateApp = createPrivateApp(deps, bind(overrides.routes?.private ?? [], core));
  const uiApp = createUiApp(deps, bind(overrides.routes?.ui ?? [], core));
  const listen = (a: Express, port: number, host: string) =>
    new Promise<Server>((resolve, reject) => {
      const s = a.listen(port, host, () => resolve(s));
      s.once('error', reject);
    });
  const server = await listen(app, config.PORT, config.HOST);
  hardenServer(server);
  let privateServer: Server;
  let uiServer: Server;
  try {
    privateServer = await listen(privateApp, config.PRIVATE_PORT, config.PRIVATE_HOST);
    try {
      uiServer = await listen(uiApp, config.UI_PORT, config.uiHost);
    } catch (err) {
      privateServer.close();
      throw err;
    }
  } catch (err) {
    server.close();
    throw err;
  }
  hardenServer(privateServer);
  hardenServer(uiServer);
  const port = (server.address() as AddressInfo).port;
  const privatePort = (privateServer.address() as AddressInfo).port;
  const uiPort = (uiServer.address() as AddressInfo).port;
  const fmt = (h: string, p: number) =>
    `http://${h.includes(':') ? `[${h}]` : h === '0.0.0.0' ? '127.0.0.1' : h}:${p}`;

  const prune = setInterval(() => {
    try {
      core.locations.prune();
      core.tokens.prune();
      core.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(core.now());
      core.stepup.prune();
      core.audit.prune();
    } catch (err) {
      logger.warn('prune_failed', { error: (err as Error).message });
    }
  }, 10 * 60_000);
  prune.unref();
  core.locations.prune();
  core.audit.prune();

  logger.info('gateway_listening', {
    public: `${config.HOST}:${port}`,
    private: `${config.PRIVATE_HOST}:${privatePort}`,
    ui: `${config.uiHost}:${uiPort}`,
    mode: config.mode,
    login: config.loginProvider,
    public_authorize_fallback: config.publicAuthorize,
  });
  const closeServer = (s: Server) =>
    new Promise<void>((r) => {
      s.close(() => r());
      s.closeAllConnections();
    });
  return {
    ...core,
    app,
    privateApp,
    uiApp,
    server,
    privateServer,
    uiServer,
    port,
    url: fmt(config.HOST, port),
    privatePort,
    privateUrl: fmt(config.PRIVATE_HOST, privatePort),
    uiPort,
    uiUrl: fmt(config.uiHost, uiPort),
    async close() {
      clearInterval(prune);
      await core.gev?.stop();
      await Promise.all([closeServer(server), closeServer(privateServer), closeServer(uiServer)]);
      core.db.close();
    },
  };
}
