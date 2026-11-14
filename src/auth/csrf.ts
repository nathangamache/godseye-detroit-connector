/**
 * CSRF protection for HTML form POSTs: a random cookie (HttpOnly,
 * SameSite=Strict, Secure on https, __Host- prefix on https) plus a form token
 * = HMAC(secret, cookie | purpose | subject | binding). POSTs must also be same-origin.
 * `binding` ties a token to a step-up session (admin forms), so a token is useless once
 * that session ends or with any other session.
 */
import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { hmacB64url, safeEqual } from '../util/crypto.js';
import { getCookie, setCookie } from './cookies.js';

export class Csrf {
  readonly cookieName: string;

  constructor(
    private readonly secret: string,
    private readonly secure: boolean,
  ) {
    this.cookieName = secure ? '__Host-gw_csrf' : 'gw_csrf';
  }

  /** Ensures the cookie exists and returns a token for the given purpose. */
  issue(req: Request, res: Response, purpose: string, subject: string, binding = ''): string {
    let value = getCookie(req, this.cookieName);
    if (!value || !/^[A-Za-z0-9_-]{32,64}$/.test(value)) {
      value = randomBytes(32).toString('base64url');
      setCookie(res, this.cookieName, value, { secure: this.secure, maxAgeS: 12 * 3600 });
    }
    return hmacB64url(this.secret, `${value}|${purpose}|${subject}|${binding}`);
  }

  verify(req: Request, purpose: string, subject: string, token: unknown, binding = ''): boolean {
    const value = getCookie(req, this.cookieName);
    if (!value || typeof token !== 'string' || !token) return false;
    return safeEqual(hmacB64url(this.secret, `${value}|${purpose}|${subject}|${binding}`), token);
  }
}
