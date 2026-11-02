"""Mandates: another person's agent pays within its signed limit and no further.

A demo agent opens its session with a mandate the copy's demo wallet signed ($20 a charge, $100 in
all, for an hour). `/decide` bounds each agent charge by what the mandate has left
(`mandate_remaining_cents`, which the baseline reads), and execution reserves the amount on the
mandate with the intent row, under the mandate row's lock, so of two calls racing for the last of
it one goes ahead and the other is refused at execution. A mandate charge (`native.charge_mandate`)
then commits its reservation once the provider has charged, releases it when nothing was charged,
and keeps it while nobody knows. An agent's payment link holds its reservation from issue until the
link is paid (committed) or leaves `issued` another way (released); an unknown link keeps it until
it is reconciled.

Tests run on a test Desk made with `POST /desks` (a $20 deposit and a $25 site visit) in a Turner
Plumbing copy (Friday 10:04 in Oakland), with Answering on and, through `draft_and_confirm`, its
money cap set to $500 and these cards: the seed's `rv-mandate` (agent charges up to $20, for
anyone), quotes for anyone and payment links up to $500 for anyone. Drafts are proved, so those
tests need the solver (`solver`); the two on a Turner copy run on the seed's own cards, `rv-mandate`
among them. Agents sign each turn as `test_agent_auth` does.
"""

import asyncio
import dataclasses
import time
from collections.abc import Awaitable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import httpx
import psycopg
import pytest
from fastapi import FastAPI
from sqlalchemy import select

from desk.contracts import Decision, ExecResult, PolicyVersion, PriceItem, RuleCard
from desk.db.models import Mandate as MandateRow
from desk.db.models import MandateReservation, PaymentLink, Quote
from desk.db.session import database_url, libpq_url
from desk.kernel_api import PaymentLinkStateResult
from desk.kernel_service import execute, mandates, payments
from desk.kernel_service.adapters.charge_mandate import ChargeMandateAdapter
from desk.kernel_service.seed import RIVERA_CARDS

from .fakes import FrozenClock
from .helpers import connections_of, draft_and_confirm, ledger_rows, rows_of, until_waiting
from .test_adapters import Rivera, quote_args, rivera
from .test_agent_auth import Agent, SignedTurn, mint, open_agent, turn
from .test_approvals import answered, post_answer
from .test_decide import decided, open_visitor, set_session, verify_signature
from .test_desk_writes import LOPEZ_DESK, new_desk, post_desk
from .test_execute import Crash, crash, executed, post_execute, read
from .test_link_completion import cancelled_links, charged, charges, completed, post_cancel
from .test_money_cap import post_draft
from .test_payment_links import confirm, delay, nothing_listening, view
from .test_payments_adapters import provider_refunds
from .test_reply_check import checked, clause
from .test_verification import api_rows

CHARGE = "native.charge_mandate"
LINK = "native.payment_link"
[MANDATE] = [card for card in RIVERA_CARDS if card.card_id == "rv-mandate"]
QUOTES = RuleCard(card_id="quotes", applies_to="native.quote", mode="auto", who="anyone",
                  reason="Quotes from the price list.")
LINKS = RuleCard(card_id="links", applies_to=LINK, mode="auto", who="anyone", max_amount_cents=50_000,
                 reason="Payment links up to $500.")
CARDS = [MANDATE, QUOTES, LINKS]
TEST_DESK = LOPEZ_DESK.model_copy(update={"price_items": [
    PriceItem(item_id="deposit", title="Deposit", unit_cents=2_000),
    PriceItem(item_id="visit", title="Site visit", unit_cents=2_500)]})


@dataclass
class AgentDesk:
    """The test Desk, and a demo agent its owner minted, in a session (with its mandate unless the
    test said otherwise)."""

    desk: Rivera
    agent: Agent
    session_id: str
    clock: FrozenClock

    def turn(self, message: str = "I'd like to pay the deposit, please.") -> SignedTurn:
        """A new A2A turn of the agent's session: a fresh nonce, signed now."""
        return turn(self.agent, self.desk.slug, self.session_id, self.clock, message)


async def agent_desk(app: FastAPI, client: httpx.AsyncClient, frozen_clock: FrozenClock, *,
                     cards: list[RuleCard] = CARDS, mandate: bool = True) -> AgentDesk:
    copy = await rivera(app, client)
    response = await post_desk(client, copy, new_desk(desk=TEST_DESK))
    assert response.status_code == 200, response.text
    created = response.json()
    desk = Rivera(copy_id=copy.copy_id, desk_id=created["desk_id"], slug=created["slug"],
                  owner_token=copy.owner_token)
    response = await client.put(f"/desks/{desk.desk_id}/answering", headers=desk.owner, json={"on": True})
    assert response.status_code == 200, response.text
    await draft_and_confirm(client, desk.owner_token, desk.desk_id, cards, auto_money_cap_cents=50_000)
    agent = await mint(client, desk.owner, desk.desk_id)
    session = await open_agent(client, desk.slug, agent, frozen_clock, mandate=mandate)
    return AgentDesk(desk=desk, agent=agent, session_id=session.state.session_id, clock=frozen_clock)


async def quoted(client: httpx.AsyncClient, signed: SignedTurn, item: str = "deposit", *,
                 call_id: str = "call-quote") -> str:
    """The agent's quote for one `item`, decided and executed under `QUOTES`: its ID."""
    decision = await decided(client, signed, "native.quote", quote_args((item, 1)), call_id=call_id)
    assert decision.outcome == "allow", decision.reason_plain
    return (await executed(client, signed, decision)).model_view["quote_id"]


async def asked(client: httpx.AsyncClient, signed: SignedTurn, tool: str, quote_id: str, *,
                call_id: str = "call-pay") -> Decision:
    return await decided(client, signed, tool, {"quote_id": quote_id}, call_id=call_id)


def decide_entries(entries, session_id: str) -> list[dict]:
    return [e.event.summary for e in entries if e.event.kind == "decide" and e.event.session_id == session_id]


def mandate_spend(copy_id: str) -> list[tuple[int, int]]:
    """What the API reads of the copy's mandates (`kernel_ro.mandates`): (committed, reserved)."""
    return api_rows(copy_id, "SELECT committed_cents, reserved_cents FROM kernel_ro.mandates")


async def reservations(app: FastAPI, copy_id: str) -> list[tuple[str, int, str]]:
    """The copy's mandate reservations: (action, amount, state), by action."""
    rows = await rows_of(app, copy_id, select(MandateReservation).order_by(MandateReservation.action_id))
    return [(row.action_id, row.amount_cents, row.state) for row in rows]


async def reservation_of(app: FastAPI, copy_id: str, action_id: str) -> tuple[int, str] | None:
    """The action's reservation: (amount, state), or None when it holds none."""
    found = {action: (amount, state) for action, amount, state in await reservations(app, copy_id)}
    return found.get(action_id)


def agent_charges(copy_id: str) -> list[tuple]:
    """The copy's charges to agents at the mock payments server, read as its own role: (key, amount,
    customer, state)."""
    with psycopg.connect(libpq_url(database_url("MOCKPAY"))) as conn:
        return conn.execute("SELECT idempotency_key, amount_cents, customer_id, state FROM mockpay.charges"
                            " WHERE copy_id = %s AND customer_id LIKE 'agent:%%' ORDER BY idempotency_key",
                            (copy_id,)).fetchall()


@pytest.mark.solver
async def test_agent_without_a_mandate_is_refused_for_both(desk_prove, app, client, frozen_clock):
    setup = await agent_desk(app, client, frozen_clock, mandate=False)
    signed = setup.turn()
    quote_id = await quoted(client, signed)
    for call_id, tool in (("call-link", LINK), ("call-charge", CHARGE)):
        refused = await asked(client, signed, tool, quote_id, call_id=call_id)
        assert (refused.outcome, refused.state, refused.action) == ("refuse", "refused", None), tool
        assert "This conversation can't use that tool, so it was refused." in refused.reason_plain
    # each refusal is on the ledger, before any action existed
    entries = decide_entries(await ledger_rows(app, setup.desk), setup.session_id)
    assert [(e["tool"], e["reason"]) for e in entries if e["outcome"] == "refuse"] == [
        (LINK, "not_given"), (CHARGE, "not_given")]
    assert await rows_of(app, setup.desk.copy_id, select(MandateRow)) == []
    assert await reservations(app, setup.desk.copy_id) == [] and agent_charges(setup.desk.copy_id) == []


@pytest.mark.solver
async def test_mandate_oracle(desk_prove, app, client, frozen_clock):
    setup = await agent_desk(app, client, frozen_clock)
    signed = setup.turn()
    copy_id = setup.desk.copy_id
    outcomes = []
    for n in range(10):
        quote_id = await quoted(client, signed, call_id=f"call-quote-{n}")
        decision = await asked(client, signed, CHARGE, quote_id, call_id=f"call-charge-{n}")
        if decision.outcome == "allow":
            assert decision.card_ids == ["rv-mandate"], decision.reason_plain
            result = await executed(client, signed, decision)
            outcomes.append(("executed", result.state))
        else:
            # the baseline refuses it at /decide: the mandate has nothing left
            assert (decision.outcome, decision.card_ids) == ("refuse", []), decision.reason_plain
            assert decision.action is not None and decision.action.amount_cents == 2_000
            assert "It was more than this agent's signed limit allows, so it was refused." in decision.reason_plain
            outcomes.append(("refused", None))
    assert outcomes == [("executed", "succeeded")] * 5 + [("refused", None)] * 5
    # five charges at the provider, one per executed action, each to the agent; $100 committed, nothing held
    charged = agent_charges(copy_id)
    assert [(amount, customer, state) for _, amount, customer, state in charged] == [
        (2_000, f"agent:{setup.agent.key_id}", "succeeded")] * 5
    assert mandate_spend(copy_id) == [(10_000, 0)]
    assert sorted((amount, state) for _, amount, state in await reservations(app, copy_id)) == [
        (2_000, "committed")] * 5
    assert {key for key, *_ in charged} == {action for action, *_ in await reservations(app, copy_id)}


@pytest.mark.solver
async def test_charge_above_per_charge_is_refused_at_decide(desk_prove, app, client, frozen_clock):
    setup = await agent_desk(app, client, frozen_clock)
    signed = setup.turn()
    visit = await quoted(client, signed, "visit")                                   # $25, above $20 a charge
    for call_id, tool in (("call-charge", CHARGE), ("call-link", LINK)):
        refused = await asked(client, signed, tool, visit, call_id=call_id)
        assert (refused.outcome, refused.card_ids) == ("refuse", []), (tool, refused.reason_plain)
        assert refused.action.amount_cents == 2_500
        assert "It was more than this agent's signed limit allows, so it was refused." in refused.reason_plain
    # the links card alone would let anyone have a $25 link: a visitor gets one
    visitor = await open_visitor(client, setup.desk)
    allowed = await asked(client, visitor, LINK, await quoted(client, visitor, "visit"))
    assert (allowed.outcome, allowed.card_ids) == ("allow", ["links"]), allowed.reason_plain
    # and the agent's $20 charge goes ahead
    deposit = await asked(client, signed, CHARGE, await quoted(client, signed, call_id="call-quote-2"),
                          call_id="call-charge-2")
    assert deposit.outcome == "allow", deposit.reason_plain
    assert mandate_spend(setup.desk.copy_id) == [(0, 0)] and agent_charges(setup.desk.copy_id) == []


async def expiry_of(app: FastAPI, setup: AgentDesk) -> datetime:
    [mandate] = await rows_of(app, setup.desk.copy_id, select(MandateRow))
    return datetime.strptime(mandate.expires_at, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=UTC)


@pytest.mark.solver
async def test_expired_mandate_refuses(desk_prove, app, client, frozen_clock):
    setup = await agent_desk(app, client, frozen_clock)
    expires_at = await expiry_of(app, setup)
    frozen_clock.travel(expires_at - timedelta(seconds=30))
    signed = setup.turn()
    allowed = await asked(client, signed, CHARGE, await quoted(client, signed))
    assert allowed.outcome == "allow", allowed.reason_plain
    # the mandate expires before the allow runs (its minute isn't up): refused at execution, nothing sent
    frozen_clock.advance(31)
    response = await post_execute(client, signed, allowed)
    assert (response.status_code, response.json()) == (409, {"code": "conflict"})
    assert (await read(client, signed.headers, allowed)).state == "refused_at_execution"
    # and from then on every charge or agent link is refused at /decide
    later = setup.turn("Can I still pay?")
    quote_id = await quoted(client, later, call_id="call-quote-late")
    for call_id, tool in (("call-charge-late", CHARGE), ("call-link-late", LINK)):
        refused = await asked(client, later, tool, quote_id, call_id=call_id)
        assert (refused.outcome, refused.card_ids) == ("refuse", []), (tool, refused.reason_plain)
    assert await reservations(app, setup.desk.copy_id) == [] and agent_charges(setup.desk.copy_id) == []
    assert mandate_spend(setup.desk.copy_id) == [(0, 0)]


MANDATE_RULE = "B.agent_charge_within_mandate"
OVER_THE_LIMIT = {"en": "Refused: over the signed limit for this agent",
                  "es": "Rechazado: supera el límite firmado para este agente"}


@pytest.mark.solver
@pytest.mark.parametrize("language", ["en", "es"])
async def test_an_agent_over_its_mandate_is_told_it_is_over_the_signed_limit(desk_prove, app, client, frozen_clock,
                                                                             language):
    """A charge above what the agent's mandate has left is refused by the baseline's mandate rule
    alone, and its receipt says so in the session's language rather than the generic refusal."""
    setup = await agent_desk(app, client, frozen_clock)
    await set_session(app, setup.desk, setup.session_id, last_language=language)
    signed = setup.turn()
    refused = await asked(client, signed, CHARGE, await quoted(client, signed, "visit"))   # $25 on a $20 mandate
    assert (refused.outcome, refused.state, refused.policy_ids) == ("refuse", "refused", [MANDATE_RULE])
    assert refused.action.amount_cents == 2_500
    # the receipt says why, in the session's language: the line is the decision's own, signed and read back
    assert refused.visitor_plain == OVER_THE_LIMIT[language]
    verify_signature((await client.get("/health")).json()["public_key_hex"], refused)
    assert (await read(client, signed.headers, refused)).visitor_plain == OVER_THE_LIMIT[language]
    assert "It was more than this agent's signed limit allows, so it was refused." in refused.reason_plain


@pytest.mark.solver
@pytest.mark.parametrize("case", ["no_mandate", "no_amount"])
async def test_other_mandate_refusals_keep_the_generic_line(desk_prove, app, client, frozen_clock, monkeypatch, case):
    """The mandate rule also refuses an agent that holds no mandate (here its mandate has expired, so
    the session keeps the tool but the principal has no `mandate_remaining_cents`) and a charge with
    no amount. Neither is over a signed limit, so each keeps the generic refusal line."""
    setup = await agent_desk(app, client, frozen_clock)
    if case == "no_mandate":
        frozen_clock.travel(await expiry_of(app, setup) + timedelta(seconds=1))
    else:
        normalize = ChargeMandateAdapter.normalize

        async def no_amount(self, nctx, args):
            return (await normalize(self, nctx, args)).model_copy(update={"amount_cents": None})

        monkeypatch.setattr(ChargeMandateAdapter, "normalize", no_amount)
    signed = setup.turn()
    refused = await asked(client, signed, CHARGE, await quoted(client, signed))      # the $20 deposit
    assert (refused.outcome, refused.state) == ("refuse", "refused"), refused.reason_plain
    assert MANDATE_RULE in refused.policy_ids
    if case == "no_mandate":
        assert (refused.policy_ids, refused.action.amount_cents) == ([MANDATE_RULE], 2_000)
    else:
        assert refused.action.amount_cents is None
    assert refused.visitor_plain == "Not something I can do here"
    assert "The always-on safety rules don't allow it." in refused.reason_plain


async def rivera_agent(app: FastAPI, client: httpx.AsyncClient, frozen_clock: FrozenClock) -> AgentDesk:
    """A Turner Plumbing copy as `POST /copies` seeds it (its cards include `rv-mandate`), and a demo
    agent its owner minted, in a session with its mandate."""
    copy = await rivera(app, client)
    agent = await mint(client, copy.owner, copy.desk_id)
    session = await open_agent(client, copy.slug, agent, frozen_clock)
    return AgentDesk(desk=copy, agent=agent, session_id=session.state.session_id, clock=frozen_clock)


async def test_refund_under_a_mandate_is_refused(app, client, frozen_clock):
    setup = await rivera_agent(app, client, frozen_clock)
    signed = setup.turn()
    paid = await executed(client, signed, await asked(client, signed, CHARGE, await quoted(client, signed)))
    [fact] = paid.facts
    charge_id = fact.fact_id.removeprefix("charge:")
    # the agent asks for its own charge back: a refund is never given to an agent, so it is refused at step
    # 1, before any action exists, and nothing is paid out or taken off the mandate
    again = setup.turn("Please refund that deposit.")
    refused = await decided(client, again, "payments.create_refund", {"charge_id": charge_id})
    assert (refused.outcome, refused.action) == ("refuse", None), refused.reason_plain
    assert "This conversation can't use that tool, so it was refused." in refused.reason_plain
    assert provider_refunds(setup.desk) == []
    assert mandate_spend(setup.desk.copy_id) == [(2_000, 0)]
    assert [state for *_, state in agent_charges(setup.desk.copy_id)] == ["succeeded"]


async def spend_eighty(client: httpx.AsyncClient, signed: SignedTurn) -> None:
    """Four $20 mandate charges, executed: $80 of the $100 committed."""
    for n in range(4):
        decision = await asked(client, signed, CHARGE, await quoted(client, signed, call_id=f"call-q80-{n}"),
                               call_id=f"call-c80-{n}")
        assert (await executed(client, signed, decision)).state == "succeeded"


def execute_entries(entries, decision_id: str) -> list[dict]:
    return [e.event.summary for e in entries if e.event.kind == "execute"
            and e.event.summary.get("decision_id") == decision_id]


@pytest.mark.solver
@pytest.mark.parametrize("tool", [CHARGE, LINK])
async def test_race_for_the_last_twenty(desk_prove, app, client, frozen_clock, monkeypatch, tool):
    setup = await agent_desk(app, client, frozen_clock)
    copy_id = setup.desk.copy_id
    await spend_eighty(client, setup.turn())
    # two calls for the last $20, both allowed, each in a turn of its own so neither waits on the other's
    # signature check
    turns = [setup.turn("The first."), setup.turn("The second.")]
    decisions = []
    for n, signed in enumerate(turns):
        decision = await asked(client, signed, tool, await quoted(client, signed, call_id=f"call-q-{n}"),
                               call_id=f"call-race-{n}")
        assert decision.outcome == "allow", decision.reason_plain
        decisions.append(decision)
    # both pass the re-check before either reserves, so they meet at the mandate row's lock
    meeting, reserve = asyncio.Barrier(2), mandates.reserve

    async def after_both(*args, **kwargs):
        await asyncio.wait_for(meeting.wait(), 5)
        return await reserve(*args, **kwargs)

    monkeypatch.setattr(mandates, "reserve", after_both)
    responses = await asyncio.gather(*(post_execute(client, signed, decision)
                                       for signed, decision in zip(turns, decisions, strict=True)))
    assert sorted(response.status_code for response in responses) == [200, 409]
    [(won, _)] = [(d, r) for d, r in zip(decisions, responses, strict=True) if r.status_code == 200]
    [(lost, refusal)] = [(d, r) for d, r in zip(decisions, responses, strict=True) if r.status_code == 409]
    assert refusal.json() == {"code": "conflict"}
    assert (await read(client, turns[0].headers, lost)).state == "refused_at_execution"
    [entry] = execute_entries(await ledger_rows(app, setup.desk), lost.decision_id)
    assert (entry["state"], entry["check"]) == ("refused_at_execution", "prepare")
    # exactly one holds the last $20: a charge commits it, a link keeps it reserved until it is paid
    held = await reservations(app, copy_id)
    assert [action for action, *_ in held if action in (won.action.action_id, lost.action.action_id)] == [
        won.action.action_id]
    if tool == CHARGE:
        assert mandate_spend(copy_id) == [(10_000, 0)] and len(agent_charges(copy_id)) == 5
    else:
        assert mandate_spend(copy_id) == [(8_000, 2_000)] and len(agent_charges(copy_id)) == 4
        [link] = await rows_of(app, copy_id, select(PaymentLink))
        assert (link.action_id, link.mandate_id, link.state) == (
            won.action.action_id, setup.agent.issued.mandate.mandate_id, "issued")


CHARGE_ASK = RuleCard(card_id="charge-ask", applies_to=CHARGE, mode="ask", who="anyone",
                      reason="Agent charges ask you first.")


async def held_charge(client: httpx.AsyncClient, signed: SignedTurn, n: int) -> Decision:
    decision = await asked(client, signed, CHARGE, await quoted(client, signed, call_id=f"call-hq-{n}"),
                           call_id=f"call-held-{n}")
    assert (decision.outcome, decision.card_ids) == ("hold", ["charge-ask"]), decision.reason_plain
    return decision


@pytest.mark.solver
async def test_approved_agent_charge_reserves_before_executing(desk_prove, app, client, frozen_clock, monkeypatch):
    setup = await agent_desk(app, client, frozen_clock, cards=[CHARGE_ASK, QUOTES, LINKS])
    copy_id, owner = setup.desk.copy_id, setup.desk.owner
    signed = setup.turn()
    first = await held_charge(client, signed, 0)
    # the owner's allow_once reserves the $20 with the intent, before anything is sent
    seen = []

    async def at_the_intent() -> None:
        seen.append((await reservations(app, copy_id), mandate_spend(copy_id), agent_charges(copy_id)))

    monkeypatch.setattr(execute, "_after_intent", at_the_intent)
    result = await answered(client, owner, first.decision_id, "allow_once")
    assert (result.decision.state, result.execution.state) == ("executed", "succeeded")
    assert seen == [([(first.action.action_id, 2_000, "reserved")], [(0, 2_000)], [])]
    assert mandate_spend(copy_id) == [(2_000, 0)]
    for n in (1, 2, 3):                                                     # $80 committed
        result = await answered(client, owner, (await held_charge(client, signed, n)).decision_id, "allow_once")
        assert result.decision.state == "executed"
    # two held charges for the last $20, approved at once: both pass the re-check, then meet at the mandate
    # row's lock, so one reserves and runs and the other is refused at execution
    last = [await held_charge(client, signed, 4), await held_charge(client, signed, 5)]
    meeting, reserve = asyncio.Barrier(2), mandates.reserve

    async def after_both(*args, **kwargs):
        await asyncio.wait_for(meeting.wait(), 5)
        return await reserve(*args, **kwargs)

    monkeypatch.setattr(mandates, "reserve", after_both)
    results = await asyncio.gather(*(answered(client, owner, held.decision_id, "allow_once") for held in last))
    assert sorted(r.decision.state for r in results) == ["executed", "refused_at_execution"]
    [refused] = [r for r in results if r.decision.state == "refused_at_execution"]
    assert refused.execution is None
    [entry] = [e.event.summary for e in await ledger_rows(app, setup.desk) if e.event.kind == "approval"
               and e.event.summary.get("decision_id") == refused.decision.decision_id]
    assert (entry["state"], entry["check"]) == ("refused_at_execution", "prepare")
    # its approval is used up, and nothing was sent for it
    response = await post_answer(client, owner, refused.decision.decision_id, "allow_once")
    assert (response.status_code, response.json()) == (409, {"code": "conflict"})
    assert len(agent_charges(copy_id)) == 5 and mandate_spend(copy_id) == [(10_000, 0)]
    assert refused.decision.action.action_id not in [action for action, *_ in await reservations(app, copy_id)]


@pytest.mark.solver
async def test_restart_between_intent_and_result(desk_prove, app, client, frozen_clock, monkeypatch):
    setup = await agent_desk(app, client, frozen_clock)
    copy_id = setup.desk.copy_id
    signed = setup.turn()
    await spend_eighty(client, signed)
    decision = await asked(client, signed, CHARGE, await quoted(client, signed))
    key = decision.action.action_id
    # the provider charges, then writing the result fails: nobody knows, so the reservation stays
    write_charge_fact = payments.write_charge_fact
    calls = []

    async def failing(*args, **kwargs):
        calls.append(args[3].fact_id)
        raise RuntimeError("the kernel stopped before the result was written")

    monkeypatch.setattr(payments, "write_charge_fact", failing)
    result = await executed(client, signed, decision)
    monkeypatch.setattr(payments, "write_charge_fact", write_charge_fact)
    assert (result.state, result.facts, result.model_view) == ("unknown", [], {})
    assert len(calls) == 1 and [k for k, *_ in agent_charges(copy_id)].count(key) == 1
    assert mandate_spend(copy_id) == [(8_000, 2_000)]
    assert await reservation_of(app, copy_id, key) == (2_000, "reserved")
    # so the last $20 is still held: another charge is refused at /decide
    other = await asked(client, signed, CHARGE, await quoted(client, signed, call_id="call-quote-other"),
                        call_id="call-other")
    assert (other.outcome, other.card_ids) == ("refuse", []), other.reason_plain
    # a read reconciles it by its key: the charge exists, so it is executed and committed, once
    settled = await read(client, signed.headers, decision)
    assert settled.state == "executed"
    assert mandate_spend(copy_id) == [(10_000, 0)]
    assert await reservation_of(app, copy_id, key) == (2_000, "committed")
    assert [k for k, *_ in agent_charges(copy_id)].count(key) == 1 and len(agent_charges(copy_id)) == 5
    stored = await executed(client, signed, decision)
    [fact] = stored.facts
    assert (stored.state, fact.fact_id) == ("succeeded", calls[0])
    assert stored.model_view == {"fact_id": fact.fact_id, "title": "Deposit", "amount_cents": 2_000}
    [entry] = [e for e in execute_entries(await ledger_rows(app, setup.desk), decision.decision_id)
               if e.get("state") == "executed"]
    assert entry["reconciled"] is True


def charge_states(copy_id: str, key: str) -> list[str]:
    """What the mock payments server holds under one charge key (a voided key included)."""
    with psycopg.connect(libpq_url(database_url("MOCKPAY"))) as conn:
        return [state for (state,) in conn.execute(
            "SELECT state FROM mockpay.charges WHERE copy_id = %s AND idempotency_key = %s", (copy_id, key))]


@pytest.mark.solver
async def test_timeout_then_reconcile_never_double_spends(desk_prove, app, client, frozen_clock, mockpay):
    setup = await agent_desk(app, client, frozen_clock)
    copy_id = setup.desk.copy_id
    signed = setup.turn()
    decision = await asked(client, signed, CHARGE, await quoted(client, signed))
    key = decision.action.action_id
    # the charge takes 3 s, past the 2 s deadline: it may still land, so the outcome is unknown and the
    # reservation is kept
    await delay(mockpay, setup.desk, "charge", 3)
    started = time.monotonic()
    assert (await executed(client, signed, decision)).state == "unknown"
    assert time.monotonic() - started < 3
    assert mandate_spend(copy_id) == [(0, 2_000)]
    # a read at once settles the key at the provider before the charge lands: voided, so the action failed
    # and the $20 is released
    assert (await read(client, signed.headers, decision)).state == "failed"
    assert await reservation_of(app, copy_id, key) == (2_000, "released")
    assert mandate_spend(copy_id) == [(0, 0)]
    [entry] = [e for e in execute_entries(await ledger_rows(app, setup.desk), decision.decision_id)
               if e.get("state") == "failed"]
    assert entry["reconciled"] is True
    # the delayed charge reaches the provider later and is refused: the key stays voided
    await asyncio.sleep(max(0.0, 3.5 - (time.monotonic() - started)))
    assert charge_states(copy_id, key) == ["voided"] and agent_charges(copy_id) == []
    # a new charge goes ahead, and the mandate counts exactly what moved
    await delay(mockpay, setup.desk, "charge", 0)
    again = await asked(client, signed, CHARGE, await quoted(client, signed, call_id="call-quote-again"),
                        call_id="call-again")
    assert (await executed(client, signed, again)).state == "succeeded"
    assert mandate_spend(copy_id) == [(2_000, 0)]
    assert [(k, state) for k, _, _, state in agent_charges(copy_id)] == [(again.action.action_id, "succeeded")]


@pytest.mark.solver
async def test_provider_failure_releases(desk_prove, app, client, frozen_clock):
    setup = await agent_desk(app, client, frozen_clock)
    copy_id = setup.desk.copy_id
    signed = setup.turn()
    decision = await asked(client, signed, CHARGE, await quoted(client, signed))
    key = decision.action.action_id
    # the charge never reaches a provider: nothing can have been charged, so the action failed and the
    # reservation it took with the intent is released
    runtime = app.state.kernel
    app.state.kernel = dataclasses.replace(runtime, settings=dataclasses.replace(
        runtime.settings, mockpay_url=nothing_listening()))
    try:
        result = await executed(client, signed, decision)
    finally:
        app.state.kernel = runtime
    assert (result.state, result.facts, result.model_view) == ("failed", [], {})
    assert (await read(client, signed.headers, decision)).state == "failed"
    assert await reservation_of(app, copy_id, key) == (2_000, "released")
    assert mandate_spend(copy_id) == [(0, 0)] and charge_states(copy_id, key) == []
    [entry] = [e for e in execute_entries(await ledger_rows(app, setup.desk), decision.decision_id)
               if e.get("state") == "failed"]
    assert entry["reason"] == "provider_refused"
    # the whole $100 is still there to spend
    for n in range(5):
        decision = await asked(client, signed, CHARGE, await quoted(client, signed, call_id=f"call-q-{n}"),
                               call_id=f"call-c-{n}")
        assert (await executed(client, signed, decision)).state == "succeeded"
    assert mandate_spend(copy_id) == [(10_000, 0)]


def spend_of(copy_id: str, mandate_id: str) -> tuple[int, int]:
    """One mandate's (committed, reserved), as the API reads it."""
    [row] = api_rows(copy_id, "SELECT committed_cents, reserved_cents FROM kernel_ro.mandates"
                              f" WHERE mandate_id = '{mandate_id}'")
    return row


async def agent_link(app: FastAPI, client: httpx.AsyncClient, setup: AgentDesk, signed: SignedTurn,
                     n: int) -> PaymentLink:
    """An agent link to a new $20 quote, allowed under `LINKS` and issued: its row, its $20 reserved."""
    decision = await asked(client, signed, LINK, await quoted(client, signed, call_id=f"call-lq-{n}"),
                           call_id=f"call-link-{n}")
    assert (decision.outcome, decision.card_ids) == ("allow", ["links"]), decision.reason_plain
    assert (await executed(client, signed, decision)).state == "succeeded"
    [link] = await rows_of(app, setup.desk.copy_id, select(PaymentLink).where(
        PaymentLink.action_id == decision.action.action_id))
    assert await reservation_of(app, setup.desk.copy_id, link.action_id) == (2_000, "reserved")
    return link


async def link_state(app: FastAPI, setup: AgentDesk, link: PaymentLink) -> tuple[str, str | None, tuple | None]:
    """The link's state and cancel reason, and its reservation."""
    [row] = await rows_of(app, setup.desk.copy_id, select(PaymentLink).where(PaymentLink.link_id == link.link_id))
    return row.state, row.cancel_reason, await reservation_of(app, setup.desk.copy_id, link.action_id)


@pytest.mark.solver
async def test_payment_link_reservations_follow_the_link_table(desk_prove, app, client, frozen_clock, mockpay,
                                                               monkeypatch):
    setup = await agent_desk(app, client, frozen_clock)
    copy_id, mandate_id = setup.desk.copy_id, setup.agent.issued.mandate.mandate_id
    signed = setup.turn()
    # paid: committed
    paid = await agent_link(app, client, setup, signed, 1)
    assert spend_of(copy_id, mandate_id) == (0, 2_000)
    assert (await completed(client, paid.token)).state == "paid"
    assert await link_state(app, setup, paid) == ("paid", None, (2_000, "committed"))
    # cancelled at the checkout: released
    cancelled = await agent_link(app, client, setup, signed, 2)
    assert (await post_cancel(client, cancelled.token)).status_code == 200
    assert await link_state(app, setup, cancelled) == ("cancelled", None, (2_000, "released"))
    # a completion whose outcome nobody knows: kept, until a read settles it at the provider (paid, committed)
    unknown = await agent_link(app, client, setup, signed, 3)
    await delay(mockpay, setup.desk, "complete", 3)
    assert (await completed(client, unknown.token)).state == "unknown"
    assert await link_state(app, setup, unknown) == ("unknown", None, (2_000, "reserved"))
    await delay(mockpay, setup.desk, "complete", 0)
    await charged(setup.desk, f"{unknown.action_id}:charge")
    assert (await view(client, unknown.token)).state == "paid"
    assert await link_state(app, setup, unknown) == ("paid", None, (2_000, "committed"))
    assert spend_of(copy_id, mandate_id) == (4_000, 0)

    # a rule change: another agent's link it still allows, this agent's open link and one being issued
    other = await mint(client, setup.desk.owner, setup.desk.desk_id)
    other_setup = AgentDesk(desk=setup.desk, agent=other, clock=frozen_clock,
                            session_id=(await open_agent(client, setup.desk.slug, other, frozen_clock)).state.session_id)
    kept = await agent_link(app, client, other_setup, other_setup.turn(), 4)
    at_activation = await agent_link(app, client, setup, signed, 5)
    issuing = await asked(client, signed, LINK, await quoted(client, signed, call_id="call-lq-6"), call_id="call-link-6")
    assert issuing.outcome == "allow", issuing.reason_plain
    no_links = RuleCard(card_id="no-links", applies_to=LINK, mode="never", who="agent", agent_key_id=setup.agent.key_id,
                        reason="This agent doesn't get payment links any more.")
    original = execute._after_intent

    async def confirmed_as_it_issues() -> None:
        monkeypatch.setattr(execute, "_after_intent", original)
        await draft_and_confirm(client, setup.desk.owner_token, setup.desk.desk_id, [*CARDS, no_links])

    monkeypatch.setattr(execute, "_after_intent", confirmed_as_it_issues)
    # refused at issue: the newer version no longer allows it, so no link is written and its $20 is released
    assert (await executed(client, signed, issuing)).state == "failed"
    assert await reservation_of(app, copy_id, issuing.action.action_id) == (2_000, "released")
    assert [link.action_id for link in await rows_of(app, copy_id, select(PaymentLink))].count(
        issuing.action.action_id) == 0
    # cancelled at activation: released
    assert await link_state(app, setup, at_activation) == ("cancelled", "rules_changed", (2_000, "released"))
    # the other agent's link stays issued, holding its $20
    assert await link_state(app, other_setup, kept) == ("issued", None, (2_000, "reserved"))
    other_mandate = other.issued.mandate.mandate_id
    assert spend_of(copy_id, mandate_id) == (4_000, 0) and spend_of(copy_id, other_mandate) == (0, 2_000)
    # expired, a day later: released
    frozen_clock.advance((kept.expires_at - frozen_clock.now()).total_seconds())
    assert (await view(client, kept.token)).state == "expired"
    assert await link_state(app, other_setup, kept) == ("expired", None, (2_000, "released"))
    assert spend_of(copy_id, other_mandate) == (0, 0)
    assert [key for key, *_ in charges(setup.desk)] == sorted([f"{paid.action_id}:charge",
                                                              f"{unknown.action_id}:charge"])


CALLBACKS = RuleCard(card_id="callbacks", applies_to="native.request_callback", mode="auto", who="anyone",
                     reason="Callback requests go straight through.")


@pytest.mark.solver
async def test_agent_link_keeps_its_reservation_through_an_activation(desk_prove, app, client, frozen_clock):
    setup = await agent_desk(app, client, frozen_clock)
    copy_id, mandate_id = setup.desk.copy_id, setup.agent.issued.mandate.mandate_id
    signed = setup.turn()
    await spend_eighty(client, signed)
    link = await agent_link(app, client, setup, signed, 1)                  # the last $20, held by the link
    assert spend_of(copy_id, mandate_id) == (8_000, 2_000)
    # a version that adds an unrelated card: the link took the last of the mandate, which doesn't count
    # against it, so it stays issued with its reservation
    version = await draft_and_confirm(client, setup.desk.owner_token, setup.desk.desk_id, [*CARDS, CALLBACKS])
    assert await link_state(app, setup, link) == ("issued", None, (2_000, "reserved"))
    assert not [e for e in await ledger_rows(app, setup.desk) if e.event.kind == "payment"
                and e.event.summary.get("version") == version.version]
    # while a new $20 charge has nothing left to draw on
    refused = await asked(client, signed, CHARGE, await quoted(client, signed, call_id="call-quote-new"),
                          call_id="call-new")
    assert (refused.outcome, refused.card_ids) == ("refuse", []), refused.reason_plain
    # it pays once, and the mandate has committed exactly its $100
    assert (await completed(client, link.token)).state == "paid"
    assert await link_state(app, setup, link) == ("paid", None, (2_000, "committed"))
    assert spend_of(copy_id, mandate_id) == (10_000, 0)
    assert [key for key, *_ in charges(setup.desk) if key.endswith(":charge")] == [f"{link.action_id}:charge"]
    response = await client.post(f"/payment_links/{link.token}/complete", json={})
    assert (response.status_code, response.json()) == (409, {"code": "conflict"})
    assert spend_of(copy_id, mandate_id) == (10_000, 0)


def reply_entries(entries) -> list[dict]:
    return [e.event.summary for e in entries if e.event.kind == "reply"]


def payment_entries(entries, link: PaymentLink) -> list[dict]:
    return [e.event.summary for e in entries if e.event.kind == "payment" and e.event.summary["link_id"] == link.link_id]


@pytest.mark.solver
@pytest.mark.parametrize("then", ["complete", "confirm"])
async def test_expired_mandate_cancels_its_open_link(desk_prove, app, client, frozen_clock, then):
    setup = await agent_desk(app, client, frozen_clock)
    copy_id, mandate_id = setup.desk.copy_id, setup.agent.issued.mandate.mandate_id
    link = await agent_link(app, client, setup, setup.turn(), 1)
    frozen_clock.travel(await expiry_of(app, setup))                        # the mandate's last moment has passed
    assert link.expires_at > frozen_clock.now()                             # the link's day hasn't
    if then == "complete":
        # completing it rechecks the baseline: no live mandate, so it is cancelled, with nothing charged
        response = await client.post(f"/payment_links/{link.token}/complete", json={})
        assert (response.status_code, response.json()) == (409, {"code": "conflict"})
        assert payment_entries(await ledger_rows(app, setup.desk), link)[-1] == {
            "link_id": link.link_id, "state": "cancelled", "reason": "mandate_expired"}
    else:
        # any confirm cancels it in its activation, naming the version, and the chat isn't told of a rule change
        version = await draft_and_confirm(client, setup.desk.owner_token, setup.desk.desk_id, [*CARDS, CALLBACKS])
        assert payment_entries(await ledger_rows(app, setup.desk), link)[-1] == {
            "link_id": link.link_id, "state": "cancelled", "reason": "mandate_expired", "version": version.version}
        assert await cancelled_links(client, setup.desk, version.version) == []
    assert await link_state(app, setup, link) == ("cancelled", "mandate_expired", (2_000, "released"))
    assert spend_of(copy_id, mandate_id) == (0, 0)
    assert [key for key, *_ in charges(setup.desk)] == []
    response = await client.post(f"/payment_links/{link.token}/complete", json={})
    assert (response.status_code, response.json()) == (409, {"code": "conflict"})


@pytest.mark.solver
async def test_mandate_expiry_waits_for_a_started_completion(desk_prove, app, client, frozen_clock, mockpay,
                                                             monkeypatch):
    setup = await agent_desk(app, client, frozen_clock)
    copy_id, mandate_id = setup.desk.copy_id, setup.agent.issued.mandate.mandate_id
    link = await agent_link(app, client, setup, setup.turn(), 1)
    response = await post_draft(client, setup.desk, [*CARDS, CALLBACKS], 2)
    assert response.status_code == 200, response.text
    version = PolicyVersion.model_validate(response.json())
    assert (version.version, version.status) == (3, "proved"), version.proof
    expires_at = await expiry_of(app, setup)
    frozen_clock.travel(expires_at - timedelta(seconds=5))                 # the mandate's last seconds
    await delay(mockpay, setup.desk, "complete", 3)                         # C2 times out and rolls back
    seen = []

    async def expiry_and_activation() -> None:
        frozen_clock.advance(10)                                            # past the mandate's expiry
        await confirm(client, setup.desk, version.version)
        seen.append(await link_state(app, setup, link))

    monkeypatch.setattr(payments, "_before_c3", expiry_and_activation)
    result = await completed(client, link.token)
    # the activation finds a completion started: it may be at the provider, so the link goes to unknown for
    # its mandate, naming the version, with its marker and its reservation kept, and C3 leaves it there
    assert seen == [("unknown", "mandate_expired", (2_000, "reserved"))]
    assert (result.state, result.verdict) == ("unknown", None)
    entries = payment_entries(await ledger_rows(app, setup.desk), link)
    assert {"link_id": link.link_id, "state": "unknown", "reason": "mandate_expired",
            "version": version.version} in entries
    assert not [entry for entry in entries if entry.get("reason") == "provider_unknown"]
    assert spend_of(copy_id, mandate_id) == (0, 2_000)
    # once the delayed completion lands, a read settles it at the provider: paid, committed, once
    await delay(mockpay, setup.desk, "complete", 0)
    await charged(setup.desk, f"{link.action_id}:charge")
    assert (await view(client, link.token)).state == "paid"
    # paid, it keeps none of the activation's cancellation, whose reason and version its entries keep
    assert await link_state(app, setup, link) == ("paid", None, (2_000, "committed"))
    [row] = await rows_of(app, copy_id, select(PaymentLink).where(PaymentLink.link_id == link.link_id))
    assert row.cancelled_by_version is None
    assert spend_of(copy_id, mandate_id) == (2_000, 0)
    assert [key for key, *_ in charges(setup.desk)] == [f"{link.action_id}:charge"]


async def test_demo_agent_pays_the_rivera_deposit(app, client, frozen_clock):
    setup = await rivera_agent(app, client, frozen_clock)
    copy_id = setup.desk.copy_id
    signed = setup.turn()
    decision = await asked(client, signed, CHARGE, await quoted(client, signed))
    assert (decision.outcome, decision.card_ids, decision.action.amount_cents) == ("allow", ["rv-mandate"], 2_000)
    result = await executed(client, signed, decision)
    [fact] = result.facts
    charge_id = fact.fact_id.removeprefix("charge:")
    assert result.state == "succeeded"
    assert result.model_view == {"fact_id": fact.fact_id, "title": "Service call deposit", "amount_cents": 2_000}
    assert (fact.kind, fact.status, fact.label.readers, fact.label.record_owner) == (
        "charge", "committed", ["owner", f"session:{setup.session_id}"], None)
    assert [(c.key, c.value) for c in fact.claims] == [("title", "Service call deposit"), ("total", 2_000),
                                                       ("ref", charge_id)]
    # one charge to the agent at the provider, under the action's key; $20 of the $100 committed
    assert agent_charges(copy_id) == [(decision.action.action_id, 2_000, f"agent:{setup.agent.key_id}", "succeeded")]
    assert mandate_spend(copy_id) == [(2_000, 0)]
    # its receipt says what was done, with no amount
    done = await read(client, signed.headers, decision)
    assert (done.state, done.visitor_plain) == ("executed", "Charged within the limit of your mandate")
    # the charge_confirmed card renders from the fact, in either language
    for message, prose, language in (("Thanks.", "Here is the confirmation of your payment.", "en"),
                                     ("Gracias.", "Aquí tienes la confirmación de tu pago.", "es")):
        verdict = await checked(client, setup.turn(message), prose, [clause("charge_confirmed", fact.fact_id)])
        assert (verdict.ok, verdict.language) == (True, language), verdict.violations
        [_, card] = verdict.blocks
        assert (card.kind, card.template, card.fact_id, card.title, card.lines, card.href) == (
            "card", "charge_confirmed", fact.fact_id, "Service call deposit, $20.00", [], None)


async def test_an_agent_may_name_its_quote_by_its_fact_id(app, client, frozen_clock):
    """An agent's context shows its quote by its fact ID (`quote:<id>`), as a visitor's does, and the
    tool takes "the quote_id in your context": the whole fact ID charges exactly the quote the bare ID
    would, within the mandate, and no other prefix is read as the quote's."""
    setup = await rivera_agent(app, client, frozen_clock)
    signed = setup.turn()
    quote_id = await quoted(client, signed)
    other = await asked(client, signed, CHARGE, f"charge:{quote_id}", call_id="call-other")
    assert (other.outcome, other.action) == ("refuse", None)
    decision = await asked(client, signed, CHARGE, f"quote:{quote_id}")
    assert (decision.outcome, decision.card_ids, decision.action.resource.id, decision.action.amount_cents) == (
        "allow", ["rv-mandate"], quote_id, 2_000), decision.reason_plain
    assert (await executed(client, signed, decision)).state == "succeeded"
    assert await quote_status(app, setup.desk.copy_id, quote_id) == "paid"
    assert agent_charges(setup.desk.copy_id) == [
        (decision.action.action_id, 2_000, f"agent:{setup.agent.key_id}", "succeeded")]


# ---- A quote is paid once -------------------------------------------------------------------------------

async def quote_status(app: FastAPI, copy_id: str, quote_id: str) -> str:
    [quote] = await rows_of(app, copy_id, select(Quote).where(Quote.quote_id == quote_id))
    return quote.status


@pytest.mark.solver
async def test_a_quote_is_charged_once(desk_prove, app, client, frozen_clock):
    """A quote is paid once. The agent charges its deposit quote, then asks to charge the same quote
    again, as a repeated tool call in the turn would, and again in a new turn, as a resent one
    would: each is refused at step 1, before any action exists, with the adapter's `quote_paid` on
    its `decide` entry and the generic line for the visitor. One charge reached the provider, $20 is
    committed and nothing is held."""
    setup = await agent_desk(app, client, frozen_clock)
    copy_id = setup.desk.copy_id
    signed = setup.turn()
    quote_id = await quoted(client, signed)
    first = await asked(client, signed, CHARGE, quote_id, call_id="call-charge-1")
    assert first.outcome == "allow", first.reason_plain
    assert (await executed(client, signed, first)).state == "succeeded"
    assert await quote_status(app, copy_id, quote_id) == "paid"
    for call_id, turn_of in (("call-charge-2", signed), ("call-charge-3", setup.turn("Paying the deposit again."))):
        again = await asked(client, turn_of, CHARGE, quote_id, call_id=call_id)
        assert (again.outcome, again.state, again.action) == ("refuse", "refused", None), again.reason_plain
        assert "It didn't match your records, so it was refused." in again.reason_plain
        assert again.visitor_plain == "Not something I can do here"
    refusals = [entry for entry in decide_entries(await ledger_rows(app, setup.desk), setup.session_id)
                if entry.get("outcome") == "refuse"]
    assert refusals == [{"outcome": "refuse", "tool": CHARGE, "reason": "adapter_refused", "check": "quote_paid",
                         "policy_version": first.policy_version, "auto_money_cap_cents": 50_000}] * 2
    assert [(key, amount) for key, amount, _, _ in agent_charges(copy_id)] == [(first.action.action_id, 2_000)]
    assert mandate_spend(copy_id) == [(2_000, 0)]


def paying_refusals(entries, session_id: str) -> list[dict]:
    return [entry for entry in decide_entries(entries, session_id)
            if entry.get("outcome") == "refuse" and entry.get("check") == "quote_paying"]


async def test_a_charge_that_timed_out_keeps_its_quote_unpayable_before_its_outcome_is_written(
        desk_prove, app, client, frozen_clock, monkeypatch):
    """A charge whose provider call times out lets go of the quote's row when its T2 rolls back, and
    only then writes its outcome as `unknown` (T3). A second charge of the same quote asked in that
    gap finds the first one's intent, fresh as it is, and is refused at step 1 with `quote_paying`:
    it reserves and sends nothing, so only the first can have reached the provider."""
    setup = await agent_desk(app, client, frozen_clock)
    copy_id = setup.desk.copy_id
    signed = setup.turn()
    quote_id = await quoted(client, signed)
    first = await asked(client, signed, CHARGE, quote_id, call_id="call-charge-1")
    assert first.outcome == "allow", first.reason_plain

    async def timed_out(self, *args, **kwargs):
        raise payments.ProviderTimeout("the provider didn't answer in time")

    in_the_gap, go_on = asyncio.Event(), asyncio.Event()
    settle_unknown = execute._settle_unknown

    async def paused_before_its_outcome(*args, **kwargs):
        in_the_gap.set()
        await go_on.wait()
        return await settle_unknown(*args, **kwargs)

    monkeypatch.setattr(payments.ProviderClient, "charge", timed_out)
    monkeypatch.setattr(execute, "_settle_unknown", paused_before_its_outcome)
    running = asyncio.create_task(post_execute(client, signed, first))
    await asyncio.wait_for(in_the_gap.wait(), 5)       # T2 has rolled back; the outcome isn't written yet
    again = await asked(client, signed, CHARGE, quote_id, call_id="call-charge-2")
    assert (again.outcome, again.action) == ("refuse", None), again.reason_plain
    go_on.set()
    response = await asyncio.wait_for(running, 10)
    assert ExecResult.model_validate(response.json()).state == "unknown"
    assert paying_refusals(await ledger_rows(app, setup.desk), setup.session_id) == [
        {"outcome": "refuse", "tool": CHARGE, "reason": "adapter_refused", "check": "quote_paying",
         "policy_version": first.policy_version, "auto_money_cap_cents": 50_000}]
    assert await reservations(app, copy_id) == [(first.action.action_id, 2_000, "reserved")]   # kept while unknown
    assert agent_charges(copy_id) == []
    assert await quote_status(app, copy_id, quote_id) != "paid"


async def test_a_charge_cut_off_after_its_intent_keeps_its_quote_unpayable_until_it_is_settled(
        desk_prove, app, client, frozen_clock, monkeypatch):
    """A charge whose kernel died right after its intent committed may yet have reached the provider,
    so its quote is unpayable from that moment, not only once the intent is old enough to reconcile:
    a second charge asked at once is refused at step 1 with `quote_paying`, reserving and sending
    nothing. Once the first is settled (a read reconciles it; the provider never saw it, so it is
    `failed` and its $20 released), the quote is payable again."""
    setup = await agent_desk(app, client, frozen_clock)
    copy_id = setup.desk.copy_id
    signed = setup.turn()
    quote_id = await quoted(client, signed)
    first = await asked(client, signed, CHARGE, quote_id, call_id="call-charge-1")
    assert first.outcome == "allow", first.reason_plain
    with monkeypatch.context() as patch:
        patch.setattr(execute, "_after_intent", crash)
        with pytest.raises(Crash):
            await post_execute(client, signed, first)
    again = await asked(client, signed, CHARGE, quote_id, call_id="call-charge-2")
    assert (again.outcome, again.action) == ("refuse", None), again.reason_plain
    assert paying_refusals(await ledger_rows(app, setup.desk), setup.session_id) == [
        {"outcome": "refuse", "tool": CHARGE, "reason": "adapter_refused", "check": "quote_paying",
         "policy_version": first.policy_version, "auto_money_cap_cents": 50_000}]
    assert agent_charges(copy_id) == []

    frozen_clock.advance(31)                            # an orphan now: a read reconciles it
    later = setup.turn("Is the deposit paid?")
    assert (await read(client, later.headers, first)).state == "failed"
    assert await reservations(app, copy_id) == [(first.action.action_id, 2_000, "released")]
    third = await asked(client, later, CHARGE, quote_id, call_id="call-charge-3")
    assert third.outcome == "allow", third.reason_plain


@pytest.mark.solver
@pytest.mark.parametrize("first", ["charge", "completion"])
async def test_a_charge_and_a_link_completion_of_one_quote_pay_once(desk_prove, app, client, frozen_clock,
                                                                     monkeypatch, first):
    """Of a mandate charge and a link's completion for the same quote, exactly one pays it. The
    agent has an open link to its deposit quote and an allowed charge of the same quote, and
    whichever reaches the provider first is held there by the test. A charge holds the quote's row
    across its call, so a completion arriving meanwhile waits for that row, then finds the quote
    paid and sends nothing: 409, its link cancelled (no `cancel_reason`) and ledgered `quote_paid`,
    its $20 released. A completion's marker, committed before it asks the provider, keeps the quote
    unpayable, so a charge arriving meanwhile is refused at its execution re-check, before it
    reserves or sends anything. One payment reaches the provider, the mandate commits $20 and holds
    nothing, and the quote is paid."""
    setup = await agent_desk(app, client, frozen_clock)
    copy_id = setup.desk.copy_id
    signed = setup.turn()
    quote_id = await quoted(client, signed)
    issuing = await asked(client, signed, LINK, quote_id, call_id="call-link")
    assert issuing.outcome == "allow", issuing.reason_plain
    assert (await executed(client, signed, issuing)).state == "succeeded"
    [link] = await rows_of(app, copy_id, select(PaymentLink))
    charging = await asked(client, signed, CHARGE, quote_id, call_id="call-charge")
    assert charging.outcome == "allow", charging.reason_plain

    at_provider, answer = asyncio.Event(), asyncio.Event()
    method = "charge" if first == "charge" else "complete"
    original = getattr(payments.ProviderClient, method)

    async def held_at_the_provider(self, *args, **kwargs):
        at_provider.set()
        await answer.wait()
        return await original(self, *args, **kwargs)

    def charge() -> Awaitable[httpx.Response]:
        return post_execute(client, signed, charging)

    def complete() -> Awaitable[httpx.Response]:
        return client.post(f"/payment_links/{link.token}/complete", json={})

    monkeypatch.setattr(payments.ProviderClient, method, held_at_the_provider)
    entries_of = execute_entries
    if first == "charge":
        with connections_of(app) as pids:
            holding = asyncio.create_task(charge())
            await asyncio.wait_for(at_provider.wait(), 5)          # it holds the quote's row at the provider
            waiting = asyncio.create_task(complete())
            await until_waiting(app, waiting, pids, table="kernel.quotes")
            assert not waiting.done()
            answer.set()
            charged_response, completed_response = await asyncio.wait_for(asyncio.gather(holding, waiting), 10)
        assert charged_response.status_code == 200, charged_response.text
        assert ExecResult.model_validate(charged_response.json()).state == "succeeded"
        assert (completed_response.status_code, completed_response.json()) == (409, {"code": "conflict"})
        assert await link_state(app, setup, link) == ("cancelled", None, (2_000, "released"))
        assert payment_entries(await ledger_rows(app, setup.desk), link)[-1] == {
            "link_id": link.link_id, "state": "cancelled", "reason": "quote_paid"}
        assert await reservation_of(app, copy_id, charging.action.action_id) == (2_000, "committed")
        assert [(key, amount) for key, amount, _ in charges(setup.desk)] == [(charging.action.action_id, 2_000)]
    else:
        holding = asyncio.create_task(complete())
        await asyncio.wait_for(at_provider.wait(), 5)              # its marker is committed; it is at the provider
        refused = await asyncio.wait_for(charge(), 5)              # answered at once: it waits for nothing
        assert (refused.status_code, refused.json()) == (409, {"code": "conflict"})
        assert not holding.done()
        answer.set()
        completed_response = await asyncio.wait_for(holding, 10)
        assert completed_response.status_code == 200, completed_response.text
        assert PaymentLinkStateResult.model_validate(completed_response.json()).state == "paid"
        assert (await read(client, signed.headers, charging)).state == "refused_at_execution"
        [entry] = entries_of(await ledger_rows(app, setup.desk), charging.decision_id)
        assert (entry["state"], entry["check"]) == ("refused_at_execution", "args")
        assert await link_state(app, setup, link) == ("paid", None, (2_000, "committed"))
        assert await reservation_of(app, copy_id, charging.action.action_id) is None   # it reserved nothing
        assert [(key, amount) for key, amount, _ in charges(setup.desk)] == [(f"{link.action_id}:charge", 2_000)]
    assert mandate_spend(copy_id) == [(2_000, 0)]
    assert await quote_status(app, copy_id, quote_id) == "paid"


async def link_and_charge(app: FastAPI, client: httpx.AsyncClient, setup: AgentDesk,
                          signed: SignedTurn) -> tuple[PaymentLink, Decision]:
    """An issued agent link to a new deposit quote, and an allowed charge of the same quote: the
    link's row, and the charge's decision, not yet executed."""
    quote_id = await quoted(client, signed)
    issuing = await asked(client, signed, LINK, quote_id, call_id="call-link")
    assert issuing.outcome == "allow", issuing.reason_plain
    assert (await executed(client, signed, issuing)).state == "succeeded"
    [link] = await rows_of(app, setup.desk.copy_id, select(PaymentLink))
    charging = await asked(client, signed, CHARGE, quote_id, call_id="call-charge")
    assert charging.outcome == "allow", charging.reason_plain
    return link, charging


@pytest.mark.solver
async def test_a_link_whose_quote_a_charge_paid_reads_as_cancelled(desk_prove, app, client, frozen_clock,
                                                                    monkeypatch):
    """A link is open only while its quote can still be paid. The agent has an open link to its
    deposit quote, then pays the same quote within its mandate: the next read of the link (the
    checkout's, or a chat's) finds the quote paid, so the link is `cancelled` (no `cancel_reason`),
    ledgered `quote_paid` as a completion's refusal is, and its $20 released, with nothing asked of
    the provider; a second read moves nothing. A link to another quote, still unpaid, stays open, and
    completing the cancelled link is refused, with nothing sent."""
    setup = await agent_desk(app, client, frozen_clock)
    copy_id = setup.desk.copy_id
    signed = setup.turn()
    link, charging = await link_and_charge(app, client, setup, signed)
    other = await agent_link(app, client, setup, signed, 2)
    assert (await executed(client, signed, charging)).state == "succeeded"
    assert await quote_status(app, copy_id, link.quote_id) == "paid"

    asked_provider: list[str] = []

    def no_provider(ctx):
        asked_provider.append("provider")
        raise AssertionError("a link whose quote is paid needs nothing from the provider")

    monkeypatch.setattr(payments, "provider", no_provider)
    replies = reply_entries(await ledger_rows(app, setup.desk))
    seen = await view(client, link.token)
    # no rule change cancelled it, so the checkout gives no reason, and the chat gets no card for it
    assert (seen.state, seen.cancel_reason) == ("cancelled", None)
    entries = payment_entries(await ledger_rows(app, setup.desk), link)
    assert entries[-1] == {"link_id": link.link_id, "state": "cancelled", "reason": "quote_paid"}
    assert reply_entries(await ledger_rows(app, setup.desk)) == replies
    assert await cancelled_links(client, setup.desk, charging.policy_version) == []
    assert await link_state(app, setup, link) == ("cancelled", None, (2_000, "released"))
    assert (await view(client, link.token)).state == "cancelled"                # a second read moves nothing
    assert payment_entries(await ledger_rows(app, setup.desk), link) == entries
    assert (await view(client, other.token)).state == "issued"                 # its quote is still unpaid
    assert await link_state(app, setup, other) == ("issued", None, (2_000, "reserved"))
    assert asked_provider == []

    response = await client.post(f"/payment_links/{link.token}/complete", json={})
    assert (response.status_code, response.json()) == (409, {"code": "conflict"})
    assert payment_entries(await ledger_rows(app, setup.desk), link)[-1] == {
        "link_id": link.link_id, "refused": True, "state": "cancelled", "reason": "cancelled"}
    assert asked_provider == []
    assert [(key, amount) for key, amount, _ in charges(setup.desk)] == [(charging.action.action_id, 2_000)]
    assert mandate_spend(copy_id) == [(2_000, 2_000)]                          # the charge, and the other link's hold


@pytest.mark.solver
async def test_a_link_whose_quote_is_still_being_paid_stays_open(desk_prove, app, client, frozen_clock,
                                                                 monkeypatch):
    """Only a paid quote closes its open links. A charge of the link's quote whose kernel died right
    after its intent may or may not have reached the provider, so the quote is being paid
    (`quote_paying`), not paid: a read leaves the link open, its $20 still held, until that charge
    is settled."""
    setup = await agent_desk(app, client, frozen_clock)
    signed = setup.turn()
    link, charging = await link_and_charge(app, client, setup, signed)
    with monkeypatch.context() as patch:
        patch.setattr(execute, "_after_intent", crash)
        with pytest.raises(Crash):
            await post_execute(client, signed, charging)
    assert (await view(client, link.token)).state == "issued"
    assert await link_state(app, setup, link) == ("issued", None, (2_000, "reserved"))
    assert [entry["state"] for entry in payment_entries(await ledger_rows(app, setup.desk), link)] == ["issued"]


@pytest.mark.solver
async def test_a_read_never_waits_for_a_paid_quotes_row(desk_prove, app, client, frozen_clock):
    """A read doesn't wait for the row of a quote another transaction holds (a payment of it, here a
    test's lock): it leaves the link as it is and answers at once, and the next read, once the row is
    free, cancels the link of the quote the charge paid."""
    setup = await agent_desk(app, client, frozen_clock)
    signed = setup.turn()
    link, charging = await link_and_charge(app, client, setup, signed)
    assert (await executed(client, signed, charging)).state == "succeeded"
    with psycopg.connect(libpq_url(database_url("ADMIN"))) as holding:
        holding.execute("SELECT quote_id FROM kernel.quotes WHERE quote_id = %s FOR UPDATE",
                        (charging.action.resource.id,))
        started = time.monotonic()
        assert (await asyncio.wait_for(view(client, link.token), 5)).state == "issued"
        assert time.monotonic() - started < 2
        holding.rollback()
    assert (await view(client, link.token)).state == "cancelled"
    assert await link_state(app, setup, link) == ("cancelled", None, (2_000, "released"))


@pytest.mark.solver
async def test_a_rule_change_cancels_a_paid_quotes_link_with_no_chat_line(desk_prove, app, client, frozen_clock):
    """A rule change that would cancel a link for its rules says so in the link's chat, which asks the
    customer to ask again if they still want to pay. A link whose quote another payment has paid can't be
    paid whatever the rules say, so an activation that reaches it before any read cancels it as a read
    would: `quote_paid`, naming no `cancel_reason`, its $20 released, and no chat line."""
    setup = await agent_desk(app, client, frozen_clock)
    signed = setup.turn()
    link, charging = await link_and_charge(app, client, setup, signed)
    assert (await executed(client, signed, charging)).state == "succeeded"
    no_links = RuleCard(card_id="no-links", applies_to=LINK, mode="never", who="agent", agent_key_id=setup.agent.key_id,
                        reason="This agent doesn't get payment links any more.")
    version = await draft_and_confirm(client, setup.desk.owner_token, setup.desk.desk_id, [*CARDS, no_links])
    assert payment_entries(await ledger_rows(app, setup.desk), link)[-1] == {
        "link_id": link.link_id, "state": "cancelled", "reason": "quote_paid", "version": version.version}
    assert await link_state(app, setup, link) == ("cancelled", None, (2_000, "released"))
    assert await cancelled_links(client, setup.desk, version.version) == []
    seen = await view(client, link.token)
    assert (seen.state, seen.cancel_reason) == ("cancelled", None)


@pytest.mark.solver
async def test_a_rule_change_leaves_a_started_completion_of_a_paid_quotes_link_to_its_c2(
        desk_prove, app, client, frozen_clock, monkeypatch):
    """A completion whose marker is set may be at the provider, so an activation that would move its link sends it
    to `unknown` instead. A link whose quote another payment has paid needs no such move: its completion's C2
    refuses it under the quote's row with nothing sent. So a rule change that lands between C1 and C2 leaves the
    link `issued` with its marker, and C2 then cancels it, ledgered `quote_paid`, with no `cancel_reason`."""
    setup = await agent_desk(app, client, frozen_clock)
    signed = setup.turn()
    link, charging = await link_and_charge(app, client, setup, signed)
    assert (await executed(client, signed, charging)).state == "succeeded"
    no_links = RuleCard(card_id="no-links", applies_to=LINK, mode="never", who="agent", agent_key_id=setup.agent.key_id,
                        reason="This agent doesn't get payment links any more.")
    between: list[tuple] = []

    async def a_rule_change_meanwhile() -> None:
        version = await draft_and_confirm(client, setup.desk.owner_token, setup.desk.desk_id, [*CARDS, no_links])
        [row] = await rows_of(app, setup.desk.copy_id, select(PaymentLink).where(PaymentLink.link_id == link.link_id))
        between.append((row.state, row.completion_started_at is not None, row.cancel_reason, version.version))

    monkeypatch.setattr(payments, "_after_marker", a_rule_change_meanwhile)
    response = await client.post(f"/payment_links/{link.token}/complete", json={})
    assert (response.status_code, response.json()) == (409, {"code": "conflict"})
    [(state, marked, cancel_reason, version)] = between
    assert (state, marked, cancel_reason) == ("issued", True, None)
    assert payment_entries(await ledger_rows(app, setup.desk), link)[-1] == {
        "link_id": link.link_id, "state": "cancelled", "reason": "quote_paid"}
    assert await link_state(app, setup, link) == ("cancelled", None, (2_000, "released"))
    assert await cancelled_links(client, setup.desk, version) == []
    assert [(key, amount) for key, amount, _ in charges(setup.desk)] == [(charging.action.action_id, 2_000)]
