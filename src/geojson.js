// GeoJSON import. Points become numbered markers engraved on whichever layer
// they sit on; the numbers are what an external key, legend or guide sheet
// refers back to, so the numbering has to be stable and exported alongside.

const NAME_KEYS = ['name', 'title', 'label', 'ref', 'id', 'Name', 'NAME'];

function pickName(props, fallback) {
  if (!props) return fallback;
  for (const k of NAME_KEYS) {
    const v = props[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  return fallback;
}

/** Walk any GeoJSON shape and hand each geometry to the visitor. */
function walk(node, props, visit) {
  if (!node || typeof node !== 'object') return;
  switch (node.type) {
    case 'FeatureCollection':
      (node.features || []).forEach(f => walk(f, f?.properties, visit));
      return;
    case 'Feature':
      walk(node.geometry, node.properties || props, visit);
      return;
    case 'GeometryCollection':
      (node.geometries || []).forEach(g => walk(g, props, visit));
      return;
    default:
      if (node.coordinates) visit(node, props);
  }
}

/**
 * @param text     raw file contents
 * @param project  (lon, lat) -> [x, y] in sheet millimetres
 * @param sheetW/H sheet size, for discarding anything off the piece
 * @returns {points:[{n,name,x,y,lon,lat,props}], lines:[[x,y],…][], skipped:number}
 */
export function parseGeoJSON(text, project, sheetW, sheetH) {
  let doc;
  try { doc = JSON.parse(text); }
  catch (e) { throw new Error('That file is not valid JSON.'); }

  const points = [], lines = [];
  let skipped = 0, seq = 0;

  const inSheet = ([x, y]) => x >= 0 && y >= 0 && x <= sheetW && y <= sheetH;

  // Numbering is assigned in document order to every point, before any test of
  // whether it lands on the sheet. External sheets cite these numbers, so they
  // must not shift when the frame moves and a point falls outside it.
  const addPoint = (lon, lat, props) => {
    seq++;
    const xy = project(lon, lat);
    const onSheet = isFinite(xy[0]) && isFinite(xy[1]) && inSheet(xy);
    if (!onSheet) skipped++;
    points.push({
      n: seq, name: pickName(props, `Point ${seq}`),
      x: xy[0], y: xy[1], lon, lat, onSheet, props: props || {},
    });
  };
  const addLine = (coords, props) => {
    const pts = coords.map(c => project(c[0], c[1])).filter(p => isFinite(p[0]) && isFinite(p[1]));
    if (pts.length < 2) { skipped++; return; }
    if (!pts.some(inSheet)) { skipped++; return; }
    lines.push(pts);
  };

  walk(doc, null, (geom, props) => {
    const c = geom.coordinates;
    switch (geom.type) {
      case 'Point': addPoint(c[0], c[1], props); break;
      case 'MultiPoint': c.forEach(p => addPoint(p[0], p[1], props)); break;
      case 'LineString': addLine(c, props); break;
      case 'MultiLineString': c.forEach(l => addLine(l, props)); break;
      case 'Polygon': c.forEach(r => addLine(r, props)); break;
      case 'MultiPolygon': c.forEach(p => p.forEach(r => addLine(r, props))); break;
      default: skipped++;
    }
  });

  if (!points.length && !lines.length)
    throw new Error('No usable geometry found — expected Point, LineString or Polygon features.');

  return { points, lines, skipped };
}

/** Marker glyph for one point, centred on it. */
export function markerPaths(x, y, r, style = 'circle') {
  if (style === 'cross') {
    return [[[x - r, y], [x + r, y]], [[x, y - r], [x, y + r]]];
  }
  if (style === 'target') {
    return [ring(x, y, r), [[x - r * 1.6, y], [x - r * 0.6, y]],
            [[x + r * 0.6, y], [x + r * 1.6, y]],
            [[x, y - r * 1.6], [x, y - r * 0.6]], [[x, y + r * 0.6], [x, y + r * 1.6]]];
  }
  return [ring(x, y, r)];
}

function ring(cx, cy, r, steps = 20) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const a = i / steps * Math.PI * 2;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

/** CSV key tying each engraved number back to its point, for external sheets. */
export function pointsCSV(points, sheetOf) {
  const esc = v => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const extraKeys = [...new Set(points.flatMap(p => Object.keys(p.props || {})))]
    .filter(k => !NAME_KEYS.includes(k)).slice(0, 12);

  const head = ['number', 'name', 'sheet', 'x_mm', 'y_mm', 'latitude', 'longitude', ...extraKeys];
  const rows = points.map(p => [
    p.n, p.name,
    p.onSheet ? (sheetOf?.(p) ?? '') : 'off-sheet',
    p.onSheet ? p.x.toFixed(2) : '', p.onSheet ? p.y.toFixed(2) : '',
    p.lat.toFixed(6), p.lon.toFixed(6), ...extraKeys.map(k => p.props?.[k]),
  ]);
  return [head, ...rows].map(r => r.map(esc).join(',')).join('\n') + '\n';
}
