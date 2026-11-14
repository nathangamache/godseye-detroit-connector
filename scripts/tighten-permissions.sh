#!/usr/bin/env bash
# Tightens file permissions on the godseye deploy path.
#
# Why: anything that can WRITE this repo or the GEV clone can change what later runs with
# your docker rights (a compose file that mounts the docker socket, a serve config, GEV's build
# config), and anything that can read deploy/secrets has the keys. If another local account
# shares your primary group (or your umask is 002), it can do both. This script:
#   * removes group and other WRITE everywhere in the repo and the GEV clone
#   * makes deploy/secrets 700 and its files 600, and the data directories 700
#   * keeps the GEV clone and deploy/tailscale/serve.json READABLE: the containers read them
#     as uids 10001/10002, which are "other" to your files
# Then it lists anything still group/other-writable. Run it after every clone or pull, and
# set `umask 077` in your shell profile (scripts/build-gev.sh restores what GEV needs).
#
#   scripts/tighten-permissions.sh                   # repo + GEV clone next to it
#   GEV_CLONE=/path/to/gods-eye-view scripts/tighten-permissions.sh
set -euo pipefail
umask 077

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="${REPO_DIR:-$(cd "$here/.." && pwd)}"
clone="${GEV_CLONE:-$(cd "$repo/.." && pwd)/gods-eye-view}"

chmod -R go-w "$repo"
chmod go-rwx "$repo/deploy/secrets"
chmod 700 "$repo/deploy/secrets"
find "$repo/deploy/secrets" -type f -exec chmod 600 {} +
for d in "$repo/data" "$repo/data/backups" "$repo/var"; do
  if [ -d "$d" ]; then chmod 700 "$d"; fi
done
# Read by the tailscale container (uid 10002) through a bind mount.
chmod 644 "$repo/deploy/tailscale/serve.json"

if [ -d "$clone" ]; then
  chmod -R u+rwX,go-w,go+rX "$clone"
  # A mode-600 .env inside the clone would be unreadable by the GEV container anyway; keep
  # keys in deploy/secrets/gev.env instead.
  for f in "$clone/.env" "$clone"/.env.*; do
    if [ -f "$f" ] && [ "$(basename "$f")" != ".env.example" ]; then chmod 600 "$f"; fi
  done
fi

echo "Still group/other-writable (should print nothing):"
dirs=("$repo")
if [ -d "$clone" ]; then dirs+=("$clone"); fi
find "${dirs[@]}" \( -perm -g+w -o -perm -o+w \) -not -type l -not -path '*/node_modules/*' \
  -print 2>/dev/null | head -n 50 || true
echo "deploy/secrets: $(stat -c '%a' "$repo/deploy/secrets")"
