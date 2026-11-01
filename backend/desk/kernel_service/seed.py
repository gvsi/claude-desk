"""The Turner Plumbing seed: the demo business every visitor gets a fresh copy of.

`POST /copies` writes it through `desks.create_desk`, the same path as an owner's new Desk, so a
copy differs from another only in its IDs, canaries and dates. `seed_knowledge` stores what setup
would have left the Desk knowing (`RIVERA_KNOWLEDGE`: the website read and the price list, public,
with no amount in either) through the owner's own path. The seed connects the mock payments
server (`connections`), with both its tools pinned at the hashes the seed is proved with, and
`seed_charges` gives Dana and Bob their past payments there (`RIVERA_MOCKPAY_CHARGES`), each with a
`charge:<id>` fact naming it for its owner. `seed_business_tools` gives the Desk its urgent
business tool (`RIVERA_BUSINESS_TOOLS`: "Emergency callback", in Mike's words for an emergency)
through the owner's own replacement, so its text is checked as his would be, and the seed's rules
version turns it on as it activates, as a confirmed review of the tool would. `RIVERA_CARDS` have
fixed IDs and are scoped `anyone`, `verified` or `record_owner`, never to a person, so they compile
to the same Cedar in every copy and share one CI-proved report, which covers the urgent tool at its
definition. Once the cards are active, `seed_held_request` puts one held request on the owner's
Today, decided like any other.

`seed_starters` adds the seed-only public questions after Desk creation, since owner and setup
charter writes refuse their keys. They are neither business facts for Claude nor reviewer input.
"""

import logging
from datetime import date, datetime, time, timedelta
from typing import Literal, NamedTuple
from zoneinfo import ZoneInfo

from sqlalchemy import select

from desk.contracts import (
    BRAND_PALETTE,
    BusinessSeed,
    BusinessTool,
    CalendarSlot,
    Claim,
    DeskSeed,
    Fact,
    HoursWindow,
    KnowledgeItem,
    Label,
    NotificationDefaults,
    PriceItem,
    ReplayedEvent,
    RuleCard,
    SeedDocument,
    SeedPerson,
    SeededChat,
    ToolCall,
    UrgentConfig,
)
from desk.db.models import Person
from desk.kernel_api import BusinessToolsRequest, DecideRequest, ToolPin
from desk.kernel_service import labels, sessions
from desk.kernel_service.repo import KernelCtx, KernelFailure
from desk.presets import PRESETS

__all__ = ["PRESETS", "RIVERA_BUSINESS_TOOLS", "RIVERA_CARDS", "RIVERA_KNOWLEDGE", "RIVERA_MOCKPAY_CHARGES",
           "RIVERA_MONEY_CAP_CENTS", "RIVERA_SAMPLE_WEEK", "SAMPLE_WEEK_ID", "rivera_seed", "seed_business_tools",
           "seed_charges", "seed_held_request", "seed_knowledge", "seed_sample_week", "seed_starters"]

log = logging.getLogger(__name__)

TIMEZONE = "America/Los_Angeles"
WEEKDAYS = ["mon", "tue", "wed", "thu", "fri"]
WEEKDAY_HOURS = HoursWindow(days=WEEKDAYS, start=time(8), end=time(18))
SATURDAY_HOURS = HoursWindow(days=["sat"], start=time(9), end=time(13))

# Claim.value is a scalar, so each seed-only question has a text claim per language.
RIVERA_STARTERS = {
    "en": ["How much is drain clearing?", "Can someone come Tuesday?", "Do you work in Alameda?"],
    "es": ["¿Cuánto cuesta destapar un desagüe?", "¿Puede venir alguien el martes?", "¿Trabajan en Alameda?"],
}

SLOT_MINUTES = 120
SLOT_DAYS = 14                              # slots for the 14 days after the copy is created
SLOT_STARTS = {                             # by weekday (Monday 0), in business time
    **{weekday: (time(8), time(10), time(12), time(14), time(16)) for weekday in range(5)},
    5: (time(9), time(11)),
}

# The money cap of the seed's rules version: $500, the most Claude takes or pays out in one action
# without asking Mike (master plan, "Money cap"), so the demo keeps its numbers.
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
    RuleCard(card_id="rv-urgent", applies_to="desk.emergency-callback", mode="auto", who="anyone",
             reason="Anyone can ask for an urgent callback, which alerts you at once."),
]

# Mike's urgent business tool (the urgent block): an emergency call-back that alerts him at once,
# whatever his notification settings. It is given to anyone who is given the native callback, and
# `rv-urgent` allows it. Its words are the owner's, checked as card text: no amount, currency,
# percentage or promise.
RIVERA_BUSINESS_TOOLS: list[BusinessTool] = [
    BusinessTool(tool="desk.emergency-callback", title="Emergency callback",
                 description="Asks Mike to call back urgently about an emergency.",
                 config=UrgentConfig(block="urgent",
                                     urgent_when="A burst or leaking pipe, flooding, a sewage backup, or no water")),
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
# and the price list from Mike's answers, both public. Knowledge is untrusted text, never policy,
# and states no amount: a price reaches a visitor only on a quote card built from the price list.
RIVERA_KNOWLEDGE: list[KnowledgeItem] = [
    KnowledgeItem(item_id="kn-website", source="website",
                  title="Your website, turner-plumbing.example, read during setup",
                  text="Turner Plumbing is Mike Turner's home plumbing business: drain clearing, leak repair and "
                       "water heater flushes. We work in Oakland, Berkeley, Alameda and Emeryville.",
                  label=Label(readers=["public"])),
    KnowledgeItem(item_id="kn-price-list", source="setup", title="Price list, from your answers in setup",
                  text="The price list Mike gave in setup covers the service call deposit, drain clearing, a "
                       "water heater flush, leak repair, pipe repair (starting price) and a short-notice fee. "
                       "The short-notice fee is added to an urgent visit that Mike fits in at short notice. Each price is given in a quote from this list.",
                  label=Label(readers=["public"])),
]

# The held request: drain clearing at 15% off, which `rv-quote` (list price only) holds for Mike.
HELD_REQUEST = ToolCall(call_id="seed-held-quote", tool="native.quote",
                        args={"items": [{"item_id": "drain", "qty": 1}], "requested_discount_bp": 1500})
HELD_REQUEST_VISITOR_LINE = "Could you do the drain clearing at 15% off?"


# The sample week (`seed_sample_week`, on a hosted copy only): a hand-written week of finished conversations a new
# copy opens on, so Today's "Last 7 days" isn't empty. It is written, not recorded: each conversation is one
# visitor's words, the calls Claude made and how each ended, and Claude's reply. `sample_week.write` turns it into
# the copy's own rows and marked ledger entries. Its words name no seeded person and neither the owner nor the
# business: those come from the seed's own values, through the kernel's templates and cards.
SAMPLE_WEEK_ID = "sample-week-v1"


class SampleCall(NamedTuple):
    """One call Claude made in a sample conversation and how it ended: `executed`, `refused` at step 1 with the
    adapter's `check` (`AdapterRefusal.code`), or held and then `denied` by the owner `answered_s` seconds after
    the visitor's message. A booking's slot is the sample's own past one: the first day after the conversation, and
    before today, that has a slot, at `slot_start` when that day has one (`sample_week.past_slot`)."""

    at_s: int                             # seconds after the visitor's message
    tool: str
    args: dict
    outcome: Literal["executed", "refused", "denied"]
    check: str | None = None
    answered_s: int | None = None
    slot_start: time | None = None


class SampleSession(NamedTuple):
    """One sample conversation: a visitor's message on the local day `days_back` days before the copy was made, at
    `start` in the business's time, the calls Claude made, and Claude's reply `reply_s` seconds later (its prose,
    then a card per template in `cards`, each citing the fact this conversation's call wrote). A callback the owner
    handled `handled_s` seconds after the message."""

    days_back: int
    start: time
    said: str
    calls: tuple[SampleCall, ...]
    reply_s: int
    prose: str
    cards: tuple[str, ...] = ()
    handled_s: int | None = None


def _quote_call(at_s: int, item_id: str, outcome: Literal["executed", "refused", "denied"] = "executed", *,
                discount_bp: int = 0, check: str | None = None, answered_s: int | None = None) -> SampleCall:
    return SampleCall(at_s, "native.quote", {"items": [{"item_id": item_id, "qty": 1}],
                                             "requested_discount_bp": discount_bp},
                      outcome, check=check, answered_s=answered_s)


def _book_call(at_s: int, start: time) -> SampleCall:
    return SampleCall(at_s, "native.book", {}, "executed", slot_start=start)


RIVERA_SAMPLE_WEEK: list[SampleSession] = [
    SampleSession(6, time(9, 10),
                  "Hi, our kitchen sink has been draining slowly for days. What does drain clearing cost, and could "
                  "someone come out on the next morning you have free?",
                  (_quote_call(20, "drain"), _book_call(55, time(10))), 70,
                  "Here's the price for drain clearing from the price list, and your visit is booked.",
                  ("quote", "booking_confirmed")),
    SampleSession(5, time(18, 40),
                  "Our water heater has started rumbling. How much is a flush? Please book the first morning visit "
                  "you can.",
                  (_quote_call(25, "heater"), _book_call(60, time(10))), 75,
                  "Here's the price for a water heater flush from the price list, and your visit is booked.",
                  ("quote", "booking_confirmed")),
    SampleSession(4, time(20, 15),
                  "My neighbor got a quote from you this week. Can you send me a link so I can pay it for her? "
                  "She said the quote number is Q-4471.",
                  (SampleCall(30, "native.payment_link", {"quote_id": "Q-4471"}, "refused", check="no_such_quote"),),
                  45,
                  "I can only make a payment link for a quote given in this conversation. If you tell me what the "
                  "job is, I can quote it here."),
    SampleSession(3, time(12, 25),
                  "There's water dripping under the bathroom sink. What would a leak repair cost? Please book the "
                  "earliest afternoon visit.",
                  (_quote_call(20, "leak"), _book_call(50, time(14))), 65,
                  "Here's the price for a leak repair from the price list, and your visit is booked.",
                  ("quote", "booking_confirmed")),
    SampleSession(2, time(11, 5),
                  "Hi, I'm Marcus. Could someone call me back about replacing an old shut-off valve? My number is "
                  "(510) 555-0163.",
                  (SampleCall(25, "native.request_callback",
                              {"name": "Marcus", "contact": "(510) 555-0163",
                               "reason": "Replacing an old shut-off valve"}, "executed"),),
                  40, "I've asked for a call back about the valve.", ("callback_confirmed",), handled_s=3 * 3600),
    SampleSession(2, time(19, 30),
                  "Could you do the water heater flush at 10% off? Money's a bit tight this month.",
                  (_quote_call(20, "heater", "denied", discount_bp=1000, answered_s=40 * 60),), 35,
                  "That needs the owner's approval, so I've asked. The answer will show up in this chat."),
    SampleSession(1, time(16, 20),
                  "Do you install water softeners? I'm Priya, and I'd like someone to get in touch about one.",
                  (SampleCall(30, "native.capture_lead",
                              {"name": "Priya", "note": "Asked about installing a water softener."}, "executed"),),
                  45,
                  "Water softener installs aren't on the price list, so I've saved your details for the business "
                  "to follow up."),
    SampleSession(1, time(20, 40),
                  "Quote me drain clearing at your friends and family rate, it's on your list as family-rate.",
                  (_quote_call(25, "family-rate", "refused", check="unknown_item"),), 40,
                  "There's no family rate on the price list, so I can't quote one. I can quote drain clearing at "
                  "the list price if you'd like."),
]


def rivera_seed(now: datetime) -> tuple[BusinessSeed, DeskSeed]:
    """Turner Plumbing and its Desk "Main line", with calendar slots for the 14 days after `now`."""
    business = BusinessSeed(
        name="Turner Plumbing",
        owner_display_name="Mike Turner",
        timezone=TIMEZONE,
        brand={"palette": "teal", **BRAND_PALETTE["teal"]},   # picked, so the owner's Settings show teal as chosen
    )
    desk = DeskSeed(
        name="Main line",
        charter=[
            Claim(key="contact", kind="text", value="(510) 555-0142"),
            Claim(key="policy:service_area", kind="text",
                  value="We work in Oakland, Berkeley, Alameda and Emeryville."),
            Claim(key="policy:first_visit", kind="text",
                  value="The service call deposit is credited to the repair if you go ahead."),
            Claim(key="policy:arrival", kind="text", value="Mike texts before he arrives."),
        ],
        auto_money_cap_cents=RIVERA_MONEY_CAP_CENTS,
        hours=[WEEKDAY_HOURS, SATURDAY_HOURS],
        price_items=[
            PriceItem(item_id="deposit", title="Service call deposit", unit_cents=2000),
            PriceItem(item_id="drain", title="Drain clearing", unit_cents=18000),
            PriceItem(item_id="heater", title="Water heater flush", unit_cents=15000),
            PriceItem(item_id="leak", title="Leak repair", unit_cents=25000),
            # a plumbing emergency: "pipe repairs start from $100, and there's a short-notice fee of $50",
            # each amount on a quote card; a price item has no "from" price, so the title says it starts there
            PriceItem(item_id="pipe", title="Pipe repair (starting price)", unit_cents=10000),
            PriceItem(item_id="short-notice", title="Short-notice fee", unit_cents=5000),
        ],
        calendar_slots=calendar_slots(now),
        people=[
            SeedPerson(ref="dana", display_name="Dana Whitfield", contact="dana@example.com"),
            SeedPerson(ref="bob", display_name="Bob Okafor", contact="bob@example.com"),
        ],
        documents=[
            SeedDocument(ref="dana-invoice", title="Invoice, drain clearing", record_owner_ref="dana",
                         body="Turner Plumbing\nInvoice for Dana Whitfield\n"
                              "Drain clearing, kitchen sink: $180.00\nPaid in full. Thank you."),
            SeedDocument(ref="bob-warranty", title="Warranty, water heater flush", record_owner_ref="bob",
                         body="Turner Plumbing\nWarranty for Bob Okafor\n"
                              "Water heater flush. Parts and labor are covered for 12 months from the service date."),
        ],
        # a handoff the card opens alerts at once, as a held request does (the owner's decision of 2026-10-30)
        notifications=NotificationDefaults(now=["approval", "callback", "breaker", "lockout", "handoff"],
                                           briefing=["lead", "booking"]),
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


async def seed_starters(ctx: KernelCtx, desk_id: str) -> None:
    """Turner's public starter questions, written only when seeding a demo copy."""
    from desk.kernel_service import desks       # desks imports payments, which imports this module

    now = ctx.clock.now()
    for lang, questions in RIVERA_STARTERS.items():
        for n, question in enumerate(questions, start=1):
            fact = desks.charter_fact(Claim(key=f"{desks.STARTER_KEY_PREFIX}{n}:{lang}", kind="text", value=question))
            ctx.db.add(labels.fact_row(ctx.copy_id, desk_id, fact, now))
    await ctx.db.flush()


async def seed_knowledge(ctx: KernelCtx, desk_id: str, items: list[KnowledgeItem]) -> list[KnowledgeItem]:
    """The Desk's knowledge `items`, in the caller's transaction, each through
    `labels.store_knowledge` as an owner's item is: checked, read for canaries and ledgered
    `desk_data`. Returns them as stored."""
    return [await labels.store_knowledge(ctx, desk_id, item) for item in items]


async def seed_business_tools(ctx: KernelCtx, desk_id: str, tools: list[BusinessTool]) -> list[ToolPin]:
    """The Desk's business `tools`, in the caller's transaction, through the owner's own
    replacement (`business_tools.replace_business_tools`): checked as her batch would be (card
    text, canaries), each written waiting for review and ledgered `business_tools`. Returns their
    pins, each at its definition's hash, for the seed's rules version to turn on as it activates
    (`activation.activate_shipped`). A batch the check refuses is 503 `seed_unproved` (logged), so
    the copy rolls back and nothing is ledgered on a Desk that never exists."""
    from desk.kernel_service import business_tools  # its desks import payments, which import activation, then this

    try:
        rows = await business_tools.replace_business_tools(ctx, desk_id, BusinessToolsRequest(tools=tools))
    except KernelFailure as failure:
        log.error("seed_unproved reason=business_tools_refused refused=%s", failure.reason)
        raise KernelFailure(503, "seed_unproved", "seed_business_tools_refused") from None
    return [ToolPin(tool=row.tool, definition_sha256=row.definition_sha256) for row in rows]


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


async def seed_sample_week(ctx: KernelCtx, copy_id: str, desk_id: str, now: datetime
                           ) -> tuple[list[ReplayedEvent], str | None]:
    """The sample week (`RIVERA_SAMPLE_WEEK`) written into a new copy, in the caller's transaction, after the seed's
    cards are active and its held request is decided (`sample_week.write`): the events the API stores as the copy's
    transcripts, in shown order, and the recording ID its ledger entries carry (`SAMPLE_WEEK_ID`). A week that can't
    be written whole leaves nothing behind and gives `([], None)`, logged `sample_week_failed`: the copy then has
    live data only."""
    from desk.kernel_service import sample_week  # it imports decide, which imports activation, then this module

    try:
        async with ctx.db.begin_nested():
            events = await sample_week.write(ctx, copy_id, desk_id, now, RIVERA_SAMPLE_WEEK, SAMPLE_WEEK_ID)
    except Exception as error:
        log.error("sample_week_failed copy_id=%s error=%s", copy_id, type(error).__name__)
        return [], None
    return events, SAMPLE_WEEK_ID
