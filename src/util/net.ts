import { isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';

/**
 * The client IP for rate limiting and audit. The forwarding header (CF-Connecting-IP
 * from cloudflared on the public listener) is trusted only when the TCP peer is a
 * configured proxy; the private listener configures none. Otherwise the socket
 * address is used.
 */
export function clientIp(
  req: IncomingMessage,
  trustedProxies: string[],
  header = 'cf-connecting-ip',
): string {
  const peer = normalizeIp(req.socket.remoteAddress ?? '');
  if (
    trustedProxies.length &&
    (trustedProxies.includes(peer) || trustedProxies.includes(req.socket.remoteAddress ?? ''))
  ) {
    const raw = req.headers[header];
    const v = (Array.isArray(raw) ? raw[0] : raw)?.split(',')[0]?.trim();
    if (v && isIP(v)) return normalizeIp(v);
  }
  return peer || 'unknown';
}

/** Expands an IPv6 address to 8 hextets (no zone), or returns null. */
export function expandIpv6(ip: string): string[] | null {
  if (isIP(ip) !== 6) return null;
  let s = ip.toLowerCase().split('%')[0]!;
  // Trailing embedded IPv4 (::ffff:1.2.3.4) -> two hextets.
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const o = v4[1]!.split('.').map(Number);
    s =
      s.slice(0, -v4[1]!.length) +
      ((o[0]! << 8) | o[1]!).toString(16) +
      ':' +
      ((o[2]! << 8) | o[3]!).toString(16);
  }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const fill = s.includes('::') ? 8 - h.length - t.length : 0;
  const parts = [...h, ...Array<string>(Math.max(0, fill)).fill('0'), ...t];
  return parts.length === 8 ? parts.map((p) => p.padStart(4, '0')) : null;
}

/**
 * Rate-limit key for a client address: IPv4 as is, IPv6 by its /64 (one subscriber's
 * prefix), so rotating addresses inside a prefix does not get fresh limits (review OA-6/bp-2).
 */
export function rateKeyIp(ip: string): string {
  const n = normalizeIp(ip);
  const x = expandIpv6(n);
  return x ? `${x.slice(0, 4).join(':')}::/64` : n;
}

export function normalizeIp(ip: string): string {
  return ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
}

const V4_BLOCKS: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

/** True for loopback, private, link-local, CGNAT, multicast, reserved and unspecified addresses. */
export function isPrivateIp(ipIn: string): boolean {
  const ip = normalizeIp(ipIn.trim());
  const kind = isIP(ip);
  if (kind === 4) {
    const n = ipv4ToInt(ip);
    return V4_BLOCKS.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (n & mask) === (ipv4ToInt(base) & mask);
    });
  }
  if (kind === 6) {
    const l = ip.toLowerCase();
    if (l === '::' || l === '::1') return true;
    if (/^f[cd]/.test(l)) return true; // unique local fc00::/7
    if (/^fe[89ab]/.test(l)) return true; // link-local fe80::/10
    if (/^ff/.test(l)) return true; // multicast
    if (l.startsWith('::ffff:')) return isPrivateIp(l.slice(7));
    if (l.startsWith('64:ff9b:')) return true; // NAT64: refuse, could map to private v4
    if (l.startsWith('2001:db8')) return true;
    return false;
  }
  return true; // not an IP at all: refuse
}
