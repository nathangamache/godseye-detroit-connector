export type ToolSource = 'gev' | 'gateway' | 'pulse';

export type JsonSchema = Record<string, unknown>;

export interface ToolImage {
  mimeType: string;
  data: string; // base64
}

/** Normalized output every backend returns before post-processing. */
export interface ToolOutput {
  summary: string;
  data?: unknown;
  images?: ToolImage[];
  isError?: boolean;
  /** invalid_arguments | unavailable | unsupported | retry_later | policy | timeout | internal */
  errorKind?: string;
  /** When the underlying data was observed, if the backend knows. */
  observedAt?: string;
}

export interface ToolContext {
  signal: AbortSignal;
  subject?: string;
  clientId?: string;
  /** The OAuth grant (token family) making the call. */
  familyId?: string;
  /**
   * Road sources to leave out of this call, each with the note its report gives. Set only by a
   * gateway composite (whats_happening_here sparing the TomTom daily quota), never by a request.
   */
  skipRoadSources?: Readonly<Record<string, string>>;
}

/** The API key a key-gated tool needs, when it is missing. */
export interface MissingKey {
  /** The setting to fill in deploy/secrets/gateway.env, e.g. AIRNOW_API_KEY. */
  env: string;
  /** What the key is, e.g. "a free EPA AirNow API key". */
  what: string;
}

export interface ToolDef {
  name: string;
  title?: string;
  description: string;
  source: ToolSource;
  /** Logical family shown to Claude (e.g. rail tools are "pulse" family but gateway-native). */
  family: string;
  inputSchema: JsonSchema;
  tags: string[];
  attribution?: string;
  /** Untrusted third-party text (radio transcripts, news) may appear in the output. */
  untrustedText?: boolean;
  /**
   * Set when the tool needs an API key that is not configured: find_tools lists it as OFF with
   * the key, and run_tool answers a normal result with status not_configured (nothing fetched).
   */
  needsKey?: MissingKey;
  /**
   * What is left today of the daily caps of the metered sources this tool may ask, by source
   * (road_closures: tomtom). A composite reads it to decide whether to leave one out.
   */
  quotas?(): Readonly<Record<string, { remaining: number; max: number }>>;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput>;
}
