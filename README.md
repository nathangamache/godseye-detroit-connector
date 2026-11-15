# godseye-detroit-connector

A Node 24 / TypeScript gateway for a home server that puts **God's Eye View** (GEV, a live geospatial
globe with ~40 data tools) and **Detroit Pulse** (scanner-radio incidents, future) behind one
remote MCP server, added to claude.ai as a custom connector (web, desktop and the iPhone app).

## Why a gateway

* Claude gets **four** tools instead of 40+: `find_tools` (search with hand-written synonyms,
  ranked by whole-word matches in a tool's name, then its tags, category and description, weak
  matches dropped; with no query it lists every tool the policy allows, by category, paginated),
  `run_tool` (validate, apply policy, route, post-process), `where_am_i` (latest phone fix) and
  `whats_happening_here` (rail line and crossing, Pulse rail radio and incidents, NWS alerts,
  weather in °F and mph, traffic, how many road closures are near and the nearest with road and
  cross streets, border waits near a crossing, air quality and cameras, in parallel, each with a
  short timeout inside one overall budget and its data age; every section is listed, saying so
  when it has nothing, is not configured or can't run). The server instructions give the live tool count instead of
  a fixed number.
* GEV's own MCP server is local-only and its UI assumes the owner is local. The gateway adds
  OAuth, licensing policy, quotas, result shrinking and link rewriting, and keeps every
  human-facing page on the tailnet, with an authenticator code (step-up) for approvals and
  admin.
* Rail context GEV lacks comes from public FRA/NARN datasets bundled here; Pulse plugs in over a
  documented HTTP contract.

## Tools

Claude calls the first four directly; every other tool goes through `find_tools` (search or
list by category) and `run_tool`. A gateway tool whose API key is missing is listed as **OFF**
with the key it needs and answers a normal result with status `not_configured` (nothing is
fetched); other missing requirements are hidden or answer with the setting to add. Gateway settings live in `deploy/secrets/gateway.env` (`.env.example` lists
them all), GEV's keys in `deploy/secrets/gev.env` (`deploy/gev/.env.example`).

| Tool | Source | What it answers | Key / requirement |
|---|---|---|---|
| `find_tools` | gateway | search the catalog, or list it by category (no argument needed) | none |
| `run_tool` | gateway | runs any tool `find_tools` shows, validated against its schema | that tool's own |
| `where_am_i` | gateway | the phone's latest fix (never history), its age and staleness | a phone posting fixes (OwnTracks or `/locate`, `docs/phone-setup.md`) |
| `whats_happening_here` | gateway | one summary around a point or the phone: rail, rail radio, incidents, NWS alerts ("at your location (phone fix N old)" or "at the given point"), weather (F, mph), traffic, road closures within 5 km (total, nearest 5 with road and cross streets), border waits near a crossing, air quality, cameras | a point or a phone fix; each section needs its tool's requirement and says so ("not configured (AIRNOW_API_KEY)", "none in range") rather than being left out; TomTom incidents at most every 15 min, with the requests left today |
| `nearest_rail` | gateway (rail) | nearest line (owner, every FRA/NARN name, track count) plus the nearest crossing of any kind and the nearest at-grade one, labelled | bundled FRA/NARN data (`data/rail`, `npm run rail:build`) |
| `crossings_near` | gateway (rail) | crossings in a radius: at grade or road over/under the tracks, warning devices, trains/day, FRA vs NARN track counts | bundled FRA/NARN data |
| `rail_activity_near` | Pulse | rail voice and EOT/HOT traffic near a point, with Pulse's verdict (quiet only on Pulse's proof) | Detroit Pulse at `PULSE_URL` (`PULSE_API_TOKEN`) with its own SDR receivers |
| `incidents_near`, `incident_detail`, `search_transcripts`, `feeds_status` | Pulse | scanner incidents, their transcripts, transcript search, feed and receiver status | Detroit Pulse at `PULSE_URL` (`PULSE_API_TOKEN`) |
| `dpd_calls_near` | gateway (civic) | Detroit police 911 calls near a point (official, a few hours late) | none |
| `transit_vehicles_near` | gateway (civic) | live SMART buses and alerts near a point | `SWIFTLY_API_KEY` (listed as OFF, answering `not_configured`, without) |
| `local_headlines` | gateway (civic) | recent GDELT headlines for a place or point | none |
| `weather_alerts`, `weather_forecast` | gateway (weather) | NWS alerts for a point; 12-hour or hourly forecast | none (US only) |
| `water_levels_near` | gateway (weather) | Great Lakes, tide, stream and river gauges near a point, with flood stages | none; `USGS_API_KEY` raises USGS's low `DEMO_KEY` limits |
| `air_quality` | gateway (weather) | AQI by pollutant and the agency forecast (EPA AirNow) | `AIRNOW_API_KEY` (listed as OFF, answering `not_configured`, without) |
| `road_closures` | gateway (roads) | closures, crashes, lane closures and work zones near a point or along a road | none for Detroit permits; `MDOT_RIDE_API_KEY`, `ONTARIO_511_API_KEY`, and `TOMTOM_API_KEY` with `ALLOW_TOMTOM_INCIDENTS=true` add their sources |
| `geocode_place` | gateway (roads) | coordinates for a place, address or intersection | none; intersections need a self-hosted Overpass (`OVERPASS_URL`, `docs/overpass.md`) |
| `route_avoiding_closures` | gateway (roads) | a driving route around full closures | none (`VALHALLA_URL`, FOSSGIS by default) |
| `mdot_camera_link` | gateway (roads) | a Mi Drive map link with the camera layer (nothing fetched) | none |
| `border_wait_times` | gateway (roads) | waits at the Ambassador Bridge, tunnel, Gordie Howe and Blue Water bridges | none |
| `flights_near` | gateway (aviation) | aircraft near a point or the phone, with registry and LADD/PIA flags | none (adsb.fi, personal non-commercial use; adsb.lol fallback, `ADSBLOL_DAILY_MAX`) |
| `aircraft_lookup` | gateway (aviation) | one aircraft by hex or N-number from the FAA registry | the daily FAA registry copy (`AIRCRAFT_REGISTRY_SYNC`, or `scripts/aircraft-registry-sync.ts`) |
| `get_weather`, `get_weather_map`, `get_wind` | GEV | current weather, radar/cloud map, wind (in °F and mph: the gateway converts GEV's °C and km/h, keeping both in data) | GEV running (`GEV_URL`); none |
| `get_earthquakes`, `get_cyclones`, `get_fire_perimeters` | GEV | earthquakes, tropical cyclones, wildfire perimeters | GEV; none |
| `get_active_fires` | GEV | satellite fire detections (NASA FIRMS) | `FIRMS_MAP_KEY` in GEV |
| `get_traffic_flow` | GEV | TomTom speed vs free flow in an area | `TOMTOM_API_KEY` in GEV (quota 20/h, 150/d) |
| `plan_route`, `get_bike_share`, `get_transit_vehicles` | GEV | OSRM route, GBFS docks, GTFS-RT vehicles (no Michigan feed) | GEV; none |
| `find_cctv_cameras`, `get_cctv_snapshot` | GEV | public traffic cameras and a current frame (no Street View fallback) | GEV; none (`ONTARIO_511_API_KEY` in GEV adds Windsor-side cameras) |
| `vessels_in_area`, `find_vessel`, `get_vessel_track` | GEV | live AIS ships | `AISSTREAM_API_KEY` in GEV |
| `next_satellite_pass`, `satellites_overhead`, `get_recent_launches`, `get_recent_imagery` | GEV | satellite passes, launches, recent imagery | GEV; none |
| `get_regional_brief`, `find_radio_stations` | GEV | GDELT regional news; radio stations and streams | GEV; none |
| `get_map_features`, `find_military_installations` | GEV | OpenStreetMap features and military sites | a self-hosted Overpass (`OVERPASS_UPSTREAMS` in GEV, `docs/overpass.md`) |
| `get_terrain_height`, `find_infrastructure`, `find_submarine_cables` | GEV | terrain height, infrastructure, submarine cables | GEV; none |
| `show_in_gods_eye_view` | GEV | a globe link for a place or view (tailnet only) | GEV; the UI origin on the tailnet |
| `aircraft_in_area`, `find_aircraft`, `get_aircraft_track`, `get_aircraft_info`, `situation_brief`, `military_awareness` | GEV | OpenSky-based aircraft tools and briefs | off: `ALLOW_OPENSKY_TOOLS=true` and a written OpenSky licence |
| `find_alpr_cameras` | GEV | OpenStreetMap-mapped licence plate readers | off: `ALLOW_ALPR_TOOLS=true` |

Never exposed: `panel_request`, `search_places`, `places_nearby` (Google content) and
`get_hud_caption` (metered); see Tool policy.

`flights_near` never sends the exact position: the query centre is snapped to a 0.05° grid and
the radius enlarged by 3 nm, then everything is measured here. Owner rules, LADD withholding and
the sources' terms are in `docs/security.md` ("Aviation data"); the registry sync in
`docs/operations.md`.

## Architecture

```
claude.ai ──https──▶ Cloudflare (WAF: Anthropic IPs) ──tunnel──▶ gateway PUBLIC 172.30.77.20:7700
                                                                 /mcp  OAuth endpoints  /api/location  /healthz
your devices ──Tailscale──▶ tailscale serve godseye.<tailnet>.ts.net
                              :443  ──▶ gateway PRIVATE 127.0.0.2:7702  /oauth/authorize  consent  /oauth/admin  /locate
                              :8443 ──▶ gateway UI      127.0.0.2:7703  /  (GEV globe)  /pulse
gateway ──tcp──▶ gev-mcp relay ──stdio──▶ gev/stdio-all-surfaces.mjs ──HTTP──▶ GEV vite preview :7701 ──▶ providers
gateway ──HTTP──▶ Detroit Pulse pulse-api:7710 (Pulse's internal godseye_backend network)
gateway ──▶ SQLite (OAuth clients, hashed tokens, devices, ≤24 h of fixes, audit log)
```

| Path | Listener | Auth |
|---|---|---|
| `POST /mcp` | public | OAuth 2.1 bearer token (audience `https://godseye.gamachecloud.com/mcp`) |
| `/.well-known/oauth-protected-resource[/mcp]`, `/.well-known/oauth-authorization-server` | public | none (metadata) |
| `/oauth/token`, `/oauth/register`, `/oauth/revoke` | public | PKCE / allowlisted redirects / token |
| `POST /api/location` | public + private | per-device token (OwnTracks Basic or Bearer) |
| `/oauth/authorize`, consent, `/oauth/admin` | private (:443) | Tailscale identity = `OWNER_TAILSCALE_LOGIN`, plus a step-up TOTP code to approve or open admin |
| `/locate` | private (:443) | Tailscale identity |
| `/` (GEV globe), `/pulse` | UI (:8443, separate origin) | Tailscale identity |
| `/healthz` | all | none, returns `{"ok":true}` |

OAuth: the issuer and token/registration/revocation endpoints are on the public host; the
`authorization_endpoint` is the tailnet URL, so **connecting or reconnecting the connector needs
Tailscale on that device** (and your authenticator app). Clients register by CIMD (claude.ai's and Claude Code's metadata URLs,
allowlisted) or DCR (allowlisted redirect URIs only); anyone may register, only the owner can
approve.

Run modes: **dev** = plain node under systemd --user (`deploy/systemd/`, `deploy/gev/`), with
host `tailscale serve`; **production** = hardened containers (`deploy/docker-compose.yml`: GEV,
the GEV MCP child behind a relay (`gev-mcp`), a Tailscale sidecar whose network namespace the
gateway joins, the gateway, cloudflared; read-only roots, no capabilities, non-root, no
published ports, three pinned networks) plus root-installed host firewall rules
(`docs/host-firewall.md`). Nothing is enabled or started by the repo.

## Quick start (dev)

```sh
source ~/.nvm/nvm.sh && nvm use 24
npm ci && npm run build && npm test
cp .env.example .env && chmod 600 .env       # set PRIVATE_ORIGIN, OWNER_TAILSCALE_LOGIN (or a dev password)
# GEV must be built (scripts/build-gev.sh) and running on 127.0.0.1:7701 (deploy/gev/README.md)
node dist/src/index.js                        # public :7700, private :7702, UI :7703 (all 127.0.0.1)
npm run stepup -- enroll                      # authenticator code for consent and admin
npm run smoke:live -- --url http://127.0.0.1:7700
```

## Roads and places tools (gateway-native, `src/extra/roads/`)

Run through `find_tools` / `run_tool` like every other tool (categories `traffic`, `places`,
`cameras`). Inputs are zod schemas; `here` (or `near: "here"`, `from: "here"`) uses the phone's
latest fix and is audited as a location read.

| Tool | What it answers | Sources (keys) |
|---|---|---|
| `road_closures` | Closures, crashes, lane closures and work zones near `lat`/`lon`, `here` or along a `road` (`radius_km` 1-50, `include` incidents/work_zones, `when` now/planned): source, road, direction, type, lanes and vehicle impact, description, from/to cross street, start, end, updated, distance_km, plus which sources were checked | City of Detroit right-of-way permits (keyless); MDOT RIDE work zones (WZDx v4) and traffic events (`MDOT_RIDE_API_KEY`); Ontario 511 events and construction, Windsor/Essex only (`ONTARIO_511_API_KEY`); TomTom Incident Details (`TOMTOM_API_KEY` and `ALLOW_TOMTOM_INCIDENTS=true`; a road TomTom names only by its cross streets is named from the self-hosted Overpass, `OVERPASS_URL`) |
| `geocode_place` | Coordinates for a place, street address or intersection (`near`, `limit` 1-5), biased to SE Michigan | US Census Geocoder (addresses), Photon, public Nominatim as a capped last resort; intersections through a self-hosted Overpass (`OVERPASS_URL`): a node both roads share, else (grade-separated freeway interchanges) where one road's ways pass within 30 m of the other's |
| `route_avoiding_closures` | Driving route between places, addresses, `here` or lat/lon, around full closures (`avoid_closures`, `units`): distance, duration (no live traffic), maneuvers with street names, closures_avoided, warnings; the summary says plainly when no closure source answered (the route then does not account for closures) and when TomTom is left out for its licence | Valhalla on FOSSGIS (`VALHALLA_URL`) with exclude_polygons from the open-data closure sources (never TomTom) |
| `mdot_camera_link` | A Mi Drive map link with the camera layer, centred on a point, `here` or a road | Link only: no image is fetched (Michigan.gov terms) |
| `border_wait_times` | Waits at the Ambassador Bridge, the tunnel, Gordie Howe and Blue Water (`crossing`, `direction`): delay, lanes open, lane type, updated, source | CBP Border Wait Times (U.S.-bound), CBSA CSV (Canada-bound), keyless |

* A source whose key is missing is **off**, and every result says so with the fix
  (`not configured: set MDOT_RIDE_API_KEY in deploy/secrets/gateway.env`). Each source fails on
  its own: one down never sinks the others, and "none found" is reported as "not proof the road
  is open", with the list of sources checked.
* A stretch a source reports once per direction (between the same cross streets, in either
  order, within 300 m, on the same named road or, unnamed, with lines that run within 60 m of
  each other as a divided road's carriageways do; or lines that overlap by 70% or more) is one
  item, direction "both directions". Parallel streets closed between the same cross streets stay
  separate items. Counts are after merging, and the merged item keeps both directions' geometry
  for routing.
* Upstream limits are kept inside the gateway: TomTom is never cached and hard-capped at
  `TOMTOM_INCIDENTS_DAILY_MAX` (60) calls a day, counted on disk, and `whats_happening_here` asks
  it unless it asked in the last 5 minutes or fewer than `TOMTOM_WHATS_HAPPENING_RESERVE` (20)
  of the day's calls are left (then its line says which, with the calls left, and that
  `road_closures` has the incidents; with no closure found it also says when TomTom's traffic
  flow shows closed road nearby); the City of Detroit permits are one in-memory snapshot
  refreshed every 15 minutes (the last good copy is kept when a refresh fails, and results say how
  old it is); MDOT RIDE is polled at most every 5 minutes; Ontario 511's provincial lists are
  cached 1-5 minutes and calls stay under 10 a
  minute; Valhalla and Nominatim get at most one request a second; Nominatim at most
  `GEOCODER_NOMINATIM_DAILY_MAX` (50) a day and the shared `nominatim` bucket; border feeds are
  cached 5 minutes.
* Default quotas (`ROADS_TOOL_RATE_LIMITS`, overridden per bucket by `TOOL_RATE_LIMITS`):
  road_closures 60/h, geocode_place 60/h, route_avoiding_closures 30/h, mdot_camera_link 60/h,
  border_wait_times 60/h.
* Geocoder answers are cached on disk (`DATA_DIR/cache`, mode 600, 30 days; the key is the query
  only, never the caller's position) as Nominatim's policy requires. Every outbound request has a
  generic User-Agent (`ROADS_USER_AGENT`) and a timeout, and every result carries its
  attribution (ODbL for OpenStreetMap-derived answers; OGL-Ontario and the "as is" disclaimer for
  Ontario 511). Licensing notes: `docs/security.md`.

## Tool policy

* GEV tools are **deny by default**: only names on `GEV_TOOL_ALLOWLIST` are visible or runnable,
  so tools added upstream stay hidden until vetted. The GEV child itself is started with only
  the allowed tools, so a composite tool can't call a denied one internally.
* Never exposed: `panel_request` (an open proxy into GEV) and `ui://` resources.
* Hard-denied for licensing: `search_places`, `places_nearby` (Google content), Street View
  fallback frames in `get_cctv_snapshot` (stripped), `get_hud_caption` (metered OpenAI).
* Off unless enabled: OpenSky-backed aviation tools (`ALLOW_OPENSKY_TOOLS`: `aircraft_in_area`,
  `find_aircraft`, `get_aircraft_track`, `get_aircraft_info`, `situation_brief`,
  `military_awareness`), ALPR locations (`ALLOW_ALPR_TOOLS`), place-name arguments
  (`GEV_PLACE_NAMES`, needs a Nominatim GEV can use).
* Quotas (`TOOL_RATE_LIMITS`): TomTom traffic 20/h and 150/d, OSRM routes 30/h, camera snapshots
  60/h, imagery 20/h, regional news 30/h, place lookups 30/h. Each gateway-native family adds
  its defaults for the buckets `TOOL_RATE_LIMITS` does not set: `AVIATION_RATE_LIMITS`
  (`flights_near` 60/h and 600/d, `aircraft_lookup` 120/h), `WEATHER_TOOL_RATE_LIMITS`,
  `ROADS_TOOL_RATE_LIMITS` and `CIVIC_TOOL_RATE_LIMITS` (Detroit 911 calls 60/h, SMART buses
  120/h, local headlines 30/h and 200/d). Outbound: adsb.fi at most one request per 1.1 s,
  adsb.lol at most `ADSBLOL_DAILY_MAX` (100) calls a day.
* Every call: ajv validation (a failure returns the schema), 110 s timeout, at most 4 at once.
* Every result: one copy of the data (GEV duplicates it), `data.view` stripped (its link kept as
  `map_url`), internal GEV links rewritten to the tailnet UI origin, third-party links flagged as
  unvetted, images downscaled with sharp (dropped with a note if they can't fit), total size
  (summary and images included) capped at 100k characters, provenance, retrieval time,
  attribution and an "untrusted data" label first.
* Location reads (`where_am_i`, `whats_happening_here` without a point, a weather, water, air,
  roads or civic tool called with `here: true`) are audited per grant.
  A tool called for an explicit point, while the phone's fix is under 30 minutes old, adds a
  "phone check" (distance, bearing from the point to the phone, fix age; never the phone's
  coordinates) and says plainly when the phone is not there; that is audited as a location read
  too.
* Rail lines are reported with every subdivision name the FRA and NARN datasets give the same
  track (they often differ), computed from the data, and Pulse rail coverage is matched on all of
  them. Rail radio results relay Pulse's own verdict per kind (rail voice, EOT/HOT; contract
  v1.2): activity, quiet only when Pulse proves every channel covering the point was listened to
  for the whole window, not covered, or can't confirm, with Pulse's reasons. The gateway may turn
  a quiet into "can't confirm" when its own checks disagree, never the reverse. Without verdicts
  (an older Pulse, and scanner incidents) it says activity, no receiver, offline since when, or
  can't confirm, never "quiet", so zero messages is never passed off as a quiet line or area;
  EOT/HOT packets there are "heard but not placed", since such a Pulse can't tie them to the point.

## Gateway-native tools: weather, water and air (`src/extra/weather`)

Each takes `{lat, lon}` or `{here: true}` (the latest phone fix, audited as a location read; the
fix's coordinates are never echoed back). Third-party text is capped and labelled untrusted;
every result carries its source's credit.

| Tool | What it returns | Source | Key |
|---|---|---|---|
| `weather_alerts` | active NWS watches, warnings and advisories for the point: event, severity, urgency, certainty, headline, description, instruction, areas, onset, ends, issuing office, link; "No active alerts for zone …" when there are none | NWS `api.weather.gov` (public domain) | none |
| `weather_forecast` | 12-hour periods (up to 7 days) or hourly (`hourly: true`), `periods` 1-14: temperature, wind, chance of precipitation, forecast text | NWS `/points` → forecast / forecastHourly; office/grid cached per ~1 km cell for 12 h; points NWS doesn't cover are remembered for 12 h (per ~100 m) or, far from every US area, never sent | none |
| `water_levels_near` | Great Lakes and tide stations, stream gages and NWS river gauges within `radius_km` (5-60): value, units, datum, ~3 h trend, flood stage and NWS flood category when known, update time | NOAA CO-OPS, USGS Water Data OGC API, NWS National Water Prediction Service (public domain) | `USGS_API_KEY` optional (else the shared `DEMO_KEY`) |
| `air_quality` | current AQI by pollutant (with the monitoring site) and the agency forecast (with Action Days) for the reporting area AirNow matches to the point, passed through unaltered, labelled preliminary and credited to the agency AirNow names | EPA AirNow (Michigan EGLE for Michigan), its June 2026 services | `AIRNOW_API_KEY`; **OFF** without it: listed with the key it needs, and every call answers status `not_configured` (`air_quality is not configured: set AIRNOW_API_KEY in deploy/secrets/gateway.env (…). Nothing was fetched.`) |

Quotas (`WEATHER_TOOL_RATE_LIMITS`, overridable per bucket in `TOOL_RATE_LIMITS`): alerts 120/h,
forecast 60/h, water levels 20/h, air quality 30/h. Outbound requests use https only, a fixed host
list per service, the User-Agent `(godseye-personal-connector)`, a 12 s timeout, two polite
retries on 5xx (one on 429), no redirects and a size cap. Air quality is cached 30 min, USGS
answers 10 min, NWS alerts 30 s and forecasts up to 10 min.

## Gateway-native tools: civic, transit and news (`src/extra/civic`)

Served by the gateway itself (`src/extra/civic/`), through `run_tool` like every other tool. Each
takes a point as `lat`/`lon` or `here: true` (the latest phone fix, audited as a location read;
its coordinates are never echoed), validates its input with zod, fetches with a timeout and a
generic User-Agent, caps its output, labels it untrusted third-party data and credits its source.

| Tool | What it answers | Source (key) | Notes |
|---|---|---|---|
| `dpd_calls_near` | Detroit police 911 calls near a point: time, description, category, priority, nearest intersection, neighborhood, response minutes | City of Detroit open data, Police Serviced 911 Calls (no key) | "official, delayed a few hours": when the newest published call is an hour or more old, the result opens with its age, how much of the window is published and an `hours` value that covers published calls; nearest intersection only, never a house address; Detroit city limits only |
| `transit_vehicles_near` | Live SMART buses near a point (route, headsign, vehicle, position, distance, bearing, heading, delay, last report) plus active SMART service alerts | SMART via Swiftly GTFS-Realtime (`SWIFTLY_API_KEY`; **OFF** without it, answering `not_configured`); route names and headsigns from SMART's static GTFS | display only: one in-memory snapshot of at most 30 s, never stored or exported; DDOT and QLINE have no usable public real-time feed |
| `local_headlines` | Recent headlines about a place (`place`, or a point turned into the town there): first from the metro's local outlets (GDELT `domain:`, `src/extra/civic/outlets.ts`) or, elsewhere, outlets in the place's country (`sourcecountry:`, town `near20:` its state), then a broad search only if that finds nothing; `data.mode` and the summary say which; titles tidied | GDELT DOC 2.0 API (no key); U.S. Census geocoder for coordinates (rounded to ~1 km) | at most one GDELT request every 5 s per process (queued; at most two per call), 10-minute cache; headlines are untrusted third-party text |

GEV's `get_transit_vehicles` no longer advertises DDOT, SMART or QLINE: its feed registry has no
Michigan feed.

## Repository layout

```
src/            gateway (TypeScript, ESM)
  app.ts        public and private Express apps          gateway.ts  wiring, two listeners
  mcp/          the four MCP tools                       tools/      registry, search, policy, post-processing
  gev/          child supervisor, relay, TCP transport   rail/       NARN/FRA spatial index + tools
  pulse/        Pulse HTTP client + tools                oauth/      authorization server, CIMD, DCR, tokens
  auth/         tailscale, step-up TOTP, dev login, CSRF location/   device tokens, ingest, /locate
  ui/           GEV reverse proxy, /pulse                http/       headers, Host/Origin checks, rate limits
  extra/        gateway-native tool families, each with its own block in config.ts:
    aviation/   flights_near, aircraft_lookup, FAA registry sync
    weather/    NWS alerts and forecast, water levels, air quality
    roads/      road closures, geocoding, closure-aware routes, Mi Drive links, border waits
    civic/      Detroit 911 calls, SMART buses, GDELT headlines
gev/stdio-all-surfaces.mjs   GEV MCP entry with all 40 tools (adapted from GEV, MIT)
data/rail/      FRA crossings + NARN lines for Michigan (public domain; see data/README.md)
web/            /locate PWA and shared CSS
scripts/        devices, stepup, hash-password, backup-db, revoke-all, smoke-live, gev-relay,
                egress-probe, build-gev.sh, tighten-permissions.sh, rail data build/fetch, audit,
                aircraft-registry-sync
deploy/         docker (image, compose, Tailscale sidecar), host-firewall (root), systemd units,
                GEV notes, secrets README, overpass (self-hosted Overpass + weekly refresh)
docs/           cloudflare-setup, tailscale-setup, host-firewall, phone-setup, operations, security,
                pulse-api-contract, overpass
test/           vitest unit + integration tests (mock GEV MCP child, mock Pulse, mocked HTTP only:
                test/setup-offline.ts refuses anything but loopback)
```

## Docs

* `docs/security.md`: threat model, controls, residual risks, **go-live checklist**
* `docs/tailscale-setup.md`: the mandatory tailnet policy, the sidecar, step-up, host `tailscale serve`, fallback mode
* `docs/host-firewall.md`: root-installed rules that keep the containers off the LAN, tailnet and host
* `docs/cloudflare-setup.md`: tunnel to the public listener, WAF, bot protection, TLS
* `docs/phone-setup.md`: OwnTracks (iPhone/Android), the `/locate` PWA, iOS Shortcuts
* `docs/operations.md`: run modes, builds, logs, backups, credential rotation, kill switches
* `docs/pulse-api-contract.md`: what Pulse must implement on 127.0.0.1:7710
* `docs/overpass.md`: the self-hosted Overpass (Michigan OpenStreetMap) behind `get_map_features`, and its weekly refresh

## Credits and licences

God's Eye View is © 2026 Bilawal Sidhu, MIT; `gev/stdio-all-surfaces.mjs` is adapted from it (see
`third_party/gods-eye-view/`). GEV's data sources keep their own terms; the gateway appends their
attribution to results. Rail data: U.S. DOT FRA and BTS, public domain. Map features come from a
self-hosted Overpass loaded with Geofabrik's Michigan extract: © OpenStreetMap contributors, ODbL
1.0 (`docs/overpass.md`). Live aircraft: adsb.fi (https://adsb.fi; personal, non-commercial use)
and adsb.lol (https://adsb.lol; ODbL 1.0). Aircraft registry: FAA Releasable Aircraft Database (US
government data). Weather and water data: National Weather Service, NOAA CO-OPS, NWS National
Water Prediction Service and USGS, public domain (USGS values are provisional). Air quality: EPA
AirNow and the reporting agencies (Michigan EGLE), preliminary data under the AirNow Data Exchange
Guidelines. Civic tools: City of Detroit Open Data (Police Serviced 911 Calls), SMART real-time
data via Swiftly (display only, under Swiftly's API licence) and SMART's GTFS schedule, the GDELT
Project (gdeltproject.org; a citation and link go with every result) and the U.S. Census Bureau
geocoder; see `docs/security.md` for the terms of each. This repository is
public, for personal, non-commercial use; it holds no secrets or personal data.
