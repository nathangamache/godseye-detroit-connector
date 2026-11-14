/** Pulse tools registered in the registry (source "pulse"). Output text from radio is untrusted. */
import { metaFor } from '../tools/tags.js';
import type { ToolDef, ToolOutput } from '../tools/types.js';
import { PulseClient, PulseHttpError, PulseUnavailableError } from './client.js';

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
}

const count = (v: unknown) => (Array.isArray(v) ? v.length : 0);

export function pulseTools(client: PulseClient): ToolDef[] {
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
      run: (a, ctx) =>
        call(
          client,
          'v1/incidents/near',
          { radius_km: 3, since_minutes: 60, ...a },
          ctx.signal,
          (j) => {
            const n = count(j.incidents);
            return n
              ? `${n} incident(s) within ${j.radius_km ?? a.radius_km ?? 3} km in the last ${j.since_minutes ?? a.since_minutes ?? 60} min.`
              : 'No scanner incidents in range for that window.';
          },
        ),
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
        'Recent railroad radio for the rail subdivision near a point: road/dispatcher transcripts, defect-detector readouts, EOT/HOT telemetry and labels for why a train is stopped. Says when Pulse has no coverage for that line.',
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
      run: (a, ctx) =>
        call(client, 'v1/rail/activity', { since_minutes: 30, ...a }, ctx.signal, (j) => {
          const cov = (j.coverage ?? {}) as { covered?: boolean };
          if (cov.covered === false)
            return 'No rail radio coverage for this line yet (no monitored channel).';
          // Labels are machine-derived from radio: cap how many and how long (review MCP-3).
          const all = Array.isArray(j.reason_labels)
            ? (j.reason_labels as Array<{ label?: unknown }>).map((l) => String(l?.label ?? ''))
            : [];
          const labels = all.slice(0, 10).map((l) => (l.length > 80 ? l.slice(0, 79) + '…' : l));
          const more = all.length > labels.length ? ` (+${all.length - labels.length} more)` : '';
          return `${count(j.transcripts)} rail transmission(s), ${count(j.detector_readouts)} detector readout(s), ${count(j.eot_hot)} EOT/HOT packet(s)${labels.length ? `; likely reason: ${labels.join(', ')}${more}` : ''}.`;
        }),
    },
    {
      ...base('feeds_status'),
      name: 'feeds_status',
      title: 'Pulse feed status',
      description: 'Which scanner and rail radio feeds Pulse is monitoring and whether each is up.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: (_a, ctx) =>
        call(client, 'v1/feeds/status', {}, ctx.signal, (j) => {
          const feeds = Array.isArray(j.feeds) ? (j.feeds as Array<{ state?: string }>) : [];
          return `${feeds.length} feed(s): ${feeds.filter((f) => f.state === 'up').length} up.`;
        }),
    },
  ];
}
