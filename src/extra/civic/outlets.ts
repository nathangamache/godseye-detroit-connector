/**
 * Local news outlets by metro, so local_headlines can ask GDELT for stories from the metro's
 * own newsrooms (GDELT's domain: filter) before the broad "any outlet that mentions the place"
 * search. A metro is recognised from the Census county of a point, or from a place name (a
 * listed city, or a listed county written with "County" or with the metro's state or province,
 * and no conflicting state or province). Only public outlets of a few
 * large metros near the connector's area are listed; anywhere else the search falls back to the
 * place's country (sourcecountry:) or the broad search.
 */

export type CountryCode = 'US' | 'CA';

export interface Metro {
  id: string;
  label: string;
  country: CountryCode;
  /** State or province names (lower case) a place name may add. */
  region: string[];
  /** Census county names, as the geocoder gives them ("Wayne County"). */
  counties: string[];
  /** City names (lower case) that identify the metro on their own. */
  cities: string[];
  /** Local outlets' domains for GDELT's domain: filter (kept short: GDELT queries are bounded). */
  domains: string[];
}

const MICHIGAN = ['michigan', 'mi', 'mich'];

export const METROS: Metro[] = [
  {
    id: 'detroit',
    label: 'Metro Detroit',
    country: 'US',
    region: MICHIGAN,
    counties: [
      'Wayne County',
      'Oakland County',
      'Macomb County',
      'Washtenaw County',
      'Livingston County',
      'Monroe County',
      'St. Clair County',
      'Lapeer County',
    ],
    cities: [
      'detroit',
      'metro detroit',
      'dearborn',
      'dearborn heights',
      'warren',
      'sterling heights',
      'livonia',
      'westland',
      'troy',
      'farmington hills',
      'rochester hills',
      'pontiac',
      'royal oak',
      'novi',
      'taylor',
      'st. clair shores',
      'hamtramck',
      'highland park',
      'ferndale',
      'wyandotte',
      'grosse pointe',
      'ann arbor',
      'ypsilanti',
      'port huron',
      'mount clemens',
    ],
    domains: [
      'freep.com',
      'detroitnews.com',
      'clickondetroit.com',
      'wxyz.com',
      'fox2detroit.com',
      'wdet.org',
      'michiganpublic.org',
      'crainsdetroit.com',
      'bridgedetroit.com',
      'outliermedia.org',
      'mlive.com',
      'theoaklandpress.com',
    ],
  },
  {
    id: 'lansing',
    label: 'the Lansing area',
    country: 'US',
    region: MICHIGAN,
    counties: ['Ingham County', 'Eaton County', 'Clinton County'],
    cities: ['lansing', 'east lansing'],
    domains: [
      'lansingstatejournal.com',
      'wlns.com',
      'wilx.com',
      'wkar.org',
      'lansingcitypulse.com',
      'mlive.com',
    ],
  },
  {
    id: 'grand_rapids',
    label: 'the Grand Rapids area',
    country: 'US',
    region: MICHIGAN,
    counties: ['Kent County', 'Ottawa County'],
    cities: ['grand rapids', 'kentwood'],
    domains: ['woodtv.com', 'wzzm13.com', 'fox17online.com', 'grbj.com', 'mlive.com'],
  },
  {
    id: 'flint',
    label: 'the Flint area',
    country: 'US',
    region: MICHIGAN,
    counties: ['Genesee County'],
    cities: ['flint', 'burton', 'grand blanc'],
    domains: ['abc12.com', 'nbc25news.com', 'wnem.com', 'mlive.com'],
  },
  {
    id: 'windsor',
    label: 'Windsor-Essex',
    country: 'CA',
    region: ['ontario', 'on', 'ont'],
    counties: ['Essex County'],
    cities: ['windsor', 'lasalle', 'amherstburg', 'kingsville', 'leamington'],
    domains: ['windsorstar.com', 'cbc.ca', 'ctvnews.ca', 'blackburnnews.com'],
  },
];

const US_STATES = [
  'alabama',
  'alaska',
  'arizona',
  'arkansas',
  'california',
  'colorado',
  'connecticut',
  'delaware',
  'district of columbia',
  'florida',
  'georgia',
  'hawaii',
  'idaho',
  'illinois',
  'indiana',
  'iowa',
  'kansas',
  'kentucky',
  'louisiana',
  'maine',
  'maryland',
  'massachusetts',
  'michigan',
  'minnesota',
  'mississippi',
  'missouri',
  'montana',
  'nebraska',
  'nevada',
  'new hampshire',
  'new jersey',
  'new mexico',
  'new york',
  'north carolina',
  'north dakota',
  'ohio',
  'oklahoma',
  'oregon',
  'pennsylvania',
  'rhode island',
  'south carolina',
  'south dakota',
  'tennessee',
  'texas',
  'utah',
  'vermont',
  'virginia',
  'washington',
  'west virginia',
  'wisconsin',
  'wyoming',
];
const US_WORDS = ['usa', 'us', 'u.s', 'u.s.a', 'united states', 'mi', 'mich'];
const CA_PROVINCES = [
  'ontario',
  'quebec',
  'british columbia',
  'alberta',
  'manitoba',
  'saskatchewan',
  'nova scotia',
  'new brunswick',
  'newfoundland and labrador',
  'prince edward island',
  'canada',
  'on',
  'ont',
];

const norm = (s: string) => s.trim().toLowerCase().replace(/\.$/, '').replace(/\s+/g, ' ');

/** The metro of a point's Census county and state, if it is one listed here. */
export function metroForCounty(county?: string, state?: string): Metro | undefined {
  if (!county) return undefined;
  const s = state ? norm(state) : undefined;
  return METROS.find(
    (m) =>
      m.country === 'US' &&
      (!s || m.region.includes(s)) &&
      m.counties.some((c) => c.toLowerCase() === county.trim().toLowerCase()),
  );
}

/**
 * The metro a place name is in: a listed city, or a listed county written with "County"
 * ("Ottawa County") or with the metro's state or province ("Ottawa, MI"), and every other comma
 * part either the metro's state/province, one of its counties or its country (so "Lansing,
 * Illinois" is not the Lansing area). A bare county name alone names no metro: many places share
 * one ("Ottawa" is also Ottawa, Ontario; "Oakland" is also Oakland, California).
 */
export function metroForPlace(place: string): Metro | undefined {
  const parts = place.split(',').map(norm).filter(Boolean);
  if (!parts.length) return undefined;
  return METROS.find((m) => {
    const counties = m.counties.map((c) => c.toLowerCase());
    const bare = counties.map((c) => c.replace(/ county$/, ''));
    const country = m.country === 'US' ? US_WORDS : ['canada'];
    const withRegion = parts.some((p) => m.region.includes(p));
    const named = parts.some(
      (p) => m.cities.includes(p) || counties.includes(p) || (withRegion && bare.includes(p)),
    );
    const consistent = parts.every(
      (p) =>
        m.cities.includes(p) ||
        counties.includes(p) ||
        bare.includes(p) ||
        m.region.includes(p) ||
        country.includes(p),
    );
    return named && consistent;
  });
}

/** The country a place name says it is in (a US state, a Canadian province, or the country). */
export function countryForPlace(place: string): CountryCode | undefined {
  const parts = place.split(',').map(norm).slice(1);
  if (parts.some((p) => US_STATES.includes(p) || US_WORDS.includes(p))) return 'US';
  if (parts.some((p) => CA_PROVINCES.includes(p))) return 'CA';
  return undefined;
}
