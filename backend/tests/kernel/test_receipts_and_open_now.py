"""Receipts that say what was done, and whether the business is open now.

An executed action's receipt names what happened, one line per tool in the reader's language
("Quoted from Mike Turner's price list"), instead of a generic "Done"; a tool with no line fails
before anything happens. The public page's header says whether the business is open now, computed
by the kernel from the Desk's `charter:hours` windows in the business's time zone, on its own
clock, with the text the web shows verbatim and the instant it should ask again.

Tests run on Turner Plumbing copies as `POST /copies` seeds them (Friday 10:04 in Oakland; open
Monday to Friday 8:00 am to 6:00 pm and Saturday 9:00 am to 1:00 pm), and on the open-status
helpers directly for the copy table, time zones and daylight-saving changes.
"""

import logging
from datetime import UTC, datetime, time, timedelta
from zoneinfo import ZoneInfo

import httpx
from sqlalchemy import select

from desk.contracts import HoursWindow, NormalizedAction, Principal, ResourceRef
from desk.db.models import Approval
from desk.db.models import Fact as FactRow
from desk.kernel_api import OpenStatus, PublicDesk
from desk.kernel_service import adapters, decide, desks, public, render, reply_check

from .fakes import FakeAdapter
from .helpers import kernel_ctx, ledger_rows, rows_of
from .test_adapters import quote_args, rivera, visitor_of
from .test_approvals import answered, held_on, post_answer, public_key, seeded_hold
from .test_compiler import card
from .test_decide import decided, desk_with, open_visitor, set_session, verify_signature
from .test_desk_writes import updated
from .test_execute import executed, executions_of, post_execute, read

# The master's "Model-visible tools": every tool a visitor or agent may be given.
VISITOR_OR_AGENT_TOOLS = frozenset({
    "native.quote", "native.find_slots", "native.book", "native.release_document", "native.payment_link",
    "native.charge_mandate", "native.capture_lead", "native.request_callback", "native.start_verification",
    "payments.list_charges", "payments.create_refund"})

# The owner's signed-off lines for this plan's tools (English, Spanish), for an owner named Mike Turner.
RECEIPT_LINES = {
    "native.quote": ("Quoted from Mike Turner's price list", "Cotizado con la lista de precios de Mike Turner"),
    "native.find_slots": ("Times read from Mike Turner's calendar", "Horarios tomados del calendario de Mike Turner"),
    "native.book": ("Booked on Mike Turner's calendar", "Reservado en el calendario de Mike Turner"),
    "native.capture_lead": ("Details saved for Mike Turner", "Datos guardados para Mike Turner"),
    "native.request_callback": ("Callback request saved for Mike Turner",
                                "Solicitud de llamada guardada para Mike Turner"),
    "native.start_verification": ("Verification started", "Verificación iniciada"),
    "native.release_document": ("Document shared from Mike Turner's records",
                                "Documento compartido desde los registros de Mike Turner"),
}

# What a receipt line may never hold: a number, an amount, a percentage or a date.
NUMBERS_AND_DATES = {"digit", "currency", "percent_sign"} | {
    f"lex.{lang}.{category}" for lang in ("en", "es") for category in ("number", "money", "percent", "date")}


# ---- Receipts -----------------------------------------------------------------------------------

def test_every_visitor_tool_has_receipt_lines():
    registered = VISITOR_OR_AGENT_TOOLS & set(adapters.ADAPTERS)
    assert set(RECEIPT_LINES) <= registered                 # this plan's tools are all registered
    for tool in sorted(registered):
        for lang in ("en", "es"):
            line = render.executed_status(tool, lang, owner="Mike Turner")
            hits = {violation.rule_id for violation in reply_check.scan_prose(line)} & NUMBERS_AND_DATES
            assert line and not hits, (tool, lang, line, hits)
    # the copy the owner signed off, word for word
    assert {tool: (render.executed_status(tool, "en", owner="Mike Turner"),
                   render.executed_status(tool, "es", owner="Mike Turner")) for tool in RECEIPT_LINES} == RECEIPT_LINES


async def test_executed_receipt_says_what_was_done(app, client):
    copy, visitor = await visitor_of(app, client)
    key = await public_key(client)
    allowed = await decided(client, visitor, "native.quote", quote_args(("drain", 1)))
    assert (allowed.outcome, allowed.visitor_plain) == ("allow", "Checked against Mike Turner's rules")
    await executed(client, visitor, allowed)
    done = await read(client, visitor.headers, allowed)
    assert (done.state, done.visitor_plain) == ("executed", "Quoted from Mike Turner's price list")
    verify_signature(key, done)
    # in Spanish for a session that reads Spanish
    spanish = await open_visitor(client, copy)
    await set_session(app, copy, spanish.session_id, last_language="es")
    allowed = await decided(client, spanish, "native.quote", quote_args(("drain", 1)))
    assert allowed.visitor_plain == "Revisado con las reglas de Mike Turner"      # other states keep their line
    await executed(client, spanish, allowed)
    done = await read(client, spanish.headers, allowed)
    assert (done.state, done.visitor_plain) == ("executed", "Cotizado con la lista de precios de Mike Turner")
    verify_signature(key, done)
    # a held quote the owner approves once ends on the same line
    copy, held = await seeded_hold(app, client)
    approved = (await answered(client, copy.owner, held.decision_id, "allow_once")).decision
    assert (approved.state, approved.visitor_plain) == ("executed", "Quoted from Mike Turner's price list")
    verify_signature(key, approved)


async def test_start_verification_receipt_is_uniform(app, client):
    # on record or not, the receipt reads the same, so it can't tell a stranger whether a contact exists
    copy = await rivera(app, client)
    receipts = []
    for language in ("en", "es"):
        for contact in ("dana@example.com", "nobody@example.com"):
            visitor = await open_visitor(client, copy)
            await set_session(app, copy, visitor.session_id, last_language=language)
            allowed = await decided(client, visitor, "native.start_verification", {"contact": contact})
            assert allowed.outcome == "allow", allowed.reason_plain
            await executed(client, visitor, allowed)
            done = await read(client, visitor.headers, allowed)
            receipts.append((done.state, done.visitor_plain))
    assert receipts == [("executed", "Verification started")] * 2 + [("executed", "Verificación iniciada")] * 2


async def test_a_tool_without_a_line_fails_before_its_side_effect(app, client, registry, monkeypatch):
    # a tool shipped without its receipt line, on both paths that run an action
    for language in ("en", "es"):
        monkeypatch.delitem(render.EXECUTED[language], "native.quote")
    quote = FakeAdapter("native.quote")
    auto = await desk_with(app, [quote], [card("quote", "native.quote")])
    asks = await desk_with(app, [quote], [card("quote", "native.quote", mode="ask")])
    visitor = await open_visitor(client, auto)
    allowed = await decided(client, visitor, "native.quote", {"qty": 1})
    _, held = await held_on(client, asks)
    answers = [await post_execute(client, visitor, allowed),
               await post_answer(client, asks.owner, held.decision_id, "allow_once")]
    assert [(response.status_code, response.json()) for response in answers] == [(500, {"code": "internal"})] * 2
    # no intent row, the adapter never asked to act, and each decision as it was: the allow to
    # expire, the hold still waiting, with no approval used up
    assert "prepare" not in quote.calls and "execute" not in quote.calls
    for rows, decision, state in ((auto, allowed, "allowed"), (asks, held, "held")):
        assert await executions_of(app, rows.copy_id) == []
        assert (await read(client, rows.owner, decision)).state == state
        notes = [entry.event.summary for entry in await ledger_rows(app, rows)
                 if entry.event.kind == "execute" and entry.event.ref_id == decision.decision_id]
        assert notes == [{"decision_id": decision.decision_id, "action_id": decision.action.action_id,
                          "refused": "no_receipt_line"}]
    assert await rows_of(app, asks.copy_id, select(Approval)) == []


# ---- Open now -----------------------------------------------------------------------------------

LA = ZoneInfo("America/Los_Angeles")                                         # Turner Plumbing's time zone


def at(wall: str, tz: ZoneInfo = LA, *, fold: int = 0) -> datetime:
    """The instant a wall time in `tz` names ("2026-11-03 10:00"), in UTC."""
    return datetime.fromisoformat(wall).replace(tzinfo=tz, fold=fold).astimezone(UTC)


def utc(moment: datetime | None) -> datetime | None:
    return None if moment is None else moment.astimezone(UTC)


def window(days: str, start: str, end: str) -> HoursWindow:
    """A weekly window: `window("mon tue", "08:00", "18:00")`; an end of "00:00" is midnight."""
    return HoursWindow(days=days.split(), start=time.fromisoformat(start), end=time.fromisoformat(end))


RIVERA_HOURS = [window("mon tue wed thu fri", "08:00", "18:00"), window("sat", "09:00", "13:00")]


def status_at(hours: list[HoursWindow], wall: str, lang: str = "en", *, tz: ZoneInfo = LA,
              fold: int = 0) -> OpenStatus | None:
    """The open-now line for `hours` when the business's clock reads `wall`."""
    return public.open_status(hours, tz.key, at(wall, tz, fold=fold), lang)


def texts_at(hours: list[HoursWindow], wall: str, **kwargs) -> tuple[str, str]:
    """The open-now text in English and Spanish."""
    return tuple(status_at(hours, wall, lang, **kwargs).text for lang in ("en", "es"))


async def open_status_of(client: httpx.AsyncClient, slug: str, lang: str | None = None) -> OpenStatus | None:
    response = await client.get(f"/public/{slug}", params={"lang": lang} if lang else {})
    assert response.status_code == 200, response.text
    return PublicDesk.model_validate(response.json()).open_status


async def test_open_now_until_the_window_ends(app, client, frozen_clock):
    copy = await rivera(app, client)
    frozen_clock.travel(at("2026-11-03 10:00"))                              # a Tuesday morning
    status = await open_status_of(client, copy.slug)
    six = at("2026-11-03 18:00")
    assert (status.open, utc(status.until), status.opens_at, utc(status.as_of), utc(status.refresh_at)) == (
        True, six, None, frozen_clock.now(), six)
    assert status.text == "Open now, until 6:00 pm"
    assert (await open_status_of(client, copy.slug, "es")).text == "Abierto ahora, hasta las 18:00"


async def test_closed_shows_the_next_opening(app, client, frozen_clock):
    copy = await rivera(app, client)
    frozen_clock.travel(at("2026-10-31 19:00"))                              # Saturday evening
    status = await open_status_of(client, copy.slug)
    assert (status.open, status.until, utc(status.opens_at), utc(status.refresh_at)) == (
        False, None, at("2026-11-02 08:00"), at("2026-11-01 00:00"))        # asked again at the next local midnight
    assert status.text == "Closed now. Opens Monday at 8:00 am"
    assert (await open_status_of(client, copy.slug, "es")).text == "Cerrado ahora. Abre el lunes a las 8:00"
    for wall, english, spanish, refresh in (
            ("2026-11-02 07:00", "Closed now. Opens today at 8:00 am", "Cerrado ahora. Abre hoy a las 8:00",
             "2026-11-02 08:00"),
            ("2026-11-01 20:00", "Closed now. Opens tomorrow at 8:00 am", "Cerrado ahora. Abre mañana a las 8:00",
             "2026-11-02 00:00")):
        frozen_clock.travel(at(wall))
        status = await open_status_of(client, copy.slug)
        assert (status.text, (await open_status_of(client, copy.slug, "es")).text) == (english, spanish)
        assert utc(status.refresh_at) == at(refresh)
    # an opening later today in the afternoon
    assert texts_at([window("tue", "13:00", "18:00")], "2026-11-03 10:00") == (
        "Closed now. Opens today at 1:00 pm", "Cerrado ahora. Abre hoy a las 13:00")


def test_touching_windows_merge():
    for hours in ([window("tue", "08:00", "12:00"), window("tue", "12:00", "18:00")],      # touching
                  [window("tue", "08:00", "13:00"), window("tue", "11:00", "18:00")]):     # overlapping
        status = status_at(hours, "2026-11-03 10:00")
        assert (status.open, utc(status.until)) == (True, at("2026-11-03 18:00"))
        assert texts_at(hours, "2026-11-03 10:00") == ("Open now, until 6:00 pm", "Abierto ahora, hasta las 18:00")
    # every hour of every day: open, with no end in the week ahead, and asked again at midnight
    always = [window("mon tue wed thu fri sat sun", "00:00", "00:00")]
    status = status_at(always, "2026-11-03 10:00")
    assert (status.open, status.until, status.opens_at, utc(status.refresh_at)) == (
        True, None, None, at("2026-11-04 00:00"))
    assert texts_at(always, "2026-11-03 10:00") == ("Open now", "Abierto ahora")


def test_windows_merge_across_midnight():
    # Friday 22:00 to midnight and Saturday midnight to 2:00 am are one span
    hours = [window("fri", "22:00", "00:00"), window("sat", "00:00", "02:00")]
    status = status_at(hours, "2026-11-06 23:00")
    assert (status.open, utc(status.until), utc(status.refresh_at)) == (
        True, at("2026-11-07 02:00"), at("2026-11-07 00:00"))               # the day word changes at midnight
    assert texts_at(hours, "2026-11-06 23:00") == ("Open now, until 2:00 am tomorrow",
                                                   "Abierto ahora, hasta mañana a las 2:00")


def test_an_end_at_midnight():
    wednesday = "2026-11-04 20:00"
    evening = window("wed", "18:00", "00:00")
    cases = [
        # closing at the 00:00 that ends today, with nothing after it
        ([evening], wednesday, "Open now, until midnight", "Abierto ahora, hasta la medianoche"),
        # followed by a window from 00:00: one span
        ([evening, window("thu", "00:00", "02:00")], wednesday, "Open now, until 2:00 am tomorrow",
         "Abierto ahora, hasta mañana a las 2:00"),
        # closing at the 00:00 that ends tomorrow
        ([evening, window("thu", "00:00", "00:00")], wednesday, "Open now, until tomorrow at midnight",
         "Abierto ahora, hasta mañana a medianoche"),
        # closing at the 00:00 that ends Friday, seen on Wednesday
        ([window("wed thu fri", "00:00", "00:00")], "2026-11-04 10:00", "Open now, until Friday at midnight",
         "Abierto ahora, hasta el viernes a medianoche"),
        # an opening at 00:00 reads the clock, on its own date
        ([window("thu", "00:00", "02:00")], wednesday, "Closed now. Opens tomorrow at 12:00 am",
         "Cerrado ahora. Abre mañana a las 0:00"),
        ([window("mon", "00:00", "02:00")], wednesday, "Closed now. Opens Monday at 12:00 am",
         "Cerrado ahora. Abre el lunes a las 0:00"),
        # today's weekday a week ahead is "next"; another weekday stays bare
        ([window("mon", "08:00", "18:00")], "2026-11-02 19:00", "Closed now. Opens next Monday at 8:00 am",
         "Cerrado ahora. Abre el próximo lunes a las 8:00"),
        ([window("mon", "08:00", "18:00")], "2026-11-03 19:00", "Closed now. Opens Monday at 8:00 am",
         "Cerrado ahora. Abre el lunes a las 8:00"),
        # open for nearly a week: closed only on Monday from 8:00 to 9:00 am
        ([window("mon", "00:00", "08:00"), window("mon", "09:00", "00:00"),
          window("tue wed thu fri sat sun", "00:00", "00:00")], "2026-11-02 10:00",
         "Open now, until next Monday at 8:00 am", "Abierto ahora, hasta el próximo lunes a las 8:00"),
    ]
    for hours, wall, english, spanish in cases:
        assert texts_at(hours, wall) == (english, spanish), (wall, english)
    # midnight is when the line is asked for again, as well as the boundary
    assert utc(status_at([evening], wednesday).refresh_at) == at("2026-11-05 00:00")


def test_spanish_says_la_una():
    assert texts_at([window("wed", "00:00", "01:00")], "2026-11-04 00:30") == (
        "Open now, until 1:00 am", "Abierto ahora, hasta la 1:00")
    assert texts_at([window("wed", "18:00", "00:00"), window("thu", "00:00", "01:30")], "2026-11-04 20:00") == (
        "Open now, until 1:30 am tomorrow", "Abierto ahora, hasta mañana a la 1:30")
    assert texts_at([window("thu", "01:00", "05:00")], "2026-11-04 20:00") == (
        "Closed now. Opens tomorrow at 1:00 am", "Cerrado ahora. Abre mañana a la 1:00")
    assert texts_at([window("thu", "13:00", "15:00")], "2026-11-04 20:00") == (     # 13:00 is "las"
        "Closed now. Opens tomorrow at 1:00 pm", "Cerrado ahora. Abre mañana a las 13:00")


def test_a_window_end_is_closed():
    # at 6:00 pm sharp the business is closed, and a window's start is open
    status = status_at(RIVERA_HOURS, "2026-11-03 18:00")
    assert (status.open, status.until, utc(status.opens_at)) == (False, None, at("2026-11-04 08:00"))
    assert status.text == "Closed now. Opens tomorrow at 8:00 am"
    status = status_at(RIVERA_HOURS, "2026-11-04 08:00")
    assert (status.open, utc(status.until), status.text) == (True, at("2026-11-04 18:00"), "Open now, until 6:00 pm")
    # a business open until now is closed: the boundary is always after as_of
    status = status_at(RIVERA_HOURS, "2026-11-03 17:59:59")
    assert (status.open, utc(status.until)) == (True, at("2026-11-03 18:00"))


def assert_valid(status: OpenStatus) -> OpenStatus:
    """The status as the contract checks it, and asked for again within 25 hours."""
    assert OpenStatus.model_validate(status.model_dump()) == status
    assert utc(status.as_of) < utc(status.refresh_at) <= utc(status.as_of) + timedelta(hours=25)
    return status


def test_both_dst_transitions():
    # Los Angeles falls back on Sunday, November 1 2026 (2:00 am PDT is 1:00 am PST, at 09:00 UTC)
    status = assert_valid(status_at(RIVERA_HOURS, "2026-10-31 19:00"))
    assert (utc(status.opens_at), utc(status.refresh_at)) == (at("2026-11-02 08:00"), at("2026-11-01 00:00"))
    assert (utc(status.opens_at), utc(status.refresh_at)) == (datetime(2026, 11, 2, 16, tzinfo=UTC),
                                                              datetime(2026, 11, 1, 7, tzinfo=UTC))
    status = assert_valid(status_at(RIVERA_HOURS, "2026-11-01 00:00"))   # a 25-hour day: midnight is 25 hours on
    assert (utc(status.refresh_at), status.text) == (datetime(2026, 11, 2, 8, tzinfo=UTC),
                                                     "Closed now. Opens tomorrow at 8:00 am")
    # a boundary 168.5 hours away is still within the 7 local days, closed and open
    for hours, text in (([window("sat", "18:00", "18:15")], "Closed now. Opens next Saturday at 6:00 pm"),
                        ([window("sat", "18:15", "00:00"), window("sun mon tue wed thu fri", "00:00", "00:00"),
                          window("sat", "00:00", "18:00")], "Open now, until next Saturday at 6:00 pm")):
        status = assert_valid(status_at(hours, "2026-10-31 18:30"))
        boundary = status.until if status.open else status.opens_at
        assert (utc(boundary), status.text) == (at("2026-11-07 18:00"), text)
        assert utc(boundary) - utc(status.as_of) == timedelta(hours=168, minutes=30)
    # in the repeated hour the wall clock goes back past a window's start, so it closes and opens again
    night = [window("sun", "01:30", "02:30")]
    status = assert_valid(status_at(night, "2026-11-01 01:45"))                       # the first 1:45 (PDT)
    assert (status.open, utc(status.until), status.text) == (True, datetime(2026, 11, 1, 9, tzinfo=UTC),
                                                            "Open now, until 1:00 am")
    status = assert_valid(status_at(night, "2026-11-01 01:10", fold=1))               # the second 1:10 (PST)
    assert (status.open, utc(status.opens_at), status.text) == (False, at("2026-11-01 01:30", fold=1),
                                                               "Closed now. Opens today at 1:30 am")
    status = assert_valid(status_at(night, "2026-11-01 01:45", fold=1))
    assert (status.open, utc(status.until)) == (True, datetime(2026, 11, 1, 10, 30, tzinfo=UTC))

    # Los Angeles springs forward on Sunday, March 8 2026 (2:00 am PST is 3:00 am PDT, at 10:00 UTC)
    status = assert_valid(status_at(RIVERA_HOURS, "2026-03-07 19:00"))
    assert (utc(status.opens_at), utc(status.refresh_at)) == (datetime(2026, 3, 9, 15, tzinfo=UTC),
                                                              datetime(2026, 3, 8, 8, tzinfo=UTC))
    status = assert_valid(status_at(RIVERA_HOURS, "2026-03-08 00:00"))   # a 23-hour day
    assert utc(status.refresh_at) == datetime(2026, 3, 9, 7, tzinfo=UTC)
    # a start or an end the clocks skip takes effect when they jump
    status = assert_valid(status_at(night, "2026-03-08 01:45"))
    assert (status.open, utc(status.until), status.text) == (True, datetime(2026, 3, 8, 10, tzinfo=UTC),
                                                            "Open now, until 3:00 am")
    status = assert_valid(status_at([window("sun", "02:30", "05:00")], "2026-03-08 01:00"))
    assert (status.open, utc(status.opens_at), status.text) == (False, datetime(2026, 3, 8, 10, tzinfo=UTC),
                                                               "Closed now. Opens today at 3:00 am")


async def test_open_status_uses_the_business_time_zone(app, client, frozen_clock):
    # the kernel's clock is in UTC; the business, and every word of the line, is in Oakland
    copy = await rivera(app, client)
    frozen_clock.travel(datetime(2026, 11, 4, 1, 30, tzinfo=UTC))             # Wednesday 1:30 am in UTC
    status = await open_status_of(client, copy.slug)
    assert (status.open, utc(status.until), status.text) == (                # Tuesday 5:30 pm in Oakland
        True, datetime(2026, 11, 4, 2, tzinfo=UTC), "Open now, until 6:00 pm")
    frozen_clock.travel(datetime(2026, 11, 3, 15, 30, tzinfo=UTC))            # Tuesday 3:30 pm in UTC
    status = await open_status_of(client, copy.slug)
    assert (status.open, utc(status.opens_at), status.text) == (              # Tuesday 7:30 am in Oakland
        False, datetime(2026, 11, 3, 16, tzinfo=UTC), "Closed now. Opens today at 8:00 am")


def test_refresh_is_capped_at_twenty_five_hours():
    # Troll's Sunday, October 25 2026 lasts 26 hours (3:00 am +02 is 1:00 am +00): its next local
    # midnight is too far, so the line is asked for again 25 hours on, still on the same local date
    troll = ZoneInfo("Antarctica/Troll")
    status = assert_valid(status_at([window("mon", "08:00", "18:00")], "2026-10-25 00:00", tz=troll))
    as_of = utc(status.as_of)
    assert (as_of, utc(status.opens_at)) == (datetime(2026, 10, 24, 22, tzinfo=UTC),
                                             datetime(2026, 10, 26, 8, tzinfo=UTC))
    assert utc(status.refresh_at) == as_of + timedelta(hours=25)
    assert status.refresh_at.astimezone(troll).date() == as_of.astimezone(troll).date()
    assert status.text == "Closed now. Opens tomorrow at 8:00 am"


def cedar_local(instant: datetime) -> tuple[int, int]:
    """The `local_dow` and `local_minute` `/decide` sends Cedar for a call decided at `instant` at a
    business in Oakland."""
    principal = Principal(kind="visitor", session_id="ses", copy_id="copy", desk_id="desk")
    action = NormalizedAction(action_id="act", copy_id="copy", desk_id="desk", session_id="ses", generation=0,
                              tool="native.quote", effects=["change"], args_sha256="a" * 64, profile_sha256="p" * 64,
                              resource=ResourceRef(kind="desk", id="desk", owner_person_id=None), list_cents=None,
                              discount_bp=None, amount_cents=None, recipient=None, starts_at=None)
    context = decide.cedar_request(principal, action, tz=LA.key, now=instant, auto_money_cap_cents=0)["context"]
    return context["local_dow"], context["local_minute"]


def within(hours: list[HoursWindow], dow: int, minute: int) -> bool:
    """Whether Cedar's hours condition for these windows holds: `[days].contains(local_dow) &&
    local_minute >= start && local_minute < end`, an end of 00:00 being minute 1440."""
    week = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
    return any(week[dow] in each.days and each.start.hour * 60 + each.start.minute <= minute
               < (1440 if each.end == time(0) else each.end.hour * 60 + each.end.minute) for each in hours)


def test_open_status_agrees_with_cedars_local_time():
    # Turner's hours and windows whose starts and ends the clock changes skip or repeat
    hours = [*RIVERA_HOURS, window("sun", "01:30", "02:30"), window("sun", "22:00", "00:00"),
             window("mon", "00:00", "00:45")]
    minute = timedelta(minutes=1)
    for change in (datetime(2026, 3, 8, 10, tzinfo=UTC), datetime(2026, 11, 1, 9, tzinfo=UTC)):
        start, end = change - timedelta(days=4), change + timedelta(days=3)
        # every minute the answer to Cedar's hours check changes, minute by minute, a day past the sweep
        flips, probe = [], start
        previous = within(hours, *cedar_local(probe))
        while probe < end + timedelta(days=1):
            probe += minute
            if (now_within := within(hours, *cedar_local(probe))) != previous:
                flips.append(probe)
            previous = now_within
        # every 7 minutes and 13 seconds across the week, and every minute around the change
        sweep = [start + timedelta(minutes=7 * step, seconds=13) for step in range(int((end - start) / (7 * minute)))]
        sweep += [change + step * minute for step in range(-120, 121)]
        for instant in sweep:
            status = assert_valid(public.open_status(hours, LA.key, instant, "en"))
            assert status.open == within(hours, *cedar_local(instant)), instant
            boundary = status.until if status.open else status.opens_at
            assert utc(boundary) == next(flip for flip in flips if flip > instant), instant


async def test_no_hours_means_no_open_status(app, client):
    # a Desk without hours claims neither open nor closed, and the rest of its page is served
    copy = await rivera(app, client)
    await updated(client, copy, "hours", {"hours": []})
    response = await client.get(f"/public/{copy.slug}")
    assert response.status_code == 200, response.text
    assert response.json()["open_status"] is None
    assert PublicDesk.model_validate(response.json()).charter[0].fact_id == "charter:contact"
    await updated(client, copy, "hours", {"hours": [each.model_dump(mode="json") for each in RIVERA_HOURS]})
    assert await open_status_of(client, copy.slug) is not None
    async with kernel_ctx(app) as ctx:                                        # no hours fact at all
        ctx.bind(copy.copy_id)
        await ctx.db.delete((await ctx.db.scalars(ctx.repo.scoped(
            select(FactRow).where(FactRow.fact_id == "charter:hours")))).one())
    assert await open_status_of(client, copy.slug) is None
    assert public.open_status([], LA.key, at("2026-11-03 10:00"), "en") is None


async def test_a_failing_open_status_is_none_and_logged(app, client, frozen_clock, monkeypatch, caplog):
    copy = await rivera(app, client)

    def broken(hours, tz, now):
        raise RuntimeError("Turner Plumbing, Monday to Friday")

    monkeypatch.setattr(desks, "open_window_status", broken)
    with caplog.at_level(logging.INFO):
        response = await client.get(f"/public/{copy.slug}")
    assert response.status_code == 200, response.text
    page = PublicDesk.model_validate(response.json())
    assert (page.open_status, page.charter[0].fact_id) == (None, "charter:hours")   # the rest of the page stands
    assert [record.getMessage() for record in caplog.records if "open_status" in record.getMessage()] == [
        "open_status_failed error=RuntimeError"]
    kernel_log = "\n".join(record.getMessage() for record in caplog.records if record.name.startswith("desk"))
    for desk_data in ("Turner", "Monday", copy.slug, copy.desk_id, copy.copy_id):
        assert desk_data not in kernel_log
    # a closed business that names no opening is a failure too: its only window is an hour the
    # clocks skip next Sunday, so nothing opens in the week ahead
    monkeypatch.undo()
    caplog.clear()
    await updated(client, copy, "hours", {"hours": [window("sun", "02:00", "02:30").model_dump(mode="json")]})
    frozen_clock.travel(at("2026-03-01 03:00"))
    with caplog.at_level(logging.INFO):
        assert await open_status_of(client, copy.slug) is None
    assert [record.getMessage() for record in caplog.records if "open_status" in record.getMessage()] == [
        "open_status_failed error=ValueError"]
