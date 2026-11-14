/**
 * Rail spatial index over NARN line segments and FRA grade crossings (Michigan).
 * Flatbush indexes line bounding boxes and crossing points; exact distances use
 * a local projection (src/util/geo.ts).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import Flatbush from 'flatbush';
import { bearingDeg, compassPoint, degreeBox, haversineM, pointToSegmentM } from '../util/geo.js';

export interface Crossing {
  id: string;
  lat: number;
  lon: number;
  pos?: string;
  type?: string;
  purpose?: string;
  rr?: string;
  rrName?: string;
  street?: string;
  city?: string;
  county?: string;
  subdiv?: string;
  div?: string;
  branch?: string;
  mp?: string;
  day?: number;
  night?: number;
  switching?: number;
  transit?: number;
  maxSpeed?: number;
  tracks?: number;
  warn?: string;
  noTraffic?: boolean;
  rev?: string;
}

export interface LineSeg {
  arc: number;
  own?: string[];
  rights?: string[];
  div?: string;
  sub?: string;
  branch?: string;
  yard?: string;
  pass?: string;
  tracks?: number;
  net: string;
  c: Array<[number, number]>; // [lon, lat]
}

export interface RailMeta {
  built_at: string;
  sources: {
    crossings: { latest_revision?: string; kept: number; dataset: string };
    lines: { kept: number; dataset: string };
  };
}

/** NARN owner/trackage-rights codes (AAR reporting marks) seen in Michigan. */
export const RAILROAD_NAMES: Record<string, string> = {
  CN: 'Canadian National',
  CSXT: 'CSX Transportation',
  CSAO: 'Conrail Shared Assets Operations',
  HESR: 'Huron & Eastern Railway',
  NS: 'Norfolk Southern',
  LSRC: 'Lake State Railway',
  GLC: 'Great Lakes Central Railroad',
  GDLK: 'Grand Elk Railroad',
  PVTX: 'private (industrial)',
  MQT: 'Marquette Rail',
  ELS: 'Escanaba & Lake Superior Railroad',
  AMTK: 'Amtrak',
  LSI: 'Lake Superior & Ishpeming Railroad',
  MS: 'Michigan Shore Railroad',
  IN: 'Indiana Northeastern Railroad',
  MMRR: 'Mid-Michigan Railroad',
  AA: 'Ann Arbor Railroad',
  JAIL: 'Jackson & Lansing Railroad',
  GR: 'Grand Rapids Eastern Railroad',
  DC: 'Delray Connecting Railroad',
  MSO: 'Michigan Southern Railroad',
  ADBF: 'Adrian & Blissfield Railroad',
  MRA: 'Mineral Range',
  IORY: 'Indiana & Ohio Railway',
  WMI: 'West Michigan Railroad',
  DCON: 'Detroit Connecting Railroad',
  HNW: 'Hamilton Northwestern Railroad',
  LIRR: 'Lapeer Industrial Railroad',
  CPMY: 'Coopersville & Marne Railroad',
  SMRS: 'Southern Michigan Railroad',
  CPKC: 'CPKC (Canadian Pacific Kansas City)',
  CHS: 'Charlotte Southern Railroad',
  USG: 'U.S. Government',
  SBS: 'South Branch Scenic Railroad',
  XXXX: 'unknown',
};

const NET_LABEL: Record<string, string> = {
  M: 'main line',
  O: 'other line',
  Y: 'yard track',
  I: 'industrial track',
  S: 'siding or spur',
};

const PASSENGER_LABEL: Record<string, string> = { A: 'Amtrak', T: 'tourist/transit', C: 'commuter' };

export function railroadName(code?: string): string | undefined {
  if (!code) return undefined;
  const n = RAILROAD_NAMES[code];
  return n ? `${n} (${code})` : code;
}

export interface NearestLine {
  railroad?: string;
  owners: string[];
  trackage_rights: string[];
  subdivision?: string;
  division?: string;
  branch?: string;
  yard?: string;
  kind: string;
  passenger?: string;
  tracks?: number;
  distance_m: number;
  bearing_deg: number;
  direction: string;
  closest_point: { lat: number; lon: number };
  narn_arc_id: number;
}

export interface CrossingHit {
  fra_crossing_id: string;
  street?: string;
  city?: string;
  county?: string;
  railroad?: string;
  railroad_code?: string;
  subdivision?: string;
  milepost?: string;
  position?: string;
  crossing_type?: string;
  warning_devices?: string;
  trains_per_day?: number;
  train_counts?: { day_thru?: number; night_thru?: number; switching?: number; transit?: number };
  max_timetable_speed_mph?: number;
  main_tracks?: number;
  no_train_traffic?: boolean;
  distance_m: number;
  bearing_deg: number;
  direction: string;
  lat: number;
  lon: number;
  fra_record_revised?: string;
  fra_url: string;
}

export class RailIndex {
  private readonly lineIdx: Flatbush;
  private readonly xIdx: Flatbush;

  constructor(
    readonly lines: LineSeg[],
    readonly crossings: Crossing[],
    readonly meta: RailMeta,
  ) {
    this.lineIdx = new Flatbush(Math.max(1, lines.length));
    for (const l of lines) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [x, y] of l.c) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      this.lineIdx.add(minX, minY, maxX, maxY);
    }
    if (!lines.length) this.lineIdx.add(0, 0, 0, 0);
    this.lineIdx.finish();
    this.xIdx = new Flatbush(Math.max(1, crossings.length));
    for (const c of crossings) this.xIdx.add(c.lon, c.lat, c.lon, c.lat);
    if (!crossings.length) this.xIdx.add(0, 0, 0, 0);
    this.xIdx.finish();
  }

  static load(dir: string): RailIndex {
    const read = (f: string) => JSON.parse(gunzipSync(readFileSync(path.join(dir, f))).toString('utf8'));
    const meta = JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8')) as RailMeta;
    return new RailIndex(read('lines.json.gz') as LineSeg[], read('crossings.json.gz') as Crossing[], meta);
  }

  datasetAsOf(): string | undefined {
    return this.meta.sources.crossings.latest_revision;
  }

  nearestLine(lat: number, lon: number, maxM = 50_000, filter?: (s: LineSeg) => boolean): NearestLine | undefined {
    for (const r of [1000, 5000, 20_000, maxM]) {
      if (r > maxM) break;
      const { dLat, dLon } = degreeBox(lat, r);
      const ids = this.lineIdx.search(lon - dLon, lat - dLat, lon + dLon, lat + dLat);
      let best: { seg: LineSeg; d: number; p: { lat: number; lon: number } } | undefined;
      for (const i of ids) {
        const seg = this.lines[i];
        if (!seg || (filter && !filter(seg))) continue;
        for (let k = 1; k < seg.c.length; k++) {
          const [ax, ay] = seg.c[k - 1]!;
          const [bx, by] = seg.c[k]!;
          const res = pointToSegmentM(lat, lon, ay, ax, by, bx);
          if (!best || res.distM < best.d) best = { seg, d: res.distM, p: { lat: res.lat, lon: res.lon } };
        }
      }
      if (best && best.d <= r) {
        const s = best.seg;
        const brg = bearingDeg(lat, lon, best.p.lat, best.p.lon);
        return {
          railroad: railroadName(s.own?.[0]),
          owners: (s.own ?? []).map((o) => railroadName(o)!),
          trackage_rights: (s.rights ?? []).map((o) => railroadName(o)!),
          subdivision: s.sub,
          division: s.div,
          branch: s.branch,
          yard: s.yard,
          kind: NET_LABEL[s.net] ?? s.net,
          passenger: s.pass ? (PASSENGER_LABEL[s.pass] ?? s.pass) : undefined,
          tracks: s.tracks,
          distance_m: Math.round(best.d),
          bearing_deg: Math.round(brg),
          direction: compassPoint(brg),
          closest_point: { lat: round5(best.p.lat), lon: round5(best.p.lon) },
          narn_arc_id: s.arc,
        };
      }
    }
    return undefined;
  }

  /** Nearest main-line track (NARN NET=M), useful when the closest track is a spur or yard. */
  nearestMainLine(lat: number, lon: number, maxM = 50_000): NearestLine | undefined {
    return this.nearestLine(lat, lon, maxM, (s) => s.net === 'M');
  }

  crossingsNear(
    lat: number,
    lon: number,
    radiusM: number,
    opts: { atGradeOnly?: boolean; limit?: number } = {},
  ): CrossingHit[] {
    const { dLat, dLon } = degreeBox(lat, radiusM);
    const ids = this.xIdx.search(lon - dLon, lat - dLat, lon + dLon, lat + dLat);
    const hits: CrossingHit[] = [];
    for (const i of ids) {
      const c = this.crossings[i];
      if (!c) continue;
      if (opts.atGradeOnly && c.pos !== 'At Grade') continue;
      const d = haversineM(lat, lon, c.lat, c.lon);
      if (d > radiusM) continue;
      hits.push(toHit(c, lat, lon, d));
    }
    hits.sort((a, b) => a.distance_m - b.distance_m);
    return hits.slice(0, opts.limit ?? 25);
  }

  nearestCrossing(lat: number, lon: number, maxM = 50_000): CrossingHit | undefined {
    for (const r of [500, 2000, 10_000, maxM]) {
      if (r > maxM) break;
      const hits = this.crossingsNear(lat, lon, r, { atGradeOnly: true, limit: 1 });
      if (hits.length) return hits[0];
    }
    return undefined;
  }
}

function round5(v: number): number {
  return Math.round(v * 1e5) / 1e5;
}

function toHit(c: Crossing, lat: number, lon: number, d: number): CrossingHit {
  const counts = { day_thru: c.day, night_thru: c.night, switching: c.switching, transit: c.transit };
  const anyCount = Object.values(counts).some((v) => typeof v === 'number');
  const perDay = anyCount ? (c.day ?? 0) + (c.night ?? 0) + (c.switching ?? 0) + (c.transit ?? 0) : undefined;
  const brg = bearingDeg(lat, lon, c.lat, c.lon);
  return {
    fra_crossing_id: c.id,
    street: c.street,
    city: c.city,
    county: c.county,
    railroad: c.rrName,
    railroad_code: c.rr,
    subdivision: c.subdiv,
    milepost: c.mp,
    position: c.pos,
    crossing_type: c.type,
    warning_devices: c.warn,
    trains_per_day: perDay,
    train_counts: anyCount ? counts : undefined,
    max_timetable_speed_mph: c.maxSpeed || undefined,
    main_tracks: c.tracks,
    no_train_traffic: c.noTraffic,
    distance_m: Math.round(d),
    bearing_deg: Math.round(brg),
    direction: compassPoint(brg),
    lat: c.lat,
    lon: c.lon,
    fra_record_revised: c.rev,
    fra_url: `https://safetydata.fra.dot.gov/OfficeofSafety/PublicSite/Crossing/Crossing.aspx?phasetype=C&rpttype=I&txtcrossingnum=${encodeURIComponent(c.id)}`,
  };
}
