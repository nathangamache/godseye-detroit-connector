/**
 * Rail line naming: the FRA crossing inventory and NARN often name the same track differently.
 * Names are matched normalised and reported in full, computed from the data (no hard-coded
 * aliases for any place).
 */
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/config.js';
import { RailIndex } from '../src/rail/index.js';
import {
  displayLineName,
  formatLineNames,
  isLineName,
  normLineName,
  plainLineName,
  railroadFamily,
  railroadsCompatible,
  trackMatchesLine,
  type TrackNames,
} from '../src/rail/names.js';
import { railTools } from '../src/rail/tools.js';
import type { ToolDef } from '../src/tools/types.js';

const sig = () => ({ signal: new AbortController().signal });

describe('normalisation (generic, made-up names)', () => {
  it('ignores case, railroad-mark suffixes and Subdivision/Sub/District', () => {
    for (const n of [
      'ALPHA (CSXT)',
      'Alpha Subdivision',
      'alpha sub',
      'ALPHA SUBDIVISION (CSXT)',
      'CSX Alpha Sub',
      'Alpha District',
    ])
      expect(normLineName(n), n).toBe('ALPHA');
    expect(normLineName('BRAVO LINE (NS)')).toBe(normLineName('BRAVO'));
    expect(normLineName('MAIN LINE')).toBe(normLineName('MAINLINE'));
    expect(normLineName('Alpha')).not.toBe(normLineName('Bravo'));
    expect(normLineName(undefined)).toBe('');
  });

  it('maps legacy and current reporting marks to one railroad', () => {
    expect(railroadFamily('GTW')).toBe(railroadFamily('CN'));
    expect(railroadFamily('ATK')).toBe(railroadFamily('AMTK'));
    expect(railroadFamily('CSX')).toBe('CSX');
    expect(railroadFamily('CSX Transportation (CSXT)')).toBe('CSX');
    expect(railroadFamily('Norfolk Southern')).toBe('NS');
    expect(railroadsCompatible(['CSXT'], ['CSX'])).toBe(true);
    expect(railroadsCompatible(['CSXT'], ['NS'])).toBe(false);
    expect(railroadsCompatible([], ['NS'])).toBe(true);
  });

  it('formats every name, merging names the datasets agree on', () => {
    expect(
      formatLineNames([
        { dataset: 'FRA', name: 'ALPHA' },
        { dataset: 'NARN', name: 'BRAVO (CSXT)' },
      ]),
    ).toBe('FRA: Alpha Sub; NARN: Bravo Sub');
    expect(
      formatLineNames([
        { dataset: 'NARN', name: 'ALPHA (CSXT)' },
        { dataset: 'FRA', name: 'ALPHA' },
      ]),
    ).toBe('NARN/FRA: Alpha Sub');
    expect(displayLineName('BRAVO LINE (NS)')).toBe('Bravo Line');
    expect(plainLineName('BRAVO (CSXT)')).toBe('Bravo');
    expect(plainLineName('Alpha Subdivision')).toBe('Alpha');
    // Numeric codes some FRA rows carry in the subdivision field are not names.
    expect(isLineName('5050304')).toBe(false);
    expect(isLineName('DT&I NORTH')).toBe(true);
  });

  it('matches a Pulse coverage line on any dataset name or Pulse alias, with the railroad', () => {
    const track: TrackNames = {
      label: 'nearest track',
      names: [
        { dataset: 'FRA', name: 'ALPHA' },
        { dataset: 'NARN', name: 'BRAVO (CSXT)' },
      ],
      railroads: ['CSX Transportation (CSXT)'],
    };
    expect(trackMatchesLine(track, { railroad: 'CSX', name: 'Bravo Subdivision' })).toBe(true);
    expect(trackMatchesLine(track, { railroad: 'CSX', name: 'Alpha Sub' })).toBe(true);
    expect(
      trackMatchesLine(track, { railroad: 'CSX', name: 'Charlie Sub', aliases: ['Alpha'] }),
    ).toBe(true);
    expect(trackMatchesLine(track, { name: 'Bravo' })).toBe(true);
    expect(trackMatchesLine(track, { railroad: 'NS', name: 'Bravo Sub' })).toBe(false);
    expect(trackMatchesLine(track, { railroad: 'CSX', name: 'Charlie Sub' })).toBe(false);
  });
});

describe('names computed from the bundled FRA and NARN data', () => {
  let index: RailIndex;
  let tools: Record<string, ToolDef>;
  /** A crossing whose FRA and NARN names differ, found in the data (not hard-coded). */
  let disagree: { i: number; lat: number; lon: number; fra: string; narn: string };

  beforeAll(() => {
    index = RailIndex.load(path.join(REPO_ROOT, 'data', 'rail'));
    tools = Object.fromEntries(railTools(index).map((t) => [t.name, t]));
    for (let i = 0; i < index.crossings.length; i++) {
      const c = index.crossings[i]!;
      if (c.pos !== 'At Grade') continue;
      const names = index.lineNamesForCrossing(i);
      const fra = names.find((n) => n.dataset === 'FRA')?.name;
      const narn = names.find((n) => n.dataset === 'NARN')?.name;
      if (fra && narn && normLineName(fra) !== normLineName(narn) && /\(/.test(narn)) {
        disagree = { i, lat: c.lat, lon: c.lon, fra, narn };
        break;
      }
    }
  });

  it('pairs most crossings with the NARN segment they sit on, and skips code-only names', () => {
    let paired = 0;
    for (let i = 0; i < index.crossings.length; i++) {
      const names = index.lineNamesForCrossing(i);
      if (names.some((n) => n.dataset === 'NARN')) paired++;
      for (const n of names) expect(isLineName(n.name), n.name).toBe(true);
    }
    expect(paired).toBeGreaterThan(3000);
    expect(disagree).toBeDefined();
  });

  it("nearest_rail and crossings_near report both datasets' names for one track", async () => {
    const r = await tools.nearest_rail!.run({ lat: disagree.lat, lon: disagree.lon }, sig());
    const data = r.data as {
      line: { line_names: Array<{ dataset: string; name: string }> };
      crossing: { line_names: Array<{ dataset: string; name: string }> };
    };
    expect(data.crossing.line_names).toEqual(
      expect.arrayContaining([
        { dataset: 'FRA', name: disagree.fra },
        { dataset: 'NARN', name: disagree.narn },
      ]),
    );
    expect(r.summary).toContain(`FRA: ${displayLineName(disagree.fra)}`);
    expect(r.summary).toContain(`NARN: ${displayLineName(disagree.narn)}`);
    // The nearest track (the same rails) carries the FRA name of its crossings too.
    const lineKeys = data.line.line_names.map((n) => normLineName(n.name));
    expect(lineKeys).toContain(normLineName(disagree.fra));

    const near = await tools.crossings_near!.run(
      { lat: disagree.lat, lon: disagree.lon, radius_km: 0.2 },
      sig(),
    );
    const hit = (near.data as { crossings: Array<{ line_names: unknown[] }> }).crossings[0]!;
    expect(hit.line_names).toHaveLength(2);
    expect(near.summary).toContain(`NARN: ${displayLineName(disagree.narn)}`);
  });

  it('tracksNear lists every name of the track at a point', () => {
    const tracks = index.tracksNear(disagree.lat, disagree.lon);
    const keys = new Set(tracks.flatMap((t) => t.names.map((n) => normLineName(n.name))));
    expect(keys.has(normLineName(disagree.fra))).toBe(true);
    expect(keys.has(normLineName(disagree.narn))).toBe(true);
    // A Pulse line known only by the NARN name matches the track that FRA names differently.
    const crossing = tracks.find((t) => t.label.startsWith('crossing'))!;
    expect(
      trackMatchesLine(crossing, { name: `${plainLineName(disagree.narn)} Subdivision` }),
    ).toBe(true);
    expect(trackMatchesLine(crossing, { name: `${plainLineName(disagree.fra)} Sub` })).toBe(true);
  });
});
