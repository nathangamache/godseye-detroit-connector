/**
 * Supervises the GEV stdio MCP child (gev/stdio-all-surfaces.mjs) through the
 * MCP v2 client. Restarts it with exponential backoff when it dies and
 * re-indexes the tool catalog after every (re)start.
 *
 * The child gets an explicit, minimal environment: StdioClientTransport would
 * otherwise pass only HOME/PATH/etc., and the gateway's own secrets must never
 * reach it.
 */
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { Logger } from '../log.js';

export interface UpstreamTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface UpstreamContent {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  [k: string]: unknown;
}

export interface UpstreamResult {
  content: UpstreamContent[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface GevChildOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  logger: Logger;
  /** Backoff bounds in ms. */
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

export type ChildState = 'stopped' | 'starting' | 'ready' | 'backoff';

export class GevChild extends EventEmitter {
  private client?: Client;
  private transport?: StdioClientTransport;
  private stopping = false;
  private backoffMs: number;
  private restartTimer?: NodeJS.Timeout;
  private readyAt = 0;
  state: ChildState = 'stopped';
  tools: UpstreamTool[] = [];
  lastError?: string;
  restarts = 0;

  constructor(private readonly opts: GevChildOptions) {
    super();
    this.backoffMs = opts.minBackoffMs ?? 1000;
  }

  async start(): Promise<void> {
    this.stopping = false;
    await this.spawn();
  }

  private async spawn(): Promise<void> {
    if (this.stopping) return;
    this.state = 'starting';
    const transport = new StdioClientTransport({
      command: this.opts.command,
      args: this.opts.args,
      cwd: this.opts.cwd,
      env: this.opts.env,
      stderr: 'pipe',
    });
    const client = new Client({ name: 'godseye-detroit-connector', version: '0.1.0' });
    this.transport = transport;
    this.client = client;
    transport.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim()) this.opts.logger.debug('gev_child_stderr', { line: line.slice(0, 300) });
      }
    });
    let closedEarly = false;
    transport.onclose = () => {
      closedEarly = true;
      if (this.client === client) this.onChildExit('closed');
    };
    transport.onerror = (err) => {
      this.lastError = err.message;
      this.opts.logger.warn('gev_child_transport_error', { error: err.message });
    };
    try {
      await client.connect(transport);
      const listed = await client.listTools(undefined, { timeout: 30_000 });
      if (closedEarly) return;
      this.tools = listed.tools.map((t) => ({
        name: t.name,
        title: t.title,
        description: t.description,
        inputSchema: t.inputSchema as Record<string, unknown>,
        annotations: t.annotations as Record<string, unknown> | undefined,
      }));
      this.state = 'ready';
      this.readyAt = Date.now();
      this.lastError = undefined;
      this.opts.logger.info('gev_child_ready', { tools: this.tools.length, pid: transport.pid });
      this.emit('catalog', this.tools);
    } catch (err) {
      this.lastError = (err as Error).message;
      this.opts.logger.warn('gev_child_start_failed', { error: this.lastError });
      await this.safeClose(client);
      if (this.client === client) this.onChildExit('start_failed');
    }
  }

  private onChildExit(reason: string): void {
    if (this.stopping) {
      this.state = 'stopped';
      return;
    }
    if (this.state === 'backoff') return;
    // A child that stayed up for a minute resets the backoff.
    if (this.readyAt && Date.now() - this.readyAt > 60_000)
      this.backoffMs = this.opts.minBackoffMs ?? 1000;
    this.state = 'backoff';
    this.client = undefined;
    this.transport = undefined;
    this.restarts++;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.opts.maxBackoffMs ?? 60_000);
    this.opts.logger.warn('gev_child_exit', {
      reason,
      restart_in_ms: delay,
      restarts: this.restarts,
    });
    this.emit('down');
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      void this.spawn();
    }, delay);
    this.restartTimer.unref();
  }

  isReady(): boolean {
    return this.state === 'ready' && Boolean(this.client);
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    opts: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<UpstreamResult> {
    const client = this.client;
    if (!client || this.state !== 'ready') {
      throw new GevUnavailableError(`GEV tools are not available right now (${this.state})`);
    }
    const result = await client.callTool(
      { name, arguments: args },
      { timeout: opts.timeoutMs, signal: opts.signal },
    );
    return result as unknown as UpstreamResult;
  }

  private async safeClose(client: Client): Promise<void> {
    try {
      await client.close();
    } catch {
      /* ignore */
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    const client = this.client;
    this.client = undefined;
    this.transport = undefined;
    this.state = 'stopped';
    if (client) await this.safeClose(client);
  }
}

export class GevUnavailableError extends Error {}

/** Builds the child's command line and minimal environment from config values. */
export function childSpawnSpec(opts: {
  gevRoot: string;
  gevUrl: string;
  wrapper: string;
  command?: string;
  extraArgs?: string;
}): { command: string; args: string[]; cwd: string; env: Record<string, string> } {
  const command = opts.command ?? process.execPath;
  const args = opts.extraArgs
    ? opts.extraArgs.split(' ').filter(Boolean)
    : [opts.wrapper, '--api-base', opts.gevUrl];
  return {
    command,
    args,
    cwd: opts.gevRoot,
    env: {
      GEV_ROOT: opts.gevRoot,
      PATH: `${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
      NODE_ENV: 'production',
      UV_THREADPOOL_SIZE: '2',
      NODE_OPTIONS: '--max-old-space-size=384',
    },
  };
}
