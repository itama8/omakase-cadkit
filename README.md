# drawkit

View, inspect and lint AutoCAD drawings (DWG and DXF) for civil infrastructure: sewer
networks, layouts, sections, detail sheets. It is built for an agent and a reviewer working
together. The agent gets text with entity handles; the reviewer gets a viewer that jumps to
those handles.

It is also the reference build for the parked Omakase CAD workstream
(`omakase-v2/docs/plans/active/cad-drawings-plan.md`). The process split is the one Omakase
would use: a supervised sidecar owns the file format, a service owns files and lint, and a
framework-free canvas renders bounded JSON.

```
DWG/DXF ──> sidecar (C#, ACadSharp)  ──payload JSON──>  cache (~/.cache/drawkit)
                                                     │
                       Node service: sheet analysis, lint rules, network rebuild
                         │                          │
                    CLI (agents)              HTTP viewer (people)
```

## Setup

Needs Node 23.6+ (runs the TypeScript directly), the .NET 8 SDK (`~/.dotnet` is found
automatically), and for fixtures `uv`.

```bash
npm install
npm run build            # sidecar + viewer bundle
npm run fixtures         # synthetic test drawings
npm test
ln -s "$PWD/bin/drawkit.mjs" ~/.local/bin/drawkit   # optional
```

## Use

```bash
drawkit inspect drawing.dwg                 # units, frame, scale, layers, blocks
drawkit lint drawing.dwg [more.dwg ...]     # findings; exit 1 on errors; --json
drawkit query drawing.dwg --layer NODE --text '^MH-' --limit 5
drawkit network drawing.dwg --csv           # manhole/pipe schedule from the drawing
drawkit render drawing.dwg --finding 3 --out f.png
drawkit view drawing.dwg --handle 5DF85     # URL to the viewer, zoomed on the entity
drawkit convert in.dxf out.dwg              # DWG <-> DXF, reread to verify
drawkit rules                               # every rule and why it exists
```

The viewer (`drawkit serve`, default `http://127.0.0.1:4280`, loopback only) has layers, text
search, findings with jump-to, an entity inspector, and sheet facts. `F` fits, `J`/`K` step
through findings, `/` searches text, clicking an entity inspects it. URLs carry `#h=HANDLE`
or `#f=N`, so an agent can hand over an exact place.

## Project profile

A `drawkit.json` in the drawing's folder or any parent sets what the file cannot say about
itself:

| key | meaning |
|---|---|
| `units` | real drawing units when `$INSUNITS` is wrong (`m`, `mm`, ...) |
| `paper` | sheet size the drawings are plotted on (`A0`...`A4`); decides the measured scale |
| `minTextMm` | smallest acceptable plotted text height |
| `drawingNumber` | regex a drawing number must match |
| `packs` | rule packs to run: `common`, `sewer` |
| `sewer` | manhole and outfall blocks, label regexes and layout, pipe layer, flow-arrow block, tolerances, and engineering limits (`minDepth`, `maxDepth`, `minSlope`) |

`fixtures/drawkit.json` is a complete example.

## Rules

`common`: units, sheet frame and drawing number, declared vs measured scale, plotted text
height, stacked duplicates, linked rasters/xrefs/OLE, overridden dimensions, content outside
the frame, hidden layers, degenerate entities, and entity types drawkit cannot draw.

`sewer`: every manhole has one label and one number, stacked symbols, GL − IL = depth and
depth limits, labelled vs drawn pipe length, pipes ending at manholes and network parts,
flow arrows that point uphill, and diameters that shrink downstream.

Rules run on the payload, not on pixels. Labels are matched to symbols by an assignment
that minimises total distance, in each label block's own rotated frame. On the private D3
network (589 manholes, 589 pipes) every pairing agrees with the hydraulic model.

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
skills/drawkit/         agent skill for using drawkit on drawings
```

## Limits

- Model space only; paper-space layouts and viewports are listed but not drawn.
- MULTILEADER, REGION, 3D solids and OLE contents are not drawn (counted under `unrendered`).
- Hatch patterns draw as translucent fills; linetypes draw solid.
- DWG written by ACadSharp round-trips through ACadSharp and LibreDWG; it has not yet been
  opened in AutoCAD itself.
