"""Why an action didn't run, for the owner alone: a decision's `owner_plain`.

A decision refused at execution tells its visitor only the state's generic line (`visitor_plain`).
The owner reads why in `owner_plain`, a kernel line from a fixed table (`render.OWNER_STATUS`) picked
by the refusal's own reason: the person's session ended (their contact changed, they were removed,
or the session closed), the Desk was deleted, the rules changed (the named rule re-checks), or, for
anything else, a line that names no cause. It is the owner's, in the owner's language, and only
the owner's reads carry it: every answer to a session (`/decide`, a session's
`GET /decisions/{id}` and `/decisions/by_call`, `/execute`, cancel) has None, and no ledger entry
holds its text.
"""

import asyncio
import json
from datetime import timedelta
from typing import get_args

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select

from desk.contracts import Decision, DecisionState
from desk.db.models import Decision as DecisionRow
from desk.kernel_service import decide, execute, render
from desk.kernel_service.adapters.base import AdapterRefusal, AdapterResult
from desk.kernel_service.seed import RIVERA_CARDS

from .fakes import FakeAdapter
from .helpers import CopyRows, kernel_ctx, ledger_rows, verify_session
from .test_adapters import Rivera, add_slot, local, quote_args, visitor_of
from .test_agent_auth import mint, open_agent, turn
from .test_approvals import (ASK_QUOTES, ENDINGS, add_person, answered, held_on, held_quote, person_id, post_cancel,
                             public_key)
from .test_compiler import card
from .test_decide import (Visitor, by_call, decided, desk_with, open_visitor, post_decide, set_session,
                          verify_signature)
from .test_desk_writes import updated
from .test_execute import activate, executions_of, post_execute, put_people
from .test_mandates import CARDS, CHARGE, agent_charges, agent_desk, asked, expiry_of, quoted, reservations
from .test_private_release import held_release, nothing_released

OWNER_LINES = {
    "en": {
        "refused_rules_changed": "Your rules changed before this ran, so it wasn't done.",
        "refused_desk_deleted": "This Desk was deleted before this ran, so it wasn't done.",
        "refused_fallback": "This couldn't run, so it wasn't done.",
        "cancelled_by_booking": "The visitor booked before you answered, so this request closed.",
    },
    "es": {
        "refused_rules_changed": "Tus reglas cambiaron antes de que se hiciera, así que no se hizo.",
        "refused_desk_deleted": "Este Desk se eliminó antes de que se hiciera, así que no se hizo.",
        "refused_fallback": "No se pudo hacer, así que no se hizo.",
        "cancelled_by_booking": "El visitante reservó antes de que respondieras, así que esta solicitud se cerró.",
    },
}
SESSION_ENDED = ("refused_contact_changed", "refused_person_removed", "refused_session_closed")


@pytest.mark.parametrize("lang", ["en", "es"])
def test_the_owner_lines_are_owner_only_and_in_both_languages(lang):
    """The rules-changed, Desk-deleted and fallback lines join the session-ended ones in `OWNER_STATUS`,
    with the line for a held request a booking closed, key for key in English and Spanish, and none of
    them is a status line, so no decision's `visitor_plain` can take one."""
    assert render.OWNER_STATUS_KEYS == {*SESSION_ENDED, *OWNER_LINES["en"]}
    assert {key: render.OWNER_STATUS[lang][key] for key in OWNER_LINES[lang]} == OWNER_LINES[lang]
    assert not render.OWNER_STATUS_KEYS & (render.STATUS_KEYS | render.DECISION_STATUS_KEYS)
    for key in render.OWNER_STATUS_KEYS:
        with pytest.raises(KeyError):
            render.status(key, lang, owner="Mike Turner")


def test_an_owner_line_is_in_the_owners_language():
    """The kernel keeps no owner language, so an owner line is English for every owner, through one
    constant an owner-language source will replace; never the session's language."""
    assert render.OWNER_LANGUAGE == "en"
    assert render.owner_line("refused_desk_deleted") == OWNER_LINES["en"]["refused_desk_deleted"]
    with pytest.raises(KeyError):
        render.owner_line("refused")                      # a status line's key is no owner line


@pytest.mark.parametrize(("reason", "check", "key"), [
    ("session_ended", "contact_changed", "refused_contact_changed"),
    ("session_ended", "person_removed", "refused_person_removed"),
    ("session_ended", "session_closed", "refused_session_closed"),
    ("rules_changed", "desk", "refused_desk_deleted"),
    ("session_ended", "desk", "refused_desk_deleted"),
    *[("rules_changed", check, "refused_rules_changed")
      for check in ("tool", "profile", "policy", "pin")],
    ("rules_changed", "session", "refused_fallback"),      # takeover or pause changes no rule
    ("rules_changed", "binding", "refused_fallback"),      # approval binding no longer matches
    ("rules_changed", "conditions", "refused_fallback"),   # same rules, changed runtime inputs
    ("rules_changed", "args", "refused_fallback"),         # normalization may refuse a slot that started
    ("rules_changed", "unavailable", "refused_fallback"),  # a server outage changes no rule
    ("rules_changed", "prepare", "refused_fallback"),      # an adapter's own refusal is no re-check
    ("rules_changed", "closed", "refused_fallback"),       # an allow's session closed before it ran
    ("session_ended", "policy", "refused_fallback"),       # a pairing no path writes
    ("mandate_exhausted", "prepare", "refused_fallback"),
    (None, None, "refused_fallback"),
])
def test_a_refusals_own_reason_picks_the_owner_line(reason, check, key):
    """The refusal's ledgered `reason` and `check` pick the line: a session that ended says how, a
    deleted Desk says so, the named rule re-checks say the rules changed, and anything else names no cause."""
    assert decide.owner_refusal_key(reason, check) == key


# ---- Who reads it -------------------------------------------------------------------------------

GENERIC = {"en": "The rules changed, so this didn't go ahead", "es": "Las reglas cambiaron, así que no se hizo"}
NEVER_QUOTES = [*(c for c in RIVERA_CARDS if c.card_id != "rv-quote"), card("no-quotes", "native.quote", mode="never")]
HELD_QUOTE = quote_args(("drain", 1), discount_bp=1500)        # what `held_quote` asks for


async def owner_read(client: httpx.AsyncClient, owner: dict[str, str], decision_id: str) -> Decision:
    response = await client.get(f"/decisions/{decision_id}", headers=owner)
    assert response.status_code == 200, response.text
    return Decision.model_validate(response.json())


async def assert_owner_only(client: httpx.AsyncClient, visitor: Visitor, decision: Decision, args: dict,
                            line: str, *, lang: str = "en") -> None:
    """Every answer to the decision's own session carries no `owner_plain` and none of its text: its read
    by ID and by call, the same call to `/decide` again (`args` its arguments), which answers with the
    stored decision, then `/execute` and cancel, both refused. Its status line is the state's generic
    one, in the session's language."""
    answers = [await client.get(f"/decisions/{decision.decision_id}", headers=visitor.headers),
               await by_call(client, visitor.session_id, decision.call_id, visitor.headers),
               await post_decide(client, visitor, decision.action.tool, args, call_id=decision.call_id)]
    for response in answers:
        assert response.status_code == 200, response.text
        read = Decision.model_validate(response.json())
        assert (read.decision_id, read.state, read.owner_plain, read.visitor_plain) == (
            decision.decision_id, "refused_at_execution", None, GENERIC[lang])
    refused = [await post_execute(client, visitor, decision), await post_cancel(client, visitor, decision.decision_id)]
    assert [response.status_code for response in refused] == [409, 409]
    for response in (*answers, *refused):
        assert line not in response.text and '"owner_plain":"' not in response.text.replace(" ", ""), response.text


async def assert_not_ledgered(app: FastAPI, rows: Rivera | CopyRows, line: str) -> None:
    """No ledger entry of the Desk holds the owner's line: the entries name the refusal's codes only."""
    summaries = [json.dumps(entry.event.summary, ensure_ascii=False) for entry in await ledger_rows(app, rows)]
    assert summaries and not [summary for summary in summaries if line in summary]


@pytest.mark.parametrize("route", ["id", "by_call", "decide", "execute", "cancel"])
async def test_session_answers_hide_the_owner_line_whatever_the_row_holds(app, client, registry, route):
    quote = FakeAdapter("native.quote")
    rows = await desk_with(app, [quote], ASK_QUOTES)
    visitor, held = await held_on(client, rows)
    line = render.OWNER_STATUS["en"]["refused_contact_changed"]
    async with kernel_ctx(app) as ctx:
        ctx.bind(rows.copy_id)
        row = (await ctx.db.scalars(ctx.repo.scoped(select(DecisionRow).where(
            DecisionRow.decision_id == held.decision_id).with_for_update()))).one()
        await decide.set_state(ctx, row, "refused_at_execution", summary={"reason": "session_ended",
                                                                       "check": "contact_changed"})
        row.owner_plain = line                          # the reader must mask the stored value itself
    if route == "id":
        response = await client.get(f"/decisions/{held.decision_id}", headers=visitor.headers)
    elif route == "by_call":
        response = await by_call(client, visitor.session_id, held.call_id, visitor.headers)
    elif route == "decide":
        response = await post_decide(client, visitor, "native.quote", {"qty": 1}, call_id=held.call_id)
    elif route == "execute":
        response = await post_execute(client, visitor, held)
    else:
        response = await post_cancel(client, visitor, held.decision_id)
    assert response.status_code == (200 if route in {"id", "by_call", "decide"} else 409), response.text
    assert line not in response.text
    if response.status_code == 200:
        assert response.json()["owner_plain"] is None
        assert response.json()["visitor_plain"] == GENERIC["en"]
    assert (await owner_read(client, rows.owner, held.decision_id)).owner_plain == line
    await assert_not_ledgered(app, rows, line)


async def test_signed_agent_answers_never_carry_the_owner_line(app, client, registry, frozen_clock):
    quote = FakeAdapter("native.quote")
    rows = await desk_with(app, [quote], ASK_QUOTES)
    agent = await mint(client, rows.owner, rows.desk_id)
    created = await open_agent(client, rows.slug, agent, frozen_clock)
    signed = turn(agent, rows.slug, created.state.session_id, frozen_clock)
    held = await decided(client, signed, "native.quote", {"qty": 1})
    assert held.state == "held" and held.owner_plain is None
    quote.script["prepare"] = AdapterRefusal("no room")

    result = await answered(client, rows.owner, held.decision_id, "allow_once")

    line = OWNER_LINES["en"]["refused_fallback"]
    assert result.decision.owner_plain == line
    assert (await owner_read(client, rows.owner, held.decision_id)).owner_plain == line
    await assert_owner_only(client, signed, held, {"qty": 1}, line)
    await assert_not_ledgered(app, rows, line)


# ---- Runtime conditions -------------------------------------------------------------------------

@pytest.mark.solver
async def test_an_expired_mandate_on_the_allow_path_names_no_rule_change(desk_prove, app, client, frozen_clock):
    setup = await agent_desk(app, client, frozen_clock)
    frozen_clock.travel(await expiry_of(app, setup) - timedelta(seconds=30))
    signed = setup.turn()
    allowed = await asked(client, signed, CHARGE, await quoted(client, signed))
    assert allowed.outcome == "allow"
    frozen_clock.advance(31)

    response = await post_execute(client, signed, allowed)

    assert response.status_code == 409, response.text
    refused = await owner_read(client, setup.desk.owner, allowed.decision_id)
    assert refused.state == "refused_at_execution"
    entries = [entry.event.summary for entry in await ledger_rows(app, setup.desk)
               if entry.event.ref_id == allowed.decision_id and entry.event.kind == "execute"]
    assert entries[-1]["check"] == "conditions"
    assert entries[-1]["policy_version"] == allowed.policy_version
    line = OWNER_LINES["en"]["refused_fallback"]
    assert refused.owner_plain == line
    assert await reservations(app, setup.desk.copy_id) == []
    assert agent_charges(setup.desk.copy_id) == []
    await assert_owner_only(client, signed, allowed, {"quote_id": allowed.action.resource.id}, line)
    await assert_not_ledgered(app, setup.desk, line)


@pytest.mark.solver
async def test_an_expired_mandate_on_the_approval_path_names_no_rule_change(desk_prove, app, client, frozen_clock):
    cards = [card.model_copy(update={"mode": "ask", "max_amount_cents": None})
             if card.applies_to == CHARGE else card for card in CARDS]
    setup = await agent_desk(app, client, frozen_clock, cards=cards)
    frozen_clock.travel(await expiry_of(app, setup) - timedelta(seconds=30))
    signed = setup.turn()
    held = await asked(client, signed, CHARGE, await quoted(client, signed))
    assert held.outcome == "hold"
    frozen_clock.advance(31)

    result = await answered(client, setup.desk.owner, held.decision_id, "allow_once")

    assert (result.decision.state, result.execution) == ("refused_at_execution", None)
    entries = [entry.event.summary for entry in await ledger_rows(app, setup.desk)
               if entry.event.ref_id == held.decision_id and entry.event.kind == "approval"]
    assert entries[-1]["check"] == "conditions"
    line = OWNER_LINES["en"]["refused_fallback"]
    assert result.decision.owner_plain == line
    assert await owner_read(client, setup.desk.owner, held.decision_id) == result.decision
    assert await reservations(app, setup.desk.copy_id) == []
    assert agent_charges(setup.desk.copy_id) == []
    await assert_owner_only(client, signed, held, {"quote_id": held.action.resource.id}, line)
    await assert_not_ledgered(app, setup.desk, line)


# ---- The approval path ---------------------------------------------------------------------------

async def test_an_approval_the_new_rules_refuse_tells_the_owner_the_rules_changed(app, client):
    """Mike stops quotes after a stranger's discounted quote was held, then allows it: the answer
    and his read of the decision say his rules changed; the stranger's session reads the generic
    line and nothing of his, and the signature, which leaves `owner_plain` out, still verifies."""
    copy, visitor, held = await held_quote(app, client)
    await activate(app, copy, NEVER_QUOTES)
    line = OWNER_LINES["en"]["refused_rules_changed"]

    result = await answered(client, copy.owner, held.decision_id, "allow_once")

    assert (result.decision.state, result.decision.owner_plain, result.decision.visitor_plain) == (
        "refused_at_execution", line, GENERIC["en"])
    entries = [entry.event.summary for entry in await ledger_rows(app, copy)
               if entry.event.ref_id == held.decision_id and entry.event.kind == "approval"]
    assert entries[-1]["check"] == "policy"
    assert await owner_read(client, copy.owner, held.decision_id) == result.decision
    verify_signature(await public_key(client), result.decision)
    await assert_owner_only(client, visitor, held, HELD_QUOTE, line)
    await assert_not_ledgered(app, copy, line)


async def delete_desk(client: httpx.AsyncClient, rows: Rivera | CopyRows) -> None:
    response = await client.delete(f"/desks/{rows.desk_id}", headers=rows.owner)
    assert response.status_code == 204, response.text


async def test_an_approval_after_the_desk_was_deleted_tells_the_owner_so(app, client):
    """The Desk is deleted while a quote waits, then Mike allows it: the answer's re-check finds the
    Desk gone, and his answer and read say the Desk was deleted."""
    copy, visitor, held = await held_quote(app, client)
    await delete_desk(client, copy)
    line = OWNER_LINES["en"]["refused_desk_deleted"]

    result = await answered(client, copy.owner, held.decision_id, "allow_once")

    assert (result.decision.state, result.decision.owner_plain) == ("refused_at_execution", line)
    assert (await owner_read(client, copy.owner, held.decision_id)).owner_plain == line
    await assert_not_ledgered(app, copy, line)


async def test_an_approval_whose_desk_goes_after_its_intent_tells_the_owner_so(app, client, registry, monkeypatch):
    """The Desk is deleted after the answer committed its intent and before the side effect: T2
    finds it gone, and the answer says the Desk was deleted."""
    quote = FakeAdapter("native.quote")
    rows = await desk_with(app, [quote], ASK_QUOTES)
    visitor, held = await held_on(client, rows)
    monkeypatch.setattr(execute, "_after_intent", lambda: delete_desk(client, rows))
    line = OWNER_LINES["en"]["refused_desk_deleted"]

    result = await answered(client, rows.owner, held.decision_id, "allow_once")

    assert (result.decision.state, result.execution.state, result.decision.owner_plain) == (
        "refused_at_execution", "failed", line)
    assert "execute" not in quote.calls
    assert (await owner_read(client, rows.owner, held.decision_id)).owner_plain == line
    await assert_not_ledgered(app, rows, line)


async def test_an_approval_its_adapter_refuses_names_no_cause(app, client, registry):
    """The adapter's own `prepare` refuses the approved action (a reservation it can't make): no
    rule changed, so the owner's line names no cause; the session still reads the generic line."""
    quote = FakeAdapter("native.quote")
    quote.script["prepare"] = AdapterRefusal("no room")
    rows = await desk_with(app, [quote], ASK_QUOTES)
    visitor, held = await held_on(client, rows)
    line = OWNER_LINES["en"]["refused_fallback"]

    result = await answered(client, rows.owner, held.decision_id, "allow_once")

    assert (result.decision.state, result.execution, result.decision.owner_plain) == (
        "refused_at_execution", None, line)
    assert (await owner_read(client, rows.owner, held.decision_id)).owner_plain == line
    await assert_owner_only(client, visitor, held, {"qty": 1}, line)
    await assert_not_ledgered(app, rows, line)


@pytest.mark.parametrize("change", ["contact", "removal"])
async def test_an_approved_release_whose_person_moved_on_tells_the_owner_why(app, client, change):
    """Dana's held invoice is approved after the owner gave her another contact, or removed her: nothing
    is released, the owner reads why her session ended, and her session's line is the generic one."""
    copy, dana, held = await held_release(app, client)
    if change == "contact":
        await updated(client, copy, "people", {"upsert": [{"ref": "dana", "display_name": "Dana Whitfield",
                                                           "contact": "dana.w@example.net"}]})
    else:
        await updated(client, copy, "people", {"remove": ["dana"]})
    key = "refused_contact_changed" if change == "contact" else "refused_person_removed"
    line = render.OWNER_STATUS["en"][key]

    result = await answered(client, copy.owner, held.decision_id, "allow_once")

    assert (result.decision.state, result.decision.owner_plain, result.decision.visitor_plain) == (
        "refused_at_execution", line, GENERIC["en"])
    assert (await owner_read(client, copy.owner, held.decision_id)).owner_plain == line
    await nothing_released(app, copy)
    await assert_not_ledgered(app, copy, line)


async def test_an_approved_release_for_a_closed_session_tells_the_owner_it_ended(app, client, registry,
                                                                                 frozen_clock):
    """A private release held for a session that names no person, which then closes: the answer's
    check finds the session ended, and the owner reads that it ended before her answer."""
    release = FakeAdapter("native.quote", releases_private_data=True)       # stands in for a private release
    rows = await desk_with(app, [release], ASK_QUOTES)
    visitor, held = await held_on(client, rows)
    await set_session(app, rows, visitor.session_id, closed_at=frozen_clock.now())
    line = render.OWNER_STATUS["en"]["refused_session_closed"]

    result = await answered(client, rows.owner, held.decision_id, "allow_once")

    assert (result.decision.state, result.decision.owner_plain) == ("refused_at_execution", line)
    assert "prepare" not in release.calls and "execute" not in release.calls
    assert (await owner_read(client, rows.owner, held.decision_id)).owner_plain == line


async def test_an_approved_release_whose_session_ends_after_its_intent_tells_the_owner_why(app, client,
                                                                                           monkeypatch):
    """Dana's contact changes after the answer committed its intent: T2 asks again under her session's
    row, releases nothing, and the owner reads that her contact changed."""
    copy, dana, held = await held_release(app, client)

    async def contact_changes() -> None:
        await updated(client, copy, "people", {"upsert": [{"ref": "dana", "display_name": "Dana Whitfield",
                                                           "contact": "dana.w@example.net"}]})

    monkeypatch.setattr(execute, "_after_intent", contact_changes)
    line = render.OWNER_STATUS["en"]["refused_contact_changed"]

    result = await answered(client, copy.owner, held.decision_id, "allow_once")

    assert (result.decision.state, result.execution.state, result.decision.owner_plain) == (
        "refused_at_execution", "failed", line)
    assert (await owner_read(client, copy.owner, held.decision_id)).owner_plain == line
    await nothing_released(app, copy)
    await assert_not_ledgered(app, copy, line)


async def test_a_spanish_visitor_reads_the_generic_line_while_the_owner_reads_english(app, client):
    """The visitor writes in Spanish: their status line is the Spanish generic one, while the owner's
    line stays in the owner's language, never the session's."""
    copy, visitor, held = await held_quote(app, client)
    await set_session(app, copy, visitor.session_id, last_language="es")
    await activate(app, copy, NEVER_QUOTES)
    line = OWNER_LINES["en"]["refused_rules_changed"]

    result = await answered(client, copy.owner, held.decision_id, "allow_once")

    assert (result.decision.owner_plain, result.decision.visitor_plain) == (line, GENERIC["es"])
    await assert_owner_only(client, visitor, held, HELD_QUOTE, line, lang="es")
    await assert_owner_only(client, visitor, held, HELD_QUOTE, OWNER_LINES["es"]["refused_rules_changed"], lang="es")


async def test_a_held_booking_whose_slot_started_names_no_cause(app, client, frozen_clock):
    """The slot starts while approval is pending, without any rule change. The adapter refuses
    normalization at the `args` re-check, and the owner's answer and later read name no cause."""
    copy, visitor = await visitor_of(app, client)
    await activate(app, copy, [card("ask-book", "native.book", mode="ask")])
    slot_id = "S-20261030-1100"
    await add_slot(app, copy, slot_id)
    held = await decided(client, visitor, "native.book", {"slot_id": slot_id})
    assert held.state == "held"
    frozen_clock.travel(local(slot_id))

    result = await answered(client, copy.owner, held.decision_id, "allow_once")

    line = OWNER_LINES["en"]["refused_fallback"]
    assert (result.decision.state, result.decision.owner_plain, result.execution) == (
        "refused_at_execution", line, None)
    read = await owner_read(client, copy.owner, held.decision_id)
    assert (read.state, read.owner_plain) == ("refused_at_execution", line)
    [refusal] = [entry.event for entry in await ledger_rows(app, copy)
                 if entry.event.summary.get("state") == "refused_at_execution"]
    assert (refusal.summary["reason"], refusal.summary["check"]) == ("rules_changed", "args")
    assert await executions_of(app, copy.copy_id) == []


# ---- The allow path ------------------------------------------------------------------------------


async def test_an_allow_the_new_rules_refuse_tells_the_owner_the_rules_changed(app, client):
    """Mike stops quotes between a stranger's allowed quote and its execution: `/execute` is refused,
    and only his read says his rules changed."""
    copy, visitor = await visitor_of(app, client)
    args = quote_args(("drain", 1))
    allowed = await decided(client, visitor, "native.quote", args)
    await activate(app, copy, NEVER_QUOTES)
    line = OWNER_LINES["en"]["refused_rules_changed"]

    response = await post_execute(client, visitor, allowed)

    assert (response.status_code, response.json()) == (409, {"code": "conflict"})
    read = await owner_read(client, copy.owner, allowed.decision_id)
    assert (read.state, read.owner_plain, read.visitor_plain) == ("refused_at_execution", line, GENERIC["en"])
    entries = [entry.event.summary for entry in await ledger_rows(app, copy)
               if entry.event.ref_id == allowed.decision_id and entry.event.kind == "execute"]
    assert entries[-1]["check"] == "policy"
    assert entries[-1]["policy_version"] != allowed.policy_version
    verify_signature(await public_key(client), read)
    await assert_owner_only(client, visitor, allowed, args, line)
    await assert_not_ledgered(app, copy, line)


async def test_an_allow_whose_desk_goes_after_its_intent_tells_the_owner_so(app, client, registry, monkeypatch):
    """The Desk is deleted after an allow's intent and before its side effect: T2 finds it gone, nothing
    runs, and the owner's read says the Desk was deleted."""
    quote = FakeAdapter("native.quote")
    rows = await desk_with(app, [quote], [card("quote", "native.quote")])
    visitor = await open_visitor(client, rows)
    allowed = await decided(client, visitor, "native.quote", {"qty": 1})
    assert allowed.outcome == "allow", allowed.reason_plain
    monkeypatch.setattr(execute, "_after_intent", lambda: delete_desk(client, rows))
    line = OWNER_LINES["en"]["refused_desk_deleted"]

    response = await post_execute(client, visitor, allowed)

    assert (response.status_code, response.json()) == (409, {"code": "conflict"})
    assert "execute" not in quote.calls
    read = await owner_read(client, rows.owner, allowed.decision_id)
    assert (read.state, read.owner_plain) == ("refused_at_execution", line)
    await assert_not_ledgered(app, rows, line)


@pytest.mark.parametrize("cause", ["prepare", "session_closed"])
async def test_an_allow_stopped_by_no_rule_names_no_cause(app, client, registry, monkeypatch, cause):
    """An allow that no rule stopped: its adapter's `prepare` refuses, or its session closes after the
    intent (Dana, whom it was verified as, removed). The owner's line names no cause."""
    quote = FakeAdapter("native.quote")
    rows = await desk_with(app, [quote], [card("quote", "native.quote")])
    visitor = await open_visitor(client, rows)
    if cause == "prepare":
        quote.script["prepare"] = AdapterRefusal("no room")
    else:
        await put_people(client, rows, {"upsert": [{"ref": "dana", "display_name": "Dana Whitfield",
                                                    "contact": "dana@example.com"}]})
        await verify_session(app, rows.copy_id, visitor.session_id, await person_id(app, rows, "dana"))
        monkeypatch.setattr(execute, "_after_intent", lambda: put_people(client, rows, {"remove": ["dana"]}))
    allowed = await decided(client, visitor, "native.quote", {"qty": 1})
    assert allowed.outcome == "allow", allowed.reason_plain
    line = OWNER_LINES["en"]["refused_fallback"]

    response = await post_execute(client, visitor, allowed)

    assert response.status_code == 409 and line not in response.text
    read = await owner_read(client, rows.owner, allowed.decision_id)
    assert (read.state, read.owner_plain, read.visitor_plain) == ("refused_at_execution", line, GENERIC["en"])
    if cause == "prepare":
        await assert_owner_only(client, visitor, allowed, {"qty": 1}, line)
    await assert_not_ledgered(app, rows, line)


# ---- Reconciliation ------------------------------------------------------------------------------

async def unknown_release(app: FastAPI, client: httpx.AsyncClient) -> tuple[FakeAdapter, CopyRows, Visitor, Decision]:
    """A private release, held for a visitor verified as Dana and approved, whose outcome nobody knew."""
    release = FakeAdapter("native.quote", releases_private_data=True)       # stands in for a private release
    rows = await desk_with(app, [release], [card("ask-quote", "native.quote", mode="ask")])
    visitor = await open_visitor(client, rows)
    await verify_session(app, rows.copy_id, visitor.session_id, await add_person(app, rows, "dana", "Dana Whitfield"))
    visitor, held = await held_on(client, rows, visitor=visitor)
    release.script["execute"] = RuntimeError("the provider's answer was lost")
    assert (await answered(client, rows.owner, held.decision_id, "allow_once")).execution.state == "unknown"
    return release, rows, visitor, held


@pytest.mark.parametrize("ended", ["contact_changed", "desk_deleted"])
async def test_a_release_recovered_after_its_session_ended_tells_the_owner_why(app, client, registry, frozen_clock,
                                                                              ended):
    """Reconciliation finds the session of an approved release whose outcome nobody knew no longer
    standing: its contact changed (closed with Dana still on record), or its Desk was deleted. The
    adapter confirms nothing ran, and the owner's read says why the release was refused."""
    release, rows, visitor, held = await unknown_release(app, client)
    if ended == "contact_changed":
        await set_session(app, rows, visitor.session_id, closed_at=frozen_clock.now())
        line = render.OWNER_STATUS["en"]["refused_contact_changed"]
    else:
        await delete_desk(client, rows)
        line = OWNER_LINES["en"]["refused_desk_deleted"]

    read = await owner_read(client, rows.owner, held.decision_id)

    assert "reconcile" in release.calls and "on_failed" in release.calls
    assert (read.state, read.owner_plain, read.visitor_plain) == ("refused_at_execution", line, GENERIC["en"])
    await assert_not_ledgered(app, rows, line)


@pytest.mark.parametrize("ran", [False, True])
async def test_a_private_action_recovered_after_desk_deletion_records_the_desk_check(app, client, registry, ran):
    """Recovery records `desk` whether the adapter ran (withheld) or not (refused with the
    Desk-deleted owner line). A completed action has no refusal line, even when withheld."""
    release, rows, _, held = await unknown_release(app, client)
    release.script["reconcile"] = AdapterResult(model_view={"ok": True}) if ran else None
    await delete_desk(client, rows)

    read = await owner_read(client, rows.owner, held.decision_id)

    [recovered] = [entry.event for entry in await ledger_rows(app, rows)
                   if entry.event.summary.get("reconciled") and entry.event.ref_id == held.decision_id]
    assert recovered.summary["check"] == "desk"
    if ran:
        assert recovered.summary["withheld"] == "session_ended"
        assert (read.state, read.owner_plain) == ("executed", None)
        assert "on_failed" not in release.calls
    else:
        assert (read.state, read.owner_plain) == (
            "refused_at_execution", OWNER_LINES["en"]["refused_desk_deleted"])
        assert "on_failed" in release.calls


# ---- Every other state ---------------------------------------------------------------------------


async def in_state(client: httpx.AsyncClient, rows: CopyRows, quote: FakeAdapter, visitor: Visitor, held: Decision,
                   frozen_clock, state: str) -> Decision:
    """A decision of `visitor`'s on `rows`' Desk moved to `state` (`held` is `held` itself), as the
    owner's read gives it. `approved` is read while its action runs."""
    if state == "approved":
        running, release = asyncio.Event(), asyncio.Event()

        async def run(xctx, action, args) -> AdapterResult:
            running.set()
            await release.wait()
            return AdapterResult(model_view={"ok": True})

        quote.script["execute"] = run
        answering = asyncio.create_task(client.post(f"/approvals/{held.decision_id}/answer", headers=rows.owner,
                                                    json={"answer": "allow_once"}))
        try:
            await asyncio.wait_for(running.wait(), 10)
            decision = await owner_read(client, rows.owner, held.decision_id)
        finally:
            release.set()                                       # never left holding the decision row
        assert (await asyncio.wait_for(answering, 10)).status_code == 200
        return decision
    if state == "allowed":
        decision = await decided(client, visitor, "native.find_slots", call_id="call-2")
    elif state == "refused":
        decision = await decided(client, visitor, "native.transfer_funds", call_id="call-2")
    elif state == "expired":
        frozen_clock.advance(24 * 3600)
        decision = held
    elif state == "cancelled":
        response = await post_cancel(client, visitor, held.decision_id)
        assert response.status_code == 200, response.text
        decision = held
    elif state in ("denied", "executed", "failed", "unknown", "refused_at_execution"):
        quote.script.update(ENDINGS.get(state, {}))
        answer = "deny_once" if state == "denied" else "allow_once"
        decision = (await answered(client, rows.owner, held.decision_id, answer)).decision
    else:
        decision = held
    return await owner_read(client, rows.owner, decision.decision_id)


@pytest.mark.parametrize("state", get_args(DecisionState))
async def test_only_a_refusal_at_execution_carries_an_owner_line(app, client, registry, frozen_clock, state):
    """The owner's read of a decision in any other state, a request the visitor cancelled included, has no
    owner line; a refusal at execution's has one (here its adapter refused, so it names no cause), and the
    session's reads never do. A held request a booking closed is `cancelled` with a line of its own
    (`test_approvals`)."""
    quote, slots = FakeAdapter("native.quote"), FakeAdapter("native.find_slots", effects=["read"])
    rows = await desk_with(app, [quote, slots], [*ASK_QUOTES, card("slots", "native.find_slots")])
    visitor, held = await held_on(client, rows)

    decision = await in_state(client, rows, quote, visitor, held, frozen_clock, state)

    expected = render.owner_line("refused_fallback") if state == "refused_at_execution" else None
    assert (decision.state, decision.owner_plain) == (state, expected)
    response = await client.get(f"/decisions/{decision.decision_id}", headers=visitor.headers)
    assert response.status_code == 200 and response.json()["owner_plain"] is None, response.text
