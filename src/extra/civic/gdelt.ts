/**
 * GDELT's limit, kept for the whole process. GDELT asks for at most one request every 5 seconds
 * per address, and God's Eye View's get_regional_brief also uses GDELT from this address. So every
 * gateway GDELT caller goes through one queue (gdeltQueue): a request starts only after the
 * previous one has finished and at least 6 s (plus up to 2 s of jitter) after it started; a call
 * the gateway passes to a GEV tool that may use GDELT counts as a start (noteGdeltUse); after a
 * refusal (429) nothing is sent for 60 s (longer if GDELT's Retry-After says so).
 */
import type { GevCaller } from '../../tools/registry.js';
import { UpstreamError } from './common.js';

/** Spacing between GDELT request starts: GDELT's 5 s rule plus a margin. */
export const GDELT_MIN_GAP_MS = 6_000;
/** Up to this much random extra spacing, so callers sharing the address do not stay in step. */
export const GDELT_JITTER_MS = 2_000;
/** After GDELT refuses a request, wait at least this long before the next one. */
export const GDELT_BACKOFF_MS = 60_000;
/** GDELT's own rule: one request every 5 s (what it asks when it sends no Retry-After). */
export const GDELT_RULE_S = 5;
/** A caller waits at most this long for its turn; past it the answer says when to try again. */
export const GDELT_MAX_WAIT_MS = 30_000;
/** GEV tools that may ask GDELT from this address (the regional brief's news fallback). */
export const GEV_GDELT_TOOLS: ReadonlySet<string> = new Set(['get_regional_brief']);

export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(new UpstreamError('cancelled', 'cancelled'));
      const t = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(t);
        reject(new UpstreamError('cancelled', 'cancelled'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
};

/**
 * Why a request was not sent: the upstream refused it, or the queue did not take it (paused after
 * a refusal, too many waiting, or the wait would be too long).
 */
export type RateLimitReason = 'refused' | 'paused' | 'crowded' | 'long_wait';

/** A refusal for rate reasons: why, and when to try again (seconds). */
export class RateLimitedError extends UpstreamError {
  constructor(
    message: string,
    readonly reason: RateLimitReason,
    /** When the gateway will next send a request (seconds from now). */
    readonly retryAfterS: number,
    /** What the upstream itself asked for (Retry-After, else its published rule), if it refused. */
    readonly upstreamAskedS?: number,
    status?: number,
  ) {
    super('rate_limited', message, status);
  }
}

/**
 * Serial queue for one upstream: a job starts only after the previous job finished and at
 * least `gapMs` (plus jitter) after the previous start, after any back-off, and after any start
 * noted from outside. Jobs that would wait longer than `maxWaitMs`, or find `maxPending` jobs
 * ahead, are refused (RateLimitedError, with when to try again) instead of queued.
 */
export class SpacedQueue {
  private tail: Promise<void> = Promise.resolve();
  private lastStart = -Infinity;
  private blockedUntil = -Infinity;
  private pending = 0;
  private gap: number;

  constructor(
    readonly gapMs: number,
    private readonly opts: {
      maxPending: number;
      maxWaitMs: number;
      clock: Clock;
      jitterMs?: number;
      random?: () => number;
    },
  ) {
    this.gap = this.drawGap();
  }

  now(): number {
    return this.opts.clock.now();
  }

  private jitter(): number {
    const j = this.opts.jitterMs ?? 0;
    return j > 0 ? Math.floor((this.opts.random ?? Math.random)() * j) : 0;
  }

  private drawGap(): number {
    return this.gapMs + this.jitter();
  }

  /** Push the next start out (e.g. after a 429), by `ms` plus jitter. */
  backOff(ms: number): void {
    this.blockedUntil = Math.max(this.blockedUntil, this.now() + ms + this.jitter());
  }

  /** A request made to the same upstream outside this queue: the next start keeps its spacing. */
  noteStart(): void {
    this.lastStart = Math.max(this.lastStart, this.now());
    this.gap = this.drawGap();
  }

  /** Earliest time a new job could start if the queue were empty. */
  private nextStart(): number {
    return Math.max(this.lastStart + this.gap, this.blockedUntil);
  }

  /** How long a job queued now would wait for its start (ms). */
  waitMs(): number {
    return Math.max(0, this.nextStart() + this.pending * this.gapMs - this.now());
  }

  /** How long until the next start is allowed, whoever is waiting (ms). */
  nextStartInMs(): number {
    return Math.max(0, this.nextStart() - this.now());
  }

  /** Whether a back-off (after a refusal) is still running. */
  backedOff(): boolean {
    return this.blockedUntil > this.now();
  }

  private refusal(waitMs: number, crowded = false): RateLimitedError {
    const s = Math.max(1, Math.ceil(waitMs / 1000));
    if (this.backedOff())
      return new RateLimitedError('requests are paused after a refusal', 'paused', s);
    if (crowded)
      return new RateLimitedError('too many requests are waiting for their turn', 'crowded', s);
    return new RateLimitedError('the wait for a turn is too long', 'long_wait', s);
  }

  run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const { clock, maxPending, maxWaitMs } = this.opts;
    if (this.pending >= maxPending) return Promise.reject(this.refusal(this.waitMs(), true));
    const estimate = this.waitMs();
    if (estimate > maxWaitMs) return Promise.reject(this.refusal(estimate));
    this.pending++;
    const job = this.tail.then(async () => {
      try {
        const wait = this.nextStart() - clock.now();
        if (wait > maxWaitMs) throw this.refusal(wait);
        if (wait > 0) await clock.sleep(wait, signal);
        if (signal?.aborted) throw new UpstreamError('cancelled', 'cancelled');
        this.lastStart = clock.now();
        this.gap = this.drawGap();
        return await fn();
      } finally {
        this.pending--;
      }
    });
    this.tail = job.then(
      () => undefined,
      () => undefined,
    );
    return job;
  }
}

/** A queue with GDELT's spacing, jitter and limits (tests pass their own clock and dice). */
export function newGdeltQueue(clock: Clock = realClock, random?: () => number): SpacedQueue {
  return new SpacedQueue(GDELT_MIN_GAP_MS, {
    maxPending: 4,
    maxWaitMs: GDELT_MAX_WAIT_MS,
    clock,
    jitterMs: GDELT_JITTER_MS,
    ...(random ? { random } : {}),
  });
}

/** The process-wide GDELT queue: every gateway GDELT caller shares it. */
export const gdeltQueue = newGdeltQueue();

/** Retry-After in seconds (delta-seconds or an HTTP date), bounded; undefined if absent. */
export function retryAfterSeconds(v: string | null | undefined, now: number): number | undefined {
  const t = v?.trim();
  if (!t) return undefined;
  const bound = (s: number) => Math.min(3600, Math.max(1, Math.ceil(s)));
  if (/^\d+$/.test(t)) return bound(Number(t));
  const at = Date.parse(t);
  return Number.isFinite(at) ? bound((at - now) / 1000) : undefined;
}

/** GDELT's refusal text names its rule ("limit requests to one every 5 seconds"). */
export function gdeltRuleSeconds(text: string): number | undefined {
  const m = /one every (\d{1,3}) seconds?/i.exec(text.slice(0, 300));
  return m ? Math.max(1, Number(m[1])) : undefined;
}

/**
 * A GEV caller that notes, on the shared GDELT queue, each call to a GEV tool that may ask GDELT
 * from this address, so the gateway's own GDELT requests keep their spacing after it. The GEV call
 * itself is not delayed.
 */
export function withGdeltNote(call: GevCaller, queue: SpacedQueue = gdeltQueue): GevCaller {
  return (name, args, ctx) => {
    if (GEV_GDELT_TOOLS.has(name)) queue.noteStart();
    return call(name, args, ctx);
  };
}
