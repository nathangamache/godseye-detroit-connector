/**
 * Radio tools (gateway-native, family "radio"):
 *   radio_stations_near   stations near a point from the Radio Browser directory (keyless)
 * Registered through the normal registry, so policy, validation, quotas (RADIO_TOOL_RATE_LIMITS,
 * folded into toolRateLimits) and post-processing apply as for every other tool. Not part of
 * whats_happening_here.
 */
import type { Audit } from '../../audit.js';
import { parseRateLimits, type Config } from '../../config.js';
import type { LocationStore } from '../../location/store.js';
import type { TokenStore } from '../../oauth/tokens.js';
import type { ToolRegistry } from '../../tools/registry.js';
import type { ToolDef } from '../../tools/types.js';
import type { FetchLike } from '../civic/common.js';
import { RadioBrowser } from './browser.js';
import { radioStationTools } from './tools.js';

export interface RadioDeps {
  config: Pick<
    Config,
    | 'RADIO_TOOL_RATE_LIMITS'
    | 'LOCATION_STALE_MINUTES'
    | 'LOCATION_RETENTION_HOURS'
    | 'privateOrigin'
  >;
  locations: LocationStore;
  audit?: Audit;
  tokens?: TokenStore;
  now?: () => number;
  /** Tests inject a mock; production uses the global fetch. */
  fetch?: FetchLike;
  /** Tests: a fixed mirror order (default: shuffled, as Radio Browser asks). */
  shuffle?: (hosts: string[]) => string[];
}

export function radioTools(deps: RadioDeps): ToolDef[] {
  const now = deps.now ?? Date.now;
  const directory = new RadioBrowser({
    fetch: deps.fetch ?? ((url: string, init: RequestInit) => fetch(url, init)),
    now,
    shuffle: deps.shuffle,
  });
  return radioStationTools({
    config: deps.config,
    locations: deps.locations,
    audit: deps.audit,
    tokens: deps.tokens,
    now,
    directory,
  });
}

/**
 * Registers the radio tools and their default quotas (already in config.toolRateLimits for a
 * loaded config); a bucket the operator set in TOOL_RATE_LIMITS keeps that setting.
 */
export function registerRadioTools(registry: ToolRegistry, deps: RadioDeps): ToolDef[] {
  registry.policy.addDefaultLimits(parseRateLimits(deps.config.RADIO_TOOL_RATE_LIMITS));
  const tools = radioTools(deps);
  for (const t of tools) registry.register(t);
  return tools;
}
