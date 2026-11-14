/**
 * GEV MCP relay: runs the GEV stdio MCP child OUTSIDE the gateway container.
 *
 * The child (gev/stdio-all-surfaces.mjs) imports upstream GEV code. Inside the gateway
 * container it would share the gateway's uid, network namespace (so it could reach the
 * private listener and assert Tailscale-User-Login) and /data (the database). In production
 * it runs in its own `gev-mcp` container instead: this relay accepts a TCP connection from
 * the gateway, reads one hello line naming the tools the gateway's policy allows, spawns
 * the wrapper with `--allow` and a minimal environment, and pipes newline-delimited
 * JSON-RPC both ways (the same framing as stdio).
 *
 *   gateway (SocketClientTransport) --tcp--> relay (gev-mcp container) --stdio--> wrapper
 *
 * Only peers on GEV_RELAY_ALLOWED_PEERS may open a session (the gateway's address);
 * loopback connections are accepted and closed at once (container health check).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { normalizeIp } from '../util/net.js';

export const RELAY_HELLO_VERSION = 1;
const TOOL_NAME = /^[a-z0-9_]{1,64}$/;

export interface RelayHello {
  godseye_gev_relay: number;
  allow: string[];
}

export interface RelayOptions {
  host: string;
  port: number;
  /** Peers that may start a session (normalized IPs). */
  allowedPeers: string[];
  /** Peers whose connection is just closed (container health check; default loopback). */
  healthPeers?: string[];
  gevRoot: string;
  gevUrl: string;
  wrapper: string;
  nodePath?: string;
  maxSessions?: number;
  helloTimeoutMs?: number;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

export interface Relay {
  server: Server;
  port: number;
  sessions(): number;
  close(): Promise<void>;
}

/** Validates a hello line; returns the allowlist or an error string. */
export function parseHello(line: string): string[] | string {
  let h: unknown;
  try {
    h = JSON.parse(line);
  } catch {
    return 'hello is not JSON';
  }
  if (!h || typeof h !== 'object' || (h as RelayHello).godseye_gev_relay !== RELAY_HELLO_VERSION)
    return 'unknown hello';
  const allow = (h as RelayHello).allow;
  if (!Array.isArray(allow) || allow.length > 200) return 'allow must be an array of tool names';
  if (!allow.every((n) => typeof n === 'string' && TOOL_NAME.test(n))) return 'bad tool name';
  return allow;
}

/** The wrapper's environment: no secrets, nothing from the relay's own environment. */
export function wrapperEnv(gevRoot: string, nodePath: string): Record<string, string> {
  return {
    GEV_ROOT: gevRoot,
    PATH: `${path.dirname(nodePath)}:/usr/local/bin:/usr/bin:/bin`,
    NODE_ENV: 'production',
    UV_THREADPOOL_SIZE: '2',
    NODE_OPTIONS: '--max-old-space-size=384',
  };
}

export function startRelay(opts: RelayOptions): Promise<Relay> {
  const log = opts.log ?? (() => {});
  const node = opts.nodePath ?? process.execPath;
  const max = opts.maxSessions ?? 2;
  const allowed = new Set(opts.allowedPeers.map(normalizeIp));
  const health = new Set((opts.healthPeers ?? ['127.0.0.1', '::1']).map(normalizeIp));
  const live = new Set<ChildProcess>();

  const onConnection = (sock: Socket) => {
    const peer = normalizeIp(sock.remoteAddress ?? '');
    if (health.has(peer)) {
      sock.end(); // health check
      return;
    }
    if (!allowed.has(peer)) {
      log('relay_peer_refused', { peer });
      sock.destroy();
      return;
    }
    if (live.size >= max) {
      log('relay_busy', { peer, sessions: live.size });
      sock.destroy();
      return;
    }
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      log('relay_hello_timeout', { peer });
      sock.destroy();
    }, opts.helloTimeoutMs ?? 5000);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(0x0a);
      if (nl < 0) {
        if (buf.length > 16 * 1024) {
          log('relay_hello_too_large', { peer });
          sock.destroy();
        }
        return;
      }
      clearTimeout(timer);
      sock.off('data', onData);
      const allow = parseHello(buf.subarray(0, nl).toString('utf8'));
      if (typeof allow === 'string') {
        log('relay_hello_rejected', { peer, reason: allow });
        sock.destroy();
        return;
      }
      if (!allow.length) {
        log('relay_hello_rejected', { peer, reason: 'empty allowlist' });
        sock.destroy();
        return;
      }
      const child = spawn(
        node,
        [opts.wrapper, '--api-base', opts.gevUrl, '--allow', allow.join(',')],
        {
          cwd: opts.gevRoot,
          env: wrapperEnv(opts.gevRoot, node),
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      live.add(child);
      // A spawn failure (missing wrapper or clone) ends this session, never the relay.
      child.on('error', (err) => {
        live.delete(child);
        log('relay_spawn_failed', { peer, error: err.message });
        sock.destroy();
      });
      log('relay_session', { peer, tools: allow.length, pid: child.pid });
      const rest = buf.subarray(nl + 1);
      if (rest.length) child.stdin.write(rest);
      sock.pipe(child.stdin);
      child.stdout.pipe(sock);
      child.stderr.on('data', (c: Buffer) => {
        for (const line of c.toString('utf8').split('\n'))
          if (line.trim()) log('gev_child_stderr', { line: line.slice(0, 300) });
      });
      child.stdin.on('error', () => sock.destroy());
      const end = () => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      };
      sock.on('close', end);
      sock.on('error', end);
      child.on('exit', (code, signal) => {
        live.delete(child);
        log('relay_session_end', { peer, code, signal });
        sock.end();
      });
    };
    sock.on('data', onData);
    sock.on('error', () => clearTimeout(timer));
  };

  const server = createServer(onConnection);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => {
      resolve({
        server,
        port: (server.address() as AddressInfo).port,
        sessions: () => live.size,
        close: () =>
          new Promise<void>((r) => {
            for (const c of live) c.kill('SIGTERM');
            server.close(() => r());
          }),
      });
    });
  });
}
