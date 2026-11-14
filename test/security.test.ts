import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tailscaleIdentity } from '../src/auth/tailscale.js';
import { base32Encode, generateTotpSecret, hotp, totp, verifyTotp } from '../src/auth/totp.js';
import { hashPassword, verifyPassword } from '../src/auth/password.js';
import { safeNext } from '../src/auth/login.js';
import { ConfigError, loadConfig } from '../src/config.js';
import { startGateway, type Gateway } from '../src/gateway.js';
import { nullLogger } from '../src/log.js';
import { CimdFetchError, checkCimdUrl, makeCimdFetcher } from '../src/oauth/cimd.js';
import { redirectMatches, validateCimd } from '../src/oauth/clients.js';
import { installAllRoutes } from '../src/routes.js';
import { isPrivateIp } from '../src/util/net.js';
import { securityConfig } from '../src/app.js';
import { sameOriginPost } from '../src/http/security.js';
import { PROD_ENV } from './helpers.js';
import {
  CLAUDE_CALLBACK,
  CLAUDE_CIMD_URL,
  Jar,
  authorizeUrl,
  fakeCimdFetch,
  freePort,
  pkce,
} from './oauth-helpers.js';

describe('SSRF guards for CIMD fetches', () => {
  it('classifies private and special-use addresses', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.20',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '::1',
      '::',
      'fd7a:115c:a1e0::1',
      'fe80::1',
      '::ffff:10.0.0.1',
      '::ffff:127.0.0.1',
      'not-an-ip',
    ]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
    for (const ip of ['160.79.104.10', '8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])
      expect(isPrivateIp(ip), ip).toBe(false);
  });

  it('classifies non-canonical IPv6 spellings like their canonical forms', () => {
    for (const ip of [
      '0:0:0:0:0:0:0:1',
      '0:0:0:0:0:0:0:0',
      '::0',
      '0::',
      '::0:1',
      '::ffff:7f00:1',
      '0:0:0:0:0:ffff:7f00:1',
      '0:0:0:0:0:FFFF:a00:1', // 10.0.0.1
      '::ffff:0:0',
      'FE80::1',
      'fe80:0:0:0:0:0:0:1',
      'fC00::1',
      'FF02::1',
      '0064:ff9b::7f00:1',
      '2001:0DB8::1',
      '::127.0.0.1', // deprecated IPv4-compatible
      '[::1]',
      '::1%lo',
    ])
      expect(isPrivateIp(ip), ip).toBe(true);
    for (const ip of ['0:0:0:0:0:ffff:808:808', '2606:4700:0:0:0:0:0:1111', '2606:4700:4700::1111'])
      expect(isPrivateIp(ip), ip).toBe(false);
  });

  it('rejects non-https, odd ports, credentials and fragments', () => {
    expect(() => checkCimdUrl('http://claude.ai/oauth/x')).toThrow(CimdFetchError);
    expect(() => checkCimdUrl('https://claude.ai:8443/oauth/x')).toThrow(/port/);
    expect(() => checkCimdUrl('https://u:p@claude.ai/oauth/x')).toThrow(/credentials/);
    expect(() => checkCimdUrl('https://claude.ai/oauth/x#f')).toThrow(/fragment/);
    expect(checkCimdUrl('https://claude.ai/oauth/mcp-oauth-client-metadata').hostname).toBe(
      'claude.ai',
    );
  });

  it('blocks hosts that resolve to private addresses (DNS checked before connecting)', async () => {
    for (const address of ['10.0.0.5', '127.0.0.1', '169.254.169.254', '192.168.1.20']) {
      const fetcher = makeCimdFetcher({ resolver: async () => [{ address, family: 4 }] });
      await expect(fetcher('https://attacker.example/client.json')).rejects.toThrow(/non-public/);
    }
    const mixed = makeCimdFetcher({
      resolver: async () => [
        { address: '8.8.8.8', family: 4 },
        { address: '::1', family: 6 },
      ],
    });
    await expect(mixed('https://attacker.example/client.json')).rejects.toThrow(/non-public/);
    const literal = makeCimdFetcher();
    await expect(literal('https://127.0.0.1/client.json')).rejects.toThrow(/non-public/);
    await expect(literal('https://[::1]/client.json')).rejects.toThrow(/non-public/);
  });

  it('validates CIMD documents', () => {
    const url = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
    expect(
      validateCimd(
        url,
        JSON.stringify({
          client_id: url,
          client_name: 'Claude',
          redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
          token_endpoint_auth_method: 'none',
        }),
      ).client_name,
    ).toBe('Claude');
    expect(() =>
      validateCimd(
        url,
        JSON.stringify({ client_id: 'https://other/x', redirect_uris: ['https://a/b'] }),
      ),
    ).toThrow(/does not match/);
    expect(() => validateCimd(url, JSON.stringify({ client_id: url, redirect_uris: [] }))).toThrow(
      /redirect_uris/,
    );
    expect(() =>
      validateCimd(
        url,
        JSON.stringify({
          client_id: url,
          redirect_uris: ['https://a/b'],
          token_endpoint_auth_method: 'private_key_jwt',
        }),
      ),
    ).toThrow(/public/);
    expect(() => validateCimd(url, 'not json')).toThrow();
  });

  it('redirect matching is exact except loopback ports', () => {
    expect(
      redirectMatches(
        'https://claude.ai/api/mcp/auth_callback',
        'https://claude.ai/api/mcp/auth_callback',
      ),
    ).toBe(true);
    expect(
      redirectMatches(
        'https://claude.ai/api/mcp/auth_callback',
        'https://claude.ai/api/mcp/auth_callback/',
      ),
    ).toBe(false);
    expect(
      redirectMatches(
        'https://claude.ai/api/mcp/auth_callback',
        'https://claude.ai.evil.example/api/mcp/auth_callback',
      ),
    ).toBe(false);
    expect(redirectMatches('http://localhost/callback', 'http://localhost:4321/callback')).toBe(
      true,
    );
    expect(redirectMatches('http://localhost/callback', 'http://localhost:4321/callback?x=1')).toBe(
      false,
    );
    expect(redirectMatches('http://127.0.0.1/callback', 'http://localhost:4321/callback')).toBe(
      false,
    );
  });

  it('open-redirect safe next parameter', () => {
    expect(safeNext('/oauth/admin')).toBe('/oauth/admin');
    for (const bad of [
      '//evil.example',
      'https://evil.example',
      '/\\evil',
      '/x\r\nSet-Cookie: a=b',
    ])
      expect(safeNext(bad)).toBe('/');
  });
});

describe('TOTP and password hashing', () => {
  it('matches RFC 6238 SHA-1 test vectors', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    // RFC 6238 Appendix B (8-digit values; we use the 6-digit suffix).
    expect(totp(secret, 59_000)).toBe('287082');
    expect(totp(secret, 1_111_111_109_000)).toBe('081804');
    expect(totp(secret, 1_234_567_890_000)).toBe('005924');
    expect(hotp(Buffer.from('12345678901234567890'), 0)).toBe('755224'); // RFC 4226
    expect(verifyTotp(secret, '287082', 59_000)).toBe(1);
    expect(verifyTotp(secret, '287082', 59_000 + 60_000)).toBeNull();
    expect(verifyTotp(secret, 'abcdef', 59_000)).toBeNull();
  });

  it('scrypt hashes verify only the right password', async () => {
    const h = await hashPassword('s3cret pass', 10);
    expect(h).toMatch(/^scrypt\$10\$8\$1\$/);
    expect(await verifyPassword('s3cret pass', h)).toBe(true);
    expect(await verifyPassword('s3cret pas', h)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });
});

describe('Tailscale identity (private listener)', () => {
  const fakeReq = (remote: string, headers: Record<string, string | string[]>) =>
    ({ socket: { remoteAddress: remote }, headers }) as never;
  const opts = { trustedProxies: ['127.0.0.1', '::1'], ownerLogin: 'owner@example.com' };

  it('trusts the login header only from the trusted proxy and only for the owner', () => {
    expect(
      tailscaleIdentity(
        fakeReq('127.0.0.1', { 'tailscale-user-login': 'Owner@Example.com' }),
        opts,
      ),
    ).toMatchObject({ login: 'owner@example.com' });
    expect(
      tailscaleIdentity(
        fakeReq('::ffff:127.0.0.1', { 'tailscale-user-login': 'owner@example.com' }),
        opts,
      ),
    ).not.toBeNull();
    expect(
      tailscaleIdentity(
        fakeReq('172.30.77.11', { 'tailscale-user-login': 'owner@example.com' }),
        opts,
      ),
    ).toBeNull();
    expect(
      tailscaleIdentity(
        fakeReq('127.0.0.1', { 'tailscale-user-login': 'someone@example.com' }),
        opts,
      ),
    ).toBeNull();
    expect(tailscaleIdentity(fakeReq('127.0.0.1', {}), opts)).toBeNull();
    expect(
      tailscaleIdentity(
        fakeReq('127.0.0.1', { 'tailscale-user-login': ['owner@example.com', 'x@y'] }),
        opts,
      ),
    ).toBeNull();
    expect(
      tailscaleIdentity(
        fakeReq('127.0.0.1', { 'tailscale-user-login': 'owner@example.com, other@x' }),
        opts,
      ),
    ).toBeNull();
  });
});

describe('production configuration', () => {
  /** The values deploy/docker-compose.yml sets. */
  const binds = {
    HOST: '172.30.77.20',
    PRIVATE_HOST: '127.0.0.2',
    TRUSTED_PROXY_IPS: '172.30.77.10',
    TAILSCALE_TRUSTED_PROXY_IPS: '127.0.0.1',
    STEPUP_KEY: PROD_ENV.STEPUP_KEY!,
  };
  const prod = {
    GATEWAY_MODE: 'production',
    PRIVATE_ORIGIN: 'https://godseye.example-tailnet.ts.net',
    OWNER_TAILSCALE_LOGIN: 'owner@example.com',
    ...binds,
  };
  it('refuses listeners the userspace netstack can reach, and loopback proxy trust', () => {
    expect(loadConfig(prod).PRIVATE_HOST).toBe('127.0.0.2');
    for (const PRIVATE_HOST of ['127.0.0.1', '0.0.0.0', '::', '::1', 'localhost', '172.30.77.20'])
      expect(() => loadConfig({ ...prod, PRIVATE_HOST }), PRIVATE_HOST).toThrow(/PRIVATE_HOST/);
    for (const HOST of ['0.0.0.0', '::', '127.0.0.1', '::1', 'localhost', 'gateway'])
      expect(() => loadConfig({ ...prod, HOST }), HOST).toThrow(/HOST to be/);
    for (const TRUSTED_PROXY_IPS of ['127.0.0.1', '172.30.77.10,::1', '', 'cloudflared'])
      expect(() => loadConfig({ ...prod, TRUSTED_PROXY_IPS }), TRUSTED_PROXY_IPS).toThrow(
        /TRUSTED_PROXY_IPS/,
      );
    expect(() => loadConfig({ ...prod, TAILSCALE_TRUSTED_PROXY_IPS: '172.30.77.10' })).toThrow(
      /TAILSCALE_TRUSTED_PROXY_IPS/,
    );
    // The defaults (127.0.0.1 everywhere) are refused outright in production.
    expect(() =>
      loadConfig({
        GATEWAY_MODE: 'production',
        PRIVATE_ORIGIN: prod.PRIVATE_ORIGIN,
        OWNER_TAILSCALE_LOGIN: prod.OWNER_TAILSCALE_LOGIN,
        STEPUP_KEY: prod.STEPUP_KEY,
      }),
    ).toThrow(ConfigError);
    // Development keeps loopback defaults (host tailscale serve, kernel TUN).
    expect(loadConfig({}).PRIVATE_HOST).toBe('127.0.0.1');
  });
  it('fails closed without the Tailscale owner or an https tailnet origin', () => {
    expect(() => loadConfig({ GATEWAY_MODE: 'production' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...prod, OWNER_TAILSCALE_LOGIN: '' })).toThrow(
      /OWNER_TAILSCALE_LOGIN/,
    );
    expect(() =>
      loadConfig({ ...prod, PRIVATE_ORIGIN: 'http://godseye.example-tailnet.ts.net' }),
    ).toThrow(/https PRIVATE_ORIGIN/);
    expect(() =>
      loadConfig({
        ...prod,
        LOGIN_PROVIDER: 'password',
        GATEWAY_PASSWORD_HASH: 'x',
        GATEWAY_TOTP_SECRET: 'y',
      }),
    ).toThrow(/not allowed in production/);
    const c = loadConfig(prod);
    expect(c.loginProvider).toBe('tailscale');
    expect(c.authorizationEndpoint).toBe('https://godseye.example-tailnet.ts.net/oauth/authorize');
    expect(c.issuer).toBe('https://godseye.gamachecloud.com');
    expect(c.mcpResource).toBe('https://godseye.gamachecloud.com/mcp');
    // Globe links open the UI origin, a different origin from consent and admin.
    expect(c.linkOrigin).toBe('https://godseye.example-tailnet.ts.net:8443');
    expect(c.uiOrigin).toBe('https://godseye.example-tailnet.ts.net:8443');
    expect(() => loadConfig({ ...prod, UI_ORIGIN: prod.PRIVATE_ORIGIN })).toThrow(/UI_ORIGIN/);
    expect(() =>
      loadConfig({ ...prod, UI_ORIGIN: 'http://godseye.example-tailnet.ts.net:8443' }),
    ).toThrow(/https UI_ORIGIN/);
    expect(() => loadConfig({ ...prod, UI_HOST: '127.0.0.1' })).toThrow(/UI_HOST/);
    expect(c.publicAuthorize).toBe(false);
  });
  it('refuses non-canonical spellings of wildcard and loopback binds exactly like the canonical ones', () => {
    // Each of these, once bound, accepts connections to 127.0.0.1 (where the netstack re-dials).
    const reachable = [
      '0:0:0:0:0:0:0:0',
      '0000:0000:0000:0000:0000:0000:0000:0000',
      '::0',
      '0::',
      '[::]',
      '::ffff:0:0',
      '::ffff:0.0.0.0',
      '::ffff:7f00:1',
      '0:0:0:0:0:ffff:7f00:1',
      '::FFFF:127.0.0.1',
      '0:0:0:0:0:0:0:1',
      '::0:1',
      '[::1]',
      '::1%lo',
      ' 0.0.0.0 ',
      ' 127.0.0.1',
      'LOCALHOST',
      'localhost.',
    ];
    for (const HOST of reachable)
      expect(() => loadConfig({ ...prod, HOST }), HOST).toThrow(/HOST to be/);
    // The private and UI listeners take only a bare dotted 127.x alias other than 127.0.0.1.
    for (const host of [...reachable, '::ffff:7f00:2', '::ffff:127.0.0.2'])
      for (const name of ['PRIVATE_HOST', 'UI_HOST'])
        expect(() => loadConfig({ ...prod, [name]: host }), `${name}=${host}`).toThrow(
          new RegExp(name),
        );
    expect(() => loadConfig({ ...prod, PRIVATE_HOST: '127.0.0.2 ' })).toThrow(/PRIVATE_HOST/);
    // (UI_HOST is trimmed when read, so this one binds 127.0.0.2.)
    expect(loadConfig({ ...prod, UI_HOST: '127.0.0.2 ' }).uiHost).toBe('127.0.0.2');
    for (const ip of ['0:0:0:0:0:0:0:1', '::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:1', '::0'])
      expect(() => loadConfig({ ...prod, TRUSTED_PROXY_IPS: ip }), ip).toThrow(/TRUSTED_PROXY_IPS/);
    // Another spelling of a fine address stays fine.
    expect(loadConfig({ ...prod, HOST: '::ffff:172.30.77.20' }).mode).toBe('production');
    expect(loadConfig({ ...prod, UI_HOST: '127.0.0.4' }).uiHost).toBe('127.0.0.4');
  });

  it('sameOriginPost compares only the configured origin in production', () => {
    const req = (headers: Record<string, string>) =>
      ({ protocol: 'http', headers: { host: '127.0.0.2:7702', ...headers } }) as never;
    const c = loadConfig(prod);
    for (const l of ['public', 'private', 'ui'] as const) {
      const sec = securityConfig(c, l);
      expect(sec.strictOrigin, l).toBe(true);
      expect(sameOriginPost(sec, req({ origin: sec.publicOrigin }))).toBe(true);
      expect(sameOriginPost(sec, req({ origin: 'http://127.0.0.2:7702' }))).toBe(false);
    }
    // Dev keeps accepting the browser's own http://<Host> (e.g. localhost vs 127.0.0.1).
    const dev = securityConfig(loadConfig({}), 'private');
    expect(dev.strictOrigin).toBe(false);
    expect(sameOriginPost(dev, req({ origin: 'http://127.0.0.2:7702' }))).toBe(true);
    expect(sameOriginPost(dev, req({ origin: 'https://evil.example' }))).toBe(false);
  });

  it('the public authorize fallback is opt-in and needs password+TOTP', () => {
    expect(() => loadConfig({ ...prod, PUBLIC_AUTHORIZE_FALLBACK: 'password' })).toThrow(
      /GATEWAY_PASSWORD_HASH/,
    );
    const c = loadConfig({
      ...prod,
      PUBLIC_AUTHORIZE_FALLBACK: 'password',
      GATEWAY_PASSWORD_HASH: 'scrypt$x',
      GATEWAY_TOTP_SECRET: 'ABC',
    });
    expect(c.authorizationEndpoint).toBe('https://godseye.gamachecloud.com/oauth/authorize');
  });
});

describe('production mode listeners', () => {
  let gw: Gateway;
  let dir: string;
  const OWNER = 'owner@example.com';
  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'gw-prod-'));
    const config = loadConfig({
      ...PROD_ENV,
      PORT: String(await freePort()),
      PRIVATE_PORT: String(await freePort()),
      UI_PORT: String(await freePort()),
      OWNER_TAILSCALE_LOGIN: OWNER,
      DATA_DIR: dir,
      GEV_MCP_ENABLED: 'false',
    });
    gw = await startGateway(config, {
      logger: nullLogger,
      gevChild: false,
      routes: installAllRoutes({ cimdFetch: fakeCimdFetch }),
    });
  });
  afterAll(async () => {
    await gw?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('private owner routes reject a missing or wrong Tailscale identity and accept the owner', async () => {
    for (const p of ['/oauth/admin', '/oauth/authorize?client_id=x', '/locate/', '/pulse/', '/']) {
      expect((await fetch(gw.privateUrl + p, { redirect: 'manual' })).status, p).toBe(403);
      expect(
        (
          await fetch(gw.privateUrl + p, {
            redirect: 'manual',
            headers: { 'tailscale-user-login': 'intruder@example.com' },
          })
        ).status,
        p,
      ).toBe(403);
    }
    // Not enrolled yet: admin refuses (step-up is on by default and fails closed).
    const notYet = await fetch(gw.privateUrl + '/oauth/admin', {
      headers: { 'tailscale-user-login': OWNER },
    });
    expect(notYet.status).toBe(503);
    gw.stepup.enroll(generateTotpSecret());
    // The owner is recognised, and asked for the step-up code before admin opens.
    const ok = await fetch(gw.privateUrl + '/oauth/admin', {
      headers: { 'tailscale-user-login': OWNER },
    });
    expect(ok.status).toBe(401);
    const html = await ok.text();
    expect(html).toContain('Signed in as owner@example.com via tailscale');
    expect(html).toContain('action="/oauth/stepup"');
    expect((await fetch(gw.privateUrl + '/auth/login')).status).toBe(404); // no password login in production
  });

  it('owner form POSTs must carry the configured https origin, never http://<Host>', async () => {
    const p = pkce();
    const url = authorizeUrl(
      { origin: 'https://godseye.gamachecloud.com', privateOrigin: gw.privateUrl },
      { clientId: CLAUDE_CIMD_URL, redirectUri: CLAUDE_CALLBACK, challenge: p.challenge },
    );
    const jar = new Jar();
    const page = await fetch(url, { headers: { 'tailscale-user-login': OWNER } });
    expect(page.status).toBe(200);
    jar.store(page);
    const html = await page.text();
    const requestId = /name="request_id" value="([^"]+)"/.exec(html)![1]!;
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
    const decide = (origin: string) =>
      fetch(`${gw.privateUrl}/oauth/authorize/decision`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'tailscale-user-login': OWNER,
          cookie: jar.header(),
          'content-type': 'application/x-www-form-urlencoded',
          'sec-fetch-site': 'same-origin',
          origin,
        },
        // Deny needs no step-up code, so only the origin check decides here.
        body: new URLSearchParams({ request_id: requestId, csrf, decision: 'deny' }),
      });
    // Behind tailscale serve req.protocol is http, so http://<Host> used to pass.
    const host = new URL(gw.privateUrl).host;
    expect((await decide(`http://${host}`)).status).toBe(403);
    expect((await decide('http://godseye.example-tailnet.ts.net')).status).toBe(403);
    const ok = await decide('https://godseye.example-tailnet.ts.net');
    expect(ok.status).toBe(302);
    expect(new URL(ok.headers.get('location')!).searchParams.get('error')).toBe('access_denied');
  });

  it('the public listener 404s every UI path, even with an identity header', async () => {
    for (const p of [
      '/',
      '/index.html',
      '/assets/app.js',
      '/pulse/',
      '/locate/',
      '/oauth/authorize',
      '/oauth/admin',
      '/auth/login',
      '/gw/static/app.css',
      '/api/setup/status',
      '/panel/',
    ]) {
      const r = await fetch(gw.url + p, {
        redirect: 'manual',
        headers: { 'tailscale-user-login': OWNER },
      });
      expect(r.status, p).toBe(404);
    }
  });

  it('the public listener serves only the machine endpoints and leaks nothing', async () => {
    const h = await fetch(gw.url + '/healthz');
    expect(await h.json()).toEqual({ ok: true });
    expect(h.headers.get('strict-transport-security')).toMatch(/max-age/);
    expect(h.headers.get('x-content-type-options')).toBe('nosniff');
    expect(h.headers.get('referrer-policy')).toBe('same-origin');
    expect(h.headers.get('access-control-allow-origin')).toBeNull();
    const mcp = await fetch(gw.url + '/mcp', {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
    });
    expect(mcp.status).toBe(401);
    expect(mcp.headers.get('www-authenticate')).toBe(
      'Bearer resource_metadata="https://godseye.gamachecloud.com/.well-known/oauth-protected-resource"',
    );
    const as = (await (
      await fetch(gw.url + '/.well-known/oauth-authorization-server')
    ).json()) as Record<string, string>;
    expect(as.authorization_endpoint).toBe(
      'https://godseye.example-tailnet.ts.net/oauth/authorize',
    );
    expect(as.token_endpoint).toBe('https://godseye.gamachecloud.com/oauth/token');
    expect((await fetch(gw.url + '/api/location', { method: 'POST', body: '{}' })).status).toBe(
      401,
    );
    expect(
      (
        await fetch(gw.url + '/oauth/token', {
          method: 'POST',
          body: 'grant_type=x',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
        })
      ).status,
    ).toBe(401);
    // The private listener has no /mcp.
    expect(
      (
        await fetch(gw.privateUrl + '/mcp', {
          method: 'POST',
          body: '{}',
          headers: { 'tailscale-user-login': OWNER },
        })
      ).status,
    ).toBe(404);
  });
});

describe('owner form POSTs carry a real Origin in browsers', () => {
  // Under Referrer-Policy no-referrer, browsers send `Origin: null` on every form POST
  // (Fetch spec, "append a request Origin header"), so the strict owner-POST check refused
  // every real consent approval. same-origin keeps the origin on same-origin POSTs and still
  // sends no referrer anywhere else.
  it('gateway pages never set no-referrer, in the header or in the page', async () => {
    const { page } = await import('../src/ui/html.js');
    const html = page('t', '<p>x</p>');
    expect(html).toContain('<meta name="referrer" content="same-origin">');
    expect(html).not.toMatch(/no-referrer/);
  });
});
