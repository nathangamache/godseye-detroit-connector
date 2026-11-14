/**
 * God's Eye View globe links for aviation results, in GEV's share-link format v2 (the hash GEV
 * writes with createView + viewUrl in src/view/index.js): a camera over the point, looking
 * straight down. Camera only: no layers and nothing followed (following an aircraft makes GEV
 * call OpenSky, which this deployment keeps off).
 */

/** Camera height for a view of an aircraft and the few kilometres around it. */
export const AIRCRAFT_VIEW_ALTITUDE_M = 6000;

export function globeLink(
  origin: string,
  lat: number,
  lon: number,
  altitudeM = AIRCRAFT_VIEW_ALTITUDE_M,
): string {
  const clampedLat = Math.min(90, Math.max(-90, lat));
  const wrappedLon = ((((lon + 180) % 360) + 360) % 360) - 180;
  const params = new URLSearchParams({
    v: '2',
    lat: clampedLat.toFixed(4),
    lon: wrappedLon.toFixed(4),
    alt: String(Math.round(altitudeM)),
    heading: '0',
    pitch: '-90',
    roll: '0',
  });
  const url = new URL(origin);
  url.hash = params.toString();
  return url.href;
}
