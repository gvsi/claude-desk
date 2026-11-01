"""Options shared by every eval run."""

import pytest

from evals.tier1.harness import TARGETS

pytest_plugins = ["desk.pytest_shard", "desk.pytest_hangs"]


def pytest_addoption(parser: pytest.Parser) -> None:
    group = parser.getgroup("claude desk evals")
    group.addoption(
        "--target",
        choices=TARGETS,
        default="kernel",
        help="what tier 1 cases call: the contract stub, the real kernel in-process, or the API over it",
    )
    group.addoption(
        "--allow-bounded",
        action="store_true",
        help="start the kernel target even when its proofs run in bounded mode (cvc5 not found); tier 1 needs symcc",
    )
    group.addoption(
        "--strict-landed",
        action="store_true",
        help="fail the run when a plan's code is on the branch but landed.toml doesn't list it, as a run with CI "
             "set does; otherwise that is a warning and the plan's cases stay pending",
    )
