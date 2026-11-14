/**
 * Audit log of security-relevant events (grants, refreshes, revocations,
 * registrations, logins, admin actions, device changes). Stored in SQLite and
 * mirrored to the structured log. Never pass tokens or coordinates in detail.
 */
import type { DB } from './db.js';
import { sanitize, type Logger } from './log.js';

export interface AuditFields {
  subject?: string;
  clientId?: string;
  ip?: string;
  detail?: Record<string, unknown>;
}

export class Audit {
  private readonly insert;

  constructor(
    private readonly db: DB,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {
    this.insert = db.prepare(
      'INSERT INTO audit_log(ts, event, subject, client_id, ip, detail) VALUES (?, ?, ?, ?, ?, ?)',
    );
  }

  record(event: string, f: AuditFields = {}): void {
    const detail = f.detail ? JSON.stringify(sanitize(f.detail)) : null;
    this.insert.run(this.now(), event, f.subject ?? null, f.clientId ?? null, f.ip ?? null, detail);
    this.logger.info('audit', { audit_event: event, subject: f.subject, client: f.clientId, ip: f.ip, detail: f.detail });
  }

  recent(limit = 100): Array<{ ts: number; event: string; subject: string | null; client_id: string | null; ip: string | null; detail: string | null }> {
    return this.db
      .prepare('SELECT ts, event, subject, client_id, ip, detail FROM audit_log ORDER BY id DESC LIMIT ?')
      .all(limit) as never;
  }

  prune(olderThanMs = 180 * 86_400_000): void {
    this.db.prepare('DELETE FROM audit_log WHERE ts < ?').run(this.now() - olderThanMs);
  }
}
