// SVG output. Millimetre user units (width/height in mm + 1:1 viewBox) so the
// files land in Illustrator / Inkscape / LightBurn at true physical size.

/** Distinct stroke colours map to separate layers in most laser software. */
export const COLOURS = {
  cut:      '#000000',
  guide:    '#B4B4B4',   // engraved outline of the layer above — glue positioning
  water:    '#00E0E0',
  waterway: '#0000FF',
  road:     '#FF0000',
  rail:     '#FF00FF',
  building: '#FF8000',
  green:    '#00E000',
  place:    '#8000FF',   // engraved place names
  point:    '#FF0080',   // imported markers and their numbers
};

const HAIRLINE = 0.1;

function f(n) {
  if (!Number.isFinite(n)) return '0';
  let s = n.toFixed(3);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

const ringD = r => 'M' + r.map(([x, y]) => `${f(x)},${f(y)}`).join('L') + 'Z';
const lineD = p => 'M' + p.map(([x, y]) => `${f(x)},${f(y)}`).join('L');

/** A feature is closed if it comes back to where it started. */
const isClosedPath = s => s.length > 3 &&
  s[0][0] === s[s.length - 1][0] && s[0][1] === s[s.length - 1][1];

/** One <path> per polygon; holes ride along as extra subpaths (even-odd). */
function polygonsD(polygons) {
  return polygons.map(rings => rings.map(ringD).join('')).join('');
}

function group(id, colour, inner, extra = '') {
  if (!inner) return '';
  return `  <g id="${id}" fill="none" fill-rule="evenodd" stroke="${colour}" ` +
         `stroke-width="${HAIRLINE}" stroke-linejoin="round"${extra}>\n${inner}  </g>\n`;
}

function header(W, H, title, meta) {
  const lines = Object.entries(meta || {}).map(([k, v]) => `     ${k}: ${v}`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" version="1.1"\n` +
    `     width="${f(W)}mm" height="${f(H)}mm" viewBox="0 0 ${f(W)} ${f(H)}">\n` +
    `  <title>${esc(title)}</title>\n` +
    (lines ? `  <!--\n${lines}\n  -->\n` : '');
}
const esc = s => String(s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

/* ── feature rendering ───────────────────────────────────────────────── */

function featuresMarkup(features) {
  let out = '';
  for (const [g, data] of Object.entries(features || {})) {
    if (!data?.shapes?.length) continue;
    const d = data.shapes.map(s => (isClosedPath(s) ? ringD(s.slice(0, -1)) : lineD(s))).join('');
    out += group(`osm-${g}`, COLOURS[g] || '#808080', `    <path d="${d}"/>\n`);
  }
  return out;
}

function pinsMarkup(pins, r) {
  if (!pins?.length) return '';
  const inner = pins.map(([x, y]) => `    <circle cx="${f(x)}" cy="${f(y)}" r="${f(r)}"/>\n`).join('');
  return group('pins', COLOURS.cut, inner);
}

/* ── documents ───────────────────────────────────────────────────────── */

/** Everything that gets marked for one layer, in that layer's own coordinates. */
function partBody(sheet, pinRadius) {
  let body = '';
  if (sheet.guide?.length)
    body += group('guide-next-layer', COLOURS.guide, `    <path d="${polygonsD(sheet.guide)}"/>\n`);
  body += featuresMarkup(sheet.features);
  body += pinsMarkup(sheet.pins, pinRadius);
  // Cut last so it sits on top when previewed.
  if (sheet.polygons?.length)
    body += group('cut', COLOURS.cut, `    <path d="${polygonsD(sheet.polygons)}"/>\n`);
  return body;
}

/**
 * A single cuttable sheet.
 * @param sheet {name, polygons, guide?, features?, pins?}
 */
export function sheetSVG(sheet, { W, H, pinRadius, meta }) {
  return header(W, H, sheet.name, meta) + partBody(sheet, pinRadius) + '</svg>\n';
}

/** Every layer in register, one colour per layer — for checking alignment. */
export function stackedSVG(sheets, { W, H, meta }) {
  let body = '';
  sheets.forEach((s, i) => {
    const hue = Math.round(200 - 200 * i / Math.max(1, sheets.length - 1));
    const colour = `hsl(${hue}, 70%, 45%)`;
    body += group(`layer-${String(i).padStart(2, '0')}`, colour,
      `    <path d="${polygonsD(s.polygons)}"/>\n`);
  });
  return header(W, H, 'All layers (in register)', meta) + body + '</svg>\n';
}

/**
 * Place a part so its bounding box lands at (x, y) on the stock board.
 * Rotating by 90° sweeps the part into negative x, so it is pushed back by its
 * own height — which is exactly the width it occupies once turned.
 */
export function placementTransform({ x, y, rot, bbox }) {
  return rot
    ? `translate(${f(x + bbox.h)},${f(y)}) rotate(90) translate(${f(-bbox.x)},${f(-bbox.y)})`
    : `translate(${f(x - bbox.x)},${f(y - bbox.y)})`;
}

/** One stock board with its packed parts, ready to cut as a single job. */
export function nestSVG(nest, { stockW, stockH, pinRadius, meta, index, total }) {
  let body = '';
  for (const pl of nest.placements) {
    body += `  <g id="${esc(pl.sheet.file)}" transform="${placementTransform(pl)}">\n` +
            partBody(pl.sheet, pinRadius) +
            `  </g>\n`;
  }
  const title = total > 1 ? `Nesting — board ${index} of ${total}` : 'Nesting';
  return header(stockW, stockH, title, { ...meta, board: `${index}/${total}` }) + body + '</svg>\n';
}

/**
 * Alignment jig: a full-sheet board with every layer outline engraved, so each
 * piece can be dropped exactly where it belongs while the glue is wet.
 */
export function jigSVG(sheets, { W, H, pins, pinRadius, meta }) {
  let body = '';
  sheets.forEach((s, i) => {
    if (!s.polygons?.length) return;
    body += group(`outline-${String(i).padStart(2, '0')}`, COLOURS.guide,
      `    <path d="${polygonsD(s.polygons)}"/>\n`);
  });
  body += pinsMarkup(pins, pinRadius);
  body += group('cut', COLOURS.cut,
    `    <path d="M0,0L${f(W)},0L${f(W)},${f(H)}L0,${f(H)}Z"/>\n`);
  return header(W, H, 'Alignment jig', meta) + body + '</svg>\n';
}
