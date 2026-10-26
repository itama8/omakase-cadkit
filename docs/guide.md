# User guide

## The viewer

Open a drawing by clicking the drawing in the middle of the empty screen, or with the
folder icon: choose a folder, then click a drawing in its list. The curved arrow next
to the folder name goes up one folder. **Files** also lists recent drawings.

| Do this | To |
|---|---|
| Drag (left or middle button) | Pan |
| Wheel, or `+` / `−` | Zoom |
| `F` | Fit the sheet |
| Click an entity | Inspect its handle, layer and properties |
| `J` / `K` | Next / previous finding |
| `/` | Search text |
| `Alt+Left` | Go back to the previous view |
| `Esc` | Clear the selection |

**Findings.** Click a finding to zoom to it. **How to fix** lists the AutoCAD commands
to use. **Copy AutoCAD selection** copies a snippet you paste at the AutoCAD command
line to select the entities (full AutoCAD or LT 2024+). **Copy handles** copies the
handles.

**Units.** If a drawing's units are wrong, click the units badge in the status bar,
choose the real units and Apply. This saves an `omakase-cadkit.json` next to the
drawing. It applies to the drawings in that folder and changes nothing in the DWG.
**Auto** removes the override.

**What the status bar tells you.** It shows the version, units, error and warning
counts and the load time. **not drawn** and **approx.** list content the viewer
skips or approximates. Checks always use the full drawing, even where the picture is
approximate.

## Commands

The installed app is also a command line. From the app folder, run
`launch.cmd <command>` on Windows or `bash launch.command <command>` on Mac and Linux.
In a source checkout, run `node bin/omakase-cadkit.mjs <command>`.

```bash
omakase-cadkit                                  # open the viewer with no drawing
omakase-cadkit view drawing.dwg --handle 5DF85  # open the viewer zoomed on an entity
omakase-cadkit inspect drawing.dwg              # units, sheet, scale, layers, blocks
omakase-cadkit lint drawing.dwg [more.dwg ...]  # findings; exit 1 if any error; --json
omakase-cadkit query drawing.dwg --layer NODE --text '^MH-' --limit 5
omakase-cadkit network drawing.dwg --csv        # manhole and pipe schedule
omakase-cadkit render drawing.dwg --finding 3 --out f.svg   # .png needs rsvg-convert or magick
omakase-cadkit convert in.dxf out.dwg           # DWG <-> DXF, read back to check
omakase-cadkit rules                            # every rule and why it exists
omakase-cadkit stop                             # stop the background viewer
```

Quote paths with spaces or `&`: `view '~/Work/My Job/D5 & D6.dwg'`. The viewer runs
in the background on port 4280; `--port` picks another. Viewer links can end in
`#h=HANDLE` or `#f=N` to open at an entity or finding.

## Project settings: omakase-cadkit.json

Put an `omakase-cadkit.json` in the drawing's folder or any folder above it. The
nearest one wins. It records what a drawing cannot say about itself:

| Key | Meaning |
|---|---|
| `units` | Real drawing units when the file header is wrong (`m`, `mm`, …) |
| `paper` | Sheet size the drawings are plotted on (`A0` … `A4`) |
| `minTextMm` | Smallest acceptable plotted text height |
| `drawingNumber` | Pattern a drawing number must match |
| `packs` | Rule packs to run: `common`, `sewer` |
| `sewer` | Manhole blocks, label patterns, pipe layer, tolerances and limits (`minDepth`, `maxDepth`, `minSlope`) |

[`fixtures/omakase-cadkit.json`](../fixtures/omakase-cadkit.json) is a complete
example. Engineering limits are design decisions: set them yourself; the tool has no
defaults for them. Older `drawkit.json` files still work.

## The rules

**common:** units, sheet frame, drawing number, declared vs measured scale, plotted
text height, stacked duplicates, linked images, xrefs and OLE, overridden dimensions,
content outside the frame, hidden layers, broken entities, and content the tool
cannot draw.

**sewer:** each manhole has one label and number, no stacked symbols, ground level −
invert level = depth and depth limits, labelled vs drawn pipe length, pipes that
connect to manholes, flow arrows that point uphill, and diameters that shrink
downstream.

Rules read the drawing's data, not its picture. On a 589-manhole sewer plan, every
label-to-manhole pairing matched an independent hydraulic model.

## What is not drawn yet

- Paper-space layouts and viewports: listed, not drawn. Only model space is drawn.
- REGION, 3D solids, and OLE objects without a usable picture.
- Dense hatch patterns become a tint. Gradients use one colour. Linetypes with
  text or shapes draw as plain dashes.
- SHX fonts use substitute faces, so text widths and some symbols are approximate.
- Plot styles and lineweights: every line draws as a thin hairline.
- A DWG written by `convert` has been read back by ACadSharp and LibreDWG, but not
  yet opened in AutoCAD.

## Using it from code

Another program can open, check and draw a drawing without the viewer:

```ts
import { Cadkit } from "omakase-cadkit";

const kit = new Cadkit();
try {
  const dwg = await kit.open("drawing.dwg");
  const pipes = dwg.entities({ type: ["LINE", "LWPOLYLINE"], layer: ["SEWER"] });
  const result = dwg.lint({ packs: ["common", "sewer"] });
  const svg = dwg.render({ findings: result.findings, width: 1200 });
} finally {
  kit.close();
}
```

- The first `open()` starts one background reader; later opens reuse it;
  `close()` stops it. Drawings you already opened keep working after `close()`.
- `open()` throws with a clear message for a missing file, a non-DWG/DXF file, or a
  reader crash or timeout. A rule that fails is reported in `result.ruleErrors`.
- Only the package entry is public (`Cadkit`, `CadkitError`, `entityMatcher` and the
  types). Imports from `src/` can change.
- There is no npm package yet; use a source checkout.
  [`examples/library-consumer`](../examples/library-consumer/consumer.ts) shows a
  complete program.

## Files the app keeps

Opened drawings are cached in `~/.cache/omakase-cadkit`, along with recent files and
viewer preferences. The cache contains drawing data, so keep it private. Delete it any
time; set `OMAKASE_CADKIT_CACHE` to move it.
