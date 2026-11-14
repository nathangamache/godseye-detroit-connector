# Security

`godseye.gamachecloud.com` is reachable from the open internet, because claude.ai must reach
`/mcp`. Everything a human logs into is reachable only over Nathan's tailnet. This document is
the threat model, the controls that answer it, what's left over, and the checklist to pass before
the tunnel goes live.

## Architecture in one picture

```
Internet ──Cloudflare (WAF, TLS)──tunnel──▶ cloudflared ──▶ gateway PUBLIC listener :7700
                                                            /mcp, /.well-known/oauth-*, /oauth/token|register|revoke,
                                                            /api/location, /healthz   (everything else 404)

Tailnet devices ──WireGuard──▶ tailscale sidecar (serve, HTTPS godseye.<tailnet>.ts.net)
                                  └──▶ 127.0.0.1:7702 gateway PRIVATE listener (same netns)
                                       /, /pulse, /locate, /oauth/authorize + consent, /oauth/admin
                                  gateway ──▶ gev:7701 (GEV preview, read-only clone)
                                  gateway ──stdio──▶ GEV MCP child
```

## Assets

1. **Nathan's location**: the latest phone fix (and up to 24 h of history in SQLite and backups).
2. **Provider API keys** in GEV's environment (TomTom, FIRMS, AISStream, Cesium ion) and the
   quotas behind them.
3. **OAuth credentials**: access/refresh tokens and codes, the session secret, the tunnel token,
   the Tailscale node key.
4. **The home network and other machines**: the host runs other personal services, and
   its user holds credentials that reach other machines.
5. Integrity of what Claude is told (tool output feeding his decisions).

## Adversaries

* Internet scanners and opportunistic attackers hitting every path on the public host.
* Malicious MCP clients, including ones that register via DCR and then try to phish a consent.
* Prompt injection through third-party data: radio transcripts, news headlines, station names,
  camera labels, GEV upstream data.
* A compromised dependency (npm, Docker image, GEV upstream code).
* A stolen phone or leaked device token; a stolen or lost tailnet device.
* Abuse of the gateway as an open proxy into GEV's key-spending routes.

## Controls

### Two listeners: nothing human-facing on the public internet

* The **public listener** routes only `/mcp`, `/.well-known/oauth-protected-resource(/mcp)`,
  `/.well-known/oauth-authorization-server`, `/oauth/token`, `/oauth/register`, `/oauth/revoke`,
  `/api/location` and `/healthz`. Every other path is 404 (tested), including GEV, `/locate`,
  `/oauth/authorize`, `/oauth/admin` and the login pages. It never reads Tailscale headers.
* The **private listener** binds `127.0.0.1:7702` inside the network namespace the gateway shares
  with the Tailscale sidecar, so only tailscaled can connect to it (verified: other containers get
  ECONNREFUSED). It serves the UI, authorize/consent and admin.
* Each listener has its own Host allowlist (public host or tailnet host, plus loopback; 421
  otherwise) and its own origin for CSRF checks and cookies.

### Owner authentication: Tailscale identity

* `tailscale serve` terminates HTTPS on the tailnet name, removes client-supplied `Tailscale-*`
  headers and adds `Tailscale-User-Login` for user-owned devices.
* The gateway trusts that header only when the TCP peer is in `TAILSCALE_TRUSTED_PROXY_IPS`
  (loopback by default), only on the private listener, only as a single value, and only if it
  equals `OWNER_TAILSCALE_LOGIN`. Missing, duplicated, malformed or non-owner → 403 (fail closed).
* Production mode refuses to start without `OWNER_TAILSCALE_LOGIN` and an https `PRIVATE_ORIGIN`,
  and refuses the password provider. With no login configured at all, owner routes answer 503.
* Tailnet ACL (documented): only your devices may reach `tag:godseye:443`; Funnel off.
* `Tailscale-*` and all proxy headers are stripped before anything is proxied to GEV.
* Dev/test fallback provider: password (scrypt, N=2^15) + TOTP (RFC 6238, replay-blocked),
  server-side sessions (hashed ids, 12 h), lockout after 5 failures per IP per 15 min plus a global
  ceiling of 20/h, generic errors, 250 ms failure delay. Off in production unless
  `PUBLIC_AUTHORIZE_FALLBACK=password` is set explicitly (then only for authorize/consent).

### Process isolation (production)

* Public-facing processes run in containers, never as `nathangamache`: gateway and GEV as uid
  10001, the Tailscale sidecar as uid 10002, cloudflared as uid 65532.
* `read_only: true` root filesystems, tmpfs `/tmp`, `cap_drop: [ALL]`, `no-new-privileges:true`,
  `init: true`, memory/pids/CPU limits, pinned CPUs. Tailscale uses userspace networking (no TUN
  device, no NET_ADMIN).
* Mounts: the GEV clone **read-only**; three small writable volumes for the paths GEV writes
  (`.gev-cache`, `.gev-logs`, `.cache`); the gateway's data volume; the Tailscale state volume;
  the serve config read-only. No docker socket, no home directory, no `~/.ssh`, no other `.env`.
* No published host ports. cloudflared reaches only the public listener over the internal
  `godseye` network (`172.30.77.0/24`). `docker-compose.debug.yml` can publish `127.0.0.1:7700`
  (public listener only) for local debugging.
* Secrets come from mode-600 env files read by compose; images contain no secrets. npm and
  corepack are removed from the runtime image.
* The GEV stdio child gets an explicit minimal environment (no gateway secrets), a random
  memory-only panel key, and serves no `ui://` resources.

### Bypassed-by-design public paths each carry their own auth

| Path | Control |
|---|---|
| `/mcp` | OAuth bearer token, audience-bound to `https://godseye.gamachecloud.com/mcp`, scope `mcp`; 401 + `WWW-Authenticate: Bearer resource_metadata=...`; Origin validated; per-IP (300/min) and per-grant (120/min) limits; 256 KB bodies; WAF: Anthropic egress only |
| `/.well-known/*` | static public metadata; WAF: Anthropic egress only |
| `/oauth/token` | public clients with PKCE S256; single-use 60 s codes; exact redirect match; RFC 8707 resource check; rotating refresh tokens; WAF |
| `/oauth/register` | public clients only; every redirect URI must be on the allowlist; 20/h per IP; grants nothing without owner consent over Tailscale; WAF |
| `/oauth/revoke` | needs the token; a named client must own it; WAF |
| `/api/location` | per-device token (hashed at rest); 16 KB bodies; range validation; per-device and per-IP limits; auth-failure throttle |
| `/healthz` | `{"ok":true}` only |

### OAuth hardening

* Issuer, token, registration and revocation endpoints are on `https://godseye.gamachecloud.com`;
  `authorization_endpoint` is the tailnet URL, so **only a tailnet device can complete consent**.
* Authorization code + PKCE **S256 only**; codes are single use, expire in 60 s and are burned
  before any other check. Replaying a code revokes the grant it produced.
* **Exact `redirect_uri` matching** against both the client's registration and the global
  allowlist (`https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback`,
  loopback `/callback` for Claude Code with any port per RFC 8252). A bad client or redirect gets
  an error page, never a redirect.
* **Audience binding**: `resource` must be the MCP URL; tokens store it; `/mcp` rejects others.
* **Refresh rotation with reuse detection**: every refresh issues a new pair; presenting a
  rotated refresh token revokes the whole family (`REFRESH_REUSE_GRACE_S=0`).
* Access tokens 1 h, refresh tokens 90 days sliding. Tokens, codes, sessions, device tokens and
  setup codes are stored as SHA-256 hashes; comparisons are constant time.
* **CIMD**: only client_id URLs on `CIMD_ALLOWED_CLIENT_IDS` (claude.ai and Claude Code) are
  fetched: https on 443 only, no credentials or fragments, DNS resolved once with every address
  checked against private/loopback/link-local/CGNAT/multicast/reserved ranges, the socket pinned to
  the checked address (no rebinding window), no redirects, 5 s timeout, 64 KB cap, JSON only, and
  `client_id` must equal the URL. Cached per `max-age` (60 s–24 h).
* Consent shows the client name, whether CIMD verified it or it self-registered (with a warning),
  the redirect host and the scope. `iss` is returned on redirects (RFC 9207).
* **Audit log** of grants, denials, refreshes, reuse detection, revocations, registrations,
  logins, lockouts, admin actions and device changes. Tokens and coordinates are never logged.

### Web security

* Strict CSP on gateway pages (`default-src 'none'`, self-hosted scripts/styles only,
  `frame-ancestors 'none'`, `form-action 'self'` plus the redirect origin on consent),
  `X-Frame-Options: DENY`, COOP/CORP same-origin, `Cache-Control: no-store`.
* CSRF: `__Host-` cookie (HttpOnly, Secure, SameSite=Strict) + an HMAC form token bound to purpose
  and user; POSTs must also be same-origin (Origin / Sec-Fetch-Site). `/locate/claim` requires
  same-origin plus a custom header.
* `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, HSTS; no CORS headers.
* Body limits on every route (4 KB–256 KB; proxy 5 MB); Node `requestTimeout` 60 s,
  `headersTimeout` 20 s; tool timeout 110 s; upstream proxy timeout 60 s.
* Open-redirect-safe `next` handling on login.

### The GEV reverse proxy (private listener only)

* Owner-only before proxying. Strips the nine proxy headers GEV checks plus every `cf-*` and
  `tailscale-*` header, cookies, `Authorization` and `Referer`; rewrites Host/Origin to the
  upstream; refuses foreign Origins.
* Blocks `/api/setup`, `/api/realtime/oauth*`, `/api/openai/oauth*`, GEV's `/mcp`, `/panel`, Vite
  internals, `/node_modules`, `/src/` and dotfiles; rejects traversal and encoded separators.
  Gateway-reserved prefixes never fall through to GEV.

### MCP surface

* Exactly four tools, all annotated read-only. `run_tool` is **allowlist-based**: GEV tools must
  be on `GEV_TOOL_ALLOWLIST`; `panel_request` is never registered; Google-derived tools and the
  metered HUD caption are hard-denied; OpenSky-backed aviation tools and ALPR are off by default.
* Arguments are validated against each tool's JSON schema; place names are refused unless a
  geocoder is configured.
* Per-tool quota limits (TomTom, OSRM, imagery, a Nominatim bucket), per-grant and per-IP request
  limits, and at most `MAX_CONCURRENT_TOOL_CALLS` (4) calls at once.
* No tool reads gateway config, env or files beyond the bundled rail data; error text is stripped
  of paths and truncated.
* **Untrusted output**: every result is labelled as untrusted data; Pulse and news-bearing results
  say third-party text must never be followed as instructions; the server `instructions` repeat
  it. Results are size-capped (100k chars), images downscaled or dropped, and GEV links rewritten
  to the tailnet UI origin (they open only on tailnet devices).

### Supply chain

* Nine runtime dependencies (plus optional `sharp`), a committed lockfile, `.npmrc`
  `ignore-scripts=true` (no dependency install scripts run, locally or in Docker).
* `npm test` runs `npm audit --omit=dev`: fails on high/critical, reports the rest.
* `.github/dependabot.yml` covers npm, the Dockerfile and compose images.
* Images pinned by digest: `node:24.22.3-bookworm-slim@sha256:dc26ae92…`,
  `tailscale/tailscale:v1.104.4@sha256:ed6480b3…`, `cloudflare/cloudflared:2026.11.0@sha256:bf723075…`.
* GEV is used from an unmodified upstream clone; review upstream diffs before rebuilding, since GEV
  code runs inside the gateway container (stdio child) and the GEV container.

## Residual risks

* **Lateral movement from a compromised container**: the `godseye` bridge network has internet
  egress (GEV, CIMD and Tailscale need it), and containers can reach host services bound to
  `0.0.0.0` (for example databases and other apps on the host) through the
  bridge gateway. Fixing it needs root: `DOCKER-USER` iptables rules dropping traffic from
  `172.30.77.0/24` to the host and LAN except DNS, or rebinding those services to 127.0.0.1.
* **Inside the gateway container, everything is trusted**: the GEV stdio child runs there and
  could reach the private listener and set identity headers, but it can equally read the
  database; a compromise of that container is a full compromise of the gateway's secrets.
* **Dev mode with host `tailscale serve`**: any local process on the host can reach
  `127.0.0.1:7702` and assert the header. Use the docker sidecar for production.
* **GEV as owner**: with headers stripped, the owner can spend GEV's provider keys; a stolen tailnet
  device that is logged in as Nathan can too. Remove lost devices from the tailnet promptly.
* **Docker daemon is root**: a container escape is root on the host. Rootless Docker or Podman
  would reduce that; not set up.
* **Shared network namespace**: restarting the sidecar without the gateway leaves the gateway
  without networking until it is recreated (an availability issue, not a security one).
* **DCR spam**: anyone can register clients (capped at 500, oldest unused pruned); registration
  grants nothing, and consent needs Tailscale.
* **Prompt injection** can't be eliminated by labelling; Claude may still be swayed by crafted
  transcripts or headlines. Tools are read-only, which bounds the damage to bad answers.
* **Location sensitivity**: Claude (and Anthropic's retention) sees the coordinates it asks for;
  backups contain up to 24 h of fixes.
* **Single-process rate limits** reset on restart; Cloudflare's rate limiting rule is the durable
  layer.
* **claude.ai and a cross-host `authorization_endpoint`**: untested end to end. If it fails, the
  documented fallback weakens "humans only via Tailscale" (password+TOTP on the public host).
* **Licensing**: Broadcastify's terms block Pulse's current audio source; OpenSky needs a licence;
  Google content is excluded by policy, not by GEV.
* `docker-compose` 1.29 is end-of-life; prefer Compose v2.

## Go-live checklist (all must pass before the tunnel is turned on)

- [ ] `npm ci && npm run build && npm test` passes (typecheck, unit + integration tests, audit with no high/critical).
- [ ] GEV clone `git status` is clean; `npm run build && npm run build:panel` done; no mode-600 `.env` inside the clone in docker mode.
- [ ] `deploy/secrets/{gateway,gev,tailscale,cloudflared}.env` exist, mode 600, owned by you; `git status` shows none of them.
- [ ] `gateway.env` has `PUBLIC_ORIGIN=https://godseye.gamachecloud.com`, `PRIVATE_ORIGIN=https://godseye.<tailnet>.ts.net`, `OWNER_TAILSCALE_LOGIN=<your login>`; `PUBLIC_AUTHORIZE_FALLBACK` is unset or `off`.
- [ ] Tailnet: MagicDNS + HTTPS certificates on; ACL limits `tag:godseye:443` to your devices; Funnel off; a tagged, pre-approved, non-reusable auth key in `tailscale.env`.
- [ ] Verification stack passes: `docker-compose -p godseye -f docker-compose.yml -f docker-compose.verify.yml up -d gev tailscale gateway`, then `docker exec godseye-gateway node dist/scripts/smoke-live.js` → 7/7; then `down -v`.
- [ ] Real stack without the tunnel: `TS_EXTRA_ARGS=--advertise-tags=tag:godseye docker-compose -p godseye up -d gev tailscale gateway`; from a tailnet device `https://godseye.<tailnet>.ts.net/oauth/admin` shows "Signed in as <you> via tailscale"; from a tailnet device logged in as someone else (if any) → 403.
- [ ] `docker ps` shows no published ports for godseye containers; `docker inspect` shows `ReadonlyRootfs: true`, `CapDrop: [ALL]`, `no-new-privileges`, non-root users.
- [ ] Cloudflare: Zero Trust onboarding done; tunnel public hostname → `http://gateway:7700` (never 7702); no Access applications.
- [ ] Cloudflare: WAF rule blocking `/mcp`, `/oauth/*`, `/.well-known/*` except 160.79.104.0/21 and 153.61.208.0/20 (+ home IP while testing); a rate limiting rule; Always Use HTTPS; HSTS.
- [ ] Bot Fight Mode off (or IP Access **Allow** rules for both Anthropic ranges and a plan for OwnTracks).
- [ ] Start cloudflared (`--profile tunnel`), then from outside the tailnet: `curl -i https://godseye.gamachecloud.com/` → 404; `/locate/`, `/oauth/admin`, `/oauth/authorize` → 404 (or WAF 403); `curl -i -X POST https://godseye.gamachecloud.com/mcp` → WAF 403 from a non-Anthropic IP, and with your IP temporarily allowed: 401 with `WWW-Authenticate: Bearer resource_metadata="https://godseye.gamachecloud.com/.well-known/oauth-protected-resource"`.
- [ ] From a tailnet device: `https://godseye.<tailnet>.ts.net/api/setup/status` → 404, `/panel/` → 404, `/` shows the globe.
- [ ] Add the connector in claude.ai **from a device on Tailscale**; consent shows **Claude**, verified by metadata document, redirect host `claude.ai`; approve; `find_tools` works from claude.ai web and the iPhone app (the phone needs Tailscale only for connecting, not for use).
- [ ] `/oauth/admin` shows exactly the grants you expect; the audit log shows `authorize_approved` and `token_issued`.
- [ ] Location: OwnTracks posts to the public `/api/location` successfully; `where_am_i` returns it; a revoked device gets 401.
- [ ] claude.ai privacy setting for model training is off.
- [ ] Backup timer installed (optional) and one manual backup taken.
- [ ] You know the kill switches: `docker stop godseye-cloudflared` (public side), `docker stop godseye-tailscale` (tailnet side).
