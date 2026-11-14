#!/bin/bash
# Builds an Overpass database in /db from the OpenStreetMap extract mounted at
# /import/extract.osm.pbf. Runs in the overpass-init container: no network, uid 10003, no
# capabilities, read-only root. Replaces the image's own init (which downloads, needs root and
# hands the files to the image's built-in user) with the same steps, offline: osmium streams
# the PBF as OSM XML straight into update_database (no bz2 round trip), then the area rules
# build the areas.
main() {
  set -euo pipefail
  umask 022
  local pbf=/import/extract.osm.pbf db=/db t0 t1 t2 version
  local flush=${OVERPASS_FLUSH_SIZE:-16} compression=${OVERPASS_COMPRESSION:-gz}

  if [[ ! -f $pbf || ! -s $pbf ]]; then
    echo "init: no extract at $pbf (the refresh script mounts it)" >&2
    return 1
  fi
  if [[ -n "$(ls -A "$db")" ]]; then
    echo "init: $db is not empty; refusing to build over an existing database" >&2
    return 1
  fi

  t0=$(date +%s)
  # The extract's replication timestamp (Geofabrik sets it in the PBF header); the newest
  # object timestamp otherwise.
  version=$(osmium fileinfo -g header.option.osmosis_replication_timestamp "$pbf" 2>/dev/null || true)
  if [[ ! $version =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T ]]; then
    version=$(osmium fileinfo -e -g data.timestamp.last "$pbf")
  fi
  echo "init: extract data as of $version"

  mkdir "$db/db"
  osmium cat --no-progress -f osm -o - "$pbf" |
    /app/bin/update_database --db-dir="$db/db/" --version="$version" \
      --compression-method="$compression" --map-compression-method="$compression" \
      --flush-size="$flush"
  t1=$(date +%s)
  echo "init: database built in $((t1 - t0)) s"

  cp -r /app/etc/rules "$db/db/"
  /app/bin/osm3s_query --progress --rules --db-dir="$db/db" <"$db/db/rules/areas.osm3s"
  t2=$(date +%s)
  echo "init: areas built in $((t2 - t1)) s"

  touch "$db/init_done"
  echo "init: done in $((t2 - t0)) s"
}

# One line, so bash has read the whole script before the long build starts.
main "$@"; exit
