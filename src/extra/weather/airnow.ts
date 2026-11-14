/**
 * EPA AirNow (www.airnowapi.org, free key in AIRNOW_API_KEY; off without one): current AQI
 * observations and forecasts by reporting area near a point.
 *
 * AirNow's Data Exchange Guidelines: observations are preliminary and must be shown as such;
 * credit the reporting agency (Michigan EGLE for Michigan) and EPA AirNow; values, forecasts,
 * advisories and their names must not be altered. So every value here is passed through as
 * received (an AQI of -1 included: AirNow's way of saying a forecast gives only a category).
 * AirNow recommends caching (observations change hourly, forecasts daily): answers are cached
 * for 30 minutes.
 *
 * AirNow's June 2026 notice retired the old lat/long services on 2026-09-30 in favour of
 * "Current Observations by Latitude/Longitude or ZIP Code" (/aq/observation/current/ziplatlong/)
 * and "Current Forecasts by Reporting Area" (/aq/forecast/current/). Their parameter docs are
 * behind the AirNow login, so the new paths are asked first with the old services' parameters,
 * and the old paths are tried if AirNow says the path or the parameters are wrong.
 */
import { z } from 'zod';
import type { ToolDef, ToolOutput } from '../../tools/types.js';
import {
  LOCATION_SHAPE,
  TtlCache,
  cleanText,
  coord,
  jsonSchemaOf,
  parseArgs,
  pointData,
  pointPhrase,
  resolvePoint,
  type PhoneDeps,
  type ResolvedPoint,
} from './common.js';
import { HttpClient, UpstreamError } from './http.js';

export const AIRNOW_HOST = 'www.airnowapi.org';
export const AIRNOW_OFF_REASON = 'not configured: set AIRNOW_API_KEY in deploy/secrets/gateway.env';
export const AIRNOW_ATTRIBUTION =
  'Preliminary data, not fully verified; source: the reporting air quality agency (Michigan EGLE for Michigan) and U.S. EPA AirNow (airnow.gov)';
const CACHE_MS = 30 * 60_000;

const PATHS = {
  observations: ['/aq/observation/current/ziplatlong/', '/aq/observation/latLong/current/'],
  forecast: ['/aq/forecast/current/', '/aq/forecast/latLong/'],
} as const;
/** Statuses that mean "not this path / not these parameters": try the older path. */
const FALLBACK_STATUS = new Set([301, 302, 303, 307, 308, 400, 404, 410]);

type Rec = Record<string, unknown>;

/** Case-insensitive field lookup (AirNow's JSON uses PascalCase). */
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

export interface AqObservationArea {
  reporting_area: unknown;
  state: unknown;
  date_observed: unknown;
  hour_observed: unknown;
  time_zone: unknown;
  values: AqValue[];
}

export interface AqForecast extends AqValue {
  reporting_area: unknown;
  state: unknown;
  date_issue: unknown;
  date_forecast: unknown;
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

function value(r: Rec): AqValue | null {
  const pollutant = field(r, 'ParameterName', 'Parameter', 'Pollutant');
  const aqi = field(r, 'AQI', 'Aqi');
  const cat = field(r, 'Category');
  const catName =
    cat && typeof cat === 'object'
      ? field(cat as Rec, 'Name', 'CategoryName')
      : field(r, 'CategoryName');
  const catNum =
    cat && typeof cat === 'object'
      ? field(cat as Rec, 'Number', 'CategoryNumber')
      : field(r, 'CategoryNumber');
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
    const area = field(r, 'ReportingArea', 'ReportingAreaName');
    const state = field(r, 'StateCode', 'State');
    const date = field(r, 'DateObserved');
    const hour = field(r, 'HourObserved');
    const tz = field(r, 'LocalTimeZone', 'TimeZone');
    const key = JSON.stringify([area, state, date, hour, tz]);
    let a = areas.get(key);
    if (!a) {
      a = {
        reporting_area: area ?? null,
        state: state ?? null,
        date_observed: typeof date === 'string' ? date.trim() : (date ?? null),
        hour_observed: hour ?? null,
        time_zone: tz ?? null,
        values: [],
      };
      areas.set(key, a);
    }
    a.values.push(v);
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
    const issue = field(r, 'DateIssue');
    const fc = field(r, 'DateForecast');
    forecasts.push({
      reporting_area: field(r, 'ReportingArea', 'ReportingAreaName') ?? null,
      state: field(r, 'StateCode', 'State') ?? null,
      date_issue: typeof issue === 'string' ? issue.trim() : (issue ?? null),
      date_forecast: typeof fc === 'string' ? fc.trim() : (fc ?? null),
      ...v,
      action_day: field(r, 'ActionDay') ?? null,
      // Agency text: kept whole up to a generous cap, never reworded.
      discussion: cleanText(field(r, 'Discussion'), 6000),
    });
  }
  return { forecasts, unparsed };
}

/** The credit line the guidelines ask for, naming Michigan EGLE for Michigan areas. */
export function airnowLabel(states: unknown[]): string {
  const s = new Set(
    states.filter((x) => typeof x === 'string').map((x) => String(x).trim().toUpperCase()),
  );
  if (s.size === 0 || (s.size === 1 && s.has('MI')))
    return 'preliminary data; source: Michigan EGLE / EPA AirNow';
  const other = [...s].filter((x) => x !== 'MI');
  return `preliminary data; source: ${s.has('MI') ? 'Michigan EGLE, ' : ''}the ${other.join('/')} air quality agency / EPA AirNow`;
}

interface AirnowAnswer {
  observations:
    { areas: AqObservationArea[]; unparsed: Rec[]; service: string } | { error: string };
  forecast: { forecasts: AqForecast[]; unparsed: Rec[]; service: string } | { error: string };
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

  /** One AirNow service, the current path first, the older one on a path/parameter error. */
  private async call(
    kind: keyof typeof PATHS,
    lat: number,
    lon: number,
    distanceMi: number,
    signal?: AbortSignal,
  ): Promise<{ body: unknown; service: string }> {
    let first: unknown;
    for (const path of PATHS[kind]) {
      const u = new URL(`https://${AIRNOW_HOST}${path}`);
      const params: Record<string, string> = {
        format: 'application/json',
        latitude: coord(lat),
        longitude: coord(lon),
        distance: String(distanceMi),
      };
      if (path === '/aq/forecast/latLong/') params.date = localDate(lon, this.now());
      u.search = new URLSearchParams({ ...params, API_KEY: this.apiKey ?? '' }).toString();
      try {
        const { body } = await this.http.getJson(u, {
          service: 'EPA AirNow',
          allowedHosts: [AIRNOW_HOST],
          signal,
        });
        return { body, service: path };
      } catch (err) {
        if (
          err instanceof UpstreamError &&
          err.kind === 'http' &&
          FALLBACK_STATUS.has(err.status)
        ) {
          first ??= err;
          continue;
        }
        throw err;
      }
    }
    throw first;
  }

  async lookup(
    lat: number,
    lon: number,
    distanceMi: number,
    signal?: AbortSignal,
  ): Promise<AirnowAnswer> {
    const key = `${lat.toFixed(2)},${lon.toFixed(2)},${distanceMi}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const [obs, fc] = await Promise.allSettled([
      this.call('observations', lat, lon, distanceMi, signal),
      this.call('forecast', lat, lon, distanceMi, signal),
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
          ? { ...parseObservations(obs.value.body), service: obs.value.service }
          : { error: errText(obs.reason) },
      forecast:
        fc.status === 'fulfilled'
          ? { ...parseForecasts(fc.value.body), service: fc.value.service }
          : { error: errText(fc.reason) },
      fetched_at: new Date(this.now()).toISOString(),
    };
    // Only complete answers are kept for 30 min; a partial one is retried next time.
    if (obs.status === 'fulfilled' && fc.status === 'fulfilled')
      this.cache.set(key, answer, CACHE_MS);
    return answer;
  }
}

/** The calendar date at the point (by longitude; close enough for "today's forecast"). */
function localDate(lon: number, now: number): string {
  return new Date(now + Math.round(lon / 15) * 3_600_000).toISOString().slice(0, 10);
}

function errText(err: unknown): string {
  return err instanceof UpstreamError ? err.message : 'unavailable';
}

const AQ_ARGS = z.strictObject({
  ...LOCATION_SHAPE,
  distance_mi: z
    .int()
    .min(5)
    .max(50)
    .optional()
    .describe('How far to look for a reporting area, in miles (default 25)'),
});

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
  const cat = typeof v.category === 'string' ? v.category : null;
  const n = typeof v.aqi === 'number' && v.aqi >= 0 ? `AQI ${v.aqi}` : null;
  return `${String(v.pollutant)} ${[n, cat ? (n ? `(${cat})` : cat) : null].filter(Boolean).join(' ')}${n ? '' : ' (no AQI number given)'}`;
};

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
        "Current air quality and the agency forecast from EPA AirNow for the reporting area nearest a point or the user's phone location (here: true): AQI, category, pollutant (ozone, PM2.5, PM10), observation hour, forecast days and Air Quality Action Days. Preliminary data, credited to the reporting agency (Michigan EGLE in Michigan) and EPA AirNow; values are passed through unaltered.",
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
        const distance = a.value.distance_mi ?? 25;
        let ans: AirnowAnswer;
        try {
          ans = await airnow.lookup(r.point.lat, r.point.lon, distance, ctx.signal);
        } catch (err) {
          if (err instanceof UpstreamError && (err.status === 401 || err.status === 403))
            return {
              summary:
                'EPA AirNow rejected the API key: check AIRNOW_API_KEY in deploy/secrets/gateway.env.',
              isError: true,
              errorKind: 'unavailable',
            };
          if (err instanceof UpstreamError)
            return {
              summary: `${err.message}.${err.kind === 'rate_limited' ? ' AirNow limits calls per key per hour; try again next hour.' : ''}`,
              isError: true,
              errorKind:
                err.kind === 'rate_limited' || err.status >= 500 ? 'retry_later' : 'unavailable',
            };
          throw err;
        }
        return answerOutput(ans, r.point, distance);
      },
    },
  ];
}

function answerOutput(ans: AirnowAnswer, pt: ResolvedPoint, distance: number): ToolOutput {
  const obs = 'error' in ans.observations ? undefined : ans.observations;
  const fc = 'error' in ans.forecast ? undefined : ans.forecast;
  const states = [
    ...(obs?.areas.map((x) => x.state) ?? []),
    ...(fc?.forecasts.map((x) => x.state) ?? []),
  ];
  const label = airnowLabel(states);
  const lines: string[] = [];
  for (const area of obs?.areas ?? []) {
    const when = [
      area.date_observed,
      area.hour_observed !== null ? `${String(area.hour_observed)}:00` : null,
      area.time_zone,
    ]
      .filter((x) => x !== null && x !== undefined && x !== '')
      .map(String)
      .join(' ');
    lines.push(
      `- Observed in ${String(area.reporting_area ?? 'the reporting area')}${area.state ? `, ${String(area.state)}` : ''}${when ? ` (${when})` : ''}: ${area.values.map(aqiText).join('; ')}.`,
    );
  }
  for (const f of (fc?.forecasts ?? []).slice(0, 8)) {
    lines.push(
      `- Forecast for ${String(f.date_forecast ?? '?')}, ${String(f.reporting_area ?? '')}${f.state ? `, ${String(f.state)}` : ''}: ${aqiText(f)}${isActionDay(f.action_day) ? '; AIR QUALITY ACTION DAY' : ''}.`,
    );
  }
  if ('error' in ans.observations)
    lines.push(`- Current observations unavailable (${ans.observations.error}).`);
  else if (!obs?.areas.length)
    lines.push(`- No current observations for a reporting area within ${distance} mi.`);
  if ('error' in ans.forecast) lines.push(`- Forecast unavailable (${ans.forecast.error}).`);
  else if (!fc?.forecasts.length)
    lines.push(`- No forecast issued for a reporting area within ${distance} mi.`);
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
      distance_mi: distance,
      note: label,
      observations: obs?.areas ?? [],
      forecast: (fc?.forecasts ?? []).map((f) => ({
        ...f,
        ...(f.discussion && f.discussion.endsWith('…') ? { discussion_truncated: true } : {}),
      })),
      ...(unparsed.length ? { records_unrecognized: unparsed.slice(0, 10) } : {}),
      services: { observations: obs?.service ?? null, forecast: fc?.service ?? null },
      retrieved_at: ans.fetched_at,
    },
  };
}
