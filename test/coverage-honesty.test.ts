/**
 * End to end through /mcp: whats_happening_here, rail_activity_near, incidents_near and
 * feeds_status read Pulse's feeds/status and say which situation applies (no receiver for this
 * line/area, receiver offline since T, listening and quiet, activity found, or Pulse too old),
 * ignoring example feeds, and match rail coverage on every name the datasets give a track.
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
import { BELLE_ISLE, DETROIT, MOCK_GEV, waitFor } from './helpers.js';

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
        /No EOT\/HOT receiver installed: EOT\/HOT telemetry \(traintap\) is configured but no receiver has ever reported/,
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
      expect(t).toMatch(
        /Listening and quiet: rail radio receiver online \(Line road\) and 0 rail messages on this line \(/,
      );
      expect(t).toMatch(/so it really is quiet/);
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
  it('listening and quiet for scanner incidents, with the areas Pulse hears', async () => {
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
        /No scanner incidents in range for that window\. Listening and quiet: scanner \(police\/fire\/EMS\) receiver online \(County fire dispatch\) and 0 scanner incidents in this area in the last 120 min/,
      );
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

      const near = await h.run('rail_activity_near', { ...BELLE_ISLE, since_minutes: 60 });
      expect(near).toMatch(
        /EOT\/HOT: Activity found: 2 EOT\/HOT packets near this point \(EOT\/HOT telemetry \(traintap\)\)\./,
      );
      const nearQuiet = await h.run('rail_activity_near', BELLE_ISLE);
      expect(nearQuiet).toMatch(/EOT\/HOT: Listening and quiet: EOT\/HOT receiver online/);
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
      // EOT/HOT is judged on its own channel and stays quiet.
      expect(t).toMatch(/EOT\/HOT: Listening and quiet: EOT\/HOT receiver online/);
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
      expect(t).toMatch(/EOT\/HOT: Listening and quiet: EOT\/HOT receiver online/);
    } finally {
      await h2.close();
    }
  });
});
