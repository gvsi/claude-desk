"""An owner's approval never releases private data into a session that no longer stands for its person.

A held action can still be answered once its session has closed (step 6 of "Evaluation"): a take-over,
a breaker pause or the visitor leaving doesn't cancel what the owner was asked. An action that
releases private data is the exception. `native.release_document` gives its link to the person the
session is verified as, so an approval after the owner gave that person another contact, or removed
them, would hand the person's document to whoever verified through the old contact. Such an action
checks its session again, before anything runs: the answer's own re-check, and T2's under the session
row it holds. A session that no longer stands releases nothing; the decision ends
`refused_at_execution` with a plain reason the owner reads. Every adapter declares whether it
releases private data (`releases_private_data`), in step with its profile's `private_data` effect,
and an adapter declared not to that returns data the session reads only as its person is withheld:
what it did stands, since it may have acted outside the kernel, but nothing it returned reaches the
session, now or on a later read.
"""

import json
import logging

import pytest
from sqlalchemy import select

from desk.contracts import Claim, Fact, Label, NormalizedAction
from desk.db.models import Approval, DocumentLink, Execution, PaymentLink, Quote
from desk.db.models import Decision as DecisionRow
from desk.db.models import Fact as FactRow
from desk.kernel_api import SessionContext
from desk.kernel_service import adapters, execute, labels
from desk.kernel_service.adapters.base import AdapterResult, AdapterUnknown, ExecCtx
from desk.kernel_service.seed import RIVERA_CARDS

from .fakes import FakeAdapter
from .helpers import activate_cards, kernel_ctx, ledger_rows, rows_of, verify_session
from .test_adapters import quote_args, rivera
from .test_approvals import add_person, answered
from .test_compiler import card
from .test_context import context_of, fact_ids, owner_session_id
from .test_decide import decided, desk_with, open_visitor, set_session
from .test_desk_writes import updated
from .test_execute import executed, read
from .test_link_completion import PASS as LINK_PASS
from .test_link_completion import rv_link
from .test_payment_links import checkouts, link_for, quoted
from .test_release_document import DANA, TOOL, confirmed, documents

ASK_FOR_DOCUMENTS = card("ask-docs", TOOL, mode="ask", who="record_owner")
SECRET = "Dana Whitfield, account 4471"                 # what a misdeclared adapter returns
QUOTED = "Quoted from Mike Turner's price list"        # the stand-in's executed line, its tool being the quote's
CHECKED = {"policy_version": 1, "auto_money_cap_cents": 50_000}   # the rules a stand-in Desk's step 6 ran under


async def held_release(app, client):
    """A Turner copy whose owner asks before any document goes out, Dana verified in a session, and
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
    assert result.approved is None                    # nothing ran, so the visitor isn't shown it approved
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
    reads only as its person: the document release (a link to the person's document) and the
    connected payments tools (the person's own charges and refunds, labelled for the person alone)
    do; a payment link and a mandate charge (the session's own quote, labelled for the session too)
    and the owner's setup reads don't. An adapter that doesn't say isn't registered."""
    assert all(isinstance(adapter.__class__.__dict__.get("releases_private_data"), bool)
               for adapter in adapters.ADAPTERS.values()), sorted(
        tool for tool, adapter in adapters.ADAPTERS.items() if "releases_private_data" not in vars(type(adapter)))
    assert {tool for tool, adapter in adapters.ADAPTERS.items() if adapter.releases_private_data} == {
        TOOL, "payments.list_charges", "payments.create_refund"}
    undeclared = FakeAdapter("native.quote")
    del undeclared.releases_private_data
    with pytest.raises(ValueError):
        adapters.register(undeclared, replace=True)
    undecided = FakeAdapter("native.quote")
    undecided.releases_private_data = None
    with pytest.raises(ValueError, match="releases_private_data"):
        adapters.register(undecided, replace=True)


@pytest.mark.parametrize(("tool", "effects", "declared"), [
    ("native.quote", ["change"], True),
    ("payments.list_charges", ["private_data"], False),
], ids=["declared_without_the_effect", "effect_without_the_declaration"])
def test_an_adapter_whose_declaration_contradicts_its_profile_is_refused(registry, tool, effects, declared):
    """An adapter's declaration and its profile say the same thing: it releases private data exactly
    when its profile has the `private_data` effect, which the rules decide it by. One that says it
    does with no such effect (a native stand-in), or has the effect and says it doesn't (a connected
    one), isn't registered, and the tool keeps the adapter it had."""
    adapter = FakeAdapter(tool, effects=effects)
    adapter.releases_private_data = declared
    before = adapters.ADAPTERS.get(tool)
    with pytest.raises(ValueError, match=tool):
        adapters.register(adapter, replace=True)
    assert adapters.ADAPTERS.get(tool) is before


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


def stores(fact: Fact):
    """An `execute` or `reconcile` that writes `fact`'s row, as an adapter stores what it made, and
    returns it."""
    async def hook(xctx: ExecCtx, action: NormalizedAction, *args) -> AdapterResult:
        ctx = xctx.ctx
        ctx.db.add(labels.fact_row(action.copy_id, action.desk_id, fact, ctx.clock.now(),
                                   session_id=action.session_id, action_id=action.action_id))
        await ctx.db.flush()
        return AdapterResult(facts=[fact], model_view={"ok": True})
    return hook


async def withheld_everywhere(app, client, rows, visitor, decision, fact: Fact) -> None:
    """Nothing of `fact` reaches the session on a later read: its decision carries the executed line
    and none of the data, and its context leaves the fact out, now narrowed to the owner (its record
    owner kept), whose own context still has it."""
    [row] = await rows_of(app, rows.copy_id, select(FactRow).where(FactRow.fact_id == fact.fact_id))
    assert (row.readers, row.record_owner, row.action_id) == (
        ["owner"], fact.label.record_owner, decision.action.action_id)
    later = await client.get(f"/decisions/{decision.decision_id}", headers=visitor.headers)
    assert later.status_code == 200, later.text
    assert SECRET not in later.text
    assert (later.json()["state"], later.json()["visitor_plain"]) == ("executed", QUOTED)
    seen = await client.get(f"/context/{visitor.session_id}", headers=visitor.headers)
    assert seen.status_code == 200, seen.text
    assert SECRET not in seen.text and fact.fact_id not in fact_ids(SessionContext.model_validate(seen.json()).facts)
    owners = await context_of(client, await owner_session_id(client, rows.owner), rows.owner, desk_id=rows.desk_id)
    assert fact.fact_id in fact_ids(owners.facts)


def logged_by_tool_and_action(caplog, action_id: str) -> None:
    logged = [record.getMessage() for record in caplog.records]
    assert f"adapter_undeclared_private_data tool=native.quote action_id={action_id}" in logged
    assert not any(SECRET in message for message in logged)


@pytest.mark.parametrize("path", ["allow", "approved"])
@pytest.mark.parametrize("fact_kind", ["person_only", "document", "another_persons", "another_persons_record"])
async def test_an_adapter_that_releases_undeclared_private_data_is_withheld(app, client, registry, caplog, fact_kind,
                                                                           path):
    """An adapter declared not to release private data whose result carries a fact the session reads
    only as its person, a document's, or one naming another person as a reader or its owner. What it
    did stands, since it may have acted outside the kernel (a charge made is never recorded as not
    made), but nothing it returned reaches the session: on an allow and an approved hold alike, the
    action is executed with an empty result and the executed line, and no undo runs. The fact row it
    wrote stays, narrowed to the owner, since its labels can't be trusted, so no later read in the
    session shows it; the entry names the violation and how many rows were narrowed; the log names
    the tool and the action, never the data. Only the session's own verified person may join a fact
    the session reads as itself (as a quote's label does)."""
    caplog.set_level(logging.INFO, logger="desk.kernel_service")
    quote = FakeAdapter("native.quote")                          # declared not to release private data
    rule = card("quote", "native.quote") if path == "allow" else card("ask-quote", "native.quote", mode="ask")
    rows, visitor, dana, bob = await verified_fake_desk(app, client, quote, [rule])
    decision = await decided(client, visitor, "native.quote", {"qty": 1})
    secret = undeclared_fact(fact_kind, visitor.session_id, dana, bob)
    quote.script["execute"] = stores(secret)

    if path == "allow":
        assert decision.outcome == "allow", decision.reason_plain
        result = await executed(client, visitor, decision)
    else:
        assert decision.state == "held", decision.reason_plain
        result = (await answered(client, rows.owner, decision.decision_id, "allow_once")).execution

    assert (result.state, result.facts, result.model_view, result.inbox) == ("succeeded", [], {}, [])
    assert "on_failed" not in quote.calls
    [execution] = await rows_of(app, rows.copy_id, select(Execution).where(
        Execution.decision_id == decision.decision_id))
    assert (execution.state, execution.result) == ("succeeded", result)
    await withheld_everywhere(app, client, rows, visitor, decision, secret)
    withheld = [entry.event for entry in await ledger_rows(app, rows) if entry.event.kind == "execute"][-1]
    assert withheld.summary == {"decision_id": decision.decision_id, "action_id": decision.action.action_id,
                                "state": "executed", **CHECKED, "violation": "undeclared_private_data", "narrowed": 1}
    logged_by_tool_and_action(caplog, decision.action.action_id)


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


async def test_a_payment_link_for_a_verified_person_is_the_sessions_own(app, client, reviewer):
    """The payments plan's link adapter, `native.payment_link`, declares that it releases no private
    data, and meets that exception for real: Dana's link, made in her verified session, is labelled
    for that session and for her, its record owner, so the execution that holds it to its word
    lets it through."""
    copy = await rivera(app, client)
    dana = await confirmed(client, copy, DANA)
    link = await rv_link(app, client, reviewer, copy, dana)                  # its execution succeeded
    assert link.customer_id.startswith("person:")
    dana_id = link.customer_id.removeprefix("person:")
    [fact] = await rows_of(app, copy.copy_id, select(FactRow).where(FactRow.fact_id == f"payment_link:{link.link_id}"))
    assert (fact.readers, fact.record_owner) == (["owner", f"session:{dana.session_id}", f"person:{dana_id}"],
                                                 dana_id)


async def test_a_link_for_another_conversations_quote_is_refused_before_anything_is_made(app, client, reviewer):
    """The link adapter makes a link only for one of this conversation's quotes, as its description
    tells Claude, so it never makes one its own declaration would then withhold. Dana, verified,
    gets a deposit quote; verified again in a new conversation, she asks for a link to that quote
    there: refused at step 1, before any checkout or link exists, with `no_such_quote` on its entry,
    nothing withheld and no violation ledgered. In the conversation the quote was made in, it gets
    its link."""
    copy = await rivera(app, client)
    dana = await confirmed(client, copy, DANA)
    quote_id = await quoted(client, dana, ("deposit", 1))
    later = await confirmed(client, copy, DANA)
    refused = await link_for(client, later, quote_id)
    assert (refused.outcome, refused.state, refused.action) == ("refuse", "refused", None), refused.reason_plain
    entries = await ledger_rows(app, copy)
    assert [entry.event.summary for entry in entries if entry.event.kind == "decide"
            and entry.event.session_id == later.session_id and entry.event.summary.get("outcome") == "refuse"] == [
        {"outcome": "refuse", "tool": "native.payment_link", "reason": "adapter_refused", "check": "no_such_quote",
         "policy_version": 1, "auto_money_cap_cents": 50_000}]      # the Turner seed's rules and money cap
    assert not [entry for entry in entries if "violation" in entry.event.summary]
    assert await rows_of(app, copy.copy_id, select(PaymentLink)) == [] and checkouts(copy) == []
    reviewer.answer = LINK_PASS
    own = await link_for(client, dana, quote_id, call_id="call-own")
    assert (own.outcome, own.card_ids) == ("allow", ["rv-link"]), own.reason_plain


async def verified_fake_desk(app, client, fake: FakeAdapter, cards):
    """A copy whose Desk runs `fake` under `cards`, a visitor verified as Dana on it, and Bob."""
    rows = await desk_with(app, [fake], cards)
    visitor = await open_visitor(client, rows)
    dana = await add_person(app, rows, "dana", "Dana Whitfield")
    bob = await add_person(app, rows, "bob", "Bob Okafor")
    await verify_session(app, rows.copy_id, visitor.session_id, dana)
    return rows, visitor, dana, bob


@pytest.mark.parametrize("entry", ["read", "startup"])
async def test_a_reconciled_result_with_undeclared_private_data_is_withheld_once(app, client, registry, caplog,
                                                                                entry):
    """An outcome nobody knew, reconciled on a read or at startup into a result an adapter declared
    not to release private data mustn't carry (a fact Bob reads as well as the session): what the
    adapter says it did stands, but nothing it returned reaches the session. The action is executed
    with an empty result and no undo, the violation and the narrowed count on the reconciled entry,
    and the fact row `reconcile` wrote narrowed to the owner. It stays settled: the next read asks
    the adapter nothing."""
    caplog.set_level(logging.INFO, logger="desk.kernel_service")
    quote = FakeAdapter("native.quote")
    rows, visitor, dana, bob = await verified_fake_desk(app, client, quote, [card("quote", "native.quote")])
    allowed = await decided(client, visitor, "native.quote", {"qty": 1})
    quote.script["execute"] = RuntimeError("the provider's answer was lost")
    assert (await executed(client, visitor, allowed)).state == "unknown"
    secret = undeclared_fact("another_persons", visitor.session_id, dana, bob)
    quote.script["reconcile"] = stores(secret)

    if entry == "startup":
        await execute.reconcile_at_startup(app.state.kernel)
    first, again = await read(client, rows.owner, allowed), await read(client, rows.owner, allowed)

    assert (first.state, again.state) == ("executed", "executed")
    assert quote.calls.count("reconcile") == 1 and "on_failed" not in quote.calls
    [execution] = await rows_of(app, rows.copy_id, select(Execution).where(
        Execution.decision_id == allowed.decision_id))
    assert (execution.state, execution.result.facts, execution.result.model_view, execution.result.inbox) == (
        "succeeded", [], {}, [])
    await withheld_everywhere(app, client, rows, visitor, allowed, secret)
    settled = [entry.event for entry in await ledger_rows(app, rows) if entry.event.kind == "execute"][-1]
    assert settled.summary == {"decision_id": allowed.decision_id, "action_id": allowed.action.action_id,
                               "state": "executed", **CHECKED, "reconciled": True,
                               "violation": "undeclared_private_data", "narrowed": 1}
    logged_by_tool_and_action(caplog, allowed.action.action_id)


async def lost_private_release(app, client):
    """A Desk whose stand-in releases private data, a visitor verified as Dana, and her request,
    held, approved by the owner and lost on the way: its outcome nobody knows (`unknown`)."""
    release = FakeAdapter("native.quote", releases_private_data=True)     # stands in for a private release
    rows, visitor, dana, _ = await verified_fake_desk(app, client, release,
                                                      [card("ask-quote", "native.quote", mode="ask")])
    held = await decided(client, visitor, "native.quote", {"qty": 1})
    assert held.state == "held", held.reason_plain
    release.script["execute"] = RuntimeError("the provider's answer was lost")
    answered_now = await answered(client, rows.owner, held.decision_id, "allow_once")
    assert answered_now.execution.state == "unknown"
    return release, rows, visitor, dana, held


def danas(dana: str) -> Fact:
    """The private result a release that went through returns: a fact Dana reads as her person."""
    return Fact(fact_id="quote:fake-1", kind="quote", status="available", source="kernel",
                claims=[Claim(key="title", kind="text", value=SECRET)],
                label=Label(readers=["owner", f"person:{dana}"], record_owner=dana))


async def recovered_by(app, client, rows, visitor, held, entry: str) -> dict | None:
    """Reconciles the lost release through `entry`: a read of the decision, startup reconciliation,
    or the approval form of `/execute`, whose answer (the stored result) it returns."""
    if entry == "read":
        await read(client, rows.owner, held)
    elif entry == "startup":
        await execute.reconcile_at_startup(app.state.kernel)
    else:
        [approval] = await rows_of(app, rows.copy_id, select(Approval).where(Approval.decision_id == held.decision_id))
        response = await client.post("/execute", headers=rows.owner, json={
            "decision_id": held.decision_id, "session_id": visitor.session_id, "approval_id": approval.approval_id})
        assert response.status_code == 200, response.text
        return response.json()
    return None


@pytest.mark.parametrize("entry", ["read", "startup", "approved_reconciliation"])
async def test_a_private_result_is_never_recovered_into_a_session_that_ended(app, client, registry, frozen_clock,
                                                                              entry):
    """An approved release whose outcome nobody knew, reconciled after its session closed: the
    reconciliation checks the session as T2 does, holding its row first, asks the adapter once,
    which answers that the release never went through, and settles the action
    `refused_at_execution` with the plain reason, exposing nothing. So for a read of the decision,
    startup reconciliation, and the approval form of `/execute`. What a release that did go through
    records instead is `test_a_private_result_recovered_after_its_session_ended_is_withheld`'s."""
    release, rows, visitor, dana, held = await lost_private_release(app, client)
    release.script["reconcile"] = None                                    # the release never went through
    await set_session(app, rows, visitor.session_id, closed_at=frozen_clock.now())     # a contact change, say

    answer = await recovered_by(app, client, rows, visitor, held, entry)

    if answer is not None:
        assert (answer["state"], answer["facts"], answer["model_view"]) == ("failed", [], {})
    assert release.calls.count("reconcile") == 1
    [decision] = await rows_of(app, rows.copy_id, select(DecisionRow).where(
        DecisionRow.decision_id == held.decision_id))
    assert (decision.state, decision.visitor_plain) == (
        "refused_at_execution", RULES_CHANGED)
    [execution] = await rows_of(app, rows.copy_id, select(Execution).where(Execution.decision_id == held.decision_id))
    assert (execution.state, execution.result.facts, execution.result.model_view) == ("failed", [], {})
    settled = [entry.event for entry in await ledger_rows(app, rows) if entry.event.kind == "execute"][-1]
    assert (settled.summary["state"], settled.summary["reason"], settled.summary["check"],
            settled.summary.get("reconciled")) == ("refused_at_execution", "session_ended", "contact_changed", True)


# The decision's state, its visitor line, the execution's state and the entry that settles it, for each answer
# the adapter gives a recovery its session ended for: never why the session ended in the visitor's line.
RECOVERED = {
    "result": ("executed", QUOTED, "succeeded",
               {"state": "executed", "reconciled": True, "withheld": "session_ended", "check": "contact_changed"}),
    "none": ("refused_at_execution", RULES_CHANGED, "failed",
             {"state": "refused_at_execution", "reason": "session_ended", "check": "contact_changed",
              "reconciled": True}),
    "unknown": ("unknown", "Still confirming this", "unknown", {"state": "unknown"}),
}


@pytest.mark.parametrize("entry", ["read", "startup", "approved_reconciliation"])
async def test_a_private_result_recovered_after_its_session_ended_is_withheld(app, client, registry, frozen_clock,
                                                                              entry):
    """The same recovery when the release did go through and the adapter returns Dana's private
    result: on a read, at startup and through the approval form of `/execute` alike, what it did is
    recorded as it happened, `executed` with the executed line and no undo, and nothing it returned
    is delivered: the stored result, and the approval form's answer, hold no facts, an empty
    `model_view` and no inbox notices, and the entry says it was withheld because the session
    ended."""
    release, rows, visitor, dana, held = await lost_private_release(app, client)
    release.script["reconcile"] = AdapterResult(facts=[danas(dana)], model_view={"ok": True})
    await set_session(app, rows, visitor.session_id, closed_at=frozen_clock.now())     # a contact change, say

    answer = await recovered_by(app, client, rows, visitor, held, entry)

    state, line, execution_state, settled = RECOVERED["result"]
    if answer is not None:
        assert (answer["state"], answer["facts"], answer["model_view"], answer["inbox"]) == (
            execution_state, [], {}, [])
        assert SECRET not in json.dumps(answer)
    assert release.calls.count("reconcile") == 1 and "on_failed" not in release.calls
    [decision] = await rows_of(app, rows.copy_id, select(DecisionRow).where(
        DecisionRow.decision_id == held.decision_id))
    assert (decision.state, decision.visitor_plain) == (state, line)
    [execution] = await rows_of(app, rows.copy_id, select(Execution).where(Execution.decision_id == held.decision_id))
    assert (execution.state, execution.result.facts, execution.result.model_view, execution.result.inbox) == (
        execution_state, [], {}, [])
    last = [entry.event for entry in await ledger_rows(app, rows) if entry.event.kind == "execute"][-1]
    assert last.summary == {"decision_id": held.decision_id, "action_id": held.action.action_id, **CHECKED,
                            **settled}


@pytest.mark.parametrize("answer", ["result", "none", "unknown"])
async def test_a_refused_private_recovery_asks_the_adapter_once_and_delivers_nothing(app, client, registry,
                                                                                     frozen_clock, answer):
    """An approved private release whose outcome nobody knew, recovered after its session closed:
    the adapter is asked once what happened, since a release that went through outside the kernel
    must never read as not made, and whatever it answers nothing reaches the session. It went
    through: `executed`, with an empty result and the executed line, no undo, the entry saying it was
    withheld because the session ended, with nothing narrowed. It didn't: undone once, then
    `refused_at_execution` with the plain reason. It can't say: still `unknown`, nothing delivered,
    for the next try."""
    release, rows, visitor, dana, held = await lost_private_release(app, client)
    release.script["reconcile"] = {"result": AdapterResult(facts=[danas(dana)], model_view={"ok": True}),
                                   "none": None, "unknown": AdapterUnknown("the provider can't say yet")}[answer]
    await set_session(app, rows, visitor.session_id, closed_at=frozen_clock.now())     # a contact change, say

    decision = await read(client, rows.owner, held)

    state, line, execution_state, settled = RECOVERED[answer]
    assert release.calls.count("reconcile") == 1
    assert release.calls.count("on_failed") == (1 if answer == "none" else 0)
    assert (decision.state, decision.visitor_plain) == (state, line)
    [execution] = await rows_of(app, rows.copy_id, select(Execution).where(Execution.decision_id == held.decision_id))
    assert (execution.state, execution.result.facts, execution.result.model_view, execution.result.inbox) == (
        execution_state, [], {}, [])
    last = [entry.event for entry in await ledger_rows(app, rows) if entry.event.kind == "execute"][-1]
    assert last.summary == {"decision_id": held.decision_id, "action_id": held.action.action_id, **CHECKED,
                            **settled}
