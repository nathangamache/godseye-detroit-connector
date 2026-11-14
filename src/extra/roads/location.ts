/**
 * "here": the user's latest phone fix, read exactly like whats_happening_here does (audited as
 * a location read per grant, never logged with coordinates). Results that use it never echo
 * the fix's coordinates in their summary.
 */
import type { Audit } from '../../audit.js';
import type { LocationStore } from '../../location/store.js';
import type { TokenStore } from '../../oauth/tokens.js';
import type { ToolContext } from '../../tools/types.js';
import { humanAge } from '../../util/format.js';
import type { Point } from './geo.js';

export interface HereDeps {
  locations?: LocationStore;
  audit?: Audit;
  tokens?: TokenStore;
  staleMinutes: number;
  now: () => number;
}

export type HereResult = { ok: true; point: Point; note: string } | { ok: false; error: string };

export function resolveHere(deps: HereDeps, tool: string, ctx: ToolContext): HereResult {
  const fix = deps.locations?.latest();
  deps.audit?.record('location_read', {
    clientId: ctx.clientId,
    subject: ctx.subject,
    detail: { family: ctx.familyId, tool, fix: Boolean(fix) },
  });
  if (ctx.familyId) deps.tokens?.noteLocationRead(ctx.familyId);
  if (!fix) {
    return {
      ok: false,
      error:
        'No phone location fix is available, so "here" cannot be used. Call where_am_i for setup help, or pass lat/lon (or a place) instead.',
    };
  }
  const age = Math.max(0, Math.round((deps.now() - fix.fix_ts) / 1000));
  const stale = age > deps.staleMinutes * 60;
  return {
    ok: true,
    point: { lat: fix.lat, lon: fix.lon },
    note: `Used the phone's latest fix (${humanAge(age)} old${stale ? '; STALE, the user may have moved' : ''}).`,
  };
}
