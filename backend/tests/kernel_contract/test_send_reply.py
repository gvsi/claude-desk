"""The API's reply path against FakeKernel and the real kernel: `tools.send_reply` sends `CheckReplyRequest.final`.

A first draft the API will rewrite is checked with `final` false. Blocked only for kinds a rewrite fixes
(`desk.rewrites.REWRITABLE`), it is never shown, so the kernel opens no owner handoff and alerts nothing. Blocked for
a kind no rewrite fixes, the API shows the handoff at once, and the kernel opens the owner's handoff for it though the
check wasn't final. These run the API's own `send_reply` and `deliver()` (as desk_api, on the database the kernel's
read-only views are in) against the `kernel` fixture, so `make kernel-contract` runs them against the kernel process
too, as the contract tests run.
"""

from collections.abc import AsyncIterator

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, create_async_engine

from desk.api import tools
from desk.api.kernel_client import CredentialView, KernelHttp
from desk.contracts import CopyCreated, SessionCreated
from desk.db.session import API_CONNECT_OPTIONS, database_url
from tests.kernel_contract.test_contract import (
    BLOCKED_PROSE,
    HANDED_TO_YOU,
    desk_slug,
    ledger_page,
    new_copy,
    new_visitor,
    issue_payment_link,
    item_id,
    session_handoffs,
    turn,
)

REWRITE = "Happy to help with your drain."


@pytest.fixture
async def conn() -> AsyncIterator[AsyncConnection]:
    """One connection as the API process's role (desk_api), for `deliver()`."""
    engine = create_async_engine(database_url("API"), connect_args={"options": API_CONNECT_OPTIONS})
    try:
        async with engine.connect() as connection:
            yield connection
    finally:
        await engine.dispose()


class Recording:
    """A session's kernel view that keeps each reply check's body as the API sent it."""

    def __init__(self, view: CredentialView):
        self.view, self.checks = view, []

    async def call(self, route: str, body=None, **kwargs):
        if route == "POST /check_reply":
            self.checks.append(body.model_dump(mode="json"))
        return await self.view.call(route, body, **kwargs)


def caller_of(http: KernelHttp, ro_schema: str, copy: CopyCreated, created: SessionCreated) -> tools.Caller:
    return tools.Caller(copy_id=copy.copy_id, desk_id=copy.desk_ids[0], session_id=created.state.session_id,
                        kind="visitor", kernel=Recording(http.session(created.session_token)), ro_schema=ro_schema)


async def finals_recorded(http: KernelHttp, copy: CopyCreated, session_id: str) -> list[bool]:
    """`final` as the kernel recorded it on each of the session's reply entries, in order."""
    entries = (await ledger_page(http.owner(copy.owner_token), copy.desk_ids[0])).entries
    return [entry.event.summary["final"] for entry in entries
            if entry.event.kind == "reply" and entry.event.session_id == session_id]


async def handed_to_you(http: KernelHttp, copy: CopyCreated) -> int:
    return sum(entry.body == HANDED_TO_YOU for entry in await http.owner(copy.owner_token).call("GET /demo_inbox"))


async def delivered(conn: AsyncConnection, session_id: str) -> list[list[str | None]]:
    """The templates (None for prose) of each message the API delivered to the session, in order."""
    rows = await conn.execute(text("SELECT blocks FROM app.messages WHERE session_id = :s AND kind = 'delivered'"
                                   " ORDER BY n"), {"s": session_id})
    return [[block.get("template") for block in blocks] for (blocks,) in rows]


@pytest.mark.kernel_plan("01b")
@pytest.mark.parametrize("source", ["api_fallback", "model_clause"])
async def test_a_passing_handoff_clause_is_delivered_as_a_handoff(kernel, ro_read, conn, source):
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    visitor = await new_visitor(http, desk_slug(ro_read, ro_schema, copy))
    caller, session_id = caller_of(http, ro_schema, copy, visitor), visitor.state.session_id
    if source == "api_fallback":
        outcome = await tools.hand_off(conn, caller, 0)
    else:
        outcome = await tools.send_reply(conn, caller, 0, {"prose": "", "clauses": [{"template": "handoff"}]},
                                         1, call_id="toolu_handoff")
    assert outcome.result == {"outcome": "delivered_handoff"}
    assert outcome.delivered == "handoff" and outcome.is_error
    assert await delivered(conn, session_id) == [["handoff"]]
    (payload,) = (await conn.execute(text(
        "SELECT payload FROM app.run_events WHERE session_id = :s AND type = 'message'"), {"s": session_id})).one()
    assert payload["handoff"]
    entries = (await ledger_page(http.owner(copy.owner_token), copy.desk_ids[0])).entries
    assert [entry.event.summary["ok"] for entry in entries
            if entry.event.kind == "reply" and entry.event.session_id == session_id] == [True]
    assert [(kind, status) for _, kind, status in session_handoffs(ro_read, ro_schema, copy, session_id)] == [
        ("card", "open")]
    assert await handed_to_you(http, copy) == 1


@pytest.mark.kernel_plan("01b")
async def test_a_final_prose_failure_delivers_the_kept_card_then_the_drafted_handoff(kernel, ro_read, conn):
    """Only the prose fails on the final check: the checked hours card and, after it, the handoff clause Claude
    drafted are shown as one handoff, which opens the owner's item, with one check and no handoff of the API's own."""
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    visitor = await new_visitor(http, desk_slug(ro_read, ro_schema, copy))
    caller, session_id = caller_of(http, ro_schema, copy, visitor), visitor.state.session_id
    draft = {"prose": "It comes to $89 for the visit.",
             "clauses": [{"template": "hours", "fact_id": "charter:hours"}, {"template": "handoff"}]}
    outcome = await tools.send_reply(conn, caller, 0, draft, 2, call_id="toolu_kept_then_handoff")
    assert outcome.result == {"outcome": "delivered_handoff", "prose_shown": False}
    assert outcome.delivered == "handoff" and outcome.is_error
    assert [check["final"] for check in caller.kernel.checks] == [True]
    assert await delivered(conn, session_id) == [["hours", "handoff"]]
    (payload,) = (await conn.execute(text(
        "SELECT payload FROM app.run_events WHERE session_id = :s AND type = 'message'"), {"s": session_id})).one()
    assert payload["handoff"] and "89" not in str(payload["blocks"])
    assert [(kind, status) for _, kind, status in session_handoffs(ro_read, ro_schema, copy, session_id)] == [
        ("card", "open")]
    assert await handed_to_you(http, copy) == 1


OFFER = {"en": "Would you like me to arrange a callback?", "es": "¿Quiere que solicite una llamada?"}
RECEIPT = {"en": "Reply checked against Mike Turner's rules", "es": "Respuesta revisada con las reglas de Mike Turner"}


@pytest.mark.kernel_plan("01b")
@pytest.mark.parametrize("language", ["en", "es"])
async def test_a_final_prose_failure_with_nothing_to_keep_delivers_the_call_back_offer(kernel, ro_read, conn,
                                                                                      language):
    """Only the prose fails on the final check and no card is kept, on a Desk that offers call backs: the kernel's
    call-back offer is shown as a reply, as kept cards are, not a handoff (the owner's decision of 2026-11-01). The
    delivered event carries no handoff flag, and no owner handoff opens or alerts. Claude reads `delivered` with
    `prose_shown` false, since its own prose wasn't shown, and the offer's words as `shown_instead`, so a visitor's
    "yes" next comes with the question it answers."""
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    visitor = await new_visitor(http, desk_slug(ro_read, ro_schema, copy))
    caller, session_id = caller_of(http, ro_schema, copy, visitor), visitor.state.session_id
    if language == "es":                    # the visitor writes Spanish, so a draft too short to tell speaks it
        assert (await turn(http.session(visitor.session_token), session_id, 0,
                           "Hola, ¿me puede ayudar con una fuga?")).language == "es"
    draft = {"prose": "It comes to $89 for the visit." if language == "en" else "$89.", "clauses": []}
    outcome = await tools.send_reply(conn, caller, 0, draft, 2, call_id="toolu_offer")
    assert outcome.result == {"outcome": "delivered", "message_id": outcome.message_id, "prose_shown": False,
                              "shown_instead": OFFER[language]}
    assert outcome.delivered == "reply" and not outcome.is_error
    assert [check["final"] for check in caller.kernel.checks] == [True]
    assert await delivered(conn, session_id) == [[None]]
    (payload,) = (await conn.execute(text(
        "SELECT payload FROM app.run_events WHERE session_id = :s AND type = 'message'"), {"s": session_id})).one()
    assert not payload["handoff"]
    assert [block["text"] for block in payload["blocks"]] == [OFFER[language]]
    assert payload["visitor_plain"] == RECEIPT[language]
    assert session_handoffs(ro_read, ro_schema, copy, session_id) == []
    assert await handed_to_you(http, copy) == 0


@pytest.mark.kernel_plan("01b")
async def test_a_final_prose_failure_with_a_drafted_handoff_and_nothing_to_keep_hands_off(kernel, ro_read, conn):
    """A handoff clause Claude drafted is honoured when only the prose fails and no card is kept: the handoff card,
    not the call-back offer, as a handoff that opens the owner's item, with no `shown_instead`."""
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    visitor = await new_visitor(http, desk_slug(ro_read, ro_schema, copy))
    caller, session_id = caller_of(http, ro_schema, copy, visitor), visitor.state.session_id
    draft = {"prose": "It comes to $89 for the visit.", "clauses": [{"template": "handoff"}]}
    outcome = await tools.send_reply(conn, caller, 0, draft, 2, call_id="toolu_drafted")
    assert outcome.result == {"outcome": "delivered_handoff", "prose_shown": False}
    assert outcome.delivered == "handoff"
    assert await delivered(conn, session_id) == [["handoff"]]
    assert [(kind, status) for _, kind, status in session_handoffs(ro_read, ro_schema, copy, session_id)] == [
        ("card", "open")]
    assert await handed_to_you(http, copy) == 1


@pytest.mark.kernel_plan("01b")
async def test_a_clause_missing_its_fact_id_is_pointed_at_in_the_correction(kernel, ro_read, conn):
    """A card template sent with no fact ID names no fact in the kernel's violation, so the correction points at the
    clause by its place and template."""
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    visitor = await new_visitor(http, desk_slug(ro_read, ro_schema, copy))
    caller = caller_of(http, ro_schema, copy, visitor)
    outcome = await tools.send_reply(conn, caller, 0, {"prose": "Here are our opening hours.",
                                                       "clauses": [{"template": "hours"}]}, 1, call_id="toolu_no_id")
    assert outcome.result["outcome"] == "blocked"
    assert outcome.result["violations"] == [
        {"kind": "unknown_fact", "rule_id": "no_such_fact", "clause_index": 0, "template": "hours"}]


@pytest.mark.kernel_plan("01b")
async def test_a_rewritten_first_draft_opens_no_handoff_through_the_api(kernel, ro_read, conn):
    """A blocked first draft the API will rewrite is sent with `final` false: it shows nothing, and the kernel records
    it as not final and opens no handoff and no alert. The clean rewrite, sent as final, is what the visitor sees,
    and leaves no handoff either."""
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    visitor = await new_visitor(http, desk_slug(ro_read, ro_schema, copy))
    caller, session_id = caller_of(http, ro_schema, copy, visitor), visitor.state.session_id

    first = await tools.send_reply(conn, caller, 0, {"prose": BLOCKED_PROSE, "clauses": []}, 1)

    assert first.result["outcome"] == "blocked" and first.delivered is None
    assert [check["final"] for check in caller.kernel.checks] == [False]
    assert await finals_recorded(http, copy, session_id) == [False]
    assert session_handoffs(ro_read, ro_schema, copy, session_id) == []
    assert await handed_to_you(http, copy) == 0

    second = await tools.send_reply(conn, caller, 0, {"prose": REWRITE, "clauses": []}, 2)

    assert second.delivered == "reply" and [check["final"] for check in caller.kernel.checks] == [False, True]
    assert await delivered(conn, session_id) == [[None]]   # the rewrite alone: the blocked draft never showed
    assert session_handoffs(ro_read, ro_schema, copy, session_id) == []
    assert await handed_to_you(http, copy) == 0


@pytest.mark.kernel_plan("01b")
async def test_a_first_draft_no_rewrite_fixes_opens_the_handoff_the_visitor_sees(kernel, ro_read, arrange, conn):
    """A first draft blocked for a kind no rewrite fixes (a document's canary) is sent with `final` false, as any first
    attempt with a model call left is, yet the API shows the handoff at once, and the kernel opens one card handoff
    for it and alerts the owner once."""
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    visitor = await new_visitor(http, desk_slug(ro_read, ro_schema, copy))
    caller, session_id = caller_of(http, ro_schema, copy, visitor), visitor.state.session_id
    canary = arrange.canary(copy.copy_id)

    outcome = await tools.send_reply(conn, caller, 0, {"prose": f"Your invoice reference is {canary}.",
                                                       "clauses": []}, 1)

    assert outcome.delivered == "handoff" and outcome.result == {"outcome": "delivered_handoff", "prose_shown": False}
    assert [check["final"] for check in caller.kernel.checks] == [False]
    assert await finals_recorded(http, copy, session_id) == [False]
    assert [(kind, status) for _, kind, status in session_handoffs(ro_read, ro_schema, copy, session_id)] == [
        ("card", "open")]
    assert await handed_to_you(http, copy) == 1
    assert await delivered(conn, session_id) == [["handoff"]]


@pytest.mark.kernel_plan("01c")
async def test_payment_caption_rewrites_through_the_api_and_keeps_final_cards(kernel, ro_read, conn):
    """The combined API/kernel path: one uncertain-language correction, retained checked cards, and a hard control."""
    http, ro_schema, state = kernel
    copy = await new_copy(http)
    visitor = await new_visitor(http, desk_slug(ro_read, ro_schema, copy))
    caller, session_id = caller_of(http, ro_schema, copy, visitor), visitor.state.session_id
    _, issued = await issue_payment_link(http.session(visitor.session_token), session_id,
        item_id(ro_read, ro_schema, copy, "Service call deposit"), 1,
        owner=http.owner(copy.owner_token) if state is None else None)
    clauses = [{"template": "payment_link", "fact_id": issued.facts[0].fact_id}]
    draft = {"prose": "Absolutely. Payment link below.", "clauses": clauses}
    first = await tools.send_reply(conn, caller, 0, draft, 1, call_id="toolu_uncertain")
    assert first.result["delivered"] is False
    assert first.result["violations"] == [{"kind": "uncertain_language", "rule_id": "language_uncertain"}]
    assert await delivered(conn, session_id) == []
    assert session_handoffs(ro_read, ro_schema, copy, session_id) == []

    corrected = await tools.send_reply(conn, caller, 0, {**draft, "prose": "Here is the link to pay."}, 2,
                                       call_id="toolu_corrected")
    assert corrected.result["outcome"] == "delivered" and corrected.delivered == "reply"
    assert "prose_shown" not in corrected.result
    assert [check["final"] for check in caller.kernel.checks] == [False, True]
    final = await tools.send_reply(conn, caller, 0, draft, 2, call_id="toolu_kept")
    assert final.result["outcome"] == "delivered" and final.delivered == "reply" and not final.is_error
    assert final.result["prose_shown"] is False
    assert await delivered(conn, session_id) == [[None, "payment_link"], ["payment_link"]]
    assert session_handoffs(ro_read, ro_schema, copy, session_id) == []
    stored = await conn.execute(text("SELECT payload FROM app.run_events WHERE session_id = :s AND type = 'message'"
                                    " ORDER BY seq"), {"s": session_id})
    assert all(not payload["handoff"] for (payload,) in stored)
    control = await tools.send_reply(conn, caller, 0, {**draft, "prose": "Bonjour, je peux vous aider."}, 1,
                                      call_id="toolu_unsupported")
    assert control.result == {"outcome": "delivered_handoff", "prose_shown": False} and control.delivered == "handoff"
