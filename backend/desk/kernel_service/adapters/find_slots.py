"""`native.find_slots`: the Desk's open appointment times, from its calendar.

`execute` lists up to six of the earliest unbooked slots that start after now, from `from_date`
(today in business time by default) for `days` days, and writes them as one `slots:<id>` fact
labelled for the session and good for 30 minutes, which the booking options card renders with
one choice per slot still free. Claude sees each slot's ID and local start, to book by ID.
"""

import re
from datetime import date, datetime, time, timedelta
from typing import Annotated, Any
from zoneinfo import ZoneInfo

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field
from sqlalchemy import select

from desk.contracts import Claim, Fact, NormalizedAction, ResourceRef, ToolProfile
from desk.db.models import Booking, CalendarSlot
from desk.db.models import Fact as FactRow
from desk.kernel_service import labels
from desk.kernel_service.adapters import register
from desk.kernel_service.adapters.base import AdapterResult, ExecCtx, Normalized, NormalizeCtx, business_timezone
from desk.kernel_service.repo import KernelCtx, new_id

MAX_SLOTS = 6
SLOTS_TTL = timedelta(minutes=30)


def _iso_date(value: Any) -> Any:
    """A date argument arrives as JSON text: only `YYYY-MM-DD` in ASCII digits is read as one
    (strict models take no other coercion)."""
    if isinstance(value, str):
        if not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", value):
            raise ValueError("a date is written YYYY-MM-DD")
        return date.fromisoformat(value)
    return value


LocalDate = Annotated[date, BeforeValidator(_iso_date)]


class FindSlotsArgs(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    from_date: LocalDate | None = None    # in the business's time zone; today when absent
    days: int = Field(7, ge=1, le=14)


PROFILE = ToolProfile(
    tool="native.find_slots", source="native", effects=["read"], reversible=True,
    adapter="desk.kernel_service.adapters.find_slots", resource_kind="desk",
    description_confirmed=(
        "Finds open appointment times on the business's calendar, from from_date (today if left out) for the "
        "number of days given. The times come from the business's records and the visitor sees them in a card "
        "to pick from, never in your own words. Book a time with its slot_id."),
    input_schema=FindSlotsArgs.model_json_schema(), status="enabled")


async def open_slots(ctx: KernelCtx, desk_id: str, *, tz: ZoneInfo, now: datetime, first_day: date,
                     days: int) -> list[CalendarSlot]:
    """The Desk's earliest slots (at most `MAX_SLOTS`) that start after `now`, on the `days` days
    from `first_day` in business time, without a confirmed booking."""
    start = datetime.combine(first_day, time(0), tzinfo=tz)
    end = datetime.combine(first_day + timedelta(days=days), time(0), tzinfo=tz)
    booked = set(await ctx.db.scalars(ctx.repo.scoped(select(Booking.slot_id).where(
        Booking.desk_id == desk_id, Booking.status == "confirmed"))))
    slots = await ctx.db.scalars(ctx.repo.scoped(select(CalendarSlot).where(
        CalendarSlot.desk_id == desk_id, CalendarSlot.starts_at > now, CalendarSlot.starts_at >= start,
        CalendarSlot.starts_at < end).order_by(CalendarSlot.starts_at, CalendarSlot.slot_id)))
    return [slot for slot in slots if slot.slot_id not in booked][:MAX_SLOTS]


def model_view(fact: Fact | None) -> dict[str, Any]:
    """What Claude sees: the fact to cite and each slot's ID and local start, read from the fact's
    claims (one `slot` then one `starts_at` per slot)."""
    if fact is None:
        return {"slots": []}
    ids, starts = fact.claims[0::2], fact.claims[1::2]
    return {"fact_id": fact.fact_id, "slots": [{"slot_id": slot.value, "starts_at_local": starts_at.value}
                                               for slot, starts_at in zip(ids, starts, strict=True)]}


class FindSlotsAdapter:
    profile = PROFILE
    Args = FindSlotsArgs
    free_text_fields: frozenset[str] = frozenset()
    model_view_keys = frozenset({"fact_id", "slots"})

    async def normalize(self, nctx: NormalizeCtx, args: FindSlotsArgs) -> Normalized:
        return Normalized(resource=ResourceRef(kind="desk", id=nctx.desk_row.desk_id, owner_person_id=None))

    async def execute(self, xctx: ExecCtx, action: NormalizedAction, args: FindSlotsArgs) -> AdapterResult:
        """The open slots as one fact for the session; with none, no fact (nothing to cite)."""
        ctx = xctx.ctx
        now = ctx.clock.now()
        tz = await business_timezone(ctx, xctx.desk_row)
        first_day = args.from_date or now.astimezone(tz).date()
        slots = await open_slots(ctx, action.desk_id, tz=tz, now=now, first_day=first_day, days=args.days)
        if not slots:
            return AdapterResult(model_view=model_view(None))
        claims = []
        for slot in slots:
            claims += [Claim(key="slot", kind="ref", value=slot.slot_id),
                       Claim(key="starts_at", kind="datetime", value=slot.starts_at.astimezone(tz).isoformat())]
        fact = Fact(fact_id=f"slots:{new_id('slots')}", kind="slots", status="available", source="kernel",
                    claims=claims, label=labels.new_fact_label(xctx.session_row), expires_at=now + SLOTS_TTL)
        ctx.db.add(labels.fact_row(action.copy_id, action.desk_id, fact, now,
                                   session_id=xctx.session_row.session_id, action_id=action.action_id))
        await ctx.db.flush()
        return AdapterResult(facts=[fact], model_view=model_view(fact))

    async def reconcile(self, xctx: ExecCtx, action: NormalizedAction) -> AdapterResult | None:
        """The slots fact the action wrote, if it wrote one."""
        ctx = xctx.ctx
        row = (await ctx.db.scalars(ctx.repo.scoped(select(FactRow).where(
            FactRow.desk_id == action.desk_id, FactRow.action_id == action.action_id)))).one_or_none()
        if row is None:
            return None
        fact = labels.fact_of(row)
        return AdapterResult(facts=[fact], model_view=model_view(fact))


ADAPTER = register(FindSlotsAdapter())
