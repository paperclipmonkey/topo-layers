# Topo Layers

A single-page app for turning any map area into a stack of laser-cuttable
vector layers — the multi-layer topographic wall art thing, but where *you*
choose the area, the aspect ratio, and exactly which elevations to split at.

No build step, no npm install, no API keys.

**→ [paperclipmonkey.github.io/topo-layers](https://paperclipmonkey.github.io/topo-layers/)**

## Run it locally

```bash
cd /Users/michaelwaterworth/map-generator && python3 serve.py
```

Then open <http://localhost:8781>. It needs to be served over HTTP rather than
opened as a `file://` URL, because the browser blocks cross-origin tile reads
from `file://`. `serve.py` is just `http.server` with caching turned off — with
caching on, an edited module keeps running from cache while the page reloads
around it, which looks exactly like a code change having no effect.

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

The panel walks you through it: the four sections that are actually a sequence
show a **do this / done** marker, and a bar at the bottom always offers the one
action that comes next. Everything else is optional detail you can ignore.

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
| `points-key.csv` | number → name, sheet and coordinates for imported points |
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
| `#8000FF` / `#FF0080` | place names / imported points |

## Lettering and your own points

Place names and peaks come from OSM and are engraved onto whichever layer is the
visible surface there. They are set in a **single-stroke font** built into the
app: the laser traces each letter's centre line once rather than clearing a
filled interior, which is far quicker to burn, stays legible down to about 2 mm,
and needs no font file, so the marks are identical on any machine. Labels are
set in capitals — the cartographic convention, and markedly clearer engraved
small. A label is never split across a layer boundary, and where two collide the
less prominent one is dropped.

**Keep names readable from above** is worth understanding, because it trades
coverage for legibility. A name engraved on a layer is only visible where that
layer is not covered by the plate above it, and with a dozen layers those
exposed terraces are narrow bands — so a name at its natural position very often
runs half onto thin air or disappears under the next plate. With the option on,
each name is tried at a range of offsets around its point and at up to two
smaller sizes, looking for somewhere it sits complete on a single visible
terrace; anything that still has nowhere to go is dropped rather than engraved
broken, and the panel tells you how many. The dot stays at the true location on
whatever layer is exposed *there*, which is not necessarily the layer the name
moved to. On a 12-layer test this took the proportion of lettering falling off
its terrace from 33% to under 1%, at the cost of 2 names in 12.

Turn it off to engrave every name at its exact position and accept the
clipping.

**GeoJSON import** takes Point, LineString and Polygon features. Points are
engraved as numbered markers on the layer they sit on, and the export includes
`points-key.csv` tying each number back to its name, sheet, sheet coordinates,
latitude/longitude and any custom properties from the file. Numbers are assigned
in document order *before* testing whether a point falls on the sheet, so moving
the frame never renumbers anything — which matters when a separate survey sheet
already cites those numbers. Points outside the frame keep their number and are
marked `off-sheet` in the CSV.

## Showing dolines and other closed depressions

For karst, the thing you want to see is the closed depressions — dolines,
shakeholes, sinks — and the default level modes are bad at it. A closed
depression only appears in the stack when a level falls strictly between its
floor and its **spill point**, the lowest saddle it would overflow. Below the
floor there is no ring at all; above the spill the contour opens out and merges
into the hillside. A shallow doline sitting between two evenly-spaced levels is
therefore invisible no matter how many layers you cut.

*Show depressions* mode finds them properly. The terrain is flooded until every
cell drains to the edge (Priority-Flood); wherever the filled surface sits above
the real one is a closed depression, and the fill height is exactly its spill
elevation. Levels are then placed to put rings inside as many as possible,
weighted by depth and extent so a real doline outranks a dimple.

**Depression emphasis** is the control that matters. Spending every level on
depressions flatters the count and ruins the piece: the levels all pile into the
narrow bands where depressions live, the middle of the range gets no contour at
all, and you end up with detailed pockmarks in one featureless slab. So only
that fraction of the levels chases depressions; the rest are spread evenly and
hold the shape of the open ground. On a Mendip test area with 20 levels:

| Mode | Dolines shown | Rings |
| --- | --- | --- |
| Equal interval | 7 / 9 | 7 |
| Equal area | 6 / 9 | 6 |
| Show depressions (50% emphasis) | **9 / 9** | **18** |

The readout under the levels tells you what any mode is achieving, so you can
compare rather than guess.

Two caveats. Keep **terrain smoothing at 0** for this — smoothing flattens
shallow depressions out of existence before they can be found. And detection is
limited by the DEM: the open terrain tiles resolve roughly 5–30 m on the ground,
which finds sizeable dolines but not small shakeholes. If you have LIDAR (in the
UK, Environment Agency 1 m DTM), serve it as `{z}/{x}/{y}` terrarium tiles and
point the custom source at it — that is where this mode really pays off.

## Checking it in 3D

The **3D** tab builds the stack from the layers and the material thickness and
lets you turn it around — drag to spin, scroll to zoom, or leave it spinning.
Worth doing before you cut: it shows how much relief you will actually get,
which is usually less than people expect. Thirteen layers of 3 mm ply is 39 mm
of stack on a 300 mm piece, and seeing that is a better guide than any number.

There is no 3D library behind it. The layers nest strictly — each sits wholly
inside and above the one below — so with the camera above the stack, drawing
bottom plate to top plate is exactly correct painter's order, and no depth
buffer is needed. Within a plate the walls are drawn first and the top face over
them, which hides the back walls for free: a back wall projects into the
interior of its own top face, while a front wall projects clear of it.

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

Pushing to `main` publishes the site — `.github/workflows/pages.yml` deploys the
repo to GitHub Pages:

```bash
git push origin main
```

Do **not** also push to `gh-pages`. Pages is configured to build from the
workflow, so a push to that branch starts a second, competing deployment; the
two fight over the deployment lock and the workflow sits at
`deployment_in_progress` until it times out. The branch is left in place but is
no longer the source, and nothing needs to go to it.

Note that the basemap and Overpass are volunteer-run services on a fair-use
policy — fine for personal use, but don't point heavy traffic at them.

## Attribution

Elevation from AWS Terrain Tiles. Map data © OpenStreetMap contributors,
[ODbL](https://www.openstreetmap.org/copyright) — keep the attribution if you
publish or sell the result.
