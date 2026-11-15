/**
 * whats_happening_here over MCP spares the TomTom daily quota: the connector builds a fresh MCP
 * server per request, yet two summaries a minute apart make one TomTom request between them
 * (the pacing lives with the HTTP handler, not the per-request server), and the second says it
 * skipped TomTom. All HTTP is mocked.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { startGateway, type Gateway } from '../src/gateway.js';
import { nullLogger } from '../src/log.js';
import { DETROIT } from './helpers.js';

let gw: Gateway;
let dir: string;
let client: Client;
const tomtom: string[] = [];

const text = (r: { content: unknown }) =>
  (r.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n');

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'gw-wh-mcp-'));
  const config = loadConfig({
    GATEWAY_MODE: 'test',
    PORT: '0',
    PRIVATE_PORT: '0',
    UI_PORT: '0',
    DATA_DIR: dir,
    PULSE_URL: 'http://127.0.0.1:9',
    PULSE_TIMEOUT_MS: '500',
    TOMTOM_API_KEY: 'tt-test-key',
    ALLOW_TOMTOM_INCIDENTS: 'true',
  });
  gw = await startGateway(config, {
    logger: nullLogger,
    gevChild: false,
    fetch: async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('api.tomtom.com')) {
        tomtom.push(url);
        return new Response(JSON.stringify({ incidents: [] }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{"error":"test double: upstream down"}', { status: 404 });
    },
  });
  const token = gw.tokens.issue({
    clientId: 'c',
    subject: 'owner',
    scope: 'mcp',
    resource: config.mcpResource,
  }).tokens.access_token;
  client = new Client({ name: 't', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${gw.url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
});

afterAll(async () => {
  await client?.close();
  await gw?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('whats_happening_here and the TomTom quota', () => {
  it('asks TomTom once for two summaries in a row and says why the second has none', async () => {
    const first = text(
      await client.callTool({ name: 'whats_happening_here', arguments: { ...DETROIT } }),
    );
    expect(tomtom).toHaveLength(1);
    expect(first).toMatch(/TomTom incidents: 0 \(59 of 60 requests left today\)/);
    const second = text(
      await client.callTool({ name: 'whats_happening_here', arguments: { ...DETROIT } }),
    );
    expect(tomtom).toHaveLength(1);
    expect(second).toContain(
      'TomTom incidents skipped to save the daily quota; ask road_closures for them',
    );
    // road_closures through run_tool still asks TomTom (nothing is cached).
    const rc = await client.callTool({
      name: 'run_tool',
      arguments: { name: 'road_closures', arguments: { ...DETROIT, radius_km: 5 } },
    });
    expect(rc.isError).toBeFalsy();
    expect(tomtom).toHaveLength(2);
  });
});
