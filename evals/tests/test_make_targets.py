"""The tier 1 make targets: the kernel and API runs get the release desk-prove `make kernel` builds
as DESK_PROVE and the cvc5 `make setup` unpacks to .tools/cvc5 as CVC5, each unless that variable is
already set or there is no such file."""

import os
import subprocess
from pathlib import Path

import pytest

MAKEFILE = Path(__file__).resolve().parents[2] / "Makefile"
TARGETS = ["evals-tier1-kernel", "evals-tier1-api"]
# What an outer make (`make evals-unit`) or the shell could hand the make under test.
OUTSIDE = {"DESK_PROVE", "CVC5", "MAKEFLAGS", "MFLAGS", "MAKELEVEL", "MAKEOVERRIDES"}


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


def unpacked_cvc5(checkout: Path, at: str = ".tools/cvc5/bin/cvc5") -> Path:
    cvc5 = checkout / at
    cvc5.parent.mkdir(parents=True)
    cvc5.write_text("#!/bin/sh\n")
    cvc5.chmod(0o755)
    return cvc5


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


@pytest.mark.parametrize("target", TARGETS)
@pytest.mark.parametrize("prover", ["no build", "the release build"])
def test_the_local_cvc5_is_passed_when_cvc5_is_unset(tmp_path: Path, target: str, prover: str):
    checkout = tmp_path.resolve()
    cvc5 = unpacked_cvc5(checkout)
    passed = f'DESK_PROVE="{built_prover(checkout)}" ' if prover == "the release build" else ""

    assert planned(target, checkout).startswith(f'{passed}CVC5="{cvc5}" ')


@pytest.mark.parametrize("target", TARGETS)
@pytest.mark.parametrize("case", ["no cvc5", "set in the environment", "set on the command line"])
def test_cvc5_is_left_alone_otherwise(tmp_path: Path, target: str, case: str):
    checkout = tmp_path.resolve()
    if case != "no cvc5":
        unpacked_cvc5(checkout)
    other = unpacked_cvc5(checkout, "elsewhere/cvc5")   # it exists, so only where CVC5 came from keeps it out
    variables = (f"CVC5={other}",) if case == "set on the command line" else ()
    environment = {"CVC5": str(other)} if case == "set in the environment" else {}

    assert "CVC5" not in planned(target, checkout, *variables, environment=environment)


# db-throwaway, CI's setting for a job's own Postgres: it turns off durable commits for the whole instance.
def throwaway(tmp_path: Path, ci: str | None) -> subprocess.CompletedProcess:
    """`make db-throwaway` in an empty checkout, with a stand-in psql that records its arguments."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    psql = bin_dir / "psql"
    psql.write_text(f'#!/bin/sh\nprintf "%s\\n" "$@" > "{tmp_path / "psql-args"}"\n')
    psql.chmod(0o755)
    env = {name: value for name, value in os.environ.items() if name not in OUTSIDE | {"CI"}}
    env["PATH"] = f"{bin_dir}{os.pathsep}{env['PATH']}"
    if ci is not None:
        env["CI"] = ci
    return subprocess.run(["make", "--no-print-directory", "-C", str(tmp_path), "-f", str(MAKEFILE), "db-throwaway"],
                          env=env, capture_output=True, text=True)


@pytest.mark.parametrize("ci", [None, "", "false", "0"])
def test_db_throwaway_refuses_to_run_outside_ci(tmp_path: Path, ci: str | None):
    """A developer's database is persistent and shared, so unless CI is true the target changes nothing."""
    result = throwaway(tmp_path, ci)
    assert result.returncode != 0
    assert "CI" in result.stderr
    assert not (tmp_path / "psql-args").exists()


def test_db_throwaway_turns_off_durable_commits_in_ci(tmp_path: Path):
    result = throwaway(tmp_path, "true")
    assert result.returncode == 0, result.stderr
    args = (tmp_path / "psql-args").read_text().splitlines()
    for setting in ("fsync", "synchronous_commit", "full_page_writes"):
        assert f"ALTER SYSTEM SET {setting} = off" in args
    assert "SELECT pg_reload_conf()" in args


def test_waiver_review_target_is_local_and_names_its_pass(tmp_path):
    command = planned("evals-waiver-review", tmp_path, "PASS=fixture-pass")
    assert "python -m evals.run waiver-review --pass fixture-pass" in command
