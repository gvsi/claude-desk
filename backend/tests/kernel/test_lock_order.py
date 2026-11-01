"""The kernel's lock order (`repo.py`): the session row, then the decision row, then the execution
row, then the policy row, people and their verification codes, a quote, payment links, document
links, documents, the rows an adapter's hooks lock (a handoff) and facts, then the ledger head, so
two kernel transactions never deadlock.

Two tests race requests that once took a pair of rows in opposite orders: the session and the
decision rows, and an adapter's row and the ledger head. The others record the row locks each
transaction of a path takes (`LockLog`) and check that they come in that order: executions and
their reconciliation (a private action's too, once its session closed: its adapter asked, then
the action withheld, refused or left unknown by what it answers), answers, cancels and reads, a
verification start allowed or approved, a right code checked, a document link opened, a person
removed or given another contact, a Desk deleted, a reply check that opens a handoff for its card,
a booking that closes the card's handoff, and a handoff closed, after the Desk row an owner's write
holds first; and Plan 01c's payment paths, over the real adapters and the mock payments server.
"""

import asyncio
import re
from collections.abc import Awaitable, Callable, Iterator, Sequence
from contextlib import contextmanager
from typing import Any

import psycopg
import pytest
from fastapi import FastAPI
from sqlalchemy import event, select
from sqlalchemy.engine import Connection

from desk.contracts import Decision, ExecResult, NormalizedAction
from desk.contracts import PolicyVersion as PolicyVersionContract
from desk.db.models import CalendarSlot, DemoInboxEntry, Execution, PaymentLink, PolicyVersion
from desk.db.session import database_url, libpq_url
from desk.kernel_service import demo_inbox, desks, execute
from desk.kernel_service.adapters.base import AdapterFailure, AdapterResult, AdapterUnknown, ExecCtx

from .fakes import FakeAdapter
from .helpers import activate_cards, kernel_ctx, ledger_rows, rows_of
from .test_adapters import book, rivera, visitor_of
from .test_approvals import ASK_QUOTES, answered, held_on, post_answer, post_cancel
from .test_calendar_refresh import setup_calendar, setup_desk
from .test_compiler import card
from .test_decide import PASS, decided, desk_with, open_visitor, owner_decide, set_mode, set_session
from .test_desk_writes import slot_body, updated
from .test_execute import Crash, crash, executed, fake_quote_desk, post_execute, read, store_intent
from .test_handoff_card import legacy_call_back
from .test_lead_tools import CALLBACK, callback, handoff_done
from .test_link_completion import PASS as LINK_PASS
from .test_link_completion import RV_LINK_100, charged, completed, rivera_cards, rv_link
from .test_mandates import CHARGE, asked, rivera_agent
from .test_mandates import quoted as agent_quoted
from .test_money_cap import post_draft
from .test_payment_links import confirm, delay, landed, link_for, quoted, view
from .test_payments_adapters import LIST, REFUND, person_of, provider_charges
from .test_private_release import verified_fake_desk
from .test_release_document import DANA, confirmed, documents, links, open_link, released
from .test_owner_messages import sent
from .test_reply_check import checked
from .test_verification import check, code_in, entry_of, started

# A reply in another language: a failure no rewrite fixes, so the handoff card shows and opens the card handoff
# these cases need, where a prose-only block would show the call-back offer and open none.
OTHER_LANGUAGE = "Bonjour, je peux vous aider."

# The tables whose rows the kernel locks, in the order it locks them (repo.py); `handoffs` stands
# for an adapter's own rows.
LOCK_ORDER = ("sessions", "decisions", "executions", "policy_versions", "people", "verification_challenges",
              "quotes", "payment_links", "document_links", "documents", "calendar_slots", "handoffs", "facts",
              "ledger_heads")
_LOCKING = re.compile(
    r"^\s*(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+kernel\.(?P<written>\w+)"
    r"|^\s*SELECT\b.*?\bFROM\s+kernel\.(?P<read>\w+)\b.*\bFOR\s+(?:NO\s+KEY\s+UPDATE|UPDATE|KEY\s+SHARE|SHARE)\b",
    re.S | re.I)


class LockLog:
    """The row locks each kernel transaction takes while the log is open, as the tables of
    `tables` (`LOCK_ORDER` unless given) in the order the transaction first locks a row of each: a
    `SELECT ... FOR UPDATE` or `FOR SHARE` on the table, or an `INSERT`, `UPDATE` or `DELETE` on it.
    It goes by table, not row, so a second lock on a table counts as one the transaction holds
    already; each path here works on one session, one decision and one execution, and a removal on
    one person; a Desk's deletion takes all its open sessions in one statement, in ID order."""

    def __init__(self, tables: Sequence[str] = LOCK_ORDER) -> None:
        self.tables = tables
        self.transactions: list[list[str]] = []
        self._open: dict[Connection, list[str]] = {}

    def begin(self, conn: Connection) -> None:
        self._open[conn] = []

    def statement(self, conn: Connection, cursor, statement: str, parameters, context, executemany) -> None:
        found = _LOCKING.match(statement)
        table = found and (found["written"] or found["read"])
        if table in self.tables and table not in self._open.setdefault(conn, []):
            self._open[conn].append(table)

    def end(self, conn: Connection) -> None:
        if locked := self._open.pop(conn, None):
            self.transactions.append(locked)


def in_lock_order(tables: list[str]) -> bool:
    """Whether a transaction's tables come in `LOCK_ORDER`."""
    return tables == sorted(tables, key=LOCK_ORDER.index)


@contextmanager
def lock_log(app: FastAPI, tables: Sequence[str] = LOCK_ORDER) -> Iterator[LockLog]:
    """A `LockLog` of the kernel app's transactions, over `tables`, until the block ends."""
    log, engine = LockLog(tables), app.state.kernel.engine.sync_engine
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
    # each commits at once; a read then goes on holding the decision again, in a transaction of its own
    reread = [["decisions"]] if how == "read" else []
    assert log.transactions == [["decisions", "executions", "ledger_heads"], *reread]


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
    # the rows the adapter's hooks lock come before the ledger head, like any step's; the reconciliation commits at
    # once, and the read goes on in a new transaction holding the decision again, as a caller that held it would
    assert log.transactions == [["decisions", "executions", "policy_versions", "ledger_heads"], ["decisions"]]
    base = {"decision_id": allowed.decision_id, "action_id": allowed.action.action_id}
    outcome = [] if state == "unknown" else [{**base, "state": state, "reconciled": True}]
    assert [e.event.summary for e in await ledger_rows(app, rows) if e.event.kind == "execute"] == [
        {**base, "state": "unknown", "orphaned": True}, *outcome]   # the same record, in the same order


async def hold_the_active_version_and_fail(xctx: ExecCtx, action: NormalizedAction) -> None:
    """An `on_failed` that holds the active version, then can't undo what `prepare` reserved."""
    await hold_the_active_version(xctx, action)
    raise RuntimeError("the provider can't release the reservation")


@pytest.mark.parametrize(("on_failed", "state"), [
    (hold_the_active_version, "refused_at_execution"),                 # undone, then refused
    (hold_the_active_version_and_fail, "unknown"),                     # not undone: still unknown
], ids=["undone", "undo-failed"])
async def test_a_private_actions_refused_recovery_undoes_before_it_ledgers(app, client, registry, frozen_clock,
                                                                         monkeypatch, on_failed, state):
    """An approved hold of an action that releases private data, its intent left by a kernel that
    died after the answer, recovered once its session closed: the adapter is asked once and answers
    that nothing happened, and the rows its `on_failed` locks come before the ledger head, as in
    every other step. If it can't undo, the action stays `unknown`, with nothing in its result."""
    release = FakeAdapter("native.quote", releases_private_data=True)     # stands in for a private release
    rows, visitor, _, _ = await verified_fake_desk(app, client, release,
                                                   [card("ask-quote", "native.quote", mode="ask")])
    _, held = await held_on(client, rows, visitor=visitor)
    with monkeypatch.context() as patch:
        patch.setattr(execute, "_after_intent", crash)
        with pytest.raises(Crash):
            await post_answer(client, rows.owner, held.decision_id, "allow_once")     # dies after the intent
    release.script["on_failed"] = on_failed
    await set_session(app, rows, visitor.session_id, closed_at=frozen_clock.now())     # a contact change, say
    frozen_clock.advance(31)

    with lock_log(app) as log:
        assert (await read(client, rows.owner, held)).state == state

    # the reconciliation commits at once, and the read goes on in a new transaction holding the decision again
    assert log.transactions == [["sessions", "decisions", "executions", "policy_versions", "ledger_heads"],
                                ["decisions"]]
    assert release.calls.count("reconcile") == 1 and release.calls[-2:] == ["reconcile", "on_failed"]
    [execution] = await rows_of(app, rows.copy_id, select(Execution).where(Execution.decision_id == held.decision_id))
    assert (execution.state, execution.result.facts, execution.result.model_view) == (
        "failed" if state == "refused_at_execution" else "unknown", [], {})
    entries = [e.event.summary for e in await ledger_rows(app, rows) if e.event.kind == "execute"]
    refused = [("refused_at_execution", None, "session_ended", True)] if state == "refused_at_execution" else []
    assert [(s["state"], s.get("orphaned"), s.get("reason"), s.get("reconciled")) for s in entries] == [
        ("unknown", True, None, None), *refused]


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
    await set_mode(client, rows, visitor.session_id, "owner", 0)            # Mike takes over
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
        ["sessions", "decisions", "executions", "ledger_heads"],    # T2 on the approved path, holding the session
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


@pytest.mark.parametrize("prose", ["Here is your quote.", "Here is $20."])
async def test_a_reply_with_rechecked_cards_keeps_the_lock_order(app, client, prose):
    from .test_reply_check import clause, own_quote

    _, visitor = await visitor_of(app, client)
    quote = await own_quote(client, visitor)
    # No clock advance: the explicit session lock must work even without a last-seen UPDATE.
    with lock_log(app) as log:
        verdict = await checked(client, visitor, prose, [clause("quote", quote.fact_id)])
    assert [b.template for b in verdict.blocks if b.kind == "card"] == ["quote"]
    # Handoffs are held before facts even if the refresh later drops the last card.
    assert log.transactions == [["sessions", "handoffs", "facts", "ledger_heads"]]
    assert all(map(in_lock_order, log.transactions))


async def test_a_reply_check_that_opens_a_handoff_keeps_the_lock_order(app, client, frozen_clock):
    _, visitor = await visitor_of(app, client)
    frozen_clock.advance(1)                                         # so the visitor's last_seen_at is written
    with lock_log(app) as log:
        assert not (await checked(client, visitor, OTHER_LANGUAGE)).ok
    # the session row, then the handoffs (the session's open ones, none, then the card's, inserted), then the
    # handoff's entry and the verdict's; the owner's alert is an insert under a fresh key
    assert log.transactions == [["sessions", "handoffs", "ledger_heads"]]
    frozen_clock.advance(1)
    with lock_log(app) as log:
        assert not (await checked(client, visitor, OTHER_LANGUAGE)).ok
    # the open one, held FOR SHARE so the owner can't mark it done meanwhile, and only the verdict's entry
    assert log.transactions == [["sessions", "handoffs", "ledger_heads"]]
    assert all(map(in_lock_order, log.transactions))


async def test_a_reply_backed_by_an_open_handoff_keeps_the_lock_order(app, client, frozen_clock):
    _, visitor = await visitor_of(app, client)
    assert not (await checked(client, visitor, OTHER_LANGUAGE)).ok          # the card opens a handoff
    frozen_clock.advance(1)
    with lock_log(app) as log:
        assert (await checked(client, visitor, "Mike Turner will reply here.")).ok
    # a reply that passed on the open handoff's card: the session row, then that handoff FOR SHARE, held to the
    # commit, then the verdict's entry
    assert log.transactions == [["sessions", "handoffs", "ledger_heads"]]


async def test_an_allowed_verification_start_runs_in_the_lock_order(app, client):
    _, visitor = await visitor_of(app, client)
    allowed = await decided(client, visitor, "native.start_verification", {"contact": "dana@example.com"})
    assert allowed.outcome == "allow", allowed.reason_plain
    with lock_log(app) as log:
        assert (await executed(client, visitor, allowed)).state == "succeeded"
    assert log.transactions == [
        ["sessions", "decisions", "executions"],                    # T1: the intent
        # T2: the session row FOR UPDATE, then the start's own rows: Dana's row, her live challenges
        # (cancelled, then the new one), then its `verify` entry and the outcome
        ["sessions", "decisions", "executions", "people", "verification_challenges", "ledger_heads"],
    ]
    assert all(map(in_lock_order, log.transactions))


async def test_an_approved_verification_start_runs_in_the_lock_order(app, client):
    copy, visitor = await visitor_of(app, client)
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        await activate_cards(ctx, copy.desk_id, [card("ask-verify", "native.start_verification", mode="ask")])
    held = await decided(client, visitor, "native.start_verification", {"contact": "dana@example.com"})
    assert held.state == "held", held.reason_plain
    with lock_log(app) as log:
        assert (await answered(client, copy.owner, held.decision_id, "allow_once")).decision.state == "executed"
    assert log.transactions == [
        ["decisions", "executions", "ledger_heads"],                # the answer: approved, with its intent
        # T2 on the approved path: the held session's row FOR UPDATE, as an allow's, then the same rows
        ["sessions", "decisions", "executions", "people", "verification_challenges", "ledger_heads"],
    ]
    assert all(map(in_lock_order, log.transactions))


async def test_a_document_link_opens_in_the_lock_order(app, client):
    copy, _ = await visitor_of(app, client)
    dana = await confirmed(client, copy, DANA)
    await released(client, dana, (await documents(app, copy))["dana-invoice"])
    [link] = await links(app, copy)
    with lock_log(app) as log:
        assert (await open_link(client, link.token)).status_code == 200
    # one UPDATE marks the link opened, then its fact expires, then the open is ledgered
    assert log.transactions == [["document_links", "facts", "ledger_heads"]]
    assert all(map(in_lock_order, log.transactions))


async def test_removing_a_person_runs_in_the_lock_order(app, client):
    # Dana is verified in one session, her invoice's link is unopened, and a code is on its way to her
    copy, _ = await visitor_of(app, client)
    dana = await confirmed(client, copy, DANA)
    await released(client, dana, (await documents(app, copy))["dana-invoice"])
    await started(client, await open_visitor(client, copy), DANA)
    with lock_log(app) as log:
        await updated(client, copy, "people", {"remove": ["dana"]})
    # the owner's write holds the Desk row first (not a table of the order); then the session
    # verified as her, her row and her live code, her link, her invoice, their facts, and last the
    # session's close and the write, ledgered
    assert log.transactions == [["sessions", "people", "verification_challenges", "document_links", "documents",
                                 "facts", "ledger_heads"]]
    assert all(map(in_lock_order, log.transactions))


async def test_changing_a_contact_runs_in_the_lock_order(app, client):
    # Dana is verified in one session, her invoice's link is unopened, and a code is on its way to
    # her in another
    copy, _ = await visitor_of(app, client)
    dana = await confirmed(client, copy, DANA)
    await released(client, dana, (await documents(app, copy))["dana-invoice"])
    await started(client, await open_visitor(client, copy), DANA)
    with lock_log(app) as log:
        await updated(client, copy, "people", {"upsert": [{"ref": "dana", "display_name": "Dana Whitfield",
                                                           "contact": "dana.w@example.net"}]})
    # after the Desk row: the session verified as her, her row and her live code, her link and its
    # fact (her invoice stays hers), then the session's close and the write, ledgered
    assert log.transactions == [["sessions", "people", "verification_challenges", "document_links", "facts",
                                 "ledger_heads"]]
    assert all(map(in_lock_order, log.transactions))


async def test_a_right_code_verifies_in_the_lock_order(app, client):
    # a fresh session asks for a code as Dana, and checks the one her Demo inbox shows
    _, visitor = await visitor_of(app, client)
    [notice] = (await started(client, visitor, DANA)).inbox
    code = code_in(await entry_of(client, visitor, notice))
    with lock_log(app) as log:
        response = await check(client, visitor, code)
    assert (response.status_code, response.json()["verified"]) == (200, True), response.text
    # the session row FOR UPDATE, then Dana's row and her live code (consumed), then the facts the
    # session holds, relabelled for her (`labels.relabel_on_verify`; none in a fresh session, but the
    # lock is asked for), then its `verify` entry
    assert log.transactions == [["sessions", "people", "verification_challenges", "facts", "ledger_heads"]]
    assert all(map(in_lock_order, log.transactions))


async def test_deleting_a_desk_runs_in_the_lock_order(app, client):
    # Dana is verified in one session and her invoice's link is unopened
    copy, _ = await visitor_of(app, client)
    dana = await confirmed(client, copy, DANA)
    await released(client, dana, (await documents(app, copy))["dana-invoice"])
    with lock_log(app) as log:
        response = await client.delete(f"/desks/{copy.desk_id}", headers=copy.owner)
    assert response.status_code == 204, response.text
    # after the Desk row: its open sessions closed, its live codes cancelled (none, but the lock is
    # asked for), its payment links locked (none either), its document links voided in one UPDATE
    # (`ON_DELETE`), their facts expired, then the deletion ledgered
    assert log.transactions == [["sessions", "verification_challenges", "payment_links", "document_links", "facts",
                                 "ledger_heads"]]
    assert all(map(in_lock_order, log.transactions))


async def test_a_call_back_taking_over_a_card_handoff_runs_in_the_lock_order(app, client):
    _, visitor = await visitor_of(app, client)
    assert not (await checked(client, visitor, OTHER_LANGUAGE)).ok          # the card opens a handoff
    allowed = await decided(client, visitor, "native.request_callback", CALLBACK)
    with lock_log(app) as log:
        assert (await executed(client, visitor, allowed)).state == "succeeded"
    assert log.transactions == [
        ["sessions", "decisions", "executions"],                    # T1: the intent
        # T2, holding the session row FOR UPDATE (one open handoff per session): the open handoff, closed, and the
        # call-back's own, then their facts, then the closing's entry and the outcome
        ["sessions", "decisions", "executions", "handoffs", "facts", "ledger_heads"],
    ]


async def test_a_call_back_beside_several_open_ones_runs_in_the_lock_order(app, client, frozen_clock):
    copy, visitor = await visitor_of(app, client)
    older = await decided(client, visitor, "native.request_callback", CALLBACK, call_id="call-1")
    frozen_clock.advance(60)
    newer = await decided(client, visitor, "native.request_callback", CALLBACK, call_id="call-2")
    for handoff_id, decision in (("handoff-older", older), ("handoff-newer", newer)):   # from before, side by side
        await legacy_call_back(app, copy, visitor, handoff_id, decision.action.action_id)
    allowed = await decided(client, visitor, "native.request_callback", CALLBACK, call_id="call-3")
    with lock_log(app) as log:
        assert (await executed(client, visitor, allowed)).state == "succeeded"
    # T2 holds the session row FOR UPDATE, then the open handoffs FOR UPDATE, closed newest first, and the
    # call-back's own, then their facts, then the closings' entries and the outcome
    assert log.transactions[-1] == ["sessions", "decisions", "executions", "handoffs", "facts", "ledger_heads"]
    assert all(map(in_lock_order, log.transactions))


async def test_closing_a_handoff_runs_in_the_lock_order(app, client):
    copy, visitor = await visitor_of(app, client)
    handoff_id = (await callback(client, visitor)).model_view["handoff_id"]
    with lock_log(app, ("desks", *LOCK_ORDER)) as log:
        assert (await handoff_done(client, handoff_id, copy.owner)).status_code == 200
    # an owner's write to the Desk's data: the Desk row first, before any table of the order, then
    # the handoff (an adapter's own row), its fact, and the close, ledgered
    assert log.transactions == [["desks", "handoffs", "facts", "ledger_heads"]]
    assert all(in_lock_order(tables[1:]) for tables in log.transactions)


@pytest.mark.parametrize("how", ["takeover", "owner_message"])
async def test_the_owner_handling_a_conversation_closes_its_card_handoff_in_the_lock_order(app, client, how):
    copy, visitor = await visitor_of(app, client)
    assert not (await checked(client, visitor, OTHER_LANGUAGE)).ok          # the card's handoff opens
    with lock_log(app) as log:
        if how == "takeover":
            await set_mode(client, copy, visitor.session_id, "owner", 0)
        else:
            await sent(client, copy, visitor.session_id, "Hi, this is Mike.")
    # the session row the route holds, then the card's handoff and its fact (none), then the ledger head
    assert log.transactions == [["sessions", "handoffs", "facts", "ledger_heads"]]
    assert all(map(in_lock_order, log.transactions))


async def test_a_booking_runs_in_the_lock_order(app, client, reviewer):
    copy, visitor = await visitor_of(app, client)
    reviewer.answer = PASS
    allowed = await book(client, visitor, "S-20261102-1400")
    assert allowed.state == "allowed"
    with lock_log(app) as log:
        assert (await executed(client, visitor, allowed)).state == "succeeded"
    # T2 takes the slot it books (an adapter's own row) after the session, decision and execution
    t2 = [tables for tables in log.transactions if "calendar_slots" in tables]
    assert len(t2) == 1 and t2[0][:3] == ["sessions", "decisions", "executions"], log.transactions
    assert all(in_lock_order(tables) for tables in log.transactions), log.transactions


async def test_a_booking_closing_a_card_handoff_runs_in_the_lock_order(app, client, reviewer):
    _, visitor = await visitor_of(app, client)
    assert not (await checked(client, visitor, OTHER_LANGUAGE)).ok          # the card opens a handoff
    reviewer.answer = PASS
    allowed = await book(client, visitor, "S-20261102-1400")
    with lock_log(app) as log:
        assert (await executed(client, visitor, allowed)).state == "succeeded"
    # T2, holding the session row FOR UPDATE: the slot it books FOR SHARE and its booking (an adapter's own
    # rows), then the session's open card handoff, closed, then the facts (the handoff's, none, and the
    # booking's), then the closing's entry and the outcome
    t2 = [tables for tables in log.transactions if "calendar_slots" in tables]
    assert t2 == [["sessions", "decisions", "executions", "calendar_slots", "handoffs", "facts", "ledger_heads"]], (
        log.transactions)
    assert all(in_lock_order(tables) for tables in log.transactions), log.transactions


async def test_a_calendar_write_runs_in_the_lock_order(app, client):
    copy, _ = await visitor_of(app, client)
    slots = [slot_body(slot) for slot in await rows_of(app, copy.copy_id, select(CalendarSlot)
                                                       .order_by(CalendarSlot.slot_id))]
    with lock_log(app, ("desks", *LOCK_ORDER)) as log:
        await updated(client, copy, "calendar", {"calendar_slots": slots[1:]})
    # an owner's write to the Desk's data: the Desk row first, then the Desk's slots, then the entry
    assert log.transactions == [["desks", "calendar_slots", "ledger_heads"]], log.transactions


async def test_a_calendar_refresh_runs_in_the_lock_order(app, client):
    desk = await setup_desk(app, client, await rivera(app, client), setup_calendar(days_ago=11))
    on_slots: list[str] = []

    def slot_statement(conn, cursor, statement: str, parameters, context, executemany) -> None:
        if "kernel.calendar_slots" in statement:
            on_slots.append(" ".join(statement.split()))

    engine = app.state.kernel.engine.sync_engine
    event.listen(engine, "before_cursor_execute", slot_statement)
    try:
        with lock_log(app, ("desks", *(table for table in LOCK_ORDER if table != "calendar_slots"))) as log:
            assert list(await desks.extend_calendars(app.state.kernel)) == [desk.desk_id]
    finally:
        event.remove(engine, "before_cursor_execute", slot_statement)
    # the Desk row, as an owner's calendar write takes it, then the ledger head
    assert log.transactions == [["desks", "ledger_heads"]], log.transactions
    # the Desk's slots are only read, and the new ones inserted under fresh keys: no slot is locked
    read, *inserts = on_slots
    assert read.startswith("SELECT") and " FOR " not in read, read
    assert inserts and all(statement.startswith("INSERT") for statement in inserts), inserts


# ---- Plan 01c's payment paths ---------------------------------------------------------------------
# The same log over the real adapters and the mock payments server: a payment link issued and paid,
# a customer's charges listed and refunded, a demo agent's mandate charge, their reconciliation, an
# activation that cancels a link and a Desk's deletion that cancels one. Each transaction takes its
# rows in the kernel's order.

async def test_a_payment_link_is_issued_and_paid_in_the_lock_order(app, client, reviewer):
    copy = await rivera(app, client)
    visitor = await open_visitor(client, copy)
    reviewer.answer = LINK_PASS
    decision = await link_for(client, visitor, await quoted(client, visitor, ("deposit", 1)))
    assert decision.outcome == "allow", decision.reason_plain
    with lock_log(app) as issued:
        assert (await executed(client, visitor, decision)).state == "succeeded"
    assert issued.transactions == [
        ["sessions", "decisions", "executions"],                    # T1: the intent
        # T2: the active version FOR SHARE, the quote FOR UPDATE before the new link, then its fact and
        # the ledger head
        ["sessions", "decisions", "executions", "policy_versions", "quotes", "payment_links", "facts",
         "ledger_heads"],
    ]
    assert all(map(in_lock_order, issued.transactions))
    [link] = await rows_of(app, copy.copy_id, select(PaymentLink))
    with lock_log(app) as paid:
        assert (await completed(client, link.token)).state == "paid"
    assert paid.transactions == [
        ["payment_links"],                                          # C1: the marker
        # C2: the quote before the link, then paid, its fact and its verdict
        ["sessions", "quotes", "payment_links", "facts", "ledger_heads"],
    ]
    assert all(map(in_lock_order, paid.transactions))


async def test_a_charge_listing_and_an_approved_refund_keep_the_lock_order(app, client):
    copy = await rivera(app, client)
    dana_id = await person_of(app, copy, "dana")
    [(charge_id, _, _), *_] = provider_charges(copy, dana_id)
    dana = await confirmed(client, copy, DANA)
    listing = await decided(client, dana, LIST, {}, call_id="call-list")
    assert listing.outcome == "allow", listing.reason_plain
    with lock_log(app) as listed:
        assert (await executed(client, dana, listing)).state == "succeeded"
    assert listed.transactions == [
        ["sessions", "decisions", "executions"],                    # T1: the intent
        # T2, the tool's pin checked on the way, then the charges' facts
        ["sessions", "decisions", "executions", "facts", "ledger_heads"],
    ]
    assert all(map(in_lock_order, listed.transactions))
    held = await decided(client, dana, REFUND, {"charge_id": charge_id}, call_id="call-refund")
    assert held.outcome == "hold", held.reason_plain
    with lock_log(app) as refunded:
        result = await answered(client, copy.owner, held.decision_id, "allow_once")
    assert (result.decision.state, result.execution.state) == ("executed", "succeeded")
    assert refunded.transactions == [
        ["decisions", "executions", "ledger_heads"],                # the answer: approved, with its intent
        # T2 on the approved path: the session row FOR SHARE first, as on an allow's
        ["sessions", "decisions", "executions", "facts", "ledger_heads"],
    ]
    assert all(map(in_lock_order, refunded.transactions))


async def test_an_agents_mandate_charge_runs_in_the_lock_order(app, client, frozen_clock):
    setup = await rivera_agent(app, client, frozen_clock)
    signed = setup.turn()
    decision = await asked(client, signed, CHARGE, await agent_quoted(client, signed))
    assert decision.outcome == "allow", decision.reason_plain
    with lock_log(app) as charged_log:
        assert (await executed(client, signed, decision)).state == "succeeded"
    # the mandate's reservation is the adapter's own row (step 10), taken in T1 before the intent's insert
    assert charged_log.transactions == [
        ["sessions", "decisions", "executions"],                    # T1: the reservation and the intent
        # T2: the quote FOR UPDATE across the charge, then the quote paid, the spend committed, the
        # charge's fact
        ["sessions", "decisions", "executions", "quotes", "facts", "ledger_heads"],
    ]
    assert all(map(in_lock_order, charged_log.transactions))


async def test_payment_reconciliation_keeps_the_lock_order(app, client, reviewer, mockpay):
    copy = await rivera(app, client)
    visitor = await open_visitor(client, copy)
    reviewer.answer = LINK_PASS
    # a link issue the provider answers too late: its execution is unknown, and a read settles it
    decision = await link_for(client, visitor, await quoted(client, visitor, ("deposit", 1)))
    await delay(mockpay, copy, "checkout", 3)
    assert (await executed(client, visitor, decision)).state == "unknown"
    await landed(copy, decision.action.action_id)
    with lock_log(app) as issue:
        assert (await read(client, visitor.headers, decision)).state == "executed"
    assert issue.transactions == [
        # the decision and the execution SKIP LOCKED, then the issue's own rows (the quote NOWAIT before
        # the link), then the ledger head
        ["decisions", "executions", "policy_versions", "quotes", "payment_links", "facts", "ledger_heads"],
        ["decisions"],      # committed at once; the read goes on holding the decision again
    ]
    assert all(map(in_lock_order, issue.transactions))
    # a completion the provider answers too late: the link is unknown, and a view settles it
    [link] = await rows_of(app, copy.copy_id, select(PaymentLink))
    await delay(mockpay, copy, "complete", 3)
    assert (await completed(client, link.token)).state == "unknown"
    await charged(copy, f"{link.action_id}:charge")
    with lock_log(app) as completion:
        assert (await view(client, link.token)).state == "paid"
    # the quote SKIP LOCKED before the link, since settling it records the payment
    assert completion.transactions == [["quotes", "payment_links", "facts", "ledger_heads"]]
    assert all(map(in_lock_order, completion.transactions))


@pytest.mark.solver
async def test_an_activation_cancels_a_link_in_the_lock_order(desk_prove, app, client, reviewer):
    copy = await rivera(app, client)
    visitor = await open_visitor(client, copy)
    over = await rv_link(app, client, reviewer, copy, visitor, ("heater", 2), call_id="call-over")   # $300, auto
    response = await post_draft(client, copy, rivera_cards(link=RV_LINK_100), 1, auto_money_cap_cents=10_000)
    assert response.status_code == 200, response.text
    version = PolicyVersionContract.model_validate(response.json())
    with lock_log(app) as activation:
        await confirm(client, copy, version.version)
    # the active version and the draft, then the links it cancels, their facts, then the ledger head
    assert activation.transactions == [["policy_versions", "payment_links", "facts", "ledger_heads"]]
    assert all(map(in_lock_order, activation.transactions))
    [link] = await rows_of(app, copy.copy_id, select(PaymentLink).where(PaymentLink.link_id == over.link_id))
    assert (link.state, link.cancel_reason) == ("cancelled", "rules_changed")


async def test_deleting_a_desk_cancels_its_payment_links_in_the_lock_order(app, client, reviewer):
    # a visitor's payment link is issued, and Dana's invoice link is unopened
    copy = await rivera(app, client)
    visitor = await open_visitor(client, copy)
    reviewer.answer = LINK_PASS
    decision = await link_for(client, visitor, await quoted(client, visitor, ("deposit", 1)))
    assert (await executed(client, visitor, decision)).state == "succeeded"
    dana = await confirmed(client, copy, DANA)
    await released(client, dana, (await documents(app, copy))["dana-invoice"])
    with lock_log(app) as log:
        response = await client.delete(f"/desks/{copy.desk_id}", headers=copy.owner)
    assert response.status_code == 204, response.text
    # the payment link is locked before the document link (`payments.lock_desk_links`), and both
    # links' facts expire after them, then the cancellation and the deletion are ledgered
    assert log.transactions == [["sessions", "verification_challenges", "payment_links", "document_links", "facts",
                                 "ledger_heads"]]
    assert all(map(in_lock_order, log.transactions))
    [link] = await rows_of(app, copy.copy_id, select(PaymentLink))
    assert link.state == "cancelled"
