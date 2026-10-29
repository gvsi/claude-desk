"""The API's in-memory rate limits: sliding windows, one ledger entry per window's first refusal, open streams."""

import pytest

from desk.api.ratelimit import LIMITS, RateLimited, RateLimiter, RateLimitLedger, StreamSlots


def test_sliding_window(clock):
    limiter = RateLimiter(clock)
    for _ in range(3):
        assert limiter.hit("k", 3, 60) is None          # admitted and counted, at 0, 10 and 20 s
        clock.advance(10)
    assert limiter.hit("k", 3, 60) == 30               # at 30 s the first hit frees a place in 30 s
    clock.advance(30)
    assert limiter.hit("k", 3, 60) is None             # at 60 s the hit at 0 s has left the window
    clock.advance(1)
    assert limiter.hit("k", 3, 60) == 9                # at 61 s: hits at 10, 20 and 60 s; the one at 10 s leaves at 70 s
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
        await limiter.enforce("visitor_message", None)  # only per-IP limits have exempt callers
    with pytest.raises(KeyError):
        await limiter.enforce("no_such_limit", "k")


async def test_limit_hit_is_ledgered_once_per_window(visitor, fake, clock):
    limiter = RateLimiter(clock)
    ledger = RateLimitLedger(visitor.kernel, desk_id=visitor.ids.desk_id, session_id=visitor.ids.session_id)
    session = visitor.ids.session_id

    def appended() -> list[dict]:
        return [call.body["event"] for call in fake.called("POST /ledger/append")]

    for _ in range(20):
        await limiter.enforce("visitor_message", session, ledger=ledger)
    assert appended() == []                             # admitted hits are never ledgered
    for _ in range(3):
        with pytest.raises(RateLimited):
            await limiter.enforce("visitor_message", session, ledger=ledger)
    assert appended() == [{"kind": "rate_limit", "origin": "api", "session_id": session, "ref_id": None,
                           "summary": {"limit": "visitor_message"}}]
    assert [call.headers.get("x-session-token") for call in fake.called("POST /ledger/append")] == [visitor.token]
    entry = fake.desks[visitor.ids.desk_id].ledger[-1]
    assert (entry.event.kind, entry.event.origin, entry.event.summary) == ("rate_limit", "api", {"limit": "visitor_message"})

    with pytest.raises(RateLimited):                    # refused without a credential: counted, not ledgered
        await limiter.enforce("visitor_message", session)
    assert len(appended()) == 1

    clock.advance(301)                                  # the next window's first refusal is ledgered again
    for _ in range(20):
        await limiter.enforce("visitor_message", session, ledger=ledger)
    for _ in range(2):
        with pytest.raises(RateLimited):
            await limiter.enforce("visitor_message", session, ledger=ledger)
    assert len(appended()) == 2


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


def test_stream_slots_cap_each_session_and_address():
    slots = StreamSlots()
    assert (slots.per_session, slots.per_ip) == (3, 30)
    held = [slots.acquire("s1", "203.0.113.7") for _ in range(3)]
    with pytest.raises(RateLimited):                    # a fourth stream on one session
        slots.acquire("s1", "203.0.113.7")
    held[0].release()
    held[0].release()                                   # releasing twice frees one place, once
    held.append(slots.acquire("s1", "203.0.113.7"))
    with pytest.raises(RateLimited):
        slots.acquire("s1", "203.0.113.7")

    for n in range(27):                                 # 30 streams from one address, over many sessions
        held.append(slots.acquire(f"other-{n}", "203.0.113.7"))
    with pytest.raises(RateLimited):
        slots.acquire("s2", "203.0.113.7")
    with slots.acquire("s2", "203.0.113.8"):            # another address; the slot frees on leaving the block
        pass
    for _ in range(3):
        held.append(slots.acquire("s2", None))          # an exempt peer counts toward its session only
    with pytest.raises(RateLimited):
        slots.acquire("s2", None)
    for slot in held:
        slot.release()
    assert slots.open_counts() == ({}, {})
