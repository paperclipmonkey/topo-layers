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

  let done = 0, missing = 0;
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
        mosaic[mi] = src.isNoData(r, g, b) ? NaN : src.decode(r, g, b);
      }
    }
  });

  if (signal?.aborted) throw new Error('Cancelled');
  if (missing === jobs.length) throw new Error('No elevation tiles could be loaded. Check the source or your connection.');

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

  return { values, width: gw, height: gh, min, max, zoom: z, tiles: jobs.length, missing };
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
