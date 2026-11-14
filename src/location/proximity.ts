/**
 * Owner-location awareness for tools called with an explicit point.
 *
 * When Claude asks about a place ("I'm stuck at the X St crossing") it passes that place's
 * coordinates; nothing then tells it that the user's phone may be kilometres away. If the latest
 * fix is recent, results for an explicit point carry a short note with the distance, the compass
 * bearing from the place to the phone and the fix age, and say plainly when the phone is not at
 * the place. The note never contains the phone's coordinates; the caller audits it as a
 * location read.
 */
import { bearingDeg, compassPoint, haversineM, isValidLatLon } from '../util/geo.js';
import { humanAge } from '../util/format.js';
import type { LatestFix } from './store.js';

export interface Point {
  lat: number;
  lon: number;
}

/** Farther than this and the phone is "not at this place". */
export const AT_PLACE_M = 500;

/** Argument keys that hold "the place this call is about" (GEV uses location/area). */
const POINT_KEYS = ['location', 'area', 'center', 'point', 'position', 'near', 'at'];

function asPoint(v: unknown): Point | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const { lat, lon } = v as { lat?: unknown; lon?: unknown };
  return isValidLatLon(lat, lon) ? { lat, lon: lon as number } : undefined;
}

/** The explicit point a tool call is about: top-level lat/lon, or location/area/center/... */
export function pointFromArgs(args: unknown): Point | undefined {
  const top = asPoint(args);
  if (top) return top;
  if (!args || typeof args !== 'object') return undefined;
  for (const k of POINT_KEYS) {
    const p = asPoint((args as Record<string, unknown>)[k]);
    if (p) return p;
  }
  return undefined;
}

export interface ProximityCheck {
  distance_km: number;
  /** Bearing FROM the place TO the phone, degrees clockwise from north. */
  bearing_deg: number;
  compass: string;
  fix_age_s: number;
  at_place: boolean;
  note: string;
}

/**
 * Compares the place with the latest fix. Undefined when there is no fix or it is older than
 * `maxAgeMinutes` (an old fix says nothing about where the user is now).
 */
export function proximityCheck(
  place: Point,
  fix: LatestFix | undefined,
  now: number,
  maxAgeMinutes: number,
): ProximityCheck | undefined {
  if (!fix) return undefined;
  const age = Math.max(0, Math.round((now - fix.fix_ts) / 1000));
  if (age > maxAgeMinutes * 60) return undefined;
  const d = haversineM(place.lat, place.lon, fix.lat, fix.lon);
  const km = Math.round(d / 100) / 10;
  const brg = Math.round(bearingDeg(place.lat, place.lon, fix.lat, fix.lon)) % 360;
  const compass = compassPoint(brg);
  const at = d <= AT_PLACE_M;
  const acc =
    fix.accuracy_m !== null && fix.accuracy_m > AT_PLACE_M
      ? ` The fix is only accurate to about ${Math.round(fix.accuracy_m)} m, so treat this as rough.`
      : '';
  const fixed = `the user's latest phone fix (${humanAge(age)} old) is ${km.toFixed(1)} km ${compass} of this point`;
  const note = at
    ? `Phone check: ${fixed}, so the phone is at or very near this place.${acc}`
    : `Phone check: ${fixed}, so the phone is NOT at this place. If the user claims to be here, say that the phone puts the user ${km.toFixed(1)} km ${compass} of it and ask which is right before answering as if the user were here.${acc}`;
  return { distance_km: km, bearing_deg: brg, compass, fix_age_s: age, at_place: at, note };
}
