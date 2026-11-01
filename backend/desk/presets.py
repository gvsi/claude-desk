"""The starter presets: the rule cards behind the owner's autonomy modes, as plain data.

Both processes import this module (the API's Rules page shows these cards; the kernel activates
them on a new Desk) and CI proves them, so it imports nothing but `desk.contracts`. Card IDs are
fixed and start with `preset-`, so a preset compiles to the same Cedar, and hits the same shipped
proof, in every copy. Treat the lists as read-only: copy a card before changing it.

- `ask_first` (Ask me first, the starter preset): Claude may show open times, take a lead, ask
  for a callback, start a verification and read the owner's setup material on its own; every
  other tool falls to the compiler's default ask.
- `auto` (Auto): the same, plus quotes at list price, weekday bookings from 09:00 to 17:00 with the
  reviewer's check, customers' own documents once verified, and an ask before any money moves.
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
