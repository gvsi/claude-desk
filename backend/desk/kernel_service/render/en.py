"""English: the visitor's status lines, the owner's alert previews and the clause cards.

`{owner}` is the business's `owner_display_name`. Status lines carry no digits, currency or
percentages: only clause cards rendered from facts do. Cards read datetimes in the business's
time zone ("Tuesday, November 3, 2:00 pm"), money as `$1,234.56` and percentages as "10%".
"""

from datetime import datetime, time

from desk.contracts import Fact, HoursWindow
from desk.kernel_service.render.cards import (Card, DeskInfo, booking_window, claims, day_groups, hours_windows, local,
                                              money, percent_text, slot_claims, text_claim)

STATUS: dict[str, str] = {
    "allowed": "Checked against {owner}'s rules",
    "held": "Waiting for {owner} to approve",
    "refused": "Not something I can do here",
    "approved": "{owner} approved this",
    "denied": "{owner} decided not to go ahead",
    "expired": "This request timed out",
    "cancelled": "Cancelled",
    "executed": "Done",
    "failed": "That didn't go through",
    "unknown": "Still confirming this",
    "refused_at_execution": "The rules changed, so this didn't go ahead",
    "reply_checked": "Reply checked against {owner}'s rules",
    "reply_handed_off": "Passed to {owner} to answer",
}

# Owner-only, in English: the preview line of a Demo inbox alert.
OWNER_PREVIEWS: dict[str, str] = {
    "approval": "A request needs your answer",
    "breaker": "A conversation was paused",
    "booking": "New booking",
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
    """`{date}` / `Arriving {start} to {end}` / `With {owner}`; no booking ID."""
    start, end = booking_window(fact, desk)
    return Card(title=date(start), lines=(f"Arriving {clock(start)} to {clock(end)}",
                                          f"With {desk.owner_display_name}"))


def charter_text(fact: Fact | None, desk: DeskInfo) -> Card:
    """A policy or the contact, verbatim."""
    return Card(title=text_claim(fact))


def verify_prompt(fact: Fact | None, desk: DeskInfo) -> Card:
    return Card(title="I'll send a code to the contact on record.")
