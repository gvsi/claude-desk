"""Agent list outcomes come from stored decisions and shown, checked cards, never request text."""

from datetime import timedelta

import pytest

from desk.api.deliver import Reply, Status, deliver
from desk.api.store import Ids
from desk.contracts import Decision, RenderedBlock, ReplyVerdict
from tests.api.test_owner_reads import app, model, scene, local  # noqa: F401 (shared fixtures)


async def record(scene, ids, at, *, state="executed", tool="native.book", card="booking_confirmed",
                 author="claude", receipt=True, created_at=None, outcome=None):
    fake, owner = scene.fake, scene.owner
    fake.now = at
    decision_id = f"outcome-{at.timestamp()}-{tool}"
    entry = fake.append(fake.desks[owner.desk_id], "execute", {"decision_id": decision_id, "state": state},
                        session_id=ids.session_id, ref_id=decision_id)
    outcome = outcome or ("refuse" if state == "refused" else "hold" if state == "held" else "allow")
    fake._put("decisions", (decision_id,), {
        "decision_id": decision_id, "copy_id": ids.copy_id, "desk_id": ids.desk_id,
        "session_id": ids.session_id, "tool": tool, "effects": [], "outcome": outcome, "state": state,
        "answers": [], "policy_version": 1, "card_ids": [], "review": None, "reason_plain": "Recorded result",
        "visitor_plain": "Checked", "expires_at": at + timedelta(hours=1), "ledger_seq": entry.seq,
        "created_at": created_at or at, "policy_ids": []})
    fake.flush()
    decision = Decision(decision_id=decision_id, session_id=ids.session_id, call_id=decision_id, action=None,
                        outcome=outcome, state=state, policy_version=1, policy_ids=[], card_ids=[],
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
        for decision in reversed(decisions) if reverse_publication else decisions:
            await deliver(conn, ids, Status(decision, "receipt"))
        await deliver(conn, ids, Reply(verdict, "claude", "api"), ro_schema="fake_kernel_ro")
        await conn.commit()
    result = await owner.get(f"desks/{owner.desk_id}/conversations")
    assert result.status_code == 200, result.text
    summary = next(row for row in result.json() if row["session_id"] == session.session_id)
    assert summary["latest_outcome"] == ("turned_down" if newer_refusal else "visit_booked")


@pytest.mark.parametrize("case,expected", [
    ("booking", "visit_booked"), ("charge", "deposit_paid"), ("payment", "deposit_paid"),
    ("refusal", "turned_down"), ("execution_refusal", "turned_down"),
    ("later_refusal", "turned_down"), ("same_time_refusal", "turned_down"), ("later_hold", None), ("resolved_hold", None), ("later_handoff", None),
    ("no_card", None), ("visitor", None), ("wrong_tool", None), ("no_receipt", None),
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
