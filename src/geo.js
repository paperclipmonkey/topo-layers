// Web Mercator helpers. All "world pixel" coordinates use the standard
// 256px tile scheme: worldSize(z) = 256 * 2^z, origin top-left (NW).

export const TILE = 256;
export const worldSize = z => TILE * Math.pow(2, z);

export const lon2x = (lon, ws) => (lon + 180) / 360 * ws;
export const x2lon = (x, ws) => x / ws * 360 - 180;

export function lat2y(lat, ws) {
  const s = Math.sin(Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI / 180);
  return ws * (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI));
}
export function y2lat(y, ws) {
  return Math.atan(Math.sinh(Math.PI * (1 - 2 * y / ws))) * 180 / Math.PI;
}

/** Great-circle distance in metres (spherical earth is plenty here). */
export function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371008.8, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Ground dimensions of a bbox: width measured along the centre parallel,
 * height along the central meridian. This is what a viewer perceives as the
 * size of the piece; Mercator's area distortion over a wall-art-sized extent
 * is negligible.
 */
export function groundSize(bbox) {
  const cLat = (bbox.north + bbox.south) / 2;
  const cLon = (bbox.east + bbox.west) / 2;
  return {
    width: haversine(cLat, bbox.west, cLat, bbox.east),
    height: haversine(bbox.south, cLon, bbox.north, cLon),
  };
}

/** Aspect ratio (w/h) of the bbox as it appears in Mercator — i.e. on screen. */
export function mercatorAspect(bbox) {
  const ws = worldSize(12); // any zoom works, ratios are scale-invariant
  const w = lon2x(bbox.east, ws) - lon2x(bbox.west, ws);
  const h = lat2y(bbox.south, ws) - lat2y(bbox.north, ws);
  return h > 0 ? w / h : 1;
}

/** Format a metric distance for display. */
export function fmtDist(m) {
  if (m >= 10000) return (m / 1000).toFixed(1) + ' km';
  if (m >= 1000) return (m / 1000).toFixed(2) + ' km';
  return Math.round(m) + ' m';
}

/** Round a 1:N scale denominator to a friendly value for display only. */
export function fmtScale(denom) {
  if (!isFinite(denom) || denom <= 0) return '—';
  const nice = denom >= 1e6 ? Math.round(denom / 1e5) * 1e5
             : denom >= 1e5 ? Math.round(denom / 1e4) * 1e4
             : denom >= 1e4 ? Math.round(denom / 1000) * 1000
             : Math.round(denom / 100) * 100;
  return '1:' + nice.toLocaleString('en-GB');
}
