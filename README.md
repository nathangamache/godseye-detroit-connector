# godseye-detroit-connector

A Node 24 / TypeScript gateway for a home server that puts **God's Eye View** (GEV, a live geospatial
globe with ~40 data tools) and **Detroit Pulse** (scanner-radio incidents, future) behind one
remote MCP server, added to claude.ai as a custom connector (web, desktop and the iPhone app).

## Why a gateway

* Claude gets **four** tools instead of 40+: `find_tools` (BM25 search with hand-written
  synonyms; with no query it lists every tool the policy allows, by category, paginated),
  `run_tool` (validate, apply policy, route, post-process), `where_am_i` (latest phone fix) and
  `whats_happening_here` (rail line and crossing, Pulse rail radio and incidents, traffic, cameras
  and weather, in parallel, each with its data age). The server instructions give the live tool
  count instead of a fixed number.
* GEV's own MCP server is local-only and its UI assumes the owner is local. The gateway adds
  OAuth, licensing policy, quotas, result shrinking and link rewriting, and keeps every
  human-facing page on the tailnet, with an authenticator code (step-up) for approvals and
  admin.
* Rail context GEV lacks comes from public FRA/NARN datasets bundled here; Pulse plugs in over a
  documented HTTP contract.

## Gateway-native tools (through `run_tool`)

| Tool | Category | What it answers | Data |
|---|---|---|---|
| `nearest_rail` | rail | nearest rail line (owner, every subdivision name) and at-grade crossing | FRA crossing inventory, NARN (bundled) |
| `crossings_near` | rail | grade crossings in a radius, nearest first | FRA crossing inventory (bundled) |
| `flights_near` | aviation | aircraft near a point or the phone (`here: true`): callsign, hex, registration, type, altitude, speed, track, distance and bearing from the exact point, data age, position source, military/LADD/PIA flags, FAA registrant type with city and state (government owners by name), a globe link per aircraft | adsb.fi live (adsb.lol fallback); FAA registry copy |
| `aircraft_lookup` | aviation | one aircraft by ICAO hex or N-number: make/model, year, registrant type and owner under the disclosure rules (never street or ZIP), status and dates, whether it is flying now | local copy of the FAA Releasable Aircraft Database, synced daily |

`flights_near` never sends the exact position: the query centre is snapped to a 0.05° grid and
the radius enlarged by 3 nm, then everything is measured here. Owner rules, LADD withholding and
the sources' terms are in `docs/security.md` ("Aviation data"); the registry sync in
`docs/operations.md`.

## Architecture

```
claude.ai ──https──▶ Cloudflare (WAF: Anthropic IPs) ──tunnel──▶ gateway PUBLIC 172.30.77.20:7700
                                                                 /mcp  OAuth endpoints  /api/location  /healthz
your devices ──Tailscale──▶ tailscale serve godseye.<tailnet>.ts.net
                              :443  ──▶ gateway PRIVATE 127.0.0.2:7702  /oauth/authorize  consent  /oauth/admin  /locate
                              :8443 ──▶ gateway UI      127.0.0.2:7703  /  (GEV globe)  /pulse
gateway ──tcp──▶ gev-mcp relay ──stdio──▶ gev/stdio-all-surfaces.mjs ──HTTP──▶ GEV vite preview :7701 ──▶ providers
gateway ──HTTP──▶ Detroit Pulse pulse-api:7710 (Pulse's internal godseye_backend network)
gateway ──▶ SQLite (OAuth clients, hashed tokens, devices, ≤24 h of fixes, audit log)
```

| Path | Listener | Auth |
|---|---|---|
| `POST /mcp` | public | OAuth 2.1 bearer token (audience `https://godseye.gamachecloud.com/mcp`) |
| `/.well-known/oauth-protected-resource[/mcp]`, `/.well-known/oauth-authorization-server` | public | none (metadata) |
| `/oauth/token`, `/oauth/register`, `/oauth/revoke` | public | PKCE / allowlisted redirects / token |
| `POST /api/location` | public + private | per-device token (OwnTracks Basic or Bearer) |
| `/oauth/authorize`, consent, `/oauth/admin` | private (:443) | Tailscale identity = `OWNER_TAILSCALE_LOGIN`, plus a step-up TOTP code to approve or open admin |
| `/locate` | private (:443) | Tailscale identity |
| `/` (GEV globe), `/pulse` | UI (:8443, separate origin) | Tailscale identity |
| `/healthz` | all | none, returns `{"ok":true}` |

OAuth: the issuer and token/registration/revocation endpoints are on the public host; the
`authorization_endpoint` is the tailnet URL, so **connecting or reconnecting the connector needs
Tailscale on that device** (and your authenticator app). Clients register by CIMD (claude.ai's and Claude Code's metadata URLs,
allowlisted) or DCR (allowlisted redirect URIs only); anyone may register, only the owner can
approve.

Run modes: **dev** = plain node under systemd --user (`deploy/systemd/`, `deploy/gev/`), with
host `tailscale serve`; **production** = hardened containers (`deploy/docker-compose.yml`: GEV,
the GEV MCP child behind a relay (`gev-mcp`), a Tailscale sidecar whose network namespace the
gateway joins, the gateway, cloudflared; read-only roots, no capabilities, non-root, no
published ports, three pinned networks) plus root-installed host firewall rules
(`docs/host-firewall.md`). Nothing is enabled or started by the repo.

## Quick start (dev)

```sh
source ~/.nvm/nvm.sh && nvm use 24
npm ci && npm run build && npm test
cp .env.example .env && chmod 600 .env       # set PRIVATE_ORIGIN, OWNER_TAILSCALE_LOGIN (or a dev password)
# GEV must be built (scripts/build-gev.sh) and running on 127.0.0.1:7701 (deploy/gev/README.md)
node dist/src/index.js                        # public :7700, private :7702, UI :7703 (all 127.0.0.1)
npm run stepup -- enroll                      # authenticator code for consent and admin
npm run smoke:live -- --url http://127.0.0.1:7700
```

## Tool policy

* GEV tools are **deny by default**: only names on `GEV_TOOL_ALLOWLIST` are visible or runnable,
  so tools added upstream stay hidden until vetted. The GEV child itself is started with only
  the allowed tools, so a composite tool can't call a denied one internally.
* Never exposed: `panel_request` (an open proxy into GEV) and `ui://` resources.
* Hard-denied for licensing: `search_places`, `places_nearby` (Google content), Street View
  fallback frames in `get_cctv_snapshot` (stripped), `get_hud_caption` (metered OpenAI).
* Off unless enabled: OpenSky-backed aviation tools (`ALLOW_OPENSKY_TOOLS`: `aircraft_in_area`,
  `find_aircraft`, `get_aircraft_track`, `get_aircraft_info`, `situation_brief`,
  `military_awareness`), ALPR locations (`ALLOW_ALPR_TOOLS`), place-name arguments
  (`GEV_PLACE_NAMES`, needs a Nominatim GEV can use).
* Quotas (`TOOL_RATE_LIMITS`): TomTom traffic 20/h and 150/d, OSRM routes 30/h, camera snapshots
  60/h, imagery 20/h, regional news 30/h, place lookups 30/h; `AVIATION_RATE_LIMITS` adds
  `flights_near` 60/h and 600/d and `aircraft_lookup` 120/h for buckets `TOOL_RATE_LIMITS` does
  not set. Outbound: adsb.fi at most one request per 1.1 s, adsb.lol at most `ADSBLOL_DAILY_MAX`
  (100) calls a day.
* Every call: ajv validation (a failure returns the schema), 110 s timeout, at most 4 at once.
* Every result: one copy of the data (GEV duplicates it), `data.view` stripped (its link kept as
  `map_url`), internal GEV links rewritten to the tailnet UI origin, third-party links flagged as
  unvetted, images downscaled with sharp (dropped with a note if they can't fit), total size
  (summary and images included) capped at 100k characters, provenance, retrieval time,
  attribution and an "untrusted data" label first.
* Location reads (`where_am_i`, `whats_happening_here` without a point) are audited per grant.
  A tool called for an explicit point, while the phone's fix is under 30 minutes old, adds a
  "phone check" (distance, bearing from the point to the phone, fix age; never the phone's
  coordinates) and says plainly when the phone is not there; that is audited as a location read
  too.
* Rail lines are reported with every subdivision name the FRA and NARN datasets give the same
  track (they often differ), computed from the data, and Pulse rail coverage is matched on all of
  them. Rail radio results relay Pulse's own verdict per kind (rail voice, EOT/HOT; contract
  v1.2): activity, quiet only when Pulse proves every channel covering the point was listened to
  for the whole window, not covered, or can't confirm, with Pulse's reasons. The gateway may turn
  a quiet into "can't confirm" when its own checks disagree, never the reverse. Without verdicts
  (an older Pulse, and scanner incidents) it says activity, no receiver, offline since when, or
  can't confirm, never "quiet", so zero messages is never passed off as a quiet line or area;
  EOT/HOT packets there are "heard but not placed", since such a Pulse can't tie them to the point.

## Repository layout

```
src/            gateway (TypeScript, ESM)
  app.ts        public and private Express apps          gateway.ts  wiring, two listeners
  mcp/          the four MCP tools                       tools/      registry, search, policy, post-processing
  gev/          child supervisor, relay, TCP transport   rail/       NARN/FRA spatial index + tools
  pulse/        Pulse HTTP client + tools                oauth/      authorization server, CIMD, DCR, tokens
  auth/         tailscale, step-up TOTP, dev login, CSRF location/   device tokens, ingest, /locate
  ui/           GEV reverse proxy, /pulse                http/       headers, Host/Origin checks, rate limits
  extra/aviation/  flights_near, aircraft_lookup, FAA registry sync
gev/stdio-all-surfaces.mjs   GEV MCP entry with all 40 tools (adapted from GEV, MIT)
data/rail/      FRA crossings + NARN lines for Michigan (public domain; see data/README.md)
web/            /locate PWA and shared CSS
scripts/        devices, stepup, hash-password, backup-db, revoke-all, smoke-live, gev-relay,
                egress-probe, build-gev.sh, tighten-permissions.sh, rail data build/fetch, audit,
                aircraft-registry-sync
deploy/         docker (image, compose, Tailscale sidecar), host-firewall (root), systemd units,
                GEV notes, secrets README
docs/           cloudflare-setup, tailscale-setup, host-firewall, phone-setup, operations, security,
                pulse-api-contract
test/           vitest unit + integration tests (mock GEV MCP child, mock Pulse)
```

## Docs

* `docs/security.md`: threat model, controls, residual risks, **go-live checklist**
* `docs/tailscale-setup.md`: the mandatory tailnet policy, the sidecar, step-up, host `tailscale serve`, fallback mode
* `docs/host-firewall.md`: root-installed rules that keep the containers off the LAN, tailnet and host
* `docs/cloudflare-setup.md`: tunnel to the public listener, WAF, bot protection, TLS
* `docs/phone-setup.md`: OwnTracks (iPhone/Android), the `/locate` PWA, iOS Shortcuts
* `docs/operations.md`: run modes, builds, logs, backups, credential rotation, kill switches
* `docs/pulse-api-contract.md`: what Pulse must implement on 127.0.0.1:7710

## Credits and licences

God's Eye View is © 2026 Bilawal Sidhu, MIT; `gev/stdio-all-surfaces.mjs` is adapted from it (see
`third_party/gods-eye-view/`). GEV's data sources keep their own terms; the gateway appends their
attribution to results. Rail data: U.S. DOT FRA and BTS, public domain. Live aircraft: adsb.fi
(https://adsb.fi; personal, non-commercial use) and adsb.lol (https://adsb.lol; ODbL 1.0).
Aircraft registry: FAA Releasable Aircraft Database (US government data). This repository is
public, for personal, non-commercial use; it holds no secrets or personal data.
