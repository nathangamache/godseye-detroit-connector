/**
 * US N-numbers and their ICAO 24-bit (Mode S) addresses.
 *
 * Written from the published allocation scheme, not from any existing implementation: the US
 * block A00000-AFFFFF assigns A00001 (N1) through ADF7C7 (N99999) in N-number order. Under each
 * leading digit string come first its letter suffixes (none, then A, AA, AB .. AZ, B, BA ..; at
 * most two letters, never I or O), then its ten one-digit-longer children. Only one letter may
 * follow four digits and none may follow five. That gives fixed block sizes: 35 under a
 * four-digit number (itself, 24 letters, 10 five-digit children), 951 under three digits,
 * 10,111 under two and 101,711 under one, and 9 x 101,711 = 915,399 civil addresses.
 * ADF7C8-AFFFFF has no N-numbers (US military and federal use, per community data).
 */

/** Suffix letters: A-Z without I and O. */
export const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITS = '0123456789';

/** One leading-digit string's suffix slots: none, then 24 x (letter, letter + 24 letters). */
const SUFFIX_SLOTS = 1 + LETTERS.length * (1 + LETTERS.length); // 601
const SIZE4 = 1 + LETTERS.length + DIGITS.length; // 35
const SIZE3 = SUFFIX_SLOTS + DIGITS.length * SIZE4; // 951
const SIZE2 = SUFFIX_SLOTS + DIGITS.length * SIZE3; // 10,111
const SIZE1 = SUFFIX_SLOTS + DIGITS.length * SIZE2; // 101,711
/** Child block size below a number with this many digits (index = digit count). */
const CHILD_SIZE = [0, SIZE2, SIZE3, SIZE4];

export const US_BLOCK_FIRST = 0xa00000;
export const US_BLOCK_LAST = 0xafffff;
export const US_CIVIL_FIRST = 0xa00001;
export const US_CIVIL_LAST = US_CIVIL_FIRST + 9 * SIZE1 - 1; // 0xADF7C7

/** FAA forms: 1-5 digits, 1-4 digits + 1 letter, 1-3 digits + 2 letters; no leading 0, I or O. */
const N_NUMBER = /^(?:[1-9]\d{0,4}|[1-9]\d{0,3}[A-HJ-NP-Z]|[1-9]\d{0,2}[A-HJ-NP-Z]{2})$/;

/** "n12345", " N 123ab " -> "N12345", "N123AB"; null if not a valid US N-number. */
export function normalizeNNumber(input: string): string | null {
  const s = input.trim().toUpperCase().replace(/[\s-]/g, '');
  const body = s.startsWith('N') ? s.slice(1) : s;
  return N_NUMBER.test(body) ? `N${body}` : null;
}

/** Looks like a US registration attempt (starts with N then a digit), valid or not. */
export function looksLikeNNumber(input: string): boolean {
  return /^N[\s-]?\d/i.test(input.trim());
}

function suffixAt(slot: number): string {
  if (slot === 0) return '';
  const i = slot - 1;
  const first = LETTERS[Math.floor(i / (LETTERS.length + 1))]!;
  const second = i % (LETTERS.length + 1);
  return second === 0 ? first : first + LETTERS[second - 1]!;
}

function slotOf(suffix: string): number {
  if (!suffix) return 0;
  const a = LETTERS.indexOf(suffix[0]!);
  const b = suffix.length > 1 ? LETTERS.indexOf(suffix[1]!) + 1 : 0;
  return 1 + a * (LETTERS.length + 1) + b;
}

/** ICAO address (number) -> "N12345", or null outside A00001-ADF7C7. */
export function icaoToNNumber(icao: number): string | null {
  if (!Number.isInteger(icao) || icao < US_CIVIL_FIRST || icao > US_CIVIL_LAST) return null;
  let off = icao - US_CIVIL_FIRST;
  let out = 'N' + DIGITS[Math.floor(off / SIZE1) + 1];
  off %= SIZE1;
  for (let digits = 1; digits <= 3; digits++) {
    if (off < SUFFIX_SLOTS) return out + suffixAt(off);
    off -= SUFFIX_SLOTS;
    const child = CHILD_SIZE[digits]!;
    out += DIGITS[Math.floor(off / child)];
    off %= child;
  }
  // Four digits: itself, one letter, or a fifth digit.
  if (off === 0) return out;
  if (off <= LETTERS.length) return out + LETTERS[off - 1];
  return out + DIGITS[off - LETTERS.length - 1];
}

/** "N12345" (or "12345") -> its ICAO address number, or null if not a valid N-number. */
export function nNumberToIcao(input: string): number | null {
  const n = normalizeNNumber(input);
  if (!n) return null;
  const body = n.slice(1);
  const digits = /^\d+/.exec(body)![0];
  const letters = body.slice(digits.length);
  let off = (Number(digits[0]) - 1) * SIZE1;
  for (let i = 1; i < digits.length; i++) {
    const d = Number(digits[i]);
    off += i < 4 ? SUFFIX_SLOTS + d * CHILD_SIZE[i]! : 1 + LETTERS.length + d;
  }
  if (digits.length < 4) off += slotOf(letters);
  else if (letters) off += 1 + LETTERS.indexOf(letters);
  return US_CIVIL_FIRST + off;
}

/** "a1b2c3" / "~a1b2c3" -> {icao, nonIcao}; null when malformed. */
export function parseHex(input: string): { icao: number; hex: string; nonIcao: boolean } | null {
  const m = /^(~?)([0-9a-f]{6})$/i.exec(input.trim());
  if (!m) return null;
  return { icao: parseInt(m[2]!, 16), hex: m[2]!.toUpperCase(), nonIcao: m[1] === '~' };
}

export const toHex = (icao: number): string => icao.toString(16).toUpperCase().padStart(6, '0');

export type IcaoBlock =
  | { kind: 'us_civil' }
  | { kind: 'us_military_federal' }
  | { kind: 'us_unassigned' }
  | { kind: 'foreign'; country?: string };

/** Allocations near the user's area (ICAO Annex 10 Vol. III); others are just "not US". */
const NEARBY_BLOCKS: Array<{ first: number; last: number; country: string }> = [
  { first: 0xc00000, last: 0xc3ffff, country: 'Canada' },
  { first: 0x0d0000, last: 0x0d7fff, country: 'Mexico' },
];

export function classifyIcao(icao: number): IcaoBlock {
  if (icao >= US_CIVIL_FIRST && icao <= US_CIVIL_LAST) return { kind: 'us_civil' };
  if (icao === US_BLOCK_FIRST) return { kind: 'us_unassigned' };
  if (icao > US_CIVIL_LAST && icao <= US_BLOCK_LAST) return { kind: 'us_military_federal' };
  const hit = NEARBY_BLOCKS.find((b) => icao >= b.first && icao <= b.last);
  return hit ? { kind: 'foreign', country: hit.country } : { kind: 'foreign' };
}
