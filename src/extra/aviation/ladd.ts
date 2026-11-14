/**
 * Which aircraft are on the FAA's LADD list (owners who asked to limit display). The FAA
 * publishes no list, so two signals are combined:
 *  - live dbFlags bit 8 from the feeds (kept in memory for a day, never written to disk: they
 *    come from the user's own queries, so a file of them would hint at where the user was);
 *  - adsb.lol's /v2/ladd (the LADD aircraft it tracks right now, worldwide). Each fetch is merged
 *    into a list kept on disk for 60 days, hex codes and day numbers only.
 * Not being flagged never proves an aircraft is not on LADD.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const LIVE_TTL_MS = 24 * 3_600_000;
const LIST_TTL_DAYS = 60;
const MAX_LIVE = 5000;
const DAY_MS = 86_400_000;

export class LaddTracker {
  private readonly live = new Map<string, number>();
  private list = new Map<string, number>();
  private listFetchedAt = 0;
  private loaded = false;
  private readonly file?: string;

  constructor(
    dir: string | undefined,
    private readonly now: () => number = Date.now,
  ) {
    this.file = dir ? path.join(dir, 'ladd-list.json') : undefined;
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.file) return;
    try {
      const j = JSON.parse(readFileSync(this.file, 'utf8')) as {
        fetched_at?: number;
        hexes?: Record<string, number>;
      };
      const today = Math.floor(this.now() / DAY_MS);
      for (const [hex, day] of Object.entries(j.hexes ?? {}))
        if (/^[0-9a-f]{6}$/.test(hex) && Number.isInteger(day) && today - day <= LIST_TTL_DAYS)
          this.list.set(hex, day);
      if (typeof j.fetched_at === 'number') this.listFetchedAt = j.fetched_at;
    } catch {
      /* none yet */
    }
  }

  /** Records a live flag (dbFlags & 8). */
  noteLive(hex: string, dbFlags: number): void {
    if (!(dbFlags & 8)) return;
    const h = hex.toLowerCase();
    this.live.delete(h);
    this.live.set(h, this.now() + LIVE_TTL_MS);
    while (this.live.size > MAX_LIVE) this.live.delete(this.live.keys().next().value!);
  }

  has(hex: string): boolean {
    this.load();
    const h = hex.toLowerCase();
    const exp = this.live.get(h);
    if (exp !== undefined) {
      if (exp > this.now()) return true;
      this.live.delete(h);
    }
    return this.list.has(h);
  }

  /** The adsb.lol list is refreshed at most every 6 hours. */
  listIsStale(): boolean {
    this.load();
    return this.now() - this.listFetchedAt > 6 * 3_600_000;
  }

  get listAgeS(): number | undefined {
    this.load();
    return this.listFetchedAt ? Math.round((this.now() - this.listFetchedAt) / 1000) : undefined;
  }

  mergeList(hexes: string[]): void {
    this.load();
    const today = Math.floor(this.now() / DAY_MS);
    for (const h of hexes) if (/^[0-9a-f]{6}$/i.test(h)) this.list.set(h.toLowerCase(), today);
    for (const [h, day] of this.list) if (today - day > LIST_TTL_DAYS) this.list.delete(h);
    this.listFetchedAt = this.now();
    if (!this.file) return;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      writeFileSync(
        this.file,
        JSON.stringify({ fetched_at: this.listFetchedAt, hexes: Object.fromEntries(this.list) }),
        { mode: 0o600 },
      );
    } catch {
      /* kept in memory */
    }
  }

  /** Marks a failed refresh so it is not retried on every lookup (tries again in an hour). */
  noteRefreshFailed(): void {
    this.load();
    this.listFetchedAt = Math.max(this.listFetchedAt, this.now() - 5 * 3_600_000);
  }
}
