import { groundSize, mercatorAspect, fmtDist, fmtScale,
         worldSize, lon2x, lat2y, y2lat } from './geo.js';
import { fetchElevationGrid, smoothGrid, histogram, DEM_SOURCES } from './terrain.js';
import { makeThresholds, buildLayers, sheetRect } from './contour.js';
import { findDepressions, optimiseLevels, countRendered } from './depression.js';
import { fetchOsmFeatures, FEATURE_GROUPS, makeProjector } from './osm.js';
import { textPaths, textWidth } from './font.js';
import { parseGeoJSON, markerPaths, pointsCSV } from './geojson.js';
import { sheetSVG, stackedSVG, nestSVG, jigSVG } from './svg.js';
import { packParts, polygonsBBox } from './nest.js';
import { renderStack, renderSheet, renderNest, renderHistogram,
         histoGeom, snapStep } from './preview.js';
import { render3D } from './render3d.js';
import { makeZip, download } from './zip.js';

const $ = id => document.getElementById(id);
const num = id => parseFloat($(id).value);

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
  places: [],          // named OSM points, engraved as labels
  geoText: null,       // imported GeoJSON, re-projected whenever the frame moves
  geoPoints: [],
  geoLines: [],
  overlay: null,
  nesting: null,
  sheetIndex: 0,
  nestIndex: 0,
  view3d: { yaw: -0.62, tilt: 0.72, zoom: 1 },
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
    g.dataset.open = g.dataset.open === '1' ? '0' : '1';
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

$('searchBtn').addEventListener('click', () => {
  const row = $('searchRow');
  row.hidden = !row.hidden;
  if (!row.hidden) $('searchInput').focus();
});
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
  updateDerived();
  updateSteps();
}

function updateDerived() {
  if (!state.bbox) return;
  const g = groundSize(state.bbox);
  const W = num('sheetW'), H = num('sheetH');
  $('groundOut').textContent = `${fmtDist(g.width)} × ${fmtDist(g.height)}`;
  $('scaleOut').textContent = fmtScale(g.width * 1000 / W);

  const th = state.thresholds;
  const t = num('thickness');
  if (th.length >= 2) {
    const steps = th.slice(1).map((v, i) => v - th[i]);
    const lo = Math.min(...steps), hi = Math.max(...steps);
    const even = hi - lo < 1e-6;
    $('intervalOut').textContent = even
      ? `${lo.toFixed(1)} m` : `${lo.toFixed(1)}–${hi.toFixed(1)} m`;
    const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
    const horiz = g.width / W;                 // metres of ground per mm across the sheet
    const vert = mean / t;                     // metres of altitude per mm up the stack
    const x = horiz / vert;
    $('exaggOut').textContent = (x < 10 ? x.toFixed(2) : x.toFixed(1)) + '×';
  } else {
    $('intervalOut').textContent = '—';
    $('exaggOut').textContent = '—';
  }
  const n = state.sheets.length || (th.length + ($('baseFull').checked ? 1 : 0));
  $('stackOut').textContent = n ? `${(n * t).toFixed(1)} mm (${n} sheets)` : '—';
}

/* ── elevation ───────────────────────────────────────────────────────── */

$('demSource').addEventListener('change', () => {
  const v = $('demSource').value;
  $('demTokenRow').hidden = v !== 'mapbox';
  $('demCustomRow').hidden = v !== 'custom';
});

$('fetchDem').addEventListener('click', async () => {
  if (!state.bbox) return;
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

    generateThresholds();
    await rebuild();
    switchView('stack');
    updateSteps();
    setStatus('Elevation loaded', 'ok');
  } catch (e) {
    console.error(e);
    setStatus(e.message || 'Elevation fetch failed', 'err');
  } finally {
    hideProgress();
  }
});

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
  const mw = Math.max(1, Math.ceil(W * MASK_PPMM));
  const mh = Math.max(1, Math.ceil(H * MASK_PPMM));
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
}

function readThresholds() {
  state.thresholds = $('thrList').value
    .split(/[\n,;]+/).map(s => parseFloat(s.trim()))
    .filter(Number.isFinite).sort((a, b) => a - b);
  syncLevelCount();
  renderHist();
  updateDerived();
  updateDolineReadout();
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

function dragSize({ grip, vertical, apply, done, reset }) {
  grip.addEventListener('pointerdown', e => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    grip.classList.add('dragging');
    document.body.classList.add(vertical ? 'resizing-v' : 'resizing');
    let frame = 0, last = null;
    const move = ev => {
      last = vertical ? ev.clientY : ev.clientX;
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; apply(last); });
    };
    const up = ev => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.classList.remove('dragging');
      document.body.classList.remove('resizing', 'resizing-v');
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
      apply(vertical ? ev.clientY : ev.clientX);
      done?.();
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
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

async function rebuild() {
  if (!state.smoothed || !state.thresholds.length) return;
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

$('fetchOsm').addEventListener('click', async () => {
  if (!state.bbox) return;
  const groups = Object.fromEntries(OSM_IDS.map(([id, g]) => [g, $(id).checked]));
  if (!Object.values(groups).some(Boolean)) { setStatus('Pick at least one feature type', 'err'); return; }

  state.abort?.abort();
  const ctrl = new AbortController();
  state.abort = ctrl;
  setStatus('Querying OpenStreetMap…', 'busy');
  setProgress(0.1, 'Overpass can take a while for large areas…');
  try {
    const { features, places } = await fetchOsmFeatures({
      bbox: state.bbox, groups,
      sheetW: num('sheetW'), sheetH: num('sheetH'),
      simplifyTol: Math.max(0.05, num('simplifyTol')),
      minLength: 1.2,
      onProgress: setProgress, signal: ctrl.signal,
    });
    state.features = features;
    state.places = places;
    const counts = Object.entries(features)
      .map(([g, d]) => `${FEATURE_GROUPS[g].label.toLowerCase()} ${d.shapes.length}`);
    if (places.length) counts.push(`place names ${places.length}`);
    $('osmOut').textContent = counts.join(', ') || 'nothing found';
    assignFeatures();
    redraw();
    updateSteps();
    setStatus('OSM features loaded', 'ok');
  } catch (e) {
    console.error(e);
    setStatus(e.message || 'Overpass failed', 'err');
  } finally {
    hideProgress();
  }
});

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
   */
  const splitByLayer = shape => {
    const pieces = [];
    let cur = sheetForPoint(shape[0][0], shape[0][1]);
    let run = [shape[0]];
    for (let i = 1; i < shape.length; i++) {
      const p = shape[i];
      const si = sheetForPoint(p[0], p[1]);
      if (si === cur) { run.push(p); continue; }

      // Layers nest, so climbing to a higher one keeps you on this material;
      // only a step down actually leaves it and needs trimming.
      const leaves = cur >= 0 && !inMask(masks[cur], p[0], p[1]);
      const boundary = leaves ? edgeCross(shape[i - 1], p, masks[cur]) : p;

      run.push(boundary);
      if (run.length > 1) pieces.push([cur, run]);
      run = leaves ? [boundary, p] : [p];
      cur = si;
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
     Lettering is never split across a layer boundary — half a word on one
     terrace and half on the next is unreadable. Each label goes whole onto
     the layer under its anchor point. */
  const engrave = (g, i, strokes) => { for (const s of strokes) push(i, g, 'line', s); };
  const taken = [];
  const free = box => !taken.some(b => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]);

  if (hasPlaces) {
    const size = num('labelSize');
    const limit = parseInt($('labelMax').value, 10) || 0;
    const dot = $('labelDot').checked;
    const keepClear = $('labelClear').checked && mode === 'byheight';
    const exposed = keepClear ? buildExposed(masks) : null;
    let drawn = 0, skipped = 0;

    for (const p of state.places) {
      if (drawn >= limit) break;
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
            if (!exposed) { placed = { cx, by, sz, box, layer: resolve(anchor) }; break outer; }
            for (let i = anchor; i >= 0; i--) {
              if (boxInMask(exposed[i], box[0], box[1], box[2], box[3])) {
                placed = { cx, by, sz, box, layer: i };
                break outer;
              }
            }
          }
        }
      }

      // Nothing fits cleanly. With "readable from above" on, a name is dropped
      // rather than engraved half onto thin air or under the plate above.
      if (!placed) {
        if (keepClear) { skipped++; continue; }
        const half = w / 2;
        const cx = Math.max(half + 1, Math.min(W - half - 1, p.x));
        const by = p.y - size * 0.55;
        const box = [cx - half - 0.6, by - size - 0.6, cx + half + 0.6, by + size * 0.2 + 0.6];
        if (!free(box)) continue;
        placed = { cx, by, sz: size, box, layer: resolve(anchor) };
      }

      taken.push(placed.box);
      const target = mode === 'top' ? sheets.length - 1 : placed.layer;
      engrave('place', target, textPaths(p.name, placed.cx, placed.by, placed.sz, { anchor: 'middle' }));

      // The dot marks the actual spot, so it belongs on whatever layer is
      // exposed *there* — which is not necessarily the one the name moved to.
      if (dot) {
        const at = mode === 'top' ? sheets.length - 1 : (mode === 'separate' ? target : anchor);
        engrave('place', at, markerPaths(p.x, p.y, Math.max(0.4, size * 0.16), 'circle'));
      }
      drawn++;
    }
    state.labelStats = { drawn, skipped };
    $('labelOut').textContent = skipped
      ? `${drawn} · ${skipped} had nowhere clear`
      : String(drawn);
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

  const warn = $('nestWarn');
  if (res.oversize.length) {
    warn.hidden = false;
    warn.textContent = `Too big for this stock: ${res.oversize.join(', ')}. ` +
      `Use a larger board, or reduce the sheet size in step 2.`;
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
    sheets: state.sheets, pinRadius: num('pinDia') / 2,
  };
  const has = state.sheets.length > 0;
  $('stackEmpty').hidden = has;
  $('sheetEmpty').hidden = has;
  $('nestEmpty').hidden = has;
  $('threeEmpty').hidden = has;
  if (!has) return;

  if (state.view === 'three') render3D($('threeCanvas'), model, state.view3d);

  if (state.view === 'stack') renderStack($('stackCanvas'), model);

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
let orbit = null;

threeCanvas.addEventListener('pointerdown', e => {
  orbit = { x: e.clientX, y: e.clientY, yaw: state.view3d.yaw, tilt: state.view3d.tilt };
  threeCanvas.setPointerCapture(e.pointerId);
  $('spin').checked = false;
});
threeCanvas.addEventListener('pointermove', e => {
  if (!orbit) return;
  state.view3d.yaw = orbit.yaw + (e.clientX - orbit.x) * 0.008;
  state.view3d.tilt = Math.max(0.12, Math.min(Math.PI / 2,
                        orbit.tilt + (e.clientY - orbit.y) * 0.006));
  redraw();
});
const endOrbit = e => {
  if (!orbit) return;
  orbit = null;
  try { threeCanvas.releasePointerCapture(e.pointerId); } catch {}
};
threeCanvas.addEventListener('pointerup', endOrbit);
threeCanvas.addEventListener('pointercancel', endOrbit);
threeCanvas.addEventListener('wheel', e => {
  e.preventDefault();
  state.view3d.zoom = Math.max(0.3, Math.min(6, state.view3d.zoom * (e.deltaY > 0 ? 0.9 : 1.1)));
  redraw();
}, { passive: false });

$('resetView').addEventListener('click', () => {
  state.view3d = { yaw: -0.62, tilt: 0.72, zoom: 1 };
  redraw();
});

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
 * actually a sequence. This marks those, and keeps one obvious action in front
 * of you at all times so there is never a question of what to do next.
 */
const FLOW = [
  { section: 0, done: () => !!state.bbox },
  { section: 2, done: () => !!state.grid },
  { section: 3, done: () => state.thresholds.length > 0 },
  { section: 9, done: () => state.sheets.length > 0 },
];

function nextStep() {
  if (!state.bbox)
    return { title: 'Choose your area',
             hint: 'Pan the map, then drag the frame over the ground you want.',
             label: 'Frame to view', run: frameToView };
  if (!state.grid)
    return { title: 'Fetch the elevation',
             hint: `Area is set to ${$('groundOut').textContent}. This downloads the terrain for it.`,
             label: 'Fetch elevation', run: () => $('fetchDem').click() };
  if (!state.sheets.length)
    return { title: 'Build the layers',
             hint: 'Turn the elevation into cut geometry.',
             label: 'Build layers', run: () => $('build').click() };
  return { title: `${state.sheets.length} layers ready to cut`,
           hint: 'Add OSM detail or your own points if you want them — or take the files now.',
           label: 'Download ZIP', run: () => $('dlZip').click() };
}

function updateSteps() {
  const groups = [...document.querySelectorAll('#panel .grp')];
  let flagged = false;
  for (const step of FLOW) {
    const g = groups[step.section];
    if (!g) continue;
    let chip = g.querySelector('h2 > .chip');
    if (!chip) {
      chip = document.createElement('span');
      chip.className = 'chip';
      g.querySelector('h2').appendChild(chip);
    }
    if (step.done()) { g.dataset.state = 'done'; chip.textContent = 'done'; }
    else if (!flagged) { g.dataset.state = 'next'; chip.textContent = 'do this'; flagged = true; }
    else { g.dataset.state = ''; chip.textContent = ''; }
  }

  const n = nextStep();
  $('nextTitle').textContent = n.title;
  $('nextHint').textContent = n.hint;
  $('nextAction').textContent = n.label;
  $('nextAction').onclick = n.run;
}

/* ── parameter wiring ────────────────────────────────────────────────── */

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
  $(id).addEventListener('change', () => { computeNesting(); redraw(); });

// Annotation settings only change what is engraved, so they skip the rebuild.
for (const id of ['labelSize', 'labelMax', 'labelDot', 'labelClear', 'osm_place',
                  'markerStyle', 'markerSize', 'pointNumSize', 'pointLabelMode'])
  $(id).addEventListener('change', () => { assignFeatures(); redraw(); });

$('thickness').addEventListener('change', () => { if (state.view === 'three') redraw(); });

for (const id of ['sheetW', 'sheetH']) {
  $(id).addEventListener('change', () => {
    if ($('lockAspect').checked) applySheetAspect();
    updateDerived();
    scheduleRebuild();
  });
}
$('thickness').addEventListener('change', updateDerived);
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

/* ── go ──────────────────────────────────────────────────────────────── */

$('fitFrame').addEventListener('click', frameToView);

// Escape hatch for scripting from the console: inspect state, or grab the
// generated files without going through the download button.
window.topo = { state, rebuild, buildFiles, exportMeta, map };

map.whenReady(() => setTimeout(() => { map.invalidateSize(); frameToView(); }, 60));
renderHist();
updateSteps();
setStatus('Pick an area, then fetch elevation');
