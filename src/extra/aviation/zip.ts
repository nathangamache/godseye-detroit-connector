/**
 * Just enough ZIP reading for the FAA registry archive, with the standard library only: the
 * central directory is read from the end of the file, and each wanted entry is streamed
 * through zlib's raw inflate with its CRC-32 and size checked. No ZIP64, no encryption.
 */
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { Transform, type Readable } from 'node:stream';
import { createInflateRaw, crc32 } from 'node:zlib';

export interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  crc32: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
  /** The entry's DOS timestamp as written (the archiver's local time), "YYYY-MM-DDTHH:MM". */
  modified?: string;
}

export class ZipError extends Error {}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
const MAX_CENTRAL_DIRECTORY = 4 * 1024 * 1024;

function dosTime(date: number, time: number): string | undefined {
  const y = 1980 + (date >> 9);
  const mo = (date >> 5) & 0xf;
  const d = date & 0x1f;
  if (mo < 1 || mo > 12 || d < 1) return undefined;
  const h = time >> 11;
  const mi = (time >> 5) & 0x3f;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${y}-${p(mo)}-${p(d)}T${p(h)}:${p(mi)}`;
}

/** Lists the archive's entries from its central directory. */
export async function readZipEntries(file: string): Promise<ZipEntry[]> {
  const fh = await open(file, 'r');
  try {
    const { size } = await fh.stat();
    if (size < 22) throw new ZipError('not a zip archive (too short)');
    const tailLen = Math.min(size, 22 + 0xffff);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new ZipError('not a zip archive (no end of central directory)');
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff)
      throw new ZipError('ZIP64 archives are not supported');
    if (cdSize > MAX_CENTRAL_DIRECTORY || cdOffset + cdSize > size)
      throw new ZipError('central directory out of range');
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);
    const entries: ZipEntry[] = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== CEN_SIG)
        throw new ZipError('corrupt central directory');
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const entry: ZipEntry = {
        flags: cd.readUInt16LE(p + 8),
        method: cd.readUInt16LE(p + 10),
        modified: dosTime(cd.readUInt16LE(p + 14), cd.readUInt16LE(p + 12)),
        crc32: cd.readUInt32LE(p + 16),
        compressedSize: cd.readUInt32LE(p + 20),
        size: cd.readUInt32LE(p + 24),
        localHeaderOffset: cd.readUInt32LE(p + 42),
        name: cd.toString('utf8', p + 46, p + 46 + nameLen),
      };
      if (entry.compressedSize === 0xffffffff || entry.size === 0xffffffff)
        throw new ZipError('ZIP64 entries are not supported');
      entries.push(entry);
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } finally {
    await fh.close();
  }
}

/** The uncompressed bytes of one entry, CRC-32 and size checked as they stream. */
export async function openZipEntry(file: string, entry: ZipEntry): Promise<Readable> {
  if (entry.flags & 1) throw new ZipError(`${entry.name} is encrypted`);
  if (entry.method !== 0 && entry.method !== 8)
    throw new ZipError(`${entry.name} uses unsupported compression method ${entry.method}`);
  const fh = await open(file, 'r');
  let start: number;
  try {
    const head = Buffer.alloc(30);
    await fh.read(head, 0, 30, entry.localHeaderOffset);
    if (head.readUInt32LE(0) !== LOC_SIG) throw new ZipError(`bad local header for ${entry.name}`);
    start = entry.localHeaderOffset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
  } finally {
    await fh.close();
  }
  const raw = createReadStream(file, {
    start,
    end: Math.max(start, start + entry.compressedSize - 1),
    highWaterMark: 256 * 1024,
  });
  let crc = 0;
  let total = 0;
  const check = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      total += chunk.length;
      if (total > entry.size) return cb(new ZipError(`${entry.name} is longer than declared`));
      crc = crc32(chunk, crc);
      cb(null, chunk);
    },
    flush(cb) {
      if (total !== entry.size) return cb(new ZipError(`${entry.name} is truncated`));
      if (crc >>> 0 !== entry.crc32 >>> 0) return cb(new ZipError(`${entry.name} fails its CRC`));
      cb();
    },
  });
  const forward = (err: Error) => check.destroy(err);
  raw.on('error', forward);
  if (entry.method === 0) return raw.pipe(check);
  const inflate = createInflateRaw();
  inflate.on('error', (err) => check.destroy(new ZipError(`${entry.name}: ${err.message}`)));
  return raw.pipe(inflate).pipe(check);
}
