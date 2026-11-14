/**
 * Water levels near a point, from three keyless or nearly keyless public sources:
 *  - NOAA CO-OPS (api.tidesandcurrents.noaa.gov): Great Lakes and tide stations found through
 *    the CO-OPS metadata API, the last ~3 h of 6-minute water levels (IGLD85 on the Great
 *    Lakes, MLLW at tide stations) and, on the Great Lakes, the station's flood levels.
 *  - USGS Water Data OGC API (api.waterdata.usgs.gov): stream gages in the area (latest gage
 *    height, discharge, lake elevation) and their last ~3 h for a trend. A USGS_API_KEY raises
 *    the limits; without one the documented shared DEMO_KEY is used, whose limits are low, so
 *    USGS answers are cached for 10 minutes.
 *  - NOAA NWS National Water Prediction Service (api.water.noaa.gov): flood stages and the
 *    current flood category of NWS river gauges, matched to USGS gages by site number.
 * All public domain. Values are reported as received; trends are computed here and say so.
 */
import { z } from 'zod';
import type { ToolDef, ToolOutput } from '../../tools/types.js';
import { humanDistance } from '../../util/format.js';
import { bearingDeg, compassPoint, degreeBox, haversineM } from '../../util/geo.js';
import {
  LOCATION_SHAPE,
  TtlCache,
  jsonSchemaOf,
  mapLimit,
  num,
  parseArgs,
  pointData,
  pointPhrase,
  resolvePoint,
  str,
  type PhoneDeps,
  type ResolvedPoint,
} from './common.js';
import { HttpClient, UpstreamError } from './http.js';

export const COOPS_HOST = 'api.tidesandcurrents.noaa.gov';
export const USGS_HOST = 'api.waterdata.usgs.gov';
export const NWPS_HOST = 'api.water.noaa.gov';
export const USGS_DEMO_KEY = 'DEMO_KEY';
export const WATER_ATTRIBUTION =
  'NOAA CO-OPS Tides & Currents; USGS Water Data (provisional data, subject to revision); NOAA NWS National Water Prediction Service (flood stages). Public domain.';

const DAY_MS = 86_400_000;
const USGS_TTL_MS = 10 * 60_000;
const NWPS_LIST_TTL_MS = 10 * 60_000;
/** A USGS series whose newest value is older than this is discontinued or down: left out. */
const USGS_STALE_MS = 48 * 3_600_000;
/** CO-OPS / NWPS readings older than this are flagged stale. */
const READING_STALE_MS = 2 * 3_600_000;
const TREND_FT = 0.05;
const MAX_COOPS = 6;
const MAX_USGS_SITES = 10;
const MAX_NWPS = 10;

/** USGS parameter codes asked for: gage height, discharge, lake elevation (NGVD29, NAVD88). */
const STAGE_CODES: Record<string, { parameter: string; datum: string }> = {
  '00065': { parameter: 'gage height', datum: 'USGS gage datum' },
  '62614': { parameter: 'lake or reservoir elevation', datum: 'NGVD29' },
  '62615': { parameter: 'lake or reservoir elevation', datum: 'NAVD88' },
};
const DISCHARGE = '00060';

export type Trend = 'rising' | 'falling' | 'steady';

export interface SiteOut {
  station: string;
  id: string;
  agency: 'NOAA CO-OPS' | 'USGS' | 'NOAA NWS';
  kind: 'lake level' | 'tide gauge' | 'stream gage' | 'river gauge';
  distance_km: number;
  direction: string;
  parameter: string | null;
  value: number | null;
  units: string | null;
  datum: string | null;
  trend: Trend | null;
  /** Change over trend_window_min (computed here from the agency's own readings). */
  change: number | null;
  trend_window_min: number | null;
  updated: string | null;
  stale: boolean;
  approval?: string | null;
  discharge?: { value: number | null; units: string | null; updated: string | null } | null;
  flood_stage?: {
    action: number | null;
    minor: number | null;
    moderate: number | null;
    major: number | null;
    units: string;
    source: string;
    datum_note?: string;
  } | null;
  /** NWS's own classification of the latest observation (NWPS), as received. */
  flood_category?: string | null;
  nws_gauge?: string | null;
  site_altitude_ft?: number | null;
  site_vertical_datum?: string | null;
}

interface CoopsStation {
  id: string;
  name: string;
  lat: number;
  lon: number;
  state: string | null;
  greatlakes: boolean;
}

interface Reading {
  t: number;
  v: number;
}

interface SourceStatus {
  source: string;
  status: 'ok' | 'error' | 'none_in_range';
  note?: string;
}

/** Trend over the readings: first vs last, at least 30 min apart. */
export function trendOf(series: Reading[]): {
  trend: Trend | null;
  change: number | null;
  window_min: number | null;
} {
  const s = [...series].filter((r) => Number.isFinite(r.v)).sort((a, b) => a.t - b.t);
  const first = s[0];
  const last = s[s.length - 1];
  if (!first || !last || last.t - first.t < 30 * 60_000)
    return { trend: null, change: null, window_min: null };
  const change = Math.round((last.v - first.v) * 100) / 100;
  return {
    trend: change > TREND_FT ? 'rising' : change < -TREND_FT ? 'falling' : 'steady',
    change,
    window_min: Math.round((last.t - first.t) / 60_000),
  };
}

/** "2026-11-14 20:48" (GMT, as CO-OPS sends it with time_zone=gmt) -> epoch ms. */
const coopsTime = (t: unknown): number | null => {
  if (typeof t !== 'string' || !/^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(t)) return null;
  const ms = Date.parse(`${t.replace(' ', 'T')}:00Z`);
  return Number.isNaN(ms) ? null : ms;
};

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

export class WaterClients {
  private readonly stations: TtlCache<CoopsStation[]>;
  private readonly coopsFlood: TtlCache<SiteOut['flood_stage']>;
  private readonly usgsBundles: TtlCache<UsgsBundle>;
  private readonly usgsNames: TtlCache<UsgsSiteInfo>;
  private readonly nwpsLists: TtlCache<NwpsGauge[]>;
  private readonly nwpsDetail: TtlCache<NwpsDetail>;

  constructor(
    private readonly http: HttpClient,
    private readonly usgsKey: string | undefined,
    private readonly now: () => number,
  ) {
    this.stations = new TtlCache(1, now);
    this.coopsFlood = new TtlCache(500, now);
    this.usgsBundles = new TtlCache(200, now);
    this.usgsNames = new TtlCache(2_000, now);
    this.nwpsLists = new TtlCache(200, now);
    this.nwpsDetail = new TtlCache(1_000, now);
  }

  get usingDemoKey(): boolean {
    return !this.usgsKey;
  }

  // ---- NOAA CO-OPS ----
  async coopsStations(signal?: AbortSignal): Promise<CoopsStation[]> {
    const hit = this.stations.get('all');
    if (hit) return hit;
    const { body } = await this.http.getJson<{ stations?: unknown }>(
      new URL(`https://${COOPS_HOST}/mdapi/prod/webapi/stations.json?type=waterlevels`),
      { service: 'NOAA CO-OPS', allowedHosts: [COOPS_HOST], signal, maxBytes: 6 * 1024 * 1024 },
    );
    const list = (Array.isArray(body.stations) ? body.stations : [])
      .map((s): CoopsStation | null => {
        const x = s as Record<string, unknown>;
        const lat = num(x.lat);
        const lon = num(x.lng);
        const id = typeof x.id === 'string' && /^\d{7}$/.test(x.id) ? x.id : null;
        if (lat === null || lon === null || !id) return null;
        return {
          id,
          name: str(x.name, 100) ?? id,
          lat,
          lon,
          state: str(x.state, 4),
          greatlakes: x.greatlakes === true,
        };
      })
      .filter((s): s is CoopsStation => s !== null);
    this.stations.set('all', list, DAY_MS);
    return list;
  }

  async coopsLevels(
    st: CoopsStation,
    signal?: AbortSignal,
  ): Promise<{ readings: Reading[]; note?: string }> {
    const u = new URL(`https://${COOPS_HOST}/api/prod/datagetter`);
    u.search = new URLSearchParams({
      range: '3',
      station: st.id,
      product: 'water_level',
      datum: st.greatlakes ? 'IGLD' : 'MLLW',
      units: 'english',
      time_zone: 'gmt',
      format: 'json',
      application: 'godseye-personal-connector',
    }).toString();
    const { body } = await this.http.getJson<{ data?: unknown; error?: { message?: unknown } }>(u, {
      service: 'NOAA CO-OPS',
      allowedHosts: [COOPS_HOST],
      signal,
    });
    if (body.error) return { readings: [], note: str(body.error.message, 160) ?? 'no data' };
    const readings = (Array.isArray(body.data) ? body.data : [])
      .map((d) => {
        const r = d as { t?: unknown; v?: unknown };
        const t = coopsTime(r.t);
        const v = num(r.v);
        return t === null || v === null ? null : { t, v };
      })
      .filter((r): r is Reading => r !== null);
    return { readings };
  }

  /** Great Lakes station flood levels (same IGLD85 scale as the readings). */
  async coopsFloodLevels(st: CoopsStation, signal?: AbortSignal): Promise<SiteOut['flood_stage']> {
    const cached = this.coopsFlood.get(st.id);
    if (cached !== undefined) return cached;
    let out: SiteOut['flood_stage'] = null;
    try {
      const { body } = await this.http.getJson<Record<string, unknown>>(
        new URL(`https://${COOPS_HOST}/mdapi/prod/webapi/stations/${st.id}/floodlevels.json`),
        { service: 'NOAA CO-OPS', allowedHosts: [COOPS_HOST], signal, retry: false },
      );
      const pick = (...keys: string[]) => {
        for (const k of keys) {
          const v = num(body[k]);
          if (v !== null) return v;
        }
        return null;
      };
      const levels = {
        action: pick('action'),
        minor: pick('nws_minor', 'nos_minor'),
        moderate: pick('nws_moderate', 'nos_moderate'),
        major: pick('nws_major', 'nos_major'),
      };
      if (Object.values(levels).some((v) => v !== null))
        out = {
          ...levels,
          units: 'ft',
          source: 'NOAA CO-OPS flood levels',
          datum_note: 'as CO-OPS publishes them for this Great Lakes station (IGLD85 scale)',
        };
    } catch {
      return null; // not cached: try again next time
    }
    this.coopsFlood.set(st.id, out, DAY_MS);
    return out;
  }

  // ---- USGS ----
  private usgsGet<T>(path: string, params: Record<string, string>, signal?: AbortSignal) {
    const u = new URL(`https://${USGS_HOST}/ogcapi/v1/collections/${path}`);
    u.search = new URLSearchParams({ f: 'json', ...params }).toString();
    return this.http.getJson<T>(u, {
      service: 'USGS Water Data',
      allowedHosts: [USGS_HOST],
      headers: { 'x-api-key': this.usgsKey ?? USGS_DEMO_KEY },
      signal,
      maxBytes: 4 * 1024 * 1024,
    });
  }

  async usgs(bbox: Bbox, signal?: AbortSignal): Promise<UsgsBundle> {
    const key = bboxKey(bbox);
    const hit = this.usgsBundles.get(key);
    if (hit) return hit;
    const { body } = await this.usgsGet<{ features?: unknown }>(
      'latest-continuous/items',
      {
        bbox: `${bbox.w},${bbox.s},${bbox.e},${bbox.n}`,
        parameter_code: [...Object.keys(STAGE_CODES), DISCHARGE].join(','),
        limit: '500',
      },
      signal,
    );
    const latest: UsgsLatest[] = [];
    let stale = 0;
    for (const f of Array.isArray(body.features) ? body.features : []) {
      const p = ((f as { properties?: unknown }).properties ?? {}) as Record<string, unknown>;
      const c = (f as { geometry?: { coordinates?: unknown } }).geometry?.coordinates;
      const id = typeof p.monitoring_location_id === 'string' ? p.monitoring_location_id : null;
      const code = typeof p.parameter_code === 'string' ? p.parameter_code : '';
      const t = typeof p.time === 'string' ? Date.parse(p.time) : NaN;
      const asked = Boolean(STAGE_CODES[code]) || code === DISCHARGE;
      if (!id || !/^USGS-\d{8,15}$/.test(id) || !asked || !Array.isArray(c) || Number.isNaN(t))
        continue;
      if (this.now() - t > USGS_STALE_MS) {
        stale++;
        continue;
      }
      const lon = num(c[0]);
      const lat = num(c[1]);
      if (lat === null || lon === null) continue;
      latest.push({
        id,
        code,
        t,
        value: num(p.value),
        units: str(p.unit_of_measure, 20),
        approval: str(p.approval_status, 20),
        lat,
        lon,
      });
    }
    const bundle: UsgsBundle = { latest, stale, recent: [], names: new Map(), notes: [] };
    const ids = [...new Set(latest.map((l) => l.id))];
    if (ids.length) {
      const [names, recent] = await Promise.allSettled([
        this.usgsSiteInfo(ids, signal),
        this.usgsGet<{ features?: unknown }>(
          'continuous/items',
          {
            monitoring_location_id: ids.join(','),
            parameter_code: Object.keys(STAGE_CODES).join(','),
            time: 'PT3H',
            properties: 'monitoring_location_id,parameter_code,time,value',
            skipGeometry: 'true',
            limit: '3000',
          },
          signal,
        ),
      ]);
      if (names.status === 'fulfilled') bundle.names = names.value;
      else bundle.notes.push('site names unavailable');
      if (recent.status === 'fulfilled') {
        for (const f of Array.isArray(recent.value.body.features)
          ? recent.value.body.features
          : []) {
          const p = ((f as { properties?: unknown }).properties ?? {}) as Record<string, unknown>;
          const t = typeof p.time === 'string' ? Date.parse(p.time) : NaN;
          const v = num(p.value);
          if (typeof p.monitoring_location_id === 'string' && !Number.isNaN(t) && v !== null)
            bundle.recent.push({
              id: p.monitoring_location_id,
              code: String(p.parameter_code ?? ''),
              t,
              v,
            });
        }
      } else bundle.notes.push('recent readings (trend) unavailable');
    }
    this.usgsBundles.set(key, bundle, USGS_TTL_MS);
    return bundle;
  }

  private async usgsSiteInfo(
    ids: string[],
    signal?: AbortSignal,
  ): Promise<Map<string, UsgsSiteInfo>> {
    const out = new Map<string, UsgsSiteInfo>();
    const missing: string[] = [];
    for (const id of ids) {
      const hit = this.usgsNames.get(id);
      if (hit) out.set(id, hit);
      else missing.push(id);
    }
    for (let i = 0; i < missing.length; i += 50) {
      const chunk = missing.slice(i, i + 50);
      const { body } = await this.usgsGet<{ features?: unknown }>(
        'monitoring-locations/items',
        {
          id: chunk.join(','),
          properties: 'monitoring_location_name,site_type,altitude,vertical_datum',
          skipGeometry: 'true',
          limit: '50',
        },
        signal,
      );
      for (const f of Array.isArray(body.features) ? body.features : []) {
        const id = (f as { id?: unknown }).id;
        const p = ((f as { properties?: unknown }).properties ?? {}) as Record<string, unknown>;
        if (typeof id !== 'string') continue;
        const info: UsgsSiteInfo = {
          name: str(p.monitoring_location_name, 120),
          site_type: str(p.site_type, 40),
          altitude_ft: num(p.altitude),
          vertical_datum: str(p.vertical_datum, 20),
        };
        this.usgsNames.set(id, info, DAY_MS);
        out.set(id, info);
      }
    }
    return out;
  }

  // ---- NWS NWPS ----
  async nwpsGauges(bbox: Bbox, signal?: AbortSignal): Promise<NwpsGauge[]> {
    const key = bboxKey(bbox);
    const hit = this.nwpsLists.get(key);
    if (hit) return hit;
    const u = new URL(`https://${NWPS_HOST}/nwps/v1/gauges`);
    u.search = new URLSearchParams({
      'bbox.xmin': String(bbox.w),
      'bbox.ymin': String(bbox.s),
      'bbox.xmax': String(bbox.e),
      'bbox.ymax': String(bbox.n),
      srid: 'EPSG_4326',
    }).toString();
    const { body } = await this.http.getJson<{ gauges?: unknown }>(u, {
      service: 'NWS National Water Prediction Service',
      allowedHosts: [NWPS_HOST],
      signal,
    });
    const gauges = (Array.isArray(body.gauges) ? body.gauges : [])
      .map((g): NwpsGauge | null => {
        const x = g as Record<string, unknown>;
        const lid = typeof x.lid === 'string' && /^[A-Z0-9]{3,6}$/.test(x.lid) ? x.lid : null;
        const lat = num(x.latitude);
        const lon = num(x.longitude);
        if (!lid || lat === null || lon === null) return null;
        const obs = ((x.status as Record<string, unknown> | undefined)?.observed ?? {}) as Record<
          string,
          unknown
        >;
        const primary = num(obs.primary);
        const t = typeof obs.validTime === 'string' ? Date.parse(obs.validTime) : NaN;
        return {
          lid,
          name: str(x.name, 120) ?? lid,
          lat,
          lon,
          stage: primary !== null && primary > -900 ? primary : null,
          stage_units: str(obs.primaryUnit, 10),
          category: str(obs.floodCategory, 40),
          t: Number.isNaN(t) || t < 0 || new Date(t).getUTCFullYear() < 1900 ? null : t,
        };
      })
      .filter((g): g is NwpsGauge => g !== null);
    this.nwpsLists.set(key, gauges, NWPS_LIST_TTL_MS);
    return gauges;
  }

  async nwpsGauge(lid: string, signal?: AbortSignal): Promise<NwpsDetail | null> {
    const hit = this.nwpsDetail.get(lid);
    if (hit) return hit;
    let body: Record<string, unknown>;
    try {
      ({ body } = await this.http.getJson<Record<string, unknown>>(
        new URL(`https://${NWPS_HOST}/nwps/v1/gauges/${lid}`),
        {
          service: 'NWS National Water Prediction Service',
          allowedHosts: [NWPS_HOST],
          signal,
          retry: false,
        },
      ));
    } catch {
      return null;
    }
    const flood = (body.flood ?? {}) as Record<string, unknown>;
    const cats = (flood.categories ?? {}) as Record<string, { stage?: unknown } | undefined>;
    const stage = (k: string) => {
      const v = num(cats[k]?.stage);
      return v !== null && v > -900 ? v : null;
    };
    const usgs =
      typeof body.usgsId === 'string' && /^\d{8,15}$/.test(body.usgsId) ? body.usgsId : null;
    const d: NwpsDetail = {
      usgs_id: usgs,
      flood: {
        action: stage('action'),
        minor: stage('minor'),
        moderate: stage('moderate'),
        major: stage('major'),
        units: str(flood.stageUnits, 10) ?? 'ft',
      },
    };
    this.nwpsDetail.set(lid, d, DAY_MS);
    return d;
  }
}

interface Bbox {
  w: number;
  s: number;
  e: number;
  n: number;
}
const bboxKey = (b: Bbox) => [b.w, b.s, b.e, b.n].map((v) => v.toFixed(2)).join(',');

interface UsgsLatest {
  id: string;
  code: string;
  t: number;
  value: number | null;
  units: string | null;
  approval: string | null;
  lat: number;
  lon: number;
}
interface UsgsSiteInfo {
  name: string | null;
  site_type: string | null;
  altitude_ft: number | null;
  vertical_datum: string | null;
}
interface UsgsBundle {
  latest: UsgsLatest[];
  stale: number;
  recent: Array<{ id: string; code: string; t: number; v: number }>;
  names: Map<string, UsgsSiteInfo>;
  notes: string[];
}
interface NwpsGauge {
  lid: string;
  name: string;
  lat: number;
  lon: number;
  stage: number | null;
  stage_units: string | null;
  category: string | null;
  t: number | null;
}
interface NwpsDetail {
  usgs_id: string | null;
  flood: {
    action: number | null;
    minor: number | null;
    moderate: number | null;
    major: number | null;
    units: string;
  };
}

const FLOODING = new Set(['action', 'minor', 'moderate', 'major']);

const WATER_ARGS = z.strictObject({
  ...LOCATION_SHAPE,
  radius_km: z.number().min(5).max(60).optional().describe('Search radius in km (default 30)'),
});

const WATER_TAGS = [
  'water level',
  'lake level',
  'river level',
  'river height',
  'stream gauge',
  'stream gage',
  'gage height',
  'stage',
  'flood stage',
  'flooding',
  'flood',
  'is the river flooding',
  'high water',
  'low water',
  'discharge',
  'streamflow',
  'great lakes',
  'detroit river',
  'lake st clair',
  'rouge river',
  'clinton river',
  'tide',
  'usgs',
  'noaa',
  'co-ops',
  'tides and currents',
];

export interface WaterToolDeps {
  water: WaterClients;
  phone: PhoneDeps;
  now: () => number;
}

export function waterTools(deps: WaterToolDeps): ToolDef[] {
  return [
    {
      name: 'water_levels_near',
      title: 'Lake, river and stream levels near a point',
      description:
        "Water levels near a point or the user's phone location (here: true), nearest first: NOAA Great Lakes and tide stations (water level with datum, ~3 h trend, flood levels) and USGS stream gages (gage height, discharge, trend), with NWS flood stages and the NWS flood category when a gage has them. Use for 'is the river flooding', lake levels and high water.",
      source: 'gateway',
      family: 'weather',
      inputSchema: jsonSchemaOf(WATER_ARGS),
      tags: WATER_TAGS,
      attribution: WATER_ATTRIBUTION,
      untrustedText: true,
      async run(args, ctx) {
        const a = parseArgs(WATER_ARGS, args, 'water_levels_near');
        if (!a.ok) return a.out;
        const r = resolvePoint('water_levels_near', a.value, ctx, deps.phone);
        if (!r.ok) return r.out;
        return waterNear(deps, r.point, a.value.radius_km ?? 30, ctx.signal);
      },
    },
  ];
}

async function waterNear(
  deps: WaterToolDeps,
  pt: ResolvedPoint,
  radiusKm: number,
  signal: AbortSignal,
): Promise<ToolOutput> {
  const { water, now } = deps;
  const radiusM = radiusKm * 1000;
  const { dLat, dLon } = degreeBox(pt.lat, radiusM);
  const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
  const bbox: Bbox = {
    w: r4(pt.lon - dLon),
    s: r4(pt.lat - dLat),
    e: r4(pt.lon + dLon),
    n: r4(pt.lat + dLat),
  };
  const place = (lat: number, lon: number) => {
    const d = haversineM(pt.lat, pt.lon, lat, lon);
    return {
      d,
      distance_km: Math.round(d / 100) / 10,
      direction: compassPoint(bearingDeg(pt.lat, pt.lon, lat, lon)),
    };
  };
  const sources: SourceStatus[] = [];
  const sites: Array<SiteOut & { _d: number }> = [];

  const [coops, usgs, nwps] = await Promise.allSettled([
    (async () => {
      const all = await water.coopsStations(signal);
      const near = all
        .map((s) => ({ s, ...place(s.lat, s.lon) }))
        .filter((x) => x.d <= radiusM)
        .sort((a, b) => a.d - b.d)
        .slice(0, MAX_COOPS);
      return mapLimit(near, 4, async (x) => {
        const [lv, flood] = await Promise.all([
          water.coopsLevels(x.s, signal).catch((err: unknown) => ({
            readings: [] as Reading[],
            note: err instanceof UpstreamError ? err.message : 'no data',
          })),
          x.s.greatlakes ? water.coopsFloodLevels(x.s, signal) : Promise.resolve(null),
        ]);
        const last = lv.readings.reduce<Reading | undefined>(
          (m, r) => (!m || r.t > m.t ? r : m),
          undefined,
        );
        const tr = trendOf(lv.readings);
        const site: SiteOut & { _d: number; note?: string } = {
          _d: x.d,
          station: x.s.name + (x.s.state ? `, ${x.s.state}` : ''),
          id: x.s.id,
          agency: 'NOAA CO-OPS',
          kind: x.s.greatlakes ? 'lake level' : 'tide gauge',
          distance_km: x.distance_km,
          direction: x.direction,
          parameter: 'water level',
          value: last?.v ?? null,
          units: last ? 'ft' : null,
          datum: x.s.greatlakes ? 'IGLD85' : 'MLLW',
          trend: tr.trend,
          change: tr.change,
          trend_window_min: tr.window_min,
          updated: iso(last?.t ?? null),
          stale: !last || now() - last.t > READING_STALE_MS,
          flood_stage: flood && last && floodPlausible(flood, last.v) ? flood : null,
          ...(lv.note ? { note: lv.note } : {}),
        };
        return site;
      });
    })(),
    water.usgs(bbox, signal),
    (async () => {
      const gauges = (await water.nwpsGauges(bbox, signal))
        .map((g) => ({ g, ...place(g.lat, g.lon) }))
        .filter((x) => x.d <= radiusM)
        .sort((a, b) => a.d - b.d)
        .slice(0, MAX_NWPS);
      const details = await mapLimit(gauges, 4, (x) => water.nwpsGauge(x.g.lid, signal));
      return gauges.map((x, i) => ({ ...x, detail: details[i] ?? null }));
    })(),
  ]);

  if (coops.status === 'fulfilled') {
    sites.push(...coops.value);
    sources.push({
      source: 'NOAA CO-OPS',
      status: coops.value.length ? 'ok' : 'none_in_range',
    });
  } else sources.push({ source: 'NOAA CO-OPS', status: 'error', note: errNote(coops.reason) });

  // NWPS gauges by USGS site number, to attach flood stages to the matching USGS gage.
  const nwpsList = nwps.status === 'fulfilled' ? nwps.value : undefined;
  const nwpsByUsgs = new Map<string, NonNullable<typeof nwpsList>[number]>();
  for (const x of nwpsList ?? []) if (x.detail?.usgs_id) nwpsByUsgs.set(x.detail.usgs_id, x);
  const usedNwps = new Set<string>();

  if (usgs.status === 'fulfilled') {
    const b = usgs.value;
    const bySite = new Map<string, UsgsLatest[]>();
    for (const l of b.latest) {
      const arr = bySite.get(l.id) ?? [];
      arr.push(l);
      bySite.set(l.id, arr);
    }
    const near = [...bySite.entries()]
      .map(([id, ls]) => ({ id, ls, ...place(ls[0]!.lat, ls[0]!.lon) }))
      .filter((x) => x.d <= radiusM)
      .sort((a, b2) => a.d - b2.d)
      .slice(0, MAX_USGS_SITES);
    for (const x of near) {
      const stage = x.ls.find((l) => STAGE_CODES[l.code]);
      const q = x.ls.find((l) => l.code === DISCHARGE);
      const info = b.names.get(x.id);
      const num8 = x.id.replace(/^USGS-/, '');
      const nw = nwpsByUsgs.get(num8);
      if (nw) usedNwps.add(nw.g.lid);
      const tr = stage
        ? trendOf(b.recent.filter((r) => r.id === x.id && r.code === stage.code))
        : { trend: null, change: null, window_min: null };
      const main = stage ?? q!;
      sites.push({
        _d: x.d,
        station: info?.name ?? x.id,
        id: x.id,
        agency: 'USGS',
        kind: stage && stage.code !== '00065' ? 'lake level' : 'stream gage',
        distance_km: x.distance_km,
        direction: x.direction,
        parameter: stage ? STAGE_CODES[stage.code]!.parameter : 'discharge',
        value: main.value,
        units: main.units,
        datum: stage ? STAGE_CODES[stage.code]!.datum : null,
        trend: tr.trend,
        change: tr.change,
        trend_window_min: tr.window_min,
        updated: iso(main.t),
        stale: now() - main.t > READING_STALE_MS,
        approval: main.approval,
        discharge: stage && q ? { value: q.value, units: q.units, updated: iso(q.t) } : null,
        flood_stage:
          nw?.detail && stage?.code === '00065' && hasAny(nw.detail.flood)
            ? { ...nw.detail.flood, source: `NWS (NWPS gauge ${nw.g.lid})` }
            : null,
        flood_category: nw?.g.category ?? null,
        nws_gauge: nw?.g.lid ?? null,
        site_altitude_ft: info?.altitude_ft ?? null,
        site_vertical_datum: info?.vertical_datum ?? null,
      });
    }
    const notes = [...b.notes];
    if (b.stale) notes.push(`${b.stale} discontinued or out-of-date series left out`);
    if (water.usingDemoKey) notes.push('using the shared DEMO_KEY (low limits; set USGS_API_KEY)');
    sources.push({
      source: 'USGS Water Data',
      status: near.length ? 'ok' : 'none_in_range',
      ...(notes.length ? { note: notes.join('; ') } : {}),
    });
  } else {
    const demo =
      water.usingDemoKey &&
      usgs.reason instanceof UpstreamError &&
      (usgs.reason.kind === 'rate_limited' || usgs.reason.status === 403)
        ? ' (the shared DEMO_KEY is used: set USGS_API_KEY in deploy/secrets/gateway.env for higher limits)'
        : '';
    sources.push({ source: 'USGS Water Data', status: 'error', note: errNote(usgs.reason) + demo });
  }

  if (nwpsList) {
    // NWS gauges with no USGS gage listed here (another agency's, or USGS was unavailable).
    for (const x of nwpsList) {
      if (usedNwps.has(x.g.lid)) continue;
      sites.push({
        _d: x.d,
        station: x.g.name,
        id: x.g.lid,
        agency: 'NOAA NWS',
        kind: 'river gauge',
        distance_km: x.distance_km,
        direction: x.direction,
        parameter: 'stage',
        value: x.g.stage,
        units: x.g.stage !== null ? (x.g.stage_units ?? 'ft') : null,
        datum: x.g.stage !== null ? 'NWS gauge datum' : null,
        trend: null,
        change: null,
        trend_window_min: null,
        updated: iso(x.g.t),
        stale: x.g.t === null || now() - x.g.t > READING_STALE_MS,
        flood_stage:
          x.detail && hasAny(x.detail.flood) ? { ...x.detail.flood, source: 'NWS (NWPS)' } : null,
        flood_category: x.g.category,
        nws_gauge: x.g.lid,
      });
    }
    sources.push({
      source: 'NWS National Water Prediction Service',
      status: nwpsList.length ? 'ok' : 'none_in_range',
    });
  } else
    sources.push({
      source: 'NWS National Water Prediction Service',
      status: 'error',
      note: errNote(nwps.status === 'rejected' ? nwps.reason : undefined),
    });

  if (sources.every((s) => s.status === 'error')) {
    return {
      summary: `Water levels are unavailable right now: ${sources.map((s) => `${s.source}: ${s.note ?? 'error'}`).join('; ')}.`,
      isError: true,
      errorKind: 'retry_later',
      data: { sources },
    };
  }
  sites.sort((x, y) => x._d - y._d);
  const out = sites.map(({ _d, ...s }) => s);
  const flooding = out.filter((s) => s.flood_category && FLOODING.has(s.flood_category));
  const lines = out.slice(0, 8).map(siteLine);
  const head = flooding.length
    ? `NWS FLOOD CATEGORY: ${flooding.map((s) => `${s.station} is at ${s.flood_category} stage`).join('; ')}.\n`
    : '';
  const failed = sources.filter((s) => s.status === 'error');
  const partial = failed.length
    ? `\nNot available this time: ${failed.map((s) => `${s.source} (${s.note ?? 'error'})`).join('; ')}.`
    : '';
  const summary = out.length
    ? `${head}${out.length} water-level station(s) within ${radiusKm} km of ${pointPhrase(pt)}, nearest first:\n${lines.join('\n')}${out.length > lines.length ? `\n(+${out.length - lines.length} more in data)` : ''}\nTrends compare the first and last readings of the last ~3 h. USGS values are provisional.${partial}`
    : `No water-level stations within ${radiusKm} km of ${pointPhrase(pt)}.${partial}`;
  const newest = out
    .map((s) => (s.updated ? Date.parse(s.updated) : NaN))
    .filter((t) => !Number.isNaN(t))
    .sort((x, y) => y - x)[0];
  return {
    summary,
    data: {
      point: pointData(pt),
      radius_km: radiusKm,
      count: out.length,
      stations: out,
      sources,
    },
    observedAt: newest !== undefined ? new Date(newest).toISOString() : undefined,
  };
}

function hasAny(f: {
  action: number | null;
  minor: number | null;
  moderate: number | null;
  major: number | null;
}) {
  return [f.action, f.minor, f.moderate, f.major].some((v) => v !== null);
}

/** Flood levels on the same scale as the reading (within 20 ft), else not shown. */
function floodPlausible(f: NonNullable<SiteOut['flood_stage']>, reading: number): boolean {
  return [f.action, f.minor, f.moderate, f.major].some(
    (v) => v !== null && Math.abs(v - reading) < 20,
  );
}

function errNote(err: unknown): string {
  return err instanceof UpstreamError ? err.message : 'unavailable';
}

function siteLine(s: SiteOut): string {
  const val =
    s.value !== null
      ? `${s.value} ${s.units ?? ''}${s.datum && s.units === 'ft' ? ` (${s.datum})` : ''}`.trim()
      : 'no current reading';
  const trend =
    s.trend && s.change !== null && s.trend_window_min !== null
      ? `, ${s.trend} (${s.change > 0 ? '+' : ''}${s.change} ${s.units ?? ''} in ${humanWindow(s.trend_window_min)})`
      : '';
  const q =
    s.discharge && s.discharge.value !== null
      ? `, discharge ${s.discharge.value} ${s.discharge.units ?? ''}`.trimEnd()
      : '';
  const fl = s.flood_stage
    ? s.flood_stage.minor !== null
      ? `, flood stage ${s.flood_stage.minor} ${s.flood_stage.units}`
      : s.flood_stage.action !== null
        ? `, action level ${s.flood_stage.action} ${s.flood_stage.units}`
        : ''
    : '';
  const cat = s.flood_category ? `, NWS category: ${s.flood_category}` : '';
  const when = s.updated ? `, updated ${s.updated}${s.stale ? ' (STALE)' : ''}` : '';
  return `- ${s.station} (${s.agency} ${s.id.replace(/^USGS-/, '')}, ${s.kind}): ${s.parameter ?? 'level'} ${val}${trend}${q}${fl}${cat}${when}, ${humanDistance(s.distance_km * 1000)} ${s.direction}`;
}

const humanWindow = (min: number) => (min < 90 ? `${min} min` : `${(min / 60).toFixed(1)} h`);
