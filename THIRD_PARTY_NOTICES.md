# Third-party notices

omakase-cadkit is licensed under AGPL-3.0-only; see [LICENSE](LICENSE). Dependencies retain their own licenses and copyrights.

## ACadSharp 3.8.0

The .NET sidecar reads and writes DWG/DXF through
[ACadSharp](https://github.com/DomCR/ACadSharp), licensed under MIT.
The upstream license is preserved in [licenses/ACadSharp-MIT.txt](licenses/ACadSharp-MIT.txt).

Provenance: the NuGet 3.8.0 package identifies source commit
`3a1c66b9932f9e2dbfbbf3f03660c97d52e49b02`. Its metadata lists
Copyright (c) 2026 Albert Domenech; the license file at that commit lists
Copyright (c) 2021 Albert Domenech. The upstream text is retained unchanged.

## IBM Plex Sans and IBM Plex Mono

The viewer bundles latin subsets of the IBM Plex typefaces as WOFF2 under
`viewer/fonts/`, from `@fontsource-variable/ibm-plex-sans` 5.3.0 and
`@fontsource/ibm-plex-mono` 5.2.5. Copyright © 2017 IBM Corp. with Reserved Font
Name "Plex", licensed under SIL OFL 1.1. The upstream license is preserved in
[licenses/IBMPlex-OFL.txt](licenses/IBMPlex-OFL.txt). No font file has been
modified; only the latin subset files are redistributed.

## Arimo and Tinos

Drawing text uses the unmodified Latin WOFF2 subsets of Arimo and Tinos from
`@fontsource/arimo` and `@fontsource/tinos` 5.3.0 (regular, bold, italic and bold italic).
Both are licensed under SIL OFL 1.1; their upstream license texts are preserved in
[licenses/Arimo-OFL.txt](licenses/Arimo-OFL.txt) and
[licenses/Tinos-OFL.txt](licenses/Tinos-OFL.txt).

## Toolchains and future distributions

Node.js, .NET, uv, Python, ezdxf, TypeScript, esbuild, and optional renderers are
separate tools or development dependencies. This repository does not relicense
them. Their installed packages carry their notices. Any future binary or npm
release must inventory what it actually bundles and include the corresponding
licenses; this source-checkout notice is not a completed distribution audit.
