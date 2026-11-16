/**
 * local_headlines' primary source: local newsrooms' public RSS/Atom feeds (LOCAL_NEWS_FEEDS),
 * read by a background refresher with conditional GETs and kept as a snapshot. Every feed is
 * mocked (no live calls); stories, names and bylines are made up.
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { USER_AGENT, type FetchLike } from '../src/extra/civic/common.js';
import {
  DEFAULT_LOCAL_NEWS_FEEDS,
  normalizeFeeds,
  parseLocalNewsFeeds,
  type FeedSpec,
} from '../src/extra/civic/feedList.js';
import { LocalNewsFeeds, parseFeed, partnerCredit } from '../src/extra/civic/feeds.js';
import { newGdeltQueue, type Clock } from '../src/extra/civic/gdelt.js';
import {
  CENSUS_COORDINATES_API,
  GDELT_DOC_API,
  PERSONAL_USE_NOTE,
} from '../src/extra/civic/headlines.js';
import { buildCivic } from '../src/extra/civic/index.js';
import { LocationStore } from '../src/location/store.js';
import { nullLogger } from '../src/log.js';
import { ToolPolicy } from '../src/tools/policy.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { ToolRunner } from '../src/tools/runner.js';
import type { ToolContext, ToolOutput } from '../src/tools/types.js';
import { DETROIT } from './helpers.js';

const NOW = Date.parse('2026-11-14T21:00:00Z');
const H = 3_600_000;
const ctx = (): ToolContext => ({ signal: new AbortController().signal, clientId: 'c1' });

// ------------------------------------------------------------------------------------
// Fixtures

interface Fx {
  title: string;
  link: string;
  hoursAgo: number;
  creator?: string;
  description?: string;
  categories?: string[];
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** RSS 2.0 as WordPress-style newsrooms publish it, full text included (it must never leak). */
function rss(items: Fx[], at = NOW): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
<title>Example newsroom</title>
<link>https://news.example/</link>
<atom:link href="https://news.example/feed/" rel="self" type="application/rss+xml"/>
<description>Local news</description>
${items
  .map(
    (i) => `<item>
  <title>${esc(i.title)}</title>
  <link>${i.link}</link>
  <dc:creator><![CDATA[${i.creator ?? 'Jane Doe'}]]></dc:creator>
  <pubDate>${new Date(at - i.hoursAgo * H).toUTCString()}</pubDate>
  ${(i.categories ?? []).map((c) => `<category><![CDATA[${c}]]></category>`).join('')}
  <guid isPermaLink="false">${i.link}#guid</guid>
  <description><![CDATA[${i.description ?? `<p>${esc(i.title)}: the short version.</p><p>The post <a href="${i.link}">${esc(i.title)}</a> appeared first on <a href="https://news.example">Example</a>.</p>`}]]></description>
  <content:encoded><![CDATA[<p>FULL-TEXT-MARKER of the whole story.</p></item></description><p>more</p>]]></content:encoded>
</item>`,
  )
  .join('\n')}
</channel>
</rss>`;
}

const MP = 'https://www.michiganpublic.org';
const FEEDS: Record<string, Fx[]> = {
  [`${MP}/news.rss`]: [
    {
      title: 'Dearborn library expands weekend hours',
      link: `${MP}/news/dearborn-library`,
      hoursAgo: 3,
    },
    {
      title: 'Budget talks resume in Lansing',
      link: `${MP}/politics/budget`,
      hoursAgo: 5,
      creator: 'John Roe',
    },
    {
      title: 'Wire story about Dearborn',
      link: `${MP}/wire/1`,
      hoursAgo: 1,
      creator: 'The Associated Press',
    },
    { title: 'Detroit transit board meets', link: `${MP}/news/transit`, hoursAgo: 10 },
  ],
  [`${MP}/index.rss`]: [
    {
      title: 'Dearborn library expands weekend hours',
      link: `${MP}/news/dearborn-library`,
      hoursAgo: 3,
    },
    { title: 'Record snowfall up north', link: `${MP}/news/snow`, hoursAgo: 2 },
  ],
  [`${MP}/politics-government.rss`]: [
    {
      title: 'Budget talks resume in Lansing',
      link: `${MP}/politics/budget?utm_source=rss`,
      hoursAgo: 5,
      creator: 'John Roe',
    },
  ],
  'https://www.bridgedetroit.com/feed/': [
    {
      title: 'City council approves park plan',
      link: 'https://www.bridgedetroit.com/park-plan/',
      hoursAgo: 4,
      creator: 'Sam Writer',
    },
    {
      title: 'Partner story',
      link: 'https://www.bridgedetroit.com/partner/',
      hoursAgo: 2,
      creator: 'Jane Doe, Detroit Free Press',
    },
    {
      title: 'Another partner story',
      link: 'https://www.bridgedetroit.com/pbs/',
      hoursAgo: 2,
      creator: 'Detroit PBS',
    },
    {
      title: 'Detroit’s Eastern Market adds Sunday hours',
      link: 'https://www.bridgedetroit.com/eastern-market/',
      hoursAgo: 6,
      creator: 'Pat Reporter',
    },
  ],
  'https://wdet.org/feed/': [
    {
      title: 'Morning news roundup',
      link: 'https://wdet.org/roundup/',
      hoursAgo: 1,
      creator: 'Alex Host',
    },
    {
      title: 'Jazz show playlist',
      link: 'https://wdet.org/jazz/',
      hoursAgo: 1,
      categories: ['Music'],
    },
    { title: 'Old story', link: 'https://wdet.org/old/', hoursAgo: 100 },
  ],
  'https://bridgemi.com/feed/': [
    {
      title: 'Detroit’s Eastern Market adds Sunday hours',
      link: 'https://bridgemi.com/eastern-market/',
      hoursAgo: 6,
      creator: 'Pat Reporter, Bridge Detroit',
    },
    {
      title: 'School funding report',
      link: 'https://bridgemi.com/schools/',
      hoursAgo: 8,
      creator: 'Jane Doe, WCMU',
    },
    {
      title: 'Lansing housing plan',
      link: 'https://bridgemi.com/housing/',
      hoursAgo: 9,
      creator: 'Chris Doe',
    },
  ],
  'https://www.wemu.org/news.rss': [
    {
      title: 'Ypsilanti road project starts',
      link: 'https://www.wemu.org/road/',
      hoursAgo: 3,
      creator: 'Lee Doe',
    },
    {
      title: 'County board vote',
      link: 'https://www.wemu.org/board/',
      hoursAgo: 12,
      // No byline in the feed.
      creator: '',
    },
  ],
};

interface Call {
  url: string;
  headers: Record<string, string>;
}

type Handler = (url: string, headers: Record<string, string>) => Response | Promise<Response>;

function mockFetch(handler: Handler) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    calls.push({ url, headers });
    return handler(url, headers);
  };
  return { fetch, calls };
}

const xml = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/rss+xml', ...headers },
  });
const json = (v: unknown) =>
  new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });

function fakeClock(start = NOW): Clock & { t: number } {
  const c = {
    t: start,
    now: () => c.t,
    sleep: async (ms: number) => {
      c.t += ms;
    },
  };
  return c;
}

/** The civic tools with the default feeds, every upstream mocked. */
function setup(
  opts: {
    feeds?: Record<string, Fx[]>;
    env?: Record<string, string>;
    handler?: (url: string, headers: Record<string, string>) => Response | undefined;
    gdelt?: (u: URL) => Response;
    clock?: Clock & { t: number };
  } = {},
) {
  const clock = opts.clock ?? fakeClock();
  const config = loadConfig({ GATEWAY_MODE: 'test', ...opts.env });
  const db = openDb(':memory:');
  const locations = new LocationStore(db, { retentionHours: 24 }, () => clock.now());
  const feeds = opts.feeds ?? FEEDS;
  const http = mockFetch((url, headers) => {
    const custom = opts.handler?.(url, headers);
    if (custom) return custom;
    if (url.startsWith(GDELT_DOC_API))
      return opts.gdelt ? opts.gdelt(new URL(url)) : json({ articles: [] });
    const items = feeds[url];
    if (items) return xml(rss(items));
    throw new TypeError(`no mock for ${url}`);
  });
  const civic = buildCivic({
    config,
    locations,
    now: () => clock.now(),
    fetch: http.fetch,
    gdeltQueue: newGdeltQueue(clock, () => 0),
  });
  const registry = new ToolRegistry(new ToolPolicy(config));
  for (const t of civic.tools) registry.register(t);
  const runner = new ToolRunner(registry, {
    timeoutMs: 10_000,
    maxConcurrent: 4,
    logger: nullLogger,
    post: {
      publicOrigin: 'https://ui.example',
      gevOrigins: [],
      maxResultChars: config.MAX_RESULT_CHARS,
      imageMaxDim: 768,
      imageMaxBase64Chars: 60_000,
      maxImages: 1,
    },
  });
  const run = (args: Record<string, unknown>) => registry.get('local_headlines')!.run(args, ctx());
  const feedCalls = () => http.calls.filter((c) => !c.url.startsWith(GDELT_DOC_API));
  return { config, clock, http, civic, news: civic.news, registry, runner, run, feedCalls };
}

type Data = Record<string, unknown>;
interface H {
  title: string;
  link: string;
  outlet: string;
  byline?: string;
  match: string;
  source: string;
  attribution: string;
  excerpt?: string;
  from?: string;
}
const data = (o: ToolOutput) => o.data as Data;
const heads = (o: ToolOutput) => data(o).headlines as H[];
const titles = (o: ToolOutput) => heads(o).map((h) => h.title);

// ------------------------------------------------------------------------------------

describe('local news feeds: the list (LOCAL_NEWS_FEEDS)', () => {
  it('defaults to the checked newsrooms, each with its credit, scope and skip rules', () => {
    const feeds = loadConfig({}).LOCAL_NEWS_FEEDS;
    expect(feeds.map((f) => f.id)).toEqual([
      'michigan_public',
      'bridgedetroit',
      'wdet',
      'bridge_michigan',
      'wemu',
    ]);
    expect(feeds.flatMap((f) => f.feed_urls)).toEqual([
      'https://www.michiganpublic.org/news.rss',
      'https://www.michiganpublic.org/index.rss',
      'https://www.michiganpublic.org/politics-government.rss',
      'https://www.bridgedetroit.com/feed/',
      'https://wdet.org/feed/',
      'https://bridgemi.com/feed/',
      'https://www.wemu.org/news.rss',
    ]);
    for (const f of feeds) {
      expect(f.attribution).toMatch(/^Source: .+ \([a-z.]+\)$/);
      expect(f.excerpt_max).toBeLessThanOrEqual(300);
      expect(f.poll_minutes).toBeGreaterThanOrEqual(15);
    }
    const byId = Object.fromEntries(feeds.map((f) => [f.id, f]));
    // Michigan Public asks for 30 to 60 minutes between polls; its AP copy is left out.
    expect(byId.michigan_public!.poll_minutes).toBe(30);
    expect(byId.michigan_public!.skip_creators).toContain('Associated Press');
    expect(byId.bridgedetroit!.skip_partner_credits).toBe(true);
    expect(byId.wdet!.short_name).toBe('WDET');
    expect(DEFAULT_LOCAL_NEWS_FEEDS).toHaveLength(5);
  });

  it('the owner can replace the list with JSON, or turn it off; bad values fail the config', () => {
    const custom = loadConfig({
      LOCAL_NEWS_FEEDS: JSON.stringify([
        { outlet: 'Example Weekly', feed_urls: ['https://weekly.example/rss'], region: ['Ohio'] },
      ]),
    }).LOCAL_NEWS_FEEDS;
    expect(custom).toEqual([
      expect.objectContaining({
        id: 'example_weekly',
        short_name: 'Example Weekly',
        attribution: 'Source: Example Weekly (weekly.example)',
        region: ['ohio'],
        excerpt_max: 300,
        poll_minutes: 15,
        skip_creators: [],
      }),
    ]);
    expect(parseLocalNewsFeeds('none')).toEqual([]);
    expect(parseLocalNewsFeeds('')).toHaveLength(5);
    for (const bad of [
      'not json',
      '{"outlet":"x"}',
      JSON.stringify([{ outlet: 'X', feed_urls: ['http://plain.example/rss'] }]),
      JSON.stringify([{ outlet: 'X', feed_urls: ['https://a.example/rss'], excerpt_max: 5000 }]),
      JSON.stringify([{ outlet: 'X', feed_urls: ['https://a.example/rss'], poll_minutes: 1 }]),
      JSON.stringify([{ outlet: 'X', feed_urls: ['https://a.example/rss'], bogus: 1 }]),
      JSON.stringify([
        { outlet: 'X', feed_urls: ['https://a.example/rss'] },
        { outlet: 'Y', feed_urls: ['https://a.example/rss'] },
      ]),
    ])
      expect(() => loadConfig({ LOCAL_NEWS_FEEDS: bad }), bad).toThrow(/LOCAL_NEWS_FEEDS/);
    // Same names get distinct ids.
    expect(
      normalizeFeeds([
        { outlet: 'Same', feed_urls: ['https://a.example/rss'] },
        { outlet: 'Same', feed_urls: ['https://b.example/rss'] },
      ]).map((f) => f.id),
    ).toEqual(['same', 'same_2']);
  });
});

describe('local news feeds: parsing', () => {
  const spec = (over: Partial<FeedSpec> = {}): FeedSpec => ({
    ...normalizeFeeds([{ outlet: 'Example News', feed_urls: ['https://news.example/feed'] }])[0]!,
    ...over,
  });

  it('reads RSS 2.0: headline, link, date, byline, categories and a short excerpt, never the full text', () => {
    const body = rss([
      {
        title: 'Council &amp; mayor agree — budget “done” | Example News',
        link: 'https://news.example/a?utm_source=rss',
        hoursAgo: 2,
        creator: 'Jane Doe',
        categories: ['Government', 'City'],
        description: `<p>${'Long words here. '.repeat(40)}</p>`,
      },
    ]);
    const p = parseFeed(body, spec(), NOW);
    expect(p.format).toBe('rss');
    expect(p.items).toHaveLength(1);
    const it0 = p.items[0]!;
    expect(it0).toMatchObject({
      // Entities decoded, the outlet's own name dropped from the end.
      title: 'Council & mayor agree — budget “done”',
      link: 'https://news.example/a?utm_source=rss',
      published_at: new Date(NOW - 2 * H).toISOString(),
      author: 'Jane Doe',
      categories: ['Government', 'City'],
    });
    expect(it0.excerpt!.length).toBeLessThanOrEqual(300);
    expect(it0.excerpt).toMatch(/^Long words here\..*…$/);
    expect(JSON.stringify(p)).not.toContain('FULL-TEXT-MARKER');
    // WordPress's "The post … appeared first on …" tail is dropped; HTML is removed.
    const wp = parseFeed(
      rss([{ title: 'Short one', link: 'https://news.example/b', hoursAgo: 1 }]),
      spec(),
      NOW,
    );
    expect(wp.items[0]!.excerpt).toBe('Short one: the short version.');
    // A smaller cap from the entry.
    const capped = parseFeed(body, spec({ excerpt_max: 40 }), NOW);
    expect(capped.items[0]!.excerpt!.length).toBeLessThanOrEqual(40);
    expect(parseFeed(body, spec({ excerpt_max: 0 }), NOW).items[0]!.excerpt).toBeUndefined();
  });

  it('reads Atom: the alternate link, published date, author name and summary, not the content', () => {
    const atom = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Example</title>
  <entry>
    <title type="html">Bridge &lt;b&gt;closed&lt;/b&gt; tonight</title>
    <link rel="self" href="https://news.example/self/1"/>
    <link rel="alternate" href="https://news.example/story/1"/>
    <published>2026-11-14T18:00:00Z</published>
    <updated>2026-11-14T19:00:00Z</updated>
    <author><name>Sam Writer</name></author>
    <category term="Traffic"/>
    <summary>The bridge closes at 10 p.m.</summary>
    <content type="html">FULL-TEXT-MARKER</content>
  </entry>
</feed>`;
    const p = parseFeed(atom, spec(), NOW);
    expect(p.format).toBe('atom');
    expect(p.items).toEqual([
      {
        title: 'Bridge closed tonight',
        link: 'https://news.example/story/1',
        published_at: '2026-11-14T18:00:00.000Z',
        author: 'Sam Writer',
        excerpt: 'The bridge closes at 10 p.m.',
        categories: ['Traffic'],
      },
    ]);
    expect(JSON.stringify(p)).not.toContain('FULL-TEXT-MARKER');
  });

  it('skips wire and partner copy, skipped categories, and items without a link, a date or too old', () => {
    const body = rss([
      { title: 'Own story', link: 'https://news.example/1', hoursAgo: 1, creator: 'Jane Doe' },
      {
        title: 'Two bylines',
        link: 'https://news.example/2',
        hoursAgo: 1,
        creator: 'Jane Doe, John Roe',
      },
      {
        title: 'Sister copy',
        link: 'https://news.example/3',
        hoursAgo: 1,
        creator: 'Pat Reporter, Bridge Detroit',
      },
      {
        title: 'Wire',
        link: 'https://news.example/4',
        hoursAgo: 1,
        creator: 'The Associated Press',
      },
      {
        title: 'Partner',
        link: 'https://news.example/5',
        hoursAgo: 1,
        creator: 'Jane Doe, Detroit Free Press',
      },
      { title: 'Station', link: 'https://news.example/6', hoursAgo: 1, creator: 'Jane Doe, WCMU' },
      { title: 'Org alone', link: 'https://news.example/7', hoursAgo: 1, creator: 'Detroit PBS' },
      { title: 'Show', link: 'https://news.example/8', hoursAgo: 1, categories: ['music'] },
      { title: 'Ancient', link: 'https://news.example/9', hoursAgo: 24 * 30 },
      { title: 'No link', link: 'javascript:alert(1)', hoursAgo: 1 },
    ]).replace(/<guid[^>]*>[^<]*<\/guid>/g, '');
    const p = parseFeed(
      body,
      spec({
        skip_creators: ['Associated Press'],
        skip_partner_credits: true,
        own_credits: ['Bridge Detroit'],
        skip_categories: ['Music'],
      }),
      NOW,
    );
    expect(p.items.map((i) => i.title)).toEqual(['Own story', 'Two bylines', 'Sister copy']);
    expect(p.skipped).toEqual({ creator: 1, partner: 3, category: 1, old: 1, no_link: 1 });
    expect(partnerCredit('Jane Doe', [])).toBe(false);
    expect(partnerCredit('Jane Doe, Chalkbeat Detroit', [])).toBe(true);
    expect(partnerCredit('Kim Doe, WKAR-FM', [])).toBe(true);
    // A surname is not a newsroom.
    expect(partnerCredit('Pat Reporter', [])).toBe(false);
    expect(partnerCredit('Jane Doe, Pat Reporter', [])).toBe(false);
  });

  it('refuses a page that is not a feed', () => {
    expect(() => parseFeed('<html><body>Not a feed</body></html>', spec(), NOW)).toThrow(
      /did not send an RSS or Atom feed/,
    );
  });
});

describe('local news feeds: the refresher', () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.useRealTimers();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const one = (over: Record<string, unknown> = {}) =>
    normalizeFeeds([{ outlet: 'Example News', feed_urls: ['https://news.example/feed'], ...over }]);
  const story = [{ title: 'A story', link: 'https://news.example/a', hoursAgo: 1 }];

  it('sends conditional GETs with the generic User-Agent; a 304 keeps the items', async () => {
    const clock = fakeClock();
    let notModified = false;
    const http = mockFetch((_u, h) =>
      notModified && h['if-none-match'] === '"v1"'
        ? new Response(null, { status: 304 })
        : xml(rss(story), { etag: '"v1"', 'last-modified': 'Sat, 14 Nov 2026 20:00:00 GMT' }),
    );
    const news = new LocalNewsFeeds({ feeds: one(), fetch: http.fetch, now: () => clock.now() });
    await news.refresh();
    expect(http.calls).toHaveLength(1);
    const first = http.calls[0]!.headers;
    expect(first['user-agent']).toBe(USER_AGENT);
    expect(first['user-agent']).not.toMatch(/rss-monitor/i);
    expect(first.accept).toMatch(/application\/rss\+xml/);
    expect(first['if-none-match']).toBeUndefined();
    expect(news.snapshot()[0]!.items.map((i) => i.title)).toEqual(['A story']);
    // Not due again before its interval.
    clock.t += 10 * 60_000;
    await news.refresh();
    expect(http.calls).toHaveLength(1);
    clock.t += 5 * 60_000;
    notModified = true;
    await news.refresh();
    expect(http.calls).toHaveLength(2);
    expect(http.calls[1]!.headers).toMatchObject({
      'if-none-match': '"v1"',
      'if-modified-since': 'Sat, 14 Nov 2026 20:00:00 GMT',
    });
    const snap = news.snapshot()[0]!;
    expect(snap).toMatchObject({ checkedAt: clock.t, stale: false });
    expect(snap.items.map((i) => i.title)).toEqual(['A story']);
  });

  it('honours an entry that asks for a longer interval', async () => {
    const clock = fakeClock();
    const http = mockFetch(() => xml(rss(story)));
    const news = new LocalNewsFeeds({
      feeds: one({ poll_minutes: 30 }),
      fetch: http.fetch,
      now: () => clock.now(),
    });
    await news.refresh();
    clock.t += 15 * 60_000;
    await news.refresh();
    expect(http.calls).toHaveLength(1);
    clock.t += 15 * 60_000;
    await news.refresh();
    expect(http.calls).toHaveLength(2);
  });

  it('a failing feed keeps its last good items, marked stale, and backs off 15, 30, 60 ... min', async () => {
    const clock = fakeClock();
    let status = 200;
    const http = mockFetch(() =>
      status === 200 ? xml(rss(story)) : new Response('busy', { status }),
    );
    const errors: string[] = [];
    const news = new LocalNewsFeeds({
      feeds: one(),
      fetch: http.fetch,
      now: () => clock.now(),
      onError: (outlet, _u, err) => errors.push(`${outlet}: ${(err as Error).message}`),
    });
    await news.refresh();
    status = 503;
    const at: number[] = [];
    for (let i = 0; i < 12; i++) {
      clock.t += 15 * 60_000;
      const before = http.calls.length;
      await news.refresh();
      if (http.calls.length > before) at.push((clock.t - NOW) / 60_000);
    }
    // Asked at 15 min, then 15, 30, 60 min after each failure.
    expect(at).toEqual([15, 30, 60, 120]);
    expect(errors[0]).toBe('Example News: the Example News feed returned HTTP 503');
    const snap = news.snapshot()[0]!;
    expect(snap).toMatchObject({
      checkedAt: NOW,
      stale: true,
      error: { message: 'the Example News feed returned HTTP 503' },
    });
    expect(snap.items.map((i) => i.title)).toEqual(['A story']);
    // A 429's Retry-After is honoured when longer.
    const c2 = fakeClock();
    const h2 = mockFetch(
      () => new Response('slow', { status: 429, headers: { 'retry-after': '3600' } }),
    );
    const n2 = new LocalNewsFeeds({ feeds: one(), fetch: h2.fetch, now: () => c2.now() });
    await n2.refresh();
    c2.t += 30 * 60_000;
    await n2.refresh();
    expect(h2.calls).toHaveLength(1);
    c2.t += 30 * 60_000;
    await n2.refresh();
    expect(h2.calls).toHaveLength(2);
  });

  it('a feed that hangs times out without holding up the others', async () => {
    const feeds = normalizeFeeds([
      { outlet: 'Slow News', feed_urls: ['https://slow.example/feed'] },
      { outlet: 'Example News', feed_urls: ['https://news.example/feed'] },
    ]);
    const fetch: FetchLike = (url, init) =>
      url.includes('slow')
        ? new Promise((_r, reject) =>
            init.signal!.addEventListener('abort', () => reject(new Error('aborted'))),
          )
        : Promise.resolve(xml(rss(story)));
    const news = new LocalNewsFeeds({ feeds, fetch, now: () => NOW, timeoutMs: 50 });
    await news.refresh();
    const [slow, ok] = news.snapshot();
    expect(slow).toMatchObject({
      stale: true,
      error: { message: 'the Slow News feed did not answer within 0 s' },
    });
    expect(ok!.items).toHaveLength(1);
  });

  it('keeps the snapshot (items and validators, never full text) on disk, private, for a restart', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gw-news-'));
    dirs.push(dir);
    const file = path.join(dir, 'cache', 'local-news.json');
    const clock = fakeClock();
    const http = mockFetch((_u, h) =>
      h['if-none-match'] === '"v1"'
        ? new Response(null, { status: 304 })
        : xml(rss(story), { etag: '"v1"' }),
    );
    const a = new LocalNewsFeeds({ feeds: one(), fetch: http.fetch, now: () => clock.now(), file });
    await a.refresh();
    const saved = readFileSync(file, 'utf8');
    expect(saved).toContain('A story');
    expect(saved).not.toContain('FULL-TEXT-MARKER');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // After a restart: the items at once, and the validator for the next request.
    clock.t += 20 * 60_000;
    const b = new LocalNewsFeeds({ feeds: one(), fetch: http.fetch, now: () => clock.now(), file });
    expect(b.snapshot()[0]).toMatchObject({
      checkedAt: NOW,
      items: [expect.objectContaining({ title: 'A story' })],
    });
    await b.refresh();
    expect(http.calls.at(-1)!.headers['if-none-match']).toBe('"v1"');
    expect(b.snapshot()[0]!.items).toHaveLength(1);
    // A damaged file is ignored.
    writeFileSync(file, '{not json');
    expect(
      new LocalNewsFeeds({ feeds: one(), fetch: http.fetch, now: () => NOW, file }).snapshot()[0]!
        .items,
    ).toEqual([]);
  });

  it('a refresh cut short by stop() (shutdown) is not counted as the feed failing', async () => {
    const errors: unknown[] = [];
    const fetch: FetchLike = (_u, init) =>
      new Promise((_r, reject) =>
        init.signal!.addEventListener('abort', () => reject(new Error('aborted'))),
      );
    const news = new LocalNewsFeeds({
      feeds: one(),
      fetch,
      now: () => NOW,
      onError: (_o, _u, e) => errors.push(e),
    });
    const p = news.refresh();
    news.stop();
    await p;
    expect(errors).toEqual([]);
    expect(news.snapshot()[0]).toMatchObject({ stale: false, items: [] });
    expect(news.snapshot()[0]!.error).toBeUndefined();
  });

  it('start() refreshes in the background every 15 minutes; stop() ends it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const http = mockFetch(() => xml(rss(story)));
    let t = NOW;
    const news = new LocalNewsFeeds({
      feeds: one(),
      fetch: http.fetch,
      now: () => t,
      startupDelayMs: 1000,
    });
    news.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(http.calls).toHaveLength(1);
    t += 15 * 60_000;
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(http.calls).toHaveLength(2);
    news.stop();
    t += 15 * 60_000;
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(http.calls).toHaveLength(2);
  });
});

describe('local_headlines from the local news feeds', () => {
  it('answers from the snapshot: the place first, then its metro, newest first, each with its byline', async () => {
    const { run, runner, feedCalls } = setup();
    const r = await run({ place: 'Dearborn' });
    expect(r.isError).toBeFalsy();
    expect(feedCalls()).toHaveLength(7);
    expect(titles(r)).toEqual([
      // Names the place.
      'Dearborn library expands weekend hours',
      // Metro Detroit: outlets covering it, and statewide stories naming Detroit.
      'Morning news roundup',
      'City council approves park plan',
      'Detroit’s Eastern Market adds Sunday hours',
      'Detroit transit board meets',
    ]);
    expect(heads(r).map((h) => h.match)).toEqual(['place', 'area', 'area', 'area', 'area']);
    expect(heads(r)[0]).toEqual({
      title: 'Dearborn library expands weekend hours',
      link: 'https://www.michiganpublic.org/news/dearborn-library',
      outlet: 'Michigan Public',
      byline: 'by Jane Doe, Michigan Public',
      published_at: new Date(NOW - 3 * H).toISOString(),
      excerpt: 'Dearborn library expands weekend hours: the short version.',
      match: 'place',
      source: 'feed',
      attribution: 'Source: Michigan Public (michiganpublic.org)',
    });
    // The sister newsroom's copy of the same story is listed once, from the first outlet.
    expect(heads(r)[3]).toMatchObject({
      outlet: 'BridgeDetroit',
      byline: 'by Pat Reporter, BridgeDetroit',
    });
    expect(r.summary).toContain(
      '1. "Dearborn library expands weekend hours" by Jane Doe, Michigan Public, Nov 14, 2026 (3 h ago), https://www.michiganpublic.org/news/dearborn-library',
    );
    expect(r.summary).toMatch(
      /^5 headline\(s\) for Dearborn from the last 72 h \(stories naming Dearborn first, then news of Metro Detroit\), newest first:/,
    );
    expect(r.summary).toContain(PERSONAL_USE_NOTE);
    expect(r.summary).toMatch(/untrusted third-party text/);
    // Wire, partner and music items, and the full text, never appear.
    const all = JSON.stringify(r);
    for (const gone of [
      'Wire story',
      'Partner story',
      'Another partner',
      'Jazz show',
      'FULL-TEXT-MARKER',
      'Old story',
    ])
      expect(all, gone).not.toContain(gone);
    expect(data(r)).toMatchObject({
      status: 'ok',
      metro: 'Metro Detroit',
      count: 5,
      sources: { gdelt: { status: 'ok' } },
      personal_use: PERSONAL_USE_NOTE,
    });
    const status = (data(r).sources as { feeds: Array<{ status: string }> }).feeds;
    expect(status.map((s) => s.status)).toEqual([
      'current',
      'current',
      'current',
      'current',
      'current',
    ]);
    // Over MCP: each outlet is credited.
    const out = await runner.run('local_headlines', { place: 'Dearborn' }, ctx());
    expect(out.content[0]!.text).toMatch(
      /Attribution: Local news feeds: Michigan Public \(michiganpublic\.org\); BridgeDetroit \(bridgedetroit\.com\); WDET 101\.9 FM \(wdet\.org\); Bridge Michigan \(bridgemi\.com\); WEMU 89\.1 FM \(wemu\.org\)/,
    );
    // Answered from the snapshot: no feed is asked again.
    expect(feedCalls()).toHaveLength(7);
  });

  it("an outlet's own town gets all its stories; statewide outlets only when they name the place", async () => {
    const { run } = setup();
    const detroit = await run({ place: 'Detroit' });
    expect(titles(detroit)).toEqual([
      'Morning news roundup',
      'City council approves park plan',
      'Detroit’s Eastern Market adds Sunday hours',
      'Detroit transit board meets',
    ]);
    expect(heads(detroit).every((h) => h.match === 'place')).toBe(true);
    const ypsi = await run({ place: 'Ypsilanti' });
    expect(titles(ypsi).slice(0, 2)).toEqual([
      'Ypsilanti road project starts',
      'County board vote',
    ]);
    expect(
      heads(ypsi)
        .slice(0, 2)
        .map((h) => h.outlet),
    ).toEqual(['WEMU', 'WEMU']);
    // Without a byline, the outlet alone.
    expect(heads(ypsi)[1]!.byline).toBeUndefined();
    expect(ypsi.summary).toContain(
      '2. "County board vote" (WEMU), Nov 14, 2026 (12 h ago), https://www.wemu.org/board/',
    );
    const lansing = await run({ place: 'Lansing, Michigan' });
    expect(titles(lansing)).toEqual(['Budget talks resume in Lansing', 'Lansing housing plan']);
    // The Michigan Public story is in two of its feeds (one link with tracking): listed once.
    expect(heads(lansing)[0]!.link).toBe('https://www.michiganpublic.org/politics/budget');
  });

  it('asks an outlet only about places in the states it covers', async () => {
    const { run } = setup();
    const il = await run({ place: 'Lansing, IL' });
    expect(data(il)).toMatchObject({ status: 'ok', count: 0 });
    expect(
      (data(il).sources as { feeds: Array<{ not_asked?: string }> }).feeds.every(
        (f) => f.not_asked === 'outside its area',
      ),
    ).toBe(true);
    expect(il.summary).toMatch(
      /^No headlines for Lansing, IL in the last 72 h in the GDELT news index \(no local news feed covers this place\)\./,
    );
    // A place with no state given: any outlet, by name only.
    const bare = await run({ place: 'Lansing' });
    expect(titles(bare)).toEqual(['Budget talks resume in Lansing', 'Lansing housing plan']);
  });

  it('looks back `hours` (default 72) and lists at most `max`', async () => {
    const { run } = setup();
    expect(titles(await run({ place: 'Detroit', hours: 2 }))).toEqual(['Morning news roundup']);
    expect(titles(await run({ place: 'Detroit', max: 2 }))).toHaveLength(2);
  });

  it('coordinates: the Census town and county decide the place and the area', async () => {
    const { run, http } = setup({
      handler: (url) =>
        url.startsWith(CENSUS_COORDINATES_API)
          ? json({
              result: {
                geographies: {
                  States: [{ NAME: 'Michigan' }],
                  'Incorporated Places': [{ BASENAME: 'Detroit' }],
                  Counties: [{ NAME: 'Wayne County' }],
                },
              },
            })
          : undefined,
    });
    const r = await run({ ...DETROIT });
    expect(data(r)).toMatchObject({ place: 'Detroit, Michigan', metro: 'Metro Detroit' });
    expect(titles(r)[0]).toBe('Morning news roundup');
    const census = new URL(http.calls.find((c) => c.url.startsWith(CENSUS_COORDINATES_API))!.url);
    expect([census.searchParams.get('y'), census.searchParams.get('x')]).toEqual([
      '42.33',
      '-83.05',
    ]);
  });

  it('a feed that is down is served from its last good answer, marked with its age', async () => {
    let down = false;
    const { run, clock } = setup({
      handler: (url) =>
        down && url === 'https://wdet.org/feed/' ? new Response('x', { status: 503 }) : undefined,
    });
    await run({ place: 'Detroit' });
    down = true;
    clock.t += 2 * H;
    const r = await run({ place: 'Detroit' });
    const wdet = heads(r).find((h) => h.outlet === 'WDET')!;
    expect(wdet).toMatchObject({ title: 'Morning news roundup', from: '2 h ago' });
    expect(r.summary).toContain(
      '"Morning news roundup" by Alex Host, WDET, Nov 14, 2026 (3 h ago), https://wdet.org/roundup/ [WDET feed from 2 h ago]',
    );
    expect(r.summary).toContain(
      'WDET: from 2 h ago (its latest refresh failed: the WDET feed returned HTTP 503).',
    );
    const feeds = (data(r).sources as { feeds: Array<Record<string, unknown>> }).feeds;
    expect(feeds.find((f) => f.outlet === 'WDET 101.9 FM')).toMatchObject({
      status: 'stale',
      age_s: expect.toSatisfy((n: number) => n >= 7200 && n < 7260),
      latest_error: 'the WDET feed returned HTTP 503',
    });
    expect(heads(r).find((h) => h.outlet === 'BridgeDetroit')!.from).toBeUndefined();
  });

  it('says which outlet has not answered yet', async () => {
    const { run } = setup({
      handler: (url) =>
        url === 'https://www.wemu.org/news.rss' ? new Response('x', { status: 500 }) : undefined,
    });
    const r = await run({ place: 'Ypsilanti' });
    expect(r.summary).toContain('WEMU: no answer yet (the WEMU feed returned HTTP 500).');
    const feeds = (data(r).sources as { feeds: Array<Record<string, unknown>> }).feeds;
    expect(
      feeds.find((f) => f.outlet === 'WEMU 89.1 FM (Eastern Michigan University)'),
    ).toMatchObject({
      status: 'failing',
      items: 0,
    });
  });

  it('GDELT is an extra: merged when it answers, its last answer (with its age) while it is paused', async () => {
    let refuse = false;
    const { run, clock, http } = setup({
      gdelt: (u) =>
        refuse
          ? new Response('Please limit requests to one every 5 seconds', { status: 429 })
          : u.searchParams.get('query')!.includes('domain:')
            ? json({
                articles: [
                  {
                    url: 'https://tv.example/dearborn-parade',
                    title: 'Dearborn parade route set',
                    seendate: '20261114T190000Z',
                    domain: 'tv.example',
                  },
                  // Already in a feed: not repeated.
                  {
                    url: 'https://www.michiganpublic.org/news/dearborn-library',
                    title: 'Dearborn library expands weekend hours',
                    seendate: '20261114T190000Z',
                    domain: 'michiganpublic.org',
                  },
                ],
              })
            : json({ articles: [] }),
    });
    const r = await run({ place: 'Dearborn' });
    expect(titles(r).slice(0, 2)).toEqual([
      'Dearborn parade route set',
      'Dearborn library expands weekend hours',
    ]);
    expect(heads(r)[0]).toMatchObject({ source: 'gdelt', match: 'place', outlet: 'tv.example' });
    expect(r.summary).toContain(
      '1. "Dearborn parade route set" (tv.example, seen 2 h ago, via GDELT), https://tv.example/dearborn-parade',
    );
    // Paused by a refusal: the feeds answer at once, with GDELT's last answer marked by its age.
    refuse = true;
    clock.t += 20 * 60_000;
    const asked = http.calls.filter((c) => c.url.startsWith(GDELT_DOC_API)).length;
    const paused = await run({ place: 'Dearborn' });
    expect(data(paused)).toMatchObject({
      status: 'ok',
      sources: { gdelt: { status: 'paused', retry_after_s: 60, from: '20 min ago' } },
    });
    expect(heads(paused)[0]).toMatchObject({
      title: 'Dearborn parade route set',
      from: '20 min ago',
    });
    expect(paused.summary).toMatch(
      /GDELT: GDELT asked this gateway to slow down \(HTTP 429\); next try in 60 s; its last answer, from 20 min ago, is used\./,
    );
    // Called again while paused: nothing is sent to GDELT.
    clock.t += 30_000;
    const again = await run({ place: 'Dearborn' });
    expect(http.calls.filter((c) => c.url.startsWith(GDELT_DOC_API)).length).toBe(asked + 1);
    expect(data(again)).toMatchObject({
      sources: { gdelt: { status: 'paused', retry_after_s: 30 } },
    });
    // A place GDELT never answered for: feeds only, GDELT "not used".
    const fresh = await run({ place: 'Ypsilanti' });
    expect(fresh.summary).toMatch(/GDELT: not used \(this gateway pauses GDELT requests/);
    expect(titles(fresh)[0]).toBe('Ypsilanti road project starts');
  });

  it('with no feed answer yet and GDELT paused, says so and when to try again', async () => {
    const { run } = setup({
      handler: (url) =>
        url.startsWith('https://') && !url.startsWith(GDELT_DOC_API)
          ? new Response('x', { status: 500 })
          : undefined,
      gdelt: () => new Response('Please limit requests to one every 5 seconds', { status: 429 }),
    });
    const r = await run({ place: 'Detroit' });
    expect(r.isError).toBeFalsy();
    expect(data(r)).toMatchObject({ status: 'unavailable', retry_after_s: 60, fetched: false });
    expect(r.summary).toMatch(
      /^Headlines for Detroit are unavailable right now: GDELT asked this gateway to slow down \(HTTP 429\)\..* The local news feeds have not answered yet \(the Michigan Public feed returned HTTP 500\)\. Try again in 60 s\.$/,
    );
  });
});
