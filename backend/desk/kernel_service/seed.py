"""The Rivera Plumbing seed: the demo business every visitor gets a fresh copy of.

`POST /copies` writes it through `desks.create_desk`, the same path as an owner's new Desk, so a
copy differs from another only in its IDs, canaries and dates. `seed_knowledge` stores what setup
would have left the Desk knowing (`RIVERA_KNOWLEDGE`: the website read and the price list, public,
with no amount in either) through the owner's own path. The seed connects the mock payments
server (`connections`), with both its tools pinned at the hashes the seed is proved with, and
`seed_charges` gives Dana and Bob their past payments there (`RIVERA_MOCKPAY_CHARGES`), each with a
`charge:<id>` fact naming it for its owner. `RIVERA_CARDS` have fixed IDs and are scoped `anyone`,
`verified` or `record_owner`, never to a person, so they compile to the same Cedar in every copy and
share one CI-proved report. Once the cards are active, `seed_held_request` puts one held request on
the owner's Today, decided like any other.
"""

import logging
from datetime import date, datetime, time, timedelta
from typing import NamedTuple
from zoneinfo import ZoneInfo

from sqlalchemy import select

from desk.contracts import (
    BusinessSeed,
    CalendarSlot,
    Claim,
    DeskSeed,
    Fact,
    HoursWindow,
    KnowledgeItem,
    Label,
    NotificationDefaults,
    PriceItem,
    RuleCard,
    SeedDocument,
    SeedPerson,
    SeededChat,
    ToolCall,
)
from desk.db.models import Person
from desk.kernel_api import DecideRequest
from desk.kernel_service import labels, sessions
from desk.kernel_service.repo import KernelCtx, KernelFailure
from desk.presets import PRESETS

__all__ = ["PRESETS", "RIVERA_CARDS", "RIVERA_KNOWLEDGE", "RIVERA_MOCKPAY_CHARGES", "RIVERA_MONEY_CAP_CENTS",
           "rivera_seed", "seed_charges", "seed_held_request", "seed_knowledge"]

log = logging.getLogger(__name__)

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

# The money cap of the seed's rules version: $500, the most Claude takes or pays out in one action
# without asking Maria (master plan, "Money cap"), so the demo keeps its numbers.
RIVERA_MONEY_CAP_CENTS = 50_000

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
    RuleCard(card_id="rv-link", applies_to="native.payment_link", mode="auto", who="anyone", max_amount_cents=30_000,
             review=True, reason="Payment links up to $300, checked by the reviewer."),
    RuleCard(card_id="rv-charges", applies_to="payments.list_charges", mode="auto", who="record_owner",
             reason="Customers see their own past payments after confirming it's them."),
    RuleCard(card_id="rv-refund", applies_to="payments.create_refund", mode="ask", who="record_owner",
             reason="Refunds of a customer's own payment ask you first."),
    RuleCard(card_id="rv-mandate", applies_to="native.charge_mandate", mode="auto", who="anyone",
             max_amount_cents=2_000, reason="Visiting agents pay up to $20, within the limits of their signed mandate."),
]


class SeedCharge(NamedTuple):
    """A past payment at the mock payments server: whose (a `SeedPerson.ref`), how much, for what,
    and how many days before the copy was made."""

    person_ref: str
    amount_cents: int
    title: str
    days_ago: int


RIVERA_MOCKPAY_CHARGES: list[SeedCharge] = [
    SeedCharge("dana", 18_000, "Drain clearing", 21),
    SeedCharge("dana", 25_000, "Leak repair", 9),
    SeedCharge("bob", 15_000, "Water heater flush", 30),
]

# What the Desk knows on a new copy, as setup leaves it (Settings › Knowledge): the website read
# and the price list from Maria's answers, both public. Knowledge is untrusted text, never policy,
# and states no amount: a price reaches a visitor only on a quote card built from the price list.
RIVERA_KNOWLEDGE: list[KnowledgeItem] = [
    KnowledgeItem(item_id="kn-website", source="website",
                  title="Your website, rivera-plumbing.example, read during setup",
                  text="Rivera Plumbing is Maria Rivera's home plumbing business: drain clearing, leak repair and "
                       "water heater flushes. We work in Oakland, Berkeley, Alameda and Emeryville.",
                  label=Label(readers=["public"])),
    KnowledgeItem(item_id="kn-price-list", source="setup", title="Price list, from your answers in setup",
                  text="The price list Maria gave in setup covers the service call deposit, drain clearing, a "
                       "water heater flush and leak repair. Each price is given in a quote from this list.",
                  label=Label(readers=["public"])),
]

# The held request: drain clearing at 15% off, which `rv-quote` (list price only) holds for Maria.
HELD_REQUEST = ToolCall(call_id="seed-held-quote", tool="native.quote",
                        args={"items": [{"item_id": "drain", "qty": 1}], "requested_discount_bp": 1500})
HELD_REQUEST_VISITOR_LINE = "Could you do the drain clearing at 15% off?"


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
        auto_money_cap_cents=RIVERA_MONEY_CAP_CENTS,
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
        connections=["mock_payments"],
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


async def seed_knowledge(ctx: KernelCtx, desk_id: str, items: list[KnowledgeItem]) -> list[KnowledgeItem]:
    """The Desk's knowledge `items`, in the caller's transaction, each through
    `labels.store_knowledge` as an owner's item is: checked, read for canaries and ledgered
    `desk_data`. Returns them as stored."""
    return [await labels.store_knowledge(ctx, desk_id, item) for item in items]


async def seed_charges(ctx: KernelCtx, desk_id: str, charges: list[SeedCharge]) -> list[str]:
    """The Desk's people's past payments, made at the mock payments server for the bound copy
    (`/provider/seed`), each with a `charge:<id>` fact in the caller's transaction holding its
    title, total, date and ID, readable by the owner and the person it belongs to. A server that
    can't be reached, or answers otherwise, is 503 `internal` (logged `mockpay_unavailable`), so the
    copy rolls back; the charges it may have made belong to a copy that never exists. Returns their IDs."""
    from desk.kernel_service import payments     # payments imports activation, which imports this module

    now = ctx.clock.now()
    people = dict((await ctx.db.execute(ctx.repo.scoped(
        select(Person.ref, Person.person_id).where(Person.desk_id == desk_id)))).all())
    made = [payments.SeedCharge(owner_person_id=people[charge.person_ref], amount_cents=charge.amount_cents,
                                description=charge.title, created_at=now - timedelta(days=charge.days_ago))
            for charge in charges]
    try:
        charge_ids = await payments.provider(ctx).seed(made)
    except (payments.ProviderError, payments.ProviderTimeout):
        log.warning("mockpay_unavailable copy_id=%s op=seed", ctx.copy_id)
        raise KernelFailure(503, "internal", "mockpay_unavailable") from None
    if len(charge_ids) != len(made):
        log.warning("mockpay_unavailable copy_id=%s op=seed reason=count", ctx.copy_id)
        raise KernelFailure(503, "internal", "mockpay_unavailable")
    for charge_id, charge in zip(charge_ids, made, strict=True):
        person = charge.owner_person_id
        ctx.db.add(labels.fact_row(ctx.copy_id, desk_id, Fact(
            fact_id=f"charge:{charge_id}", kind="charge", status="committed", source="kernel",
            claims=[Claim(key="title", kind="text", value=charge.description),
                    Claim(key="total", kind="money", value=charge.amount_cents),
                    Claim(key="starts_at", kind="datetime", value=charge.created_at.isoformat()),
                    Claim(key="ref", kind="ref", value=charge_id)],
            label=Label(readers=["owner", f"person:{person}"], record_owner=person)), now))
    await ctx.db.flush()
    return charge_ids


async def seed_held_request(ctx: KernelCtx, copy_id: str, desk_id: str) -> SeededChat:
    """The request waiting on a new copy's Today: a visitor session of its own (its token is
    discarded, so no one can speak for it) asks for `HELD_REQUEST`, and `decide.decide_call`
    decides it as it would any call, so it is a signed, ledgered hold that alerts the owner. Runs
    in the caller's transaction, after the seed's cards are active. Returns the session, the
    visitor's own words (untrusted text) and that decision for the API's transcript."""
    from desk.kernel_service import decide       # decide imports activation, which imports this module

    ctx.bind(copy_id)
    visitor, _ = await sessions.open_visitor(ctx, copy_id, desk_id)
    request = DecideRequest(session_id=visitor.session_id, generation=visitor.generation,
                            call=HELD_REQUEST.model_copy(deep=True))
    decision = await decide.decide_call(ctx, sessions.principal_for(visitor), visitor, request)
    return SeededChat(session_id=visitor.session_id, visitor_line=HELD_REQUEST_VISITOR_LINE, decision=decision)
