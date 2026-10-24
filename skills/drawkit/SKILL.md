---
name: drawkit
description: Inspect, review and lint AutoCAD drawings (DWG or DXF) with the drawkit CLI. Use when asked to look at, check, review, QA, lint or explain a .dwg/.dxf file; find drafting or design errors in layouts, sewer networks, sections, P&IDs or detail sheets; read a manhole/pipe schedule out of a network drawing; convert DWG to DXF or back; or show the user a place in a drawing.
---

# drawkit

drawkit reads DWG and DXF through ACadSharp and answers in text with entity handles. Use it
instead of writing ezdxf scripts or reading rendered images. Pixels are the last resort.

Run `drawkit` (or `node ~/Projects/drawkit/bin/drawkit.mjs` if it is not on PATH). The
first open of a DWG takes a few seconds; later calls hit the cache.

## The loop

1. `drawkit inspect <file>` once. It tells you the version, the units it is using and why,
   the sheet frame, the declared and measured scale, the drawing number, the layers and the
   blocks. Read this before anything else.
2. `drawkit lint <file>` for the review. Exit 1 means at least one error. Each finding
   names a rule, a message and the entity handles involved.
3. `drawkit query <file> --handle H1,H2` to read the entities behind a finding, or
   `--layer L --type TEXT --text REGEX --near x,y,r` to look around it.
4. `drawkit render <file> --finding N --out /tmp/f.png` only when you need to see a
   layout question (overlap, placement). Read the PNG.
5. Give the user `drawkit view <file> --handle H`. It prints a URL that opens the viewer
   zoomed on that entity. Cite handles in what you write so they can be found again.

`drawkit network <file> --csv` prints the manhole/pipe schedule rebuilt from the drawing
(ids, levels, depths, drawn and labelled lengths, diameters, flow direction).
`drawkit convert in.dxf out.dwg` writes DWG (and reads it back to check).

## Project profile: drawkit.json

drawkit walks up from the drawing's folder to the nearest `drawkit.json`. It records what a
drawing cannot say about itself: the real units, the paper it is plotted on, the drawing
number pattern, and the sewer conventions (manhole block names, label regexes, label layout).
`inspect` prints which profile it used. When there is none:

- Do not guess conventions inside your answer. Run `inspect` and `query --layer <x> --type
  TEXT --limit 20` to see the label patterns, then write a `drawkit.json` next to the
  drawings (copy `~/Projects/drawkit/fixtures/drawkit.json` as a template) and ask the user to
  confirm engineering limits such as `minDepth` and `minSlope`. Those are design decisions,
  not drawkit defaults.

## Reading findings

- `units-declared`: the header units are wrong. Common in civil files drawn in UTM metres
  with `$INSUNITS = Inches`. Anything that trusts the header scales the drawing by 0.0254.
- `scale-mismatch`: the title block's scale disagrees with frame size on the profile's paper.
  The message says by how much. `≈` means the fit is not a standard scale.
- `text-height-paper`: text that prints smaller than `minTextMm`. Grouped by layer.
- `duplicate-entities`: stacked identical copies. Data lists every stacked set.
- `sewer-*`: the network rebuilt from symbols and label clusters. Matching is verified on a
  real 589-pipe network against its hydraulic model; still, before you report a sewer
  finding as a design error, `query` the handles and check the labels say what the finding
  says.

`info` findings are context, not defects. Report errors first, then warnings, and say how
many of each you did not list.

## Do not

- Do not pipe drawkit through `head` or `tail` when you need its exit code.
- Do not reason about geometry from a full-sheet render: render a finding or a handle.
- Do not edit the source DWG. Write a new file and say where it is.
