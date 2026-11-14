/**
 * run_tool pipeline: lookup -> policy -> schema validation -> argument rules ->
 * rate limits -> concurrency slot -> timeout-bounded call -> post-processing.
 */
import type { Logger } from '../log.js';
import { BusyError, Semaphore } from '../util/semaphore.js';
import { postprocess, type McpToolResult, type PostprocessOptions } from './postprocess.js';
import type { ToolRegistry } from './registry.js';
import type { ToolContext, ToolDef, ToolOutput } from './types.js';
import { SchemaValidator } from './validate.js';

export interface RunnerOptions {
  timeoutMs: number;
  maxConcurrent: number;
  /** How long a call may wait for a free slot. */
  queueWaitMs?: number;
  post: PostprocessOptions;
  logger: Logger;
}

export class ToolRunner {
  private readonly validator = new SchemaValidator();
  private readonly slots: Semaphore;

  constructor(
    readonly registry: ToolRegistry,
    private readonly opts: RunnerOptions,
  ) {
    this.slots = new Semaphore(opts.maxConcurrent);
  }

  get postOptions(): PostprocessOptions {
    return this.opts.post;
  }

  /** Error result in the same shape Claude sees for tool failures. */
  static error(text: string, extra?: Record<string, unknown>): McpToolResult {
    const content: McpToolResult['content'] = [{ type: 'text', text }];
    if (extra) content.push({ type: 'text', text: JSON.stringify(extra) });
    return { content, isError: true };
  }

  async run(name: string, args: unknown, ctx: ToolContext): Promise<McpToolResult> {
    const t0 = Date.now();
    const def = this.registry.get(name);
    const denied = def ? null : this.registry.policy.deniedReason(name);
    if (denied) return ToolRunner.error(`Tool "${name}" is not available: ${denied}.`);
    if (!def) {
      const hits = this.registry.find(name.replace(/_/g, ' '), 3).map((h) => h.tool.name);
      const gevNote = this.registry.hasGev() ? '' : " God's Eye View tools are offline right now.";
      return ToolRunner.error(
        `Unknown tool "${name}".${gevNote} Call find_tools first to discover tool names.` +
          (hits.length ? ` Similar: ${hits.join(', ')}.` : ''),
      );
    }
    const verdict = this.registry.policy.evaluate(def);
    if (!verdict.allowed) {
      this.log(def, t0, 'denied', ctx);
      return ToolRunner.error(`Tool "${name}" is not available: ${verdict.reason}.`);
    }
    const argObj = args === undefined || args === null ? {} : args;
    if (typeof argObj !== 'object' || Array.isArray(argObj)) {
      return ToolRunner.error('arguments must be a JSON object.', {
        input_schema: def.inputSchema,
      });
    }
    const a = argObj as Record<string, unknown>;
    const v = this.validator.validate(def.name, def.inputSchema, a);
    if (!v.ok) {
      this.log(def, t0, 'invalid_arguments', ctx);
      return ToolRunner.error(
        `Invalid arguments for ${name}: ${v.errors.join('; ')}. Fix the arguments to match input_schema and call run_tool again.`,
        { input_schema: def.inputSchema },
      );
    }
    const argError = this.registry.policy.checkArguments(def, a);
    if (argError) return ToolRunner.error(argError, { input_schema: def.inputSchema });

    const rate = this.registry.policy.consumeRate(this.registry.policy.bucketsFor(def, a));
    if (!rate.ok) {
      this.log(def, t0, 'rate_limited', ctx);
      return ToolRunner.error(
        `Rate limit reached for ${rate.bucket} (protects a free-tier quota). Try again in about ${rate.retryAfterS} s.`,
      );
    }

    let release: (() => void) | undefined;
    try {
      release = await this.slots.acquire(this.opts.queueWaitMs ?? 15_000, ctx.signal);
    } catch (err) {
      if (err instanceof BusyError) return ToolRunner.error(err.message);
      throw err;
    }
    try {
      const output = await this.callWithTimeout(def, a, ctx);
      const result = await postprocess(def, output, this.opts.post);
      this.log(def, t0, output.isError ? `tool_error:${output.errorKind ?? 'error'}` : 'ok', ctx);
      return result;
    } finally {
      release();
    }
  }

  /** Runs fn while holding one concurrency slot (composite tools count as one call). */
  async withSlot(signal: AbortSignal, fn: () => Promise<McpToolResult>): Promise<McpToolResult> {
    let release: () => void;
    try {
      release = await this.slots.acquire(this.opts.queueWaitMs ?? 15_000, signal);
    } catch (err) {
      if (err instanceof BusyError) return ToolRunner.error(err.message);
      throw err;
    }
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** Runs a tool without policy/validation (internal composites such as whats_happening_here). */
  async callRaw(
    def: ToolDef,
    args: Record<string, unknown>,
    ctx: ToolContext,
    timeoutMs: number,
  ): Promise<ToolOutput> {
    return this.callWithTimeout(def, args, ctx, timeoutMs);
  }

  private async callWithTimeout(
    def: ToolDef,
    args: Record<string, unknown>,
    ctx: ToolContext,
    timeoutMs = this.opts.timeoutMs,
  ): Promise<ToolOutput> {
    const ac = new AbortController();
    const onAbort = () => ac.abort(ctx.signal.reason);
    if (ctx.signal.aborted) ac.abort(ctx.signal.reason);
    else ctx.signal.addEventListener('abort', onAbort, { once: true });
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<ToolOutput>((resolve) => {
      timer = setTimeout(() => {
        ac.abort(new Error('timeout'));
        resolve({
          summary: `The tool did not finish within ${Math.round(timeoutMs / 1000)} s and was cancelled.`,
          isError: true,
          errorKind: 'timeout',
        });
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        def.run(args, { ...ctx, signal: ac.signal }).catch((err: unknown): ToolOutput => ({
          summary: `The tool failed: ${publicMessage(err)}`,
          isError: true,
          errorKind: 'internal',
        })),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onAbort);
    }
  }

  private log(def: ToolDef, t0: number, outcome: string, ctx: ToolContext): void {
    this.logCall(def.name, def.source, t0, outcome, ctx);
  }

  /** The tool_call log line (name, outcome, duration; never arguments). */
  logCall(tool: string, source: string, t0: number, outcome: string, ctx: ToolContext): void {
    this.opts.logger.info('tool_call', {
      tool,
      source,
      outcome,
      ms: Date.now() - t0,
      client: ctx.clientId,
    });
  }
}

/** Error text safe to show: no stack, no absolute paths, bounded length. */
export function publicMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/(\/[\w.-]+){2,}/g, '[path]')
    .replace(/\s+/g, ' ')
    .slice(0, 300);
}
