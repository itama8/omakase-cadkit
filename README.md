# omakase-cadkit

View, inspect and lint AutoCAD drawings (DWG and DXF) for civil infrastructure: sewer
networks, layouts, sections, detail sheets. It is built for an agent and a reviewer working
together. The agent gets text with entity handles; the reviewer gets a viewer that jumps to
those handles.

The source CLI and viewer work today. A reusable npm library and versioned package
are being prepared; there is no supported package import API yet. See the compact
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

## Setup

Needs Node 23.6+, the .NET 8 SDK and runtime, and `uv`. See
[setup for people and agents](docs/setup.md) for prerequisites, troubleshooting,
optional tools, and tested platform limits. From your checkout:

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

- **Use the tool:** [setup and first drawing](docs/setup.md), then commands below.
- **Have an agent review a drawing:** [bundled drawing skill](skills/omakase-cadkit/SKILL.md).
- **Contribute:** [CONTRIBUTING.md](CONTRIBUTING.md); agents also read [AGENTS.md](AGENTS.md).
- **Choose the next work:** [outcomes](docs/outcomes.md).
- **Read evidence or leave a handoff:** [devlogs and template](.devlog/README.md).

## Use

```bash
omakase-cadkit inspect drawing.dwg                 # units, frame, scale, layers, blocks
omakase-cadkit lint drawing.dwg [more.dwg ...]     # findings; exit 1 on errors; --json
omakase-cadkit query drawing.dwg --layer NODE --text '^MH-' --limit 5
omakase-cadkit network drawing.dwg --csv           # manhole/pipe schedule from the drawing
omakase-cadkit render drawing.dwg --finding 3 --out f.png
omakase-cadkit view drawing.dwg --handle 5DF85     # URL to the viewer, zoomed on the entity
omakase-cadkit convert in.dxf out.dwg              # DWG <-> DXF, reread to verify
omakase-cadkit rules                               # every rule and why it exists
```

The viewer (`omakase-cadkit serve`, default `http://127.0.0.1:4280`, loopback only) has layers, text
search, findings with jump-to, an entity inspector, and sheet facts. `F` fits, `J`/`K` step
through findings, `/` searches text, clicking an entity inspects it. URLs carry `#h=HANDLE`
or `#f=N`, so an agent can hand over an exact place.

Drag with the left or middle button to pan; use the wheel or the +/− buttons to zoom.
The drawing toolbar includes Fit, Back (also `Alt+Left`), and buttons to hide either side
panel. Selecting a finding keeps the finding list open and highlights it on the drawing;
enable **Show all finding markers** to see the other findings too. Re-running lint preserves your view.
The renderer reuses image tiles while panning, rendering only newly exposed strips, and skips geometry smaller than a pixel
at sheet scale; those details appear as you zoom in. Inspection and lint still use the full
source geometry.

To check viewer interactions and measure delivered pan frames with Chromium, start the
server and run:

```bash
node scripts/shot.mjs 'http://127.0.0.1:4280/?file=/absolute/path/to/drawing.dwg' /tmp/viewer.png 1500 900 --check
```

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
src/cli.ts, server.ts   CLI and loopback viewer server
viewer/                 canvas renderer and UI, no framework
fixtures/               generator for synthetic drawings with planted defects
test/                   end-to-end tests (+ a local real-drawing regression)
skills/omakase-cadkit/         agent skill for using omakase-cadkit on drawings
```

## Limits

- Model space only; paper-space layouts and viewports are listed but not drawn.
- MULTILEADER, REGION, 3D solids and OLE contents are not drawn (counted under `unrendered`).
- Hatch patterns draw as translucent fills; linetypes draw solid.
- DWG written by ACadSharp round-trips through ACadSharp and LibreDWG; it has not yet been
  opened in AutoCAD itself.

## License

[MIT](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md) for ACadSharp attribution.
