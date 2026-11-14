import { isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';

/**
 * The client IP for rate limiting and audit. CF-Connecting-IP is trusted only
 * when the TCP peer is a configured proxy (cloudflared on loopback or its
 * fixed container IP). Otherwise the socket address is used.
 */
export function clientIp(req: IncomingMessage, trustedProxies: string[]): string {
  const peer = normalizeIp(req.socket.remoteAddress ?? '');
  if (trustedProxies.includes(peer) || trustedProxies.includes(req.socket.remoteAddress ?? '')) {
    const cf = req.headers['cf-connecting-ip'];
    const v = Array.isArray(cf) ? cf[0] : cf;
    if (v && isIP(v.trim())) return normalizeIp(v.trim());
  }
  return peer || 'unknown';
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
