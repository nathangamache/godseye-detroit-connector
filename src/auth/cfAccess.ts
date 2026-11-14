/**
 * Cloudflare Access JWT verification (defense in depth: Cloudflare enforces
 * Access at the edge, and the gateway re-verifies every UI/authorize/admin
 * request). Checks signature against the team JWKS, iss, aud, exp/nbf and that
 * the email claim is the configured owner.
 */
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { sha256hex } from '../util/crypto.js';

export interface CfAccessOptions {
  teamDomain: string; // e.g. yourteam.cloudflareaccess.com
  aud: string;
  ownerEmail: string;
  /** Test hook: a local key set instead of fetching the team's certs. */
  jwks?: JWTVerifyGetKey;
}

export interface CfIdentity {
  email: string;
  sub: string;
}

export class CfAccessVerifier {
  private readonly jwks: JWTVerifyGetKey;
  private readonly issuer: string;
  private cache = new Map<string, { id: CfIdentity; exp: number }>();

  constructor(private readonly opts: CfAccessOptions) {
    this.issuer = `https://${opts.teamDomain}`;
    this.jwks =
      opts.jwks ??
      createRemoteJWKSet(new URL(`${this.issuer}/cdn-cgi/access/certs`), {
        timeoutDuration: 5000,
        cooldownDuration: 30_000,
        cacheMaxAge: 10 * 60_000,
      });
  }

  async verify(assertion: string | undefined, now = Date.now()): Promise<CfIdentity | null> {
    if (!assertion || assertion.length > 8192) return null;
    const key = sha256hex(assertion);
    const hit = this.cache.get(key);
    if (hit && hit.exp > now) return hit.id;
    try {
      const { payload } = await jwtVerify(assertion, this.jwks, {
        issuer: this.issuer,
        audience: this.opts.aud,
        algorithms: ['RS256', 'ES256', 'PS256'],
        clockTolerance: 30,
        currentDate: new Date(now),
      });
      const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : '';
      if (!email || email !== this.opts.ownerEmail) return null;
      const id = { email, sub: String(payload.sub ?? email) };
      const exp = Math.min((payload.exp ?? 0) * 1000, now + 60_000);
      if (this.cache.size > 100) this.cache.clear();
      this.cache.set(key, { id, exp });
      return id;
    } catch {
      return null;
    }
  }
}
