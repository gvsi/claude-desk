"""The kernel's lock order (`repo.py`): the session row, then the decision row, then the execution
row, then the rows an adapter's hooks lock, then the ledger head, so two kernel transactions never
deadlock.

Two tests race requests that once took a pair of rows in opposite orders: the session and the
decision rows, and an adapter's row and the ledger head. The others record the row locks each
transaction of a path takes (`LockLog`) and check that they come in that order.
"""

import asyncio
import re
from collections.abc import Awaitable, Callable, Iterator
from contextlib import contextmanager
from typing import Any

import psycopg
import pytest
from fastapi import FastAPI
from sqlalchemy import event, select
from sqlalchemy.engine import Connection

from desk.contracts import Decision, ExecResult, NormalizedAction
from desk.db.models import DemoInboxEntry, PolicyVersion
from desk.db.session import database_url, libpq_url
from desk.kernel_service import demo_inbox, execute
from desk.kernel_service.adapters.base import AdapterFailure, AdapterResult, AdapterUnknown, ExecCtx

from .fakes import FakeAdapter
from .helpers import kernel_ctx, ledger_rows
from .test_adapters import visitor_of
from .test_approvals import ASK_QUOTES, answered, held_on, post_cancel
from .test_compiler import card
from .test_decide import decided, desk_with, owner_decide, set_mode
from .test_execute import executed, fake_quote_desk, post_execute, read, store_intent
from .test_reply_check import checked

# The tables whose rows the kernel locks, in the order it locks them (repo.py).
LOCK_ORDER = ("sessions", "decisions", "executions", "policy_versions", "payment_links", "ledger_heads")
_LOCKING = re.compile(
    r"^\s*(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+kernel\.(?P<written>\w+)"
    r"|^\s*SELECT\b.*?\bFROM\s+kernel\.(?P<read>\w+)\b.*\bFOR\s+(?:NO\s+KEY\s+UPDATE|UPDATE|KEY\s+SHARE|SHARE)\b",
    re.S | re.I)


class LockLog:
    """The row locks each kernel transaction takes while the log is open, as the tables of
    `LOCK_ORDER` in the order the transaction first locks a row of each: a `SELECT ... FOR UPDATE`
    or `FOR SHARE` on the table, or an `INSERT`, `UPDATE` or `DELETE` on it. It goes by table, not
    row, so a second lock on a table counts as one the transaction holds already; each path here
    works on one session, one decision and one execution."""

    def __init__(self) -> None:
        self.transactions: list[list[str]] = []
        self._open: dict[Connection, list[str]] = {}

    def begin(self, conn: Connection) -> None:
        self._open[conn] = []

    def statement(self, conn: Connection, cursor, statement: str, parameters, context, executemany) -> None:
        found = _LOCKING.match(statement)
        table = found and (found["written"] or found["read"])
        if table in LOCK_ORDER and table not in self._open.setdefault(conn, []):
            self._open[conn].append(table)

    def end(self, conn: Connection) -> None:
        if locked := self._open.pop(conn, None):
            self.transactions.append(locked)


@contextmanager
def lock_log(app: FastAPI) -> Iterator[LockLog]:
    """A `LockLog` of the kernel app's transactions until the block ends."""
    log, engine = LockLog(), app.state.kernel.engine.sync_engine
    listeners = [("begin", log.begin), ("before_cursor_execute", log.statement), ("commit", log.end),
                 ("rollback", log.end)]
    for name, listener in listeners:
        event.listen(engine, name, listener)
    try:
        yield log
    finally:
        for name, listener in listeners:
            event.remove(engine, name, listener)


async def a_kernel_backend_waits(within: float = 5.0) -> bool:
    """Whether a kernel backend in this database comes to wait for a lock another transaction
    holds. Read as the kernel role, which sees its own backends' waits."""
    async with await psycopg.AsyncConnection.connect(libpq_url(database_url("KERNEL")), autocommit=True) as kernel:
        for _ in range(int(within / 0.02)):
            waiting = await (await kernel.execute(
                "SELECT count(*) FROM pg_stat_activity"
                " WHERE datname = current_database() AND pid <> pg_backend_pid()"
                "   AND wait_event_type = 'Lock' AND cardinality(pg_blocking_pids(pid)) > 0")).fetchone()
            if waiting[0]:
                return True
            await asyncio.sleep(0.02)
    return False


async def test_an_owner_execute_and_a_repeated_decide_never_deadlock(app, client, registry, frozen_clock,
                                                                     monkeypatch):
    website = FakeAdapter("native.fetch_website", effects=["read"])
    rows = await desk_with(app, [website], [card("site", "native.fetch_website")])
    response = await owner_decide(client, rows, "native.fetch_website", desk_id=rows.desk_id)
    allowed = Decision.model_validate(response.json())
    assert allowed.state == "allowed"
    frozen_clock.advance(61)                                    # past its minute: whoever reads it next expires it

    # the owner's /execute stops once it holds the decision row; the owner's /decide repeats the call
    locked, release = asyncio.Event(), asyncio.Event()
    lock_decision = execute._lock_decision

    async def pause_holding_the_decision(ctx, decision_id):
        row = await lock_decision(ctx, decision_id)
        if not locked.is_set():
            locked.set()
            await release.wait()
        return row

    monkeypatch.setattr(execute, "_lock_decision", pause_holding_the_decision)
    executing = asyncio.create_task(client.post("/execute", headers=rows.owner, json={
        "decision_id": allowed.decision_id, "session_id": rows.owner_session_id, "generation": 0}))
    try:
        await asyncio.wait_for(locked.wait(), 5)
        repeating = asyncio.create_task(owner_decide(client, rows, "native.fetch_website", desk_id=rows.desk_id))
        assert await a_kernel_backend_waits()                   # the repeat waits for a row the execution holds
    finally:
        release.set()                                           # never left holding the decision row
    execution, repeat = await asyncio.wait_for(asyncio.gather(executing, repeating), 10)

    # neither is a deadlock's victim: the execution expired the allow, and the repeat reads it expired
    assert (execution.status_code, execution.json()) == (409, {"code": "conflict"})
    assert repeat.status_code == 200, repeat.text
    assert Decision.model_validate(repeat.json()).state == "expired"
    assert "execute" not in website.calls
    expired = [e.event.summary for e in await ledger_rows(app, rows) if e.event.summary.get("state") == "expired"]
    assert expired == [{"decision_id": allowed.decision_id, "state": "expired"}]


async def test_an_allow_runs_in_the_lock_order(app, client, registry):
    _, _, visitor, allowed = await fake_quote_desk(app, client)
    with lock_log(app) as log:
        assert (await executed(client, visitor, allowed)).state == "succeeded"
    assert log.transactions == [
        ["sessions", "decisions", "executions"],                    # T1: the intent
        ["sessions", "decisions", "executions", "ledger_heads"],    # T2: the side effect and its outcome
    ]


@pytest.mark.parametrize("how", ["read", "startup"])
async def test_reconciliation_runs_in_the_lock_order(app, client, registry, frozen_clock, how):
    _, rows, _, allowed = await fake_quote_desk(app, client)
    await store_intent(app, rows.copy_id, allowed)                  # a kernel died after T1
    frozen_clock.advance(31)
    with lock_log(app) as log:
        if how == "read":
            assert (await read(client, rows.owner, allowed)).state == "failed"
        else:
            assert await execute.reconcile_at_startup(app.state.kernel) == [allowed.action.action_id]
    assert log.transactions == [["decisions", "executions", "ledger_heads"]]


async def hold_the_active_version(xctx: ExecCtx, action: NormalizedAction) -> None:
    """What Plan 01c's payment-link hooks take first: the Desk's active `policy_versions` row, `FOR SHARE`."""
    ctx = xctx.ctx
    (await ctx.db.scalars(ctx.repo.scoped(select(PolicyVersion).where(
        PolicyVersion.desk_id == xctx.desk_row.desk_id, PolicyVersion.status == "active")
        .with_for_update(read=True)))).one()


def then(answer: AdapterResult | Exception | None) -> Callable[[ExecCtx, NormalizedAction], Awaitable[Any]]:
    """A `reconcile` that holds the active version, then answers (or raises) `answer`."""
    async def reconcile(xctx: ExecCtx, action: NormalizedAction) -> AdapterResult | None:
        await hold_the_active_version(xctx, action)
        if isinstance(answer, Exception):
            raise answer
        return answer
    return reconcile


@pytest.mark.parametrize(("script", "state"), [
    ({"reconcile": then(None)}, "failed"),                                    # it never ran
    ({"on_failed": hold_the_active_version}, "failed"),                       # it never ran, undone holding it
    ({"reconcile": then(AdapterResult(model_view={"ok": True}))}, "executed"),
    ({"reconcile": then(AdapterUnknown("the provider is still deciding"))}, "unknown"),
], ids=["reconcile-failed", "on_failed", "reconcile-executed", "reconcile-unknown"])
async def test_reconciliation_runs_the_adapter_before_it_ledgers(app, client, registry, frozen_clock, script, state):
    quote, rows, _, allowed = await fake_quote_desk(app, client)
    quote.script.update(script)
    await store_intent(app, rows.copy_id, allowed)                  # a kernel died after T1
    frozen_clock.advance(31)
    with lock_log(app) as log:
        assert (await read(client, rows.owner, allowed)).state == state
    # the rows the adapter's hooks lock come before the ledger head, like any step's
    assert log.transactions == [["decisions", "executions", "policy_versions", "ledger_heads"]]
    base = {"decision_id": allowed.decision_id, "action_id": allowed.action.action_id}
    outcome = [] if state == "unknown" else [{**base, "state": state, "reconciled": True}]
    assert [e.event.summary for e in await ledger_rows(app, rows) if e.event.kind == "execute"] == [
        {**base, "state": "unknown", "orphaned": True}, *outcome]   # the same record, in the same order


async def test_reconciliation_and_a_running_execution_never_deadlock(app, client, registry, frozen_clock):
    # Plan 01c's mandate: a charge's `execute` and an orphaned charge's `reconcile` lock the same
    # row of the adapter's own (a Demo inbox entry stands in for it) before the ledger head
    quote, rows, visitor, orphan = await fake_quote_desk(app, client)
    running = await decided(client, visitor, "native.quote", {"qty": 2}, call_id="call-2")
    async with kernel_ctx(app) as ctx:
        await demo_inbox.deliver(ctx, copy_id=rows.copy_id, desk_id=rows.desk_id, to="owner", person_id=None,
                                 kind="alert", body="mandate", preview="Mandate")
    await store_intent(app, rows.copy_id, orphan)                   # a kernel died after T1
    frozen_clock.advance(31)

    async def hold_the_mandate(xctx: ExecCtx) -> None:
        ctx = xctx.ctx
        (await ctx.db.scalars(ctx.repo.scoped(select(DemoInboxEntry).where(DemoInboxEntry.preview == "Mandate")
                                              .with_for_update()))).one()

    holding, release = asyncio.Event(), asyncio.Event()

    async def charge(xctx: ExecCtx, action: NormalizedAction, args) -> AdapterResult:
        await hold_the_mandate(xctx)
        holding.set()
        await release.wait()
        return AdapterResult(model_view={"ok": True})

    async def look_up(xctx: ExecCtx, action: NormalizedAction) -> None:
        await hold_the_mandate(xctx)
        return None                                                 # no charge was made

    quote.script.update(execute=charge, reconcile=look_up)
    executing = asyncio.create_task(post_execute(client, visitor, running))
    try:
        await asyncio.wait_for(holding.wait(), 10)
        reading = asyncio.create_task(client.get(f"/decisions/{orphan.decision_id}", headers=rows.owner))
        assert await a_kernel_backend_waits()                       # the reconciliation waits for the mandate
    finally:
        release.set()                                               # never left holding the mandate
    execution, settled = await asyncio.wait_for(asyncio.gather(executing, reading), 10)

    # neither is a deadlock's victim: the charge succeeded, and the orphan, which never charged, failed
    assert execution.status_code == 200, execution.text
    assert ExecResult.model_validate(execution.json()).state == "succeeded"
    assert settled.status_code == 200, settled.text
    assert Decision.model_validate(settled.json()).state == "failed"


@pytest.mark.parametrize(("error", "state"), [(AdapterFailure("slot_taken"), "failed"),
                                               (RuntimeError("bad provider output"), "unknown")])
async def test_a_run_that_raises_settles_in_the_lock_order(app, client, registry, error, state):
    quote, _, visitor, allowed = await fake_quote_desk(app, client)
    quote.script["execute"] = error
    with lock_log(app) as log:
        assert (await executed(client, visitor, allowed)).state == state
    assert log.transactions == [
        ["sessions", "decisions", "executions"],                    # T1: the intent
        ["sessions", "decisions", "executions"],                    # T2, rolled back when the adapter raised
        ["decisions", "executions", "ledger_heads"],                # T3: the outcome
    ]


async def test_a_stale_execute_is_recorded_in_the_lock_order(app, client, registry):
    _, rows, visitor, allowed = await fake_quote_desk(app, client)
    await set_mode(client, rows, visitor.session_id, "owner", 0)            # Maria takes over
    with lock_log(app) as log:
        response = await post_execute(client, visitor, allowed)
    assert (response.status_code, response.json()) == (409, {"code": "stale_generation"})
    assert log.transactions == [
        ["sessions", "decisions"],                                  # the request's, rolled back at the refusal
        ["decisions", "ledger_heads"],                              # the refusal and the allow's expiry, recorded
    ]


async def test_an_approved_hold_runs_in_the_lock_order(app, client, registry):
    rows = await desk_with(app, [FakeAdapter("native.quote")], ASK_QUOTES)
    _, held = await held_on(client, rows)
    with lock_log(app) as log:
        assert (await answered(client, rows.owner, held.decision_id, "allow_once")).decision.state == "executed"
    assert log.transactions == [
        ["decisions", "executions", "ledger_heads"],                # the answer: approved, with its intent
        ["decisions", "executions", "ledger_heads"],                # T2 on the approved path
    ]


async def test_a_cancel_keeps_the_lock_order(app, client, registry, frozen_clock):
    rows = await desk_with(app, [FakeAdapter("native.quote")], ASK_QUOTES)
    visitor, held = await held_on(client, rows)
    frozen_clock.advance(1)                                         # so the visitor's last_seen_at is written
    with lock_log(app) as log:
        response = await post_cancel(client, visitor, held.decision_id)
    assert (response.status_code, response.json()["state"]) == (200, "cancelled")
    assert log.transactions == [["sessions", "decisions", "ledger_heads"]]


async def test_a_sessions_decision_read_keeps_the_lock_order(app, client, registry, frozen_clock):
    _, _, visitor, allowed = await fake_quote_desk(app, client)
    frozen_clock.advance(61)                        # past the allow's minute, and the visitor's last_seen_at moves
    with lock_log(app) as log:
        assert (await read(client, visitor.headers, allowed)).state == "expired"
    # the session is proved, and seen, in the transaction that read the decision, before it expires it
    assert log.transactions == [["sessions", "decisions", "ledger_heads"]]


async def test_a_reply_check_keeps_the_lock_order(app, client, frozen_clock):
    _, visitor = await visitor_of(app, client)
    frozen_clock.advance(1)                                         # so the visitor's last_seen_at is written
    with lock_log(app) as log:
        verdict = await checked(client, visitor, "I can help with that.")
    assert verdict.ok
    # the session is seen at the check's end (no lock across the model call), just before its entry
    assert log.transactions == [["sessions", "ledger_heads"]]
