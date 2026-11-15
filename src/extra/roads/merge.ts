/**
 * One closed stretch, one item. Sources report a closure once per direction (TomTom: "closed
 * between A and B", then "between B and A"); road_closures shows such reports as one item with
 * direction "both directions". Two reports of the same source, kind and type (and the same
 * description, apart from direction words) are the same stretch when they are between the same
 * cross streets, in either order, within 300 m of each other, and either on the same named road
 * or, when a road is not named (TomTom often names none), with at least 70% of each within 60 m
 * of the other, as a divided road's two carriageways are; parallel streets closed between the
 * same two cross streets stay apart. Without matching cross streets, their lines must overlap:
 * at least 70% of each within 25 m of the other. The merged item keeps every report's geometry,
 * so a route along either carriageway still meets it.
 */
import type { RoadItem } from './closures.js';
import {
  bboxOf,
  distanceToLinesM,
  intersects,
  lineLengthM,
  samplePoints,
  type BBox,
  type LonLat,
} from './geo.js';
import { normRoad } from './text.js';

/** Two lines are on one stretch where they lie within this of each other. */
export const SAME_STRETCH_M = 25;
/** Share of each line that must lie on the other. */
export const SAME_STRETCH_SHARE = 0.7;
/** Reports between the same cross streets must still be this close (box to box) to be one. */
const CROSS_STREET_NEAR_M = 300;
/**
 * Reports between the same cross streets, on roads not both named and the same, must lie this
 * close along most of their length: wide enough for a divided road's two carriageways, narrower
 * than a city block, so two parallel streets are never taken for one.
 */
export const CARRIAGEWAYS_M = 60;
/** Lines shorter than this (points, mostly) are merged only by their cross streets. */
const MIN_LINE_M = 30;

export const BOTH_DIRECTIONS = 'both directions';

const DIRECTION_WORDS =
  /\b(?:north|south|east|west)[ -]?bound\b|\b(?:nb|sb|eb|wb)\b|\bboth directions\b|\b(?:north|south|east|west)\b/g;

function textKey(s: string): string {
  return normRoad(s.toLowerCase().replace(DIRECTION_WORDS, ' '));
}

/** "Northbound", "NB", "north" -> "n"; "Both Directions" -> "both"; else the text itself. */
function directionKey(d: string): string {
  const t = d.toLowerCase().trim();
  if (/both/.test(t)) return 'both';
  const m = /^(north|south|east|west)|^([nsew])b$/.exec(t);
  return m ? (m[1] ?? m[2]!).charAt(0) : t;
}

/** What the comparisons need of an item, worked out once (a city-wide search compares many). */
interface Facts {
  box: BBox | undefined;
  len: number;
  road: string | null;
  desc: string | null;
  cross: [string, string] | undefined;
}

const facts = new WeakMap<RoadItem, Facts>();
function factsOf(it: RoadItem): Facts {
  let f = facts.get(it);
  if (!f) {
    const from = it.from_cross_street ? normRoad(it.from_cross_street) : '';
    const to = it.to_cross_street ? normRoad(it.to_cross_street) : '';
    f = {
      box: bboxOf(it.lines.flat()),
      len: it.lines.reduce((m, l) => m + lineLengthM(l), 0),
      road: it.road ? normRoad(it.road) : null,
      desc: it.description ? textKey(it.description) : null,
      cross: from && to && from !== to ? [from, to] : undefined,
    };
    facts.set(it, f);
  }
  return f;
}

function padded(b: BBox, m: number): BBox {
  const dLat = m / 111_320;
  const dLon = m / (111_320 * Math.max(0.1, Math.cos(((b[1] + b[3]) / 2) * (Math.PI / 180))));
  return [b[0] - dLon, b[1] - dLat, b[2] + dLon, b[3] + dLat];
}

/**
 * The share of a's length (sampled every 10 m) that lies within tolM of b. An item that is only
 * points (one-vertex lines) is sampled at its points.
 */
function shareOn(a: LonLat[][], b: LonLat[][], tolM: number): number {
  let pts = a.flatMap((l) => (l.length > 1 ? samplePoints(l, 10, 400) : []));
  if (!pts.length) pts = a.flat().map(([lon, lat]) => ({ lat, lon }));
  if (!pts.length) return 0;
  let on = 0;
  for (const p of pts) if (distanceToLinesM(p, b).distM <= tolM) on++;
  return on / pts.length;
}

/** At least SAME_STRETCH_SHARE of each lies within tolM of the other. */
function runTogether(a: LonLat[][], b: LonLat[][], tolM: number): boolean {
  return shareOn(a, b, tolM) >= SAME_STRETCH_SHARE && shareOn(b, a, tolM) >= SAME_STRETCH_SHARE;
}

export function sameStretch(a: RoadItem, b: RoadItem): boolean {
  // Same source, kind and type, and nothing that tells them apart (road, description).
  if (a.source !== b.source || a.kind !== b.kind || a.type !== b.type) return false;
  if (a.full_closure !== b.full_closure || Boolean(a.dateOnly) !== Boolean(b.dateOnly))
    return false;
  const fa = factsOf(a);
  const fb = factsOf(b);
  if (!fa.box || !fb.box) return false;
  // Within CROSS_STREET_NEAR_M of each other in all: one box padded, not both.
  if (!intersects(padded(fa.box, CROSS_STREET_NEAR_M), fb.box)) return false;
  if (fa.road && fb.road && fa.road !== fb.road) return false;
  if (fa.desc && fb.desc && fa.desc !== fb.desc) return false;
  // Between the same two cross streets, in either order: enough on one named road; otherwise
  // the lines must run together, as a divided road's carriageways do and parallel streets don't.
  if (fa.cross && fb.cross) {
    const [x, y] = fa.cross;
    const [u, v] = fb.cross;
    if ((x === u && y === v) || (x === v && y === u)) {
      const oneRoad = Boolean(fa.road) && fa.road === fb.road;
      return oneRoad || runTogether(a.lines, b.lines, CARRIAGEWAYS_M);
    }
  }
  if (fa.len < MIN_LINE_M || fb.len < MIN_LINE_M) return false;
  if (!intersects(padded(fa.box, SAME_STRETCH_M), fb.box)) return false;
  return runTogether(a.lines, b.lines, SAME_STRETCH_M);
}

/** The heading of an item's longest line (first vertex to last), in local metres. */
function heading(it: RoadItem): [number, number] | undefined {
  const l = it.lines.reduce<LonLat[] | undefined>(
    (best, x) => (!best || lineLengthM(x) > lineLengthM(best) ? x : best),
    undefined,
  );
  if (!l || l.length < 2 || lineLengthM(l) < MIN_LINE_M) return undefined;
  const [aLon, aLat] = l[0]!;
  const [bLon, bLat] = l[l.length - 1]!;
  const k = Math.cos(((aLat + bLat) / 2) * (Math.PI / 180));
  return [(bLon - aLon) * k, bLat - aLat];
}

/** The two reports run opposite ways: swapped cross streets, or lines pointing apart. */
function opposite(a: RoadItem, b: RoadItem): boolean {
  if (
    a.from_cross_street &&
    a.to_cross_street &&
    normRoad(a.from_cross_street) === normRoad(b.to_cross_street ?? '') &&
    normRoad(a.to_cross_street) === normRoad(b.from_cross_street ?? '') &&
    normRoad(a.from_cross_street) !== normRoad(a.to_cross_street)
  )
    return true;
  const ha = heading(a);
  const hb = heading(b);
  if (!ha || !hb) return false;
  const cos = (ha[0] * hb[0] + ha[1] * hb[1]) / (Math.hypot(...ha) * Math.hypot(...hb));
  return cos < -0.5;
}

function mergedDirection(c: RoadItem[]): string | null {
  const known = c.map((m) => m.direction).filter((d): d is string => Boolean(d));
  const keys = new Set(known.map(directionKey));
  if (keys.has('both') || keys.size >= 2) return BOTH_DIRECTIONS;
  for (let i = 0; i < c.length; i++)
    for (let j = i + 1; j < c.length; j++) if (opposite(c[i]!, c[j]!)) return BOTH_DIRECTIONS;
  // The same direction reported twice: a duplicate, not both directions.
  return known[0] ?? null;
}

function joined(vals: Array<string | null>): string | null {
  const seen = [...new Set(vals.filter((v): v is string => Boolean(v)))];
  return seen.length ? seen.join('; ') : null;
}

const earliest = (vals: Array<string | null>) =>
  vals.filter((v): v is string => Boolean(v)).sort()[0] ?? null;
const latest = (vals: Array<string | null>) =>
  vals
    .filter((v): v is string => Boolean(v))
    .sort()
    .pop() ?? null;

function combine(c: RoadItem[]): RoadItem {
  const first = c[0]!;
  const named = c.find((m) => m.resolveRoad);
  const direction = mergedDirection(c);
  const why =
    direction === BOTH_DIRECTIONS
      ? `${c.length} reports of this stretch (one per direction) merged`
      : `${c.length} reports of this stretch merged`;
  return {
    ...first,
    id: c.map((m) => m.id).join('+'),
    road: c.find((m) => m.road)?.road ?? null,
    direction,
    lanes: joined(c.map((m) => m.lanes)),
    vehicle_impact: joined(c.map((m) => m.vehicle_impact)),
    description: c.find((m) => m.description)?.description ?? null,
    from_cross_street: c.find((m) => m.from_cross_street)?.from_cross_street ?? null,
    to_cross_street: c.find((m) => m.to_cross_street)?.to_cross_street ?? null,
    start: earliest(c.map((m) => m.start)),
    end: c.some((m) => !m.end) ? null : latest(c.map((m) => m.end)),
    updated: latest(c.map((m) => m.updated)),
    lines: c.flatMap((m) => m.lines),
    primaryLines: first.primaryLines ?? first.lines,
    resolveRoad: named?.resolveRoad,
    roadCredit: named?.roadCredit,
    merged: c.reduce((n, m) => n + (m.merged ?? 1), 0),
    note: [first.note, why].filter(Boolean).join('; '),
  };
}

/** Grid cells (about 1 km) that a box covers; a huge box goes in one shared list instead. */
const CELL_DEG = 0.01;
const MAX_CELLS = 400;
function cellsOf(b: BBox): string[] | undefined {
  const x0 = Math.floor(b[0] / CELL_DEG);
  const x1 = Math.floor(b[2] / CELL_DEG);
  const y0 = Math.floor(b[1] / CELL_DEG);
  const y1 = Math.floor(b[3] / CELL_DEG);
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_CELLS) return undefined;
  const out: string[] = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push(`${x}:${y}`);
  return out;
}

/**
 * Folds the reports of one stretch into one item; order follows each stretch's first report.
 * Only reports of the same source, kind and type whose boxes are near each other are compared.
 */
export function mergeDirections(items: RoadItem[]): RoadItem[] {
  type Index = { cells: Map<string, Set<RoadItem[]>>; big: Set<RoadItem[]> };
  const groups = new Map<string, Index>();
  const clusters: RoadItem[][] = [];
  for (const it of items) {
    const key = `${it.source}|${it.kind}|${it.type}|${it.full_closure}`;
    let idx = groups.get(key);
    if (!idx) groups.set(key, (idx = { cells: new Map(), big: new Set() }));
    const box = factsOf(it).box;
    const cells = box ? cellsOf(padded(box, CROSS_STREET_NEAR_M)) : undefined;
    const near = new Set<RoadItem[]>(idx.big);
    if (cells) for (const c of cells) for (const cl of idx.cells.get(c) ?? []) near.add(cl);
    else for (const set of idx.cells.values()) for (const cl of set) near.add(cl);
    let home: RoadItem[] | undefined;
    for (const cl of near)
      if (cl.some((m) => sameStretch(m, it))) {
        home = cl;
        break;
      }
    if (home) home.push(it);
    else clusters.push((home = [it]));
    if (!box) continue;
    if (!cells) idx.big.add(home);
    else
      for (const c of cells) {
        let set = idx.cells.get(c);
        if (!set) idx.cells.set(c, (set = new Set()));
        set.add(home);
      }
  }
  return clusters.map((c) => (c.length === 1 ? c[0]! : combine(c)));
}
