"""A test still running past the limit names itself and dumps every thread's stack, without failing."""

from pathlib import Path

import pytest

pytest_plugins = ["pytester"]


@pytest.fixture
def session(pytester, monkeypatch):
    monkeypatch.setenv("PYTHONPATH", str(Path(__file__).resolve().parents[1]))
    pytester.makeconftest('pytest_plugins = ["desk.pytest_hangs"]\n')
    pytester.makepyfile(test_sample='''
import asyncio

async def test_waits_on_an_await():
    await asyncio.sleep(1.5)

def test_quick():
    pass
''')
    return pytester


def test_a_slow_async_test_names_itself_and_dumps_the_threads(session):
    result = session.runpytest_subprocess("-q", "-o", "asyncio_mode=auto", "-o", "hang_report_s=0.5")
    assert result.ret == pytest.ExitCode.OK
    reports = [line for line in result.stderr.lines if line.startswith("still running after")]
    assert reports == ["still running after 0.5 s: test_sample.py::test_waits_on_an_await"]
    assert any(line.startswith(("Thread 0x", "Current thread 0x")) for line in result.stderr.lines)


def test_tests_within_the_limit_report_nothing(session):
    result = session.runpytest_subprocess("-q", "-o", "asyncio_mode=auto", "-o", "hang_report_s=30")
    assert result.ret == pytest.ExitCode.OK
    assert not [line for line in result.stderr.lines if line.startswith("still running")]
