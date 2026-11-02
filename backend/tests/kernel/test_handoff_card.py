"""The handoff card opens a handoff the owner sees (the owner's decision of 2026-10-30).

The kernel's handoff card tells the visitor "Let me check with Mike Turner. Mike Turner will reply
here." When `/check_reply` answers with it, in place of a draft its checks blocked or because Claude's
own draft cited it, the kernel opens an owner handoff for the session in the verdict's transaction:
kind `card`, no call-back window, a reason the kernel writes, and an owner alert in the Demo inbox
naming only who is waiting. So the conversation lands in the owner's Needs you, and the card's
promise has something behind it. One handoff is open at a time per session (a call-back request
counts): a later card opens none and alerts nothing until the owner marks the open one done. An
owner's say never opens one. (While a handoff is open, the soft-promise check reads the card's
text as one of the reply's cards: test_soft_promise.py.)

A draft blocked only for its prose, with no checked card to keep, asks the visitor first when the
Desk offers a call back: the kernel's call-back offer replaces the handoff card, and opens nothing
(the owner's decision of 2026-11-01). Tests that need a blocked draft to show the handoff card run
on a Desk with its call-back tool turned off (`without_call_backs`), or cite the card in Claude's
own reply (`hand_over`).

Tests run on Turner Plumbing copies as `POST /copies` seeds them (Friday 10:04 in Oakland), whose
notification defaults alert the owner of a handoff at once.
"""

import asyncio
from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest
import sqlalchemy.exc
from fastapi import FastAPI
from sqlalchemy import select

from desk.contracts import Claim, Decision, DemoInboxEntry, ExecResult, Label, ReplyVerdict, SessionCreated
from desk.db.models import DemoInboxEntry as DemoInboxRow
from desk.db.models import Booking, CalendarSlot, Document, Fact, Handoff, LedgerEntry
from desk.kernel_service import adapters, execute, ledger, reply_check
from desk.kernel_service.decisions import SoftPromiseVerdict

from .helpers import kernel_ctx, ledger_rows, rows_of
from .test_adapters import WHO_NOTE, Rivera, book, quote_args, rivera, run, visitor_of
from .test_approvals import answered, post_cancel
from .test_context import context_of, fact_ids, owner_session_id
from .test_decide import PASS, Visitor, decided, open_visitor, set_mode, set_session
from .test_execute import executed
from .test_lead_tools import CALLBACK, TZ, alert_now, callback, handoff_done, owner_alerts
from .test_owner_messages import sent
from .test_release_document import DANA, confirmed
from .test_reply_check import (assert_handed_off, assert_offered, checked, clause, keep_alive_until, post_check,
                               public_key, reply_entries, verify_verdict, own_quote, without_call_backs)
from .test_verification import api_rows, check, code_in, entry_of, started

CARD_REASON = "The Desk handed this to you."
PREVIEW = "A conversation was handed to you"
BLOCKED = "That will be $180."                                   # a number: the code check blocks it
BLOCKED_ES = "Le hago el cincuenta por ciento de descuento, con gusto."
CLEAN = "I can help with that."
FLAGGED = SoftPromiseVerdict(promises_beyond_cards=True, denies_being_ai=False)
HANDOFF_CARD = {"en": "Let me check with Mike Turner.\nMike Turner will reply here.",
                "es": "Déjame consultarlo con Mike Turner.\nMike Turner te responderá aquí."}


async def hand_over(client, visitor: Visitor) -> ReplyVerdict:
    """Claude's own reply citing the handoff card, which passes and shows the card whether or not
    the Desk offers a call back, as the API's own handoff does."""
    verdict = await checked(client, visitor, "", [clause("handoff")])
    assert verdict.ok and [block.template for block in verdict.blocks] == ["handoff"]
    return verdict


@pytest.mark.parametrize(("prose", "clauses", "final", "ok", "templates", "receipt"), [
    ("", [clause("handoff")], True, True, ["handoff"], "Passed to Mike Turner to answer"),
    ("Je peux vous aider avec ça.", [], True, False, ["handoff"], "Passed to Mike Turner to answer"),
    (BLOCKED, [], True, False, [None], "Reply checked against Mike Turner's rules"),   # the call-back offer
    (BLOCKED, [clause("hours", "charter:hours")], True, False, ["hours"],
     "Reply checked against Mike Turner's rules"),
    (BLOCKED, [], False, False, [], "Passed to Mike Turner to answer"),
], ids=["passing-handoff", "final-handoff", "final-offer", "final-kept-card", "unshown-first-attempt"])
async def test_reply_receipt_follows_the_shown_handoff_clause(app, client, prose, clauses, final, ok, templates,
                                                            receipt):
    _, visitor = await visitor_of(app, client)
    verdict = await checked(client, visitor, prose, clauses, final=final)
    assert verdict.ok is ok
    assert [block.template for block in verdict.blocks] == templates
    assert verdict.visitor_plain == receipt
    verify_verdict(await public_key(client), visitor.session_id, verdict)


async def quote_and_payment(client, reviewer, visitor):
    from .test_decide import PASS
    from .test_payment_links import link_for

    quote = await own_quote(client, visitor)
    reviewer.answer = PASS
    decision = await link_for(client, visitor, quote.fact_id.removeprefix("quote:"))
    assert decision.outcome == "allow", decision.reason_plain
    result = await executed(client, visitor, decision)
    [payment] = [fact for fact in result.facts if fact.kind == "payment_link"]
    return [clause("quote", quote.fact_id), clause("payment_link", payment.fact_id)]


@pytest.mark.parametrize("reverse", [False, True], ids=["quote-first", "payment-first"])
async def test_final_prose_failure_keeps_only_checked_cards(app, client, reviewer, reverse):
    copy, visitor = await visitor_of(app, client)
    clauses = await quote_and_payment(client, reviewer, visitor)
    if reverse:
        clauses.reverse()
    verdict = await checked(client, visitor, "Here is $20.", clauses)
    assert not verdict.ok
    assert {v.kind for v in verdict.violations} == {"number_in_prose"}
    assert [(b.template, b.fact_id) for b in verdict.blocks] == [(c["template"], c["fact_id"]) for c in clauses]
    assert verdict.visitor_plain == "Reply checked against Mike Turner's rules"
    assert await handoffs_of(app, copy) == []
    assert await handoff_alerts(app, copy) == []
    assert handoff_entries(await ledger_rows(app, copy)) == []
    verify_verdict(await public_key(client), visitor.session_id, verdict)


@pytest.mark.parametrize("failure", ["unentitled", "unknown", "stale", "canary", "language", "paused", "empty"])
async def test_card_retention_never_salvages_non_prose_failures(app, client, reviewer, failure):
    from desk.db.models import Document
    from .test_reply_check import own_quote

    copy, visitor = await visitor_of(app, client)
    clauses, prose = await quote_and_payment(client, reviewer, visitor), "Here is $20."
    quote_id = clauses[0]["fact_id"]
    if failure == "unentitled":
        other = await open_visitor(client, copy)
        clauses.append(clause("quote", (await own_quote(client, other)).fact_id))
    elif failure == "unknown":
        clauses.append(clause("quote", "quote:missing"))
    elif failure == "stale":
        async with kernel_ctx(app) as ctx:
            ctx.bind(copy.copy_id)
            row = (await ctx.db.scalars(ctx.repo.scoped(select(Fact).where(Fact.fact_id == quote_id)))).one()
            row.status = "expired"
    elif failure == "canary":
        [document, *_] = await rows_of(app, copy.copy_id, select(Document))
        prose += f" {document.canary}"
    elif failure == "language":
        prose = "Je peux envoyer un plombier pour la fuite."
    elif failure == "paused":
        await set_session(app, copy, visitor.session_id, mode="paused")
    else:                # no card to keep, and no call back to offer in the handoff's place
        clauses = []
        await without_call_backs(app, copy)
    verdict = await checked(client, visitor, prose, clauses)
    assert_handed_off(verdict)
    assert [(row.kind, row.status) for row in await handoffs_of(app, copy)] == [("card", "open")]


@pytest.mark.parametrize("kind", ["number_in_prose", "promise_word", "soft_promise", "uncertain_language",
                                  "check_unavailable", "denies_ai"])
@pytest.mark.parametrize("final", [False, True])
@pytest.mark.parametrize("drafted", [False, True], ids=["no-handoff", "drafted-handoff"])
async def test_prose_only_blocks_keep_cards_only_when_shown(app, client, reviewer, kind, final, drafted):
    """A shown block failing only for its prose keeps its checked cards and drops the prose. A
    handoff clause Claude drafted follows them and opens the owner's item and alert, as the handoff
    card does (the owner's ruling of 2026-11-01); without one, no owner item opens."""
    from desk.kernel_service.decisions import CallUsage

    copy, visitor = await visitor_of(app, client)
    clauses = await quote_and_payment(client, reviewer, visitor)
    if drafted:          # drafted between the cards: it is shown after them
        clauses.insert(1, clause("handoff"))
    prose = {"number_in_prose": "Here is $20.", "promise_word": "I guarantee it.",
             "uncertain_language": "Absolutely. Payment link below.",
             "denies_ai": "I'm a real person at the shop, not a bot."}.get(kind, "Here is your quote.")
    if kind == "soft_promise":
        reviewer.soft_answer = FLAGGED
    elif kind == "denies_ai":
        reviewer.soft_answer = SoftPromiseVerdict(promises_beyond_cards=False, denies_being_ai=True)
    elif kind == "check_unavailable":
        async def refusal(data):
            return None, CallUsage(model="claude-haiku-5-5", status="refusal", input_tokens=0, cached_tokens=0,
                                   output_tokens=0, latency_ms=0)
        reviewer.soft_promise = refusal
    verdict = await checked(client, visitor, prose, clauses, final=final)
    assert not verdict.ok
    assert {v.kind for v in verdict.violations} == {"soft_promise" if kind == "denies_ai" else kind}
    shown = final
    assert [b.template for b in verdict.blocks] == (
        ["quote", "payment_link"] + (["handoff"] if drafted else []) if shown else [])
    assert all(b.kind == "card" for b in verdict.blocks)                    # the prose is never kept
    assert prose not in [b.text for b in verdict.blocks]
    opened = shown and drafted
    assert [(row.kind, row.status) for row in await handoffs_of(app, copy)] == ([("card", "open")] if opened else [])
    assert len(await handoff_alerts(app, copy)) == int(opened)
    assert verdict.visitor_plain == ("Passed to Mike Turner to answer" if opened or not shown
                                     else "Reply checked against Mike Turner's rules")
    verify_verdict(await public_key(client), visitor.session_id, verdict)


@pytest.mark.parametrize(("prose", "soft_answer", "kind", "language"), [
    ("I guarantee it.", None, "promise_word", "en"),
    ("Eso es gratis.", None, "promise_word", "es"),
    (CLEAN, FLAGGED, "soft_promise", "en"),
    ("Perfecto, ya lo reviso.", FLAGGED, "soft_promise", "es"),
], ids=["promise-en", "promise-es", "soft-en", "soft-es"])
async def test_a_prose_only_block_with_nothing_to_keep_offers_a_call_back(app, client, reviewer, prose, soft_answer,
                                                                          kind, language):
    """Self-serve first: a shown block failing only for its prose, with no checked card to keep,
    asks the visitor before involving the owner. On a Desk that offers call backs (Turner's seed
    gives visitors `native.request_callback`), the kernel shows its signed call-back offer in the
    reply's language in place of the handoff card, so no owner handoff opens and no alert goes out
    (the owner's decision of 2026-11-01)."""
    copy, visitor = await visitor_of(app, client)
    if soft_answer is not None:
        reviewer.soft_answer = soft_answer
    verdict = await checked(client, visitor, prose)
    assert {v.kind for v in verdict.violations} == {kind}
    assert_offered(verdict, language)
    assert await handoffs_of(app, copy) == []
    assert await handoff_alerts(app, copy) == []
    assert handoff_entries(await ledger_rows(app, copy)) == []
    verify_verdict(await public_key(client), visitor.session_id, verdict)


@pytest.mark.parametrize("session", ["drafted handoff", "call-back open", "card open", "checker outage"])
async def test_the_offer_never_replaces_a_handoff_the_conversation_has(app, client, reviewer, session):
    """The call-back offer asks first only where nothing else stands. A handoff clause Claude drafted
    is honoured, and opens the owner's handoff as the card does. A session with an open handoff of
    either kind, a call-back request's or a card's, sees the handoff card, which opens nothing new
    and alerts no one again. A checker outage (`check_unavailable`) hands off."""
    copy, visitor = await visitor_of(app, client)
    prose, clauses = BLOCKED, []
    if session == "drafted handoff":
        clauses = [clause("handoff")]
    elif session == "call-back open":
        await callback(client, visitor)
    elif session == "card open":
        await hand_over(client, visitor)
    else:
        prose, reviewer.soft_answer = CLEAN, None                 # the soft check gives no verdict
    before = [(row.handoff_id, row.kind, row.status) for row in await handoffs_of(app, copy)]
    alerts_before = len(await handoff_alerts(app, copy))
    verdict = await checked(client, visitor, prose, clauses)
    assert {v.kind for v in verdict.violations} == {"check_unavailable" if session == "checker outage"
                                                    else "number_in_prose"}
    assert_handed_off(verdict)
    after = [(row.handoff_id, row.kind, row.status) for row in await handoffs_of(app, copy)]
    if before:                                                    # the open one stands, and no alert repeats
        assert (after, len(await handoff_alerts(app, copy))) == (before, alerts_before)
    else:                                                         # the card shown opens the owner's handoff
        assert [(kind, status) for _, kind, status in after] == [("card", "open")]
        assert len(await handoff_alerts(app, copy)) == 1


@pytest.mark.parametrize(("prose", "soft_answer", "language"), [
    ("I guarantee it.", None, "en"),
    ("Eso es gratis.", None, "es"),
    (CLEAN, FLAGGED, "en"),
], ids=["promise-en", "promise-es", "soft-en"])
async def test_a_desk_without_call_backs_still_hands_a_prose_only_block_to_the_owner(app, client, reviewer, prose,
                                                                                     soft_answer, language):
    """With no call back to offer (the owner turned the tool off), a prose-only failure with no card
    to keep shows the handoff card, as before, and it opens the owner's handoff and alert."""
    copy, visitor = await visitor_of(app, client)
    await without_call_backs(app, copy)
    if soft_answer is not None:
        reviewer.soft_answer = soft_answer
    verdict = await checked(client, visitor, prose)
    assert_handed_off(verdict, language)
    assert [(row.kind, row.status) for row in await handoffs_of(app, copy)] == [("card", "open")]
    assert len(await handoff_alerts(app, copy)) == 1


async def test_a_business_tool_for_urgent_requests_offers_the_call_back_too(app, client, monkeypatch):
    """The offer follows the session's resolved tools: a business tool of block `urgent` offers a
    call back as `native.request_callback` does (`desk.next_steps`)."""
    from desk.kernel_service import context

    copy, visitor = await visitor_of(app, client)
    await without_call_backs(app, copy)
    resolved_tools = context.resolved_tools
    urgent = SimpleNamespace(tool="desk.urgent", business=SimpleNamespace(config=SimpleNamespace(block="urgent")))

    async def with_urgent(*args):
        return [*await resolved_tools(*args), urgent]

    monkeypatch.setattr(context, "resolved_tools", with_urgent)
    assert_offered(await checked(client, visitor, "I guarantee it."))
    assert await handoffs_of(app, copy) == []


@pytest.mark.parametrize("session", ["card open", "call-back open", "hold awaiting", "preview"])
@pytest.mark.parametrize("drafted", [False, True], ids=["no-handoff", "drafted-handoff"])
async def test_shown_checker_outage_keeps_cards_without_another_owner_item(app, client, reviewer, session, drafted):
    """Kept cards, and a drafted handoff kept after them, open no second owner item: not while a
    handoff or a held request is open, and never in the owner's preview."""
    from desk.kernel_service.decisions import CallUsage

    copy, visitor = await visitor_of(app, client)
    if session == "preview":
        response = await client.post("/sessions", headers=copy.owner, json={
            "desk_slug": copy.slug, "kind": "visitor", "preview": True})
        assert response.status_code == 200, response.text
        created = SessionCreated.model_validate(response.json())
        visitor = Visitor(session_id=created.state.session_id, token=created.session_token)
    clauses = await quote_and_payment(client, reviewer, visitor)
    if drafted:
        clauses.append(clause("handoff"))
    if session == "card open":
        await hand_over(client, visitor)
    elif session == "call-back open":
        await callback(client, visitor)
    elif session == "hold awaiting":
        await held_quote(client, visitor)
    before = [(row.handoff_id, row.kind, row.status) for row in await handoffs_of(app, copy)]
    alerts_before = len(await handoff_alerts(app, copy))

    async def refusal(data):
        return None, CallUsage(model="claude-haiku-5-5", status="refusal", latency_ms=0)

    reviewer.soft_promise = refusal
    # A first attempt is rewritten (the owner's ruling of 2026-11-01): nothing shows, no owner item.
    first = await checked(client, visitor, CLEAN, clauses, final=False)
    assert [v.kind for v in first.violations] == ["check_unavailable"] and first.blocks == []
    verdict = await checked(client, visitor, CLEAN, clauses, final=True)
    assert not verdict.ok and [v.kind for v in verdict.violations] == ["check_unavailable"]
    assert [b.template for b in verdict.blocks] == ["quote", "payment_link"] + (["handoff"] if drafted else [])
    assert [(row.handoff_id, row.kind, row.status) for row in await handoffs_of(app, copy)] == before
    assert len(await handoff_alerts(app, copy)) == alerts_before


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
    """On a Desk that offers no call back, a blocked draft with no card to keep shows the handoff card."""
    copy, visitor = await visitor_of(app, client)
    await without_call_backs(app, copy)
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
    await without_call_backs(app, copy)                          # so each blocked draft shows the handoff card
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
    assert verdict.visitor_plain == "Passed to Mike Turner to answer"
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
    await hand_over(client, visitor)
    [first] = await handoffs_of(app, copy)
    assert (await handoff_done(client, first.handoff_id, copy.owner)).status_code == 200
    await hand_over(client, visitor)
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
    await hand_over(client, caller)
    kinds = sorted((row.kind, row.status) for row in await handoffs_of(app, copy)
                   if row.session_id == caller.session_id)
    assert kinds == [("callback", "done"), ("card", "open")]


async def test_the_alert_names_only_who_is_waiting(app, client):
    """The alert holds neither the draft's prose nor anything the visitor typed, nor a contact: a
    verified person is named as the owner's records name them, anyone else is "A visitor". It
    names no decision."""
    copy = await rivera(app, client)
    await without_call_backs(app, copy)                          # so the blocked drafts show the handoff card
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
    await hand_over(client, visitor)
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
    await set_mode(client, copy, visitor.session_id, "owner", 0)                     # Mike takes over
    assert (await sent(client, copy, visitor.session_id, "I'll come by and look at it myself.")).verdict.ok
    assert (await sent(client, copy, visitor.session_id, "Offer the Tuesday slot.", "whisper")).verdict is None
    await set_mode(client, copy, visitor.session_id, "ai", 1)                        # and hands back
    assert (await sent(client, copy, visitor.session_id, "Back to Claude now.")).verdict.ok
    assert await handoffs_of(app, copy) == []
    assert await handoff_alerts(app, copy) == []
    assert handoff_entries(await ledger_rows(app, copy)) == []


async def test_the_handoff_and_the_verdict_share_a_transaction(app, client, monkeypatch):
    copy, visitor = await visitor_of(app, client)
    await without_call_backs(app, copy)                          # so the blocked draft shows the handoff card
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
    await without_call_backs(app, copy)                          # so the blocked draft shows the handoff card
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
    handoff for it, alerts no one, and leaves nothing to back a later reply; and its verdict, still
    signed and ledgered, carries no blocks, so it never holds a showable handoff card that no
    handoff backs."""
    copy, visitor = await visitor_of(app, client)
    if soft_answer is not None:
        reviewer.soft_answer = soft_answer
    verdict = await checked_as(client, visitor, prose, final=False)
    assert (verdict.ok, verdict.blocks, verdict.visitor_plain) == (False, [], "Passed to Mike Turner to answer")
    assert {violation.kind for violation in verdict.violations} == {kind}
    verify_verdict(await public_key(client), visitor.session_id, verdict)
    assert (await handoffs_of(app, copy), await handoff_alerts(app, copy)) == ([], [])
    assert handoff_entries(await ledger_rows(app, copy)) == []
    [entry] = await reply_entries(app, copy)
    assert (entry.seq, entry.event.summary["final"]) == (verdict.ledger_seq, False)
    reviewer.soft_answer = SoftPromiseVerdict(promises_beyond_cards=False, denies_being_ai=False)
    assert (await checked_as(client, visitor, "Mike Turner will reply here.")).ok
    assert reviewer.soft_inputs[-1].cards == []                   # no handoff backs it


async def test_a_rewritten_draft_leaves_no_phantom_handoff(app, client, reviewer):
    """The API's own flow: a first draft blocked for a number, which the visitor never sees, then
    Claude's clean rewrite, which passes. No handoff is opened, no alert sent, and the rewrite's
    check is shown no handoff card."""
    copy, visitor = await visitor_of(app, client)
    first = await checked_as(client, visitor, BLOCKED, final=False)
    assert (first.ok, first.blocks) == (False, [])
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
    await without_call_backs(app, copy)                          # so the blocked draft shows the handoff card
    assert_handed_off(await checked_as(client, visitor, BLOCKED, final=final))     # the handoff card, shown
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
    await without_call_backs(app, copy)                          # so the blocked drafts show the handoff card
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


async def test_the_owners_preview_callback_keeps_its_card_and_reconciliation_without_needing_the_owner(app, client):
    """A preview's call-back writes its own row already done, no Needs-you item or alert, but
    keeps its window fact for the card and its row for reconciliation, even after another call."""
    copy = await rivera(app, client)
    await alert_now(app, copy, "callback")
    response = await client.post("/sessions", headers=copy.owner, json={
        "desk_slug": copy.slug, "kind": "visitor", "preview": True})
    assert response.status_code == 200, response.text
    created = SessionCreated.model_validate(response.json())
    previewing = Visitor(session_id=created.state.session_id, token=created.session_token)
    before = await owner_alerts(client, copy)
    requests = []
    for call_id in ("call-1", "call-2"):
        decision = await decided(client, previewing, "native.request_callback", CALLBACK, call_id=call_id)
        result = await executed(client, previewing, decision)
        assert result.state == "succeeded" and result.inbox == []
        [fact] = result.facts
        assert fact.fact_id == f"handoff:{result.model_view['handoff_id']}"
        assert (fact.status, fact.claims, fact.expires_at) == ("committed", [
            Claim(key="window_start", kind="datetime", value="2026-10-30T11:00:00-07:00"),
            Claim(key="window_end", kind="datetime", value="2026-10-30T12:00:00-07:00")],
            datetime(2026, 10, 30, 12, 0, tzinfo=TZ))
        requests.append((decision, result))

    assert [(row.kind, row.status) for row in await handoffs_of(app, copy)] == [("callback", "done")] * 2
    assert api_rows(copy.copy_id, "SELECT handoff_id FROM kernel_ro.handoffs WHERE status = 'open'") == []
    assert await owner_alerts(client, copy) == before
    assert handoff_entries(await ledger_rows(app, copy)) == []       # no closing entry for a preview
    for decision, result in requests:
        reconciled = await run(app, copy.copy_id, decision, "reconcile")
        assert (reconciled.facts, reconciled.model_view) == (result.facts, result.model_view)
        [fact] = result.facts
        verdict = await checked(client, previewing, "", [clause("callback_confirmed", fact.fact_id)])
        assert verdict.ok
        [block] = verdict.blocks
        assert (block.template, block.fact_id, block.title, block.lines) == (
            "callback_confirmed", fact.fact_id,
            "Mike Turner will call you back on Friday, October 30, between 11:00 am and 12:00 pm", [])
    assert await owner_alerts(client, copy) == before

    # An ordinary visitor still leaves one open call-back and alerts the owner.
    visitor = await open_visitor(client, copy)
    result = await callback(client, visitor)
    assert api_rows(copy.copy_id, "SELECT handoff_id, session_id FROM kernel_ro.handoffs WHERE status = 'open'") == [
        (result.model_view["handoff_id"], visitor.session_id)]
    [alert] = [entry for entry in await owner_alerts(client, copy) if entry not in before]
    assert alert.to == "owner" and "Sam Lee" in alert.body


async def verify_dana(client, visitor):
    """Verify an existing session through the code sent to Dana's contact on record."""
    [notice] = (await started(client, visitor, DANA)).inbox
    response = await check(client, visitor, code_in(await entry_of(client, visitor, notice)))
    assert response.status_code == 200, response.text


@pytest.mark.parametrize("verified_first", [False, True], ids=["verified-after", "verified-first"])
async def test_preview_callback_fact_stays_in_its_session_after_verification(app, client, verified_first):
    """A real visitor verified as the same person gets neither the preview fact nor its card."""
    copy = await rivera(app, client)
    response = await client.post("/sessions", headers=copy.owner, json={
        "desk_slug": copy.slug, "kind": "visitor", "preview": True})
    assert response.status_code == 200, response.text
    created = SessionCreated.model_validate(response.json())
    preview = Visitor(session_id=created.state.session_id, token=created.session_token)
    if verified_first:
        await verify_dana(client, preview)
    [fact] = (await callback(client, preview)).facts
    if not verified_first:
        await verify_dana(client, preview)

    visitor = await confirmed(client, copy, DANA)
    context = await context_of(client, visitor.session_id, visitor.headers)
    verdict = await checked(client, visitor, "", [clause("callback_confirmed", fact.fact_id)])
    assert (fact.fact_id in fact_ids(context.facts), verdict.ok) == (False, False)
    assert not any(block.template == "callback_confirmed" for block in verdict.blocks)

    # Verification preserves the session-only label, its preview card and the owner's access.
    preview_context = await context_of(client, preview.session_id, preview.headers)
    [stored] = [item for item in preview_context.facts if item.fact_id == fact.fact_id]
    assert stored.label == Label(readers=["owner", f"session:{preview.session_id}"])
    assert (await checked(client, preview, "", [clause("callback_confirmed", fact.fact_id)])).ok
    owner = await owner_session_id(client, copy.owner)
    assert fact.fact_id in fact_ids((await context_of(client, owner, copy.owner, desk_id=copy.desk_id)).facts)


@pytest.mark.parametrize("verified_first", [False, True], ids=["verified-after", "verified-first"])
async def test_visitor_callback_fact_reaches_the_same_person_in_another_session(app, client, verified_first):
    """Ordinary call-backs keep person sharing, whether verification precedes or follows them."""
    copy, visitor = await visitor_of(app, client)
    if verified_first:
        await verify_dana(client, visitor)
    [fact] = (await callback(client, visitor)).facts
    if not verified_first:
        await verify_dana(client, visitor)

    returning = await confirmed(client, copy, DANA)
    context = await context_of(client, returning.session_id, returning.headers)
    [shared] = [item for item in context.facts if item.fact_id == fact.fact_id]
    assert shared.label.record_owner is not None
    assert shared.label.readers == ["owner", f"session:{visitor.session_id}",
                                    f"person:{shared.label.record_owner}"]
    assert (await checked(client, returning, "", [clause("callback_confirmed", fact.fact_id)])).ok
    assert [(row.kind, row.status) for row in await handoffs_of(app, copy)] == [("callback", "open")]


# ---- One open handoff per session, a call-back's included ----------------------------------------------

SAM = "Sam Lee · (510) 555-0100 · The water heater is leaking"     # the call-back's reason, as CALLBACK writes it


def closed_entries(entries: list[LedgerEntry]) -> list[list[str]]:
    """The handoffs each `desk_data` closing entry names, in order: the owner's mark, or a call-back's."""
    return [entry.event.summary["refs"] for entry in entries if entry.event.kind == "desk_data"
            and entry.event.summary.get("part") == "handoffs" and "kind" not in entry.event.summary]


def replaced_entries(entries: list[LedgerEntry]) -> list[tuple[list[str], str | None]]:
    """Each closing entry's handoffs and the call-back that replaced them, None for the owner's own
    mark of done, so the owner's history can tell the two apart."""
    return [(entry.event.summary["refs"], entry.event.summary.get("replaced_by")) for entry in entries
            if entry.event.kind == "desk_data" and entry.event.summary.get("part") == "handoffs"
            and "kind" not in entry.event.summary]


async def test_a_call_back_request_closes_the_open_card_handoff_and_opens_its_own(app, client, frozen_clock):
    """A call-back request in a conversation the card already handed to the owner closes the card's
    handoff, as the owner's mark of done closes one and ledgered as it is, and opens its own, of kind
    `callback`, with its window, fact and action. A row's kind never changes, so the session keeps
    one open handoff, the owner one item, and an owner's stale mark of done on the card's item
    answers 409 without touching the call-back. The card's alert isn't repeated; the call-back
    alerts as call-backs do."""
    copy, visitor = await visitor_of(app, client)                 # Friday 10:04 in Oakland: 11:00 to 12:00
    await alert_now(app, copy, "callback")
    await hand_over(client, visitor)
    [card] = await handoffs_of(app, copy)
    decision = await decided(client, visitor, "native.request_callback", CALLBACK)
    result = await executed(client, visitor, decision)

    rows = {row.handoff_id: row for row in await handoffs_of(app, copy)}
    called = rows[result.model_view["handoff_id"]]
    assert (rows[card.handoff_id].kind, rows[card.handoff_id].status) == ("card", "done")
    assert (called.kind, called.status, called.action_id, called.reason) == (
        "callback", "open", decision.action.action_id, SAM)
    assert (called.window_start, called.window_end) == (datetime(2026, 10, 30, 11, tzinfo=TZ),
                                                        datetime(2026, 10, 30, 12, tzinfo=TZ))
    assert (rows[card.handoff_id].created_at, called.created_at) == (frozen_clock.now(), frozen_clock.now())
    # as the owner's mark is ledgered, naming the call-back that replaced it
    assert replaced_entries(await ledger_rows(app, copy)) == [([card.handoff_id], called.handoff_id)]
    [fact] = result.facts
    assert (fact.fact_id, fact.kind, fact.status) == (f"handoff:{called.handoff_id}", "handoff", "committed")
    assert len(await handoff_alerts(app, copy)) == 1                         # the card's, not repeated
    assert len([alert for alert in await owner_alerts(client, copy) if "Sam Lee" in alert.body]) == 1
    reconciled = await run(app, copy.copy_id, decision, "reconcile")       # found by its action, as any call-back
    assert (reconciled.facts, reconciled.model_view) == (result.facts, result.model_view)

    response = await handoff_done(client, card.handoff_id, copy.owner)    # the owner's view from before
    assert (response.status_code, response.json()) == (409, {"code": "conflict"})
    assert [(row.kind, row.status) for row in await handoffs_of(app, copy) if row.status == "open"] == [
        ("callback", "open")]
    verdict = await checked(client, visitor, "I passed your request on.", [clause("callback_confirmed", fact.fact_id)])
    assert verdict.ok, verdict.violations


async def test_a_second_call_back_request_closes_the_first(app, client, frozen_clock):
    """A second call-back request while the first is open closes the first, its fact expired, and
    opens its own with the time now promised. Each keeps its own row, so the first call-back's
    reconciliation still finds its own. Each alerts as call-backs do."""
    copy, visitor = await visitor_of(app, client)
    await alert_now(app, copy, "callback")
    first_decision = await decided(client, visitor, "native.request_callback", CALLBACK)
    first = await executed(client, visitor, first_decision)       # 10:04: 11:00 to 12:00
    frozen_clock.advance(3600)                                    # 11:04: 12:00 to 13:00
    decision = await decided(client, visitor, "native.request_callback", {**CALLBACK, "contact": "(510) 555-0199"},
                             call_id="call-2")
    second = await executed(client, visitor, decision)

    rows = {row.handoff_id: row for row in await handoffs_of(app, copy)}
    earlier, later = rows[first.model_view["handoff_id"]], rows[second.model_view["handoff_id"]]
    assert (earlier.status, earlier.action_id) == ("done", first_decision.action.action_id)
    assert (later.status, later.kind, later.action_id, later.reason) == (
        "open", "callback", decision.action.action_id, "Sam Lee · (510) 555-0199 · The water heater is leaking")
    assert (later.window_start, later.window_end) == (datetime(2026, 10, 30, 12, tzinfo=TZ),
                                                      datetime(2026, 10, 30, 13, tzinfo=TZ))
    facts = {row.fact_id: row.status for row in await rows_of(app, copy.copy_id, select(Fact).where(
        Fact.kind == "handoff"))}
    assert facts == {first.facts[0].fact_id: "expired", second.facts[0].fact_id: "committed"}
    assert replaced_entries(await ledger_rows(app, copy)) == [([earlier.handoff_id], later.handoff_id)]
    assert len([alert for alert in await owner_alerts(client, copy) if "Sam Lee" in alert.body]) == 2
    reconciled = await run(app, copy.copy_id, first_decision, "reconcile")
    assert reconciled.model_view == first.model_view                       # its own row, closed


async def test_two_call_back_requests_at_once_leave_one_open_handoff(app, client):
    """A call-back's execution holds the session row FOR UPDATE, so two call-back requests run at once
    in one session take turns: the second closes the first's handoff and opens its own."""
    copy, visitor = await visitor_of(app, client)
    decisions = [await decided(client, visitor, "native.request_callback", CALLBACK, call_id=call_id)
                 for call_id in ("call-1", "call-2")]
    results = await asyncio.gather(*(executed(client, visitor, decision) for decision in decisions))
    assert [result.state for result in results] == ["succeeded", "succeeded"]
    rows = await handoffs_of(app, copy)
    assert sorted((row.kind, row.status) for row in rows) == [("callback", "done"), ("callback", "open")]
    assert {row.handoff_id for row in rows} == {result.model_view["handoff_id"] for result in results}


async def legacy_call_back(app: FastAPI, copy: Rivera, visitor: Visitor, handoff_id: str, action_id: str) -> None:
    """An open call-back's handoff as an earlier kernel wrote it (no `created_at`), beside any other."""
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        ctx.db.add(Handoff(handoff_id=handoff_id, copy_id=copy.copy_id, desk_id=copy.desk_id,
                           session_id=visitor.session_id, reason=SAM, status="open", kind="callback",
                           action_id=action_id))


async def test_a_session_holding_several_open_handoffs_has_them_closed_by_the_next_call_back(app, client):
    """A session may hold several open call-backs from before one open handoff per session was
    kept, or from the previous release during a deploy. A card shown there opens none; the next
    call-back request closes them all, each ledgered as the owner's mark is, and opens its own."""
    copy, visitor = await visitor_of(app, client)
    for handoff_id, call_id in (("handoff-zzzz", "call-1"), ("handoff-aaaa", "call-2")):
        earlier = await decided(client, visitor, "native.request_callback", CALLBACK, call_id=call_id)
        await legacy_call_back(app, copy, visitor, handoff_id, earlier.action.action_id)
    await hand_over(client, visitor)
    assert await handoff_alerts(app, copy) == []                                      # no card's handoff beside them

    latest = await decided(client, visitor, "native.request_callback", CALLBACK, call_id="call-3")
    result = await executed(client, visitor, latest)
    rows = {row.handoff_id: (row.kind, row.status) for row in await handoffs_of(app, copy)}
    assert rows == {"handoff-zzzz": ("callback", "done"), "handoff-aaaa": ("callback", "done"),
                    result.model_view["handoff_id"]: ("callback", "open")}
    replacing = result.model_view["handoff_id"]
    assert sorted(replaced_entries(await ledger_rows(app, copy))) == [(["handoff-aaaa"], replacing),
                                                                     (["handoff-zzzz"], replacing)]


# ---- A held request awaiting the owner (the owner's decision of 2026-10-31) ---------------------------

async def held_quote(client, visitor):
    """The visitor's quote at 15% off, which `rv-quote` (no discount) holds for the owner."""
    held = await decided(client, visitor, "native.quote", quote_args(("drain", 1), discount_bp=1500),
                         call_id="call-held")
    assert (held.outcome, held.state) == ("hold", "held"), held.reason_plain
    return held


@pytest.mark.parametrize("ends", ["denied", "cancelled", "expired"])
async def test_a_held_request_awaiting_the_owner_is_the_conversations_item(app, client, frozen_clock, ends):
    """While the session has a held request awaiting the owner, the owner already has that
    request's alert and item for the conversation: a card shown meanwhile opens no handoff and
    sends no alert, so the owner sees one item and gets one alert, and a draft blocked only for its
    prose shows the kernel's status line instead of the card. Once the hold has an end (the owner's
    answer, the visitor's cancel, or its expiry), the next blocked draft shows the card, which opens
    one as usual."""
    copy, visitor = await visitor_of(app, client)
    await without_call_backs(app, copy)                          # so the blocked drafts show the handoff card
    held = await held_quote(client, visitor)
    status = await checked(client, visitor, BLOCKED)             # the visitor is told the request is waiting for approval
    assert [(block.kind, block.text) for block in status.blocks] == [("prose", STATUS_LINE["en"])]
    assert (await checked(client, visitor, "", [clause("handoff")])).ok          # nor a card Claude cites
    assert (await handoffs_of(app, copy), await handoff_alerts(app, copy)) == ([], [])
    assert handoff_entries(await ledger_rows(app, copy)) == []

    if ends == "denied":
        await answered(client, copy.owner, held.decision_id, "deny_once")
    elif ends == "cancelled":
        assert (await post_cancel(client, visitor, held.decision_id)).status_code == 200
    else:
        await keep_alive_until(client, frozen_clock, visitor, 24)            # past its day, never read since
    assert_handed_off(await checked(client, visitor, BLOCKED))
    assert [(row.kind, row.status) for row in await handoffs_of(app, copy)] == [("card", "open")]
    assert len(await handoff_alerts(app, copy)) == 1


async def test_a_hold_that_cant_be_read_opens_the_handoff_as_usual(app, client, monkeypatch):
    """The skip only spares the owner a second alert, so a read of the session's holds that fails
    opens the handoff and alerts as usual: it fails toward telling the owner."""
    copy, visitor = await visitor_of(app, client)
    await without_call_backs(app, copy)                          # so the blocked draft shows the handoff card
    await held_quote(client, visitor)

    async def unreadable(ctx, session_row):
        raise sqlalchemy.exc.OperationalError("SELECT", {}, RuntimeError("the read failed"))

    monkeypatch.setattr(reply_check, "_awaiting_holds", unreadable)
    assert_handed_off(await checked(client, visitor, BLOCKED))
    assert [(row.kind, row.status) for row in await handoffs_of(app, copy)] == [("card", "open")]
    assert len(await handoff_alerts(app, copy)) == 1


@pytest.mark.parametrize("session", ["call-back open", "hold awaiting", "preview"])
async def test_a_first_attempt_no_rewrite_can_fix_shows_the_handoff_where_none_opens(app, client, session):
    """A first attempt holding a violation no rewrite can fix is shown at once, so its verdict keeps
    the handoff clause even where the card opens no handoff: a session whose call-back is already
    open, one with a request awaiting the owner, and the owner's own preview. Only a first attempt
    blocked for rewritable kinds alone carries no blocks; whether a handoff opened doesn't decide it,
    or the visitor would be shown nothing."""
    copy, visitor = await visitor_of(app, client)
    if session == "call-back open":
        await callback(client, visitor)
    elif session == "hold awaiting":
        await held_quote(client, visitor)
    else:
        response = await client.post("/sessions", headers=copy.owner, json={
            "desk_slug": copy.slug, "kind": "visitor", "preview": True})
        assert response.status_code == 200, response.text
        created = SessionCreated.model_validate(response.json())
        visitor = Visitor(session_id=created.state.session_id, token=created.session_token)
    before = [(row.kind, row.status) for row in await handoffs_of(app, copy)]
    verdict = await checked_as(client, visitor, FRENCH, [clause("quote", "catalog")], final=False)
    assert "unsupported_language" in {violation.kind for violation in verdict.violations}
    assert_handed_off(verdict)
    assert [(row.kind, row.status) for row in await handoffs_of(app, copy)] == before   # no second one


# ---- The owner handling the conversation closes the card's handoff (the owner's decision of 2026-10-31) --

def closing_summaries(entries: list[LedgerEntry]) -> list[dict]:
    """The `desk_data` entries that close a handoff, in order, as ledgered."""
    return [entry.event.summary for entry in entries if entry.event.kind == "desk_data"
            and entry.event.summary.get("part") == "handoffs" and "kind" not in entry.event.summary]


async def card_handoff(app: FastAPI, client, copy: Rivera, visitor: Visitor) -> Handoff:
    """The session's card handoff, opened by a blocked final check on a Desk that offers no call back."""
    await without_call_backs(app, copy)
    assert_handed_off(await checked(client, visitor, BLOCKED))
    [handoff] = await handoffs_of(app, copy)
    assert (handoff.kind, handoff.status) == ("card", "open")
    return handoff


async def test_taking_the_conversation_over_closes_the_cards_handoff(app, client):
    """The owner taking the conversation over is the owner handling it: the card's handoff closes
    with the take-over, ledgered as closed by it, so Needs you stops listing it. Handing back
    closes nothing more."""
    copy, visitor = await visitor_of(app, client)
    card = await card_handoff(app, client, copy, visitor)
    await set_mode(client, copy, visitor.session_id, "owner", 0)
    assert [(row.handoff_id, row.status) for row in await handoffs_of(app, copy)] == [(card.handoff_id, "done")]
    assert api_rows(copy.copy_id, "SELECT handoff_id, status FROM kernel_ro.handoffs") == [(card.handoff_id, "done")]
    entries = await ledger_rows(app, copy)
    assert closing_summaries(entries) == [{"part": "handoffs", "refs": [card.handoff_id], "closed_by": "takeover"}]
    await set_mode(client, copy, visitor.session_id, "ai", 1)
    assert closing_summaries(await ledger_rows(app, copy)) == closing_summaries(entries)


async def test_the_owners_first_message_closes_the_cards_handoff(app, client):
    """The owner saying something in the conversation is the owner handling it: the card's handoff
    closes with the message, ledgered as closed by it. A whisper to Claude, which the visitor
    never sees, closes nothing."""
    copy, visitor = await visitor_of(app, client)
    card = await card_handoff(app, client, copy, visitor)
    await sent(client, copy, visitor.session_id, "Let me look at that for you.", kind="whisper")
    assert [row.status for row in await handoffs_of(app, copy)] == ["open"]
    said = await sent(client, copy, visitor.session_id, "Hi, this is Mike. I can help with that.")
    assert said.verdict is not None and said.verdict.ok
    assert [row.status for row in await handoffs_of(app, copy)] == ["done"]
    assert closing_summaries(await ledger_rows(app, copy)) == [
        {"part": "handoffs", "refs": [card.handoff_id], "closed_by": "owner_message"}]
    # the next message closes nothing more
    await sent(client, copy, visitor.session_id, "What day suits you?")
    assert len(closing_summaries(await ledger_rows(app, copy))) == 1


async def test_an_owner_message_the_check_blocks_closes_nothing(app, client):
    """A message the check blocks for a document canary never reaches the visitor, so the owner
    hasn't handled the conversation yet: the card's handoff stays open."""
    copy, visitor = await visitor_of(app, client)
    await card_handoff(app, client, copy, visitor)
    [canary, *_] = [row.canary for row in await rows_of(app, copy.copy_id, select(Document))]
    blocked = await sent(client, copy, visitor.session_id, f"Your invoice reference is {canary}.")
    assert blocked.verdict is not None and not blocked.verdict.ok
    assert [row.status for row in await handoffs_of(app, copy)] == ["open"]
    assert closing_summaries(await ledger_rows(app, copy)) == []


@pytest.mark.parametrize("how", ["takeover", "owner_message"])
async def test_the_owner_handling_the_conversation_leaves_a_call_back_open(app, client, how):
    """A call-back promises the visitor a call, which taking over or replying in the chat doesn't
    keep, so it stays open until the owner marks it done."""
    copy, visitor = await visitor_of(app, client)
    requested = (await callback(client, visitor)).model_view["handoff_id"]
    if how == "takeover":
        await set_mode(client, copy, visitor.session_id, "owner", 0)
    else:
        await sent(client, copy, visitor.session_id, "Hi, this is Mike.")
    assert [(row.handoff_id, row.kind, row.status) for row in await handoffs_of(app, copy)] == [
        (requested, "callback", "open")]
    assert closing_summaries(await ledger_rows(app, copy)) == []


# ---- A booking closes the card's handoff (the owner's decision of 2026-11-01) --------------------------

SLOT = "S-20261102-1000"                    # Monday 10:00 to 12:00, inside rv-book-wk's hours
BOOKED = "A stranger booked Monday, November 2, from 10:00 am to 12:00 pm." + WHO_NOTE


async def preview_of(client, copy: Rivera) -> Visitor:
    """The owner's own preview of the Desk, as a visitor session."""
    response = await client.post("/sessions", headers=copy.owner, json={
        "desk_slug": copy.slug, "kind": "visitor", "preview": True})
    assert response.status_code == 200, response.text
    created = SessionCreated.model_validate(response.json())
    return Visitor(session_id=created.state.session_id, token=created.session_token)


async def held_card(app: FastAPI, copy: Rivera, visitor: Visitor) -> Handoff:
    """An open card handoff the session holds from before, as `reply_check.open_card_handoff`
    writes one (no fact). A preview's card opens none now, so its test writes it here."""
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        ctx.db.add(Handoff(handoff_id="handoff-earlier", copy_id=copy.copy_id, desk_id=copy.desk_id,
                           session_id=visitor.session_id, reason=CARD_REASON, status="open", kind="card",
                           action_id="handoff-earlier", created_at=ctx.clock.now()))
    [handoff] = await handoffs_of(app, copy)
    return handoff


async def booked(client, reviewer, visitor: Visitor, slot_id: str = SLOT,
                 call_id: str = "call-book") -> tuple[Decision, ExecResult]:
    """A weekday booking the reviewer passes, allowed and executed."""
    reviewer.answer = PASS
    decision = await book(client, visitor, slot_id, call_id=call_id)
    assert decision.outcome == "allow", decision.reason_plain
    result = await executed(client, visitor, decision)
    assert result.state == "succeeded"
    return decision, result


def closed_in_its_execution(entries: list[LedgerEntry], decision: Decision, handoff_id: str) -> bool:
    """Whether the booking's closing of `handoff_id` is ledgered once, in the booking's execution:
    after its decision's entry and before its outcome's, as a call-back's closing is."""
    seqs = {(entry.event.kind, entry.event.ref_id): entry.seq for entry in entries}
    closing = [entry.seq for entry in entries if entry.event.kind == "desk_data"
               and entry.event.summary == {"part": "handoffs", "refs": [handoff_id], "closed_by": "booking"}]
    return (len(closing) == 1
            and seqs[("decide", decision.decision_id)] < closing[0] < seqs[("execute", decision.decision_id)])


@pytest.mark.parametrize("session", ["visitor", "preview"])
async def test_a_booking_closes_the_sessions_card_handoff(app, client, reviewer, session):
    """A visitor who books has had what they asked for done, so the handoff the card opened closes
    with the booking, in its transaction, as the owner's mark of done closes one, and is ledgered as
    closed by it: Needs you stops listing the conversation. The owner's booking alert still goes
    out. A card's handoff has no fact, so none is left committed. The owner's own preview, where a
    card opens no handoff, closes one it holds the same way."""
    copy, visitor = await visitor_of(app, client)
    await alert_now(app, copy, "booking")
    if session == "preview":
        visitor = await preview_of(client, copy)
        card = await held_card(app, copy, visitor)
    else:
        card = await card_handoff(app, client, copy, visitor)

    decision, _ = await booked(client, reviewer, visitor)
    assert [(row.handoff_id, row.kind, row.status) for row in await handoffs_of(app, copy)] == [
        (card.handoff_id, "card", "done")]
    assert api_rows(copy.copy_id, "SELECT handoff_id, status FROM kernel_ro.handoffs") == [(card.handoff_id, "done")]
    assert await rows_of(app, copy.copy_id, select(Fact).where(
        Fact.fact_id == f"handoff:{card.handoff_id}", Fact.status != "expired")) == []
    entries = await ledger_rows(app, copy)
    assert closing_summaries(entries) == [{"part": "handoffs", "refs": [card.handoff_id], "closed_by": "booking"}]
    assert closed_in_its_execution(entries, decision, card.handoff_id)
    if session == "visitor":
        assert BOOKED in [alert.body for alert in await owner_alerts(client, copy)]
    # a later booking in the session closes nothing more
    await booked(client, reviewer, visitor, "S-20261102-1200", call_id="call-book-2")
    assert closing_summaries(await ledger_rows(app, copy)) == closing_summaries(entries)


async def test_a_typed_booking_closes_the_sessions_card_handoff(app, client):
    """A booking made through a typed booking tool runs the native booking's execution, so it
    closes the card's handoff the same way."""
    from .test_typed_booking import TOOL, configured

    copy, visitor = await configured(app, client)
    card = await card_handoff(app, client, copy, visitor)
    decision = await decided(client, visitor, TOOL, {"slot_id": SLOT})
    assert decision.outcome == "allow", decision.reason_plain
    assert (await executed(client, visitor, decision)).state == "succeeded"
    assert [(row.handoff_id, row.status) for row in await handoffs_of(app, copy)] == [(card.handoff_id, "done")]
    entries = await ledger_rows(app, copy)
    assert closing_summaries(entries) == [{"part": "handoffs", "refs": [card.handoff_id], "closed_by": "booking"}]
    assert closed_in_its_execution(entries, decision, card.handoff_id)
    # both hold the session row FOR UPDATE in their execution, as the session's handoff rows need
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        assert (await adapters.resolve(ctx, copy.desk_id, TOOL)).locks_session is True
    assert adapters.ADAPTERS["native.book"].locks_session is True


async def test_a_booking_leaves_a_call_back_open(app, client, reviewer):
    """A call-back promises the visitor a call, which a booking doesn't keep, so it stays open, its
    fact committed, until the owner marks it done."""
    copy, visitor = await visitor_of(app, client)
    requested = await callback(client, visitor)
    await booked(client, reviewer, visitor)
    assert [(row.handoff_id, row.kind, row.status) for row in await handoffs_of(app, copy)] == [
        (requested.model_view["handoff_id"], "callback", "open")]
    [fact] = requested.facts
    assert [row.status for row in await rows_of(app, copy.copy_id, select(Fact).where(
        Fact.fact_id == fact.fact_id))] == ["committed"]
    assert closing_summaries(await ledger_rows(app, copy)) == []


async def test_a_booking_closes_only_its_own_sessions_card_handoff(app, client, reviewer):
    copy, visitor = await visitor_of(app, client)
    card = await card_handoff(app, client, copy, visitor)
    await booked(client, reviewer, await open_visitor(client, copy))
    assert [(row.handoff_id, row.status) for row in await handoffs_of(app, copy)] == [(card.handoff_id, "open")]
    assert closing_summaries(await ledger_rows(app, copy)) == []


@pytest.mark.parametrize("failure", ["slot_changed", "slot_taken"])
async def test_a_booking_that_fails_closes_nothing(app, client, reviewer, monkeypatch, failure):
    """A booking that fails in its execution (the slot moved since the re-check, or another
    session took it) books nothing, so the card's handoff stays open."""
    copy, visitor = await visitor_of(app, client)
    card = await card_handoff(app, client, copy, visitor)
    reviewer.answer = PASS
    decision = await book(client, visitor, SLOT)
    assert decision.outcome == "allow", decision.reason_plain
    if failure == "slot_taken":
        await booked(client, reviewer, await open_visitor(client, copy), call_id="call-other")
    else:
        async def slot_moves() -> None:
            async with kernel_ctx(app) as ctx:
                ctx.bind(copy.copy_id)
                slot = (await ctx.db.scalars(ctx.repo.scoped(select(CalendarSlot).where(
                    CalendarSlot.desk_id == copy.desk_id, CalendarSlot.slot_id == SLOT)))).one()
                slot.starts_at += timedelta(hours=1)

        monkeypatch.setattr(execute, "_after_intent", slot_moves)
    assert (await executed(client, visitor, decision)).state == "failed"
    assert [(row.handoff_id, row.status) for row in await handoffs_of(app, copy)] == [(card.handoff_id, "open")]
    assert closing_summaries(await ledger_rows(app, copy)) == []
    assert visitor.session_id not in {row.session_id for row in await rows_of(app, copy.copy_id, select(Booking))}


# The kernel's status line, the API's signed `STATUS_LINES["check_status"]`.
STATUS_LINE = {"en": "Your request is waiting for approval; you can see where it stands in this chat.",
               "es": "Su solicitud está esperando aprobación; puede consultar su estado en este chat."}
SERVICE_AREA_CLAUSE = ("policy", "charter:policy:service_area")


@pytest.mark.parametrize("cited", [True, False], ids=["policy-card", "no-card"])
@pytest.mark.parametrize(("prose", "soft_answer", "kind", "language"), [
    ("I guarantee it.", None, "promise_word", "en"),
    ("Eso es gratis.", None, "promise_word", "es"),
    (CLEAN, FLAGGED, "soft_promise", "en"),
], ids=["promise-en", "promise-es", "soft-en"])
async def test_a_held_request_shows_the_status_line_when_only_the_prose_is_blocked(app, client, reviewer, prose,
                                                                                  soft_answer, kind, language, cited):
    """While a held request awaits the owner, a final draft blocked only for its prose still gives the visitor
    words: the kept checked cards, if any, then the kernel's status line in the reply's language, in place of the
    call-back offer. No owner handoff opens and no handoff alert goes out."""
    from desk.contracts import RenderedBlock

    from .test_approvals import held_quote

    copy, visitor, _ = await held_quote(app, client)
    if soft_answer is not None:
        reviewer.soft_answer = soft_answer
    alerts_before = len(await handoff_alerts(app, copy))
    verdict = await checked(client, visitor, prose, [clause(*SERVICE_AREA_CLAUSE)] if cited else [])
    assert not verdict.ok and {v.kind for v in verdict.violations} == {kind}
    assert [(block.kind, block.template) for block in verdict.blocks[:-1]] == (
        [("card", "policy")] if cited else [])
    assert verdict.blocks[-1] == RenderedBlock(kind="prose", text=STATUS_LINE[language])
    assert verdict.language == language
    assert await handoffs_of(app, copy) == []
    assert len(await handoff_alerts(app, copy)) == alerts_before
    verify_verdict(await public_key(client), visitor.session_id, verdict)


@pytest.mark.parametrize("cited", [True, False], ids=["policy-card", "no-card"])
@pytest.mark.parametrize("ending", ["none", "answered", "cancelled"])
async def test_without_a_held_request_awaiting_the_owner_a_prose_block_is_unchanged(app, client, cited, ending):
    """With no held request, or one the owner answered or the visitor cancelled, a final draft blocked only for its
    prose keeps its checked cards alone, or, with none, shows the call-back offer, as before."""
    from .test_approvals import held_quote
    from .test_reply_check import assert_kept

    if ending == "none":
        copy, visitor = await visitor_of(app, client)
    else:
        copy, visitor, held = await held_quote(app, client)
        if ending == "answered":
            await answered(client, copy.owner, held.decision_id, "deny_once")
        else:
            assert (await post_cancel(client, visitor, held.decision_id)).status_code == 200
    verdict = await checked(client, visitor, "I guarantee it.", [clause(*SERVICE_AREA_CLAUSE)] if cited else [])
    assert {v.kind for v in verdict.violations} == {"promise_word"}
    if cited:
        assert_kept(verdict, [SERVICE_AREA_CLAUSE])
    else:
        assert_offered(verdict)
    assert await handoffs_of(app, copy) == []


async def test_a_held_request_leaves_a_first_attempt_the_api_rewrites_unshown(app, client):
    """A first attempt blocked only for kinds a rewrite can fix is never shown, held request or not: no blocks."""
    from .test_approvals import held_quote

    copy, visitor, _ = await held_quote(app, client)
    verdict = await checked(client, visitor, "I guarantee it.", [clause(*SERVICE_AREA_CLAUSE)], final=False)
    assert {v.kind for v in verdict.violations} == {"promise_word"}
    assert verdict.blocks == []
    assert await handoffs_of(app, copy) == []


@pytest.mark.parametrize("session", ["checker outage", "drafted handoff"])
async def test_a_held_request_never_replaces_a_handoff(app, client, reviewer, session):
    """A checker outage (`check_unavailable`) hands off, and a handoff clause Claude drafted is honoured, held
    request or not: the handoff card, with no status line."""
    from .test_approvals import held_quote

    copy, visitor, _ = await held_quote(app, client)
    prose, clauses = BLOCKED, []
    if session == "checker outage":
        prose, reviewer.soft_answer = CLEAN, None                 # the soft check gives no verdict
    else:
        clauses = [clause("handoff")]
    verdict = await checked(client, visitor, prose, clauses)
    assert {v.kind for v in verdict.violations} == {"check_unavailable" if session == "checker outage"
                                                    else "number_in_prose"}
    assert_handed_off(verdict)
    assert STATUS_LINE["en"] not in [block.text for block in verdict.blocks]
