#!/usr/bin/env bash
# Builds the God's Eye View clone inside a throwaway, unprivileged container (review DS-5).
#
# `npm ci`, `npm run build` and `npm run build:panel` run upstream code (vite.config.js, build
# scripts, dependency code). Run on the host they would execute as you, with your SSH keys,
# your other projects' .env files and the docker socket (root-equivalent) in reach. Here they
# run in a pinned node:24 container that:
#   * runs as your uid, with no capabilities, no-new-privileges, a read-only root and a tmpfs
#     HOME, so files it writes are yours but it holds no privilege
#   * sees ONLY a throwaway COPY of the clone's working tree: no .git (so it can't plant a
#     core.fsmonitor, hook or filter that your next `git status` would run on the host), no
#     .env files or logs, no home directory, no docker socket
#   * gets ONLY CESIUM_ION_TOKEN (the one build-time browser key), never the rest of gev.env
#   * installs with --ignore-scripts (no dependency install scripts; esbuild works from its
#     platform package)
#   * uses its own network, godseye-build (172.30.76.0/24), which the host firewall rules in
#     docs/host-firewall.md keep off the LAN and the tailnet; it still needs the npm registry
# Afterwards only dist/ and node_modules/ come back into the clone, and only if they are real
# directories (a symlink planted in their place is refused, never followed). Their modes are
# normalised without following any link: readable by the GEV containers (uid 10001), writable
# only by you, no setuid/setgid bits.
#
# Usage (from anywhere):
#   scripts/build-gev.sh                         # GEV clone next to this repo
#   GEV_CLONE=/path/to/gods-eye-view scripts/build-gev.sh
# CESIUM_ION_TOKEN comes from the environment, or else from deploy/secrets/gev.env (only that
# one line is read). The script ends by printing a hardened `git status` for the clone, which
# should print nothing.
set -euo pipefail
umask 077

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"
clone="${GEV_CLONE:-$(cd "$repo/.." && pwd)/gods-eye-view}"
image="${NODE_IMAGE:-node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54}"
network="${BUILD_NETWORK:-godseye-build}"
subnet="${BUILD_SUBNET:-172.30.76.0/24}"
# The build's products. Nothing else the build writes ever reaches the clone.
outputs=(dist node_modules)

die() {
  echo "build-gev: $*" >&2
  exit 1
}
[ -d "$clone" ] && [ ! -L "$clone" ] || die "no GEV clone at $clone (set GEV_CLONE)"
clone="$(cd "$clone" && pwd -P)"
[ -f "$clone/package.json" ] && [ -f "$clone/package-lock.json" ] ||
  die "no GEV clone at $clone (set GEV_CLONE)"
command -v docker >/dev/null || die "docker is not installed"

# Every git command this script suggests: repo-local fsmonitor, hooks and pager are ignored.
safe_git=(git -c core.fsmonitor= -c core.hooksPath=/dev/null --no-pager)

# Builds made before this script stopped mounting the clone could write to its .git. Point
# out settings there that make a host-side git command run a program.
check_git_dir() {
  local g="$clone/.git" found=() keys hooks
  [ -d "$g" ] && [ ! -L "$g" ] || return 0
  if [ -f "$g/config" ] && [ ! -L "$g/config" ]; then
    # Key names only (never values: a remote URL can hold a token).
    keys="$(grep -oiE '^[[:space:]]*(fsmonitor|hookspath|pager|editor|sshcommand|askpass|worktree|textconv|clean|smudge|process|command|driver|external|path)[[:space:]]*=' "$g/config" |
      tr -d ' \t=' | sort -u | tr '\n' ' ' || true)"
    [ -z "$keys" ] || found+=("config sets: ${keys% }")
    if grep -qiE '^[[:space:]]*\[(filter|diff|merge|include|includeif|pager|alias)\b' "$g/config"; then
      found+=("config has filter/diff/merge/include/pager/alias sections")
    fi
  fi
  if [ -d "$g/hooks" ] && [ ! -L "$g/hooks" ]; then
    hooks="$(find -P "$g/hooks" -mindepth 1 -maxdepth 1 ! -name '*.sample' -printf '%f ' 2>/dev/null || true)"
    [ -z "$hooks" ] || found+=("hooks: ${hooks% }")
  fi
  [ ! -e "$g/info/attributes" ] || found+=("info/attributes exists")
  if [ "${#found[@]}" -gt 0 ]; then
    echo "build-gev: WARNING: $clone/.git may have been changed by an earlier, unconfined build:" >&2
    printf 'build-gev:   %s\n' "${found[@]}" >&2
    echo "build-gev:   inspect it (or re-clone GEV) before running any other git command there." >&2
  fi
}
check_git_dir

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

# The copy lives beside the clone (same filesystem, so the outputs move back with a rename).
staging="$(mktemp -d "$(dirname "$clone")/.gev-build.XXXXXX")"
# Removes a tree without following links; a build can leave directories without write bits.
remove_tree() {
  if [ -L "$1" ]; then
    rm -f -- "$1"
  elif [ -d "$1" ]; then
    find -P "$1" -type d ! -perm -u=rwx -exec chmod u+rwx {} + 2>/dev/null || true
    rm -rf -- "$1"
  elif [ -e "$1" ]; then
    rm -f -- "$1"
  fi
}
trap 'remove_tree "$staging"' EXIT

# The working tree without .git, previous outputs, caches, logs or .env files (Vite's loadEnv
# would read every .env* there; the build gets CESIUM_ION_TOKEN and nothing else). tar stores
# symlinks as links and never follows them.
tar -C "$clone" \
  --exclude=./.git --exclude=./dist --exclude=./node_modules \
  --exclude=./.gev-cache --exclude=./.gev-logs --exclude=./.cache \
  --exclude=./.claude --exclude=./.playwright-mcp --exclude=./qa-artifacts \
  --exclude=./pinokio/ENVIRONMENT \
  --exclude=.env --exclude='.env.*' --exclude='*.log' \
  -cf - . | tar -C "$staging" -xf -

cpuset=()
[ -n "${BUILD_CPUSET:-}" ] && cpuset=(--cpuset-cpus "$BUILD_CPUSET")

echo "build-gev: building a copy of $clone in $image (uid $(id -u), network $network)" >&2
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
  -v "$staging:/gev" \
  -w /gev \
  "$image" \
  sh -ec 'npm ci --ignore-scripts && npm run build && npm run build:panel'

# The container has exited (nothing writes to the copy any more). Accept only real directories.
for d in "${outputs[@]}"; do
  if [ -L "$staging/$d" ] || [ ! -d "$staging/$d" ]; then
    die "refusing the build: $d is not a real directory (a symlink or missing); the clone is unchanged"
  fi
done
# Readable by the GEV containers (uid 10001 is "other"), writable only by you, no set-id bits.
# find -P never follows a link and chmod gets only directories and regular files, so nothing
# outside the copy can be reached.
find -P "${outputs[@]/#/$staging/}" \( -type d -o -type f \) \
  -exec chmod u+rwX,go-w,go+rX,ug-s {} +
for d in "${outputs[@]}"; do
  remove_tree "$clone/$d"
  mv -T -- "$staging/$d" "$clone/$d"
done

printf -v check '%q ' "${safe_git[@]}" -C "$clone" status --short
echo "build-gev: done. Check: ${check% }" >&2
