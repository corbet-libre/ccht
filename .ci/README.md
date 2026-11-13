# Focused validation and release preparation

The Forgejo verdict job runs `.ci/ccid.toml` through ccid.
The repository commands also work on a suitably provisioned build host.
The dispatcher stages the committed source and reports evidence; builds run only in CI.

Package selectors export under `<ARTIFACT_ROOT>/ccht/<commit>/`: the crate at the top,
`web/`, `jsr/` and `python/` below it, each with its receipt, `SOURCE_COMMIT`
and `SHA256SUMS`.

| Selector | Coverage |
| --- | --- |
| `rust` | Formatting, locked tests and Clippy with all features |
| `core` | Default-free tests and the Wasm feature check |
| `licenses` | Cargo dependency license inventory |
| `rust-package` | Crate archive, license notices and an independent consumer |
| `js-package` | npm Wasm package with corresponding source, offline rebuild and consumer |
| `jsr-package` | JSR package generated from the published npm archive pinned in `jsr-input.json` |
| `python-prepare` | Resolve `py/Cargo.lock` against the published crate |
| `python-package` | Native wheel and sdist with vendored source, offline rebuild and consumers |
| `jsr-registry`, `python-registry` | Consumers of the exact version on the live registry |

## Release

`.ci/release-build.py` is the release run's build check (`[release]` in `ccid.toml`); see
[releasing](../docs/releasing.md).
