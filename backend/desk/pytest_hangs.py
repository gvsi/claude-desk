"""Name a hung test: one still running after `hang_report_s` seconds prints its node ID and every thread's stack.

A CI shard once printed nothing for 19 minutes until it was cancelled, which left no trace of the test it hung
on. Most of the suite's tests are async, and a test waiting on an await runs on no thread's stack, so a stack dump
alone (pytest's faulthandler_timeout) can't say which test it is: this prints the test's ID first. It fails and
skips nothing.
"""

import faulthandler
import os
import sys
import threading

import pytest

REPORT_AFTER_S = "300"
# The real stderr, copied before tests run: while a test runs, pytest captures file descriptor 2 itself, and a
# report written there would show only if the test failed, never for a hung one that CI cancels.
_STDERR = pytest.StashKey[int]()


def pytest_addoption(parser: pytest.Parser) -> None:
    parser.addini("hang_report_s", "seconds after which a still-running test names itself and dumps every thread's stack",
                  default=REPORT_AFTER_S)


def pytest_configure(config: pytest.Config) -> None:
    config.stash[_STDERR] = os.dup(sys.__stderr__.fileno())


def pytest_unconfigure(config: pytest.Config) -> None:
    if (stderr := config.stash.get(_STDERR, None)) is not None:
        os.close(stderr)


@pytest.hookimpl(wrapper=True)
def pytest_runtest_protocol(item: pytest.Item, nextitem: pytest.Item | None):
    after = float(item.config.getini("hang_report_s"))
    stderr = item.config.stash[_STDERR]

    def report() -> None:
        os.write(stderr, f"\nstill running after {after:g} s: {item.nodeid}\n".encode())
        faulthandler.dump_traceback(file=stderr, all_threads=True)

    timer = threading.Timer(after, report)
    timer.daemon = True
    timer.start()
    try:
        return (yield)
    finally:
        timer.cancel()
