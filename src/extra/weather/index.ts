/**
 * Weather, water and air tools (gateway-native, family "weather"):
 *   weather_alerts     NWS active alerts for a point           (keyless)
 *   weather_forecast   NWS 12-hour or hourly forecast          (keyless)
 *   water_levels_near  NOAA CO-OPS, USGS and NWS NWPS levels   (USGS_API_KEY optional)
 *   air_quality        EPA AirNow AQI and forecast             (AIRNOW_API_KEY; off without)
 * Every tool takes {lat, lon} or {here: true} (the latest phone fix, audited as a location read).
 */
import { parseRateLimits, type Config } from '../../config.js';
import type { Logger } from '../../log.js';
import type { ToolRegistry } from '../../tools/registry.js';
import type { ToolDef } from '../../tools/types.js';
import { AIRNOW_OFF_REASON, AirnowClient, airnowTools } from './airnow.js';
import type { PhoneDeps } from './common.js';
import { HttpClient, type FetchLike } from './http.js';
import { NwsClient, nwsTools } from './nws.js';
import { WaterClients, waterTools } from './water.js';

export interface WeatherDeps {
  config: Pick<
    Config,
    | 'USGS_API_KEY'
    | 'AIRNOW_API_KEY'
    | 'WEATHER_HTTP_TIMEOUT_MS'
    | 'WEATHER_TOOL_RATE_LIMITS'
    | 'LOCATION_STALE_MINUTES'
    | 'LOCATION_RETENTION_HOURS'
    | 'privateOrigin'
  >;
  registry: ToolRegistry;
  locations: PhoneDeps['locations'];
  audit?: PhoneDeps['audit'];
  tokens?: PhoneDeps['tokens'];
  logger?: Logger;
  now?: () => number;
  /** Tests: a mock fetch and no real waits between retries. */
  fetchImpl?: FetchLike;
  retryDelaysMs?: number[];
}

/** Registers the four tools, their default quotas, and switches air_quality off without a key. */
export function registerWeatherTools(deps: WeatherDeps): ToolDef[] {
  const { config, registry } = deps;
  const now = deps.now ?? Date.now;
  const http = new HttpClient({
    timeoutMs: config.WEATHER_HTTP_TIMEOUT_MS,
    fetchImpl: deps.fetchImpl,
    retryDelaysMs: deps.retryDelaysMs,
  });
  const phone: PhoneDeps = {
    locations: deps.locations,
    audit: deps.audit,
    tokens: deps.tokens,
    staleMinutes: config.LOCATION_STALE_MINUTES,
    retentionHours: config.LOCATION_RETENTION_HOURS,
    locateOrigin: config.privateOrigin,
    now,
  };
  const tools = [
    ...nwsTools({ nws: new NwsClient(http, now), phone }),
    ...waterTools({ water: new WaterClients(http, config.USGS_API_KEY, now), phone, now }),
    ...airnowTools({ airnow: new AirnowClient(http, config.AIRNOW_API_KEY, now), phone }),
  ];
  registry.policy.addDefaultLimits(parseRateLimits(config.WEATHER_TOOL_RATE_LIMITS));
  if (!config.AIRNOW_API_KEY) registry.policy.switchOff('air_quality', AIRNOW_OFF_REASON);
  for (const t of tools) registry.register(t);
  deps.logger?.info('weather_tools', {
    tools: tools.map((t) => t.name),
    air_quality: config.AIRNOW_API_KEY ? 'on' : 'off (no AIRNOW_API_KEY)',
    usgs: config.USGS_API_KEY ? 'own key' : 'DEMO_KEY',
  });
  return tools;
}
