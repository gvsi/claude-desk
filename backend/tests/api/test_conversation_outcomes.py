"""List outcomes: an agent's come from stored decisions and shown, checked cards; a visitor's from the kernel's
decisions, payment links and handoffs, timed by the ledger. Never request text."""

from datetime import timedelta

import pytest

from desk.api.deliver import Reply, Status, deliver
from desk.api.metrics import TurnMetric
from desk.api.sse import append_metric, emit
from desk.api.store import Ids, NOTES, append_message
from desk.contracts import Decision, RenderedBlock, ReplyVerdict
from desk.events import EvTurnEnd
from tests.api.test_owner_reads import app, model, scene, local, stamp  # noqa: F401 (shared fixtures)
from tests.kernel_contract.fake_kernel import signed_time


async def record(scene, ids, at, *, state="executed", tool="native.book", card="booking_confirmed",
                 author="claude", receipt=True, created_at=None, outcome=None, action=None, policy_ids=()):
    """A decision of the session's in `state`, its receipt and its card. With `action` (the action's fields), the
    kernel's action row too and the `decide` entry naming it, as the kernel ledgers one; a refusal at decide then stays
    on that entry, with its deciding `policy_ids`."""
    fake, owner = scene.fake, scene.owner
    fake.now = at
    decision_id = f"outcome-{at.timestamp()}-{tool}"
    outcome = outcome or ("refuse" if state == "refused" else "hold" if state == "held" else "allow")
    desk = fake.desks[owner.desk_id]
    if action is not None:
        action_id = f"action-{decision_id}"
        fake._put("actions", (action_id,), {
            "action_id": action_id, "copy_id": ids.copy_id, "desk_id": ids.desk_id, "session_id": ids.session_id,
            "generation": 0, "tool": tool, "effects": [], "resource_kind": "desk", "list_cents": None,
            "discount_bp": None, "amount_cents": None, "recipient": None, "starts_at": None, "created_at": at,
            **action})
        entry = fake.append(desk, "decide", {"decision_id": decision_id, "action_id": action_id, "tool": tool,
                                             "outcome": outcome, "card_ids": [], "policy_version": 1},
                            session_id=ids.session_id, ref_id=decision_id)
    if action is None or state != "refused":
        entry = fake.append(desk, "execute", {"decision_id": decision_id, "state": state},
                            session_id=ids.session_id, ref_id=decision_id)
    fake._put("decisions", (decision_id,), {
        "decision_id": decision_id, "copy_id": ids.copy_id, "desk_id": ids.desk_id,
        "session_id": ids.session_id, "tool": tool, "effects": [], "outcome": outcome, "state": state,
        "answers": [], "policy_version": 1, "card_ids": [], "review": None, "reason_plain": "Recorded result",
        "visitor_plain": "Checked", "expires_at": at + timedelta(hours=1), "ledger_seq": entry.seq,
        "created_at": created_at or at, "policy_ids": list(policy_ids)})
    fake.flush()
    decision = Decision(decision_id=decision_id, session_id=ids.session_id, call_id=decision_id, action=None,
                        outcome=outcome, state=state, policy_version=1, policy_ids=list(policy_ids), card_ids=[],
                        reason_plain="Recorded result", visitor_plain="Checked", expires_at=at + timedelta(hours=1),
                        ledger_seq=entry.seq, signature="fake:outcome")
    async with scene.engine.connect() as conn:
        if receipt:
            await deliver(conn, ids, Status(decision, "held" if state == "held" else "receipt"))
        if card:
            verdict = ReplyVerdict(ok=True, language="en", blocks=[RenderedBlock(kind="card", template=card, text="Checked card")],
                                   violations=[], message_id=decision_id, generation=0, visitor_plain="Checked",
                                   ledger_seq=entry.seq, signature="fake:outcome")
            await deliver(conn, ids, Reply(verdict, author, "kernel" if author == "desk" else "api"),
                          ro_schema="fake_kernel_ro")
        await conn.commit()
    scene.admin.execute("UPDATE app.messages SET created_at = %s WHERE session_id = %s AND created_at > %s",
                        (at, ids.session_id, at))
    return decision


@pytest.mark.parametrize("boundary", [
    "agent_text", "visitor_text", "whisper", "action_update", "note", "turn_end", "turn", "ended_agent_text",
])
async def test_agent_outcome_does_not_reuse_receipts_across_turns(scene, boundary):
    at = local(2026, 10, 30, 9)
    fake, owner = scene.fake, scene.owner
    fake.now = at
    session, _ = fake._new_session(owner.copy_id, owner.desk_id, "agent")
    fake.flush()
    ids = Ids(copy_id=owner.copy_id, desk_id=owner.desk_id, session_id=session.session_id)
    booking = await record(scene, ids, at, card=None)
    async with scene.engine.connect() as conn:
        if boundary in {"turn_end", "ended_agent_text"}:
            await emit(conn, ids, EvTurnEnd(type="turn_end"))
        elif boundary == "turn":
            await append_metric(conn, ids, TurnMetric(turn_id="unfinished-reply", model_calls=1, tool_calls=1,
                                                     decide_ms=0, execute_ms=0, total_ms=0, outcome="internal"))
        if boundary not in {"turn_end", "turn"}:
            kind = "agent_text" if boundary == "ended_agent_text" else boundary
            extra = {"state": "executed", "ref_id": booking.decision_id} if kind == "action_update" else {}
            await append_message(conn, ids, kind, text=NOTES["verified"] if kind == "note" else "New request",
                                 wake=True, **extra)
        verdict = ReplyVerdict(ok=True, language="en",
                               blocks=[RenderedBlock(kind="card", template="booking_confirmed", text="Checked card")],
                               violations=[], message_id="later-card", generation=0, visitor_plain="Checked",
                               ledger_seq=booking.ledger_seq, signature="fake:outcome")
        await deliver(conn, ids, Reply(verdict, "claude", "api"), ro_schema="fake_kernel_ro")
        await conn.commit()
    result = await owner.get(f"desks/{owner.desk_id}/conversations")
    assert result.status_code == 200, result.text
    summary = next(row for row in result.json() if row["session_id"] == session.session_id)
    assert summary["latest_outcome"] is None


@pytest.mark.parametrize("reverse_publication", [False, True])
@pytest.mark.parametrize("newer_refusal", [False, True])
async def test_agent_outcome_uses_ledger_order_not_receipt_publication(scene, reverse_publication, newer_refusal):
    at = local(2026, 10, 30, 9)
    fake, owner = scene.fake, scene.owner
    fake.now = at
    session, _ = fake._new_session(owner.copy_id, owner.desk_id, "agent")
    fake.flush()
    ids = Ids(copy_id=owner.copy_id, desk_id=owner.desk_id, session_id=session.session_id)
    states = ["executed", "refused"] if newer_refusal else ["refused", "executed"]
    decisions = [await record(scene, ids, at, state=state,
                              tool="native.book" if state == "executed" else "native.quote",
                              card=None, receipt=False) for state in states]
    booking = next(d for d in decisions if d.state == "executed")
    verdict = ReplyVerdict(ok=True, language="en",
                           blocks=[RenderedBlock(kind="card", template="booking_confirmed", text="Checked card")],
                           violations=[], message_id=booking.decision_id, generation=0, visitor_plain="Checked",
                           ledger_seq=booking.ledger_seq, signature="fake:outcome")
    async with scene.engine.connect() as conn:
        await emit(conn, ids, EvTurnEnd(type="turn_end"))
        await append_message(conn, ids, "agent_text", text="Book a visit")
        for decision in reversed(decisions) if reverse_publication else decisions:
            await deliver(conn, ids, Status(decision, "receipt"))
        await deliver(conn, ids, Reply(verdict, "claude", "api"), ro_schema="fake_kernel_ro")
        await emit(conn, ids, EvTurnEnd(type="turn_end"))
        await conn.commit()
    result = await owner.get(f"desks/{owner.desk_id}/conversations")
    assert result.status_code == 200, result.text
    summary = next(row for row in result.json() if row["session_id"] == session.session_id)
    assert summary["latest_outcome"] == ("turned_down" if newer_refusal else "visit_booked")


@pytest.mark.parametrize("case,expected", [
    ("booking", "visit_booked"), ("charge", "deposit_paid"), ("payment", "deposit_paid"),
    ("refusal", "turned_down"), ("execution_refusal", "turned_down"),
    ("later_refusal", "turned_down"), ("same_time_refusal", "turned_down"), ("later_hold", None), ("resolved_hold", None), ("later_handoff", None),
    ("no_card", None), ("visitor", "visit_booked"), ("wrong_tool", None), ("no_receipt", None),
    ("claude_payment", None),
])
async def test_agent_latest_outcome(scene, case, expected):
    at = local(2026, 10, 30, 9)
    fake, owner = scene.fake, scene.owner
    fake.now = at
    session, _ = fake._new_session(owner.copy_id, owner.desk_id, "visitor" if case == "visitor" else "agent")
    fake.flush()
    ids = Ids(copy_id=owner.copy_id, desk_id=owner.desk_id, session_id=session.session_id)
    if case in {"refusal", "execution_refusal"}:
        await record(scene, ids, at, state="refused" if case == "refusal" else "refused_at_execution", card=None)
    else:
        await record(scene, ids, at,
                     tool="native.charge_mandate" if case == "charge" else "native.quote" if case == "wrong_tool" else "native.book",
                     card=None if case == "no_card" else "charge_confirmed" if case == "charge" else
                     "payment_confirmed" if case in {"payment", "claude_payment"} else "booking_confirmed",
                     author="desk" if case == "payment" else "claude", receipt=case not in {"no_receipt", "payment"})
    later = at + timedelta(minutes=1)
    if case == "later_refusal":
        # Refused at execution now, even though the decision was first created before the success.
        await record(scene, ids, later, state="refused_at_execution", card=None, created_at=at - timedelta(minutes=1))
    elif case == "same_time_refusal":
        await record(scene, ids, at, state="refused", tool="native.quote", card=None)
    elif case == "later_hold":
        await record(scene, ids, later, state="held", card=None)
    elif case == "resolved_hold":
        await record(scene, ids, later, tool="native.quote", card=None, outcome="hold")
    elif case == "later_handoff":
        await record(scene, ids, later, tool="native.quote", card="handoff")
    result = await owner.get(f"desks/{owner.desk_id}/conversations")
    assert result.status_code == 200, result.text
    summary = next(row for row in result.json() if row["session_id"] == session.session_id)
    assert summary["latest_outcome"] == expected


FACTS = ("latest_outcome", "latest_outcome_starts_at", "latest_outcome_cents", "latest_outcome_cause")


async def agent(scene, at):
    """A visiting agent's session on the Desk, opened at `at`."""
    fake, owner = scene.fake, scene.owner
    fake.now = at
    session, _ = fake._new_session(owner.copy_id, owner.desk_id, "agent")
    fake.flush()
    return Ids(copy_id=owner.copy_id, desk_id=owner.desk_id, session_id=session.session_id)


async def facts(scene, ids) -> tuple:
    """The session's outcome and the facts behind it, as the owner's list gives them."""
    result = await scene.owner.get(f"desks/{scene.owner.desk_id}/conversations")
    assert result.status_code == 200, result.text
    summary = next(row for row in result.json() if row["session_id"] == ids.session_id)
    return tuple(summary[key] for key in FACTS)


async def test_agent_booking_carries_its_start(scene):
    at = local(2026, 10, 30, 9)
    ids = await agent(scene, at)
    starts = local(2026, 11, 2, 10)
    await record(scene, ids, at, action={"resource_kind": "slot", "starts_at": starts})
    assert await facts(scene, ids) == ("visit_booked", stamp(starts), None, None)


async def test_agent_charge_carries_its_amount(scene):
    at = local(2026, 10, 30, 9)
    ids = await agent(scene, at)
    await record(scene, ids, at, tool="native.charge_mandate", card="charge_confirmed",
                 action={"resource_kind": "quote", "amount_cents": 2000})
    assert await facts(scene, ids) == ("deposit_paid", None, 2000, None)


@pytest.mark.parametrize("mismatch", ["session", "tool"])
@pytest.mark.parametrize("tool,card,outcome", [
    ("native.book", "booking_confirmed", "visit_booked"),
    ("native.charge_mandate", "charge_confirmed", "deposit_paid"),
])
async def test_agent_outcome_drops_mismatched_action_facts(scene, mismatch, tool, card, outcome):
    at = local(2026, 10, 30, 9)
    ids = await agent(scene, at)
    action = {"resource_kind": "slot", "starts_at": local(2026, 11, 2, 10), "amount_cents": 2000}
    if mismatch == "session":
        other = await agent(scene, at)
        action["session_id"] = other.session_id
    else:
        action["tool"] = "native.quote"
    # The decision and its decide entry belong to this agent; the referenced action doesn't match.
    await record(scene, ids, at, tool=tool, card=card, action=action)
    assert await facts(scene, ids) == (outcome, None, None, None)


async def confirm_payment(scene, ids, at, cents, *, confirmed=True, refused_retry_link=None) -> str:
    """One of the agent's payment links paid at `at`, its move to `paid` ledgered as the kernel ledgers one, then, when
    `confirmed`, the Desk's own payment confirmation, ledgered after it. Optionally ledger a refused retry of an
    older link just before that confirmation. Return the paid link's ID."""
    fake, owner = scene.fake, scene.owner
    fake.now = at
    desk = fake.desks[owner.desk_id]
    link_id = f"link-{at.timestamp()}"
    fake._put("payment_links", (link_id,), {
        "link_id": link_id, "copy_id": ids.copy_id, "desk_id": ids.desk_id, "session_id": ids.session_id,
        "quote_id": None, "action_id": None, "amount_cents": cents, "state": "paid",
        "expires_at": at + timedelta(hours=1)})
    fake.append(desk, "payment", {"link_id": link_id, "state": "paid", "charge_id": f"charge-{link_id}"},
                session_id=ids.session_id, ref_id=link_id)
    fake.flush()
    if not confirmed:
        return link_id
    if refused_retry_link is not None:
        fake.append(desk, "payment", {"link_id": refused_retry_link, "state": "paid", "refused": True},
                    session_id=ids.session_id, ref_id=refused_retry_link)
    reply = fake.append(desk, "reply", {"message_id": f"confirm-{link_id}", "author": "desk", "ok": True},
                        session_id=ids.session_id, ref_id=f"confirm-{link_id}")
    fake.flush()
    verdict = ReplyVerdict(ok=True, language="en",
                           blocks=[RenderedBlock(kind="card", template="payment_confirmed", text="Checked card")],
                           violations=[], message_id=f"confirm-{link_id}", generation=0, visitor_plain="Checked",
                           ledger_seq=reply.seq, signature="fake:outcome")
    async with scene.engine.connect() as conn:
        await deliver(conn, ids, Reply(verdict, "desk", "kernel"), ro_schema="fake_kernel_ro")
        await conn.commit()

    return link_id


async def test_agent_payment_confirmation_carries_its_own_links_amount(scene):
    at = local(2026, 10, 30, 9)
    ids = await agent(scene, at)
    await confirm_payment(scene, ids, at, 18000)
    await confirm_payment(scene, ids, at + timedelta(minutes=1), 2000)
    # A link paid after the newest confirmation, with no confirmation of its own, isn't the one it confirmed.
    await confirm_payment(scene, ids, at + timedelta(minutes=2), 5000, confirmed=False)
    assert await facts(scene, ids) == ("deposit_paid", None, 2000, None)


@pytest.mark.parametrize("state", ["cancelled", "expired"])
async def test_agent_payment_confirmation_drops_unpaid_link_amount(scene, state):
    at = local(2026, 10, 30, 9)
    ids = await agent(scene, at)
    link_id = await confirm_payment(scene, ids, at, 2000)
    scene.admin.execute("UPDATE fake_kernel_ro.payment_links SET state = %s WHERE link_id = %s", (state, link_id))
    assert await facts(scene, ids) == ("deposit_paid", None, None, None)


@pytest.mark.parametrize("older_cents", [5000, 18000])
async def test_agent_payment_confirmation_ignores_refused_retry(scene, older_cents):
    at = local(2026, 10, 30, 9)
    ids = await agent(scene, at)
    older_link = await confirm_payment(scene, ids, at, older_cents)
    # The older link's refused retry is the last payment entry before the newer confirmation.
    await confirm_payment(scene, ids, at + timedelta(minutes=1), 2000, refused_retry_link=older_link)
    assert await facts(scene, ids) == ("deposit_paid", None, 2000, None)


@pytest.mark.parametrize("policy_ids,cause", [
    (["B.agent_charge_within_mandate"], "agent_limit"),
    (["F.never.rv-refunds"], "owner_rule"),
    ([], "no_rule"),
])
async def test_agent_refusal_carries_its_cause(scene, policy_ids, cause):
    at = local(2026, 10, 30, 9)
    ids = await agent(scene, at)
    await record(scene, ids, at, state="refused", tool="native.charge_mandate", card=None, receipt=False,
                 action={"resource_kind": "quote", "amount_cents": 18500}, policy_ids=policy_ids)
    assert await facts(scene, ids) == ("turned_down", None, None, cause)


async def test_agent_refusal_at_execution_has_no_cause(scene):
    at = local(2026, 10, 30, 9)
    ids = await agent(scene, at)
    await record(scene, ids, at, state="refused_at_execution", tool="native.charge_mandate", card=None, receipt=False,
                 action={"resource_kind": "quote", "amount_cents": 18500},
                 policy_ids=["B.agent_charge_within_mandate"])
    assert await facts(scene, ids) == ("turned_down", None, None, None)


@pytest.mark.parametrize("later", ["hold", "handoff"])
async def test_agent_later_hold_or_handoff_clears_the_outcome_and_its_facts(scene, later):
    at = local(2026, 10, 30, 9)
    ids = await agent(scene, at)
    starts = local(2026, 11, 2, 10)
    await record(scene, ids, at, action={"resource_kind": "slot", "starts_at": starts})
    assert await facts(scene, ids) == ("visit_booked", stamp(starts), None, None)
    if later == "hold":
        await record(scene, ids, at + timedelta(minutes=1), state="held", tool="native.quote", card=None,
                     action={"resource_kind": "quote", "amount_cents": 18000})
    else:
        await record(scene, ids, at + timedelta(minutes=1), tool="native.quote", card="handoff")
    assert await facts(scene, ids) == (None, None, None, None)


@pytest.mark.parametrize("preview", [False, True])
async def test_visitor_and_preview_outcomes_carry_no_agent_facts(scene, preview):
    at = local(2026, 10, 30, 9)
    who = await scene.visitor(at, preview=preview)
    await record(scene, who.ids, at, action={"resource_kind": "slot", "starts_at": local(2026, 11, 2, 10)})
    assert await facts(scene, who.ids) == (None if preview else "visit_booked", None, None, None)


# Visitors -----------------------------------------------------------------------------------------------------


def entry(scene, ids, at, kind, summary, *, on_session=True, recorded_at=None) -> int:
    """A ledger entry on the Desk written at `at`, on the visitor's session unless `on_session` is false; replayed
    into the copy with `recorded_at` as its recorded time when given, as recorded history is. Returns its seq."""
    fake = scene.fake
    fake.now = at
    if recorded_at is not None:
        summary = {**summary, "replayed": {"at": signed_time(recorded_at), "recording": "a recorded night"}}
    written = fake.append(fake.desks[ids.desk_id], kind, summary, session_id=ids.session_id if on_session else None)
    fake.flush()
    return written.seq


def decided(scene, ids, at, tool, state, *, written_at=None) -> str:
    """A visitor's decision now in `state`, its current ledger entry at `at` (or written at `written_at` and replayed
    with `at` as its recorded time, the decision row stamped at the recorded time too). Returns its ID."""
    seq = entry(scene, ids, written_at or at, "execute", {"state": state}, recorded_at=at if written_at else None)
    decision_id = f"visitor-decision-{seq}"
    scene.fake._put("decisions", (decision_id,), {
        "decision_id": decision_id, "copy_id": ids.copy_id, "desk_id": ids.desk_id, "session_id": ids.session_id,
        "tool": tool, "effects": [], "outcome": "refuse" if state.startswith("refused") else
        "hold" if state in {"held", "denied", "expired"} else "allow", "state": state, "answers": [],
        "policy_version": 1, "card_ids": [], "review": None, "reason_plain": "Recorded result",
        "visitor_plain": "Checked", "expires_at": at + timedelta(hours=1), "ledger_seq": seq, "created_at": at,
        "policy_ids": []})
    scene.fake.flush()
    return decision_id


async def visitor_outcome(scene, who) -> str | None:
    result = await scene.owner.get(f"desks/{scene.owner.desk_id}/conversations")
    assert result.status_code == 200, result.text
    return next(row for row in result.json() if row["session_id"] == who.session_id)["latest_outcome"]


@pytest.mark.parametrize("tool,state,expected", [
    ("native.quote", "executed", "quoted"),
    ("native.book", "executed", "visit_booked"),
    ("native.capture_lead", "executed", "lead_captured"),
    ("native.release_document", "executed", "document_sent"),
    ("native.release_document", "refused", "turned_down"),
    ("native.book", "refused_at_execution", "turned_down"),
    ("native.quote", "denied", "owner_declined"),
    ("native.request_callback", "executed", None),
    ("native.payment_link", "executed", None),
    ("native.quote", "held", None), ("native.quote", "allowed", None), ("native.book", "failed", None),
])
async def test_visitor_latest_outcome_from_a_decision(scene, tool, state, expected):
    at = local(2026, 10, 30, 9)
    who = await scene.visitor(at)
    decided(scene, who.ids, at, tool, state)
    assert await visitor_outcome(scene, who) == expected


def paid_link(scene, ids, at, *, refused_first=False) -> None:
    """A payment link of the visitor's that moved to `paid` at `at`, ledgered as the kernel ledgers the move (after a
    refused retry, ledgered with the link's state too, a minute earlier, when `refused_first`)."""
    link_id = f"link-{at.timestamp()}"
    scene.fake._put("payment_links", (link_id,), {
        "link_id": link_id, "copy_id": ids.copy_id, "desk_id": ids.desk_id, "session_id": ids.session_id,
        "quote_id": None, "action_id": None, "amount_cents": 18000, "state": "paid",
        "expires_at": at + timedelta(hours=1)})
    if refused_first:
        entry(scene, ids, at - timedelta(minutes=1), "payment", {"link_id": link_id, "state": "paid", "refused": True})
    entry(scene, ids, at, "payment", {"link_id": link_id, "state": "paid"})


@pytest.mark.parametrize("refused_first", [False, True])
async def test_visitor_paid_link_is_deposit_paid(scene, refused_first):
    at = local(2026, 10, 30, 9)
    who = await scene.visitor(at)
    decided(scene, who.ids, at, "native.payment_link", "executed")
    paid_link(scene, who.ids, at + timedelta(minutes=5), refused_first=refused_first)
    assert await visitor_outcome(scene, who) == "deposit_paid"


async def test_visitor_newest_outcome_wins(scene):
    at = local(2026, 10, 30, 9)
    who = await scene.visitor(at)
    decided(scene, who.ids, at, "native.quote", "executed")
    assert await visitor_outcome(scene, who) == "quoted"
    decided(scene, who.ids, at + timedelta(minutes=1), "native.book", "executed")
    assert await visitor_outcome(scene, who) == "visit_booked"
    paid_link(scene, who.ids, at + timedelta(minutes=2))
    assert await visitor_outcome(scene, who) == "deposit_paid"
    decided(scene, who.ids, at + timedelta(minutes=3), "native.request_callback", "executed")
    assert await visitor_outcome(scene, who) == "deposit_paid"         # a call-back request is no outcome


async def test_visitor_ties_go_to_the_later_ledger_entry(scene):
    at = local(2026, 10, 30, 9)
    who = await scene.visitor(at)
    decided(scene, who.ids, at, "native.book", "executed")
    decided(scene, who.ids, at, "native.quote", "refused")
    assert await visitor_outcome(scene, who) == "turned_down"


@pytest.mark.parametrize("state", ["held", "expired", "cancelled"])
async def test_visitor_later_unresolved_request_clears_the_outcome(scene, state):
    at = local(2026, 10, 30, 9)
    who = await scene.visitor(at)
    decided(scene, who.ids, at, "native.book", "executed")
    decided(scene, who.ids, at + timedelta(minutes=1), "native.quote", state)
    assert await visitor_outcome(scene, who) is None


async def test_visitor_later_handoff_card_clears_the_outcome(scene):
    at = local(2026, 10, 30, 9)
    who = await scene.visitor(at)
    decided(scene, who.ids, at, "native.book", "executed")
    entry(scene, who.ids, at + timedelta(minutes=1), "desk_data",
          {"part": "handoffs", "refs": ["handoff-card"], "kind": "card"})
    assert await visitor_outcome(scene, who) is None


CALLBACK = {"name": "Sam Ortiz", "contact": "(510) 555-0199", "reason": "Leaking water heater"}


async def test_visitor_callback_marked_done_is_called_back(scene):
    at = local(2026, 10, 30, 9)
    who = await scene.visitor(at)
    await who.run("native.request_callback", CALLBACK)
    (handoff_id,) = [h for h, row in scene.fake.handoffs.items() if row["session_id"] == who.session_id]
    decided(scene, who.ids, at + timedelta(minutes=1), "native.quote", "executed")
    assert await visitor_outcome(scene, who) == "quoted"             # an open call-back is no outcome yet
    scene.fake.now = at + timedelta(minutes=2)
    done = await scene.owner.browser.post(f"/api/owner/handoffs/{handoff_id}/done")
    assert done.status_code == 200, done.text
    assert await visitor_outcome(scene, who) == "called_back"
    decided(scene, who.ids, at + timedelta(minutes=3), "native.book", "executed")
    assert await visitor_outcome(scene, who) == "visit_booked"


async def test_visitor_callback_replaced_by_a_newer_one_is_not_called_back(scene):
    at = local(2026, 10, 30, 9)
    who = await scene.visitor(at)
    decided(scene, who.ids, at, "native.quote", "executed")
    scene.fake.now = at + timedelta(minutes=1)
    await who.run("native.request_callback", CALLBACK)
    scene.fake.now = at + timedelta(minutes=2)
    await who.run("native.request_callback", CALLBACK)            # closes the first as done, replaced
    statuses = sorted(row["status"] for row in scene.fake.handoffs.values() if row["session_id"] == who.session_id)
    assert statuses == ["done", "open"]
    assert await visitor_outcome(scene, who) == "quoted"


async def test_visitor_callback_superseded_is_not_called_back(scene):
    """A call-back the one-open revision superseded (kernel_one_open_handoff) is `superseded`, never `done`, so it
    is no call-back the owner made, even once an entry on the ledger names it closed."""
    at = local(2026, 10, 30, 9)
    who = await scene.visitor(at)
    decided(scene, who.ids, at, "native.quote", "executed")
    scene.fake.now = at + timedelta(minutes=1)
    await who.run("native.request_callback", CALLBACK)
    (handoff_id,) = [h for h, row in scene.fake.handoffs.items() if row["session_id"] == who.session_id]
    scene.fake.handoffs[handoff_id]["status"] = "superseded"
    scene.fake._put("handoffs", (handoff_id,), dict(scene.fake.handoffs[handoff_id]))
    entry(scene, who.ids, at + timedelta(minutes=2), "desk_data", {"part": "handoffs", "refs": [handoff_id]})
    assert await visitor_outcome(scene, who) == "quoted"


async def test_visitor_outcome_follows_the_recorded_time_of_replayed_history(scene):
    at = local(2026, 10, 30, 9)
    who = await scene.visitor(at)
    # recorded at 9:00 but written into the copy at 9:30, after a live quote at 9:10
    decided(scene, who.ids, at, "native.book", "executed", written_at=at + timedelta(minutes=30))
    decided(scene, who.ids, at + timedelta(minutes=10), "native.quote", "executed")
    assert await visitor_outcome(scene, who) == "quoted"
    decided(scene, who.ids, at + timedelta(minutes=20), "native.capture_lead", "executed",
            written_at=at + timedelta(minutes=40))
    assert await visitor_outcome(scene, who) == "lead_captured"


async def test_owner_preview_has_no_outcome(scene):
    at = local(2026, 10, 30, 9)
    who = await scene.visitor(at, preview=True)
    decided(scene, who.ids, at, "native.book", "executed")
    assert await visitor_outcome(scene, who) is None


async def test_visitor_with_no_outcome_events_is_null(scene):
    at = local(2026, 10, 30, 9)
    who = await scene.visitor(at)
    await scene.text(who, at)
    assert await visitor_outcome(scene, who) is None
