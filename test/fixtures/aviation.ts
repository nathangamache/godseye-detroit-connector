/**
 * Aviation test fixtures: a synthetic FAA ReleasableAircraft.zip (fictitious registrants only,
 * written the way the FAA writes its files: BOM, padded fields, trailing comma, CRLF, a header
 * with a leading space) and a scripted fetch that records every request.
 */
import { crc32, deflateRawSync } from 'node:zlib';
import { nNumberToIcao, toHex } from '../../src/extra/aviation/nnumber.js';

export interface ZipInput {
  name: string;
  data: Buffer;
  method?: 0 | 8;
  /** Write a wrong CRC-32 (to test the integrity check). */
  badCrc?: boolean;
}

/** A minimal PKZIP archive (no data descriptors, no ZIP64), entries dated 2026-11-13 23:22. */
export function makeZip(entries: ZipInput[]): Buffer {
  const date = ((2026 - 1980) << 9) | (11 << 5) | 13;
  const time = (23 << 11) | (22 << 5);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const method = e.method ?? 8;
    const body = method === 8 ? deflateRawSync(e.data) : e.data;
    const crc = (crc32(e.data) ^ (e.badCrc ? 1 : 0)) >>> 0;
    const name = Buffer.from(e.name);
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0);
    loc.writeUInt16LE(20, 4);
    loc.writeUInt16LE(0, 6);
    loc.writeUInt16LE(method, 8);
    loc.writeUInt16LE(time, 10);
    loc.writeUInt16LE(date, 12);
    loc.writeUInt32LE(crc, 14);
    loc.writeUInt32LE(body.length, 18);
    loc.writeUInt32LE(e.data.length, 22);
    loc.writeUInt16LE(name.length, 26);
    loc.writeUInt16LE(0, 28);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(time, 12);
    cen.writeUInt16LE(date, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(e.data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    locals.push(loc, name, body);
    centrals.push(cen, name);
    offset += loc.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/** FAA layout: BOM, comma-delimited, fields padded with spaces, a trailing comma, CRLF. */
export function faaText(header: string[], rows: string[][], widths: number[] = []): Buffer {
  const line = (fields: string[]) =>
    fields.map((f, i) => f.padEnd(widths[i] ?? f.length + 2)).join(',') + ',\r\n';
  return Buffer.from('\ufeff' + header.join(',') + ',\r\n' + rows.map(line).join(''), 'utf8');
}

export const MASTER_HEADER = [
  'N-NUMBER',
  'SERIAL NUMBER',
  'MFR MDL CODE',
  'ENG MFR MDL',
  'YEAR MFR',
  'TYPE REGISTRANT',
  'NAME',
  'STREET',
  'STREET2',
  'CITY',
  'STATE',
  'ZIP CODE',
  'REGION',
  'COUNTY',
  'COUNTRY',
  'LAST ACTION DATE',
  'CERT ISSUE DATE',
  'CERTIFICATION',
  'TYPE AIRCRAFT',
  'TYPE ENGINE',
  'STATUS CODE',
  'MODE S CODE',
  'FRACT OWNER',
  'AIR WORTH DATE',
  'OTHER NAMES(1)',
  'OTHER NAMES(2)',
  'OTHER NAMES(3)',
  'OTHER NAMES(4)',
  'OTHER NAMES(5)',
  'EXPIRATION DATE',
  'UNIQUE ID',
  'KIT MFR',
  ' KIT MODEL',
  'MODE S CODE HEX',
];

export interface FakeAircraft {
  n: string;
  type: string;
  name: string;
  city: string;
  state: string;
  mfrMdl?: string;
  typeAircraft?: string;
  status?: string;
  year?: string;
  certification?: string;
  /** Leave MODE S CODE HEX blank (the octal code is still written). */
  noHex?: boolean;
  /** Leave both Mode S columns blank (only the N-number algorithm can link it). */
  noModeS?: boolean;
}

/** Street, ZIP and co-owner values that must never reach the registry copy. */
export const SECRET_STREET = '123 EXAMPLE PRIVATE LANE';
export const SECRET_ZIP = '00999-1234';
export const SECRET_COOWNER = 'COOWNER EXAMPLE PERSON';
/**
 * A CITY the way the FAA sometimes fills it for a registrant abroad (STATE blank): a postal
 * code, or a house number, in front of the town. Neither may be shown or stored.
 */
export const SECRET_POSTCODE = 'A-98765';
export const SECRET_POSTCODE_CITY = `${SECRET_POSTCODE} EXAMPLESTADT`;

export function masterRow(a: FakeAircraft): string[] {
  const n = a.n.replace(/^N/, '');
  const icao = nNumberToIcao(n)!;
  const row = new Map<string, string>([
    ['N-NUMBER', n],
    ['SERIAL NUMBER', `SN-${n}`],
    ['MFR MDL CODE', a.mfrMdl ?? '2072738'],
    ['ENG MFR MDL', '41514'],
    ['YEAR MFR', a.year ?? '2005'],
    ['TYPE REGISTRANT', a.type],
    ['NAME', a.name],
    ['STREET', a.name ? SECRET_STREET : ''],
    ['STREET2', ''],
    ['CITY', a.city],
    ['STATE', a.state],
    ['ZIP CODE', a.name ? SECRET_ZIP : ''],
    ['REGION', 'C'],
    ['COUNTY', '163'],
    ['COUNTRY', 'US'],
    ['LAST ACTION DATE', '20240115'],
    ['CERT ISSUE DATE', '20190610'],
    ['CERTIFICATION', a.certification ?? '1N'],
    ['TYPE AIRCRAFT', a.typeAircraft ?? '4'],
    ['TYPE ENGINE', '1'],
    ['STATUS CODE', a.status ?? 'V'],
    ['MODE S CODE', a.noModeS ? '' : icao.toString(8).padStart(8, '0')],
    ['FRACT OWNER', ''],
    ['AIR WORTH DATE', '20050506'],
    ['OTHER NAMES(1)', a.type === '4' ? SECRET_COOWNER : ''],
    ['OTHER NAMES(2)', ''],
    ['OTHER NAMES(3)', ''],
    ['OTHER NAMES(4)', ''],
    ['OTHER NAMES(5)', ''],
    ['EXPIRATION DATE', '20310630'],
    ['UNIQUE ID', '00999999'],
    ['KIT MFR', ''],
    [' KIT MODEL', ''],
    ['MODE S CODE HEX', a.noHex || a.noModeS ? '' : toHex(icao)],
  ]);
  return MASTER_HEADER.map((h) => row.get(h) ?? '');
}

export const ACFTREF_HEADER = [
  'CODE',
  'MFR',
  'MODEL',
  'TYPE-ACFT',
  'TYPE-ENG',
  'AC-CAT',
  'BUILD-CERT-IND',
  'NO-ENG',
  'NO-SEATS',
  'AC-WEIGHT',
  'SPEED',
  'TC-DATA-SHEET',
  'TC-DATA-HOLDER',
];

export const ACFTREF_ROWS = [
  ['2072738', 'CESSNA', '172S', '4', '1 ', '1', '0', '01', '004', 'CLASS 1', '0124', '3A12', ''],
  ['1152020', 'BELL', '407', '6', '3 ', '1', '0', '01', '007', 'CLASS 1', '0133', 'H2SW', ''],
  [
    '138A00Z',
    'BOEING',
    '737-800',
    '5',
    '5 ',
    '1',
    '0',
    '02',
    '189',
    'CLASS 3',
    '0453',
    'A16WE',
    '',
  ],
  ['05600AN', 'EXAMPLE UAS', 'QUAD-1', '6', '10', '1', '1', '04', '000', 'CLASS 4', '0000', '', ''],
];

export const ENGINE_HEADER = ['CODE', 'MFR', 'MODEL', 'TYPE', 'HORSEPOWER', 'THRUST'];
export const ENGINE_ROWS = [['41514', 'LYCOMING', 'IO-360-L2A', '1 ', '00180', '000000']];

/** The fictitious registry used across the aviation tests. */
export const FAKE_FLEET: FakeAircraft[] = [
  { n: 'N101AA', type: '1', name: 'PRIVATE EXAMPLE PERSON', city: 'LANSING', state: 'MI' },
  {
    n: 'N202SP',
    type: '5',
    name: 'EXAMPLE COUNTY SHERIFF OFFICE',
    city: 'DETROIT',
    state: 'MI',
    mfrMdl: '1152020',
    typeAircraft: '6',
    certification: '3 5',
  },
  { n: 'N303CC', type: '3', name: 'EXAMPLE CHARTER CORP', city: 'GRAND RAPIDS', state: 'MI' },
  { n: 'N404LL', type: '7', name: 'EXAMPLE HOLDINGS LLC', city: 'DETROIT', state: 'MI' },
  { n: 'N505WH', type: '1', name: '', city: '', state: '' },
  { n: 'N606CW', type: '4', name: 'COOWNED EXAMPLE PERSON', city: 'FLINT', state: 'MI' },
  {
    n: 'N707AL',
    type: '3',
    name: 'EXAMPLE AIRLINES INC',
    city: 'DETROIT',
    state: 'MI',
    mfrMdl: '138A00Z',
    typeAircraft: '5',
  },
  {
    n: 'N808UA',
    type: '5',
    name: 'EXAMPLE STATE UNIVERSITY',
    city: 'LANSING',
    state: 'MI',
    mfrMdl: '05600AN',
    typeAircraft: '6',
  },
  { n: 'N909NH', type: '7', name: 'EXAMPLE NOHEX LLC', city: 'DETROIT', state: 'MI', noHex: true },
  {
    n: 'N919NM',
    type: '3',
    name: 'EXAMPLE NOMODES CORP',
    city: 'DETROIT',
    state: 'MI',
    noModeS: true,
  },
  // A private registrant abroad whose CITY holds a postal code (STATE blank).
  { n: 'N111FR', type: '1', name: 'ABROAD EXAMPLE PERSON', city: SECRET_POSTCODE_CITY, state: '' },
];

export function fakeRegistryZip(
  fleet: FakeAircraft[] = FAKE_FLEET,
  opts: { badCrc?: boolean; noAcftref?: boolean } = {},
): Buffer {
  const entries: ZipInput[] = [
    ...(opts.noAcftref
      ? []
      : [{ name: 'ACFTREF.txt', data: faaText(ACFTREF_HEADER, ACFTREF_ROWS, [7, 30, 20]) }]),
    { name: 'ENGINE.txt', data: faaText(ENGINE_HEADER, ENGINE_ROWS, [5, 10, 13]) },
    { name: 'DEREG.txt', data: faaText(['N-NUMBER', 'NAME'], [['505WH', 'DEREG EXAMPLE PERSON']]) },
    {
      name: 'MASTER.txt',
      data: faaText(
        MASTER_HEADER,
        fleet.map(masterRow),
        [5, 30, 7, 5, 4, 1, 50, 33, 33, 18, 2, 10],
      ),
      badCrc: opts.badCrc,
    },
  ];
  return makeZip(entries);
}

export interface Recorded {
  url: string;
  headers: Record<string, string>;
}

export type Responder = (url: string, call: number) => Response | Promise<Response> | 'timeout';

/** A fetch that answers from `respond` and records each request (url + headers). */
export function scriptedFetch(respond: Responder): typeof fetch & { calls: Recorded[] } {
  const calls: Recorded[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    calls.push({ url, headers });
    const r = await respond(url, calls.length);
    if (r === 'timeout') {
      // Wait for the caller's timeout to abort the request.
      await new Promise<never>((_resolve, reject) => {
        const s = init?.signal;
        if (s?.aborted) return reject(s.reason);
        s?.addEventListener('abort', () => reject(s.reason), { once: true });
      });
    }
    return r as Response;
  }) as typeof fetch & { calls: Recorded[] };
  f.calls = calls;
  return f;
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
