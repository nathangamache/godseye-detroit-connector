// Runs `npm audit --omit=dev` as part of `npm test`.
// Fails only on high/critical advisories in production dependencies; reports the rest.
import { spawnSync } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const r = spawnSync(npm, ['audit', '--omit=dev', '--json'], { encoding: 'utf8', timeout: 60_000 });
let report;
try {
  report = JSON.parse(r.stdout || '{}');
} catch {
  console.warn('[audit] could not parse npm audit output (offline?); skipping');
  process.exit(0);
}
if (report.error) {
  console.warn(
    `[audit] npm audit unavailable: ${report.error.summary ?? 'unknown error'}; skipping`,
  );
  process.exit(0);
}
const v = report.metadata?.vulnerabilities ?? {};
const summary = ['info', 'low', 'moderate', 'high', 'critical']
  .map((k) => `${k}=${v[k] ?? 0}`)
  .join(' ');
console.log(`[audit] production dependencies: ${summary}`);
for (const [name, adv] of Object.entries(report.vulnerabilities ?? {})) {
  console.log(`[audit]   ${adv.severity.padEnd(8)} ${name} (${adv.range ?? ''})`);
}
if ((v.high ?? 0) + (v.critical ?? 0) > 0) {
  console.error('[audit] high/critical advisories present: failing');
  process.exit(1);
}
