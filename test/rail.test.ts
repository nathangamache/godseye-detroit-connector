import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT, loadConfig } from '../src/config.js';
import { RailIndex } from '../src/rail/index.js';
import { railTools, titleCase } from '../src/rail/tools.js';
import { ToolPolicy } from '../src/tools/policy.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { ToolDef } from '../src/tools/types.js';
import { bearingDeg, haversineM, pointToSegmentM } from '../src/util/geo.js';
import { ANN_ARBOR, BELLE_ISLE, DETROIT } from './helpers.js';

let index: RailIndex;
let tools: Record<string, ToolDef>;
const sig = () => ({ signal: new AbortController().signal });

beforeAll(() => {
  index = RailIndex.load(path.join(REPO_ROOT, 'data', 'rail'));
  tools = Object.fromEntries(railTools(index).map((t) => [t.name, t]));
});

describe('formatting', () => {
  it('keeps railroad marks upper case when title-casing', () => {
    expect(titleCase('MICHIGAN LINE (NS)')).toBe('Michigan Line (NS)');
    expect(titleCase('DETROIT')).toBe('Detroit');
  });
});

describe('geo helpers', () => {
  it('distances and bearings', () => {
    // Downtown Detroit to Ann Arbor center is ~58 km, almost due west.
    const d = haversineM(DETROIT.lat, DETROIT.lon, ANN_ARBOR.lat, ANN_ARBOR.lon);
    expect(d).toBeGreaterThan(55_000);
    expect(d).toBeLessThan(60_000);
    const b = bearingDeg(DETROIT.lat, DETROIT.lon, ANN_ARBOR.lat, ANN_ARBOR.lon);
    expect(b).toBeGreaterThan(255);
    expect(b).toBeLessThan(275);
    const s = pointToSegmentM(0, 0.001, -1, 0, 1, 0);
    expect(s.distM).toBeGreaterThan(100);
    expect(s.distM).toBeLessThan(120);
  });
});

describe('rail index (public fixture points)', () => {
  it('loads the Michigan datasets', () => {
    expect(index.crossings.length).toBeGreaterThan(5000);
    expect(index.lines.length).toBeGreaterThan(4000);
    expect(index.datasetAsOf()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('Downtown Detroit: CPKC Windsor Sub nearest, Rivard St crossing', async () => {
    const r = await tools.nearest_rail!.run({ lat: DETROIT.lat, lon: DETROIT.lon }, sig());
    const data = r.data as {
      line: { railroad: string; distance_m: number };
      main_line: unknown;
      crossing: Record<string, unknown>;
    };
    expect(data.line.railroad).toMatch(/CPKC/);
    expect(data.line.distance_m).toBeLessThan(2000);
    expect(data.crossing).toMatchObject({
      fra_crossing_id: '284190P',
      street: 'RIVARD STREET',
      railroad: 'Adrian & Blissfield Railroad',
      position: 'At Grade',
    });
    expect(data.crossing.trains_per_day).toBeGreaterThan(0);
    expect(data.crossing.distance_m).toBeGreaterThan(300);
    expect(data.crossing.distance_m).toBeLessThan(1500);
    expect(data.crossing.direction).toMatch(/^E/);
    expect(r.summary).toMatch(/FRA 284190P at RIVARD STREET/);
  });

  it('Ann Arbor: Ann Arbor Railroad crossings downtown, NS/Amtrak Michigan Line nearby', async () => {
    const r = await tools.crossings_near!.run(
      { lat: ANN_ARBOR.lat, lon: ANN_ARBOR.lon, radius_km: 1, at_grade_only: true },
      sig(),
    );
    const hits = (r.data as { crossings: Array<Record<string, unknown>> }).crossings;
    const liberty = hits.find((c) => c.fra_crossing_id === '000223R');
    expect(liberty).toMatchObject({
      street: 'WEST LIBERTY STREET',
      railroad: 'Ann Arbor Railroad',
      position: 'At Grade',
    });
    expect(hits.every((c) => (c.distance_m as number) <= 1000)).toBe(true);
    const sorted = hits.map((c) => c.distance_m as number);
    expect([...sorted].sort((a, b) => a - b)).toEqual(sorted);
    const line = index.nearestLine(ANN_ARBOR.lat, ANN_ARBOR.lon)!;
    expect(line.owners.join(' ')).toMatch(/Amtrak|Norfolk Southern|Ann Arbor/);
  });

  it('Belle Isle: no track on the island, Conrail is the nearest line', () => {
    const line = index.nearestLine(BELLE_ISLE.lat, BELLE_ISLE.lon)!;
    expect(line.distance_m).toBeGreaterThan(2000);
    expect(line.railroad).toMatch(/Conrail/);
  });

  it('outside Michigan coverage returns a clear message', async () => {
    const r = await tools.nearest_rail!.run({ lat: 40.0, lon: -100.0, max_km: 50 }, sig());
    expect(r.summary).toMatch(/Michigan only/);
  });

  it('find_tools("train crossing") ranks nearest_rail first with the real descriptions', () => {
    const reg = new ToolRegistry(new ToolPolicy(loadConfig({})));
    for (const t of railTools(index)) reg.register(t);
    const names = reg.find('train crossing', 8).map((h) => h.tool.name);
    expect(names[0]).toBe('nearest_rail');
    expect(names).toContain('crossings_near');
  });
});

/** Public FRA crossings in Detroit (the inventory's own coordinates). */
const MICHIGAN_AVE_UNDERPASS = { lat: 42.33124, lon: -83.10291 }; // FRA 283998C, RR Over
const AMTRAK_STATION_CROSSING = { lat: 42.367673, lon: -83.07264 }; // FRA 968840K, at grade

describe('crossings of any kind vs at grade, and FRA vs NARN attributes', () => {
  it('nearest_rail labels the nearest crossing of any kind (with its separation) and the nearest at grade', async () => {
    const p = MICHIGAN_AVE_UNDERPASS;
    const r = await tools.nearest_rail!.run({ lat: p.lat, lon: p.lon }, sig());
    const data = r.data as {
      crossing: Record<string, unknown>;
      nearest_crossing_any_kind: Record<string, unknown>;
    };
    expect(data.nearest_crossing_any_kind).toMatchObject({
      fra_crossing_id: '283998C',
      position: 'RR Over',
      grade_separated: true,
      separation: 'road under the tracks',
    });
    expect(data.crossing.position).toBe('At Grade');
    expect(data.crossing.grade_separated).toBe(false);
    expect(data.crossing.fra_crossing_id).not.toBe('283998C');
    expect(r.summary).toMatch(
      /Nearest crossing of any kind: FRA 283998C at MICHIGAN AVE, DETROIT \([^)]*\), \d+ m [NESW]+; grade-separated: road under the tracks \(FRA position "RR Over"\)/,
    );
    expect(r.summary).toMatch(/Nearest at-grade crossing: FRA \w+ /);
    // Where it is at grade anyway, one crossing answers both.
    const d = await tools.nearest_rail!.run({ lat: DETROIT.lat, lon: DETROIT.lon }, sig());
    expect(d.summary).toMatch(
      /Nearest crossing of any kind is also the nearest at-grade crossing: FRA 284190P at RIVARD STREET/,
    );
    expect(
      (d.data as { nearest_crossing_any_kind: { fra_crossing_id: string } })
        .nearest_crossing_any_kind.fra_crossing_id,
    ).toBe('284190P');
  });

  it('shows both datasets, labelled, when FRA and NARN disagree on the track count', async () => {
    const p = AMTRAK_STATION_CROSSING;
    const c = index.crossingsNear(p.lat, p.lon, 50, { limit: 1 })[0]!;
    expect(c.fra_crossing_id).toBe('968840K');
    expect(c.main_tracks).toBe(2);
    expect(c.narn_tracks).toBe(1);
    expect(c.track_counts).toEqual({
      narn_tracks: 1,
      fra_main_tracks: 2,
      agree: false,
      text: 'NARN: 1 track; FRA: 2 main tracks',
    });
    const r = await tools.crossings_near!.run({ lat: p.lat, lon: p.lon, radius_km: 0.2 }, sig());
    expect(r.summary).toMatch(/FRA 968840K at AMTRAK STATION .*NARN: 1 track; FRA: 2 main tracks/);
    const near = await tools.nearest_rail!.run({ lat: p.lat, lon: p.lon }, sig());
    expect(near.summary).toMatch(
      /Nearest crossing of any kind is also the nearest at-grade crossing: FRA 968840K .*NARN: 1 track; FRA: 2 main tracks/,
    );
    // The line: NARN's count for the segment, FRA's from a crossing on that same segment.
    const line = (near.data as { line: { track_counts?: { text: string; agree: boolean } } }).line;
    expect(line.track_counts).toMatchObject({
      agree: false,
      text: 'NARN: 1 track; FRA: 2 main tracks',
    });
    expect(near.summary).toMatch(/Nearest active rail line: .*NARN: 1 track; FRA: 2 main tracks/);
  });

  it('crossings_near names the nearest of any kind and the nearest at grade, each labelled', async () => {
    const p = MICHIGAN_AVE_UNDERPASS;
    const r = await tools.crossings_near!.run({ lat: p.lat, lon: p.lon, radius_km: 1 }, sig());
    const hits = (r.data as { crossings: Array<Record<string, unknown>> }).crossings;
    expect(hits[0]).toMatchObject({ fra_crossing_id: '283998C', grade_separated: true });
    expect(
      hits
        .filter((h) => h.position === 'RR Under')
        .every((h) => h.separation === 'road over the tracks'),
    ).toBe(true);
    expect(r.summary).toMatch(
      /^\d+ crossing\(s\) within 1 km \(\d+ at grade, \d+ grade-separated\); nearest of any kind: FRA 283998C at MICHIGAN AVE \(.*\), \d+ m [NESW]+, grade-separated: road under the tracks \[NARN: 1 track; FRA: 2 main tracks\]; nearest at-grade: FRA \w+ at /,
    );
    const only = await tools.crossings_near!.run(
      { lat: p.lat, lon: p.lon, radius_km: 1, at_grade_only: true },
      sig(),
    );
    expect(only.summary).toMatch(/^\d+ at-grade crossing\(s\) within 1 km; nearest at-grade: FRA /);
    expect(only.summary).not.toMatch(/any kind/);
  });
});
