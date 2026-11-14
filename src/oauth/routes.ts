/**
 * OAuth 2.1 authorization server endpoints (RFC 8414 metadata, authorization
 * code + PKCE S256, RFC 8707 resource binding, RFC 7591 DCR, CIMD, RFC 7009
 * revocation, RFC 9207 iss), plus the owner-only consent and admin pages.
 */
import { randomBytes } from 'node:crypto';
import express, { type Express, type Request, type Response } from 'express';
import type { AppContext } from '../app.js';
import type { Audit } from '../audit.js';
import { safeNext, type Login } from '../auth/login.js';
import type { StepUp } from '../auth/stepup.js';
import type { Csrf } from '../auth/csrf.js';
import type { Config } from '../config.js';
import { ipOf, pageHeaders, rateLimit, sameOriginPost } from '../http/security.js';
import type { LocationStore } from '../location/store.js';
import { esc, page } from '../ui/html.js';
import { ClientError, type ClientRegistry, type OAuthClient } from './clients.js';
import { verifyPkce, type TokenStore } from './tokens.js';

export const SUPPORTED_SCOPES = ['mcp', 'offline_access'];

export function authorizationServerMetadata(config: Config) {
  const i = config.issuer;
  return {
    issuer: i,
    authorization_endpoint: config.authorizationEndpoint,
    token_endpoint: `${i}/oauth/token`,
    registration_endpoint: config.DCR_ENABLED ? `${i}/oauth/register` : undefined,
    revocation_endpoint: `${i}/oauth/revoke`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: SUPPORTED_SCOPES,
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${i}/healthz`,
  };
}

interface PendingAuthz {
  client: OAuthClient;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  scope: string;
  resource: string;
  subject: string;
  expires: number;
}

export interface OAuthDeps {
  config: Config;
  audit: Audit;
  tokens: TokenStore;
  clients: ClientRegistry;
  locations: LocationStore;
  stepup: StepUp;
  now: () => number;
}

/** How long a consent page stays approvable. */
const PENDING_TTL_MS = 10 * 60_000;

function oauthError(res: Response, status: number, error: string, description: string): void {
  res
    .status(status)
    .set('Cache-Control', 'no-store')
    .set('Pragma', 'no-cache')
    .json({ error, error_description: description });
}

function redirectWith(
  res: Response,
  redirectUri: string,
  params: Record<string, string | undefined>,
): void {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  res.redirect(302, u.toString());
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/**
 * Builds the OAuth route installers. The public listener gets the machine endpoints;
 * the private (tailnet) listener gets authorize/consent and admin. One pending-request
 * map is shared so a fallback deployment can serve authorize on either listener.
 */
export function createOAuthRoutes(d: OAuthDeps) {
  const { config, audit, tokens, clients, stepup } = d;
  const pending = new Map<string, PendingAuthz>();
  const asMeta = JSON.parse(JSON.stringify(authorizationServerMetadata(config)));

  /** Metadata, token, register, revoke: public listener. */
  function endpoints(app: Express, ctx: AppContext): void {
    const sec = ctx.sec;
    const ip = (req: Request) => ipOf(req, sec);
    const form = express.urlencoded({ extended: false, limit: '16kb', parameterLimit: 30 });
    const json = express.json({ limit: '16kb', type: ['application/json'] });
    app.get('/.well-known/oauth-authorization-server', (_req, res) => {
      res.set('Cache-Control', 'public, max-age=300').json(asMeta);
    });

    // ---------------- /oauth/token ----------------
    app.post(
      '/oauth/token',
      rateLimit(ctx.limiter, 'token', 60, 60_000, ip),
      form,
      json,
      (req, res) => {
        res.set('Cache-Control', 'no-store').set('Pragma', 'no-cache');
        if (req.headers.authorization)
          return oauthError(res, 401, 'invalid_client', 'only public clients are supported');
        const b = (req.body ?? {}) as Record<string, unknown>;
        const clientId = str(b.client_id) ?? '';
        const client = clientId ? clients.known(clientId) : null;
        if (!client) return oauthError(res, 401, 'invalid_client', 'unknown or revoked client');
        const grantType = str(b.grant_type);
        const resource = str(b.resource);
        if (resource !== undefined && resource.replace(/\/$/, '') !== config.mcpResource) {
          return oauthError(res, 400, 'invalid_target', 'unknown resource');
        }

        if (grantType === 'authorization_code') {
          const code = str(b.code) ?? '';
          const verifier = str(b.code_verifier) ?? '';
          const redirectUri = str(b.redirect_uri) ?? '';
          if (!code || !verifier || !redirectUri)
            return oauthError(
              res,
              400,
              'invalid_request',
              'code, code_verifier and redirect_uri are required',
            );
          const r = tokens.consumeCode(code, clientId);
          if (!r.ok) {
            audit.record(r.reason === 'reused' ? 'code_reuse_detected' : 'code_rejected', {
              ip: ip(req),
              clientId,
              detail: { reason: r.reason },
            });
            return oauthError(res, 400, 'invalid_grant', 'invalid authorization code');
          }
          if (r.redirectUri !== redirectUri) {
            audit.record('code_rejected', {
              ip: ip(req),
              clientId,
              detail: { reason: 'redirect_mismatch' },
            });
            return oauthError(res, 400, 'invalid_grant', 'redirect_uri does not match');
          }
          if (!verifyPkce(verifier, r.codeChallenge)) {
            audit.record('code_rejected', { ip: ip(req), clientId, detail: { reason: 'pkce' } });
            return oauthError(res, 400, 'invalid_grant', 'PKCE verification failed');
          }
          const { tokens: issued, familyId } = tokens.issue(r.grant);
          tokens.attachFamilyToCode(r.codeHash, familyId);
          clients.touch(clientId);
          audit.record('token_issued', {
            ip: ip(req),
            clientId,
            subject: r.grant.subject,
            detail: { family: familyId, scope: r.grant.scope },
          });
          return res.json(issued);
        }

        if (grantType === 'refresh_token') {
          const rt = str(b.refresh_token) ?? '';
          if (!rt) return oauthError(res, 400, 'invalid_request', 'refresh_token is required');
          const r = tokens.refresh(rt, clientId);
          if (!r.ok) {
            if (r.familyRevoked) {
              audit.record('refresh_reuse_detected', {
                ip: ip(req),
                clientId,
                detail: { family: r.familyRevoked, action: 'family_revoked' },
              });
            } else {
              audit.record('refresh_rejected', {
                ip: ip(req),
                clientId,
                detail: { reason: r.reason },
              });
            }
            return oauthError(res, 400, 'invalid_grant', 'invalid refresh token');
          }
          const requested = str(b.scope);
          if (
            requested &&
            requested.split(' ').some((s) => !r.grant.scope.split(' ').includes(s))
          ) {
            return oauthError(res, 400, 'invalid_scope', 'scope exceeds the original grant');
          }
          clients.touch(clientId);
          audit.record('token_refreshed', {
            ip: ip(req),
            clientId,
            subject: r.grant.subject,
            detail: { family: r.familyId },
          });
          return res.json(r.tokens);
        }
        return oauthError(
          res,
          400,
          'unsupported_grant_type',
          'grant_type must be authorization_code or refresh_token',
        );
      },
    );

    // ---------------- /oauth/register (RFC 7591) ----------------
    app.post(
      '/oauth/register',
      rateLimit(ctx.limiter, 'register', 20, 3_600_000, ip),
      json,
      (req, res) => {
        res.set('Cache-Control', 'no-store');
        try {
          const out = clients.register(req.body);
          audit.record('client_registered', {
            ip: ip(req),
            clientId: String(out.client_id),
            detail: { name: out.client_name, redirect_uris: out.redirect_uris },
          });
          res.status(201).json(out);
        } catch (err) {
          if (err instanceof ClientError) {
            audit.record('client_registration_rejected', {
              ip: ip(req),
              detail: { reason: err.message },
            });
            return oauthError(
              res,
              400,
              err.code === 'invalid_client' ? 'invalid_client_metadata' : err.code,
              err.message,
            );
          }
          throw err;
        }
      },
    );

    // ---------------- /oauth/revoke (RFC 7009) ----------------
    app.post(
      '/oauth/revoke',
      rateLimit(ctx.limiter, 'revoke', 60, 60_000, ip),
      form,
      json,
      (req, res) => {
        res.set('Cache-Control', 'no-store');
        const b = (req.body ?? {}) as Record<string, unknown>;
        const token = str(b.token);
        if (!token) return oauthError(res, 400, 'invalid_request', 'token is required');
        const clientId = str(b.client_id);
        // Only revoke when the presenting client (if named) owns the token.
        const r = tokens.revokeToken(token);
        if (r) {
          if (clientId && clientId !== r.clientId) {
            audit.record('revoke_client_mismatch', { ip: ip(req), clientId });
          } else {
            audit.record('token_revoked', {
              ip: ip(req),
              clientId: r.clientId,
              detail: { kind: r.kind, family: r.familyId },
            });
          }
        }
        res.status(200).end();
      },
    );
  }

  /** /oauth/authorize and the consent decision (private listener, or public in fallback mode). */
  function authorize(app: Express, ctx: AppContext, login: Login, csrf: Csrf): void {
    const sec = ctx.sec;
    const secure = sec.publicOrigin.startsWith('https://');
    const ip = (req: Request) => ipOf(req, sec);
    const form = express.urlencoded({ extended: false, limit: '16kb', parameterLimit: 30 });
    const owner = login.require();
    // ---------------- /oauth/authorize ----------------
    app.get(
      '/oauth/authorize',
      rateLimit(ctx.limiter, 'authorize', 60, 60_000, ip),
      owner,
      async (req, res) => {
        pageHeaders(res);
        const q = req.query as Record<string, unknown>;
        const clientId = str(q.client_id) ?? '';
        const redirectUri = str(q.redirect_uri) ?? '';
        const fatal = (msg: string) => {
          res
            .status(400)
            .send(
              page(
                'Authorization error',
                `<h1>Authorization error</h1><p>${esc(msg)}</p><p class="muted">Nothing was sent back to the application.</p>`,
              ),
            );
        };
        let client: OAuthClient;
        try {
          client = await clients.resolve(clientId);
        } catch (err) {
          audit.record('authorize_rejected', {
            ip: ip(req),
            clientId: clientId.slice(0, 120),
            detail: { reason: (err as Error).message },
          });
          return fatal(err instanceof ClientError ? err.message : 'unknown client');
        }
        if (!redirectUri || !clients.redirectAllowed(client, redirectUri)) {
          audit.record('authorize_rejected', {
            ip: ip(req),
            clientId,
            detail: { reason: 'redirect_uri not allowed' },
          });
          return fatal(
            'The redirect_uri is not registered for this client or not on the allowlist.',
          );
        }
        const state = str(q.state);
        const err = (error: string, description: string) =>
          redirectWith(res, redirectUri, {
            error,
            error_description: description,
            state,
            iss: config.issuer,
          });
        if (q.response_type !== 'code')
          return err('unsupported_response_type', 'response_type must be code');
        const challenge = str(q.code_challenge);
        if (
          q.code_challenge_method !== 'S256' ||
          !challenge ||
          !/^[A-Za-z0-9_-]{43}$/.test(challenge)
        ) {
          return err('invalid_request', 'PKCE with code_challenge_method=S256 is required');
        }
        const resource = str(q.resource) ?? config.mcpResource;
        if (resource.replace(/\/$/, '') !== config.mcpResource)
          return err('invalid_target', 'unknown resource');
        const requested = (str(q.scope) ?? 'mcp').split(' ').filter(Boolean);
        if (requested.some((s) => !SUPPORTED_SCOPES.includes(s)))
          return err('invalid_scope', 'unsupported scope');
        const scope = Array.from(new Set(['mcp', ...requested])).join(' ');

        const subject = req.owner!.subject;
        const id = randomBytes(24).toString('base64url');
        const created = d.now();
        for (const [k, p] of pending) if (p.expires < created) pending.delete(k);
        if (pending.size > 200) pending.clear();
        pending.set(id, {
          client,
          redirectUri,
          state,
          codeChallenge: challenge,
          scope,
          resource: config.mcpResource,
          subject,
          expires: created + PENDING_TTL_MS,
        });
        // The CSRF token is bound to the live step-up session when there is one; otherwise
        // approving needs a fresh authenticator code in this form.
        const su = stepup.current(req, subject, secure);
        const needCode = stepup.enabled && !su;
        const canApprove = !stepup.enabled || stepup.isEnrolled();
        const token = csrf.issue(req, res, `consent:${id}`, subject, su?.binding ?? 'none');
        const redirectHost = new URL(redirectUri).host;
        const loopback = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(redirectHost);
        const verified = client.kind === 'cimd';
        const existing = tokens.activeFamilies(client.client_id);
        const when = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
        pageHeaders(res, [new URL(redirectUri).origin]);
        res.send(
          page(
            'Allow access?',
            `<h1>Allow access to God's Eye View + Detroit Pulse?</h1>
<div class="card warn">
<p><strong>Only approve if you started connecting this connector yourself, on this device, in the last few minutes.</strong></p>
<p>Anyone can start a connection in their own Claude account and send you the link to this page. Approving it gives <em>their</em> account access to these tools, including your phone's live location.</p>
</div>
<div class="card">
<p><strong>${esc(client.client_name)}</strong> asks for read-only access to this connector's tools, <strong>including your phone's latest location</strong>.</p>
<p class="muted">Client ID: <span class="mono">${esc(client.client_id)}</span><br>
Registration: ${verified ? 'client metadata document fetched from its URL (allowlisted). The client is genuine, but not necessarily your own account' : 'self-registered (dynamic registration): the name is not verified'}<br>
Will return to: <strong class="mono">${esc(redirectHost)}</strong>${loopback ? ' (a program on the computer that opened this page)' : ''}<br>
Access: ${esc(scope)} (read-only tools) for ${esc(config.mcpResource)}<br>
Request started: ${esc(when(created))}; it expires in ${PENDING_TTL_MS / 60_000} minutes</p>
<p>${
              existing.count
                ? `This client already has <strong>${existing.count} active grant(s)</strong>${existing.lastUsedAt ? ` (last used ${esc(when(existing.lastUsedAt))})` : ''}. Approving adds another one. If you did not just reconnect, deny and check <a href="/oauth/admin">admin</a>.`
                : 'This client has no active grant yet.'
            }</p>
</div>
${
  canApprove
    ? ''
    : '<div class="card warn"><p>Approving needs the step-up authenticator code, which is not set up on this gateway yet. On the server, run <code>node dist/scripts/stepup.js enroll</code> (docker: <code>docker exec -it godseye-gateway node dist/scripts/stepup.js enroll</code>).</p></div>'
}
<form method="post" action="/oauth/authorize/decision" class="card">
<input type="hidden" name="request_id" value="${esc(id)}">
<input type="hidden" name="csrf" value="${esc(token)}">
${
  needCode && canApprove
    ? `<label for="totp">Authenticator code (needed to approve)</label><input id="totp" type="text" name="totp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6">`
    : ''
}
<div class="row">
${canApprove ? '<button type="submit" name="decision" value="approve">Approve</button>' : ''}
<button type="submit" name="decision" value="deny" class="secondary" formnovalidate>Deny</button>
</div>
</form>`,
          ),
        );
      },
    );

    app.post(
      '/oauth/authorize/decision',
      rateLimit(ctx.limiter, 'consent', 30, 60_000, ip),
      form,
      owner,
      (req, res) => {
        pageHeaders(res);
        const id = str(req.body?.request_id) ?? '';
        const p = pending.get(id);
        const subject = req.owner!.subject;
        const purpose = `consent:${id}`;
        const su = stepup.current(req, subject, secure);
        const boundToSession = Boolean(
          su && csrf.verify(req, purpose, subject, req.body?.csrf, su.binding),
        );
        const tokenOk =
          boundToSession || csrf.verify(req, purpose, subject, req.body?.csrf, 'none');
        if (!sameOriginPost(sec, req) || !p || !tokenOk || p.subject !== subject) {
          audit.record('consent_rejected', {
            ip: ip(req),
            subject,
            detail: { reason: 'csrf_or_unknown_request' },
          });
          res
            .status(403)
            .send(
              page(
                'Request expired',
                '<h1>Request expired or invalid</h1><p>Start the connection again from Claude.</p>',
              ),
            );
          return;
        }
        if (p.expires < d.now()) {
          pending.delete(id);
          res
            .status(400)
            .send(
              page(
                'Request expired',
                '<h1>Request expired</h1><p>Start the connection again from Claude.</p>',
              ),
            );
          return;
        }
        if (req.body?.decision !== 'approve') {
          pending.delete(id);
          audit.record('authorize_denied', { ip: ip(req), subject, clientId: p.client.client_id });
          return redirectWith(res, p.redirectUri, {
            error: 'access_denied',
            error_description: 'The owner denied access',
            state: p.state,
            iss: config.issuer,
          });
        }
        // Step-up: approving needs a live step-up session bound into the form, or a fresh code.
        if (stepup.enabled && !boundToSession) {
          const check = stepup.verifyCode(req.body?.totp, ip(req));
          if (check !== 'ok') {
            audit.record(check === 'locked' ? 'stepup_locked' : 'stepup_failed', {
              ip: ip(req),
              subject,
              clientId: p.client.client_id,
              detail: { where: 'consent', reason: check },
            });
            res
              .status(check === 'locked' ? 429 : check === 'not_enrolled' ? 503 : 403)
              .send(
                page(
                  'Code not accepted',
                  check === 'not_enrolled'
                    ? '<h1>Step-up not set up</h1><p>Run <code>node dist/scripts/stepup.js enroll</code> on the server, then start the connection again.</p>'
                    : check === 'locked'
                      ? '<h1>Too many wrong codes</h1><p>Approvals are locked for a while. Wait, then start the connection again.</p>'
                      : '<h1>Code not accepted</h1><p>The authenticator code was wrong, expired or already used. Go back, wait for the next code and approve again.</p>',
                ),
              );
            return;
          }
          stepup.setCookie(res, stepup.createSession(subject), secure);
          audit.record('stepup_ok', { ip: ip(req), subject, detail: { where: 'consent' } });
        }
        pending.delete(id);
        const code = tokens.createCode({
          clientId: p.client.client_id,
          redirectUri: p.redirectUri,
          codeChallenge: p.codeChallenge,
          scope: p.scope,
          resource: p.resource,
          subject,
        });
        clients.touch(p.client.client_id);
        audit.record('authorize_approved', {
          ip: ip(req),
          subject,
          clientId: p.client.client_id,
          detail: { scope: p.scope, redirect_host: new URL(p.redirectUri).host },
        });
        redirectWith(res, p.redirectUri, { code, state: p.state, iss: config.issuer });
      },
    );
  }

  /** The step-up form (TOTP) that opens a short step-up session. */
  function stepupForm(token: string, nextPath: string, subject: string, via: string): string {
    return page(
      'Confirm with your authenticator',
      `<h1>Confirm it's you</h1>
<p class="muted">Signed in as ${esc(subject)} via ${esc(via)}.</p>
<div class="card"><p>Admin needs a code from your authenticator app. It stays open for ${Math.round(stepup.windowS / 60)} minutes.</p>
<form method="post" action="/oauth/stepup">
<input type="hidden" name="csrf" value="${esc(token)}">
<input type="hidden" name="next" value="${esc(nextPath)}">
<label for="code">Authenticator code</label><input id="code" type="text" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required autofocus>
<div class="row"><button type="submit">Continue</button></div>
</form></div>`,
    );
  }

  const notEnrolledPage = page(
    'Step-up not set up',
    '<h1>Step-up not set up</h1><p>Admin needs the step-up authenticator code, which is not set up yet. On the server, run <code>node dist/scripts/stepup.js enroll</code> (docker: <code>docker exec -it godseye-gateway node dist/scripts/stepup.js enroll</code>), then reload.</p>',
  );

  /** /oauth/admin and /oauth/stepup (private listener only). */
  function admin(app: Express, ctx: AppContext, login: Login, csrf: Csrf): void {
    const sec = ctx.sec;
    const secure = sec.publicOrigin.startsWith('https://');
    const ip = (req: Request) => ipOf(req, sec);
    const form = express.urlencoded({ extended: false, limit: '16kb', parameterLimit: 30 });
    const owner = login.require();
    const stepupNext = (v: unknown) => {
      const n = safeNext(String(v ?? '/oauth/admin'));
      return n.startsWith('/oauth/') ? n : '/oauth/admin';
    };

    // ---------------- /oauth/stepup ----------------
    app.get('/oauth/stepup', owner, (req, res) => {
      pageHeaders(res);
      const subject = req.owner!.subject;
      if (!stepup.enabled) return res.redirect(303, stepupNext(req.query.next));
      if (!stepup.isEnrolled()) return res.status(503).send(notEnrolledPage);
      const t = csrf.issue(req, res, 'stepup', subject);
      res.status(401).send(stepupForm(t, stepupNext(req.query.next), subject, req.owner!.via));
    });
    app.post(
      '/oauth/stepup',
      rateLimit(ctx.limiter, 'stepup', 10, 15 * 60_000, ip),
      form,
      owner,
      (req, res) => {
        pageHeaders(res);
        const subject = req.owner!.subject;
        if (!sameOriginPost(sec, req) || !csrf.verify(req, 'stepup', subject, req.body?.csrf)) {
          audit.record('stepup_csrf_rejected', { ip: ip(req), subject });
          res.status(403).send(page('Forbidden', '<h1>Forbidden</h1><p>Reload and try again.</p>'));
          return;
        }
        const check = stepup.enabled ? stepup.verifyCode(req.body?.code, ip(req)) : 'ok';
        if (check !== 'ok') {
          audit.record(check === 'locked' ? 'stepup_locked' : 'stepup_failed', {
            ip: ip(req),
            subject,
            detail: { where: 'admin', reason: check },
          });
          if (check === 'not_enrolled') return res.status(503).send(notEnrolledPage);
          res
            .status(check === 'locked' ? 429 : 403)
            .send(
              page(
                'Code not accepted',
                check === 'locked'
                  ? '<h1>Too many wrong codes</h1><p>Step-up is locked for a while. Wait and try again.</p>'
                  : `<h1>Code not accepted</h1><p>The code was wrong, expired or already used. <a href="/oauth/stepup?next=${encodeURIComponent(stepupNext(req.body?.next))}">Try again</a> with the next code.</p>`,
              ),
            );
          return;
        }
        if (stepup.enabled) {
          stepup.setCookie(res, stepup.createSession(subject), secure);
          audit.record('stepup_ok', { ip: ip(req), subject, detail: { where: 'admin' } });
        }
        res.redirect(303, stepupNext(req.body?.next));
      },
    );

    // ---------------- /oauth/admin ----------------
    app.get('/oauth/admin', owner, (req, res) => {
      pageHeaders(res);
      const subject = req.owner!.subject;
      const su = stepup.current(req, subject, secure);
      if (stepup.enabled && !su) {
        if (!stepup.isEnrolled()) return res.status(503).send(notEnrolledPage);
        const st = csrf.issue(req, res, 'stepup', subject);
        return res.status(401).send(stepupForm(st, '/oauth/admin', subject, req.owner!.via));
      }
      const t = csrf.issue(req, res, 'admin', subject, su?.binding ?? '');
      const fmt = (ms: number | null | undefined) =>
        ms ? new Date(ms).toISOString().replace('.000Z', 'Z') : '';
      const clientRows = clients
        .list()
        .map(
          (c) =>
            `<tr><td>${esc(c.client_name)}<br><span class="muted mono">${esc(c.client_id)}</span></td><td>${c.kind}</td><td>${fmt(c.created_at)}</td><td>${fmt(c.last_used_at)}</td><td>${
              c.revoked
                ? 'revoked'
                : `<form method="post" action="/oauth/admin/revoke-client"><input type="hidden" name="csrf" value="${esc(t)}"><input type="hidden" name="client_id" value="${esc(c.client_id)}"><button class="danger" type="submit">Revoke</button></form>`
            }</td></tr>`,
        )
        .join('');
      const families = tokens.listFamilies();
      const recent = families.filter(
        (f) => !f.revoked_at && f.created_at > d.now() - 86_400_000,
      ).length;
      const famRows = families
        .map(
          (f) =>
            `<tr><td class="mono">${esc(f.family_id.slice(0, 8))}</td><td class="mono">${esc(f.client_id.slice(0, 60))}</td><td>${fmt(f.created_at)}</td><td>${fmt(f.last_used_at)}</td><td>${fmt(f.refresh_expires_at)}</td><td>${
              f.revoked_at
                ? `revoked (${esc(f.revoked_reason)})`
                : `<form method="post" action="/oauth/admin/revoke-family"><input type="hidden" name="csrf" value="${esc(t)}"><input type="hidden" name="family_id" value="${esc(f.family_id)}"><button class="danger" type="submit">Revoke</button></form>`
            }</td></tr>`,
        )
        .join('');
      const devRows = d.locations
        .listDevices()
        .map(
          (dv) =>
            `<tr><td>${esc(dv.name)}</td><td>${fmt(dv.created_at)}</td><td>${fmt(dv.last_seen_at)}</td><td>${
              dv.revoked_at
                ? 'revoked'
                : `<form method="post" action="/oauth/admin/revoke-device"><input type="hidden" name="csrf" value="${esc(t)}"><input type="hidden" name="device_id" value="${dv.id}"><button class="danger" type="submit">Revoke</button></form>`
            }</td></tr>`,
        )
        .join('');
      const auditRows = audit
        .recent(50)
        .map(
          (a) =>
            `<tr><td>${fmt(a.ts)}</td><td>${esc(a.event)}</td><td class="mono">${esc((a.client_id ?? '').slice(0, 40))}</td><td class="mono">${esc(a.ip ?? '')}</td></tr>`,
        )
        .join('');
      const lock = su
        ? `<form method="post" action="/oauth/stepup/end" class="row"><input type="hidden" name="csrf" value="${esc(t)}"><span class="muted">Step-up open until ${fmt(su.expiresAt)}.</span> <button class="secondary" type="submit">Lock admin now</button></form>`
        : '';
      res.send(
        page(
          'Connector admin',
          `<h1>Connector admin</h1>
<p class="muted">Signed in as ${esc(subject)} via ${esc(req.owner!.via)}.</p>
${lock}
${recent ? `<div class="card warn"><p><strong>${recent} grant(s) created in the last 24 hours.</strong> Revoke any you don't recognise.</p></div>` : ''}
<h2>OAuth clients</h2><div class="card"><table><tr><th>Client</th><th>Kind</th><th>Registered</th><th>Last used</th><th></th></tr>${clientRows || '<tr><td colspan="5">None</td></tr>'}</table></div>
<h2>Token grants</h2><div class="card"><table><tr><th>Grant</th><th>Client</th><th>Issued</th><th>Last used</th><th>Refresh expires</th><th></th></tr>${famRows || '<tr><td colspan="6">None</td></tr>'}</table></div>
<h2>Location devices</h2><div class="card"><table><tr><th>Name</th><th>Created</th><th>Last fix</th><th></th></tr>${devRows || '<tr><td colspan="4">None</td></tr>'}</table><p class="muted">Add devices with <code>npm run devices -- add NAME</code> on the server.</p></div>
<h2>Recent audit events</h2><div class="card"><table><tr><th>Time</th><th>Event</th><th>Client</th><th>IP</th></tr>${auditRows}</table></div>`,
          { nav: true },
        ),
      );
    });

    /** Admin POSTs: owner, same-origin, a live step-up session, CSRF bound to that session. */
    const adminGuard = (req: Request, res: Response): boolean => {
      const subject = req.owner!.subject;
      const su = stepup.current(req, subject, secure);
      if (
        !sameOriginPost(sec, req) ||
        (stepup.enabled && !su) ||
        !csrf.verify(req, 'admin', subject, req.body?.csrf, su?.binding ?? '')
      ) {
        audit.record('admin_csrf_rejected', {
          ip: ip(req),
          subject,
          detail: { stepup: su ? 'live' : 'none' },
        });
        res
          .status(403)
          .send(
            page(
              'Forbidden',
              '<h1>Forbidden</h1><p>The admin page expired (or its step-up session did). <a href="/oauth/admin">Reload it</a> and try again.</p>',
            ),
          );
        return false;
      }
      return true;
    };
    app.post(
      '/oauth/stepup/end',
      rateLimit(ctx.limiter, 'admin', 60, 60_000, ip),
      form,
      owner,
      (req, res) => {
        pageHeaders(res);
        if (!adminGuard(req, res)) return;
        stepup.end(req, res, secure);
        audit.record('stepup_ended', { ip: ip(req), subject: req.owner!.subject });
        res.redirect(303, '/oauth/admin');
      },
    );
    const adminPost = (path: string, action: (req: Request) => string | undefined) => {
      app.post(path, rateLimit(ctx.limiter, 'admin', 60, 60_000, ip), form, owner, (req, res) => {
        pageHeaders(res);
        if (!adminGuard(req, res)) return;
        const what = action(req);
        audit.record(`admin_${path.split('/').pop()}`, {
          ip: ip(req),
          subject: req.owner!.subject,
          detail: { target: what },
        });
        res.redirect(303, '/oauth/admin');
      });
    };
    adminPost('/oauth/admin/revoke-client', (req) => {
      const id = str(req.body?.client_id);
      if (id) {
        clients.revoke(id);
        tokens.revokeClient(id);
      }
      return id;
    });
    adminPost('/oauth/admin/revoke-family', (req) => {
      const id = str(req.body?.family_id);
      if (id) tokens.revokeFamily(id, 'admin');
      return id;
    });
    adminPost('/oauth/admin/revoke-device', (req) => {
      const id = str(req.body?.device_id);
      if (id && /^\d+$/.test(id)) d.locations.revokeDevice(Number(id));
      return id;
    });
  }

  return { endpoints, authorize, admin };
}
