# Third-party notices

omakase-cadkit is MIT licensed. Dependencies retain their own licenses and copyrights.

## ACadSharp 3.8.0

The .NET sidecar reads and writes DWG/DXF through
[ACadSharp](https://github.com/DomCR/ACadSharp), licensed under MIT.
The upstream license is preserved in [licenses/ACadSharp-MIT.txt](licenses/ACadSharp-MIT.txt).

Provenance: the NuGet 3.8.0 package identifies source commit
`3a1c66b9932f9e2dbfbbf3f03660c97d52e49b02`. Its metadata lists
Copyright (c) 2026 Albert Domenech; the license file at that commit lists
Copyright (c) 2021 Albert Domenech. The upstream text is retained unchanged.

## Toolchains and future distributions

Node.js, .NET, uv, Python, ezdxf, TypeScript, esbuild, and optional renderers are
separate tools or development dependencies. This repository does not relicense
them. Their installed packages carry their notices. Any future binary or npm
release must inventory what it actually bundles and include the corresponding
licenses; this source-checkout notice is not a completed distribution audit.
