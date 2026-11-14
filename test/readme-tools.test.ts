/**
 * The README's tool table lists every tool the connector can expose: the four direct tools,
 * every gateway and Pulse tool a gateway registers, and every allowlisted GEV tool.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_GEV_TOOL_ALLOWLIST, REPO_ROOT, loadConfig } from '../src/config.js';
import { buildCore } from '../src/gateway.js';
import { nullLogger } from '../src/log.js';
import { UPSTREAMS_DOWN } from './helpers.js';

const dir = mkdtempSync(path.join(tmpdir(), 'gw-readme-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('README tool table', () => {
  it('names every tool, each with a key/requirement cell', () => {
    const core = buildCore(
      loadConfig({ GATEWAY_MODE: 'test', DATA_DIR: dir, PULSE_URL: 'http://127.0.0.1:9' }),
      { logger: nullLogger, fetch: UPSTREAMS_DOWN },
    );
    const names = [
      'find_tools',
      'run_tool',
      'where_am_i',
      'whats_happening_here',
      ...core.registry.all().map((t) => t.name),
      ...DEFAULT_GEV_TOOL_ALLOWLIST,
    ];
    core.aviation.stop();
    core.db.close();
    const readme = readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
    const section = readme.slice(
      readme.indexOf('## Tools\n'),
      readme.indexOf('\n## ', readme.indexOf('## Tools\n') + 1),
    );
    const rows = section.split('\n').filter((l) => l.startsWith('| `'));
    const missing = names.filter((n) => !rows.some((r) => r.split('|')[1]!.includes(`\`${n}\``)));
    expect(missing).toEqual([]);
    for (const r of rows) expect(r.split('|').filter((c) => c.trim()).length, r).toBe(4);
  });
});
