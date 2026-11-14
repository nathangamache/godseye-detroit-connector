/**
 * In-memory sliding-window rate limiter. Single process, so memory is enough;
 * state resets on restart (acceptable: limits protect quotas, not secrets).
 *
 * Memory is bounded (review bp-2): every key remembers its own window and is dropped as
 * soon as its newest hit is older than that window (not after a fixed day), and the number
 * of per-client keys is capped (least recently hit evicted first). Callers key IPv6 clients
 * by /64 (util/net.ts rateKeyIp) so address rotation inside one prefix does not mint new keys.
 *
 * Global budgets (one key shared by every client: failed token requests, registrations, tool
 * quotas) live in a separate map that the cap never touches: otherwise churning through
 * per-client keys would evict them and reset the budget (review OA-6). They still expire with
 * their window. Mark them with { global: true }.
 */
export interface RateResult {
  ok: boolean;
  retryAfterMs: number;
  remaining: number;
}

export interface HitOptions {
  /** A global budget (same key for every client): never evicted by the per-client key cap. */
  global?: boolean;
}

interface Entry {
  hits: number[];
  windowMs: number;
}

export interface RateLimiterOptions {
  /** Maximum number of tracked per-client keys (default 50 000). */
  maxKeys?: number;
  /** How often expired keys are swept (default 30 s). */
  sweepEveryMs?: number;
}

/**
 * Global keys are a fixed set named in code; more than this means a per-client key was
 * marked global by mistake, which would make memory unbounded again.
 */
export const MAX_GLOBAL_KEYS = 256;

export class RateLimiter {
  private entries = new Map<string, Entry>();
  private globals = new Map<string, Entry>();
  private lastSweep: number;
  private readonly maxKeys: number;
  private readonly sweepEveryMs: number;

  constructor(
    private readonly now: () => number = Date.now,
    opts: RateLimiterOptions = {},
  ) {
    this.maxKeys = opts.maxKeys ?? 50_000;
    this.sweepEveryMs = opts.sweepEveryMs ?? 30_000;
    this.lastSweep = now();
  }

  /** Number of tracked keys, global budgets included (tests, metrics). */
  get size(): number {
    return this.entries.size + this.globals.size;
  }

  /** Records a hit if under the limit. */
  hit(key: string, limit: number, windowMs: number, opts: HitOptions = {}): RateResult {
    const r = this.peek(key, limit, windowMs);
    if (r.ok) {
      this.push(key, windowMs, opts.global === true);
      r.remaining -= 1;
    }
    return r;
  }

  /** Checks without recording (and without creating a key). */
  peek(key: string, limit: number, windowMs: number): RateResult {
    const t = this.now();
    this.sweep(t);
    const e = this.globals.get(key) ?? this.entries.get(key);
    if (!e) return { ok: limit > 0, retryAfterMs: limit > 0 ? 0 : windowMs, remaining: limit };
    e.windowMs = Math.max(e.windowMs, windowMs);
    const arr = e.hits;
    while (arr.length && arr[0]! <= t - windowMs) arr.shift();
    if (arr.length >= limit) {
      return { ok: false, retryAfterMs: Math.max(1, arr[0]! + windowMs - t), remaining: 0 };
    }
    return { ok: true, retryAfterMs: 0, remaining: limit - arr.length };
  }

  /** Records a hit unconditionally (used after a multi-bucket check passed). */
  record(key: string, windowMs: number, opts: HitOptions = {}): void {
    this.sweep(this.now());
    this.push(key, windowMs, opts.global === true);
  }

  reset(key?: string): void {
    if (key) {
      this.entries.delete(key);
      this.globals.delete(key);
    } else {
      this.entries.clear();
      this.globals.clear();
    }
  }

  private push(key: string, windowMs: number, global: boolean): void {
    let g = this.globals.get(key);
    if (g || global) {
      if (!g) {
        if (this.globals.size >= MAX_GLOBAL_KEYS)
          throw new Error(
            `rate limiter: more than ${MAX_GLOBAL_KEYS} global keys (a per-client key marked global?)`,
          );
        g = this.entries.get(key) ?? { hits: [], windowMs };
        this.entries.delete(key);
        this.globals.set(key, g);
      }
      g.windowMs = Math.max(g.windowMs, windowMs);
      g.hits.push(this.now());
      return;
    }
    let e = this.entries.get(key);
    if (e) {
      // Most recently used last: Map iteration order doubles as the LRU list.
      this.entries.delete(key);
      e.windowMs = Math.max(e.windowMs, windowMs);
    } else {
      e = { hits: [], windowMs };
    }
    e.hits.push(this.now());
    this.entries.set(key, e);
    while (this.entries.size > this.maxKeys) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }

  private sweep(t: number): void {
    if (t - this.lastSweep < this.sweepEveryMs) return;
    this.lastSweep = t;
    for (const map of [this.entries, this.globals]) {
      for (const [k, e] of map) {
        const arr = e.hits;
        while (arr.length && arr[0]! <= t - e.windowMs) arr.shift();
        if (!arr.length) map.delete(k);
      }
    }
  }
}
