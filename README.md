# omakase-cadkit

View, inspect and lint AutoCAD drawings (DWG and DXF) for civil infrastructure: sewer
networks, layouts, sections, detail sheets. It is built for an agent and a reviewer working
together. The agent gets text with entity handles; the reviewer gets a viewer that jumps to
those handles.

The source CLI, viewer and library work today. Standalone alpha downloads are
available; npm publishing remains disabled. See the compact
[outcome map](docs/outcomes.md) for current work and what comes next.

A supervised sidecar owns the file format, a service owns files and lint, and a
framework-free canvas renders bounded JSON. No Omakase installation is required.

```
DWG/DXF ──> sidecar (C#, ACadSharp)  ──payload JSON──>  cache (~/.cache/omakase-cadkit)
                                                     │
                       Node service: sheet analysis, lint rules, network rebuild
                         │                          │
                    CLI (agents)              HTTP viewer (people)
```

## Run it

**Tester:** download the ZIP for your platform from the [latest
prerelease](https://github.com/itama8/omakase-cadkit/releases/tag/v0.1.0-alpha.1), unzip it, and
double-click `launch.cmd` on Windows or `launch.command` on macOS/Linux. The
archive carries its own Node runtime and DWG/DXF sidecar, so nothing is installed
and nothing is downloaded on first run. Builds exist for Linux x64, macOS Apple
Silicon and Intel, and Windows x64; `START-HERE.txt` in the folder has the details.
See [installing a download](docs/setup.md#install-a-download) and, for what an
alpha does not do yet, [trying an alpha](docs/setup.md#trying-an-alpha).

**Developer:** work from a checkout instead. It needs Node 23.6+, the .NET 8 SDK
and runtime, and `uv`; `setup.cmd` on Windows or `bash setup.command` on
macOS/Linux installs those locally into `.tools/` and builds and verifies the app.
CI runs that Setup and opens a synthetic drawing through Launch on Linux x64,
macOS on Apple Silicon and Intel, and Windows x64. See [setup](docs/setup.md) for
prerequisites, troubleshooting, optional tools, and tested platform limits. From
your checkout:

```bash
cd /path/to/omakase-cadkit
npm ci
npm run setup
node bin/omakase-cadkit.mjs inspect fixtures/sewer_clean.dxf
node bin/omakase-cadkit.mjs view fixtures/sewer_bad.dxf
```

`setup` builds, generates synthetic drawings, typechecks, and tests without private
files. Use `node bin/omakase-cadkit.mjs` from the checkout for commands below, or
optionally run `npm link` to make the short command available.

## Start here

- **Try the tool:** [setup and first drawing](docs/setup.md), then commands below;
alpha limits and reporting are in [trying an alpha](docs/setup.md#trying-an-alpha).
- **Have an agent review a drawing:** [bundled drawing skill](skills/omakase-cadkit/SKILL.md).
- **Contribute:** [CONTRIBUTING.md](CONTRIBUTING.md); agents also read [AGENTS.md](AGENTS.md).
- **Choose the next work:** [outcomes](docs/outcomes.md).
- **Read evidence or leave a handoff:** [devlogs and template](.devlog/README.md).

## Use

Run `omakase-cadkit` with no arguments to launch the app with no drawing loaded.
Use the folder icon or recent drawings to open a file. From the source checkout,
`node bin/omakase-cadkit.mjs` does the same.

```bash
omakase-cadkit                                     # launch an empty viewer
omakase-cadkit inspect drawing.dwg                 # units, frame, scale, layers, blocks
omakase-cadkit lint drawing.dwg [more.dwg ...]     # findings; exit 1 on errors; --json
omakase-cadkit query drawing.dwg --layer NODE --text '^MH-' --limit 5
omakase-cadkit network drawing.dwg --csv           # manhole/pipe schedule from the drawing
omakase-cadkit render drawing.dwg --finding 3 --out f.png
omakase-cadkit view drawing.dwg --handle 5DF85     # opens the viewer, zoomed on the entity
omakase-cadkit view '~/Work/My Job/D5 & D6.dwg'    # quote paths with spaces; ~ still works
omakase-cadkit convert in.dxf out.dwg              # DWG <-> DXF, reread to verify
omakase-cadkit rules                               # every rule and why it exists
```

The viewer (`omakase-cadkit serve`, default `http://127.0.0.1:4280`, loopback only) has layers, text
search, findings with jump-to, an entity inspector, and sheet facts. `F` fits, `J`/`K` step
through findings, `/` searches text, clicking an entity inspects it. URLs carry `#h=HANDLE`
or `#f=N`, so an agent can hand over an exact place.

Drag with the left or middle button to pan; use the wheel or the +/− buttons to zoom.
The toolbar in the bottom-right corner has Back (also `Alt+Left`), Fit, zoom and the background
image switch; drawing facts (version, units, errors and warnings) sit in the status bar. Collapse
a side panel with the chevron on its outer edge: its tabs stay as a ribbon on the window edge,
which you can drag up or down and click to reopen that tab. Selecting a finding keeps the finding list open, highlights it on the drawing and
shows **How to fix**: AutoCAD commands with what each does, plus icon buttons for **Copy AutoCAD selection**
(AutoLISP to paste at the command line; needs full AutoCAD or LT 2024+) and **Copy handles**.
Every copy opens a popup showing exactly what went to the clipboard; it stays until closed.
Enable **Show all finding markers** to see the other findings too. Re-running lint preserves your view.
Use the sliders icon in the header (or click the units badge in the status bar) to open **Drawing properties**.
Choose `mm`, `cm`, `m`, `in`, `ft`, or **Auto**, then Apply. The ruler previews the unit size;
the badge, sheet facts and findings update immediately. This saves a profile beside the drawing
and applies to other drawings in that folder and inheriting subfolders. Existing profile settings
are preserved; inherited settings are copied locally so an ancestor profile stays unchanged.
Auto removes the unit override and returns to the normal header/detection logic. It does not
rescale or edit the DWG. The panel keeps the original file-header units visible for comparison.

The renderer reuses image tiles while panning, rendering only newly exposed strips, and skips geometry smaller than a pixel
at sheet scale; those details appear as you zoom in. Linked raster underlays (`IMAGE`) draw beneath the
vector geometry when the referenced file is next to the drawing; the viewer streams it from the local
server. Inspection and lint still use the full source geometry.

To check viewer interactions and measure delivered pan frames with Chromium, start the
server and run:

```bash
node scripts/shot.mjs 'http://127.0.0.1:4280/?file=/absolute/path/to/drawing.dwg' /tmp/viewer.png 1500 900 --check
```

## Library

Another program can open, inspect, lint, and render a drawing without the CLI or viewer:

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

The entry point is `src/index.ts`, published as the package's `exports` and `types`:
`Cadkit`, `CadkitError`, `entityMatcher`, and the payload, config, lint, sheet, and SVG types.
Deep imports under `src/` are internal and can change.

- **Process ownership:** a new `Cadkit` starts nothing. The first uncached `open()` spawns one
  sidecar, later opens reuse it, and `close()` stops it. `running` reports whether it is
  alive; `closed` reports whether this instance still accepts opens. A returned drawing owns
  parsed data, not the process, so it keeps linting and rendering after `close()`.
- **Errors:** `open()` throws for a missing file, a non-DWG/DXF file, an unbuilt sidecar, a
  crash, or a timeout, and the message names the cause. A rule that throws is reported in
  `LintResult.ruleErrors` instead of failing the lint.
- **Cache:** set `OMAKASE_CADKIT_CACHE` before importing the package to move the payload cache.

[`examples/library-consumer/`](examples/library-consumer/consumer.ts) is a separate package
that depends on this one and exercises every step above; `npm run consumer` installs it,
typechecks it, and runs it. `npm run build` emits `dist/` JavaScript and `.d.ts` files, which
are what `exports` and `types` point at, so consumers do not need to run TypeScript.

## Project profile

An `omakase-cadkit.json` in the drawing's folder or any parent sets what the file cannot say about
itself:

| key | meaning |
|---|---|
| `units` | real drawing units when `$INSUNITS` is wrong (`m`, `mm`, ...) |
| `paper` | sheet size the drawings are plotted on (`A0`...`A4`); decides the measured scale |
| `minTextMm` | smallest acceptable plotted text height |
| `drawingNumber` | regex a drawing number must match |
| `packs` | rule packs to run: `common`, `sewer` |
| `sewer` | manhole and outfall blocks, label regexes and layout, pipe layer, flow-arrow block, tolerances, and engineering limits (`minDepth`, `maxDepth`, `minSlope`) |

`fixtures/omakase-cadkit.json` is a complete example. Existing `drawkit.json` profiles
are also accepted; at each directory the new filename takes precedence. The `drawkit` CLI
remains available as a compatibility alias. Set `OMAKASE_CADKIT_CACHE` to override the
cache directory (`DRAWKIT_CACHE` is also accepted).

## Rules

`common`: units, sheet frame and drawing number, declared vs measured scale, plotted text
height, stacked duplicates, linked rasters/xrefs/OLE, overridden dimensions, content outside
the frame, hidden layers, degenerate entities, and entity types omakase-cadkit cannot draw.

`sewer`: every manhole has one label and one number, stacked symbols, GL − IL = depth and
depth limits, labelled vs drawn pipe length, pipes ending at manholes and network parts,
flow arrows that point uphill, and diameters that shrink downstream.

Rules run on the payload, not on pixels. Labels are matched to symbols by an assignment
that minimises total distance, in each label block's own rotated frame. On a private
589-manhole sewerage plan every pairing agrees with an independent hydraulic model.

## Layout

```
sidecar/Program.cs      ACadSharp reader/writer, payload writer (JSON lines protocol)
src/sidecar.ts          lazy supervised sidecar process
src/store.ts            payload cache (disk + memory)
src/sheet.ts            units, frames, declared/measured scale, drawing number
src/lint/               engine, common pack, sewer pack (network rebuild)
src/render-svg.ts       region -> SVG for agents
src/query.ts            entity filters shared by `query` and the library
src/index.ts            public library entry: Cadkit, DrawingHandle
src/cli.ts, server.ts   CLI and loopback viewer server
viewer/                 canvas renderer and UI, no framework
examples/library-consumer/  separate package that uses only the public library API
dist/                   compiled CLI and library (npm run build:lib), what npm publishes
fixtures/               generator for synthetic drawings with planted defects
test/                   end-to-end tests (+ a local real-drawing regression)
skills/omakase-cadkit/         agent skill for using omakase-cadkit on drawings
```

## Limits

- Model space only; paper-space layouts and viewports are listed but not drawn.
- MULTILEADER, REGION, 3D solids and OLE contents are not drawn (counted under `unrendered`).
- Linked rasters draw in the viewer; SVG render embeds them only when the file is present and at most
  6 MB, so a large satellite backdrop is drawn in the viewer but left out of exported SVG.
- Hatch patterns draw as translucent fills; linetypes draw solid.
- DWG written by ACadSharp round-trips through ACadSharp and LibreDWG; it has not yet been
  opened in AutoCAD itself.

## License

Copyright (c) 2026 omakase-cadkit contributors.

[GNU Affero General Public License v3.0 only (AGPL-3.0-only)](LICENSE).
Dependencies retain their own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md).
The previously published `v0.1.0-alpha.1` tag and downloads retain their MIT license;
this change applies to subsequent source revisions and releases.
