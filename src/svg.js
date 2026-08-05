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

/**
 * A single cuttable sheet.
 * @param sheet {name, polygons, guide?, features?, pins?}
 */
export function sheetSVG(sheet, { W, H, pinRadius, meta }) {
  let body = '';
  if (sheet.guide?.length)
    body += group('guide-next-layer', COLOURS.guide, `    <path d="${polygonsD(sheet.guide)}"/>\n`);
  body += featuresMarkup(sheet.features);
  body += pinsMarkup(sheet.pins, pinRadius);
  // Cut last so it sits on top when previewed.
  if (sheet.polygons?.length)
    body += group('cut', COLOURS.cut, `    <path d="${polygonsD(sheet.polygons)}"/>\n`);

  return header(W, H, sheet.name, meta) + body + '</svg>\n';
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

/** Every layer nested side by side on one big sheet, ready for a single job. */
export function tiledSVG(sheets, { W, H, gap = 10, meta }) {
  const cols = Math.max(1, Math.round(Math.sqrt(sheets.length * H / W)));
  const rows = Math.ceil(sheets.length / cols);
  const TW = cols * W + (cols + 1) * gap;
  const TH = rows * H + (rows + 1) * gap;

  let body = '';
  sheets.forEach((s, i) => {
    const cx = gap + (i % cols) * (W + gap);
    const cy = gap + Math.floor(i / cols) * (H + gap);
    let inner = '';
    if (s.guide?.length) inner += group('guide', COLOURS.guide, `      <path d="${polygonsD(s.guide)}"/>\n`);
    inner += featuresMarkup(s.features).replace(/^ {2}/gm, '    ');
    if (s.pins?.length) inner += pinsMarkup(s.pins, meta?.pinRadius || 1.5);
    inner += group('cut', COLOURS.cut, `      <path d="${polygonsD(s.polygons)}"/>\n`);
    body += `  <g id="${esc(s.name)}" transform="translate(${f(cx)},${f(cy)})">\n${inner}  </g>\n`;
  });
  return header(TW, TH, 'All layers, nested', meta) + body + '</svg>\n';
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
