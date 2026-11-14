/**
 * In-memory sliding-window rate limiter. Single process, so memory is enough;
 * state resets on restart (acceptable: limits protect quotas, not secrets).
 *
 * Memory is bounded (review bp-2): every key remembers its own window and is dropped as
 * soon as its newest hit is older than that window (not after a fixed day), and the number
 * of keys is capped (least recently hit evicted first). Callers key IPv6 clients by /64
 * (util/net.ts rateKeyIp) so address rotation inside one prefix does not mint new keys.
 */
export interface RateResult {
  ok: boolean;
  retryAfterMs: number;
  remaining: number;
}

interface Entry {
  hits: number[];
  windowMs: number;
}

export interface RateLimiterOptions {
  /** Maximum number of tracked keys (default 50 000). */
  maxKeys?: number;
  /** How often expired keys are swept (default 30 s). */
  sweepEveryMs?: number;
}

export class RateLimiter {
  private entries = new Map<string, Entry>();
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

  /** Number of tracked keys (tests, metrics). */
  get size(): number {
    return this.entries.size;
  }

  /** Records a hit if under the limit. */
  hit(key: string, limit: number, windowMs: number): RateResult {
    const r = this.peek(key, limit, windowMs);
    if (r.ok) {
      this.push(key, windowMs);
      r.remaining -= 1;
    }
    return r;
  }

  /** Checks without recording (and without creating a key). */
  peek(key: string, limit: number, windowMs: number): RateResult {
    const t = this.now();
    this.sweep(t);
    const e = this.entries.get(key);
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
  record(key: string, windowMs: number): void {
    this.sweep(this.now());
    this.push(key, windowMs);
  }

  reset(key?: string): void {
    if (key) this.entries.delete(key);
    else this.entries.clear();
  }

  private push(key: string, windowMs: number): void {
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
    for (const [k, e] of this.entries) {
      const arr = e.hits;
      while (arr.length && arr[0]! <= t - e.windowMs) arr.shift();
      if (!arr.length) this.entries.delete(k);
    }
  }
}
