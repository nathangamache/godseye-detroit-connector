/**
 * Key-gated tools: a tool whose API key is missing stays in the catalog, listed as OFF with the
 * key it needs, and answers every call with a normal (non-error) result whose status is
 * not_configured, naming the missing key. No request is made.
 */
import type { MissingKey, ToolDef, ToolOutput } from './types.js';

/** Where the operator puts keys. */
export const SECRETS_FILE = 'deploy/secrets/gateway.env';

/** The answer of a key-gated tool without its key: nothing was fetched. */
export function notConfiguredOutput(tool: string, key: MissingKey): ToolOutput {
  return {
    summary: `${tool} is not configured: set ${key.env} in ${SECRETS_FILE} (${key.what}). Nothing was fetched.`,
    data: {
      status: 'not_configured',
      tool,
      missing_key: key.env,
      fetched: false,
      note: `Nothing was fetched. Set ${key.env} in ${SECRETS_FILE} to turn ${tool} on.`,
    },
  };
}

/** "OFF: not configured (needs AIRNOW_API_KEY)." for catalog listings. */
export function offLabel(key: MissingKey): string {
  return `OFF: not configured (needs ${key.env}).`;
}

/** The catalog fields find_tools adds to a key-gated tool's entry. */
export function keyFields(def: Pick<ToolDef, 'needsKey'>): {
  status?: 'off';
  needs_key?: string;
} {
  return def.needsKey ? { status: 'off', needs_key: def.needsKey.env } : {};
}
