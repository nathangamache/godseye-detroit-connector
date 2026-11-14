#!/bin/bash
# Health check for a served database. overpass-refresh.sh runs it in the offline check container
# before a swap and in the live container after it; by hand:
#   docker exec godseye-overpass /overpass/check.sh
# Waits for the dispatchers, then asks questions a complete Michigan database must answer (an
# empty, partial or area-less build fails). Written for the Michigan extract.
API=http://127.0.0.1/api/interpreter

main() {
  set -euo pipefail
  local deadline fail=0 stamp
  deadline=$(($(date +%s) + ${OVERPASS_CHECK_WAIT:-180}))
  until query '[out:json][timeout:5];node(1);out ids;' 2>/dev/null | grep -q '"generator"'; do
    if (($(date +%s) >= deadline)); then
      echo "check: FAIL no answer within ${OVERPASS_CHECK_WAIT:-180} s"
      return 1
    fi
    sleep 2
  done
  stamp=$(query '[out:json][timeout:5];node(1);out ids;' | jq -r '.osm3s.timestamp_osm_base')
  echo "check: answering; data as of $stamp"

  expect 'motorway ways in a central Detroit box' 100 '.elements[0].tags.ways' \
    '[out:json][timeout:60];way["highway"="motorway"](42.30,-83.15,42.40,-83.00);out count;' || fail=1
  # The city's boundary relation (tagged admin_level 7, not 8), by its Wikidata id.
  expect 'amenities inside the City of Detroit area' 100 '.elements[0].tags.total' \
    '[out:json][timeout:60];area["boundary"="administrative"]["wikidata"="Q12439"]->.a;nwr["amenity"](area.a);out count;' || fail=1
  # Grade-separated freeways share no node: M-10 ways within 30 m of I-94 mark the interchange.
  expect 'I-94 / M-10 crossing' 1 '.elements | length' \
    '[out:json][timeout:60];way["highway"~"^motorway"]["ref"~"(^|;) *I 94 *($|;)"](42.30,-83.20,42.45,-82.95)->.a;way(around.a:30)["highway"~"^motorway"]["ref"~"(^|;) *M 10 *($|;)"];out ids;' || fail=1
  return "$fail"
}

query() { curl -fsS --max-time 90 --data-urlencode "data=$1" "$API"; }

# expect NAME MIN JQ QUERY: the query's count (JQ) must be at least MIN.
expect() {
  local name=$1 min=$2 expr=$3 q=$4 t0 out n ms
  t0=$(date +%s%N)
  if ! out=$(query "$q"); then
    echo "check: FAIL $name: the query failed"
    return 1
  fi
  ms=$((($(date +%s%N) - t0) / 1000000))
  n=$(jq -r "$expr" <<<"$out" 2>/dev/null || true)
  if [[ $n =~ ^[0-9]+$ ]] && ((n >= min)); then
    echo "check: ok   $name: $n ($ms ms)"
  else
    echo "check: FAIL $name: ${n:-no answer}, want at least $min ($ms ms)"
    return 1
  fi
}

# One line, so bash has read the whole script before it runs any of it.
main "$@"; exit
