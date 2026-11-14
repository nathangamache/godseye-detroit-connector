/**
 * Client ID Metadata Document fetcher with SSRF protection.
 *  - only https URLs on port 443, no credentials, no fragment
 *  - DNS is resolved once; every address must be public (no private, loopback,
 *    link-local, CGNAT, multicast or reserved ranges), and each TCP connection is
 *    pinned to one validated address (no DNS-rebinding window). The validated
 *    addresses are tried in order; only a failure to connect moves on to the next.
 *  - no connection reuse, no redirects, 5 s timeout in total, 64 KB body cap, JSON only
 * The gateway additionally only fetches client_id URLs on CIMD_ALLOWED_CLIENT_IDS.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import type { ClientRequest } from 'node:http';
import { request } from 'node:https';
import type { LookupAddress } from 'node:dns';
import { isIP, type LookupFunction, type Socket } from 'node:net';
import { isPrivateIp } from '../util/net.js';

export interface FetchedDoc {
  body: string;
  maxAgeS?: number;
}

export type CimdFetcher = (url: string) => Promise<FetchedDoc>;

export class CimdFetchError extends Error {}

/** The TCP connection to one address was never established (try the next address). */
class ConnectFailed extends CimdFetchError {}

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

/**
 * Resolves and validates every address; returns them all (resolver order, duplicates
 * dropped). One non-public address refuses the whole host.
 */
export async function resolvePublic(
  host: string,
  resolver: Resolver = defaultResolver,
  isPrivate: (ip: string) => boolean = isPrivateIp,
): Promise<LookupAddress[]> {
  if (isLiteralIp(host)) {
    if (isPrivate(stripBrackets(host)))
      throw new CimdFetchError('client_id host resolves to a non-public address');
    return [{ address: stripBrackets(host), family: host.includes(':') ? 6 : 4 }];
  }
  let addrs: LookupAddress[];
  try {
    addrs = await resolver(host);
  } catch {
    throw new CimdFetchError('client_id host does not resolve');
  }
  if (!addrs.length) throw new CimdFetchError('client_id host does not resolve');
  const out: LookupAddress[] = [];
  for (const a of addrs) {
    if (isIP(a.address) === 0 || isPrivate(a.address))
      throw new CimdFetchError('client_id host resolves to a non-public address');
    if (!out.some((o) => o.address === a.address))
      out.push({ address: a.address, family: isIP(a.address) });
  }
  return out;
}

function stripBrackets(h: string): string {
  return h.replace(/^\[|\]$/g, '');
}
function isLiteralIp(h: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(h) || h.startsWith('[') || h.includes(':');
}

/**
 * A `lookup` for https.request that always answers with the address we validated.
 * Node 24's net.connect uses autoSelectFamily and calls lookup with {all: true}, expecting
 * an array; answering with a bare address there fails every fetch with
 * ERR_INVALID_IP_ADDRESS (review OA-3), so both forms are honoured.
 *
 * The answer is always deferred. tls.connect keeps setting up its socket (servername) after
 * net has called lookup; answering inline means a connect that fails synchronously (no route,
 * e.g. an IPv6 address on an IPv4-only host) destroys the socket under it, https.request
 * throws a TypeError and the connect error is emitted with no listener: an uncaught
 * exception that would take the gateway down.
 */
export function pinnedLookup(addr: LookupAddress): LookupFunction {
  return ((_host: string, options: unknown, cb: (...args: unknown[]) => void) => {
    const all =
      typeof options === 'object' && options !== null && (options as { all?: boolean }).all;
    process.nextTick(() => {
      if (all) cb(null, [{ address: addr.address, family: addr.family }]);
      else cb(null, addr.address, addr.family);
    });
  }) as unknown as LookupFunction;
}

export interface CimdFetcherOptions {
  /** Total time for the fetch, across every address tried (default 5 s). */
  timeoutMs?: number;
  /** Time to establish TCP to one address before trying the next (default 2.5 s). */
  connectTimeoutMs?: number;
  maxBytes?: number;
  resolver?: Resolver;
  /** Tests only: the port actually connected to (the URL must still say 443). */
  connectPort?: number;
  /** Tests only: extra CA for the local TLS test server. */
  ca?: string | Buffer;
  /** Tests only: the private-address check (default isPrivateIp). */
  isPrivate?: (ip: string) => boolean;
}

export function makeCimdFetcher(opts: CimdFetcherOptions = {}): CimdFetcher {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const connectTimeoutMs = opts.connectTimeoutMs ?? 2500;
  const maxBytes = opts.maxBytes ?? 64 * 1024;

  /** One GET pinned to one address. Rejects with ConnectFailed if TCP never connected. */
  const fetchFrom = (url: URL, addr: LookupAddress, budgetMs: number, connectMs: number) =>
    new Promise<FetchedDoc>((resolve, reject) => {
      let connected = false;
      const fail = (e: Error) =>
        reject(
          e instanceof CimdFetchError
            ? e
            : connected
              ? new CimdFetchError(`client metadata fetch failed: ${e.message}`)
              : new ConnectFailed(`client metadata fetch failed: ${e.message}`),
        );
      let req: ClientRequest;
      try {
        req = request(
          {
            host: url.hostname,
            servername: url.hostname,
            port: opts.connectPort ?? 443,
            ...(opts.ca ? { ca: opts.ca } : {}),
            path: url.pathname + url.search,
            method: 'GET',
            headers: {
              accept: 'application/json',
              'user-agent': 'godseye-detroit-connector/0.1 (oauth client metadata)',
            },
            timeout: budgetMs,
            // A fresh connection every time: a pooled socket would skip the pinned lookup.
            agent: false,
            // Pin the connection to the address we validated (no DNS-rebinding window).
            lookup: pinnedLookup(addr),
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
            res.on('error', fail);
          },
        );
      } catch (err) {
        // Belt and braces: whatever https.request throws becomes this fetch's failure.
        fail(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      req.on('error', fail);
      req.on('socket', (s: Socket) => {
        // (A connect that failed synchronously has already destroyed the socket by now.)
        if (s.readyState === 'open') connected = true;
        else
          s.once('connect', () => {
            connected = true;
            clearTimeout(connectTimer);
          });
      });
      const connectTimer = setTimeout(() => {
        if (!connected) req.destroy(new ConnectFailed('client metadata fetch: connect timed out'));
      }, connectMs);
      const hard = setTimeout(
        () => req.destroy(new CimdFetchError('client metadata fetch timed out')),
        budgetMs,
      );
      req.on('timeout', () => req.destroy(new CimdFetchError('client metadata fetch timed out')));
      req.on('close', () => {
        clearTimeout(hard);
        clearTimeout(connectTimer);
      });
      req.end();
    });

  return async (raw) => {
    const url = checkCimdUrl(raw);
    const addrs = await resolvePublic(url.hostname, opts.resolver, opts.isPrivate);
    const deadline = Date.now() + timeoutMs;
    let last: CimdFetchError = new CimdFetchError('client metadata fetch timed out');
    for (let i = 0; i < addrs.length; i++) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      const isLast = i === addrs.length - 1;
      try {
        return await fetchFrom(
          url,
          addrs[i]!,
          left,
          isLast ? left : Math.min(left, connectTimeoutMs),
        );
      } catch (err) {
        // Only "could not connect to this address" moves on; anything the server said is final.
        if (!(err instanceof ConnectFailed)) throw err;
        last = err;
      }
    }
    throw last;
  };
}
