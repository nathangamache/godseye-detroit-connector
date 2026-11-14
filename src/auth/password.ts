/**
 * Password+TOTP login (local/dev fallback). scrypt hash in .env, TOTP secret in
 * .env, brute-force lockout per IP plus a global ceiling, TOTP replay blocking.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { kvGet, kvSet, type DB } from '../db.js';
import { verifyTotp } from './totp.js';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;

export async function hashPassword(password: string, logN = 15): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 32, { N: 2 ** logN, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  return `scrypt$${logN}$8$1$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const m = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(stored);
  if (!m) return false;
  const [, logN, r, p, salt, hash] = m;
  const expected = Buffer.from(hash!, 'base64url');
  const got = await scrypt(password.slice(0, 1024), Buffer.from(salt!, 'base64url'), expected.length, {
    N: 2 ** Number(logN),
    r: Number(r),
    p: Number(p),
    maxmem: 128 * 1024 * 1024,
  });
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export interface LockoutPolicy {
  perIpMax: number; // failures
  perIpWindowMs: number;
  perIpLockMs: number;
  globalMax: number;
  globalWindowMs: number;
  globalLockMs: number;
}

export const DEFAULT_LOCKOUT: LockoutPolicy = {
  perIpMax: 5,
  perIpWindowMs: 15 * 60_000,
  perIpLockMs: 15 * 60_000,
  globalMax: 20,
  globalWindowMs: 60 * 60_000,
  globalLockMs: 60 * 60_000,
};

export class Lockout {
  constructor(
    private readonly db: DB,
    private readonly policy: LockoutPolicy = DEFAULT_LOCKOUT,
    private readonly now: () => number = Date.now,
  ) {}

  isLocked(ip: string): boolean {
    const t = this.now();
    const rows = this.db
      .prepare('SELECT locked_until FROM login_failures WHERE key IN (?, ?)')
      .all(`ip:${ip}`, 'global') as Array<{ locked_until: number | null }>;
    return rows.some((r) => (r.locked_until ?? 0) > t);
  }

  fail(ip: string): void {
    this.bump(`ip:${ip}`, this.policy.perIpMax, this.policy.perIpWindowMs, this.policy.perIpLockMs);
    this.bump('global', this.policy.globalMax, this.policy.globalWindowMs, this.policy.globalLockMs);
  }

  succeed(ip: string): void {
    this.db.prepare('DELETE FROM login_failures WHERE key = ?').run(`ip:${ip}`);
  }

  private bump(key: string, max: number, windowMs: number, lockMs: number): void {
    const t = this.now();
    const row = this.db.prepare('SELECT count, first_at FROM login_failures WHERE key = ?').get(key) as
      | { count: number; first_at: number }
      | undefined;
    if (!row || t - row.first_at > windowMs) {
      this.db
        .prepare('INSERT INTO login_failures(key, count, first_at, locked_until) VALUES (?, 1, ?, NULL) ON CONFLICT(key) DO UPDATE SET count = 1, first_at = excluded.first_at, locked_until = NULL')
        .run(key, t);
      return;
    }
    const count = row.count + 1;
    this.db
      .prepare('UPDATE login_failures SET count = ?, locked_until = ? WHERE key = ?')
      .run(count, count >= max ? t + lockMs : null, key);
  }
}

/** Verifies password + TOTP; blocks reuse of a TOTP step that already logged in. */
export async function checkPasswordLogin(
  db: DB,
  opts: { passwordHash: string; totpSecret: string },
  password: string,
  code: string,
  now = Date.now(),
): Promise<boolean> {
  const pwOk = await verifyPassword(password, opts.passwordHash);
  const step = verifyTotp(opts.totpSecret, code.trim(), now);
  if (!pwOk || step === null) return false;
  const last = Number(kvGet(db, 'totp_last_step') ?? '0');
  if (step <= last) return false;
  kvSet(db, 'totp_last_step', String(step));
  return true;
}
