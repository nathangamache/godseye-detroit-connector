/**
 * The local news feeds local_headlines reads (LOCAL_NEWS_FEEDS). Unset, it is the list below:
 * public RSS feeds of local newsrooms whose robots.txt, terms and republishing rules were checked
 * for this use (personal, non-commercial reading behind the owner's login; headline, link, date,
 * byline and a short excerpt only, never the full text; link out, never frame). The owner can
 * replace it with a JSON array of entries shaped like DEFAULT_LOCAL_NEWS_FEEDS (snake_case keys),
 * or turn the feeds off with "none".
 *
 * A leaf module (zod only), so config.ts can validate the setting when it loads.
 */
import { z } from 'zod';

/** The default refresh interval of every feed; an entry may ask for a longer one. */
export const FEED_DEFAULT_POLL_MINUTES = 15;

const words = (max: number) => z.array(z.string().trim().min(1).max(80)).max(max).default([]);

const httpsUrl = z
  .string()
  .trim()
  .max(500)
  .refine((s) => {
    try {
      const u = new URL(s);
      return u.protocol === 'https:' && !u.username && !u.password && u.hostname.includes('.');
    } catch {
      return false;
    }
  }, 'must be an https URL');

const entry = z.strictObject({
  /** Short id for data and the disk snapshot (default: from short_name). */
  id: z
    .string()
    .regex(/^[a-z0-9_]{2,40}$/)
    .optional(),
  /** The outlet's full name. */
  outlet: z.string().trim().min(2).max(120),
  /** The name a byline uses ("by <author>, <short_name>"); default: outlet. */
  short_name: z.string().trim().min(2).max(60).optional(),
  feed_urls: z.array(httpsUrl).min(1).max(5),
  /** Credit shown with every item of this outlet; default "Source: <outlet> (<host>)". */
  attribution: z.string().trim().min(5).max(200).optional(),
  /** States or provinces the outlet covers (lower case): its items count for places there when they name the place. */
  region: words(5),
  /** Metro ids (src/extra/civic/outlets.ts) whose news this outlet covers: all its items count as area news there. */
  metros: words(5),
  /** Places (towns or counties, lower case) whose own outlet this is: all its items count for them. */
  home: words(20),
  /** Items whose byline contains one of these (any case) are skipped (wire copy, partners). */
  skip_creators: words(30),
  /** Bylines "Name, Org" where Org looks like another newsroom are skipped (partner copy). */
  skip_partner_credits: z.boolean().default(false),
  /** Names of this outlet (and sister newsrooms) a byline may carry without being a partner. */
  own_credits: words(10),
  /** Items in one of these feed categories (any case) are skipped. */
  skip_categories: words(20),
  /** Longest excerpt kept from an item's short description (never its full text). */
  excerpt_max: z.int().min(0).max(300).default(300),
  /** Refresh no more often than this (minutes; the refresher runs every 15). */
  poll_minutes: z.int().min(FEED_DEFAULT_POLL_MINUTES).max(1440).default(FEED_DEFAULT_POLL_MINUTES),
});

export type FeedSpecInput = z.input<typeof entry>;

export interface FeedSpec extends Omit<
  z.output<typeof entry>,
  'id' | 'short_name' | 'attribution'
> {
  id: string;
  short_name: string;
  attribution: string;
}

export const DEFAULT_LOCAL_NEWS_FEEDS: FeedSpecInput[] = [
  {
    outlet: 'Michigan Public',
    feed_urls: [
      'https://www.michiganpublic.org/news.rss',
      'https://www.michiganpublic.org/index.rss',
      'https://www.michiganpublic.org/politics-government.rss',
    ],
    attribution: 'Source: Michigan Public (michiganpublic.org)',
    region: ['michigan'],
    // Associated Press copy (its terms bar republishing or rewriting it) is left out.
    skip_creators: ['Associated Press'],
    // The newsroom asks for polling every 30 to 60 minutes.
    poll_minutes: 30,
  },
  {
    outlet: 'BridgeDetroit',
    feed_urls: ['https://www.bridgedetroit.com/feed/'],
    attribution: 'Source: BridgeDetroit (bridgedetroit.com)',
    region: ['michigan'],
    metros: ['detroit'],
    home: ['detroit'],
    // Partner copy (another newsroom's byline) is not BridgeDetroit's to offer.
    skip_creators: ['Detroit Free Press', 'Detroit PBS', 'Associated Press'],
    skip_partner_credits: true,
    own_credits: ['BridgeDetroit', 'Bridge Detroit'],
  },
  {
    outlet: 'WDET 101.9 FM',
    short_name: 'WDET',
    feed_urls: ['https://wdet.org/feed/'],
    attribution: 'Source: WDET 101.9 FM (wdet.org)',
    region: ['michigan'],
    metros: ['detroit'],
    home: ['detroit'],
    // Music-show posts are not news.
    skip_categories: ['Music'],
  },
  {
    outlet: 'Bridge Michigan',
    feed_urls: ['https://bridgemi.com/feed/'],
    attribution: 'Source: Bridge Michigan (bridgemi.com)',
    region: ['michigan'],
    skip_creators: ['Associated Press'],
    skip_partner_credits: true,
    // Its sister newsroom's stories are kept, and de-duplicated against the BridgeDetroit feed.
    own_credits: ['Bridge Michigan', 'BridgeMI', 'BridgeDetroit', 'Bridge Detroit'],
  },
  {
    outlet: 'WEMU 89.1 FM (Eastern Michigan University)',
    short_name: 'WEMU',
    feed_urls: ['https://www.wemu.org/news.rss'],
    attribution: 'Source: WEMU 89.1 FM (wemu.org)',
    region: ['michigan'],
    home: ['washtenaw county', 'ann arbor', 'ypsilanti'],
    skip_creators: ['Associated Press'],
  },
];

const list = z.array(entry).max(20);

function slug(s: string): string {
  return (
    s
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'feed'
  );
}

/** Validated entries with their defaults filled in; ids are unique. Throws with the reason. */
export function normalizeFeeds(input: unknown): FeedSpec[] {
  const parsed = list.safeParse(input);
  if (!parsed.success) {
    const why = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.') || '(list)'}: ${i.message}`)
      .join('; ');
    throw new Error(why);
  }
  const ids = new Set<string>();
  const urls = new Set<string>();
  return parsed.data.map((e) => {
    const short = e.short_name ?? e.outlet;
    let id = e.id ?? slug(short);
    for (let n = 2; ids.has(id); n++) id = `${e.id ?? slug(short)}_${n}`.slice(0, 40);
    ids.add(id);
    for (const u of e.feed_urls) {
      if (urls.has(u)) throw new Error(`${u} is listed twice`);
      urls.add(u);
    }
    const host = new URL(e.feed_urls[0]!).hostname.replace(/^www\./, '');
    const lower = (xs: string[]) => xs.map((x) => x.toLowerCase());
    return {
      ...e,
      id,
      short_name: short,
      attribution: e.attribution ?? `Source: ${e.outlet} (${host})`,
      region: lower(e.region),
      metros: lower(e.metros),
      home: lower(e.home),
    };
  });
}

/**
 * LOCAL_NEWS_FEEDS: unset or empty = the default list; "none" (or "off", "[]") = no feeds; else a
 * JSON array of entries. Throws with the reason when it is not valid.
 */
export function parseLocalNewsFeeds(raw: string | undefined): FeedSpec[] {
  const s = raw?.trim();
  if (!s) return normalizeFeeds(DEFAULT_LOCAL_NEWS_FEEDS);
  if (/^(none|off)$/i.test(s)) return [];
  let j: unknown;
  try {
    j = JSON.parse(s);
  } catch {
    throw new Error('expected a JSON array of feed entries, or "none"');
  }
  return normalizeFeeds(j);
}
