# Data

## `rail/` (committed)

Compact Michigan rail datasets for the gateway-native `nearest_rail` and `crossings_near` tools.
Built by `scripts/build-rail-data.mjs`; `scripts/fetch-rail-data.sh` re-downloads the sources into
`data/raw/` (gitignored) and rebuilds. `rail/meta.json` records the source URLs, input SHA-256
hashes, record counts and the latest FRA revision date.

| File | Source | Publisher | Licence |
|---|---|---|---|
| `crossings.json.gz` | FRA Crossing Inventory Data (Form 71), Current: data.transportation.gov dataset `m2f8-22s6`, filtered to `statename=MICHIGAN` | U.S. DOT Federal Railroad Administration | Public domain (dataset licence "Public Domain"; U.S. Government work, 17 U.S.C. § 105) |
| `lines.json.gz` | NTAD North American Rail Network Lines (doi:10.21949/1528950), ArcGIS FeatureServer filtered to `STATEAB='MI'` | U.S. DOT BTS / FRA | Public domain ("a work of the United States government … not protected by any U.S. copyrights … available for unrestricted public use") |

Processing:

* Crossings: rows whose latest record reason is `Closed` are dropped, as are rows without plausible
  coordinates. Kept fields: crossing ID, position (at grade / RR over / RR under), type, railroad,
  street, city, county, subdivision, division, branch, milepost, train counts (day/night through,
  switching, transit), timetable speed, main tracks, a warning-device summary (gates / flashing
  lights / passive) and the record revision date.
* Lines: segments with NARN `NET` codes `A`, `X`, `R`, `T` (abandoned, out of service, rail-banked,
  trail; best understanding of the NARN data dictionary) are dropped. Coordinates are rounded to
  1e-5° (about 1 m). Owner and trackage-rights codes are mapped to names in `src/rail/index.ts`.

These are infrastructure inventories, not live train positions, and they can lag reality.
FRA train counts are railroad-reported estimates.

The initial build (2026-11-14) used downloads made the same day for the SDR-route research
(FRA latest revision 2026-11-12; NARN updated 2026-10-19).

## Runtime files (never committed)

* `gateway.sqlite` (+ `-wal`, `-shm`): OAuth clients, hashed tokens and codes, sessions, devices,
  the last 24 h of location fixes, the audit log. Mode 600.
* `backups/`: nightly SQLite backups (see docs/operations.md).
* `raw/`: source downloads.
