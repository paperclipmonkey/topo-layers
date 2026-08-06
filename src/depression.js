// Closed-depression analysis, for karst.
//
// A doline shows up in a layer stack only when a cut level falls strictly
// between its floor and its spill point — the lowest saddle over which it would
// overflow. Below the floor there is no ring; above the spill the contour opens
// out and joins the surrounding slope. Equal-interval levels know nothing about
// this, so a shallow doline between two levels vanishes completely however many
// layers you cut.
//
// Depressions are found by filling the terrain until every cell drains to the
// edge (Priority-Flood, Barnes/Wang & Liu). Wherever the filled surface sits
// above the real one, that is a closed depression, and the fill height is
// exactly its spill elevation.

/** Binary min-heap over (float key, int payload). */
class MinHeap {
  constructor(cap) {
    this.k = new Float64Array(cap);
    this.v = new Int32Array(cap);
    this.n = 0;
  }
  push(key, val) {
    let i = this.n++;
    this.k[i] = key; this.v[i] = val;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.k[p] <= this.k[i]) break;
      this.swap(p, i); i = p;
    }
  }
  pop() {
    const top = this.v[0], key = this.k[0];
    this.n--;
    if (this.n > 0) {
      this.k[0] = this.k[this.n]; this.v[0] = this.v[this.n];
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < this.n && this.k[l] < this.k[m]) m = l;
        if (r < this.n && this.k[r] < this.k[m]) m = r;
        if (m === i) break;
        this.swap(m, i); i = m;
      }
    }
    return [key, top];
  }
  swap(a, b) {
    const k = this.k[a]; this.k[a] = this.k[b]; this.k[b] = k;
    const v = this.v[a]; this.v[a] = this.v[b]; this.v[b] = v;
  }
}

/** Water level at every cell once all depressions are filled to their spill. */
export function fillDepressions(v, w, h) {
  const filled = new Float32Array(v.length);
  const seen = new Uint8Array(v.length);
  const heap = new MinHeap(v.length);

  const seed = i => { if (!seen[i]) { seen[i] = 1; filled[i] = v[i]; heap.push(v[i], i); } };
  for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }

  while (heap.n) {
    const [level, i] = heap.pop();
    const x = i % w, y = (i - x) / w;
    for (let d = 0; d < 4; d++) {
      const nx = x + (d === 0 ? 1 : d === 1 ? -1 : 0);
      const ny = y + (d === 2 ? 1 : d === 3 ? -1 : 0);
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (seen[j]) continue;
      seen[j] = 1;
      filled[j] = v[j] > level ? v[j] : level;
      heap.push(filled[j], j);
    }
  }
  return filled;
}

/**
 * Closed depressions, deepest first.
 * @returns [{floor, spill, depth, cells, area}] with elevations in metres and
 *          `area` as a fraction of the whole grid.
 */
export function findDepressions(v, w, h, { minDepth = 0.5, minCells = 6 } = {}) {
  const filled = fillDepressions(v, w, h);
  const seen = new Uint8Array(v.length);
  const out = [];
  const stack = [];

  for (let i = 0; i < v.length; i++) {
    if (seen[i] || filled[i] - v[i] <= 1e-4) continue;

    let floor = Infinity, spill = -Infinity, cells = 0;
    stack.push(i); seen[i] = 1;
    while (stack.length) {
      const c = stack.pop();
      cells++;
      if (v[c] < floor) floor = v[c];
      if (filled[c] > spill) spill = filled[c];
      const x = c % w, y = (c - x) / w;
      for (let d = 0; d < 4; d++) {
        const nx = x + (d === 0 ? 1 : d === 1 ? -1 : 0);
        const ny = y + (d === 2 ? 1 : d === 3 ? -1 : 0);
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (seen[j] || filled[j] - v[j] <= 1e-4) continue;
        seen[j] = 1; stack.push(j);
      }
    }

    const depth = spill - floor;
    if (depth >= minDepth && cells >= minCells)
      out.push({ floor, spill, depth, cells, area: cells / v.length });
  }

  out.sort((a, b) => b.depth - a.depth);
  return out;
}

/** How many of these depressions the given levels would actually render. */
export function countRendered(depressions, thresholds) {
  let shown = 0, rings = 0;
  for (const d of depressions) {
    let n = 0;
    for (const t of thresholds) if (t > d.floor && t < d.spill) n++;
    if (n > 0) shown++;
    rings += n;
  }
  return { shown, total: depressions.length, rings };
}

/**
 * Place levels so as many depressions as possible get a closed ring, without
 * wrecking the landscape they sit in.
 *
 * Pure greedy scoring fails here, and it fails in a way that flatters the
 * metric: every level piles into the narrow bands where depressions live, the
 * whole middle of the range is left without a single contour, and the piece
 * comes out as detailed pockmarks surrounded by one featureless slab. So the
 * levels are split. `emphasis` of them go to depressions, greedily; the rest
 * are spread evenly first and hold the overall form of the ground.
 *
 * Within the depression budget, scoring weights each doline by depth and extent
 * so a real one outranks a dimple, with sharply diminishing returns so a single
 * big sink cannot hoard the budget.
 */
export function optimiseLevels(v, w, h, { count, depressions, ringsPerDoline = 3,
                                          emphasis = 0.5, terrainWeight = 0.35 } = {}) {
  let lo = Infinity, hi = -Infinity;
  for (const e of v) { if (e < lo) lo = e; if (e > hi) hi = e; }
  if (!(hi > lo) || count < 1) return [];

  const dep = depressions || findDepressions(v, w, h);
  const STEPS = 512;
  const step = (hi - lo) / STEPS;
  const cand = Array.from({ length: STEPS - 1 }, (_, i) => lo + step * (i + 1));

  // how much ground sits near each candidate height
  const hist = new Float64Array(STEPS);
  for (const e of v) {
    let b = Math.floor((e - lo) / (hi - lo) * STEPS);
    if (b < 0) b = 0; if (b >= STEPS) b = STEPS - 1;
    hist[b]++;
  }
  let peak = 0;
  for (const c of hist) if (c > peak) peak = c;

  // Evenly spread levels first, so the open ground keeps its shape whatever the
  // depression pass then does.
  const nBase = Math.max(1, Math.round(count * (1 - Math.max(0, Math.min(1, emphasis)))));
  const chosen = Array.from({ length: nBase }, (_, k) => lo + (hi - lo) * (k + 1) / (nBase + 1));

  const inside = new Map(dep.map((d, i) => [i, 0]));
  for (let i = 0; i < dep.length; i++)
    for (const t of chosen)
      if (t > dep[i].floor && t < dep[i].spill) inside.set(i, inside.get(i) + 1);

  // Tight enough that several levels can stack inside one shallow doline.
  const minGap = (hi - lo) / (count * 8);

  const score = t => {
    let s = 0;
    for (let i = 0; i < dep.length; i++) {
      const d = dep[i];
      if (t <= d.floor || t >= d.spill) continue;
      const already = inside.get(i);
      if (already >= ringsPerDoline) continue;
      // depth and extent make a doline worth showing; each extra ring adds less
      s += Math.sqrt(d.depth) * (1 + 8 * d.area) / (1 + already * 2);
    }
    let b = Math.floor((t - lo) / (hi - lo) * STEPS);
    if (b < 0) b = 0; if (b >= STEPS) b = STEPS - 1;
    return s + terrainWeight * (hist[b] / (peak || 1));
  };

  while (chosen.length < count) {
    let best = null, bestScore = -Infinity;
    for (const t of cand) {
      if (chosen.some(c => Math.abs(c - t) < minGap)) continue;
      const s = score(t);
      if (s > bestScore) { bestScore = s; best = t; }
    }
    if (best === null) break;                     // no room left at this spacing
    chosen.push(best);
    for (let i = 0; i < dep.length; i++) {
      const d = dep[i];
      if (best > d.floor && best < d.spill) inside.set(i, inside.get(i) + 1);
    }
  }

  return chosen.sort((a, b) => a - b);
}
