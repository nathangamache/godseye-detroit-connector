/**
 * What a result may say about an aircraft's registered owner, and the rest of an FAA record in
 * plain words.
 *
 * Owner rules (AIRCRAFT_OWNER_DISCLOSURE, default private_hidden):
 *  - government registrants: name, city and state, always (they cannot ask the FAA to withhold);
 *  - corporations, LLCs, non-citizen corporations: name, city and state in a single-aircraft
 *    lookup; in a list (flights_near) the registrant type, city and state only;
 *  - individuals, co-owners, partnerships: "private individual" / "private owners" plus city and
 *    state (private_hidden), the label alone (type_only), or the name only in a single-aircraft
 *    lookup (full);
 *  - LADD aircraft (AIRCRAFT_LADD_WITHHOLD, default true): no owner name unless government;
 *  - an owner the FAA file leaves blank stays blank (likely withheld at the owner's request under
 *    49 U.S.C. 44114(b)): never filled from deregistered records, old copies or a live feed.
 * No street address or ZIP code exists anywhere in the copy, so none can be shown.
 */
import {
  AIRCRAFT_CATEGORIES,
  AIRCRAFT_TYPES,
  BUILDER_CERTIFICATION,
  ENGINE_TYPES,
  REGISTRANT_TYPES,
  STATUS_CODES,
  WEIGHT_CLASSES,
  decodeCertification,
  faaDate,
} from './codes.js';
import { cleanText } from './http.js';
import type { RegistryRecord } from './registry-store.js';

export const OWNER_DISCLOSURES = ['private_hidden', 'type_only', 'full'] as const;
export type OwnerDisclosure = (typeof OWNER_DISCLOSURES)[number];

export interface OwnerPolicy {
  disclosure: OwnerDisclosure;
  laddWithhold: boolean;
}

/** Words in a government registrant's name that point to a police or similar agency. */
const LAW_ENFORCEMENT =
  /\b(POLICE|SHERIFFS?|STATE PATROL|HIGHWAY PATROL|PUBLIC SAFETY|LAW ENFORCEMENT|MARSHALS?|CUSTOMS|BORDER PROTECTION|HOMELAND SECURITY|DRUG ENFORCEMENT|BUREAU OF INVESTIGATION|CONSERVATION OFFICERS?)\b/i;

export interface OwnerView {
  registrant_type?: string;
  registrant_kind: 'private' | 'organization' | 'government' | 'unknown';
  /** A name, or a label such as "private individual". Absent when there is none to show. */
  owner?: string;
  owner_is_name: boolean;
  city?: string;
  state?: string;
  government: boolean;
  /** Government registrant whose name contains police/sheriff/patrol-type words. */
  law_enforcement_hint?: boolean;
  /** Why a name is not shown. */
  withheld?: 'faa_blank' | 'ladd' | 'policy' | 'not_stored' | 'list';
  note?: string;
}

const text = (v: string | null | undefined, max = 60) => cleanText(v ?? undefined, max);

export function ownerView(
  rec: RegistryRecord,
  policy: OwnerPolicy,
  ladd: boolean,
  context: 'lookup' | 'list',
): OwnerView {
  const t = rec.type_registrant ?? '';
  const def = REGISTRANT_TYPES[t];
  const kind: OwnerView['registrant_kind'] = def?.kind ?? 'unknown';
  const base = {
    ...(def ? { registrant_type: def.label } : {}),
    registrant_kind: kind,
    government: kind === 'government',
  };
  const place = { city: text(rec.city, 30), state: text(rec.state, 2) };
  if (rec.name_blank) {
    return {
      ...base,
      owner_is_name: false,
      ...place,
      withheld: 'faa_blank',
      note: def
        ? "The FAA file has no owner name for this registration, most likely withheld at the owner's request (49 U.S.C. 44114(b)). It is not filled in from any other source."
        : 'No owner on file: the N-number is assigned or reserved but not registered.',
    };
  }
  const name = text(rec.name, 50);
  if (kind === 'government') {
    const le = Boolean(name && LAW_ENFORCEMENT.test(name));
    return {
      ...base,
      ...(name ? { owner: name } : {}),
      owner_is_name: Boolean(name),
      ...place,
      ...(le ? { law_enforcement_hint: true } : {}),
      note: le
        ? 'Government-registered, and the name points to a police or similar agency. The registered owner is not necessarily who is flying it.'
        : 'Government-registered (a city, county, state or federal body). The registered owner is not necessarily who is flying it.',
    };
  }
  const laddNote =
    'The aircraft is on the FAA LADD list (its owner asked to limit display), so the owner name is withheld (AIRCRAFT_LADD_WITHHOLD).';
  if (kind === 'organization') {
    if (context === 'list')
      return {
        ...base,
        owner: def!.label,
        owner_is_name: false,
        ...place,
        withheld: 'list',
      };
    if (ladd && policy.laddWithhold)
      return { ...base, owner_is_name: false, ...place, withheld: 'ladd', note: laddNote };
    return { ...base, ...(name ? { owner: name } : {}), owner_is_name: Boolean(name), ...place };
  }
  // Individuals, co-owners, partnerships (and unknown types, treated the same way).
  const label = def?.privateLabel ?? 'private owner';
  if (policy.disclosure === 'type_only')
    return { ...base, owner: label, owner_is_name: false, withheld: 'policy' };
  if (policy.disclosure === 'full' && context === 'lookup') {
    if (ladd && policy.laddWithhold)
      return {
        ...base,
        owner: label,
        owner_is_name: false,
        ...place,
        withheld: 'ladd',
        note: laddNote,
      };
    if (name) return { ...base, owner: name, owner_is_name: true, ...place };
    return {
      ...base,
      owner: label,
      owner_is_name: false,
      ...place,
      withheld: 'not_stored',
      note: 'Private owner names are kept only after the next registry sync under AIRCRAFT_OWNER_DISCLOSURE=full.',
    };
  }
  return { ...base, owner: label, owner_is_name: false, ...place, withheld: 'policy' };
}

/** Would `ownerView` show a non-government name if the aircraft were not on LADD? */
export function wouldShowName(rec: RegistryRecord, policy: OwnerPolicy): boolean {
  if (rec.name_blank) return false;
  const kind = REGISTRANT_TYPES[rec.type_registrant ?? '']?.kind ?? 'unknown';
  if (kind === 'organization') return true;
  if (kind === 'government') return false;
  return policy.disclosure === 'full';
}

const label = (table: Record<string, string>, code: string | null | undefined) => {
  const c = (code ?? '').trim();
  return c ? { code: c, label: table[c] ?? 'unknown code' } : undefined;
};

/** The FAA long type name ("CESSNA 172S"), when the reference file has the model. */
export function faaTypeName(rec: RegistryRecord): string | undefined {
  return text([rec.ref_mfr, rec.ref_model].filter(Boolean).join(' '), 60);
}

export function isDrone(rec: RegistryRecord): boolean {
  return (rec.ref_ac_weight ?? '').trim().toUpperCase() === 'CLASS 4';
}

/** The whole record for aircraft_lookup (owner per the rules above). */
export function recordView(rec: RegistryRecord, owner: OwnerView): Record<string, unknown> {
  const cert = decodeCertification(rec.certification);
  const weight = (rec.ref_ac_weight ?? '').trim().toUpperCase();
  const status = (rec.status_code ?? '').trim();
  const engine = {
    manufacturer: text(rec.eng_mfr, 30),
    model: text(rec.eng_model, 30),
    ...(rec.eng_horsepower ? { horsepower: rec.eng_horsepower } : {}),
    ...(rec.eng_thrust ? { thrust_lb: rec.eng_thrust } : {}),
  };
  return {
    n_number: `N${rec.n_number}`,
    mode_s_hex: rec.mode_s_hex ?? undefined,
    serial_number: text(rec.serial, 30),
    manufacturer: text(rec.ref_mfr, 30),
    model: text(rec.ref_model, 30),
    mfr_mdl_code: rec.mfr_mdl_code ?? undefined,
    year_manufactured: rec.year_mfr ?? undefined,
    aircraft_type: label(AIRCRAFT_TYPES, rec.type_aircraft)?.label,
    engine_type: label(ENGINE_TYPES, rec.type_engine)?.label,
    engine: engine.manufacturer || engine.model ? engine : undefined,
    engines: rec.ref_no_eng ?? undefined,
    seats: rec.ref_no_seats ?? undefined,
    category: label(AIRCRAFT_CATEGORIES, rec.ref_ac_cat)?.label,
    builder_certification: label(BUILDER_CERTIFICATION, rec.ref_build_cert_ind)?.label,
    weight_class: weight ? (WEIGHT_CLASSES[weight] ?? weight) : undefined,
    cruise_speed_mph: rec.ref_speed || undefined,
    ...(isDrone(rec) ? { drone: true } : {}),
    ...(rec.kit_mfr || rec.kit_model
      ? { kit: { manufacturer: text(rec.kit_mfr, 30), model: text(rec.kit_model, 30) } }
      : {}),
    registrant: owner,
    status: status ? { code: status, label: STATUS_CODES[status] ?? 'unknown code' } : undefined,
    airworthiness: cert
      ? { ...cert, date: faaDate(rec.air_worth_date) }
      : faaDate(rec.air_worth_date)
        ? { date: faaDate(rec.air_worth_date) }
        : undefined,
    certificate_issued: faaDate(rec.cert_issue_date),
    registration_expires: faaDate(rec.expiration_date),
    last_action: faaDate(rec.last_action_date),
    ...((rec.fract_owner ?? '').trim().toUpperCase() === 'Y' ? { fractional_ownership: true } : {}),
  };
}

/** One line about the owner, for summaries. */
export function ownerSentence(o: OwnerView): string {
  const where = [o.city, o.state].filter(Boolean).join(', ');
  const at = where ? `, ${where}` : '';
  const type = o.registrant_type ? ` (${o.registrant_type})` : '';
  if (o.withheld === 'faa_blank')
    return `no owner name on file${o.registrant_type ? ` (registrant type ${o.registrant_type}; likely withheld at the owner's request)` : ''}`;
  if (o.government)
    return `GOVERNMENT-REGISTERED: ${o.owner ?? 'name not given'}${at}${o.law_enforcement_hint ? ' (police/sheriff-type agency)' : ''}`;
  if (o.withheld === 'ladd') return `owner name withheld (LADD)${type}${at}`;
  if (o.owner_is_name) return `registered to ${o.owner}${type}${at}`;
  return `registrant: ${o.owner ?? 'not shown'}${at}`;
}
