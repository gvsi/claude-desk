"""`native.book`: one open slot of the Desk's calendar, booked by its ID.

`normalize` resolves the slot from `calendar_slots`: it must be this Desk's and start after now,
else the call is refused at step 1. The action carries the slot's start, so the owner's hours on
a booking card are checked against the slot, not against the time of asking.

`execute` books it through `commit_booking`, the one side effect, then writes a `booking:<id>`
fact labelled for the session (the booking confirmed card) and alerts the owner per the Desk's
notification defaults. The alert is read only from the owner's Demo inbox, so the result's `inbox`
stays empty. An optional untrusted note is saved separately as an owner-only knowledge fact,
quoted in the owner's alert, and never returned with the session's booking fact.
"""

from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from desk.contracts import SLOT_ID_PATTERN, Claim, Fact, Label, NormalizedAction, Principal, ResourceRef, ToolProfile
from desk.db.models import Booking, CalendarSlot, Person
from desk.db.models import Fact as FactRow
from desk.kernel_service import demo_inbox, labels, render
from desk.kernel_service.adapters import register
from desk.kernel_service.adapters.base import (QUOTED_CHARS, AdapterFailure, AdapterRefusal, AdapterResult, ExecCtx, Normalized,
                                               NormalizeCtx, business_timezone, claudes_note, quoted)
from desk.kernel_service.repo import KernelCtx, new_id

ONE_BOOKING_PER_SLOT = "bookings_one_confirmed_per_slot"    # the database's unique index on confirmed bookings


class BookArgs(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    slot_id: str = Field(pattern=SLOT_ID_PATTERN)
    note: str | None = Field(None, max_length=QUOTED_CHARS, description='Optional details for the owner only.')

    @field_validator('note')
    @classmethod
    def blank_owner_note(cls, note: str | None) -> str | None:
        return note if note and note.strip() else None


PROFILE = ToolProfile(
    tool="native.book", source="native", effects=["change"], reversible=True,
    adapter="desk.kernel_service.adapters.book", resource_kind="slot",
    description_confirmed=(
        "Books one open appointment time by the slot_id that find_slots gave. The time comes from the "
        "business's records and the visitor sees the confirmed booking in a card, never in your own words."),
    input_schema=BookArgs.model_json_schema(), status="enabled")


async def find_slot(ctx: KernelCtx, desk_id: str, slot_id: str, *, lock: bool = False) -> CalendarSlot | None:
    """The Desk's slot by its ID; with `lock`, held `FOR SHARE` (the adapter's own row, `repo.py`
    step 10), so the owner's calendar write, which takes the slots `FOR UPDATE`, can't drop or move
    it until the booking commits."""
    query = ctx.repo.scoped(select(CalendarSlot).where(
        CalendarSlot.desk_id == desk_id, CalendarSlot.slot_id == slot_id))
    if lock:
        query = query.with_for_update(read=True)
    return (await ctx.db.scalars(query)).one_or_none()


async def commit_booking(ctx: KernelCtx, action: NormalizedAction, slot: CalendarSlot, *,
                         person_id: str | None = None) -> Booking:
    """The booking's one side effect: a `confirmed` bookings row for the slot. The database's one
    confirmed booking per slot is the lock, so of two bookings racing for a slot one commits and
    the other gets `AdapterFailure("slot_taken")` with nothing written. Module-level, so tests and
    evals can patch it (`adapters.book.commit_booking`)."""
    booking = Booking(booking_id=new_id("booking"), copy_id=action.copy_id, desk_id=action.desk_id,
                      slot_id=slot.slot_id, starts_at=slot.starts_at, person_id=person_id, status="confirmed",
                      action_id=action.action_id, session_id=action.session_id)
    try:
        async with ctx.db.begin_nested():
            ctx.db.add(booking)
            await ctx.db.flush()
    except IntegrityError as exc:
        if getattr(getattr(exc.orig, "diag", None), "constraint_name", None) == ONE_BOOKING_PER_SLOT:
            raise AdapterFailure("slot_taken") from None
        raise
    return booking


def _clock(moment: datetime) -> str:
    return f"{moment.hour % 12 or 12}:{moment.minute:02d} {'am' if moment.hour < 12 else 'pm'}"


def owner_when(starts_at: datetime, minutes: int, tz: ZoneInfo) -> str:
    """A booking's day and window as the owner reads it: "Monday, November 2, from 12:00 pm to 2:00 pm"."""
    start = starts_at.astimezone(tz)
    end = start + timedelta(minutes=minutes)
    return f"{start:%A, %B} {start.day}, from {_clock(start)} to {_clock(end)}"


async def _who(ctx: KernelCtx, principal: Principal, person_id: str | None) -> str:
    """Who booked, as the owner reads it."""
    if principal.kind == "agent":
        return "A visiting agent"
    if person_id is None:
        return "A stranger"
    name = (await ctx.db.execute(ctx.repo.scoped(
        select(Person.display_name).where(Person.person_id == person_id)))).scalar_one_or_none()
    return name or "A verified customer"


def model_view(fact_id: str, booking_id: str) -> dict[str, Any]:
    return {"fact_id": fact_id, "booking_id": booking_id, "status": "confirmed"}


class BookAdapter:
    profile = PROFILE
    Args = BookArgs
    free_text_fields = frozenset({"note"})
    model_view_keys = frozenset({"fact_id", "booking_id", "status"})
    releases_private_data = False         # the booking the session made, labelled for the session too

    def appointment(self) -> tuple[str, int] | None:
        """Optional display metadata supplied by trusted adapter code, never visitor args."""
        return None

    async def normalize(self, nctx: NormalizeCtx, args: BookArgs) -> Normalized:
        if args.note and labels.find_canaries(args.note, await labels.copy_canaries(nctx.ctx)):
            raise AdapterRefusal("note_canary")
        slot = await find_slot(nctx.ctx, nctx.desk_row.desk_id, args.slot_id)
        if slot is None or slot.starts_at <= nctx.ctx.clock.now():
            raise AdapterRefusal("no_such_slot")
        return Normalized(resource=ResourceRef(kind="slot", id=slot.slot_id, owner_person_id=None),
                          starts_at=slot.starts_at)

    async def execute(self, xctx: ExecCtx, action: NormalizedAction, args: BookArgs) -> AdapterResult:
        """Books the slot the action resolved; a slot that changed or started since the execution
        re-check, or that another booking took, fails it before anything is written."""
        ctx = xctx.ctx
        now = ctx.clock.now()
        slot = await find_slot(ctx, action.desk_id, args.slot_id, lock=True)
        if slot is None or slot.starts_at != action.starts_at or slot.starts_at <= now:
            raise AdapterFailure("slot_changed")
        label = labels.new_fact_label(xctx.session_row)
        booking = await commit_booking(ctx, action, slot, person_id=label.record_owner)
        tz = await business_timezone(ctx, xctx.desk_row)
        fact = Fact(fact_id=f"booking:{booking.booking_id}", kind="booking", status="committed", source="kernel",
                    claims=[Claim(key="starts_at", kind="datetime", value=slot.starts_at.astimezone(tz).isoformat()),
                            Claim(key="minutes", kind="text", value=str(slot.minutes)),
                            Claim(key="booking", kind="ref", value=booking.booking_id)],
                    label=label)
        appointment = self.appointment()
        if appointment is not None:
            appointment_type, minutes = appointment
            fact.claims.extend([Claim(key="appointment_type", kind="text", value=appointment_type),
                                Claim(key="appointment_minutes", kind="text", value=str(minutes))])
        ctx.db.add(labels.fact_row(action.copy_id, action.desk_id, fact, now, session_id=xctx.session_row.session_id,
                                   action_id=action.action_id))
        if args.note:
            note = Fact(fact_id=f"booking_note:{booking.booking_id}", kind="knowledge", status="committed",
                        source="kernel", claims=[Claim(key="booking", kind="ref", value=booking.booking_id),
                                                  Claim(key="note", kind="text", value=args.note)],
                        label=Label(readers=["owner"]))
            ctx.db.add(labels.fact_row(action.copy_id, action.desk_id, note, now,
                                       session_id=xctx.session_row.session_id, action_id=action.action_id))
        await ctx.db.flush()
        who = await _who(ctx, xctx.principal, label.record_owner)
        booked_type = f"{quoted(appointment[0])} " if appointment is not None else ""
        note_text = f" {claudes_note((args.note,))}" if args.note else ""
        await demo_inbox.alert_owner(ctx, action.desk_id, "booking", render.owner_preview("booking"),
                                     f"{who} booked {booked_type}{owner_when(slot.starts_at, slot.minutes, tz)}.{note_text}")
        return AdapterResult(facts=[fact], model_view=model_view(fact.fact_id, booking.booking_id))

    async def reconcile(self, xctx: ExecCtx, action: NormalizedAction) -> AdapterResult | None:
        """The booking the action made, if it made one."""
        ctx = xctx.ctx
        booking = (await ctx.db.scalars(ctx.repo.scoped(
            select(Booking).where(Booking.action_id == action.action_id)))).one_or_none()
        if booking is None:
            return None
        fact = (await ctx.db.scalars(ctx.repo.scoped(select(FactRow).where(
            FactRow.desk_id == action.desk_id, FactRow.action_id == action.action_id,
            FactRow.fact_id == f"booking:{booking.booking_id}")))).one()
        return AdapterResult(facts=[labels.fact_of(fact)], model_view=model_view(fact.fact_id, booking.booking_id))


ADAPTER = register(BookAdapter())
