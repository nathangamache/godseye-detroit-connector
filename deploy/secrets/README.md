# deploy/secrets (gitignored except this file)

Keep this directory mode 700 (`chmod 700 deploy/secrets`, or run `scripts/tighten-permissions.sh`).
Create each file with `install -m 600 /dev/null <file>` and fill it in with an editor (not
`echo`, which leaves secrets in your shell history). Compose reads them as your user when it
starts the containers; the values become container environment variables.

| File | Used by | Contents |
|---|---|---|
| `gateway.env` | gateway | `PUBLIC_ORIGIN=https://godseye.gamachecloud.com`, `PRIVATE_ORIGIN=https://godseye.<tailnet>.ts.net`, `OWNER_TAILSCALE_LOGIN=<your Tailscale login>`, `STEPUP_KEY=<32 random bytes, base64url>` (required; `node dist/scripts/stepup.js keygen` or `openssl rand -base64 32`), optional `SESSION_SECRET`, `PULSE_API_TOKEN`, licensing switches. See `../../.env.example`. Do **not** set `HOST`, `PORT`, `PRIVATE_*`/`UI_*` listener settings, `TRUSTED_PROXY_IPS`, `DATA_DIR` or `GEV_*` here; compose sets them. |
| `gev.env` | gev | GEV server keys: `TOMTOM_API_KEY`, `FIRMS_MAP_KEY`, `AISSTREAM_API_KEY` (see `../gev/.env.example`). |
| `tailscale.env` | tailscale | `TS_AUTHKEY=tskey-auth-...` (see `docs/tailscale-setup.md`). Only needed for the first login; the node key then lives in the `tailscale-state` volume. |
| `cloudflared.env` | cloudflared | `TUNNEL_TOKEN=<token from the Cloudflare dashboard>` |

Browser keys (`CESIUM_ION_TOKEN`) are baked into GEV's `dist/` at build time, not read from
`gev.env` at runtime. Build with `scripts/build-gev.sh` (a sandboxed container): it reads only the
`CESIUM_ION_TOKEN=` line from `gev.env` and passes nothing else. Don't `source` the whole file
into a shell that then runs upstream build code.

In docker mode, keep no mode-600 `.env` inside the GEV clone: the container user (uid 10001)
cannot read it and Vite would fail to start.
