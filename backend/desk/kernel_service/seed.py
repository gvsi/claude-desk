"""The Rivera Plumbing seed: the demo business every visitor gets a fresh copy of.

`POST /copies` writes it through `desks.create_desk`, the same path as an owner's new Desk, so a
copy differs from another only in its IDs, canaries and dates. `RIVERA_CARDS` have fixed IDs and
are scoped `anyone`, `verified` or `record_owner`, never to a person, so they compile to the same
Cedar in every copy and share one CI-proved report.
"""

from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from desk.contracts import (
    BusinessSeed,
    CalendarSlot,
    Claim,
    DeskSeed,
    HoursWindow,
    NotificationDefaults,
    PriceItem,
    RuleCard,
    SeedDocument,
    SeedPerson,
)
from desk.presets import PRESETS

__all__ = ["PRESETS", "RIVERA_CARDS", "rivera_seed"]

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
