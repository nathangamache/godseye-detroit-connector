/**
 * Two Express applications on two listeners.
 *
 * PUBLIC listener (PORT, reached only through the Cloudflare Tunnel). Routes ONLY:
 *   GET  /healthz                                     {ok:true}
 *   GET  /.well-known/oauth-protected-resource[/mcp]   RFC 9728 metadata
 *   GET  /.well-known/oauth-authorization-server       RFC 8414 metadata
 *   *    /mcp                                          OAuth bearer token (audience-bound)
 *   POST /oauth/token | /oauth/register | /oauth/revoke
 *   POST /api/location                                device token
 *   (+ /oauth/authorize and /auth/login only in the opt-in PUBLIC_AUTHORIZE_FALLBACK mode)
 * Everything else: 404.
 *
 * PRIVATE listener (PRIVATE_PORT on 127.0.0.1, reached only through tailscale serve):
 *   /, /pulse, /locate, /oauth/authorize, consent, /oauth/admin, /api/location (for the PWA),
 *   login pages in dev. Identity: Tailscale-User-Login from the trusted proxy.
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
}

export type Listener = 'public' | 'private';

export interface AppContext {
  listener: Listener;
  sec: SecurityConfig;
  limiter: RateLimiter;
}

export type Mount = (app: Express, ctx: AppContext) => void;

export function securityConfig(config: Config, listener: Listener): SecurityConfig {
  if (listener === 'public') {
    return {
      allowedHosts: config.allowedHosts,
      publicOrigin: config.PUBLIC_ORIGIN,
      trustedProxies: config.TRUSTED_PROXY_IPS,
      clientIpHeader: 'cf-connecting-ip',
      hsts: config.PUBLIC_ORIGIN.startsWith('https://'),
    };
  }
  return {
    allowedHosts: config.privateAllowedHosts,
    publicOrigin: config.privateOrigin,
    trustedProxies: config.TAILSCALE_TRUSTED_PROXY_IPS,
    clientIpHeader: 'x-forwarded-for',
    hsts: config.privateOrigin.startsWith('https://'),
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

function baseApp(sec: SecurityConfig, limiter: RateLimiter): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.set('etag', false);
  app.use(baseHeaders(sec));
  app.use(hostCheck(sec));
  app.use(rateLimit(limiter, 'all', 1200, 60_000, (req) => ipOf(req, sec)));
  app.get('/healthz', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ ok: true });
  });
  return app;
}

function finish(app: Express, logger: Logger): Express {
  app.use((_req, res) => {
    res.status(404).type('text/plain').send('Not found');
  });
  app.use((err: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
    const status = (err as { status?: number }).status ?? 500;
    if (status >= 500)
      logger.error('http_error', { error: err instanceof Error ? err.message : String(err) });
    if (!res.headersSent)
      res.status(status).json({ error: status === 413 ? 'payload_too_large' : 'request_error' });
  });
  return app;
}

export function createPublicApp(deps: AppDeps, mounts: Mount[] = []): Express {
  const { config } = deps;
  const sec = securityConfig(config, 'public');
  const limiter = deps.limiter ?? new RateLimiter();
  const app = baseApp(sec, limiter);

  const prm = protectedResourceMetadata(config);
  const sendPrm = (_req: Request, res: Response) => {
    res.set('Cache-Control', 'public, max-age=300').json(prm);
  };
  app.get('/.well-known/oauth-protected-resource', sendPrm);
  app.get('/.well-known/oauth-protected-resource/mcp', sendPrm);

  const mcpHandler = toNodeHandler(
    createMcpHttpHandler({ config, runner: deps.runner, locations: deps.locations }),
    {
      maxRequestBodySize: 256 * 1024,
    },
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
        deps.logger.error('mcp_handler_error', {
          error: err instanceof Error ? err.message : String(err),
        });
        if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
      });
    },
  );

  for (const m of mounts) m(app, { listener: 'public', sec, limiter });
  return finish(app, deps.logger);
}

export function createPrivateApp(deps: AppDeps, mounts: Mount[] = []): Express {
  const sec = securityConfig(deps.config, 'private');
  const limiter = deps.limiter ?? new RateLimiter();
  const app = baseApp(sec, limiter);
  for (const m of mounts) m(app, { listener: 'private', sec, limiter });
  return finish(app, deps.logger);
}

/** Node server timeouts: bounded request intake; responses may stream up to the tool timeout. */
export function hardenServer(server: Server): void {
  server.requestTimeout = 60_000;
  server.headersTimeout = 20_000;
  server.keepAliveTimeout = 65_000;
  server.maxHeadersCount = 100;
}
