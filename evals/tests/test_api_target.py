"""`ApiTarget` and `load_api_target`: the seam Plan 02a fills with `make_api_target`.

Until Plan 02a's Task 9 adds `evals/tier1/api_impl.py` (and `02a` to `landed.toml`), tier 1's API
cases are pending 02a, and these tests are what runs the seam: how the implementation is found,
and what fits the protocol.
"""

import sys
import types

import pytest

from evals.tier1 import targets
from evals.tier1.targets import API_IMPL, ApiUnavailable, load_api_target


def test_load_api_target_needs_the_implementation(monkeypatch: pytest.MonkeyPatch):
    """With no `api_impl.py`, loading the target says the case needs the API."""
    monkeypatch.setitem(sys.modules, API_IMPL, None)   # importing it raises ModuleNotFoundError, as if absent
    with pytest.raises(ApiUnavailable, match="needs api"):
        load_api_target()


def implementation(**attributes: object) -> types.ModuleType:
    module = types.ModuleType(API_IMPL)
    module.__dict__.update(attributes)
    return module


def test_load_api_target_returns_make_api_target(monkeypatch: pytest.MonkeyPatch):
    def make_api_target(kernel: object, *, models: str) -> object:
        return ("target", kernel, models)

    monkeypatch.setitem(sys.modules, API_IMPL, implementation(make_api_target=make_api_target))
    make = load_api_target()
    assert make("kernel", models="fake") == ("target", "kernel", "fake")


def test_an_implementation_without_the_factory_fails(monkeypatch: pytest.MonkeyPatch):
    """`api_impl.py` is there but gives no `make_api_target`: that fails the case, it isn't a skip."""
    monkeypatch.setitem(sys.modules, API_IMPL, implementation(make_api_target="not a function"))
    with pytest.raises(targets.TargetError, match="make_api_target") as raised:
        load_api_target()
    assert not isinstance(raised.value, ApiUnavailable)


def test_an_implementation_that_fails_to_import_fails(monkeypatch: pytest.MonkeyPatch):
    """A module the implementation imports is missing: the error is the case's, never `needs api`."""
    monkeypatch.delitem(sys.modules, API_IMPL, raising=False)
    original = targets.importlib.import_module

    def import_module(name: str) -> types.ModuleType:
        if name == API_IMPL:
            raise ModuleNotFoundError("No module named 'desk.api.main'", name="desk.api.main")
        return original(name)

    monkeypatch.setattr(targets.importlib, "import_module", import_module)
    with pytest.raises(ModuleNotFoundError, match="desk.api.main"):
        load_api_target()


class StandInApi:
    """What `make_api_target` returns, as the protocol states it."""

    def __init__(self, kernel: object):
        self.kernel = kernel
        self.base_url = "http://127.0.0.1:8700"
        self.passcode = "a passcode"
        self.api_dsn = "postgresql+psycopg://desk_api@localhost/desk"

    async def start(self) -> "StandInApi":
        return self

    async def stop(self) -> None:
        return None


def test_api_target_protocol():
    """A target with the kernel, base URL, passcode, database URL, start and stop fits; one missing any doesn't."""
    assert isinstance(StandInApi(object()), targets.ApiTarget)
    for missing in ("kernel", "base_url", "passcode", "api_dsn"):
        target = StandInApi(object())
        delattr(target, missing)
        assert not isinstance(target, targets.ApiTarget), missing
    assert not isinstance(object(), targets.ApiTarget)
