# deploy/secrets (gitignored except this file)

Create these files with `install -m 600 /dev/null <file>` and fill them in. Compose reads them as
your user when it starts the containers; the values become container environment variables.

| File | Used by | Contents |
|---|---|---|
| `gateway.env` | gateway | `PUBLIC_ORIGIN=https://godseye.gamachecloud.com`, `PRIVATE_ORIGIN=https://godseye.<tailnet>.ts.net`, `OWNER_TAILSCALE_LOGIN=<your Tailscale login>`, optional `SESSION_SECRET`, `PULSE_API_TOKEN`, licensing switches. See `../../.env.example`. Do **not** set `HOST`, `PORT`, `PRIVATE_*` listener settings, `DATA_DIR` or `GEV_*` here; compose sets them. |
| `gev.env` | gev | GEV server keys: `TOMTOM_API_KEY`, `FIRMS_MAP_KEY`, `AISSTREAM_API_KEY` (see `../gev/.env.example`). |
| `tailscale.env` | tailscale | `TS_AUTHKEY=tskey-auth-...` (see `docs/tailscale-setup.md`). Only needed for the first login; the node key then lives in the `tailscale-state` volume. |
| `cloudflared.env` | cloudflared | `TUNNEL_TOKEN=<token from the Cloudflare dashboard>` |

Browser keys (`CESIUM_ION_TOKEN`) are baked into GEV's `dist/` at build time on the host, not read
from `gev.env` at runtime. Build with the key in the build shell's environment only:

```sh
cd ~/projects/godseye/gods-eye-view
set -a; . ../godseye-detroit-connector/deploy/secrets/gev.env; set +a
nice -n 19 npm run build && nice -n 19 npm run build:panel
```

In docker mode, keep no mode-600 `.env` inside the GEV clone: the container user (uid 10001)
cannot read it and Vite would fail to start.
