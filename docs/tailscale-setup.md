# Tailscale setup (the private, human-facing side)

Everything you log into is reachable **only over your tailnet**, on two origins of the same
node name:

| URL | Gateway listener | Serves |
|---|---|---|
| `https://godseye.<tailnet>.ts.net` (443) | private, `127.0.0.2:7702` | `/oauth/authorize` and consent, `/oauth/admin`, `/oauth/stepup`, `/locate` |
| `https://godseye.<tailnet>.ts.net:8443` | UI, `127.0.0.2:7703` | the GEV globe (`/`), `/pulse` |

They are separate origins on purpose: GEV and Pulse run third-party code and render
third-party data, and must not be able to script the consent and admin pages.

`tailscale serve` terminates HTTPS on both ports and tells the gateway who you are with the
`Tailscale-User-Login` header. The gateway accepts that header only from `tailscale serve`
(peer `127.0.0.1`) and only if it equals `OWNER_TAILSCALE_LOGIN`; approving a connection and
opening admin **also need a code from your authenticator app** (step-up, see below).

The public hostname (`godseye.gamachecloud.com`, via the Cloudflare Tunnel) serves only `/mcp`,
OAuth metadata, `/oauth/token|register|revoke`, `/api/location` and `/healthz`.

**Consequence:** connecting or reconnecting the claude.ai connector opens
`https://godseye.<tailnet>.ts.net/oauth/authorize` in your browser, so **the device you connect
from must be on Tailscale at that moment**, and you need your authenticator app. Day-to-day use
(tool calls, token refresh) goes through the public host and works from any device, including
the iPhone app without Tailscale.

## Why the tailnet policy is mandatory

`Tailscale-User-Login` identifies the **owner of the node** a request comes from, not a person.
Every untagged device you own (laptops, phones, but also servers, including the machine that
runs this stack) is "you" to `tailscale serve`, and so is every process and container on it.
With Tailscale's default allow-all policy, a compromised service on any of your machines could
open the consent page as you. The step-up code stops it from approving anything, but the policy
below is what keeps those machines away from the gateway in the first place:

1. **No allow-all.** Delete the default rule (`{"src": ["*"], "dst": ["*"], "ip": ["*"]}` in
   `grants`, or `{"action": "accept", "src": ["*"], "dst": ["*:*"]}` in `acls`). Grants only
   add access; leaving the default in place makes everything else here meaningless.
2. **Tag every server** (`tag:server`), including the docker host. A tagged node no longer
   carries a user identity: `tailscale serve` sends no `Tailscale-User-Login` for it, so the
   gateway answers 403, and the grants below don't let it connect anyway.
3. **Only your personal devices reach `tag:godseye`, and only on 443 and 8443.** A user or
   group as `src` matches only that user's *untagged* devices.
4. Keep your own access to your machines with explicit grants (SSH between servers through
   `tag:server`, your devices to your servers).

The gateway's own defence against the rest (raw connections to other ports on the godseye node,
which Tailscale's userspace networking forwards to `127.0.0.1` inside the container) is to bind
nothing there: its listeners are on `127.0.0.2` and the compose-network address, and it refuses
to start in production otherwise.

## One-time tailnet settings (admin console)

1. **DNS**: MagicDNS on. **HTTPS Certificates**: enabled (Settings, DNS, HTTPS Certificates).
   Note your tailnet name (`<tailnet>.ts.net`).
2. **Access controls**: replace the policy with one shaped like this (HuJSON; adapt the group
   and the ports your servers really need). It is complete: nothing not listed is allowed.

   ```jsonc
   {
     // You, as the Tailscale login the gateway sees (OWNER_TAILSCALE_LOGIN).
     "groups": {
       "group:owner": ["you@example.com"],
     },

     // Only you may apply tags. Servers carry tag:server; the gateway node carries tag:godseye.
     "tagOwners": {
       "tag:server": ["group:owner"],
       "tag:godseye": ["group:owner"],
     },

     // NOTE: no allow-all rule anywhere. Delete the default one.
     "grants": [
       // Your personal (untagged) devices -> the gateway: consent/admin (443) and the UIs (8443).
       { "src": ["group:owner"], "dst": ["tag:godseye"], "ip": ["tcp:443", "tcp:8443"] },

       // Your personal devices -> your servers (add the ports you actually use).
       { "src": ["group:owner"], "dst": ["tag:server"], "ip": ["tcp:22"] },

       // Servers -> servers: SSH between your own machines. Never to tag:godseye.
       { "src": ["tag:server"], "dst": ["tag:server"], "ip": ["tcp:22"] },

       // Your personal devices -> each other (optional; e.g. file sharing between laptops).
       { "src": ["group:owner"], "dst": ["group:owner"], "ip": ["*"] },
     ],

     // Tailscale SSH (optional): you to your servers, re-authenticating periodically.
     "ssh": [
       {
         "action": "check",
         "src": ["group:owner"],
         "dst": ["tag:server"],
         "users": ["autogroup:nonroot"],
       },
     ],

     // Tailscale refuses to save the policy if these fail.
     "tests": [
       {
         "src": "you@example.com",
         "accept": ["tag:godseye:443", "tag:godseye:8443", "tag:server:22"],
         "deny": ["tag:godseye:7700", "tag:godseye:7702", "tag:godseye:7703", "tag:godseye:22"],
       },
       {
         "src": "tag:server",
         "accept": ["tag:server:22"],
         "deny": ["tag:godseye:443", "tag:godseye:8443", "tag:godseye:7700", "tag:godseye:7702"],
       },
     ],
   }
   ```

   If you share the tailnet with other people, they are not in `group:owner` and get nothing
   from these grants; give them their own explicit grants if they need any.
3. **Tag the servers**: in the admin console, Machines, each server (and the docker host), Edit
   ACL tags, `tag:server`. Or on the machine:
   `sudo tailscale up --advertise-tags=tag:server --reset` (re-authenticates it; expect to log in
   once). After this, `tailscale whois <its 100.x address>` from another device shows the tag and
   no user. A tagged machine also loses whatever access it had as your user, which is why the
   grants above re-add SSH explicitly.
4. **Auth key** for the gateway node: Settings, Keys, **Generate auth key**: reusable *off*,
   ephemeral *off*, pre-approved *on*, tags `tag:godseye`.
5. **Your login name**: shown on the admin console Users page (e.g. `you@example.com` or
   `you@github`). That exact value goes in `OWNER_TAILSCALE_LOGIN`.
6. Keep **Funnel off** for this node (`serve.json` also sets `AllowFunnel: false` on both
   ports), and don't advertise subnet routes or an exit node from it.

## Production: the sidecar container

`deploy/docker-compose.yml` runs `godseye-tailscale` (official `tailscale/tailscale:v1.104.4`,
pinned by digest, rebuilt only to run as uid 10002) with userspace networking (no TUN device, no
capabilities, read-only root) and node name `godseye`. The gateway container joins the sidecar's
network namespace (`network_mode: service:tailscale`) and binds:

* the private listener on `127.0.0.2:7702` and the UI listener on `127.0.0.2:7703`. Tailscale's
  userspace netstack forwards raw tailnet connections on ports serve doesn't own to
  `127.0.0.1:<port>`, so nothing may listen there (or on `0.0.0.0`); serve proxies to
  `127.0.0.2` explicitly, and its connections still arrive from `127.0.0.1`;
* the public listener on the sidecar's compose-network address `172.30.77.20:7700`
  (cloudflared's `gateway:7700`), not `0.0.0.0`.

Nothing is published on the host.

```sh
cd ~/projects/godseye/godseye-detroit-connector/deploy
install -m 600 /dev/null secrets/tailscale.env
${EDITOR:-nano} secrets/tailscale.env      # TS_AUTHKEY=tskey-auth-...  (an editor keeps it out of shell history)
# In secrets/gateway.env (see secrets/README.md):
#   PRIVATE_ORIGIN=https://godseye.<tailnet>.ts.net
#   OWNER_TAILSCALE_LOGIN=<your login>
#   STEPUP_KEY=<from: docker run --rm godseye-runtime:0.1.0 node dist/scripts/stepup.js keygen>
TS_EXTRA_ARGS=--advertise-tags=tag:godseye docker-compose -p godseye up -d gev gev-mcp tailscale gateway
docker logs godseye-tailscale | tail        # should show it logged in and serving
docker exec -it godseye-gateway node dist/scripts/stepup.js enroll   # step-up code, once
```

`deploy/tailscale/serve.json` is the serve config (`TS_SERVE_CONFIG`): HTTPS 443 to
`http://127.0.0.2:7702` and HTTPS 8443 to `http://127.0.0.2:7703`, on the node's own name. The
first HTTPS request may take a few seconds while the certificate is issued. The node key persists
in the `godseye_tailscale-state` volume, so the auth key is only used once (`TS_AUTH_ONCE=true`);
delete it from `tailscale.env` and the admin console afterwards.

Because the two containers share a network namespace, restart them together
(`docker-compose -p godseye restart tailscale gateway`). If the sidecar is recreated, recreate the
gateway too (`up -d --force-recreate gateway`).

## Step-up code (consent and admin)

On by default (`STEPUP_TOTP=on`). Enroll once with
`docker exec -it godseye-gateway node dist/scripts/stepup.js enroll` (dev: `npm run stepup --
enroll`): it prints an `otpauth://` URI and the key for your authenticator app, asks for a code
to confirm, and stores the secret in the database encrypted with `STEPUP_KEY` (which lives only
in `gateway.env`). Until you enroll, consent shows no Approve button and admin answers 503.

* **Approving a connection** needs a code typed into the consent form (or a step-up session
  opened in the last 10 minutes on that browser).
* **Admin** asks for a code first; it then stays open for `STEPUP_WINDOW_S` (600 s). "Lock admin
  now" ends it early.
* Codes are single use, with a lockout after 5 wrong codes in 15 minutes.
* Lost the authenticator? `docker exec -it godseye-gateway node dist/scripts/stepup.js enroll --force`.

## Go-live checks for this side

Run from a **personal device** on the tailnet unless noted:

1. `https://godseye.<tailnet>.ts.net/oauth/admin` asks for the code ("Signed in as <you> via
   tailscale"), then opens. `https://godseye.<tailnet>.ts.net:8443/` shows the globe.
2. Raw ports are closed: `nc -vz -w 3 godseye.<tailnet>.ts.net 7700`, `7702`, `7703` and `22`
   all fail (the policy blocks them; even if it didn't, nothing listens where the netstack
   forwards).
3. From a **tagged server**, and from the docker host itself:
   `curl -sS -m 5 -o /dev/null -w '%{http_code}\n' https://godseye.<tailnet>.ts.net/oauth/admin`
   and the same for `:8443/` fail to connect (the policy has no grant). To prove the identity
   half too, temporarily add a grant `tag:server -> tag:godseye tcp:443`, repeat: the answer
   must be **403** ("Not available here"), because a tagged node has no user identity. Remove
   the grant again.
4. `tailscale whois <docker host's 100.x>` shows `tag:server` and no user.
5. The admin console's policy editor shows the `tests` above passing.
6. From inside a container (after `docs/host-firewall.md`):
   `docker exec godseye-gev node /app/dist/scripts/egress-probe.js --blocked 100.100.100.100:53`
   passes.

## Dev mode: `tailscale serve` on the host (not for go-live)

With the plain-node gateway (`godseye-gateway.service`: private listener on host
`127.0.0.1:7702`, UI on `127.0.0.1:7703`):

```sh
sudo tailscale set --operator=$USER      # once, lets you run serve without sudo
tailscale serve --bg --https=443 http://127.0.0.1:7702
tailscale serve --bg --https=8443 http://127.0.0.1:7703
tailscale serve status
```

This publishes on **the host machine's** tailnet name (`https://<host>.<tailnet>.ts.net`), so set
`PRIVATE_ORIGIN` to that (the UI origin defaults to the same name on 8443). Trust boundary: in
this mode **any local process or user on the host** can connect to `127.0.0.1:7702` and assert
the identity header itself, and if the host is untagged, everything on it already *is* you to
`tailscale serve`. The step-up code still guards consent and admin, but the UIs and `/locate` are
open to every local process. Use the docker sidecar for anything real. Turn it off with
`tailscale serve --https=443 off` and `--https=8443 off`.

## FALLBACK: authorize on the public host (off by default)

If claude.ai ever refuses an `authorization_endpoint` on a different host from the issuer, set in
the gateway env:

```
PUBLIC_AUTHORIZE_FALLBACK=password
GATEWAY_PASSWORD_HASH=...      # npm run hash-password -- --totp
GATEWAY_TOTP_SECRET=...
```

Then `/oauth/authorize`, the consent page and `/auth/login` are also served on
`https://godseye.gamachecloud.com`, behind password + TOTP with lockout (and the step-up code on
approval), and the AS metadata advertises `https://godseye.gamachecloud.com/oauth/authorize`.
Admin and the UI stay tailnet-only. Also allow `/oauth/authorize`, `/oauth/authorize/decision`,
`/auth/login` and `/gw/static/*` in the WAF rule for your own IP ranges, since your browser (not
Anthropic) loads them. This trades the "humans only via Tailscale" property for compatibility, so
prefer leaving it off. A passkey (WebAuthn) login would be a stronger fallback; it isn't
implemented yet.
