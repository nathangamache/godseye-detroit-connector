/**
 * National Weather Service (api.weather.gov): active alerts for a point, and the 12-hour or
 * hourly forecast through /points -> forecast / forecastHourly.
 *
 * NWS asks for a User-Agent and publishes no rate limit; a client that goes over is told to
 * retry after about 5 s. /points answers rarely change, so the office/grid for each ~1 km cell
 * (0.01°) is cached and re-checked every 12 h, or at once when NWS says the grid is gone.
 * Gridpoint forecasts fail now and then with 500/503: those are retried twice, politely.
 * Text and data are public domain; results credit the National Weather Service.
 *
 * Points NWS doesn't cover are not asked about again and again: a point far from every US area
 * is answered without a request, and NWS's own "no data here" (a /points 404, or /alerts/active
 * saying the point is out of bounds) is remembered for 12 h per ~100 m cell. The cell is finer
 * than the ~1 km points cell on purpose: a 1 km cell can span both banks of a border river, and
 * a US point must never inherit its neighbour's "outside".
 */
import { z } from 'zod';
import { tempText } from '../../tools/units.js';
import type { ToolDef, ToolOutput } from '../../tools/types.js';
import {
  LOCATION_SHAPE,
  TtlCache,
  cleanText,
  coord,
  isoOrNull,
  jsonSchemaOf,
  num,
  oneLine,
  parseArgs,
  pointData,
  pointPhrase,
  resolvePoint,
  str,
  upstreamOutput,
  type PhoneDeps,
  type ResolvedPoint,
} from './common.js';
import { HttpClient, UpstreamError } from './http.js';

export const NWS_HOST = 'api.weather.gov';
const BASE = `https://${NWS_HOST}`;
const SERVICE = 'The National Weather Service API';
export const NWS_ATTRIBUTION =
  'National Weather Service (NOAA), api.weather.gov; public domain. Official warnings: weather.gov';

/** office/grid per ~1 km cell is re-checked this often. */
export const POINTS_TTL_MS = 12 * 3_600_000;
const ALERTS_TTL_MS = 30_000;
/** Forecasts are cached at most this long (less if NWS's Cache-Control says so). */
const FORECAST_MAX_TTL_MS = 10 * 60_000;
const MAX_ALERTS = 20;

const GEO_JSON = { accept: 'application/geo+json' };

export interface PointInfo {
  office: string;
  grid_x: number;
  grid_y: number;
  forecast_url: string;
  forecast_hourly_url: string;
  forecast_zone: string | null;
  zone_name: string | null;
  county: string | null;
  city: string | null;
  state: string | null;
  time_zone: string | null;
}

/** Thrown when NWS has no data for a point (outside the US and its waters). */
export class OutsideCoverageError extends Error {}

/**
 * Coarse boxes [latMin, latMax, lonMin, lonMax] around everything NWS covers: the states,
 * territories and adjacent waters. Generous on purpose: NWS itself decides every point inside
 * them; a point outside all of them is answered "outside" without a request.
 */
const NWS_BOXES: ReadonlyArray<readonly [number, number, number, number]> = [
  [14, 60, -140, -50], // lower 48, Puerto Rico, US Virgin Islands and adjacent waters
  [48, 75, -180, -125], // Alaska east of 180°
  [48, 60, 165, 180], // the western Aleutians
  [15, 32, -180, -150], // Hawaii and the Northwestern Hawaiian Islands
  [10, 23, 140, 150], // Guam and the Northern Mariana Islands
  [-17, -10, -174, -165], // American Samoa
];

/** False when a point is far from every area NWS covers. */
export function nwsMayCover(lat: number, lon: number): boolean {
  return NWS_BOXES.some(([a, b, c, d]) => lat >= a && lat <= b && lon >= c && lon <= d);
}

/** NWS's 400 for /alerts/active?point= outside its area ("Parameter "point" is invalid: out of bounds"). */
function isOutOfBounds(err: unknown): boolean {
  if (!(err instanceof UpstreamError) || err.kind !== 'http' || err.status !== 400) return false;
  const b = (err.body ?? {}) as { detail?: unknown; parameterErrors?: unknown };
  const texts = [b.detail];
  if (Array.isArray(b.parameterErrors))
    for (const p of b.parameterErrors) texts.push((p as { message?: unknown } | null)?.message);
  return texts.some((t) => typeof t === 'string' && /out of bounds/i.test(t));
}

const GRID_PATH = /^\/gridpoints\/[A-Z]{3}\/\d{1,3},\d{1,3}\/forecast(\/hourly)?$/;

/** A forecast URL from /points, used only if it is the expected api.weather.gov gridpoint path. */
function forecastUrl(
  given: unknown,
  office: string,
  x: number,
  y: number,
  hourly: boolean,
): string {
  if (typeof given === 'string') {
    try {
      const u = new URL(given);
      if (
        u.protocol === 'https:' &&
        u.hostname === NWS_HOST &&
        !u.search &&
        GRID_PATH.test(u.pathname) &&
        u.pathname.endsWith(hourly ? '/forecast/hourly' : '/forecast')
      )
        return u.toString();
    } catch {
      /* fall through */
    }
  }
  return `${BASE}/gridpoints/${office}/${x},${y}/forecast${hourly ? '/hourly' : ''}`;
}

const zoneId = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const m = /\/zones\/[a-z]+\/([A-Z]{2}[CZ]\d{3})$/.exec(v);
  return m ? m[1]! : null;
};

export class NwsClient {
  private readonly points: TtlCache<PointInfo>;
  private readonly alerts: TtlCache<unknown>;
  private readonly forecasts: TtlCache<unknown>;
  private readonly outside: TtlCache<true>;

  constructor(
    private readonly http: HttpClient,
    private readonly now: () => number,
  ) {
    this.points = new TtlCache(2_000, now);
    this.alerts = new TtlCache(500, now);
    this.forecasts = new TtlCache(500, now);
    this.outside = new TtlCache(2_000, now);
  }

  private static outsideCell(lat: number, lon: number): string {
    return `${lat.toFixed(3)},${lon.toFixed(3)}`;
  }

  /** True when NWS can't cover the point: far from every US area, or NWS said so recently. */
  knownOutside(lat: number, lon: number): boolean {
    return (
      !nwsMayCover(lat, lon) || this.outside.get(NwsClient.outsideCell(lat, lon)) !== undefined
    );
  }

  private markOutside(lat: number, lon: number): OutsideCoverageError {
    this.outside.set(NwsClient.outsideCell(lat, lon), true, POINTS_TTL_MS);
    return new OutsideCoverageError();
  }

  private get(path: string, signal?: AbortSignal) {
    return this.http.getJson<Record<string, unknown>>(new URL(path, BASE), {
      service: SERVICE,
      allowedHosts: [NWS_HOST],
      headers: GEO_JSON,
      signal,
    });
  }

  /** office/grid/zone for the ~1 km cell around a point (cached; re-checked every 12 h). */
  async point(lat: number, lon: number, signal?: AbortSignal, fresh = false): Promise<PointInfo> {
    if (this.knownOutside(lat, lon)) throw new OutsideCoverageError();
    const cell = `${lat.toFixed(2)},${lon.toFixed(2)}`;
    if (!fresh) {
      const hit = this.points.get(cell);
      if (hit) return hit;
    }
    let body: Record<string, unknown>;
    try {
      ({ body } = await this.get(`/points/${coord(lat)},${coord(lon)}`, signal));
    } catch (err) {
      if (err instanceof UpstreamError && err.kind === 'http' && err.status === 404)
        throw this.markOutside(lat, lon);
      throw err;
    }
    const p = (body.properties ?? {}) as Record<string, unknown>;
    const office = typeof p.gridId === 'string' && /^[A-Z]{3}$/.test(p.gridId) ? p.gridId : null;
    const x = num(p.gridX);
    const y = num(p.gridY);
    if (!office || x === null || y === null || !Number.isInteger(x) || !Number.isInteger(y))
      throw new OutsideCoverageError();
    const rel = ((p.relativeLocation as { properties?: Record<string, unknown> } | undefined)
      ?.properties ?? {}) as Record<string, unknown>;
    const info: PointInfo = {
      office,
      grid_x: x,
      grid_y: y,
      forecast_url: forecastUrl(p.forecast, office, x, y, false),
      forecast_hourly_url: forecastUrl(p.forecastHourly, office, x, y, true),
      forecast_zone: zoneId(p.forecastZone),
      zone_name: null,
      county: zoneId(p.county),
      city: str(rel.city, 80),
      state: str(rel.state, 10),
      time_zone: str(p.timeZone, 60),
    };
    if (info.forecast_zone) {
      // The zone's name, for "no active alerts for <zone>"; optional.
      try {
        const { body: z } = await this.get(`/zones/forecast/${info.forecast_zone}`, signal);
        info.zone_name = str((z.properties as Record<string, unknown> | undefined)?.name, 80);
      } catch {
        /* the zone id alone will do */
      }
    }
    this.points.set(cell, info, POINTS_TTL_MS);
    return info;
  }

  dropPoint(lat: number, lon: number): void {
    this.points.delete(`${lat.toFixed(2)},${lon.toFixed(2)}`);
  }

  async activeAlerts(lat: number, lon: number, signal?: AbortSignal): Promise<unknown> {
    if (this.knownOutside(lat, lon)) throw new OutsideCoverageError();
    const key = `${coord(lat)},${coord(lon)}`;
    const hit = this.alerts.get(key);
    if (hit) return hit;
    let body: Record<string, unknown>;
    try {
      ({ body } = await this.get(`/alerts/active?status=actual&point=${key}`, signal));
    } catch (err) {
      if (isOutOfBounds(err)) throw this.markOutside(lat, lon);
      throw err;
    }
    this.alerts.set(key, body, ALERTS_TTL_MS);
    return body;
  }

  async forecast(url: string, signal?: AbortSignal): Promise<unknown> {
    const hit = this.forecasts.get(url);
    if (hit) return hit;
    const { body, maxAgeS } = await this.http.getJson(new URL(url), {
      service: SERVICE,
      allowedHosts: [NWS_HOST],
      headers: GEO_JSON,
      signal,
    });
    const ttl = Math.min(FORECAST_MAX_TTL_MS, Math.max(60_000, (maxAgeS ?? 600) * 1000));
    this.forecasts.set(url, body, ttl);
    return body;
  }
}

const SEVERITY = ['Extreme', 'Severe', 'Moderate', 'Minor', 'Unknown'];
const URGENCY = ['Immediate', 'Expected', 'Future', 'Past', 'Unknown'];
const rank = (list: string[], v: unknown) => {
  const i = list.indexOf(String(v));
  return i < 0 ? list.length : i;
};

export interface AlertOut {
  event: string | null;
  severity: string | null;
  urgency: string | null;
  certainty: string | null;
  headline: string | null;
  description: string | null;
  instruction: string | null;
  areaDesc: string | null;
  onset: string | null;
  ends: string | null;
  expires: string | null;
  message_type: string | null;
  sender: string | null;
  url: string | null;
}

/** NWS alert features -> the fields this tool returns, most severe and urgent first. */
export function parseAlerts(body: unknown): {
  alerts: AlertOut[];
  total: number;
  updated: string | null;
} {
  const b = (body ?? {}) as { features?: unknown; updated?: unknown };
  const feats = Array.isArray(b.features) ? b.features : [];
  const alerts = feats
    .map((f) => ((f as { properties?: unknown })?.properties ?? {}) as Record<string, unknown>)
    .filter((p) => typeof p.event === 'string')
    .sort(
      (a, b) =>
        rank(SEVERITY, a.severity) - rank(SEVERITY, b.severity) ||
        rank(URGENCY, a.urgency) - rank(URGENCY, b.urgency) ||
        String(a.onset ?? a.effective ?? '').localeCompare(String(b.onset ?? b.effective ?? '')),
    )
    .map((p): AlertOut => ({
      event: str(p.event, 120),
      severity: str(p.severity, 20),
      urgency: str(p.urgency, 20),
      certainty: str(p.certainty, 20),
      headline: cleanText(p.headline, 400),
      description: cleanText(p.description, 4000),
      instruction: cleanText(p.instruction, 2000),
      areaDesc: cleanText(p.areaDesc, 600),
      onset: isoOrNull(p.onset) ?? isoOrNull(p.effective),
      ends: isoOrNull(p.ends),
      expires: isoOrNull(p.expires),
      message_type: str(p.messageType, 20),
      sender: str(p.senderName, 120) ?? str(p.sender, 120),
      url: alertUrl(p['@id']),
    }));
  return {
    alerts: alerts.slice(0, MAX_ALERTS),
    total: alerts.length,
    updated: isoOrNull(b.updated),
  };
}

function alertUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && u.hostname === NWS_HOST ? u.toString() : null;
  } catch {
    return null;
  }
}

export interface PeriodOut {
  name: string | null;
  start: string | null;
  end: string | null;
  is_daytime: boolean | null;
  temp: number | null;
  temp_unit: string | null;
  temp_trend: string | null;
  wind: string | null;
  precip_prob: number | null;
  dewpoint_c?: number | null;
  humidity_pct?: number | null;
  short: string | null;
  detailed: string | null;
}

export function parseForecast(
  body: unknown,
  periods: number,
  hourly: boolean,
): { periods: PeriodOut[]; updated: string | null; generated: string | null } {
  const p = ((body as { properties?: unknown } | undefined)?.properties ?? {}) as Record<
    string,
    unknown
  >;
  const list = Array.isArray(p.periods) ? (p.periods as Record<string, unknown>[]) : [];
  const out = list.slice(0, periods).map((x): PeriodOut => {
    const wind = [str(x.windDirection, 10), str(x.windSpeed, 40)].filter(Boolean).join(' ');
    const q = (v: unknown) => num((v as { value?: unknown } | undefined)?.value);
    return {
      name: str(x.name, 60),
      start: isoOrNull(x.startTime),
      end: isoOrNull(x.endTime),
      is_daytime: typeof x.isDaytime === 'boolean' ? x.isDaytime : null,
      temp: num(x.temperature),
      temp_unit: str(x.temperatureUnit, 4),
      temp_trend: str(x.temperatureTrend, 20),
      wind: wind || null,
      precip_prob: q(x.probabilityOfPrecipitation),
      ...(hourly
        ? {
            dewpoint_c: q(x.dewpoint) === null ? null : Math.round(q(x.dewpoint)! * 10) / 10,
            humidity_pct: q(x.relativeHumidity),
          }
        : {}),
      short: cleanText(x.shortForecast, 200),
      detailed: cleanText(x.detailedForecast, 1200),
    };
  });
  return { periods: out, updated: isoOrNull(p.updateTime), generated: isoOrNull(p.generatedAt) };
}

function zoneLabel(info: PointInfo | undefined): string {
  if (!info?.forecast_zone) return 'this point';
  const name = info.zone_name ? ` (${info.zone_name}${info.state ? `, ${info.state}` : ''})` : '';
  return `zone ${info.forecast_zone}${name}${info.county ? `, county ${info.county}` : ''}`;
}

function placeLabel(info: PointInfo): string {
  const near = info.city
    ? `near ${info.city}${info.state ? `, ${info.state}` : ''}`
    : 'for this point';
  return `${near} (NWS office ${info.office}, grid ${info.grid_x},${info.grid_y})`;
}

export interface NwsToolDeps {
  nws: NwsClient;
  phone: PhoneDeps;
}

const OUTSIDE =
  'The National Weather Service has no data for this point: it covers the United States, its territories and adjacent waters only.';

const ALERTS_ARGS = z.strictObject({ ...LOCATION_SHAPE });
const FORECAST_ARGS = z.strictObject({
  ...LOCATION_SHAPE,
  hourly: z.boolean().optional().describe('Hourly periods instead of 12-hour day/night periods'),
  periods: z
    .int()
    .min(1)
    .max(14)
    .optional()
    .describe('How many periods to return (default 14 for 12-hour, 12 for hourly)'),
});

const WEATHER_TAGS = [
  'weather warning',
  'warnings',
  'watch',
  'advisory',
  'alert',
  'alerts',
  'tornado',
  'tornado warning',
  'siren',
  'severe thunderstorm',
  'thunderstorm',
  'flood warning',
  'flash flood',
  'winter storm',
  'blizzard',
  'ice storm',
  'wind advisory',
  'heat advisory',
  'wind chill',
  'freeze warning',
  'dense fog',
  'special weather statement',
  'nws',
  'national weather service',
  'noaa',
];

const FORECAST_TAGS = [
  'forecast',
  'weather forecast',
  'tomorrow',
  'tonight',
  'this weekend',
  'hourly forecast',
  'will it rain',
  'chance of rain',
  'precipitation chance',
  'snow forecast',
  'temperature forecast',
  'high',
  'low',
  'nws',
  'national weather service',
];

export function nwsTools(deps: NwsToolDeps): ToolDef[] {
  const { nws } = deps;
  return [
    {
      name: 'weather_alerts',
      title: 'Active NWS weather alerts for a point',
      description:
        "Active National Weather Service watches, warnings and advisories (tornado, severe thunderstorm, flood, winter storm, wind, heat, fog...) that cover a point or the user's phone location (here: true): event, severity, urgency, certainty, headline, description, instruction, affected areas, onset, end, issuing office and link. Says so plainly when none are active for the point's forecast zone. United States only.",
      source: 'gateway',
      family: 'weather',
      inputSchema: jsonSchemaOf(ALERTS_ARGS),
      tags: WEATHER_TAGS,
      attribution: NWS_ATTRIBUTION,
      untrustedText: true,
      async run(args, ctx) {
        const a = parseArgs(ALERTS_ARGS, args, 'weather_alerts');
        if (!a.ok) return a.out;
        const r = resolvePoint('weather_alerts', a.value, ctx, deps.phone);
        if (!r.ok) return r.out;
        const pt = r.point;
        // Far away, or NWS said "no data here" recently: answered without a request.
        if (nws.knownOutside(pt.lat, pt.lon))
          return { summary: OUTSIDE, isError: true, errorKind: 'unsupported' };
        // The zone (for "no active alerts for <zone>") is a nice-to-have; alerts are not.
        const [zoneR, alertsR] = await Promise.allSettled([
          nws.point(pt.lat, pt.lon, ctx.signal),
          nws.activeAlerts(pt.lat, pt.lon, ctx.signal),
        ]);
        const outside = (x: PromiseSettledResult<unknown>) =>
          x.status === 'rejected' && x.reason instanceof OutsideCoverageError;
        if (outside(zoneR) || outside(alertsR))
          return { summary: OUTSIDE, isError: true, errorKind: 'unsupported' };
        if (alertsR.status === 'rejected')
          return upstreamOutput(
            alertsR.reason,
            'Alerts could not be checked: do not assume there are none; weather.gov shows the official list.',
          );
        const info = zoneR.status === 'fulfilled' ? zoneR.value : undefined;
        const { alerts, total, updated } = parseAlerts(alertsR.value);
        const where = zoneLabel(info);
        const zone = info
          ? {
              forecast_zone: info.forecast_zone,
              zone_name: info.zone_name,
              county: info.county,
              office: info.office,
            }
          : null;
        const asOf = updated ? ` (NWS list updated ${updated})` : '';
        if (!alerts.length) {
          return {
            summary: `No active alerts for ${where}${asOf}, at ${pointPhrase(pt)}.`,
            data: { point: pointData(pt), zone, count: 0, alerts: [], updated },
            observedAt: updated ?? undefined,
          };
        }
        const lines = alerts.slice(0, 8).map((x) => {
          const until = x.ends ?? x.expires;
          return `- ${x.event} (${[x.severity, x.urgency, x.certainty].filter(Boolean).join(', ')})${until ? ` until ${until}` : ''}: ${oneLine(x.headline ?? '', 300)}`;
        });
        const more = total > 8 ? `\n(+${total - 8} more in data)` : '';
        return {
          summary: `${total} active NWS alert(s) for ${where}${asOf}, at ${pointPhrase(pt)}:\n${lines.join('\n')}${more}\nDescriptions and instructions are the NWS's own text (in data); quote them rather than paraphrase safety instructions.`,
          data: {
            point: pointData(pt),
            zone,
            count: total,
            alerts,
            ...(total > alerts.length ? { alerts_omitted: total - alerts.length } : {}),
            updated,
          },
          observedAt: updated ?? undefined,
        };
      },
    },
    {
      name: 'weather_forecast',
      title: 'NWS forecast for a point',
      description:
        "National Weather Service forecast for a point or the user's phone location (here: true): 12-hour day/night periods for up to 7 days, or hourly periods (hourly: true), each with temperature, wind, chance of precipitation and the forecast text. United States only.",
      source: 'gateway',
      family: 'weather',
      inputSchema: jsonSchemaOf(FORECAST_ARGS),
      tags: FORECAST_TAGS,
      attribution: NWS_ATTRIBUTION,
      untrustedText: true,
      async run(args, ctx) {
        const a = parseArgs(FORECAST_ARGS, args, 'weather_forecast');
        if (!a.ok) return a.out;
        const r = resolvePoint('weather_forecast', a.value, ctx, deps.phone);
        if (!r.ok) return r.out;
        const pt = r.point;
        const hourly = a.value.hourly === true;
        const periods = a.value.periods ?? (hourly ? 12 : 14);
        if (nws.knownOutside(pt.lat, pt.lon))
          return { summary: OUTSIDE, isError: true, errorKind: 'unsupported' };
        try {
          return await forecastFor(nws, pt, hourly, periods, ctx.signal);
        } catch (err) {
          if (err instanceof OutsideCoverageError)
            return { summary: OUTSIDE, isError: true, errorKind: 'unsupported' };
          return upstreamOutput(err);
        }
      },
    },
  ];
}

async function forecastFor(
  nws: NwsClient,
  pt: ResolvedPoint,
  hourly: boolean,
  periods: number,
  signal: AbortSignal,
): Promise<ToolOutput> {
  let info = await nws.point(pt.lat, pt.lon, signal);
  let body: unknown;
  try {
    body = await nws.forecast(hourly ? info.forecast_hourly_url : info.forecast_url, signal);
  } catch (err) {
    // A grid NWS no longer serves (office or grid change): look the point up again, once.
    if (!(err instanceof UpstreamError && err.kind === 'http' && err.status === 404)) throw err;
    nws.dropPoint(pt.lat, pt.lon);
    info = await nws.point(pt.lat, pt.lon, signal, true);
    body = await nws.forecast(hourly ? info.forecast_hourly_url : info.forecast_url, signal);
  }
  const f = parseForecast(body, periods, hourly);
  if (!f.periods.length)
    return {
      summary: `The NWS returned no forecast periods ${placeLabel(info)}. Try again in a few minutes.`,
      isError: true,
      errorKind: 'retry_later',
    };
  // US units: the NWS answers in F; a period in C reads "39 F (4 C)" like the rest.
  const unit = (x: PeriodOut) =>
    x.temp === null
      ? ''
      : x.temp_unit?.toUpperCase() === 'C'
        ? tempText(x.temp)
        : `${x.temp}°${x.temp_unit ?? ''}`;
  const lines = f.periods.slice(0, hourly ? 12 : 6).map((x) => {
    const label = hourly ? (x.start ?? '') : (x.name ?? x.start ?? '');
    const bits = [
      x.short,
      unit(x),
      x.wind ? `wind ${x.wind}` : '',
      x.precip_prob !== null ? `precip ${x.precip_prob}%` : '',
    ].filter(Boolean);
    return `- ${label}: ${bits.join(', ')}`;
  });
  const updated = f.updated ? `, updated ${f.updated}` : '';
  return {
    summary: `NWS ${hourly ? 'hourly' : '12-hour'} forecast ${placeLabel(info)}${updated}, at ${pointPhrase(pt)}:\n${lines.join('\n')}${f.periods.length > lines.length ? `\n(${f.periods.length} periods in data)` : ''}`,
    data: {
      point: pointData(pt),
      office: info.office,
      grid: { x: info.grid_x, y: info.grid_y },
      near: info.city ? `${info.city}${info.state ? `, ${info.state}` : ''}` : null,
      time_zone: info.time_zone,
      hourly,
      updated: f.updated,
      generated_at: f.generated,
      periods: f.periods,
    },
    observedAt: f.updated ?? f.generated ?? undefined,
  };
}
