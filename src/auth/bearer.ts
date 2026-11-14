/**
 * Bearer-token gate for /mcp (resource server side).
 * 401 responses carry the RFC 9728 pointer Claude needs to start OAuth:
 *   WWW-Authenticate: Bearer resource_metadata="https://<host>/.well-known/oauth-protected-resource"
 */
import type { NextFunction, Request, Response } from 'express';
import type { TokenStore } from '../oauth/tokens.js';

export interface BearerOptions {
  tokens: TokenStore;
  resource: string;
  resourceMetadataUrl: string;
  requiredScope: string;
}

export interface GatewayAuth {
  token: string;
  clientId: string;
  scopes: string[];
  expiresAt: number; // seconds
  resource: URL;
  extra: { subject: string; familyId: string };
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: GatewayAuth;
  }
}

export function challenge(
  opts: BearerOptions,
  error?: { code: string; description: string },
): string {
  const parts: string[] = [];
  if (error) parts.push(`error="${error.code}"`, `error_description="${error.description}"`);
  parts.push(`resource_metadata="${opts.resourceMetadataUrl}"`);
  return `Bearer ${parts.join(', ')}`;
}

export function bearerAuth(opts: BearerOptions) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization;
    const m =
      typeof header === 'string' ? /^Bearer\s+([A-Za-z0-9._~+/=-]+)\s*$/i.exec(header) : null;
    if (!m) {
      res
        .status(401)
        .set('WWW-Authenticate', challenge(opts))
        .set('Cache-Control', 'no-store')
        .json({ error: 'invalid_token', error_description: 'Authorization required' });
      return;
    }
    const info = opts.tokens.verifyAccess(m[1]!);
    if (!info || info.resource !== opts.resource) {
      res
        .status(401)
        .set(
          'WWW-Authenticate',
          challenge(opts, {
            code: 'invalid_token',
            description: 'The access token is invalid or expired',
          }),
        )
        .set('Cache-Control', 'no-store')
        .json({
          error: 'invalid_token',
          error_description: 'The access token is invalid or expired',
        });
      return;
    }
    const scopes = info.scope.split(' ').filter(Boolean);
    if (!scopes.includes(opts.requiredScope)) {
      res
        .status(403)
        .set(
          'WWW-Authenticate',
          `Bearer error="insufficient_scope", scope="${opts.requiredScope}", resource_metadata="${opts.resourceMetadataUrl}"`,
        )
        .json({ error: 'insufficient_scope' });
      return;
    }
    req.auth = {
      token: m[1]!,
      clientId: info.clientId,
      scopes,
      expiresAt: Math.floor(info.expiresAt / 1000),
      resource: new URL(info.resource),
      extra: { subject: info.subject, familyId: info.familyId },
    };
    next();
  };
}
