/**
 * Outbound HTTP for the roads tools, plus the small pieces every source needs: a short
 * in-memory cache with in-flight sharing, a global request pacer (1 req/s services), and
 * file-backed state in the gateway data volume (daily caps that survive a restart, the
 * geocoder's disk cache).
 *
 * Errors never carry the request URL (keys travel in query strings) or the response body.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface HttpOptions {
  userAgent: string;
  timeoutMs: number;
  fetch?: FetchLike;
}

export interface RequestOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  accept?: string;
  /** Response size cap (default 2 MB). */
  maxBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class Http {
  constructor(private readonly o: HttpOptions) {}

  async text(label: string, url: string | URL, init: RequestOptions = {}): Promise<string> {
    const timeout = AbortSignal.timeout(init.timeoutMs ?? this.o.timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await (this.o.fetch ?? fetch)(url, {
        method: init.method ?? 'GET',
        headers: {
          'user-agent': this.o.userAgent,
          accept: init.accept ?? 'application/json',
          ...(init.headers ?? {}),
        },
        body: init.body,
        redirect: 'error',
        signal,
      });
    } catch (err) {
      const why = timeout.aborted
        ? 'timed out'
        : (err as Error)?.name === 'AbortError'
          ? 'cancelled'
          : 'unreachable';
      throw new HttpError(0, `${label} ${why}`);
    }
    const text = await readCapped(res, init.maxBytes ?? 2 * 1024 * 1024, label);
    if (!res.ok) throw new HttpError(res.status, `${label} returned HTTP ${res.status}`);
    return text;
  }

  async json<T = unknown>(label: string, url: string | URL, init: RequestOptions = {}): Promise<T> {
    const text = await this.text(label, url, init);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new HttpError(200, `${label} returned invalid JSON`);
    }
  }
}

async function readCapped(res: Response, max: number, label: string): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel();
      throw new HttpError(res.status, `${label} response too large`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The message of an error that is safe to show (HttpError text, never a URL or stack). */
export function errorText(err: unknown): string {
  if (err instanceof HttpError) return err.message;
  const m = err instanceof Error ? err.message : String(err);
  return m
    .replace(/https?:\/\/\S+/g, '[url]')
    .replace(/\s+/g, ' ')
    .slice(0, 200);
}

/**
 * Short in-memory cache for whole upstream answers (a provincial or statewide list), shared by
 * concurrent callers so one cold cache costs one request. Failures are remembered briefly
 * (failMs) so an outage is not retried on every call.
 */
export class TtlCache<T> {
  private entries = new Map<string, { at: number; p: Promise<T>; failed?: boolean }>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
    private readonly failMs = 30_000,
    private readonly maxEntries = 64,
  ) {}

  async get(key: string, load: () => Promise<T>): Promise<{ value: T; ageMs: number }> {
    const t = this.now();
    const hit = this.entries.get(key);
    if (hit && t - hit.at <= (hit.failed ? this.failMs : this.ttlMs)) {
      return { value: await hit.p, ageMs: t - hit.at };
    }
    const entry: { at: number; p: Promise<T>; failed?: boolean } = { at: t, p: load() };
    entry.p.catch(() => {
      entry.failed = true;
    });
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.maxEntries)
      this.entries.delete(this.entries.keys().next().value as string);
    return { value: await entry.p, ageMs: 0 };
  }
}

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export const sleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('cancelled'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error('cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/**
 * Global spacing between request starts (FOSSGIS Valhalla and public Nominatim allow one
 * request per second, from every caller together).
 */
export class Pacer {
  private next = 0;

  constructor(
    private readonly intervalMs: number,
    private readonly now: () => number = Date.now,
    private readonly sleepFn: Sleep = sleep,
  ) {}

  async wait(signal?: AbortSignal): Promise<void> {
    const t = this.now();
    const at = Math.max(t, this.next);
    this.next = at + this.intervalMs;
    if (at > t) await this.sleepFn(at - t, signal);
  }
}

/** Local calendar date (America/Detroit) for "per day" caps. */
export function localDay(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Detroit',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

/** Writes a small file atomically, mode 600, in a mode-700 directory. */
function writePrivate(file: string, data: string): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, file);
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * A hard daily cap that survives restarts (TomTom incidents, public Nominatim). Calls are
 * counted before they are made, so a crash never under-counts. Only the date and a count are
 * stored: never a query or a result.
 */
export class DailyCounter {
  private state: { day: string; count: number } | undefined;

  constructor(
    private readonly file: string,
    readonly max: number,
    private readonly now: () => number = Date.now,
    private readonly onWriteError?: (err: unknown) => void,
  ) {}

  private load(): { day: string; count: number } {
    const today = localDay(this.now());
    if (!this.state) {
      const j = readJson(this.file) as { day?: unknown; count?: unknown } | undefined;
      this.state =
        j && typeof j.day === 'string' && typeof j.count === 'number'
          ? { day: j.day, count: j.count }
          : { day: today, count: 0 };
    }
    if (this.state.day !== today) this.state = { day: today, count: 0 };
    return this.state;
  }

  used(): number {
    return this.load().count;
  }

  remaining(): number {
    return Math.max(0, this.max - this.load().count);
  }

  /** Takes one call from today's budget; false when it is spent. */
  take(): boolean {
    const s = this.load();
    if (s.count >= this.max) return false;
    s.count++;
    try {
      writePrivate(this.file, JSON.stringify(s));
    } catch (err) {
      this.onWriteError?.(err);
    }
    return true;
  }
}

interface DiskEntry<T> {
  v: T;
  exp: number;
}

/**
 * A small JSON cache on disk (the gateway data volume). Entries expire; the oldest are dropped
 * past maxEntries. A missing or unreadable file starts empty; write errors keep the memory copy.
 */
export class DiskCache<T> {
  private map: Map<string, DiskEntry<T>> | undefined;

  constructor(
    private readonly file: string,
    private readonly opts: { maxEntries: number; now?: () => number },
    private readonly onWriteError?: (err: unknown) => void,
  ) {}

  private get nowMs(): number {
    return (this.opts.now ?? Date.now)();
  }

  private load(): Map<string, DiskEntry<T>> {
    if (this.map) return this.map;
    this.map = new Map();
    const j = readJson(this.file);
    if (j && typeof j === 'object' && !Array.isArray(j)) {
      const t = this.nowMs;
      for (const [k, e] of Object.entries(j as Record<string, DiskEntry<T>>)) {
        if (e && typeof e === 'object' && typeof e.exp === 'number' && e.exp > t)
          this.map.set(k, e);
      }
    }
    return this.map;
  }

  get(key: string): T | undefined {
    const m = this.load();
    const e = m.get(key);
    if (!e) return undefined;
    if (e.exp <= this.nowMs) {
      m.delete(key);
      return undefined;
    }
    return e.v;
  }

  set(key: string, value: T, ttlMs: number): void {
    const m = this.load();
    m.delete(key);
    m.set(key, { v: value, exp: this.nowMs + ttlMs });
    while (m.size > this.opts.maxEntries) m.delete(m.keys().next().value as string);
    try {
      writePrivate(this.file, JSON.stringify(Object.fromEntries(m)));
    } catch (err) {
      this.onWriteError?.(err);
    }
  }
}
