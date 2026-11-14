/**
 * The self-hosted Overpass (deploy/overpass, docs/overpass.md): the compose file's confinement,
 * and overpass-refresh.sh's download, md5 check, build, check and swap against fake curl,
 * docker and docker-compose (no network, no containers).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/config.js';

const read = (p: string) => readFileSync(path.join(REPO_ROOT, p), 'utf8');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'gw-overpass-'));
  dirs.push(d);
  return d;
};

/** One service block of a compose file (up to the next top-level service key). */
function service(compose: string, name: string): string {
  const start = compose.indexOf(`\n  ${name}:\n`);
  expect(start, name).toBeGreaterThan(0);
  const rest = compose.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n|\n[a-z]/);
  return next > 0 ? rest.slice(0, next + 1) : rest;
}

describe('overpass compose: confinement', () => {
  const compose = read('deploy/overpass/docker-compose.yml');
  const SERVICES = ['overpass', 'overpass-init', 'overpass-check', 'overpass-clean'];

  it('one image, pinned by digest, run as uid 10003 with no capabilities and a read-only root', () => {
    const images = compose.match(/^\s*image: .*/gm)!;
    expect(images).toHaveLength(1);
    expect(images[0]).toMatch(/image: wiktorn\/overpass-api:v[\d.]+@sha256:[0-9a-f]{64}$/);
    const anchor = compose.slice(
      compose.indexOf('x-overpass: &overpass'),
      compose.indexOf('\nservices:'),
    );
    expect(anchor).toMatch(/\n {2}user: "10003:10003"\n/);
    expect(anchor).toMatch(/\n {2}read_only: true\n/);
    expect(anchor).toMatch(/\n {2}cap_drop: \[ALL\]\n/);
    expect(anchor).toMatch(/\n {2}security_opt: \["no-new-privileges:true"\]\n/);
    expect(anchor).toMatch(/\n {2}cpuset: "24-31"\n/);
    expect(anchor).toMatch(/OVERPASS_META: "no"/); // no user names or uids in the database
    for (const name of SERVICES) {
      const s = service(compose, name);
      expect(s, name).toMatch(/\n {4}<<: \*overpass\n/);
      expect(s, name).toMatch(/\n {4}mem_limit: \d+[mg]\n/);
      expect(s, name).toMatch(/\n {4}cpus: \d/);
      expect(s, name).not.toMatch(/\n {4}(user|read_only|cap_drop|security_opt):/);
    }
    expect(compose).not.toMatch(
      /cap_add|privileged|ports:|docker\.sock|\/home\/|OVERPASS_DIFF_URL/,
    );
  });

  it('serves only on the internal backend network, at a fixed address; everything else is offline', () => {
    const live = service(compose, 'overpass');
    expect(live).toMatch(
      /\n {4}networks:\n {6}backend:\n {8}ipv4_address: 172\.30\.78\.30\n {8}aliases: \[overpass\]\n/,
    );
    expect(live).not.toMatch(/network_mode/);
    for (const name of ['overpass-init', 'overpass-check', 'overpass-clean'])
      expect(service(compose, name), name).toMatch(/\n {4}network_mode: none\n/);
    expect(compose.match(/network_mode: none/g)).toHaveLength(3);
    // The only network: GEV's internal one, by its real name.
    const networks = compose.slice(compose.indexOf('\nnetworks:\n'));
    expect(networks).toMatch(/\n {2}backend:\n {4}external: true\n {4}name: godseye-backend\n$/);
    expect(networks.match(/\n {2}[a-z-]+:\n/g)).toHaveLength(1);
    // That network is internal, 172.30.78.30 is inside it, and no godseye service has it.
    const main = read('deploy/docker-compose.yml');
    expect(main).toMatch(
      /backend:\n {4}name: godseye-backend\n {4}driver: bridge\n {4}internal: true[\s\S]*?subnet: 172\.30\.78\.0\/24/,
    );
    expect(main).not.toMatch(/172\.30\.78\.30/);
  });

  it('mounts only its scripts (read-only), one database and, for the build, one extract', () => {
    const live = service(compose, 'overpass');
    expect(live).toMatch(/- \.\/container:\/overpass:ro\n/);
    expect(live).toMatch(/source: \$\{OVERPASS_DATA:\?[^}]*\}\/current\n {8}target: \/db\n/);
    const init = service(compose, 'overpass-init');
    expect(init).toMatch(/source: \$\{OVERPASS_NEW_DB:-\/nonexistent\/[^}]*\}\n {8}target: \/db\n/);
    expect(init).toMatch(
      /source: \$\{OVERPASS_NEW_PBF:-\/nonexistent\/[^}]*\}\n {8}target: \/import\/extract\.osm\.pbf\n {8}read_only: true\n/,
    );
    expect(init).toMatch(
      /entrypoint: \["nice", "-n", "19", "ionice", "-c", "3", "\/overpass\/init\.sh"\]/,
    );
    // Bind mounts use the long syntax so a missing source fails instead of being created, and
    // none of them is the whole data directory.
    expect(compose.match(/- type: bind\n/g)).toHaveLength(5);
    const sources = compose.match(/^ +source: .*$/gm)!.map((l) => l.trim());
    expect(sources).toHaveLength(5);
    for (const s of sources)
      expect(s).toMatch(
        /^source: \$\{(OVERPASS_DATA:\?[^}]*\}\/current|OVERPASS_(NEW_DB|NEW_PBF|CLEAN_DB):-\/nonexistent\/[^}]*\})$/,
      );
  });

  it("replaces the image's root entrypoint: no user switching, no updates, four endpoints, no access log", () => {
    const sup = read('deploy/overpass/container/supervisord.conf');
    expect(sup).not.toMatch(/^user=/m);
    expect(sup).not.toMatch(/update_overpass|rules_loop|fetch_osc|clone/);
    expect(sup.match(/^\[program:/gm)).toHaveLength(4);
    const nginx = read('deploy/overpass/container/nginx.conf');
    expect(nginx).toMatch(/access_log off;/);
    expect(nginx).not.toMatch(/^\s*user /m);
    expect(nginx).toMatch(
      /location ~ \^\/cgi-bin\/\(interpreter\|status\|timestamp\|kill_my_queries\)\$ \{\n\s+internal;/,
    );
    expect(nginx.match(/location = \/api\/[a-z_]+ \{/g)).toHaveLength(4);
    expect(nginx).toMatch(/location \/ \{\n\s+return 404;/);
    const init = read('deploy/overpass/container/init.sh');
    expect(init).not.toMatch(/curl|wget|chown|https?:/);
    expect(init).toMatch(/refusing to build over an existing database/);
  });

  it('the weekly unit runs the installed copy; Dependabot watches the image', () => {
    const unit = read('deploy/overpass/godseye-overpass-refresh.service');
    expect(unit).toMatch(
      /^ExecStart=%h\/\.local\/share\/godseye-overpass\/overpass-refresh\.sh refresh$/m,
    );
    expect(unit).toMatch(/^Type=oneshot$/m);
    const timer = read('deploy/overpass/godseye-overpass-refresh.timer');
    expect(timer).toMatch(/^OnCalendar=Sun \*-\*-\* \d\d:\d\d:00$/m);
    expect(timer).toMatch(/^Persistent=true$/m);
    expect(timer).toMatch(/^WantedBy=timers\.target$/m);
    expect(read('.github/dependabot.yml')).toMatch(
      /package-ecosystem: docker-compose\n {4}directory: \/deploy\/overpass\n/,
    );
    // No host paths or contact details in anything that is installed.
    for (const f of readdirSync(path.join(REPO_ROOT, 'deploy', 'overpass'), { recursive: true }))
      if (statSync(path.join(REPO_ROOT, 'deploy', 'overpass', String(f))).isFile())
        expect(read(`deploy/overpass/${String(f)}`), String(f)).not.toMatch(
          /\/home\/|@[a-z0-9-]+\.[a-z]/i,
        );
  });
});

const hasJq = spawnSync('jq', ['--version']).status === 0;

describe.skipIf(!hasJq)('container/check.sh (fake Overpass API; needs jq)', () => {
  const script = path.join(REPO_ROOT, 'deploy', 'overpass', 'container', 'check.sh');
  const fake = path.join(REPO_ROOT, 'test', 'fixtures', 'fake-overpass-host.mjs');
  function run(extra: Record<string, string> = {}) {
    const bin = tmp();
    writeFileSync(
      path.join(bin, 'curl'),
      `#!/bin/sh\nexec "${process.execPath}" "${fake}" api "$@"\n`,
      {
        mode: 0o755,
      },
    );
    return spawnSync('bash', [script], {
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        FAKE_OVP_LOG: path.join(bin, 'calls.jsonl'),
        ...extra,
      },
      encoding: 'utf8',
    });
  }

  it('passes a complete database and prints what it found', () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/data as of 2026-11-13T21:22:20Z/);
    expect(r.stdout).toMatch(/ok {3}motorway ways in a central Detroit box: 641/);
    expect(r.stdout).toMatch(/ok {3}amenities inside the City of Detroit area: 10248/);
    expect(r.stdout).toMatch(/ok {3}I-94 \/ M-10 crossing: 4/);
  });

  it('fails a database without areas, and one that never answers', () => {
    const noAreas = run({ FAKE_OVP_AMENITIES: '0' });
    expect(noAreas.status).toBe(1);
    expect(noAreas.stdout).toMatch(
      /FAIL amenities inside the City of Detroit area: 0, want at least 100/,
    );
    expect(noAreas.stdout).toMatch(/ok {3}I-94/); // the other checks still run
    const down = run({ FAKE_OVP_API_DOWN: '1', OVERPASS_CHECK_WAIT: '1' });
    expect(down.status).toBe(1);
    expect(down.stdout).toMatch(/FAIL no answer within 1 s/);
  });
});

describe('overpass-refresh.sh (fake curl, docker and compose)', { timeout: 60_000 }, () => {
  const script = path.join(REPO_ROOT, 'deploy', 'overpass', 'overpass-refresh.sh');
  const fake = path.join(REPO_ROOT, 'test', 'fixtures', 'fake-overpass-host.mjs');
  const DATED = 'https://download.geofabrik.de/north-america/us/michigan-261113.osm.pbf';
  const LATEST = 'https://download.geofabrik.de/north-america/us/michigan-latest.osm.pbf';

  interface Call {
    role: string;
    args: string[];
    newDb?: string;
    newPbf?: string;
    cleanDb?: string;
  }
  function setup() {
    const root = tmp();
    const data = path.join(root, 'overpass-data');
    return { root, data, log: path.join(root, 'calls.jsonl') };
  }
  function run(
    t: ReturnType<typeof setup>,
    args: string[] = [],
    extra: Record<string, string> = {},
  ) {
    writeFileSync(t.log, '');
    const r = spawnSync('bash', [script, ...args], {
      env: {
        PATH: process.env.PATH,
        HOME: t.root,
        OVERPASS_DATA: t.data,
        CURL: `${process.execPath} ${fake} curl`,
        DOCKER: `${process.execPath} ${fake} docker`,
        OVERPASS_COMPOSE: `${process.execPath} ${fake} compose`,
        FAKE_OVP_LOG: t.log,
        FAKE_OVP_REDIRECT: DATED,
        ...extra,
      },
      encoding: 'utf8',
    });
    const calls = readFileSync(t.log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Call);
    return { ...r, calls };
  }
  const live = (data: string) => readlinkSync(path.join(data, 'current'));
  const dbs = (data: string) =>
    readdirSync(data)
      .filter((e) => e.startsWith('db-'))
      .sort();
  const composeCalls = (calls: Call[]) =>
    calls.filter((c) => c.role === 'compose').map((c) => c.args.slice(4).join(' '));
  const execs = (calls: Call[]) =>
    calls.filter((c) => c.role === 'docker' && c.args[0] === 'exec').map((c) => c.args[1]);

  it('first build: downloads the dated extract and its own md5, builds, checks offline, then goes live', () => {
    const t = setup();
    const r = run(t);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const curls = r.calls.filter((c) => c.role === 'curl');
    expect(curls.map((c) => c.args.at(-1))).toEqual([LATEST, DATED, `${DATED}.md5`]);
    for (const c of curls) {
      const ua = c.args[c.args.indexOf('-A') + 1]!;
      expect(ua).toMatch(/^godseye-overpass-refresh\/[\d.]+ \(/);
      expect(ua).not.toMatch(/@|https?:/);
    }
    expect(composeCalls(r.calls)).toEqual([
      'run --rm overpass-init',
      'run -d --name godseye-overpass-check overpass-check',
      'up -d --no-deps overpass',
    ]);
    // The new database is checked on its own before the live container is recreated on it.
    expect(execs(r.calls)).toEqual(['godseye-overpass-check', 'godseye-overpass']);
    // docker-compose 1.29 can't recreate on Docker 29: the service's containers (renamed
    // leftovers included) are found by label and removed, then created afresh.
    expect(
      r.calls.some(
        (c) =>
          c.role === 'docker' &&
          c.args.join(' ') ===
            'ps -aq --filter label=com.docker.compose.project=godseye-overpass --filter label=com.docker.compose.service=overpass',
      ),
    ).toBe(true);
    expect(read('deploy/overpass/overpass-refresh.sh')).not.toMatch(/--force-recreate/);
    const [db] = dbs(t.data);
    expect(live(t.data)).toBe(db);
    const init = r.calls.find((c) => c.args.includes('overpass-init'))!;
    expect(init.newDb).toBe(path.join(t.data, db!));
    expect(init.newPbf).toBe(path.join(t.data, 'pbf', 'michigan-261113.osm.pbf'));
    const source = readFileSync(path.join(t.data, db!, 'SOURCE'), 'utf8');
    expect(source).toMatch(/^extract=michigan-261113\.osm\.pbf$/m);
    expect(source).toMatch(
      new RegExp(`^md5=${createHash('md5').update('fake pbf').digest('hex')}$`, 'm'),
    );
    expect(source).toMatch(/^data_as_of=2026-11-13T21:22:20Z$/m);
    // Private data directory; pbf/ and the database open only for the container's bind mounts.
    expect(statSync(t.data).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(t.data, 'pbf')).mode & 0o777).toBe(0o755);
    expect(statSync(path.join(t.data, db!)).mode & 0o777).toBe(0o777);
    expect(statSync(path.join(t.data, 'pbf', 'michigan-261113.osm.pbf')).mode & 0o777).toBe(0o644);
    expect(readdirSync(path.join(t.data, 'pbf'))).toEqual(['michigan-261113.osm.pbf']);
    expect(r.stdout).toMatch(/swapped in db-/);

    const s = run(t, ['status']);
    expect(s.status).toBe(0);
    expect(s.stdout).toMatch(new RegExp(`live: +${db}\\n`));
    expect(s.stdout).toMatch(/extract: +michigan-261113\.osm\.pbf/);
  });

  it('does nothing while that extract is live; --force rebuilds and then removes the old database', () => {
    const t = setup();
    expect(run(t).status).toBe(0);
    const [first] = dbs(t.data);
    const again = run(t);
    expect(again.status).toBe(0);
    expect(again.stdout).toMatch(/already live/);
    expect(composeCalls(again.calls)).toEqual([]);
    expect(again.calls.filter((c) => c.role === 'curl')).toHaveLength(1); // the HEAD only

    const forced = run(t, ['--force']);
    expect(forced.status).toBe(0);
    const [second] = dbs(t.data);
    expect(second).not.toBe(first);
    expect(live(t.data)).toBe(second);
    // The old database went only after the new one passed both checks.
    const cmds = composeCalls(forced.calls);
    expect(cmds.at(-1)).toBe('run --rm overpass-clean');
    expect(forced.calls.at(-1)!.cleanDb).toBe(path.join(t.data, first!));
    expect(existsSync(path.join(t.data, first!))).toBe(false);
  });

  it('a newer extract replaces the old one, and its download is the only one kept', () => {
    const t = setup();
    expect(run(t).status).toBe(0);
    const r = run(t, [], {
      FAKE_OVP_REDIRECT: DATED.replace('261113', '261120'),
      FAKE_OVP_PBF_BODY: 'newer',
    });
    expect(r.status).toBe(0);
    expect(readdirSync(path.join(t.data, 'pbf'))).toEqual(['michigan-261120.osm.pbf']);
    expect(readFileSync(path.join(t.data, live(t.data), 'SOURCE'), 'utf8')).toMatch(
      /^extract=michigan-261120\.osm\.pbf$/m,
    );
    expect(dbs(t.data)).toHaveLength(1);
  });

  it('an md5 mismatch stops before anything is built and keeps nothing it downloaded', () => {
    const t = setup();
    expect(run(t).status).toBe(0);
    const before = live(t.data);
    const r = run(t, [], {
      FAKE_OVP_REDIRECT: DATED.replace('261113', '261120'),
      FAKE_OVP_MD5: '0'.repeat(32),
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/md5 mismatch for michigan-261120\.osm\.pbf/);
    expect(composeCalls(r.calls)).toEqual([]);
    expect(readdirSync(path.join(t.data, 'pbf'))).toEqual(['michigan-261113.osm.pbf']);
    expect(live(t.data)).toBe(before);
    // A malformed md5 file is refused the same way.
    const bad = run(t, ['--force'], { FAKE_OVP_MD5: '<html>' });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/unexpected md5 file/);
  });

  it('a failed build or a failed offline check leaves the old database live and removes the new one', () => {
    const t = setup();
    expect(run(t).status).toBe(0);
    const before = live(t.data);

    const init = run(t, ['--force'], { FAKE_OVP_INIT_FAIL: '1' });
    expect(init.status).toBe(1);
    expect(init.stderr).toMatch(new RegExp(`database build failed; ${before} stays live`));
    expect(live(t.data)).toBe(before);
    expect(dbs(t.data)).toEqual([before]);

    const check = run(t, ['--force'], { FAKE_OVP_CHECK_FAIL: 'godseye-overpass-check' });
    expect(check.status).toBe(1);
    expect(check.stderr).toMatch(/the new database failed its checks/);
    expect(composeCalls(check.calls)).not.toContain('up -d --no-deps overpass');
    expect(live(t.data)).toBe(before);
    expect(dbs(t.data)).toEqual([before]);
  });

  it('puts the old database back when the live container fails its checks after the swap', () => {
    const t = setup();
    expect(run(t).status).toBe(0);
    const before = live(t.data);
    const r = run(t, ['--force'], { FAKE_OVP_ONLY_GOOD_DB: before });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/swap failed/);
    expect(r.stdout).toMatch(new RegExp(`${before} is live again`));
    expect(composeCalls(r.calls).filter((c) => c === 'up -d --no-deps overpass')).toHaveLength(2);
    expect(live(t.data)).toBe(before);
    expect(dbs(t.data)).toEqual([before]);
    expect(lstatSync(path.join(t.data, 'current')).isSymbolicLink()).toBe(true);
  });

  it('removes leftovers of an interrupted run, never the live database', () => {
    const t = setup();
    expect(run(t).status).toBe(0);
    const before = live(t.data);
    mkdirSync(path.join(t.data, 'db-20260101T000000Z', 'db'), { recursive: true });
    const r = run(t);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/removing leftover db-20260101T000000Z/);
    expect(dbs(t.data)).toEqual([before]);
  });

  it('refuses a relative data directory, or one inside a git work tree', () => {
    const t = setup();
    const rel = run(t, [], { OVERPASS_DATA: 'overpass-data' });
    expect(rel.status).toBe(1);
    expect(rel.stderr).toMatch(/absolute path/);
    execFileSync('git', ['init', '-q', t.root]);
    const inRepo = run(t);
    expect(inRepo.status).toBe(1);
    expect(inRepo.stderr).toMatch(/inside a git work tree/);
    expect(inRepo.calls).toEqual([]);
  });
});
