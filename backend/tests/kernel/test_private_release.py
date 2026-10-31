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
from desk.db.models import Approval, DocumentLink, Execution, Quote
from desk.db.models import Decision as DecisionRow
from desk.db.models import Fact as FactRow
from desk.kernel_service import adapters, execute
from desk.kernel_service.adapters.base import AdapterResult
from desk.kernel_service.seed import RIVERA_CARDS

from .fakes import FakeAdapter
from .helpers import activate_cards, kernel_ctx, ledger_rows, rows_of, verify_session
from .test_adapters import quote_args, rivera
from .test_approvals import add_person, answered
from .test_compiler import card
from .test_decide import decided, desk_with, open_visitor, set_session
from .test_desk_writes import updated
from .test_execute import executed, read
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


# A visitor's status line for an approved release refused because their session ended: the generic line, never the
# owner's reason (that the person was removed or their contact changed), which their session's holder mustn't read.
RULES_CHANGED = "The rules changed, so this didn't go ahead"
OWNER_LINES = ("Not shared", "No se compartió")


async def test_an_approved_release_for_a_session_closed_by_a_contact_change_releases_nothing(app, client):
    copy, dana, held = await held_release(app, client)
    await updated(client, copy, "people", {"upsert": [{"ref": "dana", "display_name": "Dana Whitfield",
                                                       "contact": "dana.w@example.net"}]})

    result = await answered(client, copy.owner, held.decision_id, "allow_once")

    assert (result.decision.state, result.decision.visitor_plain) == (
        "refused_at_execution", RULES_CHANGED)
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
        "refused_at_execution", RULES_CHANGED)
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
        "refused_at_execution", RULES_CHANGED)
    assert (result.execution.state, result.execution.facts, result.execution.model_view) == ("failed", [], {})
    await nothing_released(app, copy)
    [execution] = await rows_of(app, copy.copy_id, select(Execution).where(Execution.decision_id == held.decision_id))
    assert execution.state == "failed"
    refusal = [entry.event for entry in await ledger_rows(app, copy) if entry.event.kind == "execute"][-1]
    assert (refusal.summary["state"], refusal.summary["reason"], refusal.summary["check"]) == (
        "refused_at_execution", "session_ended", "contact_changed")


@pytest.mark.parametrize("change", ["contact", "removal"])
async def test_a_spanish_visitor_sees_the_generic_line_and_no_owner_reason(app, client, change):
    from .helpers import kernel_ctx
    from desk.db.models import ActorSession
    copy, dana, held = await held_release(app, client)
    async with kernel_ctx(app) as ctx:                          # the visitor writes in Spanish
        ctx.bind(copy.copy_id)
        [session] = await ctx.db.scalars(ctx.repo.scoped(select(ActorSession).where(
            ActorSession.session_id == held.session_id)))
        session.last_language = "es"
    if change == "contact":
        await updated(client, copy, "people", {"upsert": [{"ref": "dana", "display_name": "Dana Whitfield",
                                                           "contact": "dana.w@example.net"}]})
    else:
        await updated(client, copy, "people", {"remove": ["dana"]})
    result = await answered(client, copy.owner, held.decision_id, "allow_once")
    assert (result.decision.state, result.decision.visitor_plain) == (
        "refused_at_execution", "Las reglas cambiaron, así que no se hizo")
    assert not any(line in result.decision.visitor_plain for line in OWNER_LINES)


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


def undeclared_fact(fact_kind: str, session_id: str, dana: str, bob: str) -> Fact:
    """A fact an adapter declared not to release private data must never return, for a session
    verified as Dana: one she reads only as her person, a document's, one Bob reads as well as her
    session, or one Bob owns."""
    kind, readers, record_owner = {
        "person_only": ("quote", ["owner", f"person:{dana}"], dana),
        "document": ("document", ["owner", f"session:{session_id}"], None),
        "another_persons": ("quote", ["owner", f"person:{bob}", f"session:{session_id}"], bob),
        "another_persons_record": ("quote", ["owner", f"session:{session_id}"], bob),
    }[fact_kind]
    return Fact(fact_id="quote:fake-1", kind=kind, status="available", source="kernel",
                claims=[Claim(key="title", kind="text", value=SECRET)],
                label=Label(readers=readers, record_owner=record_owner))


@pytest.mark.parametrize("fact_kind", ["person_only", "document", "another_persons", "another_persons_record"])
async def test_an_adapter_that_releases_undeclared_private_data_fails_closed(app, client, registry, caplog, fact_kind):
    """An adapter declared not to release private data whose result carries a fact the session reads
    only as its person, a document's, or one naming another person as a reader or its owner, fails
    closed: the action is settled failed, nothing is delivered, and the log names the tool and the
    action, never the data. Only the session's own verified person may join a fact the session
    reads as itself (as a quote's label does)."""
    caplog.set_level(logging.INFO, logger="desk.kernel_service")
    quote = FakeAdapter("native.quote")                          # declared not to release private data
    rows = await desk_with(app, [quote], [card("quote", "native.quote")])
    visitor = await open_visitor(client, rows)
    person_id = await add_person(app, rows, "dana", "Dana Whitfield")
    bob = await add_person(app, rows, "bob", "Bob Okafor")
    await verify_session(app, rows.copy_id, visitor.session_id, person_id)
    allowed = await decided(client, visitor, "native.quote", {"qty": 1})
    assert allowed.outcome == "allow", allowed.reason_plain
    secret = undeclared_fact(fact_kind, visitor.session_id, person_id, bob)
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


async def test_a_session_may_read_its_own_persons_fact_as_itself(app, client, registry):
    """The one exception the declaration allows: a fact labelled for the session and its own verified
    person, who owns it, as every fact an adapter writes in a verified session is
    (`labels.new_fact_label`). It is delivered."""
    quote = FakeAdapter("native.quote")
    rows = await desk_with(app, [quote], [card("quote", "native.quote")])
    visitor = await open_visitor(client, rows)
    person_id = await add_person(app, rows, "dana", "Dana Whitfield")
    await verify_session(app, rows.copy_id, visitor.session_id, person_id)
    allowed = await decided(client, visitor, "native.quote", {"qty": 1})
    own = Fact(fact_id="quote:own-1", kind="quote", status="available", source="kernel",
               claims=[Claim(key="title", kind="text", value="Drain clearing")],
               label=Label(readers=["owner", f"session:{visitor.session_id}", f"person:{person_id}"],
                           record_owner=person_id))
    quote.script["execute"] = AdapterResult(facts=[own], model_view={"ok": True})

    result = await executed(client, visitor, allowed)

    assert (result.state, [fact.fact_id for fact in result.facts]) == ("succeeded", ["quote:own-1"])


async def verified_fake_desk(app, client, fake: FakeAdapter, cards):
    """A copy whose Desk runs `fake` under `cards`, a visitor verified as Dana on it, and Bob."""
    rows = await desk_with(app, [fake], cards)
    visitor = await open_visitor(client, rows)
    dana = await add_person(app, rows, "dana", "Dana Whitfield")
    bob = await add_person(app, rows, "bob", "Bob Okafor")
    await verify_session(app, rows.copy_id, visitor.session_id, dana)
    return rows, visitor, dana, bob


async def test_a_reconciled_result_with_undeclared_private_data_settles_failed_once(app, client, registry, caplog):
    """An outcome nobody knew, reconciled into a result an adapter declared not to release private
    data mustn't carry (a fact Bob reads): the action settles `failed` with nothing in it, ledgered
    with the reason, and stays settled: the next read asks the adapter nothing."""
    caplog.set_level(logging.INFO, logger="desk.kernel_service")
    quote = FakeAdapter("native.quote")
    rows, visitor, dana, bob = await verified_fake_desk(app, client, quote, [card("quote", "native.quote")])
    allowed = await decided(client, visitor, "native.quote", {"qty": 1})
    quote.script["execute"] = RuntimeError("the provider's answer was lost")
    assert (await executed(client, visitor, allowed)).state == "unknown"
    quote.script["reconcile"] = AdapterResult(facts=[undeclared_fact("another_persons", visitor.session_id, dana, bob)],
                                              model_view={"ok": True})

    first, again = await read(client, rows.owner, allowed), await read(client, rows.owner, allowed)

    assert (first.state, again.state) == ("failed", "failed")
    assert quote.calls.count("reconcile") == 1
    [execution] = await rows_of(app, rows.copy_id, select(Execution).where(
        Execution.decision_id == allowed.decision_id))
    assert (execution.state, execution.result.facts, execution.result.model_view) == ("failed", [], {})
    settled = [entry.event for entry in await ledger_rows(app, rows) if entry.event.kind == "execute"][-1]
    assert (settled.summary["state"], settled.summary["reason"], settled.summary.get("reconciled")) == (
        "failed", "undeclared_private_data", True)
    logged = [record.getMessage() for record in caplog.records]
    assert f"adapter_undeclared_private_data tool=native.quote action_id={allowed.action.action_id}" in logged
    assert not any(SECRET in message for message in logged)


@pytest.mark.parametrize("entry", ["read", "startup", "approved_reconciliation"])
async def test_a_private_result_is_never_recovered_into_a_session_that_ended(app, client, registry, frozen_clock,
                                                                              entry):
    """An approved release whose outcome nobody knew, reconciled after its session closed: the
    reconciliation checks the session as T2 does, holding its row first, and settles the action
    `refused_at_execution` with the plain reason, exposing nothing; the adapter isn't asked. So for a
    read of the decision, startup reconciliation, and the approval form of `/execute`."""
    release = FakeAdapter("native.quote", releases_private_data=True)     # stands in for a private release
    rows, visitor, dana, bob = await verified_fake_desk(app, client, release,
                                                        [card("ask-quote", "native.quote", mode="ask")])
    held = await decided(client, visitor, "native.quote", {"qty": 1})
    assert held.state == "held", held.reason_plain
    release.script["execute"] = RuntimeError("the provider's answer was lost")
    answered_now = await answered(client, rows.owner, held.decision_id, "allow_once")
    assert answered_now.execution.state == "unknown"
    mine = Fact(fact_id="quote:fake-1", kind="quote", status="available", source="kernel",
                claims=[Claim(key="title", kind="text", value=SECRET)],
                label=Label(readers=["owner", f"person:{dana}"], record_owner=dana))
    release.script["reconcile"] = AdapterResult(facts=[mine], model_view={"ok": True})
    await set_session(app, rows, visitor.session_id, closed_at=frozen_clock.now())     # a contact change, say

    if entry == "read":
        await read(client, rows.owner, held)
    elif entry == "startup":
        await execute.reconcile_at_startup(app.state.kernel)
    else:
        [approval] = await rows_of(app, rows.copy_id, select(Approval).where(Approval.decision_id == held.decision_id))
        response = await client.post("/execute", headers=rows.owner, json={
            "decision_id": held.decision_id, "session_id": visitor.session_id, "approval_id": approval.approval_id})
        assert response.status_code == 200, response.text
        assert (response.json()["state"], response.json()["facts"], response.json()["model_view"]) == ("failed", [], {})

    assert "reconcile" not in release.calls
    [decision] = await rows_of(app, rows.copy_id, select(DecisionRow).where(
        DecisionRow.decision_id == held.decision_id))
    assert (decision.state, decision.visitor_plain) == (
        "refused_at_execution", RULES_CHANGED)
    [execution] = await rows_of(app, rows.copy_id, select(Execution).where(Execution.decision_id == held.decision_id))
    assert (execution.state, execution.result.facts, execution.result.model_view) == ("failed", [], {})
    settled = [entry.event for entry in await ledger_rows(app, rows) if entry.event.kind == "execute"][-1]
    assert (settled.summary["state"], settled.summary["reason"], settled.summary["check"],
            settled.summary.get("reconciled")) == ("refused_at_execution", "session_ended", "contact_changed", True)
