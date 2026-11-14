# Detroit Pulse API contract (v1, for the gateway)

Status: v1, plus the additive v1.1 receiver/coverage fields on `GET /v1/feeds/status` (below).
The gateway's client (`src/pulse/client.ts`), tools (`src/pulse/tools.ts`) and coverage logic
(`src/pulse/coverage.ts`) are written against this document, and the test double in
`test/fixtures/mock-pulse.ts` implements it. Every v1.1 field is optional for the gateway: an
older Pulse that omits them still works, and the gateway says it can't tell quiet from uncovered.

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
| `subdivision` | string | — | hint: the `coverage.lines[].name` from feeds/status that matched this track (any of its names or aliases), else a plain dataset name with marks and "Sub" removed, e.g. `Holly` |
| `railroad` | string | — | hint, e.g. `CN` (only when the caller or the matched coverage line gives one) |

Pulse maps the point (and hints) to the rail subdivision(s) and the radio channels it monitors for
them, then returns:

```ts
{
  generated_at: string;
  subdivision?: string; railroad?: string;
  coverage: {
    covered: boolean;              // false = no monitored channel for this line yet
    channels: { channel: string; frequency_mhz?: number; railroad?: string; subdivision?: string; kind: "road" | "dispatcher" | "detector" | "eot"; receiver_state?: "not_installed" | "offline" | "online" }[];
    note?: string;
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
}
type ReasonLabel = "crew_change" | "meet_pass" | "signal_stop" | "dispatcher_hold" | "mechanical"
  | "defect_detector_stop" | "blocked_crossing" | "track_work" | "switching" | "emergency" | "unknown";
```

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
  * `online`: the heartbeat is fresh. A fresh heartbeat with 0 chunks means the channel is
    **quiet**, not uncovered.
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
  `name` is sent as the `subdivision` hint. Pulse searches transcripts only on the voice channels
  its `rail/activity` lists in `coverage.channels`, so when that list is sent (every v1.1 Pulse
  does) only a listed voice channel can be **quiet** or **offline** for the point; a feed the
  gateway matched to the line by name but Pulse did not list (Pulse picks channels its own way, for
  example at a junction, or with an exact railroad mark) gives **no receiver confirmed: Pulse did
  not search it for this point**, never "quiet". Without the list (older Pulse), a feed on the
  matched line or one Pulse lists counts. When no line is identified at the point (no named track
  near it in the rail datasets, for example outside their coverage) and Pulse lists no voice
  channel for it, no rail voice receiver is tied to the point: the result says no rail line was
  identified here, never "quiet".
* EOT/HOT is judged by the `kind: "eot"` channels `rail/activity` lists for the point (Pulse lists
  one only when its receiver is within range of the point or has no location set). An EOT/HOT
  receiver Pulse doesn't list for the point gives **no EOT/HOT receiver near this point**, and any
  `eot_hot` packets returned are not counted as activity there (the tool moves them to
  `eot_hot_not_near_point`). With one receiver listed and another not, activity found adds that
  some packets may come from the other one.
* On v1.1, `coverage.covered: false` from `rail/activity` is never reported as quiet, even if
  feeds/status shows a matching receiver online: the result says no receiver is confirmed.
  Pulse computes `covered` over the voice and EOT channels together, so the gateway splits it per
  kind: with each listed channel's `receiver_state`, a kind is covered when one of its listed
  channels (not an example or disabled feed) has reported; without per-channel states,
  `covered: false` holds for both kinds and a kind with no listed channel is not covered (an EOT
  listing never makes rail voice covered, nor the reverse).
* Each result then states exactly one of: **activity found**; **listening and quiet** (a
  receiver covering the point is online and 0 messages arrived in the window); **receiver
  offline since T**; **no receiver** (none of that kind is set up, a channel is set up but its
  receiver never reported, no channel covers this line, naming the lines Pulse does cover, no
  line identified at the point, no EOT/HOT receiver near the point, Pulse's point lookup says
  not covered, or Pulse did not search the line's channel for the point); or **Pulse is too old to say** (no `receiver`/`coverage`/`coverage_summary`;
  unknown, not "quiet"). EOT/HOT
  results add that packets can't be tied to the place when the EOT receiver has no
  `coverage.area`/`radius_km`. Scanner results list the areas the listening feeds cover (the
  gateway can't tell whether the point is inside them).
* `incidents_near` asks for feeds/status alongside the incidents and states the scanner verdict.
* One feeds/status answer is shared for 10 s, so `whats_happening_here` asks once.

## Gateway behaviour

* Pulse unreachable (connection refused, timeout) → the tool returns
  "Pulse is not running …" with `isError` and kind `unavailable`; `whats_happening_here` reports
  "no Pulse data / no rail radio coverage yet" for that source and carries on. (`rail_activity_near`
  returns that as soon as feeds/status is unreachable, without waiting out a second timeout.)
* feeds/status failing (non-2xx) while the other route works → the result says the feed status
  was unavailable, so 0 messages can't be told apart from no receiver.
* An older Pulse without the v1.1 fields → treated as unknown, and the result says so.
* Non-2xx → an error result quoting Pulse's `error.code` (never its stack).
* Responses are size-capped, links rewritten, and summarized; `*_untrusted` text is passed as data.
