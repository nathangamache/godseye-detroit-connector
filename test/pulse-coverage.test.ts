/**
 * Coverage honesty (feeds/status receiver + coverage): "0 messages" is reported as one of
 * activity / listening and quiet / receiver offline since T / no receiver / Pulse can't say.
 */
import { describe, expect, it } from 'vitest';
import {
  assess,
  feedKind,
  isExampleFeed,
  parseFeedsStatus,
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

  it('listening and quiet vs activity found', () => {
    const s = status([railFeed()]);
    const quiet = rail(s);
    expect(quiet).toMatchObject({ state: 'quiet', window_min: 30 });
    expect(verdictSentence(quiet, NOW, 'this line')).toMatch(
      /Listening and quiet: rail radio receiver online \(CSX Alpha road\) and 0 rail messages on this line in the last 30 min/,
    );
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
    expect(rail(byAlias).state).toBe('quiet');
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
    // Pulse's own rail/activity lookup naming the channel also counts as coverage.
    expect(
      assess('rail_radio', s, {
        messages: 0,
        window_min: 30,
        tracks: TRACK,
        pulseChannels: ['CSX Alpha road'],
      }).state,
    ).toBe('quiet');
  });

  it('EOT receiver without a location: packets cannot be tied to the place', () => {
    const eot = {
      feed_id: 'eot_hot',
      name: 'EOT/HOT telemetry (traintap)',
      category: 'rail',
      enabled: true,
      source: 'sdr:traintap',
      receiver: { state: 'online', last_seen_at: '2026-11-14T11:59:30Z' },
    };
    const v = assess('eot', status([eot]), { messages: 2, window_min: 30 });
    expect(v.state).toBe('activity');
    expect(verdictSentence(v, NOW)).toMatch(
      /location is not set in Pulse, so these packets can't be tied to this place/,
    );
    const located = assess('eot', status([{ ...eot, coverage: { radius_km: 25 } }]), {
      messages: 0,
      window_min: 30,
    });
    expect(verdictSentence(located, NOW)).not.toMatch(/location is not set/);
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
    expect(assess('public_safety', s, { messages: 0, window_min: 60 }).state).toBe('quiet');
  });
});
