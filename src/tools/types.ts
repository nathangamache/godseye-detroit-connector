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
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput>;
}
