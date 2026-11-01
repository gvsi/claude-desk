"""The kernel keeps a setup-made Desk's calendar open.

Setup gives a new Desk 60-minute slots from its hours for the 14 days after setup finishes, once.
So a live Desk doesn't run out of open times, the kernel adds the days after its latest slot, up to
14 days ahead, from its hours in its business's time zone (`desks.extend_calendars`), at its start
and then daily. It only adds: a booked slot, one a request still names and the owner's own changes
stay as they are. A Desk is made here as setup makes one: through `POST /desks` in a Rivera copy,
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
from desk.contracts import CalendarSlot, HoursWindow
from desk.db.models import Booking
from desk.db.models import CalendarSlot as SlotRow
from desk.db.session import database_url, libpq_url
from desk.kernel_service import desks
from desk.kernel_service.app import create_app

from .helpers import rows_of
from .test_adapters import Rivera, book, rivera
from .test_decide import open_visitor
from .test_desk_writes import LOPEZ_DESK, answered, entries_of, new_desk, post_desk, put_part, slot_body
from .test_verification import api_rows

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
    for desk in (first, second):             # each slot under its own Desk's copy, and only there
        assert await slots_of(app, desk) == as_rows(made + later, desk.copy.copy_id)
        assert api_rows(desk.copy.copy_id, "SELECT DISTINCT copy_id FROM kernel_ro.calendar_slots") == [
            (desk.copy.copy_id,)]


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


async def test_a_desk_that_fails_leaves_the_others_refreshed(app, client, monkeypatch, caplog):
    made = setup_calendar(days_ago=11)
    failing = await setup_desk(app, client, await rivera(app, client), made)
    other = await setup_desk(app, client, await rivera(app, client), made)
    extend = desks.extend_calendar

    async def fails_for_one(ctx, desk_id):
        if desk_id == failing.desk_id:
            raise RuntimeError("one Desk's write failed")
        return await extend(ctx, desk_id)

    monkeypatch.setattr(desks, "extend_calendar", fails_for_one)
    with caplog.at_level(logging.INFO, logger="desk.kernel_service"):
        assert list(await desks.extend_calendars(app.state.kernel)) == [other.desk_id]
    assert (f"calendar_extend_failed copy_id={failing.copy.copy_id} desk_id={failing.desk_id} kind=RuntimeError"
            in caplog.text)
    assert await slots_of(app, failing) == as_rows(made, failing.copy.copy_id)   # rolled back, left to the next pass
