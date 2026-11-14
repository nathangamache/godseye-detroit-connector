/** Gateway-native rail tools (logically part of the "pulse" family). */
import { metaFor } from '../tools/tags.js';
import type { ToolDef } from '../tools/types.js';
import { humanDistance } from '../util/format.js';
import type { CrossingHit, NearestLine, RailIndex } from './index.js';

const LATLON = {
  lat: { type: 'number', minimum: -90, maximum: 90, description: 'Latitude (WGS84)' },
  lon: { type: 'number', minimum: -180, maximum: 180, description: 'Longitude (WGS84)' },
};

function lineSentence(l: NearestLine): string {
  const name = [
    l.railroad ?? 'unknown railroad',
    l.subdivision ? `${titleCase(l.subdivision)} Subdivision` : undefined,
  ]
    .filter(Boolean)
    .join(', ');
  const rights = l.trackage_rights.length
    ? `; trackage rights: ${l.trackage_rights.join(', ')}`
    : '';
  const pax = l.passenger ? `; passenger: ${l.passenger}` : '';
  return `Nearest active rail line: ${name} (${l.kind}${l.tracks ? `, ${l.tracks} track${l.tracks > 1 ? 's' : ''}` : ''}${rights}${pax}), ${humanDistance(l.distance_m)} ${l.direction}.`;
}

function crossingSentence(c: CrossingHit): string {
  const where = [c.street, c.city].filter(Boolean).join(', ');
  const rr = [
    c.railroad,
    c.subdivision ? `${titleCase(c.subdivision)} Sub` : undefined,
    c.milepost ? `MP ${c.milepost}` : undefined,
  ]
    .filter(Boolean)
    .join(', ');
  const trains =
    c.trains_per_day !== undefined
      ? ` About ${c.trains_per_day} train${c.trains_per_day === 1 ? '' : 's'}/day per the FRA inventory${c.max_timetable_speed_mph ? `, timetable speed up to ${c.max_timetable_speed_mph} mph` : ''}.`
      : '';
  return `Nearest at-grade crossing: FRA ${c.fra_crossing_id}${where ? ` at ${where}` : ''}${rr ? ` (${rr})` : ''}, ${humanDistance(c.distance_m)} ${c.direction}; ${c.warning_devices ?? 'warning devices unknown'}.${trains}`;
}

/** "MICHIGAN LINE (NS)" -> "Michigan Line (NS)": parenthesized railroad marks stay upper case. */
export function titleCase(s: string): string {
  return s
    .split(/(\([^)]*\))/)
    .map((part) =>
      part.startsWith('(') ? part : part.toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase()),
    )
    .join('');
}

export function railTools(index: RailIndex): ToolDef[] {
  const asOf = index.datasetAsOf();
  const dataNote = `Static public datasets (FRA crossing inventory revised through ${asOf ?? 'unknown'}; NARN lines). They describe infrastructure, not live train positions.`;
  return [
    {
      name: 'nearest_rail',
      title: 'Nearest rail line and train crossing',
      description:
        'Nearest railroad line (owner, trackage rights, subdivision, distance, direction) and the nearest at-grade grade crossing (FRA crossing ID, street, railroad, daily train counts, warning devices, distance, bearing) to a point. Michigan coverage. Use for train, railroad, track or crossing questions.',
      source: 'gateway',
      family: 'pulse',
      inputSchema: {
        type: 'object',
        properties: {
          ...LATLON,
          max_km: {
            type: 'number',
            minimum: 0.1,
            maximum: 100,
            description: 'Search radius in km (default 50)',
          },
        },
        required: ['lat', 'lon'],
        additionalProperties: false,
      },
      tags: metaFor('nearest_rail').tags,
      attribution: metaFor('nearest_rail').attribution,
      async run(args) {
        const lat = args.lat as number;
        const lon = args.lon as number;
        const maxM = ((args.max_km as number | undefined) ?? 50) * 1000;
        const line = index.nearestLine(lat, lon, maxM);
        const main =
          line && line.kind !== 'main line' ? index.nearestMainLine(lat, lon, maxM) : undefined;
        const crossing = index.nearestCrossing(lat, lon, maxM);
        if (!line && !crossing) {
          return {
            summary: `No rail line or crossing within ${maxM / 1000} km. Coverage is Michigan only.`,
            data: { line: null, crossing: null, dataset_as_of: asOf },
          };
        }
        const parts = [line ? lineSentence(line) : 'No active rail line found in range.'];
        if (main)
          parts.push(lineSentence(main).replace('Nearest active rail line', 'Nearest main line'));
        parts.push(crossing ? crossingSentence(crossing) : 'No at-grade crossing found in range.');
        return {
          summary: `${parts.join(' ')} ${dataNote}`,
          data: {
            line: line ?? null,
            main_line: main ?? null,
            crossing: crossing ?? null,
            dataset_as_of: asOf,
          },
        };
      },
    },
    {
      name: 'crossings_near',
      title: 'List grade crossings in a radius',
      description:
        'Railroad grade crossings within a radius of a point, nearest first, from the FRA crossing inventory: crossing ID, street, railroad, subdivision, milepost, at-grade vs grade-separated, warning devices, daily train counts, distance and bearing. Michigan coverage.',
      source: 'gateway',
      family: 'pulse',
      inputSchema: {
        type: 'object',
        properties: {
          ...LATLON,
          radius_km: {
            type: 'number',
            minimum: 0.1,
            maximum: 25,
            description: 'Radius in km (default 2)',
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 100,
            description: 'Most results (default 20)',
          },
          at_grade_only: {
            type: 'boolean',
            description: 'Only at-grade crossings (default false)',
          },
        },
        required: ['lat', 'lon'],
        additionalProperties: false,
      },
      tags: metaFor('crossings_near').tags,
      attribution: metaFor('crossings_near').attribution,
      async run(args) {
        const radiusKm = (args.radius_km as number | undefined) ?? 2;
        const hits = index.crossingsNear(args.lat as number, args.lon as number, radiusKm * 1000, {
          atGradeOnly: Boolean(args.at_grade_only),
          limit: (args.limit as number | undefined) ?? 20,
        });
        const summary = hits.length
          ? `${hits.length} crossing(s) within ${radiusKm} km; nearest is FRA ${hits[0]!.fra_crossing_id}${hits[0]!.street ? ` at ${hits[0]!.street}` : ''}, ${humanDistance(hits[0]!.distance_m)} ${hits[0]!.direction}. ${dataNote}`
          : `No crossings within ${radiusKm} km (Michigan coverage only). ${dataNote}`;
        return {
          summary,
          data: { radius_km: radiusKm, count: hits.length, crossings: hits, dataset_as_of: asOf },
        };
      },
    },
  ];
}
