/**
 * where_am_i and whats_happening_here.
 *
 * whats_happening_here fans out in parallel, each section with its own short timeout inside one
 * overall budget (whatsHappeningBudgetMs), so a slow or failing source costs only its own line:
 *   rail (native) -> nearest line + crossing, with every name FRA and NARN give the track
 *   Pulse        -> rail_activity_near (relays Pulse's rail voice and EOT/HOT verdicts: quiet
 *                   only with Pulse's proof for the whole window), incidents_near (never
 *                   quiet: no proof), so 0 messages is never mistaken for "quiet"
 *   gateway      -> weather_alerts (NWS, the point), road_closures (nearest 5 within 5 km, every
 *                   enabled source), border_wait_times (only within 8 km of a Detroit/Windsor or
 *                   Port Huron crossing), air_quality ("not configured (AIRNOW_API_KEY)" without
 *                   its key)
 *   GEV          -> get_weather, get_traffic_flow, find_cctv_cameras (shown only when a camera
 *                   is in range: none in SE Michigan today)
 * and returns one compact summary with each source's timestamp/age and error. For an explicit
 * point it also says how far the user's phone is from that point (src/location/proximity.ts).
 */
import type { Config } from '../config.js';
import {
  crossingLabel,
  crossingsNear,
  waitLine,
  type Crossing,
  type WaitRow,
} from '../extra/roads/border.js';
import { ONTARIO_DISCLAIMER } from '../extra/roads/sources/ontario511.js';
import type { Point, ProximityCheck } from '../location/proximity.js';
import type { LocationStore } from '../location/store.js';
import { postprocess, type McpToolResult } from '../tools/postprocess.js';
import type { ToolRunner } from '../tools/runner.js';
import type { ToolContext, ToolOutput } from '../tools/types.js';
import { formatLineNames, titleCase, type LineName } from '../rail/names.js';
import { humanAge } from '../util/format.js';

export interface PositionInfo {
  lat: number;
  lon: number;
  accuracy_m: number | null;
  timestamp: string;
  age_s: number;
  stale: boolean;
  device: string;
  source: string;
}

export function currentPosition(
  store: LocationStore,
  staleMinutes: number,
  now = Date.now(),
): PositionInfo | undefined {
  const fix = store.latest();
  if (!fix) return undefined;
  const age = Math.max(0, Math.round((now - fix.fix_ts) / 1000));
  return {
    lat: fix.lat,
    lon: fix.lon,
    accuracy_m: fix.accuracy_m === null ? null : Math.round(fix.accuracy_m),
    timestamp: new Date(fix.fix_ts).toISOString(),
    age_s: age,
    stale: age > staleMinutes * 60,
    device: fix.device,
    source: fix.source,
  };
}

export function noFixMessage(publicOrigin: string, retentionHours: number): string {
  return (
    `No phone location fix is available (none received in the last ${retentionHours} h). ` +
    `Ask the user to open ${publicOrigin}/locate/ on the phone (over Tailscale) and tap "Update My Location", ` +
    'or to check that OwnTracks is running and allowed to report location. ' +
    'Alternatively, ask the user for the place and pass lat/lon explicitly.'
  );
}

export function whereAmI(store: LocationStore, config: Config, now = Date.now()): McpToolResult {
  const pos = currentPosition(store, config.LOCATION_STALE_MINUTES, now);
  if (!pos) {
    return {
      content: [
        {
          type: 'text',
          text: noFixMessage(config.privateOrigin, config.LOCATION_RETENTION_HOURS),
        },
        { type: 'text', text: JSON.stringify({ found: false }) },
      ],
    };
  }
  const acc = pos.accuracy_m === null ? '' : ` ±${pos.accuracy_m} m`;
  const lines = [
    `Latest phone fix: ${pos.lat.toFixed(5)}, ${pos.lon.toFixed(5)}${acc}, taken ${pos.timestamp} (${humanAge(pos.age_s)} ago) from ${pos.device} via ${pos.source}.`,
  ];
  if (pos.stale) {
    lines.push(
      `STALE: this fix is older than ${config.LOCATION_STALE_MINUTES} minutes, so the user may have moved. ` +
        `Say how old it is, and suggest opening ${config.privateOrigin}/locate/ (needs Tailscale) or checking OwnTracks.`,
    );
  }
  return {
    content: [
      { type: 'text', text: lines.join('\n') },
      { type: 'text', text: JSON.stringify({ found: true, ...pos }) },
    ],
  };
}

export { humanAge };

interface SourceReport {
  source: string;
  /** not_configured: the tool's API key is missing (the line names it; nothing was fetched). */
  status: 'ok' | 'error' | 'unavailable' | 'skipped' | 'not_configured';
  summary: string;
  retrieved_at: string;
  observed_at?: string;
  age_s?: number;
  data?: unknown;
}

const OBSERVED_KEYS = [
  'observed_at',
  'observedAt',
  'as_of',
  'generated_at',
  'updated_at',
  'time',
  'timestamp',
];

function observedAt(data: unknown, depth = 0): string | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  for (const k of OBSERVED_KEYS) {
    const v = (data as Record<string, unknown>)[k];
    if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
    if (typeof v === 'number' && v > 1e9) return new Date(v > 1e12 ? v : v * 1000).toISOString();
  }
  // One level down (e.g. GEV get_weather returns {weather: {observed_at}}).
  if (depth === 0) {
    for (const v of Object.values(data as Record<string, unknown>)) {
      const hit = observedAt(v, 1);
      if (hit) return hit;
    }
  }
  return undefined;
}

interface RailData {
  line?: {
    railroad?: string;
    subdivision?: string;
    line_names?: LineName[];
    kind?: string;
    distance_m?: number;
    direction?: string;
  } | null;
  main_line?: {
    railroad?: string;
    subdivision?: string;
    line_names?: LineName[];
    distance_m?: number;
    direction?: string;
  } | null;
  crossing?: {
    fra_crossing_id?: string;
    street?: string;
    railroad?: string;
    subdivision?: string;
    line_names?: LineName[];
    distance_m?: number;
    direction?: string;
    warning_devices?: string;
    trains_per_day?: number;
  } | null;
  dataset_as_of?: string;
}

/** Compact one-line rail summary for the combined report. */
export function railLine(d: RailData): string {
  const m = (n?: number) =>
    n === undefined ? '?' : n < 1000 ? `${n} m` : `${(n / 1000).toFixed(1)} km`;
  // Every name the datasets give the track ("[NARN: X Sub; FRA: Y Sub]"), else the one name.
  const sub = (s?: string, names?: LineName[]) =>
    names?.length ? ` [${formatLineNames(names)}]` : s ? ` ${titleCase(s)} Sub` : '';
  const parts: string[] = [];
  if (d.line)
    parts.push(
      `nearest track ${d.line.railroad ?? 'unknown railroad'}${sub(d.line.subdivision, d.line.line_names)} (${d.line.kind ?? 'track'}) ${m(d.line.distance_m)} ${d.line.direction ?? ''}`.trim(),
    );
  if (d.main_line)
    parts.push(
      `main line ${d.main_line.railroad ?? ''}${sub(d.main_line.subdivision, d.main_line.line_names)} ${m(d.main_line.distance_m)} ${d.main_line.direction ?? ''}`.trim(),
    );
  const c = d.crossing;
  if (c) {
    const extras = [
      c.warning_devices,
      c.trains_per_day !== undefined ? `~${c.trains_per_day} trains/day` : undefined,
    ]
      .filter(Boolean)
      .join(', ');
    parts.push(
      `crossing FRA ${c.fra_crossing_id}${c.street ? ` at ${titleCase(c.street)}` : ''} (${c.railroad ?? ''}${sub(c.subdivision, c.line_names)}) ${m(c.distance_m)} ${c.direction ?? ''}${extras ? `; ${extras}` : ''}`,
    );
  }
  if (!parts.length) return 'no rail line or crossing in range (Michigan data only)';
  return `${parts.join('; ')} [FRA/NARN inventory, revised through ${d.dataset_as_of ?? 'unknown'}; not live train positions]`;
}

export interface WhatsHappeningDeps {
  config: Config;
  runner: ToolRunner;
  locations: LocationStore;
  now?: () => number;
  /** Explicit point only: distance/bearing of the phone's recent fix (audited by the caller). */
  phoneCheck?: (p: Point) => ProximityCheck | undefined;
  /** Overall time budget in ms (default whatsHappeningBudgetMs). */
  budgetMs?: number;
}

export interface WhatsHappeningArgs {
  lat?: number;
  lon?: number;
  radius_km?: number;
}

export async function whatsHappeningHere(
  deps: WhatsHappeningDeps,
  args: WhatsHappeningArgs,
  ctx: ToolContext,
): Promise<McpToolResult> {
  const now = deps.now ?? Date.now;
  const radius = Math.min(25, Math.max(0.2, args.radius_km ?? 3));
  let lat = args.lat;
  let lon = args.lon;
  let positionNote: string;
  if (lat === undefined || lon === undefined) {
    if (lat !== undefined || lon !== undefined) {
      return {
        content: [
          { type: 'text', text: 'Give both lat and lon, or neither (to use the phone location).' },
        ],
        isError: true,
      };
    }
    const pos = currentPosition(deps.locations, deps.config.LOCATION_STALE_MINUTES, now());
    if (!pos) {
      return {
        content: [
          {
            type: 'text',
            text: noFixMessage(deps.config.privateOrigin, deps.config.LOCATION_RETENTION_HOURS),
          },
        ],
      };
    }
    lat = pos.lat;
    lon = pos.lon;
    const acc = pos.accuracy_m === null ? '' : `, ±${pos.accuracy_m} m`;
    positionNote = `position from phone fix ${humanAge(pos.age_s)} old${acc}${pos.stale ? ' (STALE: may have moved)' : ''}`;
  } else {
    positionNote = 'position supplied by caller';
  }
  // An explicit point: is the user's phone actually there?
  const phone = usesCaller(args) ? deps.phoneCheck?.({ lat, lon }) : undefined;

  const runner = deps.runner;
  const registry = runner.registry;
  const retrievedAt = () => new Date(now()).toISOString();
  // The budget runs on the real clock (deps.now only dates the data).
  const started = Date.now();
  const budget = deps.budgetMs ?? whatsHappeningBudgetMs(deps.config);
  const credits: string[] = [];

  const runSource = async (
    source: string,
    toolName: string,
    toolArgs: Record<string, unknown>,
    timeoutMs: number,
    interpret: (out: ToolOutput) => Omit<SourceReport, 'source' | 'retrieved_at'>,
    opts: {
      /** Leave the section out when the tool is missing or switched off by policy. */
      optional?: boolean;
      /** Credit the tool's own attribution when the section is shown. */
      credit?: boolean;
    } = {},
  ): Promise<SourceReport | undefined> => {
    const def = registry.get(toolName);
    if (!def) {
      if (opts.optional) return undefined;
      const missing =
        toolName === 'nearest_rail'
          ? 'rail data is not loaded'
          : toolName.endsWith('_near')
            ? 'no Pulse data / Pulse tools not registered'
            : GATEWAY_SECTIONS.has(toolName)
              ? `${toolName} is not available in this deployment`
              : "God's Eye View is offline right now";
      return { source, status: 'unavailable', summary: missing, retrieved_at: retrievedAt() };
    }
    const verdict = registry.policy.evaluate(def);
    if (!verdict.allowed) {
      if (opts.optional) return undefined;
      return { source, status: 'skipped', summary: verdict.reason, retrieved_at: retrievedAt() };
    }
    // A key-gated tool without its key: said so, never left out, and nothing is fetched.
    if (def.needsKey)
      return {
        source,
        status: 'not_configured',
        summary: `not configured (${def.needsKey.env})`,
        retrieved_at: retrievedAt(),
      };
    const left = budget - (Date.now() - started);
    if (left < MIN_SECTION_MS)
      return {
        source,
        status: 'skipped',
        summary: 'skipped: the time budget of this summary was spent',
        retrieved_at: retrievedAt(),
      };
    const rate = registry.policy.consumeRate(registry.policy.bucketsFor(def, toolArgs));
    if (!rate.ok) {
      return {
        source,
        status: 'skipped',
        summary: `skipped: rate limit for ${rate.bucket} (retry in ~${rate.retryAfterS} s)`,
        retrieved_at: retrievedAt(),
      };
    }
    const out = await runner.callRaw(def, toolArgs, ctx, Math.min(timeoutMs, left));
    const rep = interpret(out);
    const obs = rep.observed_at ?? observedAt(out.data);
    const r: SourceReport = { source, retrieved_at: retrievedAt(), ...rep };
    if (obs) {
      r.observed_at = obs;
      r.age_s = Math.max(0, Math.round((now() - Date.parse(obs)) / 1000));
    }
    if (opts.credit && r.status === 'ok' && def.attribution) credits.push(def.attribution);
    return r;
  };

  // Rail is local and fast; its subdivision feeds the Pulse rail query.
  const rail = (await runSource('rail', 'nearest_rail', { lat, lon }, 3000, (out) => {
    if (out.isError) return { status: 'error', summary: out.summary };
    return { status: 'ok', summary: railLine((out.data ?? {}) as RailData), data: out.data };
  }))!;

  const pulseDown = (out: ToolOutput) => out.isError && out.errorKind === 'unavailable';
  const nearCrossings = crossingsNear({ lat, lon }, BORDER_NEAR_KM);
  const [railRadio, incidents, alerts, weather, air, traffic, closures, border, cameras] =
    await Promise.all([
      // The rail tool works out every name the track here has and matches Pulse's coverage on
      // all of them; it asks Pulse twice (feeds/status, then rail/activity).
      runSource(
        'rail_radio',
        'rail_activity_near',
        { lat, lon, since_minutes: 30 },
        2 * deps.config.PULSE_TIMEOUT_MS + 500,
        (out) =>
          pulseDown(out)
            ? { status: 'unavailable', summary: 'no Pulse data / no rail radio coverage yet' }
            : out.isError
              ? { status: 'error', summary: out.summary }
              : { status: 'ok', summary: out.summary, data: out.data },
      ),
      runSource(
        'incidents',
        'incidents_near',
        { lat, lon, radius_km: radius, since_minutes: 120 },
        deps.config.PULSE_TIMEOUT_MS + 500,
        (out) =>
          pulseDown(out)
            ? { status: 'unavailable', summary: 'no Pulse data (Pulse is not running yet)' }
            : out.isError
              ? { status: 'error', summary: out.summary }
              : { status: 'ok', summary: out.summary, data: out.data },
      ),
      runSource(
        'weather_alerts',
        'weather_alerts',
        { lat, lon },
        8_000,
        (out) => {
          if (out.isError)
            return {
              status: out.errorKind === 'unsupported' ? 'unavailable' : 'error',
              summary: out.summary,
            };
          const d = (out.data ?? {}) as { count?: number; zone?: unknown; alerts?: unknown[] };
          return {
            status: 'ok',
            summary: out.summary,
            observed_at: isoOrUndefined(out.observedAt),
            data: { count: d.count, zone: d.zone, alerts: (d.alerts ?? []).slice(0, 5) },
          };
        },
        { credit: true },
      ),
      runSource('weather', 'get_weather', { location: { lat, lon } }, 10_000, (out) => {
        if (out.isError) return { status: 'error', summary: out.summary };
        const d = { ...((out.data ?? {}) as Record<string, unknown>) };
        delete d.view;
        return { status: 'ok', summary: out.summary, data: d };
      }),
      // Without AIRNOW_API_KEY the line says "not configured (AIRNOW_API_KEY)".
      runSource(
        'air_quality',
        'air_quality',
        { lat, lon },
        8_000,
        (out) =>
          out.isError
            ? { status: 'error', summary: out.summary }
            : {
                status: 'ok',
                summary: out.summary,
                data: compact(out.data, ['note', 'observations', 'forecast', 'retrieved_at']),
              },
        { credit: true },
      ),
      runSource(
        'traffic',
        'get_traffic_flow',
        { area: { lat, lon, radius_km: Math.min(radius, 10) } },
        12_000,
        (out) => {
          if (out.isError && /tomtom/i.test(out.summary))
            return { status: 'unavailable', summary: 'traffic needs a TomTom key' };
          if (out.isError) return { status: 'error', summary: out.summary };
          return {
            status: 'ok',
            summary: out.summary,
            data: compact(out.data, [
              'congested_km',
              'closed_km',
              'by_category',
              'observed_at',
              'map_url',
            ]),
          };
        },
      ),
      runSource(
        'road_closures',
        'road_closures',
        { lat, lon, radius_km: CLOSURES_RADIUS_KM, limit: CLOSURES_SHOWN },
        12_000,
        (out) => closuresReport(out, credits),
      ),
      nearCrossings.length
        ? runSource(
            'border',
            'border_wait_times',
            {},
            8_000,
            (out) => borderReport(out, nearCrossings),
            { credit: true },
          )
        : undefined,
      // Public cameras: shown only when one is in range (none in SE Michigan today).
      runSource(
        'cameras',
        'find_cctv_cameras',
        { area: { lat, lon, radius_km: radius }, limit: 5 },
        8_000,
        (out) => {
          if (out.isError) return { status: 'error', summary: out.summary };
          const d = (out.data ?? {}) as { cameras?: unknown[]; total?: number };
          const cams = Array.isArray(d.cameras)
            ? d.cameras
                .slice(0, 5)
                .map((c) => compact(c, ['id', 'name', 'city', 'distance_km', 'provider', 'credit']))
            : undefined;
          return { status: 'ok', summary: out.summary, data: { total: d.total, cameras: cams } };
        },
        { optional: true },
      ),
    ]);
  const camerasInRange =
    cameras?.status === 'ok' &&
    ((cameras.data as { cameras?: unknown[] } | undefined)?.cameras?.length ?? 0) > 0;

  const sources = [
    rail,
    railRadio,
    incidents,
    alerts,
    weather,
    air,
    traffic,
    closures,
    border,
    camerasInRange ? cameras : undefined,
  ].filter((s): s is SourceReport => s !== undefined);
  const label: Record<string, string> = {
    rail: 'Rail line & crossing',
    rail_radio: 'Rail radio (Pulse)',
    incidents: 'Incidents (Pulse)',
    weather_alerts: 'Weather alerts (NWS)',
    weather: 'Weather',
    air_quality: 'Air quality (AirNow)',
    traffic: 'Traffic',
    road_closures: 'Road closures',
    border: 'Border waits',
    cameras: 'Cameras',
  };
  const lines = [
    `What's happening within ${radius} km of ${lat.toFixed(4)}, ${lon.toFixed(4)} (${positionNote}):`,
  ];
  if (phone) lines.push(phone.note);
  for (const s of sources) {
    const age = s.age_s !== undefined ? ` [data ${humanAge(s.age_s)} old]` : '';
    const flag = s.status === 'ok' || s.status === 'not_configured' ? '' : ` (${s.status})`;
    lines.push(`- ${label[s.source] ?? s.source}${flag}: ${oneLine(s.summary)}${age}`);
  }
  lines.push(`Retrieved ${retrievedAt()}. Always tell the user how old each piece of data is.`);

  const output: ToolOutput = {
    summary: lines.join('\n'),
    data: {
      center: { lat, lon },
      radius_km: radius,
      position: positionNote,
      ...(phone
        ? {
            owner_phone: {
              distance_km: phone.distance_km,
              bearing_from_point_deg: phone.bearing_deg,
              compass_from_point: phone.compass,
              fix_age_s: phone.fix_age_s,
              at_this_place: phone.at_place,
            },
          }
        : {}),
      sources,
    },
  };
  const attribution = [
    'FRA/BTS rail data (public domain); Open-Meteo (CC BY 4.0); Traffic flow data © TomTom',
    ...credits,
    ...(camerasInRange ? ['camera operators as credited'] : []),
  ];
  return postprocess(
    {
      name: 'whats_happening_here',
      source: 'gateway',
      untrustedText: true,
      attribution: [...new Set(attribution)].join('; '),
    },
    output,
    runner.postOptions,
  );
}

/** Gateway-native tools whose section says "not available" (not "GEV offline") when missing. */
const GATEWAY_SECTIONS = new Set([
  'weather_alerts',
  'air_quality',
  'road_closures',
  'border_wait_times',
]);
/** A section that would get less than this of the budget is skipped, not started. */
const MIN_SECTION_MS = 250;
/** Crossings this close to the point get a border-waits section. */
export const BORDER_NEAR_KM = 8;
/** Road closures: within this radius, at most this many (nearest first). */
export const CLOSURES_RADIUS_KM = 5;
export const CLOSURES_SHOWN = 5;

/**
 * Overall time budget of one call: every section gets at most what is left of it. Never shorter
 * than the rail and Pulse sections' own timeouts (rail radio asks Pulse twice).
 */
export function whatsHappeningBudgetMs(config: Pick<Config, 'PULSE_TIMEOUT_MS'>): number {
  return Math.max(15_000, 3_000 + 2 * config.PULSE_TIMEOUT_MS + 1_000);
}

function isoOrUndefined(s: string | undefined): string | undefined {
  return s && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString() : undefined;
}

interface ClosureItemData {
  source?: string;
  type?: string;
  road?: string | null;
  direction?: string | null;
  full_closure?: boolean;
  distance_km?: number | null;
}
interface ClosureSourceData {
  source?: string;
  label?: string;
  status?: string;
  count?: number;
  note?: string;
}

/** road_closures, nearest few, with every enabled source and what it found. */
function closuresReport(
  out: ToolOutput,
  credits: string[],
): Omit<SourceReport, 'source' | 'retrieved_at'> {
  if (out.isError) return { status: 'error', summary: out.summary };
  const d = (out.data ?? {}) as {
    items?: ClosureItemData[];
    sources?: ClosureSourceData[];
    attribution?: string[];
    disclaimer?: string;
  };
  const items = (d.items ?? []).slice(0, CLOSURES_SHOWN);
  // Ontario 511's licence: its "as is" disclaimer goes with every result that uses its data.
  const ontario = typeof d.disclaimer === 'string' || items.some((i) => i.source === 'ontario511');
  const disclaimer = ontario ? { disclaimer: ONTARIO_DISCLAIMER } : {};
  const asIs = ontario ? ` ${ONTARIO_DISCLAIMER}` : '';
  const reports = d.sources ?? [];
  const labelOf = new Map(reports.map((r) => [r.source, r.label ?? r.source ?? '?']));
  // Sources that are off (no key, licence switch) aren't "checked"; the tool itself says so.
  const enabled = reports.filter((r) => r.status !== 'off' && r.status !== 'not_configured');
  const checked = enabled.length
    ? enabled
        .map((r) => `${r.label}: ${r.status === 'ok' ? (r.count ?? 0) : (r.note ?? r.status)}`)
        .join('; ')
    : 'none (no road source is enabled)';
  const within = `within ${CLOSURES_RADIUS_KM} km`;
  if (!items.length)
    return {
      status: 'ok',
      summary: `No closures, incidents or work zones found ${within} in the sources checked, which is not proof the roads are open. Sources checked: ${checked}.${asIs}`,
      data: { count: 0, items: [], sources: enabled, ...disclaimer },
    };
  for (const a of d.attribution ?? []) credits.push(a);
  const full = items.filter((i) => i.full_closure).length;
  const text = items
    .map((i) => {
      const where = i.road ? ` on ${i.road}${i.direction ? ` ${i.direction}` : ''}` : '';
      const dist = typeof i.distance_km === 'number' ? `${i.distance_km} km, ` : '';
      return `${i.full_closure ? 'FULL CLOSURE: ' : ''}${i.type ?? 'item'}${where} (${dist}${labelOf.get(i.source) ?? i.source})`;
    })
    .join('; ');
  const more =
    items.length >= CLOSURES_SHOWN ? ` More may exist: road_closures lists up to 50.` : '';
  return {
    status: 'ok',
    summary: `${items.length} item(s) ${within} (${full} full closure(s)); nearest ${items.length}: ${text}. Sources checked: ${checked}.${more}${asIs}`,
    data: {
      count: items.length,
      items: items.map((i) =>
        compact(i, [
          'source',
          'type',
          'road',
          'direction',
          'full_closure',
          'lanes',
          'from_cross_street',
          'to_cross_street',
          'start',
          'end',
          'updated',
          'distance_km',
        ]),
      ),
      sources: enabled,
      ...disclaimer,
    },
  };
}

/** border_wait_times, for the crossings near the point only. */
function borderReport(
  out: ToolOutput,
  near: Crossing[],
): Omit<SourceReport, 'source' | 'retrieved_at'> {
  if (out.isError) return { status: 'error', summary: out.summary };
  const d = (out.data ?? {}) as { rows?: WaitRow[]; errors?: string[] };
  const rows = (d.rows ?? []).filter((r) => near.includes(r.crossing));
  const errors = d.errors ?? [];
  const main = rows.filter((r) => /^(passenger|commercial)$/.test(r.lane_type));
  const missing = errors.length ? ` Missing: ${errors.join('; ')}.` : '';
  const newest = rows
    .map((r) => (r.updated ? Date.parse(r.updated) : NaN))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b)
    .pop();
  const names = near.map(crossingLabel).join(', ');
  return {
    status: 'ok',
    summary: rows.length
      ? `${(main.length ? main : rows).slice(0, 8).map(waitLine).join('; ')}.${missing}`
      : `No wait times reported for ${names}.${missing}`,
    ...(newest !== undefined ? { observed_at: new Date(newest).toISOString() } : {}),
    data: { crossings: near, rows, errors },
  };
}

function usesCaller(a: WhatsHappeningArgs): boolean {
  return a.lat !== undefined && a.lon !== undefined;
}

function oneLine(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  // Room for the counts plus Pulse's rail voice and EOT/HOT verdicts (window, channels and up to
  // 600 characters of reasons each, src/pulse/coverage.ts reasonText).
  return t.length > 2000 ? t.slice(0, 1997) + '…' : t;
}

function compact(v: unknown, keys: string[]): unknown {
  if (!v || typeof v !== 'object') return v;
  const out: Record<string, unknown> = {};
  for (const k of keys)
    if ((v as Record<string, unknown>)[k] !== undefined) out[k] = (v as Record<string, unknown>)[k];
  return out;
}
