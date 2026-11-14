import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Opaque random token with a recognizable prefix (gat_ access, grt_ refresh, gdt_ device, ...). */
export function randomToken(prefix: string, bytes = 32): string {
  return `${prefix}_${randomBytes(bytes).toString('base64url')}`;
}

export function sha256hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

export function sha256b64url(s: string): string {
  return createHash('sha256').update(s, 'ascii').digest('base64url');
}

/** Constant-time string comparison (length leak only). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export function hmacB64url(key: string | Buffer, data: string): string {
  return createHmac('sha256', key).update(data, 'utf8').digest('base64url');
}
