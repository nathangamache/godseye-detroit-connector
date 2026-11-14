/**
 * SQLite storage (better-sqlite3). Secrets are stored only as SHA-256 hashes:
 * access/refresh tokens, authorization codes, session ids, device tokens and
 * setup codes. The database file is created mode 600 in a mode-700 directory.
 */
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type DB = Database.Database;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE clients (
    client_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('cimd', 'dcr')),
    client_name TEXT,
    redirect_uris TEXT NOT NULL,
    metadata TEXT,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at INTEGER
  );

  CREATE TABLE cimd_cache (
    url TEXT PRIMARY KEY,
    document TEXT NOT NULL,
    fetched_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE auth_codes (
    code_hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    resource TEXT NOT NULL,
    scope TEXT NOT NULL,
    subject TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    family_id TEXT
  );

  CREATE TABLE token_families (
    family_id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    scope TEXT NOT NULL,
    resource TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at INTEGER,
    revoked_reason TEXT
  );

  CREATE TABLE tokens (
    token_hash TEXT PRIMARY KEY,
    family_id TEXT NOT NULL REFERENCES token_families(family_id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    revoked_at INTEGER
  );
  CREATE INDEX tokens_family ON tokens(family_id);

  CREATE TABLE sessions (
    id_hash TEXT PRIMARY KEY,
    subject TEXT NOT NULL,
    provider TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE login_failures (
    key TEXT PRIMARY KEY,
    count INTEGER NOT NULL,
    first_at INTEGER NOT NULL,
    locked_until INTEGER
  );

  CREATE TABLE devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    token_hash TEXT UNIQUE,
    setup_code_hash TEXT UNIQUE,
    setup_expires_at INTEGER,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER,
    revoked_at INTEGER
  );

  CREATE TABLE locations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    accuracy_m REAL,
    fix_ts INTEGER NOT NULL,
    received_at INTEGER NOT NULL,
    battery INTEGER,
    speed_kmh REAL,
    source TEXT NOT NULL
  );
  CREATE INDEX locations_fix_ts ON locations(fix_ts);

  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    event TEXT NOT NULL,
    subject TEXT,
    client_id TEXT,
    ip TEXT,
    detail TEXT
  );
  CREATE INDEX audit_ts ON audit_log(ts);
  `,
  // 2: step-up (TOTP) sessions for consent and admin.
  `
  CREATE TABLE stepup_sessions (
    id_hash TEXT PRIMARY KEY,
    subject TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  `,
  // 3: audit classes (per-class caps and retention).
  `
  ALTER TABLE audit_log ADD COLUMN class TEXT NOT NULL DEFAULT 'security';
  CREATE INDEX audit_class_id ON audit_log(class, id);
  CREATE INDEX audit_class_ts ON audit_log(class, ts);
  `,
];

export function openDb(file: string): DB {
  if (file !== ':memory:') {
    const dir = path.dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const isNew = file === ':memory:' || !existsSync(file);
  const db = new Database(file);
  if (file !== ':memory:' && isNew) chmodSync(file, 0o600);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('secure_delete = ON');
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  const version = db.pragma('user_version', { simple: true }) as number;
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

export function kvGet(db: DB, key: string): string | undefined {
  return (
    db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined
  )?.value;
}

export function kvSet(db: DB, key: string, value: string): void {
  db.prepare(
    'INSERT INTO kv(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}
