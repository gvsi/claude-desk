"""Every collected test belongs to exactly one positional CI shard."""

import json
from pathlib import Path

import pytest

pytest_plugins = ["pytester"]


@pytest.fixture
def collection(pytester, monkeypatch):
    monkeypatch.setenv("PYTHONPATH", str(Path(__file__).resolve().parents[1]))
    pytester.makeconftest('''
import json
pytest_plugins = ["desk.pytest_shard"]

# Sharding must see the order after other collection hooks have run.
def pytest_collection_modifyitems(items):
    items.reverse()

def pytest_deselected(items):
    print("DESELECTED=" + json.dumps([item.nodeid for item in items]))
''')
    pytester.makepyfile(test_sample='''
import pytest
@pytest.mark.parametrize("number", range(11))
def test_number(number):
    pass
''')
    return pytester


def selected(result):
    assert result.ret in (pytest.ExitCode.OK, pytest.ExitCode.NO_TESTS_COLLECTED)
    return [line for line in result.stdout.lines if line.startswith("test_sample.py::")]


def test_without_shard_selects_everything(collection):
    result = collection.runpytest_subprocess("--collect-only", "-q")
    ids = selected(result)
    assert ids == [f"test_sample.py::test_number[{number}]" for number in reversed(range(11))]
    assert not any(line.startswith("DESELECTED=") for line in result.stdout.lines)


@pytest.mark.parametrize("count", [1, 2, 3, 4, 13])
def test_shards_partition_collection_in_final_order(collection, count):
    whole = selected(collection.runpytest_subprocess("--collect-only", "-q"))
    shards = []
    for index in range(1, count + 1):
        result = collection.runpytest_subprocess("--collect-only", "-q", f"--shard={index}/{count}")
        ids = selected(result)
        assert ids == whole[index - 1::count]
        deselected = [json.loads(line.removeprefix("DESELECTED=")) for line in result.stdout.lines
                      if line.startswith("DESELECTED=")]
        if count > 1:
            assert deselected == [[nodeid for nodeid in whole if nodeid not in ids]]
        else:
            assert not deselected
        shards.append(set(ids))
    assert set.union(*shards) == set(whole)
    assert sum(map(len, shards)) == len(whole)


@pytest.mark.parametrize("value", ["", "1", "1/", "/4", "a/4", "1/a", "0/4", "-1/4", "5/4", "1/0", "1/-4", "1/2/3"])
def test_bad_shard_is_a_usage_error(collection, value):
    result = collection.runpytest_subprocess("--collect-only", f"--shard={value}")
    assert result.ret == pytest.ExitCode.USAGE_ERROR
    assert "--shard" in result.stderr.str()
    assert "I/N" in result.stderr.str()


def test_test_subprocesses_do_not_inherit_the_sessions_shard(collection, monkeypatch):
    collection.makepyfile(test_nested='''
import os
import subprocess
import sys
import pytest

@pytest.mark.parametrize("number", range(4))
def test_nested_pytest(number, pytestconfig):
    assert pytestconfig.getoption("shard") == (1, 4)
    assert os.environ.get("PYTEST_ADDOPTS") is None
    result = subprocess.run([sys.executable, "-m", "pytest", "-q", "test_sample.py"],
                            capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "11 passed" in result.stdout
''')
    monkeypatch.setenv("PYTEST_ADDOPTS", "--shard=1/4")
    result = collection.runpytest_subprocess("test_nested.py", "-q")
    result.assert_outcomes(passed=1, deselected=3)
