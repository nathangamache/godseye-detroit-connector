/**
 * Owner login, per listener. Providers:
 *   tailscale  (private listener, default/production): identity = Tailscale-User-Login from the
 *              trusted tailscale serve proxy, must equal OWNER_TAILSCALE_LOGIN
 *   password   (dev/test, or the opt-in public authorize fallback): password + TOTP -> session cookie
 *   none       nothing configured: every owner-only route refuses
 * Anyone may register an OAuth client; only the owner can approve one.
 */
import { randomBytes } from 'node:crypto';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { Audit } from '../audit.js';
import type { Config } from '../config.js';
import type { DB } from '../db.js';
import {
  ipOf,
  pageHeaders,
  rateLimit,
  sameOriginPost,
  type SecurityConfig,
} from '../http/security.js';
import { esc, page } from '../ui/html.js';
import type { RateLimiter } from '../util/ratelimit.js';
import { sha256hex } from '../util/crypto.js';
import { tailscaleIdentity } from './tailscale.js';
import { clearCookie, getCookie, setCookie } from './cookies.js';
import type { Csrf } from './csrf.js';
import { checkPasswordLogin, Lockout } from './password.js';

export interface Owner {
  subject: string;
  via: 'tailscale' | 'password';
}

declare module 'express-serve-static-core' {
  interface Request {
    owner?: Owner;
  }
}

export interface LoginDeps {
  config: Config;
  db: DB;
  audit: Audit;
  csrf: Csrf;
  sec: SecurityConfig;
  limiter: RateLimiter;
  /** Which provider this listener uses. */
  kind: 'tailscale' | 'password' | 'none';
  /** Origin the browser sees for this listener (cookies are Secure when https). */
  origin: string;
  /** Where /auth/login lives when this listener has none (the UI listener; default: here). */
  loginOrigin?: string;
  /** Absolute origins a login may return to (the UI origin). */
  nextOrigins?: string[];
  now: () => number;
}

export class Login {
  readonly kind: LoginDeps['kind'];
  readonly sessionCookie: string;
  private readonly secure: boolean;
  private readonly lockout: Lockout;

  constructor(private readonly d: LoginDeps) {
    this.kind = d.kind;
    this.secure = d.origin.startsWith('https://');
    this.sessionCookie = this.secure ? '__Host-gw_session' : 'gw_session';
    this.lockout = new Lockout(d.db, undefined, d.now);
    if (this.kind === 'tailscale' && !d.config.ownerTailscaleLogin)
      throw new Error('tailscale login needs OWNER_TAILSCALE_LOGIN');
  }

  async identify(req: Request): Promise<Owner | null> {
    if (this.kind === 'tailscale') {
      const id = tailscaleIdentity(req, {
        trustedProxies: this.d.config.TAILSCALE_TRUSTED_PROXY_IPS,
        ownerLogin: this.d.config.ownerTailscaleLogin!,
      });
      return id ? { subject: id.login, via: 'tailscale' } : null;
    }
    if (this.kind === 'password') {
      const sid = getCookie(req, this.sessionCookie);
      if (!sid || !/^[A-Za-z0-9_-]{40,64}$/.test(sid)) return null;
      const row = this.d.db
        .prepare('SELECT subject FROM sessions WHERE id_hash = ? AND expires_at > ?')
        .get(sha256hex(sid), this.d.now()) as { subject: string } | undefined;
      return row ? { subject: row.subject, via: 'password' } : null;
    }
    return null;
  }

  /** Middleware for owner-only routes (UI, /oauth/authorize, consent, admin). */
  require() {
    return (req: Request, res: Response, next: NextFunction): void => {
      this.identify(req).then(
        (owner) => {
          if (owner) {
            req.owner = owner;
            next();
          } else this.challenge(req, res);
        },
        (err: unknown) => next(err),
      );
    };
  }

  challenge(req: Request, res: Response): void {
    pageHeaders(res);
    if (this.kind === 'password' && (req.method === 'GET' || req.method === 'HEAD')) {
      const here = this.d.loginOrigin && this.d.loginOrigin !== this.d.origin;
      const nextPath = here ? this.d.origin + safeNext(req.originalUrl) : safeNext(req.originalUrl);
      res.redirect(
        302,
        `${here ? this.d.loginOrigin : ''}/auth/login?next=${encodeURIComponent(nextPath)}`,
      );
      return;
    }
    if (this.kind === 'none') {
      res
        .status(503)
        .send(
          page(
            'Login not configured',
            '<h1>Login not configured</h1><p>This gateway has no owner login configured, so this page is unavailable.</p>',
          ),
        );
      return;
    }
    res
      .status(403)
      .send(
        page(
          'Tailscale required',
          '<h1>Not available here</h1><p>Open this page on a device signed in to your tailnet, at its tailnet address.</p>',
        ),
      );
  }

  install(app: Express): void {
    if (this.kind !== 'password') return;
    const urlencoded = express.urlencoded({ extended: false, limit: '4kb', parameterLimit: 10 });
    const limit = rateLimit(this.d.limiter, 'login', 10, 15 * 60_000, (req) =>
      ipOf(req, this.d.sec),
    );

    app.get('/auth/login', (req, res) => {
      pageHeaders(res);
      const token = this.d.csrf.issue(req, res, 'login', 'anon');
      const nextPath = safeNext(String(req.query.next ?? '/'), this.d.nextOrigins);
      res.send(
        page(
          'Sign in',
          `<h1>Sign in</h1>
<form class="card" method="post" action="/auth/login">
<input type="hidden" name="csrf" value="${esc(token)}">
<input type="hidden" name="next" value="${esc(nextPath)}">
<label for="pw">Password</label><input id="pw" type="password" name="password" autocomplete="current-password" required>
<label for="otp">Authenticator code</label><input id="otp" type="text" name="totp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" required>
<div class="row"><button type="submit">Sign in</button></div>
</form>`,
        ),
      );
    });

    app.post('/auth/login', limit, urlencoded, async (req, res) => {
      pageHeaders(res);
      const ip = ipOf(req, this.d.sec);
      const fail = (status: number) => {
        res
          .status(status)
          .send(
            page(
              'Sign in failed',
              '<h1>Sign in failed</h1><p>Invalid credentials, or too many attempts. Wait and <a href="/auth/login">try again</a>.</p>',
            ),
          );
      };
      if (
        !sameOriginPost(this.d.sec, req) ||
        !this.d.csrf.verify(req, 'login', 'anon', req.body?.csrf)
      )
        return fail(403);
      if (this.lockout.isLocked(ip)) {
        this.d.audit.record('login_locked', { ip });
        return fail(429);
      }
      const ok = await checkPasswordLogin(
        this.d.db,
        {
          passwordHash: this.d.config.GATEWAY_PASSWORD_HASH!,
          totpSecret: this.d.config.GATEWAY_TOTP_SECRET!,
        },
        String(req.body?.password ?? ''),
        String(req.body?.totp ?? ''),
        this.d.now(),
      );
      if (!ok) {
        this.lockout.fail(ip);
        this.d.audit.record('login_failed', { ip });
        await new Promise((r) => setTimeout(r, 250));
        return fail(401);
      }
      this.lockout.succeed(ip);
      const sid = randomBytes(32).toString('base64url');
      this.d.db
        .prepare(
          'INSERT INTO sessions(id_hash, subject, provider, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(
          sha256hex(sid),
          'owner',
          'password',
          this.d.now(),
          this.d.now() + this.d.config.SESSION_TTL_S * 1000,
        );
      setCookie(res, this.sessionCookie, sid, {
        secure: this.secure,
        maxAgeS: this.d.config.SESSION_TTL_S,
      });
      this.d.audit.record('login_success', { ip, subject: 'owner' });
      res.redirect(303, safeNext(String(req.body?.next ?? '/'), this.d.nextOrigins));
    });

    app.post('/auth/logout', urlencoded, (req, res) => {
      const sid = getCookie(req, this.sessionCookie);
      if (sameOriginPost(this.d.sec, req) && sid) {
        this.d.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(sha256hex(sid));
      }
      clearCookie(res, this.sessionCookie, this.secure);
      res.redirect(303, '/auth/login');
    });
  }
}

/**
 * Only same-site relative paths (no //host, no backslashes, no scheme), or an absolute URL
 * on one of `origins` (exact origin match).
 */
export function safeNext(p: string, origins: string[] = []): string {
  if (typeof p === 'string' && origins.length && !/[\r\n\\]/.test(p)) {
    try {
      const u = new URL(p);
      if (origins.includes(u.origin) && !u.username && !u.password) return u.href.slice(0, 2000);
    } catch {
      /* not absolute */
    }
  }
  if (
    typeof p !== 'string' ||
    !p.startsWith('/') ||
    p.startsWith('//') ||
    p.includes('\\') ||
    /[\r\n]/.test(p)
  )
    return '/';
  return p.slice(0, 2000);
}
