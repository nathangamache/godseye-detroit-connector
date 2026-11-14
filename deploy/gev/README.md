# GEV runtime notes

God's Eye View has no standalone server: every `/api/*` route and GEV's own `/mcp` are Vite
plugins that also run under `vite preview`. We run preview mode (about 250 MB RSS, no file
watcher, no `.env`-writing setup endpoint).

## Build (sandboxed; tracked files stay untouched)

`npm ci`, `npm run build` and `npm run build:panel` run upstream code. Don't run them on the host
as yourself (your SSH keys, other projects' `.env` files and the docker socket would be in
reach). Use the containerized build from the connector repo:

```sh
cd ~/projects/godseye/godseye-detroit-connector
BUILD_CPUSET=24-31 scripts/build-gev.sh        # npm ci --ignore-scripts, build, build:panel
# then run the hardened `git ... status --short` it prints last: it should print nothing
```

It runs in the pinned `node:24` image as your uid with no capabilities, a read-only root and
only `CESIUM_ION_TOKEN` passed (from your environment, or that one line of
`deploy/secrets/gev.env`). The container gets a throwaway **copy** of the clone's working tree
without `.git`, `.env*` files, logs or caches, so build code can't plant a `core.fsmonitor`,
hook or filter that a later `git` command would run on the host. Only `dist/` and
`node_modules/` come back, and only as real directories (a symlink in their place is refused);
their modes are set without following links (readable by uid 10001, no setuid/setgid bits).
If an older version of this script built the clone, it warns about suspicious `.git/config`
keys or hooks; inspect or re-clone before running other git commands there, and use
`git -c core.fsmonitor= -c core.hooksPath=/dev/null --no-pager ...` meanwhile. Measured on the
deployment host (2026-11-14) with the earlier in-place build: about 80 s in total, peak RSS
~1.9 GB (the copy adds a few seconds).

## Run (dev mode)

`godseye-gev.service` runs
`node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 7701 --strictPort`.
Preview ignores the `PORT` env, so the port is a flag.

## How the gateway talks to GEV

* MCP: `gev/stdio-all-surfaces.mjs` (this repo) runs with `--api-base http://gev:7701` and
  `--allow <tools the gateway's policy allows>`. In docker it runs in the `gev-mcp` container
  behind a relay the gateway connects to (`GEV_CHILD_URL=tcp://gev-mcp:7704`); in dev the gateway
  spawns it locally with `--api-base http://127.0.0.1:7701`. GEV's own HTTP `/mcp` is never
  exposed.
* UI: the gateway's UI listener (tailnet-only, `https://godseye.<tailnet>.ts.net:8443`, a
  different origin from consent and admin) reverse-proxies `/` to the preview server after
  verifying the owner's Tailscale identity.
  It strips the nine proxy headers GEV's same-site gate rejects (plus `cf-*`/`tailscale-*`
  headers and cookies), rewrites `Host` and `Origin`
  to the upstream origin, and blocks `/api/setup/*`, `/api/realtime/oauth-*`, `/mcp`,
  `/panel/*` and Vite internals. Because stripping those headers makes every request look like
  the local owner to GEV, the gateway must authenticate everything it proxies.
* With the Host rewrite GEV only ever sees `127.0.0.1:7701` (dev) or `gev:7701` (docker), so docker
  mode sets `GEV_ALLOWED_HOSTS=gev` and nothing else: a tunnel route mistakenly pointed at GEV
  with the public hostname gets nothing.

## Runtime writes

GEV writes `.gev-cache/`, `.gev-logs/` and `.cache/` inside its checkout (all gitignored).
In docker mode the clone is mounted read-only and those three paths are separate writable volumes.
