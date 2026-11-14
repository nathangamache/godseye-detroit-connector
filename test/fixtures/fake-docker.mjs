// Test double for the docker CLI as scripts/build-gev.sh uses it. `network inspect|create`
// succeed. `run` records what it was given (mounts, env NAMES, never values) in the JSON file
// FAKE_DOCKER_LOG, then plays the build on the directory mounted at /gev: it writes dist/ and
// node_modules/ like `npm ci && npm run build` would. FAKE_DOCKER_ATTACK (comma list) adds what
// a malicious build could do to that directory:
//   git      plant core.fsmonitor and a hook in .git (runs on the host's next `git status`)
//   source   rewrite a source file (vite.config.js)
//   symlink  replace node_modules with a symlink to FAKE_DOCKER_LINK_TARGET
//   setuid   leave a setuid/setgid file in dist/
//   lockdir  leave a directory without write permission (cleanup must still work)
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
if (args[0] === 'network') process.exit(0);
if (args[0] !== 'run') {
  console.error(`fake-docker: unsupported ${args[0]}`);
  process.exit(2);
}

const mounts = [];
const envNames = [];
for (let i = 1; i < args.length; i++) {
  const a = args[i];
  if (a === '-v' || a === '--volume') mounts.push(args[++i]);
  else if (a === '--mount') mounts.push(`mount:${args[++i]}`);
  else if (a === '-e' || a === '--env') envNames.push(args[++i].split('=')[0]);
  else if (a === '--env-file') envNames.push(`env-file:${args[++i]}`);
}
const gev = mounts.find((m) => m.endsWith(':/gev'));
if (!gev) {
  console.error('fake-docker: nothing mounted at /gev');
  process.exit(3);
}
const src = gev.slice(0, -':/gev'.length);
const listing = (dir) =>
  readdirSync(dir, { recursive: true }).map((p) => String(p).split(path.sep).join('/'));
const files = listing(src);
writeFileSync(
  process.env.FAKE_DOCKER_LOG,
  JSON.stringify({
    mounts,
    envNames,
    src,
    hasGit: existsSync(path.join(src, '.git')),
    envFiles: files.filter((f) => /(^|\/)\.env(\.|$)/.test(f)),
    files,
    command: args.at(-1),
  }),
);

// The build itself.
mkdirSync(path.join(src, 'dist', 'panel'), { recursive: true });
writeFileSync(path.join(src, 'dist', 'index.html'), '<!doctype html>');
writeFileSync(path.join(src, 'dist', 'panel', 'index.html'), '<!doctype html>');
mkdirSync(path.join(src, 'node_modules', 'vite', 'bin'), { recursive: true });
writeFileSync(path.join(src, 'node_modules', 'vite', 'bin', 'vite.js'), '// vite');
chmodSync(path.join(src, 'node_modules', 'vite', 'bin', 'vite.js'), 0o755);

const attacks = new Set((process.env.FAKE_DOCKER_ATTACK ?? '').split(',').filter(Boolean));
if (attacks.has('git')) {
  const git = path.join(src, '.git');
  mkdirSync(path.join(git, 'hooks'), { recursive: true });
  appendFileSync(
    path.join(git, 'config'),
    '[core]\n\tfsmonitor = /nonexistent/fake-docker-pwned\n',
  );
  writeFileSync(path.join(git, 'hooks', 'post-index-change'), '#!/bin/sh\nexit 0\n');
}
if (attacks.has('source')) writeFileSync(path.join(src, 'vite.config.js'), '// tampered\n');
if (attacks.has('symlink')) {
  rmSync(path.join(src, 'node_modules'), { recursive: true, force: true });
  symlinkSync(process.env.FAKE_DOCKER_LINK_TARGET, path.join(src, 'node_modules'));
}
if (attacks.has('setuid')) {
  const f = path.join(src, 'dist', 'suid');
  writeFileSync(f, '#!/bin/sh\n');
  chmodSync(f, 0o6755);
}
if (attacks.has('lockdir')) {
  mkdirSync(path.join(src, 'locked', 'inner'), { recursive: true });
  writeFileSync(path.join(src, 'locked', 'inner', 'f'), 'x');
  chmodSync(path.join(src, 'locked', 'inner'), 0o500);
  chmodSync(path.join(src, 'locked'), 0o500);
}
