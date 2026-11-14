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

export interface ParsedIp {
  family: 4 | 6;
  /** IPv4, or IPv4-mapped IPv6 (::ffff:a.b.c.d in any spelling): the IPv4 address. */
  v4?: string;
  /** IPv6: the eight 16-bit groups (zone dropped). */
  hextets?: number[];
}

/**
 * Parses an IP literal however it is spelled: surrounding whitespace, [brackets], case, zero
 * compression or none, leading zeros in groups, a zone (%lo), an embedded dotted IPv4. Use it
 * for checks, so "0:0:0:0:0:ffff:7f00:1" is judged like "::ffff:127.0.0.1" (review: bind
 * guard). Returns null for anything that is not an IP literal.
 */
export function parseIp(raw: string): ParsedIp | null {
  let s = raw.trim();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const kind = isIP(s);
  if (kind === 4) return { family: 4, v4: s };
  if (kind !== 6) return null;
  const x = expandIpv6(s);
  if (!x) return null;
  const h = x.map((p) => parseInt(p, 16));
  const mapped = h.slice(0, 5).every((n) => n === 0) && h[5] === 0xffff;
  if (!mapped) return { family: 6, hextets: h };
  const v4 = [h[6]! >> 8, h[6]! & 0xff, h[7]! >> 8, h[7]! & 0xff].join('.');
  return { family: 6, hextets: h, v4 };
}

/** The unspecified (wildcard) address in any spelling: 0.0.0.0, ::, ::ffff:0.0.0.0. */
export function isUnspecifiedIp(raw: string): boolean {
  const p = parseIp(raw);
  if (!p) return false;
  if (p.v4) return p.v4 === '0.0.0.0';
  return p.hextets!.every((n) => n === 0);
}

/** IPv6 ::1 in any spelling. */
export function isIpv6Loopback(raw: string): boolean {
  const p = parseIp(raw);
  return Boolean(p && !p.v4 && p.hextets!.slice(0, 7).every((n) => n === 0) && p.hextets![7] === 1);
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

/**
 * True for loopback, private, link-local, CGNAT, multicast, reserved and unspecified
 * addresses, however they are spelled (parseIp).
 */
export function isPrivateIp(ipIn: string): boolean {
  const p = parseIp(ipIn);
  if (!p) return true; // not an IP at all: refuse
  if (p.v4) {
    const n = ipv4ToInt(p.v4);
    return V4_BLOCKS.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (n & mask) === (ipv4ToInt(base) & mask);
    });
  }
  const h = p.hextets!;
  // ::, ::1 and the deprecated IPv4-compatible ::a.b.c.d (::/96).
  if (h.slice(0, 6).every((n) => n === 0)) return true;
  if ((h[0]! & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((h[0]! & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((h[0]! & 0xffc0) === 0xfec0) return true; // site-local fec0::/10 (deprecated)
  if ((h[0]! & 0xff00) === 0xff00) return true; // multicast ff00::/8
  if (h[0] === 0x64 && h[1] === 0xff9b) return true; // NAT64: could map to private v4
  if (h[0] === 0x2001 && h[1] === 0x0db8) return true; // documentation
  return false;
}
