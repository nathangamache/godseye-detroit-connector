/** Route installers for the public and private listeners. */
import path from 'node:path';
import express, { type Express } from 'express';
import type { AppContext, Mount } from './app.js';
import { Csrf } from './auth/csrf.js';
import { Login } from './auth/login.js';
import { REPO_ROOT } from './config.js';
import type { GatewayCore } from './gateway.js';
import { installLocate, installLocationIngest } from './location/routes.js';
import { makeCimdFetcher, type CimdFetcher } from './oauth/cimd.js';
import { ClientRegistry } from './oauth/clients.js';
import { createOAuthRoutes } from './oauth/routes.js';
import { installUi } from './ui/routes.js';

export type RouteInstaller = (app: Express, ctx: AppContext, gw: GatewayCore) => void;

export interface RouteSet {
  public: RouteInstaller[];
  private: RouteInstaller[];
}

export interface RouteOptions {
  /** Test hook: replaces the SSRF-safe CIMD fetcher. */
  cimdFetch?: CimdFetcher;
  /** Called with the built objects (tests). */
  onReady?: (parts: { clients: ClientRegistry }) => void;
}

export const WEB_ROOT = path.join(REPO_ROOT, 'web');

const staticAssets = () =>
  express.static(path.join(WEB_ROOT, 'static'), {
    index: false,
    fallthrough: false,
    maxAge: '1h',
    dotfiles: 'deny',
  });

export function installAllRoutes(opts: RouteOptions = {}): RouteSet {
  // Shared between both listeners; built lazily from the gateway core.
  let shared: { clients: ClientRegistry; oauth: ReturnType<typeof createOAuthRoutes> } | undefined;
  const get = (gw: GatewayCore) => {
    if (!shared) {
      const clients = new ClientRegistry(
        gw.db,
        gw.config,
        opts.cimdFetch ?? makeCimdFetcher(),
        gw.now,
      );
      const oauth = createOAuthRoutes({
        config: gw.config,
        audit: gw.audit,
        tokens: gw.tokens,
        clients,
        locations: gw.locations,
        stepup: gw.stepup,
        now: gw.now,
      });
      shared = { clients, oauth };
      opts.onReady?.({ clients });
    }
    return shared;
  };
  const loginFor = (gw: GatewayCore, ctx: AppContext, kind: Login['kind']) => {
    const csrf = new Csrf(gw.sessionSecret, ctx.sec.publicOrigin.startsWith('https://'));
    const login = new Login({
      config: gw.config,
      db: gw.db,
      audit: gw.audit,
      csrf,
      sec: ctx.sec,
      limiter: ctx.limiter,
      kind,
      origin: ctx.sec.publicOrigin,
      now: gw.now,
    });
    return { csrf, login };
  };
  const locationDeps = (gw: GatewayCore) => ({
    config: gw.config,
    locations: gw.locations,
    audit: gw.audit,
    logger: gw.logger,
    webRoot: WEB_ROOT,
    now: gw.now,
  });

  return {
    public: [
      (app, ctx, gw) => {
        const { oauth } = get(gw);
        oauth.endpoints(app, ctx);
        installLocationIngest(app, ctx, locationDeps(gw));
        if (gw.config.publicAuthorize) {
          // FALLBACK mode (off by default): authorize + consent on the public host behind password+TOTP.
          app.use('/gw/static', staticAssets());
          const { csrf, login } = loginFor(gw, ctx, 'password');
          login.install(app);
          oauth.authorize(app, ctx, login, csrf);
        }
      },
    ],
    private: [
      (app, ctx, gw) => {
        const { oauth } = get(gw);
        app.use('/gw/static', staticAssets());
        const { csrf, login } = loginFor(gw, ctx, gw.config.loginProvider);
        login.install(app);
        oauth.authorize(app, ctx, login, csrf);
        oauth.admin(app, ctx, login, csrf);
        installLocationIngest(app, ctx, locationDeps(gw));
        installLocate(app, ctx, locationDeps(gw), login);
        // Must be last: "/" falls through to the GEV reverse proxy.
        installUi(app, ctx, { config: gw.config, login, logger: gw.logger });
      },
    ],
  };
}

export function bind(installers: RouteInstaller[], gw: GatewayCore): Mount[] {
  return installers.map((i) => (app: Express, ctx: AppContext) => i(app, ctx, gw));
}
