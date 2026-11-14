import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hashPassword } from '../src/auth/password.js';
import { StepUp } from '../src/auth/stepup.js';
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
export const OWNER_TS_LOGIN = 'owner@example.com';
/** Mirrors the fields of claude.ai's published client metadata document (fetched 2026-11-13). */
export const CLAUDE_CIMD_DOC = {
  client_id: CLAUDE_CIMD_URL,
  client_name: 'Claude',
  redirect_uris: [CLAUDE_CALLBACK],
  grant_types: [
    'authorization_code',
    'refresh_token',
    'urn:ietf:params:oauth:grant-type:jwt-bearer',
  ],
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
  /** Public listener (tunnel side). */
  origin: string;
  /** Private listener (tailnet side): consent, admin, /locate. */
  privateOrigin: string;
  /** UI listener (tailnet side, its own origin): GEV globe, /pulse. */
  uiOrigin: string;
  provider: 'tailscale' | 'password';
  password: string;
  totpSecret: string;
  /** The step-up TOTP secret enrolled at start (tests/stepup.test.ts exercises it directly). */
  stepupSecret: string;
  dir: string;
  /** Headers that authenticate the owner on the private listener (plus the jar's cookies). */
  auth(jar: Jar): Record<string, string>;
  close(): Promise<void>;
}

/** Route options plus test-only switches. */
export type TestRouteOptions = RouteOptions & {
  skipStepupEnroll?: boolean;
  /** Gateway clock (tests that move time). */
  now?: () => number;
};

async function start(
  provider: 'tailscale' | 'password',
  env: Record<string, string>,
  routeOpts: TestRouteOptions,
  logger: Logger,
): Promise<TestGateway> {
  const port = await freePort();
  const privatePort = await freePort();
  const uiPort = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const privateOrigin = `http://127.0.0.1:${privatePort}`;
  const uiOrigin = `http://127.0.0.1:${uiPort}`;
  const dir = mkdtempSync(path.join(tmpdir(), 'gw-oauth-'));
  const password = 'correct horse battery staple';
  const totpSecret = generateTotpSecret();
  const config = loadConfig({
    GATEWAY_MODE: 'test',
    HOST: '127.0.0.1',
    PORT: String(port),
    PRIVATE_PORT: String(privatePort),
    UI_PORT: String(uiPort),
    PUBLIC_ORIGIN: origin,
    PRIVATE_ORIGIN: privateOrigin,
    UI_ORIGIN: uiOrigin,
    DATA_DIR: dir,
    LOGIN_PROVIDER: provider,
    ...(provider === 'tailscale' ? { OWNER_TAILSCALE_LOGIN: OWNER_TS_LOGIN } : {}),
    GATEWAY_PASSWORD_HASH: await hashPassword(password, 10),
    GATEWAY_TOTP_SECRET: totpSecret,
    PULSE_URL: 'http://127.0.0.1:9',
    ...env,
  });
  const gw = await startGateway(config, {
    logger,
    now: routeOpts.now,
    gevChild: childSpawnSpec({
      gevRoot: REPO_ROOT,
      gevUrl: 'http://127.0.0.1:7701',
      wrapper: MOCK_GEV,
    }),
    routes: installAllRoutes({ cimdFetch: fakeCimdFetch, ...routeOpts }),
  });
  const stepupSecret = generateTotpSecret();
  if (!routeOpts.skipStepupEnroll) gw.stepup.enroll(stepupSecret);
  return {
    gw,
    origin,
    privateOrigin,
    uiOrigin,
    provider,
    password,
    totpSecret,
    stepupSecret,
    dir,
    auth: (jar) => ({
      cookie: jar.header(),
      // The test process connects from 127.0.0.1, standing in for tailscale serve.
      ...(provider === 'tailscale'
        ? { 'tailscale-user-login': OWNER_TS_LOGIN, 'tailscale-user-name': 'Owner' }
        : {}),
    }),
    async close() {
      await gw.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const startPasswordGateway = (
  env: Record<string, string> = {},
  routeOpts: TestRouteOptions = {},
  logger: Logger = nullLogger,
) => start('password', env, routeOpts, logger);
export const startTailscaleGateway = (
  env: Record<string, string> = {},
  routeOpts: TestRouteOptions = {},
  logger: Logger = nullLogger,
) => start('tailscale', env, routeOpts, logger);

/** Logs in through the password+TOTP form on the given origin (private by default). */
export async function passwordLogin(
  t: TestGateway,
  jar = new Jar(),
  opts: { timeOffsetMs?: number; origin?: string } = {},
): Promise<Jar> {
  const base = opts.origin ?? t.privateOrigin;
  const page = await fetch(`${base}/auth/login?next=/oauth/admin`, {
    headers: { cookie: jar.header() },
  });
  jar.store(page);
  const html = await page.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
  const res = await fetch(`${base}/auth/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: base,
      cookie: jar.header(),
    },
    body: new URLSearchParams({
      csrf,
      next: '/oauth/admin',
      password: t.password,
      totp: totp(t.totpSecret, Date.now() + (opts.timeOffsetMs ?? 0)),
    }),
  });
  if (res.status !== 303) throw new Error(`login failed: ${res.status}`);
  jar.store(res);
  return jar;
}

/**
 * A jar that is "logged in" and stepped up: password mode logs in; tailscale mode needs no
 * session. The step-up session is created directly in the store (tests/stepup.test.ts covers
 * the TOTP form itself), so many approvals can run within one 30 s TOTP step.
 */
export async function ownerJar(t: TestGateway, opts: { stepup?: boolean } = {}): Promise<Jar> {
  const jar = t.provider === 'password' ? await passwordLogin(t) : new Jar();
  if (opts.stepup !== false) stepUpJar(t, jar);
  return jar;
}

export function ownerSubject(t: Pick<TestGateway, 'provider'>): string {
  return t.provider === 'password' ? 'owner' : OWNER_TS_LOGIN;
}

/** Puts a fresh step-up session cookie for the owner into the jar. */
export function stepUpJar(t: TestGateway, jar: Jar): Jar {
  const id = t.gw.stepup.createSession(ownerSubject(t));
  jar.cookies.set(StepUp.cookieName(t.privateOrigin.startsWith('https://')), id);
  return jar;
}

export function authorizeUrl(
  t: Pick<TestGateway, 'origin' | 'privateOrigin'>,
  p: {
    clientId: string;
    redirectUri: string;
    challenge: string;
    state?: string;
    resource?: string;
    scope?: string;
    base?: string;
  },
): string {
  const u = new URL(`${p.base ?? t.privateOrigin}/oauth/authorize`);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', p.clientId);
  u.searchParams.set('redirect_uri', p.redirectUri);
  u.searchParams.set('code_challenge', p.challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('state', p.state ?? 'st-' + randomBytes(4).toString('hex'));
  u.searchParams.set('resource', p.resource ?? `${t.origin}/mcp`);
  u.searchParams.set('scope', p.scope ?? 'mcp offline_access');
  return u.toString();
}

/** Opens the consent page and approves; returns the redirect Location. */
export async function approve(
  t: TestGateway,
  jar: Jar,
  url: string,
  decision: 'approve' | 'deny' = 'approve',
  headers?: Record<string, string>,
): Promise<URL> {
  const auth = headers ?? t.auth(jar);
  const page = await fetch(url, { headers: auth, redirect: 'manual' });
  if (page.status !== 200) throw new Error(`consent page ${page.status}: ${await page.text()}`);
  jar.store(page);
  const html = await page.text();
  const requestId = /name="request_id" value="([^"]+)"/.exec(html)![1]!;
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
  const base = new URL(url).origin;
  const res = await fetch(`${base}/oauth/authorize/decision`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      ...(headers ?? t.auth(jar)),
      'content-type': 'application/x-www-form-urlencoded',
      origin: base,
    },
    body: new URLSearchParams({ request_id: requestId, csrf, decision }),
  });
  if (res.status !== 302) throw new Error(`decision ${res.status}: ${await res.text()}`);
  return new URL(res.headers.get('location')!);
}

export async function tokenRequest(
  origin: string,
  params: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> }> {
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
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  await res.text();
  return res.status;
}
