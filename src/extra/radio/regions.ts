/**
 * A plausibility check of Radio Browser's community-entered places: a station whose state or
 * region field names a region of another country than its country field ("Niederösterreich"
 * with "The United States Of America") gets a 'check: state/country mismatch' note. Such rows are
 * kept and flagged, never hidden: the station may be fine and only its entry wrong.
 *
 * The check is conservative. It knows the first-level regions of a few countries (in their own
 * and English names) and only flags a state that is one of them, for another country than the
 * row's. A state that is also a common place name elsewhere ("Georgia", "Victoria", "Vienna",
 * "Durango") never flags; a city in the state field ("Detroit") is simply not a known region.
 */
import type { GevCaller } from '../../tools/registry.js';

export const STATE_COUNTRY_MISMATCH = 'state/country mismatch';

interface CountryRegions {
  code: string;
  /** How a sentence names it ("the United States"). */
  label: string;
  /** Spellings of the country itself, as a country field or a state field may give it. */
  names: string[];
  /** First-level regions (states, provinces, Länder, cantons ...), own and English names. */
  regions: string[];
  /** Short forms that count for the country itself only (postal codes). */
  codes?: string[];
}

// prettier-ignore
const COUNTRIES: CountryRegions[] = [
  {
    code: 'US',
    label: 'the United States',
    names: [
      'the united states of america',
      'united states of america',
      'united states',
      'usa',
      'u.s.a.',
      'u.s.',
      'us',
      'america',
    ],
    regions: [
      'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut',
      'delaware', 'district of columbia', 'florida', 'georgia', 'hawaii', 'idaho', 'illinois',
      'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana', 'maine', 'maryland', 'massachusetts',
      'michigan', 'minnesota', 'mississippi', 'missouri', 'montana', 'nebraska', 'nevada',
      'new hampshire', 'new jersey', 'new mexico', 'new york', 'north carolina', 'north dakota',
      'ohio', 'oklahoma', 'oregon', 'pennsylvania', 'rhode island', 'south carolina',
      'south dakota', 'tennessee', 'texas', 'utah', 'vermont', 'virginia', 'washington',
      'west virginia', 'wisconsin', 'wyoming', 'puerto rico',
    ],
    codes: [
      'al', 'ak', 'az', 'ar', 'ca', 'co', 'ct', 'de', 'dc', 'fl', 'ga', 'hi', 'id', 'il', 'in',
      'ia', 'ks', 'ky', 'la', 'me', 'md', 'ma', 'mi', 'mn', 'ms', 'mo', 'mt', 'ne', 'nv', 'nh',
      'nj', 'nm', 'ny', 'nc', 'nd', 'oh', 'ok', 'or', 'pa', 'ri', 'sc', 'sd', 'tn', 'tx', 'ut',
      'vt', 'va', 'wa', 'wv', 'wi', 'wy', 'pr', 'mich',
    ],
  },
  {
    code: 'CA',
    label: 'Canada',
    names: ['canada'],
    regions: [
      'ontario', 'quebec', 'british columbia', 'alberta', 'manitoba', 'saskatchewan',
      'nova scotia', 'new brunswick', 'newfoundland and labrador', 'newfoundland',
      'prince edward island', 'yukon', 'northwest territories', 'nunavut',
    ],
    codes: ['on', 'ont', 'qc', 'bc', 'ab', 'mb', 'sk', 'ns', 'nb', 'nl', 'pe', 'pei', 'yt', 'nt', 'nu'],
  },
  {
    code: 'MX',
    label: 'Mexico',
    names: ['mexico', 'estados unidos mexicanos'],
    regions: [
      'aguascalientes', 'baja california', 'baja california sur', 'campeche', 'chiapas',
      'chihuahua', 'coahuila', 'colima', 'ciudad de mexico', 'cdmx', 'distrito federal',
      'durango', 'guanajuato', 'guerrero', 'hidalgo', 'jalisco', 'estado de mexico', 'mexico',
      'michoacan', 'morelos', 'nayarit', 'nuevo leon', 'oaxaca', 'puebla', 'queretaro',
      'quintana roo', 'san luis potosi', 'sinaloa', 'sonora', 'tabasco', 'tamaulipas',
      'tlaxcala', 'veracruz', 'yucatan', 'zacatecas',
    ],
  },
  {
    code: 'GB',
    label: 'the United Kingdom',
    names: [
      'the united kingdom of great britain and northern ireland',
      'united kingdom of great britain and northern ireland',
      'the united kingdom',
      'united kingdom',
      'great britain',
      'uk',
    ],
    regions: ['england', 'scotland', 'wales', 'northern ireland'],
  },
  {
    code: 'DE',
    label: 'Germany',
    names: ['germany', 'deutschland', 'federal republic of germany'],
    regions: [
      'baden-württemberg', 'bayern', 'bavaria', 'berlin', 'brandenburg', 'bremen', 'hamburg',
      'hessen', 'hesse', 'mecklenburg-vorpommern', 'niedersachsen', 'lower saxony',
      'nordrhein-westfalen', 'north rhine-westphalia', 'nrw', 'rheinland-pfalz',
      'rhineland-palatinate', 'saarland', 'sachsen', 'saxony', 'sachsen-anhalt',
      'saxony-anhalt', 'schleswig-holstein', 'thüringen', 'thuringia',
    ],
  },
  {
    code: 'AT',
    label: 'Austria',
    names: ['austria', 'österreich', 'republic of austria'],
    regions: [
      'burgenland', 'kärnten', 'carinthia', 'niederösterreich', 'lower austria',
      'oberösterreich', 'upper austria', 'salzburg', 'steiermark', 'styria', 'tirol', 'tyrol',
      'vorarlberg', 'wien', 'vienna',
    ],
  },
  {
    code: 'CH',
    label: 'Switzerland',
    names: ['switzerland', 'schweiz', 'suisse', 'svizzera'],
    regions: [
      'zürich', 'bern', 'berne', 'luzern', 'lucerne', 'uri', 'schwyz', 'obwalden', 'nidwalden',
      'glarus', 'zug', 'fribourg', 'freiburg', 'solothurn', 'basel-stadt', 'basel-landschaft',
      'schaffhausen', 'appenzell', 'appenzell ausserrhoden', 'appenzell innerrhoden',
      'st. gallen', 'sankt gallen', 'graubünden', 'grisons', 'aargau', 'thurgau', 'ticino',
      'tessin', 'vaud', 'valais', 'wallis', 'neuchâtel', 'genève', 'geneva', 'jura',
    ],
  },
  {
    code: 'FR',
    label: 'France',
    names: ['france'],
    regions: [
      'île-de-france', 'auvergne-rhône-alpes', 'hauts-de-france', 'nouvelle-aquitaine',
      'occitanie', 'grand est', "provence-alpes-côte d'azur", 'pays de la loire', 'bretagne',
      'brittany', 'normandie', 'normandy', 'bourgogne-franche-comté', 'centre-val de loire',
      'corse', 'corsica',
    ],
  },
  {
    code: 'IT',
    label: 'Italy',
    names: ['italy', 'italia'],
    regions: [
      'lombardia', 'lombardy', 'lazio', 'campania', 'sicilia', 'sicily', 'veneto', 'piemonte',
      'piedmont', 'puglia', 'apulia', 'emilia-romagna', 'toscana', 'tuscany', 'calabria',
      'sardegna', 'sardinia', 'liguria', 'marche', 'abruzzo', 'friuli-venezia giulia',
      'trentino-alto adige', 'südtirol', 'south tyrol', 'umbria', 'basilicata', 'molise',
      "valle d'aosta", 'aosta valley',
    ],
  },
  {
    code: 'ES',
    label: 'Spain',
    names: ['spain', 'españa'],
    regions: [
      'andalucía', 'andalusia', 'cataluña', 'catalunya', 'catalonia', 'comunidad de madrid',
      'madrid', 'comunidad valenciana', 'valencia', 'galicia', 'país vasco', 'euskadi',
      'basque country', 'castilla y león', 'castilla-la mancha', 'canarias', 'canary islands',
      'aragón', 'murcia', 'asturias', 'navarra', 'extremadura', 'islas baleares',
      'illes balears', 'balearic islands', 'cantabria', 'la rioja',
    ],
  },
  {
    code: 'NL',
    label: 'the Netherlands',
    names: ['the netherlands', 'netherlands', 'nederland', 'kingdom of the netherlands', 'holland'],
    regions: [
      'noord-holland', 'north holland', 'zuid-holland', 'south holland', 'utrecht',
      'noord-brabant', 'north brabant', 'gelderland', 'overijssel', 'limburg', 'friesland',
      'fryslân', 'groningen', 'drenthe', 'flevoland', 'zeeland',
    ],
  },
  {
    code: 'AU',
    label: 'Australia',
    names: ['australia'],
    regions: [
      'new south wales', 'victoria', 'queensland', 'western australia', 'south australia',
      'tasmania', 'northern territory', 'australian capital territory',
    ],
  },
  {
    code: 'BR',
    label: 'Brazil',
    names: ['brazil', 'brasil'],
    regions: [
      'são paulo', 'rio de janeiro', 'minas gerais', 'bahia', 'paraná', 'rio grande do sul',
      'pernambuco', 'ceará', 'pará', 'santa catarina', 'goiás', 'maranhão', 'amazonas',
      'espírito santo', 'paraíba', 'mato grosso', 'mato grosso do sul', 'distrito federal',
      'alagoas', 'piauí', 'rio grande do norte', 'rondônia', 'tocantins', 'acre', 'amapá',
      'roraima', 'sergipe',
    ],
  },
];

/**
 * Names that are also common place names elsewhere (or regions of two countries): they count
 * for their own country but never mark a row as belonging to another one.
 */
// prettier-ignore
const AMBIGUOUS = new Set(
  [
    'georgia', 'washington', 'florida', 'virginia', 'nevada', 'maine', 'indiana', 'montana',
    'america', 'us', 'mexico', 'durango', 'hidalgo', 'sonora', 'guerrero', 'distrito federal',
    'victoria', 'vienna', 'berlin', 'brandenburg', 'bremen', 'hamburg', 'freiburg', 'bern',
    'lucerne', 'geneva', 'zürich', 'jura', 'uri', 'zug', 'normandy', 'new brunswick', 'madrid',
    'valencia', 'murcia', 'limburg', 'zeeland', 'holland', 'acre', 'amazonas', 'pará', 'paraná',
    'newfoundland', 'marche', 'tirol', 'tyrol',
  ].map((s) => fold(s)),
);

/** Lower case, accents removed, hyphens and runs of spaces as one space. */
function fold(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[-‐–—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Every spelling that is consistent with a country (its regions, codes and names). */
const OWN = new Map<string, Set<string>>(
  COUNTRIES.map((c) => [c.code, new Set([...c.regions, ...(c.codes ?? []), ...c.names].map(fold))]),
);
/** Region (or country) spelling -> the one country it marks a row as belonging to. */
const DETECT = new Map<string, string>();
for (const c of COUNTRIES)
  for (const r of [...c.regions, ...c.names].map(fold))
    if (!AMBIGUOUS.has(r) && !DETECT.has(r)) DETECT.set(r, c.code);
const BY_NAME = new Map<string, string>();
for (const c of COUNTRIES) for (const n of c.names) BY_NAME.set(fold(n), c.code);
const LABEL = new Map(COUNTRIES.map((c) => [c.code, c.label]));

export interface StateCountryCheck {
  check: typeof STATE_COUNTRY_MISMATCH;
  check_detail: string;
}

/**
 * Whether a directory row's state names a region of another country than its country field.
 * `country` is the row's country name and, when the directory gives it, its ISO code.
 */
export function stateCountryCheck(
  state: string | null | undefined,
  country: { name?: string | null; code?: string | null },
): StateCountryCheck | undefined {
  if (typeof state !== 'string' || !state.trim()) return undefined;
  const name = typeof country.name === 'string' ? country.name.trim() : '';
  const given = typeof country.code === 'string' ? country.code.trim().toUpperCase() : '';
  const code = OWN.has(given) ? given : BY_NAME.get(fold(name));
  if (!code && !name && !given) return undefined;
  const parts = [state, ...state.split(/[,/;|()]|\s+[-–—]\s+/)].map(fold).filter(Boolean);
  if (code && parts.some((p) => OWN.get(code)!.has(p))) return undefined;
  for (const p of parts) {
    const other = DETECT.get(p);
    if (!other || other === code) continue;
    const named = name || given;
    return {
      check: STATE_COUNTRY_MISMATCH,
      check_detail: `the state "${state.trim()}" is a region of ${LABEL.get(other)}, but the country given is ${named}${given && name ? ` (country code ${given})` : ''}; the directory entry may be wrong`,
    };
  }
  return undefined;
}

/** The summary sentence for flagged rows (`path` says where the details are). */
export function mismatchNote(n: number, path: string): string {
  return n === 1
    ? `1 station is flagged "check: ${STATE_COUNTRY_MISMATCH}": its directory state and country disagree (${path}); the directory is community-entered.`
    : `${n} stations are flagged "check: ${STATE_COUNTRY_MISMATCH}": their directory state and country disagree (${path}); the directory is community-entered.`;
}

/**
 * GEV's find_radio_stations rows get the same check: a flagged row gains `check` and
 * `check_detail` (a copy; GEV's data is not changed in place) and the summary says how many.
 * Every other tool passes through.
 */
export function withRadioChecks(call: GevCaller): GevCaller {
  return async (name, args, ctx) => {
    const out = await call(name, args, ctx);
    if (name !== 'find_radio_stations' || out.isError) return out;
    const data = out.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return out;
    const rows = (data as { rows?: unknown }).rows;
    if (!Array.isArray(rows)) return out;
    let flagged = 0;
    const checked = rows.map((r: unknown) => {
      if (!r || typeof r !== 'object') return r;
      const row = r as Record<string, unknown>;
      const c = stateCountryCheck(typeof row.state === 'string' ? row.state : undefined, {
        name: typeof row.country === 'string' ? row.country : undefined,
      });
      if (!c) return r;
      flagged++;
      return { ...row, ...c };
    });
    if (!flagged) return out;
    return {
      ...out,
      summary: `${out.summary}\n${mismatchNote(flagged, 'data.rows[].check_detail')}`,
      data: { ...(data as Record<string, unknown>), rows: checked },
    };
  };
}
