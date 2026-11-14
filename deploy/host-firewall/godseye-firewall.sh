#!/bin/sh
# godseye container egress rules (IPv4 iptables). Run as root; idempotent.
#
#   godseye-firewall.sh apply           install or refresh the rules
#   godseye-firewall.sh ensure [SECS]   check them, fixing only what is wrong: rebuild missing or
#                                       altered chains, put our jumps back on top; with SECS,
#                                       keep checking every 2 s for that long
#   godseye-firewall.sh remove          take them out again
#   godseye-firewall.sh show            print what is installed
#
# Containers on the godseye compose networks may reach the public internet (GEV's data
# providers, the npm registry for builds, Tailscale's and Cloudflare's servers) and each
# other, and nothing else:
#   * FORWARD (via DOCKER-USER): no RFC 1918, no CGNAT 100.64.0.0/10 (the tailnet, including
#     100.100.100.100), no link-local, multicast or reserved space.
#   * INPUT: no new connection to the host itself on ANY of its addresses (bridge gateways,
#     LAN, tailnet, docker0), which DOCKER-USER cannot see.
# Detroit Pulse's networks (PULSE_SUBNETS: godseye_backend and Pulse's own pulse_internal,
# pulse_egress and pulse_debug) get the same INPUT drop and the same egress drop list; each
# subnet's members may reach each other, no other network gets a route into them, they get none
# into the godseye subnets, and of the rest only the public internet is left (which only
# pulse_egress and pulse_debug can route to).
# DNS needs no exception: the compose file points the containers' DNS at public resolvers.
#
# Order matters. tailscaled inserts `-j ts-forward` at the top of FORWARD (it ACCEPTs
# everything routed out of tailscale0) and `-j ts-input` at the top of INPUT whenever it
# starts, so after a tailscaled restart container traffic to the tailnet would skip
# DOCKER-USER. `ensure` (run by godseye-firewall-check.service on every tailscaled start and
# by its timer) moves our jumps back to the top. Every move inserts the rule before deleting
# its old copy, so there is never a moment without it.
# See docs/host-firewall.md for persistence and verification.
set -eu

# edge, backend, gev-egress and build networks (deploy/docker-compose.yml, scripts/build-gev.sh)
SUBNETS="${GODSEYE_SUBNETS:-172.30.77.0/24 172.30.78.0/24 172.30.79.0/24 172.30.76.0/24}"
# Detroit Pulse (detroit-pulse/deploy, subnets pinned there):
#   172.30.80.0/24  godseye_backend (internal): pulse-api and the tailscale sidecar, whose
#                   namespace the gateway shares
#   172.30.81.0/24  pulse_internal (internal): postgis, redis, api, the workers
#   172.30.82.0/24  pulse_egress: pulse-transcribe, pulse-extract (Anthropic, geocoders, Whisper)
#   172.30.83.0/24  pulse_debug: the opt-in pulse-debug forwarder (127.0.0.1 ports)
# Members of each may reach each other; no host (even an internal bridge holds a host address),
# no LAN or tailnet, no route between them and the godseye subnets above in either direction.
PULSE_SUBNETS="${GODSEYE_PULSE_SUBNETS:-172.30.80.0/24 172.30.81.0/24 172.30.82.0/24 172.30.83.0/24}"
BLOCK="10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16 192.0.0.0/24 198.18.0.0/15 224.0.0.0/4 240.0.0.0/4"
# -w: wait for the xtables lock (dockerd and tailscaled take it too) instead of failing.
IPT="${IPTABLES:-iptables -w 5}"

# The rules of each chain, one per line.
egress_rules() {
  echo "-m conntrack --ctstate ESTABLISHED,RELATED -j RETURN"
  # Pulse: its own members, and never the godseye subnets (whose RETURNs below are for them).
  for s in $PULSE_SUBNETS; do echo "-s $s -d $s -j RETURN"; done
  for s in $PULSE_SUBNETS; do for g in $SUBNETS; do echo "-s $s -d $g -j DROP"; done; done
  for s in $SUBNETS; do echo "-d $s -j RETURN"; done
  for b in $BLOCK; do echo "-d $b -j DROP"; done
  echo "-j RETURN"
}
host_rules() {
  echo "-m conntrack --ctstate ESTABLISHED,RELATED -j RETURN"
  echo "-j DROP"
}
# Our jumps into chain $1, one per subnet.
jumps() { for s in $SUBNETS $PULSE_SUBNETS; do echo "-s $s -j $1"; done; }

# (Re)creates chain $1 holding exactly the rules printed by $2.
fill() {
  $IPT -N "$1" 2>/dev/null || $IPT -F "$1"
  $2 | while read -r r; do
    # shellcheck disable=SC2086 # a rule is several words
    $IPT -A "$1" $r
  done
}

# Does chain $1 hold exactly the rules printed by $2 (matched by iptables itself)?
holds() {
  $IPT -S "$1" >/dev/null 2>&1 || return 1
  [ "$($2 | wc -l)" -eq "$(($($IPT -S "$1" | wc -l) - 1))" ] || return 1
  $2 | while read -r r; do
    # shellcheck disable=SC2086
    $IPT -C "$1" $r 2>/dev/null || exit 1
  done
}

# Are the rules in $2 (one per line) the first rules of chain $1, in that order?
leads() {
  n=$(printf '%s\n' "$2" | wc -l)
  [ "$($IPT -S "$1" 2>/dev/null | sed 1d | head -n "$n" | sed "s/^-A $1 //")" = "$2" ]
}

# Makes the rules in $2 (one per line) the first rules of chain $1, in that order, unless
# they already are. Each is inserted before its old copies are deleted.
lead() {
  c=$1
  want=$2
  leads "$c" "$want" && return 0
  # Last rule first, each inserted at position 1, gives the wanted order.
  printf '%s\n' "$want" | sed '1!G;h;$!d' | while read -r r; do
    # shellcheck disable=SC2086
    $IPT -I "$c" 1 $r
    # Older copies, highest rule number first (line k+1 of `iptables -S` is rule k).
    for k in $($IPT -S "$c" | sed 1d | grep -nxF -- "-A $c $r" | cut -d: -f1 | sed 1d | sort -rn); do
      $IPT -D "$c" "$k"
    done
  done
  echo "godseye-firewall: moved the godseye rules back to the top of $c" >&2
}

order() {
  lead DOCKER-USER "$(jumps GODSEYE-EGRESS)"
  lead INPUT "$(jumps GODSEYE-HOST)"
  # tailscaled's ts-forward ACCEPTs everything routed out of tailscale0: DOCKER-USER first
  # (dockerd does the same when it starts).
  lead FORWARD "-j DOCKER-USER"
}

have_docker() { $IPT -L DOCKER-USER -n >/dev/null 2>&1; }
# Applied at all? (`remove`, e.g. stopping godseye-firewall.service, deletes both chains.)
installed() { $IPT -S GODSEYE-EGRESS >/dev/null 2>&1 || $IPT -S GODSEYE-HOST >/dev/null 2>&1; }

# Cheap check (three listings, no changes): nothing to fix, or nothing we should touch?
in_order() {
  ! have_docker || ! installed ||
    { leads FORWARD "-j DOCKER-USER" && leads DOCKER-USER "$(jumps GODSEYE-EGRESS)" &&
      leads INPUT "$(jumps GODSEYE-HOST)"; }
}

remove() {
  for s in $SUBNETS $PULSE_SUBNETS; do
    while $IPT -C DOCKER-USER -s "$s" -j GODSEYE-EGRESS 2>/dev/null; do $IPT -D DOCKER-USER -s "$s" -j GODSEYE-EGRESS; done
    while $IPT -C INPUT -s "$s" -j GODSEYE-HOST 2>/dev/null; do $IPT -D INPUT -s "$s" -j GODSEYE-HOST; done
  done
  for c in GODSEYE-EGRESS GODSEYE-HOST; do
    $IPT -F "$c" 2>/dev/null || true
    $IPT -X "$c" 2>/dev/null || true
  done
}

apply() {
  if ! have_docker; then
    echo "godseye-firewall: no DOCKER-USER chain; start docker first" >&2
    exit 1
  fi
  # Container -> elsewhere (routed): allow replies, the godseye networks, the internet.
  fill GODSEYE-EGRESS egress_rules
  # Container -> the host itself: replies only.
  fill GODSEYE-HOST host_rules
  order
}

# Are all our jumps into $2 present in chain $1 (anywhere)?
jumps_in() {
  jumps "$2" | while read -r r; do
    # shellcheck disable=SC2086
    $IPT -C "$1" $r 2>/dev/null || exit 1
  done
}

ensure_once() {
  if ! have_docker; then
    echo "godseye-firewall: Docker is not running (no DOCKER-USER chain); nothing to check" >&2
    return 0
  fi
  if ! installed; then
    # Removed on purpose (godseye-firewall.service stopped): not ours to bring back.
    echo "godseye-firewall: rules not applied (godseye-firewall.service stopped?); nothing to check" >&2
    return 0
  fi
  if ! holds GODSEYE-EGRESS egress_rules || ! holds GODSEYE-HOST host_rules ||
    ! jumps_in DOCKER-USER GODSEYE-EGRESS || ! jumps_in INPUT GODSEYE-HOST; then
    echo "godseye-firewall: rules missing or changed; applying them again" >&2
    apply
    return 0
  fi
  order
}

# One full check; with SECS, then a cheap order check every 2 s for that long, and the full
# check again whenever something is out of place.
ensure() {
  secs="${1:-0}"
  case "$secs" in *[!0-9]* | '') echo "godseye-firewall: ensure takes whole seconds" >&2; exit 2 ;; esac
  end=$(($(date +%s) + secs))
  ensure_once
  while [ "$(date +%s)" -lt "$end" ]; do
    sleep 2
    in_order || ensure_once
  done
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
  ensure) ensure "${2:-0}" ;;
  remove) remove ;;
  show) show ;;
  *) echo "usage: $0 apply | ensure [SECONDS] | remove | show" >&2; exit 2 ;;
esac
