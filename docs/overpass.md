# Self-hosted Overpass API (Michigan OpenStreetMap extract)

GEV's OpenStreetMap features need an Overpass server: `get_map_features`, voice place search
(`osm_query`), the military-installations layer and the map's `/api/overpass` proxy. GEV answers
them only when `OVERPASS_UPSTREAMS` is set and never falls back to a public instance, and the
public instances aren't a backend for an app built for more than OSM mappers anyway
([Overpass commons](https://dev.overpass-api.de/overpass-doc/en/preface/commons.html): such an
app needs its own instance). The same server lets gateway tools find a freeway intersection (the
ways tagged `ref=I 94` and `ref=M 10` near each other) without any third-party geocoder.

So this stack runs its own Overpass, loaded with Geofabrik's Michigan extract, on the internal
`godseye-backend` network next to GEV. It is a separate compose project (`godseye-overpass`,
`deploy/overpass/`); nothing in the godseye stack depends on it being up.

**Data and licence.** Map data © OpenStreetMap contributors, available under the
[Open Database License 1.0](https://www.openstreetmap.org/copyright); the extract is Geofabrik's
(`https://download.geofabrik.de/north-america/us/michigan-latest.osm.pbf`, refreshed daily,
free to download). Anything shown from it carries `© OpenStreetMap contributors (ODbL)`: the
gateway already attaches that to `get_map_features` and `find_military_installations`
(`src/tools/tags.ts`), and a gateway tool that queries `OVERPASS_URL` must do the same. The
database is built with `OVERPASS_META=no`: no mapper user names, uids or changesets are stored
or returned. One download a week (about 320 MB) keeps well within Geofabrik's fair use.

## What runs

| | `overpass` (live) | `overpass-init` | `overpass-check` | `overpass-clean` |
|---|---|---|---|---|
| Job | serves `current` | builds a new database from one extract | serves the new database, before the swap | empties a database directory |
| Network | `godseye-backend` only, `172.30.78.30`, alias `overpass` | none | none | none |
| Mounts | `./container` ro, `$OVERPASS_DATA/current` at `/db` | `./container` ro, the new `db-*` dir, the extract ro | `./container` ro, the new `db-*` dir | that `db-*` dir |
| Limits | 4 GiB, 2 CPUs | 8 GiB, 4 CPUs, `nice 19`, idle I/O | 4 GiB, 2 CPUs | 256 MiB, 1 CPU |

All four: image `wiktorn/overpass-api:v0.7.62.11` pinned by digest (Overpass API 0.7.62, built
by the image's maintainer from upstream sources; Dependabot watches `deploy/overpass`), uid
**10003** (neither the image's built-in user, uid 1000, nor any host account), `read_only`
root, `cap_drop: [ALL]`, `no-new-privileges`, `init`, CPUs `24-31`, `pids_limit`, capped
json-file logs. No published host port, no docker socket, no home directory.

The image's own entrypoint needs root (it changes file owners, writes `/etc/nginx` and starts
supervisord programs under other users) and would download a planet file or replication diffs
itself. It is replaced by the scripts in `deploy/overpass/container/`, mounted read-only:

* `init.sh` streams the PBF through `osmium cat -f osm` into `update_database` (no bz2 round
  trip), builds the areas, refuses a non-empty `/db`, and never touches the network;
* `serve.sh` + `supervisord.conf` run the osm-base and areas dispatchers, fcgiwrap and nginx as
  uid 10003, with no update or area-rebuild loops;
* `nginx.conf` serves only `/api/interpreter`, `/api/status`, `/api/timestamp` and
  `/api/kill_my_queries` (the CGI paths themselves are `internal`), keeps **no access log**
  (queries carry the boxes and points being looked up) and writes only under `/tmp`;
* `check.sh` is the health check the refresh runs (below).

**Network.** `godseye-backend` is `internal: true` (no route out), so the container can't reach
the internet even if something in it tried; the host firewall rules for `172.30.78.0/24`
(`docs/host-firewall.md`) also keep it off the host and the LAN. On that network it is a peer of
GEV, gev-mcp and the gateway's namespace, like GEV is: it can open connections to `gev:7701` and
the sidecar's backend address, but gev-mcp's relay admits only the gateway, and the gateway's
listeners are on other addresses. The trade-off is the same as for GEV, and the code here parses
only Geofabrik's extract (md5-checked) and the queries GEV and the gateway send.

**Dispatcher budget** (`OVERPASS_SPACE`, `OVERPASS_TIME`): 4 GiB of declared `[maxsize]` and
2400 s of declared `[timeout]` across all running queries, so eight queries at Overpass's default
512 MiB run at once and the rest wait. Duplicate queries are allowed (GEV dedupes its own; a
refusal would only trip GEV's cooldown), and there is no per-client rate limit, since the only
clients are GEV and the gateway, which have their own.

## Measured on this host (Michigan, extract of 2026-11-13)

| | |
|---|---|
| Extract | `michigan-261113.osm.pbf`, 318 MB (303 MiB), data as of 2026-11-13T21:22:20Z; download 22-42 s |
| Database | **5.2 GB** (`OVERPASS_META=no`, gz compression, areas included); 5.5 GB with the extract |
| Disk during a refresh | about 10.7 GB at the peak (old and new database plus the extract) |
| Build (`overpass-init`, nice 19, 4 CPUs) | **608-626 s**: about 580 s for the data, 33 s for the areas; peak memory 5.1 GiB of its 8 GiB (page cache included) |
| Whole refresh | 664 s (download 22 s, build 626 s, two checks, swap) |
| Swap | an outside probe on `godseye-backend` saw queries fail for about 2 s; the script logs 8 s, which includes its own check queries |
| Container start to first answer | about 7 s |

Queries from a throwaway container on `godseye-backend`, by name (`http://overpass/api/interpreter`),
as GEV sends them (form-encoded POST):

| Query | Answer | Time |
|---|---|---|
| Nodes shared by the `I 94` and `M 10` ways around Detroit | none (grade-separated, see below) | 0.68 s |
| `M 10` motorway ways within 30 m of `I 94` | 4 ways, John C Lodge Freeway, around 42.359 N, 83.076 W | 0.58 s |
| Hospitals, police, fire stations, schools in a downtown box (`out tags center`) | 69 features, 29 KB | 0.31 s |
| All amenities in the same box (`out count`) | 4,092 | 0.31 s |
| Parks inside the City of Detroit area (area query) | 448 | 1.58 s |
| Amenities inside the City of Detroit area (`check.sh`) | 10,248 | 3.4 s |
| 12 bbox queries at once | all HTTP 200 with data, no rate-limit remarks | 0.5-1.5 s each |

## Install and first build

Start the godseye stack first (it creates `godseye-backend`). Then, from the main checkout:

```sh
cd ~/projects/godseye/godseye-detroit-connector
deploy/overpass/install.sh                    # copies to ~/.local/share/godseye-overpass, writes its .env
~/.local/share/godseye-overpass/overpass-refresh.sh          # download, build, check, start
systemctl --user enable --now godseye-overpass-refresh.timer # weekly
```

`install.sh [OVERPASS_DATA]` installs the compose file, the scripts and the units outside the
repo, so the running container's bind mounts and the timer don't depend on what the checkout has
checked out. `OVERPASS_DATA` defaults to `~/projects/godseye/overpass-data` (outside every repo;
the refresh refuses a directory inside a git work tree) and is written to the `.env` next to the
installed compose file, which docker-compose and the script both read. Re-run `install.sh` after
pulling a change to `deploy/overpass`; the next refresh recreates the container with it (or run
`overpass-refresh.sh --force` now).

Data directory layout (mode 700, so no other host account can reach any of it):

```
overpass-data/
  pbf/                      755  the extract in use, e.g. michigan-261113.osm.pbf (644, md5-checked)
  db-20261114T210500Z/      777  a database (written by uid 10003; SOURCE records extract, md5, timings)
  current -> db-...              the live one
```

`pbf/` and the `db-*` directories are opened up for uid 10003, which reaches them only through
its bind mounts; the files inside a database belong to uid 10003, so the refresh deletes old ones
with the `overpass-clean` container instead of `rm`.

## Wiring GEV and the gateway

Add to `deploy/secrets/gev.env` (mode 600):

```sh
OVERPASS_UPSTREAMS=http://overpass/api/interpreter
```

and to `deploy/secrets/gateway.env`, for the gateway tools that query it directly
(`geocode_place` finds intersections with it; unset, it answers that intersections need it):

```sh
OVERPASS_URL=http://overpass/api/interpreter
```

Then recreate GEV so it reads the new environment (gev-mcp reaches Overpass through GEV and
needs nothing). docker-compose 1.29 can't *recreate* a container on Docker 29
(`KeyError: 'ContainerConfig'`, after it has already stopped and renamed the old one; see
`docs/operations.md`), so remove GEV and create it afresh, touching nothing else:

```sh
cd ~/projects/godseye/godseye-detroit-connector/deploy
docker-compose -p godseye rm -sf gev && docker-compose -p godseye up -d --no-deps gev
```

(With Compose v2: `docker compose -p godseye up -d --no-deps --force-recreate gev`.) Do the same
for the gateway after adding `OVERPASS_URL`: `rm -sf gateway` and `up -d --no-deps gateway`, the
gateway only, since the sidecar keeps its namespace.

## Weekly refresh

`godseye-overpass-refresh.timer` runs `overpass-refresh.sh` on Sundays at 04:41 local time
(randomised by up to 20 min, caught up after downtime; the host's user manager lingers, so it
runs without a login). The script, on the host, under a lock:

1. Removes leftovers of an interrupted run (never the live database).
2. Asks Geofabrik where `michigan-latest.osm.pbf` redirects (the dated file, e.g.
   `michigan-261113.osm.pbf`) and stops if that extract is already live (`--force` rebuilds).
3. Downloads the dated file and **its own** `.md5` (so the two can't come from different days)
   with a generic User-Agent, checks the md5, and keeps it as `pbf/<name>` (mode 644).
4. Builds a **new** `db-<UTC stamp>` with `overpass-init` (no network, nice 19, idle I/O).
5. Starts `overpass-check` on the new database (no network) and runs `check.sh` in it.
6. Points `current` at the new database (atomic rename), removes the `overpass` container and
   creates it afresh (docker-compose 1.29's recreate crashes on Docker 29, see above), and runs
   `check.sh` in the live container.
7. Only then deletes the old database and older extracts.

Any failure stops with a non-zero exit (visible in `systemctl --user status
godseye-overpass-refresh` and `journalctl --user -u godseye-overpass-refresh`) and leaves the old
database live: a failed download, md5, build or offline check never touches it, and a failed
live check puts `current` back and recreates the container on the old database. Disk use peaks
at two databases plus one extract during a refresh. Queries fail for the few seconds the
recreated container takes to start its dispatchers (GEV serves its cached answers meanwhile).

`check.sh` (also usable by hand: `docker exec godseye-overpass /overpass/check.sh`) waits up to
three minutes for the dispatchers, then requires at least 100 motorway ways in a central Detroit
box, at least 100 amenities inside the City of Detroit boundary area (found by its Wikidata id,
Q12439, since the city's boundary is tagged `admin_level=7`, not 8; this proves the areas were
built), and at
least one M-10 motorway way within 30 m of I-94. It is written for the Michigan extract; another
region needs its own checks.

**Intersections.** Freeway-to-freeway interchanges are grade-separated, so the mainline ways
share no node: `node(w.a)(w.b)` for the ways tagged `I 94` and `M 10` returns nothing. What
works is proximity, `way(around.a:30)` on the second road's ways, which finds the four
`John C Lodge Freeway` (M-10) ways at the interchange, around 42.359 N, 83.076 W. Surface
streets that cross at grade do share a node, so a tool should try the shared node first and fall
back to proximity.

## Operating it

```sh
~/.local/share/godseye-overpass/overpass-refresh.sh status   # live database, extract, health, disk
docker logs --tail 50 godseye-overpass
docker exec godseye-overpass /overpass/check.sh
systemctl --user list-timers godseye-overpass-refresh.timer
```

The container has `restart: unless-stopped`, so Docker brings it back after a reboot (once the
godseye stack has created `godseye-backend` again). To start it by hand:

```sh
cd ~/.local/share/godseye-overpass && docker-compose -p godseye-overpass up -d overpass
```

To remove it: disable the timer, `docker-compose -p godseye-overpass rm -sf overpass` in that
directory, take `OVERPASS_UPSTREAMS` out of `gev.env` (and `OVERPASS_URL` out of
`gateway.env`), recreate GEV, then empty each `db-*` directory with
`OVERPASS_CLEAN_DB=<dir> docker-compose -p godseye-overpass run --rm overpass-clean` before
deleting the data directory.

**Image updates** (Dependabot PRs for `deploy/overpass`): the replacement scripts use the
image's `/app/bin/dispatcher_start.sh`, `start_fcgiwarp.sh`, `update_database`, `osm3s_query`,
`/app/cgi-bin/interpreter`, `/app/etc/rules/areas.osm3s` and `/app/docker-healthcheck.sh`;
check they are still there, re-run `install.sh` and `overpass-refresh.sh --force`, which only
goes live if the new image builds and serves a database that passes the checks.
