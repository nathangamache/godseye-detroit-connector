/**
 * Tool policy: which tools may run, argument rules and per-tool rate limits.
 *
 * Order of evaluation (first match wins):
 *  1. NEVER: tools that must not exist on the connector at all (panel_request).
 *  2. Licensing hard denies (Google-derived content; metered OpenAI). Not configurable.
 *  3. Licensing switches: OpenSky-backed aviation tools, ALPR locations; then tools a backend
 *     switched off at startup (switchOff, e.g. a missing API key).
 *  4. TOOL_DENYLIST from config.
 *  5. GEV tools must be on GEV_TOOL_ALLOWLIST (deny by default, so a tool that
 *     appears after an upstream pull stays hidden until it is vetted).
 * The GEV child is started with only the allowed tools (allowedGevTools), so composite GEV
 * tools can't reach a denied one internally; argument rules (checkArguments) add a second
 * layer, e.g. no aircraft "follow" while OpenSky is off.
 */
import { addDefaultRateLimits, type Config, type RateLimitSpec } from '../config.js';
import { RateLimiter } from '../util/ratelimit.js';
import type { ToolDef } from './types.js';

/** Never registered, never callable. */
export const NEVER_TOOLS = new Set(['panel_request']);

/** Google Maps Platform content must not be fed to Claude (ToS 3.2.3, Map Tiles policy). */
export const GOOGLE_TOOLS = new Set(['search_places', 'places_nearby']);

/** Metered OpenAI summary (and it composes OpenSky data). */
export const METERED_TOOLS = new Set(['get_hud_caption']);

/** Tools that call OpenSky (directly or through a composite). OpenSky needs a written licence. */
export const OPENSKY_TOOLS = new Set([
  'aircraft_in_area',
  'find_aircraft',
  'get_aircraft_track',
  'get_aircraft_info',
  'situation_brief',
  'military_awareness',
]);

export const ALPR_TOOLS = new Set(['find_alpr_cameras']);

export type PolicyVerdict = { allowed: true } | { allowed: false; reason: string };

export class ToolPolicy {
  readonly limiter: RateLimiter;
  private readonly limits: RateLimitSpec[];
  /** Tools a backend switched off at startup (e.g. its API key is missing), with the reason. */
  private readonly switchedOff = new Map<string, string>();

  constructor(
    private readonly config: Pick<
      Config,
      | 'GEV_TOOL_ALLOWLIST'
      | 'TOOL_DENYLIST'
      | 'ALLOW_OPENSKY_TOOLS'
      | 'ALLOW_ALPR_TOOLS'
      | 'GEV_PLACE_NAMES'
      | 'toolRateLimits'
    >,
    limiter?: RateLimiter,
  ) {
    this.limiter = limiter ?? new RateLimiter();
    this.limits = [...config.toolRateLimits];
  }

  /** Switch a tool off: hidden from find_tools, and run_tool answers with `reason`. */
  switchOff(name: string, reason: string): void {
    this.switchedOff.set(name, reason);
  }

  /**
   * Default quotas a tool family brings (src/extra). A TOOL_RATE_LIMITS entry for the same
   * bucket replaces them, so the operator's own limits always win. loadConfig already folds
   * every family's *_RATE_LIMITS setting into toolRateLimits (composeToolRateLimits), so for a
   * loaded config this adds nothing new; it keeps a hand-built config honest too.
   */
  addDefaultLimits(specs: RateLimitSpec[]): void {
    addDefaultRateLimits(this.limits, specs);
  }

  evaluate(tool: Pick<ToolDef, 'name' | 'source'>): PolicyVerdict {
    const n = tool.name;
    if (NEVER_TOOLS.has(n))
      return { allowed: false, reason: `${n} is never exposed by this connector` };
    if (GOOGLE_TOOLS.has(n))
      return {
        allowed: false,
        reason: `${n} returns Google Maps Platform content, which may not be passed to an AI assistant under Google's terms`,
      };
    if (METERED_TOOLS.has(n))
      return { allowed: false, reason: `${n} depends on a metered paid API` };
    if (OPENSKY_TOOLS.has(n) && !this.config.ALLOW_OPENSKY_TOOLS)
      return {
        allowed: false,
        reason: `${n} uses OpenSky Network data, which needs a written licence for automated use (ALLOW_OPENSKY_TOOLS=false)`,
      };
    if (ALPR_TOOLS.has(n) && !this.config.ALLOW_ALPR_TOOLS)
      return { allowed: false, reason: `${n} is disabled by policy (ALLOW_ALPR_TOOLS=false)` };
    const off = this.switchedOff.get(n);
    if (off) return { allowed: false, reason: `${n} is off: ${off}` };
    if (this.config.TOOL_DENYLIST.includes(n))
      return { allowed: false, reason: `${n} is on TOOL_DENYLIST` };
    if (tool.source === 'gev' && !this.config.GEV_TOOL_ALLOWLIST.includes(n))
      return { allowed: false, reason: `${n} is not on the vetted GEV tool allowlist` };
    return { allowed: true };
  }

  /**
   * Why a tool name is explicitly denied (never exposed, licensing, a switch or the deny
   * list), or null. Used to explain a refusal for a tool the child no longer even lists.
   */
  deniedReason(name: string): string | null {
    const explicit =
      NEVER_TOOLS.has(name) ||
      GOOGLE_TOOLS.has(name) ||
      METERED_TOOLS.has(name) ||
      OPENSKY_TOOLS.has(name) ||
      ALPR_TOOLS.has(name) ||
      this.switchedOff.has(name) ||
      this.config.TOOL_DENYLIST.includes(name);
    if (!explicit) return null;
    const v = this.evaluate({ name, source: 'gev' });
    return v.allowed ? null : v.reason;
  }

  /** The GEV tools this policy lets through: the child is started with exactly these. */
  allowedGevTools(): string[] {
    return this.config.GEV_TOOL_ALLOWLIST.filter(
      (name) => this.evaluate({ name, source: 'gev' }).allowed,
    );
  }

  /**
   * Argument rules that apply across tools. Returns an error message, or null.
   * Place-name lookups go through Nominatim inside GEV; without a configured
   * geocoder they fail with an opaque error, so reject them with guidance.
   */
  checkArguments(
    tool: Pick<ToolDef, 'name' | 'source'>,
    args: Record<string, unknown>,
  ): string | null {
    if (tool.source !== 'gev') return null;
    if (!this.config.ALLOW_OPENSKY_TOOLS && followsAircraft(args)) {
      return (
        'Following an aircraft uses OpenSky Network data, which this deployment has turned off ' +
        '(ALLOW_OPENSKY_TOOLS=false). Give a camera (lat/lon) or an area without "follow".'
      );
    }
    if (hasPlaceArgument(args) && !this.config.GEV_PLACE_NAMES) {
      return (
        'Place names are not supported by this deployment (no geocoder is configured). ' +
        'Pass coordinates instead, e.g. {"lat": 42.33, "lon": -83.05, "radius_km": 5}; ' +
        "use where_am_i for the user's own position."
      );
    }
    return null;
  }

  /** Buckets a call consumes: the tool's own name, plus "nominatim" for place lookups. */
  bucketsFor(tool: Pick<ToolDef, 'name' | 'source'>, args: Record<string, unknown>): string[] {
    const buckets = [tool.name];
    if (tool.source === 'gev' && hasPlaceArgument(args)) buckets.push('nominatim');
    return buckets;
  }

  /** Checks all applicable limits; records a hit in every bucket only if all pass. */
  consumeRate(
    buckets: string[],
  ): { ok: true } | { ok: false; bucket: string; retryAfterS: number } {
    const specs = this.limits.filter((l) => buckets.includes(l.bucket));
    for (const s of specs) {
      const r = this.limiter.peek(key(s), s.limit, s.windowMs);
      if (!r.ok)
        return { ok: false, bucket: s.bucket, retryAfterS: Math.ceil(r.retryAfterMs / 1000) };
    }
    // Tool quotas are global budgets (shared by every grant): never evicted by key churn.
    for (const s of specs) this.limiter.record(key(s), s.windowMs, { global: true });
    return { ok: true };
  }
}

const key = (s: RateLimitSpec) => `tool:${s.bucket}:${s.windowMs}`;

export function hasPlaceArgument(value: unknown, depth = 0): boolean {
  if (depth > 5 || !value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((v) => hasPlaceArgument(v, depth + 1));
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === 'place' && typeof v === 'string' && v.trim()) return true;
    if (hasPlaceArgument(v, depth + 1)) return true;
  }
  return false;
}

/** Aircraft kinds GEV can follow; following one makes GEV call find_aircraft (OpenSky). */
export const AIRCRAFT_FOLLOW_KINDS = new Set(['aircraft', 'military_aircraft']);

/** True if any `follow` object (e.g. follow or view.follow) names an aircraft kind. */
export function followsAircraft(value: unknown, depth = 0): boolean {
  if (depth > 5 || !value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((v) => followsAircraft(v, depth + 1));
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (
      k === 'follow' &&
      v &&
      typeof v === 'object' &&
      AIRCRAFT_FOLLOW_KINDS.has(String((v as { kind?: unknown }).kind ?? '').toLowerCase())
    )
      return true;
    if (followsAircraft(v, depth + 1)) return true;
  }
  return false;
}
