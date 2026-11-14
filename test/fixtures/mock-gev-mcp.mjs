// Test double for GEV's stdio MCP server. Mimics GEV's hand-rolled JSON-RPC:
// newline-delimited, answers concurrently (out of order), duplicates data in a
// JSON text block and structuredContent, returns a JSON-RPC error (-32602) for
// unknown tools, and builds links from --api-base.
import { createInterface } from 'node:readline';
import sharp from 'sharp';

const apiBase = process.argv[process.argv.indexOf('--api-base') + 1] || 'http://127.0.0.1:7701';
const AREA = {
  type: 'object',
  properties: {
    place: { type: 'string', minLength: 1, maxLength: 200 },
    lat: { type: 'number', minimum: -90, maximum: 90 },
    lon: { type: 'number', minimum: -180, maximum: 180 },
    radius_km: { type: 'number', minimum: 0.1, maximum: 2000 },
  },
  additionalProperties: false,
};
const POINT = {
  type: 'object',
  properties: {
    place: { type: 'string', minLength: 1, maxLength: 200 },
    lat: { type: 'number', minimum: -90, maximum: 90 },
    lon: { type: 'number', minimum: -180, maximum: 180 },
  },
  additionalProperties: false,
};
const tool = (name, description, properties, required = []) => ({
  name,
  title: name,
  description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
  annotations: { title: name, readOnlyHint: true },
});
const TOOLS = [
  tool('get_weather', 'Current weather at a location.', { location: POINT }, ['location']),
  tool('find_cctv_cameras', 'Public cameras in an area, nearest first.', { area: AREA, limit: { type: 'integer', minimum: 1, maximum: 200 } }, ['area']),
  tool('get_cctv_snapshot', 'One camera image.', { camera_id: { type: 'string', minLength: 1, maxLength: 200 } }, ['camera_id']),
  tool('get_traffic_flow', 'TomTom traffic flow.', { area: AREA }, ['area']),
  tool('show_in_gods_eye_view', 'Build a view link.', { area: AREA }),
  tool('search_places', 'Google Places text search.', { query: { type: 'string' }, area: AREA }, ['query', 'area']),
  tool('places_nearby', 'Google nearby places.', { location: POINT }, ['location']),
  tool('aircraft_in_area', 'Aircraft in an area.', { area: AREA }, ['area']),
  tool('find_alpr_cameras', 'ALPR camera locations.', { area: AREA }, ['area']),
  tool('panel_request', 'Panel-only proxy.', { key: { type: 'string' }, path: { type: 'string' } }, ['key', 'path']),
  tool('get_recent_imagery', 'Latest clear satellite image.', { area: AREA }, ['area']),
  tool('plan_route', 'OSRM route.', { from: POINT, to: POINT }, ['from', 'to']),
  tool('crash_child', 'Test-only: exits the process.', {}),
  tool('slow_tool', 'Test-only: sleeps.', { ms: { type: 'integer' } }),
  tool('brand_new_tool', 'Not on any allowlist.', {}),
];

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const result = (summary, data, images = []) => ({
  content: [
    { type: 'text', text: summary },
    { type: 'text', text: JSON.stringify(data) },
    ...images.map((i) => ({ type: 'image', data: i.data, mimeType: i.mimeType })),
  ],
  structuredContent: data,
});
const viewFor = (lat, lon) => ({
  url: `${apiBase}/#v=2&lat=${lat}&lon=${lon}&alt=1500`,
  camera: { lat, lon, altitude_m: 1500 },
  layers: ['cctv'],
});

async function bigImage(w, h) {
  const raw = Buffer.alloc(w * h * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) >>> 24;
  const buf = await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
  return { mimeType: 'image/jpeg', data: buf.toString('base64') };
}

async function call(name, args) {
  switch (name) {
    case 'get_weather': {
      await sleep(30);
      const { lat, lon } = args.location;
      return result(`Clear, 3 °C at ${lat.toFixed(2)}, ${lon.toFixed(2)}.`, {
        view: viewFor(lat, lon),
        conditions: 'clear',
        temperature_c: 3,
        observed_at: new Date().toISOString(),
        credit: 'Open-Meteo',
      });
    }
    case 'find_cctv_cameras': {
      await sleep(5);
      return result('2 cameras within 3 km.', {
        view: viewFor(args.area.lat, args.area.lon),
        total: 2,
        returned: 2,
        cameras: [
          { id: 'cam-1', name: 'Main St at Ann Arbor Tr', distance_km: 0.4, provider: 'Test DOT' },
          { id: 'sv-1', name: 'Mill St', distance_km: 1.2, provider: 'Test DOT' },
        ],
      });
    }
    case 'get_cctv_snapshot': {
      const img = await bigImage(1600, 1200);
      if (args.camera_id === 'sv-1') {
        return result('Street View fallback for Mill St, courtesy of Google Street View.', {
          id: 'sv-1', provider: 'Google Street View', credit: 'Google Street View', source_kind: 'streetview', current_view: false,
        }, [img]);
      }
      return result('Current view from Main St, courtesy of Test DOT.', {
        view: viewFor(42.37, -83.47), id: args.camera_id, provider: 'Test DOT', source_kind: 'upstream-image', current_view: true,
      }, [img]);
    }
    case 'get_traffic_flow':
      if (process.env.MOCK_TOMTOM === '1') {
        return result('Traffic is moving: 2.1 km congested.', { congested_km: 2.1, closed_km: 0, observed_at: new Date().toISOString() });
      }
      return { content: [{ type: 'text', text: 'Live traffic needs a TomTom key' }], structuredContent: { error: 'unavailable' }, isError: true };
    case 'show_in_gods_eye_view':
      return result('Open the view.', { view: viewFor(args.area?.lat ?? 0, args.area?.lon ?? 0), url: `${apiBase}/#v=2` });
    case 'get_recent_imagery': {
      const img = await bigImage(2400, 1800);
      return result('Recent image.', { view: viewFor(0, 0), date: '2026-11-10' }, [img]);
    }
    case 'plan_route':
      return result('Route 2.3 km.', { distance_km: 2.3 });
    case 'crash_child':
      setTimeout(() => process.exit(3), 10);
      return result('bye', {});
    case 'slow_tool':
      await sleep(args.ms ?? 1000);
      return result('slow done', {});
    default:
      return result(`${name} ok`, { tool: name, args });
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  if (msg.id === undefined) return; // notification
  try {
    if (msg.method === 'initialize') {
      return send({ jsonrpc: '2.0', id: msg.id, result: {
        protocolVersion: msg.params?.protocolVersion ?? '2025-11-25',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'mock-gev', version: '0.0.1' },
      } });
    }
    if (msg.method === 'ping') return send({ jsonrpc: '2.0', id: msg.id, result: {} });
    if (msg.method === 'tools/list') return send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
    if (msg.method === 'tools/call') {
      const name = msg.params?.name;
      if (!TOOLS.some((t) => t.name === name)) {
        return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `Unknown tool: ${name}` } });
      }
      const res = await call(name, msg.params?.arguments ?? {});
      return send({ jsonrpc: '2.0', id: msg.id, result: res });
    }
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
  } catch (err) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(err?.message ?? err) } });
  }
});
rl.on('close', () => process.exit(0));
console.error(`mock GEV MCP server reading ${apiBase}`);
