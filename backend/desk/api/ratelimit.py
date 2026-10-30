"""The API's rate limits: in memory, per process, over sliding windows (Plan 02a, "Rate limits").

`RateLimiter.hit(key, limit, window_s)` admits and counts a request while the key's window holds fewer than
`limit` hits, and otherwise answers how many whole seconds until one leaves it; a refused hit isn't counted.
`enforce(name, key)` applies one of `LIMITS` and raises `RateLimited(retry_after)`, which the app answers
with 429 `{"error": "rate_limited", "retry_after": s}`; `enforce_all` applies several, counting on each or on none.
When the request holds a credential, `ledger` names it, and the first refusal in each window of a limit and key is
reported to the kernel as an `api`-origin `rate_limit` entry naming only the limit. A ledger append that fails is
logged without values and tried again at the next refusal; the request is refused either way.

The money guard is on model turns and the daily model budget, never on page loads: loading or resuming a chat is
never limited, a new chat counts toward `new_chat`, and a visitor message that starts a model turn counts toward
`visitor_turn` (per address, by the hour) and `visitor_turn_conversation` (per session, with no window). A limit
with no window keeps its count for the conversation: hits never leave it one by one, and the count is let go only
once a day has passed since its last hit (`CONVERSATION_IDLE_S`), by when the kernel has closed the session unless
other requests kept it open, so the memory it holds stays bounded.

Per-IP limits take the key from `deps.client_ip`, which answers None for a caller exempt from them (a
loopback peer: the built-in agent, and any loopback peer outside production); every other limit needs a key.

`once_per_window(key, window_s, write)` bounds a write rather than a request: it awaits `write` unless it was awaited
for `key` less than `window_s` ago, and a skipped write lets the request go on without it. It fails toward writing: a
clock that can't be read, or a mark from before the clock was stepped back, means the write runs. A resumed chat's
`session` ledger entry is written this way (routes/public.py), since resuming is never limited.
"""

import logging
import math
from collections import deque
from collections.abc import Awaitable, Callable, Hashable
from dataclasses import dataclass
from datetime import datetime
from typing import Literal

from desk.api.kernel_client import CredentialView, KernelFailed, KernelUnavailable
from desk.contracts import LedgerEvent
from desk.kernel_api import LedgerAppendRequest

logger = logging.getLogger(__name__)


CONVERSATION_IDLE_S = 24 * 3600     # the kernel closes a session after a day idle


@dataclass(frozen=True)
class Limit:
    limit: int
    window_s: int | None                # None: no window, the count lasts the conversation (module docstring)
    per: Literal["ip", "session", "copy", "agent_key"]


LIMITS: dict[str, Limit] = {
    "passcode": Limit(30, 600, "ip"),               # failed passcodes only: a right one gives its place back
    "copies": Limit(30, 3600, "ip"),                # new copies and start over: a backstop against a leaked passcode
    "new_chat": Limit(180, 3600, "ip"),             # a new visitor session; resuming one is never limited
    "visitor_turn": Limit(90, 3600, "ip"),          # a visitor message that starts a model turn
    "proxy": Limit(60, 600, "ip"),                  # document and payment links
    "a2a_ip": Limit(120, 3600, "ip"),
    "visitor_turn_conversation": Limit(30, None, "session"),   # the same messages, per conversation
    "verify": Limit(10, 600, "session"),
    "demo_agent": Limit(5, 3600, "copy"),
    "setup_turn": Limit(80, 3600, "copy"),
    "owner_ai": Limit(40, 3600, "copy"),
    "a2a": Limit(30, 300, "agent_key"),             # counted once the kernel accepted the signature
}


class RateLimited(Exception):
    """A limit refused the request; `retry_after` is whole seconds, at least 1."""

    def __init__(self, retry_after: int):
        super().__init__(f"rate limited; retry after {retry_after} s")
        self.retry_after = retry_after


@dataclass(frozen=True)
class RateLimitLedger:
    """The credential a refusal is ledgered with: its kernel view, the Desk whose ledger takes the entry and
    the session it names (the credential's own, or None)."""

    kernel: CredentialView
    desk_id: str
    session_id: str | None = None


def _span(window_s: float | None) -> float:
    """How long a window's refusal stays ledgered: the window, or for a conversation's count, its idle day."""
    return CONVERSATION_IDLE_S if window_s is None else window_s


class _Window:
    __slots__ = ("window_s", "hits")

    def __init__(self, window_s: float | None):
        self.window_s = window_s
        self.hits: deque[float] = deque()

    def slide(self, now: float) -> None:
        if self.window_s is None:                       # a conversation's count, let go after a day with no hit
            if self.hits and self.hits[-1] <= now - CONVERSATION_IDLE_S:
                self.hits.clear()
            return
        while self.hits and self.hits[0] <= now - self.window_s:
            self.hits.popleft()

    def retry_after(self, now: float) -> int:
        """Whole seconds, at least 1, until a hit leaves (or, with no window, the count is let go)."""
        frees_at = self.hits[-1] + CONVERSATION_IDLE_S if self.window_s is None else self.hits[0] + self.window_s
        return max(1, math.ceil(frees_at - now))


class RateLimiter:
    """Sliding-window counts by key, timed by `clock` (the app's clock, which tests move)."""

    SWEEP_EVERY = 1024        # hits between sweeps of windows that have emptied

    def __init__(self, clock: Callable[[], datetime]):
        self._clock = clock
        self._windows: dict[Hashable, _Window] = {}
        self._ledgered: dict[Hashable, float] = {}      # (name, key) -> when its window's refusal was ledgered
        self._written: dict[Hashable, float] = {}       # once_per_window's key -> when its window ends
        self._since_sweep = 0

    def _now(self) -> float:
        return self._clock().timestamp()

    def hit(self, key: Hashable, limit: int, window_s: float | None) -> int | None:
        """Count one hit and answer None while the window holds fewer than `limit`; else the seconds until one
        leaves it, counting nothing. `window_s` None counts with no window (module docstring)."""
        now = self._now()
        self._sweep(now)
        window = self._windows.get(key)
        if window is None or window.window_s != window_s:
            window = self._windows[key] = _Window(window_s)
        window.slide(now)
        if len(window.hits) >= limit:
            return window.retry_after(now)
        window.hits.append(now)
        return None

    def _sweep(self, now: float) -> None:
        self._since_sweep += 1
        if self._since_sweep < self.SWEEP_EVERY:
            return
        self._since_sweep = 0
        for key, window in list(self._windows.items()):
            window.slide(now)
            if not window.hits:
                del self._windows[key]
        for key, at in list(self._ledgered.items()):
            if at <= now - _span(LIMITS[key[0]].window_s):
                del self._ledgered[key]
        for key, until in list(self._written.items()):
            if until <= now:
                del self._written[key]

    async def once_per_window(self, key: Hashable, window_s: float, write: Callable[[], Awaitable[object]]) -> None:
        """Await `write()` unless it was awaited for `key` less than `window_s` ago, in which case nothing is done. The
        key is marked before the await, so callers at the same moment write once; a `write` that raises unmarks it, so
        the next caller writes, and the exception goes on to the caller. It fails toward writing: a clock that can't be
        read means `write()` is awaited and nothing is marked, and a mark that ends further off than `window_s` (the
        clock was stepped back) is stale, so the write runs."""
        try:
            now = self._now()
        except Exception:
            logger.warning("the clock could not be read, so a write bounded to once a window runs anyway")
            await write()
            return
        self._sweep(now)
        until = self._written.get(key)
        if until is not None and now < until <= now + window_s:
            return
        self._written[key] = until = now + window_s
        try:
            await write()
        except BaseException:
            if self._written.get(key) == until:
                del self._written[key]
            raise

    def forget(self, name: str, key: Hashable | None) -> None:
        """Take back the latest hit counted on limit `name` for `key` (a passcode that turned out right)."""
        window = None if key is None else self._windows.get((name, key))
        if window is not None and window.hits:
            window.hits.pop()

    async def enforce(self, name: str, key: Hashable | None, *, ledger: RateLimitLedger | None = None) -> None:
        """Count a hit on limit `name` for `key`, or raise `RateLimited`, ledgering the window's first refusal
        with `ledger` when one is given. A None key is exempt from per-IP limits."""
        limit = LIMITS[name]
        if key is None:
            if limit.per != "ip":
                raise ValueError(f"the {name} limit needs a key")
            return
        retry_after = self.hit((name, key), limit.limit, limit.window_s)
        if retry_after is None:
            return
        if ledger is not None:
            await self._ledger_refusal(name, key, limit, ledger)
        raise RateLimited(retry_after)

    async def enforce_all(self, limits: list[tuple[str, Hashable | None]], *,
                          ledger: RateLimitLedger | None = None) -> None:
        """`enforce` each (name, key) in order, counting a hit on every one or on none: when one refuses, the hits
        the ones before it counted are taken back."""
        counted: list[tuple[str, Hashable | None]] = []
        try:
            for name, key in limits:
                await self.enforce(name, key, ledger=ledger)
                counted.append((name, key))
        except RateLimited:
            for name, key in counted:
                self.forget(name, key)
            raise

    async def _ledger_refusal(self, name: str, key: Hashable, limit: Limit, ledger: RateLimitLedger) -> None:
        now, marker = self._now(), (name, key)
        last = self._ledgered.get(marker)
        if last is not None and last > now - _span(limit.window_s):
            return                                      # this window's refusal is already ledgered
        self._ledgered[marker] = now                    # before the await, so concurrent refusals append once
        event = LedgerEvent(kind="rate_limit", origin="api", session_id=ledger.session_id, summary={"limit": name})
        try:
            await ledger.kernel.call("POST /ledger/append", LedgerAppendRequest(desk_id=ledger.desk_id, event=event))
        except (KernelFailed, KernelUnavailable):
            if self._ledgered.get(marker) == now:
                del self._ledgered[marker]              # the next refusal tries again
            logger.warning("a rate limit refusal could not be ledgered (limit %s)", name)


STREAMS_PER_SESSION = 3
STREAMS_PER_IP = 30
STREAM_RETRY_AFTER_S = 5      # an open stream frees its place when its client goes away


class StreamSlot:
    """One open stream's place; `release()` (or leaving its `with` block) frees it, once. `close()` also ends the
    stream, through the `on_close` its route gave."""

    def __init__(self, slots: "StreamSlots", session_id: str, ip: str | None,
                 on_close: Callable[[], None] | None = None):
        self._slots, self.session_id, self.ip, self._on_close = slots, session_id, ip, on_close
        self._held = True

    def release(self) -> None:
        if self._held:
            self._held = False
            self._slots._free(self)

    def close(self) -> None:
        """Make way for a newer stream: free the place at once and end the stream."""
        self.release()
        if self._on_close is not None:
            self._on_close()

    def __enter__(self) -> "StreamSlot":
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.release()


class StreamSlots:
    """Open event streams, per session (oldest first) and counted per client address (None: exempt from the address
    cap). A session's stream past its cap closes the session's oldest instead of being refused, so a reload never
    answers 429 while the old page's stream is still counted; past the address's cap a stream is refused."""

    def __init__(self, per_session: int = STREAMS_PER_SESSION, per_ip: int = STREAMS_PER_IP):
        self.per_session, self.per_ip = per_session, per_ip
        self._sessions: dict[str, list[StreamSlot]] = {}
        self._ips: dict[str, int] = {}

    def acquire(self, session_id: str, ip: str | None, *, on_close: Callable[[], None] | None = None) -> StreamSlot:
        """A place for one more stream, `on_close` ending it should a newer one close it. At the session's cap its
        oldest stream is closed to make way; `RateLimited` when the address would still be past its cap (counting the
        place that closing frees), and then nothing is closed."""
        open_here = self._sessions.get(session_id, [])
        oldest = open_here[0] if len(open_here) >= self.per_session else None
        if ip is not None:
            freed = 1 if oldest is not None and oldest.ip == ip else 0
            if self._ips.get(ip, 0) - freed >= self.per_ip:
                raise RateLimited(STREAM_RETRY_AFTER_S)
        if oldest is not None:
            oldest.close()
        slot = StreamSlot(self, session_id, ip, on_close)
        self._sessions.setdefault(session_id, []).append(slot)
        if ip is not None:
            self._ips[ip] = self._ips.get(ip, 0) + 1
        return slot

    def _free(self, slot: StreamSlot) -> None:
        open_here = self._sessions[slot.session_id]
        open_here.remove(slot)
        if not open_here:
            del self._sessions[slot.session_id]
        if slot.ip is not None:
            self._ips[slot.ip] -= 1
            if not self._ips[slot.ip]:
                del self._ips[slot.ip]

    def open_counts(self) -> tuple[dict[str, int], dict[str, int]]:
        """The open streams by session and by address."""
        return {session_id: len(open_here) for session_id, open_here in self._sessions.items()}, dict(self._ips)
