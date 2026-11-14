import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT, loadConfig } from '../src/config.js';
import { RailIndex } from '../src/rail/index.js';
import { railTools, titleCase } from '../src/rail/tools.js';
import { ToolPolicy } from '../src/tools/policy.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { ToolDef } from '../src/tools/types.js';
import { bearingDeg, haversineM, pointToSegmentM } from '../src/util/geo.js';
import { ANN_ARBOR, LTU_SOUTHFIELD, PLYMOUTH } from './helpers.js';

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
    expect(titleCase('PLYMOUTH')).toBe('Plymouth');
  });
});

describe('geo helpers', () => {
  it('distances and bearings', () => {
    // Plymouth center to Ann Arbor center is ~23 km roughly west-southwest.
    const d = haversineM(PLYMOUTH.lat, PLYMOUTH.lon, ANN_ARBOR.lat, ANN_ARBOR.lon);
    expect(d).toBeGreaterThan(22_000);
    expect(d).toBeLessThan(25_000);
    const b = bearingDeg(PLYMOUTH.lat, PLYMOUTH.lon, ANN_ARBOR.lat, ANN_ARBOR.lon);
    expect(b).toBeGreaterThan(240);
    expect(b).toBeLessThan(260);
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

  it('Plymouth city center: CSX Plymouth Sub, Main St crossing', async () => {
    const r = await tools.nearest_rail!.run({ lat: PLYMOUTH.lat, lon: PLYMOUTH.lon }, sig());
    const data = r.data as {
      line: { railroad: string; distance_m: number };
      main_line: unknown;
      crossing: Record<string, unknown>;
    };
    expect(data.line.railroad).toMatch(/CSX/);
    expect(data.line.distance_m).toBeLessThan(2000);
    expect(data.crossing).toMatchObject({
      fra_crossing_id: '232216W',
      street: 'MAIN ST',
      railroad: 'CSX Transportation',
      subdivision: 'PLYMOUTH',
      position: 'At Grade',
    });
    expect(data.crossing.trains_per_day).toBeGreaterThan(0);
    expect(data.crossing.distance_m).toBeGreaterThan(300);
    expect(data.crossing.distance_m).toBeLessThan(1000);
    expect(data.crossing.direction).toMatch(/^N|^E/);
    expect(r.summary).toMatch(/FRA 232216W at MAIN ST/);
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

  it('LTU Southfield: no track on campus, the CN Holly Sub is the nearest line', () => {
    const line = index.nearestLine(LTU_SOUTHFIELD.lat, LTU_SOUTHFIELD.lon)!;
    expect(line.distance_m).toBeGreaterThan(2000);
    expect(line.railroad).toMatch(/Canadian National/);
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
