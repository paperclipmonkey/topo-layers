// Shareable links: the settings that define a piece, packed into the URL hash.
//
// Keys are the control ids themselves rather than short codes — a link stays
// readable and hand-editable, and there is no lookup table to fall out of step
// with the markup. Only settings that differ from stock are written, so a
// typical link is short despite the long names.

/**
 * Controls deliberately left out of a link:
 *   demToken     a private API key — a link is a public thing
 *   geoFile      a local file the person opening the link does not have
 *   searchInput  scratch text, not part of the design
 *   thrList      the levels travel as one `levels=` key instead
 *   histoLog     how you like to look at the histogram, not what you are cutting
 *   spin         a shared link always opens turning
 */
const PRIVATE = new Set(['demToken', 'geoFile', 'searchInput', 'thrList', 'histoLog', 'spin']);

const FORMAT = '1';

/** Every panel control whose value is part of the design. */
export function shareControls() {
  return [...document.querySelectorAll('#panel input, #panel select, #panel textarea')]
    .filter(el => el.id && !PRIVATE.has(el.id) && el.type !== 'file' && el.type !== 'radio');
}

export function controlValues() {
  const out = {};
  for (const el of shareControls()) {
    out[el.id] = el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value;
  }
  return out;
}

/** Apply what the link carries, leaving anything it does not mention alone. */
export function applyControlValues(vals) {
  for (const el of shareControls()) {
    const v = vals[el.id];
    if (v === undefined) continue;
    if (el.type === 'checkbox') el.checked = v === '1';
    else el.value = v;
  }
}

/**
 * Only the settings that have been moved off their stock value. Numbers are
 * compared as numbers, so a field that merely re-rendered itself as "200.0"
 * does not pad out every link.
 */
export function changedFrom(defaults, values) {
  const out = {};
  for (const [k, v] of Object.entries(values)) {
    const d = defaults[k];
    if (v === d) continue;
    const a = parseFloat(v), b = parseFloat(d);
    if (Number.isFinite(a) && Number.isFinite(b) && a === b && v.trim() !== '') continue;
    out[k] = v;
  }
  return out;
}

// Commas and colons survive verbatim: they are legal in a fragment and keep
// coordinate and level lists readable.
const enc = s => encodeURIComponent(s).replace(/%2C/g, ',').replace(/%3A/g, ':');

export function packHash(params) {
  const parts = [`v=${FORMAT}`];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    parts.push(`${enc(k)}=${enc(String(v))}`);
  }
  return '#' + parts.join('&');
}

/** Null unless the hash really is one of ours. */
export function unpackHash(hash) {
  const body = (hash || '').replace(/^#/, '');
  if (!body) return null;
  const out = {};
  for (const pair of body.split('&')) {
    if (!pair) continue;
    const i = pair.indexOf('=');
    if (i < 0) continue;
    try {
      out[decodeURIComponent(pair.slice(0, i))] = decodeURIComponent(pair.slice(i + 1));
    } catch { /* a mangled pair should not sink the whole link */ }
  }
  return out.v ? out : null;
}

/** Four finite numbers, south/west/north/east, or null. */
export function parseBBox(text) {
  const n = String(text || '').split(',').map(Number);
  if (n.length !== 4 || !n.every(Number.isFinite)) return null;
  if (n[2] <= n[0] || n[3] <= n[1]) return null;
  return { south: n[0], west: n[1], north: n[2], east: n[3] };
}

// Six decimals is about 0.1 m of ground — finer than the frame's own pixel
// quantisation, so a link samples the DEM on the same grid the sharer did.
export function formatBBox(bb) {
  return [bb.south, bb.west, bb.north, bb.east].map(v => v.toFixed(6)).join(',');
}

export function parseLevels(text) {
  return String(text || '').split(',')
    .map(Number).filter(Number.isFinite).sort((a, b) => a - b);
}
