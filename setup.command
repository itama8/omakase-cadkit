#!/usr/bin/env bash
# macOS: double-click; Linux/macOS terminal: bash setup.command
set -euo pipefail
cd -- "$(dirname -- "$0")"
root="$PWD"
if [[ "${1:-}" == "--help" ]]; then
  echo 'Usage: bash setup.command [--check] [--local-tools]'
  echo 'Installs missing tools locally, builds and verifies the app. Then use launch.command.'
  exit 0
fi
node_ok() { "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' >/dev/null 2>&1; }
node_bin="$root/.tools/node/bin/node"
if ! node_ok "$node_bin" || [[ ! -f "$root/.tools/node/lib/node_modules/npm/bin/npm-cli.js" ]]; then
  node_bin="$(command -v node || true)"
  if [[ " $* " == *" --local-tools "* ]] || [[ -z "$node_bin" ]] || ! node_ok "$node_bin" || ! command -v npm >/dev/null; then
    if [[ " $* " == *" --check "* ]]; then echo 'Node 24+ and npm are missing. Run setup.command without --check.' >&2; exit 1; fi
    case "$(uname -s)" in Darwin) platform=darwin ;; Linux) platform=linux ;; *) echo 'This script supports macOS and Linux.' >&2; exit 1 ;; esac
    case "$(uname -m)" in x86_64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) echo 'Supported architectures: x64, arm64.' >&2; exit 1 ;; esac
    command -v curl >/dev/null || { echo 'Install curl and retry.' >&2; exit 1; }
    command -v tar >/dev/null || { echo 'Install tar and retry.' >&2; exit 1; }
    mkdir -p .tools
    temp="$(mktemp -d "$root/.tools/node-download.XXXXXX")"
    trap 'rm -rf -- "$temp"' EXIT
    base=https://nodejs.org/dist/latest-v24.x
    echo 'Downloading Node 24 LTS from nodejs.org…'
    curl --fail --location --retry 3 "$base/SHASUMS256.txt" -o "$temp/SHASUMS256.txt"
    entry="$(awk -v suffix="-$platform-$arch.tar.gz" '$2 ~ (suffix "$") {print; exit}' "$temp/SHASUMS256.txt")"
    [[ -n "$entry" ]] || { echo 'No matching Node download.' >&2; exit 1; }
    checksum="${entry%% *}"
    archive="${entry##* }"
    [[ "$archive" =~ ^node-v24\.[0-9]+\.[0-9]+-(darwin|linux)-(x64|arm64)\.tar\.gz$ ]] || exit 1
    curl --fail --location --retry 3 "$base/$archive" -o "$temp/$archive"
    if command -v shasum >/dev/null; then actual="$(shasum -a 256 "$temp/$archive")"
    elif command -v sha256sum >/dev/null; then actual="$(sha256sum "$temp/$archive")"
    else echo 'Install shasum or sha256sum and retry.' >&2; exit 1; fi
    [[ "${actual%% *}" == "$checksum" ]] || { echo 'Node checksum mismatch.' >&2; exit 1; }
    mkdir "$temp/unpacked"
    tar -xzf "$temp/$archive" -C "$temp/unpacked" --strip-components=1
    node_ok "$temp/unpacked/bin/node" || { echo 'Downloaded Node cannot run on this OS.' >&2; exit 1; }
    rm -rf -- "$root/.tools/node"
    mv "$temp/unpacked" "$root/.tools/node"
    node_bin="$root/.tools/node/bin/node"
    rm -rf -- "$temp"
    trap - EXIT
  fi
fi
export PATH="$(dirname -- "$node_bin"):$PATH"
exec "$node_bin" "$root/scripts/bootstrap.mjs" "$@"
