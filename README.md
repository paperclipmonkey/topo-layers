# Topo Layers

A single-page app for turning any map area into a stack of laser-cuttable
vector layers — the multi-layer topographic wall art thing, but where *you*
choose the area, the aspect ratio, and exactly which elevations to split at.

No build step, no npm install, no API keys.

**→ [paperclipmonkey.github.io/topo-layers](https://paperclipmonkey.github.io/topo-layers/)**

## Run it locally

```bash
cd /Users/michaelwaterworth/map-generator && python3 -m http.server 8777
```

Then open <http://localhost:8777>. It needs to be served over HTTP rather than
opened as a `file://` URL, because the browser blocks cross-origin tile reads
from `file://`.

## Where the data comes from

**Elevation** is *not* in OpenStreetMap — OSM is a vector database of nodes and
ways, and it carries almost no terrain height. So heights come from
[AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/), an open,
keyless dataset of terrarium-encoded PNGs (SRTM globally, EU-DEM over Europe,
plus national datasets where they exist). Zoom 15 is the maximum, which is
roughly 5 m per sample at UK latitudes.

**Everything else** is OSM: the basemap, place search (Nominatim), and the
vector features — lakes, rivers, roads, railways, buildings, woodland — fetched
live from the Overpass API and engraved onto whichever layer they sit on.

You can swap the elevation source for Mapbox Terrain-RGB (paste a token) or any
custom `{z}/{x}/{y}` tile URL in either encoding.

## How it works

1. **Area** — pan/zoom, then drag the frame or its corners. The frame is
   anchored to the ground, so it stays over the same terrain while you pan. Any
   aspect ratio; either the frame drives the sheet proportions or the sheet
   drives the frame.
2. **Elevation** — terrain tiles covering the frame are fetched, decoded
   (`h = R·256 + G + B/256 − 32768`), mosaicked and resampled to a grid whose
   cells are square in Mercator.
3. **Levels** — pick how many layers and where they sit: equal interval, equal
   area (quantile), or snapped to round contour intervals. Or type exact heights,
   or click the histogram to add and remove them individually.
4. **Contours** — marching squares (`d3-contour`) produces, for each level, the
   closed region of ground above it. Holes are preserved, so a caldera or a lake
   basin cuts out properly.
5. **Clean-up for the laser** — Chaikin smoothing to take the stair-step out of
   the DEM, Douglas–Peucker simplification, removal of islands and holes too
   small to survive the cut, and optional kerf compensation.
6. **Export** — one SVG per layer plus assembly aids, in a ZIP.

## Output

| File | What it is |
| --- | --- |
| `nesting-01.svg`, … | **what you cut** — every layer packed onto stock boards |
| `01_base.svg`, `02_120m.svg`, … | one sheet per layer, bottom first, each in its own file |
| `all-layers-in-register.svg` | all layers overlaid, colour-coded — for checking alignment |
| `alignment-jig.svg` | a board with every outline engraved, to position pieces while gluing |
| `manifest.json`, `README.txt` | the exact parameters used, and cutting notes |

SVGs are in millimetre user units with a physical `width`/`height`, so they
import at true size into LightBurn, Illustrator and Inkscape. Stroke colour
separates operations, which is how most laser software assigns layers:

| Colour | Operation |
| --- | --- |
| `#000000` black | **cut** — part outline and pin holes |
| `#B4B4B4` grey | **engrave** — outline of the layer above, as a glue guide |
| `#00E0E0` / `#0000FF` | lakes / rivers |
| `#FF0000` / `#FF00FF` | roads / railways |
| `#FF8000` / `#00E000` | buildings / woodland |

## Nesting

Give it your stock size and it packs the layers onto as few boards as possible,
so the whole piece cuts in one job instead of one file at a time.

Each layer travels as a single rigid part — its glue-guide outline, engraved
rivers and pin holes ride along with it — so only the part's own bounding box
matters, not the full sheet it was drawn on. That is what makes the upper layers
cheap to place: a summit layer occupying 40 × 30 mm is packed as 40 × 30 mm, not
as a full sheet with a lot of empty space around it. Parts are placed by
MaxRects best-short-side-fit, largest first, and may be turned 90° where that
helps; anything engraved on a part turns with it.

*Edge margin* keeps parts clear of the board edge, *part gap* keeps them clear
of each other — set that to at least a couple of kerfs so neighbouring cuts do
not run into one another. Anything too large for the stock is listed rather than
silently dropped, so a base layer bigger than your board is a warning, not a
missing file.

## Settings worth understanding

**Min feature** drops any island smaller than roughly this square. Set it to
about 2–3× your material thickness — anything smaller tends to char through,
fall into the machine, or snap when you handle it.

**Kerf** widens each part by half the beam width so the cut piece comes out at
nominal size. Leave it at 0 if LightBurn is already applying kerf offset,
otherwise you will double up.

**Vertical exaggeration** is shown live. It is the ratio of the horizontal scale
to the vertical scale: material thickness ÷ contour interval, against ground
metres per sheet millimetre. Real terrain at 1:1 looks disappointingly flat at
wall-art size, so 5–20× is normal. Change it by changing the contour interval or
the material thickness.

**Terrain smoothing** blurs the elevation grid before contouring. One or two
passes removes DEM quantisation without losing real landforms. **Curve
smoothing** rounds the resulting outlines; segments running along the sheet edge
are deliberately held rigid so the rectangle stays square.

## Assembly

Cut bottom layer first. With *engrave outline of the layer above* switched on,
each sheet carries a faint outline showing exactly where the next piece goes —
lay the glue, drop the next sheet inside the line, repeat. The jig sheet does
the same job for the whole stack if you would rather not mark the pieces.

Pin holes are an alternative, and they are placed from the top down. The
generator starts at the summit layer, finds the point deepest inside its
material, and puts a hole there; because the layers nest, that hole then passes
down through every layer beneath it. Only when a layer does not already contain
enough holes — or contains them too close together to stop it pivoting — does it
ask for another. The result is a small number of dowels sited under the high
ground that carry the whole stack, including the small summit pieces that have
nowhere near the sheet corners to locate against.

*Per layer* is how many holes each layer should end up with (two is enough to
fix rotation). *Margin* is how much material must surround a hole; raise it if
holes are landing closer to an edge than you would like. A layer that is simply
too small to take a hole at that margin is skipped rather than weakened.

## Limits

- Mercator, so the piece is a Mercator rectangle. Over a wall-art extent the
  distortion is invisible; over several degrees of latitude it is not.
- Kerf compensation offsets each vertex along its angle bisector with a miter
  limit. At realistic kerfs (0.05–0.25 mm) that is fine; at large values a
  tight concave notch can self-intersect.
- Overpass will refuse very large areas, especially with buildings enabled.
- Coastlines are handled implicitly: sea is below the 0 m level, so include a
  level at 0 to cut a shoreline.

## Deploying

The site is served from the `gh-pages` branch. To publish changes:

```bash
git push origin main && git push origin main:gh-pages
```

Note that the basemap and Overpass are volunteer-run services on a fair-use
policy — fine for personal use, but don't point heavy traffic at them.

## Attribution

Elevation from AWS Terrain Tiles. Map data © OpenStreetMap contributors,
[ODbL](https://www.openstreetmap.org/copyright) — keep the attribution if you
publish or sell the result.
