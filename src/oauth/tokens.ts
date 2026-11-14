/**
 * Authorization codes, token families, access/refresh tokens.
 *
 * - Tokens are opaque random strings; only SHA-256 hashes are stored.
 * - Access tokens are audience-bound to the MCP resource (RFC 8707).
 * - Refresh tokens rotate on every use. Presenting an already-rotated refresh
 *   token revokes the whole family (reuse detection), unless it happens within
 *   REFRESH_REUSE_GRACE_S (default 0 = never).
 * - Codes are single use; replaying one revokes the tokens it produced.
 */
import { randomUUID } from 'node:crypto';
import type { DB } from '../db.js';
import { randomToken, safeEqual, sha256b64url, sha256hex } from '../util/crypto.js';

export interface Grant {
  clientId: string;
  subject: string;
  scope: string;
  resource: string;
}

export interface IssuedTokens {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

export interface AccessInfo extends Grant {
  expiresAt: number;
  familyId: string;
}

export interface TokenStoreOptions {
  accessTtlS: number;
  refreshTtlS: number;
  codeTtlS: number;
  reuseGraceS: number;
}

export interface CodeRequest extends Grant {
  redirectUri: string;
  codeChallenge: string;
}

export type CodeResult =
  | { ok: true; grant: Grant; redirectUri: string; codeChallenge: string; codeHash: string }
  | { ok: false; reason: 'invalid' | 'expired' | 'reused' | 'client_mismatch' };

export type RefreshResult =
  | { ok: true; tokens: IssuedTokens; familyId: string; grant: Grant }
  | { ok: false; reason: string; familyRevoked?: string };

interface TokenRow {
  token_hash: string;
  family_id: string;
  kind: 'access' | 'refresh';
  expires_at: number;
  used_at: number | null;
  revoked_at: number | null;
  client_id: string;
  subject: string;
  scope: string;
  resource: string;
  family_revoked_at: number | null;
}

export class TokenStore {
  constructor(
    private readonly db: DB,
    private readonly opts: TokenStoreOptions,
    private readonly now: () => number = Date.now,
  ) {}

  // ---------- authorization codes ----------
  createCode(req: CodeRequest): string {
    const code = randomToken('gac', 32);
    const t = this.now();
    this.db
      .prepare(
        `INSERT INTO auth_codes(code_hash, client_id, redirect_uri, code_challenge, resource, scope, subject, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sha256hex(code),
        req.clientId,
        req.redirectUri,
        req.codeChallenge,
        req.resource,
        req.scope,
        req.subject,
        t,
        t + this.opts.codeTtlS * 1000,
      );
    return code;
  }

  /** Marks the code used. A second presentation revokes whatever the first one produced. */
  consumeCode(code: string, clientId: string): CodeResult {
    const hash = sha256hex(code);
    const row = this.db.prepare('SELECT * FROM auth_codes WHERE code_hash = ?').get(hash) as
      | {
          client_id: string;
          redirect_uri: string;
          code_challenge: string;
          resource: string;
          scope: string;
          subject: string;
          expires_at: number;
          used_at: number | null;
          family_id: string | null;
        }
      | undefined;
    if (!row) return { ok: false, reason: 'invalid' };
    if (row.used_at) {
      if (row.family_id) this.revokeFamily(row.family_id, 'code_reuse');
      return { ok: false, reason: 'reused' };
    }
    // Burn the code before any other check so it can never be retried.
    this.db.prepare('UPDATE auth_codes SET used_at = ? WHERE code_hash = ?').run(this.now(), hash);
    if (row.expires_at < this.now()) return { ok: false, reason: 'expired' };
    if (!safeEqual(row.client_id, clientId)) return { ok: false, reason: 'client_mismatch' };
    return {
      ok: true,
      codeHash: hash,
      redirectUri: row.redirect_uri,
      codeChallenge: row.code_challenge,
      grant: {
        clientId: row.client_id,
        subject: row.subject,
        scope: row.scope,
        resource: row.resource,
      },
    };
  }

  attachFamilyToCode(codeHash: string, familyId: string): void {
    this.db
      .prepare('UPDATE auth_codes SET family_id = ? WHERE code_hash = ?')
      .run(familyId, codeHash);
  }

  // ---------- tokens ----------
  issue(grant: Grant, familyId?: string): { tokens: IssuedTokens; familyId: string } {
    const t = this.now();
    const fam = familyId ?? randomUUID();
    const access = randomToken('gat');
    const refresh = randomToken('grt');
    const tx = this.db.transaction(() => {
      if (!familyId) {
        this.db
          .prepare(
            'INSERT INTO token_families(family_id, client_id, subject, scope, resource, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          )
          .run(fam, grant.clientId, grant.subject, grant.scope, grant.resource, t, t);
      } else {
        this.db
          .prepare('UPDATE token_families SET last_used_at = ? WHERE family_id = ?')
          .run(t, fam);
      }
      const ins = this.db.prepare(
        'INSERT INTO tokens(token_hash, family_id, kind, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
      );
      ins.run(sha256hex(access), fam, 'access', t, t + this.opts.accessTtlS * 1000);
      ins.run(sha256hex(refresh), fam, 'refresh', t, t + this.opts.refreshTtlS * 1000);
    });
    tx();
    return {
      familyId: fam,
      tokens: {
        access_token: access,
        token_type: 'Bearer',
        expires_in: this.opts.accessTtlS,
        refresh_token: refresh,
        scope: grant.scope,
      },
    };
  }

  private lookup(token: string): TokenRow | undefined {
    return this.db
      .prepare(
        `SELECT t.token_hash, t.family_id, t.kind, t.expires_at, t.used_at, t.revoked_at,
                f.client_id, f.subject, f.scope, f.resource, f.revoked_at AS family_revoked_at
           FROM tokens t JOIN token_families f ON f.family_id = t.family_id
          WHERE t.token_hash = ?`,
      )
      .get(sha256hex(token)) as TokenRow | undefined;
  }

  verifyAccess(token: string): AccessInfo | null {
    if (!token.startsWith('gat_') || token.length > 200) return null;
    const row = this.lookup(token);
    if (!row || row.kind !== 'access') return null;
    if (row.revoked_at || row.family_revoked_at) return null;
    if (row.expires_at <= this.now()) return null;
    return {
      clientId: row.client_id,
      subject: row.subject,
      scope: row.scope,
      resource: row.resource,
      expiresAt: row.expires_at,
      familyId: row.family_id,
    };
  }

  /**
   * Rotates a refresh token. A requested `scope` wider than the grant is refused BEFORE the
   * token is used, so a client that asks for too much can simply retry (review OA-4).
   */
  refresh(refreshToken: string, clientId: string, requestedScope?: string): RefreshResult {
    if (!refreshToken.startsWith('grt_') || refreshToken.length > 200)
      return { ok: false, reason: 'unknown' };
    const row = this.lookup(refreshToken);
    if (!row || row.kind !== 'refresh') return { ok: false, reason: 'unknown' };
    if (row.family_revoked_at) return { ok: false, reason: 'family_revoked' };
    if (!safeEqual(row.client_id, clientId)) return { ok: false, reason: 'client_mismatch' };
    if (row.revoked_at) return { ok: false, reason: 'revoked' };
    const t = this.now();
    if (row.used_at) {
      const grace = this.opts.reuseGraceS * 1000;
      if (!(grace > 0 && t - row.used_at <= grace)) {
        this.revokeFamily(row.family_id, 'refresh_reuse');
        return { ok: false, reason: 'reuse', familyRevoked: row.family_id };
      }
      // Within the grace window: invalidate the sibling issued at rotation and re-issue.
      this.db
        .prepare(
          "UPDATE tokens SET revoked_at = ? WHERE family_id = ? AND kind = 'refresh' AND used_at IS NULL AND revoked_at IS NULL",
        )
        .run(t, row.family_id);
    }
    if (row.expires_at <= t) return { ok: false, reason: 'expired' };
    if (requestedScope !== undefined) {
      const granted = row.scope.split(' ');
      if (
        requestedScope
          .split(' ')
          .filter(Boolean)
          .some((sc) => !granted.includes(sc))
      )
        return { ok: false, reason: 'invalid_scope' };
    }
    this.db
      .prepare('UPDATE tokens SET used_at = COALESCE(used_at, ?) WHERE token_hash = ?')
      .run(t, row.token_hash);
    const grant: Grant = {
      clientId: row.client_id,
      subject: row.subject,
      scope: row.scope,
      resource: row.resource,
    };
    const { tokens } = this.issue(grant, row.family_id);
    return { ok: true, tokens, familyId: row.family_id, grant };
  }

  /** The client a token was issued to, without changing anything (RFC 7009 ownership check). */
  tokenClient(token: string): string | null {
    if (token.length > 200) return null;
    return this.lookup(token)?.client_id ?? null;
  }

  /** RFC 7009 revocation. Refresh tokens take their whole family with them. */
  revokeToken(
    token: string,
  ): { kind: 'access' | 'refresh'; familyId: string; clientId: string } | null {
    const row = this.lookup(token);
    if (!row) return null;
    if (row.kind === 'refresh') this.revokeFamily(row.family_id, 'revoked_by_client');
    else
      this.db
        .prepare('UPDATE tokens SET revoked_at = ? WHERE token_hash = ?')
        .run(this.now(), row.token_hash);
    return { kind: row.kind, familyId: row.family_id, clientId: row.client_id };
  }

  revokeFamily(familyId: string, reason: string): void {
    const t = this.now();
    this.db.transaction(() => {
      this.db
        .prepare(
          'UPDATE token_families SET revoked_at = COALESCE(revoked_at, ?), revoked_reason = COALESCE(revoked_reason, ?) WHERE family_id = ?',
        )
        .run(t, reason, familyId);
      this.db
        .prepare('UPDATE tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE family_id = ?')
        .run(t, familyId);
    })();
  }

  revokeClient(clientId: string): number {
    const fams = this.db
      .prepare('SELECT family_id FROM token_families WHERE client_id = ? AND revoked_at IS NULL')
      .all(clientId) as Array<{ family_id: string }>;
    for (const f of fams) this.revokeFamily(f.family_id, 'client_revoked');
    return fams.length;
  }

  /** Live (not revoked, refresh not expired) grants of one client. */
  activeFamilies(clientId: string): { count: number; lastUsedAt: number | null } {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS n, MAX(f.last_used_at) AS last FROM token_families f
          WHERE f.client_id = ? AND f.revoked_at IS NULL
            AND EXISTS (SELECT 1 FROM tokens t WHERE t.family_id = f.family_id AND t.kind = 'refresh'
                          AND t.revoked_at IS NULL AND t.expires_at > ?)`,
      )
      .get(clientId, this.now()) as { n: number; last: number | null };
    return { count: r.n, lastUsedAt: r.last };
  }

  listFamilies(): Array<{
    family_id: string;
    client_id: string;
    subject: string;
    scope: string;
    created_at: number;
    last_used_at: number | null;
    revoked_at: number | null;
    revoked_reason: string | null;
    refresh_expires_at: number | null;
  }> {
    return this.db
      .prepare(
        `SELECT f.family_id, f.client_id, f.subject, f.scope, f.created_at, f.last_used_at, f.revoked_at, f.revoked_reason,
                (SELECT MAX(expires_at) FROM tokens t WHERE t.family_id = f.family_id AND t.kind = 'refresh') AS refresh_expires_at
           FROM token_families f ORDER BY f.created_at DESC LIMIT 200`,
      )
      .all() as never;
  }

  prune(): void {
    const t = this.now();
    this.db.prepare('DELETE FROM auth_codes WHERE expires_at < ?').run(t - 86_400_000);
    this.db.prepare('DELETE FROM tokens WHERE expires_at < ?').run(t - 86_400_000);
    this.db
      .prepare(
        'DELETE FROM token_families WHERE NOT EXISTS (SELECT 1 FROM tokens t WHERE t.family_id = token_families.family_id) AND created_at < ?',
      )
      .run(t - 86_400_000);
  }
}

/** PKCE S256 check (RFC 7636), constant time. */
export function verifyPkce(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  return safeEqual(sha256b64url(verifier), challenge);
}
