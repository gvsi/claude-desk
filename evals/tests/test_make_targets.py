"""The tier 1 make targets: the kernel and API runs get the release desk-prove `make kernel` builds
as DESK_PROVE, unless DESK_PROVE is already set or there is no such build."""

import os
import subprocess
from pathlib import Path

import pytest

MAKEFILE = Path(__file__).resolve().parents[2] / "Makefile"
TARGETS = ["evals-tier1-kernel", "evals-tier1-api"]
# What an outer make (`make evals-unit`) or the shell could hand the make under test.
OUTSIDE = {"DESK_PROVE", "MAKEFLAGS", "MFLAGS", "MAKELEVEL", "MAKEOVERRIDES"}


def planned(target: str, checkout: Path, *variables: str, environment: dict[str, str] | None = None) -> str:
    """What `make <target>` would run (`make -n`), as if the Makefile were in `checkout`."""
    env = {name: value for name, value in os.environ.items() if name not in OUTSIDE}
    result = subprocess.run(
        ["make", "--no-print-directory", "-n", "-C", str(checkout), "-f", str(MAKEFILE), target, *variables],
        env={**env, **(environment or {})}, capture_output=True, text=True, check=True,
    )
    return result.stdout.strip()


def built_prover(checkout: Path) -> Path:
    prover = checkout / "kernel" / "target" / "release" / "desk-prove"
    prover.parent.mkdir(parents=True)
    prover.write_text("#!/bin/sh\n")
    prover.chmod(0o755)
    return prover


@pytest.mark.parametrize("target", TARGETS)
def test_the_release_prover_is_passed_when_desk_prove_is_unset(tmp_path: Path, target: str):
    checkout = tmp_path.resolve()   # make's CURDIR is the resolved path
    prover = built_prover(checkout)

    assert planned(target, checkout).startswith(f'DESK_PROVE="{prover}" ')


@pytest.mark.parametrize("target", TARGETS)
@pytest.mark.parametrize("case", ["no build", "set in the environment", "set on the command line"])
def test_desk_prove_is_left_alone_otherwise(tmp_path: Path, target: str, case: str):
    checkout = tmp_path.resolve()
    if case != "no build":
        built_prover(checkout)
    other = "/opt/prover/desk-prove"
    variables = (f"DESK_PROVE={other}",) if case == "set on the command line" else ()
    environment = {"DESK_PROVE": other} if case == "set in the environment" else {}

    assert "DESK_PROVE" not in planned(target, checkout, *variables, environment=environment)
