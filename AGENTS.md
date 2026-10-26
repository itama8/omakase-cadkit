# AGENTS.md

omakase-cadkit views, inspects and lints DWG/DXF drawings. The [README](README.md)
explains what it is. To *use* it on drawings rather than develop it, read
[skills/omakase-cadkit/SKILL.md](skills/omakase-cadkit/SKILL.md).

## Before you start

- Set up with [docs/setup.md](docs/setup.md).
- Read [docs/outcomes.md](docs/outcomes.md) and the devlog it links. Work on one
  outcome.
- Check `git status` and keep other people's uncommitted work.

## Build and check

| After changing | Run |
|---|---|
| `src/` | `npm run build:lib` |
| `viewer/` | `npm run build:viewer` |
| `sidecar/*.cs` | `npm run build:sidecar`, then restart the viewer server |
| Anything | `npm run typecheck && npm test` before calling it done |

- Check viewer changes visually: `node scripts/shot.mjs <url> out.png --check`.
- `npm run bundle` builds this platform's download (Windows: installer via Inno
  Setup; others: ZIP). `node scripts/check-bundle.mjs` launches it.
- `node scripts/make-icon.mjs` regenerates the app icon in `assets/` and
  `viewer/favicon.svg`.

## Code rules

- Node runs `src/` TypeScript directly. Use erasable syntax only: no enums, parameter
  properties or namespaces. Relative imports end in `.ts`.
- `viewer/` uses no framework.
- When the payload format changes, bump `schema` in `sidecar/Program.cs` and
  `src/types.ts` together.

## Lint rule rules

- A rule must catch a real defect. Add a planted defect for it to
  `fixtures/make_fixtures.py`, and keep it silent on the clean drawing.
- Before trusting a rule on a real drawing, check some findings against a second
  source: the hydraulic model, the issued PDF, or the raw entities via `query`.
  Early sewer matching produced hundreds of plausible but wrong findings.
- Every finding carries real entity handles and a world bbox. Its message gives the
  numbers that disagree.
- Engineering limits (minimum depth, slope) come from `omakase-cadkit.json`, never
  from defaults in code.

## Hand off

Write `.devlog/YYYY-MM-DD-sNN.md` from the [template](.devlog/TEMPLATE.md): what
changed, the exact checks and their results, and what is still unproven. Update the
outcome row if its state or next step changed. A passing check proves only the
environment it ran in. npm publishing stays off until the package outcome is done.
