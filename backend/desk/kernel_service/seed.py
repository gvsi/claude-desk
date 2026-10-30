"""The Rivera Plumbing seed: the demo business every visitor gets a fresh copy of.

`POST /copies` writes it through `desks.create_desk`, the same path as an owner's new Desk, so a
copy differs from another only in its IDs, canaries and dates. `RIVERA_CARDS` have fixed IDs and
are scoped `anyone`, `verified` or `record_owner`, never to a person, so they compile to the same
Cedar in every copy and share one CI-proved report. Once the cards are active, `seed_held_request`
puts one held request on the owner's Today, decided like any other.
"""

from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from desk.contracts import (
    BusinessSeed,
    CalendarSlot,
    Claim,
    Decision,
    DeskSeed,
    HoursWindow,
    NotificationDefaults,
    PriceItem,
    RuleCard,
    SeedDocument,
    SeedPerson,
    ToolCall,
)
from desk.kernel_api import DecideRequest
from desk.kernel_service import sessions
from desk.kernel_service.repo import KernelCtx
from desk.presets import PRESETS

__all__ = ["PRESETS", "RIVERA_CARDS", "rivera_seed", "seed_held_request"]

TIMEZONE = "America/Los_Angeles"
WEEKDAYS = ["mon", "tue", "wed", "thu", "fri"]
WEEKDAY_HOURS = HoursWindow(days=WEEKDAYS, start=time(8), end=time(18))
SATURDAY_HOURS = HoursWindow(days=["sat"], start=time(9), end=time(13))

SLOT_MINUTES = 120
SLOT_DAYS = 14                              # slots for the 14 days after the copy is created
SLOT_STARTS = {                             # by weekday (Monday 0), in business time
    **{weekday: (time(8), time(10), time(12), time(14), time(16)) for weekday in range(5)},
    5: (time(9), time(11)),
}

RIVERA_CARDS: list[RuleCard] = [
    *(card for card in PRESETS["ask_first"] if card.mode == "auto"),
    RuleCard(card_id="rv-quote", applies_to="native.quote", mode="auto", who="anyone", max_discount_bp=0,
             reason="Quotes from your price list, at list price."),
    RuleCard(card_id="rv-book-wk", applies_to="native.book", mode="auto", who="anyone", hours=WEEKDAY_HOURS,
             review=True, reason="Weekday bookings in opening hours, checked by the reviewer."),
    RuleCard(card_id="rv-book-sat", applies_to="native.book", mode="auto", who="anyone", hours=SATURDAY_HOURS,
             review=True, reason="Saturday morning bookings, checked by the reviewer."),
    RuleCard(card_id="rv-docs", applies_to="native.release_document", mode="auto", who="record_owner",
             reason="Customers get their own documents after confirming it's them."),
]

# The held request: drain clearing at 15% off, which `rv-quote` (list price only) holds for Maria.
HELD_REQUEST = ToolCall(call_id="seed-held-quote", tool="native.quote",
                        args={"items": [{"item_id": "drain", "qty": 1}], "requested_discount_bp": 1500})


def rivera_seed(now: datetime) -> tuple[BusinessSeed, DeskSeed]:
    """Rivera Plumbing and its Desk "Main line", with calendar slots for the 14 days after `now`."""
    business = BusinessSeed(
        name="Rivera Plumbing",
        owner_display_name="Maria Rivera",
        timezone=TIMEZONE,
        brand={"primary": "#1F4E4A", "accent": "#B87333"},
    )
    desk = DeskSeed(
        name="Main line",
        charter=[
            Claim(key="contact", kind="text", value="(510) 555-0142"),
            Claim(key="policy:service_area", kind="text",
                  value="We work in Oakland, Berkeley, Alameda and Emeryville."),
            Claim(key="policy:first_visit", kind="text",
                  value="The service call deposit is credited to the repair if you go ahead."),
            Claim(key="policy:arrival", kind="text", value="Maria texts before she arrives."),
        ],
        hours=[WEEKDAY_HOURS, SATURDAY_HOURS],
        price_items=[
            PriceItem(item_id="deposit", title="Service call deposit", unit_cents=2000),
            PriceItem(item_id="drain", title="Drain clearing", unit_cents=18000),
            PriceItem(item_id="heater", title="Water heater flush", unit_cents=15000),
            PriceItem(item_id="leak", title="Leak repair", unit_cents=25000),
        ],
        calendar_slots=calendar_slots(now),
        people=[
            SeedPerson(ref="dana", display_name="Dana Whitfield", contact="dana@example.com"),
            SeedPerson(ref="bob", display_name="Bob Okafor", contact="bob@example.com"),
        ],
        documents=[
            SeedDocument(ref="dana-invoice", title="Invoice, drain clearing", record_owner_ref="dana",
                         body="Rivera Plumbing\nInvoice for Dana Whitfield\n"
                              "Drain clearing, kitchen sink: $180.00\nPaid in full. Thank you."),
            SeedDocument(ref="bob-warranty", title="Warranty, water heater flush", record_owner_ref="bob",
                         body="Rivera Plumbing\nWarranty for Bob Okafor\n"
                              "Water heater flush. Parts and labor are covered for 12 months from the service date."),
        ],
        notifications=NotificationDefaults(now=["approval", "emergency", "breaker", "lockout"],
                                           briefing=["lead", "callback", "booking"]),
    )
    return business, desk


def calendar_slots(now: datetime) -> list[CalendarSlot]:
    """Two-hour slots on each of the `SLOT_DAYS` business days after `now`'s date in business time,
    IDs `S-<yyyymmdd>-<hhmm>` (the local start)."""
    tz = ZoneInfo(TIMEZONE)
    today: date = now.astimezone(tz).date()
    slots = []
    for offset in range(1, SLOT_DAYS + 1):
        day = today + timedelta(days=offset)
        for start in SLOT_STARTS.get(day.weekday(), ()):
            starts_at = datetime.combine(day, start, tzinfo=tz)
            slots.append(CalendarSlot(slot_id=starts_at.strftime("S-%Y%m%d-%H%M"), starts_at=starts_at,
                                      minutes=SLOT_MINUTES))
    return slots


async def seed_held_request(ctx: KernelCtx, copy_id: str, desk_id: str) -> Decision:
    """The request waiting on a new copy's Today: a visitor session of its own (its token is
    discarded, so no one can speak for it) asks for `HELD_REQUEST`, and `decide.decide_call`
    decides it as it would any call, so it is a signed, ledgered hold that alerts the owner. Runs
    in the caller's transaction, after the seed's cards are active."""
    from desk.kernel_service import decide       # decide imports activation, which imports this module

    ctx.bind(copy_id)
    visitor, _ = await sessions.open_visitor(ctx, copy_id, desk_id)
    request = DecideRequest(session_id=visitor.session_id, generation=visitor.generation,
                            call=HELD_REQUEST.model_copy(deep=True))
    return await decide.decide_call(ctx, sessions.principal_for(visitor), visitor, request)
