"""What each booking was booked for (`owner_reads.booked_amounts`) at its edges, and the week's total that reads it.

`test_owner_reads.py` covers the common cases through the app on FakeKernel; these call the functions directly with
rows shaped like `kernel_ro.quotes` and ledger-timed bookings.
"""

from datetime import UTC, datetime, timedelta

from desk.api.owner_reads import Activity, People, Timed, booked_amounts, this_week, windows

AT = datetime(2026, 10, 29, 17, tzinfo=UTC)


def quote(quote_id: str, at: datetime, amount_cents: int, session_id: str = "sess-a", item_id: str = "drain") -> dict:
    """A quote from the price list (`native.quote`): its line names a price list item."""
    return {"quote_id": quote_id, "session_id": session_id, "created_at": at, "amount_cents": amount_cents,
            "items": [{"item_id": item_id, "title": "Drain clearing", "qty": 1, "unit_cents": amount_cents}]}


def deposit(quote_id: str, at: datetime, amount_cents: int, session_id: str = "sess-a") -> dict:
    """A purpose payment's quote record, as the kernel writes one: its one line names the business tool."""
    return quote(quote_id, at, amount_cents, session_id, item_id="desk.deposit")


def booking(ref_id: str, at: datetime, session_id: str = "sess-a") -> Timed:
    return Timed(at=at, session_id=session_id, ref_id=ref_id)


def test_a_deposit_taken_before_a_booking_leaves_its_amount_unset():
    assert booked_amounts([booking("dec-1", AT + timedelta(minutes=5))], [deposit("quote-d", AT, 5_000)]) == {
        "dec-1": 0}


def test_a_booking_takes_the_real_quote_made_before_a_deposit():
    quotes = [quote("quote-a", AT, 18_000), deposit("quote-d", AT + timedelta(minutes=1), 5_000)]
    assert booked_amounts([booking("dec-1", AT + timedelta(minutes=5))], quotes) == {"dec-1": 18_000}


def test_a_plain_quote_then_a_booking_is_booked_for_the_quote():
    assert booked_amounts([booking("dec-1", AT + timedelta(minutes=5))], [quote("quote-a", AT, 18_000)]) == {
        "dec-1": 18_000}


def test_a_created_at_tie_goes_to_the_greatest_quote_id():
    quotes = [quote("quote-b", AT, 25_000), quote("quote-c", AT, 36_000), quote("quote-a", AT, 15_000)]
    assert booked_amounts([booking("dec-1", AT + timedelta(minutes=5))], quotes) == {"dec-1": 36_000}
    # the next booking takes the greatest quote_id left
    assert booked_amounts([booking("dec-1", AT + timedelta(minutes=5)), booking("dec-2", AT + timedelta(minutes=6))],
                          quotes) == {"dec-1": 36_000, "dec-2": 25_000}


def test_a_quote_made_at_the_bookings_exact_instant_backs_it():
    assert booked_amounts([booking("dec-1", AT)], [quote("quote-a", AT, 15_000)]) == {"dec-1": 15_000}
    # a microsecond later it was made after the booking, and backs none
    later = quote("quote-a", AT + timedelta(microseconds=1), 15_000)
    assert booked_amounts([booking("dec-1", AT)], [later]) == {"dec-1": 0}


def test_a_quote_taken_before_the_window_backs_no_booking_inside_it():
    now = datetime(2026, 10, 30, 13, tzinfo=UTC)
    frame = windows(now, "America/Los_Angeles")
    before = booking("dec-before", frame.start - timedelta(hours=1))
    inside = booking("dec-inside", frame.start + timedelta(hours=1))
    quotes = [quote("quote-a", frame.start - timedelta(hours=2), 15_000)]
    booked = booked_amounts([inside, before], quotes)               # in any order: they are taken in time order
    assert booked == {"dec-before": 15_000, "dec-inside": 0}
    done = Activity(people=People([], [], []), bookings=[before, inside], booked=booked, leads=[], stopped=[],
                    holds=[], callbacks=[], stepped=[], texts=[], replies=[], handoffs=[])
    week = this_week(done, frame)
    assert (week.bookings, week.booked_cents) == (1, 0)
