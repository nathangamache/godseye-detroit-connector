/** BM25 search (MiniSearch) over tool name, title, description, parameter names and tags. */
import MiniSearch from 'minisearch';
import type { ToolDef } from './types.js';

interface Doc {
  id: string;
  name: string;
  title: string;
  description: string;
  params: string;
  tags: string;
}

/** Light English stemmer so "trains"/"crossings"/"cameras" match "train"/"crossing"/"camera". */
export function stem(term: string): string {
  let t = term.toLowerCase().replace(/'s$/, '').replace(/[’']/g, '');
  if (t.length > 4 && t.endsWith('ies')) t = t.slice(0, -3) + 'y';
  else if (t.length > 4 && /(ches|shes|sses|xes)$/.test(t)) t = t.slice(0, -2);
  else if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss') && !t.endsWith('us')) t = t.slice(0, -1);
  return t;
}

const STOP = new Set(['a', 'an', 'the', 'of', 'in', 'on', 'at', 'to', 'for', 'is', 'are', 'me', 'my', 'and', 'or', 'by', 'near', 'around', 'what', 'whats', 'there', 'any', 'show', 'get', 'find']);

function processTerm(term: string): string | null {
  const t = stem(term);
  return t && !STOP.has(t) ? t : null;
}

function paramNames(schema: Record<string, unknown>, prefix = '', depth = 0): string[] {
  if (depth > 3) return [];
  const props = (schema?.properties ?? {}) as Record<string, Record<string, unknown>>;
  const out: string[] = [];
  for (const [k, v] of Object.entries(props)) {
    out.push(prefix + k);
    if (typeof v?.description === 'string') out.push(v.description);
    if (v && typeof v === 'object' && v.properties) out.push(...paramNames(v, '', depth + 1));
  }
  return out;
}

export interface SearchHit {
  tool: ToolDef;
  score: number;
}

export class ToolSearch {
  private index = this.makeIndex();
  private tools = new Map<string, ToolDef>();

  private makeIndex() {
    return new MiniSearch<Doc>({
      fields: ['name', 'title', 'description', 'params', 'tags'],
      storeFields: [],
      processTerm,
      searchOptions: {
        boost: { name: 3, tags: 2.5, title: 2, description: 1, params: 0.4 },
        prefix: (term) => term.length >= 4,
        fuzzy: (term) => (term.length >= 6 ? 0.2 : false),
        combineWith: 'OR',
      },
    });
  }

  rebuild(tools: ToolDef[]): void {
    this.index = this.makeIndex();
    this.tools = new Map(tools.map((t) => [t.name, t]));
    this.index.addAll(
      tools.map((t) => ({
        id: t.name,
        name: t.name.replace(/_/g, ' '),
        title: t.title ?? '',
        description: t.description,
        params: paramNames(t.inputSchema).join(' '),
        tags: t.tags.join(' '),
      })),
    );
  }

  search(query: string, limit: number, filter: (t: ToolDef) => boolean = () => true): SearchHit[] {
    const q = query.trim();
    if (!q) {
      return [...this.tools.values()].filter(filter).slice(0, limit).map((tool) => ({ tool, score: 0 }));
    }
    return this.index
      .search(q)
      .map((r) => ({ tool: this.tools.get(String(r.id))!, score: r.score }))
      .filter((h) => h.tool && filter(h.tool))
      .slice(0, limit);
  }
}
