# Set up a source checkout

This route is for a person or an agent setting up the CLI and viewer from source.
An installable npm library is a [later outcome](outcomes.md); do not use
`npm install omakase-cadkit` as a substitute for these steps yet.

## Prerequisites

- Node.js 23.6 or newer and npm. Tests and tooling run the TypeScript sources with native
  type stripping; the CLI and library run compiled `dist/` output from `npm run build`.
- The .NET 8 SDK, including the .NET 8 runtime. A runtime-only installation cannot build
  the sidecar. The build checks `DOTNET_ROOT`, `~/.dotnet`, then `PATH` for an SDK.
- `uv` for synthetic DXF fixtures. It supplies Python 3.13 and ezdxf for the generator.
- Network access on first setup for npm, NuGet, and Python dependencies.

Tool installation references: [Node.js](https://nodejs.org/en/download),
[.NET 8](https://dotnet.microsoft.com/en-us/download/dotnet/8.0), and
[uv](https://docs.astral.sh/uv/getting-started/installation/).

Source setup is verified on Linux x64. Windows and macOS are not yet verified.
Chromium is optional for viewer automation. `rsvg-convert` or ImageMagick is
optional for PNG export; SVG export needs neither.

## Build and verify

After cloning or receiving the repository, enter its actual checkout directory:

```sh
cd /path/to/omakase-cadkit
npm ci
npm run setup
```

`setup` builds the sidecar and viewer, generates synthetic drawings, typechecks,
and runs tests. It stops on failure and does not install system tools, change
shell configuration, or start a background server. Re-running it is supported.

The same steps can be run separately:

```sh
cd /path/to/omakase-cadkit
npm run build
npm run fixtures
npm run typecheck
npm test
```

The private drawing regression is optional and skips on a normal checkout. To run
that exact known case, set `OMAKASE_CADKIT_PRIVATE_DWG` to your authorized local
DWG with its matching project profile. Do not use an arbitrary DWG: the regression
asserts known handles and findings. Public fixtures cover the default test path.

## First useful result

```sh
cd /path/to/omakase-cadkit
node bin/omakase-cadkit.mjs inspect fixtures/sewer_clean.dxf
node bin/omakase-cadkit.mjs lint fixtures/sewer_clean.dxf
node bin/omakase-cadkit.mjs lint fixtures/sewer_bad.dxf
node bin/omakase-cadkit.mjs render fixtures/sewer_bad.dxf --finding 1 --out review.svg
node bin/omakase-cadkit.mjs view fixtures/sewer_bad.dxf
```

Expect the clean drawing's lint to exit **0**, and the bad drawing's lint to exit
**1** with planted findings. Exit **2** means a command failed. Run these separately
so the expected exit 1 does not prevent the remaining commands. `view` prints a
loopback URL, starts a background server if needed, and opens the URL in your browser
when run from a terminal (`--no-open` to skip; piped output never opens one). If the
running server came from an older build, `view` replaces it. Paths may start with `~`,
even inside quotes, which you need for folder names with spaces or `&`.
For an explicitly owned foreground server, run `node bin/omakase-cadkit.mjs serve`
instead and stop it with Ctrl+C. Use `view ... --port 4281` if another service owns
4280. To use the short command, optionally run `npm link` from the checkout; the
direct Node commands above need no global installation.

For automated viewer checks, start a server, then use the printed drawing URL:

```sh
cd /path/to/omakase-cadkit
node scripts/shot.mjs 'http://127.0.0.1:4280/?file=/absolute/path/to/fixtures/sewer_bad.dxf' viewer.png 1500 900 --check
```

## Troubleshooting and configuration

| Symptom | Next check |
|---|---|
| No SDK found | Install the SDK, inspect `dotnet --list-sdks`, or set `DOTNET_ROOT` to its installation directory. `~/.dotnet` is detected automatically. |
| Sidecar cannot start | Verify the .NET 8 runtime is installed; rebuild with `npm run build:sidecar`. An alternate build directory can be set with `OMAKASE_CADKIT_SIDECAR_DIR`. |
| Missing drawings in tests | Run `npm run fixtures`; generation needs `uv` and network access the first time. |
| Viewer looks unchanged | Run `npm run build:viewer`, then refresh. After `npm run build:lib` or a sidecar build, the next `view` restarts the server itself. |
| `no file at …/~/…` | You are on a build from before `~` expansion; run `npm run build:lib`, or write the path without quotes around the `~` part. |
| Old payload after sidecar changes | Stop your viewer, clear the payload cache, rebuild, and restart. Cache keys currently exclude the sidecar version. |
| PNG conversion fails | Write SVG instead, or install `rsvg-convert` or ImageMagick. |

Payloads and recent-file history use `~/.cache/omakase-cadkit` (or the XDG cache
directory). Override with `OMAKASE_CADKIT_CACHE`. Cached payloads contain drawing
data; keep them local. CLI `view` uses `OMAKASE_CADKIT_PORT` or `--port`.
Project settings come from the nearest `omakase-cadkit.json`; old `drawkit.json`
profiles and `DRAWKIT_*` environment names remain compatibility fallbacks.

Agents: read [AGENTS.md](../AGENTS.md), follow this setup, and report the commands,
results, and any skipped optional checks. Do not invent a public repository URL,
engineering limits, or support for an untested platform. For drawing review, use
the bundled [drawing skill](../skills/omakase-cadkit/SKILL.md).
