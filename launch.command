#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
if [[ ! -f .tools/node-path.txt ]]; then echo 'Run Setup first.' >&2; exit 1; fi
# read fails on a file with no trailing newline; the value is still usable.
IFS= read -r node_bin < .tools/node-path.txt || true
if [[ ! -x "$node_bin" ]]; then echo "The app's Node is missing: re-extract the download, or run Setup in a source checkout." >&2; exit 1; fi
exec "$node_bin" scripts/launch.mjs "$@"
