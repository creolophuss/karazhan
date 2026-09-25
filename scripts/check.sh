#!/bin/sh
set -eu

cargo fmt --check
cargo clippy --offline --workspace --all-targets -- -D warnings
cargo test --offline --workspace
npm run frontend:check
