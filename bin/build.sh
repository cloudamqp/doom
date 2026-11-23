#!/usr/bin/env bash
# Builds DooMQ into web/: Doom compiled to WebAssembly and the Freedoom IWAD.
#
# Installs what is missing: build tools with apt-get, and Emscripten with
# emsdk in $EMSDK (default ~/emsdk) unless emcc is already on PATH, as in
# the emscripten/emsdk image. The Dockerfile builds with this script too.
set -euo pipefail

EMSCRIPTEN_VERSION=7.0.0
FREEDOOM_VERSION=0.13.0
FREEDOOM_SHA256=3f9b264f3e3ce503b4fb7f6bdcb1f419d93c7b546f4df3e874dd878db9688f59

cd "$(dirname "$0")/.."

install_tools() {
  local tool missing=()
  for tool in "$@"; do
    command -v "$tool" >/dev/null || missing+=("$tool")
  done
  [ ${#missing[@]} -eq 0 ] && return
  if ! command -v apt-get >/dev/null; then
    echo "Install ${missing[*]} and run again" >&2
    exit 1
  fi
  local sudo=""
  [ "$(id -u)" -eq 0 ] || sudo=sudo
  $sudo apt-get update -q
  $sudo apt-get install -qy --no-install-recommends ca-certificates curl git make python3 unzip xz-utils
}

if command -v emcc >/dev/null; then
  install_tools curl make unzip
else
  install_tools curl git make python3 unzip xz
  EMSDK=${EMSDK:-$HOME/emsdk}
  [ -d "$EMSDK" ] || git clone --depth 1 https://github.com/emscripten-core/emsdk "$EMSDK"
  "$EMSDK/emsdk" install "$EMSCRIPTEN_VERSION"
  "$EMSDK/emsdk" activate "$EMSCRIPTEN_VERSION" >/dev/null
  set +u # emsdk_env.sh reads unset variables
  # shellcheck source=/dev/null
  source "$EMSDK/emsdk_env.sh" 2>/dev/null
  set -u
fi

mkdir -p web

if [ ! -f web/freedoom1.wad ]; then
  zip=$(mktemp)
  trap 'rm -f "$zip"' EXIT
  curl -fsSL -o "$zip" "https://github.com/freedoom/freedoom/releases/download/v$FREEDOOM_VERSION/freedoom-$FREEDOOM_VERSION.zip"
  echo "$FREEDOOM_SHA256  $zip" | sha256sum -c --quiet
  unzip -qjo "$zip" "*/freedoom1.wad" -d web
fi

make -C doom -j"$(nproc)"
cp doom/build/doom.js doom/build/doom.wasm web/
# The page shows download progress with these, servers may compress the files
(cd web && stat -c '"%n": %s' doom.js doom.wasm freedoom1.wad | paste -sd, | sed 's/.*/{&}/') > web/files.json

echo "Built into web/ with $(emcc --version | head -1)"
