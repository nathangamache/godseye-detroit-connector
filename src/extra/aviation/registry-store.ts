/**
 * The local copy of the FAA Releasable Aircraft Database: one SQLite file in the gateway's data
 * volume (AIRCRAFT_REGISTRY_DIR, default DATA_DIR/aviation), written only by the daily sync
 * (registry-sync.ts) and read here, read-only. Only MASTER, ACFTREF and ENGINE are kept, and of
 * MASTER no street, ZIP, county, co-owner ("other names") or unique-id field is ever stored.
 * The sync replaces the whole file by an atomic rename; lookups notice the new file and reopen.
 */
import { statSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export const REGISTRY_FILE = 'faa-registry.sqlite';
export const REGISTRY_SCHEMA_VERSION = '1';

/** DDL of a fresh registry file (registry-sync.ts builds it, then swaps it in). */
export const REGISTRY_SCHEMA = `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE aircraft (
    n_number TEXT PRIMARY KEY,      -- without the leading N
    serial TEXT,
    mfr_mdl_code TEXT,
    eng_mfr_mdl TEXT,
    year_mfr INTEGER,
    type_registrant TEXT,
    name TEXT,                      -- NULL when blank in the FAA file or not stored (private)
    name_blank INTEGER NOT NULL,    -- 1: the FAA file has no name (owner withheld or none)
    city TEXT,
    state TEXT,
    last_action_date TEXT,
    cert_issue_date TEXT,
    certification TEXT,
    type_aircraft TEXT,
    type_engine TEXT,
    status_code TEXT,
    mode_s_hex TEXT,
    fract_owner TEXT,
    air_worth_date TEXT,
    expiration_date TEXT,
    kit_mfr TEXT,
    kit_model TEXT
  ) WITHOUT ROWID;
  CREATE TABLE acftref (
    code TEXT PRIMARY KEY,
    mfr TEXT, model TEXT, type_acft TEXT, type_eng TEXT, ac_cat TEXT, build_cert_ind TEXT,
    no_eng INTEGER, no_seats INTEGER, ac_weight TEXT, speed INTEGER
  ) WITHOUT ROWID;
  CREATE TABLE engine (
    code TEXT PRIMARY KEY,
    mfr TEXT, model TEXT, type TEXT, horsepower INTEGER, thrust INTEGER
  ) WITHOUT ROWID;
`;

export const REGISTRY_INDEXES = `CREATE INDEX aircraft_hex ON aircraft(mode_s_hex);`;

export interface RegistryRecord {
  n_number: string;
  serial: string | null;
  mfr_mdl_code: string | null;
  eng_mfr_mdl: string | null;
  year_mfr: number | null;
  type_registrant: string | null;
  name: string | null;
  name_blank: number;
  city: string | null;
  state: string | null;
  last_action_date: string | null;
  cert_issue_date: string | null;
  certification: string | null;
  type_aircraft: string | null;
  type_engine: string | null;
  status_code: string | null;
  mode_s_hex: string | null;
  fract_owner: string | null;
  air_worth_date: string | null;
  expiration_date: string | null;
  kit_mfr: string | null;
  kit_model: string | null;
  ref_mfr: string | null;
  ref_model: string | null;
  ref_type_acft: string | null;
  ref_type_eng: string | null;
  ref_ac_cat: string | null;
  ref_build_cert_ind: string | null;
  ref_no_eng: number | null;
  ref_no_seats: number | null;
  ref_ac_weight: string | null;
  ref_speed: number | null;
  eng_mfr: string | null;
  eng_model: string | null;
  eng_type: string | null;
  eng_horsepower: number | null;
  eng_thrust: number | null;
}

export interface RegistryMeta {
  schema_version?: string;
  /** Date the FAA wrote MASTER.txt (from the archive), YYYY-MM-DD. */
  as_of?: string;
  /** The archive's Last-Modified header, sent back as If-Modified-Since. */
  last_modified?: string;
  downloaded_at?: string;
  imported_at?: string;
  source_url?: string;
  rows?: number;
  /** Whether names of private registrants were kept (only with AIRCRAFT_OWNER_DISCLOSURE=full). */
  private_names_stored?: boolean;
}

const SELECT = `
  SELECT a.*,
         r.mfr AS ref_mfr, r.model AS ref_model, r.type_acft AS ref_type_acft,
         r.type_eng AS ref_type_eng, r.ac_cat AS ref_ac_cat, r.build_cert_ind AS ref_build_cert_ind,
         r.no_eng AS ref_no_eng, r.no_seats AS ref_no_seats, r.ac_weight AS ref_ac_weight,
         r.speed AS ref_speed,
         e.mfr AS eng_mfr, e.model AS eng_model, e.type AS eng_type,
         e.horsepower AS eng_horsepower, e.thrust AS eng_thrust
    FROM aircraft a
    LEFT JOIN acftref r ON r.code = a.mfr_mdl_code
    LEFT JOIN engine e ON e.code = a.eng_mfr_mdl`;

export function parseMeta(rows: Array<{ key: string; value: string }>): RegistryMeta {
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const rowsN = Number(m.rows);
  return {
    schema_version: m.schema_version,
    as_of: m.as_of,
    last_modified: m.last_modified,
    downloaded_at: m.downloaded_at,
    imported_at: m.imported_at,
    source_url: m.source_url,
    rows: Number.isFinite(rowsN) ? rowsN : undefined,
    private_names_stored: m.private_names_stored === '1',
  };
}

export class RegistryStore {
  readonly file: string;
  private db?: Database.Database;
  private byHexStmt?: Database.Statement<[string], RegistryRecord>;
  private byNStmt?: Database.Statement<[string], RegistryRecord>;
  private cachedMeta?: RegistryMeta;
  private ident?: string;
  private checkedAt = -Infinity;
  /** Bumped whenever a different file is opened (callers key their caches on it). */
  generation = 0;

  constructor(
    readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {
    this.file = path.join(dir, REGISTRY_FILE);
  }

  /** Reopens when the file was replaced; checks at most every 30 s unless forced. */
  refresh(force = false): void {
    const t = this.now();
    if (!force && t - this.checkedAt < 30_000) return;
    this.checkedAt = t;
    let ident: string;
    try {
      const st = statSync(this.file);
      ident = `${st.dev}:${st.ino}:${st.mtimeMs}:${st.size}`;
    } catch {
      this.close();
      return;
    }
    if (this.db && ident === this.ident) return;
    this.close();
    try {
      const db = new Database(this.file, { readonly: true, fileMustExist: true });
      const meta = parseMeta(
        db.prepare('SELECT key, value FROM meta').all() as Array<{ key: string; value: string }>,
      );
      if (meta.schema_version !== REGISTRY_SCHEMA_VERSION) {
        db.close();
        return;
      }
      this.db = db;
      this.cachedMeta = meta;
      this.byHexStmt = db.prepare(`${SELECT} WHERE a.mode_s_hex = ?`) as Database.Statement<
        [string],
        RegistryRecord
      >;
      this.byNStmt = db.prepare(`${SELECT} WHERE a.n_number = ?`) as Database.Statement<
        [string],
        RegistryRecord
      >;
      this.ident = ident;
      this.generation++;
    } catch {
      this.close();
    }
  }

  get available(): boolean {
    this.refresh();
    return Boolean(this.db);
  }

  meta(): RegistryMeta | undefined {
    this.refresh();
    return this.db ? this.cachedMeta : undefined;
  }

  /** By MODE S CODE HEX (6 hex digits, any case). */
  byHex(hex: string): RegistryRecord | undefined {
    this.refresh();
    return this.byHexStmt?.get(hex.toUpperCase());
  }

  /** By N-number, with or without the leading N. */
  byNNumber(n: string): RegistryRecord | undefined {
    this.refresh();
    return this.byNStmt?.get(n.toUpperCase().replace(/^N/, ''));
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      /* already closed */
    }
    this.db = undefined;
    this.byHexStmt = undefined;
    this.byNStmt = undefined;
    this.cachedMeta = undefined;
    this.ident = undefined;
  }
}
