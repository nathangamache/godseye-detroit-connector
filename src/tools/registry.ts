/**
 * Unified registry of tool backends: GEV (proxied over stdio), gateway-native
 * (rail) and Pulse (HTTP client). Policy decides what is visible and runnable.
 */
import type { UpstreamTool } from '../gev/child.js';
import { NEVER_TOOLS, type ToolPolicy } from './policy.js';
import { ToolSearch, type SearchHit } from './search.js';
import { CATEGORIES, categoryFor, metaFor, type CategoryId } from './tags.js';
import type { ToolContext, ToolDef, ToolOutput } from './types.js';
import { imperialGevOutput, withImperialDefault } from './units.js';

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
        description: meta.description ?? t.description ?? t.name,
        source: 'gev',
        family: 'gev',
        inputSchema: t.inputSchema,
        tags: meta.tags,
        attribution: meta.attribution,
        untrustedText: t.name === 'get_regional_brief' || t.name === 'find_radio_stations',
        // US units: GEV's weather comes back in C and km/h (src/tools/units.ts).
        run: async (args, ctx) =>
          imperialGevOutput(
            t.name,
            await call(t.name, withImperialDefault(t.inputSchema, args), { ...ctx, timeoutMs }),
          ),
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

  /** Allowed tools only (optionally one category). A query naming tools exactly lists those first. */
  find(query: string, limit: number, category?: CategoryId): SearchHit[] {
    const ok = (t: ToolDef) =>
      this.isAllowed(t) && (!category || categoryFor(t.name, t.source) === category);
    const exact = query
      .split(/[\s,]+/)
      .map((w) => this.tools.get(w.trim()))
      .filter((t): t is ToolDef => Boolean(t) && ok(t!));
    const hits = this.search.search(query, limit + exact.length, ok);
    const seen = new Set(exact.map((t) => t.name));
    return [
      ...exact.map((tool) => ({ tool, score: Infinity })),
      ...hits.filter((h) => !seen.has(h.tool.name)),
    ].slice(0, limit);
  }

  /**
   * Every tool the policy allows (gateway, Pulse and allowlisted GEV tools), ordered by
   * category then name: find_tools' list mode.
   */
  catalog(category?: CategoryId): Array<{ tool: ToolDef; category: CategoryId }> {
    const order = new Map<string, number>(CATEGORIES.map((c, i) => [c.id, i]));
    return this.all()
      .filter((t) => this.isAllowed(t))
      .map((tool) => ({ tool, category: categoryFor(tool.name, tool.source) }))
      .filter((e) => !category || e.category === category)
      .sort(
        (a, b) =>
          (order.get(a.category) ?? 99) - (order.get(b.category) ?? 99) ||
          a.tool.name.localeCompare(b.tool.name),
      );
  }

  hasGev(): boolean {
    return this.all().some((t) => t.source === 'gev');
  }

  private reindex(): void {
    this.search.rebuild(this.all());
  }
}
