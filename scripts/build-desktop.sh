#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPOSITORY_ROOT=$(dirname -- "$SCRIPT_DIR")
STALE_APP_BUNDLE="$REPOSITORY_ROOT/target/release/bundle/macos/Karazhan.app"

if [ -d "$STALE_APP_BUNDLE" ]; then
  rm -rf -- "$STALE_APP_BUNDLE"
fi

cd "$REPOSITORY_ROOT"
npm --workspace @karazhan/desktop run tauri -- build --no-bundle
