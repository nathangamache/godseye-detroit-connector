/** Small geodesic helpers (spherical earth; accurate to ~0.5% at city scale). */
export const EARTH_RADIUS_M = 6_371_008.8;
const RAD = Math.PI / 180;

export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * RAD;
  const dLon = (lon2 - lon1) * RAD;
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial bearing from point 1 to point 2, degrees clockwise from north (0..360). */
export function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = lat1 * RAD;
  const p2 = lat2 * RAD;
  const dl = (lon2 - lon1) * RAD;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export function compassPoint(deg: number): string {
  return POINTS[Math.round(deg / 22.5) % 16]!;
}

/**
 * Distance from point P to segment AB using a local equirectangular projection
 * centred on P (fine for segments up to tens of km). Returns metres and the
 * closest point.
 */
export function pointToSegmentM(
  lat: number,
  lon: number,
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number,
): { distM: number; lat: number; lon: number } {
  const kx = Math.cos(lat * RAD) * RAD * EARTH_RADIUS_M;
  const ky = RAD * EARTH_RADIUS_M;
  const ax = (aLon - lon) * kx;
  const ay = (aLat - lat) * ky;
  const bx = (bLon - lon) * kx;
  const by = (bLat - lat) * ky;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return { distM: Math.hypot(cx, cy), lat: lat + cy / ky, lon: lon + cx / kx };
}

/** Degrees of latitude/longitude spanned by `radiusM` around `lat`. */
export function degreeBox(lat: number, radiusM: number): { dLat: number; dLon: number } {
  const dLat = radiusM / (RAD * EARTH_RADIUS_M);
  const dLon = radiusM / (RAD * EARTH_RADIUS_M * Math.max(0.01, Math.cos(lat * RAD)));
  return { dLat, dLon };
}

export function isValidLatLon(lat: unknown, lon: unknown): lat is number {
  return (
    typeof lat === 'number' &&
    typeof lon === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}
