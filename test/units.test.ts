/**
 * US units: GEV's weather (Open-Meteo, C and km/h) reaches the user as "39 F (4 C)" and mph,
 * with imperial fields added beside the metric ones; a GEV tool that ever takes a units argument
 * is asked for imperial by default; GEV itself is not changed.
 */
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { ToolPolicy } from '../src/tools/policy.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { ToolOutput } from '../src/tools/types.js';
import {
  cToF,
  imperialGevOutput,
  imperialText,
  kphToMph,
  tempText,
  windText,
} from '../src/tools/units.js';

/** get_weather as GEV answers it (src/tools/queries/environment.js in GEV). */
const GEV_WEATHER: ToolOutput = {
  summary: 'Weather at 42.3314, -83.0458: overcast, 4°C, wind 12 km/h.',
  data: {
    location: { lat: 42.3314, lon: -83.0458, label: '42.3314, -83.0458' },
    weather: {
      observed_at: '2026-11-14T16:45:00Z',
      conditions: 'overcast',
      temperature_c: 4.4,
      feels_like_c: 0.6,
      wind_kph: 12.2,
      wind_direction_deg: 270,
    },
    stale: false,
  },
};

describe('unit conversion', () => {
  it('converts temperatures to F (with C) and speeds to mph', () => {
    expect(cToF(0)).toBe(32);
    expect(cToF(-40)).toBe(-40);
    expect(kphToMph(100)).toBeCloseTo(62.14, 2);
    expect(tempText(4)).toBe('39 F (4 C)');
    expect(tempText(-5)).toBe('23 F (-5 C)');
    expect(windText(12)).toBe('7 mph');
    expect(imperialText('clear, 3 °C, wind 20 km/h')).toBe('clear, 37 F (3 C), wind 12 mph');
    // The unrounded value from data wins when it rounds to the number shown.
    expect(imperialText('4°C', { tempsC: [4.4] })).toBe('40 F (4 C)');
    expect(imperialText('nothing metric here, 5 C')).toBe('nothing metric here, 5 C');
  });

  it('get_weather: summary in F and mph, imperial fields beside the metric ones', () => {
    const out = imperialGevOutput('get_weather', GEV_WEATHER);
    expect(out.summary).toBe('Weather at 42.3314, -83.0458: overcast, 40 F (4 C), wind 8 mph.');
    expect((out.data as { weather: Record<string, unknown> }).weather).toMatchObject({
      temperature_c: 4.4,
      temperature_f: 39.9,
      feels_like_c: 0.6,
      feels_like_f: 33.1,
      wind_kph: 12.2,
      wind_mph: 7.6,
    });
    // get_wind and get_regional_brief too; errors and other tools are untouched.
    const wind = imperialGevOutput('get_wind', {
      summary: 'Wind at 42.33, -83.05: 20 km/h from the W.',
      data: { speed_kph: 20, speed_mps: 5.6 },
    });
    expect(wind.summary).toBe('Wind at 42.33, -83.05: 12 mph from the W.');
    expect(wind.data).toMatchObject({ speed_kph: 20, speed_mph: 12.4 });
    const brief = imperialGevOutput('get_regional_brief', {
      summary: 'Detroit: clear sky, -2°C, wind 9 km/h; 3 recent headlines.',
      data: { weather: { temperature_c: -2, wind_kph: 9 } },
    });
    expect(brief.summary).toBe('Detroit: clear sky, 28 F (-2 C), wind 6 mph; 3 recent headlines.');
    const err = { summary: 'GEV error 4°C', isError: true };
    expect(imperialGevOutput('get_weather', err)).toBe(err);
    const other = { summary: 'Recent image, 4°C' };
    expect(imperialGevOutput('get_recent_imagery', other)).toBe(other);
  });

  it('GEV weather tools answer in US units through the registry; a units argument defaults to imperial', async () => {
    const config = loadConfig({ GATEWAY_MODE: 'test' });
    const registry = new ToolRegistry(new ToolPolicy(config));
    const seen: Array<{ name: string; args: Record<string, unknown> }> = [];
    registry.setGevTools(
      [
        {
          name: 'get_weather',
          description: 'Current weather',
          inputSchema: { type: 'object', properties: { location: { type: 'object' } } },
        },
        {
          name: 'get_wind',
          description: 'Wind (a hypothetical version that takes units)',
          inputSchema: {
            type: 'object',
            properties: {
              location: { type: 'object' },
              units: { type: 'string', enum: ['metric', 'imperial'] },
            },
          },
        },
      ],
      async (name, args) => {
        seen.push({ name, args });
        return name === 'get_weather'
          ? GEV_WEATHER
          : { summary: 'Wind at x: 20 km/h from the W.', data: { speed_kph: 20 } };
      },
      5_000,
    );
    const ctx = { signal: new AbortController().signal };
    const w = await registry
      .get('get_weather')!
      .run({ location: { lat: 42.33, lon: -83.05 } }, ctx);
    expect(w.summary).toMatch(/40 F \(4 C\), wind 8 mph/);
    // GEV's get_weather takes no units argument: none is added.
    expect(seen[0]!.args).toEqual({ location: { lat: 42.33, lon: -83.05 } });
    await registry.get('get_wind')!.run({ location: { lat: 42.33, lon: -83.05 } }, ctx);
    expect(seen[1]!.args).toEqual({ location: { lat: 42.33, lon: -83.05 }, units: 'imperial' });
    await registry.get('get_wind')!.run({ location: {}, units: 'metric' }, ctx);
    expect(seen[2]!.args.units).toBe('metric');
  });
});
