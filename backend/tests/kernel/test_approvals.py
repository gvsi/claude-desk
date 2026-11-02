"""POST /approvals/{decision_id}/answer and POST /decisions/{decision_id}/cancel: the owner answers
a held request once, and an approval runs the exact action it was given for, as the session that
asked.

Most tests answer the held quote every Turner Plumbing copy is seeded with (drain clearing at 15%
off, which `rv-quote` holds for Mike); the rest hold calls on a Desk of scripted adapters
(`FakeAdapter`) under `ask` cards. The owner answers with the copy's owner token, as the API
does, and reads the outcome back through `GET /decisions/{decision_id}` and the safety ledger.
"""

import asyncio
import json
import logging
import re
from typing import get_args

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select

from desk.contracts import (ApprovalResult, Decision, DecisionState, ExecResult, PolicyVersion, Principal, Review,
                            RuleCard)
from desk.db.models import Action, ActorSession, Approval, Booking, Execution, Person, Quote
from desk.db.models import Decision as DecisionRow
from desk.kernel_service import activation, adapters, approvals, compiler, decide, demo_inbox, desks, execute, render
from desk.kernel_service.adapters.base import AdapterFailure, AdapterRefusal, AdapterResult, AdapterUnknown
from desk.kernel_service.repo import new_id
from desk.kernel_service.seed import RIVERA_CARDS

from .fakes import FakeAdapter
from .helpers import TEST_CAP, CopyRows, activate_cards, compile_at, kernel_ctx, ledger_rows, rows_of, verify_session
from .test_adapters import Rivera, add_slot, book, local, quote_args, rivera, visitor_of
from .test_compiler import card
from .test_decide import (PASS, Visitor, by_call, decided, desk_with, open_visitor, payment_link, priced, set_mode,
                          set_session, verify_signature)
from .test_execute import activate, change_records, committed, executed, reservations

# The owner's line for a held request a booking closed (`render.owner_line("cancelled_by_booking")`), the owner's
# own words; a request the visitor cancelled has none.
BOOKED_LINE = "The visitor booked before you answered, so this request closed."


async def post_answer(client: httpx.AsyncClient, headers: dict[str, str], decision_id: str,
                      answer: str) -> httpx.Response:
    return await client.post(f"/approvals/{decision_id}/answer", headers=headers, json={"answer": answer})


async def answered(client: httpx.AsyncClient, headers: dict[str, str], decision_id: str,
                   answer: str) -> ApprovalResult:
    response = await post_answer(client, headers, decision_id, answer)
    assert response.status_code == 200, response.text
    return ApprovalResult.model_validate(response.json())


async def read_id(client: httpx.AsyncClient, headers: dict[str, str], decision_id: str) -> Decision:
    response = await client.get(f"/decisions/{decision_id}", headers=headers)
    assert response.status_code == 200, response.text
    return Decision.model_validate(response.json())


async def approvals_of(app: FastAPI, copy_id: str) -> list[Approval]:
    return await rows_of(app, copy_id, select(Approval).order_by(Approval.created_at, Approval.approval_id))


async def seeded_hold(app: FastAPI, client: httpx.AsyncClient) -> tuple[Rivera, DecisionRow]:
    """A fresh Turner copy and the held quote it was seeded with."""
    copy = await rivera(app, client)
    [held] = await rows_of(app, copy.copy_id, select(DecisionRow))
    assert held.state == "held"
    return copy, held


async def public_key(client: httpx.AsyncClient) -> str:
    return (await client.get("/health")).json()["public_key_hex"]


async def test_allow_once_executes_inside_the_answer(app, client, frozen_clock):
    copy, held = await seeded_hold(app, client)
    result = await answered(client, copy.owner, held.decision_id, "allow_once")

    decision, execution = result.decision, result.execution
    assert (decision.decision_id, decision.state, decision.visitor_plain) == (
        held.decision_id, "executed", "Quoted from Mike Turner's price list")
    assert result.card_diff is None                                       # allow_once drafts no rule
    [quote] = await rows_of(app, copy.copy_id, select(Quote))
    assert (quote.action_id, quote.session_id, quote.discount_bp, quote.amount_cents) == (
        held.action_id, held.session_id, 1500, 15_300)                   # the action Mike approved, at its price
    [fact] = execution.facts
    assert (execution.action_id, execution.state, fact.fact_id) == (held.action_id, "succeeded",
                                                                    f"quote:{quote.quote_id}")
    [run] = await rows_of(app, copy.copy_id, select(Execution))
    assert (run.action_id, run.decision_id, run.state, run.result) == (held.action_id, held.decision_id, "succeeded",
                                                                       execution)

    # one approval, bound to the action and its nonce, consumed by this answer
    [approval] = await rows_of(app, copy.copy_id, select(Approval))
    assert (approval.decision_id, approval.answer, approval.policy_version) == (held.decision_id, "allow_once", 1)
    assert (approval.consumed_at, approval.created_at, approval.expires_at) == (
        frozen_clock.now(), frozen_clock.now(), held.expires_at)
    assert re.fullmatch(r"[0-9a-f]{32}", approval.nonce)
    [action] = await rows_of(app, copy.copy_id, select(Action))
    assert approval.binding_sha256 == execute.binding_sha256(
        copy_id=copy.copy_id, desk_id=copy.desk_id, session_id=held.session_id, action_id=held.action_id,
        args_sha256=action.args_sha256, profile_sha256=action.profile_sha256, nonce=approval.nonce)

    # the approval, then the execution, on the ledger; the decision signed at its last entry
    entries = [e for e in await ledger_rows(app, copy) if e.seq > held.ledger_seq]
    base = {"decision_id": held.decision_id, "action_id": held.action_id}
    assert [(e.event.kind, e.event.session_id, e.event.ref_id, e.event.summary) for e in entries] == [
        ("approval", held.session_id, held.decision_id, {**base, "answer": "allow_once", "state": "approved"}),
        ("execute", held.session_id, held.decision_id, {**base, "state": "executed", "policy_version": 1,
                                                         "auto_money_cap_cents": 50_000}),
    ]
    assert decision.ledger_seq == entries[-1].seq
    verify_signature(await public_key(client), decision)
    response = await client.get(f"/decisions/{held.decision_id}", headers=copy.owner)
    assert response.json() == decision.model_dump(mode="json")


@pytest.mark.parametrize("answer,refused", [("allow_once", False), ("deny_once", False), ("allow_once", True)])
async def test_answer_preserves_the_signed_approval_before_the_outcome(app, client, answer, refused):
    copy, held = await seeded_hold(app, client)
    if refused:
        await activate(app, copy, [c for c in RIVERA_CARDS if c.card_id != "rv-quote"]
                       + [card("no-quotes", "native.quote", mode="never")])
    result = await answered(client, copy.owner, held.decision_id, answer)
    approved = result.approved
    if refused or answer == "deny_once":
        assert approved is None
        assert result.decision.state == ("refused_at_execution" if refused else "denied")
        assert result.execution is None
        return

    assert approved is not None
    assert (approved.decision_id, approved.state, approved.visitor_plain, approved.answers) == (
        held.decision_id, "approved", "Mike Turner approved this", [])
    verify_signature(await public_key(client), approved)
    assert result.decision.state == "executed" and result.execution.state == "succeeded"
    assert approved.ledger_seq < result.decision.ledger_seq
    [entry] = [e for e in await ledger_rows(app, copy) if e.seq == approved.ledger_seq]
    assert entry.event.kind == "approval" and entry.event.summary["state"] == "approved"
    verify_signature(await public_key(client), result.decision)


async def held_on(client: httpx.AsyncClient, rows: CopyRows, tool: str = "native.quote", args: dict | None = None,
                  *, visitor: Visitor | None = None, call_id: str = "call-1") -> tuple[Visitor, Decision]:
    """A visitor of `rows`' Desk (a new one unless given) and a call of theirs the Desk holds."""
    visitor = visitor or await open_visitor(client, rows)
    decision = await decided(client, visitor, tool, args if args is not None else {"qty": 1}, call_id=call_id)
    assert decision.state == "held", decision.reason_plain
    return visitor, decision


ASK_QUOTES = [card("quote", "native.quote", mode="ask")]


async def test_the_approved_action_runs_as_the_held_session(app, client, registry):
    # the seeded quote: its fact is the asking visitor's and the business's, never the owner session's
    copy, held = await seeded_hold(app, client)
    execution = (await answered(client, copy.owner, held.decision_id, "allow_once")).execution
    [fact] = execution.facts
    assert fact.label.readers == ["owner", f"session:{held.session_id}"]
    assert set(execution.model_view) == adapters.ADAPTERS["native.quote"].model_view_keys

    # a scripted adapter sees whom it runs as, and what it returns is filtered for that session
    quote = FakeAdapter("native.quote")
    rows = await desk_with(app, [quote], ASK_QUOTES)
    visitor, decision = await held_on(client, rows)
    ran_as = []

    def side_effect(xctx, action, args) -> AdapterResult:
        ran_as.append((xctx.principal.kind, xctx.principal.session_id, xctx.session_row.session_id))
        return AdapterResult(model_view={"ok": True, "contact": "dana@example.com"})   # an undeclared key

    quote.script["execute"] = side_effect
    execution = (await answered(client, rows.owner, decision.decision_id, "allow_once")).execution
    assert ran_as == [("visitor", visitor.session_id, visitor.session_id)]
    assert (execution.state, execution.model_view) == ("succeeded", {"ok": True})
    assert (await read_id(client, visitor.headers, decision.decision_id)).state == "executed"   # the visitor reads it too


async def test_a_second_answer_is_409(app, client):
    copy, held = await seeded_hold(app, client)
    first = await answered(client, copy.owner, held.decision_id, "allow_once")
    for again in ("allow_once", "deny_once", "deny_always"):
        response = await post_answer(client, copy.owner, held.decision_id, again)
        assert (response.status_code, response.json()) == (409, {"code": "conflict"}), again
    assert len(await approvals_of(app, copy.copy_id)) == 1
    assert len(await rows_of(app, copy.copy_id, select(Quote))) == 1          # it ran once
    assert await read_id(client, copy.owner, held.decision_id) == first.decision    # and nothing about it changed
    refusals = [e.event.summary for e in await ledger_rows(app, copy)
                if e.event.kind == "approval" and "refused" in e.event.summary]
    assert refusals == [{"decision_id": held.decision_id, "answer": again, "refused": "executed"}
                        for again in ("allow_once", "deny_once", "deny_always")]

    # an approval already on record for a request still held (a writer that skipped the lock):
    # the unique index refuses a second one, and nothing runs
    copy, held = await seeded_hold(app, client)
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        ctx.db.add(Approval(approval_id="apr-stray", copy_id=copy.copy_id, decision_id=held.decision_id,
                            answer="deny_once", expires_at=held.expires_at, created_at=ctx.clock.now()))
    response = await post_answer(client, copy.owner, held.decision_id, "allow_once")
    assert (response.status_code, response.json()) == (409, {"code": "conflict"})
    assert [a.approval_id for a in await approvals_of(app, copy.copy_id)] == ["apr-stray"]
    assert await rows_of(app, copy.copy_id, select(Execution)) == []
    assert (await read_id(client, copy.owner, held.decision_id)).state == "held"
    [refusal] = [e.event.summary for e in await ledger_rows(app, copy) if e.event.kind == "approval"]
    assert refusal == {"decision_id": held.decision_id, "answer": "allow_once", "refused": "answered"}


async def test_concurrent_answers_resolve_once(app, client):
    copy, held = await seeded_hold(app, client)
    responses = await asyncio.gather(*(post_answer(client, copy.owner, held.decision_id, "allow_once")
                                       for _ in range(3)))
    assert sorted(r.status_code for r in responses) == [200, 409, 409], [r.text for r in responses]
    [won] = [ApprovalResult.model_validate(r.json()) for r in responses if r.status_code == 200]
    assert (won.decision.state, won.execution.state) == ("executed", "succeeded")
    assert [r.json() for r in responses if r.status_code == 409] == [{"code": "conflict"}] * 2
    assert len(await approvals_of(app, copy.copy_id)) == 1
    assert len(await rows_of(app, copy.copy_id, select(Quote))) == 1
    entries = [e.event for e in await ledger_rows(app, copy) if e.seq > held.ledger_seq]
    approved = [e for e in entries if e.kind == "approval" and e.summary.get("state") == "approved"]
    executed = [e for e in entries if e.kind == "execute"]
    refusals = [e.summary for e in entries if e.kind == "approval" and "refused" in e.summary]
    assert (len(approved), len(executed), len(refusals)) == (1, 1, 2)
    # the losers waited on the decision's lock and found it approved (still running) or executed
    assert {r["refused"] for r in refusals} <= {"approved", "executed"}


async def test_answers_after_expiry_are_409(app, client, frozen_clock):
    copy, held = await seeded_hold(app, client)
    later, late = await seeded_hold(app, client)
    frozen_clock.advance(24 * 3600 - 1)                                        # a second before the 24 h are up
    assert (await answered(client, later.owner, late.decision_id, "allow_once")).decision.state == "executed"
    frozen_clock.advance(1)
    for answer in ("allow_once", "deny_once"):
        response = await post_answer(client, copy.owner, held.decision_id, answer)
        assert (response.status_code, response.json()) == (409, {"code": "conflict"})
    decision = await read_id(client, copy.owner, held.decision_id)
    assert (decision.state, decision.visitor_plain) == ("expired", "This request timed out")
    verify_signature(await public_key(client), decision)
    assert await approvals_of(app, copy.copy_id) == []
    assert await rows_of(app, copy.copy_id, select(Execution)) == []
    # the answer found it expired, so the expiry and both refusals are on record
    entries = [(e.event.kind, e.event.summary) for e in await ledger_rows(app, copy) if e.seq > held.ledger_seq]
    assert entries == [("decide", {"decision_id": held.decision_id, "state": "expired"}),
                       ("approval", {"decision_id": held.decision_id, "answer": "allow_once", "refused": "expired"}),
                       ("approval", {"decision_id": held.decision_id, "answer": "deny_once", "refused": "expired"})]


async def post_cancel(client: httpx.AsyncClient, visitor: Visitor, decision_id: str, *,
                      headers: dict[str, str] | None = None) -> httpx.Response:
    return await client.post(f"/decisions/{decision_id}/cancel", json={"session_id": visitor.session_id},
                             headers=visitor.headers if headers is None else headers)


async def held_quote(app: FastAPI, client: httpx.AsyncClient) -> tuple[Rivera, Visitor, Decision]:
    """A fresh Turner copy, a stranger on it, and their quote at 15% off, which Mike must answer."""
    copy, visitor = await visitor_of(app, client)
    held = await decided(client, visitor, "native.quote", quote_args(("drain", 1), discount_bp=1500))
    assert held.state == "held"
    return copy, visitor, held


async def test_answers_after_cancel_are_409(app, client):
    copy, visitor, held = await held_quote(app, client)
    response = await post_cancel(client, visitor, held.decision_id)
    assert response.status_code == 200, response.text
    cancelled = Decision.model_validate(response.json())
    assert (cancelled.decision_id, cancelled.state, cancelled.visitor_plain) == (held.decision_id, "cancelled",
                                                                                 "Cancelled")
    verify_signature(await public_key(client), cancelled)

    response = await post_answer(client, copy.owner, held.decision_id, "allow_once")
    assert (response.status_code, response.json()) == (409, {"code": "conflict"})
    # the visitor withdrew it themselves, so the owner's read has no owner line: the card's own line says so
    assert await read_id(client, copy.owner, held.decision_id) == cancelled
    assert cancelled.owner_plain is None
    assert await approvals_of(app, copy.copy_id) == []
    assert await rows_of(app, copy.copy_id, select(Quote)) == []
    entries = [(e.event.kind, e.event.session_id, e.event.summary) for e in await ledger_rows(app, copy)
               if e.seq > held.ledger_seq]
    assert entries == [
        ("decide", visitor.session_id, {"decision_id": held.decision_id, "action_id": held.action.action_id,
                                        "state": "cancelled"}),
        ("approval", visitor.session_id, {"decision_id": held.decision_id, "answer": "allow_once",
                                          "refused": "cancelled"}),
    ]
    assert cancelled.ledger_seq == [e.seq for e in await ledger_rows(app, copy) if e.event.kind == "decide"][-1]


async def book_and_run(client: httpx.AsyncClient, visitor: Visitor, slot_id: str = "S-20261102-1000") -> Decision:
    """A booking of `slot_id` (Monday at 10:00 unless given) that rv-book-wk allows, executed; the reviewer passes."""
    booking = await book(client, visitor, slot_id)
    assert booking.state == "allowed", booking.reason_plain
    assert (await executed(client, visitor, booking)).state == "succeeded"
    return booking


@pytest.mark.parametrize("first", ["read", "answer"])
async def test_a_booking_cancels_the_sessions_earlier_held_discount_quote(app, client, reviewer, frozen_clock, first):
    # The visitor asked for half off, which Mike's rules hold, then said list price was fine and booked: approving
    # the discount now would hand them a half-price quote for a job booked at list price. The next read settles it,
    # whether the visitor's card or Mike's answer comes first.
    reviewer.answer = PASS
    copy, visitor = await visitor_of(app, client)
    held = await decided(client, visitor, "native.quote", quote_args(("drain", 1), discount_bp=5000))
    assert held.state == "held"
    frozen_clock.advance(60)
    booking = await book_and_run(client, visitor)
    [booked] = await rows_of(app, copy.copy_id, select(Booking))

    if first == "read":
        assert (await read_id(client, visitor.headers, held.decision_id)).state == "cancelled"
    response = await post_answer(client, copy.owner, held.decision_id, "allow_once")
    assert (response.status_code, response.json()) == (409, {"code": "conflict"})

    decision = await read_id(client, visitor.headers, held.decision_id)
    assert (decision.state, decision.visitor_plain, decision.answers) == ("cancelled", "Cancelled", [])
    verify_signature(await public_key(client), decision)
    # the owner alone reads that a booking closed it, not the visitor; the line isn't signed, so the owner's read
    # verifies with the same signature
    owner_read = await read_id(client, copy.owner, held.decision_id)
    assert owner_read == decision.model_copy(update={"owner_plain": BOOKED_LINE})
    verify_signature(await public_key(client), owner_read)
    # nothing ran: no approval, no quote, and the booking's is the only execution
    assert await approvals_of(app, copy.copy_id) == []
    assert await rows_of(app, copy.copy_id, select(Quote)) == []
    assert [run.action_id for run in await rows_of(app, copy.copy_id, select(Execution))] == [booking.action.action_id]
    # cancelled once, naming the booking and the rules in force, then the answer refused
    entries = [e for e in await ledger_rows(app, copy)
               if e.event.ref_id == held.decision_id and e.seq > held.ledger_seq]
    assert [(e.event.kind, e.event.session_id, e.event.summary) for e in entries] == [
        ("decide", visitor.session_id, {"decision_id": held.decision_id, "action_id": held.action.action_id,
                                        "state": "cancelled", "cancelled_by": "booking",
                                        "booking_id": booked.booking_id, "policy_version": 1,
                                        "auto_money_cap_cents": 50_000}),
        ("approval", visitor.session_id, {"decision_id": held.decision_id, "answer": "allow_once",
                                          "refused": "cancelled"}),
    ]
    assert decision.ledger_seq == entries[0].seq
    # no answer to the visitor's session carries the owner's line: its read by ID and by call, and its cancel, now
    # refused; nor does any ledger entry
    for response in (await client.get(f"/decisions/{held.decision_id}", headers=visitor.headers),
                     await by_call(client, visitor.session_id, held.call_id, visitor.headers)):
        assert response.status_code == 200 and response.json()["owner_plain"] is None, response.text
        assert BOOKED_LINE not in response.text
    refused = await post_cancel(client, visitor, held.decision_id)
    assert (refused.status_code, refused.json()) == (409, {"code": "conflict"})
    assert BOOKED_LINE not in json.dumps([e.event.summary for e in await ledger_rows(app, copy)])


@pytest.mark.parametrize("case", ["booked_first", "another_session", "list_price", "not_confirmed"])
async def test_a_held_quote_stays_held_unless_its_session_booked_after_a_discount(app, client, reviewer, frozen_clock,
                                                                                   case):
    # A booking made before the discount was asked leaves it a real question about a booked job; another session's
    # booking isn't this visitor's; a held quote at list price (quotes ask Mike first here) isn't made stale by a
    # booking; and a booking that isn't confirmed books nothing.
    reviewer.answer = PASS
    copy, visitor = await visitor_of(app, client)
    if case == "list_price":
        await activate(app, copy, [c for c in RIVERA_CARDS if c.card_id != "rv-quote"]
                       + [card("ask-quotes", "native.quote", mode="ask")])
    booker = await open_visitor(client, copy) if case == "another_session" else visitor
    if case == "booked_first":
        await book_and_run(client, booker)
        frozen_clock.advance(60)
    held = await decided(client, visitor, "native.quote",
                         quote_args(("drain", 1), discount_bp=None if case == "list_price" else 5000))
    assert held.state == "held", held.reason_plain
    if case != "booked_first":
        frozen_clock.advance(60)
        await book_and_run(client, booker)
    if case == "not_confirmed":
        async with kernel_ctx(app) as ctx:
            ctx.bind(copy.copy_id)
            [booked] = (await ctx.db.scalars(ctx.repo.scoped(select(Booking)))).all()
            booked.status = "cancelled"

    for headers in (visitor.headers, copy.owner):
        decision = await read_id(client, headers, held.decision_id)
        assert (decision.state, decision.ledger_seq) == ("held", held.ledger_seq)
    assert (await answered(client, copy.owner, held.decision_id, "allow_once")).decision.state == "executed"


async def test_answers_after_a_rule_change_are_re_decided(app, client):
    # Mike says never to quotes after the request was held: approving it now doesn't run it
    copy, held = await seeded_hold(app, client)
    await activate(app, copy, [c for c in RIVERA_CARDS if c.card_id != "rv-quote"]
                   + [card("no-quotes", "native.quote", mode="never")])
    result = await answered(client, copy.owner, held.decision_id, "allow_once")
    assert (result.decision.state, result.decision.visitor_plain, result.execution, result.card_diff) == (
        "refused_at_execution", "The rules changed, so this didn't go ahead", None, None)
    verify_signature(await public_key(client), result.decision)
    assert await rows_of(app, copy.copy_id, select(Execution)) == []           # no intent, nothing ran
    assert await rows_of(app, copy.copy_id, select(Quote)) == []
    [approval] = await approvals_of(app, copy.copy_id)
    assert approval.consumed_at is not None                                    # used up all the same
    [entry] = [e for e in await ledger_rows(app, copy) if e.seq > held.ledger_seq]
    assert (entry.seq, entry.event.kind, entry.event.summary) == (result.decision.ledger_seq, "approval", {
        "decision_id": held.decision_id, "action_id": held.action_id, "answer": "allow_once",
        "state": "refused_at_execution", "reason": "rules_changed", "check": "policy"})   # the new rules refused it
    assert await read_id(client, copy.owner, held.decision_id) == result.decision
    response = await post_answer(client, copy.owner, held.decision_id, "allow_once")   # and it stays refused
    assert (response.status_code, response.json()) == (409, {"code": "conflict"})

    # a change that still asks Mike about 15% off: his answer runs it under the new rules
    copy, held = await seeded_hold(app, client)
    await activate(app, copy, [c for c in RIVERA_CARDS if c.card_id != "rv-quote"]
                   + [card("quote-10", "native.quote", max_discount_bp=1000)])
    result = await answered(client, copy.owner, held.decision_id, "allow_once")
    assert (result.decision.state, result.execution.state) == ("executed", "succeeded")
    assert result.decision.policy_version == 1                                 # decided under the old version
    [approval] = await approvals_of(app, copy.copy_id)
    assert approval.policy_version == 1


async def test_a_re_check_that_names_no_version_is_refused_as_the_rules(app, client, monkeypatch):
    """A re-check that fails nothing yet names no version and cap to run under can't run the
    approval: it is refused at execution, and ledgered with `check: "policy"`, never a null check."""
    copy, held = await seeded_hold(app, client)

    async def passes_with_no_version(ctx, target, path) -> None:
        return None                                    # leaves target.checked unset

    monkeypatch.setattr(execute, "_recheck", passes_with_no_version)
    result = await answered(client, copy.owner, held.decision_id, "allow_once")
    assert (result.decision.state, result.execution, result.card_diff) == ("refused_at_execution", None, None)
    assert await rows_of(app, copy.copy_id, select(Execution)) == []           # no intent, nothing ran
    assert await rows_of(app, copy.copy_id, select(Quote)) == []
    [entry] = [e.event.summary for e in await ledger_rows(app, copy) if e.seq == result.decision.ledger_seq]
    assert entry == {"decision_id": held.decision_id, "action_id": held.action_id, "answer": "allow_once",
                     "state": "refused_at_execution", "reason": "rules_changed", "check": "policy"}


async def test_answers_execute_during_a_take_over(app, client):
    copy, visitor, held = await held_quote(app, client)
    state = await set_mode(client, copy, visitor.session_id, "owner", 0)      # Mike takes the conversation over
    assert (state["mode"], state["generation"]) == ("owner", 1)
    result = await answered(client, copy.owner, held.decision_id, "allow_once")
    # a take-over doesn't cancel a held action: his answer still runs it, as the visitor's session
    assert (result.decision.state, result.execution.state) == ("executed", "succeeded")
    [fact] = result.execution.facts
    assert fact.label.readers == ["owner", f"session:{visitor.session_id}"]
    assert (held.action.generation, len(await rows_of(app, copy.copy_id, select(Quote)))) == (0, 1)
    # the conversation stays his
    row = (await rows_of(app, copy.copy_id, select(ActorSession).where(
        ActorSession.session_id == visitor.session_id)))[0]
    assert (row.mode, row.generation) == ("owner", 1)


async def test_answers_execute_during_a_breaker_pause(app, client, reviewer):
    copy, visitor, held = await held_quote(app, client)
    reviewer.answer = Review(within_charter_bp=1000, manipulation_bp=9500, recommendation="block")
    for n in range(3):                                                          # three strikes pause the session
        await book(client, visitor, "S-20261102-1000", call_id=f"call-push-{n}")
    row = (await rows_of(app, copy.copy_id, select(ActorSession).where(
        ActorSession.session_id == visitor.session_id)))[0]
    assert (row.mode, row.strikes) == ("paused", 3)
    result = await answered(client, copy.owner, held.decision_id, "allow_once")
    # the pause stops what Claude proposes next, not what Mike approves
    assert (result.decision.state, result.execution.state) == ("executed", "succeeded")
    assert len(await rows_of(app, copy.copy_id, select(Quote))) == 1
    assert len(reviewer.inputs) == 3                                           # an approval asks no reviewer


async def person_id(app: FastAPI, copy: Rivera, ref: str) -> str:
    [person] = await rows_of(app, copy.copy_id, select(Person).where(Person.ref == ref))
    return person.person_id


async def test_allow_person_needs_a_verified_person(app, client):
    copy, visitor, held = await held_quote(app, client)                      # a stranger's request
    assert held.answers == ["allow_once", "deny_once"]
    response = await post_answer(client, copy.owner, held.decision_id, "allow_person")
    assert (response.status_code, response.json()) == (422, {"code": "invalid"})
    assert (await read_id(client, copy.owner, held.decision_id)).state == "held"   # nothing ran, still Mike's
    assert await approvals_of(app, copy.copy_id) == [] and await rows_of(app, copy.copy_id, select(Execution)) == []
    [refusal] = [e.event.summary for e in await ledger_rows(app, copy) if e.event.kind == "approval"]
    assert refusal == {"decision_id": held.decision_id, "answer": "allow_person", "refused": "not_offered"}
    assert (await answered(client, copy.owner, held.decision_id, "allow_once")).decision.state == "executed"

    # a session that named a person but never confirmed it's them is still a stranger
    unconfirmed = await open_visitor(client, copy)
    await set_session(app, copy, unconfirmed.session_id, person_id=await person_id(app, copy, "dana"))
    held = await decided(client, unconfirmed, "native.quote", quote_args(("drain", 1), discount_bp=1500))
    assert held.answers == ["allow_once", "deny_once"]
    response = await post_answer(client, copy.owner, held.decision_id, "allow_person")
    assert (response.status_code, response.json()) == (422, {"code": "invalid"})


async def verified_visitor(app: FastAPI, client: httpx.AsyncClient, copy: Rivera, ref: str = "dana") -> Visitor:
    """A visitor of the copy who has confirmed they are the Desk's person `ref`."""
    visitor = await open_visitor(client, copy)
    await verify_session(app, copy.copy_id, visitor.session_id, await person_id(app, copy, ref))
    return visitor


async def test_allow_person_drafts_a_person_card(app, client):
    copy = await rivera(app, client)
    dana = await verified_visitor(app, client, copy)
    dana_id = await person_id(app, copy, "dana")
    held = await decided(client, dana, "native.quote", quote_args(("drain", 1), discount_bp=1500))
    assert held.answers == ["allow_once", "deny_once", "allow_person"]
    result = await answered(client, copy.owner, held.decision_id, "allow_person")
    assert (result.decision.state, result.execution.state) == ("executed", "succeeded")   # it runs, as allow_once
    # and drafts a rule for Dana alone, no wider than what Mike just approved
    assert result.card_diff == [RuleCard(
        card_id=f"person-{dana_id}-native.quote", applies_to="native.quote", mode="auto", who="person",
        person_id=dana_id, max_amount_cents=15_300, max_discount_bp=1500, hours=None, review=False,
        reason="Allowed for Dana Whitfield after you approved a request like this.")]
    [approval] = await approvals_of(app, copy.copy_id)
    assert approval.answer == "allow_person"
    [entry] = [e.event.summary for e in await ledger_rows(app, copy)
               if e.event.kind == "approval" and e.seq > held.ledger_seq]
    assert entry == {"decision_id": held.decision_id, "action_id": held.action.action_id, "answer": "allow_person",
                     "state": "approved"}

    # nothing is live until Mike proves and confirms it: a card /policy/draft takes with the Desk's own
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        people = await activation.desk_people(ctx, copy.desk_id)
        profiles = await desks.enabled_profiles(ctx, copy.desk_id)
    assert compiler.validate_cards([*RIVERA_CARDS, *result.card_diff], people=people, agent_keys=(),
                                   auto_money_cap_cents=TEST_CAP, money_tools=frozenset()) == []
    compile_at([*RIVERA_CARDS, *result.card_diff], profiles)
    response = await client.post("/policy/draft", headers=copy.owner, json={
        "desk_id": copy.desk_id, "cards": [c.model_dump(mode="json") for c in [*RIVERA_CARDS, *result.card_diff]],
        "expected_parent": 1})
    assert response.status_code == 200, response.text
    drafted = PolicyVersion.model_validate(response.json())
    # this kernel runs bounded, so the draft is checked on cases (and never activates); it isn't rejected
    assert (drafted.status, drafted.proof.method, drafted.proof.ok) == ("draft", "bounded", True)
    later = await decided(client, dana, "native.quote", quote_args(("drain", 1), discount_bp=1500), call_id="call-2")
    assert later.outcome == "hold"                                             # still Mike's until he confirms

    # a visiting agent's key scopes the card the same way (agent sessions arrive with Plan 01c)
    agent = Principal(kind="agent", session_id="agent-session", copy_id=copy.copy_id, desk_id=copy.desk_id,
                      agent_key_id="agentkey-1", assurance="none")
    assert approvals.person_card(held, agent, auto_money_cap_cents=TEST_CAP) == RuleCard(
        card_id="person-agentkey-1-native.quote", applies_to="native.quote", mode="auto", who="agent",
        agent_key_id="agentkey-1", max_amount_cents=15_300, max_discount_bp=1500,
        reason="Allowed for this visiting agent after you approved a request like this.")
    assert approvals.never_card(held, agent) == RuleCard(
        card_id="never-agentkey-1-native.quote", applies_to="native.quote", mode="never", who="agent",
        agent_key_id="agentkey-1", reason="You said never for this.")


async def add_person(app: FastAPI, rows: CopyRows, ref: str, name: str) -> str:
    """One of the Desk's people, with a contact on record; returns the person's ID."""
    person = new_id("person")
    async with kernel_ctx(app) as ctx:
        ctx.bind(rows.copy_id)
        ctx.db.add(Person(person_id=person, copy_id=rows.copy_id, desk_id=rows.desk_id, display_name=name,
                          masked_contact="d***@example.com", ref=ref, contact=f"{ref}@example.com",
                          contact_norm=f"{ref}@example.com", created_at=ctx.clock.now()))
    return person


async def test_allow_person_is_capped_for_money(app, client, registry, monkeypatch):
    # the stand-in runs with the receipt line the payments plan gives this tool, as every tool must
    for language, line in (("en", "Payment link made for this quote"),
                           ("es", "Enlace de pago creado para esta cotización")):
        monkeypatch.setitem(render.EXECUTED[language], "native.payment_link", line)
    link = payment_link(80_000)                                                # $800: past the version's $500 cap
    rows = await desk_with(app, [link], [])                                    # no card: money asks
    dana_id = await add_person(app, rows, "dana", "Dana Whitfield")
    dana = await open_visitor(client, rows)
    await verify_session(app, rows.copy_id, dana.session_id, dana_id)
    _, held = await held_on(client, rows, "native.payment_link", visitor=dana)
    assert held.answers == ["allow_once", "deny_once", "deny_always"]
    response = await post_answer(client, rows.owner, held.decision_id, "allow_person")
    assert (response.status_code, response.json()) == (422, {"code": "invalid"})
    assert "execute" not in link.calls and await approvals_of(app, rows.copy_id) == []

    # a stored answers list that offered it anyway is no way past the cap: with the refresh every read
    # runs switched off, the stale offer reaches the answer, and the answer's own check of the card it
    # would draft refuses it
    async with kernel_ctx(app) as ctx:
        ctx.bind(rows.copy_id)
        row = (await ctx.db.scalars(ctx.repo.scoped(select(DecisionRow).where(
            DecisionRow.decision_id == held.decision_id)))).one()
        row.answers = [*row.answers, "allow_person"]

    async def unrefreshed(ctx, row: DecisionRow) -> DecisionRow:
        return row

    with monkeypatch.context() as patch:
        patch.setattr(decide, "refresh_answers", unrefreshed)
        assert "allow_person" in (await read_id(client, rows.owner, held.decision_id)).answers   # still offered
        response = await post_answer(client, rows.owner, held.decision_id, "allow_person")
    assert (response.status_code, response.json()) == (422, {"code": "invalid"})
    assert "execute" not in link.calls and await approvals_of(app, rows.copy_id) == []
    assert (await read_id(client, rows.owner, held.decision_id)).state == "held"
    # and the card it would draft is refused on its own too
    principal = Principal(kind="visitor", session_id=dana.session_id, copy_id=rows.copy_id, desk_id=rows.desk_id,
                          person_id=dana_id, assurance="demo_code")
    with pytest.raises(ValueError, match="money cap"):
        approvals.person_card(held, principal, auto_money_cap_cents=TEST_CAP)

    # the cap follows the money, not the tool's name: a charge under another tool is capped too
    charged = held.model_copy(update={"action": held.action.model_copy(update={"tool": "native.quote"})})
    with pytest.raises(ValueError, match="money cap"):
        approvals.person_card(charged, principal, auto_money_cap_cents=TEST_CAP)

    # within the cap, Dana can be allowed: the card is capped at what Mike approved
    link.script["normalize"] = payment_link(5_000).script["normalize"]
    _, held = await held_on(client, rows, "native.payment_link", visitor=dana, call_id="call-2")
    assert "allow_person" in held.answers
    result = await answered(client, rows.owner, held.decision_id, "allow_person")
    [drafted] = result.card_diff
    assert (drafted.who, drafted.person_id, drafted.max_amount_cents, drafted.applies_to) == (
        "person", dana_id, 5_000, "native.payment_link")
    assert compiler.validate_cards([drafted], people={dana_id}, agent_keys=(),
                                   auto_money_cap_cents=TEST_CAP, money_tools=frozenset()) == []


# Mike's drafted card: every booking asks him first, whatever the booking cards' hours say.
ASK_BOOKINGS = RuleCard(card_id="ask-bookings", applies_to="native.book", mode="ask", who="anyone",
                        reason="Bookings ask you first.")
ASK_BOOKING_CARDS = [*RIVERA_CARDS, ASK_BOOKINGS]


async def test_deny_always_drafts_a_never_card(app, client, frozen_clock):
    # a weekday booking in opening hours, which rv-book-wk would allow, is held by the ask card itself
    copy, visitor = await visitor_of(app, client)                            # a stranger
    await activate(app, copy, ASK_BOOKING_CARDS)
    held = await book(client, visitor, "S-20261102-1000")
    assert (held.state, held.policy_ids) == ("held", ["H.ask.ask-bookings", "H.twin.rv-book-sat",
                                                      "H.twin.rv-book-wk"])
    assert held.answers == ["allow_once", "deny_once", "deny_always"]
    result = await answered(client, copy.owner, held.decision_id, "deny_always")
    assert (result.decision.state, result.decision.visitor_plain, result.execution) == (
        "denied", "Mike Turner decided not to go ahead", None)
    verify_signature(await public_key(client), result.decision)
    # a never card for the tool; for a stranger it can only name anyone
    assert result.card_diff == [RuleCard(card_id="never-anyone-native.book", applies_to="native.book",
                                         mode="never", who="anyone", reason="You said never for this.")]
    assert await rows_of(app, copy.copy_id, select(Execution)) == []
    assert await rows_of(app, copy.copy_id, select(Booking)) == []
    [approval] = await approvals_of(app, copy.copy_id)
    # the answer is on record and used up; a denial binds to nothing it could run
    assert (approval.answer, approval.consumed_at, approval.nonce, approval.binding_sha256) == (
        "deny_always", frozen_clock.now(), None, None)
    [entry] = [e for e in await ledger_rows(app, copy) if e.seq > held.ledger_seq]
    assert (entry.seq, entry.event.kind, entry.event.summary) == (result.decision.ledger_seq, "approval", {
        "decision_id": held.decision_id, "action_id": held.action.action_id, "answer": "deny_always",
        "state": "denied"})

    # for a verified customer, the never card is hers alone
    dana = await verified_visitor(app, client, copy)
    dana_id = await person_id(app, copy, "dana")
    held = await book(client, dana, "S-20261102-1200")
    assert held.answers == ["allow_once", "deny_once", "allow_person", "deny_always"]
    [never] = (await answered(client, copy.owner, held.decision_id, "deny_always")).card_diff
    assert never == RuleCard(card_id=f"never-{dana_id}-native.book", applies_to="native.book", mode="never",
                             who="person", person_id=dana_id, reason="You said never for this.")
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        people = await activation.desk_people(ctx, copy.desk_id)
        profiles = await desks.enabled_profiles(ctx, copy.desk_id)
    for drafted in (result.card_diff, [never]):
        assert compiler.validate_cards([*ASK_BOOKING_CARDS, *drafted], people=people, agent_keys=(),
                                       auto_money_cap_cents=TEST_CAP, money_tools=frozenset()) == []
        compile_at([*ASK_BOOKING_CARDS, *drafted], profiles)


async def test_a_limit_hold_offers_no_deny_always(app, client):
    # the seeded quote holds because 15% off is past rv-quote's limit, not because quotes ask Mike:
    # never quoting again is no answer to a discount, so he is offered the two one-time answers
    copy, held = await seeded_hold(app, client)
    before = await read_id(client, copy.owner, held.decision_id)
    assert (before.policy_ids, before.answers) == (["H.twin.rv-quote"], ["allow_once", "deny_once"])
    response = await post_answer(client, copy.owner, held.decision_id, "deny_always")
    assert (response.status_code, response.json()) == (422, {"code": "invalid"})
    assert await read_id(client, copy.owner, held.decision_id) == before        # still held, nothing changed
    assert await approvals_of(app, copy.copy_id) == []
    [refusal] = [e.event.summary for e in await ledger_rows(app, copy) if e.event.kind == "approval"]
    assert refusal == {"decision_id": held.decision_id, "answer": "deny_always", "refused": "not_offered"}
    assert (await answered(client, copy.owner, held.decision_id, "deny_once")).decision.state == "denied"

    # verified Dana's discount is past the same limit: Mike can allow her for good, not refuse for good
    dana = await verified_visitor(app, client, copy)
    held = await decided(client, dana, "native.quote", quote_args(("drain", 1), discount_bp=1500))
    assert held.answers == ["allow_once", "deny_once", "allow_person"]
    response = await post_answer(client, copy.owner, held.decision_id, "deny_always")
    assert (response.status_code, response.json()) == (422, {"code": "invalid"})
    assert (await read_id(client, copy.owner, held.decision_id)).state == "held"


async def test_a_review_gate_hold_offers_no_deny_always(app, client, reviewer):
    # a weekday booking in opening hours that the reviewer doesn't pass: rv-book-wk's review gate,
    # a limit like its hours, holds it, so Mike isn't offered never taking bookings again
    reviewer.answer = Review(within_charter_bp=4000, manipulation_bp=500, recommendation="hold")
    copy, visitor = await visitor_of(app, client)
    held = await book(client, visitor, "S-20261102-1000")                    # Monday at 10:00
    assert (held.state, held.policy_ids, held.review) == ("held", ["H.twin.rv-book-sat", "H.twin.rv-book-wk"],
                                                          reviewer.answer)
    assert held.answers == ["allow_once", "deny_once"]
    response = await post_answer(client, copy.owner, held.decision_id, "deny_always")
    assert (response.status_code, response.json()) == (422, {"code": "invalid"})
    assert (await read_id(client, copy.owner, held.decision_id)).state == "held"
    assert await approvals_of(app, copy.copy_id) == []


# Mike's drafted card for every change at once; the booking cards are more specific than it.
ASK_CHANGES = RuleCard(card_id="ask-changes", applies_to="effect:change", mode="ask", who="anyone",
                       reason="Changes ask you first.")


async def test_an_ask_card_below_the_booking_cards_leaves_a_limit_hold(app, client):
    # a Sunday 22:00 booking is outside both booking cards' hours (the master's limit-hold
    # example). The effect card's ask matches it too, but the tool's own cards decide, so the hold
    # is their twins' and Mike isn't offered never taking bookings again
    copy, visitor = await visitor_of(app, client)                            # a stranger
    await activate(app, copy, [*RIVERA_CARDS, ASK_CHANGES])
    await add_slot(app, copy, "S-20261101-2200")                             # Sunday at 22:00
    held = await book(client, visitor, "S-20261101-2200")
    assert (held.state, held.policy_ids) == ("held", ["H.ask.ask-changes", "H.twin.rv-book-sat",
                                                      "H.twin.rv-book-wk"])
    assert held.answers == ["allow_once", "deny_once"]
    response = await post_answer(client, copy.owner, held.decision_id, "deny_always")
    assert (response.status_code, response.json()) == (422, {"code": "invalid"})
    assert (await read_id(client, copy.owner, held.decision_id)).state == "held"
    assert await approvals_of(app, copy.copy_id) == []


async def test_a_person_card_decides_over_the_default_ask(app, client, registry):
    # quotes have Dana's own card (list price only) and, for everyone else, the compiler's default
    # ask. The most specific matching card decides: her discount is past her card's limit, a limit
    # hold, though the default ask matches her too; a stranger's quote is held by the default ask
    quote = FakeAdapter("native.quote")
    rows = await desk_with(app, [quote], [])
    dana_id = await add_person(app, rows, "dana", "Dana Whitfield")
    dana_card = RuleCard(card_id=f"person-{dana_id}-native.quote", applies_to="native.quote", mode="auto",
                         who="person", person_id=dana_id, max_discount_bp=0,
                         reason="Allowed for Dana Whitfield after you approved a request like this.")
    async with kernel_ctx(app) as ctx:
        ctx.bind(rows.copy_id)
        await activate_cards(ctx, rows.desk_id, [dana_card])
    dana = await open_visitor(client, rows)
    await verify_session(app, rows.copy_id, dana.session_id, dana_id)

    quote.script["normalize"] = priced(list_cents=18_000)
    allowed = await decided(client, dana, "native.quote", {"qty": 1}, call_id="call-list")
    assert (allowed.outcome, allowed.card_ids) == ("allow", [dana_card.card_id])
    quote.script["normalize"] = priced(list_cents=18_000, discount_bp=1500)
    _, held = await held_on(client, rows, visitor=dana)
    assert held.policy_ids == ["H.ask.default:native.quote", f"H.twin.{dana_card.card_id}"]
    assert held.answers == ["allow_once", "deny_once", "allow_person"]
    assert held.reason_plain == ("Dana Whitfield asked to get a quote for $153 with 15% off. "   # her card alone
                                 f"It goes past your rule, so it waits for you: “{dana_card.reason}”")
    response = await post_answer(client, rows.owner, held.decision_id, "deny_always")
    assert (response.status_code, response.json()) == (422, {"code": "invalid"})
    assert (await read_id(client, rows.owner, held.decision_id)).state == "held"

    _, stranger = await held_on(client, rows)
    assert (stranger.policy_ids, stranger.answers) == (["H.ask.default:native.quote"],
                                                       ["allow_once", "deny_once", "deny_always"])
    [never] = (await answered(client, rows.owner, stranger.decision_id, "deny_always")).card_diff
    assert (never.mode, never.who, never.applies_to) == ("never", "anyone", "native.quote")


async def test_a_mixed_hold_quotes_only_the_cards_that_decided(app, client):
    # Dana's own ask card beside rv-quote (list price, for anyone): both hold policies match her
    # list-price quote, since hold policies carry no exclusions, but her card is the more specific
    # and decides. The owner reads only it under the ask lead-in, the one that offers deny_always:
    # rv-quote's text would read as a rule that asks
    copy = await rivera(app, client)
    dana_id = await person_id(app, copy, "dana")
    dana_ask = RuleCard(card_id=f"ask-{dana_id}-native.quote", applies_to="native.quote", mode="ask",
                        who="person", person_id=dana_id, reason="Dana's quotes wait for your answer.")
    await activate(app, copy, [*RIVERA_CARDS, dana_ask])
    held = await decided(client, await verified_visitor(app, client, copy), "native.quote", quote_args(("drain", 1)))
    assert (held.state, held.policy_ids) == ("held", [f"H.ask.{dana_ask.card_id}", "H.twin.rv-quote"])
    assert held.answers == ["allow_once", "deny_once", "allow_person", "deny_always"]
    assert held.reason_plain == ("Dana Whitfield asked to get a quote for $180. "
                                 "Your rule asks you first: “Dana's quotes wait for your answer.”")


async def held_booking_of_a_past_slot(app: FastAPI, client: httpx.AsyncClient, frozen_clock) -> tuple[Rivera, str]:
    """A stranger's booking of tonight's 22:00 slot (outside the cards' hours, so it holds), and
    the clock moved to 22:30, past the slot's start but well inside the hold's 24 hours."""
    copy, visitor = await visitor_of(app, client)
    await add_slot(app, copy, "S-20261030-2200")
    held = await book(client, visitor, "S-20261030-2200")
    assert held.state == "held"
    frozen_clock.travel(local("S-20261030-2230"))
    return copy, held.decision_id


async def seeded_quote_with_the_tool_disabled(app: FastAPI, client: httpx.AsyncClient,
                                              frozen_clock) -> tuple[Rivera, str]:
    copy, held = await seeded_hold(app, client)
    await change_records(app, copy, "tool_disabled")
    return copy, held.decision_id


@pytest.mark.parametrize("held_request", [held_booking_of_a_past_slot, seeded_quote_with_the_tool_disabled],
                         ids=["slot_now_past", "tool_disabled"])
async def test_approved_recheck_reruns_step_one(app, client, frozen_clock, held_request):
    copy, decision_id = await held_request(app, client, frozen_clock)
    result = await answered(client, copy.owner, decision_id, "allow_once")
    assert (result.decision.state, result.execution) == ("refused_at_execution", None)
    assert await rows_of(app, copy.copy_id, select(Execution)) == []
    assert await rows_of(app, copy.copy_id, select(Booking)) == [] == await rows_of(app, copy.copy_id, select(Quote))
    [approval] = await approvals_of(app, copy.copy_id)
    assert approval.consumed_at == frozen_clock.now()
    assert (await read_id(client, copy.owner, decision_id)).state == "refused_at_execution"


async def test_the_approved_path_runs_prepare_with_the_intent(app, client, registry):
    quote = FakeAdapter("native.quote")
    rows = await desk_with(app, [quote], ASK_QUOTES)
    copy_id = rows.copy_id

    async def reserve(xctx, action) -> None:
        await demo_inbox.deliver(xctx.ctx, copy_id=action.copy_id, desk_id=action.desk_id, to="owner", person_id=None,
                                 kind="alert", body=action.action_id, preview="Reserved")

    seen = []

    async def look(xctx, action, args) -> AdapterResult:
        # what a crash at the side effect would leave: everything T1 wrote, committed together
        approvals = [(a.answer, a.consumed_at is not None) for a in await approvals_of(app, copy_id)]
        seen.append((await reservations(app, copy_id), await committed(app, copy_id, action.action_id), approvals))
        return AdapterResult(model_view={"ok": True})

    quote.script.update(prepare=reserve, execute=look)
    visitor, held = await held_on(client, rows)
    result = await answered(client, rows.owner, held.decision_id, "allow_once")
    assert (result.decision.state, result.execution.state) == ("executed", "succeeded")
    assert seen == [([held.action.action_id], ("intent", "approved"), [("allow_once", True)])]
    assert quote.calls == ["normalize", "normalize", "prepare", "execute"]     # decided, re-checked, prepared, run

    # a prepare refusal: refused at execution, what it wrote taken back, the approval used up, nothing run
    async def reserve_then_refuse(xctx, action) -> None:
        await reserve(xctx, action)
        raise AdapterRefusal("no room")

    quote.script["prepare"] = reserve_then_refuse
    quote.calls.clear()
    _, refused = await held_on(client, rows, visitor=visitor, call_id="call-2")
    result = await answered(client, rows.owner, refused.decision_id, "allow_once")
    assert (result.decision.state, result.execution, result.card_diff) == ("refused_at_execution", None, None)
    assert await committed(app, copy_id, refused.action.action_id) == (None, "refused_at_execution")
    assert await reservations(app, copy_id) == [held.action.action_id]
    assert "execute" not in quote.calls
    assert [a.consumed_at is not None for a in await approvals_of(app, copy_id)] == [True, True]
    [entry] = [e.event.summary for e in await ledger_rows(app, rows) if e.seq == result.decision.ledger_seq]
    assert entry == {"decision_id": refused.decision_id, "action_id": refused.action.action_id,
                     "answer": "allow_once", "state": "refused_at_execution", "reason": "rules_changed",
                     "check": "prepare"}


async def test_a_desk_deleted_after_the_answer_commits_runs_nothing(app, client, registry, monkeypatch):
    """Mike approves a held request, and the Desk is deleted after his answer has committed its
    intent and before the side effect. The approved path's T2 holds the session row and reads the
    Desk afresh, so nothing runs: what `prepare` reserved is undone, the intent is `failed`, and
    the decision `refused_at_execution`, its entry naming the deleted Desk; his answer reads it so."""
    quote = FakeAdapter("native.quote")
    rows = await desk_with(app, [quote], ASK_QUOTES)
    visitor, held = await held_on(client, rows)

    async def delete_the_desk() -> None:
        response = await client.delete(f"/desks/{rows.desk_id}", headers=rows.owner)
        assert response.status_code == 204, response.text

    monkeypatch.setattr(execute, "_after_intent", delete_the_desk)
    result = await answered(client, rows.owner, held.decision_id, "allow_once")
    assert (result.decision.state, result.execution) == ("refused_at_execution", ExecResult(
        action_id=held.action.action_id, state="failed", facts=[], model_view={}))
    assert result.decision.visitor_plain == "The rules changed, so this didn't go ahead"
    assert result.approved is None                    # nothing ran, so the visitor isn't shown it approved
    assert "execute" not in quote.calls and quote.calls[-1] == "on_failed"     # prepared, then undone
    assert await committed(app, rows.copy_id, held.action.action_id) == ("failed", "refused_at_execution")
    [entry] = [e.event.summary for e in await ledger_rows(app, rows) if e.seq == result.decision.ledger_seq]
    assert entry == {"decision_id": held.decision_id, "action_id": held.action.action_id,
                     "state": "refused_at_execution", "reason": "rules_changed", "check": "desk",
                     "policy_version": 1, "auto_money_cap_cents": TEST_CAP}


async def test_other_copy_cannot_answer_or_read(app, client, caplog):
    a, a_visitor, held = await held_quote(app, client)
    b, b_visitor = await visitor_of(app, client)
    caplog.set_level(logging.WARNING, logger="desk.kernel_service")
    refusals = [
        # copy B's owner on A's held request: answering it, reading it, reading A's ledger
        (await post_answer(client, b.owner, held.decision_id, "allow_once"), 404),
        (await client.get(f"/decisions/{held.decision_id}", headers=b.owner), 404),
        (await client.get(f"/ledger/{a.desk_id}", headers=b.owner), 404),
        # a session of copy B cancelling it, and another session of copy A
        (await post_cancel(client, b_visitor, held.decision_id), 404),
        (await post_cancel(client, other := await open_visitor(client, a), held.decision_id), 404),
        # an answer needs the owner's credential alone; a cancel, the session's
        (await post_answer(client, a_visitor.headers, held.decision_id, "allow_once"), 401),
        (await post_answer(client, {**a.owner, **a_visitor.headers}, held.decision_id, "allow_once"), 401),
        (await post_cancel(client, a_visitor, held.decision_id, headers=a.owner), 401),
    ]
    assert [(r.status_code, r.json()) for r, _ in refusals] == [
        (status, {"code": "auth" if status == 401 else "not_found"}) for _, status in refusals]
    # A's request is untouched and still Mike's to answer
    assert (await read_id(client, a.owner, held.decision_id)).state == "held"
    assert await approvals_of(app, a.copy_id) == [] and await rows_of(app, a.copy_id, select(Execution)) == []
    # each refusal is on the ledger of the Desk whose session asked, or logged when no Desk can be named;
    # a read names the decision's session, so B's owner reading it goes on A's ledger
    assert [(e.event.session_id, e.event.summary) for e in await ledger_rows(app, a) if e.event.kind == "auth"] == [
        (a_visitor.session_id, {"route": "GET /decisions/{decision_id}", "reason": "wrong_copy"}),
        (other.session_id, {"route": "POST /decisions/{decision_id}/cancel", "reason": "wrong_session"}),
        (a_visitor.session_id, {"route": "POST /decisions/{decision_id}/cancel", "reason": "bad_token"}),
    ]
    assert [(e.event.session_id, e.event.summary) for e in await ledger_rows(app, b) if e.event.kind == "auth"] == [
        (b_visitor.session_id, {"route": "POST /decisions/{decision_id}/cancel", "reason": "unknown_decision"})]
    unattributed = [r.getMessage() for r in caplog.records if r.getMessage().startswith("auth_unattributed")]
    assert unattributed.count("auth_unattributed route=POST /approvals/{decision_id}/answer "
                              "reason=unknown_decision") == 1
    assert (await answered(client, a.owner, held.decision_id, "allow_once")).decision.state == "executed"


async def test_deny_once_and_cancel(app, client, frozen_clock):
    copy, visitor, held = await held_quote(app, client)
    result = await answered(client, copy.owner, held.decision_id, "deny_once")
    assert (result.decision.state, result.decision.visitor_plain, result.execution, result.card_diff) == (
        "denied", "Mike Turner decided not to go ahead", None, None)
    [approval] = await approvals_of(app, copy.copy_id)
    assert (approval.answer, approval.consumed_at, approval.binding_sha256) == ("deny_once", frozen_clock.now(), None)
    assert await rows_of(app, copy.copy_id, select(Execution)) == []
    [entry] = [e for e in await ledger_rows(app, copy) if e.seq > held.ledger_seq]
    assert (entry.seq, entry.event.kind, entry.event.summary) == (result.decision.ledger_seq, "approval", {
        "decision_id": held.decision_id, "action_id": held.action.action_id, "answer": "deny_once",
        "state": "denied"})

    # the visitor withdraws a request of theirs while it is held, and only then
    second = await decided(client, visitor, "native.quote", quote_args(("drain", 1), discount_bp=1000),
                           call_id="call-2")
    allowed = await decided(client, visitor, "native.quote", quote_args(("drain", 1)), call_id="call-3")
    late = await decided(client, visitor, "native.quote", quote_args(("drain", 1), discount_bp=500), call_id="call-4")
    response = await post_cancel(client, visitor, second.decision_id)
    assert response.status_code == 200, response.text
    assert Decision.model_validate(response.json()).state == "cancelled"
    frozen_clock.advance(24 * 3600)                                            # `late` times out unanswered
    for decision, state in ((second, "cancelled"), (held, "denied"), (allowed, "expired"), (late, "expired")):
        response = await post_cancel(client, visitor, decision.decision_id)
        assert (response.status_code, response.json()) == (409, {"code": "conflict"}), state
        assert (await read_id(client, copy.owner, decision.decision_id)).state == state
    refusals = [e.event.summary for e in await ledger_rows(app, copy)
                if e.event.kind == "decide" and "cancel_refused" in e.event.summary]
    assert refusals == [{"decision_id": d.decision_id, "cancel_refused": state}
                        for d, state in ((second, "cancelled"), (held, "denied"), (allowed, "expired"),
                                         (late, "expired"))]


ENDINGS = {   # how the adapter ends an approved hold in each state
    "executed": {},
    "failed": {"execute": AdapterFailure("slot_taken")},
    "unknown": {"execute": RuntimeError("the provider's answer was lost"), "reconcile": AdapterUnknown("no word yet")},
    "refused_at_execution": {"prepare": AdapterRefusal("no room")},
}


async def read_back(client: httpx.AsyncClient, rows: CopyRows, visitor: Visitor, decision: Decision) -> list[Decision]:
    """The decision read again by ID, by the owner and by its session, and by call."""
    response = await by_call(client, visitor.session_id, decision.call_id, visitor.headers)
    assert response.status_code == 200, response.text
    return [await read_id(client, rows.owner, decision.decision_id),
            await read_id(client, visitor.headers, decision.decision_id), Decision.model_validate(response.json())]


@pytest.mark.parametrize("state", [state for state in get_args(DecisionState) if state != "held"])
async def test_only_a_held_decision_lists_answers(app, client, registry, frozen_clock, state):
    # `answers` is the owner's choice on a held request (the contract: "held only"); in any other
    # state there is none, whether the call that moved it there answers or a later read does
    quote, slots = FakeAdapter("native.quote"), FakeAdapter("native.find_slots", effects=["read"])
    rows = await desk_with(app, [quote, slots], [*ASK_QUOTES, card("slots", "native.find_slots")])
    visitor, held = await held_on(client, rows)
    assert held.answers == ["allow_once", "deny_once", "deny_always"]
    if state == "approved":                                     # read while the approved action runs
        running, release = asyncio.Event(), asyncio.Event()

        async def run(xctx, action, args) -> AdapterResult:
            running.set()
            await release.wait()
            return AdapterResult(model_view={"ok": True})

        quote.script["execute"] = run
        answering = asyncio.create_task(post_answer(client, rows.owner, held.decision_id, "allow_once"))
        try:
            await asyncio.wait_for(running.wait(), 10)
            decision = await read_id(client, rows.owner, held.decision_id)
            reads = await read_back(client, rows, visitor, decision)
        finally:
            release.set()                                       # never left holding the decision row
        assert (await asyncio.wait_for(answering, 10)).status_code == 200
    else:
        if state == "allowed":
            decision = await decided(client, visitor, "native.find_slots", call_id="call-2")
        elif state == "refused":
            decision = await decided(client, visitor, "native.transfer_funds", call_id="call-2")
        elif state == "denied":
            decision = (await answered(client, rows.owner, held.decision_id, "deny_once")).decision
        elif state == "expired":
            frozen_clock.advance(24 * 3600)
            decision = await read_id(client, rows.owner, held.decision_id)
        elif state == "cancelled":
            response = await post_cancel(client, visitor, held.decision_id)
            assert response.status_code == 200, response.text
            decision = Decision.model_validate(response.json())
        else:
            quote.script.update(ENDINGS[state])
            decision = (await answered(client, rows.owner, held.decision_id, "allow_once")).decision
        reads = await read_back(client, rows, visitor, decision)
    assert [(d.state, d.answers) for d in (decision, *reads)] == [(state, [])] * 4


async def set_binding(app: FastAPI, copy_id: str, approval_id: str, binding: str) -> None:
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy_id)
        row = (await ctx.db.scalars(ctx.repo.scoped(select(Approval).where(Approval.approval_id == approval_id)))).one()
        row.binding_sha256 = binding


async def test_reconcile_with_a_mismatched_binding_is_409(app, client, registry):
    quote = FakeAdapter("native.quote")
    rows = await desk_with(app, [quote], ASK_QUOTES)
    visitor, held = await held_on(client, rows)
    quote.script["execute"] = RuntimeError("the provider's answer was lost")
    result = await answered(client, rows.owner, held.decision_id, "allow_once")
    assert (result.decision.state, result.execution.state) == ("unknown", "unknown")   # never retried blindly
    [approval] = await approvals_of(app, rows.copy_id)
    quote.script["reconcile"] = AdapterResult(model_view={"ok": True})        # the provider says it went through

    async def reconcile(approval_id: str, headers: dict[str, str]) -> httpx.Response:
        return await client.post("/execute", headers=headers, json={
            "decision_id": held.decision_id, "session_id": visitor.session_id, "approval_id": approval_id})

    # an approval whose binding no longer matches the action, or another approval, reconciles nothing
    await set_binding(app, rows.copy_id, approval.approval_id, "0" * 64)
    for approval_id, headers in ((approval.approval_id, rows.owner), (approval.approval_id, visitor.headers),
                                 ("apr-forged", rows.owner)):
        response = await reconcile(approval_id, headers)
        assert (response.status_code, response.json()) == (409, {"code": "conflict"}), approval_id
    assert "reconcile" not in quote.calls
    assert await committed(app, rows.copy_id, held.action.action_id) == ("unknown", "unknown")
    refusals = [e.event.summary for e in await ledger_rows(app, rows) if e.event.kind == "execute"
                and "refused" in e.event.summary]
    assert refusals == [{"decision_id": held.decision_id, "refused": "binding"}] * 2 + [
        {"decision_id": held.decision_id, "refused": "unknown"}]

    # with its own binding back, the approval reconciles the action once, to what the provider did
    await set_binding(app, rows.copy_id, approval.approval_id, approval.binding_sha256)
    response = await reconcile(approval.approval_id, rows.owner)
    assert response.status_code == 200, response.text
    assert ExecResult.model_validate(response.json()) == ExecResult(action_id=held.action.action_id, state="succeeded",
                                                                    facts=[], model_view={"ok": True})
    assert await committed(app, rows.copy_id, held.action.action_id) == ("succeeded", "executed")
    assert quote.calls.count("reconcile") == 1 and quote.calls.count("execute") == 1
