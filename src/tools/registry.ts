/**
 * Unified registry of tool backends: GEV (proxied over stdio), gateway-native
 * (rail) and Pulse (HTTP client). Policy decides what is visible and runnable.
 */
import type { UpstreamTool } from '../gev/child.js';
import { NEVER_TOOLS, type ToolPolicy } from './policy.js';
import { ToolSearch, type SearchHit } from './search.js';
import { metaFor } from './tags.js';
import type { ToolContext, ToolDef, ToolOutput } from './types.js';

export type GevCaller = (
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext & { timeoutMs: number },
) => Promise<ToolOutput>;

export class ToolRegistry {
  private tools = new Map<string, ToolDef>();
  readonly search = new ToolSearch();

  constructor(readonly policy: ToolPolicy) {}

  register(def: ToolDef): void {
    if (NEVER_TOOLS.has(def.name)) return;
    this.tools.set(def.name, def);
    this.reindex();
  }

  /** Replace the GEV family with a freshly listed catalog. */
  setGevTools(upstream: UpstreamTool[], call: GevCaller, timeoutMs: number): void {
    for (const [name, def] of this.tools) if (def.source === 'gev') this.tools.delete(name);
    for (const t of upstream) {
      if (NEVER_TOOLS.has(t.name) || this.tools.has(t.name)) continue;
      const meta = metaFor(t.name);
      this.tools.set(t.name, {
        name: t.name,
        title: t.title ?? (t.annotations?.title as string | undefined),
        description: t.description ?? t.name,
        source: 'gev',
        family: 'gev',
        inputSchema: t.inputSchema,
        tags: meta.tags,
        attribution: meta.attribution,
        untrustedText: t.name === 'get_regional_brief' || t.name === 'find_radio_stations',
        run: (args, ctx) => call(t.name, args, { ...ctx, timeoutMs }),
      });
    }
    this.reindex();
  }

  clearGevTools(): void {
    for (const [name, def] of this.tools) if (def.source === 'gev') this.tools.delete(name);
    this.reindex();
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name);
  }

  all(): ToolDef[] {
    return [...this.tools.values()];
  }

  isAllowed(def: ToolDef): boolean {
    return this.policy.evaluate(def).allowed;
  }

  /** Allowed tools only. */
  find(query: string, limit: number): SearchHit[] {
    return this.search.search(query, limit, (t) => this.isAllowed(t));
  }

  hasGev(): boolean {
    return this.all().some((t) => t.source === 'gev');
  }

  private reindex(): void {
    this.search.rebuild(this.all());
  }
}
