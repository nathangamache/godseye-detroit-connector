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

The compose networks have pinned subnets (`deploy/docker-compose.yml`):

| Network | Subnet | Members | Egress |
|---|---|---|---|
| `godseye-edge` | `172.30.77.0/24` | cloudflared `.10`, tailscale + gateway `.20` | internet (tunnel, Tailscale coordination/DERP, CIMD fetch) |
| `godseye-backend` | `172.30.78.0/24` | tailscale + gateway `.20`, gev `.11`, gev-mcp `.12` | none (`internal: true`) |
| `godseye-gev-egress` | `172.30.79.0/24` | gev `.11` | internet (GEV's data providers) |
| `godseye-build` | `172.30.76.0/24` | `scripts/build-gev.sh` | internet (npm registry) |

For traffic **from** any of those subnets, `deploy/host-firewall/godseye-firewall.sh`:

1. `DOCKER-USER` (routed traffic, evaluated before Docker's own rules) jumps to
   `GODSEYE-EGRESS`, which
   * returns replies (`ESTABLISHED,RELATED`) and traffic to the godseye subnets themselves
     (Docker's network isolation still applies between them);
   * **drops** `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` (RFC 1918: the LAN and other
     docker networks), `100.64.0.0/10` (CGNAT: the tailnet, including `100.100.100.100`),
     `169.254.0.0/16`, `192.0.0.0/24`, `198.18.0.0/15`, `224.0.0.0/4`, `240.0.0.0/4`;
   * returns everything else (the public internet).
2. `INPUT` (traffic to the host itself, which `DOCKER-USER` never sees) jumps to
   `GODSEYE-HOST`, which returns replies and **drops everything else**: no new connection
   from a container to any host address, on any port.
3. Puts the `FORWARD -j DOCKER-USER` jump back at the top if `tailscaled` inserted its own
   `ts-forward` jump above it. `ts-forward` accepts everything routed out of `tailscale0`, so
   with the wrong order container traffic to the tailnet would never reach `DOCKER-USER`.

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

`godseye-firewall.sh apply` is equivalent to (for each `$S` in the four subnets):

```sh
iptables -N GODSEYE-EGRESS
iptables -A GODSEYE-EGRESS -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
iptables -A GODSEYE-EGRESS -d 172.30.77.0/24 -j RETURN
iptables -A GODSEYE-EGRESS -d 172.30.78.0/24 -j RETURN
iptables -A GODSEYE-EGRESS -d 172.30.79.0/24 -j RETURN
iptables -A GODSEYE-EGRESS -d 172.30.76.0/24 -j RETURN
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
```

The script is idempotent (re-running flushes and rebuilds the two chains and never
duplicates a jump) and `remove` takes everything out again. `test/deploy.test.ts` runs it
against a fake `iptables` to check exactly this.

## Install and persist

`iptables-save`/`netfilter-persistent` would also save Docker's and Tailscale's own chains and
fight them on restore, so use the unit instead: it re-applies the rules after Docker (and
Tailscale) start, and whenever Docker restarts.

```sh
cd ~/projects/godseye/godseye-detroit-connector
sudo install -o root -g root -m 0755 deploy/host-firewall/godseye-firewall.sh /usr/local/sbin/
sudo install -o root -g root -m 0644 deploy/host-firewall/godseye-firewall.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now godseye-firewall.service
sudo /usr/local/sbin/godseye-firewall.sh show
```

Install the copies under `/usr/local/sbin` and `/etc/systemd/system` (root-owned) rather than
running the script from the repo, so nobody who can write the repo can change what root runs.

After a host reboot or a Docker restart, `systemctl status godseye-firewall` should be
`active (exited)`. If you restart `tailscaled` alone, run
`sudo systemctl reload godseye-firewall` so `DOCKER-USER` is first in `FORWARD` again (step 3
above), then re-run the probes below.

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

# Gateway (and so the tailscale sidecar and, by network, cloudflared's edge subnet).
docker exec godseye-gateway node dist/scripts/egress-probe.js \
  --blocked 172.30.77.1:22 192.168.1.20:22 192.168.1.1:53 100.100.100.100:53 <peer-100.x>:22 \
  --open 1.1.1.1:443 gev:7701

# gev-mcp: nothing but GEV.
docker exec godseye-gev-mcp node /app/dist/scripts/egress-probe.js \
  --blocked 1.1.1.1:443 172.30.78.1:22 192.168.1.20:22 172.30.77.20:7700 \
  --open gev:7701

# No tailnet search domain or LAN resolver inside the containers.
docker exec godseye-gev cat /etc/resolv.conf     # nameserver 127.0.0.11, no "search ...ts.net"
```

Also check the host itself: `sudo iptables -S FORWARD | sed -n 2p` must print
`-A FORWARD -j DOCKER-USER`.
