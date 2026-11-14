/**
 * End-to-end OAuth flow against a gateway on a random 127.0.0.1 port, with a
 * mock GEV MCP child and the password+TOTP login provider.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totp } from '../src/auth/totp.js';
import {
  CLAUDE_CALLBACK,
  CLAUDE_CIMD_URL,
  Jar,
  approve,
  authorizeUrl,
  mcpList,
  passwordLogin,
  pkce,
  startPasswordGateway,
  tokenRequest,
  type TestGateway,
} from './oauth-helpers.js';

let t: TestGateway;
let jar: Jar;

beforeAll(async () => {
  t = await startPasswordGateway();
  jar = await passwordLogin(t);
});
afterAll(async () => t?.close());

async function fullFlow(clientId: string, redirectUri = CLAUDE_CALLBACK) {
  const { verifier, challenge } = pkce();
  const state = 'state-123';
  const loc = await approve(t, jar, authorizeUrl(t.origin, { clientId, redirectUri, challenge, state }));
  expect(loc.origin + loc.pathname).toBe(redirectUri.replace(/:\d+(?=\/)/, (m) => m));
  expect(loc.searchParams.get('state')).toBe(state);
  expect(loc.searchParams.get('iss')).toBe(t.origin);
  const code = loc.searchParams.get('code')!;
  const tok = await tokenRequest(t.origin, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
    resource: `${t.origin}/mcp`,
  });
  return { code, verifier, tok };
}

describe('discovery', () => {
  it('401 on /mcp points at protected resource metadata, which points at the AS', async () => {
    const r = await fetch(`${t.origin}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(r.status).toBe(401);
    const h = r.headers.get('www-authenticate')!;
    expect(h).toBe(`Bearer resource_metadata="${t.origin}/.well-known/oauth-protected-resource"`);
    const prmUrl = /resource_metadata="([^"]+)"/.exec(h)![1]!;
    const prm = (await (await fetch(prmUrl)).json()) as { resource: string; authorization_servers: string[] };
    expect(prm.resource).toBe(`${t.origin}/mcp`);
    const as = (await (await fetch(`${prm.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(as).toMatchObject({
      issuer: t.origin,
      authorization_endpoint: `${t.origin}/oauth/authorize`,
      token_endpoint: `${t.origin}/oauth/token`,
      registration_endpoint: `${t.origin}/oauth/register`,
      revocation_endpoint: `${t.origin}/oauth/revoke`,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
    expect(as.scopes_supported).toContain('offline_access');
  });
});

describe('client registration', () => {
  it('DCR accepts allowlisted redirect URIs and rejects others', async () => {
    const ok = await fetch(`${t.origin}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Claude', redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: 'none' }),
    });
    expect(ok.status).toBe(201);
    const body = (await ok.json()) as { client_id: string; token_endpoint_auth_method: string };
    expect(body.client_id).toMatch(/^dcr_/);
    expect(body.token_endpoint_auth_method).toBe('none');
    const bad = await fetch(`${t.origin}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Evil', redirect_uris: ['https://evil.example/cb'] }),
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe('invalid_redirect_uri');
    const conf = await fetch(`${t.origin}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: 'client_secret_post' }),
    });
    expect(conf.status).toBe(400);
  });

  it('loopback redirects match any port for Claude Code style clients', async () => {
    const ok = await fetch(`${t.origin}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Claude Code', redirect_uris: ['http://localhost:51234/callback'] }),
    });
    expect(ok.status).toBe(201);
    const bad = await fetch(`${t.origin}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['http://localhost:51234/other'] }),
    });
    expect(bad.status).toBe(400);
  });
});

describe('authorization code flow', () => {
  it('CIMD client (claude.ai) end to end: consent, PKCE exchange, MCP call, refresh rotation, revoke', async () => {
    const { tok } = await fullFlow(CLAUDE_CIMD_URL);
    expect(tok.status).toBe(200);
    const access = tok.body.access_token as string;
    const refresh = tok.body.refresh_token as string;
    expect(access).toMatch(/^gat_/);
    expect(refresh).toMatch(/^grt_/);
    expect(tok.body.token_type).toBe('Bearer');
    expect(tok.body.expires_in).toBe(3600);
    expect(await mcpList(t.origin, access)).toBe(200);

    // Refresh rotates both tokens.
    const r1 = await tokenRequest(t.origin, { grant_type: 'refresh_token', refresh_token: refresh, client_id: CLAUDE_CIMD_URL });
    expect(r1.status).toBe(200);
    const access2 = r1.body.access_token as string;
    const refresh2 = r1.body.refresh_token as string;
    expect(refresh2).not.toBe(refresh);
    expect(await mcpList(t.origin, access2)).toBe(200);

    // Revoking the access token -> 401.
    const rv = await fetch(`${t.origin}/oauth/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: access2, client_id: CLAUDE_CIMD_URL }),
    });
    expect(rv.status).toBe(200);
    const after = await fetch(`${t.origin}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${access2}`, 'content-type': 'application/json' }, body: '{}' });
    expect(after.status).toBe(401);
    expect(after.headers.get('www-authenticate')).toMatch(/error="invalid_token"/);

    // Revoking the refresh token kills the family.
    await fetch(`${t.origin}/oauth/revoke`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: refresh2 }) });
    const r2 = await tokenRequest(t.origin, { grant_type: 'refresh_token', refresh_token: refresh2, client_id: CLAUDE_CIMD_URL });
    expect(r2).toMatchObject({ status: 400, body: { error: 'invalid_grant' } });
  });

  it('DCR client end to end', async () => {
    const reg = (await (
      await fetch(`${t.origin}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: [CLAUDE_CALLBACK] }) })
    ).json()) as { client_id: string };
    const { tok } = await fullFlow(reg.client_id);
    expect(tok.status).toBe(200);
    expect(await mcpList(t.origin, tok.body.access_token as string)).toBe(200);
  });

  it('refresh token reuse revokes the whole family', async () => {
    const { tok } = await fullFlow(CLAUDE_CIMD_URL);
    const refresh = tok.body.refresh_token as string;
    const r1 = await tokenRequest(t.origin, { grant_type: 'refresh_token', refresh_token: refresh, client_id: CLAUDE_CIMD_URL });
    expect(r1.status).toBe(200);
    const access2 = r1.body.access_token as string;
    expect(await mcpList(t.origin, access2)).toBe(200);
    // Replaying the rotated refresh token is treated as theft.
    const replay = await tokenRequest(t.origin, { grant_type: 'refresh_token', refresh_token: refresh, client_id: CLAUDE_CIMD_URL });
    expect(replay).toMatchObject({ status: 400, body: { error: 'invalid_grant' } });
    expect(await mcpList(t.origin, access2)).toBe(401);
    const r3 = await tokenRequest(t.origin, { grant_type: 'refresh_token', refresh_token: r1.body.refresh_token as string, client_id: CLAUDE_CIMD_URL });
    expect(r3.status).toBe(400);
    const events = t.gw.audit.recent(20).map((e) => e.event);
    expect(events).toContain('refresh_reuse_detected');
  });

  it('a reused authorization code is rejected and revokes what it issued', async () => {
    const { code, verifier, tok } = await fullFlow(CLAUDE_CIMD_URL);
    expect(tok.status).toBe(200);
    const again = await tokenRequest(t.origin, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: CLAUDE_CALLBACK,
      client_id: CLAUDE_CIMD_URL,
      code_verifier: verifier,
    });
    expect(again).toMatchObject({ status: 400, body: { error: 'invalid_grant' } });
    expect(await mcpList(t.origin, tok.body.access_token as string)).toBe(401);
    expect(t.gw.audit.recent(20).map((e) => e.event)).toContain('code_reuse_detected');
  });

  it('rejects a wrong PKCE verifier and a mismatched redirect_uri', async () => {
    const { challenge } = pkce();
    const loc = await approve(t, jar, authorizeUrl(t.origin, { clientId: CLAUDE_CIMD_URL, redirectUri: CLAUDE_CALLBACK, challenge }));
    const bad = await tokenRequest(t.origin, {
      grant_type: 'authorization_code',
      code: loc.searchParams.get('code')!,
      redirect_uri: CLAUDE_CALLBACK,
      client_id: CLAUDE_CIMD_URL,
      code_verifier: pkce().verifier,
    });
    expect(bad).toMatchObject({ status: 400, body: { error: 'invalid_grant' } });
  });

  it('rejects a non-allowlisted redirect_uri without redirecting', async () => {
    const r = await fetch(authorizeUrl(t.origin, { clientId: CLAUDE_CIMD_URL, redirectUri: 'https://evil.example/cb', challenge: pkce().challenge }), {
      headers: { cookie: jar.header() },
      redirect: 'manual',
    });
    expect(r.status).toBe(400);
    expect(r.headers.get('location')).toBeNull();
    expect(await r.text()).toMatch(/redirect_uri is not registered/);
  });

  it('rejects non-allowlisted CIMD URLs and requires PKCE S256', async () => {
    const r = await fetch(authorizeUrl(t.origin, { clientId: 'https://evil.example/client.json', redirectUri: CLAUDE_CALLBACK, challenge: pkce().challenge }), {
      headers: { cookie: jar.header() },
      redirect: 'manual',
    });
    expect(r.status).toBe(400);
    const u = new URL(authorizeUrl(t.origin, { clientId: CLAUDE_CIMD_URL, redirectUri: CLAUDE_CALLBACK, challenge: pkce().challenge }));
    u.searchParams.set('code_challenge_method', 'plain');
    const noPkce = await fetch(u, { headers: { cookie: jar.header() }, redirect: 'manual' });
    expect(noPkce.status).toBe(302);
    expect(new URL(noPkce.headers.get('location')!).searchParams.get('error')).toBe('invalid_request');
    const wrongResource = await fetch(authorizeUrl(t.origin, { clientId: CLAUDE_CIMD_URL, redirectUri: CLAUDE_CALLBACK, challenge: pkce().challenge, resource: 'https://other.example/mcp' }), {
      headers: { cookie: jar.header() },
      redirect: 'manual',
    });
    expect(new URL(wrongResource.headers.get('location')!).searchParams.get('error')).toBe('invalid_target');
  });

  it('a consent POST without a valid CSRF token is rejected', async () => {
    const page = await fetch(authorizeUrl(t.origin, { clientId: CLAUDE_CIMD_URL, redirectUri: CLAUDE_CALLBACK, challenge: pkce().challenge }), { headers: { cookie: jar.header() } });
    const html = await page.text();
    const requestId = /name="request_id" value="([^"]+)"/.exec(html)![1]!;
    const post = (body: Record<string, string>, headers: Record<string, string> = {}) =>
      fetch(`${t.origin}/oauth/authorize/decision`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: t.origin, cookie: jar.header(), ...headers },
        body: new URLSearchParams(body),
      });
    expect((await post({ request_id: requestId, decision: 'approve' })).status).toBe(403);
    expect((await post({ request_id: requestId, decision: 'approve', csrf: 'forged' })).status).toBe(403);
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
    expect((await post({ request_id: requestId, decision: 'approve', csrf }, { origin: 'https://evil.example' })).status).toBe(403);
    // Consent page is not frameable.
    expect(page.headers.get('content-security-policy')).toMatch(/frame-ancestors 'none'/);
    expect(page.headers.get('x-frame-options')).toBe('DENY');
  });

  it('unauthenticated users are sent to login, and the deny button works', async () => {
    const r = await fetch(authorizeUrl(t.origin, { clientId: CLAUDE_CIMD_URL, redirectUri: CLAUDE_CALLBACK, challenge: pkce().challenge }), { redirect: 'manual' });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toMatch(/^\/auth\/login\?next=/);
    const loc = await approve(t, jar, authorizeUrl(t.origin, { clientId: CLAUDE_CIMD_URL, redirectUri: CLAUDE_CALLBACK, challenge: pkce().challenge }), 'deny');
    expect(loc.searchParams.get('error')).toBe('access_denied');
  });
});

describe('admin', () => {
  it('lists clients and revokes a client, killing its tokens', async () => {
    const { tok } = await fullFlow(CLAUDE_CIMD_URL);
    const access = tok.body.access_token as string;
    const page = await fetch(`${t.origin}/oauth/admin`, { headers: { cookie: jar.header() } });
    expect(page.status).toBe(200);
    jar.store(page);
    const html = await page.text();
    expect(html).toContain(CLAUDE_CIMD_URL);
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
    const noCsrf = await fetch(`${t.origin}/oauth/admin/revoke-client`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: t.origin, cookie: jar.header() },
      body: new URLSearchParams({ client_id: CLAUDE_CIMD_URL }),
    });
    expect(noCsrf.status).toBe(403);
    const res = await fetch(`${t.origin}/oauth/admin/revoke-client`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: t.origin, cookie: jar.header() },
      body: new URLSearchParams({ client_id: CLAUDE_CIMD_URL, csrf }),
    });
    expect(res.status).toBe(303);
    expect(await mcpList(t.origin, access)).toBe(401);
    const tokAfter = await tokenRequest(t.origin, { grant_type: 'refresh_token', refresh_token: tok.body.refresh_token as string, client_id: CLAUDE_CIMD_URL });
    expect(tokAfter.status).toBe(401);
    expect(t.gw.audit.recent(10).map((e) => e.event)).toContain('admin_revoke-client');
  });

  it('admin requires login', async () => {
    const r = await fetch(`${t.origin}/oauth/admin`, { redirect: 'manual' });
    expect(r.status).toBe(302);
  });
});

describe('password login hardening', () => {
  it('locks out after repeated failures (generic errors)', async () => {
    const t2 = await startPasswordGateway();
    try {
      const attempt = async (password: string, code: string) => {
        const j = new Jar();
        const pageRes = await fetch(`${t2.origin}/auth/login`);
        j.store(pageRes);
        const csrf = /name="csrf" value="([^"]+)"/.exec(await pageRes.text())![1]!;
        return fetch(`${t2.origin}/auth/login`, {
          method: 'POST',
          redirect: 'manual',
          headers: { 'content-type': 'application/x-www-form-urlencoded', origin: t2.origin, cookie: j.header() },
          body: new URLSearchParams({ csrf, password, totp: code, next: '/' }),
        });
      };
      for (let i = 0; i < 5; i++) expect((await attempt('wrong', '000000')).status).toBe(401);
      const locked = await attempt(t2.password, totp(t2.totpSecret));
      expect(locked.status).toBe(429);
      expect(await locked.text()).toMatch(/Invalid credentials, or too many attempts/);
    } finally {
      await t2.close();
    }
  });
});
