# Host firewall: keep the containers off the LAN, the tailnet and the host

**Needs root. Do this before go-live.** Without it, a compromised godseye container (GEV runs
unmodified upstream code and parses third-party data; the gateway parses internet traffic;
cloudflared is remotely configured) can open connections to:

* every service on the host that listens on `0.0.0.0` (SSH, databases, Redis, other apps'
  dev servers), through the bridge gateway or any of the host's addresses;
* the home LAN (router, NAS, printers, other machines);
* the whole tailnet, **as the host's own tailnet node**: the host routes `100.64.0.0/10`
  through `tailscale0` and masquerades container traffic, so a container inherits whatever
  the tailnet policy grants the host, including `https://godseye.<tailnet>.ts.net` itself if
  the host is an untagged, owner-owned node (see `docs/tailscale-setup.md`).

Docker can't express "internet only" for a bridge network, and these rules can't be added
without root, so this page gives the exact rules and a script and unit that apply them.

## What the rules do

The compose networks have pinned subnets (`deploy/docker-compose.yml`, and Detroit Pulse's
`detroit-pulse/deploy/docker-compose.yml` and `setup.sh`):

| Network | Subnet | Members | Egress |
|---|---|---|---|
| `godseye-edge` | `172.30.77.0/24` | cloudflared `.10`, tailscale + gateway `.20` | internet (tunnel, Tailscale coordination/DERP, CIMD fetch) |
| `godseye-backend` | `172.30.78.0/24` | tailscale + gateway `.20`, gev `.11`, gev-mcp `.12`, overpass `.30` (`deploy/overpass`, `docs/overpass.md`) | none (`internal: true`) |
| `godseye-gev-egress` | `172.30.79.0/24` | gev `.11` | internet (GEV's data providers) |
| `godseye-build` | `172.30.76.0/24` | `scripts/build-gev.sh` | internet (npm registry) |
| `godseye_backend` (Detroit Pulse) | `172.30.80.0/24` | tailscale + gateway `.20`, `pulse-api` | none (`--internal`); members only reach each other |
| `pulse_internal` (Detroit Pulse) | `172.30.81.0/24` | pulse-postgis, pulse-redis, pulse-api, pulse-transcribe, pulse-extract (pulse-debug) | none (`internal: true`); members only reach each other |
| `pulse_egress` (Detroit Pulse) | `172.30.82.0/24` | pulse-transcribe, pulse-extract | internet only (Anthropic, Census/Photon geocoders, the first Whisper download) |
| `pulse_debug` (Detroit Pulse) | `172.30.83.0/24` | pulse-debug (profile `debug`, ports on `127.0.0.1`) | internet only (unused) |

`godseye_backend` belongs to Detroit Pulse (`detroit-pulse/deploy`) and is `external` in the
connector's compose file, so its subnet is pinned where it is created. Pulse's `setup.sh`
creates it with that subnet (and stops with an error if an existing one has another); by hand:

```sh
docker network create --driver bridge --internal --subnet 172.30.80.0/24 --gateway 172.30.80.1 \
  --label org.detroit-pulse.shared=true godseye_backend
docker network inspect godseye_backend --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}'   # 172.30.80.0/24
```

Pulse's own networks (`pulse_internal`, `pulse_egress`, `pulse_debug`) are pinned in Pulse's
compose file; one created before that keeps its old subnet until `docker-compose -p pulse down`
and `up -d` recreate it (Pulse's `setup.sh` warns about it).

The sidecar's fixed address there (`172.30.80.20`) makes `docker-compose up` fail on a network
created without that subnet, so the rules below can't silently miss it. An internal bridge still
gives the host an address on it (`172.30.80.1`): without the `INPUT` rule, the gateway's
namespace (through the sidecar) and `pulse-api` could open connections to every host service
listening on `0.0.0.0` that way. The same holds for `pulse_internal` (`172.30.81.1`), and
`pulse_egress` is routed through the host, so without the rules `pulse-transcribe` and
`pulse-extract` could also reach the LAN and the tailnet.

For traffic **from** any of those subnets, `deploy/host-firewall/godseye-firewall.sh`:

1. `DOCKER-USER` (routed traffic, evaluated before Docker's own rules) jumps to
   `GODSEYE-EGRESS`, which
   * returns replies (`ESTABLISHED,RELATED`);
   * returns traffic **within** each Pulse subnet (`-s 172.30.80.0/24 -d 172.30.80.0/24`: the
     sidecar and `pulse-api`; likewise `172.30.81.0/24` to `172.30.83.0/24`) but not traffic into
     them from anywhere else, which hits the RFC 1918 drop: only the sidecar's namespace, which
     sits on `godseye_backend`, reaches Pulse;
   * **drops** traffic from the Pulse subnets to the godseye subnets (`-s P -d G -j DROP`), so
     no Pulse container gets near the gateway's public listener, GEV or gev-mcp;
   * returns traffic to the godseye subnets themselves (Docker's network isolation still
     applies between them);
   * **drops** `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` (RFC 1918: the LAN and other
     docker networks), `100.64.0.0/10` (CGNAT: the tailnet, including `100.100.100.100`),
     `169.254.0.0/16`, `192.0.0.0/24`, `198.18.0.0/15`, `224.0.0.0/4`, `240.0.0.0/4`;
   * returns everything else (the public internet).
2. `INPUT` (traffic to the host itself, which `DOCKER-USER` never sees) jumps to
   `GODSEYE-HOST`, which returns replies and **drops everything else**: no new connection
   from a container to any host address, on any port.
3. Keeps the `FORWARD -j DOCKER-USER` jump first, and its own `INPUT` jumps ahead of
   `ts-input`. `tailscaled` inserts `-j ts-forward` at the top of `FORWARD` (and `-j ts-input`
   at the top of `INPUT`) **every time it starts**. `ts-forward` accepts everything routed out
   of `tailscale0`, so with the wrong order container traffic to the tailnet would never reach
   `DOCKER-USER`. `godseye-firewall.sh ensure` moves the jumps back; it runs from
   `godseye-firewall-check.service` on every `tailscaled` start or restart (watching for 60 s,
   since `tailscaled` adds its jumps a moment after it reports started) and from its timer
   every 30 s. Each move inserts the rule at the top **before** deleting the old copy, so the
   chain is never without it.

**DNS needs no exception.** The compose file sets `dns: [1.1.1.1, 9.9.9.9]` and
`dns_search: ["."]` for every service, so Docker's embedded resolver forwards to public
resolvers (allowed as internet) rather than the LAN router or MagicDNS, and the host's tailnet
search domain is not copied into the containers (a tailnet device named like a service, for
example `pulse-api`, can't capture its traffic). Override the resolvers with `GODSEYE_DNS_1` /
`GODSEYE_DNS_2` if you prefer others; keep them public.

**Trade-offs.** The Tailscale sidecar can't make direct WireGuard connections to peers on the
LAN (RFC 1918 is dropped); it uses DERP relays or the peers' public endpoints instead, which
is slower but works. GEV keeps internet access because its data comes from public APIs; the
rules keep that access from reaching anything private. IPv6 is not enabled on the godseye
networks; if you ever enable it, add the equivalent `ip6tables` rules (drop `fc00::/7`,
`fe80::/10`, `fd7a:115c:a1e0::/48` and the host's addresses).

### The exact rules

`godseye-firewall.sh apply` is equivalent to (for each `$S` in the four godseye subnets and
Pulse's four, `172.30.80.0/24` to `172.30.83.0/24`; override with `GODSEYE_SUBNETS` /
`GODSEYE_PULSE_SUBNETS`):

```sh
G="172.30.77.0/24 172.30.78.0/24 172.30.79.0/24 172.30.76.0/24"
P="172.30.80.0/24 172.30.81.0/24 172.30.82.0/24 172.30.83.0/24"
iptables -N GODSEYE-EGRESS
iptables -A GODSEYE-EGRESS -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
for p in $P; do iptables -A GODSEYE-EGRESS -s "$p" -d "$p" -j RETURN; done
for p in $P; do for g in $G; do iptables -A GODSEYE-EGRESS -s "$p" -d "$g" -j DROP; done; done
for g in $G; do iptables -A GODSEYE-EGRESS -d "$g" -j RETURN; done
for b in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16 \
         192.0.0.0/24 198.18.0.0/15 224.0.0.0/4 240.0.0.0/4; do
  iptables -A GODSEYE-EGRESS -d "$b" -j DROP
done
iptables -A GODSEYE-EGRESS -j RETURN

iptables -N GODSEYE-HOST
iptables -A GODSEYE-HOST -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
iptables -A GODSEYE-HOST -j DROP

iptables -I DOCKER-USER 1 -s "$S" -j GODSEYE-EGRESS
iptables -I INPUT 1 -s "$S" -j GODSEYE-HOST
# and FORWARD's "-j DOCKER-USER" moved to rule 1 (insert first, then delete the old copy)
```

The script is idempotent (re-running rebuilds the two chains and never duplicates a jump),
`ensure` changes nothing unless a chain is missing or altered (then it applies again) or a jump
is out of place (then it moves it), and `remove` takes everything out again. All iptables
calls wait for the xtables lock (`-w 5`), which dockerd and tailscaled also take.
`test/deploy.test.ts` runs it against a fake `iptables` to check exactly this, including a
simulated `tailscaled` restart, that no reorder ever leaves a chain without our jump, an
upgrade from the rules without Pulse's own networks, and what `GODSEYE-EGRESS` decides for
traffic from each Pulse subnet (internet yes; host, LAN, tailnet, godseye subnets and the other
Pulse subnets no).

## Install and persist

`iptables-save`/`netfilter-persistent` would also save Docker's and Tailscale's own chains and
fight them on restore, so use the units instead:

* `godseye-firewall.service` applies the rules after Docker (and Tailscale) start, and
  whenever Docker restarts (`PartOf=docker.service`). Stopping it removes them, which is why
  it is deliberately **not** tied to `tailscaled`.
* `godseye-firewall-check.service` runs `ensure 60` on every `tailscaled` start or restart
  (`WantedBy=`/`PartOf=tailscaled.service`), and `godseye-firewall-check.timer` runs it again
  30 s after each run, for any other reordering. While watching it only lists three chains
  every 2 s. It never removes anything and never brings back rules that stopping
  `godseye-firewall.service` removed (stopping that unit stops this one first).

```sh
cd ~/projects/godseye/godseye-detroit-connector
sudo install -o root -g root -m 0755 deploy/host-firewall/godseye-firewall.sh /usr/local/sbin/
sudo install -o root -g root -m 0644 deploy/host-firewall/godseye-firewall.service \
  deploy/host-firewall/godseye-firewall-check.service \
  deploy/host-firewall/godseye-firewall-check.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now godseye-firewall.service
sudo systemctl enable godseye-firewall-check.service
sudo systemctl enable --now godseye-firewall-check.timer
sudo /usr/local/sbin/godseye-firewall.sh show
```

Install the copies under `/usr/local/sbin` and `/etc/systemd/system` (root-owned) rather than
running the script from the repo, so nobody who can write the repo can change what root runs.

**Updating the script** (for example when subnets are added): install the new copy and apply it
at once. `reload` runs `apply`, which rebuilds both chains and adds any new jumps (each inserted
before an old copy is deleted); without it, the check timer notices the changed rules within
about 30 s and applies them itself.

```sh
cd ~/projects/godseye/godseye-detroit-connector
sudo install -o root -g root -m 0755 deploy/host-firewall/godseye-firewall.sh /usr/local/sbin/ \
  && sudo systemctl reload godseye-firewall.service \
  && sudo /usr/local/sbin/godseye-firewall.sh show
```

After a host reboot or a Docker restart, `systemctl status godseye-firewall` should be
`active (exited)` and `systemctl list-timers godseye-firewall-check.timer` should show the next
run. To check the Tailscale case once:

```sh
sudo systemctl restart tailscaled
sleep 15
sudo iptables -S FORWARD | sed -n 2p                     # -A FORWARD -j DOCKER-USER
journalctl -u godseye-firewall-check -n 5 --no-pager     # "moved ... back to the top of FORWARD"
```

Between a `tailscaled` start and the check catching up there is a window of about two seconds
(the watch interval); a reordering by anything else is caught within about 30 s. A stronger
option is `tailscale up --netfilter-mode=nodivert` (Tailscale then creates its chains but adds
no jumps, and you add `-j ts-forward`/`-j ts-input` yourself after the godseye rules); it
changes how the host's own Tailscale firewalling is wired, so it is not the default here.

## Verify (go-live checklist items)

With the stack up (`docker-compose -p godseye up -d gev gev-mcp tailscale gateway`), run the
probe inside the containers; every line must say `PASS`. Replace `192.168.1.20` with the
host's LAN address and `192.168.1.1` with the router; `100.100.100.100` is Tailscale's
resolver and `<peer-100.x>` any other device on your tailnet.

```sh
# GEV: internet yes; host, LAN, tailnet, the gateway's public listener no.
docker exec godseye-gev node /app/dist/scripts/egress-probe.js \
  --blocked 172.30.79.1:22 172.30.78.1:22 192.168.1.20:22 192.168.1.1:53 \
            100.100.100.100:53 <peer-100.x>:22 172.30.77.20:7700 \
  --open 1.1.1.1:443

# Gateway (and so the tailscale sidecar and, by network, cloudflared's edge subnet). 172.30.80.1
# is the host's address on Pulse's internal bridge.
docker exec godseye-gateway node dist/scripts/egress-probe.js \
  --blocked 172.30.77.1:22 172.30.80.1:22 192.168.1.20:22 192.168.1.1:53 100.100.100.100:53 <peer-100.x>:22 \
  --open 1.1.1.1:443 gev:7701 pulse-api:7710

# Pulse is reachable from the sidecar's namespace only (not from GEV or gev-mcp).
PULSE_IP=$(docker inspect -f '{{(index .NetworkSettings.Networks "godseye_backend").IPAddress}}' pulse-api)
docker exec godseye-gev node /app/dist/scripts/egress-probe.js --blocked "$PULSE_IP:7710" 172.30.80.1:22
docker exec godseye-gev-mcp node /app/dist/scripts/egress-probe.js --blocked "$PULSE_IP:7710"

# gev-mcp: nothing but GEV.
docker exec godseye-gev-mcp node /app/dist/scripts/egress-probe.js \
  --blocked 1.1.1.1:443 172.30.78.1:22 192.168.1.20:22 172.30.77.20:7700 \
  --open gev:7701

# Detroit Pulse (its image has Python, not this probe). "blocked" = dropped or no route;
# "refused" for a blocked target means the packet got through to a closed port.
pprobe() { c=$1; shift; docker exec "$c" python -c '
import socket, sys
for t in sys.argv[1:]:
    want, h, p = t.split(":")
    try: socket.create_connection((h, int(p)), timeout=4).close(); got = "open"
    except (socket.timeout, OSError) as e: got = "refused" if isinstance(e, ConnectionRefusedError) else "blocked"
    print("PASS" if got == want else "FAIL", want, h, p, got)' "$@"; }
# pulse-api (pulse_internal + godseye_backend): the host's address on either bridge, the LAN.
pprobe pulse-api blocked:172.30.81.1:22 blocked:172.30.80.1:22 blocked:192.168.1.20:22
# The workers on pulse_egress: internet yes; host, LAN, router, tailnet, godseye subnets no.
pprobe pulse-transcribe blocked:172.30.82.1:22 blocked:172.30.81.1:22 blocked:192.168.1.20:22 \
  blocked:192.168.1.1:53 blocked:100.100.100.100:53 blocked:<peer-100.x>:22 \
  blocked:172.30.77.20:7700 open:1.1.1.1:443
pprobe pulse-extract blocked:172.30.82.1:22 blocked:192.168.1.20:22 open:api.anthropic.com:443

# No tailnet search domain or LAN resolver inside the containers.
docker exec godseye-gev cat /etc/resolv.conf     # nameserver 127.0.0.11, no "search ...ts.net"
docker exec pulse-api cat /etc/resolv.conf       # the same (Pulse sets dns and dns_search too)
```

Also check the host itself: `sudo iptables -S FORWARD | sed -n 2p` must print
`-A FORWARD -j DOCKER-USER`.
