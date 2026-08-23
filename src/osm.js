// OpenStreetMap vector features via the Overpass API, projected onto the sheet.

import { worldSize, lon2x, lat2y } from './geo.js';
import { simplifyPath } from './contour.js';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

export const FEATURE_GROUPS = {
  water:    { label: 'Lakes & reservoirs', kind: 'polygon', colour: '#00a0c8' },
  waterway: { label: 'Rivers & streams',   kind: 'line',    colour: '#00a0c8' },
  road:     { label: 'Major roads',        kind: 'line',    colour: '#c85a2a' },
  rail:     { label: 'Railways',           kind: 'line',    colour: '#8a7ad0' },
  building: { label: 'Buildings',          kind: 'polygon', colour: '#b0603a' },
  green:    { label: 'Woodland',           kind: 'polygon', colour: '#4a9a5a' },
  // Named points, engraved as lettering rather than traced as outlines.
  place:    { label: 'Place names',         kind: 'label',   colour: '#8000ff' },
};

/** How prominent a named place is — controls what gets dropped first. */
export const PLACE_RANK = {
  city: 0, town: 1, village: 2, peak: 3, hamlet: 4, suburb: 5, locality: 6,
};

/** Settlement sizes a map can be limited to, largest first. A peak is not a
 *  settlement, so it is never filtered out by size. */
export const PLACE_FLOOR = { city: 0, town: 1, village: 2, hamlet: 4, any: 99 };

const SELECTORS = {
  water: ['way["natural"="water"]', 'relation["natural"="water"]',
          'way["landuse"="reservoir"]', 'relation["landuse"="reservoir"]'],
  waterway: ['way["waterway"~"^(river|stream|canal)$"]'],
  road: ['way["highway"~"^(motorway|trunk|primary|secondary|tertiary)$"]'],
  rail: ['way["railway"~"^(rail|light_rail|subway|tram|narrow_gauge)$"]'],
  building: ['way["building"]', 'relation["building"]'],
  green: ['way["natural"="wood"]', 'way["landuse"="forest"]',
          'relation["natural"="wood"]', 'relation["landuse"="forest"]'],
  place: ['node["place"~"^(city|town|village|hamlet|suburb|locality)$"]["name"]',
          'node["natural"="peak"]["name"]'],
};

function classify(tags = {}) {
  if (tags.waterway && /^(river|stream|canal)$/.test(tags.waterway) && tags.area !== 'yes') return 'waterway';
  if (tags.natural === 'water' || tags.landuse === 'reservoir' || tags.water) return 'water';
  if (tags.building) return 'building';
  if (tags.natural === 'wood' || tags.landuse === 'forest') return 'green';
  if (tags.railway) return 'rail';
  if (tags.highway) return 'road';
  return null;
}

/* ── projection & clipping ───────────────────────────────────────────── */

export function makeProjector(bbox, W, H) {
  const ws = worldSize(20);
  const x0 = lon2x(bbox.west, ws), x1 = lon2x(bbox.east, ws);
  const y0 = lat2y(bbox.north, ws), y1 = lat2y(bbox.south, ws);
  return (lon, lat) => [
    (lon2x(lon, ws) - x0) / (x1 - x0) * W,
    (lat2y(lat, ws) - y0) / (y1 - y0) * H,
  ];
}

/** Sutherland–Hodgman clip of a closed ring against the sheet rectangle. */
function clipRing(ring, W, H) {
  const edges = [
    [p => p[0] >= 0, (a, b) => lerpX(a, b, 0)],
    [p => p[0] <= W, (a, b) => lerpX(a, b, W)],
    [p => p[1] >= 0, (a, b) => lerpY(a, b, 0)],
    [p => p[1] <= H, (a, b) => lerpY(a, b, H)],
  ];
  let out = ring;
  for (const [inside, cut] of edges) {
    const src = out; out = [];
    for (let i = 0; i < src.length; i++) {
      const cur = src[i], prev = src[(i + src.length - 1) % src.length];
      const ci = inside(cur), pi = inside(prev);
      if (ci) { if (!pi) out.push(cut(prev, cur)); out.push(cur); }
      else if (pi) out.push(cut(prev, cur));
    }
    if (!out.length) return null;
  }
  return out.length >= 3 ? out : null;
}
const lerpX = (a, b, x) => [x, a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0])];
const lerpY = (a, b, y) => [a[0] + (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]), y];

/** Clip an open polyline, returning the pieces that fall inside the sheet. */
function clipLine(pts, W, H) {
  const inside = p => p[0] >= 0 && p[0] <= W && p[1] >= 0 && p[1] <= H;
  const runs = [];
  let cur = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const seg = clipSegment(pts[i], pts[i + 1], W, H);
    if (!seg) { if (cur.length > 1) runs.push(cur); cur = []; continue; }
    if (!cur.length) cur.push(seg[0]);
    else if (dist2(cur[cur.length - 1], seg[0]) > 1e-9) { if (cur.length > 1) runs.push(cur); cur = [seg[0]]; }
    cur.push(seg[1]);
  }
  if (cur.length > 1) runs.push(cur);
  return runs;
  function dist2(a, b) { return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2; }
}

/** Liang–Barsky segment clip. */
function clipSegment(a, b, W, H) {
  let t0 = 0, t1 = 1;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const p = [-dx, dx, -dy, dy], q = [a[0], W - a[0], a[1], H - a[1]];
  for (let i = 0; i < 4; i++) {
    if (Math.abs(p[i]) < 1e-12) { if (q[i] < 0) return null; continue; }
    const r = q[i] / p[i];
    if (p[i] < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
    else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  return [[a[0] + t0 * dx, a[1] + t0 * dy], [a[0] + t1 * dx, a[1] + t1 * dy]];
}

/* ── relation member stitching ───────────────────────────────────────── */

/**
 * Join member ways that share endpoints into closed rings where possible.
 * Endpoints are indexed by position, so a multipolygon split into hundreds of
 * member ways stitches in roughly linear time rather than quadratic.
 */
function stitch(segments, minPts = 4) {
  const key = p => `${p[0].toFixed(4)},${p[1].toFixed(4)}`;
  const segs = segments.filter(s => s.length > 1);
  const ends = new Map();
  const used = new Uint8Array(segs.length);

  segs.forEach((s, i) => {
    for (const k of [key(s[0]), key(s[s.length - 1])]) {
      if (!ends.has(k)) ends.set(k, []);
      ends.get(k).push(i);
    }
  });
  const free = k => { for (const i of ends.get(k) || []) if (!used[i]) return i; return -1; };

  const rings = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    let line = segs[i].slice();

    for (;;) {
      const head = key(line[0]), tail = key(line[line.length - 1]);
      if (head === tail) break;

      let j = free(tail);
      if (j >= 0) {
        used[j] = 1;
        const s = segs[j];
        line = line.concat(key(s[0]) === tail ? s.slice(1) : s.slice().reverse().slice(1));
        continue;
      }
      j = free(head);
      if (j >= 0) {
        used[j] = 1;
        const s = segs[j];
        const pre = key(s[s.length - 1]) === head ? s.slice(0, -1) : s.slice().reverse().slice(0, -1);
        line = pre.concat(line);
        continue;
      }
      break;
    }
    if (line.length >= minPts) rings.push(line);
  }
  return rings;
}

/* ── fetch ───────────────────────────────────────────────────────────── */

export async function fetchOsmFeatures({ bbox, groups, sheetW, sheetH, simplifyTol,
                                         minLength, onProgress, signal }) {
  const active = Object.keys(SELECTORS).filter(g => groups[g]);
  if (!active.length) return {};

  const bb = `(${bbox.south.toFixed(6)},${bbox.west.toFixed(6)},${bbox.north.toFixed(6)},${bbox.east.toFixed(6)})`;
  const body = `[out:json][timeout:90];\n(\n` +
    active.flatMap(g => SELECTORS[g]).map(s => `  ${s}${bb};`).join('\n') +
    `\n);\nout geom;`;

  onProgress?.(0.1, 'Querying Overpass…');

  let json = null, lastErr = null;
  for (const ep of ENDPOINTS) {
    try {
      const res = await fetch(ep, { method: 'POST', body: 'data=' + encodeURIComponent(body),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal });
      if (!res.ok) { lastErr = new Error(`Overpass ${res.status}`); continue; }
      const got = await res.json();
      // A query that times out or runs out of memory still answers 200: the
      // failure arrives as a remark beside an empty element list. Taken as data
      // it reads as "this area has no rivers", which is a different thing
      // entirely — and the other endpoint may not be as busy.
      if (got.remark && !got.elements?.length) {
        lastErr = new Error(String(got.remark).replace(/^runtime error:\s*/i, ''));
        continue;
      }
      json = got;
      break;
    } catch (e) { if (signal?.aborted) throw e; lastErr = e; }
  }
  if (!json) throw new Error(`Overpass request failed: ${lastErr?.message || 'unknown error'}`);

  onProgress?.(0.7, 'Projecting features…');

  const project = makeProjector(bbox, sheetW, sheetH);
  const out = {};
  const places = [];
  const add = (g, shape) => { (out[g] ||= { kind: FEATURE_GROUPS[g].kind, shapes: [] }).shapes.push(shape); };

  const relMembers = new Map();   // group -> segments awaiting stitching
  const lineWays = new Map();     // group -> the fragments a road arrives in

  for (const el of json.elements || []) {
    // Named points come back as nodes and become engraved labels, not outlines.
    if (el.type === 'node') {
      const name = el.tags?.name;
      const kind = el.tags?.place || (el.tags?.natural === 'peak' ? 'peak' : null);
      if (!groups.place || !name || !kind) continue;
      const [x, y] = project(el.lon, el.lat);
      if (x < 0 || y < 0 || x > sheetW || y > sheetH) continue;
      // OSM writes population as a plain integer, sometimes with separators.
      const pop = parseInt(String(el.tags.population || '').replace(/[^0-9]/g, ''), 10);
      places.push({ x, y, name, kind, rank: PLACE_RANK[kind] ?? 9,
                    population: Number.isFinite(pop) ? pop : null,
                    ele: el.tags.ele ? Math.round(+el.tags.ele) : null });
      continue;
    }

    const g = classify(el.tags);
    if (!g || !groups[g]) continue;

    if (el.type === 'way' && el.geometry) {
      const pts = el.geometry.map(p => project(p.lon, p.lat));
      // OSM starts a new way at every junction and every change of tag, so one
      // road arrives as a chain of them — some only tens of metres long. Joining
      // the chain up before anything is measured or dropped stops a short link
      // between two stretches of the same road vanishing and leaving a gap.
      if (FEATURE_GROUPS[g].kind === 'line') {
        if (!lineWays.has(g)) lineWays.set(g, []);
        lineWays.get(g).push(pts);
      } else {
        emit(g, pts, isClosed(el));
      }
    } else if (el.type === 'relation' && el.members) {
      const segs = el.members
        .filter(m => m.type === 'way' && m.geometry && m.role !== 'inner')
        .map(m => m.geometry.map(p => project(p.lon, p.lat)));
      if (!segs.length) continue;
      if (!relMembers.has(g)) relMembers.set(g, []);
      const bucket = relMembers.get(g);
      for (const s of segs) bucket.push(s);
    }
  }

  for (const [g, segs] of relMembers) for (const ring of stitch(segs)) emit(g, ring, true);
  for (const [g, segs] of lineWays) for (const line of stitch(segs, 2)) emit(g, line, false);

  // Biggest first within a rank, so a cap on labels keeps the places that
  // matter rather than whichever ones sort early in the alphabet.
  places.sort((a, b) => a.rank - b.rank ||
                        (b.population || 0) - (a.population || 0) ||
                        a.name.localeCompare(b.name));

  onProgress?.(1, 'Done');
  return { features: out, places };

  function isClosed(el) {
    const gm = el.geometry;
    if (gm.length < 4) return false;
    const a = gm[0], b = gm[gm.length - 1];
    return a.lat === b.lat && a.lon === b.lon;
  }

  function emit(g, pts, closed) {
    const wantPolygon = FEATURE_GROUPS[g].kind === 'polygon';
    if (wantPolygon && closed) {
      const ring = clipRing(pts, sheetW, sheetH);
      if (!ring) return;
      const s = simplifyPath(ring, simplifyTol);
      if (s.length >= 4 && pathExtent(s) >= minLength) add(g, s.concat([s[0]]));
    } else {
      for (const run of clipLine(pts, sheetW, sheetH)) {
        const s = simplifyPath(run, simplifyTol);
        if (s.length >= 2 && pathLength(s) >= minLength) add(g, s);
      }
    }
  }
}

function pathLength(p) {
  let L = 0;
  for (let i = 1; i < p.length; i++) L += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
  return L;
}
function pathExtent(p) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of p) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return Math.max(x1 - x0, y1 - y0);
}
