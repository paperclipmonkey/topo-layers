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

const shade = (h, s, l) => `hsl(${h.toFixed(0)}, ${s.toFixed(0)}%, ${l.toFixed(0)}%)`;

// Projected ring coordinates, reused frame to frame. Every node of every plate
// passes through here on each redraw, so this is the one place worth keeping
// free of allocation.
let bufX = new Float64Array(0), bufY = new Float64Array(0);
function scratch(n) {
  if (bufX.length < n) { bufX = new Float64Array(n * 2); bufY = new Float64Array(n * 2); }
}

/**
 * @param model {sheets, sheetW, sheetH, thickness}
 * @param view  {yaw, tilt, zoom}  tilt in radians above the horizon
 */
export function render3D(canvas, model, view) {
  const { sheets, sheetW: W, sheetH: H, thickness: t } = model;
  const dpr = window.devicePixelRatio || 1;
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  if (canvas.width !== Math.round(cw * dpr)) canvas.width = Math.round(cw * dpr);
  if (canvas.height !== Math.round(ch * dpr)) canvas.height = Math.round(ch * dpr);

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);
  if (!sheets?.length) return;

  const yaw = view.yaw, tilt = Math.max(0.12, Math.min(Math.PI / 2, view.tilt));
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const ct = Math.cos(tilt), st = Math.sin(tilt);
  const stackH = sheets.length * t;

  // orthographic: spin about the vertical axis, then tip the camera down
  const px = (x, y) => (x - W / 2) * cy - (y - H / 2) * sy;
  const py = (x, y, z) => ((x - W / 2) * sy + (y - H / 2) * cy) * st - z * ct;

  // fit the whole stack in view
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [cx, cyy] of [[0, 0], [W, 0], [0, H], [W, H]]) {
    for (const z of [0, stackH]) {
      const X = px(cx, cyy), Y = py(cx, cyy, z);
      if (X < x0) x0 = X; if (X > x1) x1 = X;
      if (Y < y0) y0 = Y; if (Y > y1) y1 = Y;
    }
  }
  const pad = 26;
  const s = Math.min((cw - pad * 2) / (x1 - x0), (ch - pad * 2) / (y1 - y0)) * (view.zoom || 1);
  const ox = cw / 2 - (x0 + x1) / 2 * s;
  const oy = ch / 2 - (y0 + y1) / 2 * s;
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

    const wl = 20 + 26 * Math.pow(k, 0.85);
    [-6, 0, 7].forEach((d, b) => {
      ctx.fillStyle = shade(32 - 5 * k, 24 - 9 * k, wl + d);
      ctx.fill(walls[b]);
    });
    ctx.fillStyle = shade(34 - 6 * k, 26 - 12 * k, 32 + 47 * Math.pow(k, 0.85));
    ctx.fill(top, 'evenodd');

    ctx.strokeStyle = 'rgba(0,0,0,0.30)';
    ctx.lineWidth = 0.7;
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
