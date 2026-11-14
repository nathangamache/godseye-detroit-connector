#!/bin/bash
# Refreshes the self-hosted Overpass API (docs/overpass.md) from a fresh OpenStreetMap extract.
#
#   overpass-refresh.sh [refresh] [--force]
#       Downloads the extract on the host and checks its md5, builds a NEW database from it in
#       an offline container, queries that database on its own (still offline), swaps it in,
#       queries the live container, and only then deletes the old database. Any failure leaves
#       the old database live (or puts it back). Does nothing when the live database already
#       holds this extract, unless --force.
#   overpass-refresh.sh status
#       What is live, the databases and extracts on disk, and the container's health.
#
# Runs on the host as the user that owns OVERPASS_DATA (docker, curl, md5sum and flock needed);
# the weekly godseye-overpass-refresh.timer runs it. It acts only on the godseye-overpass
# compose project. Settings (environment, or the .env next to this script):
#   OVERPASS_DATA         data directory, outside any repo (made mode 700)
#   OVERPASS_EXTRACT_URL  default: Geofabrik's Michigan extract
#   OVERPASS_COMPOSE      default: docker-compose (or "docker compose")
set -euo pipefail
umask 022

here=$(cd "$(dirname "$0")" && pwd)
dotenv() { [[ -f $here/.env ]] && sed -n "s/^$1=//p" "$here/.env" | tail -n 1; }

OVERPASS_DATA=${OVERPASS_DATA:-$(dotenv OVERPASS_DATA || true)}
EXTRACT_URL=${OVERPASS_EXTRACT_URL:-$(dotenv OVERPASS_EXTRACT_URL || true)}
EXTRACT_URL=${EXTRACT_URL:-https://download.geofabrik.de/north-america/us/michigan-latest.osm.pbf}
COMPOSE=${OVERPASS_COMPOSE:-docker-compose}
DOCKER=${DOCKER:-docker}
CURL=${CURL:-curl}
PROJECT=godseye-overpass
LIVE=godseye-overpass
CHECK=godseye-overpass-check
# Generic and self-describing: no person, host or contact in it.
UA='godseye-overpass-refresh/1.0 (self-hosted Overpass API; weekly OpenStreetMap extract download)'

log() { echo "overpass-refresh: $*"; }
die() {
  echo "overpass-refresh: FAILED: $*" >&2
  exit 1
}
# shellcheck disable=SC2086 # OVERPASS_COMPOSE may be two words ("docker compose").
compose() { $COMPOSE -p "$PROJECT" -f "$here/docker-compose.yml" "$@"; }

[[ $OVERPASS_DATA == /* ]] || die "set OVERPASS_DATA to an absolute path (install.sh writes it to $here/.env)"
[[ $EXTRACT_URL == https://* ]] || die "OVERPASS_EXTRACT_URL must be https"
export OVERPASS_DATA
mkdir -p "$OVERPASS_DATA/pbf"
if git -C "$OVERPASS_DATA" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  die "$OVERPASS_DATA is inside a git work tree; keep the data outside any repo"
fi
# Nobody else on the host gets in. pbf/ and the database directories are opened up below that
# for the container's uid (10003), which reaches them only through its bind mounts.
chmod 700 "$OVERPASS_DATA"
chmod 755 "$OVERPASS_DATA/pbf"

current_db() {
  local t
  t=$(readlink "$OVERPASS_DATA/current" 2>/dev/null) || return 0
  [[ $t =~ ^db-[0-9TZ]+$ ]] && echo "$t"
  return 0
}
source_field() { [[ -f $OVERPASS_DATA/$1/SOURCE ]] && sed -n "s/^$2=//p" "$OVERPASS_DATA/$1/SOURCE"; }

# Empties and removes a database directory. Its contents belong to uid 10003, so a throwaway
# container (no network, no capabilities) deletes them; the empty directory is the user's.
clean_db() {
  local d=$1 path=$OVERPASS_DATA/$1
  [[ $d =~ ^db-[0-9TZ]+$ && -d $path && ! -L $path ]] || return 0
  if [[ $d == "$(current_db)" ]]; then
    log "not removing $d: it is live"
    return 0
  fi
  OVERPASS_CLEAN_DB=$path compose run --rm overpass-clean >/dev/null 2>&1 ||
    log "warning: could not empty $d"
  rmdir "$path" 2>/dev/null || log "warning: could not remove $d"
}

# Runs the health queries (container/check.sh) in a running container.
check_in() { $DOCKER exec "$1" /overpass/check.sh; }

# (Re)creates the live container on whatever `current` points to. docker-compose 1.29 can't
# recreate a container on Docker 29 (KeyError: 'ContainerConfig', after it has already stopped
# and renamed the old one), so every container of the service, renamed leftovers included, is
# removed first and the new one created from scratch.
start_live() {
  $DOCKER ps -aq --filter "label=com.docker.compose.project=$PROJECT" \
    --filter label=com.docker.compose.service=overpass | xargs -r $DOCKER rm -f >/dev/null
  compose up -d --no-deps overpass
}

status() {
  local cur
  cur=$(current_db)
  echo "data:      $OVERPASS_DATA"
  echo "live:      ${cur:-none}"
  if [[ -n $cur ]]; then
    echo "extract:   $(source_field "$cur" extract) (md5 $(source_field "$cur" md5))"
    echo "data as of $(source_field "$cur" data_as_of); built $(source_field "$cur" built)" \
      "in $(source_field "$cur" init_seconds) s"
  fi
  echo "container: $($DOCKER inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$LIVE" 2>/dev/null || echo missing)"
  echo "on disk:"
  du -sh "$OVERPASS_DATA"/db-* "$OVERPASS_DATA"/pbf 2>/dev/null | sed 's/^/  /' || true
}

refresh() {
  local force=$1 started cur loc url name md5 want got new path t0 t1 old
  started=$(date +%s)
  cur=$(current_db)

  # Leftovers of an interrupted run (never the live database).
  for path in "$OVERPASS_DATA"/db-*; do
    [[ -d $path && $(basename "$path") != "$cur" ]] || continue
    log "removing leftover $(basename "$path")"
    clean_db "$(basename "$path")"
  done
  $DOCKER rm -f "$CHECK" >/dev/null 2>&1 || true

  # Geofabrik redirects *-latest to the dated file. Downloading that file and ITS .md5 by name
  # means the two can't come from different days.
  loc=$($CURL -fsS -I -o /dev/null -w '%{redirect_url}' --max-time 60 -A "$UA" "$EXTRACT_URL") ||
    die "can't reach $EXTRACT_URL"
  if [[ $loc =~ ^https://[a-z0-9.-]+/[A-Za-z0-9/_.-]*/([a-z0-9_-]+-[0-9]{6}\.osm\.pbf)$ &&
    $loc == "${EXTRACT_URL%/*}/"* ]]; then
    url=$loc
    name=${BASH_REMATCH[1]}
  else
    url=$EXTRACT_URL
    name=$(basename "$EXTRACT_URL" .osm.pbf)
    name=${name%-latest}-$(date -u +%Y%m%d).osm.pbf
  fi
  if [[ -n $cur && $(source_field "$cur" extract) == "$name" && $force != yes ]]; then
    log "$name is already live in $cur; nothing to do (--force rebuilds it)"
    return 0
  fi

  log "downloading $url"
  t0=$(date +%s)
  $CURL -fsS --retry 3 --retry-delay 30 --connect-timeout 30 --max-time 3600 -A "$UA" \
    -o "$OVERPASS_DATA/pbf/$name.part" "$url" || die "download failed"
  for attempt in 1 2; do
    md5=$($CURL -fsS --retry 3 --max-time 60 -A "$UA" "$url.md5") || die "md5 download failed"
    want=$(awk 'NR == 1 { print $1 }' <<<"$md5")
    if [[ ! $want =~ ^[0-9a-f]{32}$ ]]; then
      rm -f "$OVERPASS_DATA/pbf/$name.part"
      die "unexpected md5 file: $(head -c 120 <<<"$md5" | tr -cd '[:print:]')"
    fi
    got=$(md5sum "$OVERPASS_DATA/pbf/$name.part" | awk '{ print $1 }')
    [[ $got == "$want" ]] && break
    # Only a -latest URL can change between the two downloads; wait and compare once more.
    [[ $attempt == 1 && $url == "$EXTRACT_URL" ]] && sleep 60 && continue
    rm -f "$OVERPASS_DATA/pbf/$name.part"
    die "md5 mismatch for $name (got $got, want $want)"
  done
  mv -f "$OVERPASS_DATA/pbf/$name.part" "$OVERPASS_DATA/pbf/$name"
  chmod 644 "$OVERPASS_DATA/pbf/$name"
  log "downloaded $name ($(du -h "$OVERPASS_DATA/pbf/$name" | cut -f1), md5 ok) in $(($(date +%s) - t0)) s"

  new=db-$(date -u +%Y%m%dT%H%M%SZ)
  while [[ -e $OVERPASS_DATA/$new ]]; do
    sleep 1
    new=db-$(date -u +%Y%m%dT%H%M%SZ)
  done
  path=$OVERPASS_DATA/$new
  mkdir "$path"
  chmod 0777 "$path" # uid 10003 writes here; the data directory above stays mode 700

  log "building $new (offline, nice 19)"
  t0=$(date +%s)
  if ! OVERPASS_NEW_DB=$path OVERPASS_NEW_PBF=$OVERPASS_DATA/pbf/$name \
    compose run --rm overpass-init; then
    clean_db "$new"
    die "database build failed; ${cur:-nothing} stays live"
  fi
  t1=$(date +%s)
  {
    echo "extract=$name"
    echo "url=$url"
    echo "md5=$want"
    echo "data_as_of=$(tr -d '\n' <"$path/db/osm_base_version" 2>/dev/null)"
    echo "built=$(date -u +%FT%TZ)"
    echo "init_seconds=$((t1 - t0))"
    echo "size_kb=$(du -sk "$path" | cut -f1)"
  } >"$path/SOURCE"
  log "built $new in $((t1 - t0)) s, $(du -sh "$path" | cut -f1) on disk"

  # The new database on its own, with no network: it must answer before it goes live.
  log "checking $new before the swap"
  if ! OVERPASS_NEW_DB=$path compose run -d --name "$CHECK" overpass-check >/dev/null ||
    ! check_in "$CHECK"; then
    $DOCKER logs --tail 30 "$CHECK" 2>&1 | sed 's/^/  check: /' || true
    $DOCKER rm -f "$CHECK" >/dev/null 2>&1 || true
    clean_db "$new"
    die "the new database failed its checks; ${cur:-nothing} stays live"
  fi
  $DOCKER rm -f "$CHECK" >/dev/null

  old=$cur
  ln -sfn "$new" "$OVERPASS_DATA/current.next"
  mv -Tf "$OVERPASS_DATA/current.next" "$OVERPASS_DATA/current"
  t0=$(date +%s)
  if start_live && check_in "$LIVE"; then
    log "swapped in $new (restarted and checked in $(($(date +%s) - t0)) s)"
  else
    if [[ -n $old ]]; then
      log "the live container failed its checks on $new; putting $old back"
      ln -sfn "$old" "$OVERPASS_DATA/current.next"
      mv -Tf "$OVERPASS_DATA/current.next" "$OVERPASS_DATA/current"
      if start_live && check_in "$LIVE"; then
        log "$old is live again"
      else
        log "$old does not answer either; see: docker logs $LIVE"
      fi
    else
      rm -f "$OVERPASS_DATA/current"
      compose stop overpass >/dev/null 2>&1 || true
    fi
    clean_db "$new"
    die "swap failed"
  fi

  # The new database passed twice: the old one and older extracts can go.
  [[ -n $old && $old != "$new" ]] && clean_db "$old"
  for path in "$OVERPASS_DATA"/pbf/*; do
    case $(basename "$path") in "$name" | "$name.part") ;; *) rm -f "$path" ;; esac
  done
  log "done in $(($(date +%s) - started)) s"
}

main() {
  local cmd=${1:-refresh} force=no a
  for a in "$@"; do [[ $a == --force ]] && force=yes; done
  exec 9>"$OVERPASS_DATA/.refresh.lock"
  case $cmd in
    refresh | --force)
      flock -n 9 || die "another refresh is running"
      refresh "$force"
      ;;
    status) status ;;
    *) die "usage: $0 [refresh [--force] | status]" ;;
  esac
}

# One line, so bash has read the whole script before the hour-long part starts: re-running
# install.sh (or a git pull) while a refresh runs can't change what this run does next.
main "$@"; exit
