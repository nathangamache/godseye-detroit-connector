/**
 * Border wait times at the Detroit/Windsor and Port Huron/Sarnia crossings: U.S.-bound from the
 * CBP Border Wait Times API, Canada-bound from CBSA's bwt CSV. Both keyless, cached 5 minutes.
 */
import { TtlCache, errorText, type Http } from './http.js';
import { cleanText } from './text.js';

export const CROSSINGS = ['ambassador', 'tunnel', 'gordie_howe', 'blue_water'] as const;
export type Crossing = (typeof CROSSINGS)[number];
export type Direction = 'to_us' | 'to_canada';

export const BORDER_ATTRIBUTION =
  'U.S.-bound: U.S. Customs and Border Protection Border Wait Times (bwt.cbp.gov). Canada-bound: Canada Border Services Agency border wait times; contains information licensed under the Open Government Licence – Canada';

const NAMES: Record<Crossing, { label: string; cbpPort: string; match: RegExp }> = {
  ambassador: { label: 'Ambassador Bridge', cbpPort: '380001', match: /ambassador/i },
  tunnel: { label: 'Detroit-Windsor Tunnel', cbpPort: '380002', match: /tunnel/i },
  gordie_howe: {
    label: 'Gordie Howe International Bridge',
    cbpPort: '380102',
    match: /gordie\s*howe/i,
  },
  blue_water: { label: 'Blue Water Bridge', cbpPort: '380201', match: /blue\s*water/i },
};

export interface WaitRow {
  crossing: Crossing;
  crossing_name: string;
  direction: Direction;
  lane_type: string;
  delay_min: number | null;
  lanes_open: number | null;
  status: string;
  updated: string | null;
  source: 'CBP' | 'CBSA';
}

const TZ: Record<string, string> = {
  EST: '-05:00',
  EDT: '-04:00',
  CST: '-06:00',
  CDT: '-05:00',
  AST: '-04:00',
  ADT: '-03:00',
  MST: '-07:00',
  MDT: '-06:00',
  PST: '-08:00',
  PDT: '-07:00',
};

function iso(date: string, h: number, min: number, tz: string): string | null {
  const off = TZ[tz.toUpperCase()];
  if (!off || !/^\d{4}-\d{2}-\d{2}$/.test(date) || h > 23 || min > 59) return null;
  return `${date}T${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}:00${off}`;
}

/** CBP "At 4:00 pm EST" on the feed's date "11/14/2026" -> ISO with offset. */
export function cbpTime(feedDate: unknown, updateTime: unknown): string | null {
  const d = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(feedDate ?? '').trim());
  const t = /(\d{1,2}):(\d{2})\s*([ap])\.?m\.?\s*([A-Z]{3})/i.exec(String(updateTime ?? ''));
  if (!d || !t) return null;
  let h = Number(t[1]) % 12;
  if (t[3]!.toLowerCase() === 'p') h += 12;
  return iso(`${d[3]}-${d[1]!.padStart(2, '0')}-${d[2]!.padStart(2, '0')}`, h, Number(t[2]), t[4]!);
}

const numOrNull = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

export function parseCbp(j: unknown): WaitRow[] {
  if (!Array.isArray(j)) return [];
  const out: WaitRow[] = [];
  for (const raw of j) {
    const p = raw as Record<string, unknown>;
    const name = `${p.port_name ?? ''} ${p.crossing_name ?? ''}`;
    const crossing = CROSSINGS.find(
      (c) =>
        String(p.port_number ?? '') === NAMES[c].cbpPort ||
        (/detroit|port huron/i.test(name) && NAMES[c].match.test(name)),
    );
    if (!crossing) continue;
    const groups: Array<[string, string, unknown]> = [];
    const pv = (p.passenger_vehicle_lanes ?? {}) as Record<string, unknown>;
    const cv = (p.commercial_vehicle_lanes ?? {}) as Record<string, unknown>;
    const ped = (p.pedestrian_lanes ?? {}) as Record<string, unknown>;
    groups.push(['passenger', 'standard_lanes', pv.standard_lanes]);
    groups.push(['passenger NEXUS/SENTRI', 'NEXUS_SENTRI_lanes', pv.NEXUS_SENTRI_lanes]);
    groups.push(['passenger Ready Lane', 'ready_lanes', pv.ready_lanes]);
    groups.push(['commercial', 'standard_lanes', cv.standard_lanes]);
    groups.push(['commercial FAST', 'FAST_lanes', cv.FAST_lanes]);
    groups.push(['pedestrian', 'standard_lanes', ped.standard_lanes]);
    for (const [laneType, , lane] of groups) {
      const l = (lane ?? {}) as Record<string, unknown>;
      const status = cleanText(l.operational_status, 40) ?? 'unknown';
      if (/^n\/a$/i.test(status)) continue;
      const closed = /closed/i.test(status);
      out.push({
        crossing,
        crossing_name: NAMES[crossing].label,
        direction: 'to_us',
        lane_type: laneType,
        delay_min: closed ? null : numOrNull(l.delay_minutes),
        lanes_open: closed ? 0 : numOrNull(l.lanes_open),
        status: String(p.port_status ?? '').toLowerCase() === 'closed' ? 'port closed' : status,
        updated: cbpTime(p.date, l.update_time),
        source: 'CBP',
      });
    }
  }
  return out;
}

/** CBSA "2026-11-14 15:13 EST" -> ISO with offset. */
function cbsaTime(s: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})\s*([A-Z]{3})$/.exec(s.trim());
  return m ? iso(m[1]!, Number(m[2]), Number(m[3]), m[4]!) : null;
}

function cbsaDelay(v: string): { delay: number | null; status: string } | undefined {
  const s = v.trim();
  if (!s || s === '--' || /not applicable/i.test(s)) return undefined;
  if (/no delay/i.test(s)) return { delay: 0, status: 'no delay' };
  if (/closed/i.test(s)) return { delay: null, status: 'closed' };
  const m = /(\d+)\s*(?:min|minute)/i.exec(s);
  const h = /(\d+)\s*(?:h|hour)/i.exec(s);
  if (m || h) {
    const d = (h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0);
    return { delay: d, status: d ? 'delay' : 'no delay' };
  }
  return { delay: null, status: cleanText(s, 40) ?? 'unknown' };
}

/** The CBSA CSV: ";;"-separated, with a BOM and mixed line endings. */
export function parseCbsa(csv: string): WaitRow[] {
  const lines = csv
    .replace(/^\s*/, '')
    .split(/\r?\n/)
    .filter((l) => l.trim());
  if (lines.length < 2) return [];
  const split = (l: string) => l.split(';;').map((c) => c.trim());
  const head = split(lines[0]!).map((h) => h.toLowerCase());
  const col = (re: RegExp) => head.findIndex((h) => re.test(h));
  const iName = col(/customs office/);
  const iUpd = col(/last updated/);
  const cols: Array<[number, string, Direction]> = [
    [col(/commercial.*canada/), 'commercial', 'to_canada'],
    [col(/travel+ers.*canada/), 'passenger', 'to_canada'],
    [col(/commercial.*\bu\.?s\.?\s*bound/), 'commercial', 'to_us'],
    [col(/travel+ers.*\bu\.?s\.?\s*bound/), 'passenger', 'to_us'],
  ];
  const out: WaitRow[] = [];
  for (const l of lines.slice(1, 500)) {
    const c = split(l);
    const name = c[iName] ?? '';
    const crossing = CROSSINGS.find(
      (k) => NAMES[k].match.test(name) && (k !== 'tunnel' || /windsor|detroit/i.test(name)),
    );
    if (!crossing) continue;
    for (const [i, laneType, direction] of cols) {
      if (i < 0) continue;
      const d = cbsaDelay(c[i] ?? '');
      if (!d) continue;
      out.push({
        crossing,
        crossing_name: NAMES[crossing].label,
        direction,
        lane_type: laneType,
        delay_min: d.delay,
        lanes_open: null,
        status: d.status,
        updated: cbsaTime(c[iUpd] ?? ''),
        source: 'CBSA',
      });
    }
  }
  return out;
}

export interface BorderService {
  rows(): Promise<{ rows: WaitRow[]; errors: string[]; ages: Record<string, number> }>;
}

/**
 * Both feeds are fetched for everyone and cached 5 minutes, so a load is not tied to one
 * caller's signal (the tool's own timeout still bounds the call).
 */
export function borderService(o: {
  http: Http;
  cbpUrl: string;
  cbsaUrl: string;
  now: () => number;
}): BorderService {
  const cbp = new TtlCache<WaitRow[]>(300_000, o.now, 60_000);
  const cbsa = new TtlCache<WaitRow[]>(300_000, o.now, 60_000);
  return {
    async rows() {
      const [a, b] = await Promise.allSettled([
        cbp.get('cbp', async () =>
          parseCbp(
            await o.http.json('CBP border wait times', o.cbpUrl, { maxBytes: 4 * 1024 * 1024 }),
          ),
        ),
        cbsa.get('cbsa', async () =>
          parseCbsa(
            await o.http.text('CBSA border wait times', o.cbsaUrl, {
              accept: 'text/csv,*/*',
              maxBytes: 1024 * 1024,
            }),
          ),
        ),
      ]);
      const rows: WaitRow[] = [];
      const errors: string[] = [];
      const ages: Record<string, number> = {};
      if (a.status === 'fulfilled') {
        rows.push(...a.value.value);
        ages.CBP = Math.round(a.value.ageMs / 1000);
      } else errors.push(`U.S.-bound (CBP): ${errorText(a.reason)}`);
      if (b.status === 'fulfilled') {
        rows.push(...b.value.value);
        ages.CBSA = Math.round(b.value.ageMs / 1000);
      } else errors.push(`Canada-bound (CBSA): ${errorText(b.reason)}`);
      return { rows, errors, ages };
    },
  };
}

export function crossingLabel(c: Crossing): string {
  return NAMES[c].label;
}
