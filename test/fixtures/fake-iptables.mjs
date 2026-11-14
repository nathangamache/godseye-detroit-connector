// Test double for iptables (filter table only): keeps chains in a JSON file named by
// FAKE_IPT_STATE and implements the subset deploy/host-firewall/godseye-firewall.sh uses.
// FAKE_IPT_REQUIRE (JSON [[chain, rule], ...]) names rules that must never be missing, even
// for a moment: every change that leaves one out counts in the state's "__gaps".
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.env.FAKE_IPT_STATE;
const st = JSON.parse(readFileSync(file, 'utf8'));
const [op, chain, ...rest] = process.argv.slice(2);
const required = JSON.parse(process.env.FAKE_IPT_REQUIRE ?? '[]');
const save = () => {
  for (const [c, r] of required)
    if (Object.hasOwn(st, c) && !st[c].rules.includes(r)) st.__gaps = (st.__gaps ?? 0) + 1;
  writeFileSync(file, JSON.stringify(st));
};
const builtin = (c) => ['INPUT', 'FORWARD', 'OUTPUT'].includes(c);
const has = (c) => Object.hasOwn(st, c);
const fail = () => process.exit(1);

// FAKE_IPT_TS_AT=N: on the N-th call, before doing anything, play a tailscaled (re)start: its
// ts-forward/ts-input jumps go back to the top of FORWARD and INPUT. Calls are counted in the
// state's "__calls".
const tsAt = Number(process.env.FAKE_IPT_TS_AT ?? 0);
if (tsAt) {
  st.__calls = (st.__calls ?? 0) + 1;
  if (st.__calls === tsAt) {
    for (const [c, j] of [
      ['FORWARD', 'ts-forward'],
      ['INPUT', 'ts-input'],
    ]) {
      st[j] ??= { rules: [] };
      st[c].rules = [`-j ${j}`, ...st[c].rules.filter((r) => r !== `-j ${j}`)];
    }
  }
  writeFileSync(file, JSON.stringify(st));
}

switch (op) {
  case '-N':
    if (has(chain)) fail();
    st[chain] = { rules: [] };
    break;
  case '-F':
    if (!has(chain)) fail();
    st[chain].rules = [];
    break;
  case '-X':
    if (!has(chain) || builtin(chain)) fail();
    delete st[chain];
    break;
  case '-A':
    if (!has(chain)) fail();
    st[chain].rules.push(rest.join(' '));
    break;
  case '-I': {
    if (!has(chain)) fail();
    let pos = 1;
    let r = rest;
    if (/^\d+$/.test(r[0])) [pos, r] = [Number(r[0]), r.slice(1)];
    st[chain].rules.splice(pos - 1, 0, r.join(' '));
    break;
  }
  case '-D': {
    if (!has(chain)) fail();
    // By rule number (1-based) or by rule spec (the first match), like iptables.
    const i =
      rest.length === 1 && /^\d+$/.test(rest[0])
        ? Number(rest[0]) - 1
        : st[chain].rules.indexOf(rest.join(' '));
    if (i < 0 || i >= st[chain].rules.length) fail();
    st[chain].rules.splice(i, 1);
    break;
  }
  case '-C':
    if (!has(chain) || !st[chain].rules.includes(rest.join(' '))) fail();
    process.exit(0);
    break;
  case '-L':
    if (!has(chain)) fail();
    process.exit(0);
    break;
  case '-S':
    if (!has(chain)) fail();
    console.log(builtin(chain) ? `-P ${chain} ${st[chain].policy ?? 'ACCEPT'}` : `-N ${chain}`);
    for (const r of st[chain].rules) console.log(`-A ${chain} ${r}`);
    process.exit(0);
    break;
  default:
    console.error(`fake-iptables: unsupported ${op}`);
    process.exit(2);
}
save();
