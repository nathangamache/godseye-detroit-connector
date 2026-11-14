/**
 * Coverage honesty without Pulse's verdicts (feeds/status receiver + coverage): "0 messages" is
 * reported as one of activity / online now but can't confirm quiet / receiver offline since T /
 * no receiver / Pulse can't say. Never quiet (test/pulse-verdicts.test.ts has the v1.2 path).
 */
import { describe, expect, it } from 'vitest';
import {
  assess,
  feedKind,
  isExampleFeed,
  parseFeedsStatus,
  pulseCoveredFor,
  verdictSentence,
  type FeedsStatus,
} from '../src/pulse/coverage.js';
import type { TrackNames } from '../src/rail/names.js';

const NOW = Date.parse('2026-11-14T12:00:00Z');
const TRACK: TrackNames[] = [
  {
    label: 'nearest track',
    names: [
      { dataset: 'NARN', name: 'BRAVO (CSXT)' },
      { dataset: 'FRA', name: 'ALPHA' },
    ],
    railroads: ['CSX Transportation (CSXT)'],
  },
];

const railFeed = (over: Record<string, unknown> = {}) => ({
  feed_id: 'csx_alpha_road',
  name: 'CSX Alpha road',
  category: 'rail',
  enabled: true,
  state: 'down',
  chunks_last_hour: 0,
  source: 'sdr:rtl_airband',
  receiver: { state: 'online', last_seen_at: '2026-11-14T11:59:00Z' },
  coverage: { lines: [{ railroad: 'CSX', name: 'Alpha Subdivision', aliases: [] }] },
  ...over,
});

/** A shipped placeholder rail feed: reported online, never coverage. */
const EXAMPLE_RAIL = railFeed({
  feed_id: 'example_rail_road',
  name: 'Example railroad road channel',
  example: true,
});

const status = (feeds: unknown[], summary?: Record<string, string>): FeedsStatus =>
  parseFeedsStatus({
    generated_at: '2026-11-14T12:00:00Z',
    feeds,
    ...(summary ? { coverage_summary: summary } : {}),
  });

const rail = (s: FeedsStatus | undefined, messages = 0) =>
  assess('rail_radio', s, { messages, window_min: 30, tracks: TRACK });

describe('feeds/status parsing', () => {
  it('keeps contract fields, drops junk, flags examples', () => {
    const s = status([
      railFeed({ receiver: { state: 'bogus' }, extra: 'x'.repeat(10_000) }),
      { feed_id: 'example_rail_road', category: 'rail', enabled: true },
      { feed_id: 'placeholder', category: 'public_safety', example: true },
      { name: 'no id' },
    ]);
    expect(s.feeds.map((f) => f.feed_id)).toEqual([
      'csx_alpha_road',
      'example_rail_road',
      'placeholder',
    ]);
    expect(s.feeds[0]!.receiver).toBeUndefined();
    expect(JSON.stringify(s)).not.toContain('xxxx');
    expect(s.feeds.map(isExampleFeed)).toEqual([false, true, true]);
  });

  it('tells EOT telemetry apart from rail voice', () => {
    expect(feedKind({ feed_id: 'eot_hot', category: 'rail', source: 'sdr:traintap' })).toBe('eot');
    expect(feedKind({ feed_id: 'x', category: 'rail', kind: 'eot' })).toBe('eot');
    expect(feedKind({ feed_id: 'csx_road', category: 'rail', source: 'sdr:rtl_airband' })).toBe(
      'rail_radio',
    );
    expect(feedKind({ feed_id: 'wayne_fire', category: 'public_safety' })).toBe('public_safety');
  });
});

describe('verdicts', () => {
  it('older Pulse (no receiver fields): too old to say', () => {
    const v = rail(status([{ feed_id: 'a', category: 'rail', enabled: true, state: 'up' }]));
    expect(v).toMatchObject({ state: 'unknown', reason: 'pulse_too_old' });
    expect(verdictSentence(v, NOW, 'this line')).toMatch(
      /too old to report its receivers, so 0 rail messages on this line can't be told apart from no receiver/,
    );
  });

  it('feeds/status unavailable: says so', () => {
    expect(verdictSentence(rail(undefined), NOW)).toMatch(/feed status was unavailable/);
  });

  it('only example placeholders: not configured, and they never count', () => {
    const s = status(
      [railFeed({ feed_id: 'example_rail_road' }), railFeed({ feed_id: 'demo', example: true })],
      { rail_radio: 'not_configured', eot: 'not_configured', public_safety: 'not_configured' },
    );
    const v = rail(s);
    expect(v).toMatchObject({ state: 'no_receiver', reason: 'not_configured' });
    expect(verdictSentence(v, NOW)).toMatch(
      /No rail radio receiver installed: Pulse has no rail radio channel set up.*0 rail messages means no coverage, not a quiet line/,
    );
    // Even an "online" example receiver is not coverage.
    expect(
      assess(
        'public_safety',
        status([{ ...railFeed(), feed_id: 'example_fire', category: 'public_safety' }], {}),
        {
          messages: 0,
          window_min: 60,
        },
      ),
    ).toMatchObject({ state: 'no_receiver', reason: 'not_configured' });
  });

  it('channel configured but no receiver ever reported', () => {
    const v = rail(status([railFeed({ receiver: { state: 'not_installed' } })]));
    expect(v).toMatchObject({ state: 'no_receiver', reason: 'never_reported' });
    expect(verdictSentence(v, NOW)).toMatch(
      /No rail radio receiver installed: CSX Alpha road is configured but no receiver has ever reported/,
    );
  });

  it('receiver offline since T', () => {
    const v = rail(
      status([railFeed({ receiver: { state: 'offline', last_seen_at: '2026-11-14T09:00:00Z' } })]),
    );
    expect(v).toMatchObject({ state: 'offline', since: '2026-11-14T09:00:00.000Z' });
    expect(verdictSentence(v, NOW)).toMatch(
      /Rail radio receiver offline since 2026-11-14T09:00:00.000Z \(3 h ago\).*not a quiet line/,
    );
  });

  it('receiver online now is never "quiet" without verdicts; activity found is activity', () => {
    const s = status([railFeed()]);
    const online = rail(s);
    expect(online).toMatchObject({ state: 'unconfirmed', window_min: 30 });
    const t = verdictSentence(online, NOW, 'this line');
    expect(t).toMatch(
      /^Can't confirm quiet: rail radio receiver online now \(CSX Alpha road\) and 0 rail messages on this line in the last 30 min, but this Pulse sends no verdicts \(contract v1\.2\)/,
    );
    expect(t).toMatch(/0 rail messages means no proof, not a quiet line/);
    expect(t).not.toMatch(/Listening and quiet|really is quiet/);
    const busy = rail(s, 3);
    expect(busy).toMatchObject({ state: 'activity', messages: 3 });
    expect(verdictSentence(busy, NOW, 'this line')).toMatch(
      /Activity found: 3 rail messages on this line/,
    );
  });

  it('matches the line on any name or alias, never one string', () => {
    // Pulse knows the line only by the NARN-style name, with a "(CSXT)" suffix in its alias.
    const byAlias = status([
      railFeed({
        coverage: { lines: [{ railroad: 'CSX', name: 'Charlie Sub', aliases: ['Bravo (CSXT)'] }] },
      }),
    ]);
    expect(rail(byAlias).state).toBe('unconfirmed');
    // Same names on another railroad: not this track.
    const otherRr = status([
      railFeed({ coverage: { lines: [{ railroad: 'NS', name: 'Alpha District', aliases: [] }] } }),
    ]);
    expect(rail(otherRr)).toMatchObject({ state: 'no_receiver', reason: 'not_this_line' });
  });

  it('no receiver for this line: names what Pulse does cover', () => {
    const s = status([
      railFeed({
        coverage: { lines: [{ railroad: 'CN', name: 'Delta Subdivision', aliases: [] }] },
      }),
    ]);
    const v = rail(s);
    expect(v).toMatchObject({
      state: 'no_receiver',
      reason: 'not_this_line',
      covered_lines: ['CN Delta Subdivision'],
    });
    expect(verdictSentence(v, NOW, 'this line (NARN: Bravo Sub; FRA: Alpha Sub)')).toMatch(
      /No rail radio receiver for this line \(NARN: Bravo Sub; FRA: Alpha Sub\): Pulse's rail radio channels cover CN Delta Subdivision.*means no coverage/,
    );
    // Pulse's own rail/activity lookup naming the channel ties it to the point (still unproven).
    expect(
      assess('rail_radio', s, {
        messages: 0,
        window_min: 30,
        tracks: TRACK,
        pulseChannels: ['CSX Alpha road'],
      }).state,
    ).toBe('unconfirmed');
  });

  it('EOT/HOT packets are never activity at the point without verdicts: heard, not placed', () => {
    const eot = {
      feed_id: 'eot_hot',
      name: 'EOT/HOT telemetry (traintap)',
      category: 'rail',
      enabled: true,
      source: 'sdr:traintap',
      receiver: { state: 'online', last_seen_at: '2026-11-14T11:59:30Z' },
    };
    const RULE =
      "This Pulse sends no verdicts \\(contract v1\\.2\\) and lists an EOT/HOT receiver for any point within 25 km of it, or for any point at all when its location isn't set, whatever the receiver's own range";
    const TAIL =
      ', and EOT/HOT packets carry no position, so this point may be outside the range of the receiver that heard them\\. They are not counted as activity at this point\\.$';
    // No location set in Pulse.
    const v = assess('eot', status([eot]), { messages: 2, window_min: 30 });
    expect(v).toMatchObject({ state: 'unplaced', messages: 2, window_min: 30 });
    expect(verdictSentence(v, NOW)).toMatch(
      new RegExp(
        `^Heard but not placed at this point: 2 EOT/HOT packets from EOT/HOT telemetry \\(traintap\\) in the last 30 min\\. ${RULE} \\(EOT/HOT telemetry \\(traintap\\)'s location is not set in Pulse\\)${TAIL}`,
      ),
    );
    // A receiver whose own range is shorter than Pulse's fixed 25 km (the live layout).
    for (const pulseChannels of [undefined, ['EOT/HOT telemetry (traintap)']]) {
      const short = assess('eot', status([{ ...eot, coverage: { area: 'A', radius_km: 3 } }]), {
        messages: 1,
        window_min: 30,
        pulseChannels,
      });
      expect(short.state).toBe('unplaced');
      const t = verdictSentence(short, NOW);
      expect(t).toMatch(
        new RegExp(
          `^Heard but not placed at this point: 1 EOT/HOT packet from EOT/HOT telemetry \\(traintap\\) in the last 30 min\\. ${RULE} \\(EOT/HOT telemetry \\(traintap\\)'s own range is 3 km\\)${TAIL}`,
        ),
      );
      expect(t).not.toMatch(/Activity found|near this point/);
    }
    // Even a 25 km receiver: the gateway can't see where it is, so the packets aren't placed.
    const wide = assess('eot', status([{ ...eot, coverage: { radius_km: 25 } }]), {
      messages: 2,
      window_min: 30,
    });
    expect(wide.state).toBe('unplaced');
    expect(verdictSentence(wide, NOW)).toMatch(new RegExp(`${RULE}${TAIL}`));
    // Online now, nothing heard: can't confirm, and the range caveat when feeds/status rules
    // the point out or can't place the receiver.
    const located = assess('eot', status([{ ...eot, coverage: { radius_km: 25 } }]), {
      messages: 0,
      window_min: 30,
    });
    expect(verdictSentence(located, NOW)).toMatch(/^Can't confirm quiet: /);
    expect(verdictSentence(located, NOW)).not.toMatch(/location is not set|own range/);
    const quietShort = assess('eot', status([{ ...eot, coverage: { radius_km: 3 } }]), {
      messages: 0,
      window_min: 30,
    });
    expect(verdictSentence(quietShort, NOW)).toMatch(
      /^Can't confirm quiet: EOT\/HOT receiver online now .* Nor does it show that this point is in the receiver's range: it lists an EOT\/HOT receiver for any point within 25 km of it, .* \(EOT\/HOT telemetry \(traintap\)'s own range is 3 km\)\.$/,
    );
  });

  it('falls back to coverage_summary when no feed of the kind is visible', () => {
    const s = status([], {
      rail_radio: 'not_configured',
      eot: 'no_receiver',
      public_safety: 'listening',
    });
    expect(assess('eot', s, { messages: 0, window_min: 30 })).toMatchObject({
      state: 'no_receiver',
      reason: 'never_reported',
    });
    expect(assess('public_safety', s, { messages: 0, window_min: 60 }).state).toBe('unconfirmed');
  });
});

describe('verdicts are tied to the point', () => {
  const EOT = 'EOT/HOT telemetry (traintap)';
  const eotFeed = (over: Record<string, unknown> = {}) => ({
    feed_id: 'eot_hot',
    name: EOT,
    category: 'rail',
    enabled: true,
    state: 'up',
    chunks_last_hour: 9,
    source: 'sdr:traintap',
    receiver: { state: 'online', last_seen_at: '2026-11-14T11:59:30Z' },
    coverage: { area: 'Elsewhere County', radius_km: 25 },
    ...over,
  });
  const eot = (s: FeedsStatus | undefined, messages: number, pulseChannels?: string[]) =>
    assess('eot', s, { messages, window_min: 30, pulseChannels });

  it('EOT: a located receiver Pulse does not list for this point is not near it', () => {
    const s = status([eotFeed()], { rail_radio: 'not_configured', eot: 'listening' });
    const v = eot(s, 0, []);
    expect(v).toMatchObject({ state: 'no_receiver', reason: 'not_near' });
    const t = verdictSentence(v, NOW);
    expect(t).toMatch(/^No EOT\/HOT receiver near this point: /);
    expect(t).toMatch(/Elsewhere County/);
    expect(t).toMatch(/0 EOT\/HOT packets means no coverage/);
    expect(t).not.toMatch(/quiet: |really is quiet/);
    // Packets Pulse heard elsewhere are not activity here.
    const busy = eot(s, 3, []);
    expect(busy).toMatchObject({ state: 'no_receiver', reason: 'not_near', ignored_messages: 3 });
    expect(verdictSentence(busy, NOW)).not.toMatch(/Activity found/);
    expect(verdictSentence(busy, NOW)).toMatch(/3 EOT\/HOT packets .*not counted/);
  });

  it('EOT: the receiver Pulse lists for this point decides (by name or feed id)', () => {
    const s = status([eotFeed()], { eot: 'listening' });
    expect(eot(s, 0, [EOT]).state).toBe('unconfirmed');
    expect(eot(s, 0, ['EOT_HOT']).state).toBe('unconfirmed');
    expect(eot(s, 2, [EOT])).toMatchObject({ state: 'unplaced', messages: 2 });
    // Only a listed receiver that is offline: offline.
    const off = status([
      eotFeed({ receiver: { state: 'offline', last_seen_at: '2026-11-14T09:00:00Z' } }),
    ]);
    expect(eot(off, 0, [EOT]).state).toBe('offline');
  });

  it('EOT: with one receiver near and one far, packets may come from either', () => {
    const s = status([
      eotFeed(),
      eotFeed({ feed_id: 'eot_far', name: 'Far EOT', coverage: { area: 'Far County' } }),
      eotFeed({ feed_id: 'eot_new', name: 'New EOT', receiver: { state: 'not_installed' } }),
    ]);
    const v = eot(s, 2, [EOT]);
    expect(v).toMatchObject({
      state: 'unplaced',
      messages: 2,
      feeds: [{ feed_id: 'eot_hot' }, { feed_id: 'eot_far' }],
    });
    const t = verdictSentence(v, NOW);
    expect(t).toMatch(
      /^Heard but not placed at this point: 2 EOT\/HOT packets from EOT\/HOT telemetry \(traintap\), Far EOT in the last 30 min\./,
    );
    expect(t).not.toMatch(/Activity found/);
  });

  it('EOT: no listed channel and only a summary saying "listening" is not quiet', () => {
    const s = status([], { eot: 'listening' });
    expect(eot(s, 0, [])).toMatchObject({ state: 'no_receiver', reason: 'not_near' });
    // Feed status unavailable: Pulse's own point lookup still says no EOT channel covers it.
    expect(eot(undefined, 4, [])).toMatchObject({
      state: 'no_receiver',
      reason: 'not_near',
      ignored_messages: 4,
    });
    // Nothing set up at all stays "not configured".
    const none = status([], { eot: 'not_configured' });
    expect(eot(none, 0, [])).toMatchObject({ state: 'no_receiver', reason: 'not_configured' });
  });

  it('rail voice: no line identified and no channel from Pulse is never quiet', () => {
    const s = status([railFeed()], { rail_radio: 'listening' });
    for (const pulseChannels of [undefined, []]) {
      const v = assess('rail_radio', s, { messages: 0, window_min: 30, tracks: [], pulseChannels });
      expect(v).toMatchObject({
        state: 'no_receiver',
        reason: 'no_line',
        covered_lines: ['CSX Alpha Subdivision'],
      });
      const t = verdictSentence(v, NOW);
      expect(t).toMatch(/^No rail radio receiver for this point: no rail line identified here/);
      expect(t).toMatch(/channels cover CSX Alpha Subdivision/);
      expect(t).not.toMatch(/quiet: |really is quiet/);
    }
    // Pulse's summary alone (no visible feed) does not make an unidentified point quiet.
    const summaryOnly = status([], { rail_radio: 'listening' });
    expect(
      assess('rail_radio', summaryOnly, { messages: 0, window_min: 30, tracks: [] }),
    ).toMatchObject({ state: 'no_receiver', reason: 'no_line' });
    // A channel Pulse's lookup names for the point still ties it there without a line.
    expect(
      assess('rail_radio', s, {
        messages: 0,
        window_min: 30,
        tracks: [],
        pulseChannels: ['CSX Alpha road'],
      }).state,
    ).toBe('unconfirmed');
  });

  it("covered:false from Pulse's rail/activity is never quiet", () => {
    const s = status([railFeed(), eotFeed()], { rail_radio: 'listening', eot: 'listening' });
    const v = assess('rail_radio', s, {
      messages: 0,
      window_min: 30,
      tracks: TRACK,
      pulseChannels: ['CSX Alpha road'],
      pulseCovered: false,
    });
    expect(v).toMatchObject({ state: 'no_receiver', reason: 'pulse_not_covered' });
    const t = verdictSentence(v, NOW, 'this line');
    expect(t).toMatch(/^No rail radio receiver confirmed on this line: /);
    expect(t).not.toMatch(/quiet: |really is quiet/);
    expect(
      assess('eot', s, { messages: 0, window_min: 30, pulseChannels: [EOT], pulseCovered: false }),
    ).toMatchObject({ state: 'no_receiver', reason: 'pulse_not_covered' });
    // covered:true (or not given) leaves the verdict alone.
    expect(
      assess('rail_radio', s, {
        messages: 0,
        window_min: 30,
        tracks: TRACK,
        pulseCovered: true,
      }).state,
    ).toBe('unconfirmed');
  });

  it('rail voice: a feed Pulse did not list for the point was not searched, so never quiet', () => {
    // feeds/status: the line's road channel online, plus an EOT receiver online. Pulse's
    // rail/activity listed only its EOT channel for the point (so covered:true), which means it
    // never searched the road channel's transcripts here.
    const s = status([railFeed(), eotFeed()], { rail_radio: 'listening', eot: 'listening' });
    const v = assess('rail_radio', s, {
      messages: 0,
      window_min: 30,
      tracks: TRACK,
      pulseChannels: [],
      pulseCovered: true,
    });
    expect(v).toMatchObject({
      state: 'no_receiver',
      reason: 'not_searched',
      feeds: [{ feed_id: 'csx_alpha_road' }],
    });
    const t = verdictSentence(v, NOW, 'this line');
    expect(t).toMatch(
      /^No rail radio receiver confirmed on this line: Pulse's own lookup for this point did not list CSX Alpha road among its rail voice channels, so it was not searched here/,
    );
    expect(t).toMatch(/0 rail messages means no coverage, not a quiet line/);
    expect(t).not.toMatch(/quiet: |really is quiet/);
    // Same when Pulse listed another line's channel only, or the unlisted feed is offline.
    const other = status([
      railFeed(),
      railFeed({ feed_id: 'cn_zulu_road', name: 'CN Zulu road', coverage: {} }),
    ]);
    expect(
      assess('rail_radio', other, {
        messages: 0,
        window_min: 30,
        tracks: TRACK,
        pulseChannels: ['CN Zulu road'],
      }),
    ).toMatchObject({ state: 'unconfirmed', feeds: [{ feed_id: 'cn_zulu_road' }] });
    const off = status([
      railFeed({ receiver: { state: 'offline', last_seen_at: '2026-11-14T09:00:00Z' } }),
    ]);
    expect(
      assess('rail_radio', off, { messages: 0, window_min: 30, tracks: TRACK, pulseChannels: [] }),
    ).toMatchObject({ state: 'no_receiver', reason: 'not_searched' });
    // Pulse's summary alone ("listening") with no feed it listed is not quiet either.
    expect(
      assess('rail_radio', status([], { rail_radio: 'listening' }), {
        messages: 0,
        window_min: 30,
        tracks: TRACK,
        pulseChannels: [],
      }),
    ).toMatchObject({ state: 'no_receiver', reason: 'not_searched', feeds: [] });
    // The listed feed decides: online now (unproven), and activity names only listed feeds.
    expect(
      assess('rail_radio', s, {
        messages: 0,
        window_min: 30,
        tracks: TRACK,
        pulseChannels: ['CSX Alpha road'],
      }).state,
    ).toBe('unconfirmed');
    expect(
      assess('rail_radio', s, { messages: 2, window_min: 30, tracks: TRACK, pulseChannels: [] }),
    ).toMatchObject({ state: 'activity', messages: 2, feeds: [] });
  });

  it("rail/activity's covered is split per kind", () => {
    const s = status([railFeed(), eotFeed(), EXAMPLE_RAIL]);
    const road = (receiver_state?: string) => ({
      channel: 'CSX Alpha road',
      kind: 'road',
      ...(receiver_state ? { receiver_state } : {}),
    });
    const eotCh = (receiver_state?: string) => ({
      channel: EOT,
      kind: 'eot',
      ...(receiver_state ? { receiver_state } : {}),
    });
    const cov = (covered: boolean, channels: unknown[]) => ({ covered, channels });
    // A reported EOT receiver makes Pulse's covered true; voice is still not covered.
    const eotOnly = cov(true, [eotCh('online')]);
    expect(pulseCoveredFor('rail_radio', eotOnly, s)).toBe(false);
    expect(pulseCoveredFor('eot', eotOnly, s)).toBe(true);
    // Per-channel receiver_state decides each kind.
    const voiceNever = cov(true, [road('not_installed'), eotCh('online')]);
    expect(pulseCoveredFor('rail_radio', voiceNever, s)).toBe(false);
    expect(pulseCoveredFor('eot', voiceNever, s)).toBe(true);
    const eotNever = cov(true, [road('offline'), eotCh('not_installed')]);
    expect(pulseCoveredFor('rail_radio', eotNever, s)).toBe(true);
    expect(pulseCoveredFor('eot', eotNever, s)).toBe(false);
    // An example placeholder Pulse lists doesn't count, as in Pulse's own rule.
    const exampleOnly = cov(true, [
      road('not_installed'),
      { channel: 'Example railroad road channel', kind: 'road', receiver_state: 'online' },
      eotCh('online'),
    ]);
    expect(pulseCoveredFor('rail_radio', exampleOnly, s)).toBe(false);
    // Without per-channel states: covered:false holds for both kinds, and an EOT listing alone
    // doesn't make voice covered; covered:true with both kinds listed can't be split.
    expect(pulseCoveredFor('rail_radio', cov(true, [eotCh()]), s)).toBe(false);
    expect(pulseCoveredFor('eot', cov(true, [eotCh()]), s)).toBe(true);
    expect(pulseCoveredFor('rail_radio', cov(false, [road(), eotCh()]), s)).toBe(false);
    expect(pulseCoveredFor('eot', cov(false, [road(), eotCh()]), s)).toBe(false);
    expect(pulseCoveredFor('rail_radio', cov(true, [road(), eotCh()]), s)).toBe(true);
    // No channel list (malformed or older answer): covered as given.
    expect(pulseCoveredFor('rail_radio', { covered: true }, s)).toBe(true);
    expect(pulseCoveredFor('eot', {}, s)).toBeUndefined();
    // Fed to assess: a listed voice channel whose receiver never reported is not quiet, even
    // though feeds/status shows it online and Pulse's covered is true because of the EOT one.
    expect(
      assess('rail_radio', s, {
        messages: 0,
        window_min: 30,
        tracks: TRACK,
        pulseChannels: ['CSX Alpha road'],
        pulseCovered: pulseCoveredFor('rail_radio', voiceNever, s),
      }),
    ).toMatchObject({ state: 'no_receiver', reason: 'pulse_not_covered' });
  });
});
