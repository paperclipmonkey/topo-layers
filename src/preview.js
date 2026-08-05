// Canvas previews: the finished stack, and each individual sheet as cut.

import { COLOURS } from './svg.js';

function fit(canvas, W, H, pad = 28) {
  const dpr = window.devicePixelRatio || 1;
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const s = Math.min((cw - pad * 2) / W, (ch - pad * 2) / H);
  const ox = (cw - W * s) / 2, oy = (ch - H * s) / 2;
  ctx.scale(dpr, dpr);
  return { ctx, s, ox, oy, cw, ch };
}

function pathOf(polygons) {
  const p = new Path2D();
  for (const rings of polygons || []) {
    for (const r of rings) {
      if (r.length < 2) continue;
      p.moveTo(r[0][0], r[0][1]);
      for (let i = 1; i < r.length; i++) p.lineTo(r[i][0], r[i][1]);
      p.closePath();
    }
  }
  return p;
}

function featurePaths(features) {
  const out = [];
  for (const [g, data] of Object.entries(features || {})) {
    if (!data?.shapes?.length) continue;
    const p = new Path2D();
    for (const s of data.shapes) {
      if (s.length < 2) continue;
      p.moveTo(s[0][0], s[0][1]);
      for (let i = 1; i < s.length; i++) p.lineTo(s[i][0], s[i][1]);
      const closed = s.length > 3 &&
        s[0][0] === s[s.length - 1][0] && s[0][1] === s[s.length - 1][1];
      if (closed) p.closePath();
    }
    out.push([g, p]);
  }
  return out;
}

/** Warm plywood ramp — low layers dark, high layers pale. */
function layerFill(i, n) {
  const t = n > 1 ? i / (n - 1) : 1;
  const h = 34 - 6 * t;
  const sat = 26 - 12 * t;
  const l = 30 + 48 * Math.pow(t, 0.85);
  return `hsl(${h}, ${sat}%, ${l}%)`;
}

export function renderStack(canvas, model) {
  const { sheetW: W, sheetH: H, sheets } = model;
  if (!sheets?.length) return;
  const { ctx, s, ox, oy } = fit(canvas, W, H, 34);

  ctx.save();
  ctx.translate(ox, oy);
  ctx.scale(s, s);

  // faint sheet extent
  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.lineWidth = 0.6 / s;
  ctx.strokeRect(0, 0, W, H);

  sheets.forEach((sheet, i) => {
    const p = sheet._path || (sheet._path = pathOf(sheet.polygons));

    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = 7;
    ctx.shadowOffsetX = 1.5;
    ctx.shadowOffsetY = 2.5;
    ctx.fillStyle = layerFill(i, sheets.length);
    ctx.fill(p, 'evenodd');

    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = ctx.shadowOffsetX = ctx.shadowOffsetY = 0;
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 0.35 / s;
    ctx.stroke(p);

    if (sheet.features) {
      ctx.save();
      ctx.clip(p, 'evenodd');
      for (const [g, fp] of (sheet._fpaths || (sheet._fpaths = featurePaths(sheet.features)))) {
        ctx.strokeStyle = COLOURS[g] || '#888';
        ctx.lineWidth = (g === 'waterway' || g === 'water' ? 0.55 : 0.4) / s;
        ctx.globalAlpha = 0.85;
        ctx.stroke(fp);
      }
      ctx.globalAlpha = 1;
      ctx.restore();
    }
  });

  ctx.restore();
}

export function renderSheet(canvas, model, index) {
  const { sheetW: W, sheetH: H, sheets } = model;
  const sheet = sheets?.[index];
  if (!sheet) return;
  const { ctx, s, ox, oy } = fit(canvas, W, H, 34);

  ctx.save();
  ctx.translate(ox, oy);
  ctx.scale(s, s);

  // material blank
  ctx.fillStyle = '#171a1f';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 0.5 / s;
  ctx.setLineDash([2 / s, 2 / s]);
  ctx.strokeRect(0, 0, W, H);
  ctx.setLineDash([]);

  // the part itself, faintly filled so you can read what stays
  const p = sheet._path || (sheet._path = pathOf(sheet.polygons));
  ctx.fillStyle = 'rgba(232,145,58,0.10)';
  ctx.fill(p, 'evenodd');

  if (sheet.guide?.length) {
    ctx.strokeStyle = COLOURS.guide;
    ctx.lineWidth = 0.3 / s;
    ctx.globalAlpha = 0.7;
    ctx.stroke(sheet._gpath || (sheet._gpath = pathOf(sheet.guide)));
    ctx.globalAlpha = 1;
  }

  for (const [g, fp] of (sheet._fpaths || (sheet._fpaths = featurePaths(sheet.features)))) {
    ctx.strokeStyle = COLOURS[g] || '#888';
    ctx.lineWidth = 0.4 / s;
    ctx.stroke(fp);
  }

  ctx.strokeStyle = '#f3f5f8';
  ctx.lineWidth = 0.55 / s;
  ctx.stroke(p);

  if (sheet.pins?.length) {
    ctx.strokeStyle = '#f3f5f8';
    ctx.lineWidth = 0.4 / s;
    for (const [x, y] of sheet.pins) {
      ctx.beginPath();
      ctx.arc(x, y, model.pinRadius || 1.5, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  ctx.restore();
}

/** Elevation histogram with the current levels marked. */
export function renderHistogram(canvas, hist, thresholds) {
  const dpr = window.devicePixelRatio || 1;
  const cw = canvas.clientWidth, ch = canvas.clientHeight || 110;
  canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);

  if (!hist) {
    ctx.fillStyle = '#6b7482';
    ctx.font = '11px ui-sans-serif, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Fetch elevation to see the distribution', cw / 2, ch / 2 + 4);
    return;
  }

  const { counts, min, max } = hist;
  const peak = Math.max(...counts) || 1;
  const bw = cw / counts.length;
  ctx.fillStyle = '#3d4653';
  for (let i = 0; i < counts.length; i++) {
    const h = (counts[i] / peak) * (ch - 18);
    ctx.fillRect(i * bw, ch - 14 - h, Math.max(1, bw - 0.5), h);
  }

  ctx.strokeStyle = '#e8913a';
  ctx.fillStyle = '#e8913a';
  ctx.lineWidth = 1;
  ctx.font = '9px ui-monospace, monospace';
  ctx.textAlign = 'center';
  for (const t of thresholds || []) {
    const x = (t - min) / (max - min || 1) * cw;
    if (x < 0 || x > cw) continue;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, ch - 14); ctx.stroke();
    ctx.beginPath(); ctx.arc(x, 3.5, 3, 0, Math.PI * 2); ctx.fill();
  }

  ctx.fillStyle = '#6b7482';
  ctx.textAlign = 'left';
  ctx.fillText(Math.round(min) + ' m', 3, ch - 3);
  ctx.textAlign = 'right';
  ctx.fillText(Math.round(max) + ' m', cw - 3, ch - 3);
}
