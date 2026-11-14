/**
 * Audit log of security-relevant events (grants, refreshes, revocations,
 * registrations, logins, admin actions, device changes, location reads). Stored in
 * SQLite and mirrored to the structured log. Never pass tokens or coordinates in detail.
 *
 * Bounded (review OA-6): events are classed, and each class has its own row cap and
 * retention, so a flood of one kind can never push out another.
 *  - security         grants, approvals, revocations, admin, step-up, devices   180 days, 20k rows
 *  - unauthenticated  what anyone on the internet can trigger (rejected codes and refreshes,
 *                     registrations, failed logins): at most 60 rows a minute in total,
 *                     the rest counted into one "audit_suppressed" row      30 days, 5k rows
 *  - access           location reads by MCP grants                         90 days, 20k rows
 * prune() (every 10 minutes and at start) applies the caps.
 */
import type { DB } from './db.js';
import { sanitize, type Logger } from './log.js';

export interface AuditFields {
  subject?: string;
  clientId?: string;
  ip?: string;
  detail?: Record<string, unknown>;
}

export type AuditClass = 'security' | 'unauthenticated' | 'access';

export const UNAUTHENTICATED_EVENTS = new Set([
  'code_rejected',
  'refresh_rejected',
  'client_registered',
  'client_registration_rejected',
  'revoke_client_mismatch',
  'login_failed',
  'login_locked',
  'audit_suppressed',
]);
export const ACCESS_EVENTS = new Set(['location_read']);

export function auditClass(event: string): AuditClass {
  if (UNAUTHENTICATED_EVENTS.has(event)) return 'unauthenticated';
  if (ACCESS_EVENTS.has(event)) return 'access';
  return 'security';
}

export interface AuditLimits {
  /** Rows per minute (all IPs together) for the unauthenticated class. */
  unauthPerMinute: number;
  maxRows: Record<AuditClass, number>;
  retentionMs: Record<AuditClass, number>;
}

export const DEFAULT_AUDIT_LIMITS: AuditLimits = {
  unauthPerMinute: 60,
  maxRows: { security: 20_000, unauthenticated: 5_000, access: 20_000 },
  retentionMs: {
    security: 180 * 86_400_000,
    unauthenticated: 30 * 86_400_000,
    access: 90 * 86_400_000,
  },
};

export interface AuditRow {
  ts: number;
  event: string;
  subject: string | null;
  client_id: string | null;
  ip: string | null;
  detail: string | null;
  class: AuditClass;
}

export class Audit {
  private readonly insert;
  private windowStart: number;
  private windowCount = 0;
  private suppressed = new Map<string, number>();

  constructor(
    private readonly db: DB,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
    private readonly limits: AuditLimits = DEFAULT_AUDIT_LIMITS,
  ) {
    this.insert = db.prepare(
      'INSERT INTO audit_log(ts, event, subject, client_id, ip, detail, class) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    this.windowStart = now();
  }

  record(event: string, f: AuditFields = {}): void {
    const cls = auditClass(event);
    if (cls === 'unauthenticated' && !this.admit(event)) return;
    this.write(event, cls, f);
  }

  private write(event: string, cls: AuditClass, f: AuditFields): void {
    const detail = f.detail ? JSON.stringify(sanitize(f.detail)) : null;
    this.insert.run(
      this.now(),
      event,
      f.subject ?? null,
      f.clientId ?? null,
      f.ip ?? null,
      detail,
      cls,
    );
    this.logger.info('audit', {
      audit_event: event,
      subject: f.subject,
      client: f.clientId,
      ip: f.ip,
      detail: f.detail,
    });
  }

  /** Global per-minute budget for unauthenticated rows; the rest are only counted. */
  private admit(event: string): boolean {
    const t = this.now();
    if (t - this.windowStart >= 60_000) {
      this.flushSuppressed();
      this.windowStart = t;
      this.windowCount = 0;
    }
    if (this.windowCount < this.limits.unauthPerMinute) {
      this.windowCount++;
      return true;
    }
    this.suppressed.set(event, (this.suppressed.get(event) ?? 0) + 1);
    return false;
  }

  /** Writes one summary row for events dropped by the unauthenticated budget. */
  flushSuppressed(): void {
    if (!this.suppressed.size) return;
    const counts = Object.fromEntries(this.suppressed);
    this.suppressed.clear();
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    this.write('audit_suppressed', 'unauthenticated', {
      detail: { window_start: new Date(this.windowStart).toISOString(), total, counts },
    });
    this.logger.warn('audit_suppressed', { total, counts });
  }

  recent(limit = 100, cls?: AuditClass): AuditRow[] {
    return (
      cls
        ? this.db
            .prepare(
              'SELECT ts, event, subject, client_id, ip, detail, class FROM audit_log WHERE class = ? ORDER BY id DESC LIMIT ?',
            )
            .all(cls, limit)
        : this.db
            .prepare(
              'SELECT ts, event, subject, client_id, ip, detail, class FROM audit_log ORDER BY id DESC LIMIT ?',
            )
            .all(limit)
    ) as AuditRow[];
  }

  countSince(cls: AuditClass, sinceMs: number): number {
    return (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM audit_log WHERE class = ? AND ts >= ?')
        .get(cls, sinceMs) as { n: number }
    ).n;
  }

  /** Retention job: per-class age limit and row cap. */
  prune(): void {
    this.flushSuppressed();
    const t = this.now();
    for (const cls of ['security', 'unauthenticated', 'access'] as const) {
      this.db
        .prepare('DELETE FROM audit_log WHERE class = ? AND ts < ?')
        .run(cls, t - this.limits.retentionMs[cls]);
      this.db
        .prepare(
          `DELETE FROM audit_log WHERE class = ? AND id <= (
             SELECT id FROM audit_log WHERE class = ? ORDER BY id DESC LIMIT 1 OFFSET ?)`,
        )
        .run(cls, cls, this.limits.maxRows[cls]);
    }
  }
}
