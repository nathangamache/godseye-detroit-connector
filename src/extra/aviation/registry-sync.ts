/**
 * Daily copy of the FAA Releasable Aircraft Database into the gateway's data volume.
 *
 * Once a day (about 06:15 UTC; the FAA refreshes the file around 11:30 pm Central) one GET of
 * ReleasableAircraft.zip with an honest generic User-Agent and If-Modified-Since: a 304 costs
 * nothing. A new archive is streamed to DATA_DIR/aviation (not /tmp: it is ~73 MB and /tmp is a
 * small tmpfs in the container), MASTER.txt, ACFTREF.txt and ENGINE.txt are inflated as streams
 * (CRC-checked) into a NEW SQLite file, sanity-checked, fsynced and renamed over the old one in
 * one step. Any failure leaves the last good copy in place. The archive (it holds addresses) is
 * deleted as soon as the import ends. Street, ZIP, county, co-owner names and unique ids are
 * never read into the copy, and private registrants' names only with
 * AIRCRAFT_OWNER_DISCLOSURE=full. Never fetched per request, never with a browser User-Agent.
 */
import { closeSync, createWriteStream, fsyncSync, openSync, writeFileSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import Database from 'better-sqlite3';
import type { Logger } from '../../log.js';
import { REGISTRANT_TYPES } from './codes.js';
import { REGISTRY_USER_AGENT, type FetchFn } from './http.js';
import { registrantCity } from './owner.js';
import {
  REGISTRY_FILE,
  REGISTRY_INDEXES,
  REGISTRY_SCHEMA,
  REGISTRY_SCHEMA_VERSION,
  type RegistryStore,
} from './registry-store.js';
import { openZipEntry, readZipEntries, type ZipEntry } from './zip.js';

export const FAA_REGISTRY_URL = 'https://registry.faa.gov/database/ReleasableAircraft.zip';

export interface ImportOptions {
  storePrivateNames: boolean;
  /** Refuse an archive with fewer MASTER rows (a truncated or changed file). */
  minRows: number;
  /** The current copy's row count: a new one must have at least half as many. */
  previousRows?: number;
}

export interface ImportResult {
  rows: number;
  acftref: number;
  engine: number;
  skipped: number;
  as_of?: string;
}

export class RegistryImportError extends Error {}

/** Splits a stream of text into batches of lines (CRLF or LF), never holding the whole file. */
async function* lineBatches(stream: Readable): AsyncGenerator<string[]> {
  const decoder = new TextDecoder('utf-8');
  let rest = '';
  for await (const chunk of stream) {
    const text = rest + decoder.decode(chunk as Buffer, { stream: true });
    const lines = text.split('\n');
    rest = lines.pop() ?? '';
    if (rest.length > 64 * 1024) throw new RegistryImportError('a line is longer than 64 KB');
    yield lines;
  }
  const tail = rest + decoder.decode();
  if (tail.trim()) yield [tail];
}

/** One comma-delimited, space-padded FAA line: no quoting, a trailing empty field. */
export function splitFaaLine(line: string): string[] {
  const f = line.replace(/\r$/, '').split(',');
  if (f.length > 1 && f[f.length - 1]!.trim() === '') f.pop();
  return f.map((s) => s.trim());
}

/** Header names, BOM stripped and trimmed (" KIT MODEL"). */
export function parseFaaHeader(line: string): string[] {
  return splitFaaLine(line.replace(/^\ufeff/, '')).map((h) => h.toUpperCase());
}

type Row = (name: string) => string;

/** Streams one entry's rows to `onRow`, a transaction per chunk so the event loop keeps moving. */
async function importEntry(
  file: string,
  entry: ZipEntry,
  db: Database.Database,
  required: string[],
  onRow: (get: Row) => boolean,
): Promise<{ rows: number; skipped: number }> {
  let header: string[] | undefined;
  let index = new Map<string, number>();
  let rows = 0;
  let skipped = 0;
  const stream = await openZipEntry(file, entry);
  for await (const batch of lineBatches(stream)) {
    let start = 0;
    if (!header) {
      if (!batch.length) continue;
      header = parseFaaHeader(batch[0]!);
      index = new Map(header.map((h, i) => [h, i]));
      const missing = required.filter((h) => !index.has(h));
      if (missing.length)
        throw new RegistryImportError(`${entry.name} lacks column(s): ${missing.join(', ')}`);
      start = 1;
    }
    db.transaction(() => {
      for (let i = start; i < batch.length; i++) {
        const line = batch[i]!;
        if (!line.trim()) continue;
        const f = splitFaaLine(line);
        if (f.length !== header!.length) {
          skipped++;
          continue;
        }
        const get: Row = (name) => {
          const j = index.get(name);
          return j === undefined ? '' : f[j]!;
        };
        if (onRow(get)) rows++;
        else skipped++;
      }
    })();
  }
  if (!header) throw new RegistryImportError(`${entry.name} is empty`);
  return { rows, skipped };
}

const orNull = (s: string) => (s === '' ? null : s);
const intOrNull = (s: string) => (/^\d+$/.test(s) ? Number(s) : null);

/** Builds a registry file at `outFile` from the archive at `zipFile`. */
export async function importRegistryZip(
  zipFile: string,
  outFile: string,
  opts: ImportOptions,
): Promise<ImportResult> {
  const entries = await readZipEntries(zipFile);
  const find = (name: string) => entries.find((e) => e.name.toUpperCase() === name);
  const master = find('MASTER.TXT');
  const acftref = find('ACFTREF.TXT');
  const engine = find('ENGINE.TXT');
  if (!master || !acftref)
    throw new RegistryImportError('the archive has no MASTER.txt or ACFTREF.txt');
  await rm(outFile, { force: true });
  const db = new Database(outFile);
  try {
    db.pragma('journal_mode = OFF');
    db.pragma('synchronous = OFF');
    db.pragma('temp_store = MEMORY');
    db.pragma('cache_size = -16000');
    db.exec(REGISTRY_SCHEMA);

    const insRef = db.prepare(
      'INSERT OR REPLACE INTO acftref VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const ref = await importEntry(zipFile, acftref, db, ['CODE', 'MFR', 'MODEL'], (g) => {
      if (!g('CODE')) return false;
      insRef.run(
        g('CODE'),
        orNull(g('MFR')),
        orNull(g('MODEL')),
        orNull(g('TYPE-ACFT')),
        orNull(g('TYPE-ENG')),
        orNull(g('AC-CAT')),
        orNull(g('BUILD-CERT-IND')),
        intOrNull(g('NO-ENG')),
        intOrNull(g('NO-SEATS')),
        orNull(g('AC-WEIGHT')),
        intOrNull(g('SPEED')),
      );
      return true;
    });

    let eng = { rows: 0, skipped: 0 };
    if (engine) {
      const insEng = db.prepare('INSERT OR REPLACE INTO engine VALUES (?, ?, ?, ?, ?, ?)');
      eng = await importEntry(zipFile, engine, db, ['CODE'], (g) => {
        if (!g('CODE')) return false;
        insEng.run(
          g('CODE'),
          orNull(g('MFR')),
          orNull(g('MODEL')),
          orNull(g('TYPE')),
          intOrNull(g('HORSEPOWER')),
          intOrNull(g('THRUST')),
        );
        return true;
      });
    }

    // Only these MASTER columns are ever read. STREET, STREET2, ZIP CODE, COUNTY, COUNTRY,
    // REGION, OTHER NAMES(1-5) and UNIQUE ID are not. A CITY holding a digit (a postal code or
    // house number, for registrants abroad) is not kept either.
    const insAc = db.prepare(
      'INSERT OR IGNORE INTO aircraft VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const ac = await importEntry(
      zipFile,
      master,
      db,
      ['N-NUMBER', 'TYPE REGISTRANT', 'NAME', 'CITY', 'STATE'],
      (g) => {
        const n = g('N-NUMBER').toUpperCase();
        if (!/^[1-9][0-9A-Z]{0,4}$/.test(n)) return false;
        let hex = g('MODE S CODE HEX').toUpperCase();
        if (!/^[0-9A-F]{6}$/.test(hex)) {
          // Fall back to the octal MODE S CODE (the same address in base 8).
          const oct = g('MODE S CODE');
          hex = /^[0-7]{8}$/.test(oct)
            ? parseInt(oct, 8).toString(16).toUpperCase().padStart(6, '0')
            : '';
        }
        const type = g('TYPE REGISTRANT');
        const rawName = g('NAME');
        const isPrivate = REGISTRANT_TYPES[type]?.kind === 'private';
        const keepName = rawName !== '' && (!isPrivate || opts.storePrivateNames);
        const r = insAc.run(
          n,
          orNull(g('SERIAL NUMBER')),
          orNull(g('MFR MDL CODE')),
          orNull(g('ENG MFR MDL')),
          intOrNull(g('YEAR MFR')),
          orNull(type),
          keepName ? rawName : null,
          rawName === '' ? 1 : 0,
          registrantCity(g('CITY')) ?? null,
          orNull(g('STATE')),
          orNull(g('LAST ACTION DATE')),
          orNull(g('CERT ISSUE DATE')),
          orNull(g('CERTIFICATION')),
          orNull(g('TYPE AIRCRAFT')),
          orNull(g('TYPE ENGINE')),
          orNull(g('STATUS CODE')),
          hex || null,
          orNull(g('FRACT OWNER')),
          orNull(g('AIR WORTH DATE')),
          orNull(g('EXPIRATION DATE')),
          orNull(g('KIT MFR')),
          orNull(g('KIT MODEL')),
        );
        return r.changes > 0;
      },
    );

    if (ac.rows < opts.minRows)
      throw new RegistryImportError(`MASTER.txt has ${ac.rows} rows, expected ${opts.minRows}+`);
    if (opts.previousRows && ac.rows < opts.previousRows / 2)
      throw new RegistryImportError(
        `MASTER.txt has ${ac.rows} rows, under half of the current copy's ${opts.previousRows}`,
      );
    if (ref.rows < 1) throw new RegistryImportError('ACFTREF.txt has no rows');
    db.exec(REGISTRY_INDEXES);
    const asOf = master.modified?.slice(0, 10);
    const meta: Record<string, string> = {
      schema_version: REGISTRY_SCHEMA_VERSION,
      rows: String(ac.rows),
      private_names_stored: opts.storePrivateNames ? '1' : '0',
      ...(asOf ? { as_of: asOf } : {}),
    };
    const insMeta = db.prepare('INSERT OR REPLACE INTO meta VALUES (?, ?)');
    db.transaction(() => {
      for (const [k, v] of Object.entries(meta)) insMeta.run(k, v);
    })();
    return {
      rows: ac.rows,
      acftref: ref.rows,
      engine: eng.rows,
      skipped: ac.skipped,
      as_of: asOf,
    };
  } finally {
    db.close();
  }
}

/** Adds meta rows to a finished (closed) registry file. */
function writeMeta(file: string, meta: Record<string, string | undefined>): void {
  const db = new Database(file);
  try {
    db.pragma('journal_mode = DELETE');
    const ins = db.prepare('INSERT OR REPLACE INTO meta VALUES (?, ?)');
    db.transaction(() => {
      for (const [k, v] of Object.entries(meta)) if (v !== undefined) ins.run(k, v);
    })();
  } finally {
    db.close();
  }
}

function fsyncPath(p: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(p, 'r');
    fsyncSync(fd);
  } catch {
    /* best effort (some filesystems refuse to fsync a directory) */
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export type SyncOutcome =
  | { outcome: 'imported'; rows: number; as_of?: string; ms: number }
  | { outcome: 'not_modified'; ms: number }
  | { outcome: 'failed'; reason: string; status?: number; ms: number }
  | { outcome: 'busy' };

export interface SyncState {
  checked_at?: string;
  last_outcome?: string;
  last_error?: string;
  failures?: number;
}

export interface RegistrySyncOptions {
  dir: string;
  url?: string;
  fetch?: FetchFn;
  logger: Logger;
  now?: () => number;
  storePrivateNames: boolean;
  minRows?: number;
  /** Whole download, start to end. */
  timeoutMs?: number;
  maxBytes?: number;
  /** First run after start when the copy is missing or stale. */
  startupDelayMs?: number;
}

const STATE_FILE = 'sync-state.json';
const LOCK_FILE = 'sync.lock';
const ZIP_PART = 'ReleasableAircraft.zip.part';
const DAY_MS = 86_400_000;

/** Milliseconds from `now` to the next hh:mm UTC. */
export function msUntilUtc(now: number, hour: number, minute: number): number {
  const d = new Date(now);
  let next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, minute);
  if (next <= now) next += DAY_MS;
  return next - now;
}

export class RegistrySync {
  private timer?: NodeJS.Timeout;
  private running?: Promise<SyncOutcome>;
  private stopped = false;
  private failures = 0;
  private readonly now: () => number;

  constructor(
    private readonly opts: RegistrySyncOptions,
    private readonly store: RegistryStore,
  ) {
    this.now = opts.now ?? Date.now;
  }

  get url(): string {
    return this.opts.url ?? FAA_REGISTRY_URL;
  }

  async state(): Promise<SyncState> {
    try {
      return JSON.parse(await readFile(path.join(this.opts.dir, STATE_FILE), 'utf8')) as SyncState;
    } catch {
      return {};
    }
  }

  private writeState(s: SyncState): void {
    try {
      writeFileSync(path.join(this.opts.dir, STATE_FILE), JSON.stringify(s), { mode: 0o600 });
    } catch {
      /* the next run tries again */
    }
  }

  /**
   * One sync. `force` skips If-Modified-Since; `file` imports an archive already on disk (a
   * manual download, when the FAA blocks automated clients) instead of downloading.
   */
  run(o: { force?: boolean; file?: string } = {}): Promise<SyncOutcome> {
    if (this.running) return Promise.resolve({ outcome: 'busy' });
    this.running = this.runOnce(o).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async runOnce(o: { force?: boolean; file?: string }): Promise<SyncOutcome> {
    const t0 = this.now();
    const dir = this.opts.dir;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const lock = path.join(dir, LOCK_FILE);
    if (!(await this.acquireLock(lock))) return { outcome: 'busy' };
    const part = path.join(dir, ZIP_PART);
    const fresh = path.join(dir, `${REGISTRY_FILE}.new`);
    let result: SyncOutcome;
    try {
      this.store.refresh(true);
      const meta = this.store.meta();
      let zip = o.file;
      let lastModified: string | undefined;
      if (!zip) {
        const dl = await this.download(part, o.force ? undefined : meta?.last_modified);
        if (dl.status === 304) {
          result = { outcome: 'not_modified', ms: this.now() - t0 };
          return result;
        }
        zip = part;
        lastModified = dl.lastModified;
      }
      const imported = await importRegistryZip(zip, fresh, {
        storePrivateNames: this.opts.storePrivateNames,
        minRows: this.opts.minRows ?? 100_000,
        previousRows: meta?.rows,
      });
      writeMeta(fresh, {
        last_modified: lastModified,
        downloaded_at: o.file ? undefined : new Date(this.now()).toISOString(),
        imported_at: new Date(this.now()).toISOString(),
        source_url: o.file ? 'manual import of ReleasableAircraft.zip' : this.url,
      });
      fsyncPath(fresh);
      await rename(fresh, path.join(dir, REGISTRY_FILE));
      fsyncPath(dir);
      this.store.refresh(true);
      result = {
        outcome: 'imported',
        rows: imported.rows,
        as_of: imported.as_of,
        ms: this.now() - t0,
      };
      return result;
    } catch (err) {
      const e = err as Error & { status?: number };
      result = {
        outcome: 'failed',
        reason: e.message.replace(/(\/[\w.-]+){2,}/g, '[path]').slice(0, 200),
        status: e.status,
        ms: this.now() - t0,
      };
      return result;
    } finally {
      await rm(fresh, { force: true }).catch(() => undefined);
      await rm(part, { force: true }).catch(() => undefined);
      await rm(lock, { force: true }).catch(() => undefined);
      this.afterRun(result!);
    }
  }

  private afterRun(r: SyncOutcome | undefined): void {
    if (!r || r.outcome === 'busy') return;
    this.failures = r.outcome === 'failed' ? this.failures + 1 : 0;
    this.writeState({
      checked_at: new Date(this.now()).toISOString(),
      last_outcome: r.outcome,
      ...(r.outcome === 'failed' ? { last_error: r.reason } : {}),
      failures: this.failures,
    });
    const fields: Record<string, unknown> = { outcome: r.outcome, ms: r.ms };
    if (r.outcome === 'imported') Object.assign(fields, { rows: r.rows, as_of: r.as_of });
    if (r.outcome === 'failed') Object.assign(fields, { reason: r.reason, status: r.status });
    if (r.outcome === 'failed') this.opts.logger.warn('aircraft_registry_sync', fields);
    else this.opts.logger.info('aircraft_registry_sync', fields);
  }

  private async acquireLock(lock: string): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fh = await open(lock, 'wx', 0o600);
        await fh.writeFile(JSON.stringify({ pid: process.pid, at: this.now() }));
        await fh.close();
        return true;
      } catch {
        // A lock older than two hours belongs to a sync that died.
        const st = await stat(lock).catch(() => undefined);
        if (st && Date.now() - st.mtimeMs > 2 * 3_600_000) await rm(lock, { force: true });
        else return false;
      }
    }
    return false;
  }

  private async download(
    dest: string,
    ifModifiedSince?: string,
  ): Promise<{ status: number; lastModified?: string }> {
    const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? 15 * 60_000);
    const headers: Record<string, string> = {
      'user-agent': REGISTRY_USER_AGENT,
      accept: 'application/zip, application/octet-stream;q=0.9, */*;q=0.1',
    };
    if (ifModifiedSince) headers['if-modified-since'] = ifModifiedSince;
    let res: Response;
    try {
      res = await (this.opts.fetch ?? fetch)(this.url, {
        headers,
        redirect: 'error',
        signal: timeout,
      });
    } catch (err) {
      throw new Error(
        timeout.aborted ? 'download timed out' : `download failed (${(err as Error).name})`,
        { cause: err },
      );
    }
    if (res.status === 304) {
      await res.body?.cancel().catch(() => undefined);
      return { status: 304 };
    }
    if (res.status !== 200 || !res.body) {
      await res.body?.cancel().catch(() => undefined);
      throw Object.assign(new Error(`registry download refused: HTTP ${res.status}`), {
        status: res.status,
      });
    }
    const max = this.opts.maxBytes ?? 400 * 1024 * 1024;
    let n = 0;
    const cap = new Transform({
      transform(chunk: Buffer, _e, cb) {
        n += chunk.length;
        if (n > max) cb(new Error(`archive larger than ${max} bytes`));
        else cb(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(res.body as WebReadableStream<Uint8Array>),
      cap,
      createWriteStream(dest, { mode: 0o600 }),
      { signal: timeout },
    );
    return { status: 200, lastModified: res.headers.get('last-modified') ?? undefined };
  }

  // ---------- schedule ----------

  /** Daily at about 06:15 UTC; a missing or stale copy is fetched shortly after start. */
  start(): void {
    if (this.timer || this.stopped) return;
    void this.state().then((s) => {
      if (this.stopped || this.timer) return;
      const meta = this.store.meta();
      const checked = s.checked_at ? Date.parse(s.checked_at) : NaN;
      const stale =
        !meta ||
        !(this.now() - checked < 30 * 3_600_000) ||
        meta.private_names_stored !== this.opts.storePrivateNames;
      this.schedule(stale ? (this.opts.startupDelayMs ?? 120_000) : this.untilNextSlot());
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private untilNextSlot(): number {
    // A little jitter so the request is not on the minute.
    return msUntilUtc(this.now(), 6, 15) + Math.floor(Math.random() * 120_000);
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), Math.max(1000, ms));
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    this.timer = undefined;
    if (this.stopped) return;
    const meta = this.store.meta();
    // A copy built under another names setting is rebuilt in full (no If-Modified-Since).
    const force = Boolean(meta && meta.private_names_stored !== this.opts.storePrivateNames);
    const r = await this.run({ force });
    if (this.stopped) return;
    // A failed run is retried an hour later, twice; then it waits for the next daily slot.
    if (r.outcome === 'failed' && this.failures <= 2) this.schedule(3_600_000);
    else this.schedule(this.untilNextSlot());
  }
}
