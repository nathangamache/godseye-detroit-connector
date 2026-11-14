/** Gateway-native rail tools (logically part of the "pulse" family). */
import { metaFor } from '../tools/tags.js';
import type { ToolDef } from '../tools/types.js';
import { humanDistance } from '../util/format.js';
import type { CrossingHit, NearestLine, RailIndex } from './index.js';
import { displayLineName, formatLineNames, titleCase } from './names.js';

export { titleCase };

const LATLON = {
  lat: { type: 'number', minimum: -90, maximum: 90, description: 'Latitude (WGS84)' },
  lon: { type: 'number', minimum: -180, maximum: 180, description: 'Longitude (WGS84)' },
};

/** "line names FRA: X Sub; NARN: Y Sub" (every name the datasets give the track), or the one name. */
function namesPhrase(names: CrossingHit['line_names'], fallback?: string): string | undefined {
  if (names.length) return `line names ${formatLineNames(names)}`;
  return fallback ? displayLineName(fallback) : undefined;
}

function lineSentence(l: NearestLine): string {
  const name = [l.railroad ?? 'unknown railroad', namesPhrase(l.line_names, l.subdivision)]
    .filter(Boolean)
    .join(', ');
  const rights = l.trackage_rights.length
    ? `; trackage rights: ${l.trackage_rights.join(', ')}`
    : '';
  const pax = l.passenger ? `; passenger: ${l.passenger}` : '';
  const tracks = l.track_counts ? `, ${l.track_counts.text}` : '';
  return `Nearest active rail line: ${name} (${l.kind}${tracks}${rights}${pax}), ${humanDistance(l.distance_m)} ${l.direction}.`;
}

/** How the road meets the tracks: grade separation (from FRA's position) or the warning devices. */
function levelPhrase(c: CrossingHit): string {
  return c.grade_separated
    ? `grade-separated: ${c.separation ?? 'not at grade'} (FRA position "${c.position}")`
    : (c.warning_devices ?? 'warning devices unknown');
}

/** `label`: "Nearest at-grade crossing", "Nearest crossing of any kind", ... */
function crossingSentence(c: CrossingHit, label: string): string {
  const where = [c.street, c.city].filter(Boolean).join(', ');
  const rr = [
    c.railroad,
    namesPhrase(c.line_names, c.subdivision),
    c.milepost ? `MP ${c.milepost}` : undefined,
  ]
    .filter(Boolean)
    .join(', ');
  const trains =
    c.trains_per_day !== undefined
      ? ` About ${c.trains_per_day} train${c.trains_per_day === 1 ? '' : 's'}/day per the FRA inventory${c.max_timetable_speed_mph ? `, timetable speed up to ${c.max_timetable_speed_mph} mph` : ''}.`
      : '';
  const tracks = c.track_counts ? `; ${c.track_counts.text}` : '';
  return `${label}: FRA ${c.fra_crossing_id}${where ? ` at ${where}` : ''}${rr ? ` (${rr})` : ''}, ${humanDistance(c.distance_m)} ${c.direction}; ${levelPhrase(c)}${tracks}.${trains}`;
}

/** One crossing in a list summary; track counts only where FRA and NARN disagree. */
function crossingBrief(c: CrossingHit): string {
  const names = namesPhrase(c.line_names, c.subdivision);
  const sep = c.grade_separated ? `, grade-separated: ${c.separation ?? 'not at grade'}` : '';
  const tracks = c.track_counts?.agree === false ? ` [${c.track_counts.text}]` : '';
  return `FRA ${c.fra_crossing_id}${c.street ? ` at ${c.street}` : ''}${names ? ` (${names})` : ''}, ${humanDistance(c.distance_m)} ${c.direction}${sep}${tracks}`;
}

export function railTools(index: RailIndex): ToolDef[] {
  const asOf = index.datasetAsOf();
  const dataNote = `Static public datasets (FRA crossing inventory revised through ${asOf ?? 'unknown'}; NARN lines). They describe infrastructure, not live train positions. FRA and NARN often name the same track differently; line_names lists every name, and where the two disagree on an attribute (track counts) both are given with their source.`;
  return [
    {
      name: 'nearest_rail',
      title: 'Nearest rail line and train crossing',
      description:
        'Nearest railroad line (owner, trackage rights, every subdivision name the FRA and NARN datasets give it, track count, distance, direction) and two crossings, each labelled: the nearest crossing of any kind (a grade-separated one says whether the road passes over or under the tracks) and the nearest at-grade crossing (FRA crossing ID, street, railroad, daily train counts, warning devices, distance, bearing). Where FRA and NARN disagree (e.g. track counts), both are shown with their source. Michigan coverage. Use for train, railroad, track or crossing questions.',
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
        const any = index.nearestCrossingAnyKind(lat, lon, maxM);
        if (!line && !any) {
          return {
            summary: `No rail line or crossing within ${maxM / 1000} km. Coverage is Michigan only.`,
            data: {
              line: null,
              crossing: null,
              nearest_crossing_any_kind: null,
              dataset_as_of: asOf,
            },
          };
        }
        const parts = [line ? lineSentence(line) : 'No active rail line found in range.'];
        if (main)
          parts.push(lineSentence(main).replace('Nearest active rail line', 'Nearest main line'));
        if (any && crossing && any.fra_crossing_id === crossing.fra_crossing_id)
          parts.push(
            crossingSentence(
              crossing,
              'Nearest crossing of any kind is also the nearest at-grade crossing',
            ),
          );
        else {
          if (any) parts.push(crossingSentence(any, 'Nearest crossing of any kind'));
          parts.push(
            crossing
              ? crossingSentence(crossing, 'Nearest at-grade crossing')
              : 'No at-grade crossing found in range.',
          );
        }
        return {
          summary: `${parts.join(' ')} ${dataNote}`,
          data: {
            line: line ?? null,
            main_line: main ?? null,
            /** The nearest at-grade crossing. */
            crossing: crossing ?? null,
            nearest_crossing_any_kind: any ?? null,
            dataset_as_of: asOf,
          },
        };
      },
    },
    {
      name: 'crossings_near',
      title: 'List grade crossings in a radius',
      description:
        'Railroad grade crossings within a radius of a point, nearest first, from the FRA crossing inventory: crossing ID, street, railroad, line names (FRA subdivision and the NARN name for the same track), milepost, at-grade vs grade-separated (road over or under the tracks), warning devices, daily train counts, track counts (FRA and NARN, labelled when they disagree), distance and bearing. The summary names the nearest crossing of any kind and the nearest at-grade one. Michigan coverage.',
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
        const lat = args.lat as number;
        const lon = args.lon as number;
        const atGradeOnly = Boolean(args.at_grade_only);
        const hits = index.crossingsNear(lat, lon, radiusKm * 1000, {
          atGradeOnly,
          limit: (args.limit as number | undefined) ?? 20,
        });
        const first = hits[0];
        let summary: string;
        if (!first)
          summary = `No ${atGradeOnly ? 'at-grade ' : ''}crossings within ${radiusKm} km (Michigan coverage only). ${dataNote}`;
        else if (atGradeOnly)
          summary = `${hits.length} at-grade crossing(s) within ${radiusKm} km; nearest at-grade: ${crossingBrief(first)}. ${dataNote}`;
        else {
          const separated = hits.filter((h) => h.grade_separated).length;
          const atGrade = first.grade_separated
            ? index.crossingsNear(lat, lon, radiusKm * 1000, { atGradeOnly: true, limit: 1 })[0]
            : first;
          const nearest = first.grade_separated
            ? `nearest of any kind: ${crossingBrief(first)}; nearest at-grade: ${atGrade ? crossingBrief(atGrade) : `none within ${radiusKm} km`}`
            : `nearest of any kind is at grade: ${crossingBrief(first)}`;
          summary = `${hits.length} crossing(s) within ${radiusKm} km (${hits.length - separated} at grade, ${separated} grade-separated); ${nearest}. ${dataNote}`;
        }
        return {
          summary,
          data: { radius_km: radiusKm, count: hits.length, crossings: hits, dataset_as_of: asOf },
        };
      },
    },
  ];
}
