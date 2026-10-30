"""The API's in-memory rate limits: sliding windows, one ledger entry per window's first refusal, a write bounded to
once a window, open streams."""

import asyncio
from collections.abc import Awaitable, Callable
from datetime import datetime

import pytest

from desk.api.kernel_client import KernelUnavailable
from desk.api.ratelimit import (
    CONVERSATION_IDLE_S,
    LIMITS,
    Limit,
    RateLimited,
    RateLimiter,
    RateLimitLedger,
    StreamSlots,
)


def test_sliding_window(clock):
    limiter = RateLimiter(clock)
    for _ in range(3):
        assert limiter.hit("k", 3, 60) is None          # admitted and counted, at 0, 10 and 20 s
        clock.advance(10)
    assert limiter.hit("k", 3, 60) == 30               # at 30 s the first hit frees a place in 30 s
    clock.advance(30)
    assert limiter.hit("k", 3, 60) is None             # at 60 s the hit at 0 s has left the window
    clock.advance(1)
    assert limiter.hit("k", 3, 60) == 9                # at 61 s: hits at 10, 20 and 60 s; the one at 10 s leaves at 70
    assert limiter.hit("other", 3, 60) is None         # keys count apart
    clock.advance(0.5)
    assert limiter.hit("k", 3, 60) == 9                # retry_after is whole seconds, rounded up, never 0

    # A refused hit isn't counted: once the window has slid, the key admits again.
    clock.advance(60)
    assert all(limiter.hit("k", 3, 60) is None for _ in range(3))


async def test_enforce_raises_with_the_retry_after_and_exempts_no_one_but_loopback(clock):
    limiter = RateLimiter(clock)
    limit = LIMITS["copies"]
    assert (limit.limit, limit.window_s, limit.per) == (30, 3600, "ip")
    for _ in range(30):
        await limiter.enforce("copies", "203.0.113.7")
    with pytest.raises(RateLimited) as refused:
        await limiter.enforce("copies", "203.0.113.7")
    assert refused.value.retry_after == 3600
    await limiter.enforce("copies", "203.0.113.8")     # another address has its own window
    for _ in range(100):
        await limiter.enforce("copies", None)          # an exempt peer (deps.client_ip answers None) is never counted
    with pytest.raises(ValueError):
        await limiter.enforce("visitor_turn_conversation", None)    # only per-IP limits have exempt callers
    with pytest.raises(KeyError):
        await limiter.enforce("no_such_limit", "k")


async def test_limit_hit_is_ledgered_once_per_window(visitor, fake, clock):
    limiter = RateLimiter(clock)
    ledger = RateLimitLedger(visitor.kernel, desk_id=visitor.ids.desk_id, session_id=visitor.ids.session_id)
    session = visitor.ids.session_id

    def appended() -> list[dict]:
        return [call.body["event"] for call in fake.called("POST /ledger/append")]

    for _ in range(10):
        await limiter.enforce("verify", session, ledger=ledger)
    assert appended() == []                             # admitted hits are never ledgered
    for _ in range(3):
        with pytest.raises(RateLimited):
            await limiter.enforce("verify", session, ledger=ledger)
    assert appended() == [{"kind": "rate_limit", "origin": "api", "session_id": session, "ref_id": None,
                           "summary": {"limit": "verify"}}]
    assert [call.headers.get("x-session-token") for call in fake.called("POST /ledger/append")] == [visitor.token]
    entry = fake.desks[visitor.ids.desk_id].ledger[-1]
    assert (entry.event.kind, entry.event.origin, entry.event.summary) == ("rate_limit", "api", {"limit": "verify"})

    with pytest.raises(RateLimited):                    # refused without a credential: counted, not ledgered
        await limiter.enforce("verify", session)
    assert len(appended()) == 1

    clock.advance(601)                                  # the next window's first refusal is ledgered again
    for _ in range(10):
        await limiter.enforce("verify", session, ledger=ledger)
    for _ in range(2):
        with pytest.raises(RateLimited):
            await limiter.enforce("verify", session, ledger=ledger)
    assert len(appended()) == 2


async def test_turn_limits_count_by_address_and_by_conversation(visitor, fake, clock):
    """`visitor_turn` slides over an hour per address; `visitor_turn_conversation` has no window, so a conversation's
    thirty turns stay counted however long it lasts, until a day has passed since its last one (by then the kernel
    has closed a session that was idle all along)."""
    assert (LIMITS["visitor_turn"], LIMITS["visitor_turn_conversation"], LIMITS["new_chat"]) == (
        Limit(90, 3600, "ip"), Limit(30, None, "session"), Limit(180, 3600, "ip"))
    assert CONVERSATION_IDLE_S == 86400
    limiter = RateLimiter(clock)
    ledger = RateLimitLedger(visitor.kernel, desk_id=visitor.ids.desk_id, session_id=visitor.ids.session_id)
    session = visitor.ids.session_id
    for _ in range(30):
        await limiter.enforce("visitor_turn_conversation", session, ledger=ledger)
        clock.advance(60)                               # one turn a minute, the last at 29 minutes
    for wait, retry_after in ((0, 86340), (7200, 79140), (79139, 1)):
        clock.advance(wait)
        with pytest.raises(RateLimited) as refused:
            await limiter.enforce("visitor_turn_conversation", session, ledger=ledger)
        assert refused.value.retry_after == retry_after
    assert [call.body["event"]["summary"] for call in fake.called("POST /ledger/append")] == [
        {"limit": "visitor_turn_conversation"}]         # once for the conversation, however long it lasts
    clock.advance(1)                                    # a day after the last counted turn: the count is let go
    await limiter.enforce("visitor_turn_conversation", session, ledger=ledger)

    for _ in range(90):
        await limiter.enforce("visitor_turn", "203.0.113.7")
    with pytest.raises(RateLimited) as refused:
        await limiter.enforce("visitor_turn", "203.0.113.7")
    assert refused.value.retry_after == 3600
    clock.advance(3600)
    await limiter.enforce("visitor_turn", "203.0.113.7")


async def test_enforce_all_counts_on_every_limit_or_none(visitor, fake, clock):
    limiter = RateLimiter(clock)
    ledger = RateLimitLedger(visitor.kernel, desk_id=visitor.ids.desk_id, session_id=visitor.ids.session_id)
    turn = [("visitor_turn_conversation", "s1"), ("visitor_turn", "203.0.113.7")]
    for _ in range(90):
        await limiter.enforce("visitor_turn", "203.0.113.7")
    for _ in range(3):                                  # the address refuses: the conversation's hit is taken back
        with pytest.raises(RateLimited):
            await limiter.enforce_all(turn, ledger=ledger)
    assert [call.body["event"]["summary"] for call in fake.called("POST /ledger/append")] == [{"limit": "visitor_turn"}]
    for n in range(30):                                 # so the conversation still has all thirty
        await limiter.enforce_all([("visitor_turn_conversation", "s1"), ("visitor_turn", None)])
    with pytest.raises(RateLimited):
        await limiter.enforce("visitor_turn_conversation", "s1")
    clock.advance(3600)                                 # the conversation refuses first: the address counts nothing
    for _ in range(3):
        with pytest.raises(RateLimited):
            await limiter.enforce_all(turn)
    for _ in range(90):
        await limiter.enforce("visitor_turn", "203.0.113.7")


async def test_a_ledger_failure_still_refuses(visitor, fake, clock):
    limiter = RateLimiter(clock)
    ledger = RateLimitLedger(visitor.kernel, desk_id=visitor.ids.desk_id, session_id=visitor.ids.session_id)
    for _ in range(10):
        await limiter.enforce("verify", visitor.ids.session_id, ledger=ledger)
    fake.fail("/ledger/append", "connect", times=1)
    with pytest.raises(RateLimited):                    # the kernel unreachable: still a 429, never a pass
        await limiter.enforce("verify", visitor.ids.session_id, ledger=ledger)
    with pytest.raises(RateLimited):                    # and the window's entry is tried again on the next refusal
        await limiter.enforce("verify", visitor.ids.session_id, ledger=ledger)
    assert len(fake.called("POST /ledger/append")) == 2
    assert fake.desks[visitor.ids.desk_id].ledger[-1].event.summary == {"limit": "verify"}


async def test_once_per_window_writes_once_a_window_and_tries_a_failed_write_again(clock):
    """A write bounded to once per key in each window, the window starting at the write; a skipped write lets the
    caller go on without it."""
    limiter = RateLimiter(clock)
    writes: list[str] = []

    def write(name: str) -> Callable[[], Awaitable[None]]:
        async def run() -> None:
            writes.append(name)
        return run

    await limiter.once_per_window("a", 600, write("a"))
    clock.advance(599)
    await limiter.once_per_window("a", 600, write("a"))         # within the window: nothing written
    await limiter.once_per_window("b", 600, write("b"))         # keys count apart
    clock.advance(1)
    await limiter.once_per_window("a", 600, write("a"))         # the window has ended: written, and a new one starts
    await limiter.once_per_window("a", 600, write("a"))
    assert writes == ["a", "b", "a"]

    # Callers at the same moment write once: the key is marked before the write is awaited.
    started, finish = asyncio.Event(), asyncio.Event()

    async def slow() -> None:
        writes.append("c")
        started.set()
        await finish.wait()

    first = asyncio.create_task(limiter.once_per_window("c", 600, slow))
    await started.wait()
    await limiter.once_per_window("c", 600, slow)
    finish.set()
    await first
    assert writes.count("c") == 1

    # A write that fails marks nothing: the failure reaches the caller, and the next caller writes.
    async def failing() -> None:
        writes.append("d")
        raise KernelUnavailable("POST /ledger/append")

    with pytest.raises(KernelUnavailable):
        await limiter.once_per_window("d", 600, failing)
    await limiter.once_per_window("d", 600, write("d"))
    await limiter.once_per_window("d", 600, write("d"))
    assert writes.count("d") == 2


async def test_once_per_window_writes_each_time_the_clock_cannot_be_read(clock):
    """The window fails toward writing: while the clock can't be read, every call writes and marks nothing, and a
    failing write's exception still reaches the caller. Once the clock reads again, the next call writes."""
    broken = True

    def unreadable() -> datetime:
        if broken:
            raise OSError("the clock can't be read")
        return clock()

    limiter = RateLimiter(unreadable)
    writes: list[str] = []

    async def write() -> None:
        writes.append("a")

    async def failing() -> None:
        writes.append("failed")
        raise KernelUnavailable("POST /ledger/append")

    for _ in range(3):
        await limiter.once_per_window("a", 600, write)
    assert writes == ["a"] * 3
    with pytest.raises(KernelUnavailable):
        await limiter.once_per_window("a", 600, failing)
    assert writes[-1] == "failed"

    broken = False                                      # nothing was marked: the first call with a clock writes
    await limiter.once_per_window("a", 600, write)
    await limiter.once_per_window("a", 600, write)
    assert writes == ["a"] * 3 + ["failed", "a"]


async def test_once_per_window_writes_after_the_clock_steps_back(clock):
    """A mark that ends further off than one window (the clock was stepped back) is stale, so the window fails toward
    writing: the write runs, and the next window starts from the clock as it now reads."""
    limiter = RateLimiter(clock)
    writes: list[str] = []

    async def write() -> None:
        writes.append("a")

    await limiter.once_per_window("a", 600, write)
    clock.advance(-3600)
    await limiter.once_per_window("a", 600, write)         # the mark ends 4200 s off: stale, so written
    clock.advance(599)
    await limiter.once_per_window("a", 600, write)         # within the new window: nothing written
    clock.advance(1)
    await limiter.once_per_window("a", 600, write)
    assert writes == ["a"] * 3


def test_stream_slots_cap_each_session_and_address():
    slots = StreamSlots()
    assert (slots.per_session, slots.per_ip) == (3, 30)
    closed: list[str] = []

    def stream(name: str, session_id: str, ip: str | None):
        return slots.acquire(session_id, ip, on_close=lambda: closed.append(name))

    held = [stream(f"s1-{n}", "s1", "203.0.113.7") for n in range(3)]
    held.append(stream("s1-3", "s1", "203.0.113.7"))   # a fourth on one session closes its oldest, never 429
    assert closed == ["s1-0"]
    assert slots.open_counts() == ({"s1": 4}, {"203.0.113.7": 4})   # counted until the closed stream has ended
    held[0].release()                                   # it ended: its place frees now
    assert slots.open_counts() == ({"s1": 3}, {"203.0.113.7": 3})
    held[1].release()
    held[1].release()                                   # releasing twice frees one place, once
    assert slots.open_counts() == ({"s1": 2}, {"203.0.113.7": 2})
    held.append(stream("s1-4", "s1", "203.0.113.7"))
    assert closed == ["s1-0"]                           # room under the cap: nothing closed

    for n in range(27):                                 # 30 streams from one address, over many sessions
        held.append(stream(f"other-{n}", f"other-{n // 3}", "203.0.113.7"))
    with pytest.raises(RateLimited) as refused:         # another session's 31st from the address
        stream("s2-0", "s2", "203.0.113.7")
    assert refused.value.retry_after == 5 and closed == ["s1-0"]
    held.append(stream("s1-5", "s1", "203.0.113.7"))   # its own session's oldest makes way
    assert closed == ["s1-0", "s1-2"]
    assert slots.open_counts()[1] == {"203.0.113.7": 31}     # one past the cap only while the closed one ends
    with pytest.raises(RateLimited):                    # so another reload waits until it has ended
        stream("s1-6", "s1", "203.0.113.7")
    assert closed == ["s1-0", "s1-2"]
    held[2].release()
    assert slots.open_counts()[1] == {"203.0.113.7": 30}
    with stream("s2-1", "s2", "203.0.113.8"):           # another address; the slot frees on leaving the block
        pass
    for n in range(3):
        held.append(stream(f"s3-{n}", "s3", None))      # an exempt peer counts toward its session only
    held.append(stream("s3-3", "s3", None))
    assert closed[-1] == "s3-0"
    held.append(stream("s3-4", "s3", None))             # one still ending isn't closed again: the oldest open is
    assert closed[-2:] == ["s3-0", "s3-1"] and slots.open_counts()[0]["s3"] == 5
    # A session moved to another address at its cap: closing its oldest frees no place at this one.
    for n in range(3):
        held.append(stream(f"s4-{n}", "s4", "198.51.100.4"))
    with pytest.raises(RateLimited):
        stream("s4-3", "s4", "203.0.113.7")
    assert closed[-1] == "s3-1"                          # refused: nothing closed
    for slot in held:
        slot.release()
    assert slots.open_counts() == ({}, {})
