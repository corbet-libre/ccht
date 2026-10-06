#!/usr/bin/env bash
set -euo pipefail
exec 2>&1
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}"
export CARGO_TERM_COLOR="${CARGO_TERM_COLOR:-always}"
export RUST_TEST_THREADS="${RUST_TEST_THREADS:-2}"
export RUSTUP_TOOLCHAIN="${RUSTUP_TOOLCHAIN:-stable}"
export UV_PYTHON="${UV_PYTHON:-python3}"
export UV_PYTHON_DOWNLOADS="${UV_PYTHON_DOWNLOADS:-never}"
: "${CI_COMMIT_SHA:?verify requires the exact source revision}"
: "${ARTIFACT_ROOT:?verify requires an absolute ARTIFACT_ROOT}"
[[ "$ARTIFACT_ROOT" = /* ]] || { echo "ARTIFACT_ROOT must be absolute" >&2; exit 2; }
# Hosted route mirror: .github/workflows/ci.yml case branches for rust/core plus
# every standalone .ci/ packaging/registry/adapter gate (release excluded: dedicated route).
cargo fetch --locked
cargo fmt --all -- --check
cargo test --locked --all-features
cargo clippy --all-targets --all-features --locked -- -D warnings
cargo test --locked --no-default-features
cargo check --locked --no-default-features --features web --target wasm32-unknown-unknown
python3 .ci/check_package.py
python3 .ci/check_web.py
python3 .ci/check_jsr.py
python3 .ci/check_python.py
python3 .ci/check_python.py --resolve-only
python3 .ci/release-check.py
