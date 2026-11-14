/**
 * Coverage honesty: "no messages" is "quiet" only when Pulse proves it.
 *
 * Rail voice and EOT/HOT: Pulse's GET /v1/rail/activity sends, from contract v1.2, `verdicts`
 * per kind (docs/pulse-api-contract.md): activity | quiet | not_covered | unknown, with reasons,
 * counts, the window and the channels that cover the point. Pulse says quiet only with proof for
 * the whole window (every covering channel's receiver listening on its configured frequency, the
 * ingest stage beating, nothing heard and nothing unattributed). The gateway relays that
 * (checkVerdict, railVerdictSentence) and may only downgrade quiet to unknown when its own checks
 * disagree: Pulse's answer contradicts itself, feeds/status shows a covering receiver down, or
 * the covering channels hear lines none of which is the track at the point. It never upgrades.
 *
 * Without verdicts (a Pulse older than v1.2, and scanner incidents, which have none) the gateway
 * judges from feeds/status and rail/activity's channel list (assess, verdictSentence) but never
 * says quiet: a receiver online now proves nothing about the whole window. Nor does it call
 * EOT/HOT packets activity at the point: such a Pulse lists an EOT/HOT receiver by a fixed
 * 25 km, whatever its own range, and packets carry no position. The verdicts there:
 *
 *   activity found (not EOT/HOT) · EOT/HOT packets heard but not placed at the point ·
 *   receiver online now, quiet not confirmed · receiver offline since T ·
 *   no receiver (none configured / never reported / none for this line / no line identified /
 *   none near this point / Pulse's point lookup says not covered / not searched by Pulse for
 *   this point) · can't say (old Pulse)
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
  radius_km?: number;
  /** v1.2 verdicts: since when Pulse has been listening to this channel without a break. */
  listening_since?: string;
}

function ref(f: FeedInfo): FeedRef {
  const r: FeedRef = { feed_id: f.feed_id, name: f.name ?? f.feed_id };
  if (f.receiver) r.receiver = f.receiver.state;
  if (f.receiver?.last_seen_at) r.last_seen_at = f.receiver.last_seen_at;
  const area = f.coverage?.area ?? f.county;
  if (area) r.area = area;
  r.located = Boolean(f.coverage?.area || f.coverage?.radius_km);
  if (f.coverage?.radius_km !== undefined) r.radius_km = f.coverage.radius_km;
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

// ── Pulse's own verdicts (contract v1.2, rail/activity `verdicts`) ─────────────────────────

export type RailKind = 'rail_radio' | 'eot';
export type PulseState = 'activity' | 'quiet' | 'not_covered' | 'unknown';
const PULSE_STATES = new Set<PulseState>(['activity', 'quiet', 'not_covered', 'unknown']);
const COUNT_KEYS = [
  'transcripts',
  'detector_readouts',
  'recordings_without_text',
  'eot_packets',
] as const;
export type VerdictCounts = Record<(typeof COUNT_KEYS)[number], number>;

export interface PulseVerdictChannel {
  feed_id: string;
  receiver_state?: ReceiverState;
  listening_since?: string;
  covers_point: boolean;
}

/** One kind's verdict as Pulse sent it: known fields only, bounded. */
export interface PulseVerdict {
  state: PulseState;
  reasons: string[];
  window_start?: string;
  window_end?: string;
  listening_since?: string;
  /** Absent when Pulse sent no complete counts block. */
  counts?: VerdictCounts;
  channels: PulseVerdictChannel[];
}

/** Pulse's `verdicts`, keyed by the gateway's kinds (Pulse's `rail_voice` is `rail_radio`). */
export interface PulseVerdicts {
  rail_radio?: PulseVerdict;
  eot?: PulseVerdict;
}

const MAX_REASONS = 20;
const MAX_VERDICT_CHANNELS = 200;

function parseVerdict(raw: unknown): PulseVerdict | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const v = raw as Record<string, unknown>;
  if (!PULSE_STATES.has(v.state as PulseState)) return undefined;
  const out: PulseVerdict = {
    state: v.state as PulseState,
    reasons: (Array.isArray(v.reasons) ? v.reasons.slice(0, MAX_REASONS) : [])
      .map((r) => str(r, 400))
      .filter((r): r is string => Boolean(r)),
    channels: [],
  };
  for (const k of ['window_start', 'window_end', 'listening_since'] as const) {
    const t = iso(v[k]);
    if (t) out[k] = t;
  }
  const c = v.counts as Record<string, unknown> | undefined;
  if (c && typeof c === 'object') {
    const n = COUNT_KEYS.map((k) => num(c[k]));
    if (n.every((x) => x !== undefined && x >= 0))
      out.counts = Object.fromEntries(
        COUNT_KEYS.map((k, i) => [k, Math.round(n[i] ?? 0)]),
      ) as VerdictCounts;
  }
  const chans = Array.isArray(v.channels) ? v.channels.slice(0, MAX_VERDICT_CHANNELS) : [];
  for (const raw of chans) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const feed_id = str(r.feed_id, 80);
    if (!feed_id) continue;
    const ch: PulseVerdictChannel = { feed_id, covers_point: r.covers_point === true };
    if (RECEIVER_STATES.has(r.receiver_state as ReceiverState))
      ch.receiver_state = r.receiver_state as ReceiverState;
    const since = iso(r.listening_since);
    if (since) ch.listening_since = since;
    out.channels.push(ch);
  }
  return out;
}

/** rail/activity's `verdicts` (v1.2), or undefined for a Pulse that sends none. */
export function parseVerdicts(body: unknown): PulseVerdicts | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const b = body as Record<string, unknown>;
  const out: PulseVerdicts = {};
  const voice = parseVerdict(b.rail_voice);
  if (voice) out.rail_radio = voice;
  const eot = parseVerdict(b.eot);
  if (eot) out.eot = eot;
  return out;
}

export interface VerdictCheckOptions {
  /** feeds/status, when it answered: names, receiver states and lines of the covering channels. */
  status?: FeedsStatus;
  /** Rail voice: the tracks at the point (src/rail/index.ts tracksNear, plus a caller hint). */
  tracks?: TrackNames[];
  /** The window asked for, in minutes. */
  window_min: number;
  /**
   * Messages of this kind listed elsewhere in the same answer (transcripts, detector_readouts
   * and coverage.recordings_without_text for voice; eot_hot for EOT), to check a quiet against.
   */
  listed: number;
}

/** rail_activity_near's verdict for one kind on a Pulse that sends verdicts. */
export interface RailVerdict {
  kind: RailKind;
  basis: 'pulse_verdict';
  /** The state reported: Pulse's, or unknown when the gateway's checks disagree with its quiet. */
  state: PulseState;
  /** Pulse's own state; absent when it sent no usable verdict for this kind. */
  pulse_state?: PulseState;
  /** Pulse's reasons, verbatim. */
  reasons: string[];
  /** Why the gateway did not relay Pulse's quiet, or why there is no verdict. */
  gateway_reasons?: string[];
  counts?: VerdictCounts;
  window_start?: string;
  window_end?: string;
  listening_since?: string;
  /** The channels Pulse says cover the point. */
  feeds: FeedRef[];
  /** Rail voice: the lines those channels hear, when none of them is the track at the point. */
  other_lines?: string[];
}

const NO_VERDICT: Record<RailKind, string> = {
  rail_radio: 'rail voice',
  eot: 'EOT/HOT',
};

/**
 * Pulse's verdict for one kind, with the gateway's checks: a quiet becomes unknown (never the
 * reverse, and nothing becomes activity) when Pulse's own answer or the gateway's view disagrees.
 */
export function checkVerdict(
  kind: RailKind,
  v: PulseVerdict | undefined,
  opts: VerdictCheckOptions,
): RailVerdict {
  if (!v)
    return {
      kind,
      basis: 'pulse_verdict',
      state: 'unknown',
      reasons: [],
      gateway_reasons: [`Pulse sent no usable verdict for ${NO_VERDICT[kind]}`],
      feeds: [],
    };
  const byId = new Map((opts.status?.feeds ?? []).map((f) => [f.feed_id.toLowerCase(), f]));
  const covering = v.channels.filter((c) => c.covers_point);
  const feeds = covering.map((c) => {
    const f = byId.get(c.feed_id.toLowerCase());
    const r: FeedRef = f ? ref(f) : { feed_id: c.feed_id, name: c.feed_id };
    if (c.receiver_state) r.receiver = c.receiver_state;
    if (c.listening_since) r.listening_since = c.listening_since;
    return r;
  });
  const out: RailVerdict = {
    kind,
    basis: 'pulse_verdict',
    state: v.state,
    pulse_state: v.state,
    reasons: v.reasons,
    feeds,
  };
  if (v.counts) out.counts = v.counts;
  if (v.window_start) out.window_start = v.window_start;
  if (v.window_end) out.window_end = v.window_end;
  if (v.listening_since) out.listening_since = v.listening_since;
  if (kind === 'rail_radio') {
    const other = otherLines(
      covering.map((c) => byId.get(c.feed_id.toLowerCase())),
      opts.tracks ?? [],
    );
    if (other) out.other_lines = other;
  }
  if (v.state === 'quiet') {
    const why = disagreements(kind, v, out, byId, opts);
    if (why.length) {
      out.state = 'unknown';
      out.gateway_reasons = why;
    }
  }
  return out;
}

/**
 * The lines the covering channels hear, when the gateway identified a track at the point and
 * every covering channel names its lines in feeds/status, but none is that track. A channel
 * placed by area alone (no lines) may hear any track there, so it leaves this undecided.
 */
function otherLines(
  covering: Array<FeedInfo | undefined>,
  tracks: TrackNames[],
): string[] | undefined {
  if (!tracks.length || !covering.length) return undefined;
  const known = covering.filter((f): f is FeedInfo => Boolean(f?.coverage?.lines?.length));
  if (known.length < covering.length) return undefined;
  const onTrack = known.some((f) =>
    (f.coverage?.lines ?? []).some((l) => tracks.some((t) => trackMatchesLine(t, l))),
  );
  return onTrack ? undefined : coveredLines(known);
}

/** Why a quiet from Pulse can't be relayed: its own answer or the gateway's view disagrees. */
function disagreements(
  kind: RailKind,
  v: PulseVerdict,
  out: RailVerdict,
  byId: Map<string, FeedInfo>,
  opts: VerdictCheckOptions,
): string[] {
  const why: string[] = [];
  if (!v.counts) why.push("Pulse's verdict has no complete counts");
  else {
    const heard = COUNT_KEYS.reduce((s, k) => s + (v.counts?.[k] ?? 0), 0);
    if (heard)
      why.push(`Pulse's counts show ${heard} message(s) on the channels that cover this point`);
  }
  if (opts.listed > 0)
    why.push(
      `Pulse's answer also lists ${opts.listed} ${kind === 'eot' ? 'EOT/HOT packet(s)' : 'transcript(s), detector readout(s) or recording(s) without text'} for this point`,
    );
  const covering = v.channels.filter((c) => c.covers_point);
  if (!covering.length) why.push('Pulse lists no channel that covers this point');
  const start = Date.parse(v.window_start ?? '');
  const end = Date.parse(v.window_end ?? '');
  if (!(end - start >= opts.window_min * 60_000 - WINDOW_TRAIL_MS))
    why.push(
      v.window_start && v.window_end
        ? `Pulse's window (${shortIso(v.window_start)} to ${shortIso(v.window_end)}) is shorter than the ${opts.window_min} min asked by more than ${WINDOW_TRAIL_MS / 60_000} min`
        : "Pulse's verdict gives no window",
    );
  // Listening since before the window start, for Pulse as a whole and for every covering
  // channel (without a valid window that can't be shown, and is reported above).
  if (Number.isFinite(start)) {
    const proven = (t?: string) => t !== undefined && Date.parse(t) <= start;
    if (!proven(v.listening_since))
      why.push(
        v.listening_since
          ? `Pulse has been listening only since ${shortIso(v.listening_since)}, after the window start`
          : "Pulse's verdict gives no time it has been listening since",
      );
    const unproven = covering.filter(
      (c) => c.receiver_state !== 'online' || !proven(c.listening_since),
    );
    if (unproven.length)
      why.push(
        `Pulse's channel list does not show ${idList(unproven.map((c) => c.feed_id))} online and listening since before the window start`,
      );
  }
  // The gateway's own view: feeds/status, read a few seconds apart.
  if (opts.status && reportsCoverage(opts.status)) {
    const down: string[] = [];
    for (const c of covering) {
      const f = byId.get(c.feed_id.toLowerCase());
      if (!f) continue;
      if (isExampleFeed(f)) down.push(`${f.name ?? f.feed_id} is an example placeholder`);
      else if (f.enabled === false) down.push(`${f.name ?? f.feed_id} is disabled`);
      else if (f.receiver && f.receiver.state !== 'online')
        down.push(`${f.name ?? f.feed_id}'s receiver is ${f.receiver.state.replace('_', ' ')}`);
    }
    if (down.length) why.push(`Pulse's feed status says ${down.slice(0, 5).join('; ')}`);
  }
  if (out.other_lines)
    why.push(
      `the channels that cover this point hear ${out.other_lines.join(', ')}, and none of those is the track identified here`,
    );
  return why;
}

/**
 * How far short of the minutes asked Pulse's window may end. Pulse ends a quiet window where
 * its proof ends, at the ingest stage's newest beat and the covering receivers' newest
 * heartbeats, not at its answer: normally under 20 s before it for rail voice, up to about a
 * minute for EOT/HOT (traintap beats once a minute) and at most a receiver's max gap (105 s).
 */
const WINDOW_TRAIL_MS = 120_000;

const shortIso = (t: string) => t.replace(/\.\d+Z$/, 'Z');
const idList = (ids: string[]) =>
  ids.slice(0, 5).join(', ') + (ids.length > 5 ? ` and ${ids.length - 5} more` : '');

/** Up to four reasons as one clause, each trimmed; the rest are in coverage_check. */
function reasonText(reasons: string[]): string {
  const shown = reasons
    .slice(0, 4)
    .map((r) => r.replace(/[.\s]+$/, ''))
    .map((r) => (r.length > 220 ? `${r.slice(0, 219)}…` : r));
  const more = reasons.length - shown.length;
  return shown.join('; ') + (more > 0 ? `; and ${more} more (see coverage_check)` : '');
}

/**
 * One sentence for a v1.2 verdict, in plain words: Pulse's state and reasons verbatim, or why the
 * gateway did not relay a quiet. `place` is a noun phrase: "this line (FRA: X Sub)", "this point".
 */
export function railVerdictSentence(v: RailVerdict, place = 'this point'): string {
  const n = NOUN[v.kind];
  const at = `${n.prep} ${place}`;
  const why = reasonText(v.reasons);
  const chans = v.feeds.length ? ` (${names(v.feeds)})` : '';
  const nothing = (what: string) => `Hearing nothing here means ${what}, not a quiet ${n.scope}.`;
  switch (v.state) {
    case 'activity': {
      const other = v.other_lines?.length
        ? ` Those channels hear ${v.other_lines.join(', ')}, and none of those is the track identified here.`
        : '';
      return `Activity found ${at}, per Pulse's verdict: ${why || 'Pulse heard traffic on the channels that cover this point'}${chans}.${other}`;
    }
    case 'quiet': {
      const win =
        v.window_start && v.window_end
          ? ` for ${shortIso(v.window_start)} to ${shortIso(v.window_end)}`
          : '';
      const since = v.listening_since ? `; listening since ${shortIso(v.listening_since)}` : '';
      return `Listening and quiet ${at}, per Pulse's verdict${win}: ${why || 'nothing was heard on the channels that cover this point'}${since}${chans}. So it really is quiet.`;
    }
    case 'not_covered':
      return `No coverage ${at}, per Pulse's verdict: ${why || `no ${n.what} channel covers this point`}. ${nothing('no coverage')}`;
    case 'unknown': {
      const gw = reasonText(v.gateway_reasons ?? []);
      if (v.pulse_state === 'quiet')
        return `Can't confirm quiet ${at}: Pulse's verdict was quiet, but the gateway's own check disagrees: ${gw}. ${nothing('no proof')}`;
      if (!v.pulse_state) return `Can't confirm quiet ${at}: ${gw}. ${nothing('no proof')}`;
      return `Can't confirm quiet ${at}, per Pulse's verdict: ${why || 'Pulse gave no reason'}. ${nothing('no proof')}`;
    }
  }
}

// ── Without verdicts: older Pulse (rail) and scanner incidents. Never "quiet". ─────────────

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
  | { kind: CoverageKind; state: 'activity'; messages: number; feeds: FeedRef[] }
  /**
   * EOT/HOT packets returned, but nothing places them at the point: this Pulse lists an EOT/HOT
   * receiver for any point within a fixed 25 km of it (anywhere when its location isn't set),
   * whatever its own range, and packets carry no position. Never activity there. `feeds`: the
   * receivers that may have heard them.
   */
  | {
      kind: CoverageKind;
      state: 'unplaced';
      messages: number;
      window_min: number;
      feeds: FeedRef[];
    }
  /**
   * A receiver is online now and nothing was heard, but nothing proves it (and the ingest stage)
   * listened for the whole window: no proof, never "quiet".
   */
  | { kind: CoverageKind; state: 'unconfirmed'; window_min: number; feeds: FeedRef[] }
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
  /**
   * Messages this query found for the kind: transcripts, detector readouts and recordings
   * without text; packets; incidents.
   */
  messages: number;
  window_min: number;
  /** Rail radio only: the tracks at the point, with every name (src/rail/index.ts tracksNear). */
  tracks?: TrackNames[];
  /**
   * Channel names (labels or feed ids) of this kind that Pulse's own rail/activity lookup listed
   * for the point: road/dispatcher/detector channels for rail radio, "eot" channels for EOT/HOT.
   * `[]` means Pulse listed none for this point; undefined means the list isn't known (an older
   * Pulse). For rail radio, a list means only the feeds in it were searched, so only they can
   * be online or offline for the point; without one, a feed whose coverage line is the track at
   * the point counts.
   */
  pulseChannels?: string[];
  /**
   * rail/activity's coverage.covered for the point, for this kind (pulseCoveredFor): v1.1, a
   * listed receiver of this kind has reported.
   */
  pulseCovered?: boolean;
}

export function assess(
  kind: CoverageKind,
  status: FeedsStatus | undefined,
  opts: AssessOptions,
): Verdict {
  const v = judge(kind, status, opts);
  // Pulse's own lookup for this point (v1.1) says no receiver covering it has reported: whatever
  // feeds/status says (it may be a few seconds older), no receiver is confirmed there.
  if (v.state === 'unconfirmed' && opts.pulseCovered === false && status && reportsCoverage(status))
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

function judge(kind: CoverageKind, status: FeedsStatus | undefined, opts: AssessOptions): Verdict {
  const usable = status && reportsCoverage(status) ? status : undefined;
  const all = usable ? feedsOfKind(usable, kind) : [];
  let feeds = all;
  const tracks = opts.tracks ?? [];
  const channels = new Set((opts.pulseChannels ?? []).map((c) => c.toLowerCase()));
  const listed = (f: FeedInfo) =>
    channels.has((f.name ?? '').toLowerCase()) || channels.has(f.feed_id.toLowerCase());
  const summary = usable?.coverage_summary?.[kind];
  let elsewhere: FeedInfo[] = [];

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
    // Pulse doesn't say which receiver heard each packet: an unlisted one may have, too.
    elsewhere = all.filter((f) => !listed(f));
  }

  // Rail voice on a Pulse that sent rail/activity's channel list: it searched only those.
  const searchedOnly = kind === 'rail_radio' && opts.pulseChannels !== undefined;
  if (kind === 'rail_radio' && usable) {
    // Rail voice is judged per line: the line identified at the point, or the channels Pulse's
    // own lookup named for it. With neither, no receiver can be tied to this point. When Pulse
    // sent its list, a feed matched to the line by name only was not searched for this point,
    // so only the voice channels Pulse listed count.
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

  if (opts.messages > 0) {
    const heard = (fs: FeedInfo[]) =>
      fs.filter((f) => f.receiver?.state !== 'not_installed').map(ref);
    return kind === 'eot'
      ? {
          kind,
          state: 'unplaced',
          messages: opts.messages,
          window_min: opts.window_min,
          feeds: heard([...feeds, ...elsewhere]),
        }
      : { kind, state: 'activity', messages: opts.messages, feeds: heard(feeds) };
  }
  if (!status) return { kind, state: 'unknown', reason: 'status_unavailable' };
  if (!usable) return { kind, state: 'unknown', reason: 'pulse_too_old' };

  if (!all.length) {
    // Nothing we can see of this kind; Pulse's own summary decides (it may classify feeds we can't).
    // Not for rail voice with Pulse's list: no channel it searched is a receiver we can see.
    if (summary === 'listening')
      return searchedOnly
        ? { kind, state: 'no_receiver', reason: 'not_searched', feeds: [] }
        : { kind, state: 'unconfirmed', window_min: opts.window_min, feeds: [] };
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
    return { kind, state: 'unconfirmed', window_min: opts.window_min, feeds: online.map(ref) };
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

/**
 * A Pulse without verdicts lists an EOT/HOT receiver for any point within a fixed 25 km of it,
 * or for every point when its location isn't set, whatever range its own config gives it, and
 * the gateway can't see where the receiver is. EOT packets carry no position, so nothing ties
 * them, or the receiver's range, to the point.
 */
const EOT_LEGACY_KM = 25;
const LEGACY_EOT_RULE = `lists an EOT/HOT receiver for any point within ${EOT_LEGACY_KM} km of it, or for any point at all when its location isn't set, whatever the receiver's own range`;

/** What feeds/status says of the receivers' own range, when it rules the point out or can't. */
function ownRange(feeds: FeedRef[]): string {
  const short = feeds.find((f) => f.radius_km !== undefined && f.radius_km < EOT_LEGACY_KM);
  if (short) return `${short.name}'s own range is ${short.radius_km} km`;
  const unset = feeds.find((f) => !f.located);
  return unset ? `${unset.name}'s location is not set in Pulse` : '';
}

/**
 * One sentence stating which situation applies without Pulse's verdicts: activity found, EOT/HOT
 * packets heard but not placed at the point, a receiver online now but quiet not confirmed,
 * receiver offline since T, no receiver (none set up / never reported / none for this line / no
 * line identified / none near this point / not covered per Pulse's point lookup / not searched by
 * Pulse for this point), or Pulse can't say. Never "quiet", and never EOT/HOT activity at the
 * point. `place` is a noun phrase: "this line (FRA: X Sub; NARN: Y Sub)", "this area".
 */
export function verdictSentence(v: Verdict, now: number, place = 'this point'): string {
  const n = NOUN[v.kind];
  const at = `${n.prep} ${place}`;
  const msgs = (k: number) => `${k} ${k === 1 ? n.msgs.replace(/s$/, '') : n.msgs}`;
  switch (v.state) {
    case 'activity':
      return `Activity found: ${msgs(v.messages)} ${at}${v.feeds.length ? ` (${names(v.feeds)})` : ''}.`;
    case 'unplaced': {
      const who = v.feeds.length ? names(v.feeds) : `Pulse's ${n.rx}`;
      const own = ownRange(v.feeds);
      return `Heard but not placed at ${place}: ${msgs(v.messages)} from ${who} in the last ${v.window_min} min. This Pulse sends no verdicts (contract v1.2) and ${LEGACY_EOT_RULE}${own ? ` (${own})` : ''}, and ${n.msgs} carry no position, so ${place} may be outside the range of the receiver that heard them. They are not counted as activity at ${place}.`;
    }
    case 'unconfirmed': {
      const who = v.feeds.length
        ? `${n.rx} online now (${names(v.feeds)})`
        : `Pulse reports a ${n.rx} listening now`;
      const why =
        v.kind === 'public_safety'
          ? "Pulse doesn't prove its scanner receivers listened for the whole window"
          : 'this Pulse sends no verdicts (contract v1.2), so nothing shows the receiver and the ingest stage were up for the whole window';
      const own = v.kind === 'eot' ? ownRange(v.feeds) : '';
      const extra =
        v.kind === 'public_safety'
          ? areaNote(v.feeds)
          : own
            ? ` Nor does it show that this point is in the receiver's range: it ${LEGACY_EOT_RULE} (${own}).`
            : '';
      return `Can't confirm quiet: ${who} and 0 ${n.msgs} ${at} in the last ${v.window_min} min, but ${why}. 0 ${n.msgs} means no proof, not a quiet ${n.scope}.${extra}`;
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
