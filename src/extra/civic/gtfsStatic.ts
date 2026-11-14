/**
 * SMART's static GTFS schedule, for the two things GTFS-Realtime vehicle positions lack: route
 * names and trip headsigns. Only routes.txt and trips.txt are read (straight from the zip's
 * central directory, no dependency); the result lives in memory and is refreshed at most daily.
 */
import { inflateRawSync } from 'node:zlib';

export const SMART_STATIC_GTFS_URL = 'https://apps1.smartbus.org/gtfs/smart_gtfs.zip';

export class ZipError extends Error {}

const u16 = (b: Buffer, o: number) => {
  if (o + 2 > b.length) throw new ZipError('truncated zip');
  return b.readUInt16LE(o);
};
const u32 = (b: Buffer, o: number) => {
  if (o + 4 > b.length) throw new ZipError('truncated zip');
  return b.readUInt32LE(o);
};

/**
 * The named members of a zip (matched on their base name), decompressed. Stored and deflated
 * members only; no ZIP64. `maxBytes` caps each decompressed member.
 */
export function readZipMembers(
  zip: Buffer,
  names: string[],
  maxBytes: number,
): Map<string, Buffer> {
  // End of central directory: 22 bytes plus a comment of at most 65535.
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65_535); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('not a zip file');
  const count = u16(zip, eocd + 10);
  let p = u32(zip, eocd + 16);
  const want = new Set(names);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count && out.size < want.size; i++) {
    if (u32(zip, p) !== 0x02014b50) throw new ZipError('bad central directory');
    const method = u16(zip, p + 10);
    const csize = u32(zip, p + 20);
    const usize = u32(zip, p + 24);
    const nlen = u16(zip, p + 28);
    const xlen = u16(zip, p + 30);
    const clen = u16(zip, p + 32);
    const local = u32(zip, p + 42);
    const name = zip.subarray(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + xlen + clen;
    const base = name.split('/').pop() ?? name;
    if (!want.has(base) || out.has(base)) continue;
    if (csize === 0xffffffff || usize === 0xffffffff || local === 0xffffffff)
      throw new ZipError('ZIP64 is not supported');
    if (usize > maxBytes) throw new ZipError(`${base} is too large`);
    if (u32(zip, local) !== 0x04034b50) throw new ZipError('bad local header');
    const start = local + 30 + u16(zip, local + 26) + u16(zip, local + 28);
    if (start + csize > zip.length) throw new ZipError('truncated zip');
    const raw = zip.subarray(start, start + csize);
    if (method === 0) out.set(base, Buffer.from(raw));
    else if (method === 8) out.set(base, inflateRawSync(raw, { maxOutputLength: maxBytes }));
    else throw new ZipError(`unsupported compression method ${method}`);
  }
  return out;
}

/** RFC 4180 CSV -> rows of objects keyed by the header row (BOM and CRLF tolerated). */
export function parseCsv(text: string, maxRows = 200_000): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
      if (rows.length > maxRows) throw new Error('too many rows');
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...body] = rows;
  if (!header) return [];
  const keys = header.map((h) => h.trim());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}

export interface ScheduleNames {
  routes: Map<string, { short?: string; long?: string }>;
  trips: Map<string, { headsign?: string; route_id?: string; direction_id?: number }>;
}

/** routes.txt and trips.txt of a GTFS zip -> lookup maps. */
export function scheduleNames(zip: Buffer): ScheduleNames {
  const files = readZipMembers(zip, ['routes.txt', 'trips.txt'], 16 * 1024 * 1024);
  const routesTxt = files.get('routes.txt');
  const tripsTxt = files.get('trips.txt');
  if (!routesTxt || !tripsTxt) throw new ZipError('routes.txt or trips.txt missing');
  const routes = new Map<string, { short?: string; long?: string }>();
  for (const r of parseCsv(routesTxt.toString('utf8'))) {
    if (r.route_id)
      routes.set(r.route_id, {
        short: r.route_short_name || undefined,
        long: r.route_long_name || undefined,
      });
  }
  const trips = new Map<string, { headsign?: string; route_id?: string; direction_id?: number }>();
  for (const t of parseCsv(tripsTxt.toString('utf8'))) {
    if (!t.trip_id) continue;
    const dir = Number(t.direction_id);
    trips.set(t.trip_id, {
      headsign: t.trip_headsign || undefined,
      route_id: t.route_id || undefined,
      direction_id: t.direction_id !== '' && Number.isInteger(dir) ? dir : undefined,
    });
  }
  return { routes, trips };
}
