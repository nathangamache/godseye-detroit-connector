/**
 * Code tables of the FAA Releasable Aircraft Database (registry.faa.gov/database/ardata.pdf)
 * and of the readsb / ADS-B fields the live feeds carry.
 */

/** TYPE REGISTRANT. `kind` decides what the owner disclosure rules may show (owner.ts). */
export const REGISTRANT_TYPES: Record<
  string,
  { label: string; kind: 'private' | 'organization' | 'government'; privateLabel?: string }
> = {
  '1': { label: 'individual', kind: 'private', privateLabel: 'private individual' },
  '2': { label: 'partnership', kind: 'private', privateLabel: 'private owners (partnership)' },
  '3': { label: 'corporation', kind: 'organization' },
  '4': { label: 'co-owned', kind: 'private', privateLabel: 'private owners (co-owned)' },
  '5': { label: 'government', kind: 'government' },
  '7': { label: 'LLC', kind: 'organization' },
  '8': { label: 'non-citizen corporation', kind: 'organization' },
  '9': {
    label: 'non-citizen co-owned',
    kind: 'private',
    privateLabel: 'private owners (co-owned, non-citizen)',
  },
};

export const AIRCRAFT_TYPES: Record<string, string> = {
  '1': 'glider',
  '2': 'balloon',
  '3': 'blimp/dirigible',
  '4': 'fixed wing single engine',
  '5': 'fixed wing multi engine',
  '6': 'rotorcraft',
  '7': 'weight-shift-control',
  '8': 'powered parachute',
  '9': 'gyroplane',
  H: 'hybrid lift',
  O: 'other',
};

export const ENGINE_TYPES: Record<string, string> = {
  '0': 'none',
  '1': 'reciprocating',
  '2': 'turbo-prop',
  '3': 'turbo-shaft',
  '4': 'turbo-jet',
  '5': 'turbo-fan',
  '6': 'ramjet',
  '7': '2 cycle',
  '8': '4 cycle',
  '9': 'unknown',
  '10': 'electric',
  '11': 'rotary',
};

export const STATUS_CODES: Record<string, string> = {
  A: 'triennial registration form mailed, returned by the post office',
  D: 'expired dealer',
  E: 'registration revoked by enforcement action',
  M: 'registered to the manufacturer under its dealer certificate',
  N: 'non-citizen corporation that has not returned its flight hour reports',
  R: 'registration pending',
  S: 'second triennial form mailed, not returned',
  T: 'valid registration from a trainee',
  V: 'valid registration',
  W: 'registration deemed ineffective or invalid',
  X: 'enforcement letter',
  Z: 'permanent reserved',
  '1': 'triennial form returned by the post office as undeliverable',
  '2': 'N-number assigned, not yet registered',
  '3': 'N-number assigned (non-type-certificated aircraft), not yet registered',
  '4': 'N-number assigned (import), not yet registered',
  '5': 'reserved N-number',
  '6': 'administratively cancelled',
  '7': 'sale reported',
  '8': 'second attempt to mail the triennial form, no response',
  '9': 'registration revoked',
  '10': 'N-number assigned, not registered, pending cancellation',
  '11': 'N-number assigned (amateur built), not registered, pending cancellation',
  '12': 'N-number assigned (import), not registered, pending cancellation',
  '13': 'registration expired',
  '14': 'first notice for re-registration/renewal',
  '15': 'second notice for re-registration/renewal',
  '16': 'registration expired, pending cancellation',
  '17': 'sale reported, pending cancellation',
  '18': 'sale reported, cancelled',
  '19': 'registration pending, pending cancellation',
  '20': 'registration pending, cancelled',
  '21': 'revoked, pending cancellation',
  '22': 'revoked, cancelled',
  '23': 'expired dealer, pending cancellation',
  '24': 'third notice for re-registration/renewal',
  '25': 'first notice for registration renewal',
  '26': 'second notice for registration renewal',
  '27': 'registration expired',
  '28': 'third notice for registration renewal',
  '29': 'registration expired, pending cancellation',
};

/** First character of CERTIFICATION: the airworthiness class. */
export const AIRWORTHINESS_CLASSES: Record<string, string> = {
  '1': 'standard',
  '2': 'limited',
  '3': 'restricted',
  '4': 'experimental',
  '5': 'provisional',
  '6': 'multiple',
  '7': 'primary',
  '8': 'special flight permit',
  '9': 'light sport',
};

/** Restricted-category approved operations (class 3, and the ops part of class 6). */
export const RESTRICTED_OPERATIONS: Record<string, string> = {
  '0': 'other',
  '1': 'agriculture and pest control',
  '2': 'aerial surveying',
  '3': 'aerial advertising',
  '4': 'forest',
  '5': 'patrolling',
  '6': 'weather control',
  '7': 'carriage of cargo',
};

export const AIRCRAFT_CATEGORIES: Record<string, string> = {
  '1': 'land',
  '2': 'sea',
  '3': 'amphibian',
};

export const BUILDER_CERTIFICATION: Record<string, string> = {
  '0': 'type certificated',
  '1': 'not type certificated',
  '2': 'light sport',
};

export const WEIGHT_CLASSES: Record<string, string> = {
  'CLASS 1': 'up to 12,499 lb',
  'CLASS 2': '12,500 to 19,999 lb',
  'CLASS 3': '20,000 lb and over',
  'CLASS 4': 'UAV (drone) up to 55 lb',
};

/** ADS-B emitter category (DO-260B), as readsb reports it. */
export const EMITTER_CATEGORIES: Record<string, string> = {
  A0: 'no category information',
  A1: 'light aircraft (under 15,500 lb)',
  A2: 'small aircraft (15,500 to 75,000 lb)',
  A3: 'large aircraft (75,000 to 300,000 lb)',
  A4: 'high-vortex large aircraft (e.g. B757)',
  A5: 'heavy aircraft (over 300,000 lb)',
  A6: 'high-performance aircraft',
  A7: 'rotorcraft (helicopter)',
  B0: 'no category information',
  B1: 'glider or sailplane',
  B2: 'lighter than air',
  B3: 'parachutist or skydiver',
  B4: 'ultralight or paraglider',
  B6: 'unmanned aerial vehicle',
  B7: 'space vehicle',
  C1: 'emergency surface vehicle',
  C2: 'service surface vehicle',
  C3: 'point obstacle',
};

/** readsb "type": where the position came from. */
export const POSITION_SOURCES: Record<string, string> = {
  adsb_icao: 'ADS-B from the aircraft (its own GPS position)',
  adsb_icao_nt: 'ADS-B from a non-transponder emitter',
  adsr_icao: 'ADS-R (ADS-B rebroadcast by the FAA)',
  tisb_icao: 'TIS-B (radar-derived, rebroadcast by the FAA)',
  tisb_trackfile: 'TIS-B track file (radar-derived, no ICAO address)',
  tisb_other: 'TIS-B (radar-derived, other address)',
  adsb_other: 'ADS-B with an anonymous or non-ICAO address',
  adsr_other: 'ADS-R with an anonymous or non-ICAO address',
  mlat: 'MLAT (computed by several ground receivers, not sent by the aircraft)',
  mode_s: 'Mode S only (transponder heard, no position from the aircraft)',
  adsc: 'ADS-C (satellite contract reporting)',
  other: 'other',
  unknown: 'unknown',
};

/** dbFlags bitfield (readsb / tar1090-db): military 1, interesting 2, PIA 4, LADD 8. */
export function decodeDbFlags(v: unknown): {
  military: boolean;
  interesting: boolean;
  pia: boolean;
  ladd: boolean;
} {
  const n = typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : 0;
  return {
    military: (n & 1) !== 0,
    interesting: (n & 2) !== 0,
    pia: (n & 4) !== 0,
    ladd: (n & 8) !== 0,
  };
}

/** "20050506" -> "2005-05-06"; anything else -> undefined. */
export function faaDate(v: string | null | undefined): string | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec((v ?? '').trim());
  if (!m) return undefined;
  const [, y, mo, d] = m;
  if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31) return undefined;
  return `${y}-${mo}-${d}`;
}

/** Decodes CERTIFICATION ("1N", "3 5", "4 2 ...") into class and operations. */
export function decodeCertification(
  raw: string | null | undefined,
): { class?: string; operations?: string[]; raw?: string } | undefined {
  const s = (raw ?? '').trimEnd();
  if (!s.trim()) return undefined;
  const cls = AIRWORTHINESS_CLASSES[s[0]!];
  const rest = s.slice(1).replace(/\s+/g, '');
  let operations: string[] | undefined;
  if (s[0] === '3' && rest) {
    operations = [...rest].map((c) => RESTRICTED_OPERATIONS[c] ?? `code ${c}`);
  } else if (s[0] === '6' && rest.length > 1) {
    operations = [...rest.slice(1)].map((c) => RESTRICTED_OPERATIONS[c] ?? `code ${c}`);
  }
  return {
    ...(cls ? { class: cls } : {}),
    ...(operations?.length ? { operations } : {}),
    raw: s.trim(),
  };
}
