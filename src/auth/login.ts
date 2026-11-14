/**
 * Owner login. Providers:
 *   cf-access  (default/production): identity = verified Cf-Access-Jwt-Assertion for OWNER_EMAIL
 *   password   (local/dev fallback):  password + TOTP -> server-side session cookie
 *   none       nothing configured: every owner-only route refuses
 * Anyone may register an OAuth client; only the owner can approve one.
 */
import { randomBytes } from 'node:crypto';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { Audit } from '../audit.js';
import type { Config } from '../config.js';
import type { DB } from '../db.js';
import { ipOf, pageHeaders, rateLimit, sameOriginPost, type SecurityConfig } from '../http/security.js';
import { esc, page } from '../ui/html.js';
import type { RateLimiter } from '../util/ratelimit.js';
import { sha256hex } from '../util/crypto.js';
import type { CfAccessVerifier } from './cfAccess.js';
import { clearCookie, getCookie, setCookie } from './cookies.js';
import type { Csrf } from './csrf.js';
import { checkPasswordLogin, Lockout } from './password.js';

export interface Owner {
  subject: string;
  via: 'cf-access' | 'password';
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
  cf?: CfAccessVerifier;
  now: () => number;
}

export class Login {
  readonly kind: Config['loginProvider'];
  readonly sessionCookie: string;
  private readonly secure: boolean;
  private readonly lockout: Lockout;

  constructor(private readonly d: LoginDeps) {
    this.kind = d.config.loginProvider;
    this.secure = d.config.PUBLIC_ORIGIN.startsWith('https://');
    this.sessionCookie = this.secure ? '__Host-gw_session' : 'gw_session';
    this.lockout = new Lockout(d.db, undefined, d.now);
    if (this.kind === 'cf-access' && !d.cf) throw new Error('cf-access login needs a CfAccessVerifier');
  }

  async identify(req: Request): Promise<Owner | null> {
    if (this.kind === 'cf-access') {
      const h = req.headers['cf-access-jwt-assertion'];
      const id = await this.d.cf!.verify(Array.isArray(h) ? h[0] : h, this.d.now());
      return id ? { subject: id.email, via: 'cf-access' } : null;
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
      const nextPath = safeNext(req.originalUrl);
      res.redirect(302, `/auth/login?next=${encodeURIComponent(nextPath)}`);
      return;
    }
    if (this.kind === 'none') {
      res.status(503).send(page('Login not configured', '<h1>Login not configured</h1><p>This gateway has no owner login configured, so this page is unavailable.</p>'));
      return;
    }
    res.status(403).send(page('Sign in required', '<h1>Sign in required</h1><p>Open this page through the protected site address and sign in.</p>'));
  }

  install(app: Express): void {
    if (this.kind !== 'password') return;
    const urlencoded = express.urlencoded({ extended: false, limit: '4kb', parameterLimit: 10 });
    const limit = rateLimit(this.d.limiter, 'login', 10, 15 * 60_000, (req) => ipOf(req, this.d.sec));

    app.get('/auth/login', (req, res) => {
      pageHeaders(res);
      const token = this.d.csrf.issue(req, res, 'login', 'anon');
      const nextPath = safeNext(String(req.query.next ?? '/'));
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
        res.status(status).send(page('Sign in failed', '<h1>Sign in failed</h1><p>Invalid credentials, or too many attempts. Wait and <a href="/auth/login">try again</a>.</p>'));
      };
      if (!sameOriginPost(this.d.sec, req) || !this.d.csrf.verify(req, 'login', 'anon', req.body?.csrf)) return fail(403);
      if (this.lockout.isLocked(ip)) {
        this.d.audit.record('login_locked', { ip });
        return fail(429);
      }
      const ok = await checkPasswordLogin(
        this.d.db,
        { passwordHash: this.d.config.GATEWAY_PASSWORD_HASH!, totpSecret: this.d.config.GATEWAY_TOTP_SECRET! },
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
        .prepare('INSERT INTO sessions(id_hash, subject, provider, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
        .run(sha256hex(sid), 'owner', 'password', this.d.now(), this.d.now() + this.d.config.SESSION_TTL_S * 1000);
      setCookie(res, this.sessionCookie, sid, { secure: this.secure, maxAgeS: this.d.config.SESSION_TTL_S });
      this.d.audit.record('login_success', { ip, subject: 'owner' });
      res.redirect(303, safeNext(String(req.body?.next ?? '/')));
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

/** Only same-site relative paths (no //host, no backslashes, no scheme). */
export function safeNext(p: string): string {
  if (typeof p !== 'string' || !p.startsWith('/') || p.startsWith('//') || p.includes('\\') || /[\r\n]/.test(p)) return '/';
  return p.slice(0, 2000);
}
