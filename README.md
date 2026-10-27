# omakase-cadkit

View, check and lint AutoCAD drawings (DWG and DXF) for civil infrastructure: sewer
networks, layouts, sections and detail sheets.

- **People** get a viewer that opens a drawing and lists what is wrong with it.
- **Agents** get a command line that answers in text, with entity handles the
  viewer can jump to.

It is an alpha. It reads drawings; it never edits them.

## Install

Get the download for your computer from the
[Releases page](https://github.com/itama8/omakase-cadkit/releases). Everything the app
needs is inside: you do not install Node, .NET or anything else.

| Computer | Download | Then |
|---|---|---|
| Windows | `…-win32-x64-setup.exe` | Run it. Start **omakase-cadkit** from the Start menu. |
| Mac (Apple Silicon or Intel) | `…-darwin-arm64.zip` or `…-darwin-x64.zip` | Unzip, double-click `launch.command`. |
| Linux x64 | `…-linux-x64.zip` | Unzip, run `bash launch.command`. |

The app opens in your browser at `http://127.0.0.1:4280/`. It runs only on your
computer; drawings are never uploaded.

**Windows:** the installer is unsigned, so Windows may say "Windows protected your
PC". Choose **More info**, then **Run anyway**. It needs no administrator rights, adds
**Open with › omakase-cadkit** for `.dwg` and `.dxf` files, and uninstalls from
Settings › Apps.

**Mac:** if macOS refuses to open `launch.command`, right-click it and choose **Open**.

`v0.1.0-alpha.1` predates the Windows installer. On that release, Windows users unzip
`…-win32-x64.zip` and double-click `launch.cmd`.

## Updates

Downloads check GitHub for a newer published version when the viewer opens and then
hourly. On Windows, click **Install and restart** to download the installer, verify
its SHA-256 and replace the installed app. The viewer reloads when it restarts.
Mac, Linux and portable Windows downloads show a link to the release instead.
**Not now** hides that version.

Version `0.1.0-alpha.3.1` is the first with this feature and must be installed manually;
older downloads cannot acquire the updater by themselves. Source checkouts do not check for updates.
Set `OMAKASE_CADKIT_UPDATE_CHECK=0` before launching to disable checks. Update checks
contact GitHub; drawings stay on your computer.

## Open a drawing

Click the drawing in the middle of the empty screen and pick a DWG or DXF file. Or
click the folder icon to choose a folder, then click a drawing in the list.

Findings appear on the right. Click one to zoom to it and see how to fix it in
AutoCAD. Press `F` to fit the sheet, `J`/`K` to step through findings and `/` to
search text.

The [user guide](docs/guide.md) covers the viewer, the command line, project
settings, the rules and what is not drawn yet.

## Report a problem

Open an [issue](https://github.com/itama8/omakase-cadkit/issues). Say which computer
you used, what you did, and what happened. If a drawing was slow, hover **Opened in …**
in the status bar and copy the timings. Do not attach private drawings.

## For developers and agents

- [Developer setup](docs/setup.md): build and test from a source checkout.
- [Contributing](CONTRIBUTING.md): how to make, check and hand off a change.
- [AGENTS.md](AGENTS.md): rules for coding agents working on this repository.
- [Drawing skill](skills/omakase-cadkit/SKILL.md): for an agent reviewing drawings with
  the tool.
- [Outcomes](docs/outcomes.md): what is being worked on now.

## License

[AGPL-3.0-only](LICENSE). Dependencies keep their own licenses; see
[third-party notices](THIRD_PARTY_NOTICES.md). The `v0.1.0-alpha.1` release stays
under MIT.
