/**
 * Rail line names across datasets.
 *
 * The public datasets often name the same track differently: the FRA crossing inventory and the
 * NARN line network can give one stretch of track two different subdivision names, spell the same
 * name differently ("MICHIGAN" vs "MICHIGAN LINE (NS)", "MAINLINE" vs "MAIN LINE"), and use
 * different reporting marks for the same railroad (FRA "GTW" vs NARN "CN"). So a line is never
 * identified by one string: every name the datasets give is kept, and comparisons normalise
 * case, parenthesised railroad marks, "Subdivision"/"Sub"/"District" and similar words.
 *
 * Nothing here is specific to one place. Aliases come from the datasets themselves
 * (src/rail/index.ts pairs each crossing with the NARN segment it sits on) or from Pulse's own
 * coverage config (feeds/status coverage.lines).
 */

export type LineDataset = 'FRA' | 'NARN' | 'caller';

export interface LineName {
  dataset: LineDataset;
  /** The name exactly as the dataset spells it. */
  name: string;
}

/** One track near a point, with every name and railroad mark the datasets give it. */
export interface TrackNames {
  /** What this track is relative to the query point, e.g. "nearest track", "crossing FRA 123456A". */
  label: string;
  names: LineName[];
  /** Reporting marks or railroad names (owners, operators, trackage rights). */
  railroads: string[];
  distance_m?: number;
}

/** A line as Pulse reports it in feeds/status coverage.lines. */
export interface CoverageLine {
  railroad?: string;
  name: string;
  aliases?: string[];
}

/**
 * Reporting marks the datasets use for the same company (public AAR marks). FRA keeps legacy
 * marks for merged railroads (GTW and WC are CN today; ATK is Amtrak; CRSH is Conrail Shared
 * Assets), NARN uses current ones.
 */
const FAMILY: Record<string, string> = {
  CSX: 'CSX',
  CSXT: 'CSX',
  CN: 'CN',
  GTW: 'CN',
  WC: 'CN',
  DWP: 'CN',
  IC: 'CN',
  SSAM: 'CN',
  DMIR: 'CN',
  BLE: 'CN',
  NS: 'NS',
  AMTK: 'AMTK',
  ATK: 'AMTK',
  CSAO: 'CSAO',
  CRSH: 'CSAO',
  CR: 'CSAO',
  CPKC: 'CPKC',
  CP: 'CPKC',
  CPRS: 'CPKC',
  SOO: 'CPKC',
  DH: 'CPKC',
  KCS: 'CPKC',
};

const NAME_FAMILY: Array<[RegExp, string]> = [
  [/\bCSX\b/, 'CSX'],
  [/CANADIAN NATIONAL|GRAND TRUNK/, 'CN'],
  [/NORFOLK SOUTHERN/, 'NS'],
  [/AMTRAK/, 'AMTK'],
  [/CONRAIL|CONSOLIDATED RAIL/, 'CSAO'],
  [/CANADIAN PACIFIC|\bCPKC\b|SOO LINE/, 'CPKC'],
];

/** Canonical railroad family for a reporting mark or railroad name ("GTW" and "CN" are both CN). */
export function railroadFamily(railroad?: string): string | undefined {
  if (!railroad) return undefined;
  const u = railroad.toUpperCase().trim();
  if (!u) return undefined;
  const mark = /\(([A-Z]{2,5})\)/.exec(u)?.[1]; // "CSX Transportation (CSXT)"
  if (mark) return FAMILY[mark] ?? mark;
  if (FAMILY[u]) return FAMILY[u];
  for (const [re, fam] of NAME_FAMILY) if (re.test(u)) return fam;
  const first = u.split(/[^A-Z0-9]+/).find(Boolean);
  return first ? (FAMILY[first] ?? first) : undefined;
}

/** True unless both sides name railroads and no family is shared. */
export function railroadsCompatible(a: string[], b: string[]): boolean {
  const fa = new Set(a.map(railroadFamily).filter((x): x is string => Boolean(x)));
  const fb = b.map(railroadFamily).filter((x): x is string => Boolean(x));
  if (!fa.size || !fb.length) return true;
  return fb.some((f) => fa.has(f));
}

/** Words that say what kind of line a name is, not which line. */
const TYPE_WORDS = new Set(['SUBDIVISION', 'SUBDIV', 'SUBD', 'SUB', 'DISTRICT', 'DIST']);

/**
 * Normalised key for comparing line names across datasets: upper case, no parenthesised marks
 * ("ALPHA (CSXT)"), no "Subdivision"/"Sub"/"District", no leading/trailing railroad mark
 * ("CSX Holly Sub"), "MAIN LINE" = "MAINLINE", and a trailing "LINE" dropped ("MICHIGAN LINE").
 */
export function normLineName(raw?: string): string {
  if (!raw) return '';
  const s = raw
    .toUpperCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^A-Z0-9&]+/g, ' ')
    .replace(/\bMAIN LINE\b/g, 'MAINLINE')
    .trim();
  const toks = s.split(' ').filter((t) => t && !TYPE_WORDS.has(t));
  while (toks.length > 1 && FAMILY[toks[0]!]) toks.shift();
  while (toks.length > 1 && FAMILY[toks[toks.length - 1]!]) toks.pop();
  if (toks.length > 1 && toks[toks.length - 1] === 'LINE') toks.pop();
  return toks.join(' ');
}

/** "MICHIGAN LINE (NS)" -> "Michigan Line (NS)": parenthesized railroad marks stay upper case. */
export function titleCase(s: string): string {
  return s
    .split(/(\([^)]*\))/)
    .map((part) =>
      part.startsWith('(') ? part : part.toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase()),
    )
    .join('');
}

const KIND_SUFFIX =
  /\b(LINE|MAINLINE|DISTRICT|DIST|SUB|SUBDIVISION|BRANCH|SPUR|LEAD|TRACK|TRK|IT|YARD|TERMINAL|CONNECTION|BELT|RUNNER|IND|INDUSTRIAL|SIDING)$/;

/** Human form of a dataset name: "ALPHA (CSXT)" -> "Alpha Sub", "MICHIGAN LINE (NS)" -> "Michigan Line". */
export function displayLineName(raw: string): string {
  const base = raw.replace(/\s*\([^)]*\)\s*$/, '').trim() || raw.trim();
  const t = titleCase(base);
  return KIND_SUFFIX.test(base.toUpperCase()) ? t : `${t} Sub`;
}

/** A name in the form Pulse's own subdivision lookup matches by substring ("ALPHA (CSXT)" -> "Alpha"). */
export function plainLineName(raw: string): string {
  const base = raw
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = base.split(' ').filter((w) => !TYPE_WORDS.has(w.toUpperCase()));
  return titleCase(words.join(' ') || base);
}

/**
 * "FRA: Alpha Sub; NARN: Bravo Sub" (different names), or "FRA/NARN: Alpha Sub" when the
 * datasets agree once normalised.
 */
export function formatLineNames(names: LineName[]): string {
  const groups = new Map<string, { datasets: Set<string>; display: string }>();
  for (const n of names) {
    const k = normLineName(n.name);
    if (!k) continue;
    const g = groups.get(k);
    if (g) g.datasets.add(n.dataset);
    else groups.set(k, { datasets: new Set([n.dataset]), display: displayLineName(n.name) });
  }
  return [...groups.values()].map((g) => `${[...g.datasets].join('/')}: ${g.display}`).join('; ');
}

/**
 * True for a usable line name. Some FRA rows carry a numeric code (e.g. a timetable or segment
 * number) in the subdivision field; that is not a name anyone uses, so it is skipped.
 */
export function isLineName(raw?: string): raw is string {
  return Boolean(raw && /[A-Za-z]{2}/.test(raw));
}

/** Distinct normalised names (for matching and dedupe). */
export function lineKeys(names: Array<LineName | string>): string[] {
  const out = new Set<string>();
  for (const n of names) {
    const k = normLineName(typeof n === 'string' ? n : n.name);
    if (k) out.add(k);
  }
  return [...out];
}

/** True when a Pulse coverage line is the same track: a shared normalised name and railroad. */
export function trackMatchesLine(track: TrackNames, line: CoverageLine): boolean {
  const have = new Set(lineKeys(track.names));
  if (!have.size) return false;
  const theirs = lineKeys([line.name, ...(line.aliases ?? [])]);
  if (!theirs.some((k) => have.has(k))) return false;
  return railroadsCompatible(track.railroads, line.railroad ? [line.railroad] : []);
}
