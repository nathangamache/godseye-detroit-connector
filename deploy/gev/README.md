# GEV runtime notes

God's Eye View has no standalone server: every `/api/*` route and GEV's own `/mcp` are Vite
plugins that also run under `vite preview`. We run preview mode (about 250 MB RSS, no file
watcher, no `.env`-writing setup endpoint).

## Build (in the GEV clone; tracked files stay untouched)

```sh
cd /home/nathangamache/projects/godseye/gods-eye-view
source ~/.nvm/nvm.sh && nvm use 24
export UV_THREADPOOL_SIZE=4 PUPPETEER_SKIP_DOWNLOAD=1
taskset -c 24-31 nice -n 19 npm ci --no-audit --no-fund
taskset -c 24-31 nice -n 19 npm run build        # empties dist/
taskset -c 24-31 nice -n 19 npm run build:panel  # must run after build
git status --short                               # should print nothing
```

Measured on the deployment host (2026-11-14): npm ci 7 s, build 27 s, build:panel 29 s, peak RSS ~1.9 GB.

## Run (dev mode)

`godseye-gev.service` runs
`node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 7701 --strictPort`.
Preview ignores the `PORT` env, so the port is a flag.

## How the gateway talks to GEV

* MCP: the gateway spawns `gev/stdio-all-surfaces.mjs` (this repo) with
  `--api-base http://127.0.0.1:7701`. GEV's own HTTP `/mcp` is never exposed.
* UI: the gateway's private (tailnet-only) listener reverse-proxies `/` to the preview server
  after verifying the owner's Tailscale identity.
  It strips the nine proxy headers GEV's same-site gate rejects (plus `cf-*`/`tailscale-*`
  headers and cookies), rewrites `Host` and `Origin`
  to the upstream origin, and blocks `/api/setup/*`, `/api/realtime/oauth-*`, `/mcp`,
  `/panel/*` and Vite internals. Because stripping those headers makes every request look like
  the local owner to GEV, the gateway must authenticate everything it proxies.
* `GEV_ALLOWED_HOSTS=godseye.gamachecloud.com` is set as belt and braces; with the Host rewrite
  GEV only ever sees `127.0.0.1:7701` (dev) or `gev:7701` (docker).

## Runtime writes

GEV writes `.gev-cache/`, `.gev-logs/` and `.cache/` inside its checkout (all gitignored).
In docker mode the clone is mounted read-only and those three paths are separate writable volumes.
