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
 * PRIVATE listener (PRIVATE_PORT on PRIVATE_HOST: 127.0.0.2 in production, reached only
 * through tailscale serve on https 443, which connects from 127.0.0.1):
 *   /oauth/authorize, consent, /oauth/admin, /oauth/stepup, /locate, /api/location (for the
 *   PWA), login pages in dev. Identity: Tailscale-User-Login from the trusted proxy.
 *
 * UI listener (UI_PORT on UI_HOST, tailscale serve on https 8443: a different origin):
 *   / (GEV globe, reverse proxy), /pulse. Third-party UI code and data render here, so they
 *   can't script the owner pages above (cross-origin: no reads, and POSTs fail the Origin
 *   check).
 *
 * Client IPs: CF-Connecting-IP is honoured only on the public listener and only from
 * TRUSTED_PROXY_IPS (cloudflared's fixed address). The private listener never trusts a
 * forwarding header; its client address is the TCP peer.
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
import { rateKeyIp } from './util/net.js';
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

export type Listener = 'public' | 'private' | 'ui';

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
  if (listener === 'ui') {
    return {
      allowedHosts: config.uiAllowedHosts,
      publicOrigin: config.uiOrigin,
      trustedProxies: [],
      clientIpHeader: 'x-forwarded-for',
      hsts: config.uiOrigin.startsWith('https://'),
    };
  }
  return {
    allowedHosts: config.privateAllowedHosts,
    publicOrigin: config.privateOrigin,
    // No forwarding header is trusted on the private side: anything that reaches it arrives
    // from 127.0.0.1, which is also where netstack-forwarded tailnet connections come from.
    trustedProxies: [],
    clientIpHeader: 'x-forwarded-for',
    hsts: config.privateOrigin.startsWith('https://'),
  };
}

/** Per-IP and per-grant /mcp limits (requests, and messages inside a legacy batch). */
export const MCP_IP_PER_MIN = 300;
export const MCP_GRANT_PER_MIN = 120;
/** Largest JSON-RPC batch accepted, and only for protocol versions that had batching. */
export const MCP_MAX_BATCH = 10;
/** "" = no MCP-Protocol-Version header, which the spec says means 2025-03-26. */
const BATCH_PROTOCOL_VERSIONS = new Set(['', '2025-03-26', '2024-11-05']);

const jsonRpcError = (code: number, message: string) => ({
  jsonrpc: '2.0',
  error: { code, message },
  id: null,
});

const mcpGrantKey = (req: Request) => req.auth?.extra.familyId ?? 'none';

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
    createMcpHttpHandler({
      config,
      runner: deps.runner,
      locations: deps.locations,
      audit: deps.audit,
      tokens: deps.tokens,
    }),
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
  const mcpJson = express.json({ limit: 256 * 1024, type: ['application/json'] });
  app.all(
    '/mcp',
    mcpOriginCheck(sec),
    rateLimit(limiter, 'mcp-ip', MCP_IP_PER_MIN, 60_000, (req) => ipOf(req, sec)),
    contentLengthCap(256 * 1024),
    bearer,
    rateLimit(limiter, 'mcp-token', MCP_GRANT_PER_MIN, 60_000, (req) => mcpGrantKey(req)),
    (req, res, next) => {
      if (req.method !== 'POST') {
        res.status(405).set('Allow', 'POST').json({ error: 'method_not_allowed' });
        return;
      }
      mcpJson(req, res, (err?: unknown) => {
        if (err) {
          const status = (err as { status?: number }).status === 413 ? 413 : 400;
          res
            .status(status)
            .json(jsonRpcError(-32700, status === 413 ? 'Payload too large' : 'Parse error'));
          return;
        }
        next();
      });
    },
    (req, res, next) => {
      // JSON-RPC batches (review: rate-limit amplification). Protocol versions from
      // 2025-06-18 removed batching, so a batch there is refused. Older (or unstated)
      // versions get small batches, and every message counts against the same limits.
      const body: unknown = req.body;
      if (!Array.isArray(body)) return next();
      const v = String(req.headers['mcp-protocol-version'] ?? '');
      if (!BATCH_PROTOCOL_VERSIONS.has(v)) {
        res
          .status(400)
          .json(
            jsonRpcError(-32600, 'JSON-RPC batches are not supported in this protocol version'),
          );
        return;
      }
      if (body.length > MCP_MAX_BATCH) {
        res
          .status(400)
          .json(jsonRpcError(-32600, `A batch may hold at most ${MCP_MAX_BATCH} messages`));
        return;
      }
      for (let i = 1; i < body.length; i++) {
        const a = limiter.hit(`http:mcp-ip:${rateKeyIp(ipOf(req, sec))}`, MCP_IP_PER_MIN, 60_000);
        const b = limiter.hit(`http:mcp-token:${mcpGrantKey(req)}`, MCP_GRANT_PER_MIN, 60_000);
        if (!a.ok || !b.ok) {
          res.setHeader(
            'Retry-After',
            String(Math.ceil(Math.max(a.retryAfterMs, b.retryAfterMs) / 1000)),
          );
          res.status(429).json({ error: 'rate_limited', error_description: 'Too many requests' });
          return;
        }
      }
      next();
    },
    (req, res) => {
      mcpHandler(req, res, req.body as unknown).catch((err: unknown) => {
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

export function createUiApp(deps: AppDeps, mounts: Mount[] = []): Express {
  const sec = securityConfig(deps.config, 'ui');
  const limiter = deps.limiter ?? new RateLimiter();
  const app = baseApp(sec, limiter);
  for (const m of mounts) m(app, { listener: 'ui', sec, limiter });
  return finish(app, deps.logger);
}

/** Node server timeouts: bounded request intake; responses may stream up to the tool timeout. */
export function hardenServer(server: Server): void {
  server.requestTimeout = 60_000;
  server.headersTimeout = 20_000;
  server.keepAliveTimeout = 65_000;
  server.maxHeadersCount = 100;
}
