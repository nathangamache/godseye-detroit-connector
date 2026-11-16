/** Geometry helpers for the roads tools: boxes, polylines, distances, buffers. */
import { degreeBox, haversineM, pointToSegmentM } from '../../util/geo.js';

export interface Point {
  lat: number;
  lon: number;
}

/** [minLon, minLat, maxLon, maxLat] */
export type BBox = [number, number, number, number];

/** A vertex as GeoJSON orders it. */
export type LonLat = [number, number];

/** South-east Michigan, the area results are biased to (and road-only searches cover). */
export const SE_MICHIGAN: BBox = [-84.2, 41.7, -82.4, 43.2];
/** Windsor and Essex County, Ontario (Ontario 511 results are kept only inside it). */
export const WINDSOR_ESSEX: BBox = [-83.2, 41.6, -82.3, 42.45];
/** City of Detroit (the right-of-way permit layer covers only the city). */
export const DETROIT_CITY: BBox = [-83.29, 42.25, -82.91, 42.46];
/** Michigan (MDOT RIDE covers the state). */
export const MICHIGAN: BBox = [-90.5, 41.6, -82.1, 48.4];
/** Everything a road-only search covers: SE Michigan plus Windsor/Essex. */
export const COVERAGE: BBox = [-84.2, 41.6, -82.3, 43.2];

/**
 * Michigan's Lower Peninsula, coarsely (GeoJSON order): the Indiana and Ohio lines in the south,
 * the international border along the Detroit River, Lake St. Clair and the St. Clair River in
 * the east (within a few hundred metres), open water elsewhere. Only for telling a Michigan
 * place from one in Ontario, Ohio, Indiana or Wisconsin; the Upper Peninsula is left out, so a
 * place there is not taken for Michigan (texts about it are left as they are).
 */
const LOWER_MICHIGAN: LonLat[] = [
  [-87.0, 41.76],
  [-84.806, 41.76],
  [-84.806, 41.7],
  [-83.454, 41.733],
  [-83.1, 41.9],
  [-83.14, 42.03],
  [-83.13, 42.1],
  [-83.125, 42.15],
  [-83.125, 42.24],
  [-83.103, 42.282],
  [-83.074, 42.311],
  [-83.045, 42.3235],
  [-83.02, 42.328],
  [-82.975, 42.331],
  [-82.94, 42.35],
  [-82.65, 42.5],
  [-82.53, 42.58],
  [-82.515, 42.62],
  [-82.483, 42.72],
  [-82.47, 42.83],
  [-82.455, 42.91],
  [-82.42, 42.95],
  [-82.415, 42.985],
  [-82.42, 43.01],
  [-82.3, 43.3],
  [-82.4, 44.2],
  [-83.4, 45.5],
  [-84.0, 45.835],
  [-85.2, 45.835],
  [-85.8, 45.5],
  [-86.3, 45.0],
  [-86.6, 44.0],
  [-86.9, 43.0],
];

/** Even-odd ray test: is p inside the ring (GeoJSON order)? */
function inRing(p: LonLat, ring: LonLat[]): boolean {
  const [x, y] = p;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** In Michigan's Lower Peninsula (LOWER_MICHIGAN): not Windsor, Sarnia, Toledo or Wisconsin. */
export function inMichigan(p: LonLat): boolean {
  return inBox(p, MICHIGAN) && inRing(p, LOWER_MICHIGAN);
}

export function bboxAround(p: Point, radiusKm: number): BBox {
  const { dLat, dLon } = degreeBox(p.lat, radiusKm * 1000);
  return [p.lon - dLon, p.lat - dLat, p.lon + dLon, p.lat + dLat];
}

export function intersects(a: BBox, b: BBox): boolean {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

export function inBox(p: LonLat, b: BBox): boolean {
  return p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];
}

export function bboxCenter(b: BBox): Point {
  return { lat: (b[1] + b[3]) / 2, lon: (b[0] + b[2]) / 2 };
}

/** Approximate area of a lon/lat box in km². */
export function bboxAreaKm2(b: BBox): number {
  const midLat = ((b[1] + b[3]) / 2) * (Math.PI / 180);
  const w = (b[2] - b[0]) * 111.32 * Math.cos(midLat);
  const h = (b[3] - b[1]) * 110.57;
  return Math.abs(w * h);
}

/**
 * Trims a box to valid coordinates, [-180, 180] x [-90, 90]. A box around a point near the
 * antimeridian or a pole runs past them otherwise; the part beyond is dropped, not wrapped.
 */
export function clampToWorld(b: BBox): BBox {
  const lon = (v: number) => Math.min(180, Math.max(-180, v));
  const lat = (v: number) => Math.min(90, Math.max(-90, v));
  const out: BBox = [lon(b[0]), lat(b[1]), lon(b[2]), lat(b[3])];
  return out.every((v, i) => v === b[i]) ? b : out;
}

/** Shrinks a box around its centre until its area is at most maxKm2. */
export function clampBox(b: BBox, maxKm2: number): BBox {
  const area = bboxAreaKm2(b);
  if (area <= maxKm2) return b;
  const k = Math.sqrt(maxKm2 / area);
  const c = bboxCenter(b);
  const hw = ((b[2] - b[0]) / 2) * k;
  const hh = ((b[3] - b[1]) / 2) * k;
  return [c.lon - hw, c.lat - hh, c.lon + hw, c.lat + hh];
}

export function bboxOf(points: LonLat[], padKm = 0): BBox | undefined {
  if (!points.length) return undefined;
  let b: BBox = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of points)
    b = [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)];
  if (!padKm) return b;
  const { dLat, dLon } = degreeBox((b[1] + b[3]) / 2, padKm * 1000);
  return [b[0] - dLon, b[1] - dLat, b[2] + dLon, b[3] + dLat];
}

/** Decodes a Google-style encoded polyline (precision 5 for Ontario 511, 6 for Valhalla). */
export function decodePolyline(s: string, precision = 5, maxPoints = 20_000): LonLat[] {
  const factor = 10 ** precision;
  const out: LonLat[] = [];
  let i = 0;
  let lat = 0;
  let lon = 0;
  while (i < s.length && out.length < maxPoints) {
    const next = (): number | undefined => {
      let result = 0;
      let shift = 0;
      for (;;) {
        if (i >= s.length) return undefined;
        const b = s.charCodeAt(i++) - 63;
        if (b < 0 || b > 63) return undefined;
        result |= (b & 0x1f) << shift;
        shift += 5;
        if (b < 0x20) break;
        if (shift > 30) return undefined;
      }
      return result & 1 ? ~(result >> 1) : result >> 1;
    };
    const dLat = next();
    const dLon = next();
    if (dLat === undefined || dLon === undefined) break;
    lat += dLat;
    lon += dLon;
    out.push([lon / factor, lat / factor]);
  }
  return out;
}

/** Shortest distance (m) from a point to a polyline (a single vertex counts as a point). */
export function distanceToLineM(p: Point, line: LonLat[]): { distM: number; at: Point } {
  if (!line.length) return { distM: Infinity, at: p };
  if (line.length === 1) {
    const [lon, lat] = line[0]!;
    return { distM: haversineM(p.lat, p.lon, lat, lon), at: { lat, lon } };
  }
  let best = { distM: Infinity, at: p };
  for (let i = 1; i < line.length; i++) {
    const [aLon, aLat] = line[i - 1]!;
    const [bLon, bLat] = line[i]!;
    const r = pointToSegmentM(p.lat, p.lon, aLat, aLon, bLat, bLon);
    if (r.distM < best.distM) best = { distM: r.distM, at: { lat: r.lat, lon: r.lon } };
  }
  return best;
}

export function distanceToLinesM(p: Point, lines: LonLat[][]): { distM: number; at: Point } {
  let best = { distM: Infinity, at: p };
  for (const l of lines) {
    const r = distanceToLineM(p, l);
    if (r.distM < best.distM) best = r;
  }
  return best;
}

export function lineLengthM(line: LonLat[]): number {
  let m = 0;
  for (let i = 1; i < line.length; i++)
    m += haversineM(line[i - 1]![1], line[i - 1]![0], line[i]![1], line[i]![0]);
  return m;
}

/** The point halfway along a polyline. */
export function lineMidpoint(line: LonLat[]): Point {
  if (line.length === 1) return { lat: line[0]![1], lon: line[0]![0] };
  const half = lineLengthM(line) / 2;
  let run = 0;
  for (let i = 1; i < line.length; i++) {
    const [aLon, aLat] = line[i - 1]!;
    const [bLon, bLat] = line[i]!;
    const seg = haversineM(aLat, aLon, bLat, bLon);
    if (run + seg >= half && seg > 0) {
      const t = (half - run) / seg;
      return { lat: aLat + (bLat - aLat) * t, lon: aLon + (bLon - aLon) * t };
    }
    run += seg;
  }
  const [lon, lat] = line[line.length - 1]!;
  return { lat, lon };
}

/**
 * "northbound", "eastbound", ...: the way a line drawn in the direction of travel heads, first
 * vertex to last (the nearest of the four). Null for a point or a line whose ends are less than
 * minM apart (a loop, or too short to tell).
 */
export function travelDirection(line: LonLat[], minM = 30): string | null {
  if (line.length < 2) return null;
  const [aLon, aLat] = line[0]!;
  const [bLon, bLat] = line[line.length - 1]!;
  if (haversineM(aLat, aLon, bLat, bLon) < minM) return null;
  const k = Math.cos(((aLat + bLat) / 2) * (Math.PI / 180));
  // Degrees clockwise from north.
  const deg = ((Math.atan2((bLon - aLon) * k, bLat - aLat) * 180) / Math.PI + 360) % 360;
  return ['northbound', 'eastbound', 'southbound', 'westbound'][Math.round(deg / 90) % 4]!;
}

/** Points along a polyline at most stepM apart (vertices included). */
export function samplePoints(line: LonLat[], stepM: number, max = 500): Point[] {
  const out: Point[] = [];
  if (!line.length) return out;
  out.push({ lat: line[0]![1], lon: line[0]![0] });
  for (let i = 1; i < line.length && out.length < max; i++) {
    const [aLon, aLat] = line[i - 1]!;
    const [bLon, bLat] = line[i]!;
    const n = Math.min(50, Math.ceil(haversineM(aLat, aLon, bLat, bLon) / stepM));
    for (let k = 1; k <= n && out.length < max; k++)
      out.push({ lat: aLat + ((bLat - aLat) * k) / n, lon: aLon + ((bLon - aLon) * k) / n });
  }
  return out;
}

/** Spatial grid over a polyline's segments, for "is this point within X m of the route?". */
export class SegmentGrid {
  private cells = new Map<string, number[]>();
  private readonly cell: number;

  constructor(
    private readonly line: LonLat[],
    cellDeg = 0.003,
  ) {
    this.cell = cellDeg;
    for (let i = 1; i < line.length; i++) {
      const [aLon, aLat] = line[i - 1]!;
      const [bLon, bLat] = line[i]!;
      const x0 = Math.floor(Math.min(aLon, bLon) / cellDeg);
      const x1 = Math.floor(Math.max(aLon, bLon) / cellDeg);
      const y0 = Math.floor(Math.min(aLat, bLat) / cellDeg);
      const y1 = Math.floor(Math.max(aLat, bLat) / cellDeg);
      for (let x = x0; x <= x1 && x - x0 < 200; x++)
        for (let y = y0; y <= y1 && y - y0 < 200; y++) {
          const k = `${x}:${y}`;
          const arr = this.cells.get(k);
          if (arr) arr.push(i);
          else this.cells.set(k, [i]);
        }
    }
  }

  /** Distance (m) from p to the nearest segment in p's cell and its neighbours, else Infinity. */
  distanceM(p: Point): number {
    const cx = Math.floor(p.lon / this.cell);
    const cy = Math.floor(p.lat / this.cell);
    let best = Infinity;
    const seen = new Set<number>();
    for (let x = cx - 1; x <= cx + 1; x++)
      for (let y = cy - 1; y <= cy + 1; y++)
        for (const i of this.cells.get(`${x}:${y}`) ?? []) {
          if (seen.has(i)) continue;
          seen.add(i);
          const [aLon, aLat] = this.line[i - 1]!;
          const [bLon, bLat] = this.line[i]!;
          best = Math.min(best, pointToSegmentM(p.lat, p.lon, aLat, aLon, bLat, bLon).distM);
        }
    return best;
  }
}

/**
 * A closed ring (GeoJSON order) around one segment: a rectangle halfWidthM either side,
 * extended by halfWidthM past both ends. A single point becomes a square.
 */
export function segmentRing(a: LonLat, b: LonLat, halfWidthM: number): LonLat[] {
  const lat0 = ((a[1] + b[1]) / 2) * (Math.PI / 180);
  const mx = 111_320 * Math.cos(lat0);
  const my = 110_570;
  let dx = (b[0] - a[0]) * mx;
  let dy = (b[1] - a[1]) * my;
  let len = Math.hypot(dx, dy);
  if (len < 1) {
    dx = 1;
    dy = 0;
    len = 1;
  }
  const ux = dx / len;
  const uy = dy / len;
  const h = halfWidthM;
  const corner = (p: LonLat, along: number, side: number): LonLat => [
    p[0] + (ux * along - uy * side) / mx,
    p[1] + (uy * along + ux * side) / my,
  ];
  const ring = [corner(a, -h, -h), corner(b, h, -h), corner(b, h, h), corner(a, -h, h)];
  return [...ring, ring[0]!].map(([x, y]) => [round6(x), round6(y)] as LonLat);
}

export function ringPerimeterM(ring: LonLat[]): number {
  return lineLengthM(ring);
}

export const round6 = (v: number) => Math.round(v * 1e6) / 1e6;
export const round4 = (v: number) => Math.round(v * 1e4) / 1e4;
