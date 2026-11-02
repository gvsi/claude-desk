"""What the English and Spanish clause renderers share: the card they return, the Desk facts they
may name, and reading a fact's claims. Money reads `$1,234.56` in both languages.

Renderers read only claims kernel adapters or authenticated owner input wrote ("Clauses"). A fact
with nothing to render raises `NothingToShow`; one missing a claim its template needs raises any
other error, which the caller answers as an internal error.
"""

import json
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from desk.contracts import Fact, HoursWindow, shown_owner

WEEK = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")


class NothingToShow(ValueError):
    """A fact its template has nothing to render from, such as hours with no windows: the card is
    left out, never shown empty."""


@dataclass(frozen=True)
class DeskInfo:
    """What a card may say about the Desk: the owner's name, the business's name and time zone."""

    owner_display_name: str
    business_name: str
    timezone: str

    @property
    def owner(self) -> str:
        """The name a card gives the owner (`shown_owner`)."""
        return shown_owner(self.owner_display_name, self.business_name)

    @property
    def tz(self) -> ZoneInfo:
        return ZoneInfo(self.timezone)


@dataclass(frozen=True)
class Card:
    """A card's data: the headline, the details and, on a booking options card, one choice per
    open time as `(slot_id, label)`."""

    title: str
    lines: tuple[str, ...] = ()
    options: tuple[tuple[str, str], ...] = ()


def claims(fact: Fact | None) -> dict[str, int | str]:
    """The fact's claims by key (the last one of a repeated key). A missing fact has none."""
    return {} if fact is None else {claim.key: claim.value for claim in fact.claims}


def money(cents: int) -> str:
    """`$1,234.56`, in both languages."""
    if not isinstance(cents, int):
        raise TypeError("money is integer cents")
    dollars, rest = divmod(cents, 100)
    return f"${dollars:,}.{rest:02d}"


def local(value: int | str, desk: DeskInfo) -> datetime:
    """A datetime claim in the business's time zone."""
    if not isinstance(value, str):
        raise TypeError("a datetime claim is a string")
    moment = datetime.fromisoformat(value)
    if moment.tzinfo is None:
        raise ValueError("a datetime claim carries its offset")
    return moment.astimezone(desk.tz)


def percent_text(bp: int, decimal_mark: str) -> str:
    """Basis points as a percentage number without trailing zeros: 1500 → "15", 1250 → "12.5"."""
    if not isinstance(bp, int):
        raise TypeError("a percentage is integer basis points")
    whole, rest = divmod(bp, 100)
    return str(whole) if not rest else f"{whole}{decimal_mark}{rest:02d}".rstrip("0")


def text_claim(fact: Fact) -> str:
    """The one text claim of a charter fact (a policy, the contact) or of an owner's statement, as
    the owner wrote it."""
    [claim] = fact.claims
    if claim.kind != "text" or not isinstance(claim.value, str):
        raise TypeError("a charter fact or an owner's statement holds one text claim")
    return claim.value


def title_claim(fact: Fact | None) -> str:
    """A link's `title` claim: a document's title, as the owner wrote it, or what a payment link is
    for, from the quote's items."""
    title = claims(fact)["title"]
    if not isinstance(title, str):
        raise TypeError("a document's title is text")
    return title


def booking_window(fact: Fact, desk: DeskInfo) -> tuple[datetime, datetime]:
    """A booking's start and end in the business's time zone, from its `starts_at` and `minutes`
    claims; the end is counted in elapsed time, so a window across a clock change ends on time."""
    found = claims(fact)
    start = local(found["starts_at"], desk)
    minutes = int(str(found["minutes"]))
    return start, (start.astimezone(UTC) + timedelta(minutes=minutes)).astimezone(desk.tz)


def callback_window(fact: Fact | None, desk: DeskInfo) -> tuple[datetime, datetime] | None:
    """A handoff's window in the business's time zone, from its `window_start` and `window_end`
    claims; None when it has neither (no hour was open). One without the other is an error."""
    found = claims(fact)
    if "window_start" not in found and "window_end" not in found:
        return None
    return local(found["window_start"], desk), local(found["window_end"], desk)


def slot_claims(fact: Fact) -> list[tuple[str, str]]:
    """A slots fact's `(slot_id, starts_at)` pairs, in order: one `slot` claim, then its `starts_at`."""
    pairs = []
    for slot, starts_at in zip(fact.claims[0::2], fact.claims[1::2], strict=True):
        if (slot.key, starts_at.key) != ("slot", "starts_at"):
            raise ValueError("a slots fact lists each slot and then its start")
        pairs.append((str(slot.value), str(starts_at.value)))
    return pairs


def hours_windows(fact: Fact) -> list[HoursWindow]:
    """Fact `charter:hours`'s windows, from its one `windows` claim (canonical JSON); none is
    `NothingToShow`."""
    value = claims(fact)["windows"]
    if not isinstance(value, str):
        raise TypeError("the hours windows are a JSON string")
    windows = [HoursWindow.model_validate(window) for window in json.loads(value)]
    if not windows:
        raise NothingToShow("no hours")
    return windows


def day_groups(days: list[str]) -> list[list[str]]:
    """A window's days in week order, as runs of consecutive days."""
    ordered = sorted(set(days), key=WEEK.index)
    runs: list[list[str]] = []
    for day in ordered:
        if runs and WEEK.index(day) == WEEK.index(runs[-1][-1]) + 1:
            runs[-1].append(day)
        else:
            runs.append([day])
    return runs
