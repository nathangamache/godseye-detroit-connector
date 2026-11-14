/**
 * Pulse's rail/activity `verdicts` (contract v1.2): the gateway relays state, reasons and counts,
 * may only turn a quiet into unknown when its own checks disagree, and never upgrades anything
 * to quiet or activity.
 */
import { describe, expect, it } from 'vitest';
import {
  checkVerdict,
  parseFeedsStatus,
  parseVerdicts,
  railVerdictSentence,
  type FeedsStatus,
  type PulseVerdict,
} from '../src/pulse/coverage.js';
import type { TrackNames } from '../src/rail/names.js';

const NOW = Date.parse('2026-11-14T12:00:00Z');
const at = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();
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
const QUIET_REASON =
  'every rail voice channel that covers this point was listened to for the whole window (receiver and ingest heartbeats) and nothing was heard';

/** Pulse's verdict for one kind, as api/rail_verdicts.py builds it (30 min window). */
const raw = (over: Record<string, unknown> = {}) => ({
  state: 'quiet',
  reasons: [QUIET_REASON],
  window_start: at(30),
  window_end: at(0),
  listening_since: at(45),
  counts: { transcripts: 0, detector_readouts: 0, recordings_without_text: 0, eot_packets: 0 },
  channels: [
    {
      feed_id: 'csx_alpha_road',
      receiver_state: 'online',
      listening_since: at(45),
      covers_point: true,
    },
    {
      feed_id: 'cn_zulu_road',
      receiver_state: 'online',
      listening_since: at(45),
      covers_point: false,
    },
  ],
  ...over,
});
const parsed = (over: Record<string, unknown> = {}): PulseVerdict =>
  parseVerdicts({ rail_voice: raw(over) })!.rail_radio!;

const railFeed = (over: Record<string, unknown> = {}) => ({
  feed_id: 'csx_alpha_road',
  name: 'CSX Alpha road',
  category: 'rail',
  enabled: true,
  state: 'down',
  chunks_last_hour: 0,
  source: 'sdr:rtl_airband',
  receiver: { state: 'online', last_seen_at: at(1) },
  coverage: { lines: [{ railroad: 'CSX', name: 'Alpha Subdivision', aliases: [] }] },
  ...over,
});
const status = (feeds: unknown[]): FeedsStatus =>
  parseFeedsStatus({
    generated_at: at(0),
    feeds,
    coverage_summary: { rail_radio: 'listening', eot: 'listening' },
  });
const STATUS = status([railFeed()]);

const voice = (
  v: PulseVerdict | undefined,
  over: { status?: FeedsStatus; tracks?: TrackNames[]; window_min?: number; listed?: number } = {},
) =>
  checkVerdict('rail_radio', v, {
    status: STATUS,
    tracks: TRACK,
    window_min: 30,
    listed: 0,
    ...over,
  });

describe('parsing verdicts', () => {
  it('keeps the contract fields, drops junk and bounds sizes', () => {
    const v = parseVerdicts({
      rail_voice: raw({
        reasons: ['a', 7, '', 'x'.repeat(5000), ...Array.from({ length: 50 }, (_, i) => `r${i}`)],
        channels: [
          { feed_id: 'ok', receiver_state: 'bogus', covers_point: 'yes' },
          { covers_point: true },
          { feed_id: 'ok2', receiver_state: 'online', covers_point: true, listening_since: 'nope' },
        ],
        extra: 'y'.repeat(10_000),
      }),
      eot: { state: 'maybe' },
    })!;
    expect(v.eot).toBeUndefined();
    const r = v.rail_radio!;
    expect(r.state).toBe('quiet');
    // At most 20 entries are read; non-strings and blanks among them are dropped, and a reason
    // over 1000 characters is cut, visibly.
    expect(r.reasons[0]).toBe('a');
    expect(r.reasons.length).toBe(18);
    expect(r.reasons[1]).toBe(`${'x'.repeat(999)}…`);
    expect(r.channels).toEqual([
      { feed_id: 'ok', covers_point: false },
      { feed_id: 'ok2', receiver_state: 'online', covers_point: true },
    ]);
    expect(JSON.stringify(v)).not.toContain('yyyy');
    // Incomplete counts are not counts.
    expect(parsed({ counts: { transcripts: 0 } }).counts).toBeUndefined();
    expect(parsed({ counts: { ...raw().counts, eot_packets: -1 } }).counts).toBeUndefined();
    expect(parseVerdicts(undefined)).toBeUndefined();
    expect(parseVerdicts([raw()])).toBeUndefined();
  });
});

describe("Pulse's verdict is relayed", () => {
  it('quiet: state, window, listening since, reasons verbatim and the covering channels', () => {
    const v = voice(parsed());
    expect(v).toMatchObject({
      basis: 'pulse_verdict',
      state: 'quiet',
      pulse_state: 'quiet',
      reasons: [QUIET_REASON],
      feeds: [{ feed_id: 'csx_alpha_road', name: 'CSX Alpha road', receiver: 'online' }],
    });
    expect(v.gateway_reasons).toBeUndefined();
    expect(railVerdictSentence(v, 'this line')).toBe(
      `Listening and quiet on this line, per Pulse's verdict for ${at(30).replace('.000Z', 'Z')} to ${at(0).replace('.000Z', 'Z')}: ${QUIET_REASON}; listening since ${at(45).replace('.000Z', 'Z')} (CSX Alpha road). So it really is quiet.`,
    );
  });

  it("quiet up to Pulse's newest heartbeats: the window may end up to 2 min before the answer", () => {
    // Pulse ends a quiet where its proof ends (the ingest stage's newest beat and the covering
    // receivers' newest heartbeats): seconds before its answer for voice, up to 105 s for EOT/HOT.
    for (const [kind, lagS] of [
      ['rail_radio', 15],
      ['rail_radio', 45],
      ['eot', 60],
      ['eot', 105],
    ] as const) {
      const end = new Date(NOW - lagS * 1000).toISOString();
      const reason = `every ${kind === 'eot' ? 'EOT/HOT' : 'rail voice'} channel that covers this point was listened to for the whole window, up to ${end} (${lagS} s before this answer: Pulse's newest receiver and ingest heartbeats), and nothing was heard`;
      const v = checkVerdict(
        kind,
        parseVerdicts({
          [kind === 'eot' ? 'eot' : 'rail_voice']: raw({ window_end: end, reasons: [reason] }),
        })![kind],
        { status: STATUS, tracks: TRACK, window_min: 30, listed: 0 },
      );
      expect(v.gateway_reasons).toBeUndefined();
      expect(v.state).toBe('quiet');
      expect(railVerdictSentence(v)).toBe(
        `Listening and quiet ${kind === 'eot' ? 'near' : 'on'} this point, per Pulse's verdict for ${at(30).replace('.000Z', 'Z')} to ${end.replace('.000Z', 'Z')}: ${reason}; listening since ${at(45).replace('.000Z', 'Z')} (CSX Alpha road). So it really is quiet.`,
      );
    }
  });

  it('unknown and not_covered: Pulse reasons, never quiet', () => {
    const late = voice(
      parsed({
        state: 'unknown',
        reasons: [
          `csx_alpha_road: receiver listening only since ${at(10)}, after the window start`,
          'ingest (sdr_files) has no current heartbeat',
        ],
        listening_since: at(10),
      }),
    );
    expect(late.state).toBe('unknown');
    const t = railVerdictSentence(late, 'this line');
    expect(t).toMatch(
      /^Can't confirm quiet on this line, per Pulse's verdict: csx_alpha_road: receiver listening only since \S+, after the window start; ingest \(sdr_files\) has no current heartbeat\. Hearing nothing here means no proof, not a quiet line\.$/,
    );
    const none = voice(
      parsed({
        state: 'not_covered',
        reasons: ['no rail voice channel covers this point'],
        channels: [],
      }),
    );
    expect(railVerdictSentence(none, 'this line')).toBe(
      "No coverage on this line, per Pulse's verdict: no rail voice channel covers this point. Hearing nothing here means no coverage, not a quiet line.",
    );
    const eot = checkVerdict(
      'eot',
      parseVerdicts({ eot: raw({ state: 'not_covered', reasons: [], channels: [] }) })!.eot,
      { window_min: 30, listed: 0 },
    );
    expect(railVerdictSentence(eot)).toMatch(
      /^No coverage near this point, per Pulse's verdict: no EOT\/HOT telemetry channel covers this point\./,
    );
  });

  it('activity: any message on a covering channel, recordings without text included', () => {
    const counts = {
      transcripts: 0,
      detector_readouts: 0,
      recordings_without_text: 3,
      eot_packets: 0,
    };
    const v = voice(
      parsed({
        state: 'activity',
        reasons: ['heard on channels that cover this point: 3 recordings without text'],
        counts,
      }),
    );
    expect(v).toMatchObject({ state: 'activity', counts });
    expect(railVerdictSentence(v, 'this line')).toBe(
      "Activity found on this line, per Pulse's verdict: heard on channels that cover this point: 3 recordings without text (CSX Alpha road).",
    );
  });

  it('a kind with no usable verdict is unknown, never quiet', () => {
    const v = voice(undefined);
    expect(v).toMatchObject({ state: 'unknown', reasons: [], feeds: [] });
    expect(v.pulse_state).toBeUndefined();
    expect(railVerdictSentence(v)).toMatch(
      /^Can't confirm quiet on this point: Pulse sent no usable verdict for rail voice\./,
    );
  });
});

describe("Pulse's reasons for restarts and a dead recorder (Pulse 3fec976) are relayed whole", () => {
  // Pulse's own strings (api/rail_verdicts.py _channel_gap and _grouped, api/routes/v1.py's
  // squelch check), for the live layout: 11 rail voice channels on one receiver, all covering
  // the point, and one EOT/HOT channel.
  const ids = (n: number) =>
    Array.from({ length: n }, (_, i) => `line_rd${String(i + 1).padStart(2, '0')}`);
  const NO_MARKER = (rx: string) =>
    `the receiver writes no start marker (${rx}.started), so a restart in the window can't be ruled out`;
  const OFF =
    "(rtl_airband may have turned that channel's recordings off after a failed write: check its log)";
  const squelch = (id: string, n: number, dropped = 0) =>
    `the receiver opened squelch ${n} time${n === 1 ? '' : 's'} on ${id} in the window${dropped ? ` (not counting ${dropped} time${dropped === 1 ? '' : 's'} it dropped as too short)` : ''} but no recording reached Pulse ${OFF}`;
  const unknown = (reasons: string[], channelIds: string[], since?: string) => ({
    state: 'unknown',
    reasons,
    ...(since ? { listening_since: since } : { listening_since: undefined }),
    channels: channelIds.map((feed_id) => ({
      feed_id,
      receiver_state: 'online',
      ...(since ? { listening_since: since } : {}),
      covers_point: true,
    })),
  });
  const relayed = (
    kind: 'rail_radio' | 'eot',
    over: Record<string, unknown>,
    place = kind === 'eot' ? 'this point' : 'this line',
  ) => {
    const v = checkVerdict(
      kind,
      parseVerdicts({ [kind === 'eot' ? 'eot' : 'rail_voice']: raw(over) })![kind],
      { status: STATUS, tracks: TRACK, window_min: 30, listed: 0 },
    );
    return { v, t: railVerdictSentence(v, place) };
  };
  const cantConfirm = (prep: string, why: string) =>
    `Can't confirm quiet ${prep}, per Pulse's verdict: ${why}. Hearing nothing here means no proof, not a quiet line.`;

  it('a receiver that writes no start marker (Pulse before the SDR containers are recreated)', () => {
    const voiceWhy = `${ids(11).join(', ')}: ${NO_MARKER('rail-airband')}`;
    expect(voiceWhy.length).toBeGreaterThan(220);
    const voice = relayed('rail_radio', unknown([voiceWhy], ids(11)));
    expect(voice.v).toMatchObject({
      state: 'unknown',
      pulse_state: 'unknown',
      reasons: [voiceWhy],
    });
    expect(voice.v.listening_since).toBeUndefined();
    expect(voice.t).toBe(cantConfirm('on this line', voiceWhy));
    const eotWhy = `eot_hot: ${NO_MARKER('traintap-eot')}`;
    const eot = relayed('eot', unknown([eotWhy], ['eot_hot']));
    expect(eot.t).toBe(cantConfirm('near this point', eotWhy));
  });

  it("a restart the heartbeat can't show, caught by the start marker", () => {
    const since = '2026-11-14T11:50:15Z';
    const why = `${ids(11).join(', ')}: receiver listening only since ${since}, after the window start`;
    const voice = relayed('rail_radio', unknown([why], ids(11), since));
    expect(voice.t).toBe(cantConfirm('on this line', why));
    const eotWhy =
      'eot_hot: receiver listening only since 2026-11-14T11:51:30Z, after the window start';
    expect(relayed('eot', unknown([eotWhy], ['eot_hot'], '2026-11-14T11:51:30Z')).t).toBe(
      cantConfirm('near this point', eotWhy),
    );
  });

  it('squelch openings that never became recordings: as many whole reasons as fit, the rest counted', () => {
    const reasons = [
      squelch('line_rd01', 5),
      squelch('line_rd02', 9, 3),
      squelch('line_rd03', 2),
      squelch('line_rd04', 1),
      squelch('line_rd05', 6, 1),
      `the receiver's squelch was open on line_rd06 in the window (a transmission that began before it) but no recording reached Pulse ${OFF}`,
    ];
    expect(reasons[1]!.length).toBeGreaterThan(220);
    const voice = relayed('rail_radio', unknown(reasons, ids(11), at(120)));
    // Every reason is kept for coverage_check, verbatim.
    expect(voice.v.reasons).toEqual(reasons);
    expect(voice.t).toBe(
      cantConfirm('on this line', `${reasons[0]}; ${reasons[1]}; and 4 more (see coverage_check)`),
    );
  });

  it('a cause shared by many channels keeps its words; only the channel list is shortened', () => {
    const why = `${ids(30).join(', ')}: ${NO_MARKER('rail-airband')}`;
    expect(why.length).toBeGreaterThan(400);
    const voice = relayed('rail_radio', unknown([why], ids(30)));
    expect(voice.v.reasons).toEqual([why]);
    expect(voice.t).toBe(
      cantConfirm(
        'on this line',
        `line_rd01, line_rd02, line_rd03 and 27 more: ${NO_MARKER('rail-airband')}`,
      ),
    );
    // A single cause longer than a sentence allows is cut at a word, visibly.
    const long = relayed(
      'rail_radio',
      unknown([`ingest (sdr_files) can't see its input (${'disk '.repeat(80)})`], ids(1)),
    );
    expect(long.t).toMatch(
      /^Can't confirm quiet on this line, per Pulse's verdict: ingest \(sdr_files\) can't see its input \((disk )+disk…\. Hearing/,
    );
  });
});

describe('the gateway downgrades a quiet when its own checks disagree', () => {
  const downgraded = (v: ReturnType<typeof voice>, why: RegExp) => {
    expect(v.pulse_state).toBe('quiet');
    expect(v.state).toBe('unknown');
    expect(v.gateway_reasons?.join(' | ')).toMatch(why);
    const t = railVerdictSentence(v, 'this line');
    expect(t).toMatch(
      /^Can't confirm quiet on this line: Pulse's verdict was quiet, but the gateway's own check disagrees: /,
    );
    expect(t).not.toMatch(/Listening and quiet|really is quiet/);
  };

  it("Pulse's answer contradicts itself", () => {
    downgraded(
      voice(parsed({ counts: { ...raw().counts, recordings_without_text: 2 } })),
      /counts show 2 message\(s\)/,
    );
    downgraded(voice(parsed({ counts: undefined })), /no complete counts/);
    downgraded(
      voice(parsed(), { listed: 4 }),
      /answer also lists 4 transcript\(s\), detector readout\(s\) or recording\(s\) without text/,
    );
    downgraded(
      voice(parsed({ channels: [{ feed_id: 'cn_zulu_road', covers_point: false }] })),
      /no channel that covers this point/,
    );
    downgraded(
      voice(parsed({ window_start: at(10) })),
      /window .* is shorter than the 30 min asked by more than 2 min/,
    );
    downgraded(voice(parsed(), { window_min: 60 }), /shorter than the 60 min asked/);
    // Pulse's proof ending more than 2 min before its answer.
    downgraded(voice(parsed({ window_end: at(2.5) })), /shorter than the 30 min asked/);
    downgraded(voice(parsed({ window_end: undefined })), /gives no window/);
    downgraded(
      voice(parsed({ listening_since: at(20) })),
      /listening only since \S+, after the window start/,
    );
    downgraded(
      voice(parsed({ listening_since: undefined })),
      /no time it has been listening since/,
    );
    downgraded(
      voice(
        parsed({
          channels: [
            {
              feed_id: 'csx_alpha_road',
              receiver_state: 'online',
              listening_since: at(5),
              covers_point: true,
            },
          ],
        }),
      ),
      /does not show csx_alpha_road online and listening since before the window start/,
    );
    downgraded(
      voice(
        parsed({
          channels: [
            {
              feed_id: 'csx_alpha_road',
              receiver_state: 'offline',
              listening_since: at(45),
              covers_point: true,
            },
          ],
        }),
      ),
      /does not show csx_alpha_road online/,
    );
  });

  it("feeds/status disagrees about a covering channel's receiver", () => {
    for (const [over, why] of [
      [
        { receiver: { state: 'offline', last_seen_at: at(20) } },
        /CSX Alpha road's receiver is offline/,
      ],
      [{ receiver: { state: 'not_installed' } }, /CSX Alpha road's receiver is not installed/],
      [{ enabled: false }, /CSX Alpha road is disabled/],
      [{ example: true }, /CSX Alpha road is an example placeholder/],
    ] as const)
      downgraded(voice(parsed(), { status: status([railFeed(over)]) }), why);
    // feeds/status unavailable, or a Pulse whose feed status reports no receivers: nothing to check.
    expect(voice(parsed(), { status: undefined }).state).toBe('quiet');
    expect(
      voice(parsed(), {
        status: parseFeedsStatus({ feeds: [{ feed_id: 'csx_alpha_road', category: 'rail' }] }),
      }).state,
    ).toBe('quiet');
  });

  it('the covering channels hear other lines than the track at the point', () => {
    const zulu = railFeed({
      coverage: { lines: [{ railroad: 'CN', name: 'Zulu Subdivision', aliases: [] }] },
    });
    const v = voice(parsed(), { status: status([zulu]) });
    downgraded(
      v,
      /the channels that cover this point hear CN Zulu Subdivision, and none of those is the track identified here/,
    );
    expect(v.other_lines).toEqual(['CN Zulu Subdivision']);
    // A line alias that is the track here: quiet stands.
    const alias = railFeed({
      coverage: { lines: [{ railroad: 'CSX', name: 'Charlie Sub', aliases: ['Bravo (CSXT)'] }] },
    });
    expect(voice(parsed(), { status: status([alias]) }).state).toBe('quiet');
    // A channel placed by area alone, no track identified, or no feed status: nothing disagrees.
    expect(
      voice(parsed(), { status: status([railFeed({ coverage: { radius_km: 5 } })]) }).state,
    ).toBe('quiet');
    expect(voice(parsed(), { status: status([zulu]), tracks: [] }).state).toBe('quiet');
    // Activity stays activity (never downgraded), with a note about the lines.
    const busy = voice(
      parsed({
        state: 'activity',
        reasons: ['heard on channels that cover this point: 1 transcript'],
        counts: { ...raw().counts, transcripts: 1 },
      }),
      { status: status([zulu]) },
    );
    expect(busy.state).toBe('activity');
    expect(railVerdictSentence(busy, 'this line')).toMatch(
      /^Activity found on this line, per Pulse's verdict: heard on channels that cover this point: 1 transcript \(CSX Alpha road\)\. Those channels hear CN Zulu Subdivision, and none of those is the track identified here\.$/,
    );
  });
});

describe('the gateway never upgrades', () => {
  it('unknown and not_covered stay, whatever the counts or feeds/status say', () => {
    for (const state of ['unknown', 'not_covered'] as const) {
      const v = voice(
        parsed({ state, reasons: ['x'], counts: { ...raw().counts, transcripts: 5 } }),
        { listed: 5 },
      );
      expect(v.state).toBe(state);
      expect(v.gateway_reasons).toBeUndefined();
      expect(railVerdictSentence(v)).not.toMatch(
        /Activity found|Listening and quiet|really is quiet/,
      );
    }
    // Everything the gateway can see looks fine: Pulse's unknown is still unknown.
    expect(
      voice(parsed({ state: 'unknown', reasons: ['ingest (sdr_files) has no current heartbeat'] }))
        .state,
    ).toBe('unknown');
  });
});
