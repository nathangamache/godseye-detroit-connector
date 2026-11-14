/**
 * Express application. Route map (public = reachable without Cloudflare Access):
 *
 *   GET  /healthz                                   public, {ok:true} only
 *   GET  /.well-known/oauth-protected-resource[/mcp] public metadata
 *   GET  /.well-known/oauth-authorization-server     public metadata
 *   *    /mcp                                        OAuth bearer token (audience-bound)
 *   POST /oauth/token | /oauth/register | /oauth/revoke   public OAuth endpoints (own auth)
 *   GET  /oauth/authorize, POST /oauth/authorize/decision, /oauth/admin, /auth/*  owner login
 *   POST /api/location                              device token
 *   /locate, /pulse, / (GEV proxy)                  owner login (UI)
 */
import type { Server } from 'node:http';
import express, { type Express, type Request, type Response } from 'express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { Audit } from './audit.js';
import { bearerAuth } from './auth/bearer.js';
import type { Config } from './config.js';
import type { DB } from './db.js';
import {
  baseHeaders,
  contentLengthCap,
  hostCheck,
  ipOf,
  mcpOriginCheck,
  rateLimit,
  type SecurityConfig,
} from './http/security.js';
import type { LocationStore } from './location/store.js';
import type { Logger } from './log.js';
import { createMcpHttpHandler } from './mcp/server.js';
import type { TokenStore } from './oauth/tokens.js';
import type { ToolRunner } from './tools/runner.js';
import { RateLimiter } from './util/ratelimit.js';

export interface AppDeps {
  config: Config;
  db: DB;
  logger: Logger;
  audit: Audit;
  tokens: TokenStore;
  locations: LocationStore;
  runner: ToolRunner;
  limiter?: RateLimiter;
  /** Extra route installers (OAuth AS, location ingest, UI) mounted before the fallback. */
  mount?: Array<(app: Express, ctx: AppContext) => void>;
}

export interface AppContext {
  sec: SecurityConfig;
  limiter: RateLimiter;
}

export function securityConfig(config: Config): SecurityConfig {
  return {
    allowedHosts: config.allowedHosts,
    publicOrigin: config.PUBLIC_ORIGIN,
    trustedProxies: config.TRUSTED_PROXY_IPS,
    hsts: config.PUBLIC_ORIGIN.startsWith('https://'),
  };
}

export function protectedResourceMetadata(config: Config) {
  return {
    resource: config.mcpResource,
    authorization_servers: [config.issuer],
    scopes_supported: ['mcp'],
    bearer_methods_supported: ['header'],
    resource_name: "God's Eye View + Detroit Pulse",
  };
}

export function createApp(deps: AppDeps): Express {
  const { config } = deps;
  const app = express();
  const sec = securityConfig(config);
  const limiter = deps.limiter ?? new RateLimiter();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.set('etag', false);

  app.use(baseHeaders(sec));
  app.use(hostCheck(sec));
  // Coarse per-IP ceiling for everything (Cloudflare rate-limits too).
  app.use(rateLimit(limiter, 'all', 1200, 60_000, (req) => ipOf(req, sec)));

  app.get('/healthz', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ ok: true });
  });

  const prm = protectedResourceMetadata(config);
  const sendPrm = (_req: Request, res: Response) => {
    res.set('Cache-Control', 'public, max-age=300').json(prm);
  };
  app.get('/.well-known/oauth-protected-resource', sendPrm);
  app.get('/.well-known/oauth-protected-resource/mcp', sendPrm);

  // ---- MCP ----
  const mcpHandler = toNodeHandler(
    createMcpHttpHandler({ config, runner: deps.runner, locations: deps.locations }),
    { maxRequestBodySize: 256 * 1024 },
  );
  const bearer = bearerAuth({
    tokens: deps.tokens,
    resource: config.mcpResource,
    resourceMetadataUrl: `${config.issuer}/.well-known/oauth-protected-resource`,
    requiredScope: 'mcp',
  });
  app.all(
    '/mcp',
    mcpOriginCheck(sec),
    rateLimit(limiter, 'mcp-ip', 300, 60_000, (req) => ipOf(req, sec)),
    contentLengthCap(256 * 1024),
    bearer,
    rateLimit(limiter, 'mcp-token', 120, 60_000, (req) => req.auth?.extra.familyId ?? 'none'),
    (req, res) => {
      if (req.method !== 'POST') {
        res.status(405).set('Allow', 'POST').json({ error: 'method_not_allowed' });
        return;
      }
      mcpHandler(req, res).catch((err: unknown) => {
        deps.logger.error('mcp_handler_error', { error: err instanceof Error ? err.message : String(err) });
        if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
      });
    },
  );

  for (const m of deps.mount ?? []) m(app, { sec, limiter });

  app.use((_req, res) => {
    res.status(404).type('text/plain').send('Not found');
  });
  app.use((err: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
    const status = (err as { status?: number }).status ?? 500;
    if (status >= 500) deps.logger.error('http_error', { error: err instanceof Error ? err.message : String(err) });
    if (!res.headersSent) res.status(status).json({ error: status === 413 ? 'payload_too_large' : 'request_error' });
  });
  return app;
}

/** Node server timeouts: bounded request intake; responses may stream up to the tool timeout. */
export function hardenServer(server: Server): void {
  server.requestTimeout = 60_000;
  server.headersTimeout = 20_000;
  server.keepAliveTimeout = 65_000;
  server.maxHeadersCount = 100;
}
