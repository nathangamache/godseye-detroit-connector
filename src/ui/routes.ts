/**
 * Owner-only UI: /pulse (static build or placeholder), optional /pulse/api
 * proxy, and the GEV globe at "/" (reverse proxy). Installed last.
 *
 * Shared nav injection into GEV's index.html is intentionally skipped: GEV's
 * CSP forbids inline scripts/styles, its UI owns the whole viewport, and an
 * overlay could hide its data-attribution credits. The nav lives on gateway
 * pages (/pulse, /locate, /oauth/admin) instead.
 */
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { AppContext } from '../app.js';
import type { Login } from '../auth/login.js';
import type { Config } from '../config.js';
import { pageHeaders } from '../http/security.js';
import type { Logger } from '../log.js';
import { page } from './html.js';
import { createProxy } from './proxy.js';

/** Gateway-owned path prefixes that must never fall through to GEV. */
export const RESERVED_PREFIXES = ['/oauth', '/auth/', '/api/location', '/locate', '/gw/', '/.well-known', '/mcp', '/healthz', '/pulse'];

export interface UiDeps {
  config: Config;
  login: Login;
  logger: Logger;
}

export function installUi(app: Express, _ctx: AppContext, d: UiDeps): void {
  const { config, login } = d;
  const owner = login.require();

  // ---- /pulse ----
  app.use((req, res, next) => (req.method === 'GET' && req.originalUrl.split('?')[0] === '/pulse' ? res.redirect(301, '/pulse/') : next()));
  if (config.PULSE_API_PROXY) {
    app.use(
      '/pulse/api',
      owner,
      createProxy({
        target: config.PULSE_URL,
        publicOrigin: config.PUBLIC_ORIGIN,
        stripPrefix: '/pulse/api',
        blockedPrefixes: ['/admin', '/audio', '/docs', '/openapi.json', '/redoc'],
        extraHeaders: config.PULSE_API_TOKEN ? { authorization: `Bearer ${config.PULSE_API_TOKEN}` } : {},
        logger: d.logger,
        unavailableHtml: page('Pulse unavailable', '<h1>Pulse is not running</h1>'),
      }) as unknown as express.RequestHandler,
    );
  }
  const staticDir = config.PULSE_STATIC_DIR;
  const hasPulseBuild = Boolean(staticDir && existsSync(path.join(staticDir, 'index.html')) && statSync(staticDir).isDirectory());
  if (hasPulseBuild) {
    app.use('/pulse/', owner, express.static(staticDir!, { index: 'index.html', dotfiles: 'deny', fallthrough: true }));
    app.get(/^\/pulse\/.*/, owner, (_req, res) => res.sendFile(path.join(staticDir!, 'index.html')));
  } else {
    app.get(/^\/pulse\/.*/, owner, (_req, res) => {
      pageHeaders(res);
      res.send(
        page(
          'Detroit Pulse',
          `<h1>Detroit Pulse</h1>
<div class="card"><p>Pulse isn't running on this server yet, so there is no scanner-radio map to show.</p>
<p class="muted">When a Pulse UI build exists, set <code>PULSE_STATIC_DIR</code> to its directory (built with <code>base: '/pulse/'</code>) and restart the gateway. The API contract is in <code>docs/pulse-api-contract.md</code>.</p></div>`,
          { nav: true },
        ),
      );
    });
  }

  // ---- reserved gateway paths never reach GEV ----
  app.use((req: Request, res: Response, next: NextFunction) => {
    const p = req.path.toLowerCase();
    if (RESERVED_PREFIXES.some((r) => p === r.replace(/\/$/, '') || p.startsWith(r))) {
      res.status(404).type('text/plain').send('Not found');
      return;
    }
    next();
  });

  // ---- "/" -> GEV preview ----
  if (config.GEV_PROXY_ENABLED) {
    const gev = createProxy({
      target: config.GEV_URL,
      publicOrigin: config.PUBLIC_ORIGIN,
      blockedPrefixes: config.GEV_BLOCKED_PATHS,
      logger: d.logger,
      unavailableHtml: page("God's Eye View unavailable", "<h1>God's Eye View is not running</h1><p>Start the GEV service and reload.</p>", { nav: true }),
    });
    app.use(owner, (req, res) => gev(req, res));
  }
}
