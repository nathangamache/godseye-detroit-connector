#!/usr/bin/env node
// Builds the gateway's compact rail datasets from public U.S. DOT downloads.
//
//   node scripts/build-rail-data.mjs [--fra data/raw/fra_mi.csv] [--narn data/raw/narn] [--out data/rail]
//
// Inputs (fetch them with scripts/fetch-rail-data.sh):
//   * FRA Crossing Inventory Data (Form 71) - Current, Michigan rows (data.transportation.gov m2f8-22s6)
//   * NTAD North American Rail Network Lines, STATEAB='MI' (BTS/FRA ArcGIS FeatureServer), GeoJSON pages
// Outputs:
//   data/rail/crossings.json.gz  open crossings with coordinates (compact objects)
//   data/rail/lines.json.gz      active line segments (rounded coordinates)
//   data/rail/meta.json          provenance and counts
// Both sources are works of the U.S. government and in the public domain.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const fraPath = path.resolve(args.fra ?? path.join(root, 'data/raw/fra_mi.csv'));
const narnDir = path.resolve(args.narn ?? path.join(root, 'data/raw/narn'));
const outDir = path.resolve(args.out ?? path.join(root, 'data/rail'));

/** RFC 4180 CSV parser (quotes, escaped quotes, embedded newlines). */
function* parseCsv(text) {
  let row = [];
  let field = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else q = false;
      } else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      yield row;
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    yield row;
  }
}

const num = (s) => (s === '' || s == null ? null : Number.isFinite(Number(s)) ? Number(s) : null);
const NA = /^(#?N\\?\/?A|NULL|NONE|UNKNOWN|-)$/i;
const str = (s) => (s && s.trim() && !NA.test(s.trim()) ? s.trim() : null);
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// ---------------- crossings ----------------
const fraBuf = readFileSync(fraPath);
const rows = parseCsv(fraBuf.toString('utf8'));
const header = rows.next().value;
const col = Object.fromEntries(header.map((h, i) => [h, i]));
const need = ['crossingid', 'reasondescription', 'latitude', 'longitude', 'crossingposition', 'railroadcode', 'railroadname', 'street', 'highwayname', 'cityname', 'countyname', 'railroadsubdivision', 'railroaddivision', 'branchname', 'railroadmilepostnumber', 'crossingtype', 'crossingpurpose', 'totaldaylightthrutrains', 'totalnighttimethrutrains', 'totalswitchingtrains', 'totaltransittrains', 'maximumtimetablespeed', 'numberofmaintracks', 'countroadwaygatearms', 'countmastmountedflashinglight', 'revisiondate'];
for (const n of need) if (!(n in col)) throw new Error(`FRA CSV is missing column ${n}`);
const g = (r, n) => r[col[n]] ?? '';

const crossings = [];
let total = 0;
let closed = 0;
let noCoords = 0;
let latestRevision = '';
for (const r of rows) {
  if (r.length < header.length / 2) continue;
  total++;
  if (g(r, 'reasondescription') === 'Closed') {
    closed++;
    continue;
  }
  const lat = num(g(r, 'latitude'));
  const lon = num(g(r, 'longitude'));
  if (lat === null || lon === null || lat < 40 || lat > 49 || lon < -91 || lon > -81) {
    noCoords++;
    continue;
  }
  const rev = g(r, 'revisiondate').slice(0, 10);
  if (rev > latestRevision) latestRevision = rev;
  const gates = num(g(r, 'countroadwaygatearms')) ?? 0;
  const flashers = num(g(r, 'countmastmountedflashinglight')) ?? 0;
  crossings.push({
    id: g(r, 'crossingid'),
    lat: Math.round(lat * 1e6) / 1e6,
    lon: Math.round(lon * 1e6) / 1e6,
    pos: str(g(r, 'crossingposition')),
    type: str(g(r, 'crossingtype')),
    purpose: str(g(r, 'crossingpurpose')),
    rr: str(g(r, 'railroadcode')),
    rrName: str(g(r, 'railroadname')),
    street: str(g(r, 'street')) ?? str(g(r, 'highwayname')),
    city: str(g(r, 'cityname')),
    county: str(g(r, 'countyname')),
    subdiv: str(g(r, 'railroadsubdivision')),
    div: str(g(r, 'railroaddivision')),
    branch: str(g(r, 'branchname')),
    mp: str(g(r, 'railroadmilepostnumber')),
    day: num(g(r, 'totaldaylightthrutrains')),
    night: num(g(r, 'totalnighttimethrutrains')),
    switching: num(g(r, 'totalswitchingtrains')),
    transit: num(g(r, 'totaltransittrains')),
    maxSpeed: num(g(r, 'maximumtimetablespeed')),
    tracks: num(g(r, 'numberofmaintracks')),
    warn: gates > 0 ? 'gates' : flashers > 0 ? 'flashing lights' : 'passive (signs only)',
    noTraffic: g(r, 'reasondescription') === 'No Train Traffic' || undefined,
    rev,
  });
}
for (const c of crossings) for (const k of Object.keys(c)) if (c[k] === null || c[k] === undefined) delete c[k];

// ---------------- lines ----------------
const ACTIVE_NET = new Set(['M', 'O', 'Y', 'I', 'S']);
const narnFiles = readdirSync(narnDir).filter((f) => /\.geojson$/.test(f)).sort();
const lines = [];
const narnHashes = {};
let segTotal = 0;
let segInactive = 0;
for (const f of narnFiles) {
  const buf = readFileSync(path.join(narnDir, f));
  narnHashes[f] = sha256(buf);
  const fc = JSON.parse(buf.toString('utf8'));
  for (const feat of fc.features ?? []) {
    segTotal++;
    const p = feat.properties ?? {};
    if (!ACTIVE_NET.has(p.NET)) {
      segInactive++;
      continue;
    }
    const geoms = feat.geometry?.type === 'MultiLineString' ? feat.geometry.coordinates : [feat.geometry?.coordinates ?? []];
    for (const coords of geoms) {
      const pts = [];
      for (const [x, y] of coords) {
        const lon = Math.round(x * 1e5) / 1e5;
        const lat = Math.round(y * 1e5) / 1e5;
        const last = pts[pts.length - 1];
        if (!last || last[0] !== lon || last[1] !== lat) pts.push([lon, lat]);
      }
      if (pts.length < 2) continue;
      const rights = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => p[`TRKRGHTS${i}`]).filter(Boolean);
      const seg = {
        arc: p.FRAARCID,
        own: [p.RROWNER1, p.RROWNER2, p.RROWNER3].filter(Boolean),
        rights,
        div: str(p.DIVISION) ?? undefined,
        sub: str(p.SUBDIV) ?? undefined,
        branch: str(p.BRANCH) ?? undefined,
        yard: str(p.YARDNAME) ?? undefined,
        pass: p.PASSNGR ?? undefined,
        tracks: p.TRACKS ?? undefined,
        net: p.NET,
        county: p.STCNTYFIPS ?? undefined,
        c: pts,
      };
      for (const k of Object.keys(seg)) if (seg[k] === undefined || (Array.isArray(seg[k]) && !seg[k].length && k !== 'c')) delete seg[k];
      lines.push(seg);
    }
  }
}

mkdirSync(outDir, { recursive: true });
const cBuf = gzipSync(Buffer.from(JSON.stringify(crossings)), { level: 9 });
const lBuf = gzipSync(Buffer.from(JSON.stringify(lines)), { level: 9 });
writeFileSync(path.join(outDir, 'crossings.json.gz'), cBuf);
writeFileSync(path.join(outDir, 'lines.json.gz'), lBuf);
const meta = {
  built_at: new Date().toISOString(),
  license: 'Public domain: works of the U.S. Government (17 U.S.C. § 105); FRA dataset licence "Public Domain".',
  sources: {
    crossings: {
      name: 'FRA Crossing Inventory Data (Form 71) - Current',
      publisher: 'Federal Railroad Administration, Office of Safety',
      dataset: 'https://data.transportation.gov/Railroads/Crossing-Inventory-Data-Form-71-Current/m2f8-22s6',
      query: 'https://data.transportation.gov/resource/m2f8-22s6.csv?statename=MICHIGAN&$limit=50000',
      input_sha256: sha256(fraBuf),
      input_mtime: statSync(fraPath).mtime.toISOString(),
      rows: total,
      closed_excluded: closed,
      missing_or_bad_coordinates_excluded: noCoords,
      kept: crossings.length,
      latest_revision: latestRevision,
    },
    lines: {
      name: 'NTAD North American Rail Network Lines',
      publisher: 'U.S. DOT Bureau of Transportation Statistics / FRA',
      dataset: 'https://doi.org/10.21949/1528950',
      query:
        'https://services.arcgis.com/xOi1kZaI0eWDREZv/arcgis/rest/services/NTAD_North_American_Rail_Network_Lines/FeatureServer/0/query?where=STATEAB%3D%27MI%27&outFields=*&f=geojson',
      input_sha256: narnHashes,
      segments: segTotal,
      inactive_excluded: segInactive,
      kept: lines.length,
      active_net_codes: [...ACTIVE_NET],
      coordinate_precision: '1e-5 degrees (~1 m)',
    },
  },
};
writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
console.log(
  `crossings: ${crossings.length} kept of ${total} (${closed} closed, ${noCoords} without coordinates) -> ${(cBuf.length / 1024).toFixed(0)} KB`,
);
console.log(`lines: ${lines.length} kept of ${segTotal} segments (${segInactive} inactive) -> ${(lBuf.length / 1024).toFixed(0)} KB`);
