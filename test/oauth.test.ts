/**
 * End-to-end OAuth flow: public listener (metadata, token, register, revoke, /mcp)
 * plus private listener (authorize, consent, admin), with a mock GEV MCP child.
 * Runs with the tailscale provider (identity header from a trusted local proxy)
 * and with the dev password+TOTP provider.
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
  ownerJar,
  pkce,
  startPasswordGateway,
  startTailscaleGateway,
  tokenRequest,
  type TestGateway,
} from './oauth-helpers.js';

describe.each([
  ['tailscale', startTailscaleGateway],
  ['password', startPasswordGateway],
] as const)('OAuth with the %s provider', (provider, startFn) => {
  let t: TestGateway;
  let jar: Jar;

  beforeAll(async () => {
    t = await startFn();
    jar = await ownerJar(t);
  });
  afterAll(async () => t?.close());

  async function fullFlow(clientId: string, redirectUri = CLAUDE_CALLBACK) {
    const { verifier, challenge } = pkce();
    const state = 'state-123';
    const loc = await approve(t, jar, authorizeUrl(t, { clientId, redirectUri, challenge, state }));
    expect(loc.origin + loc.pathname).toBe(redirectUri);
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

  it('discovery: 401 -> protected resource metadata -> AS metadata with a tailnet authorize endpoint', async () => {
    const r = await fetch(`${t.origin}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(r.status).toBe(401);
    const h = r.headers.get('www-authenticate')!;
    expect(h).toBe(`Bearer resource_metadata="${t.origin}/.well-known/oauth-protected-resource"`);
    const prm = (await (await fetch(/resource_metadata="([^"]+)"/.exec(h)![1]!)).json()) as {
      resource: string;
      authorization_servers: string[];
    };
    expect(prm.resource).toBe(`${t.origin}/mcp`);
    const as = (await (
      await fetch(`${prm.authorization_servers[0]}/.well-known/oauth-authorization-server`)
    ).json()) as Record<string, unknown>;
    expect(as).toMatchObject({
      issuer: t.origin,
      authorization_endpoint: `${t.privateOrigin}/oauth/authorize`,
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

  it('CIMD client (claude.ai) end to end: consent, PKCE exchange, MCP call, refresh rotation, revoke -> 401', async () => {
    const { tok } = await fullFlow(CLAUDE_CIMD_URL);
    expect(tok.status).toBe(200);
    const access = tok.body.access_token as string;
    const refresh = tok.body.refresh_token as string;
    expect(access).toMatch(/^gat_/);
    expect(refresh).toMatch(/^grt_/);
    expect(tok.body).toMatchObject({ token_type: 'Bearer', expires_in: 3600 });
    expect(await mcpList(t.origin, access)).toBe(200);

    const r1 = await tokenRequest(t.origin, {
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: CLAUDE_CIMD_URL,
    });
    expect(r1.status).toBe(200);
    const access2 = r1.body.access_token as string;
    const refresh2 = r1.body.refresh_token as string;
    expect(refresh2).not.toBe(refresh);
    expect(await mcpList(t.origin, access2)).toBe(200);

    const rv = await fetch(`${t.origin}/oauth/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: access2, client_id: CLAUDE_CIMD_URL }),
    });
    expect(rv.status).toBe(200);
    const after = await fetch(`${t.origin}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${access2}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(after.status).toBe(401);
    expect(after.headers.get('www-authenticate')).toMatch(/error="invalid_token"/);

    await fetch(`${t.origin}/oauth/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refresh2 }),
    });
    const r2 = await tokenRequest(t.origin, {
      grant_type: 'refresh_token',
      refresh_token: refresh2,
      client_id: CLAUDE_CIMD_URL,
    });
    expect(r2).toMatchObject({ status: 400, body: { error: 'invalid_grant' } });
  });

  it('DCR client end to end', async () => {
    const reg = await fetch(`${t.origin}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Claude',
        redirect_uris: [CLAUDE_CALLBACK],
        token_endpoint_auth_method: 'none',
      }),
    });
    expect(reg.status).toBe(201);
    const { client_id } = (await reg.json()) as { client_id: string };
    expect(client_id).toMatch(/^dcr_/);
    const { tok } = await fullFlow(client_id);
    expect(tok.status).toBe(200);
    expect(await mcpList(t.origin, tok.body.access_token as string)).toBe(200);
  });

  it('refresh token reuse revokes the whole family', async () => {
    const { tok } = await fullFlow(CLAUDE_CIMD_URL);
    const refresh = tok.body.refresh_token as string;
    const r1 = await tokenRequest(t.origin, {
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: CLAUDE_CIMD_URL,
    });
    expect(r1.status).toBe(200);
    const access2 = r1.body.access_token as string;
    expect(await mcpList(t.origin, access2)).toBe(200);
    const replay = await tokenRequest(t.origin, {
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: CLAUDE_CIMD_URL,
    });
    expect(replay).toMatchObject({ status: 400, body: { error: 'invalid_grant' } });
    expect(await mcpList(t.origin, access2)).toBe(401);
    const r3 = await tokenRequest(t.origin, {
      grant_type: 'refresh_token',
      refresh_token: r1.body.refresh_token as string,
      client_id: CLAUDE_CIMD_URL,
    });
    expect(r3.status).toBe(400);
    expect(t.gw.audit.recent(20).map((e) => e.event)).toContain('refresh_reuse_detected');
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

  it('rejects a wrong PKCE verifier', async () => {
    const loc = await approve(
      t,
      jar,
      authorizeUrl(t, {
        clientId: CLAUDE_CIMD_URL,
        redirectUri: CLAUDE_CALLBACK,
        challenge: pkce().challenge,
      }),
    );
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
    const r = await fetch(
      authorizeUrl(t, {
        clientId: CLAUDE_CIMD_URL,
        redirectUri: 'https://evil.example/cb',
        challenge: pkce().challenge,
      }),
      {
        headers: t.auth(jar),
        redirect: 'manual',
      },
    );
    expect(r.status).toBe(400);
    expect(r.headers.get('location')).toBeNull();
    expect(await r.text()).toMatch(/redirect_uri is not registered/);
  });

  it('rejects non-allowlisted CIMD URLs, non-S256 PKCE and foreign resources', async () => {
    const r = await fetch(
      authorizeUrl(t, {
        clientId: 'https://evil.example/client.json',
        redirectUri: CLAUDE_CALLBACK,
        challenge: pkce().challenge,
      }),
      {
        headers: t.auth(jar),
        redirect: 'manual',
      },
    );
    expect(r.status).toBe(400);
    const u = new URL(
      authorizeUrl(t, {
        clientId: CLAUDE_CIMD_URL,
        redirectUri: CLAUDE_CALLBACK,
        challenge: pkce().challenge,
      }),
    );
    u.searchParams.set('code_challenge_method', 'plain');
    const noPkce = await fetch(u, { headers: t.auth(jar), redirect: 'manual' });
    expect(new URL(noPkce.headers.get('location')!).searchParams.get('error')).toBe(
      'invalid_request',
    );
    const wrongResource = await fetch(
      authorizeUrl(t, {
        clientId: CLAUDE_CIMD_URL,
        redirectUri: CLAUDE_CALLBACK,
        challenge: pkce().challenge,
        resource: 'https://other.example/mcp',
      }),
      {
        headers: t.auth(jar),
        redirect: 'manual',
      },
    );
    expect(new URL(wrongResource.headers.get('location')!).searchParams.get('error')).toBe(
      'invalid_target',
    );
  });

  it('a consent POST without a valid CSRF token or from another origin is rejected', async () => {
    const page = await fetch(
      authorizeUrl(t, {
        clientId: CLAUDE_CIMD_URL,
        redirectUri: CLAUDE_CALLBACK,
        challenge: pkce().challenge,
      }),
      { headers: t.auth(jar) },
    );
    jar.store(page);
    const html = await page.text();
    const requestId = /name="request_id" value="([^"]+)"/.exec(html)![1]!;
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
    const post = (body: Record<string, string>, origin = t.privateOrigin) =>
      fetch(`${t.privateOrigin}/oauth/authorize/decision`, {
        method: 'POST',
        redirect: 'manual',
        headers: { ...t.auth(jar), 'content-type': 'application/x-www-form-urlencoded', origin },
        body: new URLSearchParams(body),
      });
    expect((await post({ request_id: requestId, decision: 'approve' })).status).toBe(403);
    expect(
      (await post({ request_id: requestId, decision: 'approve', csrf: 'forged' })).status,
    ).toBe(403);
    expect(
      (await post({ request_id: requestId, decision: 'approve', csrf }, 'https://evil.example'))
        .status,
    ).toBe(403);
    expect(page.headers.get('content-security-policy')).toMatch(/frame-ancestors 'none'/);
    expect(page.headers.get('x-frame-options')).toBe('DENY');
  });

  it('the deny button returns access_denied', async () => {
    const loc = await approve(
      t,
      jar,
      authorizeUrl(t, {
        clientId: CLAUDE_CIMD_URL,
        redirectUri: CLAUDE_CALLBACK,
        challenge: pkce().challenge,
      }),
      'deny',
    );
    expect(loc.searchParams.get('error')).toBe('access_denied');
  });

  it('admin lists clients and revoking a client kills its tokens', async () => {
    const { tok } = await fullFlow(CLAUDE_CIMD_URL);
    const page = await fetch(`${t.privateOrigin}/oauth/admin`, { headers: t.auth(jar) });
    expect(page.status).toBe(200);
    jar.store(page);
    const html = await page.text();
    expect(html).toContain(CLAUDE_CIMD_URL);
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
    const post = (body: Record<string, string>) =>
      fetch(`${t.privateOrigin}/oauth/admin/revoke-client`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          ...t.auth(jar),
          'content-type': 'application/x-www-form-urlencoded',
          origin: t.privateOrigin,
        },
        body: new URLSearchParams(body),
      });
    expect((await post({ client_id: CLAUDE_CIMD_URL })).status).toBe(403);
    expect((await post({ client_id: CLAUDE_CIMD_URL, csrf })).status).toBe(303);
    expect(await mcpList(t.origin, tok.body.access_token as string)).toBe(401);
    const after = await tokenRequest(t.origin, {
      grant_type: 'refresh_token',
      refresh_token: tok.body.refresh_token as string,
      client_id: CLAUDE_CIMD_URL,
    });
    expect(after.status).toBe(401);
    expect(t.gw.audit.recent(10).map((e) => e.event)).toContain('admin_revoke-client');
  });

  it('owner pages refuse unauthenticated requests', async () => {
    const r = await fetch(`${t.privateOrigin}/oauth/admin`, { redirect: 'manual' });
    expect(r.status).toBe(provider === 'password' ? 302 : 403);
    const a = await fetch(
      authorizeUrl(t, {
        clientId: CLAUDE_CIMD_URL,
        redirectUri: CLAUDE_CALLBACK,
        challenge: pkce().challenge,
      }),
      { redirect: 'manual' },
    );
    expect(a.status).toBe(provider === 'password' ? 302 : 403);
  });
});

describe('client registration', () => {
  let t: TestGateway;
  beforeAll(async () => {
    t = await startTailscaleGateway();
  });
  afterAll(async () => t?.close());

  const register = (body: unknown) =>
    fetch(`${t.origin}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('DCR accepts allowlisted redirect URIs and rejects others', async () => {
    expect(
      (await register({ client_name: 'Claude', redirect_uris: [CLAUDE_CALLBACK] })).status,
    ).toBe(201);
    const bad = await register({ client_name: 'Evil', redirect_uris: ['https://evil.example/cb'] });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe('invalid_redirect_uri');
    expect(
      (
        await register({
          redirect_uris: [CLAUDE_CALLBACK],
          token_endpoint_auth_method: 'client_secret_post',
        })
      ).status,
    ).toBe(400);
  });

  it('loopback redirects match any port for Claude Code style clients', async () => {
    expect(
      (
        await register({
          client_name: 'Claude Code',
          redirect_uris: ['http://localhost:51234/callback'],
        })
      ).status,
    ).toBe(201);
    expect((await register({ redirect_uris: ['http://localhost:51234/other'] })).status).toBe(400);
  });
});

describe('password login hardening', () => {
  it('locks out after repeated failures (generic errors)', async () => {
    const t2 = await startPasswordGateway();
    try {
      const attempt = async (password: string, code: string) => {
        const j = new Jar();
        const pageRes = await fetch(`${t2.privateOrigin}/auth/login`);
        j.store(pageRes);
        const csrf = /name="csrf" value="([^"]+)"/.exec(await pageRes.text())![1]!;
        return fetch(`${t2.privateOrigin}/auth/login`, {
          method: 'POST',
          redirect: 'manual',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            origin: t2.privateOrigin,
            cookie: j.header(),
          },
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

describe('PUBLIC_AUTHORIZE_FALLBACK=password (off by default)', () => {
  it('serves authorize on the public listener behind password+TOTP; admin stays private', async () => {
    const t = await startPasswordGateway({ PUBLIC_AUTHORIZE_FALLBACK: 'password' });
    try {
      const as = (await (
        await fetch(`${t.origin}/.well-known/oauth-authorization-server`)
      ).json()) as Record<string, string>;
      expect(as.authorization_endpoint).toBe(`${t.origin}/oauth/authorize`);
      const anon = await fetch(
        authorizeUrl(t, {
          base: t.origin,
          clientId: CLAUDE_CIMD_URL,
          redirectUri: CLAUDE_CALLBACK,
          challenge: pkce().challenge,
        }),
        { redirect: 'manual' },
      );
      expect(anon.status).toBe(302);
      expect(anon.headers.get('location')).toMatch(/^\/auth\/login/);
      const { passwordLogin, stepUpJar } = await import('./oauth-helpers.js');
      const jar = stepUpJar(t, await passwordLogin(t, new Jar(), { origin: t.origin }));
      const { verifier, challenge } = pkce();
      const loc = await approve(
        t,
        jar,
        authorizeUrl(t, {
          base: t.origin,
          clientId: CLAUDE_CIMD_URL,
          redirectUri: CLAUDE_CALLBACK,
          challenge,
        }),
        'approve',
        { cookie: jar.header() },
      );
      const tok = await tokenRequest(t.origin, {
        grant_type: 'authorization_code',
        code: loc.searchParams.get('code')!,
        redirect_uri: CLAUDE_CALLBACK,
        client_id: CLAUDE_CIMD_URL,
        code_verifier: verifier,
      });
      expect(tok.status).toBe(200);
      expect(
        (await fetch(`${t.origin}/oauth/admin`, { headers: { cookie: jar.header() } })).status,
      ).toBe(404);
    } finally {
      await t.close();
    }
  });

  it('is off by default: the public listener has no authorize or login', async () => {
    const t = await startTailscaleGateway();
    try {
      expect((await fetch(`${t.origin}/oauth/authorize?client_id=x`)).status).toBe(404);
      expect((await fetch(`${t.origin}/auth/login`)).status).toBe(404);
    } finally {
      await t.close();
    }
  });
});
