/**
 * Client ID Metadata Document fetcher with SSRF protection.
 *  - only https URLs on port 443, no credentials, no fragment
 *  - DNS is resolved once; every address must be public (no private, loopback,
 *    link-local, CGNAT, multicast or reserved ranges), and the TCP connection is
 *    pinned to the validated address (no DNS-rebinding window)
 *  - no redirects, 5 s timeout, 64 KB body cap, JSON only
 * The gateway additionally only fetches client_id URLs on CIMD_ALLOWED_CLIENT_IDS.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { request } from 'node:https';
import type { LookupAddress } from 'node:dns';
import { isPrivateIp } from '../util/net.js';

export interface FetchedDoc {
  body: string;
  maxAgeS?: number;
}

export type CimdFetcher = (url: string) => Promise<FetchedDoc>;

export class CimdFetchError extends Error {}

export type Resolver = (host: string) => Promise<LookupAddress[]>;

const defaultResolver: Resolver = (host) => dnsLookup(host, { all: true, verbatim: true });

export function checkCimdUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new CimdFetchError('client_id is not a URL');
  }
  if (u.protocol !== 'https:') throw new CimdFetchError('client_id URL must be https');
  if (u.username || u.password)
    throw new CimdFetchError('client_id URL must not contain credentials');
  if (u.hash) throw new CimdFetchError('client_id URL must not contain a fragment');
  if (u.port && u.port !== '443') throw new CimdFetchError('client_id URL must use port 443');
  if (u.pathname === '/' || !u.pathname) throw new CimdFetchError('client_id URL must have a path');
  return u;
}

/** Resolves and validates every address; returns the one to connect to. */
export async function resolvePublic(
  host: string,
  resolver: Resolver = defaultResolver,
): Promise<LookupAddress> {
  if (isLiteralIp(host)) {
    if (isPrivateIp(stripBrackets(host)))
      throw new CimdFetchError('client_id host resolves to a non-public address');
    return { address: stripBrackets(host), family: host.includes(':') ? 6 : 4 };
  }
  let addrs: LookupAddress[];
  try {
    addrs = await resolver(host);
  } catch {
    throw new CimdFetchError('client_id host does not resolve');
  }
  if (!addrs.length) throw new CimdFetchError('client_id host does not resolve');
  for (const a of addrs) {
    if (isPrivateIp(a.address))
      throw new CimdFetchError('client_id host resolves to a non-public address');
  }
  return addrs[0]!;
}

function stripBrackets(h: string): string {
  return h.replace(/^\[|\]$/g, '');
}
function isLiteralIp(h: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(h) || h.startsWith('[') || h.includes(':');
}

export function makeCimdFetcher(
  opts: { timeoutMs?: number; maxBytes?: number; resolver?: Resolver } = {},
): CimdFetcher {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const maxBytes = opts.maxBytes ?? 64 * 1024;
  return async (raw) => {
    const url = checkCimdUrl(raw);
    const addr = await resolvePublic(url.hostname, opts.resolver);
    return new Promise<FetchedDoc>((resolve, reject) => {
      const req = request(
        {
          host: url.hostname,
          servername: url.hostname,
          port: 443,
          path: url.pathname + url.search,
          method: 'GET',
          headers: {
            accept: 'application/json',
            'user-agent': 'godseye-detroit-connector/0.1 (oauth client metadata)',
          },
          timeout: timeoutMs,
          // Pin the connection to the address we validated.
          lookup: (
            _h: string,
            _o: unknown,
            cb: (err: Error | null, address: string, family: number) => void,
          ) => cb(null, addr.address, addr.family),
        },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            reject(
              new CimdFetchError(
                `client metadata fetch returned HTTP ${res.statusCode} (redirects are not followed)`,
              ),
            );
            return;
          }
          const ct = String(res.headers['content-type'] ?? '');
          if (!/json/i.test(ct)) {
            res.resume();
            reject(new CimdFetchError('client metadata is not JSON'));
            return;
          }
          const chunks: Buffer[] = [];
          let n = 0;
          res.on('data', (c: Buffer) => {
            n += c.length;
            if (n > maxBytes) {
              req.destroy();
              reject(new CimdFetchError('client metadata document is too large'));
              return;
            }
            chunks.push(c);
          });
          res.on('end', () => {
            const cc = String(res.headers['cache-control'] ?? '');
            const m = /max-age=(\d+)/.exec(cc);
            resolve({
              body: Buffer.concat(chunks).toString('utf8'),
              maxAgeS: m ? Number(m[1]) : undefined,
            });
          });
          res.on('error', reject);
        },
      );
      const hard = setTimeout(
        () => req.destroy(new CimdFetchError('client metadata fetch timed out')),
        timeoutMs,
      );
      req.on('timeout', () => req.destroy(new CimdFetchError('client metadata fetch timed out')));
      req.on('error', (e) =>
        reject(
          e instanceof CimdFetchError
            ? e
            : new CimdFetchError(`client metadata fetch failed: ${e.message}`),
        ),
      );
      req.on('close', () => clearTimeout(hard));
      req.end();
    });
  };
}
