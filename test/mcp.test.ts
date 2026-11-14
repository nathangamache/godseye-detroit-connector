import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT, loadConfig } from '../src/config.js';
import { startGateway, type Gateway } from '../src/gateway.js';
import { childSpawnSpec } from '../src/gev/child.js';
import { nullLogger } from '../src/log.js';
import { MOCK_GEV, DETROIT, waitFor } from './helpers.js';

let gw: Gateway;
let dir: string;
let token: string;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'gw-mcp-'));
  const config = loadConfig({
    GATEWAY_MODE: 'test',
    PORT: '0',
    PRIVATE_PORT: '0',
    UI_PORT: '0',
    DATA_DIR: dir,
    PUBLIC_ORIGIN: 'https://godseye.gamachecloud.com',
    PRIVATE_ORIGIN: 'https://godseye.example-tailnet.ts.net',
    PULSE_URL: 'http://127.0.0.1:9',
  });
  gw = await startGateway(config, {
    logger: nullLogger,
    gevChild: childSpawnSpec({
      gevRoot: REPO_ROOT,
      gevUrl: 'http://127.0.0.1:7701',
      wrapper: MOCK_GEV,
    }),
  });
  await waitFor(() => gw.registry.hasGev(), 10_000);
  token = gw.tokens.issue({
    clientId: 'test-client',
    subject: 'owner',
    scope: 'mcp',
    resource: config.mcpResource,
  }).tokens.access_token;
});

afterAll(async () => {
  await gw?.close();
  rmSync(dir, { recursive: true, force: true });
});

const mcpUrl = () => `${gw.url}/mcp`;

describe('/mcp auth gate', () => {
  it('401 + WWW-Authenticate resource_metadata without a token', async () => {
    const r = await fetch(mcpUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toBe(
      'Bearer resource_metadata="https://godseye.gamachecloud.com/.well-known/oauth-protected-resource"',
    );
  });

  it('401 invalid_token for a bad token and for a token with the wrong audience', async () => {
    const r = await fetch(mcpUrl(), {
      method: 'POST',
      headers: { authorization: 'Bearer gat_nope', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toMatch(/error="invalid_token"/);
    const other = gw.tokens.issue({
      clientId: 'c',
      subject: 'owner',
      scope: 'mcp',
      resource: 'https://evil.example/mcp',
    }).tokens.access_token;
    const r2 = await fetch(mcpUrl(), {
      method: 'POST',
      headers: { authorization: `Bearer ${other}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(r2.status).toBe(401);
  });

  it('rejects foreign Origin and Host headers', async () => {
    const r = await fetch(mcpUrl(), {
      method: 'POST',
      headers: { origin: 'https://evil.example', authorization: `Bearer ${token}` },
      body: '{}',
    });
    expect(r.status).toBe(403);
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve) => {
      const req = request(mcpUrl(), { method: 'POST', headers: { host: 'evil.example' } }, (res) =>
        resolve(res.statusCode ?? 0),
      );
      req.end('{}');
    });
    expect(status).toBe(421);
  });

  it('answers in SSE response mode (keep-alive friendly behind Cloudflare)', async () => {
    const r = await fetch(mcpUrl(), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 't', version: '1' },
        },
      }),
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/event-stream/);
    expect(await r.text()).toMatch(/"protocolVersion"/);
    const get = await fetch(mcpUrl(), { headers: { authorization: `Bearer ${token}` } });
    expect(get.status).toBe(405);
  });

  it('serves protected resource metadata', async () => {
    for (const p of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
    ]) {
      const j = (await (await fetch(gw.url + p)).json()) as {
        resource: string;
        authorization_servers: string[];
      };
      expect(j.resource).toBe('https://godseye.gamachecloud.com/mcp');
      expect(j.authorization_servers).toEqual(['https://godseye.gamachecloud.com']);
    }
    expect(await (await fetch(gw.url + '/healthz')).json()).toEqual({ ok: true });
  });
});

describe('/mcp tools', () => {
  let client: Client;
  beforeAll(async () => {
    client = new Client({ name: 'test', version: '1' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(mcpUrl()), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
  });
  afterAll(async () => client?.close());

  it('exposes exactly four read-only tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'find_tools',
      'run_tool',
      'whats_happening_here',
      'where_am_i',
    ]);
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);
  });

  it('find_tools returns schemas; denied tools are hidden', async () => {
    const r = await client.callTool({ name: 'find_tools', arguments: { query: 'weather' } });
    const json = JSON.parse((r.content as Array<{ text: string }>)[1]!.text);
    const w = json.results.find((x: { name: string }) => x.name === 'get_weather');
    expect(w.source).toBe('gev');
    expect(w.input_schema.properties.location).toBeDefined();
    const g = await client.callTool({
      name: 'find_tools',
      arguments: { query: 'google places search business', limit: 20 },
    });
    expect((g.content as Array<{ text: string }>)[1]!.text).not.toMatch(
      /search_places|places_nearby/,
    );
  });

  it('run_tool proxies to GEV and rewrites links to the tailnet UI origin', async () => {
    const r = await client.callTool({
      name: 'run_tool',
      arguments: { name: 'get_weather', arguments: { location: DETROIT } },
    });
    const text = (r.content as Array<{ text: string }>).map((c) => c.text).join('\n');
    expect(r.isError).toBeFalsy();
    expect(text).toMatch(/Clear/);
    expect(text).toContain('https://godseye.example-tailnet.ts.net:8443/#v=2');
    expect(text).not.toContain('127.0.0.1:7701');
  });

  it('run_tool rejects panel_request and Google tools', async () => {
    const p = await client.callTool({
      name: 'run_tool',
      arguments: { name: 'panel_request', arguments: { key: 'k', path: '/api/x' } },
    });
    expect(p.isError).toBe(true);
    const g = await client.callTool({
      name: 'run_tool',
      arguments: { name: 'search_places', arguments: { query: 'pizza' } },
    });
    expect(g.isError).toBe(true);
    expect((g.content as Array<{ text: string }>)[0]!.text).toMatch(/Google/);
  });

  it('where_am_i says there is no fix yet', async () => {
    const r = await client.callTool({ name: 'where_am_i', arguments: {} });
    expect((r.content as Array<{ text: string }>)[0]!.text).toMatch(
      /No phone location fix.*\/locate/,
    );
  });

  it('get_cctv_snapshot images are downscaled', async () => {
    const r = await client.callTool({
      name: 'run_tool',
      arguments: { name: 'get_cctv_snapshot', arguments: { camera_id: 'cam-1' } },
    });
    const img = (r.content as Array<{ type: string; data?: string }>).find(
      (c) => c.type === 'image',
    );
    expect(img?.data?.length).toBeLessThanOrEqual(60_000);
    const total = JSON.stringify(r.content).length;
    expect(total).toBeLessThan(150_000);
  });
});
