#!/bin/sh
set -eu

cargo fmt --check
cargo clippy --offline --workspace --all-targets -- -D warnings
cargo test --offline --workspace
python3 -B -m unittest discover -s scripts/tests
npm run frontend:check
