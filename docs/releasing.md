# Releasing ccht

Keep `Cargo.toml`, `Cargo.lock`, `web/package.json`, `web/jsr.json`,
`py/pyproject.toml` and `py/Cargo.toml` versions consistent. Published contents
are immutable: use a new version for corrections.

A release is the Forgejo release flow of ccid (`.ci/ccid.toml`, `[release]`): the
version comes from `Cargo.toml`, one dispatch of the `release` workflow on `main`
makes every package once, and a green run publishes the draft as `v<version>`. The
registries and every copy carry those same bytes.

| Package | Built by | File in the release |
| --- | --- | --- |
| crate | `.ci/check_package.py` | `ccht-<version>.crate` |
| npm (custom Wasm build) | `.ci/check_web.py` | `corbet-labs-ccht-<version>.tgz` |
| PyPI (native wheel and sdist) | `.ci/check_python.py` | the `.whl` and `.tar.gz` |

`.ci/release-build.py` runs those scripts and leaves their packages and receipts
flat in the release directory. A native wheel is not a `kind = "pack"` package, which
is why the build is a `commands` check.

## The Python binding waits for the crate

The binding (`py/`) resolves the `ccht` crate from crates.io, and `py/Cargo.lock`
pins that crate's registry checksum. `release-build.py` builds the wheel only when
`py/Cargo.lock` already names the released version with a registry checksum;
otherwise the release carries the crate and the npm package alone and says so in its
log. The JSR package is not built (it is generated from the published npm archive
and is not published from our side).
