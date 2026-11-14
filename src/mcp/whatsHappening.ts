/**
 * where_am_i and whats_happening_here.
 *
 * whats_happening_here fans out in parallel with per-source timeouts:
 *   rail (native) -> nearest line + crossing, with every name FRA and NARN give the track
 *   Pulse        -> rail_activity_near (relays Pulse's rail voice and EOT/HOT verdicts: quiet
 *                   only with Pulse's proof for the whole window), incidents_near (never
 *                   quiet: no proof), so 0 messages is never mistaken for "quiet"
 *   GEV          -> get_traffic_flow, find_cctv_cameras, get_weather
 * and returns one compact summary with each source's timestamp/age and error. For an explicit
 * point it also says how far Nathan's phone is from that point (src/location/proximity.ts).
 */
import type { Config } from '../config.js';
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
    `Ask Nathan to open ${publicOrigin}/locate/ on his phone (over Tailscale) and tap "Update My Location", ` +
    'or to check that OwnTracks is running and allowed to report location. ' +
    'Alternatively, ask him where he is and pass lat/lon explicitly.'
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
      `STALE: this fix is older than ${config.LOCATION_STALE_MINUTES} minutes, so Nathan may have moved. ` +
        `Say how old it is, and suggest he opens ${config.privateOrigin}/locate/ (needs Tailscale) or checks OwnTracks.`,
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
  status: 'ok' | 'error' | 'unavailable' | 'skipped';
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
  // An explicit point: is Nathan's phone actually there?
  const phone = usesCaller(args) ? deps.phoneCheck?.({ lat, lon }) : undefined;

  const runner = deps.runner;
  const registry = runner.registry;
  const retrievedAt = () => new Date(now()).toISOString();

  const runSource = async (
    source: string,
    toolName: string,
    toolArgs: Record<string, unknown>,
    timeoutMs: number,
    interpret: (out: ToolOutput) => Omit<SourceReport, 'source' | 'retrieved_at'>,
  ): Promise<SourceReport> => {
    const def = registry.get(toolName);
    if (!def) {
      const missing =
        toolName === 'nearest_rail'
          ? 'rail data is not loaded'
          : toolName.endsWith('_near')
            ? 'no Pulse data / Pulse tools not registered'
            : "God's Eye View is offline right now";
      return { source, status: 'unavailable', summary: missing, retrieved_at: retrievedAt() };
    }
    const verdict = registry.policy.evaluate(def);
    if (!verdict.allowed)
      return { source, status: 'skipped', summary: verdict.reason, retrieved_at: retrievedAt() };
    const rate = registry.policy.consumeRate(registry.policy.bucketsFor(def, toolArgs));
    if (!rate.ok) {
      return {
        source,
        status: 'skipped',
        summary: `skipped: rate limit for ${rate.bucket} (retry in ~${rate.retryAfterS} s)`,
        retrieved_at: retrievedAt(),
      };
    }
    const out = await runner.callRaw(def, toolArgs, ctx, timeoutMs);
    const rep = interpret(out);
    const obs = rep.observed_at ?? observedAt(out.data);
    const r: SourceReport = { source, retrieved_at: retrievedAt(), ...rep };
    if (obs) {
      r.observed_at = obs;
      r.age_s = Math.max(0, Math.round((now() - Date.parse(obs)) / 1000));
    }
    return r;
  };

  // Rail is local and fast; its subdivision feeds the Pulse rail query.
  const rail = await runSource('rail', 'nearest_rail', { lat, lon }, 3000, (out) => {
    if (out.isError) return { status: 'error', summary: out.summary };
    return { status: 'ok', summary: railLine((out.data ?? {}) as RailData), data: out.data };
  });

  const pulseDown = (out: ToolOutput) => out.isError && out.errorKind === 'unavailable';
  const [railRadio, incidents, traffic, cameras, weather] = await Promise.all([
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
      'traffic',
      'get_traffic_flow',
      { area: { lat, lon, radius_km: Math.min(radius, 10) } },
      30_000,
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
      'cameras',
      'find_cctv_cameras',
      { area: { lat, lon, radius_km: radius }, limit: 5 },
      45_000,
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
    ),
    runSource('weather', 'get_weather', { location: { lat, lon } }, 20_000, (out) => {
      if (out.isError) return { status: 'error', summary: out.summary };
      const d = { ...((out.data ?? {}) as Record<string, unknown>) };
      delete d.view;
      return { status: 'ok', summary: out.summary, data: d };
    }),
  ]);

  const sources = [rail, railRadio, incidents, traffic, cameras, weather];
  const label: Record<string, string> = {
    rail: 'Rail line & crossing',
    rail_radio: 'Rail radio (Pulse)',
    incidents: 'Incidents (Pulse)',
    traffic: 'Traffic',
    cameras: 'Cameras',
    weather: 'Weather',
  };
  const lines = [
    `What's happening within ${radius} km of ${lat.toFixed(4)}, ${lon.toFixed(4)} (${positionNote}):`,
  ];
  if (phone) lines.push(phone.note);
  for (const s of sources) {
    const age = s.age_s !== undefined ? ` [data ${humanAge(s.age_s)} old]` : '';
    const flag = s.status === 'ok' ? '' : ` (${s.status})`;
    lines.push(`- ${label[s.source] ?? s.source}${flag}: ${oneLine(s.summary)}${age}`);
  }
  lines.push(`Retrieved ${retrievedAt()}. Always tell Nathan how old each piece of data is.`);

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
  return postprocess(
    {
      name: 'whats_happening_here',
      source: 'gateway',
      untrustedText: true,
      attribution:
        'FRA/BTS rail data (public domain); Open-Meteo (CC BY 4.0); Traffic flow data © TomTom; camera operators as credited',
    },
    output,
    runner.postOptions,
  );
}

function usesCaller(a: WhatsHappeningArgs): boolean {
  return a.lat !== undefined && a.lon !== undefined;
}

function oneLine(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  // Room for the counts plus Pulse's rail voice and EOT/HOT verdicts (window, reasons, channels).
  return t.length > 1600 ? t.slice(0, 1597) + '…' : t;
}

function compact(v: unknown, keys: string[]): unknown {
  if (!v || typeof v !== 'object') return v;
  const out: Record<string, unknown> = {};
  for (const k of keys)
    if ((v as Record<string, unknown>)[k] !== undefined) out[k] = (v as Record<string, unknown>)[k];
  return out;
}
