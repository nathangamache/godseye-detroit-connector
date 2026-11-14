/**
 * Neutral wording: the connector talks about "the user" (or "you", "the owner"), never with a
 * gendered pronoun, in the server instructions, tool descriptions, notes and every source and
 * doc file.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, loadConfig } from '../src/config.js';
import { proximityCheck } from '../src/location/proximity.js';
import { serverInstructions } from '../src/mcp/server.js';
import { noFixMessage, whereAmI } from '../src/mcp/whatsHappening.js';
import { DETROIT } from './helpers.js';

const GENDERED = /\b(he|him|his|himself|she|her|hers|herself)\b/i;

function files(dir: string, ext: RegExp): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p, ext));
    else if (ext.test(name)) out.push(p);
  }
  return out;
}

describe('neutral wording', () => {
  it('the server instructions speak of the user, with no gendered pronoun', () => {
    const t = serverInstructions('https://ui.example');
    expect(t).not.toMatch(GENDERED);
    expect(t).toMatch(/for the user, near Detroit/);
    expect(t).toMatch(/Always tell the user how old the data is/);
    expect(t).toMatch(/the user's phone location/);
  });

  it('the no-fix hint, the stale warning and the phone check name nobody', () => {
    const config = loadConfig({});
    const hint = noFixMessage('https://private.example', 24);
    expect(hint).not.toMatch(GENDERED);
    expect(hint).toMatch(
      /^No phone location fix .* Ask the user to open https:\/\/private\.example\/locate\//,
    );
    const now = Date.parse('2026-11-14T12:00:00Z');
    const store = {
      latest: () => ({
        lat: DETROIT.lat,
        lon: DETROIT.lon,
        accuracy_m: 10,
        fix_ts: now - 3_600_000,
        device: 'phone',
        source: 'pwa',
      }),
    };
    const stale = whereAmI(store as never, config, now).content[0]!.text!;
    expect(stale).toMatch(/STALE: .* so the user may have moved/);
    expect(stale).not.toMatch(GENDERED);
    for (const dLat of [0.001, 0.02]) {
      const note = proximityCheck(
        DETROIT,
        { ...store.latest(), lat: DETROIT.lat + dLat, fix_ts: now - 60_000 },
        now,
        30,
      )!.note;
      expect(note).toMatch(/^Phone check: the user's latest phone fix/);
      expect(note).not.toMatch(GENDERED);
    }
  });

  it('no source file, doc or README uses a gendered pronoun', () => {
    const offenders: string[] = [];
    const all = [
      ...files(path.join(REPO_ROOT, 'src'), /\.ts$/),
      ...files(path.join(REPO_ROOT, 'docs'), /\.md$/),
      path.join(REPO_ROOT, 'README.md'),
      path.join(REPO_ROOT, '.env.example'),
    ];
    for (const f of all)
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (GENDERED.test(line)) offenders.push(`${path.relative(REPO_ROOT, f)}:${i + 1}`);
        });
    expect(offenders).toEqual([]);
  });
});
