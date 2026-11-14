/** All HTTP route installers beyond the core (/healthz, metadata, /mcp). */
import path from 'node:path';
import express, { type Express } from 'express';
import type { JWTVerifyGetKey } from 'jose';
import type { AppContext } from './app.js';
import { CfAccessVerifier } from './auth/cfAccess.js';
import { Csrf } from './auth/csrf.js';
import { Login } from './auth/login.js';
import { REPO_ROOT } from './config.js';
import type { GatewayCore } from './gateway.js';
import { makeCimdFetcher, type CimdFetcher } from './oauth/cimd.js';
import { ClientRegistry } from './oauth/clients.js';
import { installOAuth } from './oauth/routes.js';
import { installLocation } from './location/routes.js';

export type RouteInstaller = (app: Express, ctx: AppContext, gw: GatewayCore) => void;

export interface RouteOptions {
  /** Test hook: replaces the SSRF-safe CIMD fetcher. */
  cimdFetch?: CimdFetcher;
  /** Test hook: a local JWKS for Cloudflare Access JWTs. */
  cfJwks?: JWTVerifyGetKey;
  /** Called with the built auth objects (tests). */
  onReady?: (parts: { login: Login; csrf: Csrf; clients: ClientRegistry }) => void;
}

export const WEB_ROOT = path.join(REPO_ROOT, 'web');

export function installAllRoutes(opts: RouteOptions = {}): RouteInstaller[] {
  return [
    (app, ctx, gw) => {
      const { config } = gw;
      const secure = config.PUBLIC_ORIGIN.startsWith('https://');
      // Public, non-sensitive assets for gateway pages (login page needs them before sign-in).
      app.use('/gw/static', express.static(path.join(WEB_ROOT, 'static'), { index: false, fallthrough: false, maxAge: '1h', dotfiles: 'deny' }));

      const csrf = new Csrf(gw.sessionSecret, secure);
      const cf = config.cfAccess ? new CfAccessVerifier({ ...config.cfAccess, jwks: opts.cfJwks }) : undefined;
      const login = new Login({ config, db: gw.db, audit: gw.audit, csrf, sec: ctx.sec, limiter: ctx.limiter, cf, now: gw.now });
      login.install(app);
      const clients = new ClientRegistry(gw.db, config, opts.cimdFetch ?? makeCimdFetcher(), gw.now);
      installOAuth(app, ctx, { config, audit: gw.audit, tokens: gw.tokens, clients, login, csrf, locations: gw.locations, now: gw.now });
      installLocation(app, ctx, { config, locations: gw.locations, audit: gw.audit, login, logger: gw.logger, webRoot: WEB_ROOT, now: gw.now });
      opts.onReady?.({ login, csrf, clients });
    },
  ];
}
