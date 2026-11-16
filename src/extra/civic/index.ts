/**
 * Civic tools (gateway-native, family "civic"):
 *   dpd_calls_near         City of Detroit Police Serviced 911 Calls (keyless, delayed hours)
 *   transit_vehicles_near  SMART buses and alerts via Swiftly GTFS-Realtime (SWIFTLY_API_KEY)
 *   local_headlines        local newsrooms' public feeds (LOCAL_NEWS_FEEDS, refreshed in the
 *                          background every 15 min), plus GDELT DOC 2.0 when it answers (the
 *                          shared GDELT queue: 1 request / 6 s plus jitter, growing pauses after
 *                          refusals; 15-minute cache)
 * Registered through the normal registry, so policy, validation, quotas (CIVIC_TOOL_RATE_LIMITS
 * in toolRateLimits) and post-processing apply as for every other tool.
 */
import path from 'node:path';
import type { Audit } from '../../audit.js';
import type { Config } from '../../config.js';
import type { LocationStore } from '../../location/store.js';
import type { Logger } from '../../log.js';
import type { TokenStore } from '../../oauth/tokens.js';
import type { ToolRegistry } from '../../tools/registry.js';
import type { ToolDef } from '../../tools/types.js';
import type { FetchLike } from './common.js';
import { dpdTools } from './dpd.js';
import { LocalNewsFeeds } from './feeds.js';
import type { SpacedQueue } from './gdelt.js';
import { headlinesTools } from './headlines.js';
import { transitTools } from './transit.js';

export interface CivicDeps {
  config: Config;
  locations: LocationStore;
  audit?: Audit;
  tokens?: TokenStore;
  logger?: Logger;
  now?: () => number;
  /** Tests inject a mock; production uses the global fetch. */
  fetch?: FetchLike;
  /** Tests inject their own GDELT queue; production shares the process-wide one. */
  gdeltQueue?: SpacedQueue;
  /**
   * Where the local news snapshot is kept: default DATA_DIR/cache/local-news.json (none in test
   * mode); null = memory only.
   */
  newsFile?: string | null;
}

/** The background work of the civic tools: the local news feed refresher. */
export interface CivicHandle {
  /** Starts the background feed refresh (not in test mode). */
  start(): void;
  stop(): void;
  news: LocalNewsFeeds;
}

export function buildCivic(deps: CivicDeps): { tools: ToolDef[]; news: LocalNewsFeeds } {
  const now = deps.now ?? Date.now;
  const fetchImpl = deps.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
  const base = {
    config: deps.config,
    locations: deps.locations,
    audit: deps.audit,
    tokens: deps.tokens,
    now,
    fetch: fetchImpl,
  };
  const file =
    deps.newsFile === null
      ? undefined
      : (deps.newsFile ??
        (deps.config.mode === 'test'
          ? undefined
          : path.join(deps.config.DATA_DIR, 'cache', 'local-news.json')));
  let warned = false;
  const news = new LocalNewsFeeds({
    feeds: deps.config.LOCAL_NEWS_FEEDS,
    fetch: fetchImpl,
    now,
    ...(file ? { file } : {}),
    onError: (outlet, _url, err) =>
      deps.logger?.warn('local_news_feed_failed', {
        outlet,
        error: (err as Error)?.message?.slice(0, 160),
      }),
    onWriteError: (err) => {
      if (warned) return;
      warned = true;
      deps.logger?.warn('local_news_snapshot_write_failed', {
        error: (err as Error)?.message?.slice(0, 120),
      });
    },
  });
  return {
    tools: [
      ...dpdTools(base),
      ...transitTools({
        ...base,
        apiKey: deps.config.SWIFTLY_API_KEY,
        staticGtfs: deps.config.SMART_STATIC_GTFS,
      }),
      ...headlinesTools({ ...base, feeds: news, queue: deps.gdeltQueue }),
    ],
    news,
  };
}

export function civicTools(deps: CivicDeps): ToolDef[] {
  return buildCivic(deps).tools;
}

/** Registers the civic tools (the one entry point gateway.ts calls). */
export function registerCivicTools(registry: ToolRegistry, deps: CivicDeps): CivicHandle {
  const built = buildCivic(deps);
  for (const t of built.tools) registry.register(t);
  return {
    start() {
      if (deps.config.mode !== 'test') built.news.start();
    },
    stop() {
      built.news.stop();
    },
    news: built.news,
  };
}
