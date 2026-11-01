"""The starter presets: the rule cards behind the owner's autonomy modes, and how a Desk's hours shape them.

Both processes import this module (the API drafts a preset for the Rules page; the kernel activates
one on a new Desk) and CI proves the shipped cards, so it imports nothing but `desk.contracts`. Card
IDs are fixed and start with `preset-`, so the shipped cards compile to the same Cedar, and hit the
same shipped proof, in every copy. Treat the lists as read-only: copy a card before changing it.

- `ask_first` (Ask me first, the starter preset): Claude may show open times, take a lead, ask
  for a callback, start a verification and read the owner's setup material on its own; every
  other tool falls to the compiler's default ask.
- `auto` (Recommended rules): the same, plus quotes at list price, weekday bookings in the Desk's
  own weekday hours with the reviewer's check, customers' own documents once verified, and an ask
  before any money moves. A draft of it for a Desk is `preset_cards`: the shipped booking card, Monday
  to Friday 09:00 to 17:00, is the fallback for a Desk with no hours.
"""

from datetime import time
from typing import Literal

from desk.contracts import HoursWindow, RuleCard

PresetName = Literal["ask_first", "auto"]

_UTILITY_CARDS: list[RuleCard] = [
    RuleCard(card_id="preset-web-search", applies_to="native.web_search", mode="auto", who="anyone",
             reason="Claude can search the web to learn how businesses like yours work."),
    RuleCard(card_id="preset-find-slots", applies_to="native.find_slots", mode="auto", who="anyone",
             reason="Anyone can see the times you have open."),
    RuleCard(card_id="preset-capture-lead", applies_to="native.capture_lead", mode="auto", who="anyone",
             reason="Anyone can leave their name and how to reach them."),
    RuleCard(card_id="preset-request-callback", applies_to="native.request_callback", mode="auto", who="anyone",
             reason="Anyone can ask you to call them back."),
    RuleCard(card_id="preset-start-verification", applies_to="native.start_verification", mode="auto", who="anyone",
             reason="Anyone can ask for a code, which goes only to the contact you have on record."),
    RuleCard(card_id="preset-fetch-website", applies_to="native.fetch_website", mode="auto", who="anyone",
             reason="Claude can read your website to learn about your business."),
    RuleCard(card_id="preset-read-memory", applies_to="native.read_memory", mode="auto", who="anyone",
             reason="Claude can read the notes you brought in to learn about your business."),
]

_AUTO_CARDS: list[RuleCard] = [
    RuleCard(card_id="preset-quote", applies_to="native.quote", mode="auto", who="anyone", max_discount_bp=0,
             reason="Quotes from your price list, at list price."),
    RuleCard(card_id="preset-book-weekday", applies_to="native.book", mode="auto", who="anyone",
             hours=HoursWindow(days=["mon", "tue", "wed", "thu", "fri"], start=time(9), end=time(17)), review=True,
             reason="Weekday bookings in working hours, checked by the reviewer."),
    RuleCard(card_id="preset-documents", applies_to="native.release_document", mode="auto", who="record_owner",
             reason="Customers get their own documents after confirming it's them."),
    RuleCard(card_id="preset-charge-ask", applies_to="effect:charge", mode="ask", who="anyone",
             reason="Taking a payment asks you first."),
    RuleCard(card_id="preset-pay-out-ask", applies_to="effect:pay_out", mode="ask", who="anyone",
             reason="Sending money out asks you first."),
]

PRESETS: dict[PresetName, list[RuleCard]] = {
    "ask_first": list(_UTILITY_CARDS),
    "auto": [*_UTILITY_CARDS, *_AUTO_CARDS],
}

# "Recommended rules" books weekdays in the Desk's own hours (`preset_cards`): its booking card, the reason a card in
# the Desk's own hours takes (the example Desk's own weekday rule's words; it names no hours), and the days it keeps.
PRESET_BOOKING_CARD = "preset-book-weekday"
OPENING_HOURS_REASON = "Weekday bookings in opening hours, checked by the reviewer."
WEEKDAYS = ("mon", "tue", "wed", "thu", "fri")


def weekday_windows(hours: list[HoursWindow]) -> list[HoursWindow]:
    """The weekday part of a Desk's opening hours: each window's days cut to Monday to Friday, a window left with none
    dropped (a Saturday's, say), and windows with the same start and end merged, their days in week order; an end of
    00:00 stays midnight. They come by their first day, then their start, then their end (midnight last), however the
    Desk keeps its windows, so the same hours always give the same list."""
    merged_days: dict[tuple[time, time], set[str]] = {}
    for window in hours:
        weekdays = set(window.days) & set(WEEKDAYS)
        if weekdays:
            merged_days.setdefault((window.start, window.end), set()).update(weekdays)
    windows = [HoursWindow(days=[day for day in WEEKDAYS if day in days], start=start, end=end)
               for (start, end), days in merged_days.items()]
    return sorted(windows, key=lambda window: (WEEKDAYS.index(window.days[0]), window.start, window.end == time(0),
                                               window.end))


def preset_cards(name: PresetName, hours: list[HoursWindow]) -> list[RuleCard]:
    """The preset's cards for a Desk with these opening hours. "Recommended rules" books weekdays in the Desk's own
    hours: its weekday booking card gives way to one card per weekday window (`weekday_windows`), in that order and in
    its place, each the preset's card in all but its hours, its reason (`OPENING_HOURS_REASON`) and, for several
    windows, its ID, numbered `-1`, `-2` and on. A Desk with hours but none on a weekday gets no booking card, so a
    weekday booking falls to the compiler's default ask. A Desk with no hours at all, or with exactly the card's own
    (Monday to Friday, 09:00 to 17:00), gets the preset's cards as they are, as does "Ask me first", which books
    nothing: a draft of them hits the proofs shipped for them, and other cards are proved like any owner draft. The
    preset is read when this runs, never copied."""
    cards = list(PRESETS[name])
    booking = next((card for card in cards if card.card_id == PRESET_BOOKING_CARD), None)
    if booking is None or not hours:
        return cards
    windows = weekday_windows(hours)
    if windows == [booking.hours]:
        return cards
    card_ids = ([booking.card_id] if len(windows) == 1
                else [f"{booking.card_id}-{number}" for number in range(1, len(windows) + 1)])
    at = cards.index(booking)
    bookings = [booking.model_copy(update={"card_id": card_id, "hours": window, "reason": OPENING_HOURS_REASON})
                for card_id, window in zip(card_ids, windows, strict=True)]
    return [*cards[:at], *bookings, *cards[at + 1:]]
