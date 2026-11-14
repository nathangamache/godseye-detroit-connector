# Operations

Two run modes share one codebase and configuration schema:

| | Dev / plain node | Production |
|---|---|---|
| Processes | `godseye-gev.service`, `godseye-gateway.service` (systemd --user, user `nathangamache`) | `deploy/docker-compose.yml`: `gev`, `tailscale`, `gateway`, `cloudflared` containers (uids 10001 / 10002 / 65532, read-only root, no capabilities) |
| Public listener (tunnel) | `127.0.0.1:7700` | `0.0.0.0:7700` in the sidecar's netns, reached as `gateway:7700` on the `godseye` network; no host port |
| Private listener (tailnet) | `127.0.0.1:7702` + `tailscale serve` on the host | `127.0.0.1:7702` inside the netns shared with the Tailscale sidecar |
| GEV listens | `127.0.0.1:7701` | `gev:7701` inside the network only |
| Login | Tailscale header (with host `tailscale serve`) or password+TOTP | Tailscale only (fail closed) |
| Config | `./.env` (mode 600) | `deploy/secrets/*.env` (mode 600) + compose `environment:` |
| Data | `./data/gateway.sqlite` | docker volume `godseye_gateway-data` (`/data` in the container) |
| Started by | you (`systemctl --user start ...`) | `godseye-stack.service` (not enabled) or `docker-compose up -d` |

Nothing is enabled or started by the repo.

## Build

```sh
cd ~/projects/godseye/godseye-detroit-connector
source ~/.nvm/nvm.sh && nvm use 24          # never change the nvm default alias (22)
npm ci && npm run build && npm test
```

GEV (both modes): see `deploy/gev/README.md`. After `git pull` in the GEV clone:
`npm ci && npm run build && npm run build:panel` (that order, under `nice -n 19`), then restart
GEV and the gateway. The gateway re-lists GEV's tools on child start; tools that are new upstream
stay hidden until added to `GEV_TOOL_ALLOWLIST` (see README "Tool policy").

Production image (classic builder; there's no buildx on this box):

```sh
DOCKER_BUILDKIT=0 docker build --cpuset-cpus 24-31 --memory 3g -f deploy/docker/Dockerfile -t godseye-runtime:0.1.0 .
cd deploy && docker-compose -p godseye --profile tunnel up -d     # or: systemctl --user start godseye-stack
```

The sidecar and the gateway share a network namespace: restart them together
(`docker-compose -p godseye restart tailscale gateway`), and recreate the gateway whenever the
sidecar is recreated. Local verification without Tailscale or the tunnel:
`docker-compose -p godseye -f docker-compose.yml -f docker-compose.verify.yml up -d gev tailscale gateway`
(the override swaps the sidecar for an idle container; tear down with `down -v`).

The installed `docker-compose` is 1.29.2; its attached `up` crashes against Docker 29, so always
use `up -d`. Installing Compose v2 as a CLI plugin (`~/.docker/cli-plugins/docker-compose`) is
recommended; the compose file works with both.

## Logs

* Dev: `journalctl --user -u godseye-gateway -f` and `-u godseye-gev`.
* Docker: `docker logs -f godseye-gateway` (json-file driver, 5 × 10 MB per container).
* Format: JSON lines. Secret-looking fields are redacted, token-shaped strings are masked, and
  coordinates are rounded to 2 decimals. Tool calls log the tool name, outcome and duration, never
  arguments.
* GEV writes its own logs to `.gev-logs/` in the clone (dev) or the `godseye_gev-logs` volume.
* Audit log: SQLite table `audit_log` (grants, refreshes, reuse detection, revocations,
  registrations, logins, admin actions, device changes), shown on `/oauth/admin`, pruned after
  180 days.

## Backups

The database holds OAuth clients, **hashed** tokens and codes, devices, at most 24 h of location
fixes and the audit log. Treat backups as sensitive (they reveal recent location).

* `godseye-backup.timer` (nightly 03:17) runs `scripts/backup-db.js` inside the gateway container,
  using SQLite's online backup API. Files land in `/data/backups/gateway-<UTC timestamp>.sqlite`,
  mode 600, newest 14 kept. Dev mode: `npm run backup` writes `data/backups/`.
* Install the timer (optional): copy `deploy/systemd/godseye-backup.{service,timer}` to
  `~/.config/systemd/user/`, `systemctl --user daemon-reload`, then
  `systemctl --user enable --now godseye-backup.timer` when you're ready.
* Copy off the box: `docker cp godseye-gateway:/data/backups ./gw-backups` and encrypt
  (e.g. `age`) before storing elsewhere.
* Restore: stop the gateway, replace `gateway.sqlite` with the backup and delete
  `gateway.sqlite-wal` / `-shm`, start it again. (Docker: run a throwaway container with the
  volume mounted to do the copy.)

## Rotating credentials

| What | How |
|---|---|
| One claude.ai connection | `/oauth/admin`: revoke the grant (or the client). Claude reconnects through consent. |
| Everything OAuth (incident) | `docker exec godseye-gateway node dist/scripts/revoke-all.js` (add `--devices` to also kill location devices and delete fixes). Dev: `node dist/scripts/revoke-all.js`. |
| A phone / device token | `npm run devices -- revoke <name>` then `add` again (docker: `docker exec -it godseye-gateway node dist/scripts/devices.js ...`). Revocation deletes that device's fixes. |
| `SESSION_SECRET` | Change it in the env file and restart. Invalidates outstanding CSRF tokens. If unset, the gateway generates one into the database; `revoke-all` doesn't rotate it, so set it explicitly if you want rotation. |
| Password / TOTP (dev login) | `npm run hash-password -- --totp`, update `.env`, restart. |
| Cloudflare tunnel token | Dashboard: Tunnels, godseye, refresh token. Update `deploy/secrets/cloudflared.env`, `docker restart godseye-cloudflared`. |
| Tailscale node | Admin console: remove the `godseye` node, generate a new tagged auth key into `deploy/secrets/tailscale.env`, `docker volume rm godseye_tailscale-state`, then `up -d --force-recreate tailscale gateway`. |
| Provider keys (TomTom, FIRMS, AISStream) | Edit `deploy/secrets/gev.env` (docker) or the GEV clone's `.env` (dev), restart GEV. Browser keys (Cesium ion) need a GEV rebuild. |
| `PULSE_API_TOKEN` | Set the same new value for Pulse and the gateway, restart both. |

## Emergency stop

`docker stop godseye-cloudflared` takes the public side off the internet immediately; the
tailnet UI keeps working. `docker stop godseye-tailscale` takes the UI off the tailnet (and,
since the gateway shares its namespace, stops the gateway's networking). In dev mode, stop the
cloudflared unit and run `tailscale serve --https=443 off`. Then investigate with the audit log
and `docker logs`.

## Resource notes

* GEV preview ~230 MiB, gateway ~130 MiB (measured 2026-11-14); cloudflared and tailscaled are small.
* Compose limits: GEV 1 GiB / 256 pids / 2 CPUs, gateway 768 MiB / 256 pids / 2 CPUs, both pinned
  to CPUs 24-31. In dev mode systemd uses `Nice=10`, `CPUAffinity=16-31`, `MemoryMax` (cgroup
  CPU controls aren't delegated to the user manager here).
* GEV's first camera query takes ~30 s while it fetches the 7,350-camera catalog;
  `whats_happening_here` allows 45 s for cameras.

## Health checks

* `GET /healthz` → `{"ok":true}` (no data). Docker healthchecks call it inside the container.
* `npm run smoke:live -- --url http://127.0.0.1:7700` (dev) or
  `docker exec godseye-gateway node dist/scripts/smoke-live.js` (docker) runs a live end-to-end
  check with a 5-minute token it mints and revokes itself.
