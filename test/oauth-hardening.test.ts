/**
 * Review findings OA-3 (CIMD fetcher under Node 24), OA-4 (scope checked before rotation),
 * OA-5 (revocation ownership), OA-6 (bounded audit and global limits) and bp-2 (rate-limiter
 * memory).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Audit, auditClass } from '../src/audit.js';
import { openDb } from '../src/db.js';
import { nullLogger } from '../src/log.js';
import { CimdFetchError, makeCimdFetcher, pinnedLookup } from '../src/oauth/cimd.js';
import { REGISTER_GLOBAL_PER_HOUR, TOKEN_FAIL_LIMIT } from '../src/oauth/routes.js';
import { expandIpv6, isPrivateIp, rateKeyIp } from '../src/util/net.js';
import { RateLimiter } from '../src/util/ratelimit.js';
import {
  CLAUDE_CALLBACK,
  CLAUDE_CIMD_URL,
  approve,
  authorizeUrl,
  mcpList,
  ownerJar,
  pkce,
  startTailscaleGateway,
  tokenRequest,
  type TestGateway,
} from './oauth-helpers.js';

function haveOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('OA-3: SSRF-pinned CIMD fetcher works under Node 24', () => {
  let dir: string;
  let server: Server;
  let port: number;
  let cert: Buffer;
  const doc = {
    client_id: 'https://cimd.test/client.json',
    client_name: 'Test',
    redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
  };

  beforeAll(async () => {
    if (!haveOpenssl()) return;
    dir = mkdtempSync(path.join(tmpdir(), 'cimd-tls-'));
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-keyout',
        path.join(dir, 'key.pem'),
        '-out',
        path.join(dir, 'cert.pem'),
        '-days',
        '1',
        '-subj',
        '/CN=cimd.test',
        '-addext',
        'subjectAltName=DNS:cimd.test',
      ],
      { stdio: 'ignore' },
    );
    cert = readFileSync(path.join(dir, 'cert.pem'));
    server = createServer({ key: readFileSync(path.join(dir, 'key.pem')), cert }, (req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { location: 'https://169.254.169.254/' }).end();
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'public, max-age=600',
      });
      res.end(JSON.stringify(doc));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => {
    server?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('answers lookup in both shapes (Node 24 asks with {all: true}), never synchronously', async () => {
    const lookup = pinnedLookup({ address: '203.0.113.5', family: 4 });
    const got: unknown[][] = [];
    (lookup as unknown as (h: string, o: unknown, cb: (...a: unknown[]) => void) => void)(
      'x',
      { all: true, hints: 32 },
      (...a) => got.push(a),
    );
    (lookup as unknown as (h: string, o: unknown, cb: (...a: unknown[]) => void) => void)(
      'x',
      {},
      (...a) => got.push(a),
    );
    // net/tls keep setting the socket up after calling lookup; answering inline lets a connect
    // that fails at once destroy the socket under tls.connect (review: uncaught TypeError).
    expect(got).toEqual([]);
    await new Promise((r) => process.nextTick(r));
    expect(got[0]).toEqual([null, [{ address: '203.0.113.5', family: 4 }]]);
    expect(got[1]).toEqual([null, '203.0.113.5', 4]);
  });

  // 224.0.0.1 is multicast: Linux refuses a TCP connect to it synchronously (ENETUNREACH),
  // like an IPv6 address on a host without an IPv6 route.
  const failsAtOnce = '224.0.0.1';
  const allowTest = (ip: string) => ip !== '127.0.0.1' && ip !== failsAtOnce && isPrivateIp(ip);

  it.runIf(haveOpenssl())(
    'a pinned address that fails at once falls through to the next, and nothing escapes uncaught',
    async () => {
      const uncaught: unknown[] = [];
      const onUncaught = (e: unknown) => uncaught.push(e);
      process.on('uncaughtException', onUncaught);
      try {
        const both = makeCimdFetcher({
          resolver: async () => [
            { address: failsAtOnce, family: 4 },
            { address: '127.0.0.1', family: 4 },
          ],
          connectPort: port,
          ca: cert,
          isPrivate: allowTest,
        });
        const r = await both('https://cimd.test/client.json');
        expect(JSON.parse(r.body)).toEqual(doc);
        // Only the failing address: a clean CimdFetchError, not a TypeError and a crash.
        const only = makeCimdFetcher({
          resolver: async () => [{ address: failsAtOnce, family: 4 }],
          connectPort: port,
          ca: cert,
          isPrivate: allowTest,
        });
        const err = await only('https://cimd.test/client.json').catch((e: unknown) => e);
        expect(err).toBeInstanceOf(CimdFetchError);
        expect(String((err as Error).message)).toMatch(/fetch failed/);
        await new Promise((r) => setTimeout(r, 100));
        expect(uncaught).toEqual([]);
      } finally {
        process.off('uncaughtException', onUncaught);
      }
    },
  );

  it.runIf(haveOpenssl())('tries the validated addresses in order when one refuses', async () => {
    // A closed port on the first address (ECONNREFUSED, asynchronous), the server on the second.
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.2', () => r()));
    const closedPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const second = createServer({ key: readFileSync(path.join(dir, 'key.pem')), cert }, (_q, s) =>
      s
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ ...doc, client_name: 'second' })),
    );
    await new Promise<void>((r) => second.listen(closedPort, '127.0.0.3', () => r()));
    try {
      const f = makeCimdFetcher({
        resolver: async () => [
          { address: '127.0.0.2', family: 4 },
          { address: '127.0.0.3', family: 4 },
        ],
        connectPort: closedPort,
        ca: cert,
        isPrivate: () => false,
      });
      expect(JSON.parse((await f('https://cimd.test/client.json')).body).client_name).toBe(
        'second',
      );
    } finally {
      second.close();
    }
  });

  // The test server is on 127.0.0.1, so the private-address check is narrowed to let only it
  // through; DNS is mocked (cimd.test does not exist), which also proves the socket is pinned
  // to the resolved address rather than looked up again.
  const fetcherFor = (
    p: number,
    isPrivate = (ip: string) => ip !== '127.0.0.1' && isPrivateIp(ip),
  ) =>
    makeCimdFetcher({
      resolver: async (h) => (h === 'cimd.test' ? [{ address: '127.0.0.1', family: 4 }] : []),
      connectPort: p,
      ca: cert,
      isPrivate,
    });

  it.runIf(haveOpenssl())('fetches a client metadata document over a real TLS socket', async () => {
    const r = await fetcherFor(port)('https://cimd.test/client.json');
    expect(JSON.parse(r.body)).toEqual(doc);
    expect(r.maxAgeS).toBe(600);
  });

  it.runIf(haveOpenssl())('still refuses redirects and private addresses', async () => {
    await expect(fetcherFor(port)('https://cimd.test/redirect')).rejects.toThrow(
      /HTTP 302 \(redirects are not followed\)/,
    );
    await expect(fetcherFor(port, isPrivateIp)('https://cimd.test/client.json')).rejects.toThrow(
      CimdFetchError,
    );
    await expect(fetcherFor(port)('https://cimd.test:8443/client.json')).rejects.toThrow(
      /port 443/,
    );
  });
});

describe('OA-4, OA-5 and OA-6 over HTTP', () => {
  let t: TestGateway;
  beforeAll(async () => {
    t = await startTailscaleGateway();
  });
  afterAll(async () => t?.close());

  async function grant(scope: string) {
    const jar = await ownerJar(t);
    const p = pkce();
    const loc = await approve(
      t,
      jar,
      authorizeUrl(t, {
        clientId: CLAUDE_CIMD_URL,
        redirectUri: CLAUDE_CALLBACK,
        challenge: p.challenge,
        scope,
      }),
    );
    const r = await tokenRequest(t.origin, {
      grant_type: 'authorization_code',
      client_id: CLAUDE_CIMD_URL,
      code: loc.searchParams.get('code')!,
      code_verifier: p.verifier,
      redirect_uri: CLAUDE_CALLBACK,
    });
    expect(r.status).toBe(200);
    return r.body as { access_token: string; refresh_token: string; scope: string };
  }

  it('OA-4: a too-wide refresh scope is refused without burning the refresh token', async () => {
    const g = await grant('mcp');
    const wide = await tokenRequest(t.origin, {
      grant_type: 'refresh_token',
      client_id: CLAUDE_CIMD_URL,
      refresh_token: g.refresh_token,
      scope: 'mcp offline_access',
    });
    expect(wide.status).toBe(400);
    expect(wide.body.error).toBe('invalid_scope');
    // The grant is intact: the access token works and a retry without scope rotates normally.
    expect(await mcpList(t.origin, g.access_token)).toBe(200);
    const retry = await tokenRequest(t.origin, {
      grant_type: 'refresh_token',
      client_id: CLAUDE_CIMD_URL,
      refresh_token: g.refresh_token,
    });
    expect(retry.status).toBe(200);
    expect(t.gw.audit.recent(20).map((e) => e.event)).not.toContain('refresh_reuse_detected');
  });

  it('OA-5: revocation by a client that does not own the token changes nothing', async () => {
    const g = await grant('mcp');
    const revoke = (client_id?: string) =>
      fetch(`${t.origin}/oauth/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: g.refresh_token, ...(client_id ? { client_id } : {}) }),
      });
    expect((await revoke('dcr_someone_else')).status).toBe(200);
    expect(await mcpList(t.origin, g.access_token)).toBe(200);
    expect(t.gw.audit.recent(3, 'unauthenticated')[0]!.event).toBe('revoke_client_mismatch');
    expect((await revoke(CLAUDE_CIMD_URL)).status).toBe(200);
    expect(await mcpList(t.origin, g.access_token)).toBe(401);
  });

  it('OA-6: failed token requests have a global budget and bounded audit rows', async () => {
    const before = t.gw.audit.countSince('unauthenticated', 0);
    let first429 = -1;
    for (let i = 0; i < TOKEN_FAIL_LIMIT + 5; i++) {
      const res = await fetch(`${t.origin}/oauth/token`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          // Many client IPs (the test listener trusts CF-Connecting-IP from loopback), so the
          // per-IP limit never triggers: only the global budget can stop this.
          'cf-connecting-ip': `198.51.100.${i % 250}`,
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: CLAUDE_CIMD_URL,
          code: 'x'.repeat(40),
          code_verifier: 'y'.repeat(43),
          redirect_uri: CLAUDE_CALLBACK,
        }),
      });
      await res.arrayBuffer();
      if (res.status === 429 && first429 < 0) first429 = i;
    }
    // (Earlier tests in this file already spent one or two failures of the budget.)
    expect(first429).toBeGreaterThan(TOKEN_FAIL_LIMIT - 5);
    expect(first429).toBeLessThanOrEqual(TOKEN_FAIL_LIMIT);
    // At most one minute's budget of rows was written; the rest are counted, not stored.
    const added = t.gw.audit.countSince('unauthenticated', 0) - before;
    expect(added).toBeLessThanOrEqual(60);
    // Real grant events are untouched and still listed on admin.
    expect(t.gw.audit.recent(50, 'security').map((e) => e.event)).toContain('authorize_approved');
  });

  it('OA-6: dynamic registration has a global ceiling', async () => {
    let first429 = -1;
    for (let i = 0; i < REGISTER_GLOBAL_PER_HOUR + 3; i++) {
      const res = await fetch(`${t.origin}/oauth/register`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-connecting-ip': `203.0.113.${i % 250}`,
        },
        body: JSON.stringify({ redirect_uris: ['https://evil.example/cb'] }),
      });
      await res.arrayBuffer();
      if (res.status === 429 && first429 < 0) first429 = i;
    }
    expect(first429).toBe(REGISTER_GLOBAL_PER_HOUR);
  });

  it('bp-2/OA-6: IPv6 clients are limited per /64, not per address', async () => {
    let first429 = -1;
    for (let i = 0; i < 25; i++) {
      const res = await fetch(`${t.origin}/api/location`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-connecting-ip': `2001:db8:abcd:12::${(i + 1).toString(16)}`,
        },
        body: '{}',
      });
      await res.arrayBuffer();
      if (res.status === 429 && first429 < 0) first429 = i;
    }
    expect(first429).toBe(20); // loc-auth-fail: 20 per 15 min for the whole /64
  });
});

describe('OA-6: audit classes, budget and retention', () => {
  it('classifies events', () => {
    expect(auditClass('code_rejected')).toBe('unauthenticated');
    expect(auditClass('client_registered')).toBe('unauthenticated');
    expect(auditClass('authorize_approved')).toBe('security');
    expect(auditClass('location_read')).toBe('access');
  });

  it('writes at most N unauthenticated rows a minute and summarises the rest', () => {
    const db = openDb(':memory:');
    let now = 1_800_000_000_000;
    const audit = new Audit(db, nullLogger, () => now, {
      unauthPerMinute: 5,
      maxRows: { security: 100, unauthenticated: 100, access: 100 },
      retentionMs: { security: 1e12, unauthenticated: 1e12, access: 1e12 },
    });
    for (let i = 0; i < 20; i++) audit.record('code_rejected', { ip: '198.51.100.1' });
    audit.record('authorize_approved', { subject: 'owner' }); // never throttled
    expect(audit.countSince('unauthenticated', 0)).toBe(5);
    now += 61_000;
    audit.record('code_rejected', {});
    const rows = audit.recent(10, 'unauthenticated');
    const summary = rows.find((r) => r.event === 'audit_suppressed')!;
    expect(JSON.parse(summary.detail!)).toMatchObject({ total: 15, counts: { code_rejected: 15 } });
    expect(audit.recent(5, 'security').map((r) => r.event)).toEqual(['authorize_approved']);
  });

  it('caps rows and age per class, so one class cannot push out another', () => {
    const db = openDb(':memory:');
    let now = 1_800_000_000_000;
    const audit = new Audit(db, nullLogger, () => now, {
      unauthPerMinute: 1_000_000,
      maxRows: { security: 3, unauthenticated: 10, access: 10 },
      retentionMs: { security: 1e12, unauthenticated: 86_400_000, access: 1e12 },
    });
    for (let i = 0; i < 5; i++) audit.record('authorize_approved', { detail: { i } });
    for (let i = 0; i < 50; i++) audit.record('code_rejected', {});
    audit.prune();
    const sec = audit.recent(10, 'security');
    expect(sec).toHaveLength(3);
    expect(JSON.parse(sec[0]!.detail!).i).toBe(4); // newest kept
    expect(audit.countSince('unauthenticated', 0)).toBe(10);
    now += 2 * 86_400_000;
    audit.prune();
    expect(audit.countSince('unauthenticated', 0)).toBe(0);
    expect(audit.recent(10, 'security')).toHaveLength(3);
  });
});

describe('bp-2: rate-limiter memory is bounded', () => {
  it('drops keys after their own window, not after a day', () => {
    let now = 1_800_000_000_000;
    const rl = new RateLimiter(() => now, { sweepEveryMs: 1000 });
    for (let i = 0; i < 1000; i++) rl.hit(`http:all:ip${i}`, 1200, 60_000);
    rl.hit('tool:quota', 20, 3_600_000);
    expect(rl.size).toBe(1001);
    now += 61_000;
    rl.peek('x', 1, 1000); // triggers a sweep
    expect(rl.size).toBe(1); // only the 1 h key is left
    now += 3_600_000;
    rl.peek('x', 1, 1000);
    expect(rl.size).toBe(0);
  });

  it('caps the number of keys (least recently hit first)', () => {
    const rl = new RateLimiter(Date.now, { maxKeys: 100 });
    rl.hit('keep', 10, 60_000);
    for (let i = 0; i < 1000; i++) {
      rl.hit(`k${i}`, 10, 60_000);
      if (i % 50 === 0) rl.hit('keep', 10, 60_000); // stays recent
    }
    expect(rl.size).toBe(100);
    expect(rl.peek('keep', 10, 60_000).remaining).toBeLessThan(10);
    expect(rl.peek('k0', 10, 60_000).remaining).toBe(10); // evicted
  });

  it('peek does not create keys; limits still hold', () => {
    const rl = new RateLimiter();
    for (let i = 0; i < 100; i++) rl.peek(`p${i}`, 5, 60_000);
    expect(rl.size).toBe(0);
    for (let i = 0; i < 3; i++) expect(rl.hit('a', 3, 60_000).ok).toBe(true);
    expect(rl.hit('a', 3, 60_000).ok).toBe(false);
  });

  it('keys IPv6 by /64', () => {
    expect(expandIpv6('2001:db8::1')).toEqual([
      '2001',
      '0db8',
      '0000',
      '0000',
      '0000',
      '0000',
      '0000',
      '0001',
    ]);
    expect(rateKeyIp('2001:db8:abcd:12::1')).toBe('2001:0db8:abcd:0012::/64');
    expect(rateKeyIp('2001:db8:abcd:12:ffff:1:2:3')).toBe('2001:0db8:abcd:0012::/64');
    expect(rateKeyIp('::ffff:198.51.100.7')).toBe('198.51.100.7');
    expect(rateKeyIp('198.51.100.7')).toBe('198.51.100.7');
  });
});
