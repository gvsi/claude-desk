"""The kernel's only source of time.

Every timestamp and expiry the kernel writes or checks comes from the injected `Clock`, never
from Postgres `now()`, so tests freeze time and a deploy's two overlapping tasks agree on what
"expired" means. `signed_time` is the exact text that signatures and the ledger cover.
"""

from datetime import UTC, datetime, tzinfo
from typing import Protocol


class Clock(Protocol):
    def now(self) -> datetime:
        """The current time, aware and in UTC."""
        ...


class SystemClock:
    def now(self) -> datetime:
        return datetime.now(UTC)


def signed_time(dt: datetime) -> str:
    """RFC 3339 in UTC with microseconds and "Z" (`SignedTime`): "2026-10-30T17:04:05.123456Z"."""
    if dt.tzinfo is None:
        raise ValueError("signed_time needs an aware datetime")
    return dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def local_dow_minute(instant: datetime, tz: tzinfo) -> tuple[int, int]:
    """The business's local day of the week (0 = Monday) and minute of the day (0-1439) at
    `instant`, in its time zone `tz`: what Cedar's hours checks read (`local_dow`, `local_minute`),
    and what the public page's open-now line reads, so the two always agree."""
    if instant.tzinfo is None:
        raise ValueError("local_dow_minute needs an aware datetime")
    local = instant.astimezone(tz)
    return local.weekday(), local.hour * 60 + local.minute
