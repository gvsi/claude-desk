"""Positional pytest shards shared by the backend, evals and kernel contract sessions."""

import re

import pytest


def _shard(value: str) -> tuple[int, int]:
    if re.fullmatch(r"[0-9]+/[0-9]+", value):
        try:
            index, count = map(int, value.split("/"))
            if 1 <= index <= count:
                return index, count
        except ValueError:
            pass
    raise pytest.UsageError("--shard must be I/N with 1 <= I <= N (for example, --shard=1/4)")


def pytest_addoption(parser: pytest.Parser) -> None:
    parser.getgroup("claude desk CI").addoption(
        "--shard", type=_shard, metavar="I/N", default=None,
        help="run shard I of N, in collection order (1-based)",
    )


@pytest.fixture(autouse=True, scope="session")
def _isolate_shard_subprocesses(pytestconfig: pytest.Config):
    # The outer session has consumed these options. A pytest or make subprocess inside a
    # test must exercise its whole fixture suite, including test_log_record_factory and
    # evals/tests/test_make_targets.py. Restore the caller's environment after the session.
    with pytest.MonkeyPatch.context() as patch:
        if pytestconfig.getoption("shard") is not None:
            patch.delenv("PYTEST_ADDOPTS", raising=False)
        yield


@pytest.hookimpl(trylast=True)
def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    shard = config.getoption("shard")
    if shard is None:
        return
    index, count = shard
    deselected = [item for position, item in enumerate(items) if position % count != index - 1]
    items[:] = items[index - 1::count]
    if deselected:
        config.hook.pytest_deselected(items=deselected)
