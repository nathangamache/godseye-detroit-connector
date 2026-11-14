#!/bin/sh
# Installs the self-hosted Overpass files outside the repo (docs/overpass.md), so the running
# container's bind mounts and the weekly timer don't depend on what the checkout has checked
# out. Re-run after pulling a change to deploy/overpass; the next refresh (or
# `overpass-refresh.sh --force`) recreates the container with it.
#
#   deploy/overpass/install.sh [OVERPASS_DATA]
#
# OVERPASS_DATA defaults to ~/projects/godseye/overpass-data (outside every repo). Installs to
# ~/.local/share/godseye-overpass and the systemd --user units; enables nothing.
set -eu
umask 022

src=$(cd "$(dirname "$0")" && pwd)
dest=${OVERPASS_HOME:-$HOME/.local/share/godseye-overpass}
units=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
data=${1:-${OVERPASS_DATA:-}}

install -d -m 0755 "$dest" "$dest/container"
install -m 0644 "$src/docker-compose.yml" "$dest/docker-compose.yml"
install -m 0755 "$src/overpass-refresh.sh" "$dest/overpass-refresh.sh"
# Read by uid 10003 inside the containers.
install -m 0755 "$src/container/init.sh" "$src/container/serve.sh" "$src/container/check.sh" \
  "$dest/container/"
install -m 0644 "$src/container/supervisord.conf" "$src/container/nginx.conf" "$dest/container/"

if [ -n "$data" ] || [ ! -f "$dest/.env" ]; then
  data=${data:-$HOME/projects/godseye/overpass-data}
  case $data in /*) ;; *) echo "install: OVERPASS_DATA must be an absolute path" >&2 && exit 1 ;; esac
  # docker-compose reads this .env (it sits next to the compose file); so does the script.
  printf 'OVERPASS_DATA=%s\n' "$data" >"$dest/.env"
fi

install -d -m 0755 "$units"
install -m 0644 "$src/godseye-overpass-refresh.service" "$src/godseye-overpass-refresh.timer" "$units/"
systemctl --user daemon-reload

echo "installed in $dest ($(cat "$dest/.env"))"
echo "first build:   $dest/overpass-refresh.sh"
echo "weekly:        systemctl --user enable --now godseye-overpass-refresh.timer"
