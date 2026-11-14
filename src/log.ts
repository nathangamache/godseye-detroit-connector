/**
 * Minimal structured logger (JSON lines on stdout, picked up by journald or
 * `docker logs`). It sanitizes every field it is given:
 *  - secret-looking keys are replaced with "[redacted]"
 *  - coordinate keys are rounded to 2 decimals (~1 km), never logged in full
 *  - token-shaped substrings inside strings are masked
 * Call sites must still avoid putting raw coordinates in the message text.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_KEY =
  /^(authorization|cookie|set-cookie|password|passwd|secret|token|access_token|refresh_token|id_token|code|code_verifier|code_challenge|client_secret|assertion|jwt|cf-access-jwt-assertion|totp|otp|api_key|apikey|key|device_token|setup_code)$/i;
const SECRET_KEY_SUFFIX = /(_token|_secret|_password|_key|_hash|_jwt)$/i;
const COORD_KEY = /^(lat|lon|lng|latitude|longitude)$/i;
const TOKEN_PATTERN = /\b(g(at|rt|dt|sc)_[A-Za-z0-9_-]{8,})|(Bearer\s+[A-Za-z0-9._~+/-]{8,}=*)/g;

export function roundCoord(v: unknown): unknown {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : v;
}

export function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[deep]';
  if (typeof value === 'string') return value.replace(TOKEN_PATTERN, '[redacted-token]');
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitize(v, depth + 1));
  if (value instanceof Error) return { name: value.name, message: sanitize(value.message, depth + 1) };
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY.test(k) || SECRET_KEY_SUFFIX.test(k)) out[k] = v == null ? v : '[redacted]';
      else if (COORD_KEY.test(k)) out[k] = roundCoord(v);
      else out[k] = sanitize(v, depth + 1);
    }
    return out;
  }
  return value;
}

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  level?: Level;
  sink?: (line: string) => void;
  base?: Record<string, unknown>;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const min = LEVELS[opts.level ?? 'info'];
  const sink = opts.sink ?? ((line: string) => process.stdout.write(line + '\n'));
  const base = opts.base ?? {};
  const emit = (level: Level, event: string, fields?: Record<string, unknown>) => {
    if (LEVELS[level] < min) return;
    const record = sanitize({ ...base, ...fields }) as Record<string, unknown>;
    sink(
      JSON.stringify({ ts: new Date().toISOString(), level, event: sanitize(event), ...record }),
    );
  };
  return {
    debug: (e, f) => emit('debug', e, f),
    info: (e, f) => emit('info', e, f),
    warn: (e, f) => emit('warn', e, f),
    error: (e, f) => emit('error', e, f),
    child: (fields) => createLogger({ ...opts, base: { ...base, ...fields } }),
  };
}

/** A logger that drops everything (tests). */
export const nullLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return nullLogger;
  },
};
