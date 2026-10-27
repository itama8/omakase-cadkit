# Outcomes

What the project is working toward, and the next step for each. Details and evidence
are in the linked devlogs. Updated 2026-10-27.

**States:** `queued` → `active` → `verifying` → `done`; also `partial` and `later`.
`done` means the evidence was seen, and only on the platforms named.

## Now

| ID | Outcome | State | Next step |
|---|---|---|---|
| O11 | A tester installs one download and uses the app with nothing else installed. | verifying | Publish the `v0.1.0-alpha.2` draft release ([s04](../.devlog/2026-10-27-s04.md)); the tester installs it and opens 3–8 MB drawings A → B → A, noting any window and the load timings. CI already builds, installs, launches and uninstalls it ([s03](../.devlog/2026-10-27-s03.md)). |
| O10 | A drafter reading a finding knows what is wrong, how to fix it in AutoCAD, and can tune the checks. | partial | Turn rules on/off, change severity and accept findings from the GUI ([s04](../.devlog/2026-10-26-s04.md)). |
| O6 | Pan, zoom and selection feel instant on heavy drawings. | active | Retest quicker cold/warm opening on desktop and finish high-DPI hatch redraw ([s09](../.devlog/2026-10-27-s09.md)). |
| O5 | Reviewers can trust what is drawn and found on a wider set of drawings. | partial | Review the newly drawn details in the viewer; plot styles, exact fonts and layouts remain ([s10](../.devlog/2026-10-26-s10.md)). |

## Next

| ID | Outcome | State | Next step |
|---|---|---|---|
| O4 | Developers install a versioned npm package that works outside the checkout. | active | Decide how the sidecar ships in the package ([s05](../.devlog/2026-10-25-s05.md)). |
| O7 | Reviewers measure distances and compare revisions in the viewer. | queued | Start after O6: snapping measurement first, then revision compare. |

## Done

| ID | Outcome | Evidence |
|---|---|---|
| O1 | A newcomer sets up a checkout and inspects a sample drawing. | [s01](../.devlog/2026-10-25-s01.md), [s06](../.devlog/2026-10-26-s06.md) |
| O2 | The public repository is understandable and open to contributions. | [s03](../.devlog/2026-10-25-s03.md) |
| O3 | Another program uses the library API without the CLI or viewer. | [s04](../.devlog/2026-10-25-s04.md) |
| O8 | Reviewers fix drawing units from the GUI. | [s10](../.devlog/2026-10-25-s10.md) |
| O9 | Setup installs missing tools, then Launch works, on Linux, macOS and Windows x64. | [s05](../.devlog/2026-10-26-s05.md) |

## How to use this map

- Work on one outcome at a time. "Next" is direction, not a to-do list.
- Keep each row to one outcome, its state and one next step.
- When a state or next step changes, update the row and link the devlog.
- Open decisions belong in devlogs. Decided: AGPL-3.0-only, public repository,
  unsigned alpha downloads. Open: library API stability, npm publishing.
