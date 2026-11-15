/**
 * find_tools browse mode: with no query (or "*", "all", "list"), or a category, it lists the
 * whole catalog the policy allows, grouped by category and paginated; keyword search still
 * works; the server instructions state the real count instead of a guess.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT, loadConfig } from '../src/config.js';
import { startGateway, type Gateway } from '../src/gateway.js';
import { childSpawnSpec } from '../src/gev/child.js';
import { nullLogger } from '../src/log.js';
import { MOCK_GEV, waitFor } from './helpers.js';

let gw: Gateway;
let dir: string;
let client: Client;
let allowed: string[];

interface ListJson {
  mode: string;
  total: number;
  offset: number;
  returned: number;
  next_offset: number | null;
  direct_tools?: Array<{ name: string }>;
  categories: Array<{
    category: string;
    label: string;
    tools: Array<{ name: string; description: string; source: string }>;
  }>;
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'gw-find-'));
  const config = loadConfig({
    GATEWAY_MODE: 'test',
    PORT: '0',
    PRIVATE_PORT: '0',
    UI_PORT: '0',
    DATA_DIR: dir,
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
  allowed = gw.registry
    .all()
    .filter((t) => gw.registry.isAllowed(t))
    .map((t) => t.name)
    .sort();
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

async function find(args: Record<string, unknown>) {
  const r = await client.callTool({ name: 'find_tools', arguments: args });
  const c = r.content as Array<{ text: string }>;
  return { text: c[0]!.text, json: JSON.parse(c[1]!.text) as ListJson & { results?: unknown[] } };
}

const names = (j: ListJson) => j.categories.flatMap((c) => c.tools.map((t) => t.name));

describe('find_tools list mode', () => {
  it('no query lists every allowed tool once, grouped by category, and nothing denied', async () => {
    const { text, json } = await find({});
    expect(json.mode).toBe('list');
    expect(json.total).toBe(allowed.length);
    expect(names(json).sort()).toEqual(allowed);
    // Gateway rail, Pulse and allowlisted GEV tools are all there.
    for (const n of [
      'nearest_rail',
      'crossings_near',
      'rail_activity_near',
      'incidents_near',
      'get_weather',
    ])
      expect(names(json)).toContain(n);
    for (const n of [
      'search_places',
      'places_nearby',
      'aircraft_in_area',
      'find_alpr_cameras',
      'panel_request',
      'brand_new_tool',
    ])
      expect(names(json)).not.toContain(n);
    // Categories are contiguous groups with labels and one-line descriptions.
    const cats = json.categories.map((c) => c.category);
    expect(new Set(cats).size).toBe(cats.length);
    expect(
      json.categories
        .find((c) => c.category === 'rail')!
        .tools.map((t) => t.name)
        .sort(),
    ).toEqual(['crossings_near', 'nearest_rail', 'rail_activity_near']);
    for (const c of json.categories)
      for (const t of c.tools) expect(t.description.length).toBeGreaterThan(5);
    expect(json.direct_tools!.map((t) => t.name)).toEqual(['where_am_i', 'whats_happening_here']);
    expect(text).toMatch(new RegExp(`^${allowed.length} tool\\(s\\) available through run_tool`));
    expect(text).toMatch(/Categories: rail \(3\), scanner \(5\)/);
  });

  it('the published schema makes query optional, and list mode needs nothing else', async () => {
    const { tools } = await client.listTools();
    const schema = tools.find((t) => t.name === 'find_tools')!.inputSchema as {
      properties?: Record<string, { type?: string }>;
      required?: string[];
    };
    expect(schema.properties?.query?.type).toBe('string');
    // No argument is required: claude.ai may call find_tools with {} to browse.
    expect(schema.required ?? []).toEqual([]);
    for (const args of [{}, { limit: 3 }, { offset: 2 }, { category: 'rail' }]) {
      const { json } = await find(args);
      expect(json.mode, JSON.stringify(args)).toBe('list');
    }
  });

  it('"*", "all", "all tools" and "list" are list mode too (not a keyword search)', async () => {
    for (const query of ['*', 'all', 'all tools', 'list', '  ALL  ']) {
      const { json } = await find({ query });
      expect(json.mode, query).toBe('list');
      expect(json.total, query).toBe(allowed.length);
    }
  });

  it('category lists one group; with a query it narrows the search', async () => {
    const { json } = await find({ category: 'scanner' });
    expect(names(json).sort()).toEqual([
      'dpd_calls_near',
      'feeds_status',
      'incident_detail',
      'incidents_near',
      'search_transcripts',
    ]);
    expect(json.direct_tools).toBeUndefined();
    const s = await find({ query: 'weather', category: 'rail' });
    expect(JSON.stringify(s.json)).not.toContain('get_weather');
  });

  it('paginates with limit and offset', async () => {
    const first = await find({ limit: 5 });
    expect(first.json.returned).toBe(5);
    expect(first.json.next_offset).toBe(5);
    expect(first.text).toMatch(/call find_tools again with offset 5/);
    const seen = names(first.json);
    let offset = first.json.next_offset;
    while (offset !== null) {
      const page = await find({ limit: 5, offset });
      seen.push(...names(page.json));
      offset = page.json.next_offset;
    }
    expect(seen.sort()).toEqual(allowed);
  });

  it('keyword search still returns schemas, and an exact name returns that tool first', async () => {
    const { json } = await find({ query: 'weather' });
    const w = (
      json.results as Array<{ name: string; input_schema: unknown; category: string }>
    ).find((x) => x.name === 'get_weather')!;
    expect(w.input_schema).toBeDefined();
    expect(w.category).toBe('weather');
    const exact = await find({ query: 'crossings_near' });
    expect((exact.json.results as Array<{ name: string }>)[0]!.name).toBe('crossings_near');
  });

  it('labels the gateway tools by what they are, not "gateway (rail)"', async () => {
    const { text } = await find({});
    expect(text).not.toMatch(/gateway \(rail\)/);
    const gateway = gw.registry
      .all()
      .filter((t) => t.source === 'gateway' && gw.registry.isAllowed(t));
    expect(text).toContain(
      `${gateway.length} gateway tools (rail, aviation, weather, roads, civic) and`,
    );
    expect(text).toMatch(/Detroit Pulse tools \(scanner and rail radio\)/);
    // A category names only the families in it.
    const rail = await find({ category: 'rail' });
    expect(rail.text).toMatch(/2 gateway tools \(rail\) and 1 Detroit Pulse tools/);
  });

  it('lists every key-gated tool the same way: OFF, with the key it needs', async () => {
    const { text, json } = await find({ limit: 100 });
    const entry = (n: string) =>
      json.categories.flatMap((c) => c.tools).find((t) => t.name === n) as
        { name: string; description: string; status?: string; needs_key?: string } | undefined;
    for (const [name, key] of [
      ['air_quality', 'AIRNOW_API_KEY'],
      ['transit_vehicles_near', 'SWIFTLY_API_KEY'],
    ] as const) {
      const e = entry(name);
      expect(e, name).toBeDefined();
      expect(e).toMatchObject({ status: 'off', needs_key: key });
      expect(e!.description).toMatch(new RegExp(`^OFF: not configured \\(needs ${key}\\)\\. \\S`));
      expect(text).toContain(`${name} (${key})`);
    }
    expect(text).toMatch(/OFF until their key is set .*answer status not_configured/);
    // Configured tools carry no OFF mark.
    expect(entry('weather_alerts')).not.toHaveProperty('status');
    expect(entry('weather_alerts')!.description).not.toMatch(/^OFF/);
  });

  it('an exact tool name returns that tool first, even when it is OFF', async () => {
    for (const name of ['air_quality', 'transit_vehicles_near', 'crossings_near']) {
      const { json } = await find({ query: name });
      const first = (json.results as Array<Record<string, unknown>>)[0]!;
      expect(first.name, name).toBe(name);
      expect(first.input_schema, name).toBeDefined();
    }
    const aq = (await find({ query: 'air_quality' })).json.results as Array<
      Record<string, unknown>
    >;
    expect(aq[0]).toMatchObject({ status: 'off', needs_key: 'AIRNOW_API_KEY' });
  });

  it('a key-gated tool without its key answers a normal not_configured result over MCP', async () => {
    for (const [name, key] of [
      ['air_quality', 'AIRNOW_API_KEY'],
      ['transit_vehicles_near', 'SWIFTLY_API_KEY'],
    ] as const) {
      const r = await client.callTool({
        name: 'run_tool',
        arguments: { name, arguments: { lat: 42.3314, lon: -83.0458 } },
      });
      expect(r.isError, name).toBeFalsy();
      const all = (r.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n');
      expect(all).toContain(`${name} is not configured: set ${key}`);
      expect(all).toContain('Nothing was fetched');
      expect(all).toContain('"status":"not_configured"');
      expect(all).toContain(`"missing_key":"${key}"`);
    }
  });

  it('the server instructions give the real count and point at list mode', () => {
    const s = client.getInstructions()!;
    expect(s).not.toMatch(/~\s*40|about 40|40 data tools/);
    expect(s).toContain(`(${allowed.length} right now)`);
    expect(s).toMatch(/Call find_tools with no query to list every available tool by category/);
  });
});
