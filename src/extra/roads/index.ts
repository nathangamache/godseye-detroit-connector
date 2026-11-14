/**
 * Roads and places (gateway-native): road_closures, geocode_place, route_avoiding_closures,
 * mdot_camera_link, border_wait_times. One call registers them all:
 *
 *   registerRoads(registry, { config, locations, audit, tokens, logger, now })
 *
 * Sources that need a key stay off until it is in deploy/secrets/gateway.env (each result says
 * which variable to set). Disk state (the geocoder cache, daily-cap counters) lives in
 * DATA_DIR/cache, never in the database or its backups.
 */
import path from 'node:path';
import type { Audit } from '../../audit.js';
import { parseRateLimits, type Config } from '../../config.js';
import type { LocationStore } from '../../location/store.js';
import type { Logger } from '../../log.js';
import type { TokenStore } from '../../oauth/tokens.js';
import type { ToolRegistry } from '../../tools/registry.js';
import { borderService } from './border.js';
import { ClosureService } from './closures.js';
import { Geocoder } from './geocode.js';
import { DailyCounter, DiskCache, Http, Pacer, type FetchLike } from './http.js';
import { valhallaRouter } from './route.js';
import { detroitRowSource } from './sources/detroitRow.js';
import { mdotRideSource } from './sources/mdotRide.js';
import { ontario511Source } from './sources/ontario511.js';
import { tomtomSource } from './sources/tomtom.js';
import { roadsTools, type RoadsToolDeps } from './tools.js';

export type RoadsConfig = Pick<
  Config,
  | 'DATA_DIR'
  | 'LOCATION_STALE_MINUTES'
  | 'ROADS_USER_AGENT'
  | 'ROADS_FETCH_TIMEOUT_MS'
  | 'ROADS_TOOL_RATE_LIMITS'
  | 'DETROIT_ROW_ENABLED'
  | 'DETROIT_ROW_URL'
  | 'TOMTOM_API_KEY'
  | 'ALLOW_TOMTOM_INCIDENTS'
  | 'TOMTOM_INCIDENTS_DAILY_MAX'
  | 'TOMTOM_API_URL'
  | 'MDOT_RIDE_API_KEY'
  | 'MDOT_RIDE_URL'
  | 'MDOT_RIDE_WORK_ZONES_DATASET'
  | 'MDOT_RIDE_EVENTS_DATASET'
  | 'MDOT_RIDE_LIMIT'
  | 'MDOT_RIDE_CACHE_S'
  | 'ONTARIO_511_API_KEY'
  | 'ONTARIO_511_URL'
  | 'ONTARIO_511_CACHE_S'
  | 'GEOCODER_CENSUS_URL'
  | 'GEOCODER_PHOTON_URL'
  | 'GEOCODER_NOMINATIM_URL'
  | 'GEOCODER_NOMINATIM_DAILY_MAX'
  | 'OVERPASS_URL'
  | 'VALHALLA_URL'
  | 'MIDRIVE_MAP_URL'
  | 'CBP_BWT_URL'
  | 'CBSA_BWT_URL'
>;

export interface RoadsDeps {
  config: RoadsConfig;
  locations?: LocationStore;
  audit?: Audit;
  tokens?: TokenStore;
  logger?: Logger;
  now?: () => number;
  /** Tests: a mocked fetch (no live calls). */
  fetch?: FetchLike;
  /** Tests: pacing without real waits. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export function buildRoadsDeps(registry: ToolRegistry | undefined, deps: RoadsDeps): RoadsToolDeps {
  const c = deps.config;
  const now = deps.now ?? Date.now;
  const cacheDir = path.join(c.DATA_DIR, 'cache');
  let warned = false;
  const onWriteError = (err: unknown) => {
    if (warned) return;
    warned = true;
    deps.logger?.warn('roads_cache_write_failed', {
      error: (err as Error)?.message?.slice(0, 120),
    });
  };
  const http = new Http({
    userAgent: c.ROADS_USER_AGENT,
    timeoutMs: c.ROADS_FETCH_TIMEOUT_MS,
    fetch: deps.fetch,
  });
  const geocoder = new Geocoder({
    http,
    censusUrl: c.GEOCODER_CENSUS_URL,
    photonUrl: c.GEOCODER_PHOTON_URL,
    nominatimUrl: c.GEOCODER_NOMINATIM_URL,
    overpassUrl: c.OVERPASS_URL,
    cache: new DiskCache(
      path.join(cacheDir, 'geocode.json'),
      { maxEntries: 5000, now },
      onWriteError,
    ),
    reverseCache: new DiskCache(
      path.join(cacheDir, 'reverse-street.json'),
      { maxEntries: 20_000, now },
      onWriteError,
    ),
    nominatimDaily: new DailyCounter(
      path.join(cacheDir, 'nominatim-usage.json'),
      c.GEOCODER_NOMINATIM_DAILY_MAX,
      now,
      onWriteError,
    ),
    nominatimPacer: new Pacer(1100, now, deps.sleep),
    photonPacer: new Pacer(250, now, deps.sleep),
    nominatimBucket: registry ? () => registry.policy.consumeRate(['nominatim']).ok : undefined,
  });
  const sources = [
    detroitRowSource({
      http,
      baseUrl: c.DETROIT_ROW_URL,
      enabled: c.DETROIT_ROW_ENABLED,
      geocoder,
      now,
    }),
    mdotRideSource({
      http,
      baseUrl: c.MDOT_RIDE_URL,
      key: c.MDOT_RIDE_API_KEY,
      workZonesDataset: c.MDOT_RIDE_WORK_ZONES_DATASET,
      eventsDataset: c.MDOT_RIDE_EVENTS_DATASET,
      limit: c.MDOT_RIDE_LIMIT,
      cacheMs: c.MDOT_RIDE_CACHE_S * 1000,
      now,
    }),
    ontario511Source({
      http,
      baseUrl: c.ONTARIO_511_URL,
      key: c.ONTARIO_511_API_KEY,
      cacheMs: c.ONTARIO_511_CACHE_S * 1000,
      now,
    }),
    tomtomSource({
      http,
      baseUrl: c.TOMTOM_API_URL,
      key: c.TOMTOM_API_KEY,
      allowed: c.ALLOW_TOMTOM_INCIDENTS,
      daily: new DailyCounter(
        path.join(cacheDir, 'tomtom-incidents-usage.json'),
        c.TOMTOM_INCIDENTS_DAILY_MAX,
        now,
        onWriteError,
      ),
    }),
  ];
  const closures = new ClosureService({
    sources,
    sourceTimeoutMs: Math.max(5_000, c.ROADS_FETCH_TIMEOUT_MS + 3_000),
    onSourceError: (source, err) =>
      deps.logger?.warn('roads_source_error', {
        source,
        error: (err as Error)?.message?.slice(0, 160),
      }),
  });
  return {
    closures,
    geocoder,
    router: valhallaRouter({
      http,
      baseUrl: c.VALHALLA_URL,
      pacer: new Pacer(1100, now, deps.sleep),
    }),
    border: borderService({ http, cbpUrl: c.CBP_BWT_URL, cbsaUrl: c.CBSA_BWT_URL, now }),
    here: {
      locations: deps.locations,
      audit: deps.audit,
      tokens: deps.tokens,
      staleMinutes: c.LOCATION_STALE_MINUTES,
      now,
    },
    midriveUrl: c.MIDRIVE_MAP_URL,
    now,
  };
}

/**
 * Registers the roads tools and their default quotas (already in config.toolRateLimits for a
 * loaded config); a bucket the operator set in TOOL_RATE_LIMITS keeps that setting.
 */
export function registerRoads(registry: ToolRegistry, deps: RoadsDeps): void {
  registry.policy.addDefaultLimits(parseRateLimits(deps.config.ROADS_TOOL_RATE_LIMITS));
  for (const t of roadsTools(buildRoadsDeps(registry, deps))) registry.register(t);
}
