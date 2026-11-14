#!/bin/sh
# godseye container egress rules (IPv4 iptables). Run as root; idempotent.
#
#   godseye-firewall.sh apply    install or refresh the rules
#   godseye-firewall.sh remove   take them out again
#   godseye-firewall.sh show     print what is installed
#
# Containers on the godseye compose networks may reach the public internet (GEV's data
# providers, the npm registry for builds, Tailscale's and Cloudflare's servers) and each
# other, and nothing else:
#   * FORWARD (via DOCKER-USER): no RFC 1918, no CGNAT 100.64.0.0/10 (the tailnet, including
#     100.100.100.100), no link-local, multicast or reserved space.
#   * INPUT: no new connection to the host itself on ANY of its addresses (bridge gateways,
#     LAN, tailnet, docker0), which DOCKER-USER cannot see.
# DNS needs no exception: the compose file points the containers' DNS at public resolvers.
# See docs/host-firewall.md for persistence and verification.
set -eu

# edge, backend, gev-egress and build networks (deploy/docker-compose.yml, scripts/build-gev.sh)
SUBNETS="${GODSEYE_SUBNETS:-172.30.77.0/24 172.30.78.0/24 172.30.79.0/24 172.30.76.0/24}"
BLOCK="10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16 192.0.0.0/24 198.18.0.0/15 224.0.0.0/4 240.0.0.0/4"
IPT="${IPTABLES:-iptables}"

chain() { $IPT -N "$1" 2>/dev/null || $IPT -F "$1"; }

remove() {
  for s in $SUBNETS; do
    while $IPT -C DOCKER-USER -s "$s" -j GODSEYE-EGRESS 2>/dev/null; do $IPT -D DOCKER-USER -s "$s" -j GODSEYE-EGRESS; done
    while $IPT -C INPUT -s "$s" -j GODSEYE-HOST 2>/dev/null; do $IPT -D INPUT -s "$s" -j GODSEYE-HOST; done
  done
  for c in GODSEYE-EGRESS GODSEYE-HOST; do
    $IPT -F "$c" 2>/dev/null || true
    $IPT -X "$c" 2>/dev/null || true
  done
}

apply() {
  if ! $IPT -L DOCKER-USER -n >/dev/null 2>&1; then
    echo "godseye-firewall: no DOCKER-USER chain; start docker first" >&2
    exit 1
  fi
  # Container -> elsewhere (routed): allow replies, the godseye networks, the internet.
  chain GODSEYE-EGRESS
  $IPT -A GODSEYE-EGRESS -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  for s in $SUBNETS; do $IPT -A GODSEYE-EGRESS -d "$s" -j RETURN; done
  for b in $BLOCK; do $IPT -A GODSEYE-EGRESS -d "$b" -j DROP; done
  $IPT -A GODSEYE-EGRESS -j RETURN
  # Container -> the host itself: replies only.
  chain GODSEYE-HOST
  $IPT -A GODSEYE-HOST -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  $IPT -A GODSEYE-HOST -j DROP
  for s in $SUBNETS; do
    $IPT -C DOCKER-USER -s "$s" -j GODSEYE-EGRESS 2>/dev/null || $IPT -I DOCKER-USER 1 -s "$s" -j GODSEYE-EGRESS
    $IPT -C INPUT -s "$s" -j GODSEYE-HOST 2>/dev/null || $IPT -I INPUT 1 -s "$s" -j GODSEYE-HOST
  done
  # Tailscale's ts-forward chain ACCEPTs everything routed out of tailscale0. If tailscaled
  # inserted its jump above Docker's, container traffic to the tailnet would never reach
  # DOCKER-USER: put DOCKER-USER first again (dockerd does the same when it starts).
  first="$($IPT -S FORWARD | sed -n '2p')"
  if [ "$first" != "-A FORWARD -j DOCKER-USER" ]; then
    while $IPT -C FORWARD -j DOCKER-USER 2>/dev/null; do $IPT -D FORWARD -j DOCKER-USER; done
    $IPT -I FORWARD 1 -j DOCKER-USER
  fi
}

show() {
  $IPT -S FORWARD | sed -n '1,4p'
  $IPT -S DOCKER-USER
  $IPT -S GODSEYE-EGRESS 2>/dev/null || echo "(no GODSEYE-EGRESS chain)"
  $IPT -S INPUT | grep -E 'GODSEYE|^-P' || true
  $IPT -S GODSEYE-HOST 2>/dev/null || echo "(no GODSEYE-HOST chain)"
}

case "${1:-}" in
  apply) apply ;;
  remove) remove ;;
  show) show ;;
  *) echo "usage: $0 apply | remove | show" >&2; exit 2 ;;
esac
