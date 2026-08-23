import { groundSize, mercatorAspect, fmtDist, fmtScale,
         worldSize, lon2x, lat2y, y2lat } from './geo.js';
import { fetchElevationGrid, smoothGrid, histogram, DEM_SOURCES } from './terrain.js';
import { makeThresholds, buildLayers, sheetRect } from './contour.js';
import { findDepressions, optimiseLevels, countRendered } from './depression.js';
import { fetchOsmFeatures, FEATURE_GROUPS, PLACE_FLOOR, makeProjector } from './osm.js';
import { textPaths, textWidth } from './font.js';
import { parseGeoJSON, markerPaths, pointsCSV } from './geojson.js';
import { sheetSVG, stackedSVG, nestSVG, jigSVG } from './svg.js';
import { packParts, polygonsBBox } from './nest.js';
import { renderStack, renderSheet, renderNest, renderHistogram,
         histoGeom, snapStep, zoomStackAt, clampStack } from './preview.js';
import { render3D } from './render3d.js';
import { makeZip, download } from './zip.js';
import { controlValues, applyControlValues, changedFrom,
         packHash, unpackHash, parseBBox, formatBBox, parseLevels } from './share.js';

const $ = id => document.getElementById(id);
const num = id => parseFloat($(id).value);
/** A floor that holds against NaN, which `Math.max` does not: max(1, NaN) is NaN. */
const atLeast = (min, v) => (Number.isFinite(v) && v > min ? v : min);
/** Millimetres for reading: whole numbers stay whole, halves keep their decimal. */
const fmtMM = v => (Math.round(v * 10) / 10).toString();

/* ── state ───────────────────────────────────────────────────────────── */

const state = {
  bbox: null,
  grid: null,          // raw sampled elevations
  smoothed: null,      // after terrain smoothing — what contours are cut from
  hist: null,
  thresholds: [],
  sheets: [],
  masks: null,         // per-sheet material coverage, drives feature and pin placement
  pins: [],
  features: null,
  osmFor: null,        // frame and sheet size the OSM shapes were projected for
  places: [],          // named OSM points, engraved as labels
  geoText: null,       // imported GeoJSON, re-projected whenever the frame moves
  geoPoints: [],
  geoLines: [],
  overlay: null,
  nesting: null,
  sheetIndex: 0,
  nestIndex: 0,
  view3d: { yaw: -0.62, tilt: 0.72, zoom: 1, x: 0, y: 0 },   // x/y pan the model on screen
  viewStack: { zoom: 1, x: 0, y: 0 },   // pan/zoom of the stacked preview
  view: 'map',
  abort: null,
};

/* ── chrome ──────────────────────────────────────────────────────────── */

function setStatus(text, cls = 'idle') {
  const el = $('status');
  el.textContent = text;
  el.className = 'status ' + cls;
}
function setProgress(p, text) {
  const el = $('progress');
  el.hidden = false;
  el.querySelector('.bar').style.setProperty('--p', Math.round(p * 100) + '%');
  el.querySelector('.txt').textContent = text || '';
}
const hideProgress = () => { $('progress').hidden = true; };

document.querySelectorAll('.grp>h2').forEach(h =>
  h.addEventListener('click', () => {
    const g = h.parentElement;
    const open = g.dataset.open === '1';
    // A step opens the way a tab does — the other three fold away, so the panel
    // only ever shows the one you are on. Clicking the open one still folds it.
    if (g.dataset.kind === 'step' && !open) openStep(g.dataset.flow, false);
    else { g.dataset.open = open ? '0' : '1'; syncRail(); }
  }));

/* ── map & selection frame ───────────────────────────────────────────── */

const map = L.map('map', { zoomControl: true, attributionControl: true })
  .setView([53.0685, -4.0764], 12);   // Snowdon — good terrain to open on

const BASEMAPS = {
  osm: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap contributors',
  }),
  topo: L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    maxZoom: 17, subdomains: 'abc',
    attribution: '&copy; OpenStreetMap contributors, SRTM | &copy; OpenTopoMap (CC-BY-SA)',
  }),
};
let basemap = BASEMAPS.osm.addTo(map);
document.querySelectorAll('input[name=bm]').forEach(r =>
  r.addEventListener('change', () => {
    map.removeLayer(basemap);
    basemap = BASEMAPS[r.value].addTo(map);
  }));

const frameEl = $('frame');

function pxRect() {
  const nw = map.latLngToContainerPoint([state.bbox.north, state.bbox.west]);
  const se = map.latLngToContainerPoint([state.bbox.south, state.bbox.east]);
  return { l: nw.x, t: nw.y, r: se.x, b: se.y };
}
function setPxRect({ l, t, r, b }) {
  const nw = map.containerPointToLatLng([l, t]);
  const se = map.containerPointToLatLng([r, b]);
  state.bbox = { north: nw.lat, west: nw.lng, south: se.lat, east: se.lng };
}

function drawFrame() {
  if (!state.bbox) return;
  const { l, t, r, b } = pxRect();
  frameEl.hidden = false;
  Object.assign(frameEl.style, {
    left: l + 'px', top: t + 'px', width: Math.max(0, r - l) + 'px', height: Math.max(0, b - t) + 'px',
  });
  const g = groundSize(state.bbox);
  $('frameDim').textContent = `${fmtDist(g.width)} × ${fmtDist(g.height)}`;
}

map.on('move zoom viewreset resize', drawFrame);
map.on('zoomstart', () => { frameEl.style.opacity = '0'; });
map.on('zoomend', () => { frameEl.style.opacity = ''; drawFrame(); });

/**
 * Reshape the selection to the sheet's aspect ratio, keeping its width and
 * centre. Done in Mercator rather than screen pixels so it stays correct while
 * the map tab is hidden — a hidden map reports zero size, which would otherwise
 * collapse the selection to nothing.
 */
function applySheetAspect() {
  if (!state.bbox) return;
  const A = num('sheetW') / num('sheetH');
  if (!isFinite(A) || A <= 0) return;
  const ws = worldSize(20);
  const x0 = lon2x(state.bbox.west, ws), x1 = lon2x(state.bbox.east, ws);
  const y0 = lat2y(state.bbox.north, ws), y1 = lat2y(state.bbox.south, ws);
  const cy = (y0 + y1) / 2, h = (x1 - x0) / A;
  state.bbox = {
    west: state.bbox.west, east: state.bbox.east,
    north: y2lat(cy - h / 2, ws), south: y2lat(cy + h / 2, ws),
  };
  drawFrame();
  onAreaChanged();
}

function frameToView() {
  const s = map.getSize();
  if (s.x < 20 || s.y < 20) return;      // map tab hidden — nothing to fit to
  const w = Math.min(s.x, s.y) * 0.62;
  const aspect = num('sheetW') / num('sheetH') || 1.5;
  let fw = w, fh = w / aspect;
  if (fh > s.y * 0.78) { fh = s.y * 0.78; fw = fh * aspect; }
  setPxRect({ l: (s.x - fw) / 2, t: (s.y - fh) / 2, r: (s.x + fw) / 2, b: (s.y + fh) / 2 });
  drawFrame(); onAreaChanged();
}

// drag / resize
let drag = null;
frameEl.addEventListener('pointerdown', e => {
  const handle = e.target.classList.contains('fh') ? e.target.dataset.h : 'move';
  drag = { handle, x: e.clientX, y: e.clientY, start: pxRect() };
  frameEl.setPointerCapture(e.pointerId);
  map.dragging.disable();
  e.preventDefault(); e.stopPropagation();
});
frameEl.addEventListener('pointermove', e => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  let { l, t, r, b } = drag.start;

  if (drag.handle === 'move') {
    l += dx; r += dx; t += dy; b += dy;
  } else {
    const h = drag.handle;
    if (h.includes('w')) l += dx;
    if (h.includes('e')) r += dx;
    if (h.includes('n')) t += dy;
    if (h.includes('s')) b += dy;
    if (r - l < 24) { if (h.includes('w')) l = r - 24; else r = l + 24; }
    if (b - t < 24) { if (h.includes('n')) t = b - 24; else b = t + 24; }

    if ($('lockAspect').checked) {
      const A = num('sheetW') / num('sheetH');
      if (h === 'n' || h === 's') {
        const w = (b - t) * A, cx = (l + r) / 2; l = cx - w / 2; r = cx + w / 2;
      } else if (h === 'e' || h === 'w') {
        const hh = (r - l) / A, cy = (t + b) / 2; t = cy - hh / 2; b = cy + hh / 2;
      } else {
        const hh = (r - l) / A;
        if (h.includes('n')) t = b - hh; else b = t + hh;
      }
    }
  }
  setPxRect({ l, t, r, b });
  drawFrame();
});
const endDrag = e => {
  if (!drag) return;
  drag = null;
  map.dragging.enable();
  try { frameEl.releasePointerCapture(e.pointerId); } catch {}
  onAreaChanged();
};
frameEl.addEventListener('pointerup', endDrag);
frameEl.addEventListener('pointercancel', endDrag);

/* ── place search ────────────────────────────────────────────────────── */

$('searchInput').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
$('searchGo').addEventListener('click', doSearch);

async function doSearch() {
  const q = $('searchInput').value.trim();
  if (!q) return;
  const box = $('searchResults');
  box.hidden = false;
  box.innerHTML = '<button disabled>Searching…</button>';
  try {
    const res = await fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&q=' +
                            encodeURIComponent(q));
    const list = await res.json();
    if (!list.length) { box.innerHTML = '<button disabled>No matches</button>'; return; }
    box.innerHTML = '';
    for (const r of list) {
      const b = document.createElement('button');
      b.textContent = r.display_name;
      b.addEventListener('click', () => {
        if (r.boundingbox) {
          const [s, n, w, e] = r.boundingbox.map(Number);
          map.fitBounds([[s, w], [n, e]], { padding: [60, 60] });
        } else {
          map.setView([+r.lat, +r.lon], 13);
        }
        box.hidden = true;
        setTimeout(frameToView, 350);
      });
      box.appendChild(b);
    }
  } catch {
    box.innerHTML = '<button disabled>Search unavailable</button>';
  }
}

/* ── readouts ────────────────────────────────────────────────────────── */

function onAreaChanged() {
  if (!state.bbox) return;
  const bb = state.bbox;
  $('bboxOut').textContent =
    `${bb.south.toFixed(4)}, ${bb.west.toFixed(4)} → ${bb.north.toFixed(4)}, ${bb.east.toFixed(4)}`;

  // The frame drives the sheet height unless the sheet is driving the frame.
  if (!$('lockAspect').checked) {
    const h = num('sheetW') / mercatorAspect(bb);
    if (isFinite(h) && h > 0) $('sheetH').value = h.toFixed(1);
  }
  if (invalidateProjected()) redraw();
  updateDerived();
  updateSteps();
  syncURL();
}

function updateDerived() {
  const th = state.thresholds;
  const t = num('thickness');
  const W = num('sheetW');
  const g = state.bbox ? groundSize(state.bbox) : null;

  if (g) {
    $('groundOut').textContent = `${fmtDist(g.width)} × ${fmtDist(g.height)}`;
    $('scaleOut').textContent = fmtScale(g.width * 1000 / W);
  }

  let interval = '—', exagg = '—';
  if (th.length >= 2) {
    const steps = th.slice(1).map((v, i) => v - th[i]);
    const lo = Math.min(...steps), hi = Math.max(...steps);
    interval = hi - lo < 1e-6 ? `${lo.toFixed(1)} m` : `${lo.toFixed(1)}–${hi.toFixed(1)} m`;
    if (g && t > 0) {
      const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
      const horiz = g.width / W;               // metres of ground per mm across the sheet
      const vert = mean / t;                   // metres of altitude per mm up the stack
      const x = horiz / vert;
      if (isFinite(x)) exagg = (x < 10 ? x.toFixed(2) : x.toFixed(1)) + '×';
    }
  }
  $('intervalOut').textContent = interval;
  $('exaggOut').textContent = exagg;

  // Before any levels exist there is no stack to measure: the base plate on its
  // own is not one, and "3.0 mm (1 sheets)" reads like a bug.
  const n = state.sheets.length ||
            (th.length ? th.length + ($('baseFull').checked ? 1 : 0) : 0);
  const tall = n && t > 0 ? `${(n * t).toFixed(1)} mm` : '—';
  $('stackOut').textContent = n && t > 0 ? `${tall} (${n} sheet${n > 1 ? 's' : ''})` : '—';

  // The same three numbers again, beside the thickness control in the 3D view —
  // that is where you are looking when you change it, and where the answer to
  // "how much relief does this actually give me" is worth having in front of
  // you rather than a panel section away.
  $('matLayers').textContent = n ? String(n) : '—';
  $('matStack').textContent = tall;
  $('matExagg').textContent = exagg;

  updateSummaries();
}

/* ── material ────────────────────────────────────────────────────────── */

/**
 * The stock the piece is cut from. Thickness is the number that matters — it
 * sets how tall the stack stands, and it is drawn to scale in the 3D view — so
 * it lives in the panel and is mirrored into the turntable, where changing it
 * and watching the piece grow is the whole point. The material itself only
 * chooses a colour for that preview; nothing exported depends on it.
 */
function materialTone() {
  const o = $('material').selectedOptions[0];
  return o ? { h: +o.dataset.h, s: +o.dataset.s, l: +o.dataset.l } : null;
}

const RANGE_LO = 0.5, RANGE_HI = 12;

/**
 * Put the current thickness on every control that shows it, skipping the one
 * being typed into so the caret is left alone, then redraw what depends on it.
 */
function syncMaterial(source) {
  const t = num('thickness');
  if (source !== $('matThickness')) $('matThickness').value = $('thickness').value;
  if (source !== $('matRange'))
    $('matRange').value = String(Math.max(RANGE_LO, Math.min(RANGE_HI, isFinite(t) ? t : 3)));
  if (source !== $('matPreset')) $('matPreset').value = $('material').value;
  if (source !== $('material')) $('material').value = $('matPreset').value;
  updateDerived();
  if (state.view === 'three') redraw();
}

/** Write a thickness in from one of the 3D view's controls. */
function setThickness(mm, source) {
  if (!isFinite(mm) || mm <= 0) return;
  $('thickness').value = String(Math.round(mm * 100) / 100);
  syncMaterial(source);
  syncURL();
}

/* ── elevation ───────────────────────────────────────────────────────── */

$('demSource').addEventListener('change', () => {
  const v = $('demSource').value;
  $('demTokenRow').hidden = v !== 'mapbox';
  $('demCustomRow').hidden = v !== 'custom';
});

/**
 * Fetch the terrain under the frame and rebuild from it.
 *
 * `levels` comes from a shared link: those heights were chosen deliberately, so
 * they are used as-is instead of generating a fresh set. `view` is where to
 * land once the layers exist.
 */
async function fetchElevation({ levels = null, view = 'stack' } = {}) {
  if (!state.bbox) return false;
  state.abort?.abort();
  const ctrl = new AbortController();
  state.abort = ctrl;

  setStatus('Fetching elevation…', 'busy');
  setProgress(0, 'Starting…');
  try {
    const srcKey = $('demSource').value;
    const grid = await fetchElevationGrid({
      bbox: state.bbox,
      gridW: parseInt($('gridRes').value, 10),
      source: srcKey === 'custom' ? $('demCustomEnc').value : srcKey,
      token: $('demToken').value.trim(),
      urlTemplate: srcKey === 'custom' ? $('demCustomUrl').value.trim() : null,
      onProgress: setProgress,
      signal: ctrl.signal,
    });

    state.grid = grid;
    applyTerrainSmoothing();
    $('gridOut').textContent = `${grid.width} × ${grid.height}`;
    $('elevOut').textContent = `${Math.round(grid.min)} – ${Math.round(grid.max)} m`;
    $('tilesOut').textContent = `${grid.tiles} @ z${grid.zoom}` + (grid.missing ? ` (${grid.missing} missing)` : '');

    if (levels?.length) { state.thresholds = levels; writeThresholds(); }
    else generateThresholds();
    await rebuild();
    switchView(view);
    updateSteps();
    setStatus('Elevation loaded', 'ok');
    return true;
  } catch (e) {
    console.error(e);
    setStatus(e.message || 'Elevation fetch failed', 'err');
    return false;
  } finally {
    hideProgress();
  }
}

$('fetchDem').addEventListener('click', () => fetchElevation());

function applyTerrainSmoothing() {
  if (!state.grid) return;
  const g = state.grid;
  const values = smoothGrid(g.values, g.width, g.height, parseInt($('smoothTerrain').value, 10));
  state.smoothed = { values, width: g.width, height: g.height };
  state.hist = histogram(values);
}

/**
 * Rasterise each sheet's material to a coverage mask.
 *
 * Features get placed by testing these masks rather than by looking up the
 * elevation grid: by the time a layer is cut it has been smoothed, simplified
 * and had its small islands dropped, so its edge no longer follows the raw
 * iso-line. Testing the geometry that actually gets cut keeps every engraved
 * river and lake on a sheet that really has material under it.
 */
const MASK_PPMM = 4;

function buildMasks(sheets, W, H) {
  const mw = atLeast(1, Math.ceil(W * MASK_PPMM));
  const mh = atLeast(1, Math.ceil(H * MASK_PPMM));
  const c = document.createElement('canvas');
  c.width = mw; c.height = mh;
  const ctx = c.getContext('2d', { willReadFrequently: true });

  return sheets.map(s => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, mw, mh);
    ctx.setTransform(MASK_PPMM, 0, 0, MASK_PPMM, 0, 0);
    const p = new Path2D();
    for (const rings of s.polygons) {
      for (const r of rings) {
        if (r.length < 2) continue;
        p.moveTo(r[0][0], r[0][1]);
        for (let i = 1; i < r.length; i++) p.lineTo(r[i][0], r[i][1]);
        p.closePath();
      }
    }
    ctx.fillStyle = '#fff';
    ctx.fill(p, 'evenodd');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const px = ctx.getImageData(0, 0, mw, mh).data;
    const m = new Uint8Array(mw * mh);
    for (let i = 0; i < m.length; i++) m[i] = px[i * 4 + 3] > 127 ? 1 : 0;
    return { m, mw, mh };
  });
}

function inMask(mask, x, y) {
  const px = Math.floor(x * MASK_PPMM), py = Math.floor(y * MASK_PPMM);
  if (px < 0 || py < 0 || px >= mask.mw || py >= mask.mh) return false;
  return mask.m[py * mask.mw + px] === 1;
}

/**
 * The part of each layer you can actually see from above: its own material,
 * minus whatever the layer above covers up. Lettering has to sit entirely
 * within one of these or it disappears under the next plate.
 */
function buildExposed(masks) {
  return masks.map((mk, i) => {
    const above = masks[i + 1];
    const m = new Uint8Array(mk.m.length);
    for (let k = 0; k < m.length; k++) m[k] = mk.m[k] && !(above && above.m[k]) ? 1 : 0;
    return { m, mw: mk.mw, mh: mk.mh };
  });
}

/** Is this whole rectangle inside the mask? */
function boxInMask(mask, x0, y0, x1, y1, step = 0.4) {
  for (let y = y0; y < y1 + step; y += step) {
    const yy = Math.min(y, y1);
    for (let x = x0; x < x1 + step; x += step) {
      if (!inMask(mask, Math.min(x, x1), yy)) return false;
    }
  }
  return true;
}

/**
 * The outline edges of a sheet, bucketed on a coarse grid.
 *
 * The coverage masks are a 0.25 mm raster, so a cut located on them can sit up
 * to half a cell from where the plate really ends — enough to leave a visible
 * nick in a road, or a letter that stops short of the step. Snapping the cut to
 * the nearest point on the actual outline puts it exactly on the edge that gets
 * cut, and since both pieces use the snapped point they still meet.
 */
const EDGE_CELL = 4;                    // mm; a few hundred cells for a sheet

function buildEdgeIndex(sheet, W, H) {
  const cols = atLeast(1, Math.ceil(W / EDGE_CELL));
  const rows = atLeast(1, Math.ceil(H / EDGE_CELL));
  const cells = new Array(cols * rows);
  for (const rings of sheet.polygons || []) {
    for (const r of rings) {
      for (let i = 1; i < r.length; i++) {
        const e = [r[i - 1][0], r[i - 1][1], r[i][0], r[i][1]];
        const cx0 = Math.floor(Math.min(e[0], e[2]) / EDGE_CELL);
        const cx1 = Math.floor(Math.max(e[0], e[2]) / EDGE_CELL);
        const cy0 = Math.floor(Math.min(e[1], e[3]) / EDGE_CELL);
        const cy1 = Math.floor(Math.max(e[1], e[3]) / EDGE_CELL);
        for (let cy = cy0; cy <= cy1; cy++) {
          if (cy < 0 || cy >= rows) continue;
          for (let cx = cx0; cx <= cx1; cx++) {
            if (cx < 0 || cx >= cols) continue;
            (cells[cy * cols + cx] ||= []).push(e);
          }
        }
      }
    }
  }
  return { cells, cols, rows };
}

/**
 * Where a line crosses that outline, taken on the line itself rather than
 * pulled sideways onto the nearest edge — a cut moved off the road's own path
 * would shorten it and kink it at every step. Confined to the span the raster
 * flagged, so consecutive pieces can neither overlap nor leave a hole; where
 * geometry and raster disagree by less than a cell there is no crossing to
 * find, and the caller decides what to do about it.
 */
function crossOutline(idx, a, b) {
  if (!idx) return null;
  const p0 = a, p1 = b;
  const rx = p1[0] - p0[0], ry = p1[1] - p0[1];
  if (Math.abs(rx) < 1e-12 && Math.abs(ry) < 1e-12) return null;

  let best = null, bestD = Infinity;
  const cx0 = Math.floor(Math.min(p0[0], p1[0]) / EDGE_CELL);
  const cx1 = Math.floor(Math.max(p0[0], p1[0]) / EDGE_CELL);
  const cy0 = Math.floor(Math.min(p0[1], p1[1]) / EDGE_CELL);
  const cy1 = Math.floor(Math.max(p0[1], p1[1]) / EDGE_CELL);
  for (let j = cy0; j <= cy1; j++) {
    if (j < 0 || j >= idx.rows) continue;
    for (let i = cx0; i <= cx1; i++) {
      if (i < 0 || i >= idx.cols) continue;
      for (const e of idx.cells[j * idx.cols + i] || []) {
        const sx = e[2] - e[0], sy = e[3] - e[1];
        const den = rx * sy - ry * sx;
        if (Math.abs(den) < 1e-12) continue;
        const qx = e[0] - p0[0], qy = e[1] - p0[1];
        const t = (qx * sy - qy * sx) / den;
        const u = (qx * ry - qy * rx) / den;
        if (t < 0 || t > 1 || u < 0 || u > 1) continue;
        if (t < bestD) { bestD = t; best = [p0[0] + rx * t, p0[1] + ry * t]; }
      }
    }
  }
  return best;
}

/** Point where segment a→b leaves the mask, to well under the laser's tolerance. */
function edgeCross(a, b, mask) {
  let lo = 0, hi = 1;
  for (let k = 0; k < 14; k++) {
    const m = (lo + hi) / 2;
    if (inMask(mask, a[0] + (b[0] - a[0]) * m, a[1] + (b[1] - a[1]) * m)) lo = m; else hi = m;
  }
  return [a[0] + (b[0] - a[0]) * lo, a[1] + (b[1] - a[1]) * lo];
}

/* ── thresholds ──────────────────────────────────────────────────────── */

function generateThresholds() {
  if (!state.smoothed) return;
  const g = state.smoothed;
  let min = Infinity, max = -Infinity;
  for (const v of g.values) { if (v < min) min = v; if (v > max) max = v; }
  const floor = Number.isFinite(num('thrFloor')) ? num('thrFloor') : min;
  const ceil = Number.isFinite(num('thrCeil')) ? num('thrCeil') : max;

  const mode = $('thrMode').value;
  const count = parseInt($('nLevels').value, 10);

  if (mode === 'depression') {
    state.thresholds = optimiseLevels(g.values, g.width, g.height, {
      count, depressions: depressionsFor(g),
      emphasis: parseInt($('emphasis').value, 10) / 100,
    });
  } else {
    state.thresholds = makeThresholds({ mode, count, min: floor, max: ceil, values: g.values });
  }
  writeThresholds();
}

/** Depressions for the current smoothed grid, cached — the fill is not cheap. */
function depressionsFor(g) {
  if (state.depCache?.values === g.values) return state.depCache.list;
  const list = findDepressions(g.values, g.width, g.height, { minDepth: 0.4, minCells: 5 });
  state.depCache = { values: g.values, list };
  return list;
}

/** Report how much of the karst the current levels actually reveal. */
function updateDolineReadout() {
  const g = state.smoothed;
  const showHint = $('thrMode').value === 'depression';
  $('dolineHint').hidden = !showHint;
  $('emphasisRow').hidden = !showHint;
  if (!g) { $('dolineOut').textContent = '—'; return; }

  const dep = depressionsFor(g);
  if (!dep.length) { $('dolineOut').textContent = 'none found'; return; }
  const { shown, total, rings } = countRendered(dep, state.thresholds);
  $('dolineOut').textContent = `${shown}/${total} shown · ${rings} rings`;
}

/**
 * Keep the Levels box showing what is actually on the histogram, so hitting
 * Generate after hand-picking does not throw the count back to where it was.
 */
function syncLevelCount() {
  const n = state.thresholds.length;
  const box = $('nLevels');
  if (n >= +box.min && n <= +box.max) box.value = n;
}

function writeThresholds() {
  $('thrList').value = state.thresholds.map(t => t.toFixed(1)).join('\n');
  syncLevelCount();
  renderHist();
  updateDerived();
  updateDolineReadout();
  syncURL();
}

function readThresholds() {
  state.thresholds = $('thrList').value
    .split(/[\n,;]+/).map(s => parseFloat(s.trim()))
    .filter(Number.isFinite).sort((a, b) => a - b);
  syncLevelCount();
  renderHist();
  updateDerived();
  updateDolineReadout();
  syncURL();
}

$('genThresholds').addEventListener('click', () => { generateThresholds(); scheduleRebuild(); });
$('thrList').addEventListener('change', () => { readThresholds(); scheduleRebuild(); });

/* ── histogram interaction ───────────────────────────────────────────── */

/**
 * The histogram is the fastest way to pick levels, so it behaves like a proper
 * control: markers drag, open ground adds, a marker click removes, and the
 * selected level takes arrow keys. Only the release rebuilds the stack — the
 * contouring is far too heavy to run on every pointer move.
 */
const histoEl = $('histo');
const histo = { hover: null, active: -1, drag: null, frame: 0 };

function renderHist() {
  if (histo.active >= state.thresholds.length) histo.active = -1;
  renderHistogram(histoEl, state.hist, state.thresholds, {
    hover: histo.hover, active: histo.active, logScale: $('histoLog').checked,
  });
}

/** Coalesce repaints during a drag — one per animation frame is plenty. */
function paintHist() {
  if (histo.frame) return;
  histo.frame = requestAnimationFrame(() => { histo.frame = 0; renderHist(); });
}

const HIT_PX = 8;

function histoAt(e) {
  const rect = histoEl.getBoundingClientRect();
  const g = histoGeom(histoEl, state.hist);
  const x = (e.clientX - rect.left) * (g.cw / (rect.width || 1));
  return { g, x, value: g.toValue(x) };
}

/** Index of the level under the pointer, or -1. */
function levelNear(g, x) {
  let best = -1, bestD = HIT_PX;
  state.thresholds.forEach((t, i) => {
    const d = Math.abs(g.toX(t) - x);
    if (d <= bestD) { bestD = d; best = i; }
  });
  return best;
}

/** Snap to round numbers by default; Alt gives continuous control. */
function snapLevel(v, g, fine) {
  const step = snapStep(g.span);
  const snapped = fine ? v : Math.round(v / step) * step;
  return +snapped.toFixed(4);
}

/** Keep a dragged level inside the range and on its own side of its neighbours. */
function clampLevel(v, i, g) {
  const gap = g.span * 0.001;
  const lo = i > 0 ? state.thresholds[i - 1] + gap : g.min;
  const hi = i < state.thresholds.length - 1 ? state.thresholds[i + 1] - gap : g.max;
  return Math.min(Math.max(v, Math.min(lo, hi)), Math.max(lo, hi));
}

/** Move one level, updating the readouts but not the (expensive) geometry. */
function setLevel(i, v) {
  state.thresholds[i] = v;
  $('thrList').value = state.thresholds.map(t => t.toFixed(1)).join('\n');
  updateDerived();
  updateDolineReadout();
  paintHist();
}

histoEl.addEventListener('pointerdown', e => {
  if (!state.hist || e.button !== 0) return;
  const { g, x, value } = histoAt(e);
  const i = levelNear(g, x);
  histo.drag = { i, startX: x, orig: i >= 0 ? state.thresholds[i] : null, value, moved: false };
  if (i >= 0) histo.active = i;
  histoEl.setPointerCapture(e.pointerId);
  histoEl.focus({ preventScroll: true });
  paintHist();
});

histoEl.addEventListener('pointermove', e => {
  if (!state.hist) return;
  const { g, x, value } = histoAt(e);
  const d = histo.drag;

  if (d && d.i >= 0) {
    if (!d.moved && Math.abs(x - d.startX) > 3) d.moved = true;
    if (d.moved) {
      histo.hover = null;
      setLevel(d.i, clampLevel(snapLevel(value, g, e.altKey), d.i, g));
    }
    return;
  }

  histo.hover = value;
  histoEl.style.cursor = levelNear(g, x) >= 0 ? 'ew-resize' : 'crosshair';
  paintHist();
});

function endLevelDrag(e) {
  const d = histo.drag;
  histo.drag = null;
  if (!d || !state.hist) return;
  if (histoEl.hasPointerCapture?.(e.pointerId)) histoEl.releasePointerCapture(e.pointerId);

  if (d.i >= 0 && !d.moved) {                       // click a marker → drop that level
    state.thresholds.splice(d.i, 1);
    histo.active = -1;
  } else if (d.i < 0) {                             // click open ground → add one
    const v = snapLevel(d.value, histoGeom(histoEl, state.hist), e.altKey);
    state.thresholds.push(v);
    state.thresholds.sort((a, b) => a - b);
    histo.active = state.thresholds.indexOf(v);
  }
  writeThresholds();
  scheduleRebuild();
}

histoEl.addEventListener('pointerup', endLevelDrag);
histoEl.addEventListener('pointercancel', e => {
  if (histo.drag?.i >= 0 && histo.drag.moved) setLevel(histo.drag.i, histo.drag.orig);
  histo.drag = null;
  renderHist();
});
histoEl.addEventListener('pointerleave', () => {
  if (histo.drag) return;
  histo.hover = null;
  paintHist();
});

histoEl.addEventListener('keydown', e => {
  if (!state.hist) return;
  const i = histo.active;

  if (e.key === 'Escape') {
    if (histo.drag?.moved && histo.drag.i >= 0) {   // abandon the drag in progress
      setLevel(histo.drag.i, histo.drag.orig);
      histo.drag = null;
    }
    histo.active = -1;
    renderHist();
    return;
  }
  if (i < 0 || i >= state.thresholds.length) return;

  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    state.thresholds.splice(i, 1);
    histo.active = -1;
    writeThresholds();
    scheduleRebuild();
    return;
  }
  const dir = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
  if (!dir) return;
  e.preventDefault();
  const g = histoGeom(histoEl, state.hist);
  const step = snapStep(g.span) * (e.shiftKey ? 5 : e.altKey ? 0.1 : 1);
  setLevel(i, clampLevel(+(state.thresholds[i] + dir * step).toFixed(4), i, g));
  scheduleRebuild();
});

$('histoLog').addEventListener('change', renderHist);

$('histoClear').addEventListener('click', () => {
  state.thresholds = [];
  histo.active = -1;
  writeThresholds();
  scheduleRebuild();
});

/* ── panel and histogram sizing ──────────────────────────────────────── */

const PANEL_DEFAULT = 352, PANEL_MIN = 300;
const HISTO_DEFAULT = 110, HISTO_MIN = 90, HISTO_MAX = 620;

const panelMax = () => Math.max(PANEL_MIN, Math.min(1000, window.innerWidth - 340));

// Kept separately from the CSS variable so a narrow window can squeeze the
// panel without the squeezed width becoming the remembered one.
let panelWanted = PANEL_DEFAULT;

function setPanelWidth(w, remember = true) {
  if (remember) panelWanted = w;
  const px = Math.round(Math.min(Math.max(w, PANEL_MIN), panelMax()));
  document.documentElement.style.setProperty('--panelW', px + 'px');
  if (remember) { try { localStorage.setItem('topo.panelW', px); } catch {} }
  return px;
}

/** Re-fit the panel after the window changes size, keeping the wanted width. */
function reflowPanel() {
  if (window.innerWidth > 900) setPanelWidth(panelWanted, false);
}

function setHistoHeight(h) {
  const px = Math.round(Math.min(Math.max(h, HISTO_MIN), HISTO_MAX));
  document.documentElement.style.setProperty('--histoH', px + 'px');
  try { localStorage.setItem('topo.histoH', px); } catch {}
  return px;
}

/** Everything that has to be told the panel just changed width. */
function afterPanelResize() {
  map.invalidateSize({ animate: false });
  drawFrame();
  redraw();
  renderHist();
}

/**
 * Wire a drag handle. Cleanup runs on a lost capture as well as a normal
 * release: a touch interrupted mid-drag must not leave the page stuck with a
 * resize cursor and no text selection.
 */
function dragSize({ grip, vertical, apply, done, reset }) {
  grip.addEventListener('pointerdown', e => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    grip.classList.add('dragging');
    document.body.classList.add(vertical ? 'resizing-v' : 'resizing');
    let frame = 0, over = false;
    const pos = ev => vertical ? ev.clientY : ev.clientX;

    const move = ev => {
      const at = pos(ev);
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; apply(at); });
    };
    const finish = (ev, commit) => {
      if (over) return;                        // pointerup is followed by lostpointercapture
      over = true;
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', onUp);
      grip.removeEventListener('pointercancel', onCancel);
      grip.removeEventListener('lostpointercapture', onCancel);
      grip.classList.remove('dragging');
      document.body.classList.remove('resizing', 'resizing-v');
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
      if (commit) apply(pos(ev));
      done?.();
    };
    const onUp = ev => finish(ev, true);
    const onCancel = ev => finish(ev, false);

    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', onUp);
    grip.addEventListener('pointercancel', onCancel);
    grip.addEventListener('lostpointercapture', onCancel);
  });
  grip.addEventListener('dblclick', reset);
}

dragSize({
  grip: $('panelGrip'),
  apply: x => { setPanelWidth(x - $('panel').getBoundingClientRect().left); afterPanelResize(); },
  reset: () => { setPanelWidth(PANEL_DEFAULT); afterPanelResize(); },
});

dragSize({
  grip: $('histoGrip'),
  vertical: true,
  apply: y => { setHistoHeight(y - histoEl.getBoundingClientRect().top); renderHist(); },
  reset: () => { setHistoHeight(HISTO_DEFAULT); renderHist(); },
});

try {
  const w = parseFloat(localStorage.getItem('topo.panelW'));
  if (Number.isFinite(w)) setPanelWidth(w);
  const h = parseFloat(localStorage.getItem('topo.histoH'));
  if (Number.isFinite(h)) setHistoHeight(h);
} catch {}

/* ── build ───────────────────────────────────────────────────────────── */

/**
 * Chamfer distance transform: for every pixel of material, how far it is from
 * the nearest edge. Anything off the canvas counts as an edge, so a hole is
 * never placed hard against the sheet boundary.
 */
function distanceTransform(mask, mw, mh) {
  const INF = 1e9;
  const d = new Float32Array(mw * mh);
  for (let i = 0; i < d.length; i++) d[i] = mask[i] ? INF : 0;
  const at = (x, y) => (x < 0 || y < 0 || x >= mw || y >= mh) ? 0 : d[y * mw + x];

  for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) {
    const i = y * mw + x;
    if (!mask[i]) continue;
    d[i] = Math.min(d[i], at(x - 1, y) + 3, at(x, y - 1) + 3,
                          at(x - 1, y - 1) + 4, at(x + 1, y - 1) + 4);
  }
  for (let y = mh - 1; y >= 0; y--) for (let x = mw - 1; x >= 0; x--) {
    const i = y * mw + x;
    if (!mask[i]) continue;
    d[i] = Math.min(d[i], at(x + 1, y) + 3, at(x, y + 1) + 3,
                          at(x + 1, y + 1) + 4, at(x - 1, y + 1) + 4);
  }
  for (let i = 0; i < d.length; i++) d[i] /= 3 * MASK_PPMM;   // -> millimetres
  return d;
}

/**
 * Everywhere on a layer a hole could go, thinned to the best spot in each
 * `cell`-millimetre square and sorted deepest first. One pass over the mask,
 * so choosing several holes costs no more scanning than choosing one.
 * Also returns the layer's extent, for judging how far apart holes should sit.
 */
function pinCandidates(mask, dt, need, cell = 4) {
  const step = cell * MASK_PPMM;
  const cols = Math.ceil(mask.mw / step);
  const best = new Map();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;

  for (let y = 0; y < mask.mh; y++) {
    for (let x = 0; x < mask.mw; x++) {
      const i = y * mask.mw + x;
      if (!mask.m[i]) continue;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;

      const c = dt[i];
      if (c < need) continue;
      const k = Math.floor(y / step) * cols + Math.floor(x / step);
      const cur = best.get(k);
      if (!cur || c > cur.c) best.set(k, { c, x: (x + 0.5) / MASK_PPMM, y: (y + 0.5) / MASK_PPMM });
    }
  }
  return {
    list: [...best.values()].sort((a, b) => b.c - a.c),
    diag: isFinite(x0) ? Math.hypot(x1 - x0, y1 - y0) / MASK_PPMM : 0,
  };
}

/**
 * Site the dowel holes.
 *
 * Working from the summit down means a hole is first placed deep inside the
 * smallest layer; because the layers nest, that same hole then passes through
 * every layer beneath it. A layer only asks for a new hole when it does not
 * already contain enough, so the high ground gets the alignment it needs
 * without peppering the base with dowels.
 */
function choosePins(sheets, masks, opts) {
  const rNeed = opts.dia / 2 + opts.margin;
  const dts = masks.map(m => distanceTransform(m.m, m.mw, m.mh));
  const pins = [];

  for (let li = sheets.length - 1; li >= 0; li--) {
    const mask = masks[li], dt = dts[li];
    const { list, diag } = pinCandidates(mask, dt, rNeed);
    if (!list.length) continue;

    // Don't drop a hole into a thin sliver just to buy separation: insist it be
    // at least half as deep as the best spot this layer has to offer, and give
    // up spacing before depth.
    const deep = Math.max(rNeed, list[0].c * 0.5);
    const inside = pins.filter(p => (dt[pixIndex(mask, p)] ?? 0) >= rNeed);

    // Two holes must never be allowed to run into each other. Centres stay at
    // least a diameter plus the margin on both sides apart, and that floor is
    // checked against *every* hole placed so far, not just the ones that fit
    // this layer — the layers below carry all of them.
    const apart = Math.max(opts.dia * 2, opts.dia + 2 * opts.margin);

    // A layer is located once it has enough holes AND they are far enough apart
    // to stop it pivoting. Holes inherited from the summit sit close together,
    // so the broad lower sheets ask for another one further out.
    const spread = () => {
      let m = 0;
      for (let i = 0; i < inside.length; i++)
        for (let j = i + 1; j < inside.length; j++)
          m = Math.max(m, Math.hypot(inside[i][0] - inside[j][0], inside[i][1] - inside[j][1]));
      return m;
    };
    const located = () => inside.length >= opts.perLayer &&
                          (inside.length < 2 || spread() >= diag * 0.3);

    while (!located() && pins.length < opts.max && inside.length < opts.perLayer + 2) {
      const clear = (c, sep) =>
        pins.every(q => Math.hypot(c.x - q[0], c.y - q[1]) >= apart) &&
        inside.every(q => Math.hypot(c.x - q[0], c.y - q[1]) >= sep);
      let pick = null;
      // Spacing degrades towards `apart` and stops there; a layer with no room
      // left for a properly clear hole simply gets one fewer.
      for (const [minC, sep] of [[deep, Math.max(diag * 0.35, apart)],
                                 [deep, Math.max(diag * 0.15, apart)],
                                 [deep, apart], [rNeed, apart]]) {
        pick = list.find(c => c.c >= minC && clear(c, sep));   // sorted, so this is the deepest
        if (pick) break;
      }
      if (!pick) break;                     // nowhere left on this layer takes a hole
      pins.push([pick.x, pick.y]);
      inside.push([pick.x, pick.y]);
    }
  }
  return { pins, dts, rNeed };
}

const pixIndex = (mask, p) => {
  const x = Math.floor(p[0] * MASK_PPMM), y = Math.floor(p[1] * MASK_PPMM);
  if (x < 0 || y < 0 || x >= mask.mw || y >= mask.mh) return -1;
  return y * mask.mw + x;
};

/**
 * Everything derived from the levels, taken off the screen.
 *
 * Clearing the levels used to leave the last piece standing: `rebuild` bailed
 * out before it could replace anything, so the previews, the layer count, the
 * download buttons and the step markers all went on describing a stack there
 * was no longer anything behind — the bar offered a ZIP of it while step 3 sat
 * empty. What is on screen has to be what the settings say.
 */
function clearBuild() {
  state.sheets = [];
  state.masks = null;
  state.pins = [];
  state.overlay = null;
  state.nesting = null;
  for (const id of ['layersOut', 'nodesOut', 'nestOut', 'nestUseOut', 'nestCapOut', 'labelOut'])
    $(id).textContent = '—';
  $('nestWarn').hidden = true;
  $('dlZip').disabled = $('dlNest').disabled = true;
  updateDerived();
  updateSteps();
  redraw();
}

async function rebuild() {
  if (!state.smoothed) return;
  if (!state.thresholds.length) { clearBuild(); return; }
  const W = num('sheetW'), H = num('sheetH');
  const kerf = num('kerf') || 0;

  const layers = buildLayers(state.smoothed, {
    thresholds: state.thresholds,
    sheetW: W, sheetH: H,
    smoothCurve: parseInt($('smoothCurve').value, 10),
    simplifyTol: num('simplifyTol'),
    minFeature: num('minFeature'),
    minHole: num('minHole'),
    kerf,
  });

  const sheets = [];
  if ($('baseFull').checked) {
    const k = kerf / 2;
    sheets.push({
      name: 'base', threshold: null,
      polygons: k > 0 ? [[[[-k, -k], [W + k, -k], [W + k, H + k], [-k, H + k], [-k, -k]]]]
                      : sheetRect(W, H),
    });
  }
  // Depression mode can put levels well under a metre apart, so whole-metre
  // names would give two different sheets the same label.
  const gaps = state.thresholds.slice(1).map((t, i) => t - state.thresholds[i]);
  const tightest = gaps.length ? Math.min(...gaps) : Infinity;
  const dp = tightest < 0.1 ? 2 : tightest < 1 ? 1 : 0;
  state.levelDP = dp;

  for (const l of layers) {
    if (!l.polygons.length) continue;
    sheets.push({ name: `${l.threshold.toFixed(dp)}m`, threshold: l.threshold, polygons: l.polygons });
  }

  sheets.forEach((s, i) => {
    s.index = i;
    s.file = `${String(i + 1).padStart(2, '0')}_${s.name}`;
    s.guide = $('engraveNext').checked && sheets[i + 1] ? sheets[i + 1].polygons : null;
  });

  state.sheets = sheets;
  state.masks = buildMasks(sheets, W, H);

  if ($('pinHoles').checked) {
    const { pins, dts, rNeed } = choosePins(sheets, state.masks, {
      dia: num('pinDia'),
      margin: num('pinMargin'),
      perLayer: parseInt($('pinsPerLayer').value, 10) || 2,
      max: parseInt($('pinMax').value, 10) || 10,
    });
    state.pins = pins;
    sheets.forEach((s, i) => {
      s.pins = pins.filter(p => {
        const ix = pixIndex(state.masks[i], p);
        return ix >= 0 && dts[i][ix] >= rNeed;
      });
    });
  } else {
    state.pins = [];
    for (const s of sheets) s.pins = null;
  }

  reprojectGeo();
  assignFeatures();
  computeNesting();

  $('layersOut').textContent = String(sheets.length);
  $('nodesOut').textContent = sheets
    .reduce((a, s) => a + s.polygons.reduce((b, p) => b + p.reduce((c, r) => c + r.length, 0), 0), 0)
    .toLocaleString('en-GB');
  $('dlZip').disabled = $('dlNest').disabled = !sheets.length;
  updateDerived();
  updateSteps();
  redraw();
}

let rebuildTimer = null;
function scheduleRebuild() {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => { rebuild().catch(e => setStatus(e.message, 'err')); }, 280);
}

/* ── OSM features ────────────────────────────────────────────────────── */

const OSM_IDS = Object.keys(FEATURE_GROUPS).map(g => ['osm_' + g, g]);

async function fetchOsm() {
  if (!state.bbox) return false;
  const groups = Object.fromEntries(OSM_IDS.map(([id, g]) => [g, $(id).checked]));
  if (!Object.values(groups).some(Boolean)) { setStatus('Pick at least one feature type', 'err'); return false; }

  state.abort?.abort();
  const ctrl = new AbortController();
  state.abort = ctrl;
  setStatus('Querying OpenStreetMap…', 'busy');
  setProgress(0.1, 'Overpass can take a while for large areas…');
  try {
    const sig = sheetSignature();
    const { features, places } = await fetchOsmFeatures({
      bbox: state.bbox, groups,
      sheetW: sig.sheetW, sheetH: sig.sheetH,
      simplifyTol: atLeast(0.05, num('simplifyTol')),
      minLength: 1.2,
      onProgress: setProgress, signal: ctrl.signal,
    });
    // Overpass can take a while, and the piece may have been reshaped while it
    // thought. These millimetres were measured on the sheet as it was.
    if (!sameSheet(sig, sheetSignature())) {
      setStatus('Sheet changed while Overpass was working — fetch OSM features again', 'err');
      return false;
    }
    state.features = features;
    state.places = places;
    state.osmFor = sig;
    const counts = Object.entries(features)
      .map(([g, d]) => `${FEATURE_GROUPS[g].label.toLowerCase()} ${d.shapes.length}`);
    if (places.length) counts.push(`place names ${places.length}`);
    $('osmOut').textContent = counts.join(', ') || 'nothing found';
    assignFeatures();
    redraw();
    updateSteps();
    syncURL();
    setStatus('OSM features loaded', 'ok');
    return true;
  } catch (e) {
    console.error(e);
    setStatus(e.message || 'Overpass failed', 'err');
    return false;
  } finally {
    hideProgress();
  }
}

$('fetchOsm').addEventListener('click', () => fetchOsm());

/**
 * Anything drawn on the sheet is held in millimetres on *that* sheet, so moving
 * the frame or changing the sheet size leaves it describing a piece that no
 * longer exists — the symptom being an OSM layer marooned in a corner at the
 * old scale.
 *
 * Imported GeoJSON survives it, because the file is still here to project
 * again. OSM shapes do not: they were clipped and stitched to the old sheet on
 * the way in and there is no lon/lat left to redo it from, so they are dropped,
 * with a word to say they need fetching again for the new one.
 *
 * @returns true when something was dropped or re-projected, so the caller can
 *          put the change on screen.
 */
function invalidateProjected() {
  const stale = !!state.osmFor && !sameSheet(state.osmFor, sheetSignature());
  if (stale) {
    state.features = null;
    state.places = [];
    state.osmFor = null;
    state.overlay = null;
    $('osmOut').textContent = '—';
    setStatus('Sheet changed — OSM features cleared, fetch them again', 'ok');
  }

  const moved = !!state.geoText;
  if (moved) reprojectGeo();
  if (!stale && !moved) return false;
  assignFeatures();
  return true;
}

/** Everything a projected coordinate depends on: the frame, and the sheet it maps onto. */
function sheetSignature() {
  const bb = state.bbox;
  return bb ? { ...bb, sheetW: num('sheetW'), sheetH: num('sheetH') } : null;
}

/** True when two signatures describe the same piece. */
function sameSheet(a, b) {
  if (!a || !b) return false;
  // A tenth of a microdegree is a centimetre of ground — far below anything the
  // frame or the millimetre-precision sheet fields can express on purpose.
  const near = (p, q) => Math.abs(p - q) < 1e-7;
  return a.sheetW === b.sheetW && a.sheetH === b.sheetH &&
         near(a.west, b.west) && near(a.east, b.east) &&
         near(a.north, b.north) && near(a.south, b.south);
}

/* ── imported GeoJSON ────────────────────────────────────────────────── */

/** Re-run the projection — the frame or the sheet size may have moved since. */
function reprojectGeo() {
  if (!state.geoText || !state.bbox) return;
  const W = num('sheetW'), H = num('sheetH');
  try {
    const { points, lines, skipped } = parseGeoJSON(
      state.geoText, makeProjector(state.bbox, W, H), W, H);
    state.geoPoints = points;
    state.geoLines = lines;
    const on = points.filter(p => p.onSheet).length;
    $('geoOut').textContent =
      `${on}/${points.length} points on sheet` +
      (lines.length ? `, ${lines.length} lines` : '') +
      (skipped && !lines.length ? '' : '');
  } catch (e) {
    setStatus(e.message, 'err');
  }
}

$('geoFile').addEventListener('change', async e => {
  const file = e.target.files?.[0];
  if (!file) return;
  if (!state.bbox) { setStatus('Choose an area first', 'err'); return; }
  try {
    state.geoText = await file.text();
    reprojectGeo();
    $('clearGeo').disabled = false;
    assignFeatures();
    redraw();
    updateSteps();
    setStatus(`Loaded ${file.name}`, 'ok');
  } catch (err) {
    console.error(err);
    state.geoText = null;
    setStatus(err.message || 'Could not read that file', 'err');
  }
});

$('clearGeo').addEventListener('click', () => {
  state.geoText = null; state.geoPoints = []; state.geoLines = [];
  $('geoFile').value = '';
  $('geoOut').textContent = '—';
  $('clearGeo').disabled = true;
  assignFeatures(); redraw(); updateSteps();
});

/** Distribute fetched features across the sheets according to the placement rule. */
function assignFeatures() {
  const sheets = state.sheets;
  if (!sheets.length) return;
  for (const s of sheets) { s.features = null; s._fpaths = null; }
  state.overlay = null;

  const hasShapes = state.features && Object.keys(state.features).length;
  const hasPlaces = state.places?.length && $('osm_place').checked;
  const hasImport = state.geoPoints?.length || state.geoLines?.length;
  if (!hasShapes && !hasPlaces && !hasImport) return;

  const W = num('sheetW'), H = num('sheetH');
  const mode = $('osmPlacement').value;
  const masks = state.masks || buildMasks(sheets, W, H);

  const bucket = sheets.map(() => ({}));
  const overlay = {};
  const push = (i, g, kind, shape) => {
    const b = mode === 'separate' ? overlay
            : (i >= 0 && i < sheets.length ? bucket[i] : null);
    if (!b) return;
    (b[g] ||= { kind, shapes: [] }).shapes.push(shape);
  };
  const sheetForPoint = (x, y) => {
    for (let i = masks.length - 1; i >= 0; i--) if (inMask(masks[i], x, y)) return i;
    return -1;
  };
  // 'top' pins everything to the surface layer; 'separate' ignores the index.
  const resolve = i => mode === 'top' ? sheets.length - 1 : i;

  /**
   * Walk a path and cut it wherever it crosses onto a different layer, ending
   * each piece exactly on the cut edge. Consecutive pieces meet at that point,
   * so a river still reads as continuous down the finished stack and no engrave
   * line runs out over material that is about to be cut away.
   *
   * The walk samples along each segment rather than only at its ends. A
   * simplified road can run straight for centimetres, crossing terrace after
   * terrace in a single segment; testing only the ends put that whole span on
   * whichever layer the far end happened to land on, which buried most of it
   * under the plates above and broke the line into visible gaps. Sampling at
   * the mask's own pitch cannot miss a crossing the mask can represent.
   */
  const STEP = 1 / MASK_PPMM;

  // Built once per assignment: the cut points are refined against these.
  const edgeIdx = sheets.map(sh => buildEdgeIndex(sh, W, H));

  const splitByLayer = shape => {
    const pieces = [];
    let cur = sheetForPoint(shape[0][0], shape[0][1]);
    let run = [shape[0]];
    let prev = shape[0];              // the previous sample, for locating the cut

    for (let i = 1; i < shape.length; i++) {
      const q = shape[i];
      const dx = q[0] - prev[0], dy = q[1] - prev[1];
      const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / STEP));
      const ax = prev[0], ay = prev[1];

      for (let k = 1; k <= steps; k++) {
        const atEnd = k === steps;
        const p = atEnd ? q : [ax + (q[0] - ax) * (k / steps), ay + (q[1] - ay) * (k / steps)];
        const si = sheetForPoint(p[0], p[1]);

        if (si !== cur) {
          // Layers nest, so climbing to a higher one keeps you on this material;
          // only a step down actually leaves it and needs trimming. And the step
          // between two layers is the outline of the higher one — the edge the
          // cut belongs on.
          const leaves = cur >= 0 && !inMask(masks[cur], p[0], p[1]);
          const hi = Math.max(cur, si);
          // Where the outline really crosses this step, or — for the odd step
          // the raster called a cell early or late, where the outline is not in
          // it at all — the raster's own estimate.
          const hit = hi >= 0 && hi < sheets.length ? crossOutline(edgeIdx[hi], prev, p) : null;
          const boundary = hit || (leaves ? edgeCross(prev, p, masks[cur]) : p);
          run.push(boundary);
          if (run.length > 1) pieces.push([cur, run]);
          // Always resume from the cut, so the two pieces share it exactly and
          // nothing is dropped between the cut and the sample that found it.
          run = boundary[0] === p[0] && boundary[1] === p[1] ? [p] : [boundary, p];
          cur = si;
        } else if (atEnd) {
          run.push(q);                // samples in between are not worth keeping
        }
        prev = p;
      }
    }
    if (run.length > 1) pieces.push([cur, run]);
    return pieces;
  };

  if (hasShapes) {
    for (const [g, data] of Object.entries(state.features)) {
      for (const shape of data.shapes) {
        if (mode !== 'byheight') { push(sheets.length - 1, g, data.kind, shape); continue; }
        const pieces = splitByLayer(shape);
        // A lake that sits within one terrace stays a closed shape. One that
        // straddles a step becomes an arc on each terrace it crosses — which is
        // what it physically does, since those shorelines are at different heights.
        if (data.kind === 'polygon' && pieces.length === 1) push(pieces[0][0], g, 'polygon', shape);
        else for (const [idx, pts] of pieces) push(idx, g, 'line', pts);
      }
    }
  }

  /* ---- engraved text and markers -------------------------------------
     A name is placed whole wherever one can be found a clear patch of visible
     terrace, moving and shrinking it to try. Only when that fails does the
     straddle rule decide: cut the lettering at the plate edge and carry it on
     down the next plate, leave the name off, or engrave it across the join. */
  const engrave = (g, i, strokes) => { for (const s of strokes) push(i, g, 'line', s); };
  const taken = [];
  const free = box => !taken.some(b => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]);

  if (hasPlaces) {
    const size = num('labelSize');
    const limit = parseInt($('labelMax').value, 10) || 0;
    const dot = $('labelDot').checked;
    const fit = $('labelFit').value;                       // split | whole | any
    const keepClear = fit !== 'any' && mode === 'byheight';
    const exposed = keepClear ? buildExposed(masks) : null;
    // A peak is a landmark, not a settlement, so size never rules one out.
    const floor = PLACE_FLOOR[$('placeMin').value] ?? PLACE_FLOOR.any;
    let drawn = 0, skipped = 0, split = 0;

    for (const p of state.places) {
      if (drawn >= limit) break;
      if (p.kind !== 'peak' && p.rank > floor) continue;
      const anchor = sheetForPoint(p.x, p.y);
      if (mode !== 'separate' && anchor < 0) continue;

      const w = textWidth(p.name, size);
      if (w > W - 2) continue;                       // no room for it at this size

      // Hunt for somewhere the name sits complete on one visible terrace. With
      // many layers the terraces are narrow bands, so a full-width name often
      // will not fit anywhere near its point at full size — hence the search
      // over offsets *and* a little shrinking before giving up.
      let placed = null;
      const sizes = exposed ? [size, size * 0.82, size * 0.68] : [size];

      outer:
      for (const sz of sizes) {
        const ww = textWidth(p.name, sz), half = ww / 2;
        if (ww > W - 2) continue;
        for (const dy of [-0.55, 1.5, -2.1, 2.8, -3.7, 4.2]) {
          for (const dx of [0, 1, -1, 2, -2]) {
            const cx = Math.max(half + 1, Math.min(W - half - 1, p.x + dx * (half + sz)));
            const by = Math.max(sz + 1, Math.min(H - 1, p.y + dy * sz));
            // the box has to allow for descenders, or a Q or comma pokes out
            const box = [cx - half - 0.6, by - sz - 0.6, cx + half + 0.6, by + sz * 0.2 + 0.6];
            if (!free(box)) continue;
            if (!exposed) { placed = { cx, by, sz, box, layer: resolve(anchor), clear: true }; break outer; }
            for (let i = anchor; i >= 0; i--) {
              if (boxInMask(exposed[i], box[0], box[1], box[2], box[3])) {
                placed = { cx, by, sz, box, layer: i, clear: true };
                break outer;
              }
            }
          }
        }
      }

      // Nothing sits clear of a step. Leave the name off, or take it at its
      // natural spot and let the plates cut it up.
      if (!placed) {
        if (fit === 'whole') { skipped++; continue; }
        const half = w / 2;
        const cx = Math.max(half + 1, Math.min(W - half - 1, p.x));
        const by = p.y - size * 0.55;
        const box = [cx - half - 0.6, by - size - 0.6, cx + half + 0.6, by + size * 0.2 + 0.6];
        if (!free(box)) continue;
        placed = { cx, by, sz: size, box, layer: resolve(anchor), clear: false };
      }

      taken.push(placed.box);
      const target = mode === 'top' ? sheets.length - 1 : placed.layer;
      const strokes = textPaths(p.name, placed.cx, placed.by, placed.sz, { anchor: 'middle' });

      // Straddling a step, each stroke is cut where it crosses and carries on
      // over the next plate down — the same treatment a river gets, and for the
      // same reason: that is where the material actually is.
      if (!placed.clear && fit === 'split' && mode === 'byheight') {
        for (const stroke of strokes)
          for (const [idx, pts] of splitByLayer(stroke)) push(idx, 'place', 'line', pts);
        split++;
      } else {
        engrave('place', target, strokes);
      }

      // The dot marks the actual spot, so it belongs on whatever layer is
      // exposed *there* — which is not necessarily the one the name moved to.
      if (dot) {
        const at = mode === 'top' ? sheets.length - 1 : (mode === 'separate' ? target : anchor);
        engrave('place', at, markerPaths(p.x, p.y, Math.max(0.4, size * 0.16), 'circle'));
      }
      drawn++;
    }
    state.labelStats = { drawn, skipped, split };
    const notes = [];
    if (split) notes.push(`${split} split`);
    if (skipped) notes.push(`${skipped} had nowhere clear`);
    $('labelOut').textContent = notes.length ? `${drawn} · ${notes.join(', ')}` : String(drawn);
  }

  if (state.geoPoints?.length) {
    const r = num('markerSize'), ns = num('pointNumSize');
    const style = $('markerStyle').value, labelMode = $('pointLabelMode').value;
    for (const p of state.geoPoints) {
      p.sheet = '';
      if (!p.onSheet) continue;
      const i = resolve(sheetForPoint(p.x, p.y));
      if (mode !== 'separate' && i < 0) continue;
      p.sheet = mode === 'separate' ? 'overlay' : (sheets[i]?.file || '');

      const strokes = markerPaths(p.x, p.y, r, style);
      const text = labelMode === 'number' ? String(p.n)
                 : labelMode === 'name' ? p.name
                 : labelMode === 'both' ? `${p.n} ${p.name}` : '';
      if (text) strokes.push(...textPaths(text, p.x + r * 1.6, p.y, ns,
                                          { anchor: 'start', baseline: 'middle' }));
      engrave('point', i, strokes);
    }
  }

  for (const line of state.geoLines || []) {
    if (mode !== 'byheight') { push(sheets.length - 1, 'point', 'line', line); continue; }
    for (const [i, pts] of splitByLayer(line)) push(i, 'point', 'line', pts);
  }

  sheets.forEach((s, i) => { s.features = Object.keys(bucket[i]).length ? bucket[i] : null; });
  if (mode === 'separate' && Object.keys(overlay).length) {
    state.overlay = {
      name: 'overlay', file: `${String(sheets.length + 1).padStart(2, '0')}_overlay`,
      threshold: null, polygons: sheetRect(W, H), features: overlay,
    };
  }
}

/* ── nesting ─────────────────────────────────────────────────────────── */

/**
 * Pack the layers onto stock boards. Each layer travels as one rigid part —
 * its guide outline, engraving and pin holes ride along with it — so only the
 * part's own bounding box matters, not the full sheet it was drawn on. That is
 * what makes the summit layers cheap to place.
 */
function computeNesting() {
  const sheets = allSheets();
  if (!sheets.length) { state.nesting = null; return; }

  const bboxes = new Map();
  const parts = [];
  for (const s of sheets) {
    const bb = polygonsBBox(s.polygons);
    if (!bb || bb.w <= 0 || bb.h <= 0) continue;
    bboxes.set(s.file, bb);
    parts.push({ id: s.file, w: bb.w, h: bb.h });
  }

  const res = packParts(parts, {
    stockW: num('stockW'), stockH: num('stockH'),
    margin: num('stockMargin'), spacing: num('partSpacing'),
    allowRotate: $('allowRotate').checked,
  });

  const byId = new Map(sheets.map(s => [s.file, s]));
  state.nesting = {
    boards: res.sheets.map(b => ({
      placements: b.placements.map(p => ({ ...p, sheet: byId.get(p.id), bbox: bboxes.get(p.id) })),
    })),
    oversize: res.oversize,
    utilisation: res.utilisation,
  };

  const n = state.nesting.boards.length;
  $('nestOut').textContent = n ? `${n} × ${num('stockW')}×${num('stockH')} mm` : '—';
  $('nestUseOut').textContent = n ? `${(state.nesting.utilisation * 100).toFixed(0)}%` : '—';

  // The board's own limit, stated in the same millimetres as the sheet size, so
  // "too big" is a number you can act on rather than a verdict. A board with
  // nothing left on it — margin wider than the stock, or a field left empty —
  // has no number to quote, so it says what to go and look at instead.
  const cap = res.capacity;
  const usable = cap.w > 0 && cap.h > 0;
  const rot = $('allowRotate').checked;
  const capText = `${fmtMM(cap.w)} × ${fmtMM(cap.h)} mm` + (rot ? ' (either way round)' : '');
  $('nestCapOut').textContent = usable ? capText : 'none';

  const warn = $('nestWarn');
  if (res.oversize.length) {
    const margin = num('stockMargin');
    warn.hidden = false;
    warn.textContent = usable
      ? `Too big for this stock: ${res.oversize.join(', ')}. ` +
        `This board takes parts up to ${capText}` +
        (margin > 0 ? `, after the ${fmtMM(margin)} mm edge margin` : '') +
        `. Use a larger board, drop the edge margin, or reduce the sheet size under Sheet & material.`
      : `This stock leaves nothing to cut from — check the stock size and edge margin above.`;
  } else {
    warn.hidden = true;
  }
  state.nestIndex = Math.min(state.nestIndex, Math.max(0, n - 1));
}

/* ── views ───────────────────────────────────────────────────────────── */

function switchView(v) {
  state.view = v;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === v));
  document.querySelectorAll('.view').forEach(el => el.classList.toggle('active', el.id === 'view-' + v));
  $('sheetNav').hidden = !(v === 'sheet' || v === 'nest');
  if (v === 'map') setTimeout(() => { map.invalidateSize(); drawFrame(); }, 0);
  if (v === 'three' && $('spin').checked && !spinFrame) spinFrame = requestAnimationFrame(spinLoop);
  redraw();
}
document.querySelectorAll('.tab').forEach(t =>
  t.addEventListener('click', () => switchView(t.dataset.view)));

function redraw() {
  const model = {
    sheetW: num('sheetW'), sheetH: num('sheetH'),
    stockW: num('stockW'), stockH: num('stockH'),
    thickness: num('thickness'),
    material: materialTone(),
    sheets: state.sheets, pinRadius: num('pinDia') / 2,
  };
  const has = state.sheets.length > 0;
  $('stackEmpty').hidden = has;
  $('sheetEmpty').hidden = has;
  $('nestEmpty').hidden = has;
  $('threeEmpty').hidden = has;
  if (!has) return;

  if (state.view === 'three') {
    render3D($('threeCanvas'), model, state.view3d);
    $('threeZoom').textContent = Math.round(state.view3d.zoom * 100) + '%';
  }

  if (state.view === 'stack') {
    renderStack($('stackCanvas'), model, state.viewStack);
    $('stackZoom').textContent = Math.round(state.viewStack.zoom * 100) + '%';
  }

  if (state.view === 'sheet') {
    state.sheetIndex = Math.max(0, Math.min(state.sheets.length - 1, state.sheetIndex));
    renderSheet($('sheetCanvas'), model, state.sheetIndex);
    const s = state.sheets[state.sheetIndex];
    $('sheetLabel').textContent =
      `${state.sheetIndex + 1}/${state.sheets.length} · ${s.threshold === null ? 'base' : s.threshold.toFixed(state.levelDP || 0) + ' m'}`;
  }

  if (state.view === 'nest') {
    const boards = state.nesting?.boards || [];
    if (!boards.length) { $('sheetLabel').textContent = 'no boards'; return; }
    state.nestIndex = Math.max(0, Math.min(boards.length - 1, state.nestIndex));
    renderNest($('nestCanvas'), boards[state.nestIndex], model);
    $('sheetLabel').textContent =
      `board ${state.nestIndex + 1}/${boards.length} · ${boards[state.nestIndex].placements.length} parts`;
  }
}

/* ── 3D turntable ────────────────────────────────────────────────────── */

const threeCanvas = $('threeCanvas');
const VIEW3D_HOME = { yaw: -0.62, tilt: 0.72, zoom: 1, x: 0, y: 0 };
const ZOOM_LO = 0.3, ZOOM_HI = 14;

/**
 * Pan is held in screen pixels, so a piece zoomed right in can still be walked
 * around. It is bounded rather than free: past a canvas-width of travel there is
 * nothing to look at, and a model shoved off the edge with no scrollbar to say
 * so looks like a bug rather than a view.
 */
function clampPan(v) {
  const lim = k => k * Math.max(1, v.zoom);
  v.x = Math.max(-lim(threeCanvas.clientWidth), Math.min(lim(threeCanvas.clientWidth), v.x));
  v.y = Math.max(-lim(threeCanvas.clientHeight), Math.min(lim(threeCanvas.clientHeight), v.y));
  return v;
}

// Left drag turns the model; shift, the middle button or the right button pans
// it — the same division of labour as every 3D viewer people already use.
const wantsPan = e => e.shiftKey || e.button === 1 || e.button === 2;
let grab = null;

threeCanvas.addEventListener('contextmenu', e => e.preventDefault());
threeCanvas.addEventListener('pointerdown', e => {
  grab = {
    pan: wantsPan(e), x: e.clientX, y: e.clientY,
    yaw: state.view3d.yaw, tilt: state.view3d.tilt,
    vx: state.view3d.x, vy: state.view3d.y,
  };
  threeCanvas.classList.toggle('panning', grab.pan);
  threeCanvas.setPointerCapture(e.pointerId);
  $('spin').checked = false;
  e.preventDefault();
});
threeCanvas.addEventListener('pointermove', e => {
  if (!grab) return;
  const dx = e.clientX - grab.x, dy = e.clientY - grab.y;
  if (grab.pan) {
    state.view3d.x = grab.vx + dx;
    state.view3d.y = grab.vy + dy;
    clampPan(state.view3d);
  } else {
    state.view3d.yaw = grab.yaw + dx * 0.008;
    state.view3d.tilt = Math.max(0.12, Math.min(Math.PI / 2, grab.tilt + dy * 0.006));
  }
  redraw();
});
const endGrab = e => {
  if (!grab) return;
  grab = null;
  threeCanvas.classList.remove('panning');
  try { threeCanvas.releasePointerCapture(e.pointerId); } catch {}
};
threeCanvas.addEventListener('pointerup', endGrab);
threeCanvas.addEventListener('pointercancel', endGrab);

// Zoom about the pointer, so whatever you are looking at is what you close in
// on. The projection is linear in the scale and the fit does not depend on the
// zoom, so holding a screen point fixed is just this one step on the pan.
threeCanvas.addEventListener('wheel', e => {
  e.preventDefault();
  const v = state.view3d;
  const before = v.zoom;
  v.zoom = Math.max(ZOOM_LO, Math.min(ZOOM_HI, v.zoom * (e.deltaY > 0 ? 1 / 1.12 : 1.12)));
  const k = v.zoom / before;
  if (k !== 1) {
    const r = threeCanvas.getBoundingClientRect();
    const mx = e.clientX - r.left - threeCanvas.clientWidth / 2;
    const my = e.clientY - r.top - threeCanvas.clientHeight / 2;
    v.x = mx - (mx - v.x) * k;
    v.y = my - (my - v.y) * k;
    clampPan(v);
  }
  redraw();
}, { passive: false });

const resetThree = () => { state.view3d = { ...VIEW3D_HOME }; redraw(); };
$('resetView').addEventListener('click', resetThree);
threeCanvas.addEventListener('dblclick', resetThree);

/* ── stacked preview: pan and zoom ───────────────────────────────────── */

// Worth having for the same reason the 3D view has it: at 1:1 a 300 mm sheet is
// a few hundred pixels, and whether a name clears its terrace or a river keeps
// to one plate is a sub-millimetre question.
const stackCanvas = $('stackCanvas');

function stackModel() {
  return { sheetW: num('sheetW'), sheetH: num('sheetH'), sheets: state.sheets };
}

stackCanvas.addEventListener('wheel', e => {
  if (!state.sheets.length) return;
  e.preventDefault();
  const r = stackCanvas.getBoundingClientRect();
  state.viewStack = zoomStackAt(stackCanvas, stackModel(), state.viewStack,
                                e.clientX - r.left, e.clientY - r.top,
                                e.deltaY > 0 ? 1 / 1.14 : 1.14);
  redraw();
}, { passive: false });

stackCanvas.addEventListener('pointerdown', e => {
  if (!state.sheets.length || e.button !== 0) return;
  stackCanvas.setPointerCapture(e.pointerId);
  stackCanvas.classList.add('dragging');
  const from = { x: e.clientX, y: e.clientY, vx: state.viewStack.x, vy: state.viewStack.y };
  const move = ev => {
    state.viewStack = clampStack(stackCanvas, stackModel(), {
      zoom: state.viewStack.zoom,
      x: from.vx + (ev.clientX - from.x),
      y: from.vy + (ev.clientY - from.y),
    });
    redraw();
  };
  const up = () => {
    stackCanvas.removeEventListener('pointermove', move);
    stackCanvas.removeEventListener('pointerup', up);
    stackCanvas.removeEventListener('pointercancel', up);
    stackCanvas.removeEventListener('lostpointercapture', up);
    stackCanvas.classList.remove('dragging');
  };
  stackCanvas.addEventListener('pointermove', move);
  stackCanvas.addEventListener('pointerup', up);
  stackCanvas.addEventListener('pointercancel', up);
  stackCanvas.addEventListener('lostpointercapture', up);
});

const resetStack = () => { state.viewStack = { zoom: 1, x: 0, y: 0 }; redraw(); };
$('resetStack').addEventListener('click', resetStack);
stackCanvas.addEventListener('dblclick', resetStack);

let spinFrame = null;
function spinLoop() {
  if (!$('spin').checked || state.view !== 'three') { spinFrame = null; return; }
  state.view3d.yaw += 0.006;
  redraw();
  spinFrame = requestAnimationFrame(spinLoop);
}
$('spin').addEventListener('change', () => {
  if ($('spin').checked && !spinFrame) spinFrame = requestAnimationFrame(spinLoop);
});

const stepView = d => {
  if (state.view === 'nest') state.nestIndex += d;
  else state.sheetIndex += d;
  redraw();
};
$('prevSheet').addEventListener('click', () => stepView(-1));
$('nextSheet').addEventListener('click', () => stepView(1));
window.addEventListener('keydown', e => {
  if ((state.view !== 'sheet' && state.view !== 'nest') ||
      e.target.matches('input,textarea,select,#histo')) return;
  if (e.key === 'ArrowLeft') stepView(-1);
  if (e.key === 'ArrowRight') stepView(1);
});
window.addEventListener('resize', () => { reflowPanel(); redraw(); renderHist(); });

/* ── export ──────────────────────────────────────────────────────────── */

function exportMeta() {
  const g = groundSize(state.bbox);
  const W = num('sheetW'), H = num('sheetH'), t = num('thickness');
  const th = state.thresholds;
  const steps = th.slice(1).map((v, i) => v - th[i]);
  const mean = steps.length ? steps.reduce((a, b) => a + b, 0) / steps.length : 0;
  return {
    generator: 'Topo Layers',
    bounds: `S ${state.bbox.south.toFixed(5)}, W ${state.bbox.west.toFixed(5)}, ` +
            `N ${state.bbox.north.toFixed(5)}, E ${state.bbox.east.toFixed(5)}`,
    sheet: `${W} × ${H} mm`,
    material: `${t} mm`,
    ground: `${fmtDist(g.width)} × ${fmtDist(g.height)}`,
    scale: fmtScale(g.width * 1000 / W),
    levels: th.map(v => Math.round(v) + 'm').join(', '),
    verticalExaggeration: mean ? +(((g.width / W) / (mean / t)).toFixed(2)) + '×' : null,
    elevationSource: DEM_SOURCES[$('demSource').value]?.label || 'custom',
    units: 'millimetres (1 SVG user unit = 1 mm)',
  };
}

function allSheets() {
  return state.overlay ? [...state.sheets, state.overlay] : state.sheets;
}

/** One SVG per stock board, named so they cut in order. */
function nestFiles() {
  const boards = state.nesting?.boards || [];
  const meta = { ...exportMeta(), stock: `${num('stockW')} × ${num('stockH')} mm`,
                 materialUsed: `${((state.nesting?.utilisation || 0) * 100).toFixed(0)}%` };
  return boards.map((b, i) => ({
    name: boards.length > 1 ? `nesting-${String(i + 1).padStart(2, '0')}.svg` : 'nesting.svg',
    data: nestSVG(b, {
      stockW: num('stockW'), stockH: num('stockH'),
      pinRadius: num('pinDia') / 2, meta, index: i + 1, total: boards.length,
    }),
  }));
}

function buildFiles() {
  const W = num('sheetW'), H = num('sheetH');
  const meta = exportMeta();
  const pinRadius = num('pinDia') / 2;
  const sheets = allSheets();
  const files = sheets.map(s => ({
    name: `${s.file}.svg`,
    data: sheetSVG(s, { W, H, pinRadius, meta: { ...meta, layer: s.file } }),
  }));

  files.push({ name: 'all-layers-in-register.svg', data: stackedSVG(sheets, { W, H, meta }) });
  for (const f of nestFiles()) files.push(f);
  if ($('makeJig').checked)
    files.push({ name: 'alignment-jig.svg',
                 data: jigSVG(state.sheets, { W, H, pins: state.pins || [], pinRadius, meta }) });
  files.push({ name: 'manifest.json', data: JSON.stringify({
    ...meta,
    nesting: {
      stock: `${num('stockW')} × ${num('stockH')} mm`,
      boards: state.nesting?.boards.length || 0,
      materialUsed: `${((state.nesting?.utilisation || 0) * 100).toFixed(0)}%`,
      tooLargeForStock: state.nesting?.oversize || [],
    },
    sheets: sheets.map(s => ({
      file: s.file + '.svg', threshold_m: s.threshold, polygons: s.polygons.length,
    })),
  }, null, 2) });
  if (state.geoPoints?.length)
    files.push({ name: 'points-key.csv', data: pointsCSV(state.geoPoints, p => p.sheet) });

  files.push({ name: 'README.txt', data: readmeText(meta, sheets) });
  return files;
}

function readmeText(meta, sheets) {
  const L = [];
  L.push('MULTI-LAYER TOPOGRAPHIC MAP', '='.repeat(46), '');
  for (const [k, v] of Object.entries(meta)) {
    if (v === null || k === 'generator') continue;
    L.push(`${k.replace(/([A-Z])/g, ' $1').toLowerCase().padEnd(24)} ${v}`);
  }
  L.push('', 'SHEETS (cut in this order, glue bottom to top)', '-'.repeat(46));
  sheets.forEach(s => L.push(
    `  ${(s.file + '.svg').padEnd(28)} ${s.threshold === null ? 'base — full sheet' : 'ground above ' + s.threshold.toFixed(state.levelDP || 0) + ' m'}`));
  L.push('',
    'STROKE COLOURS', '-'.repeat(46),
    '  #000000  black    CUT — the part outline (and pin holes)',
    '  #B4B4B4  grey     ENGRAVE — outline of the layer that sits on top;',
    '                    use it to position the next piece while gluing',
    '  #00E0E0  cyan     lakes and reservoirs',
    '  #0000FF  blue     rivers and streams',
    '  #FF0000  red      roads',
    '  #FF00FF  magenta  railways',
    '  #FF8000  orange   buildings',
    '  #00E000  green    woodland',
    '',
    'NOTES', '-'.repeat(46),
    '  * 1 SVG user unit = 1 mm. Files carry a physical size, so they should',
    '    import at true scale into LightBurn, Illustrator and Inkscape.',
    '  * nesting-NN.svg is what you actually cut: every layer packed onto stock',
    '    boards. Some parts are turned 90 degrees to save material; whatever is',
    '    engraved on a part is turned with it, so each one stays self-consistent.',
    '  * all-layers-in-register.svg overlays them for checking alignment only.',
    '  * If your laser software applies its own kerf offset, leave the kerf',
    '    setting in the generator at 0 so it is not applied twice.',
    '',
    'Elevation: AWS Terrain Tiles (SRTM/EU-DEM and friends).',
    'Features and basemap: (c) OpenStreetMap contributors, ODbL.');
  return L.join('\n');
}

$('build').addEventListener('click', () => {
  if (!state.smoothed) { setStatus('Fetch elevation first', 'err'); return; }
  setStatus('Building…', 'busy');
  setTimeout(async () => {
    try { await rebuild(); setStatus(`${state.sheets.length} layers ready`, 'ok'); }
    catch (e) { console.error(e); setStatus(e.message, 'err'); }
  }, 10);
});

$('dlZip').addEventListener('click', () => {
  try {
    download(makeZip(buildFiles()), 'topo-layers.zip');
    setStatus('ZIP downloaded', 'ok');
  } catch (e) { console.error(e); setStatus(e.message, 'err'); }
});

$('dlNest').addEventListener('click', () => {
  const files = nestFiles();
  if (!files.length) { setStatus('Nothing to nest yet', 'err'); return; }
  if (files.length === 1) {
    download(new Blob([files[0].data], { type: 'image/svg+xml' }), files[0].name);
  } else {
    download(makeZip(files), 'topo-layers-nesting.zip');
  }
  setStatus(`Nesting downloaded (${files.length} board${files.length > 1 ? 's' : ''})`, 'ok');
});

/* ── step guidance ───────────────────────────────────────────────────── */

/**
 * The panel is a long list of options, and only four of its sections are
 * actually a sequence. Those four carry a number, a done marker and a place in
 * the bar at the bottom, which always offers the one action that comes next;
 * everything else is detail you can ignore until you want it.
 *
 * The bar is the thing people miss, so it does not sit there quietly: when a
 * step completes, the section for the next one opens, scrolls into view and
 * flashes, and the pips across the top of the bar show how far along you are.
 */
const FLOW = [
  { key: 'area',   done: () => !!state.bbox },
  { key: 'dem',    done: () => !!state.grid },
  { key: 'levels', done: () => state.thresholds.length > 0 },
  { key: 'export', done: () => state.sheets.length > 0 },
];

function nextStep() {
  if (!state.bbox)
    return { key: 'area', title: 'Choose your area',
             hint: 'Search for a place, or drag the frame over the ground you want.',
             label: 'Frame the map view', run: frameToView };
  if (!state.grid)
    return { key: 'dem', title: 'Fetch the elevation',
             hint: `Your area is ${$('groundOut').textContent}. This downloads the terrain under it — free, and no key needed.`,
             label: 'Fetch elevation', run: () => $('fetchDem').click() };
  // Levels are normally generated the moment the elevation lands, so this only
  // comes up after they have been cleared — at which point "Build the layers"
  // was the offer, and it had nothing to build from.
  if (!state.thresholds.length)
    return { key: 'levels', title: 'Set the layer heights',
             hint: 'Each layer is one sheet of material. Generate a set, or place them yourself on the histogram.',
             label: 'Generate levels', run: () => $('genThresholds').click() };
  if (!state.sheets.length)
    return { key: 'export', title: 'Build the layers',
             hint: 'Turn the elevation into cut geometry.',
             label: 'Build layers', run: () => $('build').click() };
  return { key: 'export', complete: true,
           title: `${state.sheets.length} layers ready to cut`,
           hint: 'Check it on the 3D tab first. Add map detail or your own points if you want them — or take the files now.',
           label: 'Download ZIP', run: () => $('dlZip').click() };
}

// The scroll-behavior an option carries beats the one the stylesheet sets, so
// the reduced-motion rule in the CSS cannot reach a programmatic scroll. Asked
// here instead, live, because the preference can change while the page is open.
const noMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');

const scrollTo = el =>
  el.scrollIntoView({ block: 'nearest', behavior: noMotion?.matches ? 'auto' : 'smooth' });

/** Mark it, so a section that just opened cannot be missed. */
function flash(el) {
  el.classList.remove('flash');
  void el.offsetWidth;                   // restart the animation even on the same node
  el.classList.add('flash');
}

/** Put the rail's highlight on whichever step is currently unfolded. */
function syncRail() {
  const open = [...document.querySelectorAll('.grp[data-kind=step]')]
    .find(g => g.dataset.open === '1');
  for (const b of document.querySelectorAll('.srail')) {
    const on = !!open && b.dataset.goto === open.dataset.flow;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
  }
}

/**
 * Show one step and fold the other three. The four are a sequence, and only one
 * of them is ever the thing to do, so the panel shows one at a time — the rail
 * above them is what makes the other three still reachable, in any order.
 */
function openStep(key, scroll = true) {
  const g = document.querySelector(`.grp[data-flow="${key}"]`);
  if (!g) return null;
  for (const other of document.querySelectorAll('.grp[data-kind=step]'))
    other.dataset.open = other === g ? '1' : '0';
  syncRail();
  if (scroll) scrollTo(g);
  return g;
}

/** Open a step's section, put it on screen and mark it, so it cannot be missed. */
function revealStep(key) {
  const g = openStep(key);
  if (g) flash(g);
}

// The rail is a way into any step, whether or not it is the one being offered.
for (const b of document.querySelectorAll('.srail'))
  b.addEventListener('click', () => revealStep(b.dataset.goto));

// A step points at the optional sections that belong to it, so the settings
// below the divider are reachable from the place you thought of them.
for (const b of document.querySelectorAll('.jump'))
  b.addEventListener('click', () => {
    const g = document.querySelector(`.grp[data-sec="${b.dataset.jump}"]`);
    if (!g) return;
    g.dataset.open = '1';
    flash(g);
    scrollTo(g);
  });

// Which step the bar was offering last time, so the panel only jumps when the
// answer actually changes — not on every keystroke that triggers a redraw.
let offeredStep = null;

// The panel follows the flow — except across the frame the app draws for you on
// load. That one counts as step one being done, and folding step one away before
// anybody has read it hides the place search, which is the control a first visit
// goes looking for. Set the moment that opening frame is placed.
let flowLeads = false;

function updateSteps() {
  const n = nextStep();
  const pips = $('nextPips');
  if (pips.childElementCount !== FLOW.length)
    pips.innerHTML = FLOW.map(() => '<i></i>').join('');

  let flagged = false;
  FLOW.forEach((step, i) => {
    const g = document.querySelector(`.grp[data-flow="${step.key}"]`);
    const pip = pips.children[i];
    const done = step.done();
    const current = !done && !flagged;
    if (current) flagged = true;
    pip.className = done ? 'on' : current ? 'now' : '';
    const rail = document.querySelector(`.srail[data-goto="${step.key}"]`);
    if (rail) rail.dataset.state = done ? 'done' : current ? 'next' : '';
    if (!g) return;
    const chip = g.querySelector('h2 > .chip');
    if (done) { g.dataset.state = 'done'; if (chip) chip.textContent = 'done'; }
    else if (current) { g.dataset.state = 'next'; if (chip) chip.textContent = 'do this'; }
    else { g.dataset.state = ''; if (chip) chip.textContent = ''; }
  });

  $('nextCount').textContent = n.complete
    ? 'Ready' : `Step ${FLOW.findIndex(f => !f.done()) + 1} of ${FLOW.length}`;
  $('nextBar').dataset.done = n.complete ? '1' : '0';
  $('nextTitle').textContent = n.title;
  $('nextHint').textContent = n.hint;
  $('nextAction').textContent = n.label;
  $('nextAction').onclick = n.run;
  $('nextText').onclick = () => revealStep(n.key);

  // On the first paint, land without the jump.
  if (offeredStep === null) openStep(n.key, false);
  else if (offeredStep !== n.key && flowLeads) revealStep(n.key);
  offeredStep = n.key;

  // A dot on a tab that has something new to show, so the previews are not a
  // set of doors you have to try.
  const built = state.sheets.length > 0;
  for (const tab of document.querySelectorAll('.tab'))
    tab.classList.toggle('ready', built && tab.dataset.view !== 'map');

  updateSummaries();
}

/**
 * What each section is currently set to, shown in its header while it is
 * collapsed. Half the panel is closed by default, and this is what keeps that
 * from hiding anything: you can read the whole configuration off the headers
 * without opening one.
 */
function updateSummaries() {
  const set = (id, text) => { const el = $(id); if (el) el.textContent = text || ''; };
  const t = num('thickness');
  const mat = ($('material').selectedOptions[0]?.textContent || '').toLowerCase();

  set('sumArea', state.bbox ? $('groundOut').textContent : 'not set');
  set('sumSheet', `${fmtMM(num('sheetW'))} × ${fmtMM(num('sheetH'))} mm · ${fmtMM(t)} mm ${mat}`);
  set('sumDem', state.grid
    ? `${state.grid.width}×${state.grid.height} · ${Math.round(state.grid.min)}–${Math.round(state.grid.max)} m`
    : 'not fetched');
  set('sumLevels', state.thresholds.length ? `${state.thresholds.length} levels` : 'none yet');
  set('sumGeom', `smoothing ${$('smoothTerrain').value}/${$('smoothCurve').value} · min ${fmtMM(num('minFeature'))} mm`);

  const picked = OSM_IDS.filter(([id]) => $(id).checked).length;
  set('sumOsm', state.features
    ? `${Object.values(state.features).reduce((a, d) => a + d.shapes.length, 0)} shapes`
    : picked ? `${picked} types, not fetched` : 'off');

  const pts = state.geoPoints.length, lines = state.geoLines.length;
  set('sumPoints', pts || lines ? `${pts} points${lines ? `, ${lines} lines` : ''}` : 'none');

  const aids = [$('engraveNext').checked && 'glue guide', $('makeJig').checked && 'jig',
                $('pinHoles').checked && 'pins'].filter(Boolean);
  set('sumAssembly', aids.join(' · ') || 'none');

  const boards = state.nesting?.boards.length;
  set('sumNest', boards
    ? `${boards} board${boards > 1 ? 's' : ''} of ${fmtMM(num('stockW'))} × ${fmtMM(num('stockH'))} mm`
    : `${fmtMM(num('stockW'))} × ${fmtMM(num('stockH'))} mm stock`);
  set('sumExport', state.sheets.length ? `${state.sheets.length} layers` : 'not built');
}

/* ── parameter wiring ────────────────────────────────────────────────── */

/**
 * A number field has to hold a number, and one inside its own range. Left empty
 * it hands NaN to everything downstream — a NaN sheet width reaches the mask
 * canvas as a NaN size and throws out of getImageData, with the raw DOM message
 * landing in the status bar — and typed past its limits it reaches the export
 * intact, where a width of -50 mm is not an SVG any cutter will take. The min
 * and max in the markup only ever advised; this is what enforces them.
 *
 * A field carrying a placeholder is allowed to be empty: that is how the level
 * floor and ceiling say "auto".
 */
function repairNumber(el) {
  if (el.tagName !== 'INPUT' || el.type !== 'number') return false;
  if (el.placeholder && el.value.trim() === '') return false;

  const lo = parseFloat(el.min), hi = parseFloat(el.max);
  const cur = parseFloat(el.value);
  let v = cur;
  if (!Number.isFinite(v)) v = parseFloat(el.defaultValue);
  if (!Number.isFinite(v)) v = Number.isFinite(lo) ? lo : 0;
  if (Number.isFinite(lo)) v = Math.max(lo, v);
  if (Number.isFinite(hi)) v = Math.min(hi, v);

  // Leave a field that merely spells its number differently alone: "200.0" is
  // 200, and rewriting it under the caret helps nobody.
  if (Number.isFinite(cur) && cur === v) return false;
  el.value = String(v);
  return true;
}

// Capture, so the value is sound before the handlers that read it run — and so
// what the field shows is what the piece is being built from.
$('panel').addEventListener('change', e => {
  if (repairNumber(e.target)) e.target.dispatchEvent(new Event('input', { bubbles: true }));
}, true);

/** Sweep every field at once, for values that arrive without a change event. */
const repairNumbers = () =>
  document.querySelectorAll('#panel input[type=number]').forEach(repairNumber);

$('smoothTerrain').addEventListener('input', () => {
  $('smoothTerrainOut').textContent = $('smoothTerrain').value;
  applyTerrainSmoothing();
  renderHist();
  scheduleRebuild();
});
$('smoothCurve').addEventListener('input', () => {
  $('smoothCurveOut').textContent = $('smoothCurve').value;
  scheduleRebuild();
});

for (const id of ['simplifyTol', 'minFeature', 'minHole', 'kerf', 'baseFull',
                  'engraveNext', 'pinHoles', 'pinDia', 'pinsPerLayer', 'pinMargin', 'pinMax'])
  $(id).addEventListener('change', scheduleRebuild);

$('osmPlacement').addEventListener('change', () => { assignFeatures(); redraw(); });

for (const id of ['stockW', 'stockH', 'stockMargin', 'partSpacing', 'allowRotate'])
  $(id).addEventListener('change', () => { computeNesting(); updateSummaries(); redraw(); });

// Neither of these rebuilds anything — a feature type only changes what the next
// fetch will bring, and the jig is decided at export time — but both change what
// the section header claims about itself once it is closed, and a header that
// misreports the settings is the one thing it exists not to do.
for (const [id] of OSM_IDS) $(id).addEventListener('change', updateSummaries);
$('makeJig').addEventListener('change', updateSummaries);

// Annotation settings only change what is engraved, so they skip the rebuild.
for (const id of ['labelSize', 'labelMax', 'labelDot', 'labelFit', 'placeMin', 'osm_place',
                  'markerStyle', 'markerSize', 'pointNumSize', 'pointLabelMode'])
  $(id).addEventListener('change', () => { assignFeatures(); redraw(); });


for (const id of ['sheetW', 'sheetH']) {
  $(id).addEventListener('change', () => {
    if ($('lockAspect').checked) applySheetAspect();
    // Redraw now rather than at the end of the debounced rebuild, so cleared
    // detail leaves the screen when the status bar says it has gone.
    if (invalidateProjected()) redraw();
    updateDerived();
    scheduleRebuild();
  });
}
// Material and thickness: one value, four controls — the panel's pair and the
// turntable's pair. `input` rather than `change`, so dragging the slider in the
// 3D view grows the stack under your hand instead of at the end of the gesture.
$('thickness').addEventListener('input', () => syncMaterial($('thickness')));
$('material').addEventListener('change', () => syncMaterial($('material')));
$('matPreset').addEventListener('change', () => syncMaterial($('matPreset')));
$('matThickness').addEventListener('input', () => setThickness(parseFloat($('matThickness').value), $('matThickness')));
$('matRange').addEventListener('input', () => setThickness(parseFloat($('matRange').value), $('matRange')));
$('lockAspect').addEventListener('change', () => { if ($('lockAspect').checked) applySheetAspect(); });
$('nLevels').addEventListener('change', () => { generateThresholds(); scheduleRebuild(); });
$('thrMode').addEventListener('change', () => { generateThresholds(); scheduleRebuild(); });
$('emphasis').addEventListener('input', () => {
  $('emphasisOut').textContent = $('emphasis').value + '%';
  generateThresholds();
  scheduleRebuild();
});
for (const id of ['thrFloor', 'thrCeil'])
  $(id).addEventListener('change', () => { generateThresholds(); scheduleRebuild(); });

/* ── shareable links ─────────────────────────────────────────────────── */

/**
 * The address bar always holds a link back to the piece on screen: the frame,
 * the settings and the exact levels. Opening one rebuilds it and lands on the
 * turntable, because a link you send someone is a link to look at.
 *
 * Captured before any link is applied, so "differs from stock" means the stock
 * the markup ships with.
 */
const CONTROL_DEFAULTS = controlValues();

function shareParams() {
  const p = changedFrom(CONTROL_DEFAULTS, controlValues());
  // Always carried, even at stock values: with the frame driving the sheet, an
  // omitted height would be re-derived on open and quietly reshape the piece.
  p.sheetW = $('sheetW').value;
  p.sheetH = $('sheetH').value;
  if (state.bbox) p.bbox = formatBBox(state.bbox);
  // Three decimals: finer than any DEM can justify, so the levels a link
  // rebuilds are the ones that were cut, not a rounded neighbour.
  if (state.thresholds.length) p.levels = state.thresholds.map(t => +t.toFixed(3)).join(',');
  const bm = document.querySelector('input[name=bm]:checked')?.value;
  if (bm && bm !== 'osm') p.basemap = bm;
  if (state.features) p.osm = '1';       // the link re-queries Overpass for them
  return p;
}

// Built off the current href rather than origin + pathname, which comes out as
// "null/…" wherever the origin is opaque.
const shareURL = () => location.href.split('#')[0] + packHash(shareParams());

let urlTimer = 0;
function syncURL() {
  clearTimeout(urlTimer);
  urlTimer = setTimeout(() => {
    try { history.replaceState(null, '', shareURL()); } catch { /* file:// etc */ }
  }, 400);
}

// One pair of listeners covers every control in the panel, including any added
// later — nothing to keep in step by hand.
$('panel').addEventListener('change', syncURL);
$('panel').addEventListener('input', syncURL);
document.querySelectorAll('input[name=bm]').forEach(r => r.addEventListener('change', syncURL));

$('copyLink').addEventListener('click', async () => {
  const url = shareURL();
  try { history.replaceState(null, '', url); } catch { /* ignore */ }
  try {
    await navigator.clipboard.writeText(url);
    setStatus('Share link copied', 'ok');
  } catch {
    setStatus('Link is in the address bar — copy it from there', 'ok');
  }
});

/** Readouts and conditional rows that normally move with their control. */
function syncControlEcho() {
  $('smoothTerrainOut').textContent = $('smoothTerrain').value;
  $('smoothCurveOut').textContent = $('smoothCurve').value;
  $('emphasisOut').textContent = $('emphasis').value + '%';
  const src = $('demSource').value;
  $('demTokenRow').hidden = src !== 'mapbox';
  $('demCustomRow').hidden = src !== 'custom';
  syncMaterial(null);
}

/**
 * Rebuild the piece a link describes. The terrain has to come down the wire
 * before there is anything to show, so this is a fetch, not just a form fill.
 */
async function restoreShared(p) {
  applyControlValues(p);
  syncControlEcho();

  if (p.basemap && BASEMAPS[p.basemap]) {
    const radio = document.querySelector(`input[name=bm][value="${p.basemap}"]`);
    if (radio) { radio.checked = true; map.removeLayer(basemap); basemap = BASEMAPS[p.basemap].addTo(map); }
  }

  const bb = parseBBox(p.bbox);
  if (!bb) { frameToView(); setStatus('That link has no map area in it', 'err'); return; }
  state.bbox = bb;
  map.fitBounds([[bb.south, bb.west], [bb.north, bb.east]], { padding: [40, 40], animate: false });
  drawFrame();
  onAreaChanged();
  applyControlValues(p);      // the link is the authority: it outranks anything just derived
  repairNumbers();            // ...but a hand-edited one can still name a width of "abc"
  updateDerived();

  // Spin is set first: switching to the 3D view is what starts the loop.
  $('spin').checked = true;
  const ok = await fetchElevation({ levels: parseLevels(p.levels), view: 'three' });
  if (!ok) return;

  // Engraved detail is a second, slower round trip — let it land on a model
  // that is already turning rather than hold the whole link up for it.
  if (p.osm === '1') fetchOsm();
}

/* ── first run, and the help sheet ───────────────────────────────────── */

// The turntable's material controls are the panel's, mirrored: one list of
// materials, kept in the markup where the panel's copy lives.
$('matPreset').innerHTML = $('material').innerHTML;

// A dialog has to take the keyboard with it, or someone tabbing lands on the
// panel behind a modal they cannot see past. Focus goes in on open, stays
// inside while it is up, and goes back to whatever opened it on close.
const helpModal = $('helpModal');
const FOCUSABLE = 'a[href],button:not(:disabled),input:not(:disabled),' +
                  'select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])';
const inModal = () => [...helpModal.querySelectorAll(FOCUSABLE)].filter(el => el.offsetParent !== null);
let helpOpener = null;

function openHelp() {
  helpOpener = document.activeElement;
  helpModal.hidden = false;
  (helpModal.querySelector('.btn.primary') || inModal()[0])?.focus();
}
function closeHelp() {
  helpModal.hidden = true;
  helpOpener?.focus?.();
  helpOpener = null;
}
$('helpBtn').addEventListener('click', openHelp);
helpModal.addEventListener('click', e => { if (e.target.closest('[data-close]')) closeHelp(); });
helpModal.addEventListener('keydown', e => {
  if (e.key !== 'Tab') return;
  const items = inModal();
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1];
  const here = document.activeElement;
  if (e.shiftKey ? here === first : here === last) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
  }
});
window.addEventListener('keydown', e => { if (e.key === 'Escape' && !helpModal.hidden) closeHelp(); });

// The next-step bar is the whole flow, and it is also the easiest thing in the
// window to scroll past without ever reading. First-time visitors get one
// pointer at it; after that it is never shown again.
const SEEN_KEY = 'topo-layers.seen-flow';
const seen = () => { try { return localStorage.getItem(SEEN_KEY) === '1'; } catch { return true; } };
const markSeen = () => { try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* private mode */ } };

function dismissTip() { $('flowTip').hidden = true; markSeen(); }
$('flowTipGo').addEventListener('click', dismissTip);
// Acting on the bar is as good as reading the tip.
$('nextAction').addEventListener('click', dismissTip);

// Every preview starts empty, and "fetch elevation, then build" is only useful
// if the thing it names is to hand — so the empty state carries the button.
for (const b of document.querySelectorAll('.empty-go'))
  b.addEventListener('click', () => $('nextAction').click());

/* ── go ──────────────────────────────────────────────────────────────── */

$('fitFrame').addEventListener('click', frameToView);

// Escape hatch for scripting from the console: inspect state, or grab the
// generated files without going through the download button.
window.topo = { state, rebuild, buildFiles, exportMeta, map, shareURL, assignFeatures };

// A link pasted into a tab that already has the app open changes only the
// fragment, so nothing reloads — rebuild from it by hand. Our own
// history.replaceState never fires this, so it can only be someone arriving.
window.addEventListener('hashchange', () => {
  const p = unpackHash(location.hash);
  if (!p) return;
  flowLeads = true;
  restoreShared(p).catch(e => setStatus(e.message, 'err'));
});

const shared = unpackHash(location.hash);
map.whenReady(() => setTimeout(() => {
  map.invalidateSize();
  if (shared) { flowLeads = true; restoreShared(shared).catch(e => setStatus(e.message, 'err')); }
  else { frameToView(); flowLeads = true; }
}, 60));
renderHist();
syncMaterial(null);
updateSteps();
setStatus(shared ? 'Opening a shared link…' : 'Pick an area, then fetch elevation');

// Not over a shared link: that arrives already built, on the turntable, and has
// nothing left to walk anybody through.
if (!shared && !seen()) setTimeout(() => { if (!seen()) $('flowTip').hidden = false; }, 1200);
