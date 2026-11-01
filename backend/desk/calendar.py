"""A Desk's bookable slots, built from its opening hours.

Setup gives a new Desk these slots for the 14 days after the day it finishes (`desk.api.setup`), and
the kernel adds each later day's as the days go by (`desk.kernel_service.desks.extend_calendar`), so
both build them here: the API process and the kernel may each import this module, and it imports
neither of them.
"""

from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from desk.contracts import CalendarSlot, HoursWindow

CALENDAR_DAYS = 14
SLOT_MINUTES = 60
WEEK = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")


def minute_of_day(moment: time) -> int:
    return moment.hour * 60 + moment.minute


def calendar_slots(hours: list[HoursWindow], timezone: str, today: date) -> list[CalendarSlot]:
    """60-minute slots inside the opening hours on the 14 days after `today`, each named `S-<yyyymmdd>-<hhmm>` by its
    start in the business's time zone (a window's end is exclusive; 00:00 is midnight)."""
    zone = ZoneInfo(timezone)
    slots: dict[str, CalendarSlot] = {}
    for offset in range(1, CALENDAR_DAYS + 1):
        day = today + timedelta(days=offset)
        for window in hours:
            if WEEK[day.weekday()] not in window.days:
                continue
            end = minute_of_day(window.end) or 24 * 60
            for start in range(minute_of_day(window.start), end - SLOT_MINUTES + 1, SLOT_MINUTES):
                local = time(start // 60, start % 60)
                slot_id = f"S-{day:%Y%m%d}-{local:%H%M}"
                slots.setdefault(slot_id, CalendarSlot(slot_id=slot_id, starts_at=datetime.combine(day, local, zone),
                                                       minutes=SLOT_MINUTES))
    return sorted(slots.values(), key=lambda slot: slot.slot_id)
