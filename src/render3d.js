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
const DEFAULT_MATERIAL = { h: 34, s: 34, l: 58 };

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
 *              tall against the piece as the cut one will. `material` is an
 *              {h, s, l} base colour for the stock.
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

  const pal = palette(model.material);
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

  sheets.forEach((sheet, i) => {
    const zb = i * t;
    const rings = previewRings(sheet, tol);
    const k = sheets.length > 1 ? i / (sheets.length - 1) : 1;

    // Three wall buckets by which way each face turns, so the model reads as
    // lit rather than flat, at three fills per layer instead of one per quad.
    const walls = [new Path2D(), new Path2D(), new Path2D()];
    const top = new Path2D();

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
      }

      top.moveTo(bufX[0], bufY[0] - riseS);
      for (let j = 1; j < n; j++) top.lineTo(bufX[j], bufY[j] - riseS);
      top.closePath();
    }

    [-5, 0, 6].forEach((d, b) => {
      ctx.fillStyle = pal.wall(k, d);
      ctx.fill(walls[b]);
    });
    ctx.fillStyle = pal.top(k);
    ctx.fill(top, 'evenodd');

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
