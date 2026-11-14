/** Counting semaphore with a bounded wait, used to cap concurrent tool calls. */
export class Semaphore {
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  get inUse(): number {
    return this.active;
  }

  async acquire(waitMs: number, signal?: AbortSignal): Promise<() => void> {
    if (this.active < this.max) {
      this.active++;
      return this.releaser();
    }
    return new Promise((resolve, reject) => {
      const grant = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.active++;
        resolve(this.releaser());
      };
      const drop = () => {
        const i = this.queue.indexOf(grant);
        if (i >= 0) this.queue.splice(i, 1);
      };
      const timer = setTimeout(() => {
        drop();
        reject(new BusyError('too many tool calls in progress; try again shortly'));
      }, waitMs);
      const onAbort = () => {
        clearTimeout(timer);
        drop();
        reject(new BusyError('cancelled while waiting for a tool slot'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push(grant);
    });
  }

  private releaser(): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    };
  }
}

export class BusyError extends Error {}
