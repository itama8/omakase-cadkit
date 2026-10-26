# Contributing

1. **Set up** with [developer setup](docs/setup.md). You need no private drawings.
2. **Pick one outcome** from [outcomes](docs/outcomes.md) and read its latest devlog.
3. **Make the change.** Follow [AGENTS.md](AGENTS.md); its rules apply to people too.
4. **Check it.** Run `npm run typecheck && npm test`. For viewer changes, also run
   `scripts/shot.mjs --check` and look at the screenshot.
5. **Hand off.** For anything bigger than a small fix, write a devlog (see
   [.devlog/README.md](.devlog/README.md)) and update the outcome row if its state
   changed.

In a pull request, say what problem it solves, what changed, how you checked it, and
what is still unproven.

Keep private drawings, client names and personal paths out of commits, fixtures and
reports. Contributions are under [AGPL-3.0-only](LICENSE); add any new dependency to
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Discuss changes to the public
library API, system requirements or distribution before relying on them.
