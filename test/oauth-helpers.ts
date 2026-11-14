import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hashPassword } from '../src/auth/password.js';
import { generateTotpSecret, totp } from '../src/auth/totp.js';
import { REPO_ROOT, loadConfig } from '../src/config.js';
import { startGateway, type Gateway } from '../src/gateway.js';
import { childSpawnSpec } from '../src/gev/child.js';
import { nullLogger, type Logger } from '../src/log.js';
import type { CimdFetcher } from '../src/oauth/cimd.js';
import { installAllRoutes, type RouteOptions } from '../src/routes.js';
import { MOCK_GEV } from './helpers.js';

export const CLAUDE_CIMD_URL = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
export const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
/** Mirrors the fields of claude.ai's published client metadata document (fetched 2026-11-13). */
export const CLAUDE_CIMD_DOC = {
  client_id: CLAUDE_CIMD_URL,
  client_name: 'Claude',
  redirect_uris: [CLAUDE_CALLBACK],
  grant_types: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:jwt-bearer'],
  token_endpoint_auth_method: 'none',
};
export const fakeCimdFetch: CimdFetcher = async (url) => {
  if (url === CLAUDE_CIMD_URL) return { body: JSON.stringify(CLAUDE_CIMD_DOC), maxAgeS: 300 };
  throw new Error('unexpected CIMD fetch ' + url);
};

export async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

export class Jar {
  cookies = new Map<string, string>();
  store(res: Response): void {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair!.indexOf('=');
      const name = pair!.slice(0, i).trim();
      const value = pair!.slice(i + 1).trim();
      if (/Max-Age=0/i.test(c)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

export function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export interface TestGateway {
  gw: Gateway;
  origin: string;
  password: string;
  totpSecret: string;
  dir: string;
  close(): Promise<void>;
}

export async function startPasswordGateway(env: Record<string, string> = {}, routeOpts: RouteOptions = {}, logger: Logger = nullLogger): Promise<TestGateway> {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const dir = mkdtempSync(path.join(tmpdir(), 'gw-oauth-'));
  const password = 'correct horse battery staple';
  const totpSecret = generateTotpSecret();
  const config = loadConfig({
    GATEWAY_MODE: 'test',
    HOST: '127.0.0.1',
    PORT: String(port),
    PUBLIC_ORIGIN: origin,
    DATA_DIR: dir,
    LOGIN_PROVIDER: 'password',
    GATEWAY_PASSWORD_HASH: await hashPassword(password, 10),
    GATEWAY_TOTP_SECRET: totpSecret,
    PULSE_URL: 'http://127.0.0.1:9',
    ...env,
  });
  const gw = await startGateway(config, {
    logger,
    gevChild: childSpawnSpec({ gevRoot: REPO_ROOT, gevUrl: 'http://127.0.0.1:7701', wrapper: MOCK_GEV }),
    mount: installAllRoutes({ cimdFetch: fakeCimdFetch, ...routeOpts }),
  });
  return {
    gw,
    origin,
    password,
    totpSecret,
    dir,
    async close() {
      await gw.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Logs in through the password+TOTP form; returns a jar holding the session. */
export async function passwordLogin(t: TestGateway, jar = new Jar(), timeOffsetMs = 0): Promise<Jar> {
  const page = await fetch(`${t.origin}/auth/login?next=/oauth/admin`, { headers: { cookie: jar.header() } });
  jar.store(page);
  const html = await page.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
  const res = await fetch(`${t.origin}/auth/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: t.origin, cookie: jar.header() },
    body: new URLSearchParams({ csrf, next: '/oauth/admin', password: t.password, totp: totp(t.totpSecret, Date.now() + timeOffsetMs) }),
  });
  if (res.status !== 303) throw new Error(`login failed: ${res.status}`);
  jar.store(res);
  return jar;
}

export function authorizeUrl(origin: string, p: { clientId: string; redirectUri: string; challenge: string; state?: string; resource?: string; scope?: string }): string {
  const u = new URL(`${origin}/oauth/authorize`);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', p.clientId);
  u.searchParams.set('redirect_uri', p.redirectUri);
  u.searchParams.set('code_challenge', p.challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('state', p.state ?? 'st-' + randomBytes(4).toString('hex'));
  u.searchParams.set('resource', p.resource ?? `${origin}/mcp`);
  u.searchParams.set('scope', p.scope ?? 'mcp offline_access');
  return u.toString();
}

/** Opens the consent page and approves; returns the redirect Location. */
export async function approve(t: TestGateway, jar: Jar, url: string, decision: 'approve' | 'deny' = 'approve'): Promise<URL> {
  const page = await fetch(url, { headers: { cookie: jar.header() }, redirect: 'manual' });
  if (page.status !== 200) throw new Error(`consent page ${page.status}: ${await page.text()}`);
  jar.store(page);
  const html = await page.text();
  const requestId = /name="request_id" value="([^"]+)"/.exec(html)![1]!;
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
  const res = await fetch(`${t.origin}/oauth/authorize/decision`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: t.origin, cookie: jar.header() },
    body: new URLSearchParams({ request_id: requestId, csrf, decision }),
  });
  if (res.status !== 302) throw new Error(`decision ${res.status}: ${await res.text()}`);
  return new URL(res.headers.get('location')!);
}

export async function tokenRequest(origin: string, params: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${origin}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

export async function mcpList(origin: string, accessToken: string): Promise<number> {
  const res = await fetch(`${origin}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  await res.text();
  return res.status;
}
