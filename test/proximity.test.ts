import { describe, expect, it } from 'vitest';
import { pointFromArgs, proximityCheck } from '../src/location/proximity.js';
import { DETROIT } from './helpers.js';

const NOW = Date.parse('2026-11-14T12:00:00Z');
const fixAt = (lat: number, lon: number, minutesAgo: number, accuracy_m: number | null = 10) => ({
  lat,
  lon,
  accuracy_m,
  fix_ts: NOW - minutesAgo * 60_000,
  device: 'phone',
  source: 'pwa',
});

describe('pointFromArgs', () => {
  it('finds top-level and nested points, ignores place names and bad values', () => {
    expect(pointFromArgs({ lat: 42.3, lon: -83.1, radius_km: 2 })).toEqual({
      lat: 42.3,
      lon: -83.1,
    });
    expect(pointFromArgs({ location: { lat: 1, lon: 2 } })).toEqual({ lat: 1, lon: 2 });
    expect(pointFromArgs({ area: { lat: 1, lon: 2, radius_km: 3 }, limit: 5 })).toEqual({
      lat: 1,
      lon: 2,
    });
    expect(pointFromArgs({ area: { place: 'Somewhere' } })).toBeUndefined();
    expect(pointFromArgs({ lat: 95, lon: 0 })).toBeUndefined();
    expect(pointFromArgs({ camera_id: 'x' })).toBeUndefined();
    expect(pointFromArgs(undefined)).toBeUndefined();
  });
});

describe('proximityCheck', () => {
  it('distance with one decimal, bearing from the place to the phone, fix age', () => {
    // Phone due north of the place by ~1.1 km.
    const c = proximityCheck(DETROIT, fixAt(DETROIT.lat + 0.01, DETROIT.lon, 3), NOW, 30)!;
    expect(c).toMatchObject({ distance_km: 1.1, compass: 'N', fix_age_s: 180, at_place: false });
    expect(c.note).toBe(
      "Phone check: the user's latest phone fix (3 min old) is 1.1 km N of this point, so the phone is NOT at this place. If the user claims to be here, say that the phone puts the user 1.1 km N of it and ask which is right before answering as if the user were here.",
    );
    // South of the place: bearing is FROM the place TO the phone.
    expect(
      proximityCheck(DETROIT, fixAt(DETROIT.lat - 0.01, DETROIT.lon, 3), NOW, 30)!.compass,
    ).toBe('S');
  });

  it('0.5 km is "at this place"; poor accuracy is flagged', () => {
    const at = proximityCheck(DETROIT, fixAt(DETROIT.lat + 0.004, DETROIT.lon, 1), NOW, 30)!;
    expect(at.at_place).toBe(true);
    expect(at.note).toMatch(
      /0\.4 km N of this point, so the phone is at or very near this place\.$/,
    );
    const rough = proximityCheck(DETROIT, fixAt(DETROIT.lat, DETROIT.lon, 1, 1500), NOW, 30)!;
    expect(rough.note).toMatch(/only accurate to about 1500 m/);
  });

  it('no check without a fix or with a fix older than the limit', () => {
    expect(proximityCheck(DETROIT, undefined, NOW, 30)).toBeUndefined();
    expect(proximityCheck(DETROIT, fixAt(DETROIT.lat, DETROIT.lon, 31), NOW, 30)).toBeUndefined();
    expect(proximityCheck(DETROIT, fixAt(DETROIT.lat, DETROIT.lon, 30), NOW, 30)).toBeDefined();
  });

  it('never puts the phone coordinates in the note', () => {
    const phone = fixAt(42.31234, -83.10987, 2);
    const c = proximityCheck(DETROIT, phone, NOW, 30)!;
    expect(c.note).not.toMatch(/42\.31|83\.10/);
    expect(JSON.stringify(c)).not.toMatch(/42\.31|83\.10/);
  });
});
