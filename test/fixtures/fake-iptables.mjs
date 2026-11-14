// Test double for iptables (filter table only): keeps chains in a JSON file named by
// FAKE_IPT_STATE and implements the subset deploy/host-firewall/godseye-firewall.sh uses.
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.env.FAKE_IPT_STATE;
const st = JSON.parse(readFileSync(file, 'utf8'));
const [op, chain, ...rest] = process.argv.slice(2);
const save = () => writeFileSync(file, JSON.stringify(st));
const builtin = (c) => ['INPUT', 'FORWARD', 'OUTPUT'].includes(c);
const has = (c) => Object.hasOwn(st, c);
const fail = () => process.exit(1);

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
    const i = st[chain].rules.indexOf(rest.join(' '));
    if (i < 0) fail();
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
