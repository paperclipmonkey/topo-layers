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

/** One stock board with its packed parts, as they will be cut. */
export function renderNest(canvas, nest, model) {
  const { stockW: W, stockH: H } = model;
  if (!nest) return;
  const { ctx, s, ox, oy } = fit(canvas, W, H, 30);

  ctx.save();
  ctx.translate(ox, oy);
  ctx.scale(s, s);

  ctx.fillStyle = '#171a1f';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 0.7 / s;
  ctx.strokeRect(0, 0, W, H);

  for (const pl of nest.placements) {
    ctx.save();
    const b = pl.bbox;
    if (pl.rot) {
      ctx.translate(pl.x + b.h, pl.y);
      ctx.rotate(Math.PI / 2);
      ctx.translate(-b.x, -b.y);
    } else {
      ctx.translate(pl.x - b.x, pl.y - b.y);
    }

    const sheet = pl.sheet;
    const p = sheet._path || (sheet._path = pathOf(sheet.polygons));
    ctx.fillStyle = 'rgba(232,145,58,0.12)';
    ctx.fill(p, 'evenodd');

    if (sheet.guide?.length) {
      ctx.strokeStyle = COLOURS.guide;
      ctx.lineWidth = 0.3 / s;
      ctx.globalAlpha = 0.6;
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
      ctx.lineWidth = 0.4 / s;
      for (const [px, py] of sheet.pins) {
        ctx.beginPath();
        ctx.arc(px, py, model.pinRadius || 1.5, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.restore();

    // label in unrotated screen space, so it stays readable
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = `${Math.max(3, 9 / s)}px ui-monospace, monospace`;
    ctx.fillText(pl.sheet.file, pl.x + 1.5, pl.y + Math.max(4, 10 / s));
  }

  ctx.restore();
}

/* ── elevation histogram ─────────────────────────────────────────────── */

// Insets: room for the level handles above the plot, tick labels below, and a
// little slack at each end so a level sitting on the range limit still draws a
// whole marker.
const H_PADX = 10, H_TOP = 14, H_BOT = 16;

/**
 * Mapping between elevations and pixels for the histogram, shared by the
 * renderer and the pointer handling that drags levels around.
 */
export function histoGeom(canvas, hist) {
  const cw = canvas.clientWidth || 1;
  const min = hist ? hist.min : 0;
  const max = hist ? hist.max : 1;
  const span = (max - min) || 1;
  const w = Math.max(1, cw - H_PADX * 2);
  return {
    cw, min, max, span, padX: H_PADX,
    toX: v => H_PADX + (v - min) / span * w,
    toValue: x => min + (x - H_PADX) / w * span,
    perPx: span / w,
  };
}

/** Decimals worth showing for a level, given how much ground the range covers. */
export function levelDecimals(span) {
  return span < 20 ? 2 : span < 200 ? 1 : 0;
}

/** 1, 2 or 5 × 10ⁿ — the step sizes that read as round numbers on an axis. */
function niceStep(raw) {
  if (!(raw > 0)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * mag;
}

/** Decimals a tick needs, from its step — a 0.5 m step must not print "1 1 2". */
function tickDecimals(step) {
  return Math.min(3, Math.max(0, -Math.floor(Math.log10(step))));
}

/** The increment a dragged level snaps to, so hand-picked levels stay tidy. */
export function snapStep(span) {
  return niceStep(span / 200);
}

function fmtLevel(v, span) {
  return v.toFixed(levelDecimals(span));
}

function roundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fill();
}

/**
 * Elevation histogram with the current levels marked.
 *
 * Bands behind the bars are tinted with the same ramp the stack preview uses,
 * so a level dragged here can be read as "this is the plate that colour".
 */
export function renderHistogram(canvas, hist, thresholds, opts = {}) {
  const { hover = null, active = -1, logScale = false } = opts;
  const dpr = window.devicePixelRatio || 1;
  const cw = canvas.clientWidth || 1;
  const ch = canvas.clientHeight || 110;
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

  const g = histoGeom(canvas, hist);
  const { counts, min, max, span } = { ...hist, span: g.span };
  const yTop = H_TOP, yBase = ch - H_BOT;
  const plotH = Math.max(6, yBase - yTop);

  const levels = (thresholds || []).filter(Number.isFinite).slice().sort((a, b) => a - b);

  // Layer bands: everything above a level is one more plate in the stack. A
  // faint tint across the plot says which band you are in; the solid ribbon
  // along the baseline shows the plate colours as the stack preview draws them.
  const inRange = levels.filter(t => t > min && t < max);
  const edges = [min, ...inRange, max];
  const ribbon = Math.min(8, Math.max(4, plotH * 0.08));
  for (let i = 0; i < edges.length - 1; i++) {
    const x0 = g.toX(edges[i]), x1 = g.toX(edges[i + 1]);
    const w = Math.max(0, x1 - x0);
    ctx.fillStyle = layerFill(i, edges.length - 1);
    ctx.globalAlpha = 0.18;
    ctx.fillRect(x0, yTop, w, plotH - ribbon);
    ctx.globalAlpha = 1;
    ctx.fillRect(x0, yBase - ribbon, w, ribbon);
  }
  ctx.globalAlpha = 1;

  // Bars. A log count scale keeps the thin tail of high ground visible when a
  // few coastal bins hold most of the samples.
  const peak = Math.max(...counts) || 1;
  const scale = logScale
    ? c => Math.log1p(c) / Math.log1p(peak)
    : c => c / peak;
  const bw = (g.cw - H_PADX * 2) / counts.length;
  const barH = plotH - ribbon;
  ctx.fillStyle = 'rgba(226,233,244,0.4)';
  for (let i = 0; i < counts.length; i++) {
    if (!counts[i]) continue;
    const h = scale(counts[i]) * barH;
    ctx.fillRect(H_PADX + i * bw, yBase - ribbon - h, Math.max(1, bw - 0.5), h);
  }

  // Baseline and axis ticks.
  ctx.strokeStyle = '#39414e';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(H_PADX, yBase + 0.5); ctx.lineTo(g.cw - H_PADX, yBase + 0.5); ctx.stroke();

  ctx.font = '9px ui-monospace, monospace';
  ctx.fillStyle = '#6b7482';
  ctx.textAlign = 'center';
  // Counted in whole steps rather than accumulated, so a fractional step over a
  // shallow range neither drifts nor prints the same label twice.
  const step = niceStep(span / Math.max(2, Math.floor((g.cw - H_PADX * 2) / 74)));
  const tdp = tickDecimals(step);
  const endLabel = fmtLevel(min, span) + ' m', endLabel2 = fmtLevel(max, span) + ' m';
  const reserveL = ctx.measureText(endLabel).width + 4;
  const reserveR = ctx.measureText(endLabel2).width + 4;
  for (let k = Math.ceil(min / step); k * step <= max; k++) {
    const v = k * step;
    const x = g.toX(v);
    const label = v.toFixed(tdp);
    const half = ctx.measureText(label).width / 2 + 8;
    if (x - half < reserveL || x + half > g.cw - reserveR) continue;  // corners carry the ends
    ctx.strokeStyle = '#39414e';
    ctx.beginPath(); ctx.moveTo(x, yBase); ctx.lineTo(x, yBase + 3); ctx.stroke();
    ctx.fillText(label, x, ch - 4);
  }
  ctx.textAlign = 'left';
  ctx.fillText(endLabel, 2, ch - 4);
  ctx.textAlign = 'right';
  ctx.fillText(endLabel2, g.cw - 2, ch - 4);

  // Levels.
  const tall = plotH > 104;
  for (let i = 0; i < levels.length; i++) {
    const t = levels[i];
    const x = g.toX(t);
    if (x < -2 || x > g.cw + 2) continue;
    const isActive = i === active;
    ctx.strokeStyle = isActive ? '#f2b46b' : '#e8913a';
    ctx.fillStyle = isActive ? '#f2b46b' : '#e8913a';
    ctx.lineWidth = isActive ? 1.8 : 1;
    ctx.beginPath(); ctx.moveTo(x, yTop - 4); ctx.lineTo(x, yBase); ctx.stroke();
    ctx.beginPath(); ctx.arc(x, yTop - 7, isActive ? 4.5 : 3.4, 0, Math.PI * 2); ctx.fill();
    if (isActive) {
      ctx.strokeStyle = 'rgba(242,180,107,0.35)';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(x, yTop - 7, 7, 0, Math.PI * 2); ctx.stroke();
    }

    // Value alongside the line, once the panel is wide or tall enough to read
    // it without the labels colliding.
    const gapL = i > 0 ? x - g.toX(levels[i - 1]) : Infinity;
    const gapR = i < levels.length - 1 ? g.toX(levels[i + 1]) - x : Infinity;
    if (tall && (isActive || Math.min(gapL, gapR) > 26)) {
      ctx.save();
      ctx.translate(x - 3, yBase - ribbon - 4);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = 'left';
      ctx.font = '9px ui-monospace, monospace';
      ctx.lineWidth = 2.5;                       // dark outline: readable over the bars
      ctx.strokeStyle = 'rgba(18,20,24,0.85)';
      ctx.lineJoin = 'round';
      ctx.strokeText(fmtLevel(t, span) + ' m', 0, 0);
      ctx.fillStyle = isActive ? '#f2b46b' : '#e8a45e';
      ctx.fillText(fmtLevel(t, span) + ' m', 0, 0);
      ctx.restore();
    }
  }

  // Hover guide, with the elevation under the pointer and how much of the map
  // sits below it — the number that tells you whether a level is worth a plate.
  if (hover != null && hover >= min && hover <= max) {
    const x = g.toX(hover);
    ctx.save();
    ctx.setLineDash([2, 3]);
    ctx.strokeStyle = 'rgba(226,233,244,0.45)';
    ctx.beginPath(); ctx.moveTo(x, yTop); ctx.lineTo(x, yBase); ctx.stroke();
    ctx.restore();

    let below = 0, total = 0;
    const bin = Math.min(counts.length - 1, Math.max(0, Math.floor((hover - min) / span * counts.length)));
    for (let i = 0; i < counts.length; i++) { total += counts[i]; if (i < bin) below += counts[i]; }
    const pct = total ? Math.round(below / total * 100) : 0;
    tag(ctx, `${fmtLevel(hover, span)} m · ${pct}% below`, x, yTop - 3, g.cw, '#c9d3e2', 'rgba(20,22,26,0.9)');
  }

  if (active >= 0 && active < levels.length) {
    tag(ctx, fmtLevel(levels[active], span) + ' m', g.toX(levels[active]),
        hover != null ? yTop + 12 : yTop - 3, g.cw, '#1a1206', '#f2b46b');
  }
}

/** Small readout pinned inside the canvas so it never runs off an edge. */
function tag(ctx, text, x, y, cw, fg, bg) {
  ctx.font = '10px ui-monospace, monospace';
  const w = ctx.measureText(text).width + 10;
  const bx = Math.max(1, Math.min(cw - w - 1, x - w / 2));
  const by = Math.max(1, y - 12);
  ctx.fillStyle = bg;
  roundedRect(ctx, bx, by, w, 13, 3);
  ctx.fillStyle = fg;
  ctx.textAlign = 'center';
  ctx.fillText(text, bx + w / 2, by + 9.5);
}
