# Security

`godseye.gamachecloud.com` is reachable from the open internet, because claude.ai must reach
`/mcp`. Everything a human logs into is reachable only over the owner's tailnet, and the two
actions that matter most (approving a grant, admin) also need an authenticator code. This
document is the threat model, the controls that answer it, what's left over, and the checklist
to pass before the tunnel goes live. It was revised after an adversarial review (2026-11-14)
and again after an independent verification of those fixes; claims either disproved have been
removed or corrected.

## Architecture in one picture

```
Internet ──Cloudflare (WAF, TLS)──tunnel──▶ cloudflared ──edge net──▶ gateway PUBLIC 172.30.77.20:7700
                                                                       /mcp, /.well-known/oauth-*,
                                                                       /oauth/token|register|revoke,
                                                                       /api/location, /healthz   (else 404)

Personal tailnet devices ──WireGuard──▶ tailscale sidecar (userspace netstack, tag:godseye)
   https://godseye.<tailnet>.ts.net       serve :443  ──▶ 127.0.0.2:7702 PRIVATE  authorize/consent,
                                                                                   admin, step-up, /locate
   https://godseye.<tailnet>.ts.net:8443  serve :8443 ──▶ 127.0.0.2:7703 UI       GEV globe, /pulse
   (any other port: the netstack re-dials 127.0.0.1:<port>, where nothing listens)

gateway ──backend net (internal)──▶ gev:7701 (GEV preview)        ──gev-egress net──▶ providers
gateway ──backend net──tcp──▶ gev-mcp:7704 relay ──stdio──▶ GEV MCP child (allowed tools only)
gateway ──▶ SQLite on the gateway-data volume (hashed tokens, devices, ≤24 h of fixes, audit)
```

## Assets

1. **The owner's location**: the latest phone fix (and up to 24 h of history in the live
   database; none in backups).
2. **Provider API keys** in GEV's environment (TomTom, FIRMS, AISStream; Cesium ion baked into
   GEV's build) and the quotas behind them.
3. **OAuth credentials**: access/refresh tokens and codes, the session secret, the step-up TOTP
   secret and `STEPUP_KEY`, the tunnel token, the Tailscale node key.
4. **The home network and the owner's other machines**: the host runs other personal services,
   its user holds credentials that reach other machines, and the host is itself a tailnet node.
5. Integrity of what Claude is told (tool output feeding the owner's decisions).

## Adversaries

* Internet scanners and opportunistic attackers hitting every path on the public host.
* Malicious MCP clients, including ones that register via DCR, and **consent phishing**: anyone
  can start a connection in their own claude.ai account and send the owner the consent link.
* Prompt injection through third-party data: radio transcripts, news headlines, station names
  and homepages, camera labels, GEV upstream data.
* A compromised dependency (npm, Docker image, GEV upstream code), including code running in
  the GEV containers or during a GEV build.
* **Anything else on the owner's tailnet or machines**: a compromised service, container or
  second local user on any untagged machine the owner owns (Tailscale identifies the node's
  owner, so to `tailscale serve` they all *are* the owner), and any tailnet peer the policy
  admits.
* A stolen phone or leaked device token; a stolen or lost tailnet device.
* A mistake or compromise in the Cloudflare account (the tunnel is remotely managed).
* Abuse of the gateway as an open proxy into GEV's key-spending routes.

## Controls

### Listeners, and what Tailscale's userspace netstack can reach

The sidecar runs Tailscale in userspace mode. Its netstack accepts a tailnet connection to the
node on **any** port `tailscale serve` doesn't own and re-dials `127.0.0.1:<same port>` inside
the shared network namespace, with the client's bytes (and any `Tailscale-User-Login` header it
chose) untouched; the connection then arrives from `127.0.0.1`, exactly like serve's own.

* The **private** (`127.0.0.2:7702`) and **UI** (`127.0.0.2:7703`) listeners bind a loopback
  alias the netstack never dials; serve proxies to `127.0.0.2` explicitly. The **public**
  listener binds the sidecar's compose-network address `172.30.77.20:7700`, not `0.0.0.0`, so
  the tailnet can't reach it either (which would also have skipped the Cloudflare WAF).
* **Production refuses to start** if the private or UI host is `127.0.0.1`, `::1`, `localhost`, a
  wildcard, or not a bare dotted loopback alias; if the public host is a wildcard or loopback; if
  `TRUSTED_PROXY_IPS` is empty or contains loopback; or if `TAILSCALE_TRUSTED_PROXY_IPS` is not
  loopback. Addresses are **parsed**, not compared as text, so every spelling counts:
  `0:0:0:0:0:0:0:0`, `::0`, `0::`, `::ffff:0:0`, `::ffff:7f00:1`, `0:0:0:0:0:ffff:7f00:1`,
  brackets, zones and whitespace are refused exactly like `::`, `0.0.0.0` and `127.0.0.1`.
* `test/netstack.test.ts` reproduces the review's netstack stand-in (accept on the node address,
  re-dial `127.0.0.1:<port>`) and shows it reaches neither listener nor owner identity, while a
  serve stand-in proxying to `127.0.0.2` still does.
* In production the shared namespace holds only tailscaled and the gateway process: the GEV MCP
  child runs in its own container (below).
* Each listener has its own Host allowlist (421 otherwise) and its own origin for cookies and
  CSRF checks.
* **Client IPs**: `CF-Connecting-IP` is honoured only on the public listener and only from
  cloudflared's fixed address `172.30.77.10`. The private and UI listeners trust **no**
  forwarding header; their client address is the TCP peer.

### Owner authentication: Tailscale identity plus a step-up code

* `tailscale serve` terminates HTTPS, removes client-supplied `Tailscale-*` headers and adds
  `Tailscale-User-Login` for **untagged** source nodes (none for tagged nodes or Funnel).
* The gateway trusts that header only on the private and UI listeners, only from
  `TAILSCALE_TRUSTED_PROXY_IPS` (`127.0.0.1`), only as a single value, and only if it equals
  `OWNER_TAILSCALE_LOGIN`. Missing, duplicated, malformed or non-owner: 403.
* **The header identifies the node owner, not a person.** So:
  * the **tailnet policy is mandatory** (`docs/tailscale-setup.md`): no allow-all rule, every
    server (the docker host included) tagged `tag:server`, and only the owner's personal devices
    granted `tag:godseye` on tcp 443 and 8443;
  * **step-up TOTP** (on by default, `STEPUP_TOTP`): approving a consent needs a fresh code in
    the form (or a live step-up session), and `/oauth/admin` opens only after a code. A correct
    code opens a 10-minute session (`STEPUP_WINDOW_S`): a random id in a `__Host-` cookie
    (HttpOnly, Secure, SameSite=Strict), stored hashed and bound to the owner. CSRF tokens on
    consent and admin forms are bound to that session. Codes are RFC 6238, single use, with a
    lockout (5 per 15 min, 10 per hour). Until a secret is enrolled, approval and admin refuse
    (fail closed).
  * The TOTP secret is enrolled with `scripts/stepup.ts` (prints the `otpauth://` URI, confirms a
    code) and stored AES-256-GCM encrypted under `STEPUP_KEY`, which lives only in `gateway.env`;
    production refuses to start without it. A copy of the database or a backup alone doesn't
    reveal the secret.
* Production refuses to start without `OWNER_TAILSCALE_LOGIN`, an https `PRIVATE_ORIGIN` and
  `UI_ORIGIN`, and refuses the password provider.
* Dev/test fallback provider: password (scrypt, N=2^15) + TOTP (replay-blocked), server-side
  sessions (hashed ids, 12 h), lockout after 5 failures per IP per 15 min plus a global
  ceiling of 20/h, generic errors, 250 ms failure delay. Off in production unless
  `PUBLIC_AUTHORIZE_FALLBACK=password` is set explicitly (then only for authorize/consent).

### Separate origins for the UIs and the owner pages

* The GEV globe and `/pulse` (third-party code rendering third-party data) are served only on
  the UI origin (`:8443`); authorize, consent, admin, step-up and `/locate` only on the private
  origin (`:443`). On the private origin `/` and `/pulse` just redirect to the UI origin; on the
  UI origin the owner pages are 404. Production refuses `UI_ORIGIN == PRIVATE_ORIGIN`.
* A script in a GEV or Pulse page is cross-origin to the owner pages: it can't read their
  responses (no CORS headers), and its POSTs fail the Origin/`Sec-Fetch-Site: same-origin`
  check. In production the Origin must equal the configured https origin exactly
  (`PRIVATE_ORIGIN` for consent, admin, step-up and `/locate`), never `http://<Host>`. It also
  can't read `/locate`'s device token from that origin's storage.
* Cookies and `Clear-Site-Data` ignore ports, so the GEV proxy drops upstream `Set-Cookie` (no
  cookie tossing from the UI origin) and `Clear-Site-Data` (no wiping the owner origin's step-up
  and CSRF cookies), and all gateway cookies are `__Host-`, HttpOnly, SameSite=Strict. It also
  drops upstream CORS (`Access-Control-*`, `Timing-Allow-Origin`), so no other site can read the
  owner-only UI with the owner's ambient identity. Gateway pages send `frame-ancestors 'none'`
  and `X-Frame-Options: DENY`; proxied UI responses add `frame-ancestors 'self'`.
* Each listener has its **own rate limiter**. Behind `tailscale serve` all requests come from
  `127.0.0.1`, so with a shared one heavy globe use (or a script on the UI origin) would have
  answered 429 on consent and admin.

### Process and network isolation (production)

* Public-facing processes run in containers, never as the owner's user: gateway, GEV and gev-mcp
  as uid 10001, the Tailscale sidecar as uid 10002, cloudflared as uid 65532.
* `read_only: true` root filesystems, tmpfs `/tmp`, `cap_drop: [ALL]`, `no-new-privileges:true`,
  `init: true`, memory/pids/CPU limits. Tailscale uses userspace networking (no TUN device, no
  NET_ADMIN).
* **The GEV MCP child runs in `gev-mcp`, not in the gateway.** It imports upstream GEV code; in
  the gateway container it would have shared the gateway's uid, its network namespace (and so
  the private listener) and `/data`. The gateway connects to a small relay
  (`src/gev/relay.ts`) over TCP; the relay accepts only the gateway's backend address and spawns
  the child with a minimal environment. The gateway container no longer mounts the GEV clone.
* **Networks** (pinned subnets): `edge` (cloudflared, sidecar), `backend` (internal, no egress:
  gateway, gev, gev-mcp) and `gev-egress` (GEV's internet). cloudflared can't reach GEV or
  gev-mcp, GEV can't reach the gateway's public listener, gev-mcp can reach only GEV. GEV accepts
  only `Host: gev`. Detroit Pulse's `godseye_backend` (external, internal, `172.30.80.0/24`)
  holds only the sidecar and `pulse-api`, so Pulse is reachable from the gateway's namespace and
  from nothing else in this stack; the gateway mounts Pulse's UI volume read-only. Pulse's own
  networks are pinned too (`pulse_internal` `172.30.81.0/24`, `pulse_egress` `172.30.82.0/24`,
  `pulse_debug` `172.30.83.0/24`) and its containers use public DNS without a search domain.
* **Host firewall** (`docs/host-firewall.md`, needs root): `DOCKER-USER` and `INPUT` rules drop
  traffic from the godseye subnets (and Pulse's four: `godseye_backend` and its own) to RFC 1918, the CGNAT
  tailnet range (`100.64.0.0/10`), and every address of the host itself, so a compromised container can't reach host services, the
  LAN or the tailnet (as the host's node). `tailscaled` puts its own `ts-forward` jump (which
  accepts everything out of `tailscale0`) back above `DOCKER-USER` whenever it starts, so
  `godseye-firewall-check.service` re-orders the jumps on every `tailscaled` start and from a
  timer, inserting before deleting so no chain is ever without its jump. Containers use public
  DNS with no search domain (no LAN resolver, no MagicDNS, no tailnet names).
* Mounts: the GEV clone **read-only** (gev, gev-mcp); three small writable volumes for the paths
  GEV writes; the gateway's data volume; the Tailscale state volume; the serve config read-only.
  No docker socket, no home directory, no `~/.ssh`, no other `.env`. No published host ports
  (`docker-compose.debug.yml` can publish the public listener on `127.0.0.1:7700` for debugging).
* Secrets come from mode-600 env files read by compose; images contain no secrets
  (`.dockerignore` keeps `deploy/secrets` and `.env*` out of the build context). npm and
  corepack are removed from the runtime image. The image's files are root-owned and
  normalised to 644/755 in the build stage (no group/other write, no set-id bits), so it works
  for uid 10001 even when built from a `umask 077` checkout.

### Bypassed-by-design public paths each carry their own auth

| Path | Control |
|---|---|
| `/mcp` | OAuth bearer token, audience-bound to `https://godseye.gamachecloud.com/mcp`, scope `mcp`; 401 + `WWW-Authenticate: Bearer resource_metadata=...`; Origin validated; per-IP (300/min, IPv6 per /64) and per-grant (120/min) limits; JSON-RPC batches refused for protocol versions ≥ 2025-06-18, otherwise at most 10 messages each counted against both limits; 256 KB bodies; WAF: Anthropic egress only |
| `/.well-known/*` | static public metadata; WAF: Anthropic egress only |
| `/oauth/token` | public clients with PKCE S256; single-use 60 s codes; exact redirect match; RFC 8707 resource check; rotating refresh tokens (scope checked before rotation); per-IP limit plus a global budget of 300 failures per 10 min; WAF |
| `/oauth/register` | public clients only; every redirect URI must be on the allowlist; 20/h per IP and 200/h in total; grants nothing without owner consent over Tailscale plus a step-up code; WAF |
| `/oauth/revoke` | needs the token; a client that names itself must own it (checked before anything changes); WAF |
| `/api/location` | per-device token (hashed at rest); 16 KB bodies; range validation; per-device and per-IP (/64) limits; auth-failure throttle |
| `/healthz` | `{"ok":true}` only |

### OAuth hardening

* Issuer, token, registration and revocation endpoints are on `https://godseye.gamachecloud.com`;
  `authorization_endpoint` is the tailnet URL, so **only a tailnet device can complete consent**,
  and only with the step-up code.
* Authorization code + PKCE **S256 only**; codes are single use, expire in 60 s and are burned
  before any other check. Replaying a code revokes the grant it produced.
* **Exact `redirect_uri` matching** against both the client's registration and the global
  allowlist (`https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback`,
  loopback `/callback` for Claude Code with any port per RFC 8252). A bad client or redirect gets
  an error page, never a redirect.
* **Audience binding**: `resource` must be the MCP URL; tokens store it; `/mcp` rejects others.
* **Refresh rotation with reuse detection**: every refresh issues a new pair; presenting a
  rotated refresh token revokes the whole family (`REFRESH_REUSE_GRACE_S=0`). A request for a
  wider scope is refused *before* the token is used, so it can be retried.
* Access tokens 1 h, refresh tokens 90 days sliding. Tokens, codes, sessions, step-up sessions,
  device tokens and setup codes are stored as SHA-256 hashes; comparisons are constant time.
* **CIMD**: only client_id URLs on `CIMD_ALLOWED_CLIENT_IDS` (claude.ai and Claude Code) are
  fetched: https on 443 only, no credentials or fragments, DNS resolved once with every address
  checked against private/loopback/link-local/CGNAT/multicast/reserved ranges (parsed, so any
  spelling counts), each connection pinned to one checked address (no rebinding window; the
  pinned lookup answers Node 24's `{all: true}` form, always asynchronously, so a connect that
  fails at once is an ordinary error rather than an uncaught exception), the checked addresses
  tried in order when one can't be reached, no connection reuse, no redirects, 5 s in total,
  64 KB cap, JSON only, and `client_id` must equal the URL. Cached per `max-age` (60 s–24 h).
  Tested against a local TLS server, including an address that fails synchronously.
* **Consent page** (consent phishing): for every client it says to approve only a connection you
  started yourself on this device in the last few minutes, and that approving gives the
  *requesting* account access to your location; it shows the client, whether CIMD verified it
  (genuine client, not necessarily your account) or it self-registered, the redirect host, the
  scope, when the request started, and how many live grants that client already has. Admin
  highlights grants created in the last 24 hours. `iss` is returned on redirects (RFC 9207).

### Audit log

* Grants, denials, refreshes, reuse detection, revocations, registrations, logins, lockouts,
  step-up, admin actions, device changes and **location reads** (client, grant, tool, whether a
  fix existed; never coordinates). Admin shows location reads per grant.
* Bounded: three classes with their own row caps and retention: security (20k rows, 180 days),
  unauthenticated (rejected codes and refreshes, registrations, failed logins: at most 60 rows a
  minute in total, the rest summarised in one `audit_suppressed` row; 5k rows, 30 days) and
  access (location reads; 20k rows, 90 days). A flood of one class can't push out another; admin
  lists the security class.

### Web security

* Strict CSP on gateway pages (`default-src 'none'`, self-hosted scripts/styles only,
  `frame-ancestors 'none'`, `form-action 'self'` plus the redirect origin on consent),
  `X-Frame-Options: DENY`, COOP/CORP same-origin, `Cache-Control: no-store`.
* CSRF: `__Host-` cookie (HttpOnly, Secure, SameSite=Strict) + an HMAC form token bound to
  purpose, user and (on consent and admin) the step-up session; POSTs must also be same-origin
  (Origin / Sec-Fetch-Site). `/locate/claim` requires same-origin plus a custom header.
* `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, HSTS; no CORS headers.
* Body limits on every route (4 KB–256 KB; proxy 5 MB); Node `requestTimeout` 60 s,
  `headersTimeout` 20 s; tool timeout 110 s; upstream proxy timeout 60 s.
* Open-redirect-safe `next` handling on login (relative paths, or the UI origin only).

### The GEV reverse proxy (UI listener only)

* Owner-only before proxying. Strips the nine proxy headers GEV checks plus every `cf-*` and
  `tailscale-*` header, cookies, `Authorization` and `Referer`; rewrites Host/Origin to the
  upstream; refuses foreign Origins (the private origin included). From responses it drops
  every header that acts beyond the response itself: `Set-Cookie`, `Clear-Site-Data`,
  `Access-Control-*`, `Timing-Allow-Origin`, `Strict-Transport-Security` (per host, so
  `max-age=0` would undo the gateway's own for the owner pages), `Alt-Svc`, `NEL`, `Report-To`
  and `Reporting-Endpoints`.
* Blocks `/api/setup`, `/api/realtime/oauth*`, `/api/openai/oauth*`, GEV's `/mcp`, `/panel`, Vite
  internals, `/node_modules`, `/src/` and dotfiles; rejects traversal and encoded separators.
  Gateway-reserved prefixes never fall through to GEV.

### MCP surface

* Exactly four tools, all annotated read-only. `run_tool` is **allowlist-based**: GEV tools must
  be on `GEV_TOOL_ALLOWLIST`; `panel_request` is never registered; Google-derived tools and the
  metered HUD caption are hard-denied; OpenSky-backed aviation tools and ALPR are off by default.
* **The GEV child gets only the allowed tools** (`--allow`, required, fail closed) and builds its
  catalog from them, so a composite GEV tool can't call a denied one internally. With OpenSky
  off, `show_in_gods_eye_view` can't follow an aircraft (which would have run `find_aircraft`
  inside GEV), and the policy also refuses aircraft `follow` arguments. Tested with the real GEV
  wrapper when the clone is present.
* Arguments are validated against each tool's JSON schema; place names are refused unless a
  geocoder is configured.
* Per-tool quota limits (TomTom, OSRM, imagery, a Nominatim bucket), per-grant and per-IP request
  limits, and at most `MAX_CONCURRENT_TOOL_CALLS` (4) calls at once.
* No tool reads gateway config, env or files beyond the bundled rail data; error text is stripped
  of paths and truncated.
* **Untrusted output**: every result starts with a provenance header labelling it untrusted data
  (before any third-party text); Pulse and news-bearing results say third-party text must never
  be followed. Links on the globe origin are described as the connector's; **every other URL is
  flagged as third-party and unvetted**, in the result and in the server instructions. Every
  result, summary and images included, is capped at `MAX_RESULT_CHARS` (100k); Pulse labels are
  limited.

### Data retention

* Location: only the latest fix is ever exposed; history is pruned after
  `LOCATION_RETENTION_HOURS` (24 h). **Backups contain no fixes** (the table is emptied and the
  file VACUUMed with secure_delete before it is kept). Revoking a device deletes its fixes from
  the live database and strips any older backup that still holds fixes; every backup run does the
  same for backups made before this change.
* Logs: secret-looking fields redacted, token-shaped strings masked, coordinate fields rounded to
  2 decimals (~1 km); the per-fix line is debug-only. Tool calls log name, outcome and duration,
  never arguments.
* The gateway and its scripts run with umask 077; the database and backups are mode 600 in
  mode-700 directories.

### Supply chain and builds

* Nine runtime dependencies (plus optional `sharp`), a committed lockfile, `.npmrc`
  `ignore-scripts=true` (no dependency install scripts run, locally or in Docker).
* `npm test` runs `npm audit --omit=dev`: fails on high/critical, reports the rest.
* `.github/dependabot.yml` covers npm, the runtime Dockerfile, the **Tailscale sidecar
  Dockerfile** and compose images; `FROM` lines name the pinned images directly.
* Images pinned by digest: `node:24.22.3-bookworm-slim@sha256:dc26ae92…`,
  `tailscale/tailscale:v1.104.4@sha256:ed6480b3…`, `cloudflare/cloudflared:2026.11.0@sha256:bf723075…`.
* **GEV is built in a sandbox** (`scripts/build-gev.sh`): the pinned node image, the caller's uid
  with no capabilities, a read-only root, `--ignore-scripts`, only `CESIUM_ION_TOKEN` passed, on
  its own network that the host firewall keeps off the LAN and tailnet. The container gets a
  throwaway **copy** of the clone's working tree: no `.git` (build code can't plant a
  `core.fsmonitor`, hook or filter that a later host `git` command would run), no `.env*`
  files, logs or caches. Only `dist/` and `node_modules/` come back, only as real directories
  (a symlink in their place is refused, never followed), with modes set by `find -P` on
  directories and regular files only (readable by uid 10001, no set-id bits). The `git status`
  it suggests runs with `-c core.fsmonitor= -c core.hooksPath=/dev/null --no-pager`, and it
  warns if the clone's `.git` already carries such settings from an earlier, unconfined build.
  Review upstream diffs before rebuilding; GEV code runs in the gev and gev-mcp containers.
* `scripts/tighten-permissions.sh` removes group/other write (and set-id bits in the GEV clone)
  from the repo and the GEV clone and locks `deploy/secrets` and the data directories, so another
  local account in your group can't change what later runs with your docker rights. It never
  chmods through a symlink.

## Residual risks

* **The host firewall needs root and must be installed** (`docs/host-firewall.md`), the check
  unit and timer included. Until it is, any compromised container reaches host services bound
  to `0.0.0.0`, the LAN and the tailnet as the host's node. Docker's network isolation already
  blocks the godseye networks from each other where the compose file separates them. Once it
  is installed, these gaps remain:
  * after a `tailscaled` start, `ts-forward` sits above `DOCKER-USER` until the check unit's
    next look (about 2 s); other reorderings are caught within about 30 s. Tailscale's
    `--netfilter-mode=nodivert` would close that window but changes the host's own Tailscale
    firewalling, so it is not set up;
  * the rules are IPv4 only (the compose networks are IPv4 only; add `ip6tables` rules if that
    changes);
  * traffic to the home's own public address is "internet" to the rules. If the router does
    hairpin NAT, port-forwarded LAN services are reachable that way (possibly seen as coming
    from a LAN address). Forward no ports you don't need, or block the WAN address in
    `GODSEYE-EGRESS` too.
* **Host processes can reach the containers.** `DOCKER-USER` filters traffic *from* containers,
  not to them: any process on the host can call `gev:7701` on its bridge address and spend GEV's
  quotas (GEV's routes trust requests without proxy headers), or try the relay (it refuses every
  peer but the gateway). Tighten local accounts and services on the host itself.
* **Ambient identity remains on the owner's untagged devices.** Any process on a personal device
  can open the UIs and `/locate` as the owner, and can start (but not approve) a consent. The
  step-up code is what stands between it and a grant or admin. An attacker with that ambient
  identity can also burn the step-up lockout (5 wrong codes) and keep you out of admin for up to
  an hour: all tailnet traffic arrives from `127.0.0.1`, so the per-client limits on the private
  listener (authorize, consent, step-up, admin) are effectively one bucket for all your devices.
  The UI listener has its own limiter, so the globe can't exhaust them.
* **Same browser, two origins.** The UI origin is cross-origin to the owner pages but same-site:
  it can navigate the browser to a consent page (you still need the code), and SameSite=Strict
  cookies are sent on such same-site requests. Cookie tossing through GEV responses is blocked
  by dropping `Set-Cookie`; script-set cookies (`document.cookie`) on the UI origin can't
  overwrite HttpOnly cookies but could add non-HttpOnly ones, which the gateway ignores.
* **Consent phishing** can't be fully prevented by the gateway: it can't tell which claude.ai
  account started a flow. If you approve a link someone else sent you (code and all), their
  account gets a grant. Approve only connections you just started; check admin for new grants.
* **The tunnel is remotely managed**: ingress rules live in the Cloudflare account. A misclick or
  a compromised account can route other hostnames through the tunnel, but the container can only
  reach the edge network (the gateway's public listener) and, with the host firewall, the public
  internet. A locally managed tunnel with a read-only `config.yml` would remove even that.
* **GEV keeps internet egress** for its data providers; a compromised GEV can exfiltrate what it
  holds (its provider keys) and call those providers.
* **Docker daemon is root**: a container escape is root on the host. Rootless Docker or Podman
  would reduce that; not set up.
* **Dev mode** (plain node, host `tailscale serve`): any local process can reach
  `127.0.0.1:7702`/`7703` and assert the identity header, and no container isolation applies. The
  step-up code still guards consent and admin. Not for go-live.
* **Shared network namespace**: restarting the sidecar without the gateway leaves the gateway
  without networking until it is recreated (availability only). Anything that gets a shell in
  the sidecar shares the namespace with `127.0.0.2`, which is why the sidecar must never run
  Tailscale SSH (`--ssh` in `TS_EXTRA_ARGS`).
* **Rate limits** are single-process and reset on restart; the global budgets (failed token
  requests, registrations, unauthenticated audit rows, tool quotas) can be exhausted by an
  attacker past the WAF, which delays legitimate refreshes or registrations (availability
  only). They are kept apart from the per-client keys, so churning through client keys (for
  example `/healthz` from many addresses) can no longer evict and so reset them. Cloudflare's
  rate limiting rule is the durable layer.
* **GEV builds still run upstream code with internet access** (the npm registry), now only
  against a copy of the clone, and what they produce (`dist/`, `node_modules/`) runs in the gev
  and gev-mcp containers. A clone built with the earlier in-place version of
  `scripts/build-gev.sh` may already carry a planted `.git` setting or hook: the script warns
  about those; re-clone GEV if it does, and use only the hardened `git` command until then.
* **Prompt injection** can't be eliminated by labelling; Claude may still be swayed by crafted
  transcripts or headlines. Tools are read-only, which bounds the damage to bad answers.
* **Location sensitivity**: Claude (and Anthropic's retention) sees the coordinates it asks for.
  Location reads are audited per grant, not blocked; every grant can read location. A tool
  called for an explicit point also gets a "phone check" (distance, bearing and age of a fix at
  most `LOCATION_PROXIMITY_MINUTES` old, never its coordinates); distance and bearing from a known
  place still locate the phone roughly, so each check is audited as a location read
  (`purpose: proximity_check`).
* **claude.ai and a cross-host `authorization_endpoint`**: untested end to end. If it fails, the
  documented fallback weakens "humans only via Tailscale" (password+TOTP on the public host).
* **Licensing**: Broadcastify's terms block Pulse's current audio source; OpenSky needs a licence;
  Google content is excluded by policy, not by GEV.
* `docker-compose` 1.29 is end-of-life and crashes when recreating containers against Docker 29
  (`KeyError: 'ContainerConfig'`): use `down` then `up -d`, or install Compose v2.

## Go-live checklist (all must pass before the tunnel is turned on)

Build and tests

- [ ] `npm ci && npm run build && npm test` passes (typecheck, unit + integration tests, audit with no high/critical) and `npm run lint` is clean.
- [ ] GEV built with the current `scripts/build-gev.sh` (a copy in a container, never on the host). It printed **no** `WARNING ... .git` (if it did, re-clone GEV and build again), and the hardened `git -c core.fsmonitor= -c core.hooksPath=/dev/null --no-pager -C <clone> status --short` it prints last shows nothing. No mode-600 `.env` inside the clone.
- [ ] `scripts/tighten-permissions.sh` prints nothing under "Still group/other-writable", `deploy/secrets` is 700, and your shell profile sets `umask 077`. No other local account is in your primary group, or you accept that it can read (not write) the repo.
- [ ] The runtime image was rebuilt after the last pull, and works for uid 10001: `docker run --rm --network none --user 10001:10001 godseye-runtime:0.1.0 node -e "require('fs').readFileSync('/app/package.json')"` exits 0.

Secrets and configuration

- [ ] `deploy/secrets/{gateway,gev,tailscale,cloudflared}.env` exist, mode 600, owned by you; `git status` shows none of them.
- [ ] `gateway.env` has `PUBLIC_ORIGIN=https://godseye.gamachecloud.com`, `PRIVATE_ORIGIN=https://godseye.<tailnet>.ts.net`, `OWNER_TAILSCALE_LOGIN=<your login>`, `STEPUP_KEY=<32 random bytes>`; `PUBLIC_AUTHORIZE_FALLBACK` is unset or `off`; `STEPUP_TOTP` unset or `on`.

Tailnet (`docs/tailscale-setup.md`)

- [ ] Policy: the default allow-all rule is gone; `tag:godseye` is reachable only from your personal devices (`group:owner`) on tcp 443 and 8443; the policy's `tests` pass.
- [ ] Every server, the docker host included, is tagged `tag:server`; `tailscale whois <host 100.x>` shows the tag and no user.
- [ ] MagicDNS + HTTPS certificates on; Funnel off; no subnet routes or exit node on the godseye node; a tagged, pre-approved, non-reusable auth key in `tailscale.env` (removed after first login); `TS_EXTRA_ARGS` is only `--advertise-tags=tag:godseye` (never `--ssh`).

Host firewall (`docs/host-firewall.md`, sudo)

- [ ] `godseye-firewall.service`, `godseye-firewall-check.service` and `godseye-firewall-check.timer` installed from root-owned copies and enabled; the first is `active (exited)` and `systemctl list-timers godseye-firewall-check.timer` shows a next run; `sudo iptables -S FORWARD | sed -n 2p` is `-A FORWARD -j DOCKER-USER`.
- [ ] `sudo systemctl restart tailscaled`, wait 15 s: `sudo iptables -S FORWARD | sed -n 2p` is still `-A FORWARD -j DOCKER-USER`, and `sudo iptables -S INPUT` lists the eight `GODSEYE-HOST` jumps (the four godseye subnets and Pulse's `172.30.80.0/24` to `172.30.83.0/24`) before `-j ts-input`.
- [ ] The `egress-probe.js` runs from that page print only `PASS` (gev, gateway, gev-mcp, and the two Pulse checks): no host, LAN, tailnet or `100.100.100.100`; internet yes (except gev-mcp); `pulse-api:7710` only from the gateway.
- [ ] The `pprobe` runs for `pulse-api`, `pulse-transcribe` and `pulse-extract` print only `PASS`: no host address on any Pulse bridge, no LAN, router, tailnet or godseye subnet; internet only from the two workers. `docker network inspect pulse_internal pulse_egress pulse_debug` shows `172.30.81.0/24`, `172.30.82.0/24`, `172.30.83.0/24`.
- [ ] `docker exec godseye-gev cat /etc/resolv.conf` shows no `search …ts.net` line.

Stack

- [ ] Verification stack passes: `docker-compose -p godseye -f docker-compose.yml -f docker-compose.verify.yml up -d gev gev-mcp tailscale gateway`, then `docker exec godseye-gateway node dist/scripts/smoke-live.js` → 7/7; `docker logs godseye-gateway` shows `gateway_listening` with `public 172.30.77.20:7700`, `private 127.0.0.2:7702`, `ui 127.0.0.2:7703`, and `gev_child_ready` with `relay gev-mcp:7704`; then `down -v`.
- [ ] Real stack without the tunnel: `TS_EXTRA_ARGS=--advertise-tags=tag:godseye docker-compose -p godseye up -d gev gev-mcp tailscale gateway`; `docker exec -it godseye-gateway node dist/scripts/stepup.js enroll` done.
- [ ] `docker ps` shows no published ports; `docker inspect` shows `ReadonlyRootfs: true`, `CapDrop: [ALL]`, `no-new-privileges`, non-root users for every godseye container; the gateway container has no `/gev` mount.

Tailnet checks

- [ ] From a personal device: `https://godseye.<tailnet>.ts.net/oauth/admin` asks for the authenticator code ("Signed in as <you> via tailscale"), a wrong code is refused, the right one opens admin; `https://godseye.<tailnet>.ts.net:8443/` shows the globe; `https://godseye.<tailnet>.ts.net/` redirects there.
- [ ] From a personal device: `nc -vz -w 3 godseye.<tailnet>.ts.net 7700`, `7702`, `7703` and `22` all fail.
- [ ] From a tagged server and from the docker host: `curl -m 5 https://godseye.<tailnet>.ts.net/oauth/admin` and `:8443/` don't connect; with a temporary `tag:server -> tag:godseye tcp:443` grant they answer **403**; grant removed again.
- [ ] From a personal device: `https://godseye.<tailnet>.ts.net:8443/api/setup/status` → 404, `:8443/panel/` → 404, `https://godseye.<tailnet>.ts.net:8443/oauth/admin` → 404.
- [ ] From a personal device: `curl -sI https://godseye.<tailnet>.ts.net:8443/ | grep -iE '^(access-control|clear-site-data|set-cookie)'` prints nothing.

Cloudflare (`docs/cloudflare-setup.md`)

- [ ] Zero Trust onboarding done; tunnel public hostname → `http://gateway:7700` (never 7702/7703/7701); no other public hostnames; **no Private Network routes and WARP routing off** on the tunnel; no Access applications; any API token scoped to this zone and tunnel only.
- [ ] WAF rule blocking `/mcp`, `/oauth/*`, `/.well-known/*` except 160.79.104.0/21 and 153.61.208.0/20 (+ home IP while testing); a rate limiting rule; Always Use HTTPS; HSTS.
- [ ] Bot Fight Mode off (or IP Access **Allow** rules for both Anthropic ranges and a plan for OwnTracks).
- [ ] Start cloudflared (`--profile tunnel`), then from outside the tailnet: `curl -i https://godseye.gamachecloud.com/` → 404; `/locate/`, `/oauth/admin`, `/oauth/authorize` → 404 (or WAF 403); `curl -i -X POST https://godseye.gamachecloud.com/mcp` → WAF 403 from a non-Anthropic IP, and with your IP temporarily allowed: 401 with `WWW-Authenticate: Bearer resource_metadata="https://godseye.gamachecloud.com/.well-known/oauth-protected-resource"`.

Connect and use

- [ ] Add the connector in claude.ai **from a personal device on Tailscale**; consent shows **Claude**, verified by metadata document, redirect host `claude.ai`, "no active grant yet"; enter the code, approve; `find_tools` works from claude.ai web and the iPhone app (the phone needs Tailscale only for connecting, not for use). The CIMD fetch works (no "Invalid IP address" error page).
- [ ] `/oauth/admin` shows exactly the grants you expect; the audit list shows `authorize_approved`, `stepup_ok` and `token_issued`; after asking Claude "where am I", the grant shows a location read.
- [ ] Location: OwnTracks posts to the public `/api/location` successfully; `where_am_i` returns it; a revoked device gets 401.
- [ ] claude.ai privacy setting for model training is off.
- [ ] Backup timer installed (optional) and one manual backup taken; `sqlite3 <backup> 'select count(*) from locations'` → 0.
- [ ] You know the kill switches: `docker stop godseye-cloudflared` (public side), `docker stop godseye-tailscale` (tailnet side), `docker exec godseye-gateway node dist/scripts/revoke-all.js [--devices]` (all grants).
