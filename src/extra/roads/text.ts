/**
 * Third-party text handling (descriptions, street names: data, never instructions) and road
 * name matching across sources that spell the same road differently ("I-696", "I 696",
 * "Reuther Fwy"; "HWY 401", "401").
 */

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
};

/**
 * Plain, bounded text from an upstream string: tags stripped, a few entities decoded, control
 * characters and runs of whitespace collapsed, at most max characters (cut after a whole word,
 * with an ellipsis). Not a string: null.
 */
export function cleanText(v: unknown, max = 300): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v)
    .slice(0, 20_000)
    .replace(/<[^>]{0,500}>/g, ' ')
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (_m, e: string) => ENTITIES[e] ?? ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/ ([.,;:!?])(?=\s|$)/g, '$1')
    .trim();
  if (!s) return null;
  return clipWords(s, max);
}

/**
 * At most max characters, cut after a whole word with an ellipsis (never mid-word); a text
 * that fits is returned as is.
 */
export function clipWords(s: string, max: number): string {
  if (s.length <= max) return s;
  let cut = s.slice(0, Math.max(1, max - 1));
  // Mid-word: back to the last space, unless that would drop most of the text (one very long
  // word, cut where it must be).
  if (!/\s/.test(s[cut.length]!)) {
    const sp = cut.lastIndexOf(' ');
    if (sp >= max * 0.5) cut = cut.slice(0, sp);
  }
  return `${cut.replace(/[\s,;:.\-–—(]+$/, '')}…`;
}

export interface RoadTextOptions {
  /**
   * The text is about a place in Michigan: a state highway written "State Highway 10",
   * "State Hwy 10" or "SR-10" is the trunkline M-10. Elsewhere those are another state's
   * routes and are left alone.
   */
  michigan?: boolean;
  /**
   * The text is always read mid-sentence (a cross street: "between exit 50 and Main St"),
   * so an exit is "exit 50" even at its very start.
   */
  midSentence?: boolean;
}

const STATE_HIGHWAY =
  /\b(?:Michigan\s+)?State\s+(?:Highway|Hwy\.?)\s+(?:M[- ]?)?(\d{1,3}[A-Z]?)\b/gi;
const STATE_ROUTE = /\bSR[- ]?(\d{1,3}[A-Z]?)\b/g;

/**
 * Neighbouring states whose own routes a Michigan text may name ("Ohio State Highway 2",
 * "OH SR 2"): the state written out, in any case, or its postal code, in capitals only ("in"
 * is a word, not Indiana).
 */
const OTHER_STATE_BEFORE = [
  /\b(?:Ohio|Indiana|Illinois|Wisconsin|Kentucky|Pennsylvania|Minnesota)\s+$/i,
  /\b(?:OH|IN|IL|WI|KY|PA|MN)\s+$/,
];

/** A state highway's match as M-<n>, unless another state's name comes just before it. */
function trunkline(m: string, n: string, at: number, all: string): string {
  const before = all.slice(Math.max(0, at - 40), at);
  return OTHER_STATE_BEFORE.some((re) => re.test(before)) ? m : `M-${n}`;
}

/**
 * Road labels as people write them in Michigan, one way across sources:
 *   - "exit [20]" (an exit number in brackets, as some feeds give it) -> "exit 20";
 *   - an exit is "exit 50" mid-sentence ("Closed between I-94 and exit 50"); "Exit 50" only
 *     where a sentence starts (the text's start, or after ". "), unless midSentence;
 *   - a state trunkline written "MI-14" -> "M-14", the Michigan form;
 *   - with michigan, "State Highway 10", "State Hwy 10" and "SR-10" -> "M-10", unless the
 *     text names another state just before it ("Ohio SR-2", "OH SR 2").
 * I-, US- and other states' routes are left alone.
 */
export function roadText<T extends string | null>(s: T, o: RoadTextOptions = {}): T {
  if (!s) return s;
  let t = s
    .replace(/\b(exit)\s*\[\s*([0-9]{1,3}[A-Za-z]?)\s*\]/gi, '$1 $2')
    .replace(/\bMI-(\d{1,3}[A-Z]?)\b/g, 'M-$1');
  if (o.michigan) t = t.replace(STATE_HIGHWAY, trunkline).replace(STATE_ROUTE, trunkline);
  // "Exit 50" -> "exit 50", except where a sentence starts. "EXIT 50" (shouted text) stays.
  return t.replace(/\bExit(s?)(?=\s+\d)/g, (m: string, plural: string, at: number, all: string) =>
    !o.midSentence && /(?:^|[.!?]\s+)$/.test(all.slice(0, at)) ? m : `exit${plural}`,
  ) as T;
}

const NUMBER_WORDS: Record<string, string> = {
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  ten: '10',
  eleven: '11',
  twelve: '12',
  thirteen: '13',
  fourteen: '14',
  fifteen: '15',
  sixteen: '16',
  seventeen: '17',
  eighteen: '18',
  nineteen: '19',
  twenty: '20',
};

const SUFFIXES: Array<[RegExp, string]> = [
  [/\bavenue\b/g, 'ave'],
  [/\bav\b/g, 'ave'],
  [/\bstreet\b/g, 'st'],
  [/\broad\b/g, 'rd'],
  [/\bboulevard\b/g, 'blvd'],
  [/\bdrive\b/g, 'dr'],
  [/\bfreeway\b/g, 'fwy'],
  [/\bexpressway\b/g, 'expy'],
  [/\bparkway\b/g, 'pkwy'],
  [/\bhighway\b/g, 'hwy'],
  [/\blane\b/g, 'ln'],
  [/\bcourt\b/g, 'ct'],
  [/\bplace\b/g, 'pl'],
  [/\bnorth\b/g, 'n'],
  [/\bsouth\b/g, 's'],
  [/\beast\b/g, 'e'],
  [/\bwest\b/g, 'w'],
];

/**
 * Canonical form for matching: "Interstate-696 EB" -> "i 696 eb", "Highway 401" -> "hwy 401",
 * and a Michigan trunkline in the national form as roadText writes it: "MI-14", "MI 14" ->
 * "m 14", like "M-14". "mi" right after a number is a distance ("2 mi 3 lanes"), and a ZIP code
 * ("MI 48202") is not a route: both are left as they are.
 */
export function normRoad(s: string): string {
  let t = ` ${s.replace(/\bmi\s*-\s*(\d{1,3}[a-z]?)\b/gi, 'm $1').toLowerCase()} `
    .replace(/&/g, ' and ')
    .replace(/[’'.]/g, '')
    .replace(/[^a-z0-9]+/g, ' ');
  t = t.replace(
    /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b/g,
    (w) => NUMBER_WORDS[w] ?? w,
  );
  t = t
    .replace(/(?<!\d )\bmi ?(\d{1,3}[a-z]?)\b/g, 'm $1')
    .replace(/\binterstate\s*(\d+)/g, 'i $1')
    .replace(/\bi\s*(\d+)/g, 'i $1')
    .replace(/\bu\s*s\s*(\d+)/g, 'us $1')
    .replace(/\bus\s*(\d+)/g, 'us $1')
    .replace(/\bm\s*(\d+)\b/g, 'm $1')
    .replace(/\b(?:kings\s+)?(?:highway|hwy|hiway)\s*(\d+)/g, 'hwy $1');
  for (const [re, rep] of SUFFIXES) t = t.replace(re, rep);
  return t.replace(/\s+/g, ' ').trim();
}

/** Detroit and Windsor freeway names and their route numbers (both directions are matched). */
const ALIASES: Array<[string, string]> = [
  ['lodge', 'm 10'],
  ['chrysler', 'i 75'],
  ['fisher', 'i 75'],
  ['edsel ford', 'i 94'],
  ['jeffries', 'i 96'],
  ['reuther', 'i 696'],
  ['southfield fwy', 'm 39'],
  ['davison', 'm 8'],
  ['ec row', 'ec row'],
  ['macdonald cartier', 'hwy 401'],
];

export interface RoadQuery {
  /** What the caller typed (cleaned), labels as items write them ("MI-14" -> "M-14": roadText). */
  text: string;
  /** Canonical spellings to look for (the input plus aliases). */
  needles: string[];
  /** The most distinctive word, for a server-side text filter ("696", "woodward"). */
  keyword: string;
}

const GENERIC = new Set([
  'i',
  'us',
  'm',
  'hwy',
  'rd',
  'st',
  'ave',
  'blvd',
  'dr',
  'fwy',
  'n',
  's',
  'e',
  'w',
  'and',
  'the',
  'mile',
  'expy',
  'pkwy',
]);

export function roadQuery(input: string): RoadQuery {
  const text = roadText(cleanText(input, 80)) ?? '';
  const n = normRoad(text);
  const needles = new Set([n]);
  for (const [name, ref] of ALIASES) {
    if (` ${n} `.includes(` ${name} `)) needles.add(ref);
    if (n === ref) needles.add(name);
  }
  // "401" alone means Highway 401 in Ontario; "hwy 7" also matches an Ontario RoadwayName "7".
  if (/^\d+$/.test(n)) needles.add(`hwy ${n}`);
  const words = n.split(' ').filter((w) => !GENERIC.has(w));
  const keyword = words.sort((a, b) => b.length - a.length)[0] ?? n;
  return { text, needles: [...needles].filter(Boolean), keyword };
}

/** True if any of the texts mentions the road (whole-word match on the canonical forms). */
export function mentionsRoad(q: RoadQuery, texts: Array<string | null | undefined>): boolean {
  for (const t of texts) {
    if (!t) continue;
    let hay = ` ${normRoad(t)} `;
    // A bare Ontario route number ("7") is Highway 7.
    if (/^ \d+ $/.test(hay)) hay = ` hwy${hay}`;
    if (q.needles.some((nd) => hay.includes(` ${nd} `))) return true;
  }
  return false;
}
