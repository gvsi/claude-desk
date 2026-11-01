"""POST /execute: an allowed action runs once, intent first, as its own session.

Decisions come from `/decide` as the API sends them, on a Turner Plumbing copy (the native quote
and booking adapters) or on a Desk of scripted adapters (`FakeAdapter`). Each test then calls
`/execute` and reads the decision back through `GET /decisions/{decision_id}`, which settles an
orphaned intent as a read does.
"""

import asyncio
import inspect
import logging

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from desk.contracts import Claim, Decision, ExecResult, Fact, InboxNotice, Label, Review
from desk.db import logs
from desk.db.models import Decision as DecisionRow
from desk.db.models import DemoInboxEntry, Document, Execution, NotificationPref, Person, PriceItem, Quote, Tool
from desk.kernel_service import demo_inbox, execute, ledger
from desk.kernel_service.adapters.base import AdapterFailure, AdapterRefusal, AdapterResult, AdapterUnknown
from desk.kernel_service.app import create_app
from desk.kernel_service.seed import RIVERA_CARDS

from .fakes import FakeAdapter
from .helpers import CopyRows, activate_cards, kernel_ctx, ledger_rows, make_copy_rows, rows_of, verify_session
from .test_adapters import Rivera, book, quote_args, visitor_of
from .test_compiler import card
from .test_decide import PASS, Visitor, decided, desk_with, open_visitor, owner_decide, set_mode, verify_signature


async def post_execute(client: httpx.AsyncClient, visitor: Visitor, decision: Decision, *, generation: int = 0,
                       session_id: str | None = None, headers: dict[str, str] | None = None) -> httpx.Response:
    return await client.post("/execute", headers=headers if headers is not None else visitor.headers, json={
        "decision_id": decision.decision_id, "session_id": session_id or visitor.session_id, "generation": generation})


async def executed(client: httpx.AsyncClient, visitor: Visitor, decision: Decision, **kwargs) -> ExecResult:
    response = await post_execute(client, visitor, decision, **kwargs)
    assert response.status_code == 200, response.text
    return ExecResult.model_validate(response.json())


async def read(client: httpx.AsyncClient, headers: dict[str, str], decision: Decision) -> Decision:
    response = await client.get(f"/decisions/{decision.decision_id}", headers=headers)
    assert response.status_code == 200, response.text
    return Decision.model_validate(response.json())


async def executions_of(app: FastAPI, copy_id: str) -> list[Execution]:
    return await rows_of(app, copy_id, select(Execution).order_by(Execution.started_at, Execution.action_id))


async def test_an_allow_executes_once_within_a_minute(app, client, frozen_clock):
    copy, visitor = await visitor_of(app, client)
    allowed = await decided(client, visitor, "native.quote", quote_args(("drain", 1)))
    assert (allowed.outcome, allowed.state) == ("allow", "allowed")
    frozen_clock.advance(59)                                                    # still inside its minute
    result = await executed(client, visitor, allowed)

    [quote] = await rows_of(app, copy.copy_id, select(Quote))
    [fact] = result.facts
    assert (result.action_id, result.state, quote.action_id) == (
        allowed.action.action_id, "succeeded", allowed.action.action_id)
    assert (fact.fact_id, fact.label.readers) == (f"quote:{quote.quote_id}", ["owner", f"session:{visitor.session_id}"])
    assert result.model_view == {"fact_id": fact.fact_id, "quote_id": quote.quote_id, "status": "available",
                                 "items": [{"item_id": "drain", "title": "Drain clearing", "qty": 1}]}
    [execution] = await executions_of(app, copy.copy_id)
    assert (execution.decision_id, execution.state, execution.result) == (allowed.decision_id, "succeeded", result)
    assert execution.started_at == execution.finished_at == frozen_clock.now()

    # the decision is executed, ledgered and signed again
    decision = await read(client, visitor.headers, allowed)
    assert (decision.state, decision.visitor_plain) == ("executed", "Quoted from Mike Turner's price list")
    assert decision.ledger_seq > allowed.ledger_seq
    verify_signature((await client.get("/health")).json()["public_key_hex"], decision)
    [entry] = [e for e in await ledger_rows(app, copy) if e.seq == decision.ledger_seq]
    assert (entry.event.kind, entry.event.session_id, entry.event.ref_id, entry.event.summary) == (
        "execute", visitor.session_id, allowed.decision_id,
        {"decision_id": allowed.decision_id, "action_id": allowed.action.action_id, "state": "executed",
         "policy_version": 1, "auto_money_cap_cents": 50_000})                # the rules step 6 checked it against


async def test_an_allow_expires_after_sixty_seconds(app, client, frozen_clock):
    copy, visitor = await visitor_of(app, client)
    allowed = await decided(client, visitor, "native.quote", quote_args(("drain", 1)))
    frozen_clock.advance(61)
    response = await post_execute(client, visitor, allowed)
    assert (response.status_code, response.json()) == (409, {"code": "conflict"})
    assert await rows_of(app, copy.copy_id, select(Quote)) == []
    assert await executions_of(app, copy.copy_id) == []
    decision = await read(client, visitor.headers, allowed)
    assert (decision.state, decision.visitor_plain) == ("expired", "This request timed out")
    # the expiry and the refused run are both on record
    entries = [(e.event.kind, e.event.summary) for e in await ledger_rows(app, copy) if e.seq > allowed.ledger_seq]
    assert entries == [("decide", {"decision_id": allowed.decision_id, "state": "expired"}),
                       ("execute", {"decision_id": allowed.decision_id, "refused": "expired"})]


async def test_an_allow_from_an_old_generation_expires(app, client):
    copy, visitor = await visitor_of(app, client)
    allowed = await decided(client, visitor, "native.quote", quote_args(("drain", 1)))
    assert (await set_mode(client, copy, visitor.session_id, "owner", 0))["generation"] == 1   # Mike takes over
    for generation in (0, 1):            # the API's old generation, or the new one: the allow is from generation 0
        response = await post_execute(client, visitor, allowed, generation=generation)
        assert (response.status_code, response.json()) == (409, {"code": "stale_generation"})
    assert await rows_of(app, copy.copy_id, select(Quote)) == []
    assert await executions_of(app, copy.copy_id) == []
    decision = await read(client, copy.owner, allowed)
    assert (decision.state, decision.visitor_plain) == ("expired", "This request timed out")
    entries = [(e.event.kind, e.event.session_id, e.event.summary) for e in await ledger_rows(app, copy)
               if e.event.kind in ("auth", "execute")]
    assert entries == [
        ("auth", visitor.session_id, {"route": "POST /execute", "reason": "stale_generation"}),
        ("execute", visitor.session_id, {"decision_id": allowed.decision_id, "action_id": allowed.action.action_id,
                                         "state": "expired", "reason": "stale_generation"}),
        ("auth", visitor.session_id, {"route": "POST /execute", "reason": "stale_generation"}),   # expired once
    ]


async def test_a_repeat_returns_the_stored_result(app, client, reviewer):
    copy, visitor = await visitor_of(app, client)
    allowed = await decided(client, visitor, "native.quote", quote_args(("drain", 1)))
    first = await executed(client, visitor, allowed)
    settled = await read(client, visitor.headers, allowed)
    again = await executed(client, visitor, allowed)                            # a retry after a lost answer
    assert again == first and len(await rows_of(app, copy.copy_id, select(Quote))) == 1
    assert await read(client, visitor.headers, allowed) == settled              # the decision didn't change
    [repeat] = [e.event for e in await ledger_rows(app, copy) if e.seq > settled.ledger_seq]
    # the repeat names the version and money cap the execution was checked under, as its row has them
    assert (repeat.kind, repeat.summary) == ("execute", {
        "decision_id": allowed.decision_id, "action_id": allowed.action.action_id, "repeat": True,
        "policy_version": 1, "auto_money_cap_cents": 50_000})

    # a failed execution repeats its failure: two visitors were allowed one slot, the second lost it
    reviewer.answer = PASS
    second = await open_visitor(client, copy)
    first_booking, lost = [await book(client, someone, "S-20261102-1000") for someone in (visitor, second)]
    assert (await executed(client, visitor, first_booking)).state == "succeeded"
    failed = await executed(client, second, lost)
    assert failed == ExecResult(action_id=lost.action.action_id, state="failed", facts=[], model_view={})
    assert await executed(client, second, lost) == failed
    assert (await read(client, second.headers, lost)).state == "failed"


async def test_a_bookings_owner_alert_reaches_only_the_owners_inbox(app, client, reviewer):
    """An owner alert never rides in the visitor's result, whose `inbox` holds only a code notice:
    the owner reads it from `GET /demo_inbox`."""
    reviewer.answer = PASS
    copy, visitor = await visitor_of(app, client)
    async with kernel_ctx(app) as ctx:                                          # Mike wants bookings at once
        ctx.bind(copy.copy_id)
        prefs = (await ctx.db.scalars(ctx.repo.scoped(select(NotificationPref)))).one()
        prefs.now = [*prefs.now, "booking"]
    result = await executed(client, visitor, await book(client, visitor, "S-20261102-1000"))
    assert (result.state, result.inbox) == ("succeeded", [])
    response = await client.get("/demo_inbox", headers=copy.owner)
    assert response.status_code == 200, response.text
    assert [(entry["to"], entry["kind"], entry["body"]) for entry in response.json()
            if " booked " in entry["body"]] == [
        ("owner", "alert", "A stranger booked Monday, November 2, from 10:00 am to 12:00 pm.")]


async def test_an_owner_notice_never_rides_in_the_result(app, client, registry, caplog):
    """Whatever an adapter returns, the result a session reads holds no notice addressed to the
    owner: it is dropped, and logged by its kind alone, never its entry or preview."""
    caplog.set_level(logging.INFO, logger="desk.kernel_service")
    quote, rows, visitor, allowed = await fake_quote_desk(app, client)
    code = InboxNotice(entry_id="inbox-code", to="d•••@example.com", preview="New verification code")
    alert = InboxNotice(entry_id="inbox-alert", to="owner", preview="A stranger booked Monday at 10:00 am")
    quote.script["execute"] = AdapterResult(model_view={"ok": True}, inbox=[alert, code])
    result = await executed(client, visitor, allowed)
    assert (result.state, result.model_view, result.inbox) == ("succeeded", {"ok": True}, [code])
    assert await executed(client, visitor, allowed) == result                   # stored as the session saw it
    assert [record.getMessage() for record in caplog.records if "notice" in record.getMessage()] == [
        "inbox_notice_dropped to=owner tool=native.quote"]
    assert "inbox-alert" not in caplog.text and "booked" not in caplog.text


async def activate(app: FastAPI, copy: Rivera, cards) -> None:
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        await activate_cards(ctx, copy.desk_id, cards)


async def test_rules_changed_refuses_at_execution(app, client):
    copy, visitor = await visitor_of(app, client)
    allowed = await decided(client, visitor, "native.quote", quote_args(("drain", 1)))
    # Mike stops quotes between the decision and its execution
    await activate(app, copy, [c for c in RIVERA_CARDS if c.card_id != "rv-quote"]
                   + [card("no-quotes", "native.quote", mode="never")])
    response = await post_execute(client, visitor, allowed)
    assert (response.status_code, response.json()) == (409, {"code": "conflict"})
    assert await rows_of(app, copy.copy_id, select(Quote)) == []
    assert await executions_of(app, copy.copy_id) == []                        # nothing ran, no intent
    decision = await read(client, visitor.headers, allowed)
    assert (decision.state, decision.visitor_plain) == (
        "refused_at_execution", "The rules changed, so this didn't go ahead")
    verify_signature((await client.get("/health")).json()["public_key_hex"], decision)
    [entry] = [e.event for e in await ledger_rows(app, copy) if e.seq == decision.ledger_seq]
    assert (entry.kind, entry.summary) == ("execute", {
        "decision_id": allowed.decision_id, "action_id": allowed.action.action_id, "state": "refused_at_execution",
        "reason": "rules_changed", "check": "policy", "policy_version": 2, "auto_money_cap_cents": 50_000})
    # it stays refused
    response = await post_execute(client, visitor, allowed)
    assert (response.status_code, response.json()) == (409, {"code": "conflict"})


async def test_a_paused_session_cannot_execute_an_allow(app, client, reviewer):
    copy, visitor = await visitor_of(app, client)
    allowed = await decided(client, visitor, "native.quote", quote_args(("drain", 1)))
    reviewer.answer = Review(within_charter_bp=1000, manipulation_bp=9500, recommendation="block")
    for n in range(3):                                                          # three strikes pause the session
        await book(client, visitor, "S-20261102-1000", call_id=f"call-push-{n}")
    response = await post_execute(client, visitor, allowed)
    assert (response.status_code, response.json()) == (409, {"code": "mode_paused"})
    assert await rows_of(app, copy.copy_id, select(Quote)) == []
    assert await executions_of(app, copy.copy_id) == []
    assert (await read(client, visitor.headers, allowed)).state == "allowed"   # left to expire
    [refusal] = [e.event for e in await ledger_rows(app, copy) if e.event.kind == "auth"]
    assert (refusal.session_id, refusal.summary) == (visitor.session_id, {"route": "POST /execute",
                                                                          "reason": "mode_paused"})


async def committed(app: FastAPI, copy_id: str, action_id: str) -> tuple[str | None, str]:
    """The execution and decision states another transaction sees for an action."""
    [execution] = await rows_of(app, copy_id, select(Execution).where(Execution.action_id == action_id)) or [None]
    [decision] = await rows_of(app, copy_id, select(DecisionRow).where(DecisionRow.action_id == action_id))
    return (execution.state if execution else None), decision.state


async def test_intent_is_written_before_the_side_effect(app, client, registry):
    quote = FakeAdapter("native.quote")
    rows = await desk_with(app, [quote], [card("quote", "native.quote")])
    visitor = await open_visitor(client, rows)
    allowed = await decided(client, visitor, "native.quote", {"qty": 1})
    seen = []

    async def side_effect(xctx, action, args) -> AdapterResult:
        seen.append(await committed(app, rows.copy_id, action.action_id))      # what a crash here would leave
        return AdapterResult(model_view={"ok": True})

    quote.script["execute"] = side_effect
    assert (await committed(app, rows.copy_id, allowed.action.action_id)) == (None, "allowed")
    result = await executed(client, visitor, allowed)
    assert seen == [("intent", "allowed")]
    assert (result.state, result.model_view) == ("succeeded", {"ok": True})
    assert (await committed(app, rows.copy_id, allowed.action.action_id)) == ("succeeded", "executed")
    assert quote.calls == ["normalize", "normalize", "prepare", "execute"]     # decided, re-checked, run


class Crash(BaseException):
    """The kernel process dying mid-request: its handlers catch `Exception` only, so nothing records it."""


def crash(*args, **kwargs):
    raise Crash("the kernel died")


async def fake_quote_desk(app: FastAPI, client: httpx.AsyncClient) -> tuple[FakeAdapter, CopyRows, Visitor, Decision]:
    """A Desk whose quotes a scripted adapter runs, a visitor on it and one of its allows."""
    quote = FakeAdapter("native.quote")
    rows = await desk_with(app, [quote], [card("quote", "native.quote")])
    visitor = await open_visitor(client, rows)
    return quote, rows, visitor, await decided(client, visitor, "native.quote", {"qty": 1})


async def leave_an_intent(app: FastAPI, client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch, how: str,
                          visitor: Visitor, allowed: Decision, copy_id: str) -> None:
    """An intent row with no result, as a kernel that died after T1 leaves it: written directly
    ("stored"), or by an execution that dies right after its intent commits ("crash")."""
    if how == "stored":
        async with kernel_ctx(app) as ctx:
            ctx.bind(copy_id)
            ctx.db.add(Execution(action_id=allowed.action.action_id, copy_id=copy_id, decision_id=allowed.decision_id,
                                 state="intent", started_at=ctx.clock.now()))
        return
    with monkeypatch.context() as patch:
        patch.setattr(execute, "_after_intent", crash)
        with pytest.raises(Crash):
            await post_execute(client, visitor, allowed)


@pytest.mark.parametrize("how", ["stored", "crash"])
async def test_an_orphaned_intent_reconciles_to_failed(app, client, registry, frozen_clock, monkeypatch, how):
    quote, rows, visitor, allowed = await fake_quote_desk(app, client)
    copy_id = rows.copy_id
    await leave_an_intent(app, client, monkeypatch, how, visitor, allowed, copy_id)
    # neither failed nor unknown: nothing recorded what happened after the intent
    assert await committed(app, copy_id, allowed.action.action_id) == ("intent", "allowed")
    assert "execute" not in quote.calls
    frozen_clock.advance(31)                                                    # no execution is running it now
    decision = await read(client, visitor.headers, allowed)
    assert (decision.state, decision.visitor_plain) == ("failed", "That didn't go through")
    assert quote.calls[-2:] == ["reconcile", "on_failed"]                       # it never ran, so nothing to keep
    stored = await executed(client, visitor, allowed)
    assert stored == ExecResult(action_id=allowed.action.action_id, state="failed", facts=[], model_view={})
    assert await committed(app, copy_id, allowed.action.action_id) == ("failed", "failed")
    entries = [e.event.summary for e in await ledger_rows(app, rows)
               if e.event.kind == "execute"]
    base = {"decision_id": allowed.decision_id, "action_id": allowed.action.action_id}
    # an intent T1 wrote names the version its re-check ran under, and so does a repeat of it; one
    # written without it (as before the executions row recorded it) names none
    checked = {"policy_version": 1, "auto_money_cap_cents": 50_000} if how == "crash" else {}
    assert entries == [{**base, **checked, "state": "unknown", "orphaned": True},
                       {**base, **checked, "state": "failed", "reconciled": True}, {**base, **checked, "repeat": True}]


async def test_an_orphan_with_its_side_effect_reconciles_to_executed(app, client, registry, frozen_clock):
    quote, rows, visitor, allowed = await fake_quote_desk(app, client)
    effects = []                                                                # what the outside world saw

    def side_effect_then_crash(xctx, action, args):
        effects.append(action.action_id)
        raise Crash("the kernel died after the side effect")

    def what_happened(xctx, action) -> AdapterResult | None:
        return AdapterResult(model_view={"ok": True, "raw": "provider text"}) if action.action_id in effects else None

    quote.script.update(execute=side_effect_then_crash, reconcile=what_happened)
    with pytest.raises(Crash):
        await post_execute(client, visitor, allowed)
    assert await committed(app, rows.copy_id, allowed.action.action_id) == ("intent", "allowed")
    frozen_clock.advance(31)
    decision = await read(client, visitor.headers, allowed)
    assert (decision.state, decision.visitor_plain) == ("executed", "Quoted from Mike Turner's price list")
    expected = ExecResult(action_id=allowed.action.action_id, state="succeeded", facts=[], model_view={"ok": True})
    assert await executed(client, visitor, allowed) == expected                 # rebuilt as the session may see it
    assert effects == [allowed.action.action_id] and "on_failed" not in quote.calls
    assert quote.calls.count("reconcile") == 1                                  # settled once


@pytest.mark.parametrize("outcome", ["executed", "failed", "unknown"])
@pytest.mark.parametrize("how", ["crash", "error"])
@pytest.mark.parametrize("path", ["allow", "approved"])
async def test_reconciled_entries_name_the_version_their_check_ran_under(app, client, registry, frozen_clock, path,
                                                                         how, outcome):
    quote = FakeAdapter("native.quote")
    rows = await desk_with(app, [quote], [card("quote", "native.quote", mode="auto" if path == "allow" else "ask")])
    visitor = await open_visitor(client, rows)
    decision = await decided(client, visitor, "native.quote", {"qty": 1})       # under version 1, at $500
    assert decision.state == ("allowed" if path == "allow" else "held")

    def side_effect_then_lost(xctx, action, args):
        # the kernel dies after the side effect (an intent is left), or loses the provider's answer (unknown)
        raise Crash("the kernel died") if how == "crash" else RuntimeError("the provider's answer was lost")

    seen = []

    def what_happened(xctx, action) -> AdapterResult | None:
        seen.append(("reconcile", xctx.recheck_version))
        if outcome == "unknown":
            raise AdapterUnknown("the provider can't say yet")
        return AdapterResult(model_view={"ok": True}) if outcome == "executed" else None

    def undone(xctx, action) -> None:
        seen.append(("on_failed", xctx.recheck_version))

    quote.script.update(execute=side_effect_then_lost, reconcile=what_happened, on_failed=undone)
    run = (post_execute(client, visitor, decision) if path == "allow" else
           client.post(f"/approvals/{decision.decision_id}/answer", headers=rows.owner, json={"answer": "allow_once"}))
    if how == "crash":
        with pytest.raises(Crash):
            await run
    else:
        assert (await run).status_code == 200
    [execution] = await executions_of(app, rows.copy_id)
    assert (execution.policy_version, execution.auto_money_cap_cents) == (1, 50_000)   # what T1 checked against

    # the rules change, at another cap, before anything reconciles it
    async with kernel_ctx(app) as ctx:
        ctx.bind(rows.copy_id)
        await activate_cards(ctx, rows.desk_id, [card("quote", "native.quote")], auto_money_cap_cents=10_000)
    frozen_clock.advance(31)
    assert (await read(client, visitor.headers, decision)).state == outcome
    # every entry names the version and cap the execution was checked under, not the ones active now
    base = {"decision_id": decision.decision_id, "action_id": decision.action.action_id, "policy_version": 1,
            "auto_money_cap_cents": 50_000}
    lost = {**base, "state": "unknown", "orphaned": True} if how == "crash" else {**base, "state": "unknown"}
    settled = [] if outcome == "unknown" else [{**base, "state": outcome, "reconciled": True}]
    assert [e.event.summary for e in await ledger_rows(app, rows) if e.event.kind == "execute"] == [lost, *settled]
    # while the adapter, asked with no re-check run, is given no version to take for one
    assert seen == [("reconcile", None), *([("on_failed", None)] if outcome == "failed" else [])]


def test_an_intent_is_never_written_without_the_check_it_passed():
    """`prepare_intent` takes the version and money cap its re-check passed under as a required
    keyword, so a caller can't write an intent row that names none by leaving them out."""
    checked = inspect.signature(execute.prepare_intent).parameters["checked"]
    assert (checked.kind, checked.default) == (inspect.Parameter.KEYWORD_ONLY, inspect.Parameter.empty)


@pytest.mark.parametrize("outcome", ["executed", "failed", "unknown"])
async def test_an_approved_run_given_no_check_names_its_rows(app, client, registry, monkeypatch, outcome):
    """T2 and T3 name the version and money cap the execution row recorded at T1 when the caller
    passes none, so no entry goes without them while its row holds them."""
    quote = FakeAdapter("native.quote")
    rows = await desk_with(app, [quote], [card("quote", "native.quote", mode="ask")])
    visitor = await open_visitor(client, rows)
    held = await decided(client, visitor, "native.quote", {"qty": 1})            # under version 1, at $500
    quote.script["execute"] = {"executed": AdapterResult(model_view={"ok": True}), "failed": AdapterFailure("declined"),
                               "unknown": RuntimeError("the provider's answer was lost")}[outcome]
    run_approved = execute.run_approved

    async def given_no_check(ctx, decision_row, *, checked=None) -> ExecResult:
        return await run_approved(ctx, decision_row)

    monkeypatch.setattr(execute, "run_approved", given_no_check)
    response = await client.post(f"/approvals/{held.decision_id}/answer", headers=rows.owner,
                                 json={"answer": "allow_once"})
    assert response.status_code == 200, response.text
    [entry] = [e.event.summary for e in await ledger_rows(app, rows) if e.event.kind == "execute"]
    assert (entry["state"], entry["policy_version"], entry["auto_money_cap_cents"]) == (outcome, 1, 50_000), entry


async def test_a_fresh_intent_is_left_alone(app, client, registry, frozen_clock, monkeypatch):
    quote, rows, visitor, allowed = await fake_quote_desk(app, client)
    await leave_an_intent(app, client, monkeypatch, "crash", visitor, allowed, rows.copy_id)
    frozen_clock.advance(29)                                     # it may still be running somewhere: don't touch it
    assert (await read(client, visitor.headers, allowed)).state == "allowed"
    response = await post_execute(client, visitor, allowed)
    assert (response.status_code, response.json()) == (409, {"code": "conflict"})   # never a second run
    assert await committed(app, rows.copy_id, allowed.action.action_id) == ("intent", "allowed")
    assert "reconcile" not in quote.calls and "execute" not in quote.calls
    [refused] = [e.event.summary for e in await ledger_rows(app, rows) if e.event.kind == "execute"]
    assert refused == {"decision_id": allowed.decision_id, "refused": "intent"}
    frozen_clock.advance(2)                                                     # past the window it is an orphan
    assert (await read(client, visitor.headers, allowed)).state == "failed"


async def store_intent(app: FastAPI, copy_id: str, decision: Decision) -> None:
    """An intent row left by a kernel that died, started now."""
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy_id)
        ctx.db.add(Execution(action_id=decision.action.action_id, copy_id=copy_id, decision_id=decision.decision_id,
                             state="intent", started_at=ctx.clock.now()))


async def test_startup_reconciles_only_old_unlocked_intents(app, client, registry, reviewer, frozen_clock):
    quote, rows, visitor, old = await fake_quote_desk(app, client)
    fresh, running = [await decided(client, visitor, "native.quote", {"qty": n}, call_id=f"call-{n}") for n in (2, 3)]
    entered, release = asyncio.Event(), asyncio.Event()

    async def slow(xctx, action, args) -> AdapterResult:
        entered.set()
        await release.wait()                                                    # a provider taking its time
        return AdapterResult(model_view={"ok": True})

    quote.script["execute"] = slow
    await store_intent(app, rows.copy_id, old)
    execution = asyncio.create_task(post_execute(client, visitor, running))
    try:
        await asyncio.wait_for(entered.wait(), 10)
        frozen_clock.advance(31)                                # the running one's intent is as old as the orphan
        await store_intent(app, rows.copy_id, fresh)

        restarted = create_app(clock=frozen_clock, decisions=reviewer)          # a second kernel task starting up
        # its startup reconciliation skips the running execution's locked row rather than waiting on it
        async with asyncio.timeout(10), restarted.router.lifespan_context(restarted):
            pass
        assert await committed(app, rows.copy_id, old.action.action_id) == ("failed", "failed")
        assert await committed(app, rows.copy_id, fresh.action.action_id) == ("intent", "allowed")
        assert await committed(app, rows.copy_id, running.action.action_id) == ("intent", "allowed")
        assert quote.calls.count("reconcile") == 1                              # the old orphan's alone
    finally:
        release.set()                                           # never left holding the execution's rows
    response = await asyncio.wait_for(execution, 10)
    assert response.status_code == 200, response.text
    assert ExecResult.model_validate(response.json()).state == "succeeded"
    assert await committed(app, rows.copy_id, running.action.action_id) == ("succeeded", "executed")


async def reservations(app: FastAPI, copy_id: str) -> list[str]:
    """What the scripted `prepare` reserved and kept, as committed rows (Demo inbox entries stand in)."""
    return [row.body for row in await rows_of(app, copy_id, select(DemoInboxEntry).where(
        DemoInboxEntry.preview == "Reserved").order_by(DemoInboxEntry.body))]


async def test_execution_hooks_follow_the_seam(app, client, registry, frozen_clock, monkeypatch):
    quote, rows, visitor, first = await fake_quote_desk(app, client)
    copy_id = rows.copy_id

    async def reserve(xctx, action) -> None:
        await demo_inbox.deliver(xctx.ctx, copy_id=action.copy_id, desk_id=action.desk_id, to="owner", person_id=None,
                                 kind="alert", body=action.action_id, preview="Reserved")

    async def allow(n: int) -> Decision:
        quote.calls.clear()
        return await decided(client, visitor, "native.quote", {"qty": n}, call_id=f"call-{n}")

    # prepare's rows commit with the intent row, before the side effect
    seen = []

    async def look(xctx, action, args) -> AdapterResult:
        seen.append((await reservations(app, copy_id), await committed(app, copy_id, action.action_id)))
        return AdapterResult(model_view={"ok": True})

    quote.script.update(prepare=reserve, execute=look)
    assert (await executed(client, visitor, first)).state == "succeeded"
    assert seen == [([first.action.action_id], ("intent", "allowed"))]

    # a prepare refusal: refused at execution, what it wrote taken back, no intent, nothing run
    async def reserve_then_refuse(xctx, action) -> None:
        await reserve(xctx, action)
        raise AdapterRefusal("no room")

    quote.script["prepare"] = reserve_then_refuse
    refused = await allow(2)
    response = await post_execute(client, visitor, refused)
    assert (response.status_code, response.json()) == (409, {"code": "conflict"})
    assert await committed(app, copy_id, refused.action.action_id) == (None, "refused_at_execution")
    assert await reservations(app, copy_id) == [first.action.action_id]
    assert "execute" not in quote.calls

    # an outcome nobody knows is unknown, with the reservation kept and on_failed not called
    quote.script["prepare"] = reserve
    for n, error in ((3, AdapterUnknown("timed out")), (4, RuntimeError("bad provider output"))):
        unknown = await allow(n)
        quote.script["execute"] = error
        assert await executed(client, visitor, unknown) == ExecResult(
            action_id=unknown.action.action_id, state="unknown", facts=[], model_view={})
        assert await committed(app, copy_id, unknown.action.action_id) == ("unknown", "unknown")
        assert quote.calls[-1] == "execute" and "on_failed" not in quote.calls, error
        assert unknown.action.action_id in await reservations(app, copy_id)

    # a failure before any side effect is failed, after on_failed undid prepare
    failing = await allow(5)
    quote.script["execute"] = AdapterFailure("slot_taken")
    assert await executed(client, visitor, failing) == ExecResult(
        action_id=failing.action.action_id, state="failed", facts=[], model_view={})
    assert quote.calls[-2:] == ["execute", "on_failed"]
    assert await committed(app, copy_id, failing.action.action_id) == ("failed", "failed")
    [entry] = [e.event.summary for e in await ledger_rows(app, rows)
               if e.event.kind == "execute" and e.event.summary.get("state") == "failed"]
    assert entry == {"decision_id": failing.decision_id, "action_id": failing.action.action_id, "state": "failed",
                     "reason": "slot_taken", "policy_version": 1, "auto_money_cap_cents": 50_000}

    # a T2 commit that fails after the side effect: unknown, then reconciled to executed, once
    effects, armed = [], []
    real_commit = AsyncSession.commit

    async def failing_commit(self) -> None:
        if armed:
            armed.clear()
            raise RuntimeError("the database went away")
        await real_commit(self)

    def provider_call(xctx, action, args) -> AdapterResult:
        effects.append(action.action_id)
        armed.append(True)
        return AdapterResult(model_view={"ok": True})

    lost = await allow(6)
    monkeypatch.setattr(AsyncSession, "commit", failing_commit)
    quote.script.update(execute=provider_call,
                        reconcile=lambda xctx, action: AdapterResult(model_view={"ok": True})
                        if action.action_id in effects else None)
    assert (await executed(client, visitor, lost)).state == "unknown"
    assert await committed(app, copy_id, lost.action.action_id) == ("unknown", "unknown")
    for _ in range(2):
        assert (await read(client, visitor.headers, lost)).state == "executed"
    assert effects == [lost.action.action_id] and quote.calls.count("reconcile") == 1
    assert (await executed(client, visitor, lost)).model_view == {"ok": True}


@pytest.mark.parametrize("how", ["read", "startup"])
async def test_on_failed_is_never_kept_without_its_failed_record(app, client, registry, frozen_clock, monkeypatch,
                                                                 caplog, how):
    # Reconciliation asks the adapter first: an orphan that never ran is undone (`on_failed`), then
    # recorded `failed`. When the record fails, the rollback takes back `on_failed` with it, and
    # the orphan's `unknown` mark too, so the next read finds the orphan as it was and settles it once.
    quote, rows, visitor, allowed = await fake_quote_desk(app, client)
    copy_id, action_id = rows.copy_id, allowed.action.action_id

    async def undo(xctx, action) -> None:
        await demo_inbox.deliver(xctx.ctx, copy_id=action.copy_id, desk_id=action.desk_id, to="owner", person_id=None,
                                 kind="alert", body=action.action_id, preview="Undone")

    async def undone() -> list[str]:
        return [row.body for row in await rows_of(app, copy_id, select(DemoInboxEntry).where(
            DemoInboxEntry.preview == "Undone"))]

    quote.script["on_failed"] = undo                             # `reconcile` answers None: it never ran
    await store_intent(app, copy_id, allowed)                    # a kernel died after T1
    frozen_clock.advance(31)
    append = ledger.append

    async def the_record_fails(ctx, *, copy_id: str, desk_id: str, event):
        if event.kind == "execute" and event.summary.get("reconciled"):
            raise RuntimeError("the ledger went away")
        return await append(ctx, copy_id=copy_id, desk_id=desk_id, event=event)

    with monkeypatch.context() as patch:
        patch.setattr(ledger, "append", the_record_fails)
        if how == "read":
            response = await client.get(f"/decisions/{allowed.decision_id}", headers=visitor.headers)
            assert (response.status_code, response.json()) == (500, {"code": "internal"})
        else:
            assert await execute.reconcile_at_startup(app.state.kernel) == []
            assert f"reconcile_failed action_id={action_id}" in caplog.text
    assert quote.calls[-2:] == ["reconcile", "on_failed"]
    assert await undone() == []                                  # on_failed rolled back with the record
    assert await committed(app, copy_id, action_id) == ("intent", "allowed")
    assert [e for e in await ledger_rows(app, rows) if e.event.kind == "execute"] == []

    assert (await read(client, visitor.headers, allowed)).state == "failed"
    assert await undone() == [action_id]                         # undone once, with its record
    base = {"decision_id": allowed.decision_id, "action_id": action_id}
    assert [e.event.summary for e in await ledger_rows(app, rows) if e.event.kind == "execute"] == [
        {**base, "state": "unknown", "orphaned": True}, {**base, "state": "failed", "reconciled": True}]


NOTE = "Call me back at mike@riverapl.example"     # what a visitor typed, which no log may carry


def echoes_the_note(*args) -> None:
    raise RuntimeError(f"the provider refused the note {NOTE!r}")


@pytest.mark.parametrize(("hook", "logged"), [("execute", "execution_unknown"), ("on_failed", "on_failed_failed"),
                                              ("reconcile", "reconcile_error")])
async def test_a_failure_log_carries_no_visitor_text(app, client, registry, frozen_clock, caplog, hook, logged):
    """An error raised while an action runs can quote what the visitor typed (an adapter's error its
    arguments, a validation error the input it refused). The log names the error's kind and the
    frames it rose through, never its text."""
    quote = FakeAdapter("native.quote")
    rows = await desk_with(app, [quote], [card("quote", "native.quote")])
    visitor = await open_visitor(client, rows)
    allowed = await decided(client, visitor, "native.quote", {"qty": 1, "note": NOTE})
    if hook == "on_failed":
        quote.script["execute"] = AdapterFailure("slot_taken")      # undone, and the undo fails
    quote.script[hook] = echoes_the_note
    with caplog.at_level(logging.INFO, logger="desk.kernel_service"):
        if hook == "reconcile":                                     # an orphan, which a read settles
            await store_intent(app, rows.copy_id, allowed)
            frozen_clock.advance(31)
            assert (await read(client, visitor.headers, allowed)).state == "unknown"
        else:
            assert (await executed(client, visitor, allowed)).state == "unknown"
    assert f"{logged} action_id={allowed.action.action_id} kind=RuntimeError\n" in caplog.text
    assert "mike@riverapl.example" not in caplog.text


async def test_a_take_over_after_the_intent_stops_the_allow(app, client, registry, monkeypatch):
    quote, rows, visitor, allowed = await fake_quote_desk(app, client)

    async def take_over() -> None:                                  # Mike takes over as the intent commits
        await set_mode(client, rows, visitor.session_id, "owner", 0)

    monkeypatch.setattr(execute, "_after_intent", take_over)
    response = await post_execute(client, visitor, allowed)
    assert (response.status_code, response.json()) == (409, {"code": "stale_generation"})
    assert "execute" not in quote.calls and quote.calls[-1] == "on_failed"     # prepare undone, nothing run
    assert await committed(app, rows.copy_id, allowed.action.action_id) == ("failed", "expired")
    decision = await read(client, rows.owner, allowed)
    assert (decision.state, decision.visitor_plain) == ("expired", "This request timed out")
    entries = [(e.event.kind, e.event.summary) for e in await ledger_rows(app, rows)
               if e.event.kind in ("takeover", "execute", "auth")]
    assert entries == [
        ("takeover", {"from": "ai", "to": "owner", "generation": 1}),
        ("execute", {"decision_id": allowed.decision_id, "action_id": allowed.action.action_id, "state": "expired",
                     "fenced": True, "policy_version": 1, "auto_money_cap_cents": 50_000}),
        ("auth", {"route": "POST /execute", "reason": "stale_generation"}),
    ]


async def put_people(client: httpx.AsyncClient, rows: CopyRows, body: dict) -> None:
    response = await client.put(f"/desks/{rows.desk_id}/people", headers=rows.owner, json=body)
    assert response.status_code == 200, response.text


async def test_a_session_closed_after_the_intent_runs_nothing(app, client, registry, monkeypatch):
    """Mike removes Dana after an allow's intent commits in a session verified as her, and before
    its side effect: the removal closes that session, and the Desk still stands. T2 reads the
    session afresh once it holds the row and finds it closed, so nothing runs: the decision ends
    `refused_at_execution`, its intent `failed` after `on_failed`, and its `execute` entry names
    the closed session as the check that failed, with the version and cap T1 checked under."""
    quote = FakeAdapter("native.quote")
    rows = await desk_with(app, [quote], [card("quote", "native.quote")])
    await put_people(client, rows, {"upsert": [{"ref": "dana", "display_name": "Dana Whitfield",
                                                "contact": "dana@example.com"}]})
    [dana] = await rows_of(app, rows.copy_id, select(Person).where(Person.ref == "dana"))
    visitor = await open_visitor(client, rows)
    await verify_session(app, rows.copy_id, visitor.session_id, dana.person_id)
    allowed = await decided(client, visitor, "native.quote", {"qty": 1})
    assert allowed.outcome == "allow", allowed.reason_plain

    async def remove_dana() -> None:                                # Mike removes Dana as the intent commits
        await put_people(client, rows, {"remove": ["dana"]})

    monkeypatch.setattr(execute, "_after_intent", remove_dana)
    response = await post_execute(client, visitor, allowed)
    assert (response.status_code, response.json()) == (409, {"code": "conflict"})
    assert "execute" not in quote.calls and quote.calls[-1] == "on_failed"     # prepare undone, nothing run
    assert await committed(app, rows.copy_id, allowed.action.action_id) == ("failed", "refused_at_execution")
    entries = [(e.event.kind, e.event.summary) for e in await ledger_rows(app, rows)
               if e.event.kind in ("session", "execute", "auth")]
    assert entries == [
        ("session", {"kind": "visitor", "session_id": visitor.session_id}),
        ("session", {"session_id": visitor.session_id, "closed": True, "reason": "person_removed"}),
        ("execute", {"decision_id": allowed.decision_id, "action_id": allowed.action.action_id,
                     "state": "refused_at_execution", "reason": "rules_changed", "check": "closed",
                     "policy_version": 1, "auto_money_cap_cents": 50_000}),
    ]


async def test_an_allow_holding_no_session_row_ends_unknown_before_its_side_effect(app, client, registry, monkeypatch,
                                                                                   caplog):
    """T2 runs an allow only while it holds the session row (the fence). If it ever held none, an
    explicit check, not an `assert` that `python -O` strips, ends the action `unknown` before the
    adapter's `execute`: never fenced, and with no `on_failed`, as any outcome nobody knows."""
    quote, rows, visitor, allowed = await fake_quote_desk(app, client)

    async def no_session(ctx, session_id, action_id) -> None:
        return None

    monkeypatch.setattr(execute, "_hold_session", no_session)
    assert await executed(client, visitor, allowed) == ExecResult(
        action_id=allowed.action.action_id, state="unknown", facts=[], model_view={})
    assert "execute" not in quote.calls and "on_failed" not in quote.calls
    assert await committed(app, rows.copy_id, allowed.action.action_id) == ("unknown", "unknown")
    entries = [(e.event.kind, e.event.summary) for e in await ledger_rows(app, rows)
               if e.event.kind in ("execute", "auth")]
    assert entries == [("execute", {"decision_id": allowed.decision_id, "action_id": allowed.action.action_id,
                                    "state": "unknown", "policy_version": 1, "auto_money_cap_cents": 50_000})]
    [logged] = [record for record in caplog.records if record.getMessage().startswith("execution_unknown")]
    # logged by its kind and frames (`repo.log_error`), never its text: the frames end at the explicit check
    message = logged.getMessage()
    assert "kind=RuntimeError\n" in message and 'raise RuntimeError(f"{path}_without_session")' in message


class OddError(Exception):
    """An error whose `exceptions` attribute is no list of members, as an exception group's is."""

    exceptions = None


@pytest.mark.parametrize("how", ["odd_error", "failing_redaction"])
async def test_a_log_line_that_cannot_be_redacted_still_ends_unknown(app, client, registry, caplog, monkeypatch,
                                                                     how):
    """The log line an unknown outcome writes is redacted as it is made (`desk.db.logs`), inside
    the handler that rolls back and settles the action. Writing that line never raises, so the
    rollback and `unknown` still follow: an error with an `exceptions` attribute that isn't an
    exception group's is read as an error like any other, and a redaction that fails anyway leaves
    a record saying only `log_redaction_failed`."""
    quote, rows, visitor, allowed = await fake_quote_desk(app, client)
    quote.script["execute"] = OddError("the provider's answer was lost")
    if how == "failing_redaction":
        def fails(record: logging.LogRecord) -> None:
            raise RuntimeError("the redaction failed")

        monkeypatch.setattr(logs, "redact", fails)
    assert await executed(client, visitor, allowed) == ExecResult(
        action_id=allowed.action.action_id, state="unknown", facts=[], model_view={})
    assert await committed(app, rows.copy_id, allowed.action.action_id) == ("unknown", "unknown")
    unknown = [record for record in caplog.records if record.getMessage().startswith("execution_unknown")]
    if how == "odd_error":
        [logged] = unknown
        assert "kind=OddError\n" in logged.getMessage()            # it holds no database error: logged by its class
    else:
        # nothing of the line is kept, and nothing of the error: a fixed message alone
        failed = [record for record in caplog.records if record.getMessage() == "log_redaction_failed"]
        assert unknown == [] and failed
        assert all((record.args, record.exc_info, record.exc_text) == ((), None, None) for record in failed)


async def change_records(app: FastAPI, copy: Rivera, change: str) -> None:
    """Changes the Desk between a quote's decision and its execution."""
    async with kernel_ctx(app) as ctx:
        repo = ctx.bind(copy.copy_id)
        if change == "tool_disabled":
            tool = (await ctx.db.scalars(repo.scoped(select(Tool).where(Tool.tool == "native.quote")))).one()
            tool.status = "disabled"
            return
        drain = (await ctx.db.scalars(repo.scoped(select(PriceItem).where(PriceItem.item_id == "drain")))).one()
        if change == "item_removed":
            await ctx.db.delete(drain)
        else:
            drain.unit_cents = 19_000


@pytest.mark.parametrize(("change", "check"), [("tool_disabled", "tool"), ("item_removed", "args"),
                                                ("price_changed", "args")])
async def test_recheck_reruns_step_one(app, client, change, check):
    copy, visitor = await visitor_of(app, client)
    allowed = await decided(client, visitor, "native.quote", quote_args(("drain", 1)))
    await change_records(app, copy, change)
    response = await post_execute(client, visitor, allowed)
    assert (response.status_code, response.json()) == (409, {"code": "conflict"})
    assert await rows_of(app, copy.copy_id, select(Quote)) == []
    assert await executions_of(app, copy.copy_id) == []
    decision = await read(client, visitor.headers, allowed)
    assert decision.state == "refused_at_execution"
    [entry] = [e.event.summary for e in await ledger_rows(app, copy) if e.seq == decision.ledger_seq]
    assert (entry["reason"], entry["check"]) == ("rules_changed", check)


def a_fact(fact_id: str, *readers: str) -> Fact:
    return Fact(fact_id=fact_id, kind="quote", status="available", source="kernel",
                claims=[Claim(key="total", kind="money", value=18_000)], label=Label(readers=list(readers)))


async def test_model_view_is_filtered_for_the_session(app, client, registry):
    quote, rows, visitor, first = await fake_quote_desk(app, client)
    canary = "cdk-0123456789abcdef"
    async with kernel_ctx(app) as ctx:
        ctx.bind(rows.copy_id)
        ctx.db.add(Document(document_id="doc-1", copy_id=rows.copy_id, desk_id=rows.desk_id, ref="invoice",
                            title="Invoice", record_owner_person_id=None, body=f"Invoice\n\nReference {canary}",
                            canary=canary, created_at=ctx.clock.now()))
    mine = a_fact("quote:q-1", "owner", f"session:{visitor.session_id}")
    owners = a_fact("quote:q-2", "owner")
    results = [
        AdapterResult(facts=[mine], model_view={"ok": True, "contact": "dana@example.com"}),   # an undeclared key
        AdapterResult(facts=[mine, owners], model_view={"ok": True, "qty": 1}),                # a fact it can't read
        AdapterResult(facts=[mine], model_view={"ok": True, "qty": f"see {canary.upper()}"}),  # a document canary
    ]
    seen = []
    for n, result in enumerate(results):
        allowed = first if n == 0 else await decided(client, visitor, "native.quote", {"qty": n + 1},
                                                     call_id=f"call-{n + 1}")
        quote.script["execute"] = result
        seen.append(await executed(client, visitor, allowed))
        assert await executed(client, visitor, allowed) == seen[-1]                 # stored as Claude saw it
    assert [(r.state, [f.fact_id for f in r.facts], r.model_view) for r in seen] == [
        ("succeeded", ["quote:q-1"], {"ok": True}),
        ("succeeded", ["quote:q-1"], {}),
        ("succeeded", ["quote:q-1"], {}),
    ]


async def test_execute_needs_the_decisions_own_session(app, client, registry):
    quote, website = FakeAdapter("native.quote"), FakeAdapter("native.fetch_website", effects=["read"])
    rows = await desk_with(app, [quote, website], [card("quote", "native.quote"), card("site", "native.fetch_website")])
    visitor, other = await open_visitor(client, rows), await open_visitor(client, rows)
    allowed = await decided(client, visitor, "native.quote", {"qty": 1})
    refusals = [
        # another session's token on this session's allow
        (await post_execute(client, visitor, allowed, headers=other.headers), 401),
        # a valid session naming another session's decision on execute; a read names the decision's
        # own session, which another session's token doesn't prove
        (await post_execute(client, other, allowed), 404),
        (await client.get(f"/decisions/{allowed.decision_id}", headers=other.headers), 401),
        # the owner on a visitor's allow, naming the visitor's session or its own
        (await post_execute(client, visitor, allowed, headers=rows.owner), 401),
        (await post_execute(client, visitor, allowed, headers=rows.owner, session_id=rows.owner_session_id), 401),
    ]
    elsewhere = await make_copy_rows(app)                                       # another copy's owner
    refusals.append((await post_execute(client, visitor, allowed, headers=elsewhere.owner,
                                        session_id=elsewhere.owner_session_id), 404))
    assert [(r.status_code, r.json()) for r, _ in refusals] == [
        (status, {"code": "auth" if status == 401 else "not_found"}) for _, status in refusals]
    entries = [(e.event.session_id, e.event.summary) for e in await ledger_rows(app, rows) if e.event.kind == "auth"]
    assert entries == [
        (visitor.session_id, {"route": "POST /execute", "reason": "bad_token"}),
        (other.session_id, {"route": "POST /execute", "reason": "wrong_session"}),
        (visitor.session_id, {"route": "GET /decisions/{decision_id}", "reason": "bad_token"}),
        (visitor.session_id, {"route": "POST /execute", "reason": "bad_token"}),
        (visitor.session_id, {"route": "POST /execute", "reason": "bad_token"}),
    ]
    # nothing ran, and the visitor's own credential still can
    assert "execute" not in quote.calls and await executions_of(app, rows.copy_id) == []
    assert (await read(client, visitor.headers, allowed)).state == "allowed"
    assert (await executed(client, visitor, allowed)).state == "succeeded"
    # the owner runs its own session's allows
    response = await owner_decide(client, rows, "native.fetch_website", desk_id=rows.desk_id)
    own = Decision.model_validate(response.json())
    assert own.outcome == "allow"
    result = await executed(client, visitor, own, headers=rows.owner, session_id=rows.owner_session_id)
    assert (result.state, result.model_view) == ("succeeded", {"ok": True})
    # and its own setup action ends on the generic line, not a receipt written for a visitor
    own = await read(client, rows.owner, own)
    assert (own.state, own.visitor_plain) == ("executed", "Done")
