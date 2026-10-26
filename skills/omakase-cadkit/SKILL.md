---
name: omakase-cadkit
description: Inspect, review and lint AutoCAD drawings (DWG or DXF) with the omakase-cadkit CLI. Use when asked to look at, check, review, QA, lint or explain a .dwg/.dxf file; find drafting or design errors in layouts, sewer networks, sections, P&IDs or detail sheets; read a manhole/pipe schedule out of a network drawing; convert DWG to DXF or back; or show the user a place in a drawing.
---

# omakase-cadkit

omakase-cadkit reads DWG and DXF and answers in text with entity handles. Use it
instead of writing ezdxf scripts or looking at rendered images.

**Running it.** If `omakase-cadkit` is not on PATH, run it from the app folder with
`launch.cmd` (Windows) or `bash launch.command` (Mac/Linux), or from a source
checkout with `node bin/omakase-cadkit.mjs`. The first open of a DWG takes a few
seconds; later calls are cached.

## Review a drawing

1. `omakase-cadkit inspect <file>` first. It reports the version, the units it uses
   and why, the sheet frame, the declared and measured scale, the drawing number,
   layers and blocks.
2. `omakase-cadkit lint <file>`. Exit 1 means at least one error. Each finding has a
   rule, a `title`, a `message` with the numbers that disagree, `fix` steps for
   AutoCAD, and entity handles.
3. `omakase-cadkit query <file> --handle H1,H2` to read the entities behind a finding.
   Use `--layer L --type TEXT --text REGEX --near x,y,r` to look around it.
4. `omakase-cadkit render <file> --finding N --out /tmp/f.png` only when a question is
   about layout (overlap, placement). Read the image.
5. Give the user `omakase-cadkit view <file> --handle H`. The URL opens the viewer
   zoomed on that entity. Cite handles in your answer.

Also: `network <file> --csv` prints the manhole and pipe schedule rebuilt from the
drawing. `convert in.dxf out.dwg` writes a new file and reads it back to check.

## Project settings

The tool uses the nearest `omakase-cadkit.json` at or above the drawing's folder;
`inspect` says which. It holds what the drawing cannot say: real units, paper size,
drawing-number pattern, and sewer conventions.

If there is none, do not guess conventions. Run `inspect` and
`query --layer <x> --type TEXT --limit 20` to see the label patterns. Then write an
`omakase-cadkit.json` next to the drawings, using `fixtures/omakase-cadkit.json` from
the repository as a template. Ask the user to confirm engineering limits such as
`minDepth` and `minSlope`; they are design decisions, not tool defaults.

## Reading findings

- `units-declared`: the header units are wrong. Civil drawings in UTM metres often
  say `$INSUNITS = Inches`, which scales everything by 0.0254.
- `scale-mismatch`: the title block's scale disagrees with the frame size on the
  configured paper. `≈` means the fit is not a standard scale.
- `text-height-paper`: text that prints smaller than `minTextMm`, grouped by layer.
  Hidden, no-plot and Defpoints layers are skipped. If the paper size was guessed,
  these are warnings, not errors.
- `duplicate-entities`: stacked identical copies.
- `sewer-*`: the network rebuilt from symbols and labels. Before calling one a design
  error, `query` its handles and confirm the labels say what the finding says.

`info` findings are context, not defects. Report errors first, then warnings, and say
how many you left out.

## Do not

- Pipe the tool through `head` or `tail` when you need its exit code.
- Reason about geometry from a full-sheet render. Render one finding or handle.
- Edit the source drawing. Write a new file and say where it is.
