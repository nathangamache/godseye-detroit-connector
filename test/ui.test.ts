import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { startGateway, type Gateway } from '../src/gateway.js';
import { nullLogger } from '../src/log.js';
import { installAllRoutes } from '../src/routes.js';
import { PROXY_SIGNAL_HEADERS, isBlocked, safePath, upstreamHeaders } from '../src/ui/proxy.js';
import {
  fakeCimdFetch,
  freePort,
  passwordLogin,
  startPasswordGateway,
  type Jar,
  type TestGateway,
} from './oauth-helpers.js';

const OWNER = 'owner@example.com';

/** Fake GEV preview: echoes what it received. */
async function fakeGev(): Promise<{
  url: string;
  seen: Array<{ path: string; headers: IncomingHttpHeaders }>;
  server: Server;
}> {
  const seen: Array<{ path: string; headers: IncomingHttpHeaders }> = [];
  const server = createServer((req, res) => {
    seen.push({ path: req.url ?? '', headers: req.headers });
    if (req.url === '/api/ghostmaps/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write('data: first\n\n');
      setTimeout(() => res.end('data: second\n\n'), 400);
      return;
    }
    if (req.url === '/redirect') {
      res
        .writeHead(302, {
          location: `http://127.0.0.1:${(server.address() as { port: number }).port}/landing`,
        })
        .end();
      return;
    }
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-security-policy': "frame-ancestors 'none'",
    });
    res.end(JSON.stringify({ path: req.url, method: req.method }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen, server };
}

describe('proxy helpers', () => {
  it('strips all nine proxy headers, cookies and auth; rewrites Host and Origin', () => {
    const incoming: IncomingHttpHeaders = {
      host: 'godseye.gamachecloud.com',
      origin: 'https://godseye.gamachecloud.com',
      cookie: 'gw_session=abc; CF_Authorization=jwt',
      authorization: 'Bearer x',
      'cf-access-jwt-assertion': 'jwt',
      'cf-ipcountry': 'US',
      'sec-fetch-site': 'same-origin',
      accept: 'text/html',
      connection: 'keep-alive, x-custom',
      'x-custom': 'hop',
    };
    for (const h of PROXY_SIGNAL_HEADERS) incoming[h] = '1.2.3.4';
    const out = upstreamHeaders(
      incoming,
      new URL('http://127.0.0.1:7701'),
      'https://godseye.gamachecloud.com',
    ) as Record<string, string>;
    for (const h of PROXY_SIGNAL_HEADERS) expect(out[h], h).toBeUndefined();
    expect(out.host).toBe('127.0.0.1:7701');
    expect(out.origin).toBe('http://127.0.0.1:7701');
    expect(out.cookie).toBeUndefined();
    expect(out.authorization).toBeUndefined();
    expect(out['cf-access-jwt-assertion']).toBeUndefined();
    expect(out['cf-ipcountry']).toBeUndefined();
    expect(out['x-custom']).toBeUndefined();
    expect(out['sec-fetch-site']).toBe('same-origin');
    expect(
      upstreamHeaders(
        { origin: 'https://evil.example' },
        new URL('http://127.0.0.1:7701'),
        'https://godseye.gamachecloud.com',
      ),
    ).toEqual({ forbidden: 'cross-origin request' });
  });

  it('blocks dangerous GEV routes and path tricks', () => {
    const blocked = ['/api/setup', '/api/realtime/oauth', '/mcp', '/panel', '/@', '/__', '/.env'];
    for (const p of [
      '/api/setup/keys',
      '/API/Setup/keys',
      '/api/realtime/oauth-start',
      '/mcp',
      '/panel/',
      '/@vite/client',
      '/__open-in-editor',
      '/.env',
      '/%61pi/setup/keys',
    ]) {
      expect(isBlocked(p, blocked), p).toBe(true);
    }
    expect(isBlocked('/api/flights', blocked)).toBe(false);
    for (const p of ['/a/../api/setup', '/a/%2e%2e/api/setup', '/api%2fsetup', '/a\\b', '/%00'])
      expect(safePath(p), p).toBeNull();
    expect(safePath('//assets//x.js?v=1')).toEqual({ path: '/assets/x.js', search: '?v=1' });
  });
});

describe('UI routes (dev / password login)', () => {
  let t: TestGateway;
  let jar: Jar;
  let gev: Awaited<ReturnType<typeof fakeGev>>;
  let pulseDir: string;

  beforeAll(async () => {
    gev = await fakeGev();
    t = await startPasswordGateway({ GEV_URL: gev.url, GEV_MCP_ENABLED: 'false' });
    jar = await passwordLogin(t);
  });
  afterAll(async () => {
    await t?.close();
    gev?.server.close();
    if (pulseDir) rmSync(pulseDir, { recursive: true, force: true });
  });

  it('requires login before proxying anything', async () => {
    const before = gev.seen.length;
    const r = await fetch(`${t.privateOrigin}/`, { redirect: 'manual' });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toMatch(/^\/auth\/login/);
    expect(gev.seen.length).toBe(before);
  });

  it('proxies to GEV with clean headers', async () => {
    const r = await fetch(`${t.privateOrigin}/api/tomtom/status?x=1`, {
      headers: {
        cookie: jar.header(),
        origin: t.privateOrigin,
        'cf-connecting-ip': '203.0.113.9',
        'x-forwarded-for': '203.0.113.9',
        'x-forwarded-proto': 'https',
        'cf-ray': 'abc',
        via: '1.1 cloudflare',
        forwarded: 'for=203.0.113.9',
        'x-real-ip': '203.0.113.9',
      },
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ path: '/api/tomtom/status?x=1', method: 'GET' });
    const got = gev.seen.at(-1)!.headers;
    for (const h of PROXY_SIGNAL_HEADERS) expect(got[h], h).toBeUndefined();
    expect(got.host).toBe(new URL(gev.url).host);
    expect(got.origin).toBe(gev.url);
    expect(got.cookie).toBeUndefined();
    expect(r.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
  });

  it('blocks GEV setup/oauth/mcp/panel routes without contacting GEV', async () => {
    const before = gev.seen.length;
    for (const p of ['/api/setup/keys', '/api/realtime/oauth-start', '/panel/', '/@vite/client']) {
      const r = await fetch(`${t.origin}${p}`, { headers: { cookie: jar.header() } });
      expect(r.status, p).toBe(404);
    }
    expect(gev.seen.length).toBe(before);
    // /mcp lives only on the public listener; on the private one it is reserved (404), never GEV's.
    expect(
      (await fetch(`${t.privateOrigin}/mcp`, { headers: { cookie: jar.header() } })).status,
    ).toBe(404);
    expect((await fetch(`${t.origin}/mcp`, { method: 'POST', body: '{}' })).status).toBe(401);
    // Gateway-reserved paths don't fall through either.
    expect(
      (await fetch(`${t.privateOrigin}/oauth/nothing`, { headers: { cookie: jar.header() } }))
        .status,
    ).toBe(404);
    expect(gev.seen.length).toBe(before);
  });

  it('refuses cross-origin requests at the proxy', async () => {
    const r = await fetch(`${t.privateOrigin}/api/realtime/token`, {
      method: 'POST',
      headers: { cookie: jar.header(), origin: 'https://evil.example' },
      body: '{}',
    });
    expect(r.status).toBe(403);
  });

  it('streams SSE without buffering and rewrites Location', async () => {
    const t0 = Date.now();
    const r = await fetch(`${t.privateOrigin}/api/ghostmaps/events`, {
      headers: { cookie: jar.header(), accept: 'text/event-stream' },
    });
    const reader = r.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain('data: first');
    expect(Date.now() - t0).toBeLessThan(350);
    await reader.cancel();
    const red = await fetch(`${t.privateOrigin}/redirect`, {
      headers: { cookie: jar.header() },
      redirect: 'manual',
    });
    expect(red.headers.get('location')).toBe(`${t.privateOrigin}/landing`);
  });

  it('/pulse shows a placeholder when no build is configured', async () => {
    const r = await fetch(`${t.privateOrigin}/pulse/`, { headers: { cookie: jar.header() } });
    expect(r.status).toBe(200);
    expect(await r.text()).toMatch(/Pulse isn't running/);
    expect(
      (
        await fetch(`${t.privateOrigin}/pulse`, {
          redirect: 'manual',
          headers: { cookie: jar.header() },
        })
      ).status,
    ).toBe(301);
  });

  it('/healthz returns only {ok:true} on both listeners', async () => {
    expect(await (await fetch(`${t.privateOrigin}/healthz`)).json()).toEqual({ ok: true });
    expect(await (await fetch(`${t.origin}/healthz`)).json()).toEqual({ ok: true });
  });

  it('the public listener never proxies to GEV or serves UI pages', async () => {
    const before = gev.seen.length;
    for (const p of [
      '/',
      '/api/tomtom/status',
      '/pulse/',
      '/locate/',
      '/oauth/admin',
      '/auth/login',
      '/gw/static/app.css',
    ]) {
      expect(
        (await fetch(`${t.origin}${p}`, { headers: { cookie: jar.header() }, redirect: 'manual' }))
          .status,
        p,
      ).toBe(404);
    }
    expect(gev.seen.length).toBe(before);
  });

  it('serves a Pulse static build when PULSE_STATIC_DIR is set', async () => {
    pulseDir = mkdtempSync(path.join(tmpdir(), 'pulse-ui-'));
    writeFileSync(path.join(pulseDir, 'index.html'), '<!doctype html><title>Pulse UI</title>');
    const t2 = await startPasswordGateway({
      GEV_URL: gev.url,
      GEV_MCP_ENABLED: 'false',
      PULSE_STATIC_DIR: pulseDir,
    });
    try {
      const j = await passwordLogin(t2);
      const r = await fetch(`${t2.privateOrigin}/pulse/incidents/123`, {
        headers: { cookie: j.header() },
      });
      expect(await r.text()).toMatch(/Pulse UI/);
    } finally {
      await t2.close();
    }
  });
});

describe('UI routes in production mode (Tailscale identity required)', () => {
  let gw: Gateway;
  let dir: string;
  let gev: Awaited<ReturnType<typeof fakeGev>>;

  beforeAll(async () => {
    gev = await fakeGev();
    dir = mkdtempSync(path.join(tmpdir(), 'gw-ui-prod-'));
    const config = loadConfig({
      GATEWAY_MODE: 'production',
      PORT: String(await freePort()),
      PRIVATE_PORT: String(await freePort()),
      PRIVATE_ORIGIN: 'https://godseye.example-tailnet.ts.net',
      OWNER_TAILSCALE_LOGIN: OWNER,
      DATA_DIR: dir,
      GEV_URL: gev.url,
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
    gev?.server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects requests without the Tailscale identity header or from a non-owner login', async () => {
    const before = gev.seen.length;
    for (const p of ['/', '/assets/app.js', '/pulse/', '/locate/', '/oauth/admin']) {
      expect((await fetch(gw.privateUrl + p, { redirect: 'manual' })).status, p).toBe(403);
      expect(
        (
          await fetch(gw.privateUrl + p, {
            redirect: 'manual',
            headers: { 'tailscale-user-login': 'someone@else.com' },
          })
        ).status,
        p,
      ).toBe(403);
      expect(
        (
          await fetch(gw.privateUrl + p, {
            redirect: 'manual',
            headers: { 'tailscale-user-login': '' },
          })
        ).status,
        p,
      ).toBe(403);
    }
    expect(gev.seen.length).toBe(before);
  });

  it('accepts the owner and proxies to GEV without forwarding identity headers', async () => {
    const r = await fetch(gw.privateUrl + '/', {
      headers: {
        'tailscale-user-login': OWNER,
        'tailscale-user-name': 'Owner',
        origin: 'https://godseye.example-tailnet.ts.net',
      },
    });
    expect(r.status).toBe(200);
    const seen = gev.seen.at(-1)!.headers;
    expect(seen['tailscale-user-login']).toBeUndefined();
    expect(seen['tailscale-user-name']).toBeUndefined();
    expect(seen.origin).toBe(gev.url);
    expect(
      (await fetch(gw.privateUrl + '/locate/', { headers: { 'tailscale-user-login': OWNER } }))
        .status,
    ).toBe(200);
  });

  it('distrusts identity headers from peers that are not the configured proxy', async () => {
    const d2 = mkdtempSync(path.join(tmpdir(), 'gw-ui-prod2-'));
    const config = loadConfig({
      GATEWAY_MODE: 'production',
      PORT: String(await freePort()),
      PRIVATE_PORT: String(await freePort()),
      PRIVATE_ORIGIN: 'https://godseye.example-tailnet.ts.net',
      OWNER_TAILSCALE_LOGIN: OWNER,
      TAILSCALE_TRUSTED_PROXY_IPS: '10.9.9.9',
      DATA_DIR: d2,
      GEV_URL: gev.url,
      GEV_MCP_ENABLED: 'false',
    });
    const g2 = await startGateway(config, {
      logger: nullLogger,
      gevChild: false,
      routes: installAllRoutes({ cimdFetch: fakeCimdFetch }),
    });
    try {
      expect(
        (
          await fetch(g2.privateUrl + '/oauth/admin', {
            headers: { 'tailscale-user-login': OWNER },
          })
        ).status,
      ).toBe(403);
    } finally {
      await g2.close();
      rmSync(d2, { recursive: true, force: true });
    }
  });
});
