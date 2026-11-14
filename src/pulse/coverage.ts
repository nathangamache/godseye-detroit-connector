/**
 * Coverage honesty: "no messages" only means "quiet" when a receiver is actually listening.
 *
 * Pulse's GET /v1/feeds/status (docs/pulse-api-contract.md) reports, per feed, a `receiver`
 * (not_installed | offline | online) and a `coverage` block (area, rail lines with aliases,
 * radius), plus a top-level `coverage_summary`. This module turns that, and the number of
 * messages a query found, into one verdict per kind of source:
 *
 *   activity found · listening and quiet · receiver offline since T ·
 *   no receiver (none configured / never reported / none for this line / no line identified /
 *   none near this point / Pulse's point lookup says not covered / not searched by Pulse for
 *   this point) · can't say (old Pulse)
 *
 * Example/placeholder feeds (ids starting "example_" or flagged example: true) never count.
 * Rail lines are matched on every name the datasets give a track and every alias Pulse lists,
 * normalised (src/rail/names.ts), never on one string.
 *
 * Every verdict is about the point asked: "quiet" needs a receiver that covers it. Rail voice
 * is judged per line (the line identified at the point, or the channels Pulse's rail/activity
 * lists for it); when Pulse sends that list, only a voice channel it lists can be quiet, since
 * Pulse searched no other channel's transcripts for the point. EOT/HOT is judged per the "eot"
 * channels rail/activity lists for the point (Pulse lists one only when its receiver is within
 * range of the point or has no location set). rail/activity's `covered` is split per kind.
 */
import {
  formatLineNames,
  trackMatchesLine,
  displayLineName,
  type CoverageLine,
  type TrackNames,
} from '../rail/names.js';
import { humanAge } from '../util/format.js';

export type CoverageKind = 'rail_radio' | 'eot' | 'public_safety';
export type SummaryState = 'no_receiver' | 'receiver_offline' | 'listening' | 'not_configured';
export type ReceiverState = 'not_installed' | 'offline' | 'online';

export interface FeedInfo {
  feed_id: string;
  name?: string;
  category?: string;
  kind?: string;
  enabled?: boolean;
  state?: string;
  last_chunk_at?: string;
  chunks_last_hour?: number;
  source?: string;
  county?: string;
  example?: boolean;
  unmapped?: boolean;
  receiver?: { state: ReceiverState; last_seen_at?: string; device?: string };
  coverage?: { area?: string; lines?: CoverageLine[]; radius_km?: number };
}

export interface FeedsStatus {
  generated_at?: string;
  feeds: FeedInfo[];
  coverage_summary?: Partial<Record<CoverageKind, SummaryState>>;
}

const MAX_FEEDS = 500;
const MAX_LINES = 50;
const str = (v: unknown, max = 120): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const iso = (v: unknown): string | undefined => {
  const s = str(v, 40);
  return s && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString() : undefined;
};
const RECEIVER_STATES = new Set<ReceiverState>(['not_installed', 'offline', 'online']);
const SUMMARY_STATES = new Set<SummaryState>([
  'no_receiver',
  'receiver_offline',
  'listening',
  'not_configured',
]);

/** Defensive parse of a feeds/status body: known fields only, bounded sizes. */
export function parseFeedsStatus(body: unknown): FeedsStatus {
  const j = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const feeds: FeedInfo[] = [];
  for (const raw of Array.isArray(j.feeds) ? j.feeds.slice(0, MAX_FEEDS) : []) {
    if (!raw || typeof raw !== 'object') continue;
    const f = raw as Record<string, unknown>;
    const feed_id = str(f.feed_id, 80);
    if (!feed_id) continue;
    const out: FeedInfo = { feed_id };
    out.name = str(f.name);
    out.category = str(f.category, 40);
    out.kind = str(f.kind, 40);
    if (typeof f.enabled === 'boolean') out.enabled = f.enabled;
    out.state = str(f.state, 20);
    out.last_chunk_at = iso(f.last_chunk_at);
    out.chunks_last_hour = num(f.chunks_last_hour);
    out.source = str(f.source, 80);
    out.county = str(f.county, 80);
    if (f.example === true) out.example = true;
    if (f.unmapped === true) out.unmapped = true;
    const r = f.receiver as Record<string, unknown> | undefined;
    if (r && typeof r === 'object' && RECEIVER_STATES.has(r.state as ReceiverState)) {
      out.receiver = { state: r.state as ReceiverState };
      const seen = iso(r.last_seen_at);
      if (seen) out.receiver.last_seen_at = seen;
      const device = str(r.device, 80);
      if (device) out.receiver.device = device;
    }
    const c = f.coverage as Record<string, unknown> | undefined;
    if (c && typeof c === 'object') {
      const cov: NonNullable<FeedInfo['coverage']> = {};
      const area = str(c.area);
      if (area) cov.area = area;
      const radius = num(c.radius_km);
      if (radius !== undefined && radius >= 0) cov.radius_km = radius;
      if (Array.isArray(c.lines)) {
        cov.lines = [];
        for (const l of c.lines.slice(0, MAX_LINES)) {
          if (!l || typeof l !== 'object') continue;
          const line = l as Record<string, unknown>;
          const name = str(line.name);
          if (!name) continue;
          const aliases = Array.isArray(line.aliases)
            ? line.aliases.map((a) => str(a)).filter((a): a is string => Boolean(a))
            : [];
          cov.lines.push({ railroad: str(line.railroad, 60), name, aliases: aliases.slice(0, 20) });
        }
      }
      out.coverage = cov;
    }
    feeds.push(
      Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as FeedInfo,
    );
  }
  const status: FeedsStatus = { feeds };
  const gen = iso(j.generated_at);
  if (gen) status.generated_at = gen;
  const cs = j.coverage_summary as Record<string, unknown> | undefined;
  if (cs && typeof cs === 'object') {
    status.coverage_summary = {};
    for (const k of ['rail_radio', 'eot', 'public_safety'] as const)
      if (SUMMARY_STATES.has(cs[k] as SummaryState))
        status.coverage_summary[k] = cs[k] as SummaryState;
  }
  return status;
}

/** Shipped example/placeholder feeds: reported by Pulse but never coverage. */
export function isExampleFeed(f: Pick<FeedInfo, 'feed_id' | 'example'>): boolean {
  return f.example === true || /^example_/i.test(f.feed_id);
}

/**
 * Which kind of source a feed is. The contract's categories are "rail" and "public_safety";
 * within rail, end-of-train telemetry is told apart by an explicit `kind`, its traintap
 * source, or an EOT id/name.
 */
export function feedKind(f: FeedInfo): CoverageKind | undefined {
  const k = (f.kind ?? '').toLowerCase();
  if (k === 'eot' || k === 'hot') return 'eot';
  if (f.category === 'public_safety') return 'public_safety';
  if (f.category !== 'rail') return undefined;
  if (
    /traintap|\beot\b/i.test(f.source ?? '') ||
    /(^|[_\-\s/])eot([_\-\s/]|$)/i.test(f.feed_id) ||
    /\bEOT\b/.test(f.name ?? '')
  )
    return 'eot';
  return 'rail_radio';
}

/** Does this Pulse report receivers and coverage (contract v1.1)? Older Pulse doesn't. */
export function reportsCoverage(s: FeedsStatus): boolean {
  return s.coverage_summary !== undefined || s.feeds.some((f) => f.receiver !== undefined);
}

export interface FeedRef {
  feed_id: string;
  name: string;
  receiver?: ReceiverState;
  last_seen_at?: string;
  area?: string;
  located?: boolean;
}

export type NoReceiverReason =
  | 'not_configured'
  | 'never_reported'
  | 'not_this_line'
  /** Rail voice: no line identified at the point and Pulse listed no channel for it. */
  | 'no_line'
  /** EOT/HOT: Pulse's rail/activity lists no EOT channel for the point (receivers too far). */
  | 'not_near'
  /** rail/activity said covered:false for the point (v1.1): no listed receiver has reported. */
  | 'pulse_not_covered'
  /**
   * Rail voice: rail/activity's channel list for the point doesn't include these feeds (they
   * match the line by name only), so Pulse never searched their transcripts there.
   */
  | 'not_searched';

export type Verdict =
  | {
      kind: CoverageKind;
      state: 'activity';
      messages: number;
      feeds: FeedRef[];
      /** EOT/HOT: receivers that don't cover the point but may have heard some of the packets. */
      elsewhere?: FeedRef[];
    }
  | { kind: CoverageKind; state: 'quiet'; window_min: number; feeds: FeedRef[] }
  | { kind: CoverageKind; state: 'offline'; since?: string; feeds: FeedRef[] }
  | {
      kind: CoverageKind;
      state: 'no_receiver';
      reason: NoReceiverReason;
      covered_lines?: string[];
      /** Messages Pulse returned that no receiver covering the point heard (not counted). */
      ignored_messages?: number;
      feeds: FeedRef[];
    }
  | { kind: CoverageKind; state: 'unknown'; reason: 'pulse_too_old' | 'status_unavailable' };

export interface AssessOptions {
  /** Messages this query found for the kind (transcripts + detector readouts, packets, incidents). */
  messages: number;
  window_min: number;
  /** Rail radio only: the tracks at the point, with every name (src/rail/index.ts tracksNear). */
  tracks?: TrackNames[];
  /**
   * Channel names (labels or feed ids) of this kind that Pulse's own rail/activity lookup listed
   * for the point: road/dispatcher/detector channels for rail radio, "eot" channels for EOT/HOT.
   * `[]` means Pulse listed none for this point; undefined means the list isn't known (an older
   * Pulse). For rail radio, a list means only the feeds in it were searched, so only they can
   * be quiet or offline; without one, a feed whose coverage line is the track at the point counts.
   */
  pulseChannels?: string[];
  /**
   * rail/activity's coverage.covered for the point, for this kind (pulseCoveredFor): v1.1, a
   * listed receiver of this kind has reported.
   */
  pulseCovered?: boolean;
}

function ref(f: FeedInfo): FeedRef {
  const r: FeedRef = { feed_id: f.feed_id, name: f.name ?? f.feed_id };
  if (f.receiver) r.receiver = f.receiver.state;
  if (f.receiver?.last_seen_at) r.last_seen_at = f.receiver.last_seen_at;
  const area = f.coverage?.area ?? f.county;
  if (area) r.area = area;
  r.located = Boolean(f.coverage?.area || f.coverage?.radius_km);
  return r;
}

/** Real (non-example), enabled feeds of a kind. */
export function feedsOfKind(status: FeedsStatus, kind: CoverageKind): FeedInfo[] {
  return status.feeds.filter(
    (f) => !isExampleFeed(f) && f.enabled !== false && feedKind(f) === kind,
  );
}

/** The Pulse coverage line (and its feed) that is the same track as one of `tracks`, if any. */
export function matchCoverageLine(
  status: FeedsStatus,
  tracks: TrackNames[],
): { feed: FeedInfo; line: CoverageLine } | undefined {
  for (const f of feedsOfKind(status, 'rail_radio'))
    for (const line of f.coverage?.lines ?? [])
      if (tracks.some((t) => trackMatchesLine(t, line))) return { feed: f, line };
  return undefined;
}

export function assess(
  kind: CoverageKind,
  status: FeedsStatus | undefined,
  opts: AssessOptions,
): Verdict {
  const v = judge(kind, status, opts);
  // Pulse's own lookup for this point (v1.1) says no receiver covering it has reported: whatever
  // feeds/status says (it may be a few seconds older), that is not "quiet".
  if (v.state === 'quiet' && opts.pulseCovered === false && status && reportsCoverage(status))
    return { kind, state: 'no_receiver', reason: 'pulse_not_covered', feeds: v.feeds };
  return v;
}

/**
 * rail/activity's `coverage.covered` for one kind. Pulse computes `covered` over the voice and EOT
 * channels it lists together, so a reported EOT receiver near the point makes it true where no
 * voice channel is listed (and the reverse). Each listed channel carries its own
 * `receiver_state`: when every listed channel of the kind has one, the kind is covered when one
 * of them (not an example placeholder or a disabled feed) has reported, online or offline, as
 * in Pulse's own rule. Without per-channel states, covered:false holds for both kinds, a kind
 * Pulse lists no channel for is not covered, and covered:true is kept for a kind it lists.
 */
export function pulseCoveredFor(
  kind: 'rail_radio' | 'eot',
  coverage: unknown,
  status?: FeedsStatus,
): boolean | undefined {
  const cov = (coverage && typeof coverage === 'object' ? coverage : {}) as Record<string, unknown>;
  const covered = typeof cov.covered === 'boolean' ? cov.covered : undefined;
  if (!Array.isArray(cov.channels) || covered === false) return covered;
  const notCoverage = new Set(
    (status?.feeds ?? [])
      .filter((f) => isExampleFeed(f) || f.enabled === false)
      .flatMap((f) => [f.feed_id, f.name ?? ''].map((x) => x.toLowerCase())),
  );
  const mine = (cov.channels as unknown[]).filter(
    (c): c is { channel: string; kind?: unknown; receiver_state?: unknown } =>
      Boolean(c) &&
      typeof c === 'object' &&
      typeof (c as { channel?: unknown }).channel === 'string' &&
      ((c as { kind?: unknown }).kind === 'eot') === (kind === 'eot') &&
      !notCoverage.has((c as { channel: string }).channel.toLowerCase()),
  );
  if (!mine.length) return false;
  if (mine.every((c) => RECEIVER_STATES.has(c.receiver_state as ReceiverState)))
    return mine.some((c) => c.receiver_state !== 'not_installed');
  return covered;
}

/** The lines Pulse's channels of a kind hear, for "no receiver here; Pulse covers X". */
function coveredLines(feeds: FeedInfo[]): string[] {
  const covered = new Map<string, string>();
  for (const f of feeds)
    for (const l of f.coverage?.lines ?? []) {
      const label = `${l.railroad ? `${l.railroad} ` : ''}${displayLineName(l.name)}`;
      covered.set(label.toLowerCase(), label);
    }
  return [...covered.values()].slice(0, 10);
}

function judge(kind: CoverageKind, status: FeedsStatus | undefined, opts: AssessOptions): Verdict {
  const usable = status && reportsCoverage(status) ? status : undefined;
  const all = usable ? feedsOfKind(usable, kind) : [];
  let feeds = all;
  const tracks = opts.tracks ?? [];
  const channels = new Set((opts.pulseChannels ?? []).map((c) => c.toLowerCase()));
  const listed = (f: FeedInfo) =>
    channels.has((f.name ?? '').toLowerCase()) || channels.has(f.feed_id.toLowerCase());
  const summary = usable?.coverage_summary?.[kind];
  let elsewhere: FeedRef[] = [];

  if (kind === 'eot' && opts.pulseChannels !== undefined) {
    // EOT packets carry no position: only a receiver Pulse lists for this point can tie them to it.
    const near = all.filter(listed);
    if (usable ? !near.length : !channels.size) {
      const ignored = opts.messages > 0 ? { ignored_messages: opts.messages } : {};
      const nr = (reason: NoReceiverReason, fs: FeedInfo[]): Verdict => ({
        kind,
        state: 'no_receiver',
        reason,
        ...ignored,
        feeds: fs.map(ref),
      });
      if (usable && !all.length)
        return summary === 'no_receiver'
          ? nr('never_reported', [])
          : summary === 'listening' || summary === 'receiver_offline'
            ? nr('not_near', [])
            : nr('not_configured', []);
      if (usable && all.every((f) => f.receiver?.state === 'not_installed'))
        return nr('never_reported', all);
      return nr('not_near', all);
    }
    feeds = near;
    elsewhere = all.filter((f) => !listed(f) && f.receiver?.state !== 'not_installed').map(ref);
  }

  // Rail voice on a Pulse that sent rail/activity's channel list: it searched only those.
  const searchedOnly = kind === 'rail_radio' && opts.pulseChannels !== undefined;
  if (kind === 'rail_radio' && usable) {
    // Rail voice is judged per line: the line identified at the point, or the channels Pulse's
    // own lookup named for it. With neither, no receiver can be tied to this point. When Pulse
    // sent its list, a feed matched to the line by name only was not searched for this point,
    // so it can't make it quiet (or offline): only the voice channels Pulse listed count.
    const onLine = (f: FeedInfo) =>
      (f.coverage?.lines ?? []).some((l) => tracks.some((t) => trackMatchesLine(t, l)));
    feeds = all.filter((f) => listed(f) || (!searchedOnly && onLine(f)));
    if (!tracks.length && !channels.size && opts.messages === 0) {
      if (!all.length && summary === 'no_receiver')
        return { kind, state: 'no_receiver', reason: 'never_reported', feeds: [] };
      if (!all.length && summary !== 'listening' && summary !== 'receiver_offline')
        return { kind, state: 'no_receiver', reason: 'not_configured', feeds: [] };
      return {
        kind,
        state: 'no_receiver',
        reason: 'no_line',
        covered_lines: coveredLines(all),
        feeds: [],
      };
    }
    const unsearched = searchedOnly && !feeds.length ? all.filter(onLine) : [];
    if (unsearched.length && opts.messages === 0)
      return { kind, state: 'no_receiver', reason: 'not_searched', feeds: unsearched.map(ref) };
  }

  if (opts.messages > 0)
    return {
      kind,
      state: 'activity',
      messages: opts.messages,
      feeds: feeds.filter((f) => f.receiver?.state !== 'not_installed').map(ref),
      ...(elsewhere.length ? { elsewhere } : {}),
    };
  if (!status) return { kind, state: 'unknown', reason: 'status_unavailable' };
  if (!usable) return { kind, state: 'unknown', reason: 'pulse_too_old' };

  if (!all.length) {
    // Nothing we can see of this kind; Pulse's own summary decides (it may classify feeds we can't).
    // Not for rail voice with Pulse's list: no channel it searched is a receiver we can see.
    if (summary === 'listening')
      return searchedOnly
        ? { kind, state: 'no_receiver', reason: 'not_searched', feeds: [] }
        : { kind, state: 'quiet', window_min: opts.window_min, feeds: [] };
    if (summary === 'receiver_offline') return { kind, state: 'offline', feeds: [] };
    if (summary === 'no_receiver')
      return { kind, state: 'no_receiver', reason: 'never_reported', feeds: [] };
    return { kind, state: 'no_receiver', reason: 'not_configured', feeds: [] };
  }
  if (!feeds.length)
    return {
      kind,
      state: 'no_receiver',
      reason: 'not_this_line',
      covered_lines: coveredLines(all),
      feeds: [],
    };
  const online = feeds.filter((f) => f.receiver?.state === 'online');
  if (online.length)
    return { kind, state: 'quiet', window_min: opts.window_min, feeds: online.map(ref) };
  const offline = feeds.filter((f) => f.receiver?.state === 'offline');
  if (offline.length) {
    const since = offline
      .map((f) => f.receiver?.last_seen_at)
      .filter((s): s is string => Boolean(s))
      .sort()
      .pop();
    return { kind, state: 'offline', ...(since ? { since } : {}), feeds: offline.map(ref) };
  }
  if (feeds.every((f) => f.receiver?.state === 'not_installed'))
    return { kind, state: 'no_receiver', reason: 'never_reported', feeds: feeds.map(ref) };
  return { kind, state: 'unknown', reason: 'pulse_too_old' };
}

const NOUN: Record<
  CoverageKind,
  { what: string; msgs: string; rx: string; prep: string; scope: string }
> = {
  rail_radio: {
    what: 'rail radio',
    msgs: 'rail messages',
    rx: 'rail radio receiver',
    prep: 'on',
    scope: 'line',
  },
  eot: {
    what: 'EOT/HOT telemetry',
    msgs: 'EOT/HOT packets',
    rx: 'EOT/HOT receiver',
    prep: 'near',
    scope: 'line',
  },
  public_safety: {
    what: 'scanner radio',
    msgs: 'scanner incidents',
    rx: 'scanner (police/fire/EMS) receiver',
    prep: 'in',
    scope: 'area',
  },
};

const names = (feeds: FeedRef[]) =>
  feeds
    .slice(0, 3)
    .map((f) => f.name)
    .join(', ') + (feeds.length > 3 ? ` and ${feeds.length - 3} more` : '');

/** EOT packets carry no position: without a receiver location they can't be placed. */
const unlocated = (v: { kind: CoverageKind; feeds: FeedRef[] }) =>
  v.kind === 'eot' && v.feeds.length > 0 && !v.feeds.some((f) => f.located)
    ? " The EOT/HOT receiver's location is not set in Pulse, so these packets can't be tied to this place."
    : '';

/**
 * One sentence stating which situation applies: activity found, listening and quiet, receiver
 * offline since T, no receiver (none set up / never reported / none for this line / no line
 * identified / none near this point / not covered per Pulse's point lookup / not searched by
 * Pulse for this point), or Pulse can't say. `place` is a noun phrase: "this line (FRA: X Sub;
 * NARN: Y Sub)", "this area".
 */
export function verdictSentence(v: Verdict, now: number, place = 'this point'): string {
  const n = NOUN[v.kind];
  const at = `${n.prep} ${place}`;
  switch (v.state) {
    case 'activity': {
      const other = v.elsewhere?.length
        ? ` Pulse doesn't say which receiver heard each packet, so some may come from ${names(v.elsewhere)}, which ${v.elsewhere.length === 1 ? "doesn't" : "don't"} cover ${place}.`
        : '';
      return `Activity found: ${v.messages} ${v.messages === 1 ? n.msgs.replace(/s$/, '') : n.msgs} ${at}${v.feeds.length ? ` (${names(v.feeds)})` : ''}.${unlocated(v)}${other}`;
    }
    case 'quiet': {
      const who = v.feeds.length
        ? `${n.rx} online (${names(v.feeds)})`
        : `Pulse reports a ${n.rx} listening`;
      const extra =
        v.kind === 'public_safety' ? areaNote(v.feeds) : v.kind === 'eot' ? unlocated(v) : '';
      return `Listening and quiet: ${who} and 0 ${n.msgs} ${at} in the last ${v.window_min} min, so it really is quiet.${extra}`;
    }
    case 'offline': {
      const since = v.since
        ? ` since ${v.since} (${humanAge(Math.max(0, Math.round((now - Date.parse(v.since)) / 1000)))} ago)`
        : '';
      return `${cap(n.rx)} offline${since}${v.feeds.length ? ` (${names(v.feeds)})` : ''}: 0 ${n.msgs} means no data, not a quiet ${n.scope}.`;
    }
    case 'no_receiver':
      return noReceiverSentence(v, place);
    case 'unknown':
      return v.reason === 'pulse_too_old'
        ? `Pulse is too old to report its receivers, so 0 ${n.msgs} ${at} can't be told apart from no receiver.`
        : `Pulse's feed status was unavailable, so 0 ${n.msgs} ${at} can't be told apart from no receiver.`;
  }
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The "no receiver" sentence: which reason, what Pulse does cover, packets not counted. */
function noReceiverSentence(v: Extract<Verdict, { state: 'no_receiver' }>, place: string): string {
  const n = NOUN[v.kind];
  const at = `${n.prep} ${place}`;
  const one = v.ignored_messages === 1;
  const ignored = v.ignored_messages
    ? ` The ${v.ignored_messages} ${one ? n.msgs.replace(/s$/, '') : n.msgs} Pulse returned ${one ? 'is' : 'are'} not counted: no receiver that covers ${place} heard ${one ? 'it' : 'them'}.`
    : '';
  const tail = `${ignored} 0 ${n.msgs} means no coverage, not a quiet ${n.scope}.`;
  const lines = v.covered_lines?.length
    ? v.covered_lines.join(', ')
    : 'other lines (none says which lines it hears)';
  switch (v.reason) {
    case 'not_configured':
      return `No ${n.rx} installed: Pulse has no ${n.what} channel set up (example placeholders don't count).${tail}`;
    case 'never_reported':
      return `No ${n.rx} installed: ${v.feeds.length ? `${names(v.feeds)} is configured but` : 'a channel is configured but'} no receiver has ever reported.${tail}`;
    case 'no_line':
      return `No ${n.rx} for ${place}: no rail line identified here (no named track near this point in the rail datasets) and Pulse lists no ${n.what} channel for this point. Pulse's ${n.what} channels cover ${lines}.${tail}`;
    case 'not_near': {
      const rx = v.feeds
        .slice(0, 3)
        .map((f) => `${f.name}${f.area ? `, covering ${f.area}` : ''}`)
        .join('; ');
      const who = v.feeds.length
        ? `Pulse's ${n.rx}${v.feeds.length === 1 ? '' : 's'} (${rx}${v.feeds.length > 3 ? ` and ${v.feeds.length - 3} more` : ''}) ${v.feeds.length === 1 ? 'is' : 'are'} not listed for this point, so ${v.feeds.length === 1 ? 'it is' : 'they are'} too far away to hear trains here.`
        : `Pulse lists no ${n.rx} within range of this point.`;
      return `No ${n.rx} ${at}: ${who}${tail}`;
    }
    case 'not_searched': {
      const one = v.feeds.length === 1;
      const why = v.feeds.length
        ? `Pulse's own lookup for this point did not list ${names(v.feeds)} among its rail voice channels, so ${one ? 'it was' : 'they were'} not searched here (${one ? 'it matches' : 'they match'} this line by name only)`
        : `Pulse's own lookup for this point lists no rail voice channel that its feed status reports as a receiver, so none was searched here`;
      return `No ${n.rx} confirmed ${at}: ${why}.${tail}`;
    }
    case 'pulse_not_covered':
      return `No ${n.rx} confirmed ${at}: Pulse's own lookup for this point says no receiver for the channels that cover it has reported (covered: false)${v.feeds.length ? `, though its feed status lists ${names(v.feeds)} online` : ''}.${tail}`;
    case 'not_this_line':
      return `No ${n.rx} for ${place}: Pulse's ${n.what} channels cover ${lines}.${tail}`;
  }
}

function areaNote(feeds: FeedRef[]): string {
  const areas = [...new Set(feeds.map((f) => f.area).filter((a): a is string => Boolean(a)))];
  return areas.length
    ? ` Pulse's scanner channels cover ${areas.slice(0, 5).join(', ')}; whether this point is inside that area isn't known.`
    : '';
}

/** "this line (NARN: X Sub; FRA: Y Sub)" from the tracks at a point (every name, once). */
export function lineLabel(tracks: TrackNames[]): string {
  const text = formatLineNames(tracks.flatMap((t) => t.names));
  return text ? `this line (${text})` : 'this line';
}
