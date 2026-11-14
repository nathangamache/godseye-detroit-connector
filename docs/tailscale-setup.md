# Tailscale setup (the private, human-facing side)

Everything you log into is reachable **only over your tailnet**: the globe (`/`), `/pulse`,
`/locate`, `/oauth/authorize` with its consent page, and `/oauth/admin`. They are served by the
gateway's **private listener** (`127.0.0.1:7702`), and the only thing that reaches it is
`tailscale serve`, which terminates HTTPS on `https://godseye.<tailnet>.ts.net` and tells the
gateway who you are with the `Tailscale-User-Login` header. The gateway accepts that header only
from the trusted local proxy and only if it equals `OWNER_TAILSCALE_LOGIN`; otherwise it answers
403.

The public hostname (`godseye.gamachecloud.com`, via the Cloudflare Tunnel) serves only `/mcp`,
OAuth metadata, `/oauth/token|register|revoke`, `/api/location` and `/healthz`.

**Consequence:** connecting or reconnecting the claude.ai connector opens
`https://godseye.<tailnet>.ts.net/oauth/authorize` in your browser, so **the device you connect
from must be on Tailscale at that moment**. Day-to-day use (tool calls, token refresh) goes
through the public host and works from any device, including the iPhone app without Tailscale.

## One-time tailnet settings (admin console)

1. **DNS**: MagicDNS on. **HTTPS Certificates**: enabled (Settings, DNS, HTTPS Certificates).
   Note your tailnet name (`<something>.ts.net`).
2. **Tag** (recommended): in the access-control policy, add a tag owner and a grant so only your
   devices reach the gateway node:

   ```json
   "tagOwners": { "tag:godseye": ["autogroup:admin"] },
   "grants": [
     { "src": ["autogroup:member"], "dst": ["tag:godseye"], "ip": ["tcp:443"] }
   ]
   ```

   (If you share your tailnet, narrow `src` to your own user.) Keep Funnel **off** for this node;
   `serve.json` also sets `AllowFunnel: false`.
3. **Auth key**: Settings, Keys, **Generate auth key**: reusable *off*, ephemeral *off*,
   pre-approved *on*, tags `tag:godseye`. Copy it.
4. Your login name: shown in the admin console Users page (e.g. `you@example.com` or
   `you@github`). That exact value goes in `OWNER_TAILSCALE_LOGIN`.

## Production: the sidecar container (recommended)

`deploy/docker-compose.yml` runs `godseye-tailscale` (official `tailscale/tailscale:v1.104.4`,
pinned by digest, rebuilt only to run as uid 10002) with userspace networking (no TUN device, no
capabilities, read-only root) and node name `godseye`. The gateway container joins the sidecar's
network namespace (`network_mode: service:tailscale`), so the private listener on
`127.0.0.1:7702` is reachable only by tailscaled. Nothing is published on the host.

```sh
cd ~/projects/godseye/godseye-detroit-connector/deploy
install -m 600 /dev/null secrets/tailscale.env
echo 'TS_AUTHKEY=tskey-auth-...' > secrets/tailscale.env     # then chmod stays 600
# In secrets/gateway.env:
#   PRIVATE_ORIGIN=https://godseye.<tailnet>.ts.net
#   OWNER_TAILSCALE_LOGIN=<your login>
TS_EXTRA_ARGS=--advertise-tags=tag:godseye docker-compose -p godseye up -d gev tailscale gateway
docker logs godseye-tailscale | tail        # should show it logged in and serving
```

`deploy/tailscale/serve.json` is the serve config (`TS_SERVE_CONFIG`): HTTPS 443 on the node's
own name, proxy to `http://127.0.0.1:7702`. The first HTTPS request may take a few seconds while
the certificate is issued. The node key persists in the `godseye_tailscale-state` volume, so the
auth key is only used once (`TS_AUTH_ONCE=true`); you can delete it from `tailscale.env` and the
admin console afterwards.

Because the two containers share a network namespace, restart them together
(`docker-compose -p godseye restart tailscale gateway`). If the sidecar is recreated, recreate the
gateway too (`up -d --force-recreate gateway`).

## Dev mode: `tailscale serve` on the host (alternative)

With the plain-node gateway (`godseye-gateway.service`, private listener on host
`127.0.0.1:7702`):

```sh
sudo tailscale set --operator=$USER      # once, lets you run serve without sudo
tailscale serve --bg --https=443 http://127.0.0.1:7702
tailscale serve status
```

This publishes the private listener on **the host machine's** tailnet name
(`https://cyberbyte.<tailnet>.ts.net`), so set `PRIVATE_ORIGIN` to that. Trust boundary note: in
this mode any local process on the box can reach `127.0.0.1:7702` and set the header itself, so
the host user is trusted (the docker sidecar mode doesn't have this weakness). Turn it off with
`tailscale serve --https=443 off`.

## FALLBACK: authorize on the public host (off by default)

If claude.ai ever refuses an `authorization_endpoint` on a different host from the issuer, set in
the gateway env:

```
PUBLIC_AUTHORIZE_FALLBACK=password
GATEWAY_PASSWORD_HASH=...      # npm run hash-password -- --totp
GATEWAY_TOTP_SECRET=...
```

Then `/oauth/authorize`, the consent page and `/auth/login` are also served on
`https://godseye.gamachecloud.com`, behind password + TOTP with lockout, and the AS metadata
advertises `https://godseye.gamachecloud.com/oauth/authorize`. Admin and the UI stay
tailnet-only. Also allow `/oauth/authorize`, `/oauth/authorize/decision`, `/auth/login` and
`/gw/static/*` in the WAF rule for your own IP ranges, since your browser (not Anthropic) loads
them. This trades the "humans only via Tailscale" property for compatibility, so prefer leaving
it off. A passkey (WebAuthn) login would be a stronger fallback; it isn't implemented yet.
