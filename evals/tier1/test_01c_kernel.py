"""Plan 01c's own tier 1 cases: the payment, pin, agent and probe rows the shared suites leave out.

`test_payments_and_agents.py` holds most of this plan's rows: pinned tools and their drift, a
refund across copies, a payment link's life, the demo mandate's bounds and races, signed agent
requests, and a quote paid once. These cases add the rest Plan 01c's merge gate names (its Task 10):
two completions of one link sent at once; a new Desk with no `payments.*` tool; a refund the owner
approves after its tool's definition changed; a mandate charge whose provider answered late,
settled by `void` before the late call lands; an agent's nonce resent after a turn that ended in an
immediate handoff, and an opening request resent after its turn; a minted agent's codes in the
Demo inbox of the session that minted it; and setup probes of an unknown tool and of a payment
with no amount (Plan 01c's setup tools, `01c-setup`).

Every case goes through the kernel's HTTP contract alone; on the real kernel it also reads what the
kernel stored (`kernel_ro`) and what the mock payments server holds, as evidence.
"""

import asyncio
from typing import Any

import pytest

from desk.contracts import BusinessSeed, Claim, DeskSeed, HoursWindow, NotificationDefaults, PriceItem
from desk.kernel_api import PaymentLinkStateResult
from evals.fakes import FakeAnthropic
from evals.tier1.args import refund_args
from evals.tier1.golden_desk import (
    CONTACTS,
    STUB_CODE,
    Caller,
    GoldenDesk,
    active_version,
    code_from_inbox,
    decide,
    demo_agent,
    golden_desk,
    open_caller,
)
from evals.tier1.harness import Auth, Expect, KernelHarness
from evals.tier1.test_approvals import CONFLICT, answer, execute, not_run, read
from evals.tier1.test_payments_and_agents import (
    CHARGE,
    DANA_250,
    DEPOSIT_CENTS,
    LINK,
    REFUND,
    REPLAYED,
    UNNORMALIZED,
    agent_secrets,
    assert_charged,
    assert_hold_none,
    assert_paid_once,
    assert_spend,
    complete,
    decide_spend,
    issue_link,
    let_the_delayed_call_land,
    link_row,
    link_view,
    mandate_charge,
    provider_delay,
    simulate_change,
    spent,
    store_before,
    stored_charges,
    whoami,
    whoami_as,
)
from evals.tier1.test_reply_golden import CLEAN_EN, FRENCH_PROSE, check_reply, handed_off, passes
from evals.tier1.test_sessions import assert_ledgered, decide_body, decision_ids, find_slots

PAYMENTS = ("payments.list_charges", "payments.create_refund")   # the mock payments server's two pinned tools


# Two completions of one link at once

@pytest.mark.requires("01c")
async def test_concurrent_completes_pay_once(k: KernelHarness, fake: FakeAnthropic, records):
    """Two completions of one payment link sent at once pay it once: one is `paid`, for the link's
    session, and the other is 409 `conflict`; the link reads `paid`, the session holds one charge
    fact for the quote's amount, and the copy's store gained that one charge."""
    desk = await golden_desk(k)
    store = await store_before(k, desk)
    visitor = await open_caller(k, desk, "visitor")
    link = await issue_link(k, fake, desk, visitor)
    paid = Expect(fields={"state": "paid", "session_id": visitor.state.session_id})
    # Each completes or is refused; the stub answers each with its first alternative.
    results = await asyncio.gather(*[complete(k, link, expect=Expect(any_of=order))
                                     for order in ([paid, CONFLICT], [CONFLICT, paid])])
    went_through = [isinstance(result, PaymentLinkStateResult) for result in results]
    assert went_through.count(True) == 1, f"{went_through.count(True)} of two completions sent at once paid the link"
    await link_view(k, link, "paid")

    if k.is_real:
        await assert_paid_once(k, records, desk, visitor, store)
        assert (await link_row(records, desk, link))["state"] == "paid"


# A new Desk and the payments tools

NEW_DESK = {   # a second Desk the owner adds to the copy: no connections, as `POST /desks` requires
    "business": BusinessSeed(name="Lopez Electric", owner_display_name="Ana Lopez",
                             timezone="America/Chicago").model_dump(mode="json"),
    "desk": DeskSeed(name="Main line", charter=[Claim(key="contact", kind="text", value="(312) 555-0110")],
                     hours=[HoursWindow(days=["mon", "tue", "wed", "thu", "fri"], start="09:00", end="17:00")],
                     price_items=[PriceItem(item_id="visit", title="Service visit", unit_cents=9_500)],
                     calendar_slots=[], people=[], documents=[],
                     notifications=NotificationDefaults(now=["approval"], briefing=["lead"])).model_dump(mode="json"),
}


@pytest.mark.requires("01c")
async def test_a_new_desk_has_no_payments_tools(k: KernelHarness, records):
    """A Desk the owner adds with `POST /desks` starts with no `payments.*` tool, until its owner
    connects the payments server: its tool rows hold none, the owner's `/context` on it holds none,
    and a visitor's call to one is refused before it is normalized, with nothing to run. The copy's
    seeded Desk keeps both, pinned and on."""
    desk = await golden_desk(k)
    created = await k.call("POST /desks", body=NEW_DESK, auth=desk.owner,
                           expect=Expect(fields={"desk_id": {"$not": desk.desk_id}}))
    owner = desk.copy.owner_session.session_id
    context = await k.call("GET /context/{session_id}?desk_id=", path={"session_id": owner},
                           query={"desk_id": created.desk_id}, auth=desk.owner)
    opened = await k.call("POST /sessions", body={"desk_slug": created.slug, "kind": "visitor"}, auth=Auth.none(),
                          expect=Expect(fields={"state.kind": "visitor", "state.verified": False}))
    visitor = Caller("visitor", opened.state, Auth.session(opened))
    for tool in PAYMENTS:
        args = refund_args("ch_any") if tool == REFUND else {}
        refused = await decide(k, visitor, tool, args, expect=UNNORMALIZED)
        await execute(k, visitor, refused, expect=CONFLICT)   # a refusal has nothing to run

    if k.is_real:
        rows = await records.tools(desk.copy.copy_id)
        new = {row["tool"] for row in rows if row["desk_id"] == created.desk_id}
        assert not new & set(PAYMENTS), f"the new Desk has {sorted(new & set(PAYMENTS))} before its owner connects"
        seeded = {row["tool"]: row["status"] for row in rows if row["desk_id"] == desk.desk_id}
        assert all(seeded.get(tool) == "enabled" for tool in PAYMENTS), f"the seeded Desk's payments tools: {seeded}"
        listed = {profile.tool for profile in (*context.tools, *context.tools_declared)}
        assert not listed & set(PAYMENTS), f"the owner's context on the new Desk holds {sorted(listed & set(PAYMENTS))}"


# A refund the owner approves after its tool changed

@pytest.mark.requires("01c")
async def test_an_approved_refund_is_refused_after_a_drift(k: KernelHarness, records):
    """A refund the owner approves after its tool's definition changed doesn't run. Dana's refund
    of her own charge is held for the owner, as the seed's rules say; a simulated change to refunds
    then turns the tool off, and the owner's allow_once closes the held refund
    `refused_at_execution` without running it, since its execution re-check finds the tool no longer
    enabled. The store still holds her charge unrefunded."""
    desk = await golden_desk(k)
    dana = await open_caller(k, desk, "dana")
    charge = desk.charges["dana-250"]
    held = await decide(k, dana, REFUND, refund_args(charge), expect=Expect(fields={
        "outcome": "hold", "state": "held", "action.tool": REFUND, "action.amount_cents": DANA_250,
        "answers": {"$has": "allow_once"},
    }))
    await simulate_change(k, records, desk, REFUND)
    await answer(k, desk, held, "allow_once", expect=not_run(held, "refused_at_execution"))
    await read(k, desk.owner, held, "refused_at_execution")

    if k.is_real:
        stored = (await stored_charges(k, desk, [charge]))[charge]
        assert stored["refunded_cents"] == 0, f"Dana's charge was refunded {stored['refunded_cents']} cents"


# A mandate charge settled by `void` before its late call lands

@pytest.mark.requires("01c")
async def test_mandate_timeout_settled_by_void_never_charges(k: KernelHarness, records):
    """A mandate charge whose provider answers too late is `unknown`, its $20 held. A read at once,
    before the late call lands, settles the charge's idempotency key at the provider: voided, so the
    action is `failed` and the $20 released. The late call then lands on the voided key and is
    refused, so the copy's store gains no charge. A new $20 charge then goes ahead, and the mandate
    counts exactly that one."""
    desk = await golden_desk(k)
    store = await store_before(k, desk)
    agent = await open_caller(k, desk, "agent")
    decided = await decide_spend(k, desk, agent, CHARGE, expect=spent(CHARGE, "allow"))
    assert decided.action is not None
    await provider_delay(k, desk, "charge")
    await execute(k, agent, decided, expect=Expect(fields={
        "action_id": decided.action.action_id, "state": "unknown", "facts": [], "model_view": {}}))
    await read(k, desk.owner, decided, "failed")   # settled at the provider by its key, before the call lands
    await let_the_delayed_call_land(k)
    if k.is_real:
        await assert_spend(records, desk, agent, committed=0, reserved=0)
        await assert_charged(k, records, desk, agent, 0, store)
        await k.mockpay.delay(desk.copy.copy_id, "charge", 0)
    await mandate_charge(k, desk, agent)

    if k.is_real:
        await assert_spend(records, desk, agent, committed=DEPOSIT_CENTS, reserved=0)
        await assert_charged(k, records, desk, agent, 1, store)


# An agent's turn: a nonce after an immediate handoff, and an opening request resent

@pytest.mark.requires("01c")
async def test_nonce_resent_after_an_immediate_handoff_is_replayed(k: KernelHarness, records):
    """A turn that ends in an immediate handoff spends its nonce, as a passing verdict does: after a
    reply in a language the Desk doesn't speak hands the agent's turn off, the same nonce, session
    and body are 409 `replayed` on `GET /whoami` and on `/decide`, ledgered `agent_auth`, decide
    nothing, and no entry holds a signature or the agent's key."""
    desk = await golden_desk(k)
    issued, agent = await demo_agent(k, desk)
    session_id = agent.state.session_id
    agent.turn()
    await whoami(k, agent.auth, session_id, expect=whoami_as(session_id))   # binds the turn's nonce
    await check_reply(k, agent, FRENCH_PROSE, expect=handed_off(agent, "unsupported_language"))
    before = await decision_ids(records, desk) if k.is_real else set()
    async with assert_ledgered(records, desk.copy, desk.desk_id, "agent_auth", session_id=session_id) as new:
        await whoami(k, agent.auth, session_id, expect=REPLAYED)
        await k.call("POST /decide", body=decide_body(agent, find_slots()), auth=agent.auth, expect=REPLAYED)
    assert_hold_none(new, agent_secrets(issued, agent.auth))

    if k.is_real:
        assert await decision_ids(records, desk) == before, "a nonce resent after a handoff decided"


@pytest.mark.requires("01c")
async def test_resent_opening_request_returns_its_session(k: KernelHarness, records):
    """An agent's opening request resent after its turn has ended (the API lost the answer and sends
    it again) returns the session it opened, not a new one, and spends no mandate again: the copy
    holds one session and one mandate for the agent's key. The opening turn did end: its nonce is
    409 `replayed` on `GET /whoami`."""
    desk = await golden_desk(k)
    issued = await k.call("POST /agents/demo", body={"desk_id": desk.desk_id}, auth=desk.owner)
    auth = Auth.agent(issued, desk.slug, k.clock)
    body: dict[str, Any] = {"desk_slug": desk.slug, "kind": "agent", "mandate": issued.mandate.model_dump(mode="json")}
    created = await k.call("POST /sessions", body=body, auth=auth,
                           expect=Expect(fields={"state.kind": "agent", "session_token": None}))
    session_id = created.state.session_id
    agent = Caller("agent", created.state, auth)
    await check_reply(k, agent, CLEAN_EN, expect=passes(agent, ["prose"]))   # a passing verdict ends the turn
    await whoami(k, auth, session_id, expect=REPLAYED)
    k.clock.advance(30)
    resent = await k.call("POST /sessions", body=body, auth=auth, expect=Expect(fields={
        "state.session_id": session_id, "state.kind": "agent", "session_token": None}))

    if k.is_real:
        assert resent == created, "the resent opening request answered something other than the session it opened"
        sessions = [row for row in await records.sessions(desk.copy.copy_id)
                    if row["agent_key_id"] == issued.agent_key_id]
        assert [row["session_id"] for row in sessions] == [session_id], f"the agent's key has {len(sessions)} sessions"
        mandates = [row for row in await records.mandates(desk.copy.copy_id)
                    if row["agent_key_id"] == issued.agent_key_id]
        assert len(mandates) == 1, f"the agent's key has {len(mandates)} mandates"


# A minted agent's verification codes

@pytest.mark.requires("01c")
async def test_a_minted_agents_codes_reach_the_minters_demo_inbox(k: KernelHarness, records):
    """The code a minted demo agent's verification sends goes to the Demo inbox of the session that
    minted it, as if that session had typed the contact itself, and to no other visitor's: a visitor
    mints an agent, the agent starts Dana's verification on its own signed turn, the minter's inbox
    holds the code, another visitor's holds nothing, and the agent's check with that code verifies
    its session as Dana."""
    desk = await golden_desk(k)
    minter = await open_caller(k, desk, "visitor")
    other = await open_caller(k, desk, "visitor")
    issued = await k.call("POST /agents/demo", body={"desk_id": desk.desk_id}, auth=minter.auth)
    auth = Auth.agent(issued, desk.slug, k.clock)
    created = await k.call("POST /sessions", auth=auth,
                           body={"desk_slug": desk.slug, "kind": "agent",
                                 "mandate": issued.mandate.model_dump(mode="json")},
                           expect=Expect(fields={"state.kind": "agent", "session_token": None}))
    agent = Caller("agent", created.state, auth)
    agent.turn()
    await k.call("POST /verify/start", body={"session_id": agent.state.session_id, "contact": CONTACTS["dana"]},
                 auth=agent.auth)
    inbox = await k.call("GET /demo_inbox?session_id=", query={"session_id": minter.state.session_id},
                         auth=minter.auth, expect=Expect(fields={"0.kind": "verification_code"}))
    theirs = await k.call("GET /demo_inbox?session_id=", query={"session_id": other.state.session_id},
                          auth=other.auth)
    code = code_from_inbox(inbox) if k.is_real else STUB_CODE
    await k.call("POST /verify/check", auth=agent.auth, body={"session_id": agent.state.session_id, "code": code},
                 expect=Expect(fields={"session_id": agent.state.session_id, "kind": "agent", "verified": True,
                                       "assurance": "demo_code"}))

    if k.is_real:
        codes = [entry for entry in inbox if entry.kind == "verification_code"]
        assert len(codes) == 1, f"the minter's Demo inbox holds {len(codes)} codes, not the agent's one"
        assert theirs == [], f"another visitor's Demo inbox holds {len(theirs)} entries"
        [row] = [row for row in await records.sessions(desk.copy.copy_id)
                 if row["session_id"] == agent.state.session_id]
        assert row["person_id"] == desk.people["dana"], "the agent's session isn't verified as Dana"


# Setup probes (Plan 01c's setup tools)

def probe(tool: str, args: dict[str, Any] | None = None, *, resource_kind: str = "desk") -> dict[str, Any]:
    """A stranger's hypothetical call to `tool`, as setup probes one."""
    return {"actor": "visitor", "who": "anyone", "resource_kind": resource_kind,
            "call": {"call_id": "probe", "tool": tool, "args": args or {}}}


REFUSED_PROBE = {"outcome": "refuse", "card_ids": [], "depends_on_review": False}


@pytest.mark.requires("01c-setup")
async def test_unknown_tool_and_amountless_money_probes_refuse(k: KernelHarness, records):
    """A setup probe of a tool no Desk has, or of a payment with no amount, is refused, and says why
    in the owner's words; neither depends on the reviewer. Probing decides, approves and runs
    nothing: the Desk's decisions are as they were."""
    desk = await golden_desk(k)
    version = await active_version(k, desk)
    before = await decision_ids(records, desk) if k.is_real else set()
    unknown, unpriced = probe("admin.export_customers", {"all": True}), probe(LINK, resource_kind="quote")
    results = await k.call("POST /policy/{version}/probe", path={"version": version},
                           body={"desk_id": desk.desk_id, "probes": [unknown, unpriced]}, auth=desk.owner,
                           expect=Expect(fields={**{f"0.{key}": value for key, value in REFUSED_PROBE.items()},
                                                 **{f"1.{key}": value for key, value in REFUSED_PROBE.items()},
                                                 "0.probe.call.tool": "admin.export_customers",
                                                 "1.probe.call.tool": LINK}))

    if k.is_real:
        assert results[0].reason_plain.endswith("This Desk has no tool for that."), results[0].reason_plain
        assert results[1].reason_plain.endswith("A payment always names an amount."), results[1].reason_plain
        assert await decision_ids(records, desk) == before, "a probe stored a decision"
