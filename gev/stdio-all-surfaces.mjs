// God's Eye View MCP server over stdio, with every core tool on the MCP surface.
//
// Adapted from God's Eye View server/mcp/stdio.js and server/mcp/server.js
// (https://github.com/bilawalsidhu/gods-eye-view @ 083da40d).
// Copyright (c) 2026 Bilawal Sidhu. MIT License; full notice in
// third_party/gods-eye-view/LICENSE.
//
// Differences from upstream stdio.js:
//  * TOOL_SURFACES is a frozen constant upstream, so this wrapper composes the
//    'mcp' surface with an override that turns every core tool on (40 tools).
//  * No ui:// resources are served, and the panel key is a random value held
//    only in this process's memory (never written to .gev-cache). panel_request
//    therefore cannot be used even if a caller learns the tool exists; the
//    gateway never exposes it anyway.
//  * Reads no environment except GEV_ROOT (where the GEV clone lives).
//
// Usage: GEV_ROOT=/abs/path/to/gods-eye-view node stdio-all-surfaces.mjs --api-base http://127.0.0.1:7701
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const root = process.env.GEV_ROOT;
if (!root) {
  console.error('[gev-wrapper] GEV_ROOT is required');
  process.exit(2);
}
const mod = (p) => import(pathToFileURL(`${root}/${p}`).href);

const { composeCatalog, coreTools, catalogForSurface } = await mod('src/tools/index.js');
const { createMcpServer } = await mod('src/tools/mcp/index.js');
const { createLocalToolServices, DEFAULT_API_BASE } = await mod('server/mcp/services.js');
const { serveStdio, parseArgs } = await mod('server/mcp/stdio.js');

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(`[gev-wrapper] ${error.message}`);
  process.exit(2);
}
const apiBase = options.apiBase || DEFAULT_API_BASE;
console.error(`[gev-wrapper] God's Eye View MCP server (all surfaces) reading ${apiBase}`);

const panelKey = `unused-${randomBytes(24).toString('hex')}`;
const catalog = composeCatalog({
  tools: coreTools,
  services: createLocalToolServices({ apiBase, panelKey }),
});
const overrides = Object.fromEntries(catalog.list().map((tool) => [tool.name, { mcp: true }]));
const { version } = JSON.parse(readFileSync(`${root}/package.json`, 'utf8'));
const server = createMcpServer({
  catalog: catalogForSurface(catalog, 'mcp', overrides),
  name: 'gods-eye-view',
  version,
  instructions: "God's Eye View tools (all surfaces), consumed by godseye-detroit-connector.",
  resources: [],
});

const stop = () => process.exit(0);
process.stdin.on('end', stop);
process.on('SIGTERM', stop);

await serveStdio(server, {
  input: process.stdin,
  output: process.stdout,
  log: (line) => console.error(`<- ${line}`),
});
