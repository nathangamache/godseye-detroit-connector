/**
 * Deploy-side regressions: container egress rules (DS-3), network confinement (DS-4),
 * the containerized GEV build (DS-5), Dependabot coverage (DS-7), deploy-path permissions,
 * and the listener binds the netstack fix depends on.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/config.js';
import { parseTargets, probe } from '../scripts/egress-probe.js';

const read = (p: string) => readFileSync(path.join(REPO_ROOT, p), 'utf8');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // A hostile build fixture may leave read-only directories behind.
      execFileSync('find', ['-P', d, '-type', 'd', '-exec', 'chmod', 'u+rwx', '{}', '+']);
      rmSync(d, { recursive: true, force: true });
    }
  }
});
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'gw-deploy-'));
  dirs.push(d);
  return d;
};

/** One service block of the compose file (up to the next top-level service key). */
function service(compose: string, name: string): string {
  const start = compose.indexOf(`\n  ${name}:\n`);
  expect(start, name).toBeGreaterThan(0);
  const rest = compose.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n|\n[a-z]/);
  return next > 0 ? rest.slice(0, next + 1) : rest;
}

describe('host firewall rules (DOCKER-USER + INPUT)', () => {
  const script = path.join(REPO_ROOT, 'deploy', 'host-firewall', 'godseye-firewall.sh');
  const fake = path.join(REPO_ROOT, 'test', 'fixtures', 'fake-iptables.mjs');

  function run(state: string, args: string | string[], extra: Record<string, string> = {}) {
    return spawnSync('sh', [script, ...(Array.isArray(args) ? args : [args])], {
      env: {
        PATH: process.env.PATH,
        IPTABLES: `${process.execPath} ${fake}`,
        FAKE_IPT_STATE: state,
        ...extra,
      },
      encoding: 'utf8',
    });
  }
  const load = (f: string) =>
    JSON.parse(readFileSync(f, 'utf8')) as Record<string, { rules: string[] }>;
  /** The fake's own counters in the state file (__gaps, __calls). */
  const counter = (st: object, k: '__gaps' | '__calls') =>
    (st as Record<string, number | undefined>)[k];
  const SUBNETS = ['172.30.77.0/24', '172.30.78.0/24', '172.30.79.0/24', '172.30.76.0/24'];
  /** Detroit Pulse's godseye_backend (pulse-api + the tailscale sidecar). */
  const PULSE = '172.30.80.0/24';
  /** Every source subnet that jumps into the godseye chains. */
  const SOURCES = [...SUBNETS, PULSE];
  const dockerOnly = () =>
    JSON.stringify({
      FORWARD: { policy: 'DROP', rules: ['-j DOCKER-USER', '-j DOCKER-FORWARD'] },
      INPUT: { policy: 'ACCEPT', rules: [] },
      OUTPUT: { policy: 'ACCEPT', rules: [] },
      'DOCKER-USER': { rules: ['-j RETURN'] },
    });
  /** What tailscaled does when it (re)starts: its jumps go back to the top. */
  function tailscaledRestart(state: string) {
    const st = load(state);
    st['ts-forward'] = { rules: ['-o tailscale0 -j ACCEPT'] };
    st['ts-input'] = { rules: ['-p udp -m udp --dport 41641 -j ACCEPT'] };
    for (const [c, j] of [
      ['FORWARD', '-j ts-forward'],
      ['INPUT', '-j ts-input'],
    ] as const) {
      st[c]!.rules = st[c]!.rules.filter((r) => r !== j);
      st[c]!.rules.unshift(j);
    }
    writeFileSync(state, JSON.stringify(st));
  }
  /** Rules that must never be missing while the script reorders. */
  const noGaps = {
    FAKE_IPT_REQUIRE: JSON.stringify([
      ['FORWARD', '-j DOCKER-USER'],
      ...SOURCES.map((s) => ['INPUT', `-s ${s} -j GODSEYE-HOST`]),
      ...SOURCES.map((s) => ['DOCKER-USER', `-s ${s} -j GODSEYE-EGRESS`]),
    ]),
  };

  it('ensure puts the godseye rules back on top after tailscaled re-inserts its jumps', () => {
    const state = path.join(tmp(), 'ipt.json');
    writeFileSync(state, dockerOnly());
    expect(run(state, 'apply').status).toBe(0);
    const applied = load(state);
    tailscaledRestart(state);
    expect(load(state).FORWARD!.rules[0]).toBe('-j ts-forward');
    const r = run(state, 'ensure', noGaps);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/top of FORWARD/);
    const e = load(state);
    // Each rule was inserted before its old copy went: never a moment without it.
    expect(counter(e, '__gaps')).toBeUndefined();
    expect(e.FORWARD!.rules).toEqual(['-j DOCKER-USER', '-j ts-forward', '-j DOCKER-FORWARD']);
    expect(e.INPUT!.rules).toEqual([
      ...SOURCES.map((s) => `-s ${s} -j GODSEYE-HOST`),
      '-j ts-input',
    ]);
    expect(e['GODSEYE-EGRESS']).toEqual(applied['GODSEYE-EGRESS']);
    expect(e['DOCKER-USER']).toEqual(applied['DOCKER-USER']);
    // In order already: a no-op, and silent (it runs from a timer).
    const again = run(state, 'ensure', noGaps);
    expect(again.status).toBe(0);
    expect(again.stderr).toBe('');
    expect(load(state)).toEqual(e);
  });

  it('ensure SECS keeps watching and catches jumps tailscaled re-inserts a moment later', () => {
    const state = path.join(tmp(), 'ipt.json');
    writeFileSync(state, dockerOnly());
    expect(run(state, 'apply').status).toBe(0);
    const applied = load(state);
    // How many iptables calls one full check makes (nothing to fix)...
    expect(run(state, 'ensure', { FAKE_IPT_TS_AT: '1000000' }).status).toBe(0);
    const perPass = counter(load(state), '__calls')!;
    const st = load(state);
    delete st.__calls;
    writeFileSync(state, JSON.stringify(st));
    // ...so tailscaled can re-insert its jumps on the first call after it, while the watch runs.
    const r = run(state, ['ensure', '3'], { ...noGaps, FAKE_IPT_TS_AT: String(perPass + 1) });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/top of FORWARD/);
    const e = load(state);
    expect(counter(e, '__calls')).toBeGreaterThan(perPass + 1);
    expect(counter(e, '__gaps')).toBeUndefined();
    expect(e.FORWARD!.rules).toEqual(['-j DOCKER-USER', '-j ts-forward', '-j DOCKER-FORWARD']);
    expect(e.INPUT!.rules).toEqual([
      ...SOURCES.map((s) => `-s ${s} -j GODSEYE-HOST`),
      '-j ts-input',
    ]);
    expect(e['GODSEYE-EGRESS']).toEqual(applied['GODSEYE-EGRESS']);
  });

  it('ensure rebuilds missing or altered chains, and does nothing while Docker is down', () => {
    const state = path.join(tmp(), 'ipt.json');
    writeFileSync(state, dockerOnly());
    expect(run(state, 'apply').status).toBe(0);
    const applied = load(state);
    const st = load(state);
    st['GODSEYE-EGRESS']!.rules = st['GODSEYE-EGRESS']!.rules.filter(
      (r) => r !== '-d 100.64.0.0/10 -j DROP',
    );
    st.INPUT!.rules = st.INPUT!.rules.filter((r) => r !== `-s ${SUBNETS[2]} -j GODSEYE-HOST`);
    writeFileSync(state, JSON.stringify(st));
    const r = run(state, 'ensure');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/applying them again/);
    expect(load(state)).toEqual(applied);
    // Removed on purpose (godseye-firewall.service stopped): ensure does not bring them back.
    expect(run(state, 'remove').status).toBe(0);
    const removed = load(state);
    const off = run(state, 'ensure');
    expect(off.status).toBe(0);
    expect(off.stderr).toMatch(/not applied/);
    expect(load(state)).toEqual(removed);
    // Docker stopped (no DOCKER-USER chain): nothing to protect, not a failure.
    writeFileSync(state, JSON.stringify({ FORWARD: { rules: [] }, INPUT: { rules: [] } }));
    const down = run(state, 'ensure');
    expect(down.status).toBe(0);
    expect(down.stderr).toMatch(/Docker is not running/);
  });

  it('apply never leaves FORWARD without its DOCKER-USER jump while reordering', () => {
    const state = path.join(tmp(), 'ipt.json');
    writeFileSync(
      state,
      JSON.stringify({
        FORWARD: {
          policy: 'DROP',
          rules: ['-j ts-forward', '-j DOCKER-USER', '-j DOCKER-FORWARD'],
        },
        INPUT: { policy: 'ACCEPT', rules: ['-j ts-input'] },
        'DOCKER-USER': { rules: ['-j RETURN'] },
      }),
    );
    const r = run(state, 'apply', {
      FAKE_IPT_REQUIRE: JSON.stringify([['FORWARD', '-j DOCKER-USER']]),
    });
    expect(r.status, r.stderr).toBe(0);
    const a = load(state);
    expect(a.FORWARD!.rules).toEqual(['-j DOCKER-USER', '-j ts-forward', '-j DOCKER-FORWARD']);
    expect(counter(a, '__gaps')).toBeUndefined();
  });

  it('drops LAN, tailnet and host traffic from the godseye subnets and is idempotent', () => {
    const state = path.join(tmp(), 'ipt.json');
    // tailscaled started after dockerd: its ts-forward jump sits above DOCKER-USER.
    writeFileSync(
      state,
      JSON.stringify({
        FORWARD: {
          policy: 'DROP',
          rules: ['-j ts-forward', '-j DOCKER-USER', '-j DOCKER-FORWARD'],
        },
        INPUT: { policy: 'ACCEPT', rules: ['-j ts-input'] },
        OUTPUT: { policy: 'ACCEPT', rules: [] },
        'DOCKER-USER': { rules: ['-j RETURN'] },
      }),
    );
    expect(run(state, 'apply').status).toBe(0);
    const a = load(state);
    expect(a.FORWARD!.rules[0]).toBe('-j DOCKER-USER'); // ahead of ts-forward again
    for (const s of [...SUBNETS, '172.30.80.0/24']) {
      expect(a['DOCKER-USER']!.rules).toContain(`-s ${s} -j GODSEYE-EGRESS`);
      expect(a.INPUT!.rules).toContain(`-s ${s} -j GODSEYE-HOST`);
    }
    const eg = a['GODSEYE-EGRESS']!.rules;
    expect(eg[0]).toBe('-m conntrack --ctstate ESTABLISHED,RELATED -j RETURN');
    for (const b of [
      '10.0.0.0/8',
      '172.16.0.0/12',
      '192.168.0.0/16',
      '100.64.0.0/10',
      '169.254.0.0/16',
    ])
      expect(eg).toContain(`-d ${b} -j DROP`);
    // Own networks are allowed before the RFC 1918 drop; the internet after it.
    expect(eg.indexOf('-d 172.30.78.0/24 -j RETURN')).toBeLessThan(
      eg.indexOf('-d 172.16.0.0/12 -j DROP'),
    );
    expect(eg.at(-1)).toBe('-j RETURN');
    expect(a['GODSEYE-HOST']!.rules).toEqual([
      '-m conntrack --ctstate ESTABLISHED,RELATED -j RETURN',
      '-j DROP',
    ]);
    // Second run: same rules.
    expect(run(state, 'apply').status).toBe(0);
    expect(load(state)).toEqual(a);
    // remove: back to Docker's and Tailscale's own rules.
    expect(run(state, 'remove').status).toBe(0);
    const r = load(state);
    expect(r['GODSEYE-EGRESS']).toBeUndefined();
    expect(r['GODSEYE-HOST']).toBeUndefined();
    expect(r['DOCKER-USER']!.rules).toEqual(['-j RETURN']);
    expect(r.INPUT!.rules).toEqual(['-j ts-input']);
  });

  it("keeps Pulse's subnet to its own members: no host, and no route in from the godseye subnets", () => {
    const state = path.join(tmp(), 'ipt.json');
    writeFileSync(state, dockerOnly());
    expect(run(state, 'apply').status).toBe(0);
    const a = load(state);
    // The internal bridge still holds a host address (172.30.80.1): INPUT drops it like the rest.
    expect(a.INPUT!.rules).toContain(`-s ${PULSE} -j GODSEYE-HOST`);
    expect(a['DOCKER-USER']!.rules).toContain(`-s ${PULSE} -j GODSEYE-EGRESS`);
    const eg = a['GODSEYE-EGRESS']!.rules;
    // Inside the subnet (sidecar <-> pulse-api) only, ahead of the RFC 1918 drop...
    expect(eg.indexOf(`-s ${PULSE} -d ${PULSE} -j RETURN`)).toBeGreaterThan(0);
    expect(eg.indexOf(`-s ${PULSE} -d ${PULSE} -j RETURN`)).toBeLessThan(
      eg.indexOf('-d 172.16.0.0/12 -j DROP'),
    );
    // ...and never as a destination for everyone (GEV, cloudflared, the build network).
    expect(eg).not.toContain(`-d ${PULSE} -j RETURN`);
    expect(run(state, 'remove').status).toBe(0);
    const r = load(state);
    expect(r.INPUT!.rules).toEqual([]);
    expect(r['DOCKER-USER']!.rules).toEqual(['-j RETURN']);
  });

  it('refuses to run before Docker created DOCKER-USER', () => {
    const state = path.join(tmp(), 'ipt.json');
    writeFileSync(state, JSON.stringify({ FORWARD: { rules: [] }, INPUT: { rules: [] } }));
    const r = run(state, 'apply');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/start docker first/);
  });

  it('the systemd units re-apply after Docker, and re-check on every tailscaled (re)start', () => {
    const unit = read('deploy/host-firewall/godseye-firewall.service');
    expect(unit).toMatch(/After=docker\.service tailscaled\.service/);
    expect(unit).toMatch(/PartOf=docker\.service/);
    expect(unit).toMatch(/WantedBy=docker\.service/);
    // Its ExecStop removes the rules: it must not stop with tailscaled.
    expect(unit).not.toMatch(/^PartOf=.*tailscaled/m);
    const check = read('deploy/host-firewall/godseye-firewall-check.service');
    expect(check).toMatch(/^After=.*tailscaled\.service/m);
    // Restarted with tailscaled; stopped (first, by After=) when the rules are removed.
    expect(check).toMatch(/^PartOf=tailscaled\.service godseye-firewall\.service$/m);
    expect(check).toMatch(/^After=.*godseye-firewall\.service/m);
    expect(check).toMatch(/^WantedBy=tailscaled\.service$/m);
    expect(check).toMatch(/^Type=oneshot$/m);
    expect(check).not.toMatch(/RemainAfterExit=yes/); // must be able to run again
    expect(check).toMatch(/^ExecStart=\/usr\/local\/sbin\/godseye-firewall\.sh ensure \d+$/m);
    expect(check).not.toMatch(/^ExecStop/m);
    const timer = read('deploy/host-firewall/godseye-firewall-check.timer');
    expect(timer).toMatch(/^Unit=godseye-firewall-check\.service$/m);
    expect(timer).toMatch(/^OnUnitInactiveSec=\d+s$/m);
    expect(timer).toMatch(/^WantedBy=timers\.target$/m);
  });
});

describe('compose: listeners, networks and DNS', () => {
  const compose = read('deploy/docker-compose.yml');

  it('binds the gateway where the netstack never dials', () => {
    const gw = service(compose, 'gateway');
    expect(gw).toMatch(/HOST: 172\.30\.77\.20/);
    expect(gw).toMatch(/PRIVATE_HOST: 127\.0\.0\.2/);
    expect(gw).toMatch(/UI_HOST: 127\.0\.0\.2/);
    expect(gw).toMatch(/TAILSCALE_TRUSTED_PROXY_IPS: 127\.0\.0\.1\n/);
    expect(gw).toMatch(/TRUSTED_PROXY_IPS: 172\.30\.77\.10/);
    expect(gw).not.toMatch(/0\.0\.0\.0/);
    // No GEV code or clone in the gateway container.
    expect(gw).toMatch(/GEV_CHILD_URL: tcp:\/\/gev-mcp:7704/);
    expect(gw).not.toMatch(/:\/gev:ro/);
    const serve = JSON.parse(read('deploy/tailscale/serve.json'));
    expect(serve.TCP).toEqual({ '443': { HTTPS: true }, '8443': { HTTPS: true } });
    const proxies = Object.values(
      serve.Web as Record<string, { Handlers: { '/': { Proxy: string } } }>,
    ).map((w) => w.Handlers['/'].Proxy);
    expect(proxies.sort()).toEqual(['http://127.0.0.2:7702', 'http://127.0.0.2:7703']);
    expect(Object.values(serve.AllowFunnel)).toEqual([false, false]);
  });

  it('pins every subnet and confines cloudflared, GEV and gev-mcp', () => {
    expect(compose).toMatch(/edge:\n {4}name: godseye-edge[\s\S]*?subnet: 172\.30\.77\.0\/24/);
    expect(compose).toMatch(
      /backend:\n {4}name: godseye-backend\n {4}driver: bridge\n {4}internal: true[\s\S]*?subnet: 172\.30\.78\.0\/24/,
    );
    expect(compose).toMatch(
      /gev-egress:\n {4}name: godseye-gev-egress[\s\S]*?subnet: 172\.30\.79\.0\/24/,
    );
    const cf = service(compose, 'cloudflared');
    expect(cf).toMatch(/networks:\n {6}edge: \{ ipv4_address: 172\.30\.77\.10 \}\n/);
    expect(cf).not.toMatch(/backend|gev-egress/);
    const gev = service(compose, 'gev');
    expect(gev).toMatch(/backend: \{ ipv4_address: 172\.30\.78\.11 \}/);
    expect(gev).toMatch(/gev-egress: \{ ipv4_address: 172\.30\.79\.11 \}/);
    expect(gev).not.toMatch(/\n {6}edge:/);
    expect(gev).toMatch(/GEV_ALLOWED_HOSTS: gev\n/);
    const mcp = service(compose, 'gev-mcp');
    expect(mcp).toMatch(/networks:\n {6}backend: \{ ipv4_address: 172\.30\.78\.12 \}\n/);
    expect(mcp).toMatch(/GEV_RELAY_ALLOWED_PEERS: 172\.30\.78\.20/);
    for (const name of ['gev', 'gev-mcp', 'tailscale', 'cloudflared'])
      expect(service(compose, name), name).toMatch(/<<: \[\*hardening, \*dns\]/);
    expect(compose).toMatch(/dns_search: \["\."\]/);
    expect(compose).not.toMatch(/docker\.sock|\/home\//);
  });

  it("reaches Detroit Pulse only from the sidecar's namespace, and serves its UI read-only", () => {
    // Pulse's external, internal network, under its own key (not the godseye `backend`).
    expect(compose).toMatch(/\n {2}pulse:\n {4}external: true\n {4}name: godseye_backend\n/);
    expect(compose).toMatch(/\n {2}pulse-ui:\n {4}external: true\n {4}name: pulse_frontend\n/);
    const ts = service(compose, 'tailscale');
    expect(ts).toMatch(/\n {6}pulse: \{ ipv4_address: 172\.30\.80\.20 \}\n/);
    // Nobody else joins it: the gateway through the sidecar's namespace, nothing directly.
    for (const name of ['gev', 'gev-mcp', 'cloudflared', 'gateway'])
      expect(service(compose, name), name).not.toMatch(/\n {6}pulse:|godseye_backend/);
    expect(compose.match(/\n {6}pulse: /g)).toHaveLength(1);
    const gw = service(compose, 'gateway');
    expect(gw).toMatch(/network_mode: "service:tailscale"/);
    expect(gw).toMatch(/PULSE_URL: \$\{PULSE_URL:-http:\/\/pulse-api:7710\}/);
    expect(gw).toMatch(/PULSE_STATIC_DIR: \/pulse-ui\n/);
    expect(gw).toMatch(/PULSE_API_PROXY: "true"\n/);
    expect(gw).toMatch(/\n {6}- pulse-ui:\/pulse-ui:ro\n/);
    // The UI volume is mounted nowhere else, and never writable.
    expect(compose.match(/pulse-ui:\/pulse-ui/g)).toHaveLength(1);
  });
});

describe('supply chain and builds', () => {
  it('Dependabot watches the Tailscale sidecar image; FROM lines are plain digests', () => {
    expect(read('.github/dependabot.yml')).toMatch(
      /package-ecosystem: docker\n {4}directory: \/deploy\/tailscale/,
    );
    for (const f of ['deploy/docker/Dockerfile', 'deploy/tailscale/Dockerfile']) {
      const froms = read(f).match(/^FROM .*/gm)!;
      for (const l of froms)
        expect(l, f).toMatch(/^FROM [a-z0-9/.-]+:[\w.-]+@sha256:[0-9a-f]{64}( AS \w+)?$/);
    }
  });

  it('the runtime image is readable by uid 10001 whatever the checkout modes (umask 077)', () => {
    const df = read('deploy/docker/Dockerfile');
    // Classic builder: no BuildKit-only syntax (no COPY --chmod).
    expect(df).not.toMatch(/--chmod|--mount=|<<\w/);
    const [build, runtime] = df.split(/^FROM /m).slice(1) as [string, string];
    // The classic builder keeps a file's mode from the checkout (600 under umask 077) and
    // makes it root's, so the runtime stage takes nothing straight from the context...
    const copies = runtime.match(/^COPY .*/gm)!;
    expect(copies.length).toBeGreaterThan(5);
    for (const c of copies) expect(c, c).toMatch(/^COPY --from=build \/app\//);
    for (const p of ['package.json', 'gev', 'data/rail', 'web', 'third_party', 'dist'])
      expect(runtime, p).toMatch(new RegExp(`COPY --from=build /app/${p}\\b`));
    // ...only from the build stage, after it normalised every mode (no set-id bits either).
    const chmod = build.lastIndexOf('RUN chmod -R u=rwX,go=rX /app');
    expect(chmod).toBeGreaterThan(build.lastIndexOf('\nCOPY '));
    // Secrets never reach the build context, and nothing copies the whole context or deploy/.
    const ignore = read('.dockerignore').split('\n');
    for (const p of ['deploy/secrets', '.env', '.env.*', '.git']) expect(ignore, p).toContain(p);
    expect(df).not.toMatch(/^COPY (\.|\.\/|deploy)(\s|\/)/m);
  });

  it('scripts/build-gev.sh builds in a confined container with only the build-time key', () => {
    const s = read('scripts/build-gev.sh');
    execFileSync('bash', ['-n', path.join(REPO_ROOT, 'scripts', 'build-gev.sh')]);
    for (const want of [
      '--user "$(id -u):$(id -g)"',
      '--cap-drop ALL',
      '--security-opt no-new-privileges:true',
      '--read-only',
      '-v "$staging:/gev"',
      '-e CESIUM_ION_TOKEN \\',
      'npm ci --ignore-scripts && npm run build && npm run build:panel',
      'node:24.22.3-bookworm-slim@sha256:',
    ])
      expect(s, want).toContain(want);
    // Exactly one bind mount (a copy of the clone, never the clone or its .git), no env file,
    // no socket, no home.
    expect(s.match(/^\s+-v /gm)).toHaveLength(1);
    expect(s).not.toMatch(/-v "\$clone/);
    expect(s).not.toMatch(/--env-file|docker\.sock|--privileged|\$HOME:/);
    // Only the CESIUM_ION_TOKEN line is ever read from gev.env.
    expect(s).toMatch(/sed -n 's\/\^CESIUM_ION_TOKEN=\/\/p'/);
    expect(s).not.toMatch(/\. .*gev\.env|source .*gev\.env/);
    // No recursive chmod that could follow a planted symlink.
    expect(s).not.toMatch(/chmod -R/);
  });
});

describe('DS-5: the GEV build cannot reach the host through the clone', () => {
  const script = path.join(REPO_ROOT, 'scripts', 'build-gev.sh');
  const fakeDocker = path.join(REPO_ROOT, 'test', 'fixtures', 'fake-docker.mjs');
  // Keep the developer's own git configuration out of these tests.
  const gitEnv = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const mode = (p: string) => lstatSync(p).mode & 0o7777;

  function layout() {
    const root = tmp();
    const repo = path.join(root, 'repo');
    const clone = path.join(root, 'gods-eye-view');
    const secrets = path.join(repo, 'deploy', 'secrets');
    mkdirSync(secrets, { recursive: true });
    chmodSync(secrets, 0o700);
    writeFileSync(path.join(secrets, 'gateway.env'), 'X=1\n', { mode: 0o600 });
    mkdirSync(path.join(clone, 'src'), { recursive: true });
    for (const [f, body] of [
      ['package.json', '{}'],
      ['package-lock.json', '{}'],
      ['vite.config.js', '// upstream\n'],
      ['src/a.js', 'x'],
      ['.env', 'SECRET=1'],
      ['.env.local', 'SECRET=2'],
    ] as const)
      writeFileSync(path.join(clone, f), body);
    const git = (...a: string[]) =>
      execFileSync('git', a, { env: { ...process.env, ...gitEnv }, stdio: 'ignore' });
    git('init', '-q', clone);
    git('-C', clone, 'add', 'package.json', 'vite.config.js', 'src/a.js');
    const bin = path.join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(
      path.join(bin, 'docker'),
      `#!/bin/sh\nexec "${process.execPath}" "${fakeDocker}" "$@"\n`,
      { mode: 0o755 },
    );
    return { root, clone, secrets, bin, log: path.join(root, 'docker.json'), git };
  }

  function build(l: ReturnType<typeof layout>, attack = '', extra: Record<string, string> = {}) {
    return spawnSync('bash', [script], {
      env: {
        PATH: `${l.bin}:${process.env.PATH}`,
        HOME: l.root,
        GEV_CLONE: l.clone,
        // Set, so the script never looks at the real deploy/secrets/gev.env.
        CESIUM_ION_TOKEN: 'test-token',
        FAKE_DOCKER_LOG: l.log,
        FAKE_DOCKER_ATTACK: attack,
        ...gitEnv,
        ...extra,
      },
      encoding: 'utf8',
    });
  }
  const leftovers = (root: string) => readdirSync(root).filter((n) => n.startsWith('.gev-build'));

  it('builds a copy without .git or .env files; only dist and node_modules come back', () => {
    const l = layout();
    const r = build(l, 'git,source,lockdir');
    expect(r.status, r.stderr).toBe(0);
    const log = JSON.parse(readFileSync(l.log, 'utf8')) as {
      mounts: string[];
      envNames: string[];
      src: string;
      hasGit: boolean;
      envFiles: string[];
      files: string[];
    };
    expect(log.mounts).toHaveLength(1);
    expect(log.src).not.toBe(l.clone);
    expect(log.hasGit).toBe(false);
    expect(log.envFiles).toEqual([]);
    expect(log.files).toEqual(expect.arrayContaining(['package.json', 'src/a.js']));
    expect(log.envNames).toContain('CESIUM_ION_TOKEN');
    expect(log.envNames.filter((n) => n.startsWith('env-file:'))).toEqual([]);
    // What the build did to its copy stays there: no planted git config or hook, no rewritten
    // source, no stray directories in the clone.
    expect(readFileSync(path.join(l.clone, '.git', 'config'), 'utf8')).not.toMatch(/fsmonitor/);
    expect(existsSync(path.join(l.clone, '.git', 'hooks', 'post-index-change'))).toBe(false);
    expect(readFileSync(path.join(l.clone, 'vite.config.js'), 'utf8')).toBe('// upstream\n');
    expect(existsSync(path.join(l.clone, 'locked'))).toBe(false);
    // The outputs are installed and readable by the container uids (other), writable only by you.
    expect(readFileSync(path.join(l.clone, 'dist', 'index.html'), 'utf8')).toBe('<!doctype html>');
    expect(mode(path.join(l.clone, 'dist'))).toBe(0o755);
    expect(mode(path.join(l.clone, 'dist', 'panel', 'index.html'))).toBe(0o644);
    expect(mode(path.join(l.clone, 'node_modules', 'vite', 'bin', 'vite.js'))).toBe(0o755);
    expect(leftovers(l.root)).toEqual([]);
  });

  it('refuses a symlink in place of node_modules and never chmods through it', () => {
    const l = layout();
    mkdirSync(path.join(l.clone, 'node_modules', 'previous'), { recursive: true });
    const r = build(l, 'symlink', { FAKE_DOCKER_LINK_TARGET: '../repo/deploy/secrets' });
    expect(mode(l.secrets)).toBe(0o700);
    expect(mode(path.join(l.secrets, 'gateway.env'))).toBe(0o600);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/node_modules is not a real directory/);
    // The previous install is left as it was.
    expect(lstatSync(path.join(l.clone, 'node_modules')).isSymbolicLink()).toBe(false);
    expect(existsSync(path.join(l.clone, 'node_modules', 'previous'))).toBe(true);
    expect(leftovers(l.root)).toEqual([]);
  });

  it('strips setuid and setgid bits from what the build leaves behind', () => {
    const l = layout();
    const r = build(l, 'setuid');
    expect(r.status, r.stderr).toBe(0);
    expect(mode(path.join(l.clone, 'dist', 'suid')) & 0o6000).toBe(0);
  });

  it('the git command it suggests ignores a planted fsmonitor and hooks, and the next build warns', () => {
    const l = layout();
    const r = build(l);
    expect(r.status, r.stderr).toBe(0);
    const cmd = /Check: (git .*)$/m.exec(r.stderr)?.[1];
    expect(cmd).toBeDefined();
    // A clone whose .git an earlier, unconfined build wrote to:
    const marker = path.join(l.root, 'pwned');
    const payload = path.join(l.root, 'payload.sh');
    writeFileSync(payload, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    l.git('-C', l.clone, 'config', 'core.fsmonitor', payload);
    writeFileSync(
      path.join(l.clone, '.git', 'hooks', 'post-index-change'),
      `#!/bin/sh\n${payload}\n`,
      {
        mode: 0o755,
      },
    );
    const sh = (c: string) =>
      execFileSync('bash', ['-c', c], {
        env: { PATH: process.env.PATH, HOME: l.root, ...gitEnv },
        encoding: 'utf8',
      });
    sh(cmd!);
    expect(existsSync(marker)).toBe(false);
    // Control: a plain `git status` does run it, so the check above means something.
    sh(`git -C '${l.clone}' status --short`);
    expect(existsSync(marker)).toBe(true);
    const again = build(l);
    expect(again.status, again.stderr).toBe(0);
    expect(again.stderr).toMatch(/WARNING.*\.git.*fsmonitor/s);
    expect(again.stderr).toMatch(/post-index-change/);
  });
});

describe('deploy-path permissions', () => {
  it('scripts/tighten-permissions.sh removes group/other write and locks secrets and data', () => {
    const root = tmp();
    const repo = path.join(root, 'repo');
    const clone = path.join(root, 'gods-eye-view');
    for (const d of ['deploy/secrets', 'deploy/tailscale', 'data/backups', 'src'])
      mkdirSync(path.join(repo, d), { recursive: true });
    mkdirSync(path.join(clone, 'dist'), { recursive: true });
    writeFileSync(path.join(repo, 'deploy/docker-compose.yml'), 'x');
    writeFileSync(path.join(repo, 'deploy/tailscale/serve.json'), '{}');
    writeFileSync(path.join(repo, 'deploy/secrets/gateway.env'), 'X=1');
    writeFileSync(path.join(clone, 'vite.config.js'), 'x');
    writeFileSync(path.join(clone, 'dist/index.html'), 'x');
    for (const p of [
      'deploy/docker-compose.yml',
      'deploy/tailscale/serve.json',
      'deploy/secrets/gateway.env',
    ])
      chmodSync(path.join(repo, p), 0o664);
    chmodSync(path.join(repo, 'deploy/secrets'), 0o775);
    chmodSync(path.join(repo, 'data'), 0o775);
    chmodSync(path.join(clone, 'vite.config.js'), 0o664);
    chmodSync(clone, 0o775);
    // Left behind by an earlier, unconfined GEV build: a set-id file and a .env.* symlink
    // pointing at a file the tailscale container must keep reading.
    writeFileSync(path.join(clone, 'dist/suid'), '#!/bin/sh\n');
    chmodSync(path.join(clone, 'dist/suid'), 0o6755);
    symlinkSync('../repo/deploy/tailscale/serve.json', path.join(clone, '.env.local'));
    const out = execFileSync('bash', [path.join(REPO_ROOT, 'scripts/tighten-permissions.sh')], {
      env: { PATH: process.env.PATH, REPO_DIR: repo, GEV_CLONE: clone },
      encoding: 'utf8',
    });
    const mode = (p: string) => statSync(p).mode & 0o777;
    expect(mode(path.join(repo, 'deploy/secrets'))).toBe(0o700);
    expect(mode(path.join(repo, 'deploy/secrets/gateway.env'))).toBe(0o600);
    expect(mode(path.join(repo, 'data'))).toBe(0o700);
    expect(mode(path.join(repo, 'data/backups'))).toBe(0o700);
    expect(mode(path.join(repo, 'deploy/docker-compose.yml')) & 0o022).toBe(0);
    expect(mode(path.join(repo, 'deploy/tailscale/serve.json'))).toBe(0o644);
    // The GEV clone stays readable for the container uids, writable only by its owner.
    expect(mode(path.join(clone, 'vite.config.js'))).toBe(0o644);
    expect(mode(clone)).toBe(0o755);
    expect(statSync(path.join(clone, 'dist/suid')).mode & 0o7777).toBe(0o755);
    expect(lstatSync(path.join(clone, '.env.local')).isSymbolicLink()).toBe(true);
    expect(out).toMatch(/should print nothing\):\ndeploy\/secrets: 700/);
  });
});

describe('egress probe (go-live check run inside the containers)', () => {
  it('parses targets and reports reachable vs blocked', async () => {
    expect(parseTargets(['--blocked', '172.30.79.1:22', '--open', '1.1.1.1:443'])).toEqual([
      { host: '172.30.79.1', port: 22, expect: 'blocked' },
      { host: '1.1.1.1', port: 443, expect: 'open' },
    ]);
    expect(() => parseTargets(['172.30.79.1:22'])).toThrow();
    const srv = createServer((s) => s.end());
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as { port: number }).port;
    try {
      expect(await probe('127.0.0.1', port)).toBe(true);
      srv.close();
      await new Promise((r) => setTimeout(r, 50));
      expect(await probe('127.0.0.1', port, 500)).toBe(false);
    } finally {
      srv.close();
    }
  });
});
