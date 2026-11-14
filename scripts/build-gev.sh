#!/usr/bin/env bash
# Builds the God's Eye View clone inside a throwaway, unprivileged container (review DS-5).
#
# `npm ci`, `npm run build` and `npm run build:panel` run upstream code (vite.config.js, build
# scripts, dependency code). Run on the host they would execute as you, with your SSH keys,
# your other projects' .env files and the docker socket (root-equivalent) in reach. Here they
# run in a pinned node:24 container that:
#   * runs as your uid, with no capabilities, no-new-privileges, a read-only root and a tmpfs
#     HOME, so files it writes in the clone are yours but it holds no privilege
#   * sees ONLY the GEV clone (mounted read-write); no home directory, no docker socket
#   * gets ONLY CESIUM_ION_TOKEN (the one build-time browser key), never the rest of gev.env
#   * installs with --ignore-scripts (no dependency install scripts; esbuild works from its
#     platform package)
#   * uses its own network, godseye-build (172.30.76.0/24), which the host firewall rules in
#     docs/host-firewall.md keep off the LAN and the tailnet; it still needs the npm registry
#
# Usage (from anywhere):
#   scripts/build-gev.sh                         # GEV clone next to this repo
#   GEV_CLONE=/path/to/gods-eye-view scripts/build-gev.sh
# CESIUM_ION_TOKEN comes from the environment, or else from deploy/secrets/gev.env (only that
# one line is read). Afterwards `git -C <clone> status --short` should print nothing.
set -euo pipefail
umask 077

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"
clone="${GEV_CLONE:-$(cd "$repo/.." && pwd)/gods-eye-view}"
image="${NODE_IMAGE:-node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54}"
network="${BUILD_NETWORK:-godseye-build}"
subnet="${BUILD_SUBNET:-172.30.76.0/24}"

die() {
  echo "build-gev: $*" >&2
  exit 1
}
[ -f "$clone/package.json" ] && [ -f "$clone/package-lock.json" ] ||
  die "no GEV clone at $clone (set GEV_CLONE)"
command -v docker >/dev/null || die "docker is not installed"

token="${CESIUM_ION_TOKEN:-}"
if [ -z "$token" ] && [ -f "$repo/deploy/secrets/gev.env" ]; then
  token="$(sed -n 's/^CESIUM_ION_TOKEN=//p' "$repo/deploy/secrets/gev.env" | tail -n 1)"
  token="${token%\"}"
  token="${token#\"}"
fi
[ -n "$token" ] || echo "build-gev: note: no CESIUM_ION_TOKEN; the globe builds without Cesium ion imagery" >&2

if ! docker network inspect "$network" >/dev/null 2>&1; then
  docker network create --driver bridge --subnet "$subnet" "$network" >/dev/null
fi

cpuset=()
[ -n "${BUILD_CPUSET:-}" ] && cpuset=(--cpuset-cpus "$BUILD_CPUSET")

echo "build-gev: building $clone in $image (uid $(id -u), network $network)" >&2
# The token is passed by name (-e CESIUM_ION_TOKEN) so it never appears in a process list.
CESIUM_ION_TOKEN="$token" nice -n 19 docker run --rm \
  --name "godseye-gev-build-$$" \
  --user "$(id -u):$(id -g)" \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --read-only \
  --tmpfs /tmp:rw,exec,size=2g,mode=1777 \
  --memory 3g --memory-swap 3g \
  --cpus "${BUILD_CPUS:-4}" "${cpuset[@]}" \
  --pids-limit 1024 \
  --network "$network" \
  --dns "${BUILD_DNS:-1.1.1.1}" --dns-search . \
  -e HOME=/tmp \
  -e CESIUM_ION_TOKEN \
  -e npm_config_cache=/tmp/.npm \
  -e npm_config_ignore_scripts=true \
  -e npm_config_update_notifier=false \
  -e npm_config_fund=false \
  -e npm_config_audit=false \
  -e PUPPETEER_SKIP_DOWNLOAD=1 \
  -e UV_THREADPOOL_SIZE=4 \
  -v "$clone:/gev" \
  -w /gev \
  "$image" \
  sh -ec 'npm ci --ignore-scripts && npm run build && npm run build:panel'

# The GEV containers (uid 10001) read the clone: keep it readable, writable only by you.
chmod -R u+rwX,go-w,go+rX "$clone/dist" "$clone/node_modules"
echo "build-gev: done. Check: git -C $clone status --short" >&2
