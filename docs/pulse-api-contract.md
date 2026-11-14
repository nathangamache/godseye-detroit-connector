# Detroit Pulse API contract (v1, for the gateway)

Status: **contract only.** Pulse does not implement it yet. The gateway's client
(`src/pulse/client.ts`) and tools (`src/pulse/tools.ts`) are written against this document, and the
test double in `test/fixtures/mock-pulse.ts` implements it.

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
| `subdivision` | string | — | hint from the gateway's NARN lookup, e.g. `HOLLY` |
| `railroad` | string | — | hint, e.g. `CN` |

Pulse maps the point (and hints) to the rail subdivision(s) and the radio channels it monitors for
them, then returns:

```ts
{
  generated_at: string;
  subdivision?: string; railroad?: string;
  coverage: {
    covered: boolean;              // false = no monitored channel for this line yet
    channels: { channel: string; frequency_mhz?: number; railroad?: string; subdivision?: string; kind: "road" | "dispatcher" | "detector" | "eot" }[];
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

## Gateway behaviour

* Pulse unreachable (connection refused, timeout) → the tool returns
  "Pulse is not running …" with `isError` and kind `unavailable`; `whats_happening_here` reports
  "no Pulse data / no rail radio coverage yet" for that source and carries on.
* Non-2xx → an error result quoting Pulse's `error.code` (never its stack).
* Responses are size-capped, links rewritten, and summarized; `*_untrusted` text is passed as data.
