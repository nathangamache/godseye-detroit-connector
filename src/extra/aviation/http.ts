/**
 * Outbound HTTP for the aviation tools: a timeout on every request, a generic self-describing
 * User-Agent (nothing about the user), no redirects, and capped response bodies. Failures are
 * classified so callers can tell "try the fallback" (timeout, 5xx, 429) from "never retry"
 * (other 4xx).
 */

/** Sent to adsb.fi and adsb.lol. Generic on purpose: no name, domain or contact. */
export const LIVE_USER_AGENT = 'personal-aircraft-lookup/1.0 (non-commercial)';
/** Sent to registry.faa.gov: honest and generic, never a browser string. */
export const REGISTRY_USER_AGENT = 'aircraft-registry-sync/1.0';

export type FetchFn = typeof fetch;

export class HttpError extends Error {
  constructor(
    readonly kind: 'timeout' | 'network' | 'status' | 'too_large' | 'bad_json' | 'cancelled',
    message: string,
    readonly status?: number,
    /** Seconds from a Retry-After header, when one was sent. */
    readonly retryAfterS?: number,
  ) {
    super(message);
  }

  /** Worth trying a fallback source: no answer, a server error or a rate limit. */
  get transient(): boolean {
    return (
      this.kind === 'timeout' ||
      this.kind === 'network' ||
      (this.kind === 'status' && (this.status === 429 || (this.status ?? 0) >= 500))
    );
  }
}

/** Retry-After in seconds (delta-seconds or an HTTP date), capped at a day. */
export function retryAfterSeconds(v: string | null, now = Date.now()): number | undefined {
  if (!v) return undefined;
  const s = v.trim();
  if (/^\d{1,9}$/.test(s)) return Math.min(86_400, Number(s));
  const t = Date.parse(s);
  if (Number.isNaN(t)) return undefined;
  return Math.min(86_400, Math.max(0, Math.ceil((t - now) / 1000)));
}

export interface GetJsonOptions {
  fetch?: FetchFn;
  timeoutMs: number;
  maxBytes: number;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  userAgent?: string;
}

/** GET a JSON document. Throws HttpError on anything but a 2xx with valid JSON. */
export async function getJson(url: string, o: GetJsonOptions): Promise<unknown> {
  const timeout = AbortSignal.timeout(o.timeoutMs);
  const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await (o.fetch ?? fetch)(url, {
      headers: {
        accept: 'application/json',
        'user-agent': o.userAgent ?? LIVE_USER_AGENT,
        ...o.headers,
      },
      redirect: 'error',
      signal,
    });
  } catch (err) {
    if (timeout.aborted) throw new HttpError('timeout', 'timed out');
    if (o.signal?.aborted) throw new HttpError('cancelled', 'cancelled');
    throw new HttpError('network', `unreachable (${(err as Error).name})`);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new HttpError(
      'status',
      `HTTP ${res.status}`,
      res.status,
      retryAfterSeconds(res.headers.get('retry-after')),
    );
  }
  let text: string;
  try {
    text = await readCapped(res, o.maxBytes);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (timeout.aborted) throw new HttpError('timeout', 'timed out while reading');
    throw new HttpError('network', 'connection lost while reading');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError('bad_json', 'response was not JSON');
  }
}

export async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError('too_large', `response larger than ${max} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Third-party text as plain data: control and bidi characters removed, whitespace collapsed,
 * length capped. Undefined for anything that is not a non-empty string.
 */
export function cleanText(v: unknown, max: number, allowed?: RegExp): string | undefined {
  if (typeof v !== 'string') return undefined;
  let s = v
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (allowed) s = s.replace(allowed, '');
  s = s.slice(0, max).trim();
  return s ? s : undefined;
}

export const finite = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/** Sleeps, rejecting early (with the signal's reason) when the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new HttpError('cancelled', 'cancelled'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new HttpError('cancelled', 'cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
