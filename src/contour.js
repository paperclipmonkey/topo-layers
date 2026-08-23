// Elevation grid -> laser-ready polygons, in millimetres on the sheet.

import { contours as d3contours } from 'https://cdn.jsdelivr.net/npm/d3-contour@4.0.2/+esm';

const EPS = 1e-6;

/* ── threshold generation ────────────────────────────────────────────── */

const NICE = [1, 2, 2.5, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000];

// Round numbers fall where the ladder puts them, so their count follows from the
// range rather than from the layer count asked for. The floor and ceiling are
// typed by hand and carry no limits, so that range can be any width at all — and
// at one step every 5000 m a ceiling of 10,000,000 is two thousand levels, each
// of which d3-contour then has to trace. Past this many the step is coarsened
// instead, which costs round numbers nobody asked for rather than the tab.
const MAX_LEVELS = 200;

export function makeThresholds({ mode, count, min, max, values }) {
  const lo = Number.isFinite(min) ? min : 0;
  const hi = Number.isFinite(max) ? max : 1;
  if (hi - lo < EPS) return [];
  const n = Math.max(1, Math.round(count));

  if (mode === 'equal') {
    return Array.from({ length: n }, (_, k) => lo + (hi - lo) * (k + 1) / (n + 1));
  }

  if (mode === 'round') {
    const span = hi - lo;
    const target = span / (n + 1);
    let step = NICE[NICE.length - 1];
    for (const s of NICE) if (s >= target) { step = s; break; }
    // A span too wide for the ladder — including one wide enough to be Infinity,
    // which would otherwise start a walk that never reaches the end.
    if (!(span / step <= MAX_LEVELS)) step = span / MAX_LEVELS;
    const out = [];
    for (let t = Math.ceil((lo + EPS) / step) * step;
         t < hi && out.length < MAX_LEVELS; t += step) out.push(t);
    return out;
  }

  // quantile — equal *area* per layer
  const stride = Math.max(1, Math.floor(values.length / 200000));
  const sample = [];
  for (let i = 0; i < values.length; i += stride) sample.push(values[i]);
  sample.sort((a, b) => a - b);
  const out = [];
  for (let k = 1; k <= n; k++) {
    const v = sample[Math.min(sample.length - 1, Math.floor(sample.length * k / (n + 1)))];
    if (!out.length || v > out[out.length - 1] + EPS) out.push(v);
  }
  return out;
}

/* ── ring maths ──────────────────────────────────────────────────────── */

export function signedArea(r) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++)
    a += (r[j][0] * r[i][1]) - (r[i][0] * r[j][1]);
  return a / 2;
}
export const ringArea = r => Math.abs(signedArea(r));

export function pointInRing(pt, r) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > pt[1]) !== (yj > pt[1]) &&
        pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Point is inside the polygon's material (in the outer ring, out of every hole). */
export function pointInPolygon(pt, poly) {
  if (!pointInRing(pt, poly[0])) return false;
  for (let i = 1; i < poly.length; i++) if (pointInRing(pt, poly[i])) return false;
  return true;
}

/* ── simplify / smooth ───────────────────────────────────────────────── */

/** Douglas–Peucker. Endpoints are pinned, so it suits closed rings and open paths alike. */
export function simplifyPath(ring, tol) {
  if (tol <= 0 || ring.length < 8) return ring;
  const tol2 = tol * tol;
  const keep = new Uint8Array(ring.length);
  keep[0] = 1; keep[ring.length - 1] = 1;

  const stack = [[0, ring.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const [ax, ay] = ring[a], [bx, by] = ring[b];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let far = -1, best = tol2;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = ring[i];
      let d2;
      if (len2 < EPS) {
        d2 = (px - ax) ** 2 + (py - ay) ** 2;
      } else {
        let t = ((px - ax) * dx + (py - ay) * dy) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        d2 = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2;
      }
      if (d2 > best) { best = d2; far = i; }
    }
    if (far > 0) { keep[far] = 1; stack.push([a, far], [far, b]); }
  }
  const out = [];
  for (let i = 0; i < ring.length; i++) if (keep[i]) out.push(ring[i]);
  return out.length >= 4 ? out : ring;
}

const onEdge = (p, W, H, t) =>
  (Math.abs(p[0]) < t ? 1 : 0) | (Math.abs(p[0] - W) < t ? 2 : 0) |
  (Math.abs(p[1]) < t ? 4 : 0) | (Math.abs(p[1] - H) < t ? 8 : 0);

/**
 * Chaikin corner cutting on a closed ring. Segments that run along the sheet
 * boundary are left rigid, so the rectangular edge of the piece stays square
 * instead of being rounded off.
 */
function smoothRing(ring, iters, W, H) {
  if (iters <= 0 || ring.length < 4) return ring;
  let pts = ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
    ? ring.slice(0, -1) : ring.slice();

  for (let it = 0; it < iters; it++) {
    if (pts.length < 4) break;
    const t = 1e-4;
    const flags = pts.map(p => onEdge(p, W, H, t));
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      if (flags[i] & flags[(i + 1) % pts.length]) {          // same boundary line
        out.push(p, q);
      } else {
        out.push([p[0] * 0.75 + q[0] * 0.25, p[1] * 0.75 + q[1] * 0.25],
                 [p[0] * 0.25 + q[0] * 0.75, p[1] * 0.25 + q[1] * 0.75]);
      }
    }
    // drop duplicates introduced by the rigid-segment branch
    pts = out.filter((p, i) => {
      const q = out[(i + out.length - 1) % out.length];
      return Math.abs(p[0] - q[0]) > EPS || Math.abs(p[1] - q[1]) > EPS;
    });
  }
  if (pts.length < 3) return ring;
  pts.push([pts[0][0], pts[0][1]]);
  return pts;
}

/* ── kerf compensation ───────────────────────────────────────────────── */

/** Offset a closed ring so its enclosed area grows by `dist` all round. */
function offsetRing(ring, dist, miter = 2) {
  if (Math.abs(dist) < EPS || ring.length < 4) return ring;
  const closed = ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
  const pts = closed ? ring.slice(0, -1) : ring.slice();
  const n = pts.length;
  if (n < 3) return ring;
  const s = signedArea(pts) >= 0 ? 1 : -1;   // area-increasing normal flips with winding

  const norm = i => {
    const p = pts[i], q = pts[(i + 1) % n];
    let dx = q[0] - p[0], dy = q[1] - p[1];
    const L = Math.hypot(dx, dy);
    if (L < EPS) return null;
    return [s * dy / L, -s * dx / L];
  };
  const normals = Array.from({ length: n }, (_, i) => norm(i));

  const out = [];
  for (let i = 0; i < n; i++) {
    let n1 = normals[(i + n - 1) % n], n2 = normals[i];
    if (!n1 && !n2) { out.push(pts[i]); continue; }
    n1 = n1 || n2; n2 = n2 || n1;
    let bx = n1[0] + n2[0], by = n1[1] + n2[1];
    const L = Math.hypot(bx, by);
    if (L < EPS) { out.push(pts[i]); continue; }
    bx /= L; by /= L;
    const cos = Math.max(bx * n1[0] + by * n1[1], 1 / miter);
    out.push([pts[i][0] + bx * dist / cos, pts[i][1] + by * dist / cos]);
  }
  out.push([out[0][0], out[0][1]]);
  return out;
}

/* ── main build ──────────────────────────────────────────────────────── */

/**
 * @param grid   {values,width,height}
 * @param opts   {thresholds, sheetW, sheetH, smoothCurve, simplifyTol,
 *                minFeature, minHole, kerf}
 * @returns array of layers, lowest first:
 *          {index, threshold, polygons:[[outer,...holes]], area, nodes}
 */
export function buildLayers(grid, opts) {
  const { values, width: gw, height: gh } = grid;
  const { sheetW: W, sheetH: H } = opts;
  const thresholds = [...opts.thresholds].sort((a, b) => a - b);
  if (!thresholds.length) return [];

  const raw = d3contours().size([gw, gh]).thresholds(thresholds)(values);

  // d3-contour emits coordinates over [0,gw] x [0,gh]; scale straight to mm.
  const sx = W / gw, sy = H / gh;
  const cellMM = Math.min(sx, sy);
  const preTol = Math.min(opts.simplifyTol || 0, cellMM * 0.25);

  const minArea = (opts.minFeature || 0) ** 2;
  const minHoleArea = (opts.minHole || 0) ** 2;

  return raw.map((mp, index) => {
    const polygons = [];
    for (const poly of mp.coordinates) {
      const rings = [];
      let dropped = false;
      for (let ri = 0; ri < poly.length && !dropped; ri++) {
        let ring = poly[ri].map(([x, y]) => [
          Math.max(0, Math.min(W, x * sx)),
          Math.max(0, Math.min(H, y * sy)),
        ]);
        ring = simplifyPath(ring, preTol);
        ring = smoothRing(ring, opts.smoothCurve | 0, W, H);
        ring = simplifyPath(ring, opts.simplifyTol || 0);

        const tooSmall = ring.length < 4 || ringArea(ring) < (ri === 0 ? minArea : minHoleArea);
        if (ri === 0 && tooSmall) dropped = true;   // island too small to survive the cut
        else if (!tooSmall) rings.push(ring);       // pinhole holes just get skipped
      }
      if (dropped || !rings.length) continue;

      if (opts.kerf > 0) {
        const d = opts.kerf / 2;
        rings[0] = offsetRing(rings[0], d);
        for (let i = 1; i < rings.length; i++) rings[i] = offsetRing(rings[i], -d);
      }
      polygons.push(rings);
    }

    let area = 0, nodes = 0;
    for (const p of polygons) {
      area += ringArea(p[0]);
      for (let i = 1; i < p.length; i++) area -= ringArea(p[i]);
      for (const r of p) nodes += r.length;
    }
    return { index, threshold: mp.value, polygons, area, nodes };
  });
}

/** Full-sheet rectangle, used for the bottom layer and the jig. */
export function sheetRect(W, H) {
  return [[[[0, 0], [W, 0], [W, H], [0, H], [0, 0]]]];
}
