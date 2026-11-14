/**
 * Tailscale identity for the private listener.
 *
 * `tailscale serve` (the sidecar container, or tailscaled on the host) terminates
 * HTTPS on the tailnet name, strips any client-supplied Tailscale-* headers, and
 * adds Tailscale-User-Login / Tailscale-User-Name for requests from user-owned
 * devices before proxying to the gateway's private port.
 *
 * The gateway trusts those headers only when the TCP peer is a configured
 * trusted proxy (loopback by default: the private listener binds 127.0.0.1 inside
 * the network namespace it shares with the sidecar) and only on the private
 * listener. The public listener never consults them. The login must equal
 * OWNER_TAILSCALE_LOGIN; anything else fails closed.
 */
import type { IncomingMessage } from 'node:http';
import { normalizeIp } from '../util/net.js';

export interface TailscaleIdentity {
  login: string;
  name?: string;
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  if (Array.isArray(v)) return v.length === 1 ? v[0] : undefined; // duplicates: refuse
  return v;
}

export function tailscaleIdentity(
  req: IncomingMessage,
  opts: { trustedProxies: string[]; ownerLogin: string },
): TailscaleIdentity | null {
  const peer = normalizeIp(req.socket.remoteAddress ?? '');
  const trusted = opts.trustedProxies.map(normalizeIp);
  if (!peer || !trusted.includes(peer)) return null;
  const login = header(req, 'tailscale-user-login')?.trim().toLowerCase();
  if (!login || login.length > 320 || /[\s,;]/.test(login)) return null;
  if (login !== opts.ownerLogin.toLowerCase()) return null;
  const name = header(req, 'tailscale-user-name');
  return { login, name: name ? decodeName(name).slice(0, 100) : undefined };
}

/** Tailscale may RFC 2047-encode non-ASCII names; keep it simple and printable. */
function decodeName(n: string): string {
  // eslint-disable-next-line no-control-regex
  return n.replace(/[\u0000-\u001f\u007f]/g, '');
}
