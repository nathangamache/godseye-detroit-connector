/** Pulse tools registered in the registry (source "pulse"). Output text from radio is untrusted. */
import type { RailIndex } from '../rail/index.js';
import { plainLineName, type TrackNames } from '../rail/names.js';
import { metaFor } from '../tools/tags.js';
import type { ToolDef, ToolOutput } from '../tools/types.js';
import { PulseClient, PulseHttpError, PulseUnavailableError } from './client.js';
import {
  assess,
  feedKind,
  feedsOfKind,
  isExampleFeed,
  lineLabel,
  matchCoverageLine,
  parseFeedsStatus,
  reportsCoverage,
  verdictSentence,
  type FeedsStatus,
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
        'Recent railroad radio for the rail line near a point: road/dispatcher transcripts, defect-detector readouts, EOT/HOT telemetry and labels for why a train is stopped. States whether a receiver covers that line (none installed, offline since when, or listening and quiet), so 0 messages is never mistaken for a quiet line.',
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
        // Pulse's own lookup matches subdivision names by substring: give it the name its own
        // config uses for this track when one of the aliases matches, else a plain name.
        const match = status ? matchCoverageLine(status, tracks) : undefined;
        const firstName = tracks.find((t) => t.names.length)?.names[0]?.name;
        const hint =
          match?.line.name ??
          (typeof a.subdivision === 'string' && a.subdivision.trim()
            ? plainLineName(a.subdivision)
            : firstName
              ? plainLineName(firstName)
              : undefined);
        const railroad =
          (typeof a.railroad === 'string' && a.railroad) || match?.line.railroad || undefined;
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
        const voice = count(j.transcripts) + count(j.detector_readouts);
        const packets = count(j.eot_hot);
        const cov = (j.coverage ?? {}) as { covered?: boolean; channels?: unknown };
        const chans = Array.isArray(cov.channels)
          ? (cov.channels as Array<{ channel?: unknown; kind?: unknown }>)
          : [];
        const pulseVoice = chans
          .filter((c) => c && c.kind !== 'eot' && typeof c.channel === 'string')
          .map((c) => String(c.channel));
        const railVerdict = assess('rail_radio', status, {
          messages: voice,
          window_min: since,
          tracks,
          pulseChannels: pulseVoice,
        });
        const eotVerdict = assess('eot', status, { messages: packets, window_min: since });
        // Labels are machine-derived from radio: cap how many and how long (review MCP-3).
        const all = Array.isArray(j.reason_labels)
          ? (j.reason_labels as Array<{ label?: unknown }>).map((l) => String(l?.label ?? ''))
          : [];
        const labels = all.slice(0, 10).map((l) => (l.length > 80 ? l.slice(0, 79) + '…' : l));
        const more = all.length > labels.length ? ` (+${all.length - labels.length} more)` : '';
        const counts = `${count(j.transcripts)} rail transmission(s), ${count(j.detector_readouts)} detector readout(s), ${count(j.eot_hot)} EOT/HOT packet(s) in the last ${since} min${labels.length ? `; likely reason: ${labels.join(', ')}${more}` : ''}.`;
        const here = tracks.length ? lineLabel(tracks) : 'this point';
        const old =
          !reportsCoverage(status ?? { feeds: [] }) && cov.covered === false
            ? ' Pulse says no monitored channel covers this line yet.'
            : '';
        const summary = `${counts} Rail radio: ${verdictSentence(railVerdict, now(), here)}${old} EOT/HOT: ${verdictSentence(eotVerdict, now())}`;
        return {
          summary,
          data: {
            ...j,
            line_names_checked: tracks.map((t) => ({ track: t.label, names: t.names })),
            pulse_subdivision_hint: hint,
            coverage_check: { rail_radio: railVerdict, eot: eotVerdict },
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
