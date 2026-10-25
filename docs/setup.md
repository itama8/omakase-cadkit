# Set up a source checkout

This route is for a person or an agent setting up the CLI and viewer from source.
An installable npm library is a [later outcome](outcomes.md); do not use
`npm install omakase-cadkit` as a substitute for these steps yet.

## Automatic setup

Download the repository ZIP and extract it into a writable folder (or clone it).
Keep that folder: it contains the app, its tools and the launchers.

| Platform | Setup once | Launch afterward |
|---|---|---|
| Windows x64 / ARM64 | Double-click `setup.cmd` | Double-click `launch.cmd` |
| macOS Intel / Apple Silicon | Run `bash setup.command` from Terminal in the extracted folder | Double-click `launch.command` |
| Linux x64 / ARM64 | Run `bash setup.command` | Run `bash launch.command` |

On macOS, cloned executable scripts can also be double-clicked. ZIP extraction may
remove executable permissions; run `chmod +x setup.command launch.command` once
if Finder will not open them. macOS security policy or managed-machine restrictions
may also require the organization's normal approval for downloaded scripts.

Setup checks Node 24+, the .NET 8 SDK **and runtime**, and uv. Missing tools are
downloaded from Node.js, Microsoft and Astral into `.tools/` beside the app. The
Node archive is checked against Node.js's SHA-256 manifest before extraction.
It then runs `npm ci` and `npm run setup`, including builds, synthetic fixtures,
typechecking and tests. uv downloads Python 3.13 for fixture generation as needed.
Internet access is required; the first setup downloads several hundred MB.

Existing suitable tools are reused. Setup does not request administrator access or
edit shell profiles or the system PATH. The launcher remembers the tool paths
in `.tools/environment.json`, opens the empty viewer, and reuses a running server.
Move the folder or remove a reused system dependency? Run Setup again.
A failed setup prints the failed step and can be rerun.

To check without installing, run `bash setup.command --check`, or
`./scripts/bootstrap.ps1 -Check` in Windows PowerShell. To install private copies
of all tools regardless of system installations, use `--local-tools` or `-LocalTools`.

CI runs Setup and then opens a synthetic drawing through Launch on Ubuntu 24.04,
macOS 14 (Apple Silicon), macOS 15 (Intel) and Windows Server 2022 on every push;
see the [workflow](../.github/workflows/ci.yml). Those four runs are the platform
evidence. Windows ARM64 and Linux ARM64 pass the platform checks in the bootstrap
but no run covers them. Linux still needs the OS libraries required by Node/.NET,
plus Bash, curl, tar and a SHA-256 utility; this installer does not modify the
operating system.

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
After `npm link`, just run `omakase-cadkit` from any folder to launch the app with
no drawing loaded. Without linking, run `node bin/omakase-cadkit.mjs` from this checkout.
`view` also accepts no file. Both reuse the background server and open a fresh root URL;
recent drawings remain available without being loaded automatically. `--help` shows CLI help.

For an explicitly owned foreground server, run `node bin/omakase-cadkit.mjs serve`
instead and stop it with Ctrl+C. Use `view ... --port 4281` if another service owns
4280. To use the short command, optionally run `npm link` from the checkout; the
direct Node commands above need no global installation.

For automated viewer checks, start a server, then use the printed drawing URL:

```sh
cd /path/to/omakase-cadkit
node scripts/shot.mjs 'http://127.0.0.1:4280/?file=/absolute/path/to/fixtures/sewer_bad.dxf' viewer.png 1500 900 --check
```

## Trying an alpha

An alpha is a source ZIP plus Setup, not an installable package. There is no
`npm install omakase-cadkit` yet, no auto-update, and no installer for a system
package manager. Keep the extracted folder; launching from it is the whole
installation.

What to try, in order: launch with no drawing, open a project drawing, run `lint`
on it, click a finding, and use **Copy AutoCAD selection**. Then compare a few
labels and title blocks against the issued PDF or plot. Text size, wrapped MTEXT
and the sans/serif faces now follow AutoCAD, but hatch textures, linetypes and the
contents of embedded OLE tables are not drawn.

Known limits: model space only (layouts are listed, not drawn), and MULTILEADER,
REGION, 3D solids and OLE contents are counted as unrendered. A DWG written by
`convert` has been read back by ACadSharp and LibreDWG, not opened in AutoCAD
itself. Report a problem as a GitHub issue with the operating system and
architecture, the commands you ran, the exit code, and which step above failed.
Attach the synthetic fixtures from `fixtures/` when they reproduce it, and keep
private drawings and `~/.cache/omakase-cadkit` local.

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
