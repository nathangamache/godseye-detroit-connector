/**
 * US units for the user: temperatures in F (with C alongside, "39 F (4 C)") and wind in mph in
 * every text the gateway composes or passes on from God's Eye View's weather tools. GEV reports
 * Open-Meteo values in C and km/h and its tools take no units argument, so the gateway converts
 * their results (adding *_f / *_mph fields next to the metric ones) instead of changing GEV.
 * Should a GEV tool ever accept a units argument, imperial is asked for by default.
 */
import type { JsonSchema, ToolOutput } from './types.js';

export const cToF = (c: number): number => (c * 9) / 5 + 32;
export const kphToMph = (kph: number): number => kph / 1.609344;

/** "39 F (4 C)". */
export function tempText(c: number): string {
  return `${Math.round(cToF(c))} F (${Math.round(c)} C)`;
}

/** "7 mph". */
export function windText(kph: number): string {
  return `${Math.round(kphToMph(kph))} mph`;
}

const TEMP_C = /(-?\d+(?:\.\d+)?)\s?°\s?C\b/g;
const SPEED_KPH = /(\d+(?:\.\d+)?)\s?km\/h\b/g;

/** The precise value behind a rounded number in a text, when one rounds to it. */
function precise(shown: number, hints: number[]): number {
  return hints.find((h) => Math.round(h) === Math.round(shown)) ?? shown;
}

/**
 * Metric temperatures and wind speeds in a text, in US units: "4°C" -> "39 F (4 C)",
 * "12 km/h" -> "7 mph". A hint (the unrounded value from the tool's data) that rounds to the
 * number shown is converted instead, so 4.4 C reads 40 F rather than 39 F.
 */
export function imperialText(
  text: string,
  hints: { tempsC?: number[]; windsKph?: number[] } = {},
): string {
  return text
    .replace(TEMP_C, (_m, n: string) => tempText(precise(Number(n), hints.tempsC ?? [])))
    .replace(SPEED_KPH, (_m, n: string) => windText(precise(Number(n), hints.windsKph ?? [])));
}

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const round1 = (v: number) => Math.round(v * 10) / 10;

/** Adds temperature_f / feels_like_f / wind_mph next to a weather row's metric fields. */
function imperialRow(row: Record<string, unknown>): {
  row: Record<string, unknown>;
  tempsC: number[];
  windsKph: number[];
} {
  const t = num(row.temperature_c);
  const f = num(row.feels_like_c);
  const w = num(row.wind_kph);
  return {
    row: {
      ...row,
      ...(t !== undefined ? { temperature_f: round1(cToF(t)) } : {}),
      ...(f !== undefined ? { feels_like_f: round1(cToF(f)) } : {}),
      ...(w !== undefined ? { wind_mph: round1(kphToMph(w)) } : {}),
    },
    tempsC: [t, f].filter((x): x is number => x !== undefined),
    windsKph: w !== undefined ? [w] : [],
  };
}

/** GEV tools whose results carry Open-Meteo / model weather in metric units. */
export const GEV_WEATHER_TOOLS = new Set(['get_weather', 'get_regional_brief', 'get_wind']);

/**
 * A GEV weather result in US units: the summary converted (F with C, mph) and imperial fields
 * added beside the metric ones in data (data.weather for get_weather / get_regional_brief,
 * speed_mph for get_wind). Other tools, and errors, pass through unchanged.
 */
export function imperialGevOutput(tool: string, out: ToolOutput): ToolOutput {
  if (!GEV_WEATHER_TOOLS.has(tool) || out.isError) return out;
  const data =
    out.data && typeof out.data === 'object' && !Array.isArray(out.data)
      ? (out.data as Record<string, unknown>)
      : undefined;
  const tempsC: number[] = [];
  const windsKph: number[] = [];
  let next: Record<string, unknown> | undefined = data;
  if (data) {
    const w = data.weather;
    if (w && typeof w === 'object' && !Array.isArray(w)) {
      const r = imperialRow(w as Record<string, unknown>);
      next = { ...data, weather: r.row };
      tempsC.push(...r.tempsC);
      windsKph.push(...r.windsKph);
    } else if ('temperature_c' in data || 'wind_kph' in data) {
      const r = imperialRow(data);
      next = r.row;
      tempsC.push(...r.tempsC);
      windsKph.push(...r.windsKph);
    }
    const speed = num(data.speed_kph);
    if (speed !== undefined) {
      next = { ...next, speed_mph: round1(kphToMph(speed)) };
      windsKph.push(speed);
    }
  }
  return {
    ...out,
    summary: imperialText(out.summary, { tempsC, windsKph }),
    ...(next !== undefined ? { data: next } : {}),
  };
}

/** A GEV tool that takes a units argument gets the US choice unless the caller set one. */
export function withImperialDefault(
  schema: JsonSchema,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const units = (schema.properties as Record<string, { enum?: unknown[] }> | undefined)?.units;
  if (!units || args.units !== undefined) return args;
  const choice = (units.enum ?? []).find(
    (v) => typeof v === 'string' && /^(imperial|us|fahrenheit)$/i.test(v),
  );
  return choice === undefined ? args : { ...args, units: choice };
}
