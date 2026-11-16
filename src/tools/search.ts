/**
 * find_tools search. MiniSearch (BM25 over name, title, description, parameter names and tags,
 * with prefix and fuzzy matching) finds the candidates; each is then scored by where the query's
 * words occur as whole words: in the tool's name (strongest), its tags, its category, its title,
 * its description, its parameters. A word that only begins a longer word ("head" in "headlines")
 * counts half, and a word of three letters or fewer only as a whole word, so "air" in "airfield"
 * is not a match. Hits far weaker than the best one are dropped: a lone word in a tag ("air" in
 * "air base") does not make a military-bases tool the second answer to "air_quality".
 *
 * A query about a place ("near me", "around here", "local", "in Lansing") lifts the tools marked
 * nearIntent above those sharing their topic, but only when the query also names their topic (a
 * word of their name): "radio stations near me" is radio_stations_near, "news near me" is not.
 */
import MiniSearch from 'minisearch';
import { categoryFor } from './tags.js';
import type { ToolDef } from './types.js';

interface Doc {
  id: string;
  name: string;
  title: string;
  description: string;
  params: string;
  tags: string;
  /** The catalog category's id ("weather", "aviation"), none for "other". */
  category: string;
}

/** Light English stemmer so "trains"/"crossings"/"cameras" match "train"/"crossing"/"camera". */
export function stem(term: string): string {
  let t = term.toLowerCase().replace(/'s$/, '').replace(/[’']/g, '');
  if (t.length > 4 && t.endsWith('ies')) t = t.slice(0, -3) + 'y';
  else if (t.length > 4 && /(ches|shes|sses|xes)$/.test(t)) t = t.slice(0, -2);
  else if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss') && !t.endsWith('us'))
    t = t.slice(0, -1);
  return t;
}

const STOP = new Set([
  // "I-94" keeps its "94"; "can I go outside" its other words.
  'i',
  'a',
  'an',
  'the',
  'of',
  'in',
  'on',
  'at',
  'to',
  'for',
  'is',
  'are',
  'me',
  'my',
  'and',
  'or',
  'by',
  'near',
  'around',
  'what',
  'whats',
  'there',
  'any',
  'show',
  'get',
  'find',
]);

function processTerm(term: string): string | null {
  const t = stem(term);
  return t && !STOP.has(t) ? t : null;
}

/** MiniSearch's own tokenizer: split on spaces and punctuation ("_" and "-" included). */
const SPLIT = /[\n\r\p{Z}\p{P}]+/u;

/** The words of a text as the index sees them (stemmed, stop words out). */
export function words(text: string): string[] {
  return text
    .split(SPLIT)
    .map(processTerm)
    .filter((t): t is string => Boolean(t));
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

/** How much a query word is worth by where it occurs as a whole word. */
export const FIELD_WEIGHT = {
  name: 4,
  tags: 3,
  category: 2,
  title: 2,
  description: 1,
  params: 0.25,
} as const;
type Field = keyof typeof FIELD_WEIGHT;
const FIELDS = Object.keys(FIELD_WEIGHT) as Field[];

/**
 * What a place in the query adds to a nearIntent tool that shares a word of its name: as much as
 * a word of its name, so it outweighs one tag word of a tool on the same topic ("jazz").
 */
export const NEAR_BONUS = 4;

/** Words that ask about a place (some are stop words, so the index never sees them). */
const PLACE_WORDS =
  /\b(near|nearby|nearest|around|close to|closest|local|locally|here|my area|this area|the area|in town|where i am)\b/i;
/** "in Lansing", "at Belle Isle": a capitalised name after in/at. */
const IN_PLACE = /\b(?:in|at)\s+(\p{Lu}[\p{L}'.-]*)/gu;
/** Capitalised words after "in" that are not places ("radio in Spanish"). */
const NOT_PLACES = new Set([
  'spanish',
  'english',
  'french',
  'german',
  'arabic',
  'chinese',
  'japanese',
  'korean',
  'italian',
  'portuguese',
  'russian',
  'polish',
  'hindi',
  'urdu',
  'greek',
  'dutch',
  'hd',
  'stereo',
  'mp3',
  'aac',
]);

/** Whether a query asks about a place rather than a kind of thing. */
export function asksAboutPlace(query: string): boolean {
  if (PLACE_WORDS.test(query)) return true;
  for (const m of query.matchAll(IN_PLACE)) if (!NOT_PLACES.has(m[1]!.toLowerCase())) return true;
  return false;
}

/** A query word that only begins a longer word counts this share (and needs 4+ letters). */
const PREFIX_SHARE = 0.5;
const MIN_PREFIX = 4;

/**
 * A hit is kept when it scores at least KEEP_SHARE of the best hit, or, matching as many of the
 * query's words as the best hit does, at least KEEP_SHARE_ALL_WORDS of it.
 */
export const KEEP_SHARE = 0.5;
export const KEEP_SHARE_ALL_WORDS = 0.15;

type Profile = Record<Field, Set<string>>;

export class ToolSearch {
  private index = this.makeIndex();
  private tools = new Map<string, ToolDef>();
  private profiles = new Map<string, Profile>();
  private near = new Set<string>();

  private makeIndex() {
    return new MiniSearch<Doc>({
      fields: ['name', 'title', 'description', 'params', 'tags', 'category'],
      storeFields: [],
      processTerm,
      searchOptions: {
        boost: { name: 3, tags: 2.5, category: 2, title: 2, description: 1, params: 0.4 },
        prefix: (term) => term.length >= MIN_PREFIX,
        fuzzy: (term) => (term.length >= 6 ? 0.2 : false),
        combineWith: 'OR',
      },
    });
  }

  rebuild(tools: ToolDef[]): void {
    this.index = this.makeIndex();
    this.tools = new Map(tools.map((t) => [t.name, t]));
    this.near = new Set(tools.filter((t) => t.nearIntent).map((t) => t.name));
    const docs: Doc[] = tools.map((t) => {
      const category = categoryFor(t.name, t.source);
      return {
        id: t.name,
        name: t.name.replace(/_/g, ' '),
        title: t.title ?? '',
        description: t.description,
        params: paramNames(t.inputSchema).join(' '),
        tags: t.tags.join(' '),
        // By its id ("weather", "traffic"), not its label's every word ("air quality").
        category: category === 'other' ? '' : category,
      };
    });
    this.index.addAll(docs);
    this.profiles = new Map(
      docs.map((d) => [
        d.id,
        {
          name: new Set(words(d.name)),
          tags: new Set(words(d.tags)),
          category: new Set(words(d.category)),
          title: new Set(words(d.title)),
          description: new Set(words(d.description)),
          params: new Set(words(d.params)),
        },
      ]),
    );
  }

  /**
   * What a tool's fields give a query: the sum over the query's words of each word's best
   * field, how many of the words it has as whole words (outside its parameters), and whether
   * one of them is a word of its name.
   */
  private fieldScore(
    name: string,
    terms: string[],
  ): { score: number; matched: number; inName: boolean } {
    const p = this.profiles.get(name);
    if (!p) return { score: 0, matched: 0, inName: false };
    let score = 0;
    let matched = 0;
    const inName = terms.some((t) => p.name.has(t));
    for (const term of terms) {
      let best = 0;
      let counts = false;
      for (const f of FIELDS) {
        const w = FIELD_WEIGHT[f];
        if (w <= best) continue;
        let hit = 0;
        if (p[f].has(term)) hit = w;
        else if (term.length >= MIN_PREFIX) {
          for (const word of p[f])
            if (word.length > term.length && word.startsWith(term)) {
              hit = w * PREFIX_SHARE;
              break;
            }
        }
        if (hit > best) {
          best = hit;
          counts = hit === w && f !== 'params';
        }
      }
      score += best;
      if (counts) matched++;
    }
    return { score, matched, inName };
  }

  search(query: string, limit: number, filter: (t: ToolDef) => boolean = () => true): SearchHit[] {
    const q = query.trim();
    if (!q) {
      return [...this.tools.values()]
        .filter(filter)
        .slice(0, limit)
        .map((tool) => ({ tool, score: 0 }));
    }
    const terms = [...new Set(words(q))];
    const raw = this.index
      .search(q)
      .map((r) => ({ tool: this.tools.get(String(r.id))!, bm25: r.score }))
      .filter((h) => h.tool && filter(h.tool));
    if (!raw.length) return [];
    const topBm25 = Math.max(...raw.map((h) => h.bm25));
    const place = asksAboutPlace(q);
    // Field matches rank; BM25 (at most 1 point) only orders hits the fields score alike.
    const scored = raw
      .map((h) => {
        const f = this.fieldScore(h.tool.name, terms);
        const near = place && f.inName && this.near.has(h.tool.name) ? NEAR_BONUS : 0;
        return { tool: h.tool, score: f.score + near + h.bm25 / topBm25, matched: f.matched };
      })
      .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));
    const best = scored[0]!;
    return scored
      .filter(
        (h) =>
          h.score >= KEEP_SHARE * best.score ||
          (h.matched >= best.matched && h.score >= KEEP_SHARE_ALL_WORDS * best.score),
      )
      .slice(0, limit)
      .map(({ tool, score }) => ({ tool, score }));
  }
}
