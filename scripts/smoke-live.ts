/**
 * Live smoke test against a running gateway (dev or docker) with the real GEV preview + stdio child.
 * Mints a 5-minute token straight into the gateway's database (no OAuth), runs a few calls at
 * public test points, then revokes the token.
 *
 *   dev:    npm run smoke:live -- --url http://127.0.0.1:7700
 *   docker: docker exec godseye-gateway node dist/scripts/smoke-live.js
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { loadConfig, loadEnvFile } from '../src/config.js';
import { openDb } from '../src/db.js';
import { TokenStore } from '../src/oauth/tokens.js';

const DETROIT = { lat: 42.3314, lon: -83.0458 };
const ANN_ARBOR = { lat: 42.2808, lon: -83.743 };
const argUrl = process.argv.indexOf('--url');
if (process.env.GATEWAY_ENV_FILE !== 'none') loadEnvFile(process.env.GATEWAY_ENV_FILE || undefined);
const config = loadConfig();
// The public listener binds HOST (the compose-network address in docker, 127.0.0.1 in dev).
const bind = config.HOST === '0.0.0.0' || config.HOST === '::' ? '127.0.0.1' : config.HOST;
const url =
  argUrl > 0
    ? process.argv[argUrl + 1]!
    : `http://${bind.includes(':') ? `[${bind}]` : bind}:${config.PORT}`;

const db = openDb(config.dbPath);
const store = new TokenStore(db, {
  accessTtlS: 300,
  refreshTtlS: 300,
  codeTtlS: 60,
  reuseGraceS: 0,
});
const { tokens, familyId } = store.issue({
  clientId: 'smoke-live',
  subject: 'smoke-live',
  scope: 'mcp',
  resource: config.mcpResource,
});

type Res = { content: Array<{ type: string; text?: string }>; isError?: boolean };
const text = (r: Res) =>
  r.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail: string) => {
  results.push([name, ok, detail]);
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}\n      ${detail.replace(/\n/g, '\n      ').slice(0, 1600)}`,
  );
};

const client = new Client({ name: 'smoke-live', version: '0.1.0' });
try {
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } },
    }),
  );
  const { tools } = await client.listTools();
  check(
    'tools/list exposes exactly 4 tools',
    tools.length === 4,
    tools.map((t) => t.name).join(', '),
  );

  // Wait for the GEV stdio child to index its catalog.
  let gevReady = false;
  for (let i = 0; i < 60 && !gevReady; i++) {
    const r = (await client.callTool({
      name: 'find_tools',
      arguments: { query: 'weather', limit: 3 },
    })) as Res;
    gevReady = text(r).includes('get_weather');
    if (!gevReady) await new Promise((res) => setTimeout(res, 1000));
  }
  check(
    'GEV tools indexed',
    gevReady,
    gevReady ? 'get_weather is searchable' : 'GEV child not ready after 60 s',
  );

  const ft = (await client.callTool({
    name: 'find_tools',
    arguments: { query: 'train crossing' },
  })) as Res;
  const names = (
    JSON.parse(ft.content[1]!.text!) as { results: Array<{ name: string }> }
  ).results.map((x) => x.name);
  check(
    'find_tools("train crossing") returns nearest_rail',
    names.includes('nearest_rail'),
    names.join(', '),
  );

  const t0 = Date.now();
  const w = (await client.callTool({
    name: 'run_tool',
    arguments: { name: 'get_weather', arguments: { location: DETROIT } },
  })) as Res;
  check(
    `run_tool get_weather at Detroit (${Date.now() - t0} ms)`,
    !w.isError && !text(w).includes('127.0.0.1'),
    text(w).slice(0, 700),
  );

  const nr = (await client.callTool({
    name: 'run_tool',
    arguments: { name: 'nearest_rail', arguments: ANN_ARBOR },
  })) as Res;
  check(
    'run_tool nearest_rail at Ann Arbor',
    !nr.isError && /crossing/i.test(text(nr)),
    text(nr).split('\n')[0]!,
  );

  const t1 = Date.now();
  const wh = (await client.callTool(
    { name: 'whats_happening_here', arguments: { ...DETROIT, radius_km: 3 } },
    { timeout: 120_000 },
  )) as Res;
  const whText = text(wh);
  check(
    `whats_happening_here at Detroit (${Date.now() - t1} ms)`,
    !wh.isError && /Rail line & crossing/.test(whText) && /Weather/.test(whText),
    whText.split('\n\n')[0]!,
  );

  const denied = (await client.callTool({
    name: 'run_tool',
    arguments: {
      name: 'search_places',
      arguments: { query: 'coffee', area: { ...DETROIT, radius_km: 2 } },
    },
  })) as Res;
  check(
    'Google-backed tool is denied',
    Boolean(denied.isError) && /Google/.test(text(denied)),
    text(denied),
  );
} catch (err) {
  check('smoke run', false, err instanceof Error ? (err.stack ?? err.message) : String(err));
} finally {
  await client.close().catch(() => undefined);
  store.revokeFamily(familyId, 'smoke_test_done');
  db.close();
}
const failed = results.filter((r) => !r[1]).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
