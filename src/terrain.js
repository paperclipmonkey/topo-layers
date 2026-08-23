// Fetches encoded-elevation raster tiles and resamples them into a plain
// Float32 grid covering the selected bbox.

import { TILE, worldSize, lon2x, lat2y } from './geo.js';

export const DEM_SOURCES = {
  terrarium: {
    label: 'AWS Terrain Tiles',
    url: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
    maxZoom: 15,
    decode: (r, g, b) => (r * 256 + g + b / 256) - 32768,
    // RGB 0,0,0 decodes to -32768, which is not a real elevation.
    isNoData: (r, g, b) => r === 0 && g === 0 && b === 0,
  },
  mapbox: {
    label: 'Mapbox Terrain-RGB',
    url: 'https://api.mapbox.com/v4/mapbox.terrain-rgb/{z}/{x}/{y}.pngraw?access_token={token}',
    maxZoom: 15,
    decode: (r, g, b) => -10000 + ((r * 65536 + g * 256 + b) * 0.1),
    isNoData: () => false,
  },
};

const MAX_TILES = 400;

// Nothing on Earth is outside this. Anything that is came out of a bad tile.
const EARTH_MIN = -11500, EARTH_MAX = 9000;

/*
 * Encoded-elevation tiles sometimes carry heights that are nowhere near the
 * ground. The usual cause is the provider building a zoom level by resampling
 * the one above it: blending the *bytes* of an encoded height is not the same
 * as blending the height, so wherever the encoding steps — a coastline, a
 * cliff — the filter invents values that are hundreds or thousands of metres
 * out. AWS's z15 tiles over the Pembrokeshire coast, for one, hold pixels
 * reading -21764 m in the middle of sea at -1 m, in a band a few pixels wide.
 *
 * Seventy such pixels in two million are invisible in the terrain but fatal to
 * the piece: the level spacing is laid out across the full height range, so one
 * of them drags every level down into ground that does not exist and the model
 * comes out blank. Nothing errors, because as far as the fetch is concerned the
 * tiles all arrived. So they get found and patched here, before anything
 * downstream sees a range.
 *
 * Real terrain is separated from these by two margins, and a spike only has to
 * fail one of them. It can be too far from its surroundings for any landform
 * (ABS_M, which scales with how much ground a pixel covers), or too far
 * relative to how rough its own neighbourhood is (RATIO) — a cliff sits among
 * other cliffs, a corrupt pixel sits in flat water. The roughest real tiles
 * measured (Everest, El Capitan, the Grand Canyon, from z11 to z15) stay under
 * 0.6 of the first limit and under a third of the second.
 */
const SPIKE_FLOOR_M = 40;    // a deviation smaller than this is never a spike
const SPIKE_ABS_M = 600;     // ... nor is one below this and in rough company
const SPIKE_ABS_PX = 12;     // ... where "this" grows with the ground each pixel covers
const SPIKE_RATIO = 20;      // multiples of local roughness that count as impossible
const SPIKE_MAX_FRAC = 0.01; // flagging more than this means we are misreading terrain
const SPIKE_PASSES = 4;      // one spike hides its milder neighbours from the first pass

/** Smallest zoom whose pixel grid is at least as dense as the sample grid. */
function pickZoom(bbox, gridW, maxZoom) {
  const lonSpan = bbox.east - bbox.west;
  const z = Math.ceil(Math.log2(gridW * 360 / (lonSpan * TILE)));
  return Math.max(0, Math.min(maxZoom, z));
}

function loadTile(url, signal) {
  return new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const done = ok => { img.onload = img.onerror = null; resolve(ok ? img : null); };
    img.onload = () => done(true);
    img.onerror = () => done(false);
    if (signal) signal.addEventListener('abort', () => done(false), { once: true });
    img.src = url;
  });
}

async function pool(items, limit, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await worker(items[next++]);
  });
  await Promise.all(runners);
}

/**
 * @returns {{values:Float32Array,width:number,height:number,min:number,max:number,
 *            zoom:number,tiles:number,missing:number}}
 */
export async function fetchElevationGrid({ bbox, gridW, source, token, urlTemplate,
                                           onProgress, signal }) {
  const src = DEM_SOURCES[source] || DEM_SOURCES.terrarium;
  const template = urlTemplate || src.url;

  // Grid dimensions follow the bbox's Mercator aspect so samples stay square.
  const zProbe = worldSize(12);
  const aspect = (lon2x(bbox.east, zProbe) - lon2x(bbox.west, zProbe)) /
                 (lat2y(bbox.south, zProbe) - lat2y(bbox.north, zProbe));
  const gw = Math.max(8, Math.round(gridW));
  const gh = Math.max(8, Math.round(gw / aspect));

  const z = pickZoom(bbox, gw, src.maxZoom);
  const ws = worldSize(z);
  const n = 1 << z;

  const px0 = lon2x(bbox.west, ws), px1 = lon2x(bbox.east, ws);
  const py0 = lat2y(bbox.north, ws), py1 = lat2y(bbox.south, ws);

  const tx0 = Math.floor(px0 / TILE), tx1 = Math.floor((px1 - 1e-9) / TILE);
  const ty0 = Math.floor(py0 / TILE), ty1 = Math.floor((py1 - 1e-9) / TILE);
  const ntx = Math.max(1, tx1 - tx0 + 1), nty = Math.max(1, ty1 - ty0 + 1);

  if (ntx * nty > MAX_TILES) {
    throw new Error(`Area needs ${ntx * nty} tiles at this detail level (limit ${MAX_TILES}). ` +
                    `Shrink the frame or drop the detail setting.`);
  }

  // Decode every tile into one mosaic raster.
  const mw = ntx * TILE, mh = nty * TILE;
  const mosaic = new Float32Array(mw * mh);
  mosaic.fill(NaN);

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = TILE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const jobs = [];
  for (let ty = ty0; ty <= ty1; ty++)
    for (let tx = tx0; tx <= tx1; tx++) jobs.push([tx, ty]);

  let done = 0, missing = 0, impossible = 0;
  await pool(jobs, 8, async ([tx, ty]) => {
    if (signal?.aborted) return;
    const wx = ((tx % n) + n) % n;                       // wrap at the antimeridian
    const url = template
      .replace('{z}', z).replace('{x}', wx).replace('{y}', ty)
      .replace('{token}', token || '');

    const img = await loadTile(url, signal);
    done++;
    onProgress?.(done / jobs.length, `Elevation tiles ${done}/${jobs.length}`);
    if (!img) { missing++; return; }

    ctx.clearRect(0, 0, TILE, TILE);
    ctx.drawImage(img, 0, 0);
    let data;
    try { data = ctx.getImageData(0, 0, TILE, TILE).data; }
    catch { missing++; return; }                          // tainted canvas (no CORS)

    const ox = (tx - tx0) * TILE, oy = (ty - ty0) * TILE;
    for (let y = 0; y < TILE; y++) {
      let mi = (oy + y) * mw + ox, di = y * TILE * 4;
      for (let x = 0; x < TILE; x++, mi++, di += 4) {
        const r = data[di], g = data[di + 1], b = data[di + 2];
        const v = src.isNoData(r, g, b) ? NaN : src.decode(r, g, b);
        const ok = v > EARTH_MIN && v < EARTH_MAX;        // false for NaN too
        if (!ok && !Number.isNaN(v)) impossible++;
        mosaic[mi] = ok ? v : NaN;
      }
    }
  });

  if (signal?.aborted) throw new Error('Cancelled');
  if (missing === jobs.length) throw new Error('No elevation tiles could be loaded. Check the source or your connection.');

  // Ground covered by one tile pixel, which is what makes a height jump
  // between neighbours plausible or not.
  const midLat = (bbox.north + bbox.south) / 2;
  const gsd = 156543.03392 * Math.cos(midLat * Math.PI / 180) / Math.pow(2, z);
  onProgress?.(1, 'Checking samples…');
  const spikes = despike(mosaic, mw, mh, gsd);
  const repaired = impossible + spikes;

  fillHoles(mosaic, mw, mh);

  // Resample cell centres. d3-contour treats value[i] as a cell spanning
  // [i, i+1], so sampling at (i + 0.5) keeps geometry aligned with the sheet.
  const values = new Float32Array(gw * gh);
  const mx0 = tx0 * TILE, my0 = ty0 * TILE;
  for (let j = 0; j < gh; j++) {
    const py = py0 + (py1 - py0) * (j + 0.5) / gh - my0;
    for (let i = 0; i < gw; i++) {
      const px = px0 + (px1 - px0) * (i + 0.5) / gw - mx0;
      values[j * gw + i] = bilinear(mosaic, mw, mh, px - 0.5, py - 0.5);
    }
  }

  let min = Infinity, max = -Infinity;
  for (const v of values) { if (v < min) min = v; if (v > max) max = v; }

  return { values, width: gw, height: gh, min, max, zoom: z, tiles: jobs.length, missing,
           repaired, samples: (jobs.length - missing) * TILE * TILE };
}

function bilinear(a, w, h, x, y) {
  const x0 = Math.max(0, Math.min(w - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(h - 1, Math.floor(y)));
  const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
  const fx = Math.max(0, Math.min(1, x - x0)), fy = Math.max(0, Math.min(1, y - y0));
  const v00 = a[y0 * w + x0], v10 = a[y0 * w + x1];
  const v01 = a[y1 * w + x0], v11 = a[y1 * w + x1];
  return (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy;
}

/**
 * Blank out samples that cannot be ground (see the SPIKE_ constants above) so
 * the hole filler can grow real terrain over them.
 *
 * @param {number} gsd metres of ground per pixel
 * @returns {number} samples blanked
 */
export function despike(a, w, h, gsd) {
  const absLimit = Math.max(SPIKE_ABS_M, SPIKE_ABS_PX * gsd);
  const budget = Math.floor(a.length * SPIKE_MAX_FRAC);
  const dev = new Float32Array(a.length);
  const scratch = { mean: new Float32Array(a.length), sum: new Float64Array(a.length),
                    cnt: new Int32Array(a.length) };
  let dropped = 0;

  for (let pass = 0; pass < SPIKE_PASSES; pass++) {
    // How far each sample sits from the ground around it, and how far its
    // neighbours sit from theirs. The second window is the wider of the two so
    // that a cluster of spikes cannot fill it and pass itself off as terrain.
    const mean = boxBlur(a, w, h, 4, scratch);
    for (let i = 0; i < a.length; i++) dev[i] = Math.abs(a[i] - mean[i]);
    const rough = boxBlur(dev, w, h, 6, scratch);   // overwrites mean, done with

    const flagged = [];
    for (let i = 0; i < a.length; i++) {
      const d = dev[i];
      if (!(d > SPIKE_FLOOR_M)) continue;                 // skips NaN as well
      if (d > absLimit || d > SPIKE_RATIO * Math.max(rough[i], 1)) flagged.push(i);
    }
    // Terrain this spiky all over is terrain, not damage. Leave it alone.
    if (!flagged.length || dropped + flagged.length > budget) break;
    for (const i of flagged) a[i] = NaN;
    dropped += flagged.length;
  }
  return dropped;
}

/**
 * Separable box mean of radius r, ignoring NaN; NaN where a window holds none.
 * Both passes walk the raster in row order — the column sums are carried in a
 * single row of accumulators — which on a full 400-tile mosaic is worth more
 * than the arithmetic it costs.
 */
function boxBlur(a, w, h, r, scratch) {
  const { mean: out, sum, cnt } = scratch;

  for (let y = 0; y < h; y++) {
    const row = y * w;
    let s = 0, c = 0;
    for (let x = 0, n = Math.min(r, w - 1); x <= n; x++) {
      const v = a[row + x]; if (v === v) { s += v; c++; }
    }
    for (let x = 0; x < w; x++) {
      sum[row + x] = s; cnt[row + x] = c;
      const drop = x - r, add = x + r + 1;
      if (drop >= 0) { const v = a[row + drop]; if (v === v) { s -= v; c--; } }
      if (add < w) { const v = a[row + add]; if (v === v) { s += v; c++; } }
    }
  }

  const colS = new Float64Array(w), colC = new Int32Array(w);
  for (let y = 0, n = Math.min(r, h - 1); y <= n; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) { colS[x] += sum[row + x]; colC[x] += cnt[row + x]; }
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) out[row + x] = colC[x] ? colS[x] / colC[x] : NaN;
    const drop = (y - r) * w, add = (y + r + 1) * w;
    if (y - r >= 0) for (let x = 0; x < w; x++) { colS[x] -= sum[drop + x]; colC[x] -= cnt[drop + x]; }
    if (y + r + 1 < h) for (let x = 0; x < w; x++) { colS[x] += sum[add + x]; colC[x] += cnt[add + x]; }
  }
  return out;
}

/** Grow valid values into NaN gaps (missing tiles, DEM voids). */
function fillHoles(a, w, h) {
  let holes = 0;
  for (let i = 0; i < a.length; i++) if (Number.isNaN(a[i])) holes++;
  if (!holes) return;

  for (let pass = 0; pass < 24 && holes; pass++) {
    const patch = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!Number.isNaN(a[i])) continue;
      let sum = 0, cnt = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const v = a[ny * w + nx];
        if (!Number.isNaN(v)) { sum += v; cnt++; }
      }
      if (cnt) patch.push(i, sum / cnt);
    }
    if (!patch.length) break;
    for (let k = 0; k < patch.length; k += 2) { a[patch[k]] = patch[k + 1]; holes--; }
  }
  for (let i = 0; i < a.length; i++) if (Number.isNaN(a[i])) a[i] = 0;
}

/** Separable 3-tap box blur, repeated. Softens DEM stair-stepping. */
export function smoothGrid(values, w, h, passes) {
  if (passes <= 0) return values;
  let src = Float32Array.from(values);
  let dst = new Float32Array(src.length);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const a = src[y * w + Math.max(0, x - 1)], b = src[y * w + x], c = src[y * w + Math.min(w - 1, x + 1)];
      dst[y * w + x] = (a + b + c) / 3;
    }
    for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) {
      const a = dst[Math.max(0, y - 1) * w + x], b = dst[y * w + x], c = dst[Math.min(h - 1, y + 1) * w + x];
      src[y * w + x] = (a + b + c) / 3;
    }
  }
  return src;
}

/** Histogram of elevations for the threshold picker. */
export function histogram(values, bins = 120) {
  let min = Infinity, max = -Infinity;
  for (const v of values) { if (v < min) min = v; if (v > max) max = v; }
  const counts = new Uint32Array(bins);
  const span = max - min || 1;
  for (const v of values) {
    let b = Math.floor((v - min) / span * bins);
    if (b >= bins) b = bins - 1; if (b < 0) b = 0;
    counts[b]++;
  }
  return { counts, min, max };
}
