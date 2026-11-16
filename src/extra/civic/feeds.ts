/**
 * Local news feeds (RSS 2.0 and Atom), the primary source of local_headlines.
 *
 * A background refresher reads every feed in LOCAL_NEWS_FEEDS (feedList.ts) every 15 minutes, or
 * less often when an entry asks (poll_minutes), with a conditional GET (If-None-Match /
 * If-Modified-Since: a 304 costs nothing), the generic User-Agent, a timeout and a byte cap per
 * feed, and no redirects. Queries are answered from the latest snapshot in memory, never by a
 * fetch of their own (only when no refresh has run for longer than a cycle, as in tests or right
 * after start, does a call start one, and it waits for it only briefly). The snapshot is also kept
 * in the gateway's data volume (DATA_DIR/cache/local-news.json), so a restart answers at once and
 * keeps its validators.
 *
 * Only the headline, link, date, byline (dc:creator), categories and a short excerpt of the
 * description are read; full text (content:encoded, Atom content) is cut out before anything
 * else is parsed, so it is never stored or passed on. Items the entry says to skip (wire or
 * partner bylines, categories) are dropped at parse time too.
 *
 * A feed that fails keeps its last good items, served with their age ("from 2 h ago"); it is
 * tried again after 15 min, then 30, 60 ... at most 6 h (or when its Retry-After says).
 * Feed text is third-party: cleaned, capped, data only. No XML entity is expanded beyond the
 * fixed set below.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { cleanText, fetchBytes, httpUrl, UpstreamError, type FetchLike } from './common.js';
import { retryAfterSeconds } from './gdelt.js';
import type { FeedSpec } from './feedList.js';

/** The background refresher's cycle. */
export const FEED_REFRESH_MS = 15 * 60_000;
/** A failing feed waits 15 min, then 30, 60 ... at most this long. */
export const FEED_MAX_BACKOFF_MS = 6 * 3_600_000;
const FEED_TIMEOUT_MS = 15_000;
const FEED_MAX_BYTES = 4 * 1024 * 1024;
const MAX_ITEMS_PER_FEED = 60;
/** Items older than this are not kept (nothing asks further back). */
const KEEP_DAYS = 14;
const TITLE_MAX = 300;
const AUTHOR_MAX = 120;
const SNAPSHOT_VERSION = 1;

export interface FeedItem {
  title: string;
  link: string;
  /** ISO time the feed gives (pubDate, dc:date, published or updated). */
  published_at: string;
  author?: string;
  excerpt?: string;
  categories: string[];
}

export type SkipReason = 'creator' | 'partner' | 'category' | 'no_link' | 'no_date' | 'old';

// ------------------------------------------------------------------------------------
// Parsing

const XML_ENTITIES: Record<string, string> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
  laquo: '«',
  raquo: '»',
  middot: '·',
  bull: '•',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)
        ? String.fromCodePoint(cp)
        : ' ';
    }
    return XML_ENTITIES[e.toLowerCase()] ?? m;
  });
}

const escapeText = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The inner text of the first <name>…</name> in `xml` (CDATA already escaped), raw. */
function inner(xml: string, name: string): string | undefined {
  const m = new RegExp(`<${escRe(name)}(?:\\s[^>]*)?>([\\s\\S]*?)</${escRe(name)}\\s*>`, 'i').exec(
    xml,
  );
  return m ? m[1] : undefined;
}

function inners(xml: string, name: string, max: number): string[] {
  const re = new RegExp(`<${escRe(name)}(?:\\s[^>]*)?>([\\s\\S]*?)</${escRe(name)}\\s*>`, 'gi');
  const out: string[] = [];
  for (let m = re.exec(xml); m && out.length < max; m = re.exec(xml)) out.push(m[1]!);
  return out;
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${escRe(name)}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return m ? decodeEntities(m[2] ?? m[3] ?? '') : undefined;
}

/** Element text as plain text: entities decoded (twice: feeds often escape HTML), tags removed. */
function plain(raw: string | undefined, max: number): string | undefined {
  if (raw === undefined) return undefined;
  const once = decodeEntities(raw);
  const noTags = once.replace(/<[^>]{0,500}>/g, ' ');
  return cleanText(decodeEntities(noTags), max);
}

/**
 * Feed titles: plain text, single spaces, no space before punctuation; a trailing "| Outlet" or
 * "- Outlet" naming the outlet is dropped.
 */
export function normalizeFeedTitle(s: string, outletNames: string[] = []): string {
  let t = s
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:!?%)\]}»”’])/g, '$1')
    .replace(/([([{«“‘])\s+/g, '$1')
    .trim();
  for (const n of outletNames) {
    const re = new RegExp(`\\s+[|–—-]\\s+${escRe(n)}\\s*$`, 'i');
    t = t.replace(re, '').trim();
  }
  return t;
}

/** The short excerpt: no "The post … appeared first on …", no trailing "[…]", at most max. */
function excerptOf(raw: string | undefined, max: number): string | undefined {
  if (!raw || max <= 0) return undefined;
  let t = plain(raw, 2000);
  if (!t) return undefined;
  t = t
    .replace(/\s*The post .{1,400}? appeared first on .{1,120}?\.?\s*$/i, '')
    .replace(/\s*(\[…\]|\[\.\.\.\]|…|Continue reading.*|Read more.*)\s*$/i, '')
    .trim();
  if (!t) return undefined;
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.–—-]+$/, '')}…`;
}

function isoDate(raw: string | undefined): string | undefined {
  const s = plain(raw, 80);
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

export interface ParsedFeed {
  format: 'rss' | 'atom';
  items: FeedItem[];
  skipped: Partial<Record<SkipReason, number>>;
}

/** Words that mark a credit after a comma as a newsroom's ("Jane Doe, Detroit Free Press"). */
const NEWSROOM_WORDS =
  /\b(press|news|pbs|npr|radio|media|journal|times|tribune|post|herald|gazette|chalkbeat|outlier|magazine|wire|reuters|bloomberg|associated|bridge\w*|newsroom|tv|television|channel|public|daily|weekly|courier)\b/i;
/** A byline that is a newsroom on its own ("Detroit PBS"): stronger words only, not names. */
const NEWSROOM_ALONE =
  /\b(press|news|pbs|npr|media|chalkbeat|associated|reuters|bloomberg|tv|newsroom)\b/i;
/** Broadcast call letters ("WCMU", "WKAR-FM"). */
const CALL_LETTERS = /\b[KW][A-Z]{2,3}(-(FM|AM|TV))?\b/;

/**
 * Partner copy: a byline "Name, Org" (or a newsroom alone) where Org looks like a newsroom that is
 * not this outlet or a sister one. Two people ("Jane Doe, John Roe") are not a newsroom.
 */
export function partnerCredit(author: string, own: string[]): boolean {
  const a = author.toLowerCase();
  if (own.some((o) => a.includes(o.toLowerCase()))) return false;
  if (!author.includes(',')) return NEWSROOM_ALONE.test(author) || CALL_LETTERS.test(author);
  const credit = author.slice(author.lastIndexOf(',') + 1).trim();
  return NEWSROOM_WORDS.test(credit) || CALL_LETTERS.test(credit);
}

/** Why the feed entry says to skip an item, if it does. */
export function skipReason(
  item: { author?: string; categories: string[] },
  spec: Pick<
    FeedSpec,
    'skip_creators' | 'skip_partner_credits' | 'own_credits' | 'skip_categories'
  >,
): SkipReason | undefined {
  const author = item.author?.toLowerCase() ?? '';
  if (author && spec.skip_creators.some((c) => author.includes(c.toLowerCase()))) return 'creator';
  if (item.author && spec.skip_partner_credits && partnerCredit(item.author, spec.own_credits))
    return 'partner';
  const cats = item.categories.map((c) => c.toLowerCase());
  if (spec.skip_categories.some((c) => cats.includes(c.toLowerCase()))) return 'category';
  return undefined;
}

/**
 * RSS 2.0 (or RSS 1.0) and Atom: the newest items first as the feed lists them, filtered by the
 * entry's skip rules, items without a link or a date dropped. Full text is cut out first.
 */
export function parseFeed(
  body: Buffer | string,
  spec: Pick<
    FeedSpec,
    | 'skip_creators'
    | 'skip_partner_credits'
    | 'own_credits'
    | 'skip_categories'
    | 'excerpt_max'
    | 'outlet'
    | 'short_name'
  >,
  now: number,
): ParsedFeed {
  let xml = (typeof body === 'string' ? body : body.toString('utf8')).replace(/^\uFEFF/, '');
  xml = xml
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // CDATA becomes escaped text, so no markup inside it can end an element early.
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, c: string) => escapeText(c))
    .replace(/<!DOCTYPE[^>[]*(\[[\s\S]*?\])?\s*>/gi, ' ')
    // Full text is never read: cut out before anything else.
    // (Empty elements first, so "<content/>" cannot open a match that runs to a later one.)
    .replace(/<content:encoded\b[^>]*\/>/gi, ' ')
    .replace(/<content:encoded\b[^>]*>[\s\S]*?<\/content:encoded\s*>/gi, ' ')
    .replace(/<content(?=[\s/])[^>]*\/>/gi, ' ')
    .replace(/<content(?=[\s>])[^>]*>[\s\S]*?<\/content\s*>/gi, ' ');
  const head = xml.slice(0, 5000);
  const atom = /<feed\b/i.test(head) && !/<rss\b|<rdf:RDF\b/i.test(head);
  if (!atom && !/<rss\b|<rdf:RDF\b|<channel\b/i.test(head))
    throw new UpstreamError('bad_response', 'did not send an RSS or Atom feed');
  const blocks = atom ? inners(xml, 'entry', 200) : inners(xml, 'item', 200);
  const names = [spec.outlet, spec.short_name];
  const oldest = now - KEEP_DAYS * 86_400_000;
  const items: FeedItem[] = [];
  const skipped: Partial<Record<SkipReason, number>> = {};
  const skip = (r: SkipReason) => (skipped[r] = (skipped[r] ?? 0) + 1);
  for (const b of blocks) {
    const rawTitle = plain(inner(b, 'title'), TITLE_MAX);
    let link: string | undefined;
    if (atom) {
      const links = b.match(/<link\b[^>]*>/gi) ?? [];
      const alt =
        links.find((l) => (attr(l, 'rel') ?? 'alternate').toLowerCase() === 'alternate') ??
        links[0];
      link = alt ? httpUrl(attr(alt, 'href')) : undefined;
    } else {
      link = httpUrl(plain(inner(b, 'link'), 600));
      if (!link) {
        const guid = /<guid\b([^>]*)>([\s\S]*?)<\/guid\s*>/i.exec(b);
        if (guid && (attr(guid[1]!, 'isPermaLink') ?? 'true').toLowerCase() !== 'false')
          link = httpUrl(plain(guid[2], 600));
      }
    }
    const published = atom
      ? (isoDate(inner(b, 'published')) ?? isoDate(inner(b, 'updated')))
      : (isoDate(inner(b, 'pubDate')) ?? isoDate(inner(b, 'dc:date')));
    const author = atom
      ? plain(inner(inner(b, 'author') ?? '', 'name'), AUTHOR_MAX)
      : (plain(inner(b, 'dc:creator'), AUTHOR_MAX) ?? plain(inner(b, 'author'), AUTHOR_MAX));
    const categories = atom
      ? (b.match(/<category\b[^>]*>/gi) ?? [])
          .map((c) => cleanText(attr(c, 'term'), 60))
          .filter((c): c is string => Boolean(c))
          .slice(0, 10)
      : inners(b, 'category', 10)
          .map((c) => plain(c, 60))
          .filter((c): c is string => Boolean(c));
    if (!rawTitle) continue;
    if (!link) {
      skip('no_link');
      continue;
    }
    if (!published) {
      skip('no_date');
      continue;
    }
    const at = Date.parse(published);
    if (at < oldest || at > now + 86_400_000) {
      skip('old');
      continue;
    }
    const why = skipReason({ author, categories }, spec);
    if (why) {
      skip(why);
      continue;
    }
    const title = normalizeFeedTitle(rawTitle, names);
    if (!title) continue;
    const excerpt = excerptOf(
      atom ? inner(b, 'summary') : inner(b, 'description'),
      spec.excerpt_max,
    );
    items.push({
      title,
      link,
      published_at: published,
      ...(author ? { author } : {}),
      ...(excerpt ? { excerpt } : {}),
      categories,
    });
    if (items.length >= MAX_ITEMS_PER_FEED) break;
  }
  return { format: atom ? 'atom' : 'rss', items, skipped };
}

// ------------------------------------------------------------------------------------
// The refresher and its snapshot

/** A link as a de-duplication key: host without www, no query tracking, fragment or end slash. */
export function linkKey(link: string): string {
  try {
    const u = new URL(link);
    for (const k of [...u.searchParams.keys()])
      if (/^utm_|^fbclid$|^gclid$/i.test(k)) u.searchParams.delete(k);
    const q = u.searchParams.toString();
    return `${u.hostname.replace(/^www\./, '').toLowerCase()}${u.pathname.replace(/\/+$/, '')}${q ? `?${q}` : ''}`;
  } catch {
    return link;
  }
}

/** A title as a de-duplication key: letters and digits only, lower case. */
export function titleKey(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

interface UrlState {
  url: string;
  etag?: string;
  lastModified?: string;
  items: FeedItem[];
  /** Last answer (200 or 304). */
  checkedAt?: number;
  /** Last attempt, and its failure if it failed. */
  attemptAt?: number;
  error?: { at: number; message: string };
  failures: number;
  /** Earliest next attempt. */
  nextAt: number;
  skipped: Partial<Record<SkipReason, number>>;
}

/** One outlet's items and how current they are. */
export interface OutletSnapshot {
  spec: FeedSpec;
  items: FeedItem[];
  /** Oldest last answer among its feeds (undefined: never answered). */
  checkedAt?: number;
  /** The latest failure, when it came after that feed's last answer. */
  error?: { at: number; message: string };
  /** The outlet's items are the last good ones, not current (a failure, or a missed refresh). */
  stale: boolean;
  skipped: Partial<Record<SkipReason, number>>;
}

export interface LocalNewsOptions {
  feeds: FeedSpec[];
  fetch: FetchLike;
  now: () => number;
  /** The snapshot on disk; none = memory only. */
  file?: string;
  refreshMs?: number;
  timeoutMs?: number;
  maxBytes?: number;
  startupDelayMs?: number;
  onError?: (outlet: string, url: string, err: unknown) => void;
  onWriteError?: (err: unknown) => void;
}

export class LocalNewsFeeds {
  private readonly state = new Map<string, UrlState>();
  private inflight: Promise<void> | undefined;
  private lastCycleAt: number | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private readonly abort = new AbortController();

  constructor(private readonly o: LocalNewsOptions) {
    for (const f of o.feeds)
      for (const url of f.feed_urls)
        this.state.set(url, { url, items: [], failures: 0, nextAt: -Infinity, skipped: {} });
    this.load();
  }

  get feeds(): FeedSpec[] {
    return this.o.feeds;
  }

  get refreshMs(): number {
    return this.o.refreshMs ?? FEED_REFRESH_MS;
  }

  /** Background refresh: soon after start, then every refreshMs. Timers never hold the process. */
  start(): void {
    if (this.timer || this.stopped || !this.o.feeds.length) return;
    this.schedule(this.o.startupDelayMs ?? 5_000);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.abort.abort();
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh().finally(() => this.schedule(this.refreshMs));
    }, ms);
    this.timer.unref?.();
  }

  /** Reads every feed that is due (single-flight). Never throws: failures are kept per feed. */
  refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    const p = this.cycle().finally(() => {
      this.inflight = undefined;
    });
    this.inflight = p;
    return p;
  }

  /**
   * For a query: when no refresh has run for longer than a cycle (the refresher is not running
   * yet, or at all) and a feed is due, start one and wait for it at most maxWaitMs.
   */
  async ensureFresh(maxWaitMs: number, signal?: AbortSignal): Promise<void> {
    if (!this.o.feeds.length) return;
    const now = this.o.now();
    const due = [...this.state.values()].some((s) => now >= s.nextAt);
    const idle = this.lastCycleAt === undefined || now - this.lastCycleAt > this.refreshMs + 60_000;
    if (!this.inflight && !(due && idle)) return;
    const p = this.refresh();
    let t: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      p,
      new Promise<void>((r) => {
        t = setTimeout(r, maxWaitMs);
        t.unref?.();
        signal?.addEventListener('abort', () => r(), { once: true });
      }),
    ]);
    if (t) clearTimeout(t);
  }

  private async cycle(): Promise<void> {
    for (const f of this.o.feeds) {
      for (const url of f.feed_urls) {
        if (this.stopped) return;
        const s = this.state.get(url)!;
        if (this.o.now() < s.nextAt) continue;
        await this.fetchOne(f, s);
      }
    }
    this.lastCycleAt = this.o.now();
    this.save();
  }

  private async fetchOne(f: FeedSpec, s: UrlState): Promise<void> {
    const started = this.o.now();
    s.attemptAt = started;
    const headers: Record<string, string> = {
      accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8',
    };
    if (s.etag) headers['if-none-match'] = s.etag;
    if (s.lastModified) headers['if-modified-since'] = s.lastModified;
    let retryAfterMs: number | undefined;
    try {
      const r = await fetchBytes(this.o.fetch, s.url, `the ${f.short_name} feed`, {
        timeoutMs: this.o.timeoutMs ?? FEED_TIMEOUT_MS,
        maxBytes: this.o.maxBytes ?? FEED_MAX_BYTES,
        headers,
        signal: this.abort.signal,
      });
      if (r.status === 304) {
        if (!s.checkedAt)
          throw new UpstreamError('bad_response', 'answered 304 to a first request');
      } else if (r.status >= 200 && r.status < 300) {
        const parsed = parseFeed(r.body, f, this.o.now());
        s.items = parsed.items;
        s.skipped = parsed.skipped;
        s.etag = cleanText(r.headers.get('etag'), 200);
        s.lastModified = cleanText(r.headers.get('last-modified'), 100);
      } else {
        const ra = retryAfterSeconds(r.headers.get('retry-after'), this.o.now());
        if (ra !== undefined && (r.status === 429 || r.status === 503)) retryAfterMs = ra * 1000;
        throw new UpstreamError(
          r.status === 429 ? 'rate_limited' : 'http',
          `the ${f.short_name} feed returned HTTP ${r.status}`,
          r.status,
        );
      }
      s.checkedAt = this.o.now();
      s.error = undefined;
      s.failures = 0;
      // A little early, so a cycle that starts a few seconds late does not skip the feed.
      s.nextAt = s.checkedAt + f.poll_minutes * 60_000 - 60_000;
    } catch (err) {
      const now = this.o.now();
      s.failures++;
      const msg = err instanceof Error ? err.message : String(err);
      s.error = { at: now, message: (cleanText(msg, 200) ?? 'failed').replace(/\.$/, '') };
      const backoff = Math.min(
        FEED_MAX_BACKOFF_MS,
        Math.max(f.poll_minutes * 60_000, this.refreshMs) * 2 ** Math.min(10, s.failures - 1),
      );
      s.nextAt = now + Math.max(backoff, retryAfterMs ?? 0) - 60_000;
      this.o.onError?.(f.short_name, s.url, err);
    }
  }

  /** Every outlet's current items, de-duplicated by link across its feeds, and their state. */
  snapshot(): OutletSnapshot[] {
    const now = this.o.now();
    return this.o.feeds.map((spec) => {
      const seen = new Set<string>();
      const items: FeedItem[] = [];
      const skipped: Partial<Record<SkipReason, number>> = {};
      const maxAge = 2 * Math.max(spec.poll_minutes * 60_000, this.refreshMs) + 5 * 60_000;
      let checkedAt: number | undefined;
      let error: OutletSnapshot['error'];
      let stale = false;
      for (const url of spec.feed_urls) {
        const s = this.state.get(url)!;
        for (const [k, v] of Object.entries(s.skipped))
          skipped[k as SkipReason] = (skipped[k as SkipReason] ?? 0) + (v ?? 0);
        if (s.checkedAt !== undefined) {
          checkedAt = checkedAt === undefined ? s.checkedAt : Math.min(checkedAt, s.checkedAt);
          if (now - s.checkedAt > maxAge) stale = true;
        }
        // A failure after the feed's last answer (or with no answer yet).
        if (s.error && (s.checkedAt === undefined || s.error.at > s.checkedAt)) {
          if (!error || s.error.at > error.at) error = s.error;
          stale = true;
        }
        for (const it of s.items) {
          const k = linkKey(it.link);
          if (seen.has(k)) continue;
          seen.add(k);
          items.push(it);
        }
      }
      return {
        spec,
        items,
        ...(checkedAt !== undefined ? { checkedAt } : {}),
        ...(error ? { error } : {}),
        stale,
        skipped,
      };
    });
  }

  // --- disk -------------------------------------------------------------------------

  private load(): void {
    if (!this.o.file) return;
    let j: unknown;
    try {
      j = JSON.parse(readFileSync(this.o.file, 'utf8'));
    } catch {
      return;
    }
    const root = j as { v?: unknown; urls?: Record<string, unknown> };
    if (!root || root.v !== SNAPSHOT_VERSION || !root.urls || typeof root.urls !== 'object') return;
    const now = this.o.now();
    for (const f of this.o.feeds)
      for (const url of f.feed_urls) {
        const e = root.urls[url] as Record<string, unknown> | undefined;
        const s = this.state.get(url)!;
        if (!e || typeof e !== 'object' || typeof e.checked_at !== 'number') continue;
        const oldest = now - KEEP_DAYS * 86_400_000;
        const items = Array.isArray(e.items)
          ? e.items
              .map(storedItem)
              .filter(isItem)
              .filter((it) => Date.parse(it.published_at) >= oldest)
          : [];
        s.items = items.slice(0, MAX_ITEMS_PER_FEED);
        s.checkedAt = Math.min(e.checked_at, now);
        s.etag = cleanText(e.etag, 200);
        s.lastModified = cleanText(e.last_modified, 100);
        s.nextAt = s.checkedAt + f.poll_minutes * 60_000 - 60_000;
      }
  }

  private save(): void {
    if (!this.o.file) return;
    const urls: Record<string, unknown> = {};
    for (const s of this.state.values())
      if (s.checkedAt !== undefined)
        urls[s.url] = {
          checked_at: s.checkedAt,
          ...(s.etag ? { etag: s.etag } : {}),
          ...(s.lastModified ? { last_modified: s.lastModified } : {}),
          items: s.items,
        };
    try {
      mkdirSync(path.dirname(this.o.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.o.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ v: SNAPSHOT_VERSION, urls }), { mode: 0o600 });
      renameSync(tmp, this.o.file);
    } catch (err) {
      this.o.onWriteError?.(err);
    }
  }
}

/** An item read back from disk, checked as if it came from the feed. */
function storedItem(v: unknown): FeedItem | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const r = v as Record<string, unknown>;
  const title = cleanText(r.title, TITLE_MAX);
  const link = httpUrl(r.link);
  const at = typeof r.published_at === 'string' ? Date.parse(r.published_at) : NaN;
  if (!title || !link || !Number.isFinite(at)) return undefined;
  const author = cleanText(r.author, AUTHOR_MAX);
  const excerpt = cleanText(r.excerpt, 300);
  return {
    title,
    link,
    published_at: new Date(at).toISOString(),
    ...(author ? { author } : {}),
    ...(excerpt ? { excerpt } : {}),
    categories: Array.isArray(r.categories)
      ? r.categories
          .map((c) => cleanText(c, 60))
          .filter((c): c is string => Boolean(c))
          .slice(0, 10)
      : [],
  };
}

const isItem = (x: FeedItem | undefined): x is FeedItem => x !== undefined;
