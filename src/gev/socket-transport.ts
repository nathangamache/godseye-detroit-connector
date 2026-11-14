/**
 * MCP client transport over a TCP socket to the GEV relay (src/gev/relay.ts): newline-
 * delimited JSON-RPC, the same framing as stdio, after one hello line that tells the relay
 * which tools the gateway's policy allows.
 */
import { connect, type Socket } from 'node:net';
import {
  ReadBuffer,
  serializeMessage,
  type JSONRPCMessage,
  type Transport,
} from '@modelcontextprotocol/client';
import { RELAY_HELLO_VERSION } from './relay.js';

export interface SocketTransportOptions {
  host: string;
  port: number;
  allow: string[];
  connectTimeoutMs?: number;
  /** Source address to connect from (tests). */
  localAddress?: string;
}

export class SocketClientTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private socket?: Socket;
  private readonly buffer = new ReadBuffer({ maxBufferSize: 64 * 1024 * 1024 });
  private closed = false;

  constructor(private readonly opts: SocketTransportOptions) {}

  start(): Promise<void> {
    if (this.socket) throw new Error('SocketClientTransport already started');
    return new Promise((resolve, reject) => {
      const sock = connect({
        host: this.opts.host,
        port: this.opts.port,
        localAddress: this.opts.localAddress,
      });
      this.socket = sock;
      let connected = false;
      const timer = setTimeout(
        () => sock.destroy(new Error('GEV relay connect timeout')),
        this.opts.connectTimeoutMs ?? 10_000,
      );
      sock.setNoDelay(true);
      sock.on('connect', () => {
        connected = true;
        clearTimeout(timer);
        sock.write(
          JSON.stringify({ godseye_gev_relay: RELAY_HELLO_VERSION, allow: this.opts.allow }) + '\n',
        );
        resolve();
      });
      sock.on('data', (chunk: Buffer) => {
        try {
          this.buffer.append(chunk);
          for (;;) {
            const msg = this.buffer.readMessage();
            if (msg === null) break;
            this.onmessage?.(msg);
          }
        } catch (err) {
          this.onerror?.(err as Error);
          sock.destroy();
        }
      });
      sock.on('error', (err) => {
        clearTimeout(timer);
        if (!connected) reject(err);
        else this.onerror?.(err);
      });
      sock.on('close', () => {
        clearTimeout(timer);
        if (!connected) reject(new Error('GEV relay closed the connection'));
        this.finish();
      });
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const sock = this.socket;
    if (!sock || this.closed) throw new Error('GEV relay connection is closed');
    await new Promise<void>((resolve, reject) =>
      sock.write(serializeMessage(message), (err) => (err ? reject(err) : resolve())),
    );
  }

  async close(): Promise<void> {
    const sock = this.socket;
    if (!sock) return;
    sock.end();
    const t = setTimeout(() => sock.destroy(), 1000);
    t.unref();
    this.finish();
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.buffer.clear();
    this.onclose?.();
  }
}
