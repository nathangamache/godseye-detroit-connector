/**
 * Coverage honesty: "no messages" only means "quiet" when a receiver is actually listening.
 *
 * Pulse's GET /v1/feeds/status (docs/pulse-api-contract.md) reports, per feed, a `receiver`
 * (not_installed | offline | online) and a `coverage` block (area, rail lines with aliases,
 * radius), plus a top-level `coverage_summary`. This module turns that, and the number of
 * messages a query found, into one verdict per kind of source:
 *
 *   activity found · listening and quiet · receiver offline since T ·
 *   no receiver (none configured / never reported / none for this line) · can't say (old Pulse)
 *
 * Example/placeholder feeds (ids starting "example_" or flagged example: true) never count.
 * Rail lines are matched on every name the datasets give a track and every alias Pulse lists,
 * normalised (src/rail/names.ts), never on one string.
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

export type Verdict =
  | { kind: CoverageKind; state: 'activity'; messages: number; feeds: FeedRef[] }
  | { kind: CoverageKind; state: 'quiet'; window_min: number; feeds: FeedRef[] }
  | { kind: CoverageKind; state: 'offline'; since?: string; feeds: FeedRef[] }
  | {
      kind: CoverageKind;
      state: 'no_receiver';
      reason: 'not_configured' | 'never_reported' | 'not_this_line';
      covered_lines?: string[];
      feeds: FeedRef[];
    }
  | { kind: CoverageKind; state: 'unknown'; reason: 'pulse_too_old' | 'status_unavailable' };

export interface AssessOptions {
  /** Messages this query found for the kind (transcripts + detector readouts, packets, incidents). */
  messages: number;
  window_min: number;
  /** Rail radio only: the tracks at the point, with every name (src/rail/index.ts tracksNear). */
  tracks?: TrackNames[];
  /** Rail radio only: channel names Pulse's own rail/activity lookup said cover the point. */
  pulseChannels?: string[];
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
  const usable = status && reportsCoverage(status) ? status : undefined;
  let feeds = usable ? feedsOfKind(usable, kind) : [];
  const tracks = opts.tracks ?? [];
  const channels = new Set((opts.pulseChannels ?? []).map((c) => c.toLowerCase()));
  // Rail radio is judged per line when we know the line (or Pulse named its channels for the
  // point); otherwise per kind.
  if (kind === 'rail_radio' && usable && (tracks.length || channels.size)) {
    feeds = feeds.filter(
      (f) =>
        (f.coverage?.lines ?? []).some((l) => tracks.some((t) => trackMatchesLine(t, l))) ||
        channels.has((f.name ?? '').toLowerCase()) ||
        channels.has(f.feed_id.toLowerCase()),
    );
  }
  if (opts.messages > 0)
    return {
      kind,
      state: 'activity',
      messages: opts.messages,
      feeds: feeds.filter((f) => f.receiver?.state !== 'not_installed').map(ref),
    };
  if (!status) return { kind, state: 'unknown', reason: 'status_unavailable' };
  if (!usable) return { kind, state: 'unknown', reason: 'pulse_too_old' };

  const all = feedsOfKind(usable, kind);
  const summary = usable.coverage_summary?.[kind];
  if (!all.length) {
    // Nothing we can see of this kind; Pulse's own summary decides (it may classify feeds we can't).
    if (summary === 'listening')
      return { kind, state: 'quiet', window_min: opts.window_min, feeds: [] };
    if (summary === 'receiver_offline') return { kind, state: 'offline', feeds: [] };
    if (summary === 'no_receiver')
      return { kind, state: 'no_receiver', reason: 'never_reported', feeds: [] };
    return { kind, state: 'no_receiver', reason: 'not_configured', feeds: [] };
  }
  if (!feeds.length) {
    const covered = new Map<string, string>();
    for (const f of all)
      for (const l of f.coverage?.lines ?? []) {
        const label = `${l.railroad ? `${l.railroad} ` : ''}${displayLineName(l.name)}`;
        covered.set(label.toLowerCase(), label);
      }
    return {
      kind,
      state: 'no_receiver',
      reason: 'not_this_line',
      covered_lines: [...covered.values()].slice(0, 10),
      feeds: [],
    };
  }
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
 * offline since T, no receiver (none set up / never reported / none for this line), or Pulse
 * can't say. `place` is a noun phrase: "this line (FRA: X Sub; NARN: Y Sub)", "this area".
 */
export function verdictSentence(v: Verdict, now: number, place = 'this point'): string {
  const n = NOUN[v.kind];
  const at = `${n.prep} ${place}`;
  switch (v.state) {
    case 'activity':
      return `Activity found: ${v.messages} ${v.messages === 1 ? n.msgs.replace(/s$/, '') : n.msgs} ${at}${v.feeds.length ? ` (${names(v.feeds)})` : ''}.${unlocated(v)}`;
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
    case 'no_receiver': {
      const tail = `0 ${n.msgs} means no coverage, not a quiet ${n.scope}.`;
      if (v.reason === 'not_configured')
        return `No ${n.rx} installed: Pulse has no ${n.what} channel set up (example placeholders don't count). ${tail}`;
      if (v.reason === 'never_reported')
        return `No ${n.rx} installed: ${v.feeds.length ? `${names(v.feeds)} is configured but` : 'a channel is configured but'} no receiver has ever reported. ${tail}`;
      return `No ${n.rx} for ${place}: Pulse's ${n.what} channels cover ${v.covered_lines?.length ? v.covered_lines.join(', ') : 'other lines (none says which lines it hears)'}. ${tail}`;
    }
    case 'unknown':
      return v.reason === 'pulse_too_old'
        ? `Pulse is too old to report its receivers, so 0 ${n.msgs} ${at} can't be told apart from no receiver.`
        : `Pulse's feed status was unavailable, so 0 ${n.msgs} ${at} can't be told apart from no receiver.`;
  }
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

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
