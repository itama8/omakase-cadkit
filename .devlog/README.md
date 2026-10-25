# Devlogs

Use [the outcome map](../docs/outcomes.md) for current direction. Use a devlog to
explain what changed, why, how it was checked, and what the next person needs.

Create `YYYY-MM-DD-sNN.md` for a meaningful checkpoint. Pick an unused number;
do not overwrite another contributor's entry. Copy [TEMPLATE.md](TEMPLATE.md).
Small changes need only a few sentences and a short verification table. Omit
empty sections; expand only when the risk or handoff needs it.

Record commands with their actual results and environment. Distinguish automated
checks, manual observations, skipped checks, and unresolved acceptance. Include
failed attempts when they explain a decision or remaining limitation.

Link stable evidence in the repository or CI. Temporary paths can help a local
handoff, but cannot be the only proof another contributor needs. Never include
private drawing contents, credentials, or personal absolute paths.

Reference existing source commits when useful. If the log and implementation are
committed together, write `this change` rather than inventing a future SHA. Git
history can identify the commit later. Old logs are historical; append a correction
or a new entry when an old conclusion changes.

Update the outcome map only when the current state or next action changes. Do not
copy the entire session history into the map or create a separate detailed plan.
