# Contributing

Start with [README.md](README.md) and [source setup](docs/setup.md). No private
drawings or Omakase installation are needed. People and agents use the same commands.

## Choose work

Read [outcomes](docs/outcomes.md), then its linked devlog. Keep a change focused on
one useful result and state how it will be verified. Next and Later outcomes are
direction, not a request to implement everything. Discuss changes to public API,
runtime requirements, and distribution before treating them as settled contracts.

The project is licensed under AGPL-3.0-only; see [LICENSE](LICENSE). Contributions are made under
that license. Preserve dependency attribution in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Make and verify a change

- Preserve unrelated work in a shared checkout. Inspect Git status and branch first.
- Follow [AGENTS.md](AGENTS.md) for code and lint-rule contracts.
- Run `npm run typecheck` and `npm test` before handing back a change.
- Rebuild the sidecar after C# changes, and invalidate the payload cache when output
  changes. Rebuild the viewer after viewer changes.
- For viewer behavior, use `scripts/shot.mjs --check` and inspect the relevant
  interaction. A typecheck alone does not prove navigation or layout.
- New rules need planted defects and must stay silent on clean drawings. Check
  real findings against raw entities or another authorized source.
- Use synthetic or redistributable drawings in public fixtures and reports. Keep
  private drawings, exported client content, and personal paths out of commits.

## Leave a useful handoff

Use [the compact devlog format](.devlog/README.md) for meaningful behavior,
architecture, setup, or outcome changes. Record the actual checks, decisions,
acceptance limits, and one next action. Tiny typo fixes do not need a devlog.
Update the outcome row when current state or the next action changes.

A contribution description should explain the concrete problem, resulting
behavior, verification, and remaining gaps. Link the relevant outcome and devlog.
Do not equate a source-checkout test with a successful package installation, or
an automated fixture check with manual acceptance on an issued drawing.
