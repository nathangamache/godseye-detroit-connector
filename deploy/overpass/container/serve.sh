#!/bin/bash
# Serves the database in /db: the osm-base and areas dispatchers, fcgiwrap and nginx on port 80,
# under supervisord, all as the container's uid (10003). Nothing here updates the database or
# reaches the network: a new extract arrives as a new database (overpass-refresh.sh).
set -euo pipefail
umask 022

if [[ ! -f /db/init_done || ! -d /db/db ]]; then
  echo "serve: /db holds no initialised database (run overpass-refresh.sh first)" >&2
  exit 1
fi
# Leftovers from an unclean stop keep a dispatcher from starting.
rm -f /dev/shm/osm3s*
mkdir -p /tmp/nginx
exec /usr/bin/supervisord -c /overpass/supervisord.conf
