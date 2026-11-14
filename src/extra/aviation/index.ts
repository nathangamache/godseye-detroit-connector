/**
 * Aviation tool family: flights_near (live aircraft near a point or the phone) and
 * aircraft_lookup (FAA registry), plus the daily FAA registry sync that feeds both.
 *
 *   const aviation = registerAviation(registry, deps);   // in buildCore
 *   aviation.start();                                    // once the gateway listens
 *   aviation.stop();                                     // on close
 *
 * Settings: the "---- aviation ----" block of src/config.ts. Default quotas come from
 * AVIATION_RATE_LIMITS and apply through the policy's toolRateLimits for every bucket that
 * TOOL_RATE_LIMITS does not already set.
 */
import path from 'node:path';
import type { Audit } from '../../audit.js';
import { parseRateLimits, type Config, type RateLimitSpec } from '../../config.js';
import type { LocationStore } from '../../location/store.js';
import type { Logger } from '../../log.js';
import type { TokenStore } from '../../oauth/tokens.js';
import type { ToolRegistry } from '../../tools/registry.js';
import type { FetchFn } from './http.js';
import { LaddTracker } from './ladd.js';
import { LiveClient, type Upstreams } from './live.js';
import { RegistryStore } from './registry-store.js';
import { RegistrySync } from './registry-sync.js';
import { aviationTools } from './tools.js';

export interface AviationDeps {
  config: Config;
  locations: LocationStore;
  audit?: Audit;
  tokens?: TokenStore;
  logger: Logger;
  now?: () => number;
  /** Tests: replaces every outbound request (adsb.fi, adsb.lol, FAA). */
  fetch?: FetchFn;
  /** Tests: isolated throttles, cool-downs and caches instead of the process-wide ones. */
  upstreams?: Upstreams;
}

export interface AviationHandle {
  readonly dir: string;
  readonly store: RegistryStore;
  readonly sync: RegistrySync;
  readonly live: LiveClient;
  readonly ladd: LaddTracker;
  /** Starts the daily registry sync (not in test mode, nor with AIRCRAFT_REGISTRY_SYNC=false). */
  start(): void;
  stop(): void;
}

export function aviationDir(config: Pick<Config, 'AIRCRAFT_REGISTRY_DIR' | 'DATA_DIR'>): string {
  return config.AIRCRAFT_REGISTRY_DIR ?? path.join(config.DATA_DIR, 'aviation');
}

/** Adds a family's default quotas for the buckets the configured list does not mention. */
export function addDefaultRateLimits(target: RateLimitSpec[], defaults: RateLimitSpec[]): void {
  const configured = new Set(target.map((l) => l.bucket));
  for (const d of defaults)
    if (
      !configured.has(d.bucket) &&
      !target.some((t) => t.bucket === d.bucket && t.windowMs === d.windowMs)
    )
      target.push(d);
}

export function registerAviation(registry: ToolRegistry, deps: AviationDeps): AviationHandle {
  const { config, logger } = deps;
  const now = deps.now ?? Date.now;
  const dir = aviationDir(config);
  // The policy evaluates config.toolRateLimits, so the family's defaults join it there.
  addDefaultRateLimits(config.toolRateLimits, parseRateLimits(config.AVIATION_RATE_LIMITS));
  const store = new RegistryStore(dir, now);
  const sync = new RegistrySync(
    {
      dir,
      url: config.AIRCRAFT_REGISTRY_URL,
      fetch: deps.fetch,
      logger,
      now,
      storePrivateNames: config.AIRCRAFT_OWNER_DISCLOSURE === 'full',
    },
    store,
  );
  const live = new LiveClient({
    fetch: deps.fetch,
    upstreams: deps.upstreams,
    now,
    logger,
    lolDailyMax: config.ADSBLOL_DAILY_MAX,
  });
  const ladd = new LaddTracker(dir, now);
  for (const t of aviationTools({
    config,
    locations: deps.locations,
    audit: deps.audit,
    tokens: deps.tokens,
    store,
    live,
    ladd,
    now,
  }))
    registry.register(t);
  return {
    dir,
    store,
    sync,
    live,
    ladd,
    start() {
      if (config.AIRCRAFT_REGISTRY_SYNC && config.mode !== 'test') sync.start();
    },
    stop() {
      sync.stop();
      store.close();
    },
  };
}
