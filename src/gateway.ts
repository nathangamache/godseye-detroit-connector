/** Wires storage, tool backends, the MCP surface and HTTP routes into a running gateway. */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Express } from 'express';
import { createApp, hardenServer, type AppContext } from './app.js';
import { Audit } from './audit.js';
import type { Config } from './config.js';
import { kvGet, kvSet, openDb, type DB } from './db.js';
import { GevChild, childSpawnSpec } from './gev/child.js';
import { makeGevCaller } from './gev/tools.js';
import { LocationStore } from './location/store.js';
import { createLogger, type Logger } from './log.js';
import { TokenStore } from './oauth/tokens.js';
import { RailIndex } from './rail/index.js';
import { railTools } from './rail/tools.js';
import { ToolPolicy } from './tools/policy.js';
import { ToolRegistry } from './tools/registry.js';
import { ToolRunner } from './tools/runner.js';
import type { ToolDef } from './tools/types.js';
import { RateLimiter } from './util/ratelimit.js';

export interface GatewayOverrides {
  logger?: Logger;
  now?: () => number;
  /** Replace the GEV child command (tests use a mock MCP server). */
  gevChild?: { command: string; args: string[]; cwd: string; env: Record<string, string> } | false;
  /** Extra tools to register (tests). */
  extraTools?: ToolDef[];
  /** Additional route installers. */
  mount?: Array<(app: Express, ctx: AppContext, gw: GatewayCore) => void>;
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
  gev?: GevChild;
  rail?: RailIndex;
  now: () => number;
}

export interface Gateway extends GatewayCore {
  app: Express;
  server: Server;
  port: number;
  url: string;
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
      publicOrigin: config.PUBLIC_ORIGIN,
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
    logger.info('rail_data_loaded', { lines: rail.lines.length, crossings: rail.crossings.length, as_of: rail.datasetAsOf() });
  } else {
    logger.warn('rail_data_missing', { dir: config.RAIL_DATA_DIR });
  }
  for (const t of overrides.extraTools ?? []) registry.register(t);
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
    sessionSecret: sessionSecretFor(config, db),
    rail,
    now,
  };
}

export async function startGateway(config: Config, overrides: GatewayOverrides = {}): Promise<Gateway> {
  const core = buildCore(config, overrides);
  const { logger } = core;

  if (config.GEV_MCP_ENABLED && overrides.gevChild !== false) {
    const spec =
      overrides.gevChild ??
      childSpawnSpec({
        gevRoot: config.GEV_ROOT,
        gevUrl: config.GEV_URL,
        wrapper: config.GEV_WRAPPER,
        command: config.GEV_CHILD_COMMAND,
        extraArgs: config.GEV_CHILD_ARGS,
      });
    const child = new GevChild({ ...spec, logger: logger.child({ component: 'gev' }) });
    child.on('catalog', (tools) => core.registry.setGevTools(tools, makeGevCaller(child), config.TOOL_TIMEOUT_MS));
    core.gev = child;
    void child.start();
  }

  const app = createApp({
    ...core,
    mount: (overrides.mount ?? []).map((m) => (a: Express, ctx: AppContext) => m(a, ctx, core)),
  });
  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(config.PORT, config.HOST, () => resolve(s));
    s.once('error', reject);
  });
  hardenServer(server);
  const port = (server.address() as AddressInfo).port;

  const prune = setInterval(() => {
    try {
      core.locations.prune();
      core.tokens.prune();
      core.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(core.now());
      core.audit.prune();
    } catch (err) {
      logger.warn('prune_failed', { error: (err as Error).message });
    }
  }, 10 * 60_000);
  prune.unref();
  core.locations.prune();

  logger.info('gateway_listening', { host: config.HOST, port, mode: config.mode, login: config.loginProvider });
  return {
    ...core,
    app,
    server,
    port,
    url: `http://${config.HOST.includes(':') ? `[${config.HOST}]` : config.HOST}:${port}`,
    async close() {
      clearInterval(prune);
      await core.gev?.stop();
      await new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      });
      core.db.close();
    },
  };
}
