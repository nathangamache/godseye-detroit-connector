/**
 * End to end through /mcp: whats_happening_here, rail_activity_near, incidents_near and
 * feeds_status say which situation applies, ignoring example feeds, and match rail coverage on
 * every name the datasets give a track. With Pulse's v1.2 verdicts, rail voice and EOT/HOT relay
 * Pulse's state and reasons (quiet only on its proof; the gateway may only downgrade it).
 * Without them (an older Pulse, and scanner incidents): activity found, no receiver for this
 * line/area, receiver offline since T, online now but can't confirm, or Pulse too old; never quiet.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT, loadConfig } from '../src/config.js';
import { startGateway } from '../src/gateway.js';
import { childSpawnSpec } from '../src/gev/child.js';
import { nullLogger } from '../src/log.js';
import { RailIndex } from '../src/rail/index.js';
import { startMockPulse, type MockPulseOptions } from './fixtures/mock-pulse.js';
import { BELLE_ISLE, DETROIT, MOCK_GEV, UPSTREAMS_DOWN, waitFor } from './helpers.js';

const text = (r: { content: unknown }) =>
  (r.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n');

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

/** A rail activity answer with nothing heard (Pulse's own lookup may or may not cover the point). */
const quietRail =
  (covered = false, channel?: string) =>
  (q: URLSearchParams) => ({
    generated_at: iso(0),
    subdivision: q.get('subdivision') ?? undefined,
    coverage: {
      covered,
      channels: channel ? [{ channel, kind: 'road' }] : [],
      ...(covered ? {} : { note: 'No monitored rail voice channel for this location yet.' }),
    },
    transcripts: [],
    detector_readouts: [],
    eot_hot: [],
    reason_labels: [],
  });
const noIncidents = (q: URLSearchParams) => ({
  generated_at: iso(0),
  radius_km: Number(q.get('radius_km')),
  since_minutes: Number(q.get('since_minutes')),
  incidents: [],
});

const EXAMPLES = [
  {
    feed_id: 'example_fire_dispatch',
    name: 'Example city fire dispatch',
    category: 'public_safety',
    enabled: true,
    state: 'down',
    chunks_last_hour: 0,
    source: 'sdr:rtl_airband',
    example: true,
    receiver: { state: 'not_installed' },
  },
  {
    feed_id: 'example_rail_road',
    name: 'Example railroad road channel',
    category: 'rail',
    enabled: true,
    state: 'down',
    chunks_last_hour: 0,
    source: 'sdr:rtl_airband',
    example: true,
    receiver: { state: 'online', last_seen_at: iso(10_000) },
    coverage: { lines: [{ railroad: 'EXAMPLE_RR', name: 'Example Subdivision', aliases: [] }] },
  },
];
const EOT_UNLOCATED = {
  feed_id: 'eot_hot',
  name: 'EOT/HOT telemetry (traintap)',
  category: 'rail',
  enabled: true,
  state: 'down',
  chunks_last_hour: 0,
  source: 'sdr:traintap',
  receiver: { state: 'not_installed' },
};

async function harness(pulse: MockPulseOptions) {
  const mock = await startMockPulse('pulse-test-token', pulse);
  const dir = mkdtempSync(path.join(tmpdir(), 'gw-cov-'));
  const config = loadConfig({
    GATEWAY_MODE: 'test',
    PORT: '0',
    PRIVATE_PORT: '0',
    UI_PORT: '0',
    DATA_DIR: dir,
    PULSE_URL: mock.url,
    PULSE_API_TOKEN: mock.token,
    PULSE_TIMEOUT_MS: '2000',
  });
  const gw = await startGateway(config, {
    fetch: UPSTREAMS_DOWN,
    logger: nullLogger,
    gevChild: childSpawnSpec({
      gevRoot: REPO_ROOT,
      gevUrl: 'http://127.0.0.1:7701',
      wrapper: MOCK_GEV,
    }),
  });
  await waitFor(() => gw.registry.hasGev(), 10_000);
  const token = gw.tokens.issue({
    clientId: 'c',
    subject: 'owner',
    scope: 'mcp',
    resource: config.mcpResource,
  }).tokens.access_token;
  const client = new Client({ name: 't', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${gw.url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return {
    mock,
    client,
    run: async (name: string, args: Record<string, unknown>) =>
      text(await client.callTool({ name: 'run_tool', arguments: { name, arguments: args } })),
    async close() {
      await client.close();
      await gw.close();
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * A crossing whose FRA and NARN subdivision names differ, found in the data (not hard-coded)
 * with an independent oracle: the crossing's own FRA subdivision vs the NARN subdivision of the
 * track it sits on (nearestLine within 15 m), using only the index's long-standing API.
 */
let split: { lat: number; lon: number; fra: string; narn: string };
let railIndex: RailIndex;
beforeAll(() => {
  const index = RailIndex.load(path.join(REPO_ROOT, 'data', 'rail'));
  railIndex = index;
  const norm = (s: string) =>
    s
      .toUpperCase()
      .replace(/\([^)]*\)/g, '')
      .trim();
  for (const c of index.crossings) {
    if (
      c.pos !== 'At Grade' ||
      !c.subdiv ||
      !/^[A-Z ]{4,}$/.test(c.subdiv) ||
      /MAIN/.test(c.subdiv)
    )
      continue;
    const line = index.nearestLine(c.lat, c.lon, 1000);
    const narn = line?.subdivision;
    if (!line || line.distance_m > 15 || !narn || !/\(/.test(narn)) continue;
    if (norm(c.subdiv) === norm(narn)) continue;
    split = { lat: c.lat, lon: c.lon, fra: c.subdiv, narn };
    break;
  }
  if (!split) throw new Error('no crossing with differing FRA and NARN names in the data');
});

describe('rail radio: which situation applies', () => {
  it('no receiver for this line: says so, names what Pulse does cover, ignores examples', async () => {
    const h = await harness({
      feeds: () => ({
        generated_at: iso(0),
        feeds: [
          ...EXAMPLES,
          EOT_UNLOCATED,
          {
            feed_id: 'cn_zulu_road',
            name: 'CN Zulu road',
            category: 'rail',
            enabled: true,
            state: 'up',
            chunks_last_hour: 3,
            source: 'sdr:rtl_airband',
            receiver: { state: 'online', last_seen_at: iso(20_000) },
            coverage: { lines: [{ railroad: 'CN', name: 'Zulu Subdivision', aliases: [] }] },
          },
        ],
        coverage_summary: {
          rail_radio: 'listening',
          eot: 'no_receiver',
          public_safety: 'not_configured',
        },
      }),
      rail: quietRail(false),
      incidents: noIncidents,
    });
    try {
      const t = text(
        await h.client.callTool({
          name: 'whats_happening_here',
          arguments: { lat: split.lat, lon: split.lon },
        }),
      );
      expect(t).toMatch(/Rail radio \(Pulse\): 0 rail transmission\(s\)/);
      expect(t).toMatch(/No rail radio receiver for this line \(/);
      expect(t).toMatch(/channels cover CN Zulu Subdivision/);
      expect(t).toMatch(/0 rail messages means no coverage, not a quiet line/);
      expect(t).not.toMatch(/Example Subdivision/);
      // EOT: a channel exists but no receiver has ever reported.
      expect(t).toMatch(
        /No EOT\/HOT receiver installed: 1 EOT\/HOT telemetry channel \(EOT\/HOT telemetry \(traintap\)\) is configured, but no receiver has ever reported/,
      );
      // Scanner: only the example feed exists, so nothing is set up.
      expect(t).toMatch(
        /Incidents \(Pulse\): No scanner incidents in range for that window\. No scanner \(police\/fire\/EMS\) receiver installed/,
      );
    } finally {
      await h.close();
    }
  });

  it("matches Pulse's line by the other dataset's name and asks Pulse with Pulse's own name", async () => {
    // Pulse's config knows the line only by its FRA name; the gateway's nearest track is NARN-named.
    const pulseName = `${split.fra.charAt(0)}${split.fra.slice(1).toLowerCase()} Subdivision`;
    const h = await harness({
      feeds: () => ({
        generated_at: iso(0),
        feeds: [
          {
            feed_id: 'line_road',
            name: 'Line road',
            category: 'rail',
            enabled: true,
            state: 'down',
            chunks_last_hour: 0,
            source: 'sdr:rtl_airband',
            receiver: { state: 'online', last_seen_at: iso(5_000) },
            coverage: { lines: [{ name: pulseName, aliases: [] }] },
          },
        ],
        coverage_summary: {
          rail_radio: 'listening',
          eot: 'not_configured',
          public_safety: 'not_configured',
        },
      }),
      rail: (q) => quietRail(q.get('subdivision') === pulseName, 'Line road')(q),
    });
    try {
      const t = text(
        await h.client.callTool({
          name: 'whats_happening_here',
          arguments: { lat: split.lat, lon: split.lon },
        }),
      );
      // Matched, but this Pulse sends no verdicts: online now is no proof of a quiet window.
      expect(t).toMatch(
        /Can't confirm quiet: rail radio receiver online now \(Line road\) and 0 rail messages on this line \(/,
      );
      expect(t).not.toMatch(/Listening and quiet|really is quiet/);
      const asked = h.mock.urls.find((u) => u.pathname === '/v1/rail/activity')!;
      expect(asked.searchParams.get('subdivision')).toBe(pulseName);
      // The line is named by both datasets in the rail summary.
      expect(t).toMatch(/NARN: /);
      expect(t).toMatch(/FRA: /);
    } finally {
      await h.close();
    }
  });

  it('receiver offline since T (via run_tool rail_activity_near)', async () => {
    const lastSeen = iso(3 * 3_600_000);
    const h = await harness({
      feeds: () => ({
        generated_at: iso(0),
        feeds: [
          {
            feed_id: 'line_road',
            name: 'Line road',
            category: 'rail',
            enabled: true,
            state: 'degraded',
            chunks_last_hour: 0,
            source: 'sdr:rtl_airband',
            receiver: { state: 'offline', last_seen_at: lastSeen },
            coverage: { lines: [{ name: split.narn, aliases: [split.fra] }] },
          },
        ],
        coverage_summary: {
          rail_radio: 'receiver_offline',
          eot: 'not_configured',
          public_safety: 'not_configured',
        },
      }),
      rail: quietRail(true, 'Line road'),
    });
    try {
      const t = await h.run('rail_activity_near', { lat: split.lat, lon: split.lon });
      expect(t).toContain(
        `Rail radio receiver offline since ${new Date(lastSeen).toISOString()} (3 h ago)`,
      );
      expect(t).toMatch(/0 rail messages means no data, not a quiet line/);
      expect(t).toMatch(/"coverage_check"/);
    } finally {
      await h.close();
    }
  });

  it('older Pulse without receiver fields: too old to tell quiet from uncovered', async () => {
    const h = await harness({ rail: quietRail(true, 'CSX Detroit Sub road') });
    try {
      const t = await h.run('rail_activity_near', DETROIT);
      expect(t).toMatch(/0 rail transmission\(s\)/);
      expect(t).toMatch(
        /Pulse is too old to report its receivers, so 0 rail messages on this line .* can't be told apart from no receiver/,
      );
    } finally {
      await h.close();
    }
  });

  it('activity found is reported as activity', async () => {
    const h = await harness({
      feeds: () => ({
        generated_at: iso(0),
        feeds: [
          {
            feed_id: 'rail-1',
            name: 'CSX Detroit Sub road',
            category: 'rail',
            enabled: true,
            state: 'up',
            chunks_last_hour: 4,
            source: 'sdr:test',
            receiver: { state: 'online', last_seen_at: iso(1_000) },
            coverage: { lines: [] },
          },
        ],
        coverage_summary: {
          rail_radio: 'listening',
          eot: 'not_configured',
          public_safety: 'not_configured',
        },
      }),
    });
    try {
      const t = await h.run('rail_activity_near', DETROIT);
      expect(t).toMatch(/1 rail transmission\(s\)/);
      expect(t).toMatch(/Activity found: 1 rail message on this line .*\(CSX Detroit Sub road\)/);
    } finally {
      await h.close();
    }
  });
});

describe('scanner incidents and feeds_status', () => {
  it('scanner: a receiver online now is not "quiet" (no proof), with the areas Pulse hears', async () => {
    const h = await harness({
      feeds: () => ({
        generated_at: iso(0),
        feeds: [
          ...EXAMPLES,
          {
            feed_id: 'county_fire',
            name: 'County fire dispatch',
            category: 'public_safety',
            county: 'Example County',
            enabled: true,
            state: 'up',
            chunks_last_hour: 12,
            source: 'sdr:rtl_airband',
            receiver: { state: 'online', last_seen_at: iso(2_000) },
            coverage: { area: 'Example County', radius_km: 30 },
          },
        ],
        coverage_summary: {
          rail_radio: 'not_configured',
          eot: 'not_configured',
          public_safety: 'listening',
        },
      }),
      incidents: noIncidents,
    });
    try {
      const t = await h.run('incidents_near', { ...DETROIT, since_minutes: 120 });
      expect(t).toMatch(
        /No scanner incidents in range for that window\. Can't confirm quiet: scanner \(police\/fire\/EMS\) receiver online now \(County fire dispatch\) and 0 scanner incidents in this area in the last 120 min, but Pulse doesn't prove its scanner receivers listened for the whole window/,
      );
      expect(t).not.toMatch(/Listening and quiet|really is quiet/);
      expect(t).toMatch(
        /channels cover Example County; whether this point is inside that area isn't known/,
      );
      const f = await h.run('feeds_status', {});
      expect(f).toMatch(
        /1 feed\(s\): 1 up\. 2 example placeholder feed\(s\) ignored \(example_fire_dispatch, example_rail_road\)\./,
      );
      expect(f).toMatch(
        /Coverage: rail radio: not_configured; EOT\/HOT: not_configured; scanner: listening \(1 online\)\./,
      );
    } finally {
      await h.close();
    }
  });

  it('feeds_status on an older Pulse says it cannot report receivers', async () => {
    const h = await harness({});
    try {
      expect(await h.run('feeds_status', {})).toMatch(
        /1 feed\(s\): 1 up\. This Pulse does not report receivers or coverage/,
      );
    } finally {
      await h.close();
    }
  });
});

describe('rail_activity_near ties each verdict to the point', () => {
  const EOT_NAME = 'EOT/HOT telemetry (traintap)';
  const ZULU = {
    feed_id: 'cn_zulu_road',
    name: 'CN Zulu road',
    category: 'rail',
    enabled: true,
    state: 'up',
    chunks_last_hour: 3,
    source: 'sdr:rtl_airband',
    receiver: { state: 'online', last_seen_at: iso(20_000) },
    coverage: { lines: [{ railroad: 'CN', name: 'Zulu Subdivision', aliases: [] }] },
  };

  it('EOT: a far point is not "quiet" and packets heard elsewhere are not activity there', async () => {
    const h = await harness({
      feeds: () => ({
        generated_at: iso(0),
        feeds: [
          {
            feed_id: 'eot_hot',
            name: EOT_NAME,
            category: 'rail',
            enabled: true,
            state: 'up',
            chunks_last_hour: 9,
            source: 'sdr:traintap',
            receiver: { state: 'online', last_seen_at: iso(5_000), device: 'traintap' },
            coverage: { area: 'Elsewhere County', radius_km: 25 },
          },
        ],
        coverage_summary: {
          rail_radio: 'not_configured',
          eot: 'listening',
          public_safety: 'not_configured',
        },
      }),
      // Pulse lists its EOT channel only for points within range of the located receiver
      // (BELLE_ISLE here); since_minutes=60 makes the mock return packets anyway.
      rail: (q) => {
        const near = Number(q.get('lat')) === BELLE_ISLE.lat;
        const packets =
          q.get('since_minutes') === '60'
            ? [
                { ts: iso(60_000), device: 'EOT', unit_id: '12345' },
                { ts: iso(90_000), device: 'HOT', unit_id: '12345' },
              ]
            : [];
        return {
          generated_at: iso(0),
          coverage: {
            covered: near,
            channels: near ? [{ channel: EOT_NAME, kind: 'eot', receiver_state: 'online' }] : [],
          },
          transcripts: [],
          detector_readouts: [],
          eot_hot: packets,
          reason_labels: [],
        };
      },
    });
    try {
      const far = await h.run('rail_activity_near', DETROIT);
      expect(far).toMatch(
        /EOT\/HOT: No EOT\/HOT receiver near this point: Pulse's EOT\/HOT receiver \(EOT\/HOT telemetry \(traintap\), covering Elsewhere County\) is not listed for this point/,
      );
      expect(far).not.toMatch(/EOT\/HOT: Listening and quiet|really is quiet/);

      const farBusy = await h.run('rail_activity_near', { ...DETROIT, since_minutes: 60 });
      expect(farBusy).toMatch(/0 EOT\/HOT packet\(s\) \(2 ignored: /);
      expect(farBusy).toMatch(/EOT\/HOT: No EOT\/HOT receiver near this point: /);
      expect(farBusy).not.toMatch(/Activity found/);
      expect(farBusy).toMatch(/"eot_hot_not_near_point"/);

      // Listed for the point, but this Pulse sends no verdicts: heard, never placed there.
      const near = await h.run('rail_activity_near', { ...BELLE_ISLE, since_minutes: 60 });
      expect(near).toMatch(
        /EOT\/HOT: Heard but not placed at this point: 2 EOT\/HOT packets from EOT\/HOT telemetry \(traintap\) in the last 60 min\./,
      );
      expect(near).not.toMatch(/Activity found/);
      const nearQuiet = await h.run('rail_activity_near', BELLE_ISLE);
      expect(nearQuiet).toMatch(/EOT\/HOT: Can't confirm quiet: EOT\/HOT receiver online now/);
      expect(nearQuiet).not.toMatch(/Listening and quiet|really is quiet/);
    } finally {
      await h.close();
    }
  });

  it('rail voice: no identified line + a receiver online elsewhere is not "quiet"', async () => {
    // Open water in Lake Huron: no named track anywhere near it in the rail datasets.
    const lake = { lat: DETROIT.lat + 2.5, lon: DETROIT.lon + 0.6 };
    expect(railIndex.tracksNear(lake.lat, lake.lon)).toEqual([]);
    const h = await harness({
      feeds: () => ({
        generated_at: iso(0),
        feeds: [ZULU],
        coverage_summary: {
          rail_radio: 'listening',
          eot: 'not_configured',
          public_safety: 'not_configured',
        },
      }),
      // Pulse's own lookup: covered false, no channel for this point.
      rail: quietRail(false),
      incidents: noIncidents,
    });
    try {
      const t = await h.run('rail_activity_near', lake);
      expect(t).toMatch(
        /Rail radio: No rail radio receiver for this point: no rail line identified here/,
      );
      expect(t).toMatch(/channels cover CN Zulu Subdivision/);
      expect(t).not.toMatch(/Listening and quiet|really is quiet/);
      const w = text(await h.client.callTool({ name: 'whats_happening_here', arguments: lake }));
      expect(w).toMatch(/no rail line identified here/);
      expect(w).not.toMatch(/rail radio receiver online/);
    } finally {
      await h.close();
    }
  });

  it("rail voice: Pulse's covered:false for the point is respected on v1.1", async () => {
    const h = await harness({
      feeds: () => ({
        generated_at: iso(0),
        feeds: [
          {
            ...ZULU,
            feed_id: 'line_road',
            name: 'Line road',
            coverage: { lines: [{ name: split.narn, aliases: [split.fra] }] },
          },
        ],
        coverage_summary: {
          rail_radio: 'listening',
          eot: 'not_configured',
          public_safety: 'not_configured',
        },
      }),
      rail: () => ({
        generated_at: iso(0),
        coverage: {
          covered: false,
          channels: [{ channel: 'Line road', kind: 'road', receiver_state: 'not_installed' }],
        },
        transcripts: [],
        detector_readouts: [],
        eot_hot: [],
        reason_labels: [],
      }),
    });
    try {
      const t = await h.run('rail_activity_near', { lat: split.lat, lon: split.lon });
      expect(t).toMatch(/Rail radio: No rail radio receiver confirmed on this line \(/);
      expect(t).toMatch(/covered: false/);
      expect(t).not.toMatch(/Listening and quiet|really is quiet/);
    } finally {
      await h.close();
    }
  });

  it('rail voice: a feed on the line that Pulse did not list (search) for the point is not "quiet"', async () => {
    // feeds/status: 'Line road' online, its coverage line the track at the point, and an EOT
    // receiver online. Pulse's rail/activity lists only the EOT channel for the point, so
    // covered is true because of it, and it never searched Line road's transcripts here.
    const lineRoad = {
      ...ZULU,
      feed_id: 'line_road',
      name: 'Line road',
      coverage: { lines: [{ name: split.narn, aliases: [split.fra] }] },
    };
    const eotOnline = {
      feed_id: 'eot_hot',
      name: EOT_NAME,
      category: 'rail',
      enabled: true,
      state: 'up',
      chunks_last_hour: 9,
      source: 'sdr:traintap',
      receiver: { state: 'online', last_seen_at: iso(5_000), device: 'traintap' },
      coverage: { area: 'Elsewhere County', radius_km: 25 },
    };
    const answer = (channels: unknown[]) => () => ({
      generated_at: iso(0),
      coverage: { covered: true, channels },
      transcripts: [],
      detector_readouts: [],
      eot_hot: [],
      reason_labels: [],
    });
    const eotChannel = { channel: EOT_NAME, kind: 'eot', receiver_state: 'online' };
    const feeds = () => ({
      generated_at: iso(0),
      feeds: [lineRoad, eotOnline],
      coverage_summary: {
        rail_radio: 'listening',
        eot: 'listening',
        public_safety: 'not_configured',
      },
    });
    const h = await harness({ feeds, rail: answer([eotChannel]), incidents: noIncidents });
    try {
      const t = await h.run('rail_activity_near', { lat: split.lat, lon: split.lon });
      expect(t).toMatch(
        /Rail radio: No rail radio receiver confirmed on this line \(.*\): Pulse's own lookup for this point did not list Line road among its rail voice channels, so it was not searched here/,
      );
      expect(t).not.toMatch(/Rail radio: Listening and quiet/);
      expect(t).toMatch(/"not_searched"/);
      // EOT/HOT is judged on its own channel (online now, not proven quiet).
      expect(t).toMatch(/EOT\/HOT: Can't confirm quiet: EOT\/HOT receiver online now/);
      const w = text(
        await h.client.callTool({
          name: 'whats_happening_here',
          arguments: { lat: split.lat, lon: split.lon },
        }),
      );
      expect(w).toMatch(/did not list Line road among its rail voice channels/);
      expect(w).not.toMatch(/rail radio receiver online \(Line road\)/);
    } finally {
      await h.close();
    }
    // Listed, but its receiver never reported per rail/activity (covered is true only because
    // of the EOT receiver): not quiet either, whatever feeds/status says.
    const h2 = await harness({
      feeds,
      rail: answer([
        { channel: 'Line road', kind: 'road', receiver_state: 'not_installed' },
        eotChannel,
      ]),
    });
    try {
      const t = await h2.run('rail_activity_near', { lat: split.lat, lon: split.lon });
      expect(t).toMatch(/Rail radio: No rail radio receiver confirmed on this line \(/);
      expect(t).not.toMatch(/Rail radio: Listening and quiet/);
      expect(t).toMatch(/EOT\/HOT: Can't confirm quiet: EOT\/HOT receiver online now/);
    } finally {
      await h2.close();
    }
  });
});

describe("Pulse v1.2 verdicts: quiet only on Pulse's proof, relayed in plain words", () => {
  const EOT_NAME = 'EOT/HOT telemetry (traintap)';
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const QUIET_VOICE =
    'every rail voice channel that covers this point was listened to for the whole window (receiver and ingest heartbeats) and nothing was heard';
  const QUIET_EOT =
    'every EOT/HOT channel that covers this point was listened to for the whole window (receiver and ingest heartbeats) and nothing was heard';
  const ZERO = { transcripts: 0, detector_readouts: 0, recordings_without_text: 0, eot_packets: 0 };
  const lineRoad = (over: Record<string, unknown> = {}) => ({
    feed_id: 'line_road',
    name: 'Line road',
    category: 'rail',
    enabled: true,
    state: 'up',
    chunks_last_hour: 1,
    source: 'sdr:rtl_airband',
    receiver: { state: 'online', last_seen_at: iso(5_000) },
    coverage: { lines: [{ name: split.narn, aliases: [split.fra] }] },
    ...over,
  });
  /** The live layout: an EOT/HOT receiver that hears 3 km around itself. */
  const eotFeed = {
    feed_id: 'eot_hot',
    name: EOT_NAME,
    category: 'rail',
    enabled: true,
    state: 'up',
    chunks_last_hour: 9,
    source: 'sdr:traintap',
    receiver: { state: 'online', last_seen_at: iso(5_000), device: 'traintap' },
    coverage: { area: 'Alpha area', radius_km: 3 },
  };
  const feedsOf = (feeds: unknown[]) => () => ({
    generated_at: iso(0),
    feeds,
    coverage_summary: {
      rail_radio: 'listening',
      eot: 'listening',
      public_safety: 'not_configured',
    },
  });
  /** One kind's verdict as api/rail_verdicts.py builds it, its window from the query. */
  const verdict =
    (feed_id: string, reason: string, over: Record<string, unknown> = {}) =>
    (q: URLSearchParams) => {
      const min = Number(q.get('since_minutes') ?? 30);
      const since = iso((min + 15) * 60_000);
      return {
        state: 'quiet',
        reasons: [reason],
        window_start: iso(min * 60_000),
        window_end: iso(0),
        listening_since: since,
        counts: ZERO,
        channels: [
          { feed_id, receiver_state: 'online', listening_since: since, covers_point: true },
        ],
        ...over,
      };
    };
  const quietVoice = verdict('line_road', QUIET_VOICE);
  const quietEot = verdict('eot_hot', QUIET_EOT);
  const ROAD_CH = { channel: 'Line road', kind: 'road', receiver_state: 'online' };
  const EOT_CH = { channel: EOT_NAME, kind: 'eot', receiver_state: 'online' };
  /** A v1.2 rail/activity answer: Pulse's verdicts plus the lists and coverage they sum up. */
  const v12 =
    (
      voice: (q: URLSearchParams) => unknown = quietVoice,
      eot: (q: URLSearchParams) => unknown = quietEot,
      extra: Record<string, unknown> = {},
    ) =>
    (q: URLSearchParams) => ({
      generated_at: iso(0),
      coverage: { covered: true, channels: [ROAD_CH, EOT_CH] },
      transcripts: [],
      detector_readouts: [],
      eot_hot: [],
      reason_labels: [],
      verdicts: { rail_voice: voice(q), eot: eot(q) },
      ...extra,
    });
  const point = () => ({ lat: split.lat, lon: split.lon });
  const whats = async (h: Awaited<ReturnType<typeof harness>>) =>
    text(await h.client.callTool({ name: 'whats_happening_here', arguments: point() }));

  const PROVEN_NOTE =
    'The rail voice receiver is online and nothing was heard on these channels in the window: they were quiet.';
  const withNote = (note: string) => ({
    coverage: { covered: true, channels: [ROAD_CH, EOT_CH], note },
  });

  it("relays Pulse's quiet with its window, listening-since time and channels", async () => {
    const h = await harness({
      feeds: feedsOf([lineRoad(), eotFeed]),
      rail: v12(quietVoice, quietEot, withNote(PROVEN_NOTE)),
      incidents: noIncidents,
    });
    try {
      const t = await h.run('rail_activity_near', point());
      expect(t).toMatch(
        /0 rail transmission\(s\), 0 detector readout\(s\), 0 recording\(s\) without text \(not transcribed yet, failed or no speech\), 0 EOT\/HOT packet\(s\) in the last 30 min on the channels that cover this point\./,
      );
      expect(t).toMatch(
        new RegExp(
          `Rail radio: Listening and quiet on this line \\(.*\\), per Pulse's verdict for \\S+ to \\S+: ${esc(QUIET_VOICE)}; listening since \\S+ \\(Line road\\)\\. So it really is quiet\\.`,
        ),
      );
      expect(t).toMatch(
        new RegExp(
          `EOT/HOT: Listening and quiet near this point, per Pulse's verdict for \\S+ to \\S+: ${esc(QUIET_EOT)}; listening since \\S+ \\(${esc(EOT_NAME)}\\)\\. So it really is quiet\\.`,
        ),
      );
      expect(t).toMatch(/"basis":"pulse_verdict"/);
      // Pulse's note agrees with a quiet that is relayed: kept.
      expect(t).toContain(PROVEN_NOTE);
      const w = await whats(h);
      expect(w).toMatch(
        /- Rail radio \(Pulse\): .*Rail radio: Listening and quiet on this line \(.*\), per Pulse's verdict .*EOT\/HOT: Listening and quiet near this point, per Pulse's verdict .*So it really is quiet\./,
      );
    } finally {
      await h.close();
    }
  });

  it('no proof for the whole window is never quiet, whatever feeds/status says (receiver back, ingest down, wrong frequency)', async () => {
    let voice: (q: URLSearchParams) => unknown = quietVoice;
    // A partly proven point: Pulse's note calls the proven channel quiet, its verdict is unknown.
    const partial =
      'The rail voice receiver is online for 1 of 2 channels on this line (Line road) and nothing was heard on it in the window: that channel was quiet. Not covered: 1 channel with no receiver.';
    const h = await harness({
      feeds: feedsOf([lineRoad(), eotFeed]),
      rail: (q) => v12(voice, quietEot, withNote(partial))(q),
      incidents: noIncidents,
    });
    const back = iso(10 * 60_000);
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [
        {
          state: 'unknown',
          reasons: [`line_road: receiver listening only since ${back}, after the window start`],
          listening_since: back,
          channels: [
            {
              feed_id: 'line_road',
              receiver_state: 'online',
              listening_since: back,
              covers_point: true,
            },
          ],
        },
        /Rail radio: Can't confirm quiet on this line \(.*\), per Pulse's verdict: line_road: receiver listening only since \S+, after the window start\. Hearing nothing here means no proof, not a quiet line\./,
      ],
      [
        {
          state: 'unknown',
          reasons: [`ingest (sdr_files) has no current heartbeat (its last beat was at ${back})`],
        },
        /Rail radio: Can't confirm quiet on this line \(.*\), per Pulse's verdict: ingest \(sdr_files\) has no current heartbeat \(its last beat was at \S+\)\./,
      ],
      // A channel renamed with the old id kept disabled, and the receiver config not re-rendered:
      // the receiver files the frequency under the old id, whose recordings are dropped.
      [
        {
          state: 'unknown',
          reasons: [
            'line_road: the receiver files 160.98 MHz under line_road_old, a disabled channel, so those recordings are dropped (re-render rail.local.conf)',
            `recordings of the disabled channel line_road_old in the window (the newest at ${back}) were not ingested: a receiver still records it (re-render rail.local.conf)`,
          ],
          channels: [{ feed_id: 'line_road', receiver_state: 'not_installed', covers_point: true }],
        },
        /Rail radio: Can't confirm quiet on this line \(.*\), per Pulse's verdict: line_road: the receiver files 160\.98 MHz under line_road_old, a disabled channel, so those recordings are dropped \(re-render rail\.local\.conf\); recordings of the disabled channel line_road_old in the window \(the newest at \S+\) were not ingested: a receiver still records it \(re-render rail\.local\.conf\)\. Hearing nothing here means no proof, not a quiet line\./,
      ],
      [
        {
          state: 'not_covered',
          reasons: [
            'no receiver listened to the rail voice channels that cover this point in the window',
            'line_road: the receiver reports this channel on 161.4 MHz, not the configured 160.5 MHz',
          ],
          channels: [{ feed_id: 'line_road', receiver_state: 'offline', covers_point: true }],
        },
        /Rail radio: No coverage on this line \(.*\), per Pulse's verdict: no receiver listened to the rail voice channels that cover this point in the window; line_road: the receiver reports this channel on 161\.4 MHz, not the configured 160\.5 MHz\. Hearing nothing here means no coverage, not a quiet line\./,
      ],
    ];
    try {
      for (const [over, want] of cases) {
        voice = verdict('line_road', 'x', over);
        const t = await h.run('rail_activity_near', point());
        expect(t).toMatch(want);
        expect(t).not.toMatch(/Rail radio: Listening and quiet|rail radio receiver online/);
        // ...and Pulse's sentence calling a channel quiet is withheld from the data.
        expect(t).not.toMatch(/that channel was quiet/);
        expect(t).toMatch(
          /Not covered: 1 channel with no receiver\. \(The gateway withheld Pulse's sentence calling channels quiet/,
        );
        // EOT/HOT has its own proof and stays quiet.
        expect(t).toMatch(/EOT\/HOT: Listening and quiet near this point, per Pulse's verdict/);
      }
      voice = verdict('line_road', 'x', cases[0]![0]);
      const w = await whats(h);
      expect(w).toMatch(
        /Rail radio: Can't confirm quiet on this line .*receiver listening only since/,
      );
      expect(w).not.toMatch(/Rail radio: Listening and quiet/);
    } finally {
      await h.close();
    }
  });

  it("quiet up to Pulse's newest heartbeats, which trail its answer: relayed with that window", async () => {
    // Pulse ends a quiet where its proof ends: the ingest stage's newest beat and the covering
    // receivers' newest heartbeats (seconds for rail voice, up to 105 s for traintap's minute).
    const upTo = (feed_id: string, noun: string, lag: () => number) => (q: URLSearchParams) => {
      const end = iso(lag() * 1000);
      return verdict(
        feed_id,
        `every ${noun} channel that covers this point was listened to for the whole window, up to ${end} (${lag()} s before this answer: Pulse's newest receiver and ingest heartbeats), and nothing was heard`,
        { window_end: end },
      )(q);
    };
    let eotLag = 95;
    const h = await harness({
      feeds: feedsOf([lineRoad(), eotFeed]),
      rail: (q) =>
        v12(
          upTo('line_road', 'rail voice', () => 12),
          upTo('eot_hot', 'EOT/HOT', () => eotLag),
        )(q),
      incidents: noIncidents,
    });
    try {
      for (const t of [await h.run('rail_activity_near', point()), await whats(h)]) {
        expect(t).toMatch(
          /Rail radio: Listening and quiet on this line \(.*\), per Pulse's verdict for \S+ to \S+: every rail voice channel that covers this point was listened to for the whole window, up to \S+ \(12 s before this answer: Pulse's newest receiver and ingest heartbeats\), and nothing was heard; listening since \S+ \(Line road\)\. So it really is quiet\./,
        );
        expect(t).toMatch(
          /EOT\/HOT: Listening and quiet near this point, per Pulse's verdict for \S+ to \S+: every EOT\/HOT channel that covers this point was listened to for the whole window, up to \S+ \(95 s before this answer: Pulse's newest receiver and ingest heartbeats\), and nothing was heard; listening since \S+ \(EOT\/HOT telemetry \(traintap\)\)\. So it really is quiet\./,
        );
      }
      // A proof that ends more than 2 min before the answer is not a quiet for the window asked.
      eotLag = 150;
      const t = await h.run('rail_activity_near', point());
      expect(t).toMatch(
        /EOT\/HOT: Can't confirm quiet near this point: Pulse's verdict was quiet, but the gateway's own check disagrees: Pulse's window \(\S+ to \S+\) is shorter than the 30 min asked by more than 2 min\./,
      );
      expect(t).toMatch(/Rail radio: Listening and quiet on this line/);
    } finally {
      await h.close();
    }
  });

  it("EOT/HOT beyond its receiver's own radius: not covered, never quiet or activity", async () => {
    const h = await harness({
      feeds: feedsOf([lineRoad(), eotFeed]),
      rail: (q) => ({
        ...v12(quietVoice, () => ({
          state: 'not_covered',
          reasons: ['no EOT/HOT channel covers this point'],
          window_start: iso(30 * 60_000),
          window_end: iso(0),
          counts: ZERO,
          channels: [{ feed_id: 'eot_hot', receiver_state: 'online', covers_point: false }],
        }))(q),
        coverage: { covered: true, channels: [ROAD_CH] },
      }),
      incidents: noIncidents,
    });
    try {
      for (const t of [await h.run('rail_activity_near', point()), await whats(h)]) {
        expect(t).toMatch(
          /EOT\/HOT: No coverage near this point, per Pulse's verdict: no EOT\/HOT channel covers this point\. Hearing nothing here means no coverage, not a quiet line\./,
        );
        expect(t).not.toMatch(/EOT\/HOT: (Listening and quiet|Activity found)/);
      }
    } finally {
      await h.close();
    }
  });

  it("recordings without text are activity, with Pulse's counts", async () => {
    const counts = { ...ZERO, recordings_without_text: 3 };
    const h = await harness({
      feeds: feedsOf([lineRoad(), eotFeed]),
      rail: v12(
        verdict('line_road', 'heard on channels that cover this point: 3 recordings without text', {
          state: 'activity',
          counts,
        }),
        quietEot,
        {
          coverage: {
            covered: true,
            channels: [ROAD_CH, EOT_CH],
            recordings_without_text: { pending: 3, error: 0, no_speech: 0 },
          },
        },
      ),
      incidents: noIncidents,
    });
    try {
      for (const t of [await h.run('rail_activity_near', point()), await whats(h)]) {
        expect(t).toMatch(
          /0 rail transmission\(s\), 0 detector readout\(s\), 3 recording\(s\) without text/,
        );
        expect(t).toMatch(
          /Rail radio: Activity found on this line \(.*\), per Pulse's verdict: heard on channels that cover this point: 3 recordings without text \(Line road\)\./,
        );
        expect(t).not.toMatch(/Rail radio: Listening and quiet/);
      }
    } finally {
      await h.close();
    }
  });

  it("restarts the heartbeat can't show, a receiver with no start marker and a dead recorder (Pulse 3fec976): can't confirm, with Pulse's reasons whole", async () => {
    // The live layout: 11 rail voice channels on one rtl_airband receiver, all covering the point,
    // and the traintap EOT/HOT channel. The reasons are Pulse's own strings (api/rail_verdicts.py
    // and the squelch check in api/routes/v1.py), the note Pulse's for a point it can't vouch for.
    const ids = Array.from({ length: 11 }, (_, i) => `line_rd${String(i + 1).padStart(2, '0')}`);
    const roads = ids.map((id, i) => lineRoad({ feed_id: id, name: `Line road ${i + 1}` }));
    const all = ids.join(', ');
    const OFF =
      "(rtl_airband may have turned that channel's recordings off after a failed write: check its log)";
    const squelch = (id: string, n: number, dropped = 0) =>
      `the receiver opened squelch ${n} times on ${id} in the window${dropped ? ` (not counting ${dropped} times it dropped as too short)` : ''} but no recording reached Pulse ${OFF}`;
    const noMarker = (rx: string) =>
      `the receiver writes no start marker (${rx}.started), so a restart in the window can't be ruled out`;
    const restartVoice = iso(585_000);
    const restartEot = iso(510_000);
    const upSince = iso(2 * 3600_000);
    const eotEnd = iso(60_000);
    type Case = { reasons: string[]; ids: string[]; since?: string; quiet?: boolean };
    const answer = (c: Case) =>
      c.quiet
        ? verdict('eot_hot', c.reasons[0]!, { window_end: eotEnd, listening_since: c.since })
        : verdict('x', 'x', {
            state: 'unknown',
            reasons: c.reasons,
            listening_since: c.since,
            channels: c.ids.map((feed_id) => ({
              feed_id,
              receiver_state: 'online',
              ...(c.since ? { listening_since: c.since } : {}),
              covers_point: true,
            })),
          });
    const scenarios: Record<string, { voice: Case; eot: Case }> = {
      // Pulse 3fec976 before the SDR containers are recreated: neither receiver writes a marker.
      no_marker: {
        voice: { reasons: [`${all}: ${noMarker('rail-airband')}`], ids },
        eot: { reasons: [`eot_hot: ${noMarker('traintap-eot')}`], ids: ['eot_hot'] },
      },
      // rtl_airband restarted with every counter at 0, traintap inside its 105 s gap: the start
      // markers show both restarts.
      restart: {
        voice: {
          reasons: [
            `${all}: receiver listening only since ${restartVoice}, after the window start`,
          ],
          ids,
          since: restartVoice,
        },
        eot: {
          reasons: [`eot_hot: receiver listening only since ${restartEot}, after the window start`],
          ids: ['eot_hot'],
          since: restartEot,
        },
      },
      // rtl_airband turned its file outputs off after a failed write and kept demodulating.
      recorder_dead: {
        voice: {
          reasons: [
            squelch('line_rd01', 5),
            squelch('line_rd02', 9, 3),
            squelch('line_rd03', 2),
            squelch('line_rd05', 6, 2),
          ],
          ids,
          since: upSince,
        },
        eot: {
          reasons: [
            `every EOT/HOT channel that covers this point was listened to for the whole window, up to ${eotEnd} (60 s before this answer: Pulse's newest receiver and ingest heartbeats), and nothing was heard`,
          ],
          ids: ['eot_hot'],
          since: upSince,
          quiet: true,
        },
      },
    };
    let now = scenarios.no_marker!;
    const h = await harness({
      feeds: feedsOf([...roads, eotFeed]),
      rail: (q) => ({
        ...v12(answer(now.voice), answer(now.eot))(q),
        coverage: {
          covered: true,
          channels: [
            ...roads.map((r) => ({ channel: r.name, kind: 'road', receiver_state: 'online' })),
            EOT_CH,
          ],
          note: "The rail voice receiver is online now, but Pulse can't vouch for these channels across the whole window (see `verdicts.rail_voice.reasons`): no transcripts here means no proof, not a quiet line.",
        },
      }),
      incidents: noIncidents,
    });
    /** coverage_check.<kind>.reasons in run_tool's JSON. */
    const reasonsOf = (t: string, kind: 'rail_radio' | 'eot') => {
      const m = new RegExp(
        `"${kind}":\\{"kind":"${kind}","basis":"pulse_verdict",[^{]*?"reasons":(\\[.*?\\]),"feeds"`,
      ).exec(t);
      return m ? (JSON.parse(m[1]!) as string[]) : undefined;
    };
    const NO_PROOF = 'Hearing nothing here means no proof, not a quiet line.';
    try {
      for (const name of ['no_marker', 'restart', 'recorder_dead'] as const) {
        now = scenarios[name]!;
        const [v, e] = [now.voice.reasons, now.eot.reasons];
        const t = await h.run('rail_activity_near', point());
        const w = await whats(h);
        for (const x of [t, w]) {
          expect(x, name).not.toMatch(/Rail radio: Listening and quiet/);
          if (name === 'recorder_dead') {
            // As many whole reasons as fit (the second is longer than the gateway's old cut at
            // 220 characters), the rest counted; EOT/HOT has its own proof and stays quiet.
            expect(x, name).toMatch(
              new RegExp(
                `Rail radio: Can't confirm quiet on this line \\(.*\\), per Pulse's verdict: ${esc(v[0]!)}; ${esc(v[1]!)}; and 2 more \\(see coverage_check\\)\\. ${esc(NO_PROOF)}`,
              ),
            );
            expect(x, name).toMatch(
              new RegExp(
                `EOT/HOT: Listening and quiet near this point, per Pulse's verdict for \\S+ to ${esc(eotEnd.replace(/\.\d+Z$/, 'Z'))}: ${esc(e[0]!)}; listening since \\S+ \\(${esc(EOT_NAME)}\\)\\. So it really is quiet\\.`,
              ),
            );
          } else {
            // One reason, longer than the old cut for the 11 channels: whole.
            expect(x, name).toMatch(
              new RegExp(
                `Rail radio: Can't confirm quiet on this line \\(.*\\), per Pulse's verdict: ${esc(v[0]!)}\\. ${esc(NO_PROOF)}`,
              ),
            );
            expect(x, name).toContain(
              `EOT/HOT: Can't confirm quiet near this point, per Pulse's verdict: ${e[0]}. ${NO_PROOF}`,
            );
            expect(x, name).not.toMatch(/Listening and quiet|really is quiet/);
          }
        }
        // Every reason is in coverage_check, verbatim.
        expect(reasonsOf(t, 'rail_radio'), name).toEqual(v);
        expect(reasonsOf(t, 'eot'), name).toEqual(e);
      }
    } finally {
      await h.close();
    }
  });

  it("downgrades Pulse's quiet when the covering channels hear another line, or feeds/status shows the receiver down", async () => {
    let feeds: unknown[] = [
      lineRoad({
        feed_id: 'cn_zulu_road',
        name: 'CN Zulu road',
        coverage: { lines: [{ railroad: 'CN', name: 'Zulu Subdivision', aliases: [] }] },
      }),
    ];
    const voice = verdict('cn_zulu_road', QUIET_VOICE);
    const h = await harness({
      feeds: () => feedsOf(feeds)(),
      rail: (q) => ({
        ...v12(voice)(q),
        coverage: {
          covered: true,
          channels: [{ channel: 'CN Zulu road', kind: 'road', receiver_state: 'online' }, EOT_CH],
        },
      }),
      incidents: noIncidents,
    });
    try {
      for (const t of [await h.run('rail_activity_near', point()), await whats(h)]) {
        expect(t).toMatch(
          /Rail radio: Can't confirm quiet on this line \(.*\): Pulse's verdict was quiet, but the gateway's own check disagrees: the channels that cover this point hear CN Zulu Subdivision, and none of those is the track identified here\. Hearing nothing here means no proof, not a quiet line\./,
        );
        expect(t).not.toMatch(/Rail radio: Listening and quiet/);
      }
      expect(await h.run('rail_activity_near', point())).toMatch(/"pulse_state":"quiet","reasons"/);
    } finally {
      await h.close();
    }
    // The line matches, but Pulse's feed status (read a few seconds apart) has the receiver
    // offline. A fresh harness: feeds/status is cached for 10 s.
    feeds = [lineRoad({ receiver: { state: 'offline', last_seen_at: iso(400_000) } }), eotFeed];
    const h2 = await harness({
      feeds: () => feedsOf(feeds)(),
      rail: v12(quietVoice),
      incidents: noIncidents,
    });
    try {
      const t = await h2.run('rail_activity_near', point());
      expect(t).toMatch(
        /Rail radio: Can't confirm quiet on this line \(.*\): Pulse's verdict was quiet, but the gateway's own check disagrees: Pulse's feed status says Line road's receiver is offline\./,
      );
    } finally {
      await h2.close();
    }
  });

  it('only the caller narrows the channels by railroad', async () => {
    const rr = railIndex.tracksNear(split.lat, split.lon)[0]?.railroads[0];
    expect(rr).toBeTruthy();
    const h = await harness({
      feeds: feedsOf([
        lineRoad({
          coverage: { lines: [{ railroad: rr, name: split.narn, aliases: [split.fra] }] },
        }),
        eotFeed,
      ]),
      rail: v12(),
      incidents: noIncidents,
    });
    try {
      await whats(h);
      const asked = h.mock.urls.filter((u) => u.pathname === '/v1/rail/activity');
      expect(asked.at(-1)!.searchParams.get('railroad')).toBeNull();
      const t = await h.run('rail_activity_near', { ...point(), railroad: 'CSX' });
      expect(h.mock.urls.at(-1)!.searchParams.get('railroad')).toBe('CSX');
      expect(t).toMatch(/Rail radio \(CSX channels only, as asked\): /);
    } finally {
      await h.close();
    }
  });

  it('a verdicts block without a usable verdict for a kind is not quiet', async () => {
    const h = await harness({
      feeds: feedsOf([lineRoad(), eotFeed]),
      rail: v12(quietVoice, () => ({ state: 'probably_quiet' })),
    });
    try {
      const t = await h.run('rail_activity_near', point());
      expect(t).toMatch(/Rail radio: Listening and quiet on this line/);
      expect(t).toMatch(
        /EOT\/HOT: Can't confirm quiet near this point: Pulse sent no usable verdict for EOT\/HOT\./,
      );
    } finally {
      await h.close();
    }
  });
});

describe('a Pulse without verdicts never says quiet', () => {
  const lineRoad = () => ({
    feed_id: 'line_road',
    name: 'Line road',
    category: 'rail',
    enabled: true,
    state: 'up',
    chunks_last_hour: 1,
    source: 'sdr:rtl_airband',
    receiver: { state: 'online', last_seen_at: iso(5_000) },
    coverage: { lines: [{ name: split.narn, aliases: [split.fra] }] },
  });
  const EOT_NAME = 'EOT/HOT telemetry (traintap)';
  const feeds = () => ({
    generated_at: iso(0),
    feeds: [
      lineRoad(),
      {
        feed_id: 'eot_hot',
        name: EOT_NAME,
        category: 'rail',
        enabled: true,
        state: 'up',
        chunks_last_hour: 9,
        source: 'sdr:traintap',
        receiver: { state: 'online', last_seen_at: iso(5_000), device: 'traintap' },
        coverage: { area: 'Alpha area', radius_km: 3 },
      },
    ],
    coverage_summary: {
      rail_radio: 'listening',
      eot: 'listening',
      public_safety: 'not_configured',
    },
  });
  /** A v1.1 / 888cb0a-era answer: the channels listed for the point, no verdicts. */
  const old =
    (over: Record<string, unknown> = {}, packets = 0) =>
    () => ({
      generated_at: iso(0),
      coverage: {
        covered: true,
        channels: [
          { channel: 'Line road', kind: 'road', receiver_state: 'online' },
          { channel: EOT_NAME, kind: 'eot', receiver_state: 'online' },
        ],
        note: 'The receiver is online and nothing was heard on these channels in the window: they were quiet.',
        ...over,
      },
      transcripts: [],
      detector_readouts: [],
      eot_hot: Array.from({ length: packets }, (_, i) => ({
        ts: iso(60_000 * (i + 1)),
        device: 'EOT',
        unit_id: '12345',
      })),
      reason_labels: [],
    });
  const point = () => ({ lat: split.lat, lon: split.lon });

  it('online now, nothing heard: "can\'t confirm", for both kinds and in whats_happening_here', async () => {
    const h = await harness({ feeds, rail: old(), incidents: noIncidents });
    try {
      const t = await h.run('rail_activity_near', point());
      expect(t).toMatch(
        /Rail radio: Can't confirm quiet: rail radio receiver online now \(Line road\) and 0 rail messages on this line \(.*\) in the last 30 min, but this Pulse sends no verdicts \(contract v1\.2\)/,
      );
      expect(t).toMatch(/EOT\/HOT: Can't confirm quiet: EOT\/HOT receiver online now/);
      expect(t).not.toMatch(/Listening and quiet|really is quiet|they were quiet/);
      expect(t).toMatch(/"basis":"gateway_without_verdicts"/);
      const w = text(await h.client.callTool({ name: 'whats_happening_here', arguments: point() }));
      expect(w).toMatch(
        /Rail radio: Can't confirm quiet: rail radio receiver online now \(Line road\)/,
      );
      expect(w).not.toMatch(/Listening and quiet|really is quiet/);
    } finally {
      await h.close();
    }
  });

  it('the live layout (11 voice channels on one receiver, and EOT/HOT): a restart or a dead recorder such a Pulse cannot show is never quiet', async () => {
    // Without verdicts nothing shows a restart inside the window or squelch openings that never
    // became recordings: receivers online now, nothing heard, and Pulse's note says quiet.
    const roads = Array.from({ length: 11 }, (_, i) => ({
      ...lineRoad(),
      feed_id: `line_rd${String(i + 1).padStart(2, '0')}`,
      name: `Line road ${i + 1}`,
    }));
    const base = feeds();
    const h = await harness({
      feeds: () => ({ ...base, feeds: [...roads, base.feeds[1]] }),
      rail: old({
        channels: [
          ...roads.map((r) => ({ channel: r.name, kind: 'road', receiver_state: 'online' })),
          { channel: EOT_NAME, kind: 'eot', receiver_state: 'online' },
        ],
      }),
      incidents: noIncidents,
    });
    try {
      const t = await h.run('rail_activity_near', point());
      const w = text(await h.client.callTool({ name: 'whats_happening_here', arguments: point() }));
      for (const x of [t, w]) {
        expect(x).toMatch(
          /Rail radio: Can't confirm quiet: rail radio receiver online now \(Line road 1, Line road 2, Line road 3 and 8 more\) and 0 rail messages on this line \(.*\) in the last 30 min, but this Pulse sends no verdicts \(contract v1\.2\), so nothing shows the receiver and the ingest stage were up for the whole window\. 0 rail messages means no proof, not a quiet line\./,
        );
        expect(x).toMatch(
          /EOT\/HOT: Can't confirm quiet: EOT\/HOT receiver online now \(EOT\/HOT telemetry \(traintap\)\) and 0 EOT\/HOT packets near this point in the last 30 min, but this Pulse sends no verdicts/,
        );
        expect(x).not.toMatch(/Listening and quiet|really is quiet|they were quiet/);
      }
    } finally {
      await h.close();
    }
  });

  it('reads coverage.recordings_without_text as traffic (888cb0a era)', async () => {
    const h = await harness({
      feeds,
      rail: old({
        recordings_without_text: { pending: 3, error: 1, no_speech: 1 },
        note: 'Recorded on this line in the window but not in `transcripts`: 3 recordings not transcribed yet. That is radio traffic, not a quiet line.',
      }),
      incidents: noIncidents,
    });
    try {
      const t = await h.run('rail_activity_near', point());
      const w = text(await h.client.callTool({ name: 'whats_happening_here', arguments: point() }));
      for (const x of [t, w]) {
        expect(x).toMatch(
          /0 rail transmission\(s\), 0 detector readout\(s\), 5 recording\(s\) without text \(3 not transcribed yet, 1 failed, 1 no speech\)/,
        );
        expect(x).toMatch(
          /Rail radio: Activity found: 5 rail messages on this line \(.*\) \(Line road\)\./,
        );
        expect(x).not.toMatch(/Rail radio: (Listening and quiet|Can't confirm)/);
      }
    } finally {
      await h.close();
    }
  });

  it('EOT/HOT packets from a receiver listed by the old fixed 25 km rule are heard, never activity at the point', async () => {
    // The receiver hears 3 km around itself; such a Pulse lists it for any point within 25 km.
    const h = await harness({ feeds, rail: old({}, 2), incidents: noIncidents });
    try {
      const t = await h.run('rail_activity_near', point());
      const w = text(await h.client.callTool({ name: 'whats_happening_here', arguments: point() }));
      for (const x of [t, w]) {
        expect(x).toMatch(
          /0 detector readout\(s\), 2 EOT\/HOT packet\(s\) heard but not placed at this point in the last 30 min\./,
        );
        expect(x).toMatch(
          /EOT\/HOT: Heard but not placed at this point: 2 EOT\/HOT packets from EOT\/HOT telemetry \(traintap\) in the last 30 min\. This Pulse sends no verdicts \(contract v1\.2\) and lists an EOT\/HOT receiver for any point within 25 km of it, or for any point at all when its location isn't set, whatever the receiver's own range \(EOT\/HOT telemetry \(traintap\)'s own range is 3 km\), and EOT\/HOT packets carry no position, so this point may be outside the range of the receiver that heard them\. They are not counted as activity at this point\./,
        );
        expect(x).not.toMatch(/EOT\/HOT: Activity found|EOT\/HOT packets? near this point/);
      }
      // The packets are kept, under a name that doesn't place them at the point.
      expect(t).toMatch(/"eot_hot":\[\]/);
      expect(t).toMatch(/"eot_hot_not_placed":\[\{/);
    } finally {
      await h.close();
    }
  });
});
