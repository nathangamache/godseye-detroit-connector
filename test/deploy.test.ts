/**
 * Deploy-side regressions: container egress rules (DS-3), network confinement (DS-4),
 * the containerized GEV build (DS-5), Dependabot coverage (DS-7), deploy-path permissions,
 * and the listener binds the netstack fix depends on.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
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
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
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

  function run(state: string, arg: string) {
    return spawnSync('sh', [script, arg], {
      env: {
        PATH: process.env.PATH,
        IPTABLES: `${process.execPath} ${fake}`,
        FAKE_IPT_STATE: state,
      },
      encoding: 'utf8',
    });
  }
  const load = (f: string) =>
    JSON.parse(readFileSync(f, 'utf8')) as Record<string, { rules: string[] }>;

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
    for (const s of ['172.30.77.0/24', '172.30.78.0/24', '172.30.79.0/24', '172.30.76.0/24']) {
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

  it('refuses to run before Docker created DOCKER-USER', () => {
    const state = path.join(tmp(), 'ipt.json');
    writeFileSync(state, JSON.stringify({ FORWARD: { rules: [] }, INPUT: { rules: [] } }));
    const r = run(state, 'apply');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/start docker first/);
  });

  it('the systemd unit re-applies after Docker and Tailscale', () => {
    const unit = read('deploy/host-firewall/godseye-firewall.service');
    expect(unit).toMatch(/After=docker\.service tailscaled\.service/);
    expect(unit).toMatch(/PartOf=docker\.service/);
    expect(unit).toMatch(/WantedBy=docker\.service/);
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

  it('scripts/build-gev.sh builds in a confined container with only the build-time key', () => {
    const s = read('scripts/build-gev.sh');
    execFileSync('bash', ['-n', path.join(REPO_ROOT, 'scripts', 'build-gev.sh')]);
    for (const want of [
      '--user "$(id -u):$(id -g)"',
      '--cap-drop ALL',
      '--security-opt no-new-privileges:true',
      '--read-only',
      '-v "$clone:/gev"',
      '-e CESIUM_ION_TOKEN \\',
      'npm ci --ignore-scripts && npm run build && npm run build:panel',
      'node:24.22.3-bookworm-slim@sha256:',
    ])
      expect(s, want).toContain(want);
    // Exactly one bind mount, no env file, no socket, no home.
    expect(s.match(/^\s+-v /gm)).toHaveLength(1);
    expect(s).not.toMatch(/--env-file|docker\.sock|--privileged|\$HOME:/);
    // Only the CESIUM_ION_TOKEN line is ever read from gev.env.
    expect(s).toMatch(/sed -n 's\/\^CESIUM_ION_TOKEN=\/\/p'/);
    expect(s).not.toMatch(/\. .*gev\.env|source .*gev\.env/);
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
