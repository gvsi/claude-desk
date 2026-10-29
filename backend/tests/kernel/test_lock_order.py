"""The kernel's lock order: the session row before the decision row, so an execution and a
decision on the same session never deadlock.
"""

import asyncio

import psycopg

from desk.contracts import Decision
from desk.db.session import database_url, libpq_url
from desk.kernel_service import execute

from .fakes import FakeAdapter
from .helpers import ledger_rows
from .test_compiler import card
from .test_decide import desk_with, owner_decide


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
    await asyncio.wait_for(locked.wait(), 5)
    repeating = asyncio.create_task(owner_decide(client, rows, "native.fetch_website", desk_id=rows.desk_id))
    assert await a_kernel_backend_waits()                       # the repeat waits for a row the execution holds
    release.set()
    execution, repeat = await asyncio.wait_for(asyncio.gather(executing, repeating), 10)

    # neither is a deadlock's victim: the execution expired the allow, and the repeat reads it expired
    assert (execution.status_code, execution.json()) == (409, {"code": "conflict"})
    assert repeat.status_code == 200, repeat.text
    assert Decision.model_validate(repeat.json()).state == "expired"
    assert "execute" not in website.calls
    expired = [e.event.summary for e in await ledger_rows(app, rows) if e.event.summary.get("state") == "expired"]
    assert expired == [{"decision_id": allowed.decision_id, "state": "expired"}]
