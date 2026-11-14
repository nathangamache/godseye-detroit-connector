/** RFC 6238 TOTP (HMAC-SHA1, 30 s step, 6 digits) and RFC 4648 base32. */
import { createHmac, randomBytes } from 'node:crypto';
import { safeEqual } from '../util/crypto.js';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const v = B32.indexOf(ch);
    if (v < 0) throw new Error('invalid base32');
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function hotp(key: Buffer, counter: number, digits = 6, algo: 'sha1' | 'sha256' | 'sha512' = 'sha1'): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algo, key).update(msg).digest();
  const off = mac[mac.length - 1]! & 0xf;
  const bin = ((mac[off]! & 0x7f) << 24) | (mac[off + 1]! << 16) | (mac[off + 2]! << 8) | mac[off + 3]!;
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export function totp(secretB32: string, timeMs = Date.now(), step = 30): string {
  return hotp(base32Decode(secretB32), Math.floor(timeMs / 1000 / step));
}

/** Returns the matching time-step counter (to block replays), or null. Window: ±1 step. */
export function verifyTotp(secretB32: string, code: string, timeMs = Date.now(), step = 30): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const key = base32Decode(secretB32);
  const c = Math.floor(timeMs / 1000 / step);
  let hit: number | null = null;
  for (const d of [-1, 0, 1]) if (safeEqual(hotp(key, c + d), code)) hit = c + d;
  return hit;
}

export function otpauthUri(secretB32: string, label = 'godseye-gateway'): string {
  return `otpauth://totp/${encodeURIComponent(label)}?secret=${secretB32}&issuer=${encodeURIComponent('godseye')}&algorithm=SHA1&digits=6&period=30`;
}
