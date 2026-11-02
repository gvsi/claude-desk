"""English: the visitor's status lines, the owner's alert previews and owner-only lines, and the
clause cards.

`{owner}` is the business's `owner_display_name`. Status lines carry no digits, currency or
percentages: only clause cards rendered from facts do. Cards read datetimes in the business's
time zone ("Tuesday, November 3, 2:00 pm"), money as `$1,234.56` and percentages as "10%".
"""

from datetime import datetime, time, timedelta

from desk.contracts import Fact, HoursWindow
from desk.kernel_service.render.cards import (Card, DeskInfo, booking_window, callback_window, claims, day_groups,
                                              hours_windows, local, money, percent_text, slot_claims, text_claim,
                                              title_claim)

STATUS: dict[str, str] = {
    "allowed": "Checked against {owner}'s rules",
    "held": "Waiting for {owner} to approve",
    "refused": "Not something I can do here",
    # refused's line when the baseline's mandate rule alone refused an agent's charge above what its mandate has left
    "refused_over_mandate": "Refused: over the signed limit for this agent",
    "approved": "{owner} approved this",
    "denied": "{owner} decided not to go ahead",
    "expired": "This request timed out",
    "cancelled": "Cancelled",
    "executed": "Done",
    "failed": "That didn't go through",
    "unknown": "Still confirming this",
    "refused_at_execution": "The rules changed, so this didn't go ahead",
    # refused_at_execution's line when a connected tool's server can't be reached
    "tool_unavailable": "This isn't available right now, so it didn't go ahead",
    "reply_checked": "Reply checked against {owner}'s rules",
    "reply_handed_off": "Passed to {owner} to answer",
    "owner_said": "Written by {owner}",
    "owner_say_blocked": "Not sent: it included text from a private document",   # shown to the owner alone
}

# Owner-only, key for key with `es.OWNER_STATUS`: a decision's `owner_plain`. Why an approved or
# allowed action was refused at execution: an approved release of private data whose session no
# longer stood for its person says why the session ended; otherwise the Desk was deleted, the rules
# changed (a failed re-check), or, for anything else, a line that names no cause. And a held
# request the visitor's own booking closed (`cancelled_by_booking`), which a visitor's own cancel
# never takes. A decision's status line reaches the visitor, who mustn't read why their session
# ended, so these are kept out of `STATUS` and no status line can render one.
OWNER_STATUS: dict[str, str] = {
    "refused_contact_changed": "Not shared: their session ended when their contact changed",
    "refused_person_removed": "Not shared: they were removed from your records",
    "refused_session_closed": "Not shared: their session ended before your answer",
    "refused_rules_changed": "Your rules changed before this ran, so it wasn't done.",
    "refused_desk_deleted": "This Desk was deleted before this ran, so it wasn't done.",
    "refused_fallback": "This couldn't run, so it wasn't done.",
    "cancelled_by_booking": "The visitor booked before you answered, so this request closed.",
}

# What an executed action did, one line per tool, key for key with `es.EXECUTED`: the receipt a
# visitor or another agent sees instead of the generic "executed" line. Like the status lines they
# name the owner and nothing else, so they never carry an amount, a time or a date.
EXECUTED: dict[str, str] = {
    "purpose_payment": "{title}: payment link made",
    "urgent": "{title}: urgent request sent to {owner}",
    "intake": "{title}: details saved for {owner}",
    "typed_booking": "{title}: booked on {owner}'s calendar",
    "native.quote": "Quoted from {owner}'s price list",
    "native.find_slots": "Times read from {owner}'s calendar",
    "native.book": "Booked on {owner}'s calendar",
    "native.capture_lead": "Details saved for {owner}",
    "native.request_callback": "Callback request saved for {owner}",
    "native.start_verification": "Verification started",
    "native.release_document": "Document shared from {owner}'s records",
    "native.payment_link": "Payment link made for this quote",
    "payments.list_charges": "Charges read from {owner}'s payments",
    "payments.create_refund": "Refunded to the original payment",
    "native.charge_mandate": "Charged within the limit of your mandate",
}

# The kernel's other visitor texts, key for key with `es.MESSAGES`: the verify card's messages,
# the same whether or not a contact is on record, the Demo inbox's code entry, whose body is the
# only kernel text that carries a code, and the call-back offer a reply blocked only for its prose
# shows when it has no card to keep (`reply_check.blocked_blocks`), the API's signed
# `STATUS_LINES["offer_callback"]` word for word, and the line it shows instead while a held request
# awaits the owner, the API's signed `STATUS_LINES["check_status"]` word for word.
MESSAGES: dict[str, str] = {
    "verify_started": "If that contact is on record, a code is on its way. Enter it below to confirm it's you.",
    "verify_already": "You're already confirmed in this chat.",
    "inbox_code_preview": "New verification code",
    "inbox_code_body": ("Your {business} code is {code}. It expires in ten minutes. "
                        "If you didn't ask for it, ignore this message."),
    "offer_callback": "Would you like me to arrange a callback?",
    "check_status": "Please check the request status in this chat.",
}

# Owner-only, in English: the preview line of a Demo inbox alert.
OWNER_PREVIEWS: dict[str, str] = {
    "approval": "A request needs your answer",
    "breaker": "A conversation was paused",
    "booking": "New booking",
    "lockout": "Verification paused for a contact",
    "lead": "New lead",
    "callback": "Callback requested",
    "urgent": "Urgent callback requested",
    "handoff": "A conversation was handed to you",
    "rules": "Your rules need checking",
    "public_page": "Hidden from your public page",
    "drift": "A connected tool changed",
}


WEEKDAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")
DAY_NAMES = dict(zip(("mon", "tue", "wed", "thu", "fri", "sat", "sun"), WEEKDAYS, strict=True))
MONTHS = ("January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
          "November", "December")


def clock(moment: datetime | time) -> str:
    """"2:00 pm"."""
    return f"{moment.hour % 12 or 12}:{moment.minute:02d} {'am' if moment.hour < 12 else 'pm'}"


def date(moment: datetime) -> str:
    """"Tuesday, November 3"."""
    return f"{WEEKDAYS[moment.weekday()]}, {MONTHS[moment.month - 1]} {moment.day}"


def when(moment: datetime) -> str:
    """"Tuesday, November 3, 2:00 pm"."""
    return f"{date(moment)}, {clock(moment)}"


def listing(parts: list[str]) -> str:
    """"Monday", "Monday and Wednesday", "Monday, Wednesday and Friday"."""
    return parts[0] if len(parts) == 1 else f"{', '.join(parts[:-1])} and {parts[-1]}"


def days_text(days: list[str]) -> str:
    """"Monday to Friday", "Saturday", "Monday, Wednesday and Friday": three days or more in a row
    read as a range."""
    parts: list[str] = []
    for run in day_groups(days):
        if len(run) >= 3:
            parts.append(f"{DAY_NAMES[run[0]]} to {DAY_NAMES[run[-1]]}")
        else:
            parts += [DAY_NAMES[day] for day in run]
    return listing(parts)


def window(hours_window: HoursWindow) -> str:
    """"Monday to Friday, 8:00 am to 6:00 pm"."""
    return f"{days_text(hours_window.days)}, {clock(hours_window.start)} to {clock(hours_window.end)}"


def quote(fact: Fact | None, desk: DeskInfo) -> Card:
    """`{total}` / `{items}` / `Includes {pct} off {list}` (only with a discount) / `Good until {expires}`."""
    found = claims(fact)
    lines = [str(found["items"])]
    if found["discount"]:
        lines.append(f"Includes {percent_text(found['discount'], '.')}% off {money(found['list'])}")
    lines.append(f"Good until {when(local(found['expires'], desk))}")
    return Card(title=money(found["total"]), lines=tuple(lines))


def handoff(fact: Fact | None, desk: DeskInfo) -> Card:
    """`Let me check with {owner}.` / `{owner} will reply here.`"""
    owner = desk.owner_display_name
    return Card(title=f"Let me check with {owner}.", lines=(f"{owner} will reply here.",))


def booking_options(fact: Fact | None, desk: DeskInfo) -> Card:
    """`Times that are open` / one line and one option per slot still free."""
    options = tuple((slot_id, when(local(starts_at, desk))) for slot_id, starts_at in slot_claims(fact))
    return Card(title="Times that are open", lines=tuple(label for _, label in options), options=options)


def hours(fact: Fact | None, desk: DeskInfo) -> Card:
    """One line per window: `Monday to Friday, 8:00 am to 6:00 pm`."""
    first, *rest = [window(each) for each in hours_windows(fact)]
    return Card(title=first, lines=tuple(rest))


def booking_confirmed(fact: Fact | None, desk: DeskInfo) -> Card:
    """`{date}` / `{start} to {end}` / `With {owner}`; no booking ID."""
    start, end = booking_window(fact, desk)
    found = claims(fact)
    if "appointment_type" in found:
        from desk.kernel_service.adapters.base import quoted
        return Card(title=date(start), lines=(f"{quoted(found['appointment_type'])} at {clock(start)}",
                                              f"About {found['appointment_minutes']} minutes",
                                              f"With {desk.owner_display_name}"))
    return Card(title=date(start), lines=(f"{clock(start)} to {clock(end)}",
                                          f"With {desk.owner_display_name}"))


def charter_text(fact: Fact | None, desk: DeskInfo) -> Card:
    """A policy or the contact, verbatim."""
    return Card(title=text_claim(fact))


def verify_prompt(fact: Fact | None, desk: DeskInfo) -> Card:
    return Card(title="I'll send a code to the contact on record.")


def callback_confirmed(fact: Fact | None, desk: DeskInfo) -> Card:
    """`{owner} will call you back on {day}, between {start} and {end}`; without a window
    `{owner} will call you back`. The fact holds only the window, never the visitor's text."""
    owner = desk.owner_display_name
    window = callback_window(fact, desk)
    if window is None:
        return Card(title=f"{owner} will call you back")
    start, end = window
    return Card(title=f"{owner} will call you back on {date(start)}, between {clock(start)} and {clock(end)}")


def owner_said(fact: Fact | None, desk: DeskInfo) -> Card:
    """The owner's words, as the owner wrote them."""
    return Card(title=text_claim(fact))


def document_link(fact: Fact | None, desk: DeskInfo) -> Card:
    """The document's title; the link itself is the card's `href`, which the reply check fills."""
    return Card(title=title_claim(fact))


def payment_link(fact: Fact | None, desk: DeskInfo) -> Card:
    """`{title}, {total}`; the link itself is the card's `href`, which the reply check fills."""
    return Card(title=f"{title_claim(fact)}, {money(claims(fact)['total'])}")


def charges(fact: Fact | None, desk: DeskInfo) -> Card:
    """`{total}` / `{title}`, or `Payment` when the kernel holds none / `{date and time}` when the
    fact has one: one past payment of the verified customer's."""
    found = claims(fact)
    lines = [title_claim(fact) if "title" in found else "Payment"]
    if "starts_at" in found:
        lines.append(when(local(found["starts_at"], desk)))
    return Card(title=money(found["total"]), lines=tuple(lines))


def refund_issued(fact: Fact | None, desk: DeskInfo) -> Card:
    """`{total} refunded`: what the refund paid back to the original payment."""
    return Card(title=f"{money(claims(fact)['total'])} refunded")


def charge_confirmed(fact: Fact | None, desk: DeskInfo) -> Card:
    """`{title}, {total}`, or `Payment, {total}` when the kernel holds no title: a charge that went
    through, from its `charge` fact (a visiting agent's mandate charge, or a paid link Claude cites
    once it is reconciled)."""
    found = claims(fact)
    return Card(title=f"{title_claim(fact) if 'title' in found else 'Payment'}, {money(found['total'])}")


def payment_confirmed(fact: Fact | None, desk: DeskInfo) -> Card:
    """`{title}, {total}`: what the test checkout paid, from the link's `charge` fact."""
    return Card(title=f"{title_claim(fact)}, {money(claims(fact)['total'])}")


def link_cancelled(fact: Fact | None, desk: DeskInfo) -> Card:
    """`{total}` / `{title}` / `This payment link was cancelled because {owner}'s rules changed. Ask
    again if you still want to pay.`: the kernel's card for a payment link a rule change cancelled,
    from that link's own `payment_link` fact."""
    return Card(title=money(claims(fact)["total"]), lines=(
        title_claim(fact),
        f"This payment link was cancelled because {desk.owner_display_name}'s rules changed. "
        "Ask again if you still want to pay."))


# ---- The public header's open-now line ("Open status") ----------------------------------------------

def _day(moment: datetime, as_of: datetime) -> str:
    """`moment`'s date as `as_of` reads it: "today", "tomorrow", "next Monday" for today's weekday a
    week ahead, else the weekday. Both are in the business's time zone; a date more than a week
    ahead, or already past, has no word and raises ValueError."""
    ahead = (moment.date() - as_of.date()).days
    if ahead == 0:
        return "today"
    if ahead == 1:
        return "tomorrow"
    if 2 <= ahead <= 7:
        return f"next {WEEKDAYS[moment.weekday()]}" if ahead == 7 else WEEKDAYS[moment.weekday()]
    raise ValueError("an open-now day is within the week ahead")


def _until(moment: datetime, as_of: datetime) -> str:
    """When an open business closes: "6:00 pm", "2:00 am tomorrow", "Saturday at 2:00 am". A close
    at 00:00 is midnight at the end of the day before, which takes the day word: "midnight",
    "tomorrow at midnight", "Friday at midnight"."""
    if (moment.hour, moment.minute) == (0, 0):
        day = _day(moment - timedelta(days=1), as_of)
        return "midnight" if day == "today" else f"{day} at midnight"
    day = _day(moment, as_of)
    if day == "today":
        return clock(moment)
    return f"{clock(moment)} tomorrow" if day == "tomorrow" else f"{day} at {clock(moment)}"


def open_status(is_open: bool, boundary: datetime | None, as_of: datetime) -> str:
    """"Open now, until 6:00 pm", "Open now" (open through the week ahead), "Closed now. Opens
    Monday at 8:00 am": `boundary` is when it closes or opens, and it and `as_of` are in the
    business's time zone. An opening at 00:00 is on its own date ("Opens Monday at 12:00 am")."""
    if is_open:
        return "Open now" if boundary is None else f"Open now, until {_until(boundary, as_of)}"
    if boundary is None:
        raise ValueError("a closed business names when it opens")
    return f"Closed now. Opens {_day(boundary, as_of)} at {clock(boundary)}"


# The Agent Card on the public page (`render.agent_card`): plain prose the kernel writes, with no
# amount, key, mandate or private field. A tool reads by what an agent can ask for, never by name.
AGENT_TOOLS: dict[str, str] = {
    "native.quote": "get a quote from the price list",
    "native.find_slots": "find open times",
    "native.book": "book a visit",
    "native.payment_link": "get a payment link for a quote",
    "native.charge_mandate": "pay for a quote within the limit of a signed mandate",
    "native.capture_lead": "leave contact details",
    "native.request_callback": "ask for a callback",
    "native.start_verification": "verify a customer with a code sent to their contact on record",
    "native.release_document": "receive a verified customer's own documents",
    "payments.list_charges": "list a verified customer's own charges",
}

AGENT_CARD: tuple[str, ...] = (
    "Visiting agents can talk to {business} here too. Answers come from Claude, an AI, working within "
    "{owner}'s rules, unless a message is marked as {owner}'s own.",
    "What an agent can do here: {tools}.",
    "Send each request to POST /api/a2a/{slug} on this site; {slug} is this Desk's slug.",
    "Sign every request with Ed25519 and send the headers X-Agent-Key-Id, X-Agent-Ts, X-Agent-Nonce and "
    "X-Agent-Sig. The signature covers the RFC 8785 canonical JSON of desk_slug, ts, nonce and body_sha256, the "
    "lowercase hex SHA-256 of the raw request body.",
    "A signature counts for 5 minutes either side of its timestamp, and each nonce covers one turn of the "
    "conversation.",
    "Agent keys only say which agent is asking. They are not business credentials: they can't change {owner}'s "
    "rules or show anyone's private data, and money moves only as those rules and a signed mandate allow.",
)
AGENT_CARD_NO_TOOLS = "nothing for now"
# What the card says for a business or owner name the public page withholds (`public.header_of`)
AGENT_CARD_BUSINESS = "this business"
AGENT_CARD_OWNER = "the owner"
