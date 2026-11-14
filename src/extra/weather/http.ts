/**
 * Outbound HTTP for the weather, water and air tools: https only, a fixed host allowlist per
 * service, a generic User-Agent (no personal data), a timeout per attempt, a size cap, polite
 * retries on 5xx (and once on 429), no redirects. Error messages never contain the URL, so an
 * API key in a query string can't leak into a result or a log line.
 */

/** Self-describing, carries nothing about the user. */
export const USER_AGENT = '(godseye-personal-connector)';

export type UpstreamErrorKind =
  | 'http'
  | 'rate_limited'
  | 'timeout'
  | 'cancelled'
  | 'unreachable'
  | 'too_large'
  | 'invalid_json'
  | 'blocked_host';

export class UpstreamError extends Error {
  constructor(
    readonly service: string,
    readonly kind: UpstreamErrorKind,
    readonly status = 0,
    /** Parsed error body (JSON), when the upstream sent one. */
    readonly body?: unknown,
  ) {
    super(describe(service, kind, status));
  }
}

function describe(service: string, kind: UpstreamErrorKind, status: number): string {
  switch (kind) {
    case 'http':
      return `${service} returned HTTP ${status}`;
    case 'rate_limited':
      return `${service} is rate limiting requests (HTTP ${status || 429})`;
    case 'timeout':
      return `${service} did not answer in time`;
    case 'cancelled':
      return `the request to ${service} was cancelled`;
    case 'unreachable':
      return `${service} is not reachable right now`;
    case 'too_large':
      return `${service} sent a response larger than this connector accepts`;
    case 'invalid_json':
      return `${service} sent a response that is not valid JSON`;
    case 'blocked_host':
      return `refused to contact a host that is not on the ${service} allowlist`;
  }
}

export type FetchLike = (input: URL, init: RequestInit) => Promise<Response>;

export interface HttpOptions {
  fetchImpl?: FetchLike;
  timeoutMs: number;
  /** Waits between attempts after a 5xx or a network error (one entry per retry). */
  retryDelaysMs?: number[];
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface RequestSpec {
  service: string;
  allowedHosts: readonly string[];
  headers?: Record<string, string>;
  signal?: AbortSignal;
  maxBytes?: number;
  /** Retry 5xx and network errors (default true). */
  retry?: boolean;
}

export interface JsonResult<T> {
  body: T;
  status: number;
  /** Cache-Control max-age in seconds, when given. */
  maxAgeS?: number;
}

const RETRY_STATUS = new Set([500, 502, 503, 504]);
/** The longest Retry-After this client honours; longer means "come back later". */
const MAX_RETRY_AFTER_MS = 5_000;

export const sleepAbortable = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (ms <= 0) return resolve();
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export class HttpClient {
  private readonly fetchImpl: FetchLike;
  private readonly delays: number[];
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(private readonly opts: HttpOptions) {
    this.fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
    this.delays = opts.retryDelaysMs ?? [1_000, 3_000];
    this.sleep = opts.sleep ?? sleepAbortable;
  }

  async getJson<T = unknown>(url: URL, spec: RequestSpec): Promise<JsonResult<T>> {
    if (url.protocol !== 'https:' || !spec.allowedHosts.includes(url.hostname))
      throw new UpstreamError(spec.service, 'blocked_host');
    const retries = spec.retry === false ? 0 : this.delays.length;
    let rateRetried = false;
    for (let attempt = 0; ; attempt++) {
      const timeout = AbortSignal.timeout(this.opts.timeoutMs);
      const signal = spec.signal ? AbortSignal.any([spec.signal, timeout]) : timeout;
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: 'GET',
          headers: { 'user-agent': USER_AGENT, accept: 'application/json', ...spec.headers },
          redirect: 'manual',
          signal,
        });
      } catch {
        if (spec.signal?.aborted) throw new UpstreamError(spec.service, 'cancelled');
        const kind = timeout.aborted ? 'timeout' : 'unreachable';
        if (attempt < retries) {
          await this.wait(this.delays[attempt] ?? 0, spec);
          continue;
        }
        throw new UpstreamError(spec.service, kind);
      }
      if (RETRY_STATUS.has(res.status) && attempt < retries) {
        await discard(res);
        await this.wait(retryAfterMs(res) ?? this.delays[attempt] ?? 0, spec);
        continue;
      }
      if (res.status === 429 && !rateRetried && spec.retry !== false) {
        const after = retryAfterMs(res) ?? MAX_RETRY_AFTER_MS;
        await discard(res);
        if (after > MAX_RETRY_AFTER_MS) throw new UpstreamError(spec.service, 'rate_limited', 429);
        rateRetried = true;
        await this.wait(after, spec);
        continue;
      }
      const text = await readCapped(res, spec.maxBytes ?? 2 * 1024 * 1024, spec.service);
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        if (!res.ok) throw new UpstreamError(spec.service, httpKind(res.status), res.status);
        throw new UpstreamError(spec.service, 'invalid_json', res.status);
      }
      if (!res.ok) throw new UpstreamError(spec.service, httpKind(res.status), res.status, body);
      return { body: body as T, status: res.status, maxAgeS: maxAge(res) };
    }
  }

  private async wait(ms: number, spec: RequestSpec): Promise<void> {
    try {
      await this.sleep(Math.min(ms, MAX_RETRY_AFTER_MS), spec.signal);
    } catch {
      throw new UpstreamError(spec.service, 'cancelled');
    }
  }
}

const httpKind = (status: number): UpstreamErrorKind => (status === 429 ? 'rate_limited' : 'http');

function retryAfterMs(res: Response): number | undefined {
  const v = res.headers.get('retry-after');
  if (!v) return undefined;
  const s = Number(v);
  if (Number.isFinite(s) && s >= 0) return s * 1000;
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

function maxAge(res: Response): number | undefined {
  const m = /(?:^|,)\s*max-age=(\d+)/i.exec(res.headers.get('cache-control') ?? '');
  return m ? Number(m[1]) : undefined;
}

async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    /* already closed */
  }
}

async function readCapped(res: Response, max: number, service: string): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    let r: Awaited<ReturnType<typeof reader.read>>;
    try {
      r = await reader.read();
    } catch {
      throw new UpstreamError(service, 'unreachable', res.status);
    }
    if (r.done) break;
    n += r.value.byteLength;
    if (n > max) {
      await reader.cancel().catch(() => undefined);
      throw new UpstreamError(service, 'too_large', res.status);
    }
    chunks.push(r.value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
