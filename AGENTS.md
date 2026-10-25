# AGENTS.md

omakase-cadkit views, inspects and lints DWG/DXF drawings. Read `README.md` for the shape. Using
omakase-cadkit on drawings (not developing it) is covered by `skills/omakase-cadkit/SKILL.md`.

## Start and hand off

- Setup is documented in `docs/setup.md`: `npm ci`, then `npm run setup` from the checkout.
  It uses synthetic drawings; private DWGs and Omakase are not required.
- Read `docs/outcomes.md` for current state and the next useful action, then its linked
  devlog. Keep planning outcome-based; do not expand it into detailed implementation plans.
- Record meaningful changes, decisions, exact checks and limits in `.devlog/YYYY-MM-DD-sNN.md`
  using `.devlog/TEMPLATE.md`. Update the outcome row when its state or next action changes.
- `CONTRIBUTING.md` covers contribution and evidence expectations. Source checks do not
  establish installed-package or cross-platform support. AGPL-3.0-only is selected; npm publishing
  remains disabled until the package outcome is verified.

## Commands

- `npm run build:sidecar` after any change to `sidecar/Program.cs`. The payload cache is keyed
  by file path, size and mtime, not by sidecar version: clear `~/.cache/omakase-cadkit` after a
  payload change.
- `npm run build:viewer` after any change under `viewer/`.
- `npm run build:lib` after any change under `src/`: `bin/` and the package entry run
  `dist/`, not the sources. `npm run setup` and `npm run build` include it.
- `npm run typecheck` and `npm test` before calling work done. Tests need the sidecar built
  and `npm run fixtures` run once.
- `npm run bundle` builds the download ZIP for the current platform (prebuilt sidecar, its
  own Node runtime, compiled CLI, viewer). CI attaches those to a `v*` tag's release, so a
  tester unzips and launches with no tools installed. Needs the .NET SDK and `zip`.
- `node scripts/shot.mjs <viewer-url> out.png [w h] [--eval js]` screenshots the viewer
  headless once the drawing has loaded (needs `chromium`). Use it to check viewer changes.

## Rules for rule writers

- A rule earns its place by catching a real defect. Every new rule gets a planted defect in
  `fixtures/make_fixtures.py` (bad drawing) and must stay silent on the clean drawing.
- Before believing a rule on a real drawing, check a sample of its findings against a second
  source (the hydraulic model, the issued PDF, the raw entities via `omakase-cadkit query`). The
  first versions of the sewer matcher produced hundreds of false findings that looked
  plausible; every one came from pairing labels to the wrong symbol.
- Findings carry handles of real entities and a world bbox. Messages state the numbers that
  disagree, not just that something is wrong.
- Engineering limits (minimum depth, minimum slope) come from `omakase-cadkit.json`, never from
  defaults in code.

## Code

- Node runs `src/` TypeScript directly: erasable syntax only (no enums, no parameter
  properties, no namespaces), `.ts` extensions on relative imports.
- `viewer/` stays framework-free so it can move into another host.
- Payload schema changes bump `schema` in `sidecar/Program.cs` and `src/types.ts` together.
