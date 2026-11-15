/**
 * Configuration: read from process.env (optionally seeded from a .env file),
 * validated with zod. Every value has a safe default except secrets.
 *
 * Production mode fails closed: the Tailscale owner login and an https tailnet
 * origin must be configured, the public origin must be https, and no listener
 * may accept connections addressed to 127.0.0.1 (see checkProductionBinds).
 */
import { isIP } from 'node:net';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { parseStepUpKey } from './auth/stepup.js';
import { isIpv6Loopback, isUnspecifiedIp, parseIp } from './util/net.js';

/** Repository root (works from src/ under vitest and from dist/src/ when compiled). */
export const REPO_ROOT = (() => {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    if (existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
})();

const bool = (def: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => {
      if (v === undefined || v === '') return def;
      if (typeof v === 'boolean') return v;
      const s = v.trim().toLowerCase();
      if (['1', 'true', 'yes', 'on'].includes(s)) return true;
      if (['0', 'false', 'no', 'off'].includes(s)) return false;
      throw new Error(`not a boolean: ${v}`);
    });

const int = (def: number, min: number, max: number) =>
  z
    .union([z.number(), z.string()])
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === '') return def;
      const n = typeof v === 'number' ? v : Number(v);
      if (!Number.isInteger(n) || n < min || n > max) {
        ctx.addIssue({ code: 'custom', message: `expected integer ${min}..${max}` });
        return z.NEVER;
      }
      return n;
    });

const list = (def: string[]) =>
  z
    .string()
    .optional()
    .transform((v) =>
      v === undefined
        ? def
        : v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
    );

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined));

/** A tool family's default quotas (TOOL_RATE_LIMITS syntax), checked when the config loads. */
const rateLimitList = (def: string) =>
  z
    .string()
    .default(def)
    .refine(
      (s) => {
        try {
          parseRateLimits(s);
          return true;
        } catch {
          return false;
        }
      },
      { message: 'expected bucket=N/(s|m|h|d) entries separated by commas' },
    );

/** GEV tools vetted for exposure through run_tool. Anything else is denied by default. */
export const DEFAULT_GEV_TOOL_ALLOWLIST = [
  'get_earthquakes',
  'get_active_fires',
  'get_recent_launches',
  'vessels_in_area',
  'find_vessel',
  'get_vessel_track',
  'next_satellite_pass',
  'satellites_overhead',
  'find_cctv_cameras',
  'get_cctv_snapshot',
  'find_radio_stations',
  'plan_route',
  'get_bike_share',
  'get_transit_vehicles',
  'get_traffic_flow',
  'get_weather',
  'get_weather_map',
  'get_wind',
  'get_recent_imagery',
  'find_submarine_cables',
  'find_infrastructure',
  'get_regional_brief',
  'get_cyclones',
  'get_fire_perimeters',
  'get_terrain_height',
  'find_military_installations',
  'get_map_features',
  'show_in_gods_eye_view',
  // Gated separately by licensing switches (still need to be allowlisted):
  'aircraft_in_area',
  'find_aircraft',
  'get_aircraft_track',
  'get_aircraft_info',
  'situation_brief',
  'military_awareness',
  'find_alpr_cameras',
];

export const DEFAULT_TOOL_RATE_LIMITS =
  'get_traffic_flow=20/h,get_traffic_flow=150/d,plan_route=30/h,get_cctv_snapshot=60/h,nominatim=30/h,get_recent_imagery=20/h,get_regional_brief=30/h';

const schema = z.object({
  GATEWAY_MODE: z.enum(['development', 'production', 'test']).optional(),
  NODE_ENV: z.string().optional(),
  HOST: z.string().default('127.0.0.1'),
  PORT: int(7700, 0, 65535),
  PUBLIC_ORIGIN: z
    .string()
    .default('https://godseye.gamachecloud.com')
    .transform((s) => s.replace(/\/+$/, '')),
  EXTRA_ALLOWED_HOSTS: list([]),
  /** Peers whose CF-Connecting-IP is trusted on the PUBLIC listener (cloudflared only). */
  TRUSTED_PROXY_IPS: list(['127.0.0.1', '::1', '::ffff:127.0.0.1']),
  DATA_DIR: z.string().default(path.join(REPO_ROOT, 'data')),
  DB_PATH: optionalString,
  RAIL_DATA_DIR: z.string().default(path.join(REPO_ROOT, 'data', 'rail')),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // GEV
  GEV_ROOT: z.string().default(path.resolve(REPO_ROOT, '..', 'gods-eye-view')),
  GEV_URL: z
    .string()
    .default('http://127.0.0.1:7701')
    .transform((s) => s.replace(/\/+$/, '')),
  GEV_MCP_ENABLED: bool(true),
  GEV_WRAPPER: z.string().default(path.join(REPO_ROOT, 'gev', 'stdio-all-surfaces.mjs')),
  /**
   * Production: tcp://gev-mcp:7704, the GEV MCP child in its own container behind the relay
   * (src/gev/relay.ts). Unset: spawn the child locally (dev/test).
   */
  GEV_CHILD_URL: optionalString,
  GEV_CHILD_COMMAND: optionalString,
  GEV_CHILD_ARGS: optionalString,
  GEV_PROXY_ENABLED: bool(true),
  GEV_BLOCKED_PATHS: list([
    '/api/setup',
    '/api/realtime/oauth',
    '/api/openai/oauth',
    '/mcp',
    '/panel',
    '/@',
    '/__',
    '/node_modules',
    '/src/',
    '/.env',
    '/.git',
  ]),
  GEV_TOOL_ALLOWLIST: list(DEFAULT_GEV_TOOL_ALLOWLIST),
  TOOL_DENYLIST: list([]),
  ALLOW_OPENSKY_TOOLS: bool(false),
  ALLOW_ALPR_TOOLS: bool(false),
  GEV_PLACE_NAMES: bool(false),
  TOOL_RATE_LIMITS: z.string().default(DEFAULT_TOOL_RATE_LIMITS),
  TOOL_TIMEOUT_MS: int(110_000, 1_000, 230_000),
  MAX_CONCURRENT_TOOL_CALLS: int(4, 1, 64),
  MAX_RESULT_CHARS: int(100_000, 2_000, 140_000),
  IMAGE_MAX_DIM: int(768, 64, 4096),
  IMAGE_MAX_BASE64_CHARS: int(60_000, 1_000, 130_000),
  MAX_IMAGES_PER_RESULT: int(1, 0, 4),

  // Pulse
  PULSE_URL: z
    .string()
    .default('http://127.0.0.1:7710')
    .transform((s) => s.replace(/\/+$/, '')),
  PULSE_API_TOKEN: optionalString,
  PULSE_TIMEOUT_MS: int(5_000, 200, 60_000),
  PULSE_STATIC_DIR: optionalString,
  PULSE_API_PROXY: bool(false),

  // OAuth
  ACCESS_TOKEN_TTL_S: int(3600, 60, 86_400),
  REFRESH_TOKEN_TTL_S: int(90 * 86_400, 3600, 400 * 86_400),
  AUTH_CODE_TTL_S: int(60, 10, 600),
  REFRESH_REUSE_GRACE_S: int(0, 0, 120),
  CIMD_ALLOWED_CLIENT_IDS: list([
    'https://claude.ai/oauth/mcp-oauth-client-metadata',
    'https://claude.ai/oauth/claude-code-client-metadata',
  ]),
  DCR_ENABLED: bool(true),
  DCR_ALLOWED_REDIRECT_URIS: list([
    'https://claude.ai/api/mcp/auth_callback',
    'https://claude.com/api/mcp/auth_callback',
  ]),
  /** Loopback redirect URIs (any port, RFC 8252) allowed for DCR and CIMD clients, e.g. Claude Code. */
  LOOPBACK_REDIRECT_URIS: list(['http://localhost/callback', 'http://127.0.0.1/callback']),
  DCR_MAX_CLIENTS: int(500, 1, 100_000),

  // Private (tailnet-only) listener for everything a human logs into
  PRIVATE_HOST: z.string().default('127.0.0.1'),
  PRIVATE_PORT: int(7702, 0, 65535),
  /** The browser-facing origin of the private listener, e.g. https://godseye.<tailnet>.ts.net */
  PRIVATE_ORIGIN: optionalString,
  /**
   * UI listener: the GEV globe and /pulse, on a SEPARATE origin from authorize/consent/admin
   * and /locate, so script running in those third-party UIs can't read or drive the owner
   * pages. Default host: PRIVATE_HOST. Default origin: PRIVATE_ORIGIN on port 8443.
   */
  UI_HOST: optionalString,
  UI_PORT: int(7703, 0, 65535),
  UI_ORIGIN: optionalString,
  /** authorization_endpoint advertised in AS metadata (default: PRIVATE_ORIGIN/oauth/authorize). */
  AUTHORIZATION_ENDPOINT: optionalString,
  /** Origin used for globe links in tool results (default: UI_ORIGIN, where the globe lives). */
  LINK_ORIGIN: optionalString,
  /** FALLBACK: serve /oauth/authorize on the public listener behind password+TOTP. Off by default. */
  PUBLIC_AUTHORIZE_FALLBACK: z.enum(['off', 'password']).default('off'),

  // Login
  LOGIN_PROVIDER: z.enum(['auto', 'tailscale', 'password']).default('auto'),
  /** Tailscale login name (Tailscale-User-Login) of the only person who may log in. */
  OWNER_TAILSCALE_LOGIN: optionalString,
  /**
   * Peers allowed to assert Tailscale-User-Login on the private listener (tailscale serve
   * connects from 127.0.0.1). Forwarding headers (X-Forwarded-For) are never trusted there.
   */
  TAILSCALE_TRUSTED_PROXY_IPS: list(['127.0.0.1', '::1', '::ffff:127.0.0.1']),
  GATEWAY_PASSWORD_HASH: optionalString,
  GATEWAY_TOTP_SECRET: optionalString,
  SESSION_SECRET: optionalString,
  SESSION_TTL_S: int(12 * 3600, 300, 7 * 86_400),
  /**
   * Step-up second factor (TOTP) on the consent approval and /oauth/admin. On by default;
   * enroll with `node dist/scripts/stepup.js enroll`.
   */
  STEPUP_TOTP: z.enum(['on', 'off']).default('on'),
  /** How long a correct code opens admin (and further approvals) for. */
  STEPUP_WINDOW_S: int(600, 60, 3600),
  /** 32-byte key (base64url) that encrypts the TOTP secret at rest. Required in production. */
  STEPUP_KEY: optionalString,

  // Location
  LOCATION_RETENTION_HOURS: int(24, 1, 24 * 30),
  LOCATION_STALE_MINUTES: int(10, 1, 24 * 60),
  /**
   * A tool called for an explicit point gets a "phone check" note (distance and bearing to the
   * latest fix, never its coordinates) when that fix is at most this old.
   */
  LOCATION_PROXIMITY_MINUTES: int(30, 1, 24 * 60),

  // ---- aviation ----
  // flights_near and aircraft_lookup (src/extra/aviation). No keys: adsb.fi (personal,
  // non-commercial terms), adsb.lol as fallback, and a local copy of the FAA registry.
  /**
   * Private registrants (individual, co-owned, partnership): "private individual" plus city
   * and state (private_hidden), the label alone (type_only), or the name in single-aircraft
   * lookups (full; names are only kept in the copy with this setting). Street and ZIP: never.
   */
  AIRCRAFT_OWNER_DISCLOSURE: z
    .enum(['private_hidden', 'type_only', 'full'])
    .default('private_hidden'),
  /** Withhold the owner name of LADD-flagged aircraft unless the registrant is a government. */
  AIRCRAFT_LADD_WITHHOLD: bool(true),
  /** Daily FAA registry download (about 06:15 UTC, If-Modified-Since) into the data volume. */
  AIRCRAFT_REGISTRY_SYNC: bool(true),
  /** Where the registry copy lives (default DATA_DIR/aviation). */
  AIRCRAFT_REGISTRY_DIR: optionalString,
  AIRCRAFT_REGISTRY_URL: z
    .string()
    .default('https://registry.faa.gov/database/ReleasableAircraft.zip')
    .refine((s) => /^https?:\/\/[^\s/]+\/\S*$/.test(s), 'must be an http(s) URL'),
  /** adsb.lol calls per rolling 24 h (its keyless quota is per IP, shared with GEV). */
  ADSBLOL_DAILY_MAX: int(100, 0, 10_000),
  /** Default quotas for aviation buckets that TOOL_RATE_LIMITS does not set. */
  AVIATION_RATE_LIMITS: rateLimitList('flights_near=60/h,flights_near=600/d,aircraft_lookup=120/h'),
  // ---- end aviation ----

  // ---- weather ----
  // Gateway-native weather, water and air tools (src/extra/weather). NWS, NOAA CO-OPS and NWPS
  // are keyless.
  /** USGS Water Data API key (api.waterdata.usgs.gov/signup). Unset: the shared DEMO_KEY (low limits). */
  USGS_API_KEY: optionalString,
  /** EPA AirNow API key. Unset: air_quality is off. */
  AIRNOW_API_KEY: optionalString,
  /** Timeout of each upstream request these tools make (retries included separately). */
  WEATHER_HTTP_TIMEOUT_MS: int(12_000, 1_000, 60_000),
  /**
   * Default quotas for these tools (TOOL_RATE_LIMITS syntax). A TOOL_RATE_LIMITS entry for the
   * same bucket replaces the default.
   */
  WEATHER_TOOL_RATE_LIMITS: rateLimitList(
    'weather_alerts=120/h,weather_forecast=60/h,water_levels_near=20/h,air_quality=30/h',
  ),
  // ---- end weather ----

  // ---- roads ----
  // Gateway-native road, place and border tools (src/extra/roads). A source that needs a key
  // stays off, and says which variable to set, until that key is in deploy/secrets/gateway.env.
  /** Generic, self-describing User-Agent for every outbound request (no personal data). */
  ROADS_USER_AGENT: z
    .string()
    .trim()
    .min(3)
    .max(200)
    .default('godseye-connector/0.1 (personal non-commercial MCP gateway)'),
  ROADS_FETCH_TIMEOUT_MS: int(12_000, 1_000, 60_000),
  /** Default per-tool quotas; a bucket also named in TOOL_RATE_LIMITS keeps that value. */
  ROADS_TOOL_RATE_LIMITS: rateLimitList(
    'road_closures=60/h,geocode_place=60/h,route_avoiding_closures=30/h,mdot_camera_link=60/h,border_wait_times=60/h',
  ),
  DETROIT_ROW_ENABLED: bool(true),
  DETROIT_ROW_URL: z
    .url({ protocol: /^https?$/ })
    .default(
      'https://services2.arcgis.com/qvkbeam7Wirps6zC/arcgis/rest/services/detroit_right_of_way_permits/FeatureServer',
    )
    .transform((s) => s.replace(/\/+$/, '')),
  /** TomTom Traffic Incident Details: the key GEV uses, plus the owner's licence switch. */
  TOMTOM_API_KEY: optionalString,
  ALLOW_TOMTOM_INCIDENTS: bool(false),
  TOMTOM_INCIDENTS_DAILY_MAX: int(60, 0, 2_500),
  /** whats_happening_here leaves TomTom out once fewer than this many requests are left today. */
  TOMTOM_WHATS_HAPPENING_RESERVE: int(20, 0, 2_500),
  TOMTOM_API_URL: z
    .url({ protocol: /^https?$/ })
    .default('https://api.tomtom.com')
    .transform((s) => s.replace(/\/+$/, '')),
  /** MDOT RIDE (MiLogin for Business subscription); sent in the api_key header. */
  MDOT_RIDE_API_KEY: optionalString,
  MDOT_RIDE_URL: z
    .url({ protocol: /^https?$/ })
    .default(
      'https://mdotridedata.state.mi.us/api/v1/organization/michigan_department_of_transportation/dataset',
    )
    .transform((s) => s.replace(/\/+$/, '')),
  MDOT_RIDE_WORK_ZONES_DATASET: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,80}$/)
    .default('work_zone_information'),
  MDOT_RIDE_EVENTS_DATASET: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,80}$/)
    .default('traffic_events'),
  MDOT_RIDE_LIMIT: int(200, 1, 5_000),
  /** RIDE updates every 5 minutes: never poll it more often than this. */
  MDOT_RIDE_CACHE_S: int(300, 300, 3_600),
  ONTARIO_511_API_KEY: optionalString,
  ONTARIO_511_URL: z
    .url({ protocol: /^https?$/ })
    .default('https://511on.ca/api/v2/get')
    .transform((s) => s.replace(/\/+$/, '')),
  ONTARIO_511_CACHE_S: int(180, 60, 300),
  GEOCODER_CENSUS_URL: z
    .url({ protocol: /^https?$/ })
    .default('https://geocoding.geo.census.gov/geocoder')
    .transform((s) => s.replace(/\/+$/, '')),
  GEOCODER_PHOTON_URL: z
    .url({ protocol: /^https?$/ })
    .default('https://photon.komoot.io')
    .transform((s) => s.replace(/\/+$/, '')),
  GEOCODER_NOMINATIM_URL: z
    .url({ protocol: /^https?$/ })
    .default('https://nominatim.openstreetmap.org')
    .transform((s) => s.replace(/\/+$/, '')),
  /** Public Nominatim is a last resort: at most this many lookups a day (0 = never). */
  GEOCODER_NOMINATIM_DAILY_MAX: int(50, 0, 50),
  /**
   * A self-hosted Overpass interpreter (…/api/interpreter; docs/overpass.md, the same server GEV
   * uses) for intersections; unset = none. Never a public instance.
   */
  OVERPASS_URL: z
    .union([z.literal(''), z.url({ protocol: /^https?$/ })])
    .optional()
    .transform((v) => (v ? v.trim() : undefined)),
  VALHALLA_URL: z
    .url({ protocol: /^https?$/ })
    .default('https://valhalla1.openstreetmap.de')
    .transform((s) => s.replace(/\/+$/, '')),
  MIDRIVE_MAP_URL: z
    .url({ protocol: /^https$/ })
    .default('https://mdotjboss.state.mi.us/MiDrive/map'),
  CBP_BWT_URL: z.url({ protocol: /^https?$/ }).default('https://bwt.cbp.gov/api/bwtnew'),
  CBSA_BWT_URL: z
    .url({ protocol: /^https?$/ })
    .default('https://www.cbsa-asfc.gc.ca/bwt-taf/bwt-eng.csv'),
  // ---- end roads ----

  // ---- civic ----
  /**
   * Swiftly real-time API key for SMART's GTFS-Realtime feeds (sent as the Authorization
   * header). Unset: transit_vehicles_near is off and fetches nothing.
   */
  SWIFTLY_API_KEY: optionalString,
  /** Fetch SMART's public static GTFS (route names, headsigns) for transit_vehicles_near. */
  SMART_STATIC_GTFS: bool(true),
  /** Default quotas for the civic tools; a TOOL_RATE_LIMITS entry for the same bucket wins. */
  CIVIC_TOOL_RATE_LIMITS: rateLimitList(
    'dpd_calls_near=60/h,transit_vehicles_near=120/h,local_headlines=30/h,local_headlines=200/d',
  ),
  // ---- end civic ----
});

export type RawConfig = z.infer<typeof schema>;

export interface Config extends RawConfig {
  mode: 'development' | 'production' | 'test';
  dbPath: string;
  publicHost: string;
  mcpResource: string;
  issuer: string;
  /** Host allowlist for the public listener. */
  allowedHosts: string[];
  /** Host allowlist for the private listener. */
  privateAllowedHosts: string[];
  privateOrigin: string;
  /** Host allowlist and origin of the UI listener (GEV, /pulse). */
  uiAllowedHosts: string[];
  uiOrigin: string;
  uiHost: string;
  authorizationEndpoint: string;
  linkOrigin: string;
  /** Login provider on the private listener. */
  loginProvider: 'tailscale' | 'password' | 'none';
  ownerTailscaleLogin?: string;
  /** Password+TOTP on the public listener's /oauth/authorize (fallback mode only). */
  publicAuthorize: boolean;
  toolRateLimits: RateLimitSpec[];
  gevApiOrigins: string[];
}

export interface RateLimitSpec {
  bucket: string;
  limit: number;
  windowMs: number;
}

const WINDOWS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseRateLimits(spec: string): RateLimitSpec[] {
  const out: RateLimitSpec[] = [];
  for (const part of spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const m = /^([a-z0-9_:-]+)=(\d+)\/(s|m|h|d)$/i.exec(part);
    if (!m) throw new Error(`bad TOOL_RATE_LIMITS entry: ${part}`);
    out.push({ bucket: m[1]!, limit: Number(m[2]), windowMs: WINDOWS[m[3]!.toLowerCase()]! });
  }
  return out;
}

/**
 * Appends the defaults whose bucket `target` does not name yet, so a limit the operator set
 * (or an earlier family's) for the same bucket wins; never adds a bucket and window twice.
 */
export function addDefaultRateLimits(
  target: RateLimitSpec[],
  defaults: RateLimitSpec[],
): RateLimitSpec[] {
  const named = new Set(target.map((l) => l.bucket));
  for (const d of defaults)
    if (
      !named.has(d.bucket) &&
      !target.some((t) => t.bucket === d.bucket && t.windowMs === d.windowMs)
    )
      target.push(d);
  return target;
}

/** The settings that hold each gateway-native tool family's default quotas. */
export const FAMILY_RATE_LIMIT_SETTINGS = [
  'AVIATION_RATE_LIMITS',
  'WEATHER_TOOL_RATE_LIMITS',
  'ROADS_TOOL_RATE_LIMITS',
  'CIVIC_TOOL_RATE_LIMITS',
] as const satisfies readonly (keyof RawConfig)[];

/**
 * The one quota list the policy enforces (config.toolRateLimits): every TOOL_RATE_LIMITS entry,
 * then each family's defaults for the buckets TOOL_RATE_LIMITS does not name.
 */
export function composeToolRateLimits(
  raw: Pick<RawConfig, 'TOOL_RATE_LIMITS' | (typeof FAMILY_RATE_LIMIT_SETTINGS)[number]>,
): RateLimitSpec[] {
  const out = parseRateLimits(raw.TOOL_RATE_LIMITS);
  for (const k of FAMILY_RATE_LIMIT_SETTINGS) addDefaultRateLimits(out, parseRateLimits(raw[k]));
  return out;
}

function originOf(name: string, value: string): URL {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new ConfigError(`${name} must be an absolute URL`);
  }
  if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash)
    throw new ConfigError(`${name} must be an origin with no path`);
  return u;
}

export class ConfigError extends Error {}

/** tcp://host:port -> {host, port}, or null. */
export function parseRelayUrl(u: string): { host: string; port: number } | null {
  const m = /^tcp:\/\/([A-Za-z0-9.-]+|\[[0-9a-fA-F:]+\]):(\d{1,5})$/.exec(u.trim());
  if (!m) return null;
  const port = Number(m[2]);
  if (port < 1 || port > 65535) return null;
  return { host: m[1]!.replace(/^\[|\]$/g, ''), port };
}

/**
 * Addresses a listener must never use in production. Tailscale's userspace netstack
 * (the sidecar runs with TS_USERSPACE=true) re-dials any tailnet connection on a port
 * that `tailscale serve` does not own to 127.0.0.1:<same port> (::1 for IPv6), with the
 * client's own headers intact. A listener on loopback 127.0.0.1, ::1 or a wildcard
 * address is therefore reachable by any tailnet peer the policy admits, and its peer
 * address (127.0.0.1) is indistinguishable from tailscale serve's.
 *
 * The address is parsed, not looked up as a string, so every spelling counts: brackets,
 * case, whitespace, zero compression or none ("0:0:0:0:0:0:0:0", "::0", "0::"), a zone, and
 * IPv4-mapped forms ("::ffff:0:0", "::ffff:7f00:1", "0:0:0:0:0:ffff:7f00:1").
 */
export function isNetstackReachable(host: string): boolean {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (h === '' || h === 'localhost' || h.endsWith('.localhost')) return true;
  const ip = parseIp(h);
  if (!ip) return false;
  if (isUnspecifiedIp(h) || isIpv6Loopback(h)) return true;
  return ip.v4 === '127.0.0.1';
}

/** A bare dotted IPv4 loopback address (127.0.0.0/8), exactly as a listener would bind it. */
function isLoopbackV4(ip: string): boolean {
  return isIP(ip) === 4 && ip.startsWith('127.');
}

/** Production listener and proxy-trust rules (fail closed). */
export function checkProductionBinds(raw: {
  HOST: string;
  PRIVATE_HOST: string;
  UI_HOST?: string;
  TRUSTED_PROXY_IPS: string[];
  TAILSCALE_TRUSTED_PROXY_IPS: string[];
}): void {
  for (const [name, host] of [
    ['PRIVATE_HOST', raw.PRIVATE_HOST],
    ['UI_HOST', raw.UI_HOST ?? raw.PRIVATE_HOST],
  ] as const) {
    if (isNetstackReachable(host) || !isLoopbackV4(host)) {
      throw new ConfigError(
        `production requires ${name} to be a loopback alias other than 127.0.0.1 (use 127.0.0.2), not "${host}": ` +
          "Tailscale's userspace netstack forwards raw tailnet connections to 127.0.0.1:<port>, bypassing tailscale serve",
      );
    }
  }
  // (isIP: a bare literal, exactly as listen() gets it; no hostnames, brackets or spaces.)
  if (isNetstackReachable(raw.HOST) || isIP(raw.HOST) === 0) {
    throw new ConfigError(
      `production requires HOST to be the gateway's compose-network address (e.g. 172.30.77.20), not "${raw.HOST}": ` +
        'a wildcard or 127.0.0.1 bind is reachable from the tailnet through the netstack and skips the Cloudflare WAF',
    );
  }
  if (!raw.TRUSTED_PROXY_IPS.length) {
    throw new ConfigError("production requires TRUSTED_PROXY_IPS = cloudflared's fixed address");
  }
  for (const ip of raw.TRUSTED_PROXY_IPS) {
    if (isIP(ip) === 0 || isNetstackReachable(ip)) {
      throw new ConfigError(
        `TRUSTED_PROXY_IPS must list only cloudflared's fixed address in production, not "${ip}" ` +
          '(127.0.0.1 is where netstack-forwarded tailnet connections come from)',
      );
    }
  }
  for (const ip of raw.TAILSCALE_TRUSTED_PROXY_IPS) {
    const p = parseIp(ip);
    if (!p || !(p.v4?.startsWith('127.') || isIpv6Loopback(ip))) {
      throw new ConfigError(
        `TAILSCALE_TRUSTED_PROXY_IPS must be loopback (tailscale serve in the shared netns), not "${ip}"`,
      );
    }
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`invalid configuration: ${msg}`);
  }
  const raw = parsed.data;
  const mode =
    raw.GATEWAY_MODE ??
    (raw.NODE_ENV === 'production'
      ? 'production'
      : raw.NODE_ENV === 'test'
        ? 'test'
        : 'development');
  const publicUrl = originOf('PUBLIC_ORIGIN', raw.PUBLIC_ORIGIN);
  const issuer = publicUrl.origin;
  const privateUrl = originOf(
    'PRIVATE_ORIGIN',
    raw.PRIVATE_ORIGIN ?? `http://127.0.0.1:${raw.PRIVATE_PORT}`,
  );
  const privateOrigin = privateUrl.origin;
  const uiHost = raw.UI_HOST ?? raw.PRIVATE_HOST;
  let uiDefault = `http://127.0.0.1:${raw.UI_PORT}`;
  if (raw.PRIVATE_ORIGIN && privateUrl.protocol === 'https:') {
    const u = new URL(privateOrigin);
    u.port = '8443';
    uiDefault = u.origin;
  }
  const uiUrl = originOf('UI_ORIGIN', raw.UI_ORIGIN ?? uiDefault);
  const uiOrigin = uiUrl.origin;
  // (Both defaults with port 0, as in tests, are just placeholders.)
  if (uiOrigin === privateOrigin && (raw.PRIVATE_ORIGIN || raw.UI_ORIGIN))
    throw new ConfigError(
      'UI_ORIGIN must differ from PRIVATE_ORIGIN (e.g. the same name on port 8443): the GEV and Pulse UIs must not share an origin with consent and admin',
    );
  const passwordConfigured = Boolean(raw.GATEWAY_PASSWORD_HASH && raw.GATEWAY_TOTP_SECRET);
  const tailscaleConfigured = Boolean(raw.OWNER_TAILSCALE_LOGIN);
  const publicAuthorize = raw.PUBLIC_AUTHORIZE_FALLBACK === 'password';

  if (mode === 'production') {
    if (publicUrl.protocol !== 'https:')
      throw new ConfigError('production requires an https PUBLIC_ORIGIN');
    if (!raw.PRIVATE_ORIGIN || privateUrl.protocol !== 'https:') {
      throw new ConfigError(
        'production requires an https PRIVATE_ORIGIN (the tailnet URL, e.g. https://godseye.<tailnet>.ts.net)',
      );
    }
    if (uiUrl.protocol !== 'https:')
      throw new ConfigError(
        'production requires an https UI_ORIGIN (default: PRIVATE_ORIGIN:8443)',
      );
    if (!tailscaleConfigured) {
      throw new ConfigError('production mode requires OWNER_TAILSCALE_LOGIN (fail closed)');
    }
    if (raw.LOGIN_PROVIDER === 'password') {
      throw new ConfigError('LOGIN_PROVIDER=password is not allowed in production; use tailscale');
    }
    checkProductionBinds(raw);
    if (raw.STEPUP_TOTP === 'on' && !raw.STEPUP_KEY) {
      throw new ConfigError(
        'production requires STEPUP_KEY (encrypts the step-up TOTP secret at rest; generate one with `node dist/scripts/stepup.js keygen`), or STEPUP_TOTP=off',
      );
    }
  }
  if (raw.GEV_CHILD_URL && !parseRelayUrl(raw.GEV_CHILD_URL))
    throw new ConfigError('GEV_CHILD_URL must look like tcp://host:port');
  if (raw.STEPUP_KEY) {
    try {
      parseStepUpKey(raw.STEPUP_KEY);
    } catch (err) {
      throw new ConfigError((err as Error).message);
    }
  }
  if (publicAuthorize && !passwordConfigured) {
    throw new ConfigError(
      'PUBLIC_AUTHORIZE_FALLBACK=password needs GATEWAY_PASSWORD_HASH and GATEWAY_TOTP_SECRET',
    );
  }

  let loginProvider: Config['loginProvider'];
  if (raw.LOGIN_PROVIDER === 'tailscale') {
    if (!tailscaleConfigured)
      throw new ConfigError('LOGIN_PROVIDER=tailscale needs OWNER_TAILSCALE_LOGIN');
    loginProvider = 'tailscale';
  } else if (raw.LOGIN_PROVIDER === 'password') {
    if (!passwordConfigured)
      throw new ConfigError(
        'LOGIN_PROVIDER=password needs GATEWAY_PASSWORD_HASH and GATEWAY_TOTP_SECRET',
      );
    loginProvider = 'password';
  } else {
    loginProvider = tailscaleConfigured ? 'tailscale' : passwordConfigured ? 'password' : 'none';
  }

  const authorizationEndpoint =
    raw.AUTHORIZATION_ENDPOINT ??
    (publicAuthorize ? `${issuer}/oauth/authorize` : `${privateOrigin}/oauth/authorize`);
  const linkOrigin = (raw.LINK_ORIGIN ?? uiOrigin).replace(/\/+$/, '');

  const gevUrl = new URL(raw.GEV_URL);
  const gevApiOrigins = new Set<string>([gevUrl.origin]);
  if (gevUrl.hostname === '127.0.0.1') gevApiOrigins.add(`http://localhost:${gevUrl.port || '80'}`);

  // A specific bind address is also an acceptable Host (health checks and the in-container
  // smoke test reach the listener by IP); wildcard binds are not.
  const bindHost = (h: string) => (isIP(h) && !isUnspecifiedIp(h) ? [h] : []);
  const allowedHosts = Array.from(
    new Set([
      publicUrl.hostname,
      '127.0.0.1',
      'localhost',
      ...bindHost(raw.HOST),
      ...raw.EXTRA_ALLOWED_HOSTS,
    ]),
  );
  const privateAllowedHosts = Array.from(
    new Set([privateUrl.hostname, '127.0.0.1', 'localhost', ...bindHost(raw.PRIVATE_HOST)]),
  );
  const uiAllowedHosts = Array.from(
    new Set([uiUrl.hostname, '127.0.0.1', 'localhost', ...bindHost(uiHost)]),
  );

  return {
    ...raw,
    mode,
    dbPath: raw.DB_PATH ?? path.join(raw.DATA_DIR, 'gateway.sqlite'),
    publicHost: publicUrl.host,
    issuer,
    mcpResource: `${issuer}/mcp`,
    allowedHosts,
    privateAllowedHosts,
    privateOrigin,
    uiAllowedHosts,
    uiOrigin,
    uiHost,
    authorizationEndpoint,
    linkOrigin,
    loginProvider,
    ownerTailscaleLogin: raw.OWNER_TAILSCALE_LOGIN?.toLowerCase(),
    publicAuthorize,
    toolRateLimits: composeToolRateLimits(raw),
    gevApiOrigins: Array.from(gevApiOrigins),
  };
}

/** Load KEY=VALUE pairs from a .env file into process.env without overriding existing vars. */
export function loadEnvFile(file = path.join(REPO_ROOT, '.env')): boolean {
  if (!existsSync(file)) return false;
  process.loadEnvFile(file);
  return true;
}
