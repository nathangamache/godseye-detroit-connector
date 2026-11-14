/** Cross-cutting HTTP protections: headers, Host/Origin checks, rate limits, body caps. */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { clientIp } from '../util/net.js';
import type { RateLimiter } from '../util/ratelimit.js';

export interface SecurityConfig {
  allowedHosts: string[];
  publicOrigin: string;
  trustedProxies: string[];
  hsts: boolean;
}

/** Baseline headers on every response the gateway itself produces. */
export function baseHeaders(cfg: SecurityConfig): RequestHandler {
  return (_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (cfg.hsts) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  };
}

/** Strict CSP for gateway HTML pages (login, consent, admin, locate, placeholders). */
export function pageHeaders(res: Response, extraFormAction: string[] = []): void {
  const formAction = ["'self'", ...extraFormAction].join(' ');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "manifest-src 'self'",
      "worker-src 'self'",
      "font-src 'self'",
      `form-action ${formAction}`,
      "frame-ancestors 'none'",
      "base-uri 'none'",
    ].join('; '),
  );
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'no-store');
}

export function hostOf(req: Request): string {
  const h = req.headers.host ?? '';
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.split(':')[0]!.toLowerCase();
}

/** Rejects requests whose Host header is not one of ours (DNS rebinding, stray traffic). */
export function hostCheck(cfg: SecurityConfig): RequestHandler {
  const allowed = new Set(cfg.allowedHosts.map((h) => h.toLowerCase()));
  return (req, res, next) => {
    if (!allowed.has(hostOf(req))) {
      res.status(421).type('text/plain').send('Misdirected request');
      return;
    }
    next();
  };
}

export function isLoopbackOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]');
  } catch {
    return false;
  }
}

/** For /mcp: an Origin header, when present, must be ours or loopback (MCP transport spec). */
export function mcpOriginCheck(cfg: SecurityConfig): RequestHandler {
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && origin !== cfg.publicOrigin && !isLoopbackOrigin(origin)) {
      res.status(403).json({ error: 'forbidden_origin' });
      return;
    }
    next();
  };
}

/**
 * For state-changing form POSTs: the request must be same-origin.
 * Browsers always send Origin on POST; Sec-Fetch-Site is checked when present.
 */
export function sameOriginPost(cfg: SecurityConfig, req: Request): boolean {
  const origin = req.headers.origin;
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin') return false;
  if (!origin) return false;
  return origin === cfg.publicOrigin || origin === `${req.protocol}://${req.headers.host}`;
}

export function ipOf(req: Request, cfg: SecurityConfig): string {
  return clientIp(req, cfg.trustedProxies);
}

export function rateLimit(
  limiter: RateLimiter,
  name: string,
  limit: number,
  windowMs: number,
  keyFn: (req: Request) => string,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const r = limiter.hit(`http:${name}:${keyFn(req)}`, limit, windowMs);
    if (!r.ok) {
      res.setHeader('Retry-After', String(Math.ceil(r.retryAfterMs / 1000)));
      res.status(429).json({ error: 'rate_limited', error_description: 'Too many requests' });
      return;
    }
    next();
  };
}

/** Rejects bodies larger than maxBytes based on Content-Length (streams are capped by parsers). */
export function contentLengthCap(maxBytes: number): RequestHandler {
  return (req, res, next) => {
    const len = Number(req.headers['content-length'] ?? 0);
    if (len > maxBytes) {
      res.status(413).json({ error: 'payload_too_large' });
      return;
    }
    next();
  };
}
