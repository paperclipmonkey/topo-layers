// Turntable preview of the finished stack.
//
// No 3D library and no z-buffer needed. The layers nest strictly — each one
// sits wholly inside and above the one below — so with the camera anywhere
// above the stack, drawing bottom plate to top plate is exactly correct
// painter's order. Within a plate the walls go down first and the top face over
// them, which hides the back walls for free, since a back wall projects into
// the interior of its own top face while a front wall projects clear of it.

import { simplifyPath } from './contour.js';
import { COLOURS } from './svg.js';

function signedArea(r) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++)
    a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  return a / 2;
}

/** Rings thinned to what the screen can actually resolve, and cached per scale. */
function previewRings(sheet, tol) {
  if (sheet._r3d && sheet._r3dTol === tol) return sheet._r3d;
  const out = [];
  for (const rings of sheet.polygons || []) {
    for (const r of rings) {
      const s = simplifyPath(r, tol);
      if (s.length >= 4) out.push({ pts: s, sign: signedArea(s) >= 0 ? 1 : -1 });
    }
  }
  sheet._r3d = out; sheet._r3dTol = tol;
  return out;
}

const shade = (h, s, l) =>
  `hsl(${h.toFixed(0)}, ${Math.max(0, Math.min(100, s)).toFixed(0)}%, ${Math.max(0, Math.min(100, l)).toFixed(0)}%)`;

/** Plywood, unless the caller names something else. */
const DEFAULT_MATERIAL = { h: 34, s: 34, l: 58, grain: 0.5, ply: true };

/* ── grain ───────────────────────────────────────────────────────────────
 *
 * A plate is a piece of board, and a board has figure on it. Flat fills made
 * the stack read as tinted card: the terraces were told apart only by the line
 * between them, and nothing said what the piece would be made of.
 *
 * The figure is one tile of procedural grain, drawn once per material and used
 * as a fill pattern over the flat tone — so the ambient ramp up the stack, which
 * is what gives the terraces their depth, is left exactly as it was. The tile
 * carries only the light and dark of the figure, in the material's own hue, so
 * a pale birch does not pick up chalky white streaks and a walnut does not go
 * grey.
 *
 * Grain runs along one axis across the whole piece, because every plate is cut
 * from the same board and a stack whose figure changed direction plate to plate
 * would read as a pile of offcuts.
 */

const TILE = 256;          // px in the tile — enough to stay crisp zoomed right in
const GRAIN_MM = 90;       // millimetres of board the tile covers

/**
 * Periodic in v, so the tile repeats without a seam: every term completes a
 * whole number of cycles across it. Rings of a tree are not sinusoidal, and the
 * sharp term is what stops these reading as corduroy.
 */
function figure(u, v) {
  const TAU = Math.PI * 2;
  // The grain wanders across the board rather than running dead straight.
  const drift = 0.055 * Math.sin(TAU * u) + 0.022 * Math.sin(TAU * 2 * u + 1.3);
  const t = v + drift;
  let g = 0.55 * Math.sin(TAU * 7 * t)
        + 0.30 * Math.sin(TAU * 13 * t + 2.1)
        + 0.18 * Math.sin(TAU * 23 * t + 0.7)
        + 0.10 * Math.sin(TAU * 41 * t + 4.2);
  // Late wood is a narrow dark line, early wood a wide pale field: squaring the
  // dark side and easing the light one is what makes the two read differently.
  g = g < 0 ? -Math.pow(-g / 1.13, 1.7) : Math.pow(g / 1.13, 0.85);
  return g;
}

const tiles = new Map();

/** One material's grain, as a tile of translucent light and dark. */
function grainTile(m) {
  const key = `${m.h}|${m.s}|${m.l}|${m.grain}`;
  const hit = tiles.get(key);
  if (hit) return hit;

  const c = document.createElement('canvas');
  c.width = c.height = TILE;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(TILE, TILE);
  const d = img.data;

  // Dark figure in the material's own hue, a little deeper and warmer; light
  // figure the same hue lifted. Both are laid down as alpha, so what shows
  // through is the plate's own tone with its ambient shading intact.
  const dark = hsl(m.h - 3, Math.min(100, m.s * 1.15), Math.max(0, m.l * 0.52));
  const light = hsl(m.h + 2, m.s * 0.9, Math.min(100, m.l + 22));
  const A = 0.5 * Math.max(0, Math.min(1, m.grain));

  for (let py = 0; py < TILE; py++) {
    for (let px = 0; px < TILE; px++) {
      const g = figure(px / TILE, py / TILE);
      const [r, gr, b] = g < 0 ? dark : light;
      const a = Math.min(1, Math.abs(g)) * A;
      const i = (py * TILE + px) * 4;
      d[i] = r; d[i + 1] = gr; d[i + 2] = b; d[i + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  tiles.set(key, c);
  return c;
}

/** HSL to the 0–255 RGB the pixel buffer wants. */
function hsl(h, s, l) {
  h = ((h % 360) + 360) % 360; s = Math.max(0, Math.min(100, s)) / 100;
  l = Math.max(0, Math.min(100, l)) / 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

/**
 * Real stock is one colour all the way up: every plate is a sheet of the same
 * board. Earlier this faded light-to-dark over the stack, which read as a
 * height map rather than as material. What actually varies with depth is how
 * much light reaches a terrace — the plates above shade it — so the ramp is now
 * a shallow ambient one, and the plates are told apart by their cut edges
 * instead. Those edges are the laser's, so they are darker and browner than the
 * face: char, not shadow.
 */
function palette(mat) {
  const m = mat && Number.isFinite(mat.h) ? mat : DEFAULT_MATERIAL;
  return {
    // k runs 0 at the base to 1 at the summit
    top: k => shade(m.h, m.s * (0.94 + 0.06 * k), m.l - 17 * Math.pow(1 - k, 1.15)),
    wall: (k, d) => shade(m.h - 4, m.s * 0.8, m.l * 0.5 - 9 * Math.pow(1 - k, 1.15) + d),
  };
}

// Projected ring coordinates, reused frame to frame. Every node of every plate
// passes through here on each redraw, so this is the one place worth keeping
// free of allocation.
let bufX = new Float64Array(0), bufY = new Float64Array(0);
function scratch(n) {
  if (bufX.length < n) { bufX = new Float64Array(n * 2); bufY = new Float64Array(n * 2); }
}

/**
 * @param model {sheets, sheetW, sheetH, thickness, material}
 *              `thickness` is the real material thickness in millimetres, drawn
 *              to the same scale as the sheet, so the stack stands exactly as
 *              tall against the piece as the cut one will. `material` is the
 *              stock: an {h, s, l} base colour, `grain` for how strongly the
 *              face is figured (0 for a material with no figure), and `ply` for
 *              whether the cut edge shows veneer laminations.
 * @param view  {yaw, tilt, zoom, x, y}  tilt in radians above the horizon;
 *              x/y pan the model on screen, in CSS pixels, for looking closely
 *              at a corner of a piece that no longer fits the window.
 */
export function render3D(canvas, model, view) {
  const { sheets, sheetW: W, sheetH: H } = model;
  // A blank or nonsensical thickness field would otherwise collapse the whole
  // stack to a flat sheet, or send every coordinate to NaN.
  const t = Number.isFinite(model.thickness) && model.thickness > 0 ? model.thickness : 3;
  const dpr = window.devicePixelRatio || 1;
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  if (canvas.width !== Math.round(cw * dpr)) canvas.width = Math.round(cw * dpr);
  if (canvas.height !== Math.round(ch * dpr)) canvas.height = Math.round(ch * dpr);

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);
  if (!sheets?.length) return;

  const mat = model.material && Number.isFinite(model.material.h)
    ? model.material : DEFAULT_MATERIAL;
  const pal = palette(mat);
  const yaw = view.yaw, tilt = Math.max(0.12, Math.min(Math.PI / 2, view.tilt));
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const ct = Math.cos(tilt), st = Math.sin(tilt);
  const stackH = sheets.length * t;

  // orthographic: spin about the vertical axis, then tip the camera down
  const px = (x, y) => (x - W / 2) * cy - (y - H / 2) * sy;
  const py = (x, y, z) => ((x - W / 2) * sy + (y - H / 2) * cy) * st - z * ct;

  // Fit the stack in view — but from bounds that do not depend on the yaw.
  //
  // Fitting the *current* silhouette makes the model breathe as it turns: a
  // rectangle is wider corner-on than edge-on, so a spinning piece was rescaled
  // every frame, and it pulsed. The footprint is a W × H rectangle turning about
  // its centre, so whatever the yaw it stays inside the circle through its
  // corners; taking that radius fits once and holds. The piece then sits a
  // little smaller when it happens to be edge-on, which is the price of never
  // moving under you while you look at it.
  const R = Math.hypot(W, H) / 2;
  const x0 = -R, x1 = R;
  const y0 = -R * st - stackH * ct, y1 = R * st;
  const pad = 26;
  const fit = Math.min((cw - pad * 2) / (x1 - x0), (ch - pad * 2) / (y1 - y0));
  const s = fit * (view.zoom || 1);
  const ox = cw / 2 - (x0 + x1) / 2 * s + (view.x || 0);
  const oy = ch / 2 - (y0 + y1) / 2 * s + (view.y || 0);
  const S = (x, y, z) => [ox + px(x, y) * s, oy + py(x, y, z) * s];

  // ground shadow, to seat the model
  ctx.save();
  ctx.globalAlpha = 0.28;
  ctx.fillStyle = '#000';
  ctx.beginPath();
  const base = [[0, 0], [W, 0], [W, H], [0, H]].map(([a, b]) => S(a, b, 0));
  ctx.moveTo(base[0][0], base[0][1] + 4);
  for (let i = 1; i < base.length; i++) ctx.lineTo(base[i][0], base[i][1] + 4);
  ctx.closePath(); ctx.filter = 'blur(6px)'; ctx.fill();
  ctx.restore();

  // Thin the rings only below what a pixel can show — a third of a device
  // pixel, in millimetres. At any normal zoom that keeps every node the cut
  // geometry has, so the turntable draws the same shape as the stacked preview
  // and the sheets; only a model shrunk right down loses detail it could not
  // have displayed anyway.
  const tol = 0.33 / (s * dpr);

  // A plate's top face sits a fixed distance up the screen from its bottom, and
  // height does not move screen x at all, so one projection per node serves the
  // walls and the top alike.
  const riseS = t * ct * s;

  // The grain has to lie on the board, not on the screen, or it swims as the
  // piece turns. The top-face projection is affine in (x, y) once the height is
  // fixed, so it is exactly a pattern transform — one per plate, differing only
  // in how far up the screen that plate's face sits.
  const grain = mat.grain > 0 ? ctx.createPattern(grainTile(mat), 'repeat') : null;
  const k2p = GRAIN_MM / TILE;                    // tile pixels -> millimetres
  const grainAt = z => {
    grain.setTransform(new DOMMatrix([
      s * cy * k2p, s * sy * st * k2p,            // tile x -> screen
      -s * sy * k2p, s * cy * st * k2p,           // tile y -> screen
      ox, oy - z * ct * s,
    ]));
    return grain;
  };

  // Birch ply is a stack of thin veneers and its cut edge says so. The edge is a
  // vertical extrusion, and height only moves screen y, so a lamination is the
  // plate's own outline drawn again a fraction of the way up. Below a few pixels
  // a veneer cannot be told from its neighbour, and drawing them anyway turns
  // the whole edge into a grey band.
  const plies = mat.ply ? Math.max(2, Math.min(9, Math.round(t / 1.4))) : 0;
  const showPlies = plies > 1 && riseS > plies * 3;

  sheets.forEach((sheet, i) => {
    const zb = i * t;
    const rings = previewRings(sheet, tol);
    const k = sheets.length > 1 ? i / (sheets.length - 1) : 1;

    // Three wall buckets by which way each face turns, so the model reads as
    // lit rather than flat, at three fills per layer instead of one per quad.
    const walls = [new Path2D(), new Path2D(), new Path2D()];
    const top = new Path2D();
    // Every veneer join on every wall that faces us, gathered into one path so
    // the whole lamination is a single stroke rather than one per ply.
    const seam = showPlies ? new Path2D() : null;

    for (const { pts, sign } of rings) {
      const n = pts.length;
      scratch(n);
      for (let j = 0; j < n; j++) {
        const a = pts[j][0] - W / 2, b = pts[j][1] - H / 2;
        bufX[j] = ox + (a * cy - b * sy) * s;
        bufY[j] = oy + ((a * sy + b * cy) * st - zb * ct) * s;
      }

      for (let j = 1; j < n; j++) {
        const p = pts[j - 1], q = pts[j];
        const dx = q[0] - p[0], dy = q[1] - p[1];
        const L = Math.hypot(dx, dy);
        if (L < 1e-9) continue;
        const nx = sign * dy / L, ny = -sign * dx / L;
        const nxr = nx * cy - ny * sy;           // normal after the spin
        const nyr = nx * sy + ny * cy;
        if (nyr * st < -0.02) continue;          // faces away — its own top hides it
        const bucket = walls[nxr < -0.35 ? 0 : nxr > 0.35 ? 2 : 1];
        const xa = bufX[j - 1], ya = bufY[j - 1], xb = bufX[j], yb = bufY[j];
        bucket.moveTo(xa, ya);
        bucket.lineTo(xb, yb);
        bucket.lineTo(xb, yb - riseS);
        bucket.lineTo(xa, ya - riseS);
        bucket.closePath();
        if (seam) {
          for (let q = 1; q < plies; q++) {
            const dy = riseS * q / plies;
            seam.moveTo(xa, ya - dy); seam.lineTo(xb, yb - dy);
          }
        }
      }

      top.moveTo(bufX[0], bufY[0] - riseS);
      for (let j = 1; j < n; j++) top.lineTo(bufX[j], bufY[j] - riseS);
      top.closePath();
    }

    [-5, 0, 6].forEach((d, b) => {
      ctx.fillStyle = pal.wall(k, d);
      ctx.fill(walls[b]);
    });

    if (seam) {
      ctx.strokeStyle = 'rgba(0,0,0,0.22)';
      ctx.lineWidth = 0.7;
      ctx.stroke(seam);
    }

    ctx.fillStyle = pal.top(k);
    ctx.fill(top, 'evenodd');
    if (grain) {
      ctx.fillStyle = grainAt(zb + t);
      ctx.fill(top, 'evenodd');
    }

    // With one colour up the whole stack it is this line, not a change of
    // tone, that separates a plate from the terrace it sits on.
    ctx.strokeStyle = 'rgba(0,0,0,0.42)';
    ctx.lineWidth = 0.9;
    ctx.stroke(top);

    const zt = zb + t;

    // engraved detail, clipped to the plate it belongs to
    if (sheet.features) {
      ctx.save();
      ctx.clip(top, 'evenodd');
      for (const [g, data] of Object.entries(sheet.features)) {
        ctx.strokeStyle = COLOURS[g] || '#888';
        ctx.lineWidth = g === 'place' || g === 'point' ? 1.0 : 0.8;
        ctx.globalAlpha = 0.9;
        ctx.beginPath();
        for (const shp of data.shapes) {
          if (shp.length < 2) continue;
          const a = S(shp[0][0], shp[0][1], zt);
          ctx.moveTo(a[0], a[1]);
          for (let j = 1; j < shp.length; j++) {
            const c = S(shp[j][0], shp[j][1], zt);
            ctx.lineTo(c[0], c[1]);
          }
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    if (sheet.pins?.length) {
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.lineWidth = 0.8;
      for (const [qx, qy] of sheet.pins) {
        ctx.beginPath();
        const r = model.pinRadius || 1.5;
        for (let a = 0; a <= 16; a++) {
          const ang = a / 16 * Math.PI * 2;
          const c = S(qx + Math.cos(ang) * r, qy + Math.sin(ang) * r, zt);
          a ? ctx.lineTo(c[0], c[1]) : ctx.moveTo(c[0], c[1]);
        }
        ctx.stroke();
      }
    }
  });
}
