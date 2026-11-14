/** HTTP client for the Detroit Pulse API (docs/pulse-api-contract.md). */
export class PulseUnavailableError extends Error {}
export class PulseHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`Pulse returned HTTP ${status} (${code})`);
  }
}

export interface PulseClientOptions {
  baseUrl: string;
  token?: string;
  timeoutMs: number;
  maxBytes?: number;
}

export class PulseClient {
  constructor(private readonly opts: PulseClientOptions) {}

  async get<T = unknown>(
    pathname: string,
    query: Record<string, string | number | boolean | undefined> = {},
    signal?: AbortSignal,
  ): Promise<T> {
    const url = new URL(pathname, this.opts.baseUrl + '/');
    for (const [k, v] of Object.entries(query))
      if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    const timeout = AbortSignal.timeout(this.opts.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          accept: 'application/json',
          ...(this.opts.token ? { authorization: `Bearer ${this.opts.token}` } : {}),
        },
        redirect: 'error',
        signal: combined,
      });
    } catch (err) {
      const reason = timeout.aborted
        ? 'timed out'
        : (err as Error).name === 'AbortError'
          ? 'cancelled'
          : 'unreachable';
      throw new PulseUnavailableError(`Pulse is not running or not reachable (${reason})`);
    }
    const text = await readCapped(res, this.opts.maxBytes ?? 2 * 1024 * 1024);
    if (!res.ok) {
      let code = 'error';
      try {
        code = String(
          (JSON.parse(text) as { error?: { code?: string } }).error?.code ?? 'error',
        ).slice(0, 40);
      } catch {
        /* not JSON */
      }
      throw new PulseHttpError(res.status, code);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new PulseHttpError(res.status, 'invalid_json');
    }
  }
}

async function readCapped(res: Response, max: number): Promise<string> {
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
      throw new PulseHttpError(res.status, 'response_too_large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
