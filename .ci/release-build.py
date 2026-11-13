#!/usr/bin/env python3
"""The files of a ccht release, made by the release run (`ccid release build`).

Runs the repository's own package checks (the crate, the Wasm npm package, the Python
native wheel and sdist) and leaves their packages and receipts flat in $CCID_RELEASE_DIR.
The packages are made once here; the registries and every copy carry these bytes.
JSR is not built (it is generated from the published npm archive and is not published
from our side).
"""
import hashlib
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import tomllib

ROOT = Path(__file__).resolve().parent.parent
PACKAGES = (".crate", ".tgz", ".whl", ".tar.gz")


def git(*args):
    return subprocess.check_output(["git", "-C", str(ROOT), *args])


def python_lock_ready(version):
    """The binding resolves the ccht crate from crates.io: it can be built only when
    py/Cargo.lock already names this version with a registry checksum."""
    lock = tomllib.loads((ROOT / "py/Cargo.lock").read_text())
    return any(p["name"] == "ccht" and p["version"] == version and p.get("checksum")
               for p in lock.get("package", []))


def main():
    release = Path(os.environ["CCID_RELEASE_DIR"])
    version = os.environ["CCID_RELEASE_VERSION"]
    commit = os.environ.get("CCID_RELEASE_COMMIT") or git("rev-parse", "HEAD").decode().strip()
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise SystemExit("release-build needs the exact commit")
    env = dict(os.environ)
    env["CI_COMMIT_SHA"] = commit
    env.setdefault("SOURCE_SHA256", hashlib.sha256(git("archive", "--format=tar", commit)).hexdigest())
    steps = [("rust-package", "check_package.py", ""), ("js-package", "check_web.py", "web")]
    if python_lock_ready(version):
        steps.append(("python-package", "check_python.py", "python"))
    else:
        print(f"python: py/Cargo.lock does not name ccht {version} from the registry; "
              "no wheel is built (the crate must be on crates.io first)", file=sys.stderr)
    with tempfile.TemporaryDirectory(prefix="ccht-release-") as scratch:
        env["ARTIFACT_ROOT"] = scratch
        for check, script, subdirectory in steps:
            subprocess.run([sys.executable, str(ROOT / ".ci" / script)], cwd=ROOT, env=env, check=True)
            directory = Path(scratch) / "ccht" / commit / subdirectory
            for path in sorted(directory.iterdir()):
                if path.name.endswith(PACKAGES):
                    shutil.copy2(path, release / path.name)
                elif path.name.endswith(".json"):
                    shutil.copy2(path, release / f"{check}-{path.name}")
    if not any(p.name.endswith(".crate") for p in release.iterdir()):
        raise SystemExit("the release run produced no crate")


main()
