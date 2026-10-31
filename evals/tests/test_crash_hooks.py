"""The crash hooks tier 1's restart cases use, run against a stand-in for Plan 01a's kernel.

A crash hook kills one kernel request at a chosen point, as if the process died there: after the
intent row is committed (`crash_after_intent`), or just after a side effect completes
(`crash_after_side_effect`). The stand-in has an `/execute` that commits an intent, calls the
`_after_intent` hook and then a side effect, so these tests can see what ran before the crash.
On the contract stub the hooks patch nothing and the dying call is contract-checked only.
"""

import asyncio
import inspect
import sys
import types
from collections.abc import Iterator
from typing import Any

import pytest
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from evals.tier1 import targets
from evals.tier1.harness import Auth, ContractError, Expect
from evals.tier1.stub import ContractStub
from evals.tier1.targets import (
    KernelTarget,
    SimulatedCrash,
    TargetError,
    crash_after_intent,
    crash_after_side_effect,
    restart_kernel,
)

EXECUTE = {"decision_id": "d-1", "session_id": "s-1", "generation": 0}
SESSION = Auth.raw({"X-Session-Token": "stand-in-token"})


class StandInKernel:
    """Plan 01a's `create_app` and `execute` module as far as the hooks reach: `/execute` commits
    an intent, calls `execute._after_intent()` (sync or async, as the stand-in is told), then two
    side effects, the sync `payments.commit` and the async `payments.ProviderClient.charge`, and
    answers with an `ExecResult`."""

    def __init__(self, async_hook: bool) -> None:
        self.intents: list[str] = []
        self.effects: list[str] = []
        self.swallows_crashes = False   # a kernel that wrongly catches BaseException and carries on
        self.stalls_after_crash_s = 0.0   # ... and then stalls this long before carrying on
        self.answer_after_crash: JSONResponse | None = None   # ... or answers this instead of carrying on
        self.execute = types.ModuleType("desk.kernel_service.execute")
        self.payments = types.ModuleType("desk.kernel_service.payments")

        if async_hook:
            async def _after_intent() -> None:
                """No-op between T1 and T2."""
        else:
            def _after_intent() -> None:
                """No-op between T1 and T2."""

        effects = self.effects

        def commit(decision_id: str) -> None:
            effects.append(f"commit {decision_id}")

        class BaseClient:
            async def charge(self, decision_id: str) -> str:
                effects.append(f"charge {decision_id}")
                return f"ch-{decision_id}"

        class ProviderClient(BaseClient):   # charge is inherited
            pass

        self.execute._after_intent = _after_intent
        self.payments.commit = commit
        self.payments.BaseClient = BaseClient
        self.payments.ProviderClient = ProviderClient

    def create_app(self, settings: object = None, clock: object = None) -> Starlette:
        async def health(request: Request) -> JSONResponse:
            return JSONResponse({"version": "stand-in", "proof_mode": "symcc", "dev_signing_key": True,
                                 "public_key_hex": "ab" * 32, "key_id": "ab" * 8, "unproved_seeds": []})

        async def execute(request: Request) -> JSONResponse:
            decision_id = (await request.json())["decision_id"]
            self.intents.append(decision_id)                          # T1, committed
            try:
                hook = self.execute._after_intent()                   # looked up when called, as a global is
                if inspect.isawaitable(hook):
                    await hook
            except BaseException:
                if not self.swallows_crashes:
                    raise
                if self.stalls_after_crash_s:
                    await asyncio.sleep(self.stalls_after_crash_s)
                if self.answer_after_crash is not None:
                    return self.answer_after_crash
            self.payments.commit(decision_id)                          # T2's side effects
            await self.payments.ProviderClient().charge(decision_id)
            return JSONResponse({"action_id": f"a-{decision_id}", "state": "succeeded", "facts": [],
                                 "model_view": {}})

        return Starlette(routes=[Route("/health", health), Route("/execute", execute, methods=["POST"])])


@pytest.fixture(params=["async hook", "sync hook"])
def kernel(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch) -> Iterator[StandInKernel]:
    stand_in = StandInKernel(async_hook=request.param == "async hook")
    package = types.ModuleType("desk.kernel_service")
    package.__path__ = []
    app = types.ModuleType("desk.kernel_service.app")
    app.create_app = stand_in.create_app
    # The real kernel's modules another test imported stay cached, and an import finds them there
    # before the stand-in: each is taken out for the test and put back after it.
    for name in [name for name in sys.modules if name.startswith("desk.kernel_service.")]:
        monkeypatch.delitem(sys.modules, name)
    for name, module in (("", package), (".app", app), (".execute", stand_in.execute),
                         (".payments", stand_in.payments)):
        monkeypatch.setitem(sys.modules, f"desk.kernel_service{name}", module)
    # Records connects only when read, and these tests read none.
    monkeypatch.setenv("API_DATABASE_URL", "postgresql+psycopg://desk_api:unused@127.0.0.1:1/desk")
    monkeypatch.setenv("KERNEL_DATABASE_URL", "postgresql+psycopg://desk_kernel:unused@127.0.0.1:1/desk")
    yield stand_in


@pytest.fixture
async def target(kernel: StandInKernel) -> Any:
    started = await KernelTarget(models="fake").start()
    try:
        yield started
    finally:
        await started.stop()


def test_simulated_crash_escapes_exception_handlers():
    """The kernel's handlers catch `Exception`, never `BaseException`, so a simulated crash passes
    them untouched, as a dying process would."""
    assert issubclass(SimulatedCrash, BaseException) and not issubclass(SimulatedCrash, Exception)
    with pytest.raises(SimulatedCrash):
        try:
            raise SimulatedCrash("after the intent")
        except Exception:   # what T3 catches
            pytest.fail("a simulated crash was caught as an Exception")


async def test_crash_after_intent_kills_the_call_after_the_intent(kernel: StandInKernel, target: KernelTarget):
    """The call commits its intent, then dies in the hook: no side effect, no kernel answer, and
    the crash point fired once. Leaving the block puts the hook back, so the next call runs."""
    hook = kernel.execute._after_intent
    with crash_after_intent(target) as crash:
        await crash.call("POST /execute", body=EXECUTE, auth=SESSION)
    assert (kernel.intents, kernel.effects, crash.fired) == (["d-1"], [], 1)
    assert [(called.route, called.status, called.body) for called in target.responses] == [("POST /execute", 500, None)]
    assert kernel.execute._after_intent is hook
    await target.call("POST /execute", body=EXECUTE, auth=SESSION, expect=Expect(fields={"state": "succeeded"}))
    assert (kernel.intents, kernel.effects) == (["d-1", "d-1"], ["commit d-1", "charge d-1"])


@pytest.mark.parametrize("owner, name, effects", [
    ("payments", "commit", ["commit d-1"]),
    ("payments.BaseClient", "charge", ["commit d-1", "charge d-1"]),
    ("payments.ProviderClient", "charge", ["commit d-1", "charge d-1"]),
], ids=["sync function", "async method", "inherited async method"])
async def test_crash_after_side_effect_lets_it_complete_first(
    kernel: StandInKernel, target: KernelTarget, owner: str, name: str, effects: list[str]
):
    """The wrapped side effect runs to the end, then the call dies: nothing after it runs, and
    leaving the block unwraps it, an inherited method included."""
    holder: Any = kernel.payments
    for part in owner.split(".")[1:]:
        holder = getattr(holder, part)
    before = (inspect.getattr_static(holder, name), name in vars(holder))
    with crash_after_side_effect(target, f"desk.kernel_service.{owner}.{name}") as crash:
        await crash.call("POST /execute", body=EXECUTE, auth=SESSION)
    assert (kernel.intents, kernel.effects, crash.fired) == (["d-1"], effects, 1)
    assert (inspect.getattr_static(holder, name), name in vars(holder)) == before


async def test_a_call_the_crash_point_never_kills_fails(kernel: StandInKernel, target: KernelTarget):
    """A call that answers without reaching the crash point fails the case, which would otherwise
    check the state of a crash that never happened."""
    with crash_after_intent(target) as crash:
        with pytest.raises(AssertionError, match="reached the crash point at the intent row 0 times"):
            await crash.call("GET /health", auth=Auth.none())
    assert crash.fired == 0


async def test_a_kernel_that_survives_its_crash_fails_the_call(kernel: StandInKernel, target: KernelTarget):
    """A kernel that catches the crash and carries on answers as if it never died, so the state the
    case checks next isn't a crash's: the call fails though the crash point fired."""
    kernel.swallows_crashes = True
    with crash_after_intent(target) as crash:
        with pytest.raises(AssertionError, match="answered 200 though the kernel died at the intent row"):
            await crash.call("POST /execute", body=EXECUTE, auth=SESSION)
    assert (crash.fired, kernel.effects) == (1, ["commit d-1", "charge d-1"])


async def test_a_kernel_that_answers_its_crash_with_its_own_error_fails_the_call(
    kernel: StandInKernel, target: KernelTarget
):
    """A 500 whose body is a `KernelError` is the kernel's own answer, not a dying process's bare
    5xx: it caught the crash and handled it, so the state the case checks next isn't a crash's."""
    kernel.swallows_crashes = True
    kernel.answer_after_crash = JSONResponse({"code": "internal"}, status_code=500)
    with crash_after_intent(target) as crash:
        with pytest.raises(AssertionError, match="answered 500 with its own error 'internal' though it died at"):
            await crash.call("POST /execute", body=EXECUTE, auth=SESSION)
    assert (crash.fired, kernel.effects) == (1, [])


async def test_a_call_that_hangs_after_the_crash_point_fails(kernel: StandInKernel, monkeypatch: pytest.MonkeyPatch):
    """A kernel that catches the crash and then stalls gives no answer before the client's timeout.
    A timeout isn't the dropped connection of a dying process, and a timed-out case fails, so the
    call fails though the crash point fired."""
    kernel.swallows_crashes, kernel.stalls_after_crash_s = True, 1.5
    monkeypatch.setattr(targets, "CALL_TIMEOUT_S", 0.5)   # read when the target opens its client
    target = await KernelTarget(models="fake").start()
    try:
        with crash_after_intent(target) as crash:
            with pytest.raises(AssertionError, match="timed out after the crash point at the intent row fired 1 times"):
                await crash.call("POST /execute", body=EXECUTE, auth=SESSION)
    finally:
        await target.stop()
    assert (crash.fired, kernel.intents) == (1, ["d-1"])


@pytest.mark.parametrize("dotted_path", [
    "desk.kernel_service.payments.refund",                  # no such function
    "desk.kernel_service.payments.ProviderClient.refund",   # no such method
    "desk.kernel_service.ledger.append",                    # no such module
])
async def test_a_hook_that_isnt_there_fails_closed(kernel: StandInKernel, target: KernelTarget, dotted_path: str):
    """A crash point the kernel doesn't have stops the case before any call: renamed kernel code
    can't turn a crash case into one that never crashes."""
    with pytest.raises(TargetError, match=f"needs {dotted_path}, which isn't there"):
        with crash_after_side_effect(target, dotted_path):
            pytest.fail("the block ran without its crash point")


async def test_hooks_are_no_ops_on_the_stub(monkeypatch: pytest.MonkeyPatch):
    """The stub runs no kernel code: the hooks import and patch nothing, a dying call is
    contract-checked and recorded with a bare 500's status, and a restart does nothing."""
    monkeypatch.setitem(sys.modules, "desk.kernel_service", None)   # importing kernel code would fail
    stub = ContractStub()
    with crash_after_intent(stub) as crash:
        await crash.call("POST /execute", body=EXECUTE, auth=SESSION)
        with pytest.raises(ContractError, match="ExecuteRequest"):
            await crash.call("POST /execute", body={"decision_id": "d-1"}, auth=SESSION)
    with crash_after_side_effect(stub, "desk.kernel_service.payments.ProviderClient.charge") as crash:
        await crash.call("POST /execute", body=EXECUTE, auth=SESSION)
    assert crash.fired == 0
    assert [(called.route, called.status) for called in stub.responses] == [("POST /execute", 500)] * 2
    clock = stub.clock.now()
    await restart_kernel(stub)
    assert stub.clock.now() >= clock


async def test_restart_kernel_restarts_the_real_kernel(kernel: StandInKernel, target: KernelTarget):
    """On the real kernel, `restart_kernel` is `KernelTarget.restart()`: a fresh app, same address."""
    url, apps = target.url, target._kernel
    await restart_kernel(target)
    assert target.url == url and target._kernel is not apps


async def test_hooks_are_put_back_when_the_block_fails(kernel: StandInKernel, target: KernelTarget):
    """A case that fails inside the block leaves no crash point armed for the cases after it."""
    hook, charge = kernel.execute._after_intent, vars(kernel.payments.BaseClient)["charge"]
    with pytest.raises(RuntimeError, match="the case failed"):
        with crash_after_intent(target), \
                crash_after_side_effect(target, "desk.kernel_service.payments.ProviderClient.charge"), \
                crash_after_side_effect(target, "desk.kernel_service.payments.BaseClient.charge"):
            raise RuntimeError("the case failed")
    assert kernel.execute._after_intent is hook and vars(kernel.payments.BaseClient)["charge"] is charge
    assert "charge" not in vars(kernel.payments.ProviderClient), "the inherited method wasn't inherited again"


async def test_static_and_class_methods_crash_and_stay_what_they_were(monkeypatch: pytest.MonkeyPatch):
    """A static or class method, sync or async, completes and then crashes however it is called,
    and is put back as the same kind of method. (Patching needs no running kernel.)"""
    calls: list[tuple] = []

    class Client:
        @staticmethod
        def receipt(n: int) -> None:
            calls.append(("receipt", n))

        @classmethod
        async def refund(cls, n: int) -> None:
            calls.append(("refund", cls.__name__, n))

    module = types.ModuleType("desk_crash_stand_in")
    module.Client = Client
    monkeypatch.setitem(sys.modules, "desk_crash_stand_in", module)
    target = KernelTarget()
    receipt, refund = vars(Client)["receipt"], vars(Client)["refund"]
    with crash_after_side_effect(target, "desk_crash_stand_in.Client.receipt") as crashed_receipt, \
            crash_after_side_effect(target, "desk_crash_stand_in.Client.refund") as crashed_refund:
        for call in (lambda: Client.receipt(1), lambda: Client().receipt(2)):
            with pytest.raises(SimulatedCrash):
                call()
        with pytest.raises(SimulatedCrash):
            await Client().refund(3)
    assert calls == [("receipt", 1), ("receipt", 2), ("refund", "Client", 3)]
    assert (crashed_receipt.fired, crashed_refund.fired) == (2, 1)
    assert vars(Client)["receipt"] is receipt and vars(Client)["refund"] is refund
