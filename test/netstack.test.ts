/**
 * Regression test for the userspace-netstack loopback spoof (review findings OA-1, bp-1,
 * DS-2 and the public-listener WAF bypass).
 *
 * The Tailscale sidecar runs with TS_USERSPACE=true. Its netstack accepts a tailnet
 * connection to the node's own address on any port `tailscale serve` does not own and
 * re-dials 127.0.0.1:<same port> with a plain dialer, passing the client's bytes (and so
 * its forged Tailscale-User-Login header) through untouched. The stand-in below does the
 * same: it accepts on 127.0.0.77 (the node's "tailnet address") and re-dials
 * 127.0.0.1:<port>.
 *
 * With the production binds (private listener on 127.0.0.2, public listener on the
 * bridge address, here 127.0.0.3) the forwarded connection finds nothing to talk to, while
 * a serve stand-in that proxies to 127.0.0.2 (and so connects from 127.0.0.1) still works.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { connect, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateTotpSecret } from '../src/auth/totp.js';
import { loadConfig } from '../src/config.js';
import { startGateway, type Gateway } from '../src/gateway.js';
import { nullLogger } from '../src/log.js';
import { installAllRoutes } from '../src/routes.js';
import { PROD_ENV } from './helpers.js';
import { fakeCimdFetch, freePort } from './oauth-helpers.js';

const TAILNET_IP = '127.0.0.77'; // stands in for the godseye node's 100.x address
const PUB_HOST = 'godseye.gamachecloud.com';
const TS_HOST = 'godseye.example-tailnet.ts.net';
const OWNER = 'owner@example.com';

let gw: Gateway;
let dir: string;
const servers: Server[] = [];

/** A TCP relay: accept on `listenHost:port`, re-dial `dialHost:port` (like netstack forwardTCP). */
function relay(listenHost: string, port: number, dialHost: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const s = createServer((c) => {
      const up = connect({ host: dialHost, port });
      c.pipe(up);
      up.pipe(c);
      up.on('error', () => c.destroy());
      c.on('error', () => up.destroy());
    });
    s.once('error', reject);
    s.listen(port, listenHost, () => resolve(s));
  });
}

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function raw(
  host: string,
  port: number,
  method: string,
  p: string,
  headers: Record<string, string>,
  body?: string,
  localAddress?: string,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const r = request({ host, port, method, path: p, headers, localAddress }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: b }));
    });
    r.setTimeout(5000, () => r.destroy(new Error('timeout')));
    r.on('error', reject);
    r.end(body);
  });
}

const spoof = {
  host: TS_HOST,
  'tailscale-user-login': OWNER,
  'x-forwarded-for': '203.0.113.99',
};

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'gw-netstack-'));
  const config = loadConfig({
    ...PROD_ENV,
    PORT: String(await freePort()),
    PRIVATE_PORT: String(await freePort()),
    DATA_DIR: dir,
    GEV_MCP_ENABLED: 'false',
    GEV_PROXY_ENABLED: 'false',
  });
  gw = await startGateway(config, {
    logger: nullLogger,
    gevChild: false,
    routes: installAllRoutes({ cimdFetch: fakeCimdFetch }),
  });
  gw.stepup.enroll(generateTotpSecret());
  // netstack stand-ins for both listener ports
  servers.push(await relay(TAILNET_IP, gw.privatePort, '127.0.0.1'));
  servers.push(await relay(TAILNET_IP, gw.port, '127.0.0.1'));
});

afterAll(async () => {
  for (const s of servers) s.close();
  await gw?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('userspace netstack loopback forwarding', () => {
  it('binds the listeners where the netstack never dials', () => {
    expect(gw.privateUrl).toBe(`http://127.0.0.2:${gw.privatePort}`);
    expect(gw.url).toBe(`http://127.0.0.3:${gw.port}`);
  });

  it('a forwarded tailnet connection cannot reach the private listener or get owner identity', async () => {
    await expect(raw(TAILNET_IP, gw.privatePort, 'GET', '/oauth/admin', spoof)).rejects.toThrow();
    await expect(
      raw(TAILNET_IP, gw.privatePort, 'GET', '/oauth/authorize?client_id=x', spoof),
    ).rejects.toThrow();
    // Nothing listens on 127.0.0.1:<private port> at all.
    await expect(raw('127.0.0.1', gw.privatePort, 'GET', '/healthz', spoof)).rejects.toThrow(
      /ECONNREFUSED/,
    );
  });

  it('a forwarded tailnet connection cannot reach the public listener (no WAF bypass)', async () => {
    await expect(
      raw(
        TAILNET_IP,
        gw.port,
        'POST',
        '/oauth/register',
        { host: PUB_HOST, 'content-type': 'application/json' },
        JSON.stringify({ client_name: 'x', redirect_uris: ['http://127.0.0.1/callback'] }),
      ),
    ).rejects.toThrow();
    await expect(raw('127.0.0.1', gw.port, 'GET', '/healthz', { host: PUB_HOST })).rejects.toThrow(
      /ECONNREFUSED/,
    );
    const n = gw.db.prepare('SELECT COUNT(*) AS n FROM clients').get() as { n: number };
    expect(n.n).toBe(0);
  });

  it('control: tailscale serve (proxying to 127.0.0.2, so from 127.0.0.1) still identifies the owner', async () => {
    const r = await raw('127.0.0.2', gw.privatePort, 'GET', '/oauth/admin', spoof);
    expect(r.status).not.toBe(403);
    expect(r.body).toMatch(/Signed in as owner@example\.com via tailscale/);
  });

  it('the private listener never trusts X-Forwarded-For', async () => {
    const r = await raw(
      '127.0.0.2',
      gw.privatePort,
      'POST',
      '/oauth/authorize/decision',
      {
        ...spoof,
        origin: `https://${TS_HOST}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      'request_id=nope&csrf=nope&decision=approve',
    );
    expect(r.status).toBe(403);
    const ev = gw.audit.recent(5).find((a) => a.event === 'consent_rejected');
    expect(ev?.ip).toBe('127.0.0.1');
  });

  it("CF-Connecting-IP is trusted only from cloudflared's fixed address", async () => {
    const reg = (localAddress?: string) =>
      raw(
        '127.0.0.3',
        gw.port,
        'POST',
        '/oauth/register',
        { host: PUB_HOST, 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.7' },
        JSON.stringify({ redirect_uris: ['https://evil.example/cb'] }),
        localAddress,
      );
    expect((await reg('127.0.0.10')).status).toBe(400); // "cloudflared"
    expect(gw.audit.recent(1)[0]).toMatchObject({
      event: 'client_registration_rejected',
      ip: '198.51.100.7',
    });
    expect((await reg()).status).toBe(400); // any other peer (here 127.0.0.1)
    expect(gw.audit.recent(1)[0]).toMatchObject({
      event: 'client_registration_rejected',
      ip: '127.0.0.1',
    });
  });
});
