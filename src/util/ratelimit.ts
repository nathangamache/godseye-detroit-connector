/**
 * In-memory sliding-window rate limiter. Single process, so memory is enough;
 * state resets on restart (acceptable: limits protect quotas, not secrets).
 */
export interface RateResult {
  ok: boolean;
  retryAfterMs: number;
  remaining: number;
}

export class RateLimiter {
  private hits = new Map<string, number[]>();
  private lastSweep = Date.now();

  constructor(private readonly now: () => number = Date.now) {}

  /** Records a hit if under the limit. */
  hit(key: string, limit: number, windowMs: number): RateResult {
    const r = this.peek(key, limit, windowMs);
    if (r.ok) {
      this.hits.get(key)!.push(this.now());
      r.remaining -= 1;
    }
    return r;
  }

  /** Checks without recording. */
  peek(key: string, limit: number, windowMs: number): RateResult {
    const t = this.now();
    this.sweep(t);
    let arr = this.hits.get(key);
    if (!arr) {
      arr = [];
      this.hits.set(key, arr);
    }
    while (arr.length && arr[0]! <= t - windowMs) arr.shift();
    if (arr.length >= limit) {
      return { ok: false, retryAfterMs: Math.max(1, arr[0]! + windowMs - t), remaining: 0 };
    }
    return { ok: true, retryAfterMs: 0, remaining: limit - arr.length };
  }

  /** Records a hit unconditionally (used after a multi-bucket check passed). */
  record(key: string): void {
    const arr = this.hits.get(key) ?? [];
    arr.push(this.now());
    this.hits.set(key, arr);
  }

  reset(key?: string): void {
    if (key) this.hits.delete(key);
    else this.hits.clear();
  }

  private sweep(t: number): void {
    if (t - this.lastSweep < 60_000) return;
    this.lastSweep = t;
    for (const [k, arr] of this.hits) {
      // Keys keep at most a day of history (the longest configured window).
      while (arr.length && arr[0]! <= t - 86_400_000) arr.shift();
      if (!arr.length) this.hits.delete(k);
    }
  }
}
