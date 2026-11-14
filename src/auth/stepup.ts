/**
 * Step-up second factor (TOTP) for the two owner actions that matter most: approving an
 * OAuth grant (consent) and /oauth/admin.
 *
 * Why: Tailscale identity is ambient. `tailscale serve` stamps the node OWNER's login on
 * every request from an untagged node, so any process on any of the owner's untagged
 * machines "is" the owner. A TOTP code proves a human with the authenticator is present.
 *
 *  - The TOTP secret is enrolled with the CLI (scripts/stepup.ts) and stored in the database
 *    encrypted with AES-256-GCM under STEPUP_KEY (env, not in the database). Dev/test without
 *    STEPUP_KEY derive a key from the session secret; production refuses to start without it.
 *  - Codes are RFC 6238 (the same implementation as the dev password login), +-1 step,
 *    single use (replay-blocked), with a lockout after repeated failures.
 *  - A correct code opens a short step-up session (STEPUP_WINDOW_S, default 10 min): a
 *    random id in a __Host- cookie (HttpOnly, Secure, SameSite=Strict), stored hashed and
 *    bound to the owner subject. CSRF tokens on admin forms are bound to that session.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { kvGet, kvSet, type DB } from '../db.js';
import { sha256hex } from '../util/crypto.js';
import { clearCookie, getCookie, setCookie } from './cookies.js';
import { Lockout, type LockoutPolicy } from './password.js';
import { base32Decode, verifyTotp } from './totp.js';

const SECRET_KV = 'stepup_totp_secret';
const LAST_STEP_KV = 'stepup_totp_last_step';
const AAD = Buffer.from('godseye-stepup-totp-v1');

export const STEPUP_LOCKOUT: LockoutPolicy = {
  perIpMax: 5,
  perIpWindowMs: 15 * 60_000,
  perIpLockMs: 15 * 60_000,
  globalMax: 10,
  globalWindowMs: 60 * 60_000,
  globalLockMs: 60 * 60_000,
};

export type CodeCheck = 'ok' | 'bad' | 'locked' | 'not_enrolled';

export interface StepUpSession {
  /** Value mixed into CSRF tokens issued while this session is live. */
  binding: string;
  expiresAt: number;
}

/** Parses STEPUP_KEY (32 bytes as base64url, base64 or hex). */
export function parseStepUpKey(raw: string): Buffer {
  const s = raw.trim();
  let buf: Buffer | undefined;
  if (/^[0-9a-f]{64}$/i.test(s)) buf = Buffer.from(s, 'hex');
  else if (/^[A-Za-z0-9_-]{43}$/.test(s)) buf = Buffer.from(s, 'base64url');
  else if (/^[A-Za-z0-9+/]{43}=$/.test(s)) buf = Buffer.from(s, 'base64');
  if (!buf || buf.length !== 32)
    throw new Error('STEPUP_KEY must be 32 random bytes (base64url, base64 or hex)');
  return buf;
}

/** Dev/test fallback: a key derived from the session secret (never used in production). */
export function deriveStepUpKey(sessionSecret: string): Buffer {
  return Buffer.from(
    hkdfSync('sha256', Buffer.from(sessionSecret), Buffer.alloc(0), 'godseye-stepup-key-v1', 32),
  );
}

export function encryptSecret(key: Buffer, secretB32: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(AAD);
  const ct = Buffer.concat([c.update(secretB32, 'utf8'), c.final()]);
  return [
    'v1',
    iv.toString('base64url'),
    c.getAuthTag().toString('base64url'),
    ct.toString('base64url'),
  ].join('.');
}

export function decryptSecret(key: Buffer, stored: string): string {
  const [v, iv, tag, ct] = stored.split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('unknown step-up secret format');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  d.setAAD(AAD);
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}

export class StepUp {
  private readonly lockout: Lockout;

  constructor(
    private readonly db: DB,
    private readonly opts: { enabled: boolean; windowS: number; key: Buffer },
    private readonly now: () => number = Date.now,
  ) {
    this.lockout = new Lockout(db, STEPUP_LOCKOUT, now, 'stepup:');
  }

  get enabled(): boolean {
    return this.opts.enabled;
  }

  get windowS(): number {
    return this.opts.windowS;
  }

  static cookieName(secure: boolean): string {
    return secure ? '__Host-gw_stepup' : 'gw_stepup';
  }

  // ---------- enrollment (CLI) ----------
  isEnrolled(): boolean {
    return Boolean(kvGet(this.db, SECRET_KV));
  }

  enrolledAt(): number | undefined {
    const v = kvGet(this.db, `${SECRET_KV}_at`);
    return v ? Number(v) : undefined;
  }

  /** Stores a new secret (encrypted) and ends every open step-up session. */
  enroll(secretB32: string): void {
    if (base32Decode(secretB32).length < 16) throw new Error('TOTP secret is too short');
    this.db.transaction(() => {
      kvSet(this.db, SECRET_KV, encryptSecret(this.opts.key, secretB32));
      kvSet(this.db, `${SECRET_KV}_at`, String(this.now()));
      kvSet(this.db, LAST_STEP_KV, '0');
      this.db.prepare('DELETE FROM stepup_sessions').run();
    })();
  }

  reset(): void {
    this.db.transaction(() => {
      this.db
        .prepare('DELETE FROM kv WHERE key IN (?, ?, ?)')
        .run(SECRET_KV, `${SECRET_KV}_at`, LAST_STEP_KV);
      this.db.prepare('DELETE FROM stepup_sessions').run();
    })();
  }

  /** The decrypted secret; undefined if none is enrolled or STEPUP_KEY changed since. */
  private secret(): string | undefined {
    const stored = kvGet(this.db, SECRET_KV);
    if (!stored) return undefined;
    try {
      return decryptSecret(this.opts.key, stored);
    } catch {
      return undefined; // fail closed: approvals and admin refuse until re-enrolled
    }
  }

  /** Verifies a code: single use, lockout after repeated failures. */
  verifyCode(code: unknown, ip: string): CodeCheck {
    const secret = this.secret();
    if (!secret) return 'not_enrolled';
    if (this.lockout.isLocked(ip)) return 'locked';
    const c = typeof code === 'string' ? code.replace(/\s/g, '') : '';
    const step = verifyTotp(secret, c, this.now());
    const last = Number(kvGet(this.db, LAST_STEP_KV) ?? '0');
    if (step === null || step <= last) {
      this.lockout.fail(ip);
      return this.lockout.isLocked(ip) ? 'locked' : 'bad';
    }
    kvSet(this.db, LAST_STEP_KV, String(step));
    this.lockout.succeed(ip);
    return 'ok';
  }

  // ---------- sessions ----------
  /** Creates a step-up session for the subject; returns the raw id (cookie value). */
  createSession(subject: string): string {
    const id = randomBytes(32).toString('base64url');
    const t = this.now();
    this.db.prepare('DELETE FROM stepup_sessions WHERE expires_at < ?').run(t);
    this.db
      .prepare(
        'INSERT INTO stepup_sessions(id_hash, subject, created_at, expires_at) VALUES (?, ?, ?, ?)',
      )
      .run(sha256hex(id), subject, t, t + this.opts.windowS * 1000);
    return id;
  }

  /** The live step-up session for this request and subject, or null. */
  current(req: Request, subject: string, secure: boolean): StepUpSession | null {
    if (!this.opts.enabled) return null;
    const id = getCookie(req, StepUp.cookieName(secure));
    if (!id || !/^[A-Za-z0-9_-]{43}$/.test(id)) return null;
    const hash = sha256hex(id);
    const row = this.db
      .prepare('SELECT subject, expires_at FROM stepup_sessions WHERE id_hash = ?')
      .get(hash) as { subject: string; expires_at: number } | undefined;
    if (!row || row.expires_at <= this.now() || row.subject !== subject) return null;
    return { binding: `stepup:${hash.slice(0, 32)}`, expiresAt: row.expires_at };
  }

  setCookie(res: Response, id: string, secure: boolean): void {
    setCookie(res, StepUp.cookieName(secure), id, { secure, maxAgeS: this.opts.windowS });
  }

  end(req: Request, res: Response, secure: boolean): void {
    const id = getCookie(req, StepUp.cookieName(secure));
    if (id) this.db.prepare('DELETE FROM stepup_sessions WHERE id_hash = ?').run(sha256hex(id));
    clearCookie(res, StepUp.cookieName(secure), secure);
  }

  prune(): void {
    this.db.prepare('DELETE FROM stepup_sessions WHERE expires_at < ?').run(this.now());
  }
}
