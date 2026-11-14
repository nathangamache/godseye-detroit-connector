/**
 * Go-live egress check, run INSIDE a godseye container (review DS-3/DS-4):
 *
 *   docker exec godseye-gev node /app/dist/scripts/egress-probe.js \
 *     --blocked 172.30.79.1:22 192.168.1.20:22 100.100.100.100:53 --open 1.1.1.1:443
 *
 * Tries a TCP connection to each host:port (3 s timeout). Exits 0 only if every --blocked
 * target fails and every --open target connects; prints one line per target.
 */
import { connect } from 'node:net';

export type Expect = 'blocked' | 'open';

export function parseTargets(
  argv: string[],
): Array<{ host: string; port: number; expect: Expect }> {
  const out: Array<{ host: string; port: number; expect: Expect }> = [];
  let mode: Expect | undefined;
  for (const a of argv) {
    if (a === '--blocked' || a === '--open') {
      mode = a === '--blocked' ? 'blocked' : 'open';
      continue;
    }
    const m = /^\[?([0-9a-fA-F.:]+|[A-Za-z0-9.-]+)\]?:(\d{1,5})$/.exec(a);
    if (!mode || !m) throw new Error(`bad argument ${a} (use --blocked/--open host:port ...)`);
    out.push({ host: m[1]!, port: Number(m[2]), expect: mode });
  }
  return out;
}

export function probe(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host, port });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

const isMain = process.argv[1] && /egress-probe\.js$/.test(process.argv[1]);
if (isMain) {
  let targets;
  try {
    targets = parseTargets(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    process.exit(2);
  }
  let failed = 0;
  const results = await Promise.all(
    targets.map(async (t) => ({ ...t, open: await probe(t.host, t.port) })),
  );
  for (const r of results) {
    const ok = (r.expect === 'open') === r.open;
    if (!ok) failed++;
    console.log(
      `${ok ? 'PASS' : 'FAIL'}  ${r.host}:${r.port}  ${r.open ? 'reachable' : 'blocked'} (want ${r.expect})`,
    );
  }
  process.exit(failed ? 1 : 0);
}
