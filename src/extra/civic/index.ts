/**
 * Civic tools (gateway-native, family "civic"):
 *   dpd_calls_near         City of Detroit Police Serviced 911 Calls (keyless, delayed hours)
 *   transit_vehicles_near  SMART buses and alerts via Swiftly GTFS-Realtime (SWIFTLY_API_KEY)
 *   local_headlines        GDELT DOC 2.0 news headlines for a place (keyless, 1 request / 5 s)
 * Registered through the normal registry, so policy, validation, quotas (CIVIC_TOOL_RATE_LIMITS
 * in toolRateLimits) and post-processing apply as for every other tool.
 */
import type { Audit } from '../../audit.js';
import type { Config } from '../../config.js';
import type { LocationStore } from '../../location/store.js';
import type { TokenStore } from '../../oauth/tokens.js';
import type { ToolRegistry } from '../../tools/registry.js';
import type { ToolDef } from '../../tools/types.js';
import type { FetchLike } from './common.js';
import { dpdTools } from './dpd.js';
import { headlinesTools, type SpacedQueue } from './headlines.js';
import { transitTools } from './transit.js';

export interface CivicDeps {
  config: Config;
  locations: LocationStore;
  audit?: Audit;
  tokens?: TokenStore;
  now?: () => number;
  /** Tests inject a mock; production uses the global fetch. */
  fetch?: FetchLike;
  /** Tests inject their own GDELT queue; production shares the process-wide one. */
  gdeltQueue?: SpacedQueue;
}

export function civicTools(deps: CivicDeps): ToolDef[] {
  const base = {
    config: deps.config,
    locations: deps.locations,
    audit: deps.audit,
    tokens: deps.tokens,
    now: deps.now ?? Date.now,
    fetch: deps.fetch ?? ((url: string, init: RequestInit) => fetch(url, init)),
  };
  return [
    ...dpdTools(base),
    ...transitTools({
      ...base,
      apiKey: deps.config.SWIFTLY_API_KEY,
      staticGtfs: deps.config.SMART_STATIC_GTFS,
    }),
    ...headlinesTools({ ...base, queue: deps.gdeltQueue }),
  ];
}

/** Registers the civic tools (the one entry point gateway.ts calls). */
export function registerCivicTools(registry: ToolRegistry, deps: CivicDeps): void {
  for (const t of civicTools(deps)) registry.register(t);
}
