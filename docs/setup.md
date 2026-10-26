# Developer setup

This is for working on the code. To use the app, install a download instead (see the
[README](../README.md#install)).

## 1. Get the tools

You need Node 24+, the .NET 8 SDK and `uv`. Setup installs whatever is missing into
`.tools/` inside the checkout. It does not need administrator rights or change your
PATH.

| Computer | Run once |
|---|---|
| Windows | Double-click `setup.cmd` |
| Mac or Linux | `bash setup.command` |

Setup downloads a few hundred MB the first time. It then builds the app, generates
test drawings, typechecks and runs the tests. If a step fails it says which one; fix
it and run Setup again. `--check` (`-Check` on Windows) only reports what is missing;
`--local-tools` (`-LocalTools`) ignores tools already installed on the system.

If you already have the tools, the same thing is:

```sh
npm ci
npm run setup
```

## 2. Run it

```sh
node bin/omakase-cadkit.mjs view fixtures/sewer_bad.dxf    # or double-click launch.cmd / launch.command
node bin/omakase-cadkit.mjs lint fixtures/sewer_bad.dxf    # exits 1: it has planted defects
node bin/omakase-cadkit.mjs lint fixtures/sewer_clean.dxf  # exits 0
```

`npm link` makes the short `omakase-cadkit` command available everywhere.

## 3. Rebuild after a change

| You changed | Run |
|---|---|
| `src/` | `npm run build:lib` (the CLI runs the compiled `dist/`) |
| `viewer/` | `npm run build:viewer`, then refresh the browser |
| `sidecar/*.cs` | `npm run build:sidecar` |
| Anything, before you finish | `npm run typecheck && npm test` |

The next `view` restarts a viewer started from an older build by itself.
`npm run build` rebuilds all three.

## 4. Check the viewer

Screenshot the viewer and run its interaction checks in headless Chromium:

```sh
node scripts/shot.mjs 'http://127.0.0.1:4280/?file=/absolute/path/to/fixtures/sewer_bad.dxf' out.png 1500 900 --check
```

## 5. Build the downloads

`npm run bundle` builds the download for the computer you run it on into
`dist-bundle/`. On Windows that is the installer (needs
[Inno Setup 6](https://jrsoftware.org/isinfo.php)); elsewhere it is a ZIP.
`node scripts/check-bundle.mjs` launches the result with nothing installed. CI builds
and checks all four platforms on every push. Pushing a `v*` tag attaches them to a
release.

## Troubleshooting

| Problem | Fix |
|---|---|
| "No SDK found" | Install the .NET 8 SDK or set `DOTNET_ROOT`. A runtime-only install cannot build. |
| Tests miss drawings | `npm run fixtures` (needs `uv` and internet the first time). |
| Viewer shows old code | Rebuild as above and refresh. |
| PNG export fails | Export SVG, or install `rsvg-convert` or ImageMagick. |

The optional `OMAKASE_CADKIT_PRIVATE_DWG` test runs one known private drawing; it is
skipped otherwise. Do not point it at another file: it checks exact handles.
