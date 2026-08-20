// Part nesting onto stock sheets, by the MaxRects algorithm.
//
// Each layer is packed as one rigid part, so everything engraved on it stays in
// register. Parts are placed into the free rectangle that wraps them most
// tightly (best short side fit), which beats a plain grid substantially once the
// summit layers shrink to a fraction of the base.

/** True when b sits entirely inside a. */
const contains = (a, b) =>
  b.x >= a.x && b.y >= a.y && b.x + b.w <= a.x + a.w && b.y + b.h <= a.y + a.h;

/** Carve `r` out of free rectangle `fr`, pushing the remainder onto `out`. */
function subtract(fr, r, out) {
  if (r.x >= fr.x + fr.w || r.x + r.w <= fr.x ||
      r.y >= fr.y + fr.h || r.y + r.h <= fr.y) return false;   // disjoint

  if (r.x < fr.x + fr.w && r.x + r.w > fr.x) {
    if (r.y > fr.y && r.y < fr.y + fr.h)
      out.push({ x: fr.x, y: fr.y, w: fr.w, h: r.y - fr.y });
    if (r.y + r.h < fr.y + fr.h)
      out.push({ x: fr.x, y: r.y + r.h, w: fr.w, h: fr.y + fr.h - (r.y + r.h) });
  }
  if (r.y < fr.y + fr.h && r.y + r.h > fr.y) {
    if (r.x > fr.x && r.x < fr.x + fr.w)
      out.push({ x: fr.x, y: fr.y, w: r.x - fr.x, h: fr.h });
    if (r.x + r.w < fr.x + fr.w)
      out.push({ x: r.x + r.w, y: fr.y, w: fr.x + fr.w - (r.x + r.w), h: fr.h });
  }
  return true;
}

/** Drop free rectangles wholly covered by another. */
function prune(free) {
  for (let i = 0; i < free.length; i++) {
    for (let j = i + 1; j < free.length; j++) {
      if (contains(free[j], free[i])) { free.splice(i, 1); i--; break; }
      if (contains(free[i], free[j])) { free.splice(j, 1); j--; }
    }
  }
}

function findSpot(bin, w, h, allowRotate) {
  let best = null;
  const consider = (fr, pw, ph, rot) => {
    if (pw > fr.w || ph > fr.h) return;
    const slack = [fr.w - pw, fr.h - ph];
    const short = Math.min(...slack), long = Math.max(...slack);
    if (!best || short < best.short || (short === best.short && long < best.long))
      best = { x: fr.x, y: fr.y, w: pw, h: ph, rot, short, long };
  };
  for (const fr of bin.free) {
    consider(fr, w, h, false);
    if (allowRotate) consider(fr, h, w, true);
  }
  return best;
}

function occupy(bin, r) {
  const next = [];
  for (const fr of bin.free) if (!subtract(fr, r, next)) next.push(fr);
  bin.free = next;
  prune(bin.free);
}

/**
 * @param parts  [{id, w, h}] — part sizes in mm
 * @param opts   {stockW, stockH, margin, spacing, allowRotate}
 * @returns {sheets:[{placements:[{id,x,y,w,h,rot}]}], oversize:[id], utilisation,
 *           capacity:{w,h}} — capacity is the largest part the board can take.
 *          x/y are the part's top-left corner in stock-sheet coordinates.
 */
export function packParts(parts, opts) {
  const { stockW, stockH, margin = 0, spacing = 3, allowRotate = true } = opts;

  // What the board can actually give a part: the stock, less the edge margin on
  // both sides. A board with no edge margin is usable corner to corner, so a
  // 400x600 sheet cuts from 400x600 stock. Written to reject a NaN too, which is
  // what a cleared number field hands over.
  const capW = stockW - margin * 2, capH = stockH - margin * 2;
  const usable = capW > 0 && capH > 0;
  const capacity = usable ? { w: capW, h: capH } : { w: 0, h: 0 };
  if (!usable)
    return { sheets: [], oversize: parts.map(p => p.id), utilisation: 0, capacity };

  // The gap belongs *between* parts, not around the board. Every part carries
  // its own gap on the right and bottom, so the bin gets one extra gap on those
  // two sides to pay for it: neighbours still sit a full gap apart, and a part
  // that fills the board no longer loses a gap's worth to the edge.
  const W = capW + spacing, H = capH + spacing;

  // Place the most awkward parts first.
  const items = parts
    .map(p => ({ id: p.id, w: p.w, h: p.h, pw: p.w + spacing, ph: p.h + spacing }))
    .sort((a, b) => Math.max(b.pw, b.ph) - Math.max(a.pw, a.ph) ||
                    (b.pw * b.ph) - (a.pw * a.ph));

  const bins = [];
  const oversize = [];
  const newBin = () => ({ free: [{ x: 0, y: 0, w: W, h: H }], placements: [] });

  for (const it of items) {
    const fitsAtAll = (it.pw <= W && it.ph <= H) || (allowRotate && it.ph <= W && it.pw <= H);
    if (!fitsAtAll) { oversize.push(it.id); continue; }

    let spot = null, bin = null;
    for (const b of bins) {
      const s = findSpot(b, it.pw, it.ph, allowRotate);
      if (s) { spot = s; bin = b; break; }
    }
    if (!spot) {
      bin = newBin();
      bins.push(bin);
      spot = findSpot(bin, it.pw, it.ph, allowRotate);
      if (!spot) { oversize.push(it.id); continue; }
    }
    occupy(bin, spot);
    bin.placements.push({
      id: it.id,
      x: spot.x + margin, y: spot.y + margin,
      w: spot.rot ? it.h : it.w,
      h: spot.rot ? it.w : it.h,
      rot: spot.rot,
    });
  }

  const partArea = parts.reduce((a, p) => a + p.w * p.h, 0);
  const stockArea = bins.length * stockW * stockH;
  return {
    sheets: bins.map(b => ({ placements: b.placements })),
    oversize,
    utilisation: stockArea ? partArea / stockArea : 0,
    capacity,
  };
}

/** Tight bounding box of a layer's cut geometry, in mm. */
export function polygonsBBox(polygons) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const rings of polygons || []) {
    for (const r of rings) {
      for (const [x, y] of r) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  return isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}
