/**
 * Step-up second factor (TOTP) on consent approval and /oauth/admin (review DS-1 and the
 * "owner identity = node owner" items): Tailscale identity alone is not enough to approve a
 * grant or use admin.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  StepUp,
  decryptSecret,
  deriveStepUpKey,
  encryptSecret,
  parseStepUpKey,
} from '../src/auth/stepup.js';
import { generateTotpSecret, totp } from '../src/auth/totp.js';
import { loadConfig } from '../src/config.js';
import { kvGet } from '../src/db.js';
import {
  CLAUDE_CALLBACK,
  CLAUDE_CIMD_URL,
  Jar,
  OWNER_TS_LOGIN,
  authorizeUrl,
  pkce,
  startTailscaleGateway,
  type TestGateway,
} from './oauth-helpers.js';
import { PROD_ENV } from './helpers.js';

const STEP = 30_000;

/** Opens the consent page; returns the page, its form fields and whether it asks for a code. */
async function consentPage(t: TestGateway, jar: Jar) {
  const url = authorizeUrl(t, {
    clientId: CLAUDE_CIMD_URL,
    redirectUri: CLAUDE_CALLBACK,
    challenge: pkce().challenge,
  });
  const res = await fetch(url, { headers: t.auth(jar), redirect: 'manual' });
  jar.store(res);
  const html = await res.text();
  return {
    status: res.status,
    html,
    requestId: /name="request_id" value="([^"]+)"/.exec(html)?.[1] ?? '',
    csrf: /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? '',
    asksForCode: html.includes('name="totp"'),
    canApprove: html.includes('value="approve"'),
  };
}

async function decide(
  t: TestGateway,
  jar: Jar,
  f: { requestId: string; csrf: string },
  decision: 'approve' | 'deny',
  totpCode?: string,
) {
  const body = new URLSearchParams({ request_id: f.requestId, csrf: f.csrf, decision });
  if (totpCode !== undefined) body.set('totp', totpCode);
  const res = await fetch(`${t.privateOrigin}/oauth/authorize/decision`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      ...t.auth(jar),
      'content-type': 'application/x-www-form-urlencoded',
      origin: t.privateOrigin,
    },
    body,
  });
  jar.store(res);
  return res;
}

describe('step-up on consent approval', () => {
  let t: TestGateway;
  let clock = Date.now();
  beforeAll(async () => {
    t = await startTailscaleGateway({}, { now: () => clock });
  });
  afterAll(async () => t?.close());
  const code = (offset = 0) => totp(t.stepupSecret, clock + offset);

  it('approval needs a code when there is no step-up session; deny never does', async () => {
    const jar = new Jar();
    const p = await consentPage(t, jar);
    expect(p.status).toBe(200);
    expect(p.asksForCode).toBe(true);
    expect(p.html).toMatch(/Only approve if you started connecting/);
    expect(p.html).toMatch(/Request started: /);
    // No code, a wrong code: refused, and the request stays pending.
    expect((await decide(t, jar, p, 'approve')).status).toBe(403);
    const wrong = code() === '000000' ? '111111' : '000000';
    expect((await decide(t, jar, p, 'approve', wrong)).status).toBe(403);
    const events = t.gw.audit.recent(5).map((e) => e.event);
    expect(events).toContain('stepup_failed');
    expect(events).not.toContain('authorize_approved');
    // Deny works without a code.
    const d = await decide(t, jar, p, 'deny');
    expect(d.status).toBe(302);
    expect(new URL(d.headers.get('location')!).searchParams.get('error')).toBe('access_denied');
  });

  it('a correct code approves once and opens a step-up session; the code cannot be replayed', async () => {
    clock += STEP;
    const jar = new Jar();
    const p = await consentPage(t, jar);
    const c = code();
    const ok = await decide(t, jar, p, 'approve', c);
    expect(ok.status).toBe(302);
    expect(new URL(ok.headers.get('location')!).searchParams.get('code')).toMatch(/^gac_/);
    expect(jar.cookies.has(StepUp.cookieName(false))).toBe(true);

    // Same code on a fresh browser (no session): replay refused.
    const other = new Jar();
    const p2 = await consentPage(t, other);
    expect((await decide(t, other, p2, 'approve', c)).status).toBe(403);

    // The stepped-up browser: no code field, approval goes through on the session.
    const p3 = await consentPage(t, jar);
    expect(p3.asksForCode).toBe(false);
    expect((await decide(t, jar, p3, 'approve')).status).toBe(302);
  });

  it('the step-up session ends after STEPUP_WINDOW_S and is bound to the owner', async () => {
    clock += STEP;
    const jar = new Jar();
    const p = await consentPage(t, jar);
    expect((await decide(t, jar, p, 'approve', code())).status).toBe(302);
    clock += 601_000; // default window: 600 s
    const p2 = await consentPage(t, jar);
    expect(p2.asksForCode).toBe(true);
    expect((await decide(t, jar, p2, 'approve')).status).toBe(403);
    // A session for another subject is not accepted for the owner.
    const foreign = t.gw.stepup.createSession('someone-else@example.com');
    const fj = new Jar();
    fj.cookies.set(StepUp.cookieName(false), foreign);
    expect((await consentPage(t, fj)).asksForCode).toBe(true);
  });

  it('a CSRF token bound to one step-up session is useless with another', async () => {
    clock += STEP;
    const jar = new Jar();
    jar.cookies.set(StepUp.cookieName(false), t.gw.stepup.createSession(OWNER_TS_LOGIN));
    const p = await consentPage(t, jar);
    expect(p.asksForCode).toBe(false);
    // Swap in a different (valid) session: the bound token no longer verifies, and since it was
    // not issued for the code path either, the request is refused outright.
    jar.cookies.set(StepUp.cookieName(false), t.gw.stepup.createSession(OWNER_TS_LOGIN));
    expect((await decide(t, jar, p, 'approve')).status).toBe(403);
  });

  it('locks out after repeated wrong codes', async () => {
    clock += 3600_000; // fresh lockout window
    const jar = new Jar();
    const p = await consentPage(t, jar);
    const wrong = code() === '123456' ? '654321' : '123456';
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await decide(t, jar, p, 'approve', wrong)).status);
    expect(statuses.slice(0, 4)).toEqual([403, 403, 403, 403]);
    expect(statuses.at(-1)).toBe(429);
    // Even the right code is refused while locked.
    expect((await decide(t, jar, p, 'approve', code())).status).toBe(429);
    expect(t.gw.audit.recent(3).map((e) => e.event)).toContain('stepup_locked');
  });
});

describe('step-up on /oauth/admin', () => {
  let t: TestGateway;
  let clock = Date.now();
  beforeAll(async () => {
    t = await startTailscaleGateway({}, { now: () => clock });
  });
  afterAll(async () => t?.close());

  async function stepUpForm(jar: Jar) {
    const res = await fetch(`${t.privateOrigin}/oauth/admin`, { headers: t.auth(jar) });
    jar.store(res);
    const html = await res.text();
    return { status: res.status, html, csrf: /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? '' };
  }
  const postStepUp = (jar: Jar, csrf: string, c: string) =>
    fetch(`${t.privateOrigin}/oauth/stepup`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        ...t.auth(jar),
        'content-type': 'application/x-www-form-urlencoded',
        origin: t.privateOrigin,
      },
      body: new URLSearchParams({ csrf, code: c, next: '/oauth/admin' }),
    });

  it('admin asks for the code, and opens only with the right one', async () => {
    const jar = new Jar();
    const f = await stepUpForm(jar);
    expect(f.status).toBe(401);
    expect(f.html).toContain('Signed in as owner@example.com via tailscale');
    expect(f.html).not.toContain('Token grants');
    expect((await postStepUp(jar, f.csrf, '000000')).status).toBe(403);
    // Cross-origin step-up POST refused even with the right code.
    const xo = await fetch(`${t.privateOrigin}/oauth/stepup`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        ...t.auth(jar),
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://godseye.example-tailnet.ts.net:8443',
      },
      body: new URLSearchParams({ csrf: f.csrf, code: totp(t.stepupSecret, clock) }),
    });
    expect(xo.status).toBe(403);
    clock += STEP;
    const ok = await postStepUp(jar, f.csrf, totp(t.stepupSecret, clock));
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe('/oauth/admin');
    const cookie = ok.headers.getSetCookie().find((c) => c.startsWith('gw_stepup='))!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Max-Age=600/);
    jar.store(ok);
    const admin = await fetch(`${t.privateOrigin}/oauth/admin`, { headers: t.auth(jar) });
    expect(admin.status).toBe(200);
    expect(await admin.text()).toContain('Token grants');
  });

  it('admin POSTs need the live step-up session their CSRF token was bound to', async () => {
    clock += STEP;
    const jar = new Jar();
    jar.cookies.set(StepUp.cookieName(false), t.gw.stepup.createSession(OWNER_TS_LOGIN));
    const page = await fetch(`${t.privateOrigin}/oauth/admin`, { headers: t.auth(jar) });
    jar.store(page);
    const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())![1]!;
    const post = (j: Jar) =>
      fetch(`${t.privateOrigin}/oauth/admin/revoke-family`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          ...t.auth(j),
          'content-type': 'application/x-www-form-urlencoded',
          origin: t.privateOrigin,
        },
        body: new URLSearchParams({ csrf, family_id: 'nope' }),
      });
    expect((await post(jar)).status).toBe(303);
    // Another step-up session: the bound token fails.
    const other = new Jar();
    other.cookies = new Map(jar.cookies);
    other.cookies.set(StepUp.cookieName(false), t.gw.stepup.createSession(OWNER_TS_LOGIN));
    expect((await post(other)).status).toBe(403);
    // The window passes: the same jar is refused too.
    clock += 601_000;
    expect((await post(jar)).status).toBe(403);
    expect((await stepUpForm(jar)).status).toBe(401);
  });

  it('"Lock admin now" ends the step-up session', async () => {
    clock += STEP;
    const jar = new Jar();
    jar.cookies.set(StepUp.cookieName(false), t.gw.stepup.createSession(OWNER_TS_LOGIN));
    const page = await fetch(`${t.privateOrigin}/oauth/admin`, { headers: t.auth(jar) });
    jar.store(page);
    const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())![1]!;
    const end = await fetch(`${t.privateOrigin}/oauth/stepup/end`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        ...t.auth(jar),
        'content-type': 'application/x-www-form-urlencoded',
        origin: t.privateOrigin,
      },
      body: new URLSearchParams({ csrf }),
    });
    expect(end.status).toBe(303);
    jar.store(end);
    expect((await stepUpForm(jar)).status).toBe(401);
  });
});

describe('step-up enrollment and storage', () => {
  it('fails closed before enrollment: no Approve button, approve refused, admin 503', async () => {
    const t = await startTailscaleGateway({}, { skipStepupEnroll: true });
    try {
      const jar = new Jar();
      const p = await consentPage(t, jar);
      expect(p.status).toBe(200);
      expect(p.canApprove).toBe(false);
      expect(p.html).toContain('stepup.js enroll');
      expect((await decide(t, jar, p, 'approve', '123456')).status).toBe(503);
      expect((await fetch(`${t.privateOrigin}/oauth/admin`, { headers: t.auth(jar) })).status).toBe(
        503,
      );
    } finally {
      await t.close();
    }
  });

  it('stores the TOTP secret encrypted (AES-256-GCM) under STEPUP_KEY', async () => {
    const t = await startTailscaleGateway({ STEPUP_KEY: randomBytes(32).toString('base64url') });
    try {
      const stored = kvGet(t.gw.db, 'stepup_totp_secret')!;
      expect(stored).toMatch(/^v1\./);
      expect(stored).not.toContain(t.stepupSecret);
      const key = parseStepUpKey(t.gw.config.STEPUP_KEY!);
      expect(decryptSecret(key, stored)).toBe(t.stepupSecret);
      expect(() => decryptSecret(randomBytes(32), stored)).toThrow();
      expect(() => decryptSecret(deriveStepUpKey(t.gw.sessionSecret), stored)).toThrow();
    } finally {
      await t.close();
    }
  });

  it('fails closed (not enrolled) when STEPUP_KEY no longer decrypts the stored secret', async () => {
    const t = await startTailscaleGateway({ STEPUP_KEY: randomBytes(32).toString('base64url') });
    try {
      const other = new StepUp(t.gw.db, { enabled: true, windowS: 600, key: randomBytes(32) });
      expect(other.verifyCode(totp(t.stepupSecret), '127.0.0.1')).toBe('not_enrolled');
    } finally {
      await t.close();
    }
  });

  it('encrypt/decrypt round-trips and rejects tampering', () => {
    const key = randomBytes(32);
    const s = generateTotpSecret();
    const e = encryptSecret(key, s);
    expect(decryptSecret(key, e)).toBe(s);
    const parts = e.split('.');
    parts[3] = Buffer.from('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA').toString('base64url');
    expect(() => decryptSecret(key, parts.join('.'))).toThrow();
  });

  it('production requires STEPUP_KEY unless step-up is explicitly off; keys are validated', () => {
    const { STEPUP_KEY: _k, ...noKey } = PROD_ENV;
    expect(() => loadConfig(noKey)).toThrow(/STEPUP_KEY/);
    expect(loadConfig({ ...noKey, STEPUP_TOTP: 'off' }).STEPUP_TOTP).toBe('off');
    expect(() => loadConfig({ ...PROD_ENV, STEPUP_KEY: 'too-short' })).toThrow(/STEPUP_KEY/);
    expect(loadConfig(PROD_ENV).STEPUP_TOTP).toBe('on');
    expect(loadConfig({}).STEPUP_TOTP).toBe('on'); // default on in every mode
    expect(loadConfig({}).STEPUP_WINDOW_S).toBe(600);
  });
});
