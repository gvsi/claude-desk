"""The lead, callback and verification tools, and the owner closing a handoff.

`native.capture_lead` saves a visitor's name, contact and note for the owner; `native.request_callback`
saves a handoff with the next open hour of the Desk's hours as its window, never one the call
names; `native.start_verification` runs `/verify/start` for an unverified session and tells Claude
nothing about whether the contact is on record. Tests run on Rivera Plumbing copies as `POST
/copies` seeds them (Friday 10:04 in Oakland), with calls decided and executed through `/decide`
and `/execute` as the API sends them; the starter preset's cards auto-allow all three tools.
"""

import asyncio
import contextlib
import logging
from datetime import UTC, datetime, time
from zoneinfo import ZoneInfo

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select

from desk.contracts import Claim, Decision, DemoInboxEntry, ExecResult, HoursWindow
from desk.db.models import Desk, Fact, Handoff, Lead, LedgerEntry, NotificationPref, Person, VerificationChallenge
from desk.kernel_api import DeskUpdated
from desk.kernel_service import adapters, compiler, desks, verification
from desk.kernel_service.desks import mask_contact

from .helpers import kernel_ctx, ledger_rows, rows_of, verify_session
from .test_adapters import Rivera, objects, rivera, run, visitor_of
from .test_context import context_of, tools
from .test_decide import Visitor, decided, open_visitor, post_decide
from .test_execute import executed, post_execute
from .test_reply_check import checked, clause
from .test_verification import api_rows, check, code_in, session_inbox

TOOLS = ("native.capture_lead", "native.request_callback", "native.start_verification")
TZ = ZoneInfo("America/Los_Angeles")
CALLBACK = {"name": "Sam Lee", "contact": "(510) 555-0100", "reason": "The water heater is leaking"}


async def alert_now(app: FastAPI, copy: Rivera, *kinds: str) -> None:
    """The owner wants these alerts at once rather than in the briefing."""
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        prefs = (await ctx.db.scalars(ctx.repo.scoped(select(NotificationPref)))).one()
        prefs.now = [*prefs.now, *kinds]


async def owner_alerts(client: httpx.AsyncClient, copy: Rivera) -> list[DemoInboxEntry]:
    response = await client.get("/demo_inbox", headers=copy.owner)
    assert response.status_code == 200, response.text
    return [entry for entry in map(DemoInboxEntry.model_validate, response.json()) if entry.kind == "alert"]


async def test_lead_capture_saves_a_lead(app, client):
    copy, visitor = await visitor_of(app, client)
    await alert_now(app, copy, "lead")
    decision = await decided(client, visitor, "native.capture_lead", {
        "name": "Sam Lee", "contact": "sam@example.com", "note": "Wants a quote for a kitchen remodel"})
    assert (decision.outcome, decision.card_ids) == ("allow", ["preset-capture-lead"]), decision.reason_plain
    assert decision.action.resource.kind == "desk"
    # the owner reads what the visitor typed as quoted text, never as an instruction
    assert decision.reason_plain.endswith("From the visitor: “sam@example.com”. From the visitor: “Sam Lee”. "
                                          "From the visitor: “Wants a quote for a kitchen remodel”.")
    seeded = await owner_alerts(client, copy)                # the seeded hold's approval alert
    result = await executed(client, visitor, decision)

    [lead] = await rows_of(app, copy.copy_id, select(Lead))
    assert (result.state, result.facts, result.model_view) == ("succeeded", [], {"lead_id": lead.lead_id,
                                                                                  "saved": True})
    assert result.inbox == []                                # owner alerts are read only from the Demo inbox
    # the note carries the contact the visitor gave, for the owner to follow up
    assert api_rows(copy.copy_id, "SELECT session_id, display_name, note FROM kernel_ro.leads") == [
        (visitor.session_id, "Sam Lee", "Wants a quote for a kitchen remodel · sam@example.com")]
    [alert] = [entry for entry in await owner_alerts(client, copy) if entry not in seeded]
    assert (alert.to, alert.body) == (
        "owner", "From the visitor: “Sam Lee · sam@example.com · Wants a quote for a kitchen remodel”.")

    # a name alone is a lead too; a contact without a note is the note
    for call_id, args, note in (("call-2", {"name": "Ana"}, None),
                                ("call-3", {"name": "Bo", "contact": "(510) 555-0100"}, "(510) 555-0100")):
        await executed(client, visitor, await decided(client, visitor, "native.capture_lead", args, call_id=call_id))
        assert (args["name"], note) in [(name, saved) for _, name, saved in api_rows(
            copy.copy_id, "SELECT session_id, display_name, note FROM kernel_ro.leads")]

    # args the tool doesn't take are refused before any action exists
    for call_id, args in (("call-4", {}), ("call-5", {"name": ""}), ("call-6", {"name": "x" * 81}),
                          ("call-7", {"name": "Sam", "note": "x" * 201}),
                          ("call-8", {"name": "Sam", "contact": "x" * 121}),
                          ("call-9", {"name": "Sam", "email": "sam@example.com"})):
        refused = await decided(client, visitor, "native.capture_lead", args, call_id=call_id)
        assert (refused.outcome, refused.action) == ("refuse", None), args

    # all three tools publish closed input schemas whose effects are the ones Cedar groups them under
    actions = compiler.desk_schema([])[""]["actions"]
    for tool in TOOLS:
        adapter = adapters.ADAPTERS[tool]
        profile = adapter.profile
        assert profile.input_schema == adapter.Args.model_json_schema(), tool
        assert objects(profile.input_schema) and all(
            obj.get("additionalProperties") is False for obj in objects(profile.input_schema)), tool
        assert (profile.source, profile.status, profile.resource_kind) == ("native", "enabled", "desk"), tool
        assert sorted(profile.effects) == sorted(m["id"].removeprefix("effect:") for m in actions[tool]["memberOf"])
        assert adapter.free_text_fields == frozenset(adapter.Args.model_fields), tool    # every string is visitor text


async def callback(client: httpx.AsyncClient, visitor: Visitor, call_id: str = "call-1") -> ExecResult:
    """A callback the visitor asked for, decided (the starter preset allows it) and executed."""
    decision = await decided(client, visitor, "native.request_callback", CALLBACK, call_id=call_id)
    assert (decision.outcome, decision.card_ids) == ("allow", ["preset-request-callback"]), decision.reason_plain
    return await executed(client, visitor, decision)


async def test_callback_window_comes_from_the_hours(app, client, frozen_clock):
    # Saturday at 19:00 in Oakland: Rivera is closed until Monday at 08:00, after the clocks go back
    frozen_clock.travel(datetime(2026, 10, 31, 19, 0, tzinfo=TZ))
    copy, visitor = await visitor_of(app, client)
    await alert_now(app, copy, "callback")
    decision = await decided(client, visitor, "native.request_callback", CALLBACK)
    assert (decision.outcome, decision.action.resource.kind) == ("allow", "desk"), decision.reason_plain
    result = await executed(client, visitor, decision)

    [handoff] = await rows_of(app, copy.copy_id, select(Handoff))
    start, end = datetime(2026, 11, 2, 8, 0, tzinfo=TZ), datetime(2026, 11, 2, 9, 0, tzinfo=TZ)
    assert (handoff.window_start, handoff.window_end, handoff.action_id) == (start, end, decision.action.action_id)
    window = "2026-11-02T08:00:00-08:00/2026-11-02T09:00:00-08:00"
    assert api_rows(copy.copy_id, "SELECT session_id, reason, callback_window, status FROM kernel_ro.handoffs") == [
        (visitor.session_id, "Sam Lee · (510) 555-0100 · The water heater is leaking", window, "open")]
    [fact] = await rows_of(app, copy.copy_id, select(Fact).where(Fact.kind == "handoff"))
    assert (fact.fact_id, fact.status, fact.source, fact.expires_at) == (
        f"handoff:{handoff.handoff_id}", "committed", "kernel", None)
    assert fact.claims == [Claim(key="window_start", kind="datetime", value="2026-11-02T08:00:00-08:00"),
                           Claim(key="window_end", kind="datetime", value="2026-11-02T09:00:00-08:00")]
    assert (fact.readers, fact.session_id, fact.action_id) == (
        ["owner", f"session:{visitor.session_id}"], visitor.session_id, decision.action.action_id)
    assert (result.model_view, [f.fact_id for f in result.facts], result.inbox) == (
        {"fact_id": fact.fact_id, "handoff_id": handoff.handoff_id}, [fact.fact_id], [])
    reconciled = await run(app, copy.copy_id, decision, "reconcile")
    assert (reconciled.facts, reconciled.model_view) == (result.facts, result.model_view)
    [alert] = [entry for entry in await owner_alerts(client, copy) if "Sam Lee" in entry.body]
    assert alert.body == ("Call back on Monday, November 2, between 8:00 am and 9:00 am. "
                          "From the visitor: “Sam Lee · (510) 555-0100 · The water heater is leaking”.")

    # Tuesday at 10:20: the next whole hour
    frozen_clock.travel(datetime(2026, 11, 3, 10, 20, tzinfo=TZ))
    copy, visitor = await visitor_of(app, client)
    await callback(client, visitor)
    [handoff] = await rows_of(app, copy.copy_id, select(Handoff))
    assert (handoff.window_start, handoff.window_end) == (datetime(2026, 11, 3, 11, 0, tzinfo=TZ),
                                                          datetime(2026, 11, 3, 12, 0, tzinfo=TZ))

    # a time on the hour is that hour, a window's last whole hour is the last offered, and a window
    # ending at midnight offers the hour before it
    weekdays = HoursWindow(days=["mon", "tue", "wed", "thu", "fri"], start=time(8), end=time(18))
    late = HoursWindow(days=["sun"], start=time(22), end=time(0))
    assert desks.next_open_window([weekdays], TZ, datetime(2026, 11, 3, 11, 0, tzinfo=TZ)) == (
        datetime(2026, 11, 3, 11, 0, tzinfo=TZ), datetime(2026, 11, 3, 12, 0, tzinfo=TZ))
    assert desks.next_open_window([weekdays], TZ, datetime(2026, 11, 3, 17, 0, 1, tzinfo=TZ))[0] == datetime(
        2026, 11, 4, 8, 0, tzinfo=TZ)
    assert desks.next_open_window([weekdays, late], TZ, datetime(2026, 11, 7, 12, 0, tzinfo=TZ)) == (
        datetime(2026, 11, 8, 22, 0, tzinfo=TZ), datetime(2026, 11, 8, 23, 0, tzinfo=TZ))
    assert desks.next_open_window([late], TZ, datetime(2026, 11, 8, 22, 30, tzinfo=TZ)) == (
        datetime(2026, 11, 8, 23, 0, tzinfo=TZ), datetime(2026, 11, 9, 0, 0, tzinfo=TZ))
    assert desks.next_open_window([late], TZ, datetime(2026, 11, 8, 23, 30, tzinfo=TZ))[0] == datetime(
        2026, 11, 15, 22, 0, tzinfo=TZ)
    # the night the clocks go back, hours are compared as instants: at the second 1:00 am the first
    # has passed, and the repeated hour isn't offered again, so 2:00 am is next, whichever zone
    # `after` is given in
    early = HoursWindow(days=["sun"], start=time(1), end=time(3))
    second_one_am = datetime(2026, 11, 1, 1, 0, fold=1, tzinfo=TZ)
    for after in (second_one_am, second_one_am.astimezone(UTC)):
        assert [moment.isoformat() for moment in desks.next_open_window([early], TZ, after)] == [
            "2026-11-01T02:00:00-08:00", "2026-11-01T03:00:00-08:00"], after
    # the night the clocks go forward, an hour ending at 2:00 am, which the clocks skip, ends when
    # they land: 3:00 am, the same instant
    gap_night = HoursWindow(days=["sun"], start=time(1), end=time(2))
    window = desks.next_open_window([gap_night], TZ, datetime(2027, 3, 14, 0, 30, tzinfo=TZ))
    assert [moment.isoformat() for moment in window] == ["2027-03-14T01:00:00-08:00", "2027-03-14T03:00:00-07:00"]

    # the call can't name a time, or leave out who to call and why
    for call_id, args in (("call-2", {**CALLBACK, "window": "2026-11-03T15:00:00-08:00/2026-11-03T16:00:00-08:00"}),
                          ("call-3", {**CALLBACK, "starts_at": "2026-11-03T15:00:00-08:00"}),
                          ("call-4", {"name": "Sam Lee", "contact": "(510) 555-0100"}),
                          ("call-5", {**CALLBACK, "contact": ""}), ("call-6", {**CALLBACK, "reason": "x" * 201})):
        refused = await decided(client, visitor, "native.request_callback", args, call_id=call_id)
        assert (refused.outcome, refused.action) == ("refuse", None), args


async def set_hours(app: FastAPI, copy: Rivera, hours: list[HoursWindow]) -> None:
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        desk = (await ctx.db.scalars(ctx.repo.scoped(select(Desk).where(Desk.desk_id == copy.desk_id)))).one()
        desk.hours = hours


async def test_callback_without_an_open_hour_has_no_window(app, client):
    copy, visitor = await visitor_of(app, client)
    await alert_now(app, copy, "callback")
    every_day = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
    # no hours at all, then only a half hour a day: no whole hour is open
    for call_id, hours in (("call-1", []), ("call-2", [HoursWindow(days=every_day, start=time(9), end=time(9, 30))])):
        await set_hours(app, copy, hours)
        [fact] = (await callback(client, visitor, call_id)).facts
        assert (fact.kind, fact.status, fact.claims) == ("handoff", "committed", [])
    assert [(row.window_start, row.window_end) for row in await rows_of(app, copy.copy_id, select(Handoff))] == [
        (None, None)] * 2
    assert api_rows(copy.copy_id, "SELECT callback_window, status FROM kernel_ro.handoffs") == [(None, "open")] * 2
    alerts = [entry.body for entry in await owner_alerts(client, copy) if "Sam Lee" in entry.body]
    assert alerts == ["No hour is open in the next two weeks, so no time was given. "
                      "From the visitor: “Sam Lee · (510) 555-0100 · The water heater is leaking”."] * 2

    # the card says only that the owner will call
    verdict = await checked(client, visitor, "I passed your request on.", [clause("callback_confirmed", fact.fact_id)])
    assert verdict.ok, verdict.violations
    card = verdict.blocks[-1]
    assert (card.template, card.title, card.lines, card.text) == (
        "callback_confirmed", "Maria Rivera will call you back", [], "Maria Rivera will call you back")


async def test_card_and_alert_agree_on_a_window_the_clocks_cut_short(app, client, frozen_clock):
    """The night the clocks go forward, the hour from 1:00 am ends at 3:00 am in the visitor's card
    and in the owner's alert alike."""
    frozen_clock.travel(datetime(2027, 3, 14, 0, 30, tzinfo=TZ))
    copy, visitor = await visitor_of(app, client)
    await set_hours(app, copy, [HoursWindow(days=["sun"], start=time(1), end=time(2))])
    await alert_now(app, copy, "callback")
    [fact] = (await callback(client, visitor)).facts
    [alert] = [entry.body for entry in await owner_alerts(client, copy) if "Sam Lee" in entry.body]
    assert alert.startswith("Call back on Sunday, March 14, between 1:00 am and 3:00 am. ")
    verdict = await checked(client, visitor, "I passed your request on.", [clause("callback_confirmed", fact.fact_id)])
    assert verdict.ok, verdict.violations
    assert verdict.blocks[-1].title == (
        "Maria Rivera will call you back on Sunday, March 14, between 1:00 am and 3:00 am")


@pytest.mark.parametrize("language, prose, title", [
    ("en", "I passed your request on.",
     "Maria Rivera will call you back on Friday, October 30, between 11:00 am and 12:00 pm"),
    ("es", "Le pasé su solicitud a la dueña.",
     "Maria Rivera te llamará el viernes 30 de octubre, entre las 11:00 y las 12:00"),
], ids=["en", "es"])
async def test_callback_clause_renders(app, client, language, prose, title):
    copy, visitor = await visitor_of(app, client)                    # Friday at 10:04 in Oakland
    [fact] = (await callback(client, visitor)).facts
    verdict = await checked(client, visitor, prose, [clause("callback_confirmed", fact.fact_id)])
    assert (verdict.ok, verdict.language) == (True, language), verdict.violations
    assert [(block.template, block.fact_id, block.title, block.lines, block.text) for block in verdict.blocks[1:]] == [
        ("callback_confirmed", fact.fact_id, title, [], title)]
    # the card is rendered from the window alone: what the visitor typed is in no block
    shown = [text for block in verdict.blocks for text in (block.text, block.title or "", *block.lines)]
    assert not [text for text in shown for typed in CALLBACK.values() if typed in text], shown
    assert not [text for text in shown for word in ("Sam", "555", "heater") if word in text], shown


async def test_start_verification_reveals_nothing_to_claude(app, client):
    copy = await rivera(app, client)
    known, unknown = await open_visitor(client, copy), await open_visitor(client, copy)
    answers = []
    for visitor, contact in ((known, "dana@example.com"), (unknown, "nobody@example.com")):
        decide_response = await post_decide(client, visitor, "native.start_verification", {"contact": contact})
        assert decide_response.status_code == 200, decide_response.text
        decision = Decision.model_validate(decide_response.json())
        assert (decision.outcome, decision.card_ids) == ("allow", ["preset-start-verification"]), decision.reason_plain
        assert (decision.action.resource.kind, decision.action.recipient) == ("desk", "verified_contact")
        execute_response = await post_execute(client, visitor, decision)
        assert execute_response.status_code == 200, execute_response.text
        answers.append((decision, ExecResult.model_validate(execute_response.json()),
                        decide_response.text + execute_response.text))
    (on_record, started, known_text), (not_on_record, nothing, unknown_text) = answers

    # Claude reads the same thing either way: no fact, the same view and the same status line
    assert (started.state, started.facts, started.model_view) == (
        nothing.state, nothing.facts, nothing.model_view) == ("succeeded", [], {"status": "requested"})
    assert on_record.visitor_plain == not_on_record.visitor_plain
    # only the Demo inbox panel hears of the code, and only for a contact on record
    [notice] = started.inbox
    assert (notice.to, nothing.inbox) == (mask_contact("dana@example.com"), [])
    [entry] = await session_inbox(client, known)
    code = code_in(entry)
    assert code not in known_text and code not in unknown_text
    assert await session_inbox(client, unknown) == []

    # each start is a verification attempt on the ledger, and the stranger's contact a lead note
    entries = await rows_of(app, copy.copy_id, select(LedgerEntry).where(LedgerEntry.desk_id == copy.desk_id)
                            .order_by(LedgerEntry.seq))
    verify = [(entry.event.session_id, entry.event.summary["outcome"]) for entry in entries
              if entry.event.kind == "verify"]
    assert verify == [(known.session_id, "started"), (unknown.session_id, "not_on_record")]
    assert api_rows(copy.copy_id, "SELECT session_id, note FROM kernel_ro.leads") == [
        (unknown.session_id, "Asked to verify as nobody@example.com")]
    # the visitor types the code into the verify card, and the session is Dana's
    response = await check(client, known, code)
    assert (response.status_code, response.json()["verified"]) == (200, True)


async def test_parallel_verification_starts_take_turns(app, client, monkeypatch):
    """Two verification starts executed together in one session take turns on the session row, so
    both succeed and one challenge stays live; each must not hold the row shared while waiting to
    lock it for itself, or each waits on the other until Postgres ends one."""
    copy, visitor = await visitor_of(app, client)
    allowed = [await decided(client, visitor, "native.start_verification", {"contact": contact}, call_id=call_id)
               for call_id, contact in (("call-1", "dana@example.com"), ("call-2", "bob@example.com"))]
    assert [decision.outcome for decision in allowed] == ["allow", "allow"]
    start, arrived, together = verification.start, [], asyncio.Event()

    async def start_together(ctx, session_row, contact):
        # the two meet here unless something already made one wait for the other
        arrived.append(contact)
        if len(arrived) == 2:
            together.set()
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(together.wait(), timeout=0.5)
        return await start(ctx, session_row, contact)

    monkeypatch.setattr(verification, "start", start_together)
    results = await asyncio.gather(*(executed(client, visitor, decision) for decision in allowed))
    assert [result.state for result in results] == ["succeeded", "succeeded"]
    statuses = [row.status for row in await rows_of(app, copy.copy_id, select(VerificationChallenge))]
    assert sorted(statuses) == ["cancelled", "live"]
    assert [entry.event.summary["outcome"] for entry in await ledger_rows(app, copy)
            if entry.event.kind == "verify"] == ["started", "started"]


async def test_start_verification_is_for_unverified_sessions(app, client):
    copy, visitor = await visitor_of(app, client)
    allowed = await decided(client, visitor, "native.start_verification", {"contact": "bob@example.com"})
    assert allowed.outcome == "allow", allowed.reason_plain
    [dana] = await rows_of(app, copy.copy_id, select(Person).where(Person.ref == "dana"))
    await verify_session(app, copy.copy_id, visitor.session_id, dana.person_id)

    # a session that has confirmed who it is isn't given the tool, so its call is refused before any action
    refused = await decided(client, visitor, "native.start_verification", {"contact": "bob@example.com"},
                            call_id="call-2")
    assert (refused.outcome, refused.action) == ("refuse", None)
    assert "This conversation can't use that tool, so it was refused." in refused.reason_plain
    # and an allow from before it verified is refused at execution, with nothing sent
    response = await post_execute(client, visitor, allowed)
    assert (response.status_code, response.json()) == (409, {"code": "conflict"})
    assert await rows_of(app, copy.copy_id, select(VerificationChallenge)) == []
    assert await session_inbox(client, visitor) == []


async def test_answering_off_leaves_lead_capture_and_callback(app, client):
    copy, visitor = await visitor_of(app, client)
    live = await context_of(client, visitor.session_id, visitor.headers)
    assert tools(live.tools) == ["native.book", "native.capture_lead", "native.find_slots", "native.quote",
                                 "native.request_callback", "native.start_verification"]
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        desk = (await ctx.db.scalars(ctx.repo.scoped(select(Desk).where(Desk.desk_id == copy.desk_id)))).one()
        desk.answering = False

    # with Answering off, a visitor can still leave their details or ask for a callback, and nothing else
    quiet = await context_of(client, visitor.session_id, visitor.headers)
    assert tools(quiet.tools) == ["native.capture_lead", "native.request_callback"]
    assert quiet.tools_declared == live.tools_declared
    refused = await decided(client, visitor, "native.start_verification", {"contact": "dana@example.com"})
    assert (refused.outcome, refused.action) == ("refuse", None)
    await executed(client, visitor, await decided(client, visitor, "native.capture_lead", {"name": "Sam Lee"},
                                                  call_id="call-2"))
    await callback(client, visitor, "call-3")
    assert [len(await rows_of(app, copy.copy_id, select(table))) for table in (Lead, Handoff)] == [1, 1]


async def handoff_done(client: httpx.AsyncClient, handoff_id: str, headers: dict[str, str]) -> httpx.Response:
    return await client.post(f"/handoffs/{handoff_id}/done", headers=headers)


async def test_owner_closes_a_handoff_once(app, client, frozen_clock):
    copy, visitor = await visitor_of(app, client)
    handoff_id = (await callback(client, visitor)).model_view["handoff_id"]
    # only the owner's credential closes it
    for headers in (visitor.headers, {**copy.owner, **visitor.headers}):
        response = await handoff_done(client, handoff_id, headers)
        assert (response.status_code, response.json()) == (401, {"code": "auth"})
    assert api_rows(copy.copy_id, "SELECT status FROM kernel_ro.handoffs") == [("open",)]

    frozen_clock.advance(3600)                                       # Maria calls back an hour later
    response = await handoff_done(client, handoff_id, copy.owner)
    assert response.status_code == 200, response.text
    assert DeskUpdated.model_validate(response.json()) == DeskUpdated(desk_id=copy.desk_id,
                                                                      updated_at=frozen_clock.now())
    assert api_rows(copy.copy_id, "SELECT status FROM kernel_ro.handoffs") == [("done",)]
    closed = [entry.event.summary for entry in await ledger_rows(app, copy) if entry.event.kind == "desk_data"]
    assert closed[-1] == {"part": "handoffs", "refs": [handoff_id]}

    # a second close changes nothing
    response = await handoff_done(client, handoff_id, copy.owner)
    assert (response.status_code, response.json()) == (409, {"code": "conflict"})
    assert api_rows(copy.copy_id, "SELECT status FROM kernel_ro.handoffs") == [("done",)]
    assert [entry.event.summary for entry in await ledger_rows(app, copy) if entry.event.kind == "desk_data"] == closed


async def test_handoff_done_is_copy_scoped(app, client, caplog):
    caplog.set_level(logging.WARNING, logger="desk.kernel_service")
    copy, visitor = await visitor_of(app, client)
    other = await rivera(app, client)
    handoff_id = (await callback(client, visitor)).model_view["handoff_id"]
    before = [[entry.hash for entry in await ledger_rows(app, each)] for each in (copy, other)]

    # another copy's owner, or a handoff no copy has, finds nothing to close
    for headers, named in ((other.owner, handoff_id), (copy.owner, "handoff-unknown"), (copy.owner, "handoff-%00")):
        response = await handoff_done(client, named, headers)
        assert (response.status_code, response.json()) == (404, {"code": "not_found"}), named
    response = await handoff_done(client, handoff_id, {"X-Owner-Session": "not-a-token"})
    assert (response.status_code, response.json()) == (401, {"code": "auth"})
    assert api_rows(copy.copy_id, "SELECT status FROM kernel_ro.handoffs") == [("open",)]
    # no Desk of the caller's copy is named, so nothing is ledgered; each is one log line
    assert [[entry.hash for entry in await ledger_rows(app, each)] for each in (copy, other)] == before
    unattributed = [r.getMessage() for r in caplog.records if r.getMessage().startswith("auth_unattributed")]
    assert unattributed == [f"auth_unattributed route=POST /handoffs/{{handoff_id}}/done reason={reason}"
                            for reason in ("unknown_handoff",) * 3 + ("bad_owner_token",)]
