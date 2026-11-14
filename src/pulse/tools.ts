/** Pulse tools registered in the registry (source "pulse"). Output text from radio is untrusted. */
import type { RailIndex } from '../rail/index.js';
import { plainLineName, type TrackNames } from '../rail/names.js';
import { metaFor } from '../tools/tags.js';
import type { ToolDef, ToolOutput } from '../tools/types.js';
import { PulseClient, PulseHttpError, PulseUnavailableError } from './client.js';
import {
  assess,
  checkVerdict,
  feedKind,
  feedsOfKind,
  isExampleFeed,
  lineLabel,
  matchCoverageLine,
  parseFeedsStatus,
  parseVerdicts,
  pulseCoveredFor,
  railVerdictSentence,
  reportsCoverage,
  verdictSentence,
  type FeedsStatus,
  type PulseVerdicts,
} from './coverage.js';

const LATLON = {
  lat: { type: 'number', minimum: -90, maximum: 90 },
  lon: { type: 'number', minimum: -180, maximum: 180 },
};
const SINCE = (def: number, max: number) => ({
  type: 'integer',
  minimum: 1,
  maximum: max,
  description: `Look back this many minutes (default ${def})`,
});

type Json = Record<string, unknown>;

function errorOutput(err: unknown): ToolOutput {
  if (err instanceof PulseUnavailableError) {
    return {
      summary: `${err.message}. Detroit Pulse has not been started on this server yet, so there is no scanner or rail-radio data.`,
      isError: true,
      errorKind: 'unavailable',
    };
  }
  if (err instanceof PulseHttpError) {
    return {
      summary: err.message,
      isError: true,
      errorKind: err.status === 404 ? 'not_found' : 'upstream',
    };
  }
  throw err;
}

type FeedsResult = { ok: true; status: FeedsStatus } | { ok: false; err: unknown };

async function call(
  client: PulseClient,
  path: string,
  query: Json,
  signal: AbortSignal,
  summarize: (j: Json) => string,
): Promise<ToolOutput> {
  try {
    const j = await client.get<Json>(
      path,
      query as Record<string, string | number | boolean | undefined>,
      signal,
    );
    return {
      summary: summarize(j),
      data: j,
      observedAt: typeof j.generated_at === 'string' ? j.generated_at : undefined,
    };
  } catch (err) {
    return errorOutput(err);
  }
}

const count = (v: unknown) => (Array.isArray(v) ? v.length : 0);

/** What rail_activity_near says per kind, and what it adds to Pulse's data. */
interface Judged {
  summary: string;
  data: Json;
  check: Record<string, unknown>;
}

/**
 * rail/activity's coverage.recordings_without_text (Pulse 888cb0a and later): recordings on the
 * covering channels in the window with no text yet (queued or transcribing), whose
 * transcription failed, or with no speech. Traffic, never quiet. Undefined when not sent.
 */
function recordingsWithoutText(
  cov: Json,
): { total: number; pending: number; error: number; no_speech: number } | undefined {
  const r = cov.recordings_without_text;
  if (!r || typeof r !== 'object') return undefined;
  const n = (k: string) => {
    const v = (r as Json)[k];
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
  };
  const out = { pending: n('pending'), error: n('error'), no_speech: n('no_speech') };
  return { ...out, total: out.pending + out.error + out.no_speech };
}

const coverageOf = (j: Json): Json =>
  (j.coverage && typeof j.coverage === 'object' ? j.coverage : {}) as Json;

/** A sentence that calls channels quiet ("they were quiet", "that channel was quiet"). */
const QUIET_CLAIM = /\b(?:was|were|is|are)\s+quiet\b/i;

/**
 * Pulse's coverage.note may call channels quiet: an older Pulse does on "online now", and v1.2
 * does for the proven channels of a point it can't call quiet as a whole. Unless the rail voice
 * answer here is quiet, those sentences are withheld, so the data never says quiet where the
 * answer doesn't. Returns the coverage to report, or undefined to keep Pulse's.
 */
function withholdQuiet(cov: Json, quiet: boolean): Json | undefined {
  const note = typeof cov.note === 'string' ? cov.note : undefined;
  if (quiet || !note || !QUIET_CLAIM.test(note)) return undefined;
  const kept = note.split(/(?<=\.)\s+/).filter((s) => !QUIET_CLAIM.test(s));
  return {
    ...cov,
    note: [
      ...kept,
      "(The gateway withheld Pulse's sentence calling channels quiet: that is not confirmed for this point; see coverage_check.)",
    ].join(' '),
  };
}

/**
 * Contract v1.2: Pulse's own verdicts decide. The gateway relays them and only turns a quiet
 * into unknown when its checks disagree (checkVerdict); the counts are Pulse's, for the channels
 * that cover the point.
 */
function fromVerdicts(
  j: Json,
  verdicts: PulseVerdicts,
  o: { status?: FeedsStatus; tracks: TrackNames[]; since: number; railroad?: string; here: string },
): Judged {
  const rec = recordingsWithoutText(coverageOf(j));
  const rail = checkVerdict('rail_radio', verdicts.rail_radio, {
    status: o.status,
    tracks: o.tracks,
    window_min: o.since,
    listed: count(j.transcripts) + count(j.detector_readouts) + (rec?.total ?? 0),
  });
  const eot = checkVerdict('eot', verdicts.eot, {
    status: o.status,
    window_min: o.since,
    listed: count(j.eot_hot),
  });
  const vc = rail.counts;
  const counts =
    `${vc?.transcripts ?? count(j.transcripts)} rail transmission(s), ` +
    `${vc?.detector_readouts ?? count(j.detector_readouts)} detector readout(s), ` +
    `${vc?.recordings_without_text ?? rec?.total ?? 0} recording(s) without text (not transcribed yet, failed or no speech), ` +
    `${eot.counts?.eot_packets ?? count(j.eot_hot)} EOT/HOT packet(s) in the last ${o.since} min on the channels that cover this point.`;
  const only = o.railroad ? ` (${o.railroad} channels only, as asked)` : '';
  const coverage = withholdQuiet(coverageOf(j), rail.state === 'quiet');
  return {
    summary: `${counts} Rail radio${only}: ${railVerdictSentence(rail, o.here)} EOT/HOT: ${railVerdictSentence(eot)}`,
    data: coverage ? { coverage } : {},
    check: { rail_radio: rail, eot },
  };
}

/**
 * A Pulse without verdicts (older than v1.2): the gateway judges from feeds/status and the
 * channels rail/activity lists for the point, and never says quiet (assess). Recordings without
 * text count as traffic. EOT/HOT packets are never activity at the point: such a Pulse lists an
 * EOT/HOT receiver by a fixed 25 km, whatever its own range, so they are reported as heard but
 * not placed (and moved to `eot_hot_not_placed`).
 */
function withoutVerdicts(
  j: Json,
  o: { status?: FeedsStatus; tracks: TrackNames[]; since: number; here: string; now: number },
): Judged {
  const { status, since } = o;
  const cov = coverageOf(j);
  const rec = recordingsWithoutText(cov);
  const voice = count(j.transcripts) + count(j.detector_readouts) + (rec?.total ?? 0);
  const packets = count(j.eot_hot);
  const chans = (Array.isArray(cov.channels) ? (cov.channels as unknown[]) : []).filter(
    (c): c is { channel: string; kind?: unknown } =>
      Boolean(c) &&
      typeof c === 'object' &&
      typeof (c as { channel?: unknown }).channel === 'string',
  );
  // The channels Pulse lists for THIS point, per kind. Voice: only these were searched for
  // transcripts here. EOT: it lists one only when its receiver is within range of the point or
  // has no location set. v1.1 always sends the list, so there a missing list means none.
  const known = Array.isArray(cov.channels) || Boolean(status && reportsCoverage(status));
  const pulseVoice = known
    ? chans.filter((c) => c.kind !== 'eot').map((c) => c.channel)
    : undefined;
  const pulseEot = known ? chans.filter((c) => c.kind === 'eot').map((c) => c.channel) : undefined;
  // Pulse's `covered` lumps voice and EOT together: split it so that a reported EOT receiver
  // doesn't make voice covered, nor the reverse.
  const railVerdict = assess('rail_radio', status, {
    messages: voice,
    window_min: since,
    tracks: o.tracks,
    pulseChannels: pulseVoice,
    pulseCovered: pulseCoveredFor('rail_radio', cov, status),
  });
  const eotVerdict = assess('eot', status, {
    messages: packets,
    window_min: since,
    pulseChannels: pulseEot,
    pulseCovered: pulseCoveredFor('eot', cov, status),
  });
  // Packets no receiver covering this point heard are not activity here, and without verdicts
  // nothing places the packets a listed receiver heard at the point either.
  const ignored = eotVerdict.state === 'no_receiver' ? (eotVerdict.ignored_messages ?? 0) : 0;
  const unplaced = eotVerdict.state === 'unplaced' ? packets : 0;
  const eotCount = unplaced
    ? `${unplaced} EOT/HOT packet(s) heard but not placed at this point`
    : `${packets - ignored} EOT/HOT packet(s)${ignored ? ` (${ignored} ignored: no EOT/HOT receiver that covers this point heard ${ignored === 1 ? 'it' : 'them'})` : ''}`;
  const unread = rec
    ? `, ${rec.total} recording(s) without text (${rec.pending} not transcribed yet, ${rec.error} failed, ${rec.no_speech} no speech)`
    : '';
  const counts = `${count(j.transcripts)} rail transmission(s), ${count(j.detector_readouts)} detector readout(s)${unread}, ${eotCount} in the last ${since} min.`;
  // Never quiet without verdicts, so a note calling channels quiet is withheld.
  const withheld = withholdQuiet(cov, false);
  const old =
    !reportsCoverage(status ?? { feeds: [] }) && cov.covered === false
      ? ' Pulse says no monitored channel covers this line yet.'
      : '';
  return {
    summary: `${counts} Rail radio: ${verdictSentence(railVerdict, o.now, o.here)}${old} EOT/HOT: ${verdictSentence(eotVerdict, o.now)}`,
    data: {
      ...(ignored ? { eot_hot: [], eot_hot_not_near_point: j.eot_hot } : {}),
      ...(unplaced ? { eot_hot: [], eot_hot_not_placed: j.eot_hot } : {}),
      ...(withheld ? { coverage: withheld } : {}),
    },
    check: {
      rail_radio: { basis: 'gateway_without_verdicts', ...railVerdict },
      eot: { basis: 'gateway_without_verdicts', ...eotVerdict },
    },
  };
}

export interface PulseToolOptions {
  /** Rail index: every name the datasets give the track at a point, for coverage matching. */
  rail?: RailIndex;
  /** How long one feeds/status answer is reused (whats_happening_here asks twice at once). */
  feedsCacheMs?: number;
  now?: () => number;
}

export function pulseTools(client: PulseClient, opts: PulseToolOptions = {}): ToolDef[] {
  const now = opts.now ?? Date.now;
  const cacheMs = opts.feedsCacheMs ?? 10_000;
  let cached: { at: number; p: Promise<FeedsResult> } | undefined;
  /** feeds/status, shared by concurrent callers (not tied to one caller's abort signal). */
  const feeds = (): Promise<FeedsResult> => {
    const t = now();
    if (cached && t - cached.at <= cacheMs) return cached.p;
    const p = client.get<unknown>('v1/feeds/status').then(
      (j): FeedsResult => ({ ok: true, status: parseFeedsStatus(j) }),
      (err: unknown): FeedsResult => ({ ok: false, err }),
    );
    cached = { at: t, p };
    return p;
  };
  const base = (name: string) => ({
    source: 'pulse' as const,
    family: 'pulse',
    tags: metaFor(name).tags,
    untrustedText: true,
    attribution: 'Detroit Pulse (scanner-radio transcripts; machine-generated, may be wrong)',
  });
  return [
    {
      ...base('incidents_near'),
      name: 'incidents_near',
      title: 'Scanner incidents near a point',
      description:
        'Police/fire/EMS incidents Detroit Pulse derived from scanner radio near a point within a time window, nearest first, with type, status, address, units and a machine summary.',
      inputSchema: {
        type: 'object',
        properties: {
          ...LATLON,
          radius_km: { type: 'number', minimum: 0.1, maximum: 50 },
          since_minutes: SINCE(60, 1440),
          limit: { type: 'integer', minimum: 1, maximum: 100 },
        },
        required: ['lat', 'lon'],
        additionalProperties: false,
      },
      async run(a, ctx) {
        const since = (a.since_minutes as number | undefined) ?? 60;
        const [out, st] = await Promise.all([
          call(
            client,
            'v1/incidents/near',
            { radius_km: 3, since_minutes: 60, ...a },
            ctx.signal,
            (j) => {
              const n = count(j.incidents);
              return n
                ? `${n} incident(s) within ${j.radius_km ?? a.radius_km ?? 3} km in the last ${j.since_minutes ?? since} min.`
                : 'No scanner incidents in range for that window.';
            },
          ),
          feeds(),
        ]);
        if (out.isError) return out;
        const j = (out.data ?? {}) as Json;
        const verdict = assess('public_safety', st.ok ? st.status : undefined, {
          messages: count(j.incidents),
          window_min: since,
        });
        return {
          ...out,
          summary: `${out.summary} ${verdictSentence(verdict, now(), 'this area')}`,
          data: { ...j, coverage_check: { public_safety: verdict } },
        };
      },
    },
    {
      ...base('incident_detail'),
      name: 'incident_detail',
      title: 'Incident detail',
      description: 'One Pulse incident with its timeline of radio transcript chunks.',
      inputSchema: {
        type: 'object',
        properties: {
          incident_id: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9-]+$' },
        },
        required: ['incident_id'],
        additionalProperties: false,
      },
      run: (a, ctx) =>
        call(
          client,
          `v1/incidents/${encodeURIComponent(String(a.incident_id))}`,
          {},
          ctx.signal,
          (j) => `Incident with ${count(j.transcripts)} transcript chunk(s).`,
        ),
    },
    {
      ...base('search_transcripts'),
      name: 'search_transcripts',
      title: 'Search radio transcripts',
      description:
        'Full-text search of recent scanner/rail radio transcripts, newest first, optionally limited to one channel.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 200 },
          since_minutes: SINCE(60, 1440),
          channel: { type: 'string', minLength: 1, maxLength: 80 },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
        },
        required: ['query'],
        additionalProperties: false,
      },
      run: (a, ctx) =>
        call(
          client,
          'v1/transcripts/search',
          { q: a.query, since_minutes: a.since_minutes ?? 60, channel: a.channel, limit: a.limit },
          ctx.signal,
          (j) => `${count(j.results)} transcript match(es).`,
        ),
    },
    {
      ...base('rail_activity_near'),
      name: 'rail_activity_near',
      title: 'Rail radio activity near a point',
      description:
        "Recent railroad radio for the rail line near a point: road/dispatcher transcripts, defect-detector readouts, recordings not transcribed yet, EOT/HOT telemetry and labels for why a train is stopped. For rail voice and EOT/HOT it relays Pulse's verdict: activity found, quiet (only when Pulse proves every channel covering the point was listened to for the whole window), no coverage, or can't confirm, so 0 messages is never mistaken for a quiet line.",
      inputSchema: {
        type: 'object',
        properties: {
          ...LATLON,
          since_minutes: SINCE(30, 720),
          subdivision: { type: 'string', maxLength: 80 },
          railroad: { type: 'string', maxLength: 20 },
        },
        required: ['lat', 'lon'],
        additionalProperties: false,
      },
      async run(a, ctx) {
        const lat = a.lat as number;
        const lon = a.lon as number;
        const since = (a.since_minutes as number | undefined) ?? 30;
        // Every name the datasets give the track here, plus the caller's hint.
        const tracks: TrackNames[] = opts.rail ? opts.rail.tracksNear(lat, lon) : [];
        if (typeof a.subdivision === 'string' && a.subdivision.trim())
          tracks.push({
            label: 'caller hint',
            names: [{ dataset: 'caller', name: a.subdivision.trim() }],
            railroads: typeof a.railroad === 'string' ? [a.railroad] : [],
          });
        const st = await feeds();
        // Pulse down: same answer as before, without a second timeout.
        if (!st.ok && st.err instanceof PulseUnavailableError) return errorOutput(st.err);
        const status = st.ok ? st.status : undefined;
        // The subdivision hint is the name Pulse's own config uses for this track when one of
        // its aliases matches, else a plain name; Pulse uses it for its note, never to pick
        // channels. The railroad hint narrows the channels Pulse checks, so only the caller's.
        const match = status ? matchCoverageLine(status, tracks) : undefined;
        const firstName = tracks.find((t) => t.names.length)?.names[0]?.name;
        const hint =
          match?.line.name ??
          (typeof a.subdivision === 'string' && a.subdivision.trim()
            ? plainLineName(a.subdivision)
            : firstName
              ? plainLineName(firstName)
              : undefined);
        const railroad = (typeof a.railroad === 'string' && a.railroad.trim()) || undefined;
        let j: Json;
        try {
          j = await client.get<Json>(
            'v1/rail/activity',
            { lat, lon, since_minutes: since, subdivision: hint, railroad },
            ctx.signal,
          );
        } catch (err) {
          return errorOutput(err);
        }
        const here = tracks.length ? lineLabel(tracks) : 'this point';
        const verdicts = parseVerdicts(j.verdicts);
        const judged = verdicts
          ? fromVerdicts(j, verdicts, { status, tracks, since, railroad, here })
          : withoutVerdicts(j, { status, tracks, since, here, now: now() });
        // Labels are machine-derived from radio: cap how many and how long (review MCP-3).
        const all = Array.isArray(j.reason_labels)
          ? (j.reason_labels as Array<{ label?: unknown }>).map((l) => String(l?.label ?? ''))
          : [];
        const labels = all.slice(0, 10).map((l) => (l.length > 80 ? l.slice(0, 79) + '…' : l));
        const more = all.length > labels.length ? ` (+${all.length - labels.length} more)` : '';
        const why = labels.length
          ? ` Machine-labelled likely reason: ${labels.join(', ')}${more}.`
          : '';
        return {
          summary: `${judged.summary}${why}`,
          data: {
            ...j,
            ...judged.data,
            line_names_checked: tracks.map((t) => ({ track: t.label, names: t.names })),
            pulse_subdivision_hint: hint,
            coverage_check: judged.check,
          },
          observedAt: typeof j.generated_at === 'string' ? j.generated_at : undefined,
        };
      },
    },
    {
      ...base('feeds_status'),
      name: 'feeds_status',
      title: 'Pulse feed status',
      description:
        'Which scanner and rail radio feeds Pulse is monitoring, whether each is up, whether a receiver is installed/online for it, and which area or rail lines it covers. Example placeholder feeds are marked and never count as coverage.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async run(_a, ctx) {
        let j: Json;
        try {
          j = await client.get<Json>('v1/feeds/status', {}, ctx.signal);
        } catch (err) {
          return errorOutput(err);
        }
        const status = parseFeedsStatus(j);
        const examples = status.feeds.filter(isExampleFeed);
        const real = status.feeds.filter((f) => !isExampleFeed(f));
        const parts = [
          `${real.length} feed(s): ${real.filter((f) => f.state === 'up').length} up.`,
        ];
        if (examples.length)
          parts.push(
            `${examples.length} example placeholder feed(s) ignored (${examples
              .slice(0, 5)
              .map((f) => f.feed_id)
              .join(', ')}).`,
          );
        if (reportsCoverage(status)) {
          const label = { rail_radio: 'rail radio', eot: 'EOT/HOT', public_safety: 'scanner' };
          const kinds = (['rail_radio', 'eot', 'public_safety'] as const).map((k) => {
            const st = status.coverage_summary?.[k];
            const fs = feedsOfKind(status, k);
            const own = fs.length
              ? fs
                  .map((f) => f.receiver?.state ?? 'unknown')
                  .reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {})
              : {};
            const detail = Object.entries(own)
              .map(([x, n]) => `${n} ${x}`)
              .join(', ');
            return `${label[k]}: ${st ?? (fs.length ? 'see feeds' : 'not_configured')}${detail ? ` (${detail})` : ''}`;
          });
          parts.push(`Coverage: ${kinds.join('; ')}.`);
        } else {
          parts.push(
            'This Pulse does not report receivers or coverage (older version), so a feed with no recent audio may be quiet or uncovered.',
          );
        }
        // Mark examples even if this Pulse didn't, so nothing downstream counts them.
        const feedsOut = (Array.isArray(j.feeds) ? (j.feeds as Json[]) : []).map((f) =>
          f &&
          typeof f === 'object' &&
          isExampleFeed({ feed_id: String(f.feed_id ?? ''), example: f.example === true })
            ? { ...f, example: true }
            : f,
        );
        return {
          summary: parts.join(' '),
          data: {
            ...j,
            feeds: feedsOut,
            kinds: real.map((f) => ({ feed_id: f.feed_id, kind: feedKind(f) ?? 'other' })),
          },
          observedAt: typeof j.generated_at === 'string' ? j.generated_at : undefined,
        };
      },
    },
  ];
}
