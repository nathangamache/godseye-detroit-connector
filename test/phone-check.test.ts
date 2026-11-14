/**
 * Owner-location awareness: a tool called for an explicit point, while Nathan's latest phone
 * fix is recent, says how far the phone is from that point (km, compass bearing from the point
 * to the phone, fix age) and says plainly when the phone is not there. The note never carries
 * the phone's coordinates, and it is audited as a location read.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { REPO_ROOT, loadConfig } from '../src/config.js';
import { startGateway, type Gateway } from '../src/gateway.js';
import { childSpawnSpec } from '../src/gev/child.js';
import { nullLogger } from '../src/log.js';
import { bearingDeg, compassPoint, haversineM } from '../src/util/geo.js';
import { DETROIT, MOCK_GEV, waitFor } from './helpers.js';

let gw: Gateway;
let dir: string;
let client: Client;
let familyId: string;
let device: number;

/** The place asked about (public test point) and a phone fix ~2.5 km WSW of it. */
const PLACE = DETROIT;
const PHONE = { lat: 42.32283, lon: -83.07327 };
const NEAR = { lat: 42.33318, lon: -83.04391 }; // ~0.2 km from PLACE

const text = (r: { content: unknown }) =>
  (r.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n');

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'gw-phone-'));
  const config = loadConfig({
    GATEWAY_MODE: 'test',
    PORT: '0',
    PRIVATE_PORT: '0',
    UI_PORT: '0',
    DATA_DIR: dir,
    PULSE_URL: 'http://127.0.0.1:9',
    PULSE_TIMEOUT_MS: '500',
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
  const issued = gw.tokens.issue({
    clientId: 'phone-check-client',
    subject: 'owner',
    scope: 'mcp',
    resource: config.mcpResource,
  });
  familyId = issued.familyId;
  client = new Client({ name: 't', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${gw.url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${issued.tokens.access_token}` } },
    }),
  );
  device = gw.locations.createDevice('phone').id;
});

afterAll(async () => {
  await client?.close();
  await gw?.close();
  rmSync(dir, { recursive: true, force: true });
});

function fix(at: { lat: number; lon: number }, minutesAgo: number) {
  gw.locations.insert({
    deviceId: device,
    ...at,
    accuracyM: 15,
    fixTs: Date.now() - minutesAgo * 60_000,
    source: 'pwa',
  });
}

const proximityReads = () =>
  gw.audit
    .recent(200, 'access')
    .filter(
      (r) => r.event === 'location_read' && JSON.parse(r.detail!).purpose === 'proximity_check',
    );

const expectedKm = (
  Math.round(haversineM(PLACE.lat, PLACE.lon, PHONE.lat, PHONE.lon) / 100) / 10
).toFixed(1);
const expectedDir = compassPoint(bearingDeg(PLACE.lat, PLACE.lon, PHONE.lat, PHONE.lon));

describe('phone check on explicit-point calls', () => {
  beforeEach(() => {
    gw.db.prepare('DELETE FROM locations').run();
  });

  it('whats_happening_here for a place away from the phone says the phone is NOT there', async () => {
    fix(PHONE, 4);
    const before = proximityReads().length;
    const r = await client.callTool({
      name: 'whats_happening_here',
      arguments: { ...PLACE, radius_km: 2 },
    });
    const t = text(r);
    expect(expectedKm).toBe('2.5');
    expect(expectedDir).toBe('WSW');
    expect(t).toContain(
      `Phone check: Nathan's latest phone fix (4 min old) is 2.5 km WSW of this point, so his phone is NOT at this place.`,
    );
    expect(t).toMatch(
      /"owner_phone":\{"distance_km":2\.5,"bearing_from_point_deg":\d+,"compass_from_point":"WSW","fix_age_s":2\d\d,"at_this_place":false\}/,
    );
    // Never the phone's coordinates, in any form.
    for (const v of [PHONE.lat, PHONE.lon])
      for (const d of [5, 4]) expect(t).not.toContain(v.toFixed(d));
    // Audited as a location read for this grant, without coordinates.
    const reads = proximityReads();
    expect(reads.length).toBe(before + 1);
    expect(JSON.parse(reads[0]!.detail!)).toMatchObject({
      family: familyId,
      tool: 'whats_happening_here',
      fix: true,
      purpose: 'proximity_check',
    });
    expect(reads[0]!.detail).not.toMatch(/42\.3|83\.0/);
  });

  it('run_tool rail and GEV tools get the note first in the result', async () => {
    fix(PHONE, 2);
    for (const [name, args] of [
      ['crossings_near', { ...PLACE, radius_km: 1 }],
      ['nearest_rail', PLACE],
      ['get_weather', { location: PLACE }],
    ] as const) {
      const before = proximityReads().length;
      const r = await client.callTool({ name: 'run_tool', arguments: { name, arguments: args } });
      const first = (r.content as Array<{ text: string }>)[0]!.text;
      expect(
        first.startsWith(
          `Phone check: Nathan's latest phone fix (2 min old) is 2.5 km WSW of this point`,
        ),
        name,
      ).toBe(true);
      expect(first).toMatch(/NOT at this place/);
      expect(text(r)).not.toContain(PHONE.lat.toFixed(4));
      expect(proximityReads().length).toBe(before + 1);
      expect(JSON.parse(proximityReads()[0]!.detail!).tool).toBe(name);
    }
  });

  it('within 0.5 km it says the phone is there', async () => {
    fix(NEAR, 1);
    const r = await client.callTool({
      name: 'run_tool',
      arguments: { name: 'nearest_rail', arguments: PLACE },
    });
    expect((r.content as Array<{ text: string }>)[0]!.text).toMatch(
      /^Phone check: Nathan's latest phone fix \(\d+ s old\) is 0\.\d km [NESW]+ of this point, so his phone is at or very near this place\./,
    );
  });

  it('no note (and no location read) without a recent fix or without an explicit point', async () => {
    const before = proximityReads().length;
    let r = await client.callTool({
      name: 'run_tool',
      arguments: { name: 'nearest_rail', arguments: PLACE },
    });
    expect(text(r)).not.toMatch(/Phone check/);
    fix(PHONE, 45); // older than LOCATION_PROXIMITY_MINUTES (30)
    r = await client.callTool({ name: 'whats_happening_here', arguments: PLACE });
    expect(text(r)).not.toMatch(/Phone check/);
    expect(text(r)).not.toMatch(/owner_phone/);
    fix(PHONE, 1);
    r = await client.callTool({
      name: 'run_tool',
      arguments: { name: 'feeds_status', arguments: {} },
    });
    expect(text(r)).not.toMatch(/Phone check/);
    // whats_happening_here on the phone's own position needs no phone check.
    r = await client.callTool({ name: 'whats_happening_here', arguments: {} });
    expect(text(r)).not.toMatch(/Phone check/);
    expect(proximityReads().length).toBe(before);
  });

  it('the instructions say to start "I\'m here / stuck" questions from where_am_i', () => {
    expect(client.getInstructions()).toMatch(
      /"I'm here \/ I'm stuck at X \/ near me" questions, call where_am_i first and compare/,
    );
  });
});
