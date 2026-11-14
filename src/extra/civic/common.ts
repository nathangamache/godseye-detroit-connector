/**
 * Shared plumbing for the civic tools (dpd_calls_near, transit_vehicles_near, local_headlines):
 * outbound HTTP with timeouts, a generic User-Agent and size caps; small in-memory caches;
 * "lat/lon or here" point resolution (phone reads audited like where_am_i); zod-validated
 * tool definitions; and cleaning of third-party text.
 */
import { z } from 'zod';
import type { Audit } from '../../audit.js';
import type { Config } from '../../config.js';
import type { LocationStore } from '../../location/store.js';
import { currentPosition, noFixMessage } from '../../mcp/whatsHappening.js';
import type { TokenStore } from '../../oauth/tokens.js';
import type { JsonSchema, ToolContext, ToolDef, ToolOutput } from '../../tools/types.js';
import { humanAge } from '../../util/format.js';

/** Generic and self-describing: no person, host or contact in it. */
export const USER_AGENT = 'godseye-detroit-connector/0.1 (personal non-commercial MCP gateway)';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type UpstreamErrorKind =
  | 'timeout'
  | 'cancelled'
  | 'unreachable'
  | 'http'
  | 'auth'
  | 'rate_limited'
  | 'too_large'
  | 'bad_response';

export class UpstreamError extends Error {
  constructor(
    readonly kind: UpstreamErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface FetchOptions {
  timeoutMs: number;
  maxBytes: number;
  headers?: Record<string, string>;
  /** The caller's signal (a tool call being cancelled). */
  signal?: AbortSignal;
}

export interface FetchedBody {
  status: number;
  headers: Headers;
  body: Buffer;
}

/**
 * GET with a timeout, the generic User-Agent, no redirects and a byte cap. Throws
 * UpstreamError for network failures, timeouts and oversize bodies; any HTTP status is
 * returned for the caller to judge.
 */
export async function fetchBytes(
  fetchImpl: FetchLike,
  url: string,
  label: string,
  opts: FetchOptions,
): Promise<FetchedBody> {
  const timeout = AbortSignal.timeout(opts.timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const failed = (): UpstreamError =>
    timeout.aborted
      ? new UpstreamError(
          'timeout',
          `${label} did not answer within ${Math.round(opts.timeoutMs / 1000)} s`,
        )
      : opts.signal?.aborted
        ? new UpstreamError('cancelled', `the ${label} request was cancelled`)
        : new UpstreamError('unreachable', `${label} is not reachable right now`);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: { 'user-agent': USER_AGENT, ...opts.headers },
      redirect: 'error',
      signal,
    });
  } catch {
    throw failed();
  }
  try {
    return { status: res.status, headers: res.headers, body: await readCapped(res, opts.maxBytes) };
  } catch (err) {
    if (err instanceof UpstreamError) throw new UpstreamError(err.kind, `${label} ${err.message}`);
    throw failed();
  }
}

async function readCapped(res: Response, max: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => undefined);
    throw new UpstreamError('too_large', `sent more than ${Math.round(max / 1024)} KB`);
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel().catch(() => undefined);
      throw new UpstreamError('too_large', `sent more than ${Math.round(max / 1024)} KB`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Rejects when `signal` aborts, without cancelling the shared work behind `p`. */
export function untilAborted<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(new UpstreamError('cancelled', 'cancelled'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new UpstreamError('cancelled', 'cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/**
 * Small in-memory cache: concurrent callers share one load, failures are never kept, the
 * oldest entries go first past maxEntries, and an entry is deleted (not just ignored) once
 * it is older than ttlMs, so nothing outlives its TTL in memory.
 */
export class TtlCache<T> {
  private readonly map = new Map<string, { at: number; p: Promise<T>; timer?: NodeJS.Timeout }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string, load: () => Promise<T>): Promise<T> {
    const t = this.now();
    this.prune(t);
    const hit = this.map.get(key);
    if (hit) return hit.p;
    const p = load();
    const entry: { at: number; p: Promise<T>; timer?: NodeJS.Timeout } = { at: t, p };
    entry.timer = setTimeout(() => this.drop(key, entry), this.ttlMs + 1);
    entry.timer.unref();
    this.map.set(key, entry);
    p.catch(() => this.drop(key, entry));
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      const e = this.map.get(oldest);
      if (e) this.drop(oldest, e);
    }
    return p;
  }

  get size(): number {
    this.prune(this.now());
    return this.map.size;
  }

  clear(): void {
    for (const [k, e] of this.map) this.drop(k, e);
  }

  private prune(t: number): void {
    for (const [k, e] of this.map) if (t - e.at > this.ttlMs) this.drop(k, e);
  }

  private drop(key: string, entry: { timer?: NodeJS.Timeout }): void {
    if (this.map.get(key) !== entry) return;
    clearTimeout(entry.timer);
    this.map.delete(key);
  }
}

/** C0/C1 controls, zero-width and bidi controls, line separators, BOM (as code points). */
const INVISIBLE_RANGES: Array<[number, number]> = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x2069],
  [0xfeff, 0xfeff],
];
const INVISIBLE = new RegExp(
  `[${INVISIBLE_RANGES.map(([a, b]) => `\\u{${a.toString(16)}}-\\u{${b.toString(16)}}`).join('')}]`,
  'gu',
);

/** Third-party text as plain data: no control or bidi characters, one line, bounded. */
export function cleanText(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v
    .replace(INVISIBLE, ' ')
    .replace(/<[^>]{0,200}>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return undefined;
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}

/** An http(s) URL without credentials, or undefined. */
export function httpUrl(v: unknown, max = 600): string | undefined {
  if (typeof v !== 'string' || v.length > max) return undefined;
  try {
    const u = new URL(v.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    if (u.username || u.password) return undefined;
    return u.href;
  } catch {
    return undefined;
  }
}

export function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** A tool failure Claude can act on. */
export function failure(summary: string, errorKind: string): ToolOutput {
  return { summary, isError: true, errorKind };
}

/** UpstreamError -> a failure naming the source; anything else is rethrown. */
export function upstreamFailure(err: unknown, source: string): ToolOutput {
  if (!(err instanceof UpstreamError)) throw err;
  const kind: Record<UpstreamErrorKind, string> = {
    timeout: 'timeout',
    cancelled: 'timeout',
    unreachable: 'unavailable',
    http: 'upstream',
    auth: 'unavailable',
    rate_limited: 'retry_later',
    too_large: 'upstream',
    bad_response: 'upstream',
  };
  return failure(`${source}: ${err.message}.`, kind[err.kind]);
}

/** "OFF" answer for a tool whose key is missing: no request is made. */
export function notConfigured(tool: string, envVar: string, what: string): ToolOutput {
  return failure(
    `${tool} is not configured: set ${envVar} in deploy/secrets/gateway.env (${what}). Nothing was fetched.`,
    'unavailable',
  );
}

// ---------------------------------------------------------------------------------------
// Points: explicit lat/lon, or `here` (the latest phone fix)

export const pointFields = {
  lat: z
    .number()
    .min(-90)
    .max(90)
    .optional()
    .describe('Latitude (WGS84). Give lat and lon together, or here: true instead.'),
  lon: z.number().min(-180).max(180).optional().describe('Longitude (WGS84).'),
  here: z
    .boolean()
    .optional()
    .describe("true: use the user's latest phone location (as where_am_i) instead of lat/lon."),
};

export interface PointArgs {
  lat?: number;
  lon?: number;
  here?: boolean;
}

/** zod refinement: exactly one of {lat and lon} or here (or `place` when allowed). */
export function refinePoint(
  v: PointArgs & { place?: string },
  ctx: z.RefinementCtx,
  allowPlace = false,
): void {
  const hasLat = v.lat !== undefined;
  const hasLon = v.lon !== undefined;
  if (hasLat !== hasLon) {
    ctx.addIssue({ code: 'custom', message: 'give lat and lon together' });
    return;
  }
  const choices = [hasLat, v.here === true, allowPlace && v.place !== undefined].filter(Boolean);
  const options = allowPlace ? 'place, lat and lon, or here: true' : 'lat and lon, or here: true';
  if (choices.length === 0) ctx.addIssue({ code: 'custom', message: `give ${options}` });
  else if (choices.length > 1)
    ctx.addIssue({ code: 'custom', message: `give only one of ${options}` });
}

export interface PointDeps {
  config: Pick<Config, 'LOCATION_STALE_MINUTES' | 'LOCATION_RETENTION_HOURS' | 'privateOrigin'>;
  locations: LocationStore;
  audit?: Audit;
  tokens?: TokenStore;
  now: () => number;
}

export interface ResolvedPoint {
  lat: number;
  lon: number;
  fromPhone: boolean;
  /** "phone fix 2 min old" or "point given by the caller". */
  note: string;
}

/**
 * The point a call is about. `here` reads the latest phone fix, audited per grant like
 * where_am_i (never with coordinates); the caller never echoes the fix's coordinates.
 */
export function resolvePoint(
  deps: PointDeps,
  tool: string,
  args: PointArgs,
  ctx: ToolContext,
): { ok: true; point: ResolvedPoint } | { ok: false; output: ToolOutput } {
  if (args.here !== true) {
    if (args.lat === undefined || args.lon === undefined)
      return {
        ok: false,
        output: failure('Give lat and lon, or here: true.', 'invalid_arguments'),
      };
    return {
      ok: true,
      point: { lat: args.lat, lon: args.lon, fromPhone: false, note: 'point given by the caller' },
    };
  }
  const pos = currentPosition(deps.locations, deps.config.LOCATION_STALE_MINUTES, deps.now());
  deps.audit?.record('location_read', {
    clientId: ctx.clientId,
    subject: ctx.subject,
    detail: { family: ctx.familyId, tool, fix: pos !== undefined },
  });
  if (ctx.familyId) deps.tokens?.noteLocationRead(ctx.familyId);
  if (!pos)
    return {
      ok: false,
      output: failure(
        noFixMessage(deps.config.privateOrigin, deps.config.LOCATION_RETENTION_HOURS),
        'unavailable',
      ),
    };
  const acc = pos.accuracy_m === null ? '' : `, ±${pos.accuracy_m} m`;
  return {
    ok: true,
    point: {
      lat: pos.lat,
      lon: pos.lon,
      fromPhone: true,
      note: `phone fix ${humanAge(pos.age_s)} old${acc}${pos.stale ? ' (STALE: the phone may have moved)' : ''}`,
    },
  };
}

// ---------------------------------------------------------------------------------------
// Tool definitions from zod schemas

export interface CivicToolSpec<S extends z.ZodType> {
  name: string;
  title: string;
  description: string;
  schema: S;
  tags: string[];
  attribution: string;
  run(args: z.output<S>, ctx: ToolContext): Promise<ToolOutput>;
}

/**
 * A gateway tool whose input is a zod schema: the JSON Schema find_tools shows (and run_tool
 * checks with ajv) is generated from it, and run() parses with zod again, so refinements
 * (lat with lon, one point source) hold for every caller, composites included. Output always
 * counts as third-party text.
 */
export function civicTool<S extends z.ZodType>(spec: CivicToolSpec<S>): ToolDef {
  const json = z.toJSONSchema(spec.schema, { io: 'input' }) as JsonSchema;
  delete json.$schema;
  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    source: 'gateway',
    family: 'civic',
    inputSchema: json,
    tags: spec.tags,
    attribution: spec.attribution,
    untrustedText: true,
    async run(args, ctx) {
      const parsed = spec.schema.safeParse(args);
      if (!parsed.success) {
        const why = parsed.error.issues
          .slice(0, 5)
          .map((i) => `${i.path.length ? i.path.join('.') : '(arguments)'}: ${i.message}`)
          .join('; ');
        return failure(
          `Invalid arguments for ${spec.name}: ${why}. Fix them to match input_schema and call run_tool again.`,
          'invalid_arguments',
        );
      }
      return spec.run(parsed.data, ctx);
    },
  };
}
