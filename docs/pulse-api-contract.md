# Detroit Pulse API contract (v1, for the gateway)

Status: v1, plus the additive v1.1 receiver/coverage fields on `GET /v1/feeds/status` and the
additive v1.2 `verdicts` on `GET /v1/rail/activity` (below). The gateway's client
(`src/pulse/client.ts`), tools (`src/pulse/tools.ts`) and coverage logic
(`src/pulse/coverage.ts`) are written against this document, and the test double in
`test/fixtures/mock-pulse.ts` implements it. Every v1.1 and v1.2 field is optional for the
gateway: an older Pulse that omits them still works, and the gateway then never says "quiet"
(it says it can't confirm).

## Transport

* Base URL: `PULSE_URL`. Dev: `http://127.0.0.1:7710`. Docker: `http://pulse-api:7710` on the
  internal `godseye-backend` compose network (Pulse joins that network with its own pinned address
  in `172.30.78.0/24`; it must **not** bind `0.0.0.0` on the host or publish a port). The gateway's
  containers resolve names through public DNS with no tailnet search domain, so `pulse-api` can
  only ever be the container on that network.
* Auth: `Authorization: Bearer <PULSE_API_TOKEN>`. A shared secret in both services' env files
  (mode 600). Pulse must reject requests without it once it is set. Pulse's existing admin and
  audio routes stay off this API.
* All responses are `application/json; charset=utf-8` and carry `generated_at` (ISO 8601 UTC).
* Errors: HTTP 4xx/5xx with `{"error": {"code": "bad_request|not_found|unavailable|internal", "message": "..."}}`.
* Limits the gateway enforces: 5 s timeout (`PULSE_TIMEOUT_MS`), 2 MB maximum response, no
  redirects. Pulse should answer in well under a second from its own database.
* Times are UTC. Coordinates are WGS84 decimal degrees. Distances are metres.
* **Every free-text field that came from radio audio or a third party is named `*_untrusted`.**
  The gateway passes those through as data and tells Claude never to follow instructions in them.

## Shared types

```ts
type Incident = {
  incident_id: string;            // UUID
  type: string;                   // e.g. "structure_fire", "crash", "medical", "police", "rail"
  priority?: "low" | "medium" | "high";
  status: "active" | "resolved";
  opened_at: string;              // ISO
  last_updated: string;           // ISO
  address?: string;               // normalized address text
  lat?: number; lon?: number;
  location_confidence?: "high" | "medium" | "low";
  distance_m?: number;            // present on /near queries
  units?: string[];               // e.g. ["DFD:Engine 30"]
  summary_untrusted?: string;     // LLM summary of transcripts
  feed_id: string;
  chunk_count: number;
};

type Transcript = {
  chunk_id: string;
  ts: string;                     // capture time, ISO
  feed_id: string;
  channel?: string;               // human channel name, e.g. "CN Holly Sub road"
  text_untrusted: string;
  confidence?: number;            // 0..1 ASR confidence
  incident_id?: string;
};
```

## `GET /v1/health`

`200 {"ok": true, "version": "x.y.z", "generated_at": "..."}`

## `GET /v1/incidents/near` (tool: `incidents_near`)

| param | type | default | range |
|---|---|---|---|
| `lat`, `lon` | number | required | |
| `radius_km` | number | 3 | 0.1–50 |
| `since_minutes` | integer | 60 | 1–1440 |
| `limit` | integer | 25 | 1–100 |

`200 {"generated_at", "center": {"lat","lon"}, "radius_km", "since_minutes", "incidents": Incident[]}`,
nearest first. Includes incidents opened or updated within the window.

## `GET /v1/incidents/{incident_id}` (tool: `incident_detail`)

`200 {"generated_at", "incident": Incident, "transcripts": Transcript[]}` (chronological, at most
100), or `404`.

## `GET /v1/transcripts/search` (tool: `search_transcripts`)

| param | type | default | range |
|---|---|---|---|
| `q` | string | required | 1–200 chars; plain words, no operators required |
| `since_minutes` | integer | 60 | 1–1440 |
| `channel` | string | — | optional exact channel or feed id |
| `limit` | integer | 25 | 1–100 |

`200 {"generated_at", "query", "results": Transcript[]}`, newest first.

## `GET /v1/rail/activity` (tool: `rail_activity_near`)

| param | type | default | notes |
|---|---|---|---|
| `lat`, `lon` | number | required | |
| `since_minutes` | integer | 30 | 1–720 |
| `subdivision` | string | — | hint: the `coverage.lines[].name` from feeds/status that matched this track (any of its names or aliases), else a plain dataset name with marks and "Sub" removed, e.g. `Holly`. Pulse matches it exactly (normalised) and uses it only to order the point's subdivisions and for its note; it never adds a channel |
| `railroad` | string | — | hint, e.g. `CN`: Pulse then checks only that railroad's voice channels. The gateway sends it only when the caller gives one (never from its own line match), and says so |

Pulse picks the channels whose own receiver area covers the point (the channel's radius or area,
else a subdivision area it is on; never by name, never by a fixed distance), then returns:

```ts
{
  generated_at: string;
  subdivision?: string; railroad?: string;
  coverage: {
    covered: boolean;              // false = no monitored channel for this line yet
    channels: { channel: string; frequency_mhz?: number; railroad?: string; subdivision?: string; kind: "road" | "dispatcher" | "detector" | "eot"; receiver_state?: "not_installed" | "offline" | "online" }[];
    note?: string;
    // Pulse 888cb0a and later, only when one is non-zero: recordings on the covering channels in
    // the window with no text (queued/transcribing, failed, no speech). Traffic, never quiet.
    recordings_without_text?: { pending: number; error: number; no_speech: number };
  };
  transcripts: (Transcript & { reason_label?: ReasonLabel })[];   // rail voice traffic, newest first
  detector_readouts: {
    ts: string; detector: string; railroad?: string; subdivision?: string; milepost?: string;
    track?: string; axles?: number; speed_mph?: number; temperature_f?: number;
    defects: string[];             // [] = "no defects"
    raw_untrusted: string;         // the decoded/transcribed announcement
  }[];
  eot_hot: {
    ts: string; device: "EOT" | "HOT"; unit_id: string;
    brake_pipe_psi?: number; motion?: boolean; marker_light?: boolean;
    battery?: "ok" | "weak" | "low"; armed?: boolean;
  }[];
  reason_labels: { label: ReasonLabel; confidence: number; from_chunk_ids: string[] }[];
  verdicts?: { rail_voice: Verdict; eot: Verdict };   // v1.2, below
}
type ReasonLabel = "crew_change" | "meet_pass" | "signal_stop" | "dispatcher_hold" | "mechanical"
  | "defect_detector_stop" | "blocked_crossing" | "track_work" | "switching" | "emergency" | "unknown";
```

### v1.2: `verdicts` (additive, backward compatible)

Per kind, may the point be called quiet? Pulse builds this in `api/rail_verdicts.py`
(its `docs/pulse-api.md` item 8 has the full rules):

```ts
type Verdict = {
  state: "activity" | "quiet" | "not_covered" | "unknown";
  reasons: string[];             // plain sentences, the channels one cause applies to grouped:
                                 // "line_road, line_yard: no receiver has ever reported"
  window_start: string;          // ISO 8601 UTC: now - since_minutes
  window_end: string;            // now; for quiet, where Pulse's proof ends (below)
  listening_since?: string;      // since when every covering channel and the ingest stage are proven
  counts: { transcripts: number; detector_readouts: number;
            recordings_without_text: number; eot_packets: number };   // covering channels only
  channels: { feed_id: string;   // the feeds/status feed_id
              receiver_state: "not_installed" | "offline" | "online";
              listening_since?: string; covers_point: boolean }[];    // every enabled, non-example
};                                                                    // channel of the kind
```

* `activity`: anything in the window on a channel that covers the point: a transcript, a
  detector readout, a recording with no text (queued, transcribing, failed, no speech, still being
  written) or an EOT/HOT packet. Messages from channels that don't cover the point never count.
* `not_covered`: no channel of the kind covers the point by its own coverage, or none that does
  was listened to at any time in the window.
* `quiet`, only on positive proof for the **whole** window: every covering channel's receiver was
  listening since before `window_start` (heartbeat history, not "online now"; a run breaks at a
  gap longer than a missed beat or two of that receiver, 45 s for rtl_airband's stats file and
  105 s for traintap's minute heartbeat, at an rtl_airband counter that went down, and at
  **every restart**, however quickly it came back: from Pulse 3fec976 each SDR container's
  entrypoint writes a start marker, `<name>.started` with a new boot id, before every start, and
  a new one ends the run), on the channel's configured frequency and filed under a channel that
  covers the point (a label on another frequency, or the frequency filed under a disabled channel
  after a rename that wasn't re-rendered, is not listening to it); for rail voice, everything the
  receiver heard reached Pulse (below); the ingest stage (`sdr_files` for voice, `traintap` for
  EOT) beat since before `window_start`, within the last 35 s, and could see its input; nothing
  was heard on the covering channels and nothing in the window is left unattributed (recordings
  of a disabled channel that the ingest stage dropped included).
  * A receiver that writes no start marker never proves a window: traintap's heartbeat is a bare
    touch and rtl_airband's counters may all still be 0, so a restart may not show in them
    ("<channels>: the receiver writes no start marker (rail-airband.started), so a restart in the
    window can't be ruled out", with no `listening_since`). After deploying 3fec976, nothing is
    quiet until the SDR containers are recreated and write their markers.
  * Rail voice, what was heard became recordings: rtl_airband turns a channel's file output off
    for good after one failed open or short write (a full disk, the recordings volume's
    permissions) and keeps demodulating and rewriting its stats file. Pulse records how each
    channel's squelch-open, dropped-as-too-short and activity counters grew, and a covering
    channel with no recording at all in the window is `unknown` when its squelch opened more often
    than it dropped transmissions ("the receiver opened squelch 5 times on line_road in the window
    but no recording reached Pulse (rtl_airband may have turned that channel's recordings off
    after a failed write: check its log)"), or was open with no opening (a transmission that began
    before the window). A receiver whose stats file has no squelch counter for a covering channel,
    or a plain heartbeat, proves nothing about its recordings, and the channel isn't proven.
  * What no heartbeat shows: a receiver that stalls without restarting for less than its max
    gap, counted from its last write (up to about 45 s for rtl_airband, 105 s for traintap).
* A quiet window ends where Pulse's proof ends, not at its answer: `window_end` is the earliest
  of the ingest stage's newest beat (stamped with when its poll began) and the covering
  receivers' newest heartbeats. That is normally under 20 s before `generated_at` for rail
  voice and up to about a minute for EOT/HOT (at most a receiver's max gap: 45 s, 105 s), and
  the quiet reason says how far ("up to <window_end> (N s before this answer ...)").
* `unknown`: nothing was heard, but one of those isn't shown; `reasons` says which.
* The shape is the same before and after 3fec976, so the gateway can't tell a Pulse with
  verdicts from before it (which can call a window quiet across a restart its heartbeat didn't
  show, or while rtl_airband had stopped writing recordings) from a later one: run Pulse 3fec976
  or later, with its SDR containers recreated.

## `GET /v1/feeds/status` (tool: `feeds_status`)

`200 {"generated_at", "feeds": [{"feed_id", "name", "category": "public_safety"|"rail", "county"?,
"enabled", "state": "up"|"degraded"|"down", "last_chunk_at"?, "chunks_last_hour", "source"}]}`

`source` names where audio comes from (`"sdr:<device>"`, `"licensed:<provider>"`). Note the
licensing finding: Broadcastify's terms (rev. 2026-07-22, §9) forbid automated access,
transcription and LLM processing without a commercial licence, so Pulse needs its own SDR
receivers or a licensed feed before this API carries real data.

### v1.1: receivers and coverage (additive, backward compatible)

Every existing field stays. Each feed adds:

```ts
receiver: {
  state: "not_installed" | "offline" | "online";
  last_seen_at?: string;     // ISO 8601 UTC, the receiver's last heartbeat
  device?: string;           // e.g. "rtl_airband", "traintap"
};
coverage: {
  area?: string;             // what the channel hears, e.g. a county or city
  lines?: { railroad: string; name: string; aliases: string[] }[];
  radius_km?: number;
};
example?: true;              // shipped placeholder feed (see below)
```

* `receiver.state`:
  * `not_installed`: no receiver has **ever** reported for this feed's source (for example the SDR
    containers/profile are not running and never produced a heartbeat).
  * `offline`: a receiver reported before, but its heartbeat is older than `RECEIVER_STALE_S`
    (default 300 s).
  * `online`: the heartbeat is fresh: the receiver is listening **now**. That alone doesn't make
    0 chunks a quiet window (the receiver may have come back during it, or ingest may be down):
    only a v1.2 `verdicts` quiet from `rail/activity` does.
* `coverage` comes from Pulse's config. For rail feeds, `lines` are the lines this
  receiver/channel hears; `aliases` lists **every other name the same track has in other
  datasets** (for example the FRA crossing inventory and NARN often give one track different
  subdivision names). Town-specific aliases belong only in Pulse's gitignored `*.local.*` config.
* Example/placeholder feeds shipped in tracked config (ids starting `example_`) must be reported
  with `"example": true` and must **not** count as coverage anywhere.

At top level:

```ts
coverage_summary: {
  rail_radio: S; eot: S; public_safety: S;
}
// S = "no_receiver" | "receiver_offline" | "listening" | "not_configured"
// not_configured = no enabled feed of that kind exists, or only the shipped example/placeholder feeds.
```

Example (a rail channel set up but its SDR never started, the EOT receiver online without a
location, a placeholder scanner feed):

```json
{
  "generated_at": "2026-11-14T12:00:00Z",
  "feeds": [
    {"feed_id": "example_fire_dispatch", "name": "Example city fire dispatch", "category": "public_safety",
     "enabled": true, "state": "down", "chunks_last_hour": 0, "source": "sdr:rtl_airband",
     "example": true, "receiver": {"state": "not_installed"}, "coverage": {}},
    {"feed_id": "rr_road", "name": "Railroad road channel", "category": "rail", "enabled": true,
     "state": "down", "chunks_last_hour": 0, "source": "sdr:rtl_airband",
     "receiver": {"state": "not_installed"},
     "coverage": {"lines": [{"railroad": "CSX", "name": "Alpha Subdivision", "aliases": ["Bravo (CSXT)"]}]}},
    {"feed_id": "eot_hot", "name": "EOT/HOT telemetry (traintap)", "category": "rail", "enabled": true,
     "state": "up", "chunks_last_hour": 9, "source": "sdr:traintap",
     "receiver": {"state": "online", "last_seen_at": "2026-11-14T11:59:40Z", "device": "traintap"},
     "coverage": {}}
  ],
  "coverage_summary": {"rail_radio": "no_receiver", "eot": "listening", "public_safety": "not_configured"}
}
```

### How the gateway uses it (`src/pulse/coverage.ts`)

* Feeds with `"example": true` or an id starting `example_` are ignored, whatever their state.
* Kinds: `category: "public_safety"` is scanner radio; within `category: "rail"`, a feed is EOT/HOT
  telemetry when it has `kind: "eot"`, a `traintap` source, or an EOT id/name; otherwise it is
  rail voice.
* `rail_activity_near` (and `whats_happening_here`, which uses it) reads feeds/status first, then
  works out every name the datasets give the track at the point (NARN's subdivision, the FRA
  subdivision of crossings on the same rails within 3 km, the nearest crossing's names) and
  matches them against each rail feed's `coverage.lines` names **and** aliases. Names are
  compared normalised: case, parenthesised marks such as `(CSXT)`, "Subdivision"/"Sub"/"District",
  a leading railroad mark, "MAIN LINE" vs "MAINLINE"; railroads must agree when both sides name
  one (legacy marks such as GTW/CN or ATK/AMTK count as the same railroad). The matched line's
  `name` is sent as the `subdivision` hint; `railroad` only when the caller gives one.
* **With `verdicts` (v1.2), Pulse's verdict decides** rail voice and EOT/HOT. The gateway relays
  `state`, `reasons` and `counts` in plain words: **activity found**, **listening and quiet**
  (from `window_start` to `window_end`, with the listening-since time and the covering channels),
  **no coverage**, or **can't confirm quiet**. Reasons are relayed verbatim, in Pulse's order:
  `coverage_check.<kind>.reasons` has every one (up to 20, each up to 1000 characters, a longer
  one cut with "…"), and the sentence carries up to four, as many whole as fit in 600
  characters (at least one), counting the rest ("and 2 more (see coverage_check)"). A reason
  over 300 characters that groups channels ("a, b, c, d: why") names the first three and how many
  more, so the cause itself is never cut; only a single cause over 300 characters is cut, at a
  word, with "…".
  The counts line uses Pulse's counts for the covering channels, recordings without text
  included. The gateway never upgrades anything to quiet or activity. It downgrades a `quiet` to
  "can't confirm" (`coverage_check.<kind>.state: "unknown"`, `pulse_state: "quiet"`,
  `gateway_reasons`) when its own checks disagree:
  * Pulse's answer contradicts itself: counts not all zero or incomplete, `transcripts`,
    `detector_readouts`, `eot_hot` or `coverage.recordings_without_text` not empty, no channel
    with `covers_point`, a window shorter than the minutes asked by more than 2 min (room for
    `window_end` trailing the answer, above) or none, no `listening_since` before
    `window_start`, or a covering channel not `online` with its own `listening_since` before
    `window_start`;
  * feeds/status (read a few seconds apart) reports a covering channel's receiver offline or not
    installed, or the channel disabled or an example placeholder;
  * rail voice: the gateway identified a track at the point, every covering channel lists its
    `coverage.lines` in feeds/status, and none of those lines is that track (the answer names the
    lines they do hear). A channel placed by area alone, no track identified, or feeds/status
    unavailable leaves Pulse's quiet as it is. On `activity` the same mismatch only adds a note.

  A `verdicts` block without a usable verdict for a kind gives "can't confirm" for that kind.
  Where the rail voice answer is not quiet, sentences of Pulse's `coverage.note` that call
  channels quiet (v1.2 does for the proven channels of a partly proven point) are withheld from
  the data, with a marker.
* **Without `verdicts`** (a Pulse older than v1.2) the gateway judges from feeds/status and
  `rail/activity`'s channel list, and **never says quiet**: a receiver online now proves nothing
  about the whole window, so that case is **can't confirm quiet: receiver online now**. Recordings
  in `coverage.recordings_without_text` (888cb0a era) count as rail traffic (activity found), and
  the counts line lists them by kind. Sentences of Pulse's note that call channels quiet are
  withheld. Pulse searches transcripts only on the voice channels its `rail/activity` lists in
  `coverage.channels`, so only a listed voice channel can be online now or offline for the point;
  a feed the gateway matched to the line by name but Pulse did not list gives **no receiver
  confirmed: Pulse did not search it for this point**. Without the list (older Pulse), a feed on
  the matched line or one Pulse lists counts. When no line is identified at the point and Pulse
  lists no voice channel for it, the result says no rail line was identified here.
* Without `verdicts`, EOT/HOT is judged by the `kind: "eot"` channels `rail/activity` lists for the
  point. An EOT/HOT receiver Pulse doesn't list gives **no EOT/HOT receiver near this point**, and
  any `eot_hot` packets returned are not counted as activity there (the tool moves them to
  `eot_hot_not_near_point`). Such a Pulse lists an EOT/HOT receiver for any point within a fixed
  25 km of it, or for every point when its location isn't set, whatever the receiver's own
  `coverage.radius_km`; feeds/status gives no receiver position and packets carry none. So
  packets from a listed receiver are never activity at the point either: the result is
  **heard but not placed at this point** (N packets from the receivers that may have heard them,
  naming a receiver's own range when it is under 25 km or its location isn't set), and the tool
  moves them to `eot_hot_not_placed`. "Can't confirm quiet" for EOT/HOT adds the same range
  caveat.
* Without `verdicts`, on v1.1, `coverage.covered: false` from `rail/activity` gives no receiver
  confirmed, even if feeds/status shows a matching receiver online. Pulse computes `covered` over
  the voice and EOT channels together, so the gateway splits it per kind: with each listed
  channel's `receiver_state`, a kind is covered when one of its listed channels (not an example or
  disabled feed) has reported; without per-channel states, `covered: false` holds for both kinds
  and a kind with no listed channel is not covered.
* Without `verdicts`, each result states exactly one of: **activity found** (never for
  EOT/HOT); **heard but not placed at this point** (EOT/HOT only); **can't confirm quiet:
  receiver online now**; **receiver offline since T**; **no receiver** (none of that kind is
  set up, a channel is set up but its receiver never reported, no channel covers this line,
  naming the lines Pulse does cover, no line identified at the point, no EOT/HOT receiver near the
  point, Pulse's point lookup says not covered, or Pulse did not search the line's channel for the
  point); or **Pulse is too old to say** (no `receiver`/`coverage`/`coverage_summary`).
  `coverage_check.<kind>.basis` is `gateway_without_verdicts` here and `pulse_verdict` with
  verdicts.
* `incidents_near` asks for feeds/status alongside the incidents and states the scanner verdict
  the same way as rail without verdicts (scanner incidents have none), so never quiet: a scanner
  receiver online with 0 incidents is "can't confirm quiet", listing the areas the listening feeds
  cover (the gateway can't tell whether the point is inside them).
* One feeds/status answer is shared for 10 s, so `whats_happening_here` asks once.

## Gateway behaviour

* Pulse unreachable (connection refused, timeout) → the tool returns
  "Pulse is not running …" with `isError` and kind `unavailable`; `whats_happening_here` reports
  "no Pulse data / no rail radio coverage yet" for that source and carries on. (`rail_activity_near`
  returns that as soon as feeds/status is unreachable, without waiting out a second timeout.)
* feeds/status failing (non-2xx) while the other route works → the result says the feed status
  was unavailable, so 0 messages can't be told apart from no receiver.
* An older Pulse without the v1.1 fields → treated as unknown, and the result says so.
* A Pulse without the v1.2 `verdicts` → never "quiet" for rail voice or EOT/HOT, and never
  EOT/HOT activity at the point (see above).
* Non-2xx → an error result quoting Pulse's `error.code` (never its stack).
* Responses are size-capped, links rewritten, and summarized; `*_untrusted` text is passed as data.
