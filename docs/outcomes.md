# Outcomes

Start here to choose work. This is the current outcome map; decisions, tests, and
handoffs live in [devlogs](../.devlog/README.md). Updated 2026-10-25.

## Now

| ID | Desired outcome | State | Evidence needed to call it done | Next action |
|---|---|---|---|---|
| O1 | A newcomer or their agent can set up a source checkout and inspect a synthetic drawing without private files or Omakase context. | done (Linux x64) | Fresh source-directory setup passed with installed prerequisites; inspect, clean/bad lint, SVG render, and Chromium viewer checks passed. [Evidence](../.devlog/2026-10-25-s01.md). | Use [setup](setup.md); move to O2. Other platforms remain unverified. |

## Next

| ID | Desired outcome | State | Evidence needed to call it done | Next action |
|---|---|---|---|---|
| O2 | Someone outside the project can understand, reuse, and contribute to a public repository. | verifying | MIT license and dependency notices exist; contributor and agent entry points work; a clean-checkout CI run and public repository metadata are confirmed. | Local CI preparation is done and lint-clean; create `itama8/omakase-cadkit`, push, and read the first CI run. [Evidence](../.devlog/2026-10-25-s02.md). |
| O3 | Another application can use a small documented library API without depending on the CLI or viewer. | queued | A separate consumer opens a fixture, inspects entities, lints, renders SVG, and closes the sidecar through documented exports and types; errors and process ownership are explicit. | Select the smallest API from those real calls, then prove it in a separate consumer. |

## After those

| ID | Desired outcome | State | Evidence needed to call it done | Next action |
|---|---|---|---|---|
| O4 | A user installs a versioned package that works outside the source checkout. | queued | Installed tarball contains compiled JS, types, viewer assets, notices, and a working sidecar strategy; CLI and library smoke tests pass on declared supported platforms. | After O3, choose sidecar distribution and runtime requirements; rehearse package installation before enabling publishing. |
| O5 | Drawing reviewers can trust the documented fidelity and findings on a broader set of drawings. | later | Publicly shareable fixtures and second-source checks support each expanded claim; current rendering limits remain visible. | Choose a concrete drawing failure when prioritized; hatch textures, linetypes, and layout support are candidates, not promised features. |

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

Latest evidence: [2026-10-25-s02](../.devlog/2026-10-25-s02.md).
