"""The kernel keeps a setup-made Desk's calendar open.

Setup gives a new Desk 60-minute slots from its hours for the 14 days after setup finishes, once.
So a live Desk doesn't run out of open times, the kernel adds the days after its latest slot, up to
14 days ahead, from its hours in its business's time zone (`desks.extend_calendars`), at its start
and then daily. It only adds: a booked slot, one a request still names and the owner's changes
inside the days it covers stay as they are. A Desk is made here as setup makes one: through `POST /desks` in a Rivera copy,
with its hours, then given its calendar and Answering through the owner's routes. The clock stands
at Friday 2026-10-30, 12:04 in Chicago, two days before the clocks there go back an hour.
"""

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

import httpx
import psycopg
import pytest
from fastapi import FastAPI
from sqlalchemy import select

from desk.calendar import calendar_slots
from desk.contracts import CalendarSlot, HoursWindow, RuleCard
from desk.db.models import PolicyVersion
from desk.db.models import Booking
from desk.db.models import CalendarSlot as SlotRow
from desk.db.session import database_url, libpq_url
from desk.kernel_service import desks
from desk.kernel_service.app import create_app
from desk.presets import PRESETS

from .helpers import draft_and_confirm, rows_of
from .test_adapters import Rivera, book, rivera
from .test_decide import open_visitor
from .test_desk_writes import LOPEZ_DESK, answered, entries_of, new_desk, post_desk, put_part, slot_body

TIMEZONE = "America/Chicago"                 # Lopez Electric's
ZONE = ZoneInfo(TIMEZONE)
TODAY = date(2026, 10, 30)                   # the frozen clock's day in Chicago
HOURS = [HoursWindow(days=["mon", "tue", "wed", "thu", "fri"], start=time(9), end=time(17))]


@dataclass(frozen=True)
class SetupDesk:
    copy: Rivera
    desk_id: str
    slug: str


def local_day(slot: CalendarSlot | SlotRow) -> date:
    return slot.starts_at.astimezone(ZONE).date()


def setup_calendar(days_ago: int) -> list[CalendarSlot]:
    """The calendar setup gave a Desk that finished `days_ago` days before today."""
    return calendar_slots(HOURS, TIMEZONE, TODAY - timedelta(days=days_ago))


def after(slots: list[CalendarSlot], day: date) -> list[CalendarSlot]:
    return [slot for slot in slots if local_day(slot) > day]


def as_rows(slots: list[CalendarSlot], copy_id: str) -> list[tuple]:
    return sorted((slot.slot_id, slot.starts_at, slot.minutes, copy_id) for slot in slots)


async def slots_of(app: FastAPI, desk: SetupDesk) -> list[tuple]:
    """The Desk's slots as stored: ID, start, length and copy, in ID order."""
    rows = await rows_of(app, desk.copy.copy_id, select(SlotRow).where(SlotRow.desk_id == desk.desk_id)
                         .order_by(SlotRow.slot_id))
    return [(row.slot_id, row.starts_at, row.minutes, row.copy_id) for row in rows]


async def head_of(app: FastAPI, desk: SetupDesk) -> tuple[int, str]:
    """The last entry on the Desk's ledger: its number and hash."""
    last = (await entries_of(app, desk.copy, desk.desk_id))[-1]
    return last.seq, last.hash


@asynccontextmanager
async def held(copy_id: str, statement: str, **params: str) -> AsyncIterator[None]:
    """`statement`, a `SELECT ... FOR UPDATE` or `FOR SHARE`, run as the kernel in a transaction of
    `copy_id` on a connection of its own, which holds the rows it locks until the block ends."""
    async with await psycopg.AsyncConnection.connect(libpq_url(database_url("KERNEL"))) as conn:
        await conn.execute("SELECT set_config('desk.copy_id', %(copy_id)s, true)", {"copy_id": copy_id})
        assert (await conn.execute(statement, params)).rowcount == 1
        yield


async def setup_desk(app: FastAPI, client: httpx.AsyncClient, copy: Rivera, slots: list[CalendarSlot], *,
                     hours: list[HoursWindow] = HOURS, answering: bool = True) -> SetupDesk:
    """A Desk in `copy` as setup leaves it: made through `POST /desks` with `hours`, then given the
    calendar `slots` and, when `answering`, Answering on, through the owner's routes."""
    response = await post_desk(client, copy, new_desk(desk=LOPEZ_DESK.model_copy(update={"hours": hours})))
    assert response.status_code == 200, response.text
    desk_id, slug = response.json()["desk_id"], response.json()["slug"]
    for part, body in (("calendar", {"calendar_slots": [slot.model_dump(mode="json") for slot in slots]}),
                       ("answering", {"on": answering})):
        response = await put_part(client, copy, part, body, desk_id=desk_id)
        assert response.status_code == 200, (part, response.text)
    return SetupDesk(copy=copy, desk_id=desk_id, slug=slug)


NOW = datetime(2026, 10, 30, 17, 4, 5, tzinfo=UTC)   # the frozen clock: Friday 12:04 in Chicago
WINDOW = calendar_slots(HOURS, TIMEZONE, TODAY)      # the 14 days from tomorrow


def slot_at(slot_id: str, day: date) -> CalendarSlot:
    return CalendarSlot(slot_id=slot_id, starts_at=datetime.combine(day, time(9), ZONE), minutes=60)


@pytest.mark.parametrize(("rows", "expected"), [
    ([], WINDOW),                                                             # none: 14 days from tomorrow
    ([slot_at("S-20261020-0900", TODAY - timedelta(days=10))], WINDOW),       # only past ones: 14 days too
    ([slot_at("S-20261119-0900", TODAY + timedelta(days=20))], []),           # already past 14 days: none
    ([slot_at("S-20261110-0900", TODAY - timedelta(days=1))],                 # an ID it has, on another day
     [slot for slot in WINDOW if slot.slot_id != "S-20261110-0900"]),
], ids=["no_slots", "only_past_slots", "beyond_the_window", "id_taken"])
def test_later_slots(rows, expected):
    assert desks.later_slots(HOURS, TIMEZONE, NOW, rows) == expected
    assert {local_day(slot) for slot in WINDOW} == {TODAY + timedelta(days=n) for n in range(1, 15)
                                                    if (TODAY + timedelta(days=n)).weekday() < 5}


async def test_the_calendar_is_refreshed_from_the_hours(app, client):
    copy = await rivera(app, client)
    made = setup_calendar(days_ago=11)       # setup finished 11 days ago: its slots end in 3 days
    assert max(local_day(slot) for slot in made) == TODAY + timedelta(days=3)
    desk = await setup_desk(app, client, copy, made)

    await desks.extend_calendars(app.state.kernel)

    # the days after its last slot, up to 14 days ahead, from its hours in Chicago time
    added = after(calendar_slots(HOURS, TIMEZONE, TODAY), TODAY + timedelta(days=3))
    assert {local_day(slot) for slot in added} == {date(2026, 11, day) for day in (3, 4, 5, 6, 9, 10, 11, 12, 13)}
    assert await slots_of(app, desk) == as_rows(made + added, copy.copy_id)
    # 09:00 in Chicago once the clocks have gone back: 15:00 UTC, an hour later than before
    assert ("S-20261103-0900", datetime(2026, 11, 3, 15, tzinfo=UTC), 60, copy.copy_id) in await slots_of(app, desk)
    # recorded as an owner's calendar write is, naming the slots it added and that the hours made them
    entry = (await entries_of(app, copy, desk.desk_id))[-1]
    assert (entry.event.kind, entry.event.origin, entry.event.session_id, entry.event.summary) == (
        "desk_data", "kernel", None,
        {"part": "calendar", "refs": [slot.slot_id for slot in added], "extended_from": "hours"})



@pytest.mark.solver
async def test_a_setup_desk_with_confirmed_rules_is_refreshed(desk_prove, app, client):
    """Every live setup Desk has confirmed the rules setup drafted: version 2 is active, made from
    no preset, and version 1, from `ask_first`, is superseded. That first version still marks it."""
    copy = await rivera(app, client)
    made = setup_calendar(days_ago=11)
    desk = await setup_desk(app, client, copy, made)
    book = RuleCard(card_id="book-weekday", applies_to="native.book", mode="auto", who="anyone", hours=HOURS[0],
                    review=True, reason="Weekday bookings in opening hours, checked by the reviewer.")
    confirmed = await draft_and_confirm(client, copy.owner_token, desk.desk_id, [*PRESETS["ask_first"], book])
    versions = await rows_of(app, copy.copy_id, select(PolicyVersion).where(PolicyVersion.desk_id == desk.desk_id)
                             .order_by(PolicyVersion.version))
    assert [(row.version, row.status, row.preset) for row in versions] == [
        (1, "superseded", "ask_first"), (confirmed.version, "active", None)]

    added = await desks.extend_calendars(app.state.kernel)

    later = after(calendar_slots(HOURS, TIMEZONE, TODAY), TODAY + timedelta(days=3))
    assert added == {desk.desk_id: [slot.slot_id for slot in later]}
    assert await slots_of(app, desk) == as_rows(made + later, copy.copy_id)

async def test_the_refresh_never_touches_a_slot_it_finds(app, client):
    copy = await rivera(app, client)
    made = setup_calendar(days_ago=9)        # its slots end on Wednesday, November 4
    # the owner took Tuesday off and made Monday's first visit 90 minutes
    edited = [slot.model_copy(update={"minutes": 90}) if slot.slot_id == "S-20261102-0900" else slot
              for slot in made if local_day(slot) != date(2026, 11, 3)]
    desk = await setup_desk(app, client, copy, edited)
    visitor = await open_visitor(client, desk)
    booked = await book(client, visitor, "S-20261102-1000", call_id="booked")   # the owner allows it: booked
    assert (await answered(client, copy, booked.decision_id, "allow_once")).decision.state == "executed"
    held = await book(client, visitor, "S-20261102-1100", call_id="held")       # waiting for the owner
    assert held.state == "held"
    before = await slots_of(app, desk)

    await desks.extend_calendars(app.state.kernel)

    # every slot it found is as it was, Tuesday stays off, and only the days after Wednesday are added
    added = after(calendar_slots(HOURS, TIMEZONE, TODAY), date(2026, 11, 4))
    assert await slots_of(app, desk) == sorted(before + as_rows(added, copy.copy_id))
    assert min(local_day(slot) for slot in added) == date(2026, 11, 5)
    [booking] = await rows_of(app, copy.copy_id, select(Booking).where(Booking.desk_id == desk.desk_id))
    assert (booking.slot_id, booking.status) == ("S-20261102-1000", "confirmed")



async def test_a_booking_holding_its_slot_doesnt_hold_up_the_refresh(app, client, monkeypatch):
    """A booking's T2 holds its slot `FOR SHARE` while it books it; the refresh only adds slots, so
    it neither waits for that nor makes the booking wait."""
    monkeypatch.setattr(desks, "CALENDAR_REFRESH_LOCK_S", 0.5)
    copy = await rivera(app, client)
    desk = await setup_desk(app, client, copy, setup_calendar(days_ago=11))
    async with held(copy.copy_id, "SELECT 1 FROM kernel.calendar_slots WHERE desk_id = %(desk_id)s"
                                  " AND slot_id = %(slot_id)s FOR SHARE", desk_id=desk.desk_id, slot_id="S-20261102-1000"):
        added = await asyncio.wait_for(desks.extend_calendars(app.state.kernel), timeout=5)
    assert len(added[desk.desk_id]) == 72

async def test_a_second_refresh_adds_nothing(app, client):
    copy = await rivera(app, client)
    desk = await setup_desk(app, client, copy, setup_calendar(days_ago=11))
    first = await desks.extend_calendars(app.state.kernel)
    assert len(first[desk.desk_id]) == 72                # nine weekdays of eight slots
    slots, head = await slots_of(app, desk), await head_of(app, desk)

    assert await desks.extend_calendars(app.state.kernel) == {}
    assert await slots_of(app, desk) == slots
    assert await head_of(app, desk) == head                              # nothing more on the record


async def test_only_a_live_setup_desk_with_hours_is_refreshed(app, client):
    copy = await rivera(app, client)
    seed = SetupDesk(copy=copy, desk_id=copy.desk_id, slug=copy.slug)
    # Rivera's seed, live with hours, its two-hour slots cut to end on Monday
    oakland = ZoneInfo("America/Los_Angeles")
    seed_slots = [slot_body(row) for row in await rows_of(app, copy.copy_id, select(SlotRow).where(
        SlotRow.desk_id == copy.desk_id).order_by(SlotRow.slot_id)) if row.starts_at.astimezone(oakland).date()
        <= date(2026, 11, 2)]
    response = await put_part(client, copy, "calendar", {"calendar_slots": seed_slots})
    assert response.status_code == 200, response.text
    made = setup_calendar(days_ago=11)       # each setup Desk's slots end in 3 days
    resting = await setup_desk(app, client, copy, made, answering=False)
    deleted = await setup_desk(app, client, copy, made)
    response = await client.delete(f"/desks/{deleted.desk_id}", headers=copy.owner)
    assert response.status_code == 204, response.text
    no_hours = await setup_desk(app, client, copy, made, hours=[])
    live = await setup_desk(app, client, copy, made)
    left = [seed, resting, deleted, no_hours]
    before = [(await slots_of(app, desk), await head_of(app, desk)) for desk in left]

    added = await desks.extend_calendars(app.state.kernel)

    assert list(added) == [live.desk_id]
    assert [(await slots_of(app, desk), await head_of(app, desk)) for desk in left] == before



async def test_a_rivera_copy_made_before_its_starter_questions_is_left_alone(app, client, frozen_clock):
    """Copies made before the seed wrote its starter questions have none: they are still Rivera's."""
    copy = await rivera(app, client)
    seed = SetupDesk(copy=copy, desk_id=copy.desk_id, slug=copy.slug)
    with psycopg.connect(libpq_url(database_url("ADMIN")), autocommit=True) as admin:
        deleted = admin.execute("DELETE FROM kernel.facts WHERE desk_id = %s AND fact_id LIKE 'charter:starter:%%'",
                                (copy.desk_id,)).rowcount
    assert deleted == 6
    frozen_clock.advance(7 * 24 * 60 * 60)   # a week on: its two-hour slots now end a week short of 14 days
    before = (await slots_of(app, seed), await head_of(app, seed))

    assert await desks.extend_calendars(app.state.kernel) == {}
    assert (await slots_of(app, seed), await head_of(app, seed)) == before

async def test_every_copys_desks_are_refreshed_in_their_own_copy(app, client):
    made = setup_calendar(days_ago=11)
    first = await setup_desk(app, client, await rivera(app, client), made)
    second = await setup_desk(app, client, await rivera(app, client), made)
    assert first.copy.copy_id != second.copy.copy_id

    added = await desks.extend_calendars(app.state.kernel)

    later = after(calendar_slots(HOURS, TIMEZONE, TODAY), TODAY + timedelta(days=3))
    assert added == {desk.desk_id: [slot.slot_id for slot in later] for desk in (first, second)}
    for desk in (first, second):
        assert await slots_of(app, desk) == as_rows(made + later, desk.copy.copy_id)
    # read across every copy: each Desk's slots, old and new, are all under its own copy
    with psycopg.connect(libpq_url(database_url("ADMIN"))) as admin:
        found = admin.execute("SELECT desk_id, copy_id, count(*) FROM kernel.calendar_slots"
                              " WHERE desk_id = ANY(%s) GROUP BY desk_id, copy_id ORDER BY desk_id",
                              ([first.desk_id, second.desk_id],)).fetchall()
    assert found == sorted((desk.desk_id, desk.copy.copy_id, len(made + later)) for desk in (first, second))


async def test_the_refresh_runs_beside_the_kernel_and_stops_with_it(app, frozen_clock, reviewer, monkeypatch):
    started, never = asyncio.Event(), asyncio.Event()

    async def slow_pass(runtime):
        started.set()
        await never.wait()                   # a pass that is still running

    monkeypatch.setattr(desks, "extend_calendars", slow_pass)
    kernel = create_app(app.state.kernel.settings, clock=frozen_clock, decisions=reviewer)
    async with kernel.router.lifespan_context(kernel):           # the kernel starts without waiting for it
        refreshing = kernel.state.calendar_refresh
        await asyncio.wait_for(started.wait(), timeout=5)        # the first pass runs at the start
        assert not refreshing.done()
    assert refreshing.cancelled()                                 # and stops with the kernel


async def test_a_failed_pass_is_logged_and_the_next_one_runs(monkeypatch, caplog):
    passes = 0

    async def flaky(runtime):
        nonlocal passes
        passes += 1
        if passes == 1:
            raise RuntimeError("the database went away")
        if passes == 3:
            raise asyncio.CancelledError     # stands for the kernel's shutdown

    monkeypatch.setattr(desks, "extend_calendars", flaky)
    with caplog.at_level(logging.INFO, logger="desk.kernel_service"), pytest.raises(asyncio.CancelledError):
        await desks.keep_calendars_open(None, every_s=0)
    assert passes == 3
    assert "calendar_refresh_failed kind=RuntimeError" in caplog.text


async def test_a_desk_another_write_holds_is_left_to_the_next_pass(app, client, monkeypatch, caplog):
    monkeypatch.setattr(desks, "CALENDAR_REFRESH_LOCK_S", 0.3)
    copy = await rivera(app, client)
    made = setup_calendar(days_ago=11)
    busy, other = await setup_desk(app, client, copy, made), await setup_desk(app, client, copy, made)
    # an owner's write holds the Desk row past the pass's wait
    async with held(copy.copy_id, "SELECT 1 FROM kernel.desks WHERE desk_id = %(desk_id)s FOR UPDATE",
                    desk_id=busy.desk_id):
        with caplog.at_level(logging.INFO, logger="desk.kernel_service"):
            added = await asyncio.wait_for(desks.extend_calendars(app.state.kernel), timeout=5)
    assert list(added) == [other.desk_id]
    assert (f"calendar_extend_failed copy_id={copy.copy_id} desk_id={busy.desk_id} kind=OperationalError "
            "sqlstate=55P03" in caplog.text)
    assert await slots_of(app, busy) == as_rows(made, copy.copy_id)   # rolled back, left to the next pass
    assert (await desks.extend_calendars(app.state.kernel)).keys() == {busy.desk_id}   # and taken then


async def test_a_stuck_lookup_leaves_the_other_copies_refreshed(app, client, monkeypatch, caplog):
    made = setup_calendar(days_ago=11)
    stuck = await setup_desk(app, client, await rivera(app, client), made)
    other = await setup_desk(app, client, await rivera(app, client), made)
    look_up = desks.desks_to_extend

    async def stalls_for_one(runtime, copy_id):
        if copy_id == stuck.copy.copy_id:
            await asyncio.Event().wait()     # a lookup stuck behind a lock that never goes
        return await look_up(runtime, copy_id)

    monkeypatch.setattr(desks, "desks_to_extend", stalls_for_one)
    monkeypatch.setattr(desks, "CALENDAR_LOOKUP_S", 1.5)
    with caplog.at_level(logging.INFO, logger="desk.kernel_service"):
        added = await asyncio.wait_for(desks.extend_calendars(app.state.kernel), timeout=10)
    assert list(added) == [other.desk_id]
    assert f"calendar_lookup_cut_off copy_id={stuck.copy.copy_id}" in caplog.text
