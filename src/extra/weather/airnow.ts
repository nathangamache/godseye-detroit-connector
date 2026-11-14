/**
 * EPA AirNow (www.airnowapi.org, free key in AIRNOW_API_KEY; off without one): current AQI
 * observations and forecasts for the reporting area AirNow matches to a point.
 *
 * AirNow's Data Exchange Guidelines: observations are preliminary and must be shown as such;
 * credit the reporting agency and EPA AirNow; values, forecasts, advisories and their names must
 * not be altered. So every value here is passed through as received (an AQI of -1 included:
 * AirNow's way of saying a forecast gives only a category).
 * AirNow recommends caching (observations change hourly, forecasts daily): answers are cached
 * for 30 minutes.
 *
 * The services are the ones AirNow's June 2026 notice introduced (the old lat/long services were
 * retired on 2026-09-30, so they are never asked): "Current Observations by Latitude/Longitude or
 * ZIP Code" (/aq/observation/current/ziplatlong/) and "Current Forecasts by Reporting Area"
 * (/aq/forecast/current/). Both take format, latitude, longitude and the key. AirNow picks the
 * reporting area with its own fixed lookup boundary, so no distance is sent. Records are
 * lowerCamelCase: observations carry nowcastAQI, aqiCategoryName, reportingAreaName,
 * hourObserved ("14:00"), siteName and reportingAgency, but no stateCode; forecasts carry aqi,
 * categoryName, categoryNumber, reportingArea, stateCode, dateValid and forecastAgency.
 * "Nothing matched" comes as {"WebServiceError":[{"Message":"There are no ..."}]}: an empty
 * answer, not an error.
 */
import { z } from 'zod';
import type { ToolDef, ToolOutput } from '../../tools/types.js';
import {
  LOCATION_SHAPE,
  TtlCache,
  cleanText,
  coord,
  jsonSchemaOf,
  oneLine,
  parseArgs,
  pointData,
  pointPhrase,
  resolvePoint,
  str,
  type PhoneDeps,
  type ResolvedPoint,
} from './common.js';
import { HttpClient, UpstreamError } from './http.js';

export const AIRNOW_HOST = 'www.airnowapi.org';
export const AIRNOW_OFF_REASON = 'not configured: set AIRNOW_API_KEY in deploy/secrets/gateway.env';
export const AIRNOW_ATTRIBUTION =
  'Preliminary data, not fully verified; source: the reporting air quality agency (Michigan EGLE for Michigan) and U.S. EPA AirNow (airnow.gov)';
const CACHE_MS = 30 * 60_000;

export const AIRNOW_PATHS = {
  observations: '/aq/observation/current/ziplatlong/',
  forecast: '/aq/forecast/current/',
} as const;

/** AirNow's wording for "nothing matched" (not an error). */
const NO_DATA = /^(Error - )?There (are|is) no /i;

type Rec = Record<string, unknown>;

/** Case-insensitive field lookup (exact names first). */
function field(o: Rec, ...names: string[]): unknown {
  for (const n of names) if (n in o) return o[n];
  const lower = new Map(Object.keys(o).map((k) => [k.toLowerCase(), k]));
  for (const n of names) {
    const k = lower.get(n.toLowerCase());
    if (k !== undefined) return o[k];
  }
  return undefined;
}

export interface AqValue {
  pollutant: unknown;
  aqi: unknown;
  category: unknown;
  category_number: unknown;
}

export interface AqObservedValue extends AqValue {
  /** The monitoring site the reading came from (AirNow: closest reading by pollutant). */
  site: unknown;
  agency: unknown;
}

export interface AqObservationArea {
  reporting_area: unknown;
  state: unknown;
  date_observed: unknown;
  hour_observed: unknown;
  time_zone: unknown;
  lookup_boundary: unknown;
  values: AqObservedValue[];
}

export interface AqForecast extends AqValue {
  reporting_area: unknown;
  state: unknown;
  date_issue: unknown;
  date_forecast: unknown;
  agency: unknown;
  action_day: unknown;
  discussion: string | null;
}

/** AirNow sends an array of records; tolerate an object wrapping one. */
function records(body: unknown): Rec[] {
  if (Array.isArray(body)) return body.filter((r): r is Rec => Boolean(r) && typeof r === 'object');
  if (body && typeof body === 'object') {
    for (const v of Object.values(body as Rec))
      if (Array.isArray(v) && v.some((r) => r && typeof r === 'object' && !Array.isArray(r)))
        return records(v);
  }
  return [];
}

/** The messages of AirNow's {"WebServiceError":[{"Message":"..."}]} envelope, or null. */
export function serviceErrors(body: unknown): string[] | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const list = field(body as Rec, 'WebServiceError');
  if (!Array.isArray(list)) return null;
  return list
    .map((m) => (m && typeof m === 'object' ? field(m as Rec, 'Message') : m))
    .filter((m): m is string => typeof m === 'string' && m.trim() !== '');
}

const trimmed = (v: unknown) => (typeof v === 'string' ? v.trim() : (v ?? null));

function value(r: Rec): AqValue | null {
  const pollutant = field(r, 'parameterName', 'Parameter', 'Pollutant');
  // Observations: nowcastAQI / aqiCategoryName; forecasts: aqi / categoryName.
  const aqi = field(r, 'nowcastAQI', 'AQI');
  const cat = field(r, 'Category');
  const catName =
    cat && typeof cat === 'object'
      ? field(cat as Rec, 'Name', 'CategoryName')
      : field(r, 'aqiCategoryName', 'categoryName');
  const catNum =
    cat && typeof cat === 'object'
      ? field(cat as Rec, 'Number', 'CategoryNumber')
      : field(r, 'categoryNumber', 'aqiCategoryNumber');
  if (pollutant === undefined || (aqi === undefined && catName === undefined)) return null;
  return {
    pollutant,
    aqi: aqi ?? null,
    category: catName ?? null,
    category_number: catNum ?? null,
  };
}

export function parseObservations(body: unknown): { areas: AqObservationArea[]; unparsed: Rec[] } {
  const areas = new Map<string, AqObservationArea>();
  const unparsed: Rec[] = [];
  for (const r of records(body)) {
    const v = value(r);
    if (!v) {
      unparsed.push(r);
      continue;
    }
    const area = field(r, 'reportingAreaName', 'ReportingArea');
    const state = field(r, 'stateCode', 'State');
    const date = field(r, 'dateObserved');
    const hour = field(r, 'hourObserved');
    const tz = field(r, 'localTimeZone', 'TimeZone');
    const key = JSON.stringify([area, state, date, hour, tz]);
    let a = areas.get(key);
    if (!a) {
      a = {
        reporting_area: area ?? null,
        state: state ?? null,
        date_observed: trimmed(date),
        hour_observed: hour ?? null,
        time_zone: tz ?? null,
        lookup_boundary: field(r, 'lookupBoundary') ?? null,
        values: [],
      };
      areas.set(key, a);
    }
    a.values.push({
      ...v,
      site: field(r, 'siteName') ?? null,
      agency: field(r, 'reportingAgency', 'reportingAreaAgency') ?? null,
    });
  }
  return { areas: [...areas.values()], unparsed };
}

export function parseForecasts(body: unknown): { forecasts: AqForecast[]; unparsed: Rec[] } {
  const forecasts: AqForecast[] = [];
  const unparsed: Rec[] = [];
  for (const r of records(body)) {
    const v = value(r);
    if (!v) {
      unparsed.push(r);
      continue;
    }
    forecasts.push({
      reporting_area: field(r, 'reportingArea', 'reportingAreaName') ?? null,
      state: field(r, 'stateCode', 'State') ?? null,
      date_issue: trimmed(field(r, 'dateIssue')),
      date_forecast: trimmed(field(r, 'dateValid', 'DateForecast')),
      ...v,
      agency: field(r, 'forecastAgency', 'reportingAgency') ?? null,
      action_day: field(r, 'actionDay') ?? null,
      // Agency text: kept whole up to a generous cap, never reworded.
      discussion: cleanText(field(r, 'discussion'), 6000),
    });
  }
  return { forecasts, unparsed };
}

/**
 * The credit line the guidelines ask for: the agencies AirNow names on the records, else the
 * state's agency (Michigan EGLE for Michigan), else the reporting agency in general.
 */
export function airnowLabel(states: unknown[], agencies: unknown[] = []): string {
  const named = [
    ...new Set(agencies.map((a) => str(a, 100)).filter((a): a is string => a !== null)),
  ];
  if (named.length) return `preliminary data; source: ${named.slice(0, 3).join(', ')} / EPA AirNow`;
  const s = new Set(
    states
      .filter((x): x is string => typeof x === 'string')
      .map((x) => x.trim().toUpperCase())
      .filter((x) => /^[A-Z]{2}$/.test(x)),
  );
  if (s.size === 0)
    return 'preliminary data; source: the reporting air quality agency / EPA AirNow';
  if (s.size === 1 && s.has('MI')) return 'preliminary data; source: Michigan EGLE / EPA AirNow';
  const other = [...s].filter((x) => x !== 'MI');
  return `preliminary data; source: ${s.has('MI') ? 'Michigan EGLE, ' : ''}the ${other.join('/')} air quality agency / EPA AirNow`;
}

/** AirNow explained what went wrong (its own message, cleaned, the key masked). */
export class AirnowServiceError extends Error {}

type Half<T> = T & { note: string | null };

interface AirnowAnswer {
  observations: Half<{ areas: AqObservationArea[]; unparsed: Rec[] }> | { error: string };
  forecast: Half<{ forecasts: AqForecast[]; unparsed: Rec[] }> | { error: string };
  fetched_at: string;
}

export class AirnowClient {
  private readonly cache: TtlCache<AirnowAnswer>;

  constructor(
    private readonly http: HttpClient,
    private readonly apiKey: string | undefined,
    private readonly now: () => number,
  ) {
    this.cache = new TtlCache(500, now);
  }

  get configured(): boolean {
    return Boolean(this.apiKey);
  }

  /** AirNow's text, with the key masked before anything is cut, on one capped line. */
  private clean(msgs: string[]): string {
    let s = msgs.join(' ');
    if (this.apiKey) s = s.split(this.apiKey).join('[key]');
    return oneLine(s, 300);
  }

  /** One AirNow service: its body, or [] with AirNow's message when nothing matched. */
  private async call(
    kind: keyof typeof AIRNOW_PATHS,
    lat: number,
    lon: number,
    signal?: AbortSignal,
  ): Promise<{ body: unknown; note: string | null }> {
    const u = new URL(`https://${AIRNOW_HOST}${AIRNOW_PATHS[kind]}`);
    u.search = new URLSearchParams({
      format: 'application/json',
      latitude: coord(lat),
      longitude: coord(lon),
      API_KEY: this.apiKey ?? '',
    }).toString();
    let body: unknown;
    try {
      ({ body } = await this.http.getJson(u, {
        service: 'EPA AirNow',
        allowedHosts: [AIRNOW_HOST],
        signal,
      }));
    } catch (err) {
      // A 4xx carrying AirNow's envelope is read like a 200 one (a rejected key stays an error).
      if (
        !(err instanceof UpstreamError) ||
        err.kind !== 'http' ||
        err.status === 401 ||
        err.status === 403 ||
        !serviceErrors(err.body)
      )
        throw err;
      body = err.body;
    }
    const msgs = serviceErrors(body);
    if (!msgs) return { body, note: null };
    if (msgs.length && msgs.every((m) => NO_DATA.test(m.trim())))
      return { body: [], note: this.clean(msgs) };
    throw new AirnowServiceError(
      msgs.length
        ? `EPA AirNow reported an error: ${this.clean(msgs)}`
        : 'EPA AirNow reported an error',
    );
  }

  async lookup(lat: number, lon: number, signal?: AbortSignal): Promise<AirnowAnswer> {
    const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const [obs, fc] = await Promise.allSettled([
      this.call('observations', lat, lon, signal),
      this.call('forecast', lat, lon, signal),
    ]);
    // A bad key or a rate limit fails both: report it once, as the tool's error.
    for (const r of [obs, fc])
      if (r.status === 'rejected' && r.reason instanceof UpstreamError) {
        const e = r.reason;
        if (e.status === 401 || e.status === 403 || e.kind === 'rate_limited') throw e;
      }
    if (obs.status === 'rejected' && fc.status === 'rejected') throw obs.reason;
    const answer: AirnowAnswer = {
      observations:
        obs.status === 'fulfilled'
          ? { ...parseObservations(obs.value.body), note: obs.value.note }
          : { error: errText(obs.reason) },
      forecast:
        fc.status === 'fulfilled'
          ? { ...parseForecasts(fc.value.body), note: fc.value.note }
          : { error: errText(fc.reason) },
      fetched_at: new Date(this.now()).toISOString(),
    };
    // Only complete answers are kept for 30 min; a partial one is retried next time.
    if (obs.status === 'fulfilled' && fc.status === 'fulfilled')
      this.cache.set(key, answer, CACHE_MS);
    return answer;
  }
}

function errText(err: unknown): string {
  return err instanceof UpstreamError || err instanceof AirnowServiceError
    ? err.message
    : 'unavailable';
}

/** Ends a message with a full stop unless it already has one. */
const sentence = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);

const AQ_ARGS = z.strictObject({ ...LOCATION_SHAPE });

const AQ_TAGS = [
  'air quality',
  'aqi',
  'air quality index',
  'smoke',
  'wildfire smoke',
  'haze',
  'ozone',
  'pm2.5',
  'pm25',
  'particulates',
  'pollution',
  'smog',
  'action day',
  'ozone action day',
  'can i go outside',
  'asthma',
  'airnow',
  'epa',
  'egle',
];

const aqiText = (v: AqValue) => {
  const cat = str(v.category, 40);
  const n = typeof v.aqi === 'number' && v.aqi >= 0 ? `AQI ${v.aqi}` : null;
  return `${str(v.pollutant, 20) ?? '?'} ${[n, cat ? (n ? `(${cat})` : cat) : null].filter(Boolean).join(' ')}${n ? '' : ' (no AQI number given)'}`;
};

/** "14:00" as given; a bare hour (15) as "15:00". */
function hourText(h: unknown): string | null {
  if (typeof h === 'number' && Number.isInteger(h)) return `${h}:00`;
  if (typeof h !== 'string') return null;
  const s = h.trim();
  return /^\d{1,2}$/.test(s) ? `${s}:00` : str(s, 10);
}

const isActionDay = (v: unknown) =>
  v === true || (typeof v === 'string' && v.toLowerCase() === 'true');

export interface AirnowToolDeps {
  airnow: AirnowClient;
  phone: PhoneDeps;
}

export function airnowTools(deps: AirnowToolDeps): ToolDef[] {
  const { airnow } = deps;
  return [
    {
      name: 'air_quality',
      title: 'Air quality (AQI) near a point',
      description:
        "Current air quality and the agency forecast from EPA AirNow for the reporting area AirNow matches to a point or the user's phone location (here: true): AQI, category, pollutant (ozone, PM2.5, PM10), monitoring site, observation hour, forecast days and Air Quality Action Days. Preliminary data, credited to the reporting agency AirNow names and EPA AirNow; values are passed through unaltered.",
      source: 'gateway',
      family: 'weather',
      inputSchema: jsonSchemaOf(AQ_ARGS),
      tags: AQ_TAGS,
      attribution: AIRNOW_ATTRIBUTION,
      untrustedText: true,
      async run(args, ctx) {
        if (!airnow.configured)
          return {
            summary: `air_quality is ${AIRNOW_OFF_REASON}.`,
            isError: true,
            errorKind: 'unavailable',
          };
        const a = parseArgs(AQ_ARGS, args, 'air_quality');
        if (!a.ok) return a.out;
        const r = resolvePoint('air_quality', a.value, ctx, deps.phone);
        if (!r.ok) return r.out;
        let ans: AirnowAnswer;
        try {
          ans = await airnow.lookup(r.point.lat, r.point.lon, ctx.signal);
        } catch (err) {
          if (err instanceof UpstreamError && (err.status === 401 || err.status === 403))
            return {
              summary:
                'EPA AirNow rejected the API key: check AIRNOW_API_KEY in deploy/secrets/gateway.env.',
              isError: true,
              errorKind: 'unavailable',
            };
          if (err instanceof AirnowServiceError)
            return { summary: sentence(err.message), isError: true, errorKind: 'unavailable' };
          if (err instanceof UpstreamError)
            return {
              summary: `${err.message}.${err.kind === 'rate_limited' ? ' AirNow limits calls per key per hour; try again next hour.' : ''}`,
              isError: true,
              errorKind:
                err.kind === 'rate_limited' || err.status >= 500 ? 'retry_later' : 'unavailable',
            };
          throw err;
        }
        return answerOutput(ans, r.point);
      },
    },
  ];
}

function answerOutput(ans: AirnowAnswer, pt: ResolvedPoint): ToolOutput {
  const obs = 'error' in ans.observations ? undefined : ans.observations;
  const fc = 'error' in ans.forecast ? undefined : ans.forecast;
  const label = airnowLabel(
    [...(obs?.areas.map((x) => x.state) ?? []), ...(fc?.forecasts.map((x) => x.state) ?? [])],
    [
      ...(obs?.areas.flatMap((x) => x.values.map((v) => v.agency)) ?? []),
      ...(fc?.forecasts.map((x) => x.agency) ?? []),
    ],
  );
  const lines: string[] = [];
  for (const area of obs?.areas ?? []) {
    const when = [
      str(area.date_observed, 20),
      hourText(area.hour_observed),
      str(area.time_zone, 10),
    ]
      .filter(Boolean)
      .join(' ');
    const state = str(area.state, 10);
    lines.push(
      `- Observed in ${str(area.reporting_area, 80) ?? 'the reporting area'}${state ? `, ${state}` : ''}${when ? ` (${when})` : ''}: ${area.values.map(aqiText).join('; ')}.`,
    );
  }
  for (const f of (fc?.forecasts ?? []).slice(0, 8)) {
    const state = str(f.state, 10);
    lines.push(
      `- Forecast for ${str(f.date_forecast, 20) ?? '?'}, ${str(f.reporting_area, 80) ?? ''}${state ? `, ${state}` : ''}: ${aqiText(f)}${isActionDay(f.action_day) ? '; AIR QUALITY ACTION DAY' : ''}.`,
    );
  }
  const said = (note: string | null | undefined) => (note ? ` (AirNow: ${note})` : '');
  if ('error' in ans.observations)
    lines.push(`- Current observations unavailable (${ans.observations.error}).`);
  else if (!obs?.areas.length)
    lines.push(`- No current observations for a reporting area near this point${said(obs?.note)}.`);
  if ('error' in ans.forecast) lines.push(`- Forecast unavailable (${ans.forecast.error}).`);
  else if (!fc?.forecasts.length)
    lines.push(`- No forecast issued for a reporting area near this point${said(fc?.note)}.`);
  const unparsed = [...(obs?.unparsed ?? []), ...(fc?.unparsed ?? [])];
  if (unparsed.length)
    lines.push(
      `- ${unparsed.length} AirNow record(s) in an unexpected format are passed through as received in data.records_unrecognized.`,
    );
  const actionDays = (fc?.forecasts ?? []).filter((f) => isActionDay(f.action_day)).length;
  return {
    summary: `Air quality near ${pointPhrase(pt)} (${label}; values as reported, not altered):\n${lines.join('\n')}${actionDays ? '\nAn Air Quality Action Day is an agency advisory: relay it as issued.' : ''}`,
    data: {
      point: pointData(pt),
      note: label,
      observations: obs?.areas ?? [],
      forecast: (fc?.forecasts ?? []).map((f) => ({
        ...f,
        ...(f.discussion && f.discussion.endsWith('…') ? { discussion_truncated: true } : {}),
      })),
      ...(obs?.note || fc?.note
        ? { airnow_said: { observations: obs?.note ?? null, forecast: fc?.note ?? null } }
        : {}),
      ...(unparsed.length ? { records_unrecognized: unparsed.slice(0, 10) } : {}),
      retrieved_at: ans.fetched_at,
    },
  };
}
