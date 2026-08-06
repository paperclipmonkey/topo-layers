// A single-stroke ("engraving") vector font.
//
// Laser text wants centre lines, not filled outlines: the head traces each
// stroke once instead of clearing an interior, which is far quicker to burn and
// stays legible down to a few millimetres. Nothing here needs a font file, so
// the marks are identical on every machine that opens the SVG.
//
// Glyphs live in a box with y = 0 at cap height and y = 1 on the baseline;
// `w` is the advance before tracking. Map labels are set in capitals, which is
// both the cartographic convention and markedly more readable when engraved
// small, so lowercase input is folded to caps.

/** Points along an ellipse. Angles run clockwise on screen, y being down. */
function arc(cx, cy, rx, ry, a0, a1, steps = 14) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const a = a0 + (a1 - a0) * i / steps;
    pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return pts;
}

const PI = Math.PI;
const ring = (cx, cy, rx, ry) => arc(cx, cy, rx, ry, -PI / 2, PI * 3 / 2, 20);

// Shared bowl shapes, so the round letters stay consistent with each other.
const C_ARC = arc(0.30, 0.50, 0.30, 0.50, -PI / 3, -PI * 5 / 3, 16);

const G = {
  ' ': { w: 0.40, s: [] },

  A: { w: 0.62, s: [[[0, 1], [0.31, 0], [0.62, 1]], [[0.11, 0.63], [0.51, 0.63]]] },
  B: { w: 0.60, s: [
    [[0, 0], [0, 1]],
    [[0, 0], [0.38, 0], ...arc(0.38, 0.25, 0.20, 0.25, -PI / 2, PI / 2, 8), [0, 0.5]],
    [[0, 0.5], [0.40, 0.5], ...arc(0.40, 0.75, 0.21, 0.25, -PI / 2, PI / 2, 8), [0, 1]],
  ] },
  C: { w: 0.62, s: [C_ARC] },
  D: { w: 0.62, s: [[[0, 0], [0, 1]],
                    [[0, 0], [0.30, 0], ...arc(0.30, 0.5, 0.32, 0.5, -PI / 2, PI / 2, 12), [0, 1]]] },
  E: { w: 0.56, s: [[[0.56, 0], [0, 0], [0, 1], [0.56, 1]], [[0, 0.49], [0.44, 0.49]]] },
  F: { w: 0.54, s: [[[0.54, 0], [0, 0], [0, 1]], [[0, 0.49], [0.42, 0.49]]] },
  // The arc leaves off at the lower right; the spur picks it up there so the
  // crossbar cannot overshoot into the next letter.
  G: { w: 0.66, s: [[...arc(0.32, 0.50, 0.32, 0.50, -PI / 3, -PI * 5 / 3, 16),
                     [0.62, 0.82], [0.62, 0.58], [0.40, 0.58]]] },
  H: { w: 0.60, s: [[[0, 0], [0, 1]], [[0.60, 0], [0.60, 1]], [[0, 0.5], [0.60, 0.5]]] },
  I: { w: 0.18, s: [[[0.09, 0], [0.09, 1]]] },
  J: { w: 0.50, s: [[[0.50, 0], [0.50, 0.74], ...arc(0.27, 0.74, 0.23, 0.26, 0, PI * 0.9, 8)]] },
  K: { w: 0.58, s: [[[0, 0], [0, 1]], [[0.56, 0], [0.04, 0.56]], [[0.22, 0.38], [0.58, 1]]] },
  L: { w: 0.50, s: [[[0, 0], [0, 1], [0.50, 1]]] },
  M: { w: 0.74, s: [[[0, 1], [0, 0], [0.37, 0.62], [0.74, 0], [0.74, 1]]] },
  N: { w: 0.62, s: [[[0, 1], [0, 0], [0.62, 1], [0.62, 0]]] },
  O: { w: 0.66, s: [ring(0.33, 0.5, 0.33, 0.5)] },
  P: { w: 0.58, s: [[[0, 1], [0, 0], [0.36, 0],
                     ...arc(0.36, 0.27, 0.22, 0.27, -PI / 2, PI / 2, 8), [0, 0.54]]] },
  Q: { w: 0.66, s: [ring(0.33, 0.5, 0.33, 0.5), [[0.40, 0.72], [0.66, 1.04]]] },
  R: { w: 0.60, s: [[[0, 1], [0, 0], [0.36, 0],
                     ...arc(0.36, 0.27, 0.22, 0.27, -PI / 2, PI / 2, 8), [0, 0.54]],
                    [[0.26, 0.54], [0.60, 1]]] },
  // Drawn as an explicit spine: two mirrored arcs never quite meet in the
  // middle, and the join shows up as a stroke down the left that reads as a G.
  S: { w: 0.58, s: [[[0.54, 0.15], [0.46, 0.04], [0.30, 0.00], [0.13, 0.04],
                     [0.04, 0.16], [0.06, 0.31], [0.18, 0.41], [0.36, 0.50],
                     [0.50, 0.60], [0.55, 0.74], [0.50, 0.90], [0.34, 1.00],
                     [0.15, 0.99], [0.03, 0.87]]] },
  T: { w: 0.56, s: [[[0, 0], [0.56, 0]], [[0.28, 0], [0.28, 1]]] },
  U: { w: 0.62, s: [[[0, 0], [0, 0.70], ...arc(0.31, 0.70, 0.31, 0.30, PI, 0, 12), [0.62, 0]]] },
  V: { w: 0.62, s: [[[0, 0], [0.31, 1], [0.62, 0]]] },
  W: { w: 0.86, s: [[[0, 0], [0.16, 1], [0.43, 0.30], [0.70, 1], [0.86, 0]]] },
  X: { w: 0.60, s: [[[0, 0], [0.60, 1]], [[0.60, 0], [0, 1]]] },
  Y: { w: 0.60, s: [[[0, 0], [0.30, 0.50], [0.60, 0]], [[0.30, 0.50], [0.30, 1]]] },
  Z: { w: 0.58, s: [[[0, 0], [0.58, 0], [0, 1], [0.58, 1]]] },

  0: { w: 0.58, s: [ring(0.29, 0.5, 0.29, 0.5)] },
  1: { w: 0.34, s: [[[0.04, 0.18], [0.22, 0], [0.22, 1]], [[0.02, 1], [0.34, 1]]] },
  2: { w: 0.56, s: [[...arc(0.28, 0.26, 0.28, 0.26, -PI * 0.95, PI * 0.10, 10),
                     [0.02, 1], [0.56, 1]]] },
  3: { w: 0.56, s: [[...arc(0.27, 0.24, 0.25, 0.24, -PI * 0.9, PI * 0.42, 9), [0.20, 0.48]],
                    [[0.20, 0.48], ...arc(0.27, 0.74, 0.28, 0.26, -PI * 0.45, PI * 0.85, 10)]] },
  4: { w: 0.58, s: [[[0.42, 1], [0.42, 0], [0, 0.72], [0.58, 0.72]]] },
  5: { w: 0.56, s: [[[0.52, 0], [0.10, 0], [0.04, 0.42]],
                    [[0.04, 0.42], ...arc(0.28, 0.70, 0.28, 0.30, -PI * 0.72, PI * 0.80, 12)]] },
  6: { w: 0.58, s: [[...arc(0.29, 0.50, 0.29, 0.50, -PI * 0.42, -PI * 1.05, 8)],
                    [...ring(0.29, 0.70, 0.29, 0.30)]] },
  7: { w: 0.54, s: [[[0, 0], [0.54, 0], [0.18, 1]]] },
  8: { w: 0.56, s: [ring(0.28, 0.24, 0.24, 0.24), ring(0.28, 0.72, 0.28, 0.28)] },
  9: { w: 0.58, s: [[...arc(0.29, 0.50, 0.29, 0.50, PI * 0.58, -PI * 0.05, 8)],
                    [...ring(0.29, 0.30, 0.29, 0.30)]] },

  '.': { w: 0.20, s: [[[0.08, 0.94], [0.12, 0.94], [0.12, 1], [0.08, 1], [0.08, 0.94]]] },
  ',': { w: 0.20, s: [[[0.13, 0.92], [0.13, 1], [0.04, 1.12]]] },
  '-': { w: 0.44, s: [[[0.04, 0.56], [0.40, 0.56]]] },
  "'": { w: 0.16, s: [[[0.08, 0], [0.08, 0.22]]] },
  '(': { w: 0.26, s: [arc(0.30, 0.5, 0.26, 0.58, PI * 0.72, PI * 1.28, 8)] },
  ')': { w: 0.26, s: [arc(-0.04, 0.5, 0.26, 0.58, PI * 0.28, -PI * 0.28, 8)] },
  '/': { w: 0.46, s: [[[0, 1], [0.46, 0]]] },
  '&': { w: 0.66, s: [[[0.66, 1], [0.20, 0.30], [0.20, 0.16], [0.32, 0.04], [0.44, 0.14],
                       [0.40, 0.32], [0.06, 0.60], [0.04, 0.82], [0.18, 1], [0.40, 0.94],
                       [0.56, 0.72]]] },
  ':': { w: 0.20, s: [[[0.10, 0.36], [0.10, 0.44]], [[0.10, 0.92], [0.10, 1]]] },
  '!': { w: 0.18, s: [[[0.09, 0], [0.09, 0.66]], [[0.09, 0.92], [0.09, 1]]] },
  '?': { w: 0.52, s: [[...arc(0.26, 0.24, 0.24, 0.24, -PI * 0.92, PI * 0.30, 9), [0.26, 0.66]],
                      [[0.26, 0.92], [0.26, 1]]] },
  '"': { w: 0.28, s: [[[0.08, 0], [0.08, 0.22]], [[0.20, 0], [0.20, 0.22]]] },
};

const TRACKING = 0.10;

/** Advance width of a string at the given cap height, in the same units. */
export function textWidth(str, size, tracking = TRACKING) {
  const up = String(str).toUpperCase();
  let w = 0;
  for (const ch of up) {
    const g = G[ch];
    if (!g) continue;
    w += (g.w + tracking) * size;
  }
  return Math.max(0, w - tracking * size);
}

/**
 * Lay a string out as polylines ready to engrave.
 * @param anchor 'start' | 'middle' | 'end' — horizontal placement about (x, y)
 * @param baseline 'baseline' | 'middle' | 'top' — vertical placement about y
 * @returns [[ [x,y], … ], …] in millimetres
 */
export function textPaths(str, x, y, size, { anchor = 'start', baseline = 'baseline',
                                             tracking = TRACKING } = {}) {
  const up = String(str).toUpperCase();
  const total = textWidth(up, size, tracking);
  let ox = anchor === 'middle' ? x - total / 2 : anchor === 'end' ? x - total : x;
  const oy = baseline === 'middle' ? y + size / 2 : baseline === 'top' ? y + size : y;

  const out = [];
  for (const ch of up) {
    const g = G[ch];
    if (!g) continue;
    for (const stroke of g.s) {
      if (stroke.length < 2) continue;
      out.push(stroke.map(([gx, gy]) => [ox + gx * size, oy + (gy - 1) * size]));
    }
    ox += (g.w + tracking) * size;
  }
  return out;
}

/** Characters the font can actually draw — used to build the specimen sheet. */
export const CHARSET = Object.keys(G).join('');
