/**
 * flights_near and aircraft_lookup (gateway-native, catalog category "aviation").
 *
 * Privacy, flights_near: the user's exact position never leaves the gateway. The query centre is
 * snapped to a 0.05 degree grid and the radius enlarged by 3 nm (more than the largest snap
 * offset, about 2.1 nm), and the aircraft are then filtered, measured and sorted here from the
 * exact point. Nothing here logs a position or an aircraft list. With `here`, the phone fix is
 * read like where_am_i and audited the same way.
 */
import { z } from 'zod';
import type { Audit } from '../../audit.js';
import type { Config } from '../../config.js';
import type { LocationStore } from '../../location/store.js';
import { currentPosition, noFixMessage } from '../../mcp/whatsHappening.js';
import type { TokenStore } from '../../oauth/tokens.js';
import type { JsonSchema, ToolContext, ToolDef, ToolOutput } from '../../tools/types.js';
import { humanAge } from '../../util/format.js';
import { bearingDeg, compassPoint, haversineM } from '../../util/geo.js';
import {
  EMITTER_CATEGORIES,
  POSITION_SOURCES,
  REGISTRANT_TYPES,
  STATUS_CODES,
  decodeDbFlags,
} from './codes.js';
import type { LaddTracker } from './ladd.js';
import { globeLink } from './links.js';
import {
  ADSBFI_CREDIT,
  ADSBLOL_CREDIT,
  LiveError,
  type LiveAircraft,
  type LiveClient,
} from './live.js';
import {
  classifyIcao,
  icaoToNNumber,
  looksLikeNNumber,
  nNumberToIcao,
  normalizeNNumber,
  parseHex,
  toHex,
} from './nnumber.js';
import {
  faaTypeName,
  isDrone,
  ownerSentence,
  ownerView,
  recordView,
  wouldShowName,
  type OwnerPolicy,
} from './owner.js';
import type { RegistryRecord, RegistryStore } from './registry-store.js';

export const FAA_CREDIT = 'FAA Releasable Aircraft Database (registry.faa.gov), US government data';

/** The query centre's grid (degrees) and the radius added to cover the snap (nm). */
export const QUERY_GRID_DEG = 0.05;
export const QUERY_PAD_NM = 3;

const NM_M = 1852;

export interface AviationToolDeps {
  config: Pick<
    Config,
    | 'linkOrigin'
    | 'privateOrigin'
    | 'LOCATION_STALE_MINUTES'
    | 'LOCATION_RETENTION_HOURS'
    | 'AIRCRAFT_OWNER_DISCLOSURE'
    | 'AIRCRAFT_LADD_WITHHOLD'
  >;
  locations: LocationStore;
  audit?: Audit;
  tokens?: TokenStore;
  store: RegistryStore;
  live: LiveClient;
  ladd: LaddTracker;
  now?: () => number;
}

/** JSON Schema for find_tools and run_tool's validator, from the zod schema the tool parses with. */
function jsonSchema(s: z.ZodType): JsonSchema {
  const { $schema: _s, ...rest } = z.toJSONSchema(s, { io: 'input' }) as Record<string, unknown>;
  return rest;
}

const FlightsNearArgs = z.strictObject({
  lat: z
    .number()
    .min(-90)
    .max(90)
    .optional()
    .describe('Latitude (WGS84). Give lat and lon, or here: true.'),
  lon: z.number().min(-180).max(180).optional().describe('Longitude (WGS84)'),
  here: z
    .boolean()
    .optional()
    .describe("true: use the user's latest phone fix (as where_am_i) instead of lat/lon"),
  radius_nm: z
    .number()
    .min(1)
    .max(25)
    .optional()
    .describe('Radius in nautical miles, 1-25 (default 5)'),
  max: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe('Most aircraft to return, nearest first (default 20)'),
});

const AircraftLookupArgs = z.strictObject({
  hex: z
    .string()
    .regex(/^\s*~?[0-9A-Fa-f]{6}\s*$/, 'six hex digits, e.g. "a1b2c3"')
    .optional()
    .describe('ICAO 24-bit transponder address (Mode S hex), e.g. "a1b2c3"'),
  registration: z
    .string()
    .min(2)
    .max(12)
    .regex(/^[A-Za-z0-9 -]+$/, 'letters, digits, spaces and hyphens only')
    .optional()
    .describe('Registration (tail number), e.g. "N123AB". Only US N-numbers are covered.'),
});

function invalid(message: string): ToolOutput {
  return {
    summary: `Invalid arguments: ${message}`,
    isError: true,
    errorKind: 'invalid_arguments',
  };
}

function zodMessage(e: z.ZodError): string {
  return e.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || '(arguments)'}: ${i.message}`)
    .join('; ');
}

function liveErrorOutput(err: unknown): ToolOutput {
  if (err instanceof LiveError) {
    const kind = err.kind === 'cancelled' ? 'timeout' : err.kind;
    return {
      summary: `No live aircraft data right now: ${err.message}.${err.kind === 'retry_later' ? ' Try again in a minute or two.' : ''}`,
      isError: true,
      errorKind: kind,
    };
  }
  throw err;
}

/** The point the feed is asked about: a 0.05 degree grid node, radius + 3 nm (integer). */
export function coarsenQuery(
  p: { lat: number; lon: number },
  radiusNm: number,
): { center: { lat: number; lon: number }; radiusNm: number } {
  const snap = (v: number) => Math.round(v / QUERY_GRID_DEG) * QUERY_GRID_DEG;
  const lat = Math.min(90, Math.max(-90, snap(p.lat)));
  let lon = snap(p.lon);
  if (lon > 180) lon -= 360;
  if (lon < -180) lon += 360;
  return {
    center: { lat: Number(lat.toFixed(2)), lon: Number(lon.toFixed(2)) },
    radiusNm: Math.min(250, Math.ceil(radiusNm + QUERY_PAD_NM)),
  };
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const fmtAlt = (a: LiveAircraft['altitude_ft']) =>
  a === 'ground'
    ? 'on the ground'
    : a === undefined
      ? 'altitude unknown'
      : `${a.toLocaleString('en-US')} ft`;

interface RowRegistry {
  view: Record<string, unknown>;
  sentence?: string;
  typeName?: string;
}

export function aviationTools(deps: AviationToolDeps): ToolDef[] {
  const now = deps.now ?? Date.now;
  const policy: OwnerPolicy = {
    disclosure: deps.config.AIRCRAFT_OWNER_DISCLOSURE,
    laddWithhold: deps.config.AIRCRAFT_LADD_WITHHOLD,
  };
  const listCache = new Map<string, RowRegistry | null>();
  let listCacheGen = -1;

  const registryInfo = () => {
    const m = deps.store.meta();
    return m
      ? {
          name: 'FAA Releasable Aircraft Database',
          as_of: m.as_of,
          imported_at: m.imported_at,
          aircraft: m.rows,
        }
      : {
          name: 'FAA Releasable Aircraft Database',
          available: false,
          note: 'No local copy yet: the daily sync (about 06:15 UTC) has not completed. Live data still works.',
        };
  };

  /**
   * The owner of one row by aircraft_lookup's rules (government, corporations and LLCs by name;
   * private owners as "private individual"; city and state; LADD withholding), cached per
   * registry copy. owner_type is the FAA registrant type, never in place of a name.
   */
  function rowRegistry(hex: string, ladd: boolean): RowRegistry | null {
    if (deps.store.generation !== listCacheGen) {
      listCache.clear();
      listCacheGen = deps.store.generation;
    }
    const key = `${hex}:${ladd ? 1 : 0}`;
    const hit = listCache.get(key);
    if (hit !== undefined) return hit;
    const icao = parseInt(hex, 16);
    const rec =
      deps.store.byHex(hex) ??
      (() => {
        const n = icaoToNNumber(icao);
        return n ? deps.store.byNNumber(n) : undefined;
      })();
    let out: RowRegistry | null = null;
    if (rec) {
      const o = ownerView(rec, policy, ladd, 'list');
      const status = (rec.status_code ?? '').trim();
      const view: Record<string, unknown> = {
        n_number: `N${rec.n_number}`,
        ...(o.registrant_type ? { owner_type: o.registrant_type } : {}),
        ...(o.owner && o.owner_is_name ? { owner_name: o.owner } : {}),
        ...(o.owner && !o.owner_is_name ? { owner_label: o.owner } : {}),
        ...(o.city ? { city: o.city } : {}),
        ...(o.state ? { state: o.state } : {}),
        ...(o.government ? { government: true } : {}),
        ...(o.law_enforcement_hint ? { law_enforcement_hint: true } : {}),
        ...(o.withheld === 'faa_blank' ? { owner_withheld_by_faa: true } : {}),
        ...(o.withheld === 'ladd' ? { owner_withheld_ladd: true } : {}),
        ...(isDrone(rec) ? { drone: true } : {}),
        ...(status && status !== 'V'
          ? { status: STATUS_CODES[status] ?? `status code ${status}` }
          : {}),
      };
      out = { view, sentence: ownerSentence(o), typeName: faaTypeName(rec) };
    }
    listCache.set(key, out);
    if (listCache.size > 5000) listCache.delete(listCache.keys().next().value!);
    return out;
  }

  function locationRead(ctx: ToolContext, found: boolean): void {
    deps.audit?.record('location_read', {
      clientId: ctx.clientId,
      subject: ctx.subject,
      detail: { family: ctx.familyId, tool: 'flights_near', fix: found },
    });
    if (ctx.familyId) deps.tokens?.noteLocationRead(ctx.familyId);
  }

  const flightsNear: ToolDef = {
    name: 'flights_near',
    title: 'Aircraft near a point',
    description:
      'Aircraft flying (or on the ground) near a point or the user\'s phone ("what plane / helicopter is that?"): callsign, ICAO hex, registration, type and long type name, altitude, speed, track, vertical rate, distance and bearing from the point, data age, position source (ADS-B, MLAT, TIS-B), military/LADD/PIA flags, and for US aircraft the registered owner as aircraft_lookup gives it (government, corporations and LLCs by name; private owners as "private individual"; with city and state and the FAA registrant type). Live data from adsb.fi (adsb.lol as fallback). Each aircraft has a globe link.',
    source: 'gateway',
    family: 'aviation',
    inputSchema: jsonSchema(FlightsNearArgs),
    tags: [
      'aircraft',
      'airplane',
      'plane',
      'planes',
      'flight',
      'flights',
      'helicopter',
      'chopper',
      'overhead',
      'above me',
      'what plane is that',
      'circling',
      'low flying',
      'jet',
      'ads-b',
      'adsb',
      'airspace',
      'police helicopter',
      'news helicopter',
      'military aircraft',
      'callsign',
      'tail number',
      'flying over',
    ],
    attribution: `Live aircraft: ${ADSBFI_CREDIT}, personal non-commercial use; fallback ${ADSBLOL_CREDIT}; US registrants: ${FAA_CREDIT}`,
    untrustedText: true,
    async run(args, ctx) {
      const parsed = FlightsNearArgs.safeParse(args);
      if (!parsed.success) return invalid(zodMessage(parsed.error));
      const a = parsed.data;
      const hasLat = a.lat !== undefined;
      const hasLon = a.lon !== undefined;
      if (a.here && (hasLat || hasLon)) return invalid('give lat/lon or here: true, not both');
      if (!a.here && !(hasLat && hasLon))
        return invalid("give both lat and lon, or here: true for the user's phone location");
      let point: { lat: number; lon: number };
      let where: string;
      let query: Record<string, unknown>;
      if (a.here) {
        const pos = currentPosition(deps.locations, deps.config.LOCATION_STALE_MINUTES, now());
        locationRead(ctx, Boolean(pos));
        if (!pos)
          return {
            summary: noFixMessage(deps.config.privateOrigin, deps.config.LOCATION_RETENTION_HOURS),
            isError: true,
            errorKind: 'unavailable',
          };
        point = { lat: pos.lat, lon: pos.lon };
        const acc = pos.accuracy_m === null ? '' : `, ±${pos.accuracy_m} m`;
        where = `the phone's latest fix (${humanAge(pos.age_s)} old${acc}${pos.stale ? ', STALE: the user may have moved' : ''})`;
        query = {
          point: 'phone fix',
          fix_age_s: pos.age_s,
          fix_stale: pos.stale,
          ...(pos.accuracy_m !== null ? { fix_accuracy_m: pos.accuracy_m } : {}),
        };
      } else {
        point = { lat: a.lat!, lon: a.lon! };
        where = `${point.lat.toFixed(4)}, ${point.lon.toFixed(4)}`;
        query = { point: 'given', lat: point.lat, lon: point.lon };
      }
      const radius = a.radius_nm ?? 5;
      const max = a.max ?? 20;
      const q = coarsenQuery(point, radius);
      let snap;
      try {
        snap = await deps.live.near(q.center, q.radiusNm, ctx.signal);
      } catch (err) {
        return liveErrorOutput(err);
      }

      let withoutPosition = 0;
      const within: Array<{ ac: LiveAircraft; m: number; brg: number }> = [];
      for (const ac of snap.aircraft) {
        if (ac.lat === undefined || ac.lon === undefined) {
          withoutPosition++;
          continue;
        }
        const m = haversineM(point.lat, point.lon, ac.lat, ac.lon);
        if (m / NM_M > radius) continue;
        if (!ac.non_icao) deps.ladd.noteLive(ac.hex, ac.db_flags);
        within.push({ ac, m, brg: bearingDeg(point.lat, point.lon, ac.lat, ac.lon) });
      }
      within.sort((x, y) => x.m - y.m);
      const registryLoaded = deps.store.available;
      const lines: string[] = [];
      let laddCount = 0;
      let piaCount = 0;
      let govCount = 0;
      const rows = within.slice(0, max).map(({ ac, m, brg }, i) => {
        const flags = decodeDbFlags(ac.db_flags);
        if (flags.ladd) laddCount++;
        if (flags.pia) piaCount++;
        const block = ac.non_icao ? undefined : classifyIcao(parseInt(ac.hex, 16));
        let registry: Record<string, unknown> | undefined;
        let typeName = ac.type_desc;
        let typeSource: string | undefined = typeName ? snap.source : undefined;
        let ownerText: string | undefined;
        if (block?.kind === 'us_civil') {
          if (flags.pia) {
            registry = {
              note: 'Privacy ICAO address (PIA): deliberately not linked to the FAA registry, so it is not looked up.',
            };
          } else if (registryLoaded) {
            // LADD as aircraft_lookup knows it: this live flag, flags seen earlier, adsb.lol's list.
            const r = rowRegistry(ac.hex, flags.ladd || deps.ladd.has(ac.hex));
            if (r) {
              registry = r.view;
              if (r.view.government) govCount++;
              ownerText = r.sentence;
              if (r.typeName) {
                typeName = r.typeName;
                typeSource = 'faa';
              }
            } else {
              registry = { note: 'Not in the current FAA registry copy.' };
            }
          }
        } else if (block?.kind === 'us_military_federal') {
          registry = { note: 'US military/federal address block: no civil registry record.' };
        }
        const dNm = m / NM_M;
        const compass = compassPoint(brg);
        const row: Record<string, unknown> = {
          ...(ac.callsign ? { callsign: ac.callsign } : {}),
          hex: (ac.non_icao ? '~' : '') + ac.hex,
          ...(ac.non_icao ? { non_icao: true } : {}),
          ...(ac.registration ? { registration: ac.registration } : {}),
          ...(ac.type_code ? { type: ac.type_code } : {}),
          ...(typeName ? { type_name: typeName, type_name_source: typeSource } : {}),
          ...(ac.category
            ? { category: ac.category, category_label: EMITTER_CATEGORIES[ac.category] }
            : {}),
          altitude_ft: ac.altitude_ft ?? null,
          ...(ac.altitude_geom_ft !== undefined ? { altitude_geom_ft: ac.altitude_geom_ft } : {}),
          ...(ac.ground_speed_kt !== undefined ? { ground_speed_kt: ac.ground_speed_kt } : {}),
          ...(ac.track_deg !== undefined ? { track_deg: ac.track_deg } : {}),
          ...(ac.vertical_rate_fpm !== undefined
            ? { vertical_rate_fpm: ac.vertical_rate_fpm }
            : {}),
          ...(ac.squawk ? { squawk: ac.squawk } : {}),
          ...(ac.emergency ? { emergency: ac.emergency } : {}),
          distance_nm: round1(dNm),
          distance_km: round1(m / 1000),
          bearing_deg: Math.round(brg) % 360,
          compass,
          ...(ac.seen_s !== undefined ? { seen_s: ac.seen_s } : {}),
          ...(ac.seen_pos_s !== undefined ? { seen_pos_s: ac.seen_pos_s } : {}),
          ...(ac.source_type
            ? {
                position_source: ac.source_type,
                position_source_label: POSITION_SOURCES[ac.source_type],
              }
            : {}),
          ...(ac.position_kind && ac.position_kind !== 'reported'
            ? { position_kind: ac.position_kind }
            : {}),
          flags: { military: flags.military, ladd: flags.ladd, pia: flags.pia },
          ...(registry ? { registry } : {}),
          map_url: globeLink(deps.config.linkOrigin, ac.lat!, ac.lon!),
        };
        if (i < 8) {
          const id = [
            ac.registration ?? ac.callsign ?? `hex ${ac.hex}`,
            ac.callsign && ac.registration ? `(${ac.callsign})` : '',
          ]
            .filter(Boolean)
            .join(' ');
          const what = [ac.type_code, typeName ? `"${typeName}"` : ''].filter(Boolean).join(' ');
          const marks = [
            flags.military ? 'MILITARY' : '',
            registry?.drone ? 'registered as a drone' : '',
            flags.ladd ? 'LADD' : '',
            flags.pia ? 'PIA' : '',
            ac.emergency ? `EMERGENCY ${ac.emergency}` : '',
            ac.source_type === 'mlat' ? 'MLAT position' : '',
            ac.source_type?.startsWith('tisb') ? 'TIS-B position' : '',
          ].filter(Boolean);
          lines.push(
            `${i + 1}. ${id}${what ? ` ${what}` : ''}: ${round1(dNm)} nm ${compass}, ${fmtAlt(ac.altitude_ft)}` +
              `${ac.ground_speed_kt !== undefined ? `, ${ac.ground_speed_kt} kt` : ''}` +
              `${ac.track_deg !== undefined ? `, track ${ac.track_deg}°` : ''}` +
              `${ac.seen_pos_s !== undefined ? `, position ${Math.round(ac.seen_pos_s)} s old` : ''}` +
              `${marks.length ? ` [${marks.join(', ')}]` : ''}${ownerText ? `; ${ownerText}` : ''}`,
          );
        }
        return row;
      });

      const notes: string[] = [
        `Distances and bearings are measured here from ${a.here ? "the phone's fix" : 'the given point'}. The feed was asked about a nearby ${QUERY_GRID_DEG}° grid point with a ${QUERY_PAD_NM} nm larger radius, so it never saw the exact position.`,
        'Owners as aircraft_lookup shows them: government registrants, corporations and LLCs by name; private owners as "private individual"; with city and state (owner_type is the FAA registrant type). aircraft_lookup gives the full record.',
        'Police and other helicopters often fly without ADS-B, so an empty or short list does not prove nothing is flying.',
      ];
      if (snap.fallback_reason)
        notes.push(
          `adsb.fi did not answer (${snap.fallback_reason}), so adsb.lol (ODbL 1.0) was used.`,
        );
      if (laddCount)
        notes.push(
          'LADD: the owner asked the FAA to limit display of this aircraft; its owner name is withheld everywhere except for government registrants.',
        );
      if (piaCount)
        notes.push('PIA: a temporary privacy address the FAA does not link to the registry.');
      if (!registryLoaded)
        notes.push('The FAA registry copy is not loaded yet, so US registrants are not shown.');
      if (withoutPosition)
        notes.push(
          `${withoutPosition} aircraft near the query point sent no position and are not listed.`,
        );

      const observedAt = new Date(snap.feed_now_ms ?? snap.fetched_at).toISOString();
      const ageS = Math.max(0, Math.round((now() - (snap.feed_now_ms ?? snap.fetched_at)) / 1000));
      const head = within.length
        ? `${within.length} aircraft within ${radius} nm of ${where}${within.length > rows.length ? ` (nearest ${rows.length} listed)` : ''}. Source ${snap.source}, data ${humanAge(ageS)} old${govCount ? `; ${govCount} government-registered` : ''}.`
        : `No aircraft with a position within ${radius} nm of ${where} (source ${snap.source}, data ${humanAge(ageS)} old).`;
      return {
        summary: [head, ...lines, ...notes].join('\n'),
        observedAt,
        data: {
          query: { ...query, radius_nm: radius },
          source: snap.source,
          attribution: [snap.credit, ...(registryLoaded ? [FAA_CREDIT] : [])].join('; '),
          ...(snap.fallback_reason ? { fallback_reason: snap.fallback_reason } : {}),
          observed_at: observedAt,
          retrieved_at: new Date(snap.fetched_at).toISOString(),
          count: within.length,
          returned: rows.length,
          aircraft: rows,
          registry: registryInfo(),
          notes,
        },
      };
    },
  };

  /** LADD status for one hex: live flag, remembered flags, then adsb.lol's list (6-hourly). */
  async function laddFor(
    hex: string,
    live: LiveAircraft | null | undefined,
    needed: boolean,
    signal: AbortSignal,
  ): Promise<{ ladd: boolean; checked: string[] }> {
    const checked: string[] = [];
    if (live) checked.push('live dbFlags (adsb.fi)');
    if (live && decodeDbFlags(live.db_flags).ladd) return { ladd: true, checked };
    if (deps.ladd.has(hex)) return { ladd: true, checked: [...checked, 'flags seen earlier'] };
    if (needed && deps.ladd.listIsStale()) {
      const list = await deps.live.laddHexes(signal);
      if (list) deps.ladd.mergeList(list);
      else deps.ladd.noteRefreshFailed();
    }
    if (deps.ladd.listAgeS !== undefined) checked.push("adsb.lol's list of LADD aircraft");
    return { ladd: deps.ladd.has(hex), checked };
  }

  const aircraftLookup: ToolDef = {
    name: 'aircraft_lookup',
    title: 'Aircraft registry lookup (FAA)',
    description:
      'Who an aircraft is registered to and what it is, from a local copy of the FAA registry: by ICAO hex or US N-number. N-number, serial, make/model/series, aircraft and engine type, year, registrant type (individual, partnership, corporation, co-owned, government, LLC, non-citizen), owner (government and companies by name; private owners as "private individual" with city and state; never street or ZIP), status, certificate and airworthiness dates, Mode S hex and the registry date. Flags government/police registrants. Also says whether it is flying now.',
    source: 'gateway',
    family: 'aviation',
    inputSchema: jsonSchema(AircraftLookupArgs),
    tags: [
      'aircraft owner',
      'who owns',
      'owner of plane',
      'registered owner',
      'faa registry',
      'faa',
      'n-number',
      'n number',
      'tail number',
      'registration',
      'icao hex',
      'mode s',
      'transponder',
      'police helicopter',
      'government aircraft',
      'aircraft type',
      'year built',
      'plane lookup',
      'helicopter owner',
    ],
    attribution: `${FAA_CREDIT}; live flags: ${ADSBFI_CREDIT}; LADD list: ${ADSBLOL_CREDIT}`,
    untrustedText: true,
    async run(args, ctx) {
      const parsed = AircraftLookupArgs.safeParse(args);
      if (!parsed.success) return invalid(zodMessage(parsed.error));
      const { hex, registration } = parsed.data;
      if ((hex === undefined) === (registration === undefined))
        return invalid('give exactly one of hex or registration');
      const registry = registryInfo();
      const base = (summary: string, data: Record<string, unknown>): ToolOutput => ({
        summary,
        data: { ...data, registry, attribution: FAA_CREDIT },
      });

      let icao: number;
      let rec: RegistryRecord | undefined;
      let match: 'mode_s_hex' | 'n_number' | 'n_number_from_algorithm' | 'none' = 'none';
      let label: string;
      if (hex !== undefined) {
        const h = parseHex(hex)!;
        label = `hex ${h.hex}`;
        if (h.nonIcao)
          return base(
            `~${h.hex.toLowerCase()} is a non-ICAO track id (TIS-B or similar), not a transponder address, so it has no registry record.`,
            { query: { hex }, match },
          );
        const block = classifyIcao(h.icao);
        if (block.kind === 'foreign')
          return base(
            `${h.hex} is not a US registration: it is in ${block.country ? `the ICAO address block of ${block.country}` : "another country's ICAO address block"}. Only the FAA (US) registry is covered.`,
            {
              query: { hex },
              match,
              block: 'not_us',
              ...(block.country ? { country: block.country } : {}),
            },
          );
        if (block.kind === 'us_military_federal')
          return base(
            `${h.hex} is in the US military/federal address block (ADF7C8-AFFFFF): there is no civil registry record for it.`,
            { query: { hex }, match, block: 'us_military_federal' },
          );
        if (block.kind === 'us_unassigned')
          return base(`${h.hex} is not assigned to any aircraft.`, { query: { hex }, match });
        icao = h.icao;
        rec = deps.store.byHex(h.hex);
        if (rec) match = 'mode_s_hex';
        else {
          const n = icaoToNNumber(icao);
          rec = n ? deps.store.byNNumber(n) : undefined;
          if (rec) match = 'n_number_from_algorithm';
        }
      } else {
        const raw = registration!.trim().toUpperCase();
        if (!looksLikeNNumber(raw))
          return base(
            `${raw} is not a US registration (US registrations are N-numbers such as N123AB). Only the FAA (US) registry is covered.`,
            { query: { registration }, match, block: 'not_us' },
          );
        const n = normalizeNNumber(raw);
        if (!n)
          return invalid(
            `${raw} is not a valid US N-number: after N come 1-5 characters, 1-5 digits, 1-4 digits and a letter, or 1-3 digits and two letters; the first digit is not 0 and I and O are never used`,
          );
        label = n;
        icao = nNumberToIcao(n)!;
        rec = deps.store.byNNumber(n);
        if (rec) match = 'n_number';
      }
      const algorithm = { n_number: icaoToNNumber(icao), hex: toHex(icao) };
      const liveHex = (rec?.mode_s_hex ?? toHex(icao)).toLowerCase();
      const live = await deps.live.byHex(liveHex, ctx.signal);
      if (live) deps.ladd.noteLive(live.hex, live.db_flags);
      const liveFlags = decodeDbFlags(live?.db_flags);
      const liveData = live
        ? {
            tracked: true,
            source: 'adsb.fi',
            ...(live.callsign ? { callsign: live.callsign } : {}),
            ...(live.registration ? { registration: live.registration } : {}),
            altitude_ft: live.altitude_ft ?? null,
            ...(live.ground_speed_kt !== undefined
              ? { ground_speed_kt: live.ground_speed_kt }
              : {}),
            ...(live.seen_s !== undefined ? { seen_s: live.seen_s } : {}),
            flags: { military: liveFlags.military, ladd: liveFlags.ladd, pia: liveFlags.pia },
            ...(live.lat !== undefined && live.lon !== undefined
              ? {
                  lat: live.lat,
                  lon: live.lon,
                  map_url: globeLink(deps.config.linkOrigin, live.lat, live.lon),
                }
              : {}),
          }
        : { tracked: live === undefined ? false : 'unknown' };
      const liveSentence = live
        ? ` It is being tracked now${live.callsign ? ` as ${live.callsign}` : ''}, ${fmtAlt(live.altitude_ft)} (adsb.fi).`
        : live === undefined
          ? ' adsb.fi is not tracking it right now.'
          : '';

      if (!rec) {
        const why = !deps.store.available
          ? 'The local FAA registry copy is not available yet (the daily sync has not completed), so only the address arithmetic can be given.'
          : liveFlags.pia
            ? 'The live feed marks this as a privacy ICAO address (PIA): the FAA deliberately does not link it to the registry.'
            : 'It is not in the current FAA registry: the number is unassigned, deregistered or reserved (or a privacy address, which the registry never lists).';
        return {
          summary: `${label}: no FAA registry record. ${why} By the US allocation scheme, ${algorithm.hex} is ${algorithm.n_number}.${liveSentence}`,
          data: {
            query: hex !== undefined ? { hex } : { registration },
            match,
            algorithm,
            live: liveData,
            registry,
            attribution: [FAA_CREDIT, ...(live ? [ADSBFI_CREDIT] : [])].join('; '),
          },
        };
      }

      const ladd = await laddFor(
        liveHex,
        live,
        policy.laddWithhold && wouldShowName(rec, policy),
        ctx.signal,
      );
      const owner = ownerView(rec, policy, ladd.ladd, 'lookup');
      const view = recordView(rec, owner);
      const notes: string[] = [];
      if (rec.mode_s_hex && rec.mode_s_hex !== algorithm.hex)
        notes.push(
          `The registry gives Mode S hex ${rec.mode_s_hex}; the allocation scheme gives ${algorithm.hex} for this N-number.`,
        );
      if (live?.registration && live.registration.replace(/-/g, '') !== `N${rec.n_number}`)
        notes.push(
          `The live feed labels this address ${live.registration}, the registry N${rec.n_number}: the feed's database or the transponder setting may be out of date.`,
        );
      if (owner.government || owner.registrant_kind === 'organization')
        notes.push('The registered owner is not necessarily the operator or who is flying it.');
      if (ladd.ladd)
        notes.push(
          'This aircraft is flagged LADD (its owner asked the FAA to limit display of its flights).',
        );
      const type = [
        rec.year_mfr,
        faaTypeName(rec),
        view.aircraft_type ? `(${view.aircraft_type as string})` : '',
      ]
        .filter(Boolean)
        .join(' ');
      const status = (view.status as { label?: string } | undefined)?.label;
      const regType = REGISTRANT_TYPES[rec.type_registrant ?? '']?.label;
      const summary =
        `N${rec.n_number} (Mode S hex ${rec.mode_s_hex ?? algorithm.hex}): ${type || 'type not in the FAA reference file'}${isDrone(rec) ? ', a drone (UAS up to 55 lb)' : ''}; ` +
        `${ownerSentence(owner)}${regType && !owner.owner_is_name && !owner.government ? ` (registrant type: ${regType})` : ''}; ` +
        `status: ${status ?? 'not given'}${view.registration_expires ? `, registration expires ${view.registration_expires as string}` : ''}.` +
        `${liveSentence} FAA registry as of ${registry.as_of ?? 'unknown'}.` +
        (notes.length ? `\n${notes.join('\n')}` : '');
      return {
        summary,
        data: {
          query: hex !== undefined ? { hex } : { registration },
          match,
          aircraft: view,
          algorithm,
          live: liveData,
          ladd: { flagged: ladd.ladd, checked: ladd.checked },
          registry,
          attribution: [FAA_CREDIT, ...(live ? [ADSBFI_CREDIT] : [])].join('; '),
          ...(notes.length ? { notes } : {}),
        },
      };
    },
  };

  return [flightsNear, aircraftLookup];
}
