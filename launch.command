#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
if [[ ! -f .tools/node-path.txt ]]; then echo 'Run Setup first.' >&2; exit 1; fi
IFS= read -r node_bin < .tools/node-path.txt
if [[ ! -x "$node_bin" ]]; then echo 'The Node installation moved. Run Setup again.' >&2; exit 1; fi
exec "$node_bin" scripts/launch.mjs "$@"
