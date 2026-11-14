#!/usr/bin/env bash
# Downloads the public rail datasets the gateway uses into data/raw/ (gitignored),
# then rebuilds data/rail/ with scripts/build-rail-data.mjs.
# Both sources are U.S. Government works in the public domain. No API keys are needed.
set -euo pipefail
cd "$(dirname "$0")/.."
RAW=data/raw
mkdir -p "$RAW/narn"
UA="godseye-detroit-connector/0.1 (personal, non-commercial)"

echo "FRA Crossing Inventory (Michigan)..."
curl -fsS --retry 3 --max-time 300 -A "$UA" -o "$RAW/fra_mi.csv" \
  'https://data.transportation.gov/resource/m2f8-22s6.csv?statename=MICHIGAN&$limit=50000'

echo "NARN rail lines (Michigan)..."
BASE='https://services.arcgis.com/xOi1kZaI0eWDREZv/arcgis/rest/services/NTAD_North_American_Rail_Network_Lines/FeatureServer/0/query'
offset=0
while :; do
  out="$RAW/narn/narn_mi_${offset}.geojson"
  curl -fsS --retry 3 --max-time 300 -A "$UA" -o "$out" \
    "$BASE?where=STATEAB%3D%27MI%27&outFields=*&orderByFields=OBJECTID&f=geojson&resultOffset=${offset}&resultRecordCount=2000"
  n=$(node -e "const f=require('fs').readFileSync(process.argv[1],'utf8');const j=JSON.parse(f);console.log((j.features||[]).length + ' ' + Boolean(j.properties&&j.properties.exceededTransferLimit))" "$out")
  set -- $n
  echo "  offset $offset: $1 features"
  [ "$2" = "true" ] || break
  offset=$((offset + 2000))
done

node scripts/build-rail-data.mjs --fra "$RAW/fra_mi.csv" --narn "$RAW/narn" --out data/rail
