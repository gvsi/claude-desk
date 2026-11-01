"""Link completion: a payment link pays once, a rule change cancels the open links it no longer
allows, and an outcome nobody knows is settled at the mock payments provider.

Completion follows the execution shape (master plan "Payment links"): C1 locks the link, checks it
can still be paid and rechecks the baseline (never the rules), then commits a marker; C2 locks it
again, completes the checkout at the provider and commits `paid`, a `charge` fact and a signed
`payment_confirmed` verdict; C3 settles an exception in C2. A read, a restart and an activation each
find a link in the state C1 to C3 left it, and only the provider's atomic cancel settles one whose
outcome is unknown.

Tests run on Turner Plumbing copies as `POST /copies` seeds them (Friday 10:04 in Oakland): links come
from the seed's `rv-link` (auto up to $300, checked by the reviewer, whose score passes unless a test
says otherwise). A test that drafts and confirms cards needs the solver (`solver`).
"""

import asyncio
import dataclasses
import json
import logging
import time
from datetime import time as clock_time
from datetime import timedelta

import httpx
import psycopg
import pytest
from cryptography.exceptions import InvalidSignature
from fastapi import FastAPI
from sqlalchemy import Select, select, text
from sqlalchemy.exc import NoSuchColumnError
from sqlalchemy.ext.asyncio import AsyncSession

from desk.contracts import HoursWindow, PolicyVersion, Review, RuleCard
from desk.db.models import Document
from desk.db.models import Fact as FactRow
from desk.db.models import PaymentLink
from desk.db.session import database_url, libpq_url
from desk.kernel_api import LinkCancelled, PaymentLinkStateResult
from desk.kernel_service import payments, reply_check
from desk.kernel_service.app import create_app
from desk.kernel_service.seed import RIVERA_CARDS

from .fakes import FakeDecisions
from .helpers import connections_of, draft_and_confirm, kernel_ctx, ledger_rows, rows_of, until_waiting
from .test_adapters import Rivera, quote_args, rivera
from .test_approvals import answered
from .test_context import context_of, get_context
from .test_decide import Visitor, decided, open_visitor, set_session
from .test_execute import executed
from .test_money_cap import post_draft
from .test_payment_links import confirm, delay, link_for, nothing_listening, quoted, view
from .test_release_document import confirmed, violations
from .test_reply_check import assert_handed_off, checked, clause, public_key, verify_verdict
from .test_sessions import set_mode

PASS = Review(within_charter_bp=9500, manipulation_bp=300, recommendation="allow")


async def rv_link(app: FastAPI, client: httpx.AsyncClient, reviewer: FakeDecisions, copy: Rivera, visitor: Visitor,
                  *items: tuple[str, int], call_id: str = "call-link") -> PaymentLink:
    """A link to a new quote for `items` (the deposit by default), auto-allowed under `rv-link` with a
    passing review, and executed: its row."""
    reviewer.answer = PASS
    quote_id = await quoted(client, visitor, *(items or (("deposit", 1),)), call_id=f"{call_id}-quote")
    decision = await link_for(client, visitor, quote_id, call_id=call_id)
    assert (decision.outcome, decision.card_ids) == ("allow", ["rv-link"]), decision.reason_plain
    assert (await executed(client, visitor, decision)).state == "succeeded"
    [link] = await rows_of(app, copy.copy_id, select(PaymentLink).where(
        PaymentLink.action_id == decision.action.action_id))
    return link


async def link_row(app: FastAPI, copy: Rivera, link_id: str) -> PaymentLink:
    [link] = await rows_of(app, copy.copy_id, select(PaymentLink).where(PaymentLink.link_id == link_id))
    return link


async def post_complete(client: httpx.AsyncClient, token: str) -> httpx.Response:
    return await client.post(f"/payment_links/{token}/complete", json={})


async def completed(client: httpx.AsyncClient, token: str) -> PaymentLinkStateResult:
    response = await post_complete(client, token)
    assert response.status_code == 200, response.text
    return PaymentLinkStateResult.model_validate(response.json())


def charges(copy: Rivera) -> list[tuple]:
    """The copy's charges at the mock payments server, read as its own role: (key, amount, customer).
    The seed's past payments (keys `seed:<id>`, plan 01c Task 4) are left out: only what links paid."""
    with psycopg.connect(libpq_url(database_url("MOCKPAY"))) as conn:
        return conn.execute("SELECT idempotency_key, amount_cents, customer_id FROM mockpay.charges"
                            " WHERE copy_id = %s AND idempotency_key NOT LIKE 'seed:%%' ORDER BY idempotency_key",
                            (copy.copy_id,)).fetchall()


async def payment_entries(app: FastAPI, copy: Rivera) -> list[dict]:
    return [entry.event.summary for entry in await ledger_rows(app, copy) if entry.event.kind == "payment"]


def refusal(link: PaymentLink, state: str, reason: str) -> dict:
    """A refused completion or cancel's `payment` entry: marked `refused`, so no retry reads as a move,
    with the state the link stays in and why it was refused."""
    return {"link_id": link.link_id, "refused": True, "state": state, "reason": reason}


async def test_complete_pays_once(app, client, reviewer):
    copy = await rivera(app, client)
    visitor = await open_visitor(client, copy)
    link = await rv_link(app, client, reviewer, copy, visitor)

    result = await completed(client, link.token)
    assert (result.state, result.session_id) == ("paid", visitor.session_id)
    assert charges(copy) == [(f"{link.action_id}:charge", 2_000, f"session:{visitor.session_id}")]
    paid = await link_row(app, copy, link.link_id)
    assert paid.state == "paid" and paid.completion_started_at is not None
    [issued, done] = await payment_entries(app, copy)
    assert issued == {"link_id": link.link_id, "state": "issued", "version": 1}
    assert {key: done[key] for key in ("link_id", "state")} == {"link_id": link.link_id, "state": "paid"}

    # again: refused, ledgered, and nothing more is charged
    response = await post_complete(client, link.token)
    assert (response.status_code, response.json()) == (409, {"code": "conflict"})
    assert (await payment_entries(app, copy))[-1] == refusal(link, "paid", "paid")
    assert len(charges(copy)) == 1
    assert (await link_row(app, copy, link.link_id)).state == "paid"


async def charge_facts(app: FastAPI, copy: Rivera) -> list[FactRow]:
    """The `charge` facts paid links wrote, each naming its link's action; the seed's past payments,
    which no action made, are left out."""
    return await rows_of(app, copy.copy_id, select(FactRow).where(
        FactRow.kind == "charge", FactRow.action_id.is_not(None)).order_by(FactRow.fact_id))


async def test_concurrent_completes_pay_once(app, client, reviewer):
    copy = await rivera(app, client)
    visitor = await open_visitor(client, copy)
    link = await rv_link(app, client, reviewer, copy, visitor)

    responses = await asyncio.gather(*(post_complete(client, link.token) for _ in range(2)))
    assert sorted(response.status_code for response in responses) == [200, 409]
    [paid] = [PaymentLinkStateResult.model_validate(r.json()) for r in responses if r.status_code == 200]
    assert paid.state == "paid" and paid.verdict is not None and len(paid.verdict.blocks) == 1
    # one charge, one charge fact and one verdict's reply entry, whichever won
    assert len(charges(copy)) == 1 and len(await charge_facts(app, copy)) == 1
    replies = [entry for entry in await ledger_rows(app, copy)
               if entry.event.kind == "reply" and entry.event.summary["author"] == "desk"]
    assert len(replies) == 1
    # the loser is refused, ledgered: while the winner completes it, or once it is paid
    entries = await payment_entries(app, copy)
    assert [entry["state"] for entry in entries if not entry.get("refused")] == ["issued", "paid"]
    [refused] = [entry for entry in entries if "refused" in entry]
    assert refused in (refusal(link, "issued", "completing"), refusal(link, "paid", "paid"))


async def post_cancel(client: httpx.AsyncClient, token: str) -> httpx.Response:
    return await client.post(f"/payment_links/{token}/cancel", json={})


async def test_cancel_during_completion_is_refused(app, client, reviewer, monkeypatch):
    copy = await rivera(app, client)
    visitor = await open_visitor(client, copy)
    link = await rv_link(app, client, reviewer, copy, visitor)
    answers = []

    async def cancel_now() -> None:                                 # the marker is committed, nothing sent yet
        answers.append(await post_cancel(client, link.token))

    monkeypatch.setattr(payments, "_after_marker", cancel_now)
    assert (await completed(client, link.token)).state == "paid"
    [refused] = answers
    assert (refused.status_code, refused.json()) == (409, {"code": "conflict"})
    assert (await link_row(app, copy, link.link_id)).state == "paid" and len(charges(copy)) == 1
    assert refusal(link, "issued", "completing") in await payment_entries(app, copy)


async def test_read_during_completion_leaves_it_alone(app, client, reviewer, mockpay, monkeypatch):
    copy = await rivera(app, client)
    visitor = await open_visitor(client, copy)
    link = await rv_link(app, client, reviewer, copy, visitor)
    seen = []

    async def read_now() -> None:                                   # between C1 and C2: the row isn't locked
        seen.append(await view(client, link.token))

    monkeypatch.setattr(payments, "_after_marker", read_now)
    await delay(mockpay, copy, "complete", 1)
    completion = asyncio.create_task(completed(client, link.token))
    await asyncio.sleep(0.5)                                        # C2 holds the row while the provider answers
    started = time.monotonic()
    seen.append(await view(client, link.token))
    assert time.monotonic() - started < 0.5                         # the read didn't wait for C2
    assert [(each.state, each.cancel_reason) for each in seen] == [("issued", None)] * 2
    assert (await asyncio.wait_for(completion, 5)).state == "paid"
    assert (await view(client, link.token)).state == "paid" and len(charges(copy)) == 1


async def test_a_decision_during_a_completion_waits_for_it_and_both_finish(app, client, reviewer, monkeypatch):
    copy = await rivera(app, client)
    visitor = await open_visitor(client, copy)
    link = await rv_link(app, client, reviewer, copy, visitor)
    at_provider, answer = asyncio.Event(), asyncio.Event()
    complete = payments.ProviderClient.complete

    async def held_at_the_provider(self, checkout_id: str):
        at_provider.set()
        await answer.wait()
        return await complete(self, checkout_id)

    monkeypatch.setattr(payments.ProviderClient, "complete", held_at_the_provider)
    with connections_of(app) as pids:
        completing = asyncio.create_task(completed(client, link.token))
        await asyncio.wait_for(at_provider.wait(), 5)   # C2 holds the session row FOR SHARE at the provider
        deciding = asyncio.create_task(decided(client, visitor, "native.quote", quote_args(("deposit", 1)),
                                               call_id="call-during"))
        # the decision asks for the same row FOR UPDATE (`auth.lock_session`), and waits for C2
        await until_waiting(app, deciding, pids)
        assert not deciding.done()
        answer.set()
        paid = await asyncio.wait_for(completing, 10)
        decision = await asyncio.wait_for(deciding, 10)
    assert paid.state == "paid" and paid.verdict is not None
    assert decision.outcome == "allow", decision.reason_plain
    # nothing deadlocked, and the decision committed after the completion: its entry follows the payment's
    [paid_seq] = [entry.seq for entry in await ledger_rows(app, copy)
                  if entry.event.kind == "payment" and entry.event.summary.get("state") == "paid"]
    assert decision.ledger_seq > paid_seq


async def test_late_completion_is_refused(app, client, reviewer, frozen_clock):
    copy = await rivera(app, client)
    visitor = await open_visitor(client, copy)
    link = await rv_link(app, client, reviewer, copy, visitor)
    frozen_clock.advance((link.expires_at - frozen_clock.now()).total_seconds())     # a day has passed
    response = await post_complete(client, link.token)
    assert (response.status_code, response.json()) == (409, {"code": "conflict"})
    assert (await link_row(app, copy, link.link_id)).state == "expired" and charges(copy) == []
    assert (await payment_entries(app, copy))[1:] == [
        {"link_id": link.link_id, "state": "expired", "reason": "expired"}, refusal(link, "expired", "expired")]
    # the link's fact went with it, and the link can't be cancelled either
    [fact] = await rows_of(app, copy.copy_id, select(FactRow).where(FactRow.fact_id == f"payment_link:{link.link_id}"))
    assert fact.status == "expired"
    response = await post_cancel(client, link.token)
    assert (response.status_code, response.json()) == (409, {"code": "conflict"})


async def test_cancelled_link_cannot_be_paid(app, client, reviewer):
    copy = await rivera(app, client)
    visitor = await open_visitor(client, copy)
    link = await rv_link(app, client, reviewer, copy, visitor)
    response = await post_cancel(client, link.token)
    assert response.status_code == 200, response.text
    cancelled = PaymentLinkStateResult.model_validate(response.json())
    assert (cancelled.state, cancelled.session_id, cancelled.verdict) == ("cancelled", visitor.session_id, None)
    for again in (post_complete, post_cancel):
        response = await again(client, link.token)
        assert (response.status_code, response.json()) == (409, {"code": "conflict"}), again
    assert charges(copy) == [] and (await link_row(app, copy, link.link_id)).state == "cancelled"
    assert (await view(client, link.token)).state == "cancelled"
    assert (await payment_entries(app, copy))[1:] == [
        {"link_id": link.link_id, "state": "cancelled", "reason": "cancelled"},
        refusal(link, "cancelled", "cancelled"), refusal(link, "cancelled", "cancelled")]


async def charged(copy: Rivera, key: str, within: float = 6.0) -> None:
    """Waits until the provider holds a charge under `key` (a delayed completion finishing)."""
    deadline = time.monotonic() + within
    while not [row for row in charges(copy) if row[0] == key]:
        assert time.monotonic() < deadline, "the delayed completion never landed"
        await asyncio.sleep(0.1)


@pytest.mark.parametrize("read", ["after_it_lands", "before_it_lands"])
async def test_provider_timeout_settles_once(app, client, reviewer, mockpay, read):
    copy = await rivera(app, client)
    visitor = await open_visitor(client, copy)
    link = await rv_link(app, client, reviewer, copy, visitor)
    # the provider takes 3 s, past the 2 s deadline: the payment may still land, so the link is unknown
    await delay(mockpay, copy, "complete", 3)
    started = time.monotonic()
    result = await completed(client, link.token)
    assert time.monotonic() - started < 3
    assert (result.state, result.verdict) == ("unknown", None)
    row = await link_row(app, copy, link.link_id)
    assert (row.state, row.completion_started_at is not None) == ("unknown", True)
    response = await post_complete(client, link.token)                  # it isn't completed again
    assert (response.status_code, response.json()) == (409, {"code": "conflict"})
    key = f"{link.action_id}:charge"
    if read == "after_it_lands":
        # a read settles it with the provider's atomic cancel, which finds the checkout paid
        await charged(copy, key)
        seen = await view(client, link.token)
        assert seen.state == "paid"
        [fact] = await charge_facts(app, copy)
        assert fact.fact_id.startswith("charge:") and fact.status == "committed"
        assert paid_entry(await payment_entries(app, copy))["reconciled"] is True
    else:
        # a read before it lands cancels the checkout first: the late completion is refused there
        seen = await view(client, link.token)
        assert (seen.state, seen.cancel_reason) == ("expired", None)
        await asyncio.sleep(3.5)                                        # the delayed request runs, and fails
        assert charges(copy) == [] and await charge_facts(app, copy) == []
    assert len(charges(copy)) == (1 if read == "after_it_lands" else 0)
    assert (await view(client, link.token)).state == seen.state          # settled once


async def test_a_reads_reconciliation_stands_when_the_read_fails_after_it(app, client, reviewer, mockpay,
                                                                          monkeypatch):
    """A read that settles a link records what the provider says already happened (here, that the
    checkout was paid) and commits it at once, before the read goes on: the read failing afterwards
    leaves the link `paid`, with its charge fact, and the next read finds it settled, asking the
    provider nothing again."""
    copy = await rivera(app, client)
    visitor = await open_visitor(client, copy)
    link = await rv_link(app, client, reviewer, copy, visitor)
    await delay(mockpay, copy, "complete", 3)
    assert (await completed(client, link.token)).state == "unknown"
    await charged(copy, f"{link.action_id}:charge")

    async def fails(*args, **kwargs):
        raise RuntimeError("the read fails after its reconciliation")

    monkeypatch.setattr(payments.labels, "copy_canaries", fails)          # read after the link is settled
    response = await client.get(f"/payment_links/{link.token}")
    assert (response.status_code, response.json()) == (500, {"code": "internal"})
    assert (await link_row(app, copy, link.link_id)).state == "paid"
    assert len(await charge_facts(app, copy)) == 1
    assert paid_entry(await payment_entries(app, copy))["reconciled"] is True
    monkeypatch.undo()
    assert (await view(client, link.token)).state == "paid"
    assert len([entry for entry in await payment_entries(app, copy) if entry.get("state") == "paid"]) == 1


def paid_entry(entries: list[dict]) -> dict:
    [paid] = [entry for entry in entries if entry.get("state") == "paid"]
    return paid


async def test_provider_error_returns_the_link_to_issued(app, client, reviewer):
    copy = await rivera(app, client)
    visitor = await open_visitor(client, copy)
    link = await rv_link(app, client, reviewer, copy, visitor)
    # the provider can't be reached: nothing reached it, so the link is payable again
    runtime = app.state.kernel
    app.state.kernel = dataclasses.replace(runtime, settings=dataclasses.replace(runtime.settings,
                                                                                mockpay_url=nothing_listening()))
    try:
        response = await post_complete(client, link.token)
    finally:
        app.state.kernel = runtime
    assert (response.status_code, response.json()) == (502, {"code": "internal"})
    row = await link_row(app, copy, link.link_id)
    assert (row.state, row.completion_started_at) == ("issued", None)
    assert (await payment_entries(app, copy))[-1] == {"link_id": link.link_id, "state": "issued",
                                                      "reason": "provider_refused"}
    assert (await completed(client, link.token)).state == "paid"
    assert len(charges(copy)) == 1


async def test_restart_mid_completion_pays_at_most_once(app, client, reviewer, frozen_clock, monkeypatch):
    copy = await rivera(app, client)
    visitor = await open_visitor(client, copy)
    link = await rv_link(app, client, reviewer, copy, visitor)
    # the provider has taken the payment when writing `paid` fails: nobody knows, so it is unknown
    record_paid = payments.record_paid

    async def failing(*args, **kwargs):
        raise RuntimeError("the write failed")

    monkeypatch.setattr(payments, "record_paid", failing)
    result = await completed(client, link.token)
    assert (result.state, result.verdict) == ("unknown", None)
    assert len(charges(copy)) == 1 and await charge_facts(app, copy) == []
    monkeypatch.setattr(payments, "record_paid", record_paid)

    # and a link whose completion started before the kernel stopped, with no outcome written at all
    other = await rv_link(app, client, reviewer, copy, visitor, call_id="call-other")
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        row = (await ctx.db.scalars(ctx.repo.scoped(select(PaymentLink).where(
            PaymentLink.link_id == other.link_id)))).one()
        row.completion_started_at = ctx.clock.now()
    frozen_clock.advance(31)                                            # older than any running completion

    # a restarted kernel settles both with the provider: the first paid once, the other never sent
    restarted = create_app(app.state.kernel.settings, clock=frozen_clock, decisions=reviewer)
    async with asyncio.timeout(10), restarted.router.lifespan_context(restarted):
        pass
    assert (await link_row(app, copy, link.link_id)).state == "paid"
    assert (await link_row(app, copy, other.link_id)).state == "expired"
    assert charges(copy) == [(f"{link.action_id}:charge", 2_000, f"session:{visitor.session_id}")]
    assert len(await charge_facts(app, copy)) == 1
    entries = await payment_entries(app, copy)
    assert {"link_id": other.link_id, "state": "unknown", "reason": "orphaned"} in entries
    assert {"link_id": other.link_id, "state": "expired", "reason": "expired", "reconciled": True} in entries


async def test_completion_returns_a_signed_payment_confirmed_verdict(app, client, reviewer):
    copy = await rivera(app, client)
    dana = await confirmed(client, copy, "dana@example.com")
    link = await rv_link(app, client, reviewer, copy, dana)
    dana_id = link.customer_id.removeprefix("person:")
    # Dana last wrote in Spanish, then the owner took the conversation over: the verdict is in her
    # language, at the generation the conversation is at now, whatever its mode
    assert (await checked(client, dana, "Hola, ¿qué tal?")).language == "es"
    response = await set_mode(client, copy, dana.session_id, "owner", 0)
    assert response.status_code == 200, response.text

    result = await completed(client, link.token)
    verdict = result.verdict
    assert (result.state, verdict.ok, verdict.violations, verdict.generation, verdict.language) == (
        "paid", True, [], 1, "es")
    [block] = verdict.blocks
    [fact] = await charge_facts(app, copy)
    assert (block.kind, block.template, block.fact_id, block.title, block.lines, block.href) == (
        "card", "payment_confirmed", fact.fact_id, "Service call deposit, $20.00", [], None)
    assert verdict.visitor_plain == "Respuesta revisada con las reglas de Mike Turner"
    verify_verdict(await public_key(client), dana.session_id, verdict)
    reply = [entry for entry in await ledger_rows(app, copy) if entry.event.kind == "reply"][-1]
    assert (reply.seq, reply.event.session_id, reply.event.summary["author"], reply.event.summary["fact_ids"]) == (
        verdict.ledger_seq, dana.session_id, "desk", [fact.fact_id])

    # the charge fact: the link's title and total, Dana's and her session's, never Claude's to word
    charge_id = fact.fact_id.removeprefix("charge:")
    assert charges(copy) == [(f"{link.action_id}:charge", 2_000, f"person:{dana_id}")]
    assert (fact.kind, fact.status, fact.source, fact.record_owner, fact.session_id) == (
        "charge", "committed", "kernel", dana_id, dana.session_id)
    assert fact.readers == ["owner", f"session:{dana.session_id}", f"person:{dana_id}"]
    assert [(claim.key, claim.value) for claim in fact.claims] == [
        ("title", "Service call deposit"), ("total", 2_000), ("ref", link.link_id)]
    paid = paid_entry(await payment_entries(app, copy))
    assert paid == {"link_id": link.link_id, "state": "paid", "charge_id": charge_id, "policy_version": 1,
                    "auto_money_cap_cents": 50_000}
    # Dana reads it from another session she verifies in; a stranger doesn't
    again = await confirmed(client, copy, "dana@example.com")
    assert fact.fact_id in [f.fact_id for f in (await context_of(client, again.session_id, again.headers)).facts]
    stranger = await open_visitor(client, copy)
    assert fact.fact_id not in [f.fact_id for f in (await context_of(client, stranger.session_id,
                                                                     stranger.headers)).facts]

    # a cancel carries no verdict
    other = await rv_link(app, client, reviewer, copy, again, call_id="call-other")
    response = await post_cancel(client, other.token)
    assert (response.status_code, response.json()["verdict"]) == (200, None)



async def test_link_fact_follows_the_link(app, client, reviewer):
    copy = await rivera(app, client)
    visitor = await open_visitor(client, copy)
    paid, cancelled = [await rv_link(app, client, reviewer, copy, visitor, call_id=f"call-{n}") for n in range(2)]
    assert (await completed(client, paid.token)).state == "paid"
    assert (await post_cancel(client, cancelled.token)).status_code == 200
    # neither link can be shown again: its fact left `available` with it
    for link in (paid, cancelled):
        fact_id = f"payment_link:{link.link_id}"
        verdict = await checked(client, visitor, "Here is your payment link.", [clause("payment_link", fact_id)])
        assert violations(verdict) == [("stale_fact", "not_current", [fact_id])]
        assert link.token not in verdict.model_dump_json()


async def test_deleting_the_desk_cancels_issued_links(app, client, reviewer, mockpay):
    copy = await rivera(app, client)
    visitor = await open_visitor(client, copy)
    open_link, marked, unknown = [await rv_link(app, client, reviewer, copy, visitor, call_id=f"call-{n}")
                                  for n in range(3)]
    await delay(mockpay, copy, "complete", 3)
    assert (await completed(client, unknown.token)).state == "unknown"
    async with kernel_ctx(app) as ctx:                                  # a completion running as the Desk goes
        ctx.bind(copy.copy_id)
        (await ctx.db.scalars(ctx.repo.scoped(select(PaymentLink).where(
            PaymentLink.link_id == marked.link_id)))).one().completion_started_at = ctx.clock.now()
    response = await client.delete(f"/desks/{copy.desk_id}", headers=copy.owner)
    assert response.status_code == 204, response.text

    # the open link is cancelled with the Desk, ledgered; the other two may be at the provider, so wait
    # for their completion or reconciliation
    states = {link.link_id: (await link_row(app, copy, link.link_id)).state for link in (open_link, marked, unknown)}
    assert states == {open_link.link_id: "cancelled", marked.link_id: "issued", unknown.link_id: "unknown"}
    assert (await link_row(app, copy, open_link.link_id)).cancel_reason is None
    entries = await payment_entries(app, copy)
    assert {"link_id": open_link.link_id, "state": "cancelled", "reason": "desk_deleted"} in entries
    [fact] = await rows_of(app, copy.copy_id, select(FactRow).where(
        FactRow.fact_id == f"payment_link:{open_link.link_id}"))
    assert fact.status == "expired"
    response = await post_complete(client, open_link.token)
    assert (response.status_code, response.json()) == (409, {"code": "conflict"})
    # the marked link waits for the completion that started it; no other may start
    response = await post_complete(client, marked.token)
    assert (response.status_code, response.json()) == (409, {"code": "conflict"})


@pytest.mark.parametrize("change", ["person_removed", "amount_mismatch"])
async def test_completion_rechecks_the_baseline(app, client, reviewer, change):
    copy = await rivera(app, client)
    dana = await confirmed(client, copy, "dana@example.com")
    link = await rv_link(app, client, reviewer, copy, dana)
    if change == "person_removed":
        # Dana is taken off the record after her link was issued: no money moves for her any more
        response = await client.put(f"/desks/{copy.desk_id}/people", headers=copy.owner,
                                    json={"upsert": [], "remove": ["dana"]})
        assert response.status_code == 200, response.text
    else:
        # the link's amount no longer equals the amount its action was decided on
        async with kernel_ctx(app) as ctx:
            ctx.bind(copy.copy_id)
            (await ctx.db.scalars(ctx.repo.scoped(select(PaymentLink).where(
                PaymentLink.link_id == link.link_id)))).one().amount_cents = 1_999
    response = await post_complete(client, link.token)
    assert (response.status_code, response.json()) == (409, {"code": "conflict"})
    row = await link_row(app, copy, link.link_id)
    assert (row.state, row.cancel_reason, row.completion_started_at) == ("cancelled", change, None)
    assert charges(copy) == [] and await charge_facts(app, copy) == []
    assert (await payment_entries(app, copy))[-1] == {"link_id": link.link_id, "state": "cancelled", "reason": change}
    seen = await view(client, link.token)
    assert (seen.state, seen.cancel_reason, seen.customer_name) == ("cancelled", None, None)


@pytest.mark.parametrize("change", ["session_closed", "person_removed"])
async def test_completion_checks_its_session_before_the_provider_is_asked(app, client, reviewer, frozen_clock,
                                                                          monkeypatch, change):
    """C2 asks whether the link's session still stands (`auth.session_stands`), under the session row
    it holds, before the provider is asked: Dana's session closed, or Dana taken off the record, after
    C1 committed its marker pays nothing. The link is cancelled, ledgered with why, and the answer is
    409, as a failed baseline in C1 is."""
    copy = await rivera(app, client)
    dana = await confirmed(client, copy, "dana@example.com")
    link = await rv_link(app, client, reviewer, copy, dana)

    async def session_ends() -> None:                               # the marker is committed, nothing sent yet
        if change == "session_closed":
            await set_session(app, copy, dana.session_id, closed_at=frozen_clock.now())
        else:
            response = await client.put(f"/desks/{copy.desk_id}/people", headers=copy.owner,
                                        json={"upsert": [], "remove": ["dana"]})
            assert response.status_code == 200, response.text

    monkeypatch.setattr(payments, "_after_marker", session_ends)
    response = await post_complete(client, link.token)
    assert (response.status_code, response.json()) == (409, {"code": "conflict"})
    assert charges(copy) == [] and await charge_facts(app, copy) == []          # the provider was never asked
    row = await link_row(app, copy, link.link_id)
    assert (row.state, row.cancel_reason) == ("cancelled", "person_removed" if change == "person_removed" else None)
    assert (await payment_entries(app, copy))[-1] == {"link_id": link.link_id, "state": "cancelled", "reason": change}
    again = await post_complete(client, link.token)                         # and it never pays later
    assert (again.status_code, again.json()) == (409, {"code": "conflict"})


async def test_a_paid_link_stays_paid_whatever_happens_to_its_session(app, client, reviewer, monkeypatch):
    """The provider has completed the checkout and C2 is about to commit when the owner removes Dana,
    whose removal waits for the session row C2 holds: the payment is recorded as C2 decided (`paid`,
    its charge fact, its verdict) and answered, never rolled back, and the removal then closes her
    session."""
    copy = await rivera(app, client)
    dana = await confirmed(client, copy, "dana@example.com")
    link = await rv_link(app, client, reviewer, copy, dana)
    recorded, go_on = asyncio.Event(), asyncio.Event()
    record = payments.record_paid

    async def record_then_wait(*args, **kwargs):
        verdict = await record(*args, **kwargs)
        recorded.set()                                       # the provider has charged; C2 hasn't committed
        await go_on.wait()
        return verdict

    monkeypatch.setattr(payments, "record_paid", record_then_wait)
    paying = asyncio.create_task(post_complete(client, link.token))
    await asyncio.wait_for(recorded.wait(), timeout=5)
    with connections_of(app) as pids:
        removing = asyncio.create_task(client.put(f"/desks/{copy.desk_id}/people", headers=copy.owner,
                                                  json={"upsert": [], "remove": ["dana"]}))
        await until_waiting(app, removing, pids)            # for Dana's session row, which C2 holds
    go_on.set()
    paid, removed = await asyncio.wait_for(asyncio.gather(paying, removing), timeout=5)
    assert removed.status_code == 200, removed.text
    assert paid.status_code == 200, paid.text
    assert PaymentLinkStateResult.model_validate(paid.json()).state == "paid"
    assert (await link_row(app, copy, link.link_id)).state == "paid"
    assert len(charges(copy)) == 1 and len(await charge_facts(app, copy)) == 1
    assert paid_entry(await payment_entries(app, copy))["link_id"] == link.link_id
    after = await get_context(client, dana.session_id, dana.headers)
    assert (after.status_code, after.json()) == (409, {"code": "closed"})


@pytest.mark.parametrize("template", ["link_cancelled", "payment_confirmed"])
async def test_claude_cannot_draft_link_cancelled(app, client, reviewer, template):
    """Only the kernel tells a visitor a link was cancelled or a payment landed. Claude drafting either
    card is refused, even when it cites a fact of the kind the card renders that the conversation can
    read: its charge, or its own payment link's, open or cancelled. Another visitor's chat citing that
    charge or cancelled link gets the same answer, so the refusal says nothing of whose fact it is.
    Nor can the prose beside a card say a link's amount."""
    copy = await rivera(app, client)
    visitor = await open_visitor(client, copy)
    cited = ["payment_link:paylink-aaaaaaaaaaaaaaaa"]
    if template == "payment_confirmed":
        link = await rv_link(app, client, reviewer, copy, visitor)
        assert (await completed(client, link.token)).state == "paid"
        [fact] = await charge_facts(app, copy)
        cited = [fact.fact_id]
        assert fact.fact_id in [f.fact_id for f in (await context_of(client, visitor.session_id,
                                                                     visitor.headers)).facts]
    else:
        live, cancelled = [await rv_link(app, client, reviewer, copy, visitor, call_id=f"call-{n}") for n in range(2)]
        assert (await post_cancel(client, cancelled.token)).status_code == 200
        cited += [f"payment_link:{link.link_id}" for link in (live, cancelled)]
        assert cited[1] in [f.fact_id for f in (await context_of(client, visitor.session_id, visitor.headers)).facts]
        verdict = await checked(client, visitor, "Your $20.00 payment link was cancelled.")
        assert "number_in_prose" in [violation.kind for violation in verdict.violations]
        assert_handed_off(verdict)
    stranger = await open_visitor(client, copy)                         # another chat, citing this one's fact
    drafts = [(visitor, [clause(template)]), *((visitor, [clause(template, fact_id)]) for fact_id in cited),
              (stranger, [clause(template, cited[-1])])]
    for chat, clauses in drafts:
        verdict = await checked(client, chat, "Here is where your payment stands.", clauses)
        [violation] = verdict.violations
        assert (violation.kind, violation.rule_id, violation.span) == ("unknown_fact", "kernel_only_template",
                                                                       template)
        assert_handed_off(verdict)


async def test_a_link_cancelled_card_is_never_current_for_a_draft(app, client, reviewer, monkeypatch):
    """A second fence behind `kernel_only_template`: the template counts no fact status as current,
    so even with `link_cancelled` taken off the kernel-only list, Claude citing a link's fact gets no
    card (`stale_fact`): a link it cancelled, whose fact has expired, and an open one, whose fact is
    current for every other template, which only the template's empty status set refuses."""
    copy = await rivera(app, client)
    visitor = await open_visitor(client, copy)
    link = await rv_link(app, client, reviewer, copy, visitor)
    assert (await post_cancel(client, link.token)).status_code == 200
    still_open = await rv_link(app, client, reviewer, copy, visitor, ("drain", 1), call_id="call-link-2")
    monkeypatch.setattr(reply_check, "KERNEL_ONLY", reply_check.KERNEL_ONLY - {"link_cancelled"})
    for fact_id in (f"payment_link:{link.link_id}", f"payment_link:{still_open.link_id}"):
        verdict = await checked(client, visitor, "Here is where your payment stands.",
                                [clause("link_cancelled", fact_id)])
        assert violations(verdict) == [("stale_fact", "not_current", [fact_id])], fact_id
        assert_handed_off(verdict)


# ---- A rule change and the links it no longer allows --------------------------------------------------

RV_LINK = next(card for card in RIVERA_CARDS if card.card_id == "rv-link")
RV_LINK_100 = RV_LINK.model_copy(update={"max_amount_cents": 10_000, "reason": "Payment links up to $100."})
RV_LINK_WEEKDAYS = RV_LINK.model_copy(update={"hours": HoursWindow(days=["mon", "tue", "wed", "thu", "fri"],
                                                                   start=clock_time(8), end=clock_time(18)),
                                              "reason": "Payment links up to $300 in weekday hours."})
CALLBACKS = RuleCard(card_id="callbacks", applies_to="native.request_callback", mode="auto", who="anyone",
                     reason="Callback requests for anyone.")
CANCELLED = {"en": "This payment link was cancelled because Mike Turner's rules changed. "
                   "Ask again if you still want to pay.",
             "es": "Este enlace de pago se canceló porque cambiaron las reglas de Mike Turner. "
                   "Pídelo de nuevo si todavía quieres pagar."}


def rivera_cards(*, link: RuleCard = RV_LINK, extra: tuple[RuleCard, ...] = ()) -> list[RuleCard]:
    """The seed's cards with `link` in place of `rv-link`, and `extra` after them."""
    return [link if card.card_id == "rv-link" else card for card in RIVERA_CARDS] + list(extra)


async def held_then_approved(app: FastAPI, client: httpx.AsyncClient, reviewer: FakeDecisions, copy: Rivera,
                             visitor: Visitor, *items: tuple[str, int], call_id: str) -> PaymentLink:
    """A link that `rv-link` would allow but the reviewer's score holds, which Mike approves once."""
    reviewer.answer = Review(within_charter_bp=8_000, manipulation_bp=300, recommendation="allow")
    decision = await link_for(client, visitor, await quoted(client, visitor, *items, call_id=f"{call_id}-quote"),
                              call_id=call_id)
    assert decision.outcome == "hold", decision.reason_plain
    result = await answered(client, copy.owner, decision.decision_id, "allow_once")
    assert result.execution is not None and result.execution.state == "succeeded"
    [link] = await rows_of(app, copy.copy_id, select(PaymentLink).where(
        PaymentLink.action_id == decision.action.action_id))
    assert {"link_id": link.link_id, "state": "issued", "version": 1, "approved": True} in \
        await payment_entries(app, copy)
    return link


async def get_cancelled(client: httpx.AsyncClient, copy: Rivera, version: int, *,
                        headers: dict[str, str] | None = None) -> httpx.Response:
    return await client.get(f"/policy/{version}/cancelled_links", params={"desk_id": copy.desk_id},
                            headers=copy.owner if headers is None else headers)


async def cancelled_links(client: httpx.AsyncClient, copy: Rivera, version: int) -> list[LinkCancelled]:
    response = await get_cancelled(client, copy, version)
    assert response.status_code == 200, response.text
    return [LinkCancelled.model_validate(item) for item in response.json()]


@pytest.mark.solver
async def test_activation_cancels_open_links_it_no_longer_allows(desk_prove, app, client, reviewer, frozen_clock):
    copy = await rivera(app, client)
    visitor = await open_visitor(client, copy)
    over = await rv_link(app, client, reviewer, copy, visitor, ("heater", 2), call_id="call-over")   # $300, auto
    under = await rv_link(app, client, reviewer, copy, visitor, ("deposit", 4), call_id="call-under")  # $80, auto
    approved = await held_then_approved(app, client, reviewer, copy, visitor, ("heater", 2), call_id="call-held")

    # Mike lowers his money cap to $100, and `rv-link` with it
    version = await draft_and_confirm(client, copy.owner_token, copy.desk_id, rivera_cards(link=RV_LINK_100),
                                      auto_money_cap_cents=10_000)
    assert (version.version, version.auto_money_cap_cents) == (2, 10_000)

    # in the confirm's transaction: the auto-allowed $300 link is cancelled, its fact with it, ledgered after
    # the activation; the $80 one still fits, and the one Mike approved was bound to its call
    row = await link_row(app, copy, over.link_id)
    assert (row.state, row.cancel_reason, row.cancelled_by_version) == ("cancelled", "rules_changed", 2)
    for link in (under, approved):
        assert (await link_row(app, copy, link.link_id)).state == "issued"
    [fact] = await rows_of(app, copy.copy_id, select(FactRow).where(FactRow.fact_id == f"payment_link:{over.link_id}"))
    assert fact.status == "expired"
    entries = [entry.event for entry in await ledger_rows(app, copy)]
    activated = next(i for i, event in enumerate(entries) if event.kind == "policy" and event.summary.get("activated")
                     and event.summary["version"] == 2)
    assert [(event.kind, event.session_id, event.summary) for event in entries[activated + 1:]] == [
        ("payment", visitor.session_id, {"link_id": over.link_id, "state": "cancelled", "reason": "rules_changed",
                                         "version": 2})]

    # it can't be paid, and its checkout page says why
    response = await post_complete(client, over.token)
    assert (response.status_code, response.json()) == (409, {"code": "conflict"})
    assert not [row for row in charges(copy) if row[0] == f"{over.action_id}:charge"]
    seen = await view(client, over.token)
    assert (seen.state, seen.cancel_reason, seen.customer_name) == ("cancelled", "rules_changed", None)

    # the chat gets the kernel's card for the link, signed at the session's generation, in its last language
    public = await public_key(client)
    [line] = await cancelled_links(client, copy, 2)
    assert (line.link_id, line.session_id) == (over.link_id, visitor.session_id)
    [block] = line.verdict.blocks
    assert (block.kind, block.template, block.fact_id, block.title, block.lines, block.href) == (
        "card", "link_cancelled", f"payment_link:{over.link_id}", "$300.00",
        ["Water heater flush × 2", CANCELLED["en"]], None)
    assert (line.verdict.ok, line.verdict.generation, line.verdict.language) == (True, 0, "en")
    verify_verdict(public, visitor.session_id, line.verdict)
    assert (await checked(client, visitor, "Hola, ¿qué tal?")).language == "es"
    [again] = await cancelled_links(client, copy, 2)                    # read again: the same link, signed anew
    assert (again.link_id, again.verdict.language, again.verdict.blocks[0].lines) == (
        over.link_id, "es", ["Water heater flush × 2", CANCELLED["es"]])
    assert again.verdict.message_id != line.verdict.message_id
    verify_verdict(public, visitor.session_id, again.verdict)
    replies = [entry for entry in await ledger_rows(app, copy) if entry.event.kind == "reply"
               and entry.event.summary["author"] == "desk"]
    assert [(entry.seq, entry.event.session_id, entry.event.summary["fact_ids"]) for entry in replies] == [
        (verdict.ledger_seq, visitor.session_id, [f"payment_link:{over.link_id}"])
        for verdict in (line.verdict, again.verdict)]
    assert await cancelled_links(client, copy, 1) == []                 # the version it replaced cancelled nothing

    # the other two still pay, while their session stands
    for link in (under, approved):
        assert (await completed(client, link.token)).state == "paid", link.amount_cents
    await set_session(app, copy, visitor.session_id, closed_at=frozen_clock.now())
    assert await cancelled_links(client, copy, 2) == []                 # nor is a closed chat sent a line


async def lower_the_cap_to_100(client: httpx.AsyncClient, copy: Rivera) -> int:
    """Mike lowers his money cap to $100, and `rv-link` with it: the version he confirms."""
    version = await draft_and_confirm(client, copy.owner_token, copy.desk_id, rivera_cards(link=RV_LINK_100),
                                      auto_money_cap_cents=10_000)
    return version.version


@pytest.mark.solver
async def test_a_cancelled_links_card_shows_its_own_title_and_amount(desk_prove, app, client, reviewer):
    """Each chat's `link_cancelled` card says which link was cancelled: the amount as its headline,
    then what the link was for and the kernel's line, rendered from that link's own `payment_link`
    fact, never from model text, and signed with the card (`blocks_sha256`). A verified person's
    link reads the same way, in the language she last wrote in."""
    copy = await rivera(app, client)
    visitor = await open_visitor(client, copy)
    dana = await confirmed(client, copy, "dana@example.com")
    heater = await rv_link(app, client, reviewer, copy, visitor, ("heater", 2), call_id="call-heater")   # $300
    drain = await rv_link(app, client, reviewer, copy, dana, ("drain", 1), call_id="call-drain")         # $180
    assert (await checked(client, dana, "Hola, ¿qué tal?")).language == "es"
    version = await lower_the_cap_to_100(client, copy)

    lines = {line.session_id: line for line in await cancelled_links(client, copy, version)}
    assert {line.link_id for line in lines.values()} == {heater.link_id, drain.link_id}
    public = await public_key(client)
    expected = {visitor.session_id: (heater, "$300.00", "Water heater flush × 2", CANCELLED["en"], "en"),
                dana.session_id: (drain, "$180.00", "Drain clearing", CANCELLED["es"], "es")}
    for session_id, (link, amount, title, line_text, language) in expected.items():
        verdict = lines[session_id].verdict
        assert (lines[session_id].link_id, verdict.ok, verdict.language) == (link.link_id, True, language)
        [block] = verdict.blocks                                         # the card alone: no prose beside it
        assert (block.kind, block.template, block.fact_id, block.title, block.lines, block.href) == (
            "card", "link_cancelled", f"payment_link:{link.link_id}", amount, [title, line_text], None)
        assert block.text == "\n".join([amount, title, line_text])
        verify_verdict(public, session_id, verdict)
        # the title and amount are part of what is signed: a card showing another amount doesn't verify
        for changed in ({"title": "$1.00"}, {"lines": ["Leak repair", line_text]}):
            forged = verdict.model_copy(update={"blocks": [block.model_copy(update=changed)]})
            with pytest.raises(InvalidSignature):
                verify_verdict(public, session_id, forged)
    replies = [entry.event for entry in await ledger_rows(app, copy) if entry.event.kind == "reply"
                and entry.event.summary["author"] == "desk"]
    assert sorted((event.session_id, tuple(event.summary["fact_ids"])) for event in replies) == sorted(
        (session_id, (f"payment_link:{link.link_id}",)) for session_id, (link, *_) in expected.items())


WITHHELD = {"another_session": "not_a_reader", "no_such_fact": "no_such_fact",
            "another_links_fact": "template_mismatch", "canary": "canary"}


@pytest.mark.solver
@pytest.mark.parametrize("change", [*WITHHELD, "no_source", "no_total", "title_not_text", "claims_unreadable"])
async def test_a_cancelled_links_card_needs_its_own_readable_fact(desk_prove, app, client, reviewer, caplog, change):
    """A cancelled link's card shows only the fact named after that link, which the chat it goes to
    may read, well formed and holding no document text. A link row that names another visitor's chat
    (who can't read the link's fact), a fact gone, a fact naming another link, a canary in what the
    card would show, and a malformed fact (no source, no total, a title that isn't text, or claims
    that don't parse) each leave the link without a line, logged, with nothing of the link's figures
    sent or ledgered. Another chat's link that the same version cancelled still gets its line."""
    copy = await rivera(app, client)
    visitor = await open_visitor(client, copy)
    stranger = await open_visitor(client, copy)
    heater = await rv_link(app, client, reviewer, copy, visitor, ("heater", 2), call_id="call-heater")   # $300
    drain = await rv_link(app, client, reviewer, copy, stranger, ("drain", 1), call_id="call-drain")     # $180
    version = await lower_the_cap_to_100(client, copy)
    fact_id = f"payment_link:{heater.link_id}"
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        link = (await ctx.db.scalars(ctx.repo.scoped(select(PaymentLink).where(
            PaymentLink.link_id == heater.link_id)))).one()
        fact = (await ctx.db.scalars(ctx.repo.scoped(select(FactRow).where(FactRow.fact_id == fact_id)))).one()
        if change == "another_session":
            link.session_id = stranger.session_id
        elif change == "no_such_fact":
            fact.fact_id = "payment_link:paylink-aaaaaaaaaaaaaaaa"
        elif change == "no_source":
            fact.source = None
        elif change == "no_total":
            fact.claims = [claim for claim in fact.claims if claim.key != "total"]
        elif change == "title_not_text":
            fact.claims = [claim.model_copy(update={"kind": "money", "value": 30_000}) if claim.key == "title"
                           else claim for claim in fact.claims]
        elif change == "claims_unreadable":
            # written around the contract's check: a money claim holding text, so the stored claims don't parse
            unreadable = [{**claim.model_dump(mode="json"), "value": "$300"} if claim.key == "total"
                          else claim.model_dump(mode="json") for claim in fact.claims]
            await ctx.db.execute(text("UPDATE kernel.facts SET claims = CAST(:claims AS jsonb) "
                                      "WHERE desk_id = :desk_id AND fact_id = :fact_id"),
                                 {"claims": json.dumps(unreadable), "desk_id": fact.desk_id, "fact_id": fact_id})
        else:
            canary = (await ctx.db.scalars(ctx.repo.scoped(select(Document.canary)))).first()
            key, value = ("ref", "paylink-aaaaaaaaaaaaaaaa") if change == "another_links_fact" else (
                "title", f"Flush {canary}")
            fact.claims = [claim.model_copy(update={"value": value}) if claim.key == key else claim
                           for claim in fact.claims]

    with caplog.at_level(logging.ERROR, logger="desk.kernel_service.payments"):
        response = await get_cancelled(client, copy, version)
    assert response.status_code == 200, response.text
    [line] = [LinkCancelled.model_validate(item) for item in response.json()]       # the other chat's line only
    assert (line.link_id, line.session_id, line.verdict.ok, line.verdict.blocks[0].fact_id) == (
        drain.link_id, stranger.session_id, True, f"payment_link:{drain.link_id}")
    reason = WITHHELD.get(change, "malformed")
    assert f"link_cancelled_withheld link_id={heater.link_id} reason={reason}" in caplog.text
    assert [(entry.event.session_id, entry.event.summary["fact_ids"]) for entry in await ledger_rows(app, copy)
            if entry.event.kind == "reply" and entry.event.summary["author"] == "desk"] == [
        (stranger.session_id, [f"payment_link:{drain.link_id}"])]


@pytest.mark.solver
async def test_a_database_error_fails_the_whole_cancelled_links_read(desk_prove, app, client, reviewer, caplog,
                                                                     monkeypatch):
    """Only a malformed fact withholds one link's line. A database error loading a link's fact
    fails the whole read, even one that is also a `KeyError` (`NoSuchColumnError`): nothing is
    listed or ledgered, and the API's read of the version again lists every link."""
    copy = await rivera(app, client)
    visitor = await open_visitor(client, copy)
    stranger = await open_visitor(client, copy)
    heater = await rv_link(app, client, reviewer, copy, visitor, ("heater", 2), call_id="call-heater")   # $300
    drain = await rv_link(app, client, reviewer, copy, stranger, ("drain", 1), call_id="call-drain")     # $180
    version = await lower_the_cap_to_100(client, copy)
    fact_id = f"payment_link:{heater.link_id}"
    scalars = AsyncSession.scalars

    async def failing_scalars(self: AsyncSession, statement, *args, **kwargs):
        if (isinstance(statement, Select) and statement.column_descriptions[0]["entity"] is FactRow
                and fact_id in statement.compile().params.values()):
            raise NoSuchColumnError("Could not locate column in row for column 'facts.claims'")
        return await scalars(self, statement, *args, **kwargs)

    with monkeypatch.context() as patched, caplog.at_level(logging.ERROR, logger="desk.kernel_service.payments"):
        patched.setattr(AsyncSession, "scalars", failing_scalars)
        response = await get_cancelled(client, copy, version)
    assert (response.status_code, response.json()) == (500, {"code": "internal"})
    assert "link_cancelled_withheld" not in caplog.text
    assert not [entry for entry in await ledger_rows(app, copy) if entry.event.kind == "reply"
                and entry.event.summary["author"] == "desk"]
    assert {line.link_id for line in await cancelled_links(client, copy, version)} == {heater.link_id, drain.link_id}


@pytest.mark.solver
@pytest.mark.parametrize("change", ["answering_off", "after_hours"])
async def test_activation_keeps_links_its_rules_still_allow(desk_prove, app, client, reviewer, frozen_clock, change):
    copy = await rivera(app, client)
    if change == "after_hours":
        # links only in weekday hours: the window held when the link was decided (Friday 10:04)
        await draft_and_confirm(client, copy.owner_token, copy.desk_id, rivera_cards(link=RV_LINK_WEEKDAYS))
    visitor = await open_visitor(client, copy)
    link = await rv_link(app, client, reviewer, copy, visitor)
    if change == "answering_off":
        response = await client.put(f"/desks/{copy.desk_id}/answering", headers=copy.owner, json={"on": False})
        assert response.status_code == 200, response.text
    else:
        frozen_clock.advance(10 * 3600)                                  # Friday 20:04, after hours
    # a version that only adds a card for another tool
    cards = rivera_cards(link=RV_LINK_WEEKDAYS if change == "after_hours" else RV_LINK, extra=(CALLBACKS,))
    version = await draft_and_confirm(client, copy.owner_token, copy.desk_id, cards)
    assert (await link_row(app, copy, link.link_id)).state == "issued"
    entries = [entry.event for entry in await ledger_rows(app, copy)]
    assert entries[-1].kind == "policy" and entries[-1].summary["version"] == version.version
    assert await cancelled_links(client, copy, version.version) == []
    assert (await completed(client, link.token)).state == "paid"


@pytest.mark.parametrize("caller", ["visitor", "other_owner"])
async def test_cancelled_links_needs_the_owner_of_the_copy(app, client, caplog, caller):
    copy = await rivera(app, client)
    if caller == "visitor":
        visitor = await open_visitor(client, copy)
        for headers in (visitor.headers, {**visitor.headers, **copy.owner}):      # a session token is never enough
            response = await get_cancelled(client, copy, 1, headers=headers)
            assert (response.status_code, response.json()) == (401, {"code": "auth"})
    else:
        other = await rivera(app, client)
        response = await get_cancelled(client, copy, 1, headers=other.owner)
        assert (response.status_code, response.json()) == (404, {"code": "not_found"})
        response = await client.get("/policy/1/cancelled_links", params={"desk_id": "desk\x00"}, headers=copy.owner)
        assert (response.status_code, response.json()) == (404, {"code": "not_found"})     # no Desk has that ID
        # it names no Desk of the caller's copy, so its refusal is logged, never on either Desk's ledger
        assert any("auth_unattributed route=GET /policy/{version}/cancelled_links reason=wrong_copy"
                   in record.getMessage() for record in caplog.records)
        assert not [entry for entry in await ledger_rows(app, other) if entry.event.kind == "auth"]
    assert not [entry for entry in await ledger_rows(app, copy) if entry.event.kind in ("auth", "reply")]
    assert await cancelled_links(client, copy, 1) == []


async def drafted(client: httpx.AsyncClient, copy: Rivera, cards: list[RuleCard], **cap: int) -> PolicyVersion:
    """A proved draft of `cards` on version 1, not confirmed yet."""
    response = await post_draft(client, copy, cards, 1, **cap)
    assert response.status_code == 200, response.text
    version = PolicyVersion.model_validate(response.json())
    assert (version.version, version.status) == (2, "proved"), version.proof
    return version


@pytest.mark.solver
@pytest.mark.parametrize("when", ["after_the_marker", "while_c2_waits"])
async def test_completion_and_activation_do_not_interleave(desk_prove, app, client, reviewer, mockpay, monkeypatch,
                                                           when):
    copy = await rivera(app, client)
    visitor = await open_visitor(client, copy)
    link = await rv_link(app, client, reviewer, copy, visitor, ("heater", 2))                    # $300
    lowered = await drafted(client, copy, rivera_cards(link=RV_LINK_100), auto_money_cap_cents=10_000)
    key = f"{link.action_id}:charge"
    if when == "after_the_marker":
        # C1 has committed the marker when the $100 version is confirmed: the link may be at the provider
        # by now as far as the activation knows, so it goes to reconciliation, never straight to cancelled
        async def confirmed_now() -> None:
            await confirm(client, copy, lowered.version)
            row = await link_row(app, copy, link.link_id)
            assert (row.state, row.cancel_reason, row.cancelled_by_version) == ("unknown", "rules_changed", 2)
            assert row.completion_started_at is not None

        monkeypatch.setattr(payments, "_after_marker", confirmed_now)
        response = await post_complete(client, link.token)
        assert (response.status_code, response.json()) == (409, {"code": "conflict"})   # C2 sends nothing
        assert charges(copy) == []
        entries = await payment_entries(app, copy)
        assert entries[-2:] == [
            {"link_id": link.link_id, "state": "unknown", "reason": "rules_changed", "version": 2},
            refusal(link, "unknown", "moved")]
        # the next read settles it with the provider's atomic cancel: cancelled, for the rules
        seen = await view(client, link.token)
        assert (seen.state, seen.cancel_reason) == ("cancelled", "rules_changed")
        assert charges(copy) == []
        assert [line.link_id for line in await cancelled_links(client, copy, 2)] == [link.link_id]
        return
    # the confirm comes while C2 holds the link and waits on the provider: it waits for the link's
    # lock, then finds it paid and cancels nothing
    await delay(mockpay, copy, "complete", 1)
    at_provider = asyncio.Event()
    complete = payments.ProviderClient.complete

    async def completing(self, checkout_id: str):
        at_provider.set()
        return await complete(self, checkout_id)

    monkeypatch.setattr(payments.ProviderClient, "complete", completing)
    completion = asyncio.create_task(completed(client, link.token))
    await asyncio.wait_for(at_provider.wait(), 5)
    await confirm(client, copy, lowered.version)
    assert completion.done()                                            # the confirm waited for C2's commit
    assert (await completion).state == "paid"
    assert (await link_row(app, copy, link.link_id)).state == "paid"
    entries = [entry.event for entry in await ledger_rows(app, copy)]
    assert entries[-1].kind == "policy" and entries[-1].summary["version"] == 2
    assert [row[0] for row in charges(copy)] == [key]


@pytest.mark.solver
async def test_a_cancelled_links_reads_reconciliation_stands_when_the_read_fails_after_it(
        desk_prove, app, client, reviewer, monkeypatch):
    """The owner's read of a version's cancelled links first settles at the provider each link that
    version moved to `unknown`, and commits that at once, before the read goes on: the read failing
    afterwards leaves the link `cancelled` for the rules, and the next read lists it, asking the
    provider nothing again."""
    copy = await rivera(app, client)
    visitor = await open_visitor(client, copy)
    link = await rv_link(app, client, reviewer, copy, visitor, ("heater", 2))                    # $300
    lowered = await drafted(client, copy, rivera_cards(link=RV_LINK_100), auto_money_cap_cents=10_000)

    async def confirmed_now() -> None:                      # C1's marker is committed: the link goes to unknown
        await confirm(client, copy, lowered.version)

    monkeypatch.setattr(payments, "_after_marker", confirmed_now)
    response = await post_complete(client, link.token)
    assert (response.status_code, response.json()) == (409, {"code": "conflict"})
    assert (await link_row(app, copy, link.link_id)).state == "unknown"

    async def fails(*args, **kwargs):
        raise RuntimeError("the read fails after its reconciliation")

    monkeypatch.setattr(payments, "_desk_info", fails)                 # read after the link is settled
    response = await get_cancelled(client, copy, lowered.version)
    assert (response.status_code, response.json()) == (500, {"code": "internal"})
    row = await link_row(app, copy, link.link_id)
    assert (row.state, row.cancel_reason) == ("cancelled", "rules_changed")
    monkeypatch.undo()
    assert [line.link_id for line in await cancelled_links(client, copy, lowered.version)] == [link.link_id]
    assert [entry for entry in await payment_entries(app, copy) if entry.get("reconciled")] == [
        {"link_id": link.link_id, "state": "cancelled", "reason": "rules_changed", "version": 2, "reconciled": True}]
    assert charges(copy) == []


@pytest.mark.solver
async def test_link_expiry_waits_for_a_started_completion(desk_prove, app, client, reviewer, mockpay, frozen_clock,
                                                          monkeypatch):
    copy = await rivera(app, client)
    visitor = await open_visitor(client, copy)
    link = await rv_link(app, client, reviewer, copy, visitor)
    version = await drafted(client, copy, rivera_cards(extra=(CALLBACKS,)))
    frozen_clock.travel(link.expires_at - timedelta(seconds=5))         # its last seconds
    await delay(mockpay, copy, "complete", 3)                           # C2 times out and rolls back
    seen = []

    async def expiry_and_activation() -> None:
        frozen_clock.advance(10)                                        # past its expiry, the marker 10 s old
        seen.append(await view(client, link.token))
        seen.append(await link_row(app, copy, link.link_id))
        await confirm(client, copy, version.version)
        seen.append(await link_row(app, copy, link.link_id))

    monkeypatch.setattr(payments, "_before_c3", expiry_and_activation)
    result = await completed(client, link.token)
    viewed, read, activated = seen
    # the read leaves it issued with its marker: that completion may be at the provider
    assert viewed.state == "issued" and (read.state, read.completion_started_at is not None) == ("issued", True)
    # the activation moves it to unknown, naming its version, and C3 leaves it there
    assert (activated.state, activated.cancel_reason, activated.cancelled_by_version) == ("unknown", None, 2)
    assert (result.state, result.verdict) == ("unknown", None)
    entries = await payment_entries(app, copy)
    assert {"link_id": link.link_id, "state": "unknown", "reason": "expired", "version": 2} in entries
    assert not [entry for entry in entries if entry.get("reason") == "provider_unknown"]
    # once the delayed completion lands, a read settles it: paid, once
    await charged(copy, f"{link.action_id}:charge")
    assert (await view(client, link.token)).state == "paid"
    assert len(charges(copy)) == 1 and len(await charge_facts(app, copy)) == 1
