/** Adapts the supervised GEV child to the registry's GevCaller shape. */
import { fromUpstream } from '../tools/postprocess.js';
import type { GevCaller } from '../tools/registry.js';
import { publicMessage } from '../tools/runner.js';
import { GevUnavailableError, type GevChild } from './child.js';

export function makeGevCaller(child: GevChild): GevCaller {
  return async (name, args, ctx) => {
    try {
      const result = await child.callTool(name, args, { timeoutMs: ctx.timeoutMs, signal: ctx.signal });
      return fromUpstream(result);
    } catch (err) {
      if (err instanceof GevUnavailableError) {
        return { summary: err.message, isError: true, errorKind: 'unavailable' };
      }
      const msg = publicMessage(err);
      const timedOut = /timed out|timeout|aborted/i.test(msg);
      return {
        summary: timedOut ? `God's Eye View did not answer in time (${msg}).` : `God's Eye View error: ${msg}`,
        isError: true,
        errorKind: timedOut ? 'timeout' : 'upstream',
      };
    }
  };
}
