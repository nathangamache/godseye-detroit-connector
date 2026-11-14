# Cloudflare setup (dashboard steps for Nathan)

Cloudflare carries only the **machine-to-machine** side: claude.ai's server calls and OwnTracks.
Everything a human logs into is Tailscale-only (`docs/tailscale-setup.md`); **Cloudflare Access is
not used** and there are no Access or Bypass applications. Nothing in this repo creates tunnels,
DNS records or rules. Work through the go-live checklist in `docs/security.md` afterwards.

Values used below:

* Hostname: `godseye.gamachecloud.com`
* MCP URL to add in claude.ai: `https://godseye.gamachecloud.com/mcp`
* Anthropic egress (claude.ai server-to-server, IPv4 only): `160.79.104.0/21`, `153.61.208.0/20`

What the hostname serves (the gateway's PUBLIC listener; every other path returns 404):

| Path | Protection |
|---|---|
| `/mcp` | OAuth bearer token, audience-bound; 401 + `WWW-Authenticate` otherwise |
| `/.well-known/oauth-protected-resource[/mcp]`, `/.well-known/oauth-authorization-server` | static metadata |
| `/oauth/token`, `/oauth/register`, `/oauth/revoke` | PKCE / allowlisted redirects / token possession |
| `/api/location` | per-device token, rate limits (OwnTracks) |
| `/healthz` | `{"ok":true}` only |

## 1. Zero Trust onboarding (needed for tunnels only)

Tunnels live under Zero Trust, so complete the Zero Trust onboarding (free plan, pick a team name).
Don't create Access applications.

## 2. Tunnel (remotely managed) → the PUBLIC listener only

1. Zero Trust, **Networks, Tunnels, Create a tunnel**, type **Cloudflared**, name `godseye`.
2. Copy the token from the install command (the string after `--token`). Don't run the command.
3. Docker mode (production): `install -m 600 /dev/null deploy/secrets/cloudflared.env` and put
   `TUNNEL_TOKEN=<token>` in it. Dev mode: `install -m 600 /dev/null ~/.config/cloudflared/godseye.token`
   with the bare token, and use `deploy/systemd/cloudflared-godseye.service.template`.
4. **Public hostname**: `godseye.gamachecloud.com`, path empty, service
   * docker: `HTTP` `gateway:7700` (the public listener; cloudflared shares the compose network)
   * dev: `HTTP` `localhost:7700`

   Never point the tunnel at port 7702 (the private listener) or at GEV (7701).
5. Leave **HTTP Host Header** empty (the gateway checks Host and expects
   `godseye.gamachecloud.com`). Don't enable "No TLS Verify" or add other hostnames.

The gateway trusts `CF-Connecting-IP` only from cloudflared's address (`172.30.77.10` in docker,
loopback in dev), so rate limits and the audit log see real client IPs.

## 3. WAF custom rule: OAuth/MCP paths only from Anthropic

Security, WAF, **Custom rules, Create rule** `godseye-anthropic-only`, action **Block**:

```
(http.host eq "godseye.gamachecloud.com"
 and (http.request.uri.path eq "/mcp"
      or starts_with(http.request.uri.path, "/mcp/")
      or starts_with(http.request.uri.path, "/oauth/")
      or starts_with(http.request.uri.path, "/.well-known/"))
 and not ip.src in {160.79.104.0/21 153.61.208.0/20})
```

* For testing from home (Claude Code, the MCP inspector), temporarily add your public IP to the
  set. Claude Code on your own machine connects from your IP, not Anthropic's.
* `/api/location` stays outside this rule (your phone's IP changes); it is token-protected and
  rate-limited. `/healthz` is harmless.
* If you ever enable `PUBLIC_AUTHORIZE_FALLBACK`, your browser must reach `/oauth/authorize`,
  `/oauth/authorize/decision`, `/auth/login` and `/gw/static/*` on this host: exempt those paths
  (or your IPs) from the rule.

Optional extra: a second Block rule for any path other than the ones in the table above.

## 4. Rate limiting rule

Security, WAF, **Rate limiting rules**, `godseye-basic`: match
`http.host eq "godseye.gamachecloud.com"`, per IP, 300 requests per minute (free plan: 100 per
10 s), action Block for 1 minute. The gateway also limits per IP, per grant and per device.

## 5. Bot protection

A challenge is already active on this zone (`detroit-pulse.gamachecloud.com` answered
`cf-mitigated: challenge` during research). Any challenge on `/mcp`, `/.well-known/*` or
`/oauth/*` breaks claude.ai, and OwnTracks can't solve challenges either.

* **Bot Fight Mode** can't be skipped by WAF rules: turn it off, or add **IP Access rules**
  (Security, WAF, Tools) with action **Allow** for `160.79.104.0/21` and `153.61.208.0/20`
  (zone scope). Even then, OwnTracks posts to `/api/location` may be challenged; turning BFM off
  for the zone is the reliable fix.
* **Super Bot Fight Mode** (paid) supports a WAF *Skip* rule instead.
* Check Security Level / Browser Integrity Check don't challenge these paths.

## 6. TLS and HSTS

* SSL/TLS, Edge Certificates: **Always Use HTTPS**, minimum TLS 1.2, TLS 1.3 on.
* **HSTS**: on, max-age 12 months; include subdomains only if every subdomain is HTTPS; no
  preload unless you mean it. (The gateway also sends `Strict-Transport-Security`.)
* Claude connectors are IPv4-only; a proxied hostname is fine.
* Optional: a Configuration Rule for `/mcp*` with **Response Buffering: None**. cloudflared
  2026.11.0 already flushes SSE responses.

## 7. Timeouts

Cloudflare returns 524 after 125 s without a response byte. The gateway answers MCP calls as SSE
with 15 s keep-alives and caps every tool at 110 s, under both that and Claude's 240 s limit.

## 8. Add the connector in claude.ai (from a device on Tailscale)

Customize, Connectors, **Add custom connector**: URL `https://godseye.gamachecloud.com/mcp`, OAuth
client fields empty. Claude discovers the AS metadata on the public host and opens
`https://godseye.<tailnet>.ts.net/oauth/authorize`; your browser must be on the tailnet. Check the
consent page shows **Claude**, "client metadata document … (allowlisted)", redirect host
`claude.ai`, then approve. After that the connector works from any device, including the iPhone
app without Tailscale; only connecting or reconnecting needs it. Auth settings can't be edited
later (remove and re-add), and Claude caches discovery for about 5 minutes.

If claude.ai refuses the cross-host authorize endpoint, see the FALLBACK section in
`docs/tailscale-setup.md`.

Also confirm the claude.ai privacy setting for model training is **off**.

## Path normalization note

cloudflared releases from 2027-01-25 turn URL path normalization on by default. Re-test the WAF
rule and the public listener's 404s after upgrading past that date.
