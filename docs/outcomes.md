# Outcomes

Start here to choose work. This is the current outcome map; decisions, tests, and
handoffs live in [devlogs](../.devlog/README.md). Updated 2026-10-25.

## Now

| ID | Desired outcome | State | Evidence needed to call it done | Next action |
|---|---|---|---|---|
| O1 | A newcomer or their agent can set up a source checkout and inspect a synthetic drawing without private files or Omakase context. | done (Linux x64) | Fresh source-directory setup passed with installed prerequisites; inspect, clean/bad lint, SVG render, and Chromium viewer checks passed. [Evidence](../.devlog/2026-10-25-s01.md). | Use [setup](setup.md); move to O2. Other platforms remain unverified. |
| O2 | Someone outside the project can understand, reuse, and contribute to a public repository. | done (Linux x64 CI) | MIT license and dependency notices exist; contributor and agent entry points work; a clean-checkout CI run and public repository metadata are confirmed. | Public repository is live with a green, annotation-free CI run and a scrubbed history; contamination checks on a fresh clone found no client name. Start O3. [Evidence](../.devlog/2026-10-25-s03.md). |
| O3 | Another application can use a small documented library API without depending on the CLI or viewer. | done (Linux x64, source checkout) | A separate consumer opens a fixture, inspects entities, lints, renders SVG, and closes the sidecar through documented exports and types; errors and process ownership are explicit. | `Cadkit`/`DrawingHandle` are the public entry, and `examples/library-consumer` proves them in CI. Start O4. [Evidence](../.devlog/2026-10-25-s04.md). |
| O8 | A reviewer can correct drawing units from the GUI without editing JSON. | done (Linux x64, source viewer) | A compact SVG properties panel saves a folder profile, preserves other settings, and refreshes effective units, sheet facts and lint; persistence and Auto reset verified on a disposable fixture. | Refresh the viewer and use the sliders icon or unit badge. Check the chosen units against the working drawing; no private drawing profile was changed. [Evidence](../.devlog/2026-10-25-s10.md). |
| O9 | A new user runs Setup once and then launches without managing dependencies. | partial (Linux x64 verified) | Missing Node, .NET and uv are downloaded locally, setup passes, and an empty viewer plus sample drawing work through Launch on each supported OS. | Linux fresh-download and repeat-launch checks pass, including a folder with spaces and tools absent from PATH. Run the configured Windows/macOS bootstrap CI jobs before claiming those platforms. [Evidence](../.devlog/2026-10-25-s13.md). |

## Next

| ID | Desired outcome | State | Evidence needed to call it done | Next action |
|---|---|---|---|---|
| O4 | A user installs a versioned package that works outside the source checkout. | active | Installed tarball contains compiled JS, types, viewer assets, notices, and a working sidecar strategy; CLI and library smoke tests pass on declared supported platforms. | Compiled CLI and library install and run from a tarball; choose how the sidecar ships, then repeat the rehearsal with a drawing open. [Evidence](../.devlog/2026-10-25-s05.md). |
| O6 | Pan, zoom and selection feel instant on heavy drawings. | active | On a private ~152k-primitive survey drawing at DPR 2, zoom and selection frames stay under 20 ms (50+ fps) in the headless benchmark and feel smooth in a real browser; open time does not regress. | Wheel zoom now stretches cached tiles and refines once input settles ([s09](../.devlog/2026-10-25-s09.md)). Next: take the selection out of the raster-tile cache key, then benchmark the ~152k drawing at DPR 2. Baseline: [s08](../.devlog/2026-10-25-s08.md). |
| O7 | A reviewer can measure and compare revisions without leaving the viewer. | queued | Distance, area and coordinates snap to endpoints, midpoints and centres on fixtures; a two-revision fixture pair shows added, deleted and modified entities as findings with handles and bboxes. | Start after O6. Measure with snapping first; revision compare second. Editing remains out of scope. |

## After those

| ID | Desired outcome | State | Evidence needed to call it done | Next action |
|---|---|---|---|---|
| O5 | Drawing reviewers can trust the documented fidelity and findings on a broader set of drawings. | partial | Publicly shareable fixtures and second-source checks support each expanded claim; current rendering limits remain visible. | Hatch text-box metadata is filtered out of geometric fills, preserving continuous frames and hollow interiors in viewer and SVG. Synthetic edge-pixel checks and a real-DWG spot check passed. Review the corrected symbols; CAD fonts, hatch textures, linetypes and layouts remain open. [Evidence](../.devlog/2026-10-25-s14.md). |

## How to use this map

- Work on one useful, verifiable outcome at a time. Next and Later are direction,
  not authorization to implement the whole list.
- Keep each row to the desired result, honest state, completion evidence, and one
  next action. Do not add implementation task trees or completion percentages.
- States are `queued`, `active`, `verifying`, `partial`, `done`, and `later`.
  `done` requires the evidence named in the row. A local check proves its tested
  environment; it does not prove a published package or another platform.
- Update the relevant row and link a devlog when its state or next action changes.
  Keep historical detail in the log rather than growing the map.
- Record unresolved choices in the devlog. Pause only the work that depends on a
  missing choice. MIT is selected; public hosting, API stability, and binary
  distribution remain open.

Borrowed from Omakase: read current state before deeper history, separate acceptance
from implementation, choose a runnable next action, and keep evidence in devlogs.
This repository has no dependency on Omakase's skills, plans, or tooling.

Latest evidence: [2026-10-25-s08](../.devlog/2026-10-25-s08.md).
