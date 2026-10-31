"""An owner's approval never releases private data into a session that no longer stands for its person.

A held action can still be answered once its session has closed (step 6 of "Evaluation"): a take-over,
a breaker pause or the visitor leaving doesn't cancel what the owner was asked. An action that
releases private data is the exception. `native.release_document` gives its link to the person the
session is verified as, so an approval after the owner gave that person another contact, or removed
them, would hand the person's document to whoever verified through the old contact. Such an action
checks its session again, before anything runs: the answer's own re-check, and T2's under the session
row it holds. A session that no longer stands releases nothing; the decision ends
`refused_at_execution` with a plain reason the owner reads. Every adapter declares whether it
releases private data (`releases_private_data`), and an adapter declared not to that returns data
the session reads only as its person fails closed.
"""

import logging

import pytest
from sqlalchemy import select

from desk.contracts import Claim, Fact, Label
from desk.db.models import DocumentLink, Execution, Quote
from desk.db.models import Fact as FactRow
from desk.kernel_service import adapters, execute
from desk.kernel_service.adapters.base import AdapterResult
from desk.kernel_service.seed import RIVERA_CARDS

from .fakes import FakeAdapter
from .helpers import activate_cards, kernel_ctx, ledger_rows, rows_of, verify_session
from .test_adapters import quote_args, rivera
from .test_approvals import add_person, answered
from .test_compiler import card
from .test_decide import decided, desk_with, open_visitor
from .test_desk_writes import updated
from .test_execute import executed
from .test_release_document import DANA, TOOL, confirmed, documents

ASK_FOR_DOCUMENTS = card("ask-docs", TOOL, mode="ask", who="record_owner")
SECRET = "Dana Whitfield, account 4471"                 # what a misdeclared adapter returns


async def held_release(app, client):
    """A Rivera copy whose owner asks before any document goes out, Dana verified in a session, and
    her request for her invoice, held."""
    copy = await rivera(app, client)
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        await activate_cards(ctx, copy.desk_id, [*(c for c in RIVERA_CARDS if c.applies_to != TOOL),
                                                 ASK_FOR_DOCUMENTS])
    dana = await confirmed(client, copy, DANA)
    invoice = (await documents(app, copy))["dana-invoice"]
    held = await decided(client, dana, TOOL, {"document_id": invoice.document_id})
    assert held.state == "held", held.reason_plain
    return copy, dana, held


async def nothing_released(app, copy) -> None:
    assert await rows_of(app, copy.copy_id, select(DocumentLink)) == []
    assert [row.fact_id for row in await rows_of(app, copy.copy_id, select(FactRow).where(
        FactRow.fact_id.like("document_link:%")))] == []


async def test_an_approved_release_for_a_session_closed_by_a_contact_change_releases_nothing(app, client):
    copy, dana, held = await held_release(app, client)
    await updated(client, copy, "people", {"upsert": [{"ref": "dana", "display_name": "Dana Whitfield",
                                                       "contact": "dana.w@example.net"}]})

    result = await answered(client, copy.owner, held.decision_id, "allow_once")

    assert (result.decision.state, result.decision.visitor_plain) == (
        "refused_at_execution", "Not shared: their session ended when their contact changed")
    assert result.execution is None or (result.execution.facts, result.execution.model_view) == ([], {})
    await nothing_released(app, copy)
    refusal = (await ledger_rows(app, copy))[-1].event
    assert (refusal.kind, refusal.summary["state"], refusal.summary["reason"], refusal.summary["check"]) == (
        "approval", "refused_at_execution", "session_ended", "contact_changed")


async def test_an_approved_release_for_a_removed_person_releases_nothing(app, client):
    copy, dana, held = await held_release(app, client)
    await updated(client, copy, "people", {"remove": ["dana"]})

    result = await answered(client, copy.owner, held.decision_id, "allow_once")

    assert (result.decision.state, result.decision.visitor_plain) == (
        "refused_at_execution", "Not shared: they were removed from your records")
    assert result.execution is None or (result.execution.facts, result.execution.model_view) == ([], {})
    await nothing_released(app, copy)
    refusal = (await ledger_rows(app, copy))[-1].event
    assert (refusal.kind, refusal.summary["state"], refusal.summary["reason"], refusal.summary["check"]) == (
        "approval", "refused_at_execution", "session_ended", "person_removed")


async def test_a_session_closed_after_the_answers_intent_releases_nothing(app, client, monkeypatch):
    """The answer's own check passed and its intent committed; the owner then gives Dana another
    contact before T2 takes her session's row. T2 asks again under that row: nothing runs, the
    action is settled refused with the plain reason, as T2's other refusals are."""
    copy, dana, held = await held_release(app, client)

    async def contact_changes() -> None:
        await updated(client, copy, "people", {"upsert": [{"ref": "dana", "display_name": "Dana Whitfield",
                                                           "contact": "dana.w@example.net"}]})

    monkeypatch.setattr(execute, "_after_intent", contact_changes)
    result = await answered(client, copy.owner, held.decision_id, "allow_once")

    assert (result.decision.state, result.decision.visitor_plain) == (
        "refused_at_execution", "Not shared: their session ended when their contact changed")
    assert (result.execution.state, result.execution.facts, result.execution.model_view) == ("failed", [], {})
    await nothing_released(app, copy)
    [execution] = await rows_of(app, copy.copy_id, select(Execution).where(Execution.decision_id == held.decision_id))
    assert execution.state == "failed"
    refusal = [entry.event for entry in await ledger_rows(app, copy) if entry.event.kind == "execute"][-1]
    assert (refusal.summary["state"], refusal.summary["reason"], refusal.summary["check"]) == (
        "refused_at_execution", "session_ended", "contact_changed")


async def test_an_approved_quote_still_runs_for_a_closed_session(app, client):
    """Step 6 is kept for everything else: Dana's discounted quote, held, is approved after her
    session closed for a contact change, and runs."""
    copy = await rivera(app, client)
    dana = await confirmed(client, copy, DANA)
    held = await decided(client, dana, "native.quote", quote_args(("drain", 1), discount_bp=1500))
    assert held.state == "held", held.reason_plain
    await updated(client, copy, "people", {"upsert": [{"ref": "dana", "display_name": "Dana Whitfield",
                                                       "contact": "dana.w@example.net"}]})

    result = await answered(client, copy.owner, held.decision_id, "allow_once")

    assert (result.decision.state, result.execution.state) == ("executed", "succeeded")
    assert len(await rows_of(app, copy.copy_id, select(Quote))) == 1


def test_every_adapter_declares_whether_it_releases_private_data(registry):
    """Each registered adapter says, in its own class, whether its result gives the session data it
    reads only as its person; only the document release does. An adapter that doesn't say isn't
    registered."""
    assert all(isinstance(adapter.__class__.__dict__.get("releases_private_data"), bool)
               for adapter in adapters.ADAPTERS.values()), sorted(
        tool for tool, adapter in adapters.ADAPTERS.items() if "releases_private_data" not in vars(type(adapter)))
    assert {tool for tool, adapter in adapters.ADAPTERS.items() if adapter.releases_private_data} == {TOOL}
    undeclared = FakeAdapter("native.quote")
    del undeclared.releases_private_data
    with pytest.raises(ValueError):
        adapters.register(undeclared, replace=True)
    undecided = FakeAdapter("native.quote")
    undecided.releases_private_data = None
    with pytest.raises(ValueError, match="releases_private_data"):
        adapters.register(undecided, replace=True)


@pytest.mark.parametrize("fact_kind", ["person_only", "document"])
async def test_an_adapter_that_releases_undeclared_private_data_fails_closed(app, client, registry, caplog, fact_kind):
    """An adapter declared not to release private data whose result carries a fact the session reads
    only as its person, or a document's, fails closed: the action is settled failed, nothing is
    delivered, and the log names the tool and the action, never the data."""
    caplog.set_level(logging.INFO, logger="desk.kernel_service")
    quote = FakeAdapter("native.quote")                          # declared not to release private data
    rows = await desk_with(app, [quote], [card("quote", "native.quote")])
    visitor = await open_visitor(client, rows)
    person_id = await add_person(app, rows, "dana", "Dana Whitfield")
    await verify_session(app, rows.copy_id, visitor.session_id, person_id)
    allowed = await decided(client, visitor, "native.quote", {"qty": 1})
    assert allowed.outcome == "allow", allowed.reason_plain
    readers = (["owner", f"person:{person_id}"] if fact_kind == "person_only"
               else ["owner", f"session:{visitor.session_id}"])
    secret = Fact(fact_id="quote:fake-1", kind="quote" if fact_kind == "person_only" else "document",
                  status="available", source="kernel", claims=[Claim(key="title", kind="text", value=SECRET)],
                  label=Label(readers=readers, record_owner=person_id if fact_kind == "person_only" else None))
    quote.script["execute"] = AdapterResult(facts=[secret], model_view={"ok": True})

    result = await executed(client, visitor, allowed)

    assert (result.state, result.facts, result.model_view) == ("failed", [], {})
    [execution] = await rows_of(app, rows.copy_id, select(Execution).where(
        Execution.decision_id == allowed.decision_id))
    assert execution.state == "failed"
    assert await rows_of(app, rows.copy_id, select(FactRow).where(FactRow.fact_id == "quote:fake-1")) == []
    failed = [entry.event for entry in await ledger_rows(app, rows) if entry.event.kind == "execute"][-1]
    assert (failed.summary["state"], failed.summary["reason"]) == ("failed", "undeclared_private_data")
    logged = [record.getMessage() for record in caplog.records]
    assert f"adapter_undeclared_private_data tool=native.quote action_id={allowed.action.action_id}" in logged
    assert not any(SECRET in message for message in logged)
