"""The handoff card opens a handoff the owner sees (the owner's decision of 2026-10-30).

The kernel's handoff card tells the visitor "Let me check with Maria Rivera. Maria Rivera will reply
here." When `/check_reply` answers with it, in place of a draft its checks blocked or because Claude's
own draft cited it, the kernel opens an owner handoff for the session in the verdict's transaction:
kind `card`, no call-back window, a reason the kernel writes, and an owner alert in the Demo inbox
naming only who is waiting. So the conversation lands in the owner's Needs you, and the card's
promise has something behind it. One handoff is open at a time per session (a call-back request
counts): a later card opens none and alerts nothing until the owner marks the open one done. An
owner's say never opens one. (While a handoff is open, the soft-promise check reads the card's
text as one of the reply's cards: test_soft_promise.py.)

Tests run on Rivera Plumbing copies as `POST /copies` seeds them (Friday 10:04 in Oakland), whose
notification defaults alert the owner of a handoff at once.
"""

import asyncio

import pytest
from fastapi import FastAPI
from sqlalchemy import select

from desk.contracts import DemoInboxEntry, ReplyVerdict, SessionCreated
from desk.db.models import DemoInboxEntry as DemoInboxRow
from desk.db.models import Fact, Handoff, LedgerEntry
from desk.kernel_service import ledger
from desk.kernel_service.decisions import SoftPromiseVerdict

from .helpers import ledger_rows, rows_of
from .test_adapters import Rivera, rivera, visitor_of
from .test_decide import Visitor, open_visitor, set_mode, set_session
from .test_lead_tools import callback, handoff_done
from .test_owner_messages import sent
from .test_release_document import DANA, confirmed
from .test_reply_check import assert_handed_off, checked, clause, post_check, reply_entries
from .test_verification import api_rows

CARD_REASON = "The Desk handed this to you."
PREVIEW = "A conversation was handed to you"
BLOCKED = "That will be $180."                                   # a number: the code check blocks it
BLOCKED_ES = "Le hago el cincuenta por ciento de descuento, con gusto."
CLEAN = "I can help with that."
FLAGGED = SoftPromiseVerdict(promises_beyond_cards=True, denies_being_ai=False)
HANDOFF_CARD = {"en": "Let me check with Maria Rivera.\nMaria Rivera will reply here.",
                "es": "Déjame consultarlo con Maria Rivera.\nMaria Rivera te responderá aquí."}


def waiting(who: str) -> str:
    """The alert's body: who is waiting, and nothing else of the conversation."""
    return f"{who} is waiting in a conversation the Desk handed to you."


async def handoffs_of(app: FastAPI, copy: Rivera) -> list[Handoff]:
    return await rows_of(app, copy.copy_id, select(Handoff))


async def handoff_alerts(app: FastAPI, copy: Rivera) -> list[DemoInboxRow]:
    """The owner's handoff alerts in the copy's Demo inbox, oldest first."""
    return await rows_of(app, copy.copy_id, select(DemoInboxRow).where(DemoInboxRow.preview == PREVIEW)
                         .order_by(DemoInboxRow.created_at, DemoInboxRow.entry_id))


def handoff_entries(entries: list[LedgerEntry]) -> list[tuple[str | None, dict]]:
    """The session and summary of each `desk_data` entry about handoffs, in order."""
    return [(entry.event.session_id, entry.event.summary) for entry in entries
            if entry.event.kind == "desk_data" and entry.event.summary.get("part") == "handoffs"]


@pytest.mark.parametrize(("prose", "soft_answer", "kind"), [
    (BLOCKED, None, "number_in_prose"),                           # blocked by the code check
    (CLEAN, FLAGGED, "soft_promise"),                             # blocked by the model check
], ids=["code-check", "model-check"])
async def test_a_blocked_draft_opens_one_handoff_and_alerts_the_owner(app, client, reviewer, prose, soft_answer,
                                                                      kind):
    copy, visitor = await visitor_of(app, client)
    if soft_answer is not None:
        reviewer.soft_answer = soft_answer
    verdict = await checked(client, visitor, prose)
    assert_handed_off(verdict)                                    # what the visitor sees is unchanged
    assert {violation.kind for violation in verdict.violations} == {kind}

    # one open handoff of the session's, from the card: no call-back window, a reason the kernel wrote,
    # and no action (its own id stands in, which no action's id can equal)
    [handoff] = await handoffs_of(app, copy)
    assert (handoff.desk_id, handoff.session_id, handoff.kind, handoff.status, handoff.reason) == (
        copy.desk_id, visitor.session_id, "card", "open", CARD_REASON)
    assert (handoff.callback_window, handoff.window_start, handoff.window_end) == (None, None, None)
    assert handoff.action_id == handoff.handoff_id and not handoff.action_id.startswith("act-")
    # the API reads it with its kind, so it can tell it from a call-back request that has no time
    assert api_rows(copy.copy_id, "SELECT handoff_id, session_id, reason, callback_window, status, kind"
                                  " FROM kernel_ro.handoffs") == [
        (handoff.handoff_id, visitor.session_id, CARD_REASON, None, "open", "card")]
    # it promises no call back, so it writes no fact for a card to cite
    assert await rows_of(app, copy.copy_id, select(Fact).where(Fact.kind == "handoff")) == []

    # one alert to the owner, from the kernel's template
    [alert] = await handoff_alerts(app, copy)
    assert (alert.to, alert.kind, alert.person_id, alert.decision_id, alert.challenge_id, alert.body) == (
        "owner", "alert", None, None, None, waiting("A visitor"))

    # ledgered in the verdict's transaction, as `desk_data` naming the handoff and its kind, just before the verdict
    *_, opened, reply = await ledger_rows(app, copy)
    assert (opened.event.kind, opened.event.origin, opened.event.session_id, opened.event.summary) == (
        "desk_data", "kernel", visitor.session_id, {"part": "handoffs", "refs": [handoff.handoff_id], "kind": "card"})
    assert (reply.event.kind, reply.seq, reply.event.ref_id) == ("reply", verdict.ledger_seq, verdict.message_id)


async def test_one_handoff_is_open_at_a_time_per_session(app, client, reviewer):
    copy, visitor = await visitor_of(app, client)
    assert_handed_off(await checked(client, visitor, BLOCKED))
    [first] = await handoffs_of(app, copy)
    entries = len(await ledger_rows(app, copy))

    # more blocked drafts in the same conversation: by the code check, by the model check, and a card
    # Claude drafts itself; the visitor sees each card, and the owner already has the conversation
    assert_handed_off(await checked(client, visitor, BLOCKED_ES), "es")
    reviewer.soft_answer = FLAGGED
    assert_handed_off(await checked(client, visitor, CLEAN))
    reviewer.soft_answer = None                                   # the check fails: it blocks too
    assert_handed_off(await checked(client, visitor, CLEAN))
    assert (await checked(client, visitor, "", [clause("handoff")])).ok
    assert [(row.handoff_id, row.status) for row in await handoffs_of(app, copy)] == [(first.handoff_id, "open")]
    assert len(await handoff_alerts(app, copy)) == 1                         # no repeat alert
    later = (await ledger_rows(app, copy))[entries:]
    assert handoff_entries(later) == [] and [entry.event.kind for entry in later] == ["reply"] * 4

    # another conversation on the Desk gets its own
    other = await open_visitor(client, copy)
    assert_handed_off(await checked(client, other, BLOCKED))
    opened = {row.session_id: (row.kind, row.status) for row in await handoffs_of(app, copy)}
    assert opened == {visitor.session_id: ("card", "open"), other.session_id: ("card", "open")}
    assert len(await handoff_alerts(app, copy)) == 2


@pytest.mark.parametrize(("prose", "blocks"), [
    ("", ["handoff"]),                                            # the API's own handoff: the clause alone
    (CLEAN, ["prose", "handoff"]),
], ids=["clause-alone", "with-prose"])
async def test_claudes_own_draft_citing_the_handoff_card_opens_one(app, client, prose, blocks):
    copy, visitor = await visitor_of(app, client)
    verdict = await checked(client, visitor, prose, [clause("handoff")])
    assert (verdict.ok, verdict.violations) == (True, [])
    assert [block.template or block.kind for block in verdict.blocks] == blocks
    assert verdict.visitor_plain == "Reply checked against Maria Rivera's rules"
    [handoff] = await handoffs_of(app, copy)
    assert (handoff.session_id, handoff.kind, handoff.status, handoff.callback_window) == (
        visitor.session_id, "card", "open", None)
    assert [alert.body for alert in await handoff_alerts(app, copy)] == [waiting("A visitor")]
    *_, opened, reply = await ledger_rows(app, copy)
    assert (opened.event.summary, reply.seq) == (
        {"part": "handoffs", "refs": [handoff.handoff_id], "kind": "card"}, verdict.ledger_seq)


async def test_an_open_call_back_request_is_the_sessions_handoff(app, client):
    """A session whose call-back request is open gets no second handoff from the card, and its
    owner no second alert: the call back already puts the conversation in Needs you."""
    copy, visitor = await visitor_of(app, client)
    requested = (await callback(client, visitor)).model_view["handoff_id"]
    assert_handed_off(await checked(client, visitor, BLOCKED))
    [handoff] = await handoffs_of(app, copy)
    assert (handoff.handoff_id, handoff.kind, handoff.status) == (requested, "callback", "open")
    assert handoff.callback_window is not None                    # it keeps its window and its fact
    assert api_rows(copy.copy_id, "SELECT handoff_id, kind FROM kernel_ro.handoffs") == [(requested, "callback")]
    assert await handoff_alerts(app, copy) == []
    assert handoff_entries(await ledger_rows(app, copy)) == []


async def test_after_the_owner_marks_it_done_the_next_card_opens_a_new_one(app, client):
    copy, visitor = await visitor_of(app, client)
    assert_handed_off(await checked(client, visitor, BLOCKED))
    [first] = await handoffs_of(app, copy)
    assert (await handoff_done(client, first.handoff_id, copy.owner)).status_code == 200
    assert_handed_off(await checked(client, visitor, BLOCKED))
    statuses = {row.handoff_id: (row.kind, row.status) for row in await handoffs_of(app, copy)}
    [second] = [handoff_id for handoff_id in statuses if handoff_id != first.handoff_id]
    assert statuses == {first.handoff_id: ("card", "done"), second: ("card", "open")}
    assert [alert.body for alert in await handoff_alerts(app, copy)] == [waiting("A visitor")] * 2
    # opened, marked done by the owner, opened again
    assert handoff_entries(await ledger_rows(app, copy)) == [
        (visitor.session_id, {"part": "handoffs", "refs": [first.handoff_id], "kind": "card"}),
        (None, {"part": "handoffs", "refs": [first.handoff_id]}),
        (visitor.session_id, {"part": "handoffs", "refs": [second], "kind": "card"})]

    # a call-back request marked done leaves the session without one too
    caller = await open_visitor(client, copy)
    requested = (await callback(client, caller)).model_view["handoff_id"]
    assert (await handoff_done(client, requested, copy.owner)).status_code == 200
    assert_handed_off(await checked(client, caller, BLOCKED))
    kinds = sorted((row.kind, row.status) for row in await handoffs_of(app, copy)
                   if row.session_id == caller.session_id)
    assert kinds == [("callback", "done"), ("card", "open")]


async def test_the_alert_names_only_who_is_waiting(app, client):
    """The alert holds neither the draft's prose nor anything the visitor typed, nor a contact: a
    verified person is named as the owner's records name them, anyone else is "A visitor". It
    names no decision."""
    copy = await rivera(app, client)
    dana = await confirmed(client, copy, DANA)
    prose = "Dana, I'll send the $180 invoice to dana@example.com tonight."
    assert_handed_off(await checked(client, dana, prose))
    stranger = await open_visitor(client, copy)
    assert_handed_off(await checked(client, stranger, "Sam, it's 50% off at (510) 555-0100."))
    alerts = await handoff_alerts(app, copy)                      # both at the same moment, on the frozen clock
    assert sorted(alert.body for alert in alerts) == [waiting("A visitor"), waiting("Dana Whitfield")]
    for alert in alerts:
        assert (alert.to, alert.decision_id) == ("owner", None)
        held = [text for text in ("dana@example.com", "d•••@example.com", "invoice", "$", "50", "Sam", "555")
                if text in alert.body]
        assert held == [], alert.body
    # the owner reads it as any other alert, with no decision to link to
    response = await client.get("/demo_inbox", headers=copy.owner)
    assert response.status_code == 200, response.text
    read = [DemoInboxEntry.model_validate(entry) for entry in response.json()]
    assert sorted(entry.body for entry in read if entry.body in {alert.body for alert in alerts}) == sorted(
        alert.body for alert in alerts)
    assert all(entry.decision_id is None for entry in read if entry.body in {alert.body for alert in alerts})
    # and the handoffs carry the kernel's reason alone
    assert {handoff.reason for handoff in await handoffs_of(app, copy)} == {CARD_REASON}


async def test_another_copys_owner_sees_neither_the_handoff_nor_the_alert(app, client):
    copy, visitor = await visitor_of(app, client)
    other = await rivera(app, client)
    assert_handed_off(await checked(client, visitor, BLOCKED))
    [handoff] = await handoffs_of(app, copy)
    [alert] = await handoff_alerts(app, copy)

    assert api_rows(other.copy_id, "SELECT handoff_id FROM kernel_ro.handoffs") == []
    assert await rows_of(app, other.copy_id, select(Handoff)) == []
    response = await client.get("/demo_inbox", headers=other.owner)
    assert response.status_code == 200, response.text
    assert alert.entry_id not in {entry["entry_id"] for entry in response.json()}
    assert waiting("A visitor") not in {entry["body"] for entry in response.json()}
    response = await handoff_done(client, handoff.handoff_id, other.owner)
    assert (response.status_code, response.json()) == (404, {"code": "not_found"})
    # the visitor's own inbox holds codes only, never the owner's alert
    response = await client.get("/demo_inbox", params={"session_id": visitor.session_id}, headers=visitor.headers)
    assert (response.status_code, response.json()) == (200, [])
    assert [row.status for row in await handoffs_of(app, copy)] == ["open"]


async def test_an_owner_say_opens_none(app, client):
    copy, visitor = await visitor_of(app, client)
    await set_mode(client, copy, visitor.session_id, "owner", 0)                     # Maria takes over
    assert (await sent(client, copy, visitor.session_id, "I'll come by and look at it myself.")).verdict.ok
    assert (await sent(client, copy, visitor.session_id, "Offer the Tuesday slot.", "whisper")).verdict is None
    await set_mode(client, copy, visitor.session_id, "ai", 1)                        # and hands back
    assert (await sent(client, copy, visitor.session_id, "Back to Claude now.")).verdict.ok
    assert await handoffs_of(app, copy) == []
    assert await handoff_alerts(app, copy) == []
    assert handoff_entries(await ledger_rows(app, copy)) == []


async def test_the_handoff_and_the_verdict_share_a_transaction(app, client, monkeypatch):
    copy, visitor = await visitor_of(app, client)
    append = ledger.append

    async def failing_reply_entry(ctx, *, copy_id, desk_id, event):
        if event.kind == "reply":
            raise RuntimeError("the ledger is unavailable")
        return await append(ctx, copy_id=copy_id, desk_id=desk_id, event=event)

    before = [entry.seq for entry in await ledger_rows(app, copy)]
    monkeypatch.setattr(ledger, "append", failing_reply_entry)
    response = await post_check(client, visitor, BLOCKED)
    assert (response.status_code, response.json()) == (500, {"code": "internal"})   # never a pass
    # the handoff, its alert and its entry rolled back with the verdict
    assert (await handoffs_of(app, copy), await handoff_alerts(app, copy)) == ([], [])
    assert [entry.seq for entry in await ledger_rows(app, copy)] == before
    monkeypatch.setattr(ledger, "append", append)
    assert_handed_off(await checked(client, visitor, BLOCKED))
    assert [(row.kind, row.status) for row in await handoffs_of(app, copy)] == [("card", "open")]
    assert len(await handoff_alerts(app, copy)) == 1


async def test_a_card_a_take_over_keeps_from_the_visitor_opens_none(app, client, reviewer, frozen_clock):
    """A take-over that commits while the soft-promise check reads a draft moves the session to a
    new generation, so `deliver()` drops the verdict and the visitor never sees its card: the
    owner, who took the conversation over, gets no handoff for it."""
    copy, visitor = await visitor_of(app, client)
    asked, answer = asyncio.Event(), asyncio.Event()
    reviewer.soft_answer = FLAGGED
    soft_promise = reviewer.soft_promise

    async def slow_model(data):
        asked.set()
        await answer.wait()                                      # the model answers only once the test lets it
        return await soft_promise(data)

    reviewer.soft_promise = slow_model
    frozen_clock.advance(60)
    checking = asyncio.create_task(checked(client, visitor, CLEAN))
    try:
        await asyncio.wait_for(asked.wait(), 5)
        state = await asyncio.wait_for(set_mode(client, copy, visitor.session_id, "owner", 0), 5)
    finally:
        answer.set()                                             # never left waiting on the model
    verdict = await asyncio.wait_for(checking, 5)
    assert (state["generation"], verdict.ok, verdict.generation) == (1, False, 0)
    assert_handed_off(verdict)
    assert (await handoffs_of(app, copy), await handoff_alerts(app, copy)) == ([], [])


async def test_a_paused_conversations_card_opens_one(app, client, frozen_clock):
    """The breaker's pause hands every draft off: the first opens the conversation's handoff."""
    copy, visitor = await visitor_of(app, client)
    await set_session(app, copy, visitor.session_id, mode="paused", strikes=3)
    frozen_clock.advance(60)
    for _ in range(2):
        verdict = await checked(client, visitor, CLEAN)
        assert [violation.kind for violation in verdict.violations] == ["session_paused"]
    assert [(row.kind, row.status) for row in await handoffs_of(app, copy)] == [("card", "open")]
    assert len(await handoff_alerts(app, copy)) == 1


# ---- A draft the API will rewrite (`CheckReplyRequest.final`) -----------------------------------------

FRENCH = "Je peux vous aider avec ça."                           # another language: no rewrite fixes it


async def checked_as(client, visitor, prose: str, clauses=(), *, final: bool | None = None):
    """`POST /check_reply` with `final` as given, or without it (absent means final)."""
    body = {"draft": {"session_id": visitor.session_id, "generation": 0, "prose": prose, "clauses": list(clauses)}}
    if final is not None:
        body["final"] = final
    response = await client.post("/check_reply", headers=visitor.headers, json=body)
    assert response.status_code == 200, response.text
    return ReplyVerdict.model_validate(response.json())


@pytest.mark.parametrize(("prose", "soft_answer", "kind"), [
    (BLOCKED, None, "number_in_prose"),
    (CLEAN, FLAGGED, "soft_promise"),
], ids=["code-check", "model-check"])
async def test_a_draft_the_api_will_rewrite_opens_no_handoff(app, client, reviewer, prose, soft_answer, kind):
    """A first attempt (`final: false`) blocked only for what a rewrite can fix (`desk.rewrites`) is
    never shown: the API sends Claude the violations and checks the rewrite. So the kernel opens no
    handoff for it, alerts no one, and leaves nothing to back a later reply."""
    copy, visitor = await visitor_of(app, client)
    if soft_answer is not None:
        reviewer.soft_answer = soft_answer
    verdict = await checked_as(client, visitor, prose, final=False)
    assert_handed_off(verdict)                                    # the kernel's verdict is as ever
    assert {violation.kind for violation in verdict.violations} == {kind}
    assert (await handoffs_of(app, copy), await handoff_alerts(app, copy)) == ([], [])
    assert handoff_entries(await ledger_rows(app, copy)) == []
    [entry] = await reply_entries(app, copy)
    assert (entry.seq, entry.event.summary["final"]) == (verdict.ledger_seq, False)
    reviewer.soft_answer = SoftPromiseVerdict(promises_beyond_cards=False, denies_being_ai=False)
    assert (await checked_as(client, visitor, "Maria Rivera will reply here.")).ok
    assert reviewer.soft_inputs[-1].cards == []                   # no handoff backs it


async def test_a_rewritten_draft_leaves_no_phantom_handoff(app, client, reviewer):
    """The API's own flow: a first draft blocked for a number, which the visitor never sees, then
    Claude's clean rewrite, which passes. No handoff is opened, no alert sent, and the rewrite's
    check is shown no handoff card."""
    copy, visitor = await visitor_of(app, client)
    assert not (await checked_as(client, visitor, BLOCKED, final=False)).ok
    rewrite = await checked_as(client, visitor, CLEAN, final=True)
    assert rewrite.ok and [(block.kind, block.text) for block in rewrite.blocks] == [("prose", CLEAN)]
    assert reviewer.soft_inputs[-1].cards == []
    assert (await handoffs_of(app, copy), await handoff_alerts(app, copy)) == ([], [])
    assert [entry.event.summary["final"] for entry in await reply_entries(app, copy)] == [False, True]


@pytest.mark.parametrize("prose", [FRENCH, f"{BLOCKED} {FRENCH}"], ids=["french", "number-and-french"])
async def test_a_draft_no_rewrite_can_fix_opens_one_even_on_a_first_attempt(app, client, prose):
    """A violation outside the rewritable kinds hands off at once, first attempt or not: the
    visitor sees that card, so it opens the owner's handoff."""
    copy, visitor = await visitor_of(app, client)
    verdict = await checked_as(client, visitor, prose, final=False)
    assert "unsupported_language" in {violation.kind for violation in verdict.violations}
    assert [(row.kind, row.status) for row in await handoffs_of(app, copy)] == [("card", "open")]
    assert len(await handoff_alerts(app, copy)) == 1


@pytest.mark.parametrize("final", [True, None], ids=["final", "absent"])
async def test_a_final_draft_or_one_that_says_nothing_opens_one(app, client, final):
    copy, visitor = await visitor_of(app, client)
    assert not (await checked_as(client, visitor, BLOCKED, final=final)).ok
    assert [(row.kind, row.status) for row in await handoffs_of(app, copy)] == [("card", "open")]
    assert len(await handoff_alerts(app, copy)) == 1
    [entry] = await reply_entries(app, copy)
    assert entry.event.summary["final"] is True


@pytest.mark.parametrize("final", [False, True, None], ids=["first-attempt", "final", "absent"])
async def test_a_reply_citing_the_handoff_clause_always_opens_one(app, client, final):
    """A reply that passes with the handoff card is shown, whatever the attempt: the API's own
    handoff is such a reply."""
    copy, visitor = await visitor_of(app, client)
    verdict = await checked_as(client, visitor, "", [clause("handoff")], final=final)
    assert verdict.ok and [block.template for block in verdict.blocks] == ["handoff"]
    assert [(row.kind, row.status) for row in await handoffs_of(app, copy)] == [("card", "open")]
    assert len(await handoff_alerts(app, copy)) == 1


async def test_the_owners_own_preview_opens_no_handoff(app, client):
    """The owner trying the Desk as a customer (`preview`) is the owner already: a card shown in
    the preview, blocked draft or cited clause, opens no handoff and alerts no one (the owner's
    decision of 2026-10-31)."""
    copy = await rivera(app, client)
    response = await client.post("/sessions", headers=copy.owner, json={"desk_slug": copy.slug, "kind": "visitor",
                                                                        "preview": True})
    assert response.status_code == 200, response.text
    created = SessionCreated.model_validate(response.json())
    previewing = Visitor(session_id=created.state.session_id, token=created.session_token)
    assert_handed_off(await checked(client, previewing, BLOCKED))
    assert (await checked(client, previewing, "", [clause("handoff")])).ok
    assert (await handoffs_of(app, copy), await handoff_alerts(app, copy)) == ([], [])
    assert handoff_entries(await ledger_rows(app, copy)) == []
    # an ordinary visitor's card still opens one
    assert_handed_off(await checked(client, await open_visitor(client, copy), BLOCKED))
    assert len(await handoffs_of(app, copy)) == 1
