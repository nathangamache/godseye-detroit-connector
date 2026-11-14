// Test double for what deploy/overpass/overpass-refresh.sh runs on the host. The first argument
// picks the role: `curl`, `docker` or `compose` (the script gets CURL, DOCKER and
// OVERPASS_COMPOSE pointing here). Every call is appended to FAKE_OVP_LOG as one JSON line.
//   curl     -I ... -w %{redirect_url} prints FAKE_OVP_REDIRECT; -o FILE URL writes
//            FAKE_OVP_PBF_BODY; URL.md5 prints FAKE_OVP_MD5 (default: the body's real md5)
//   compose  run --rm overpass-init      builds a fake database in OVERPASS_NEW_DB
//                                        (FAKE_OVP_INIT_FAIL=1: exits 1 after partial output)
//            run --rm overpass-clean     empties OVERPASS_CLEAN_DB
//            run -d --name N overpass-check, up -d ... overpass, stop: record and succeed
//   docker   exec N /overpass/check.sh   exit 1 when N is in FAKE_OVP_CHECK_FAIL (comma list)
//            and, for the live container, when FAKE_OVP_ONLY_GOOD_DB is set and `current` points
//            elsewhere; rm, logs, inspect: succeed
//   api      curl as container/check.sh runs it against the Overpass API: answers its queries
//            with FAKE_OVP_AMENITIES amenities in the Detroit area (default 10248);
//            FAKE_OVP_API_DOWN=1 fails every request
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const [role, ...args] = process.argv.slice(2);
const env = process.env;
appendFileSync(
  env.FAKE_OVP_LOG,
  JSON.stringify({
    role,
    args,
    newDb: env.OVERPASS_NEW_DB,
    newPbf: env.OVERPASS_NEW_PBF,
    cleanDb: env.OVERPASS_CLEAN_DB,
    data: env.OVERPASS_DATA,
  }) + '\n',
);
const body = env.FAKE_OVP_PBF_BODY ?? 'fake pbf';

if (role === 'api') {
  if (env.FAKE_OVP_API_DOWN === '1') process.exit(7);
  const q = args[args.indexOf('--data-urlencode') + 1].replace(/^data=/, '');
  const meta = {
    generator: 'Overpass API 0.7.62',
    osm3s: { timestamp_osm_base: '2026-11-13T21:22:20Z' },
  };
  const count = (tags) => ({ ...meta, elements: [{ type: 'count', id: 0, tags }] });
  let out = { ...meta, elements: [] };
  if (q.includes('"motorway"')) out = count({ ways: '641' });
  else if (q.includes('Q12439')) out = count({ total: env.FAKE_OVP_AMENITIES ?? '10248' });
  else if (q.includes('around.a:30'))
    out = { ...meta, elements: [1, 2, 3, 4].map((id) => ({ type: 'way', id })) };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

if (role === 'curl') {
  const url = args.at(-1);
  if (args.includes('-I')) {
    process.stdout.write(env.FAKE_OVP_REDIRECT ?? '');
  } else if (url.endsWith('.md5')) {
    const md5 = env.FAKE_OVP_MD5 ?? createHash('md5').update(body).digest('hex');
    process.stdout.write(`${md5}  ${path.basename(url, '.md5')}\n`);
  } else {
    const out = args[args.indexOf('-o') + 1];
    writeFileSync(out, body);
  }
  process.exit(0);
}

if (role === 'compose') {
  const sub = args[args.indexOf('-f') + 2];
  const service = args.at(-1);
  if (sub === 'run' && service === 'overpass-init') {
    const db = env.OVERPASS_NEW_DB;
    mkdirSync(path.join(db, 'db'), { recursive: true });
    if (env.FAKE_OVP_INIT_FAIL === '1') {
      writeFileSync(path.join(db, 'db', 'nodes.bin'), 'partial');
      process.exit(1);
    }
    writeFileSync(path.join(db, 'db', 'osm_base_version'), '2026-11-13T21:22:20Z\n');
    writeFileSync(path.join(db, 'init_done'), '');
  } else if (sub === 'run' && service === 'overpass-clean') {
    const db = env.OVERPASS_CLEAN_DB;
    for (const e of readdirSync(db)) rmSync(path.join(db, e), { recursive: true, force: true });
  }
  process.exit(0);
}

if (role === 'docker') {
  if (args[0] === 'exec') {
    const name = args[1];
    const failing = (env.FAKE_OVP_CHECK_FAIL ?? '').split(',').filter(Boolean);
    if (failing.includes(name)) process.exit(1);
    if (name === 'godseye-overpass') {
      let live = '';
      try {
        live = readlinkSync(path.join(env.OVERPASS_DATA, 'current'));
      } catch {
        // no live database
      }
      const good = env.FAKE_OVP_ONLY_GOOD_DB;
      if (good && live !== good) process.exit(1);
    }
    process.stdout.write('check: ok\n');
  }
  process.exit(0);
}

console.error(`fake-overpass-host: unknown role ${role}`);
process.exit(2);
