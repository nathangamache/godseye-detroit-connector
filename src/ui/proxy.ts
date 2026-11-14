/**
 * Reverse proxy from the authenticated public side to a loopback/internal
 * upstream (GEV preview at "/", optionally the Pulse API at /pulse/api).
 *
 * GEV's key-spending routes refuse any of nine proxy headers and compare Origin
 * with http://<Host>, so this proxy strips every proxy/Cloudflare header,
 * rewrites Host and Origin to the upstream origin and drops cookies and
 * Authorization. That makes every request look like the local owner to GEV,
 * which is why the gateway authenticates before it proxies and blocks GEV's
 * dangerous routes outright.
 */
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Logger } from '../log.js';

export const PROXY_SIGNAL_HEADERS = [
  'forwarded',
  'via',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-forwarded-proto',
  'x-real-ip',
  'cf-connecting-ip',
  'cf-ray',
];

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const ALWAYS_DROP = new Set([
  ...PROXY_SIGNAL_HEADERS,
  'authorization',
  'cookie',
  'referer',
  'true-client-ip',
  'cdn-loop',
  'x-forwarded-server',
  'x-original-forwarded-for',
]);

export interface ProxyOptions {
  target: string; // http://127.0.0.1:7701
  publicOrigin: string;
  blockedPrefixes: string[];
  /** Strip this prefix from the path before forwarding (e.g. /pulse/api). */
  stripPrefix?: string;
  timeoutMs?: number;
  maxBodyBytes?: number;
  extraHeaders?: Record<string, string>;
  logger: Logger;
  unavailableHtml?: string;
}

/** Normalizes a request path and rejects traversal / encoded separators. Returns null if unsafe. */
export function safePath(rawUrl: string): { path: string; search: string } | null {
  const q = rawUrl.indexOf('?');
  const rawPath = q >= 0 ? rawUrl.slice(0, q) : rawUrl;
  const search = q >= 0 ? rawUrl.slice(q) : '';
  if (!rawPath.startsWith('/')) return null;
  if (/%2f|%5c|%00|\\/i.test(rawPath)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (decoded.split('/').some((seg) => seg === '..' || seg === '.')) return null;
  return { path: rawPath.replace(/\/{2,}/g, '/'), search };
}

export function isBlocked(path: string, prefixes: string[]): boolean {
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return true;
  }
  const p = decoded.toLowerCase();
  // Plain prefix match: over-blocking (e.g. /mcpx) is acceptable, under-blocking is not.
  return prefixes.some((b) => p.startsWith(b.toLowerCase()));
}

export function upstreamHeaders(
  incoming: IncomingHttpHeaders,
  target: URL,
  publicOrigin: string,
  extra: Record<string, string> = {},
): Record<string, string | string[]> | { forbidden: string } {
  const out: Record<string, string | string[]> = {};
  const connectionTokens = String(incoming.connection ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  for (const [k, v] of Object.entries(incoming)) {
    const key = k.toLowerCase();
    if (v === undefined) continue;
    if (HOP_BY_HOP.has(key) || connectionTokens.includes(key) || ALWAYS_DROP.has(key)) continue;
    if (key.startsWith('cf-') || key === 'host' || key === 'origin') continue;
    out[key] = v;
  }
  out.host = target.host;
  const origin = incoming.origin;
  if (origin) {
    if (origin === publicOrigin || origin === target.origin) out.origin = target.origin;
    else return { forbidden: 'cross-origin request' };
  }
  for (const [k, v] of Object.entries(extra)) out[k.toLowerCase()] = v;
  return out;
}

export function createProxy(opts: ProxyOptions) {
  const target = new URL(opts.target);
  const maxBody = opts.maxBodyBytes ?? 5 * 1024 * 1024;
  return (req: IncomingMessage & { originalUrl?: string }, res: ServerResponse): void => {
    const sp = safePath(req.originalUrl ?? req.url ?? '/');
    if (!sp) {
      res.writeHead(400, { 'content-type': 'text/plain' }).end('Bad request');
      return;
    }
    if (isBlocked(sp.path, opts.blockedPrefixes)) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }
    let forwardPath = sp.path;
    if (opts.stripPrefix) {
      if (!forwardPath.startsWith(opts.stripPrefix)) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
        return;
      }
      forwardPath = forwardPath.slice(opts.stripPrefix.length) || '/';
      if (isBlocked(forwardPath, opts.blockedPrefixes)) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
        return;
      }
    }
    const headers = upstreamHeaders(req.headers, target, opts.publicOrigin, opts.extraHeaders);
    if ('forbidden' in headers) {
      res.writeHead(403, { 'content-type': 'text/plain' }).end('Forbidden');
      return;
    }
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > maxBody) {
      res.writeHead(413, { 'content-type': 'text/plain' }).end('Payload too large');
      return;
    }
    const isStream =
      String(req.headers.accept ?? '').includes('text/event-stream') || /\/events(\/|$)/.test(forwardPath);
    const upstream = httpRequest(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        method: req.method,
        path: forwardPath + sp.search,
        headers,
      },
      (up) => {
        const outHeaders: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(up.headers)) {
          if (v === undefined || HOP_BY_HOP.has(k)) continue;
          outHeaders[k] = v;
        }
        const loc = up.headers.location;
        if (typeof loc === 'string' && loc.startsWith(target.origin)) {
          outHeaders.location = opts.publicOrigin + (opts.stripPrefix ?? '') + loc.slice(target.origin.length);
        }
        res.writeHead(up.statusCode ?? 502, outHeaders);
        if (String(up.headers['content-type'] ?? '').includes('text/event-stream')) res.flushHeaders();
        up.pipe(res);
        up.on('error', () => res.destroy());
      },
    );
    if (!isStream) {
      upstream.setTimeout(opts.timeoutMs ?? 60_000, () => upstream.destroy(new Error('upstream timeout')));
    }
    upstream.on('error', (err) => {
      opts.logger.warn('proxy_upstream_error', { target: target.host, error: err.message });
      if (!res.headersSent) {
        res
          .writeHead(502, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
          .end(opts.unavailableHtml ?? 'Upstream unavailable');
      } else res.destroy();
    });
    res.on('close', () => upstream.destroy());
    let seen = 0;
    req.on('data', (chunk: Buffer) => {
      seen += chunk.length;
      if (seen > maxBody) {
        upstream.destroy(new Error('request body too large'));
        if (!res.headersSent) res.writeHead(413, { 'content-type': 'text/plain' }).end('Payload too large');
        req.destroy();
      }
    });
    req.pipe(upstream);
  };
}
