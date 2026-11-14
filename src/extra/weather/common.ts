/**
 * Shared pieces of the weather, water and air tools: the {lat, lon | here} location arguments
 * (zod, published as JSON Schema), phone-fix resolution with the same audit as where_am_i, a
 * small TTL cache, and clean-up of third-party text.
 */
import { z } from 'zod';
import type { LatestFix } from '../../location/store.js';
import type { JsonSchema, ToolContext, ToolOutput } from '../../tools/types.js';
import { humanAge } from '../../util/format.js';
import { UpstreamError } from './http.js';

/** Location arguments every tool here takes: a point, or here: true for the phone fix. */
export const LOCATION_SHAPE = {
  lat: z
    .number()
    .min(-90)
    .max(90)
    .optional()
    .describe('Latitude (WGS84). Give lat and lon, or here: true.'),
  lon: z.number().min(-180).max(180).optional().describe('Longitude (WGS84)'),
  here: z
    .boolean()
    .optional()
    .describe("true: use the user's latest phone location fix instead of lat/lon"),
};

/** JSON Schema for run_tool's validator and find_tools (zod is the source of truth). */
export function jsonSchemaOf(schema: z.ZodType): JsonSchema {
  const { $schema: _s, ...rest } = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io: 'input',
  }) as Record<string, unknown>;
  return rest;
}

export function invalid(summary: string): ToolOutput {
  return { summary, isError: true, errorKind: 'invalid_arguments' };
}

/** Parses arguments with the tool's zod schema; an error output on failure. */
export function parseArgs<S extends z.ZodType>(
  schema: S,
  args: Record<string, unknown>,
  tool: string,
): { ok: true; value: z.infer<S> } | { ok: false; out: ToolOutput } {
  const r = schema.safeParse(args);
  if (r.success) return { ok: true, value: r.data };
  const msg = r.error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || '(arguments)'}: ${i.message}`)
    .join('; ');
  return { ok: false, out: invalid(`Invalid arguments for ${tool}: ${msg}.`) };
}

export interface PhoneDeps {
  locations: { latest(): LatestFix | undefined };
  /** Location reads are audited like where_am_i's (client, grant, tool, fix found; never coordinates). */
  audit?: {
    record(
      event: string,
      f: { clientId?: string; subject?: string; detail?: Record<string, unknown> },
    ): void;
  };
  tokens?: { noteLocationRead(familyId: string): void };
  staleMinutes: number;
  retentionHours: number;
  /** Where /locate lives (the private origin), for the no-fix hint. */
  locateOrigin: string;
  now: () => number;
}

export type ResolvedPoint =
  | { lat: number; lon: number; source: 'caller' }
  | {
      lat: number;
      lon: number;
      source: 'phone';
      fix_age_s: number;
      stale: boolean;
      accuracy_m: number | null;
    };

/** The point a call is about: lat/lon, or the phone's latest fix (audited) for here: true. */
export function resolvePoint(
  tool: string,
  a: { lat?: number; lon?: number; here?: boolean },
  ctx: ToolContext,
  deps: PhoneDeps,
): { ok: true; point: ResolvedPoint } | { ok: false; out: ToolOutput } {
  const hasLat = a.lat !== undefined;
  const hasLon = a.lon !== undefined;
  if (a.here === true) {
    if (hasLat || hasLon)
      return {
        ok: false,
        out: invalid('Give either lat and lon, or here: true (the phone fix), not both.'),
      };
    const fix = deps.locations.latest();
    deps.audit?.record('location_read', {
      clientId: ctx.clientId,
      subject: ctx.subject,
      detail: { family: ctx.familyId, tool, fix: fix !== undefined },
    });
    if (ctx.familyId) deps.tokens?.noteLocationRead(ctx.familyId);
    if (!fix) {
      return {
        ok: false,
        out: {
          summary:
            `No phone location fix is available (none received in the last ${deps.retentionHours} h). ` +
            `Ask the user to open ${deps.locateOrigin}/locate/ on their phone (over Tailscale) and tap "Update My Location", ` +
            'or to check that OwnTracks is running; or ask where they are and pass lat/lon.',
          isError: true,
          errorKind: 'unavailable',
        },
      };
    }
    const age = Math.max(0, Math.round((deps.now() - fix.fix_ts) / 1000));
    return {
      ok: true,
      point: {
        lat: fix.lat,
        lon: fix.lon,
        source: 'phone',
        fix_age_s: age,
        stale: age > deps.staleMinutes * 60,
        accuracy_m: fix.accuracy_m === null ? null : Math.round(fix.accuracy_m),
      },
    };
  }
  if (hasLat && hasLon) return { ok: true, point: { lat: a.lat!, lon: a.lon!, source: 'caller' } };
  return {
    ok: false,
    out: invalid(
      hasLat || hasLon
        ? 'Give both lat and lon (or here: true for the phone fix).'
        : "Give a point (lat and lon) or here: true for the user's phone location.",
    ),
  };
}

/** "the user's phone fix (4 min old)" / "the given point", for summaries (never coordinates). */
export function pointPhrase(p: ResolvedPoint): string {
  if (p.source === 'caller') return 'the given point';
  const acc = p.accuracy_m !== null ? `, ±${p.accuracy_m} m` : '';
  return `the user's phone fix (${humanAge(p.fix_age_s)} old${acc}${p.stale ? '; STALE, they may have moved' : ''})`;
}

/** What results say about where the point came from (no coordinates for a phone fix). */
export function pointData(p: ResolvedPoint): Record<string, unknown> {
  return p.source === 'caller'
    ? { source: 'caller', lat: p.lat, lon: p.lon }
    : {
        source: 'phone',
        fix_age_s: p.fix_age_s,
        stale: p.stale,
        accuracy_m: p.accuracy_m,
      };
}

/** A coordinate as upstream APIs want it: at most 4 decimals (~11 m), no trailing zeros. */
export const coord = (v: number) => String(Number(v.toFixed(4)));

/** Bounded TTL cache (insertion-ordered eviction). */
export class TtlCache<V> {
  private readonly map = new Map<string, { value: V; expires: number }>();

  constructor(
    private readonly max: number,
    private readonly now: () => number,
  ) {}

  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expires <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    return e.value;
  }

  set(key: string, value: V, ttlMs: number): void {
    this.map.delete(key);
    this.map.set(key, { value, expires: this.now() + ttlMs });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  delete(key: string): void {
    this.map.delete(key);
  }
}

// C0 controls except tab and newline, DEL, C1 controls, bidi overrides and zero-width marks.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;

/** Third-party text: controls stripped, whitespace tidied, length capped. Never rewritten. */
export function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** One-line form of third-party text for summaries. */
export function oneLine(v: unknown, max: number): string {
  return (cleanText(v, max * 2) ?? '').replace(/\s+/g, ' ').slice(0, max);
}

export const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

export const str = (v: unknown, max = 200): string | null =>
  typeof v === 'string' && v.trim() ? oneLine(v, max) : null;

/** ISO time or null (never invents one). */
export const isoOrNull = (v: unknown): string | null =>
  typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null;

/** Tool error output for an upstream failure (retry_later for rate limits and outages). */
export function upstreamOutput(err: unknown, hint = ''): ToolOutput {
  if (err instanceof UpstreamError) {
    const kind =
      err.kind === 'rate_limited' || (err.kind === 'http' && err.status >= 500)
        ? 'retry_later'
        : err.kind === 'timeout'
          ? 'timeout'
          : 'unavailable';
    return { summary: `${err.message}.${hint ? ` ${hint}` : ''}`, isError: true, errorKind: kind };
  }
  throw err;
}

/** Runs fn over items with at most `limit` in flight. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}
