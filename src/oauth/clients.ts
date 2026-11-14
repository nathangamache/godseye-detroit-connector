/**
 * OAuth client registry.
 *  - CIMD clients: client_id is an https URL on CIMD_ALLOWED_CLIENT_IDS; its
 *    metadata document is fetched (SSRF-safe), validated and cached.
 *  - DCR clients (RFC 7591): public clients only; every redirect URI must be on
 *    the allowlist (exact match; loopback entries match any port, RFC 8252).
 * Every redirect_uri used at /authorize must match both the client's own list
 * and the global allowlist.
 */
import type { Config } from '../config.js';
import type { DB } from '../db.js';
import { randomToken } from '../util/crypto.js';
import { CimdFetchError, type CimdFetcher } from './cimd.js';

export interface OAuthClient {
  client_id: string;
  kind: 'cimd' | 'dcr';
  client_name: string;
  redirect_uris: string[];
  client_uri?: string;
  revoked: boolean;
}

export class ClientError extends Error {
  constructor(
    readonly code: 'invalid_client' | 'invalid_client_metadata' | 'invalid_redirect_uri',
    message: string,
  ) {
    super(message);
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Exact match, except that loopback http redirects ignore the port (RFC 8252 §7.3). */
export function redirectMatches(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  let a: URL, b: URL;
  try {
    a = new URL(registered);
    b = new URL(requested);
  } catch {
    return false;
  }
  if (a.protocol !== 'http:' || b.protocol !== 'http:') return false;
  if (!LOOPBACK_HOSTS.has(a.hostname) || a.hostname !== b.hostname) return false;
  return (
    a.pathname === b.pathname && a.search === b.search && !b.hash && !b.username && !b.password
  );
}

export class ClientRegistry {
  constructor(
    private readonly db: DB,
    private readonly config: Pick<
      Config,
      | 'CIMD_ALLOWED_CLIENT_IDS'
      | 'DCR_ENABLED'
      | 'DCR_ALLOWED_REDIRECT_URIS'
      | 'LOOPBACK_REDIRECT_URIS'
      | 'DCR_MAX_CLIENTS'
    >,
    private readonly fetchCimd: CimdFetcher,
    private readonly now: () => number = Date.now,
  ) {}

  /** Is this redirect URI on the global allowlist? */
  globallyAllowed(uri: string): boolean {
    return (
      this.config.DCR_ALLOWED_REDIRECT_URIS.includes(uri) ||
      this.config.LOOPBACK_REDIRECT_URIS.some((l) => redirectMatches(l, uri))
    );
  }

  redirectAllowed(client: OAuthClient, uri: string): boolean {
    return this.globallyAllowed(uri) && client.redirect_uris.some((r) => redirectMatches(r, uri));
  }

  async resolve(clientId: string): Promise<OAuthClient> {
    if (typeof clientId !== 'string' || !clientId || clientId.length > 300)
      throw new ClientError('invalid_client', 'missing client_id');
    if (clientId.startsWith('https://')) return this.resolveCimd(clientId);
    const row = this.db
      .prepare("SELECT * FROM clients WHERE client_id = ? AND kind = 'dcr'")
      .get(clientId) as ClientRow | undefined;
    if (!row) throw new ClientError('invalid_client', 'unknown client_id');
    const c = fromRow(row);
    if (c.revoked) throw new ClientError('invalid_client', 'client has been revoked');
    return c;
  }

  /** Lookup without network access (token endpoint): the client must already be known. */
  known(clientId: string): OAuthClient | null {
    const row = this.db.prepare('SELECT * FROM clients WHERE client_id = ?').get(clientId) as
      ClientRow | undefined;
    if (!row) return null;
    const c = fromRow(row);
    return c.revoked ? null : c;
  }

  private async resolveCimd(url: string): Promise<OAuthClient> {
    if (!this.config.CIMD_ALLOWED_CLIENT_IDS.includes(url)) {
      throw new ClientError(
        'invalid_client',
        'this client_id metadata URL is not on the allowlist',
      );
    }
    const existing = this.db.prepare('SELECT * FROM clients WHERE client_id = ?').get(url) as
      ClientRow | undefined;
    if (existing?.revoked_at) throw new ClientError('invalid_client', 'client has been revoked');

    const t = this.now();
    const cached = this.db
      .prepare('SELECT document, expires_at, fetched_at FROM cimd_cache WHERE url = ?')
      .get(url) as { document: string; expires_at: number; fetched_at: number } | undefined;
    let docText: string | undefined;
    if (cached && cached.expires_at > t) docText = cached.document;
    else {
      try {
        const fetched = await this.fetchCimd(url);
        const ttl = Math.min(86_400, Math.max(60, fetched.maxAgeS ?? 300));
        validateCimd(url, fetched.body); // throws before caching anything bad
        docText = fetched.body;
        this.db
          .prepare(
            'INSERT INTO cimd_cache(url, document, fetched_at, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(url) DO UPDATE SET document = excluded.document, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at',
          )
          .run(url, fetched.body, t, t + ttl * 1000);
      } catch (err) {
        // Serve a stale (≤7 days) validated copy if the client's host is briefly down.
        if (cached && t - cached.fetched_at < 7 * 86_400_000) docText = cached.document;
        else if (err instanceof ClientError) throw err;
        else
          throw new ClientError(
            'invalid_client',
            err instanceof CimdFetchError ? err.message : 'could not fetch client metadata',
          );
      }
    }
    const doc = validateCimd(url, docText!);
    this.db
      .prepare(
        `INSERT INTO clients(client_id, kind, client_name, redirect_uris, metadata, created_at, last_used_at)
         VALUES (?, 'cimd', ?, ?, ?, ?, ?)
         ON CONFLICT(client_id) DO UPDATE SET client_name = excluded.client_name, redirect_uris = excluded.redirect_uris,
           metadata = excluded.metadata, last_used_at = excluded.last_used_at`,
      )
      .run(
        url,
        doc.client_name,
        JSON.stringify(doc.redirect_uris),
        JSON.stringify({ client_uri: doc.client_uri }),
        t,
        t,
      );
    return {
      client_id: url,
      kind: 'cimd',
      client_name: doc.client_name,
      redirect_uris: doc.redirect_uris,
      client_uri: doc.client_uri,
      revoked: false,
    };
  }

  /** RFC 7591 registration. Returns the registration response body. */
  register(body: unknown): Record<string, unknown> {
    if (!this.config.DCR_ENABLED)
      throw new ClientError('invalid_client_metadata', 'dynamic client registration is disabled');
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new ClientError('invalid_client_metadata', 'body must be a JSON object');
    const b = body as Record<string, unknown>;
    const uris = b.redirect_uris;
    if (
      !Array.isArray(uris) ||
      !uris.length ||
      uris.length > 10 ||
      !uris.every((u) => typeof u === 'string' && u.length <= 300)
    ) {
      throw new ClientError(
        'invalid_redirect_uri',
        'redirect_uris must be a non-empty array of URLs',
      );
    }
    for (const u of uris as string[]) {
      if (!this.globallyAllowed(u))
        throw new ClientError(
          'invalid_redirect_uri',
          `redirect_uri not allowed: ${u.slice(0, 120)}`,
        );
    }
    const method = b.token_endpoint_auth_method ?? 'none';
    if (method !== 'none')
      throw new ClientError(
        'invalid_client_metadata',
        'only public clients (token_endpoint_auth_method "none") are supported',
      );
    const grants = (b.grant_types as unknown[] | undefined) ?? [
      'authorization_code',
      'refresh_token',
    ];
    if (
      !Array.isArray(grants) ||
      !grants.every((g) => g === 'authorization_code' || g === 'refresh_token')
    ) {
      throw new ClientError('invalid_client_metadata', 'unsupported grant_types');
    }
    const responses = (b.response_types as unknown[] | undefined) ?? ['code'];
    if (!Array.isArray(responses) || !responses.every((r) => r === 'code'))
      throw new ClientError('invalid_client_metadata', 'unsupported response_types');
    const name = typeof b.client_name === 'string' ? cleanName(b.client_name) : 'Unnamed client';
    const count = (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM clients WHERE kind = 'dcr' AND revoked_at IS NULL")
        .get() as { n: number }
    ).n;
    if (count >= this.config.DCR_MAX_CLIENTS) {
      // Drop the oldest never-used registrations before refusing.
      this.db
        .prepare(
          "DELETE FROM clients WHERE kind = 'dcr' AND last_used_at IS NULL AND client_id IN (SELECT client_id FROM clients WHERE kind = 'dcr' AND last_used_at IS NULL ORDER BY created_at LIMIT 50)",
        )
        .run();
      const after = (
        this.db
          .prepare("SELECT COUNT(*) AS n FROM clients WHERE kind = 'dcr' AND revoked_at IS NULL")
          .get() as { n: number }
      ).n;
      if (after >= this.config.DCR_MAX_CLIENTS)
        throw new ClientError('invalid_client_metadata', 'too many registered clients');
    }
    const clientId = randomToken('dcr', 18);
    const t = this.now();
    this.db
      .prepare(
        "INSERT INTO clients(client_id, kind, client_name, redirect_uris, metadata, created_at) VALUES (?, 'dcr', ?, ?, ?, ?)",
      )
      .run(
        clientId,
        name,
        JSON.stringify(uris),
        JSON.stringify({ application_type: b.application_type ?? null }),
        t,
      );
    return {
      client_id: clientId,
      client_id_issued_at: Math.floor(t / 1000),
      client_name: name,
      redirect_uris: uris,
      grant_types: grants,
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  touch(clientId: string): void {
    this.db
      .prepare('UPDATE clients SET last_used_at = ? WHERE client_id = ?')
      .run(this.now(), clientId);
  }

  revoke(clientId: string): boolean {
    return (
      this.db
        .prepare('UPDATE clients SET revoked_at = ? WHERE client_id = ? AND revoked_at IS NULL')
        .run(this.now(), clientId).changes > 0
    );
  }

  list(): Array<OAuthClient & { created_at: number; last_used_at: number | null }> {
    return (
      this.db
        .prepare('SELECT * FROM clients ORDER BY created_at DESC LIMIT 300')
        .all() as ClientRow[]
    ).map((r) => ({
      ...fromRow(r),
      created_at: r.created_at,
      last_used_at: r.last_used_at,
    }));
  }
}

interface ClientRow {
  client_id: string;
  kind: 'cimd' | 'dcr';
  client_name: string | null;
  redirect_uris: string;
  metadata: string | null;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

function fromRow(r: ClientRow): OAuthClient {
  let meta: { client_uri?: string } = {};
  try {
    meta = JSON.parse(r.metadata ?? '{}');
  } catch {
    /* ignore */
  }
  return {
    client_id: r.client_id,
    kind: r.kind,
    client_name: r.client_name ?? 'Unnamed client',
    redirect_uris: JSON.parse(r.redirect_uris) as string[],
    client_uri: meta.client_uri,
    revoked: Boolean(r.revoked_at),
  };
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

function cleanName(s: string): string {
  return s.replace(CONTROL_CHARS, '').trim().slice(0, 80) || 'Unnamed client';
}

/** Validates a CIMD document per the MCP client-registration rules. */
export function validateCimd(
  url: string,
  text: string,
): { client_name: string; redirect_uris: string[]; client_uri?: string } {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new ClientError('invalid_client', 'client metadata document is not valid JSON');
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc))
    throw new ClientError('invalid_client', 'client metadata must be a JSON object');
  const d = doc as Record<string, unknown>;
  if (d.client_id !== url)
    throw new ClientError('invalid_client', 'client metadata client_id does not match its URL');
  const uris = d.redirect_uris;
  if (
    !Array.isArray(uris) ||
    !uris.length ||
    !uris.every((u) => typeof u === 'string' && /^https?:\/\//.test(u))
  ) {
    throw new ClientError('invalid_client', 'client metadata has no valid redirect_uris');
  }
  const method = d.token_endpoint_auth_method ?? 'none';
  if (method !== 'none')
    throw new ClientError('invalid_client', 'only public CIMD clients are supported');
  if (
    d.grant_types !== undefined &&
    (!Array.isArray(d.grant_types) || !d.grant_types.includes('authorization_code'))
  ) {
    throw new ClientError(
      'invalid_client',
      'client metadata grant_types must include authorization_code',
    );
  }
  if (
    d.response_types !== undefined &&
    (!Array.isArray(d.response_types) || !d.response_types.includes('code'))
  ) {
    throw new ClientError('invalid_client', 'client metadata response_types must include code');
  }
  return {
    client_name:
      typeof d.client_name === 'string' ? cleanName(d.client_name) : new URL(url).hostname,
    redirect_uris: uris as string[],
    client_uri: typeof d.client_uri === 'string' ? d.client_uri.slice(0, 200) : undefined,
  };
}
