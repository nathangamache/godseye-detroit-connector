import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CfAccessVerifier } from '../src/auth/cfAccess.js';
import { base32Encode, hotp, totp, verifyTotp } from '../src/auth/totp.js';
import { hashPassword, verifyPassword } from '../src/auth/password.js';
import { safeNext } from '../src/auth/login.js';
import { loadConfig } from '../src/config.js';
import { startGateway, type Gateway } from '../src/gateway.js';
import { nullLogger } from '../src/log.js';
import { CimdFetchError, checkCimdUrl, makeCimdFetcher } from '../src/oauth/cimd.js';
import { redirectMatches, validateCimd } from '../src/oauth/clients.js';
import { installAllRoutes } from '../src/routes.js';
import { isPrivateIp } from '../src/util/net.js';
import { fakeCimdFetch, freePort } from './oauth-helpers.js';

describe('SSRF guards for CIMD fetches', () => {
  it('classifies private and special-use addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.91', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fd7a:115c:a1e0::1', 'fe80::1', '::ffff:10.0.0.1', '::ffff:127.0.0.1', 'not-an-ip']) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
    for (const ip of ['160.79.104.10', '8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) expect(isPrivateIp(ip), ip).toBe(false);
  });

  it('rejects non-https, odd ports, credentials and fragments', () => {
    expect(() => checkCimdUrl('http://claude.ai/oauth/x')).toThrow(CimdFetchError);
    expect(() => checkCimdUrl('https://claude.ai:8443/oauth/x')).toThrow(/port/);
    expect(() => checkCimdUrl('https://u:p@claude.ai/oauth/x')).toThrow(/credentials/);
    expect(() => checkCimdUrl('https://claude.ai/oauth/x#f')).toThrow(/fragment/);
    expect(checkCimdUrl('https://claude.ai/oauth/mcp-oauth-client-metadata').hostname).toBe('claude.ai');
  });

  it('blocks hosts that resolve to private addresses (DNS checked before connecting)', async () => {
    for (const address of ['10.0.0.5', '127.0.0.1', '169.254.169.254', '192.168.1.91']) {
      const fetcher = makeCimdFetcher({ resolver: async () => [{ address, family: 4 }] });
      await expect(fetcher('https://attacker.example/client.json')).rejects.toThrow(/non-public/);
    }
    const mixed = makeCimdFetcher({ resolver: async () => [{ address: '8.8.8.8', family: 4 }, { address: '::1', family: 6 }] });
    await expect(mixed('https://attacker.example/client.json')).rejects.toThrow(/non-public/);
    const literal = makeCimdFetcher();
    await expect(literal('https://127.0.0.1/client.json')).rejects.toThrow(/non-public/);
    await expect(literal('https://[::1]/client.json')).rejects.toThrow(/non-public/);
  });

  it('validates CIMD documents', () => {
    const url = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
    expect(validateCimd(url, JSON.stringify({ client_id: url, client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], token_endpoint_auth_method: 'none' })).client_name).toBe('Claude');
    expect(() => validateCimd(url, JSON.stringify({ client_id: 'https://other/x', redirect_uris: ['https://a/b'] }))).toThrow(/does not match/);
    expect(() => validateCimd(url, JSON.stringify({ client_id: url, redirect_uris: [] }))).toThrow(/redirect_uris/);
    expect(() => validateCimd(url, JSON.stringify({ client_id: url, redirect_uris: ['https://a/b'], token_endpoint_auth_method: 'private_key_jwt' }))).toThrow(/public/);
    expect(() => validateCimd(url, 'not json')).toThrow();
  });

  it('redirect matching is exact except loopback ports', () => {
    expect(redirectMatches('https://claude.ai/api/mcp/auth_callback', 'https://claude.ai/api/mcp/auth_callback')).toBe(true);
    expect(redirectMatches('https://claude.ai/api/mcp/auth_callback', 'https://claude.ai/api/mcp/auth_callback/')).toBe(false);
    expect(redirectMatches('https://claude.ai/api/mcp/auth_callback', 'https://claude.ai.evil.example/api/mcp/auth_callback')).toBe(false);
    expect(redirectMatches('http://localhost/callback', 'http://localhost:4321/callback')).toBe(true);
    expect(redirectMatches('http://localhost/callback', 'http://localhost:4321/callback?x=1')).toBe(false);
    expect(redirectMatches('http://127.0.0.1/callback', 'http://localhost:4321/callback')).toBe(false);
  });

  it('open-redirect safe next parameter', () => {
    expect(safeNext('/oauth/admin')).toBe('/oauth/admin');
    for (const bad of ['//evil.example', 'https://evil.example', '/\\evil', '/x\r\nSet-Cookie: a=b']) expect(safeNext(bad)).toBe('/');
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

const TEAM = 'testteam.cloudflareaccess.com';
const AUD = 'test-aud-tag';
const OWNER = 'owner@example.com';
type Key = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let privateKey: Key;
let jwks: JWTVerifyGetKey;

async function cfJwt(over: { email?: string; aud?: string; iss?: string; expSecs?: number; key?: Key } = {}) {
  return new SignJWT({ email: over.email ?? OWNER, type: 'app' })
    .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
    .setIssuer(over.iss ?? `https://${TEAM}`)
    .setAudience(over.aud ?? AUD)
    .setSubject('user-1')
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + (over.expSecs ?? 300))
    .sign(over.key ?? privateKey);
}

beforeAll(async () => {
  const kp = await generateKeyPair('ES256');
  privateKey = kp.privateKey;
  const pub = await exportJWK(kp.publicKey);
  jwks = createLocalJWKSet({ keys: [{ ...pub, kid: 'k1', alg: 'ES256', use: 'sig' }] });
});

describe('Cloudflare Access JWT verification', () => {
  it('accepts only the owner, for our team and audience, unexpired', async () => {
    const v = new CfAccessVerifier({ teamDomain: TEAM, aud: AUD, ownerEmail: OWNER, jwks });
    expect(await v.verify(await cfJwt())).toMatchObject({ email: OWNER });
    expect(await v.verify(await cfJwt({ email: 'someone@else.com' }))).toBeNull();
    expect(await v.verify(await cfJwt({ aud: 'other-aud' }))).toBeNull();
    expect(await v.verify(await cfJwt({ iss: 'https://evil.cloudflareaccess.com' }))).toBeNull();
    expect(await v.verify(await cfJwt({ expSecs: -120 }))).toBeNull();
    const other = await generateKeyPair('ES256');
    expect(await v.verify(await cfJwt({ key: other.privateKey }))).toBeNull();
    expect(await v.verify(undefined)).toBeNull();
    expect(await v.verify('eyJhbGciOiJub25lIn0.eyJlbWFpbCI6Im93bmVyQGV4YW1wbGUuY29tIn0.')).toBeNull();
  });
});

describe('production mode', () => {
  let gw: Gateway;
  let base: string;
  let dir: string;
  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'gw-prod-'));
    const port = await freePort();
    const config = loadConfig({
      GATEWAY_MODE: 'production',
      PORT: String(port),
      DATA_DIR: dir,
      CF_ACCESS_TEAM_DOMAIN: TEAM,
      CF_ACCESS_AUD: AUD,
      OWNER_EMAIL: OWNER,
      GEV_MCP_ENABLED: 'false',
      PULSE_URL: 'http://127.0.0.1:9',
    });
    gw = await startGateway(config, { logger: nullLogger, gevChild: false, mount: installAllRoutes({ cimdFetch: fakeCimdFetch, cfJwks: jwks }) });
    base = gw.url;
  });
  afterAll(async () => {
    await gw?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses to start without Cloudflare Access configuration', () => {
    expect(() => loadConfig({ GATEWAY_MODE: 'production' })).toThrow(/fail closed/);
  });

  it('owner routes reject a missing or invalid Access JWT and accept a valid one', async () => {
    for (const p of ['/oauth/admin', '/oauth/authorize?client_id=x']) {
      expect((await fetch(base + p, { redirect: 'manual' })).status, p).toBe(403);
      const bad = await fetch(base + p, { redirect: 'manual', headers: { 'cf-access-jwt-assertion': await cfJwt({ email: 'intruder@example.com' }) } });
      expect(bad.status, p).toBe(403);
      const forged = await fetch(base + p, { redirect: 'manual', headers: { 'cf-access-jwt-assertion': 'abc.def.ghi' } });
      expect(forged.status, p).toBe(403);
    }
    const ok = await fetch(base + '/oauth/admin', { headers: { 'cf-access-jwt-assertion': await cfJwt() } });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('Signed in as owner@example.com via cf-access');
    // No password login route exists in production.
    expect((await fetch(base + '/auth/login')).status).toBe(404);
  });

  it('public endpoints stay public and leak nothing', async () => {
    const h = await fetch(base + '/healthz');
    expect(await h.json()).toEqual({ ok: true });
    expect(h.headers.get('strict-transport-security')).toMatch(/max-age/);
    expect(h.headers.get('x-content-type-options')).toBe('nosniff');
    expect(h.headers.get('referrer-policy')).toBe('no-referrer');
    expect(h.headers.get('access-control-allow-origin')).toBeNull();
    const mcp = await fetch(base + '/mcp', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    expect(mcp.status).toBe(401);
    expect(mcp.headers.get('www-authenticate')).toBe('Bearer resource_metadata="https://godseye.gamachecloud.com/.well-known/oauth-protected-resource"');
  });
});
