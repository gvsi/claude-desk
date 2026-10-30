"""`make kernel-contract` runs the real-kernel variants for exactly the kernel plans that have landed, against a
kernel started with the kernel's own development test hooks."""

import os
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from tests.kernel_contract import real_kernel
from tests.kernel_contract.real_kernel import landed_kernel_plans

HOOKS = ("DESK_DECISIONS", "DESK_PROVE")


def hooks(env) -> dict[str, str | None]:
    """The hooks an environment sets. Tests keep only these, since a whole environment printed in a failure's
    explanation could show a secret."""
    return {hook: env.get(hook) for hook in HOOKS}


def test_landed_kernel_plans(tmp_path: Path):
    landed = tmp_path / "landed.toml"
    assert landed_kernel_plans(landed) == []                   # no file yet: nothing has landed
    landed.write_text('plans = ["master"]\n')
    assert landed_kernel_plans(landed) == []
    landed.write_text('plans = ["master", "01a", "02a", "01b", "01c-setup"]\n')
    assert landed_kernel_plans(landed) == ["01a", "01b", "01c-setup"]
    landed.write_text('plans = "01a"\n')
    with pytest.raises(ValueError):
        landed_kernel_plans(landed)


@pytest.fixture
def runner(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> SimpleNamespace:
    """`main()` in development with every outside effect replaced: one landed kernel plan, no kernel answering
    until the runner starts one, a `Popen` and `run` that record the hooks in the environments they were given,
    and nothing to stop."""
    seen = SimpleNamespace(kernel=None, pytest=None, started=False,
                           prover=tmp_path / "kernel" / "target" / "release" / "desk-prove")
    for name in ("DESK_ENV", *HOOKS):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(real_kernel, "PROVER", seen.prover)
    monkeypatch.setattr(real_kernel, "landed_kernel_plans", lambda: ["01a"])
    monkeypatch.setattr(real_kernel, "_health", lambda: {"proof_mode": "symcc"} if seen.started else None)
    monkeypatch.setattr(real_kernel, "_stop", lambda kernel: None)

    class Kernel:
        pid = 0

        def __init__(self, args: list[str], **kwargs):
            seen.kernel, seen.started = hooks(kwargs["env"]), True

        def poll(self) -> None:
            return None

    def run(args: list[str], **kwargs) -> subprocess.CompletedProcess:
        seen.pytest = hooks(kwargs["env"])
        return subprocess.CompletedProcess(args, 0)

    monkeypatch.setattr(real_kernel.subprocess, "Popen", Kernel)
    monkeypatch.setattr(real_kernel.subprocess, "run", run)
    return seen


def test_the_kernel_runs_with_its_development_hooks(runner: SimpleNamespace, capsys: pytest.CaptureFixture):
    runner.prover.parent.mkdir(parents=True)
    runner.prover.write_text("")                                # the release build of desk-prove exists
    assert real_kernel.main() == 0
    # the offline reviewer and soft-promise check, and the release prover; only in the kernel's environment
    assert runner.kernel == {"DESK_DECISIONS": "offline", "DESK_PROVE": str(runner.prover)}
    runners_own = hooks(os.environ)
    assert runners_own == runner.pytest == {"DESK_DECISIONS": None, "DESK_PROVE": None}
    assert "proof mode symcc" in capsys.readouterr().out


def test_without_the_release_prover_desk_prove_is_unset(runner: SimpleNamespace, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("DESK_PROVE", "/somewhere/else/desk-prove")   # a shell's own hook isn't passed on
    assert real_kernel.main() == 0
    assert runner.kernel == {"DESK_DECISIONS": "offline", "DESK_PROVE": None}   # the kernel looks on PATH
    runners_own = hooks(os.environ)
    assert runners_own == {"DESK_DECISIONS": None, "DESK_PROVE": "/somewhere/else/desk-prove"}


def test_outside_development_no_kernel_starts(runner: SimpleNamespace, monkeypatch: pytest.MonkeyPatch,
                                              capsys: pytest.CaptureFixture):
    """The kernel refuses its test hooks outside development; the runner refuses first, rather than start a kernel
    it would have to switch to development."""
    monkeypatch.setenv("DESK_ENV", "production")
    assert real_kernel.main() == 1
    assert not runner.started and runner.pytest is None
    assert "DESK_ENV='production'" in capsys.readouterr().err


@pytest.mark.parametrize(("health", "mode"), [({}, "unknown"), ({"proof_mode": "bounded"}, "bounded")],
                         ids=["no proof mode", "bounded"])
def test_a_proof_mode_other_than_symcc_is_called_out(runner: SimpleNamespace, monkeypatch: pytest.MonkeyPatch,
                                                     capsys: pytest.CaptureFixture, health: dict, mode: str):
    """A kernel that doesn't say it proves with SymCC (its `/health` has no `proof_mode`, or isn't a JSON object, which
    reads as `{}`) is reported as such, with a warning: drafts it can't prove make some contract tests skip."""
    monkeypatch.setattr(real_kernel, "_health", lambda: health if runner.started else None)
    assert real_kernel.main() == 0
    out, err = capsys.readouterr()
    assert f"proof mode {mode}" in out and "proof mode None" not in out
    assert f"proof mode is {mode}, not symcc" in err
