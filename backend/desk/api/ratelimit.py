"""The API's rate limits: in memory, per process, over sliding windows (Plan 02a, "Rate limits").

`RateLimiter.hit(key, limit, window_s)` admits and counts a request while the key's window holds fewer than
`limit` hits, and otherwise answers how many whole seconds until one leaves it; a refused hit isn't counted.
`enforce(name, key)` applies one of `LIMITS` and raises `RateLimited(retry_after)`, which the app answers
with 429 `{"error": "rate_limited", "retry_after": s}`. When the request holds a credential, `ledger` names it,
and the first refusal in each window of a limit and key is reported to the kernel as an `api`-origin
`rate_limit` entry naming only the limit. A ledger append that fails is logged without values and tried
again at the next refusal; the request is refused either way.

Per-IP limits take the key from `deps.client_ip`, which answers None for a caller exempt from them (a
loopback peer: the built-in agent, and any loopback peer outside production); every other limit needs a key.
"""

import logging
import math
from collections import deque
from collections.abc import Callable, Hashable
from dataclasses import dataclass
from datetime import datetime
from typing import Literal

from desk.api.kernel_client import CredentialView, KernelFailed, KernelUnavailable
from desk.contracts import LedgerEvent
from desk.kernel_api import LedgerAppendRequest

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Limit:
    limit: int
    window_s: int
    per: Literal["ip", "session", "copy", "agent_key"]


LIMITS: dict[str, Limit] = {
    "passcode": Limit(30, 600, "ip"),               # failed passcodes only: a right one gives its place back
    "copies": Limit(30, 3600, "ip"),                # new copies and start over
    "visitor_session": Limit(30, 3600, "ip"),
    "proxy": Limit(60, 600, "ip"),                  # document and payment links
    "a2a_ip": Limit(120, 3600, "ip"),
    "visitor_message": Limit(20, 300, "session"),
    "visitor_message_copy": Limit(300, 86400, "copy"),
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


class _Window:
    __slots__ = ("window_s", "hits")

    def __init__(self, window_s: float):
        self.window_s = window_s
        self.hits: deque[float] = deque()

    def slide(self, now: float) -> None:
        while self.hits and self.hits[0] <= now - self.window_s:
            self.hits.popleft()


class RateLimiter:
    """Sliding-window counts by key, timed by `clock` (the app's clock, which tests move)."""

    SWEEP_EVERY = 1024        # hits between sweeps of windows that have emptied

    def __init__(self, clock: Callable[[], datetime]):
        self._clock = clock
        self._windows: dict[Hashable, _Window] = {}
        self._ledgered: dict[Hashable, float] = {}      # (name, key) -> when its window's refusal was ledgered
        self._since_sweep = 0

    def _now(self) -> float:
        return self._clock().timestamp()

    def hit(self, key: Hashable, limit: int, window_s: float) -> int | None:
        """Count one hit and answer None while the window holds fewer than `limit`; else the seconds until one
        leaves it, counting nothing."""
        now = self._now()
        self._sweep(now)
        window = self._windows.get(key)
        if window is None or window.window_s != window_s:
            window = self._windows[key] = _Window(window_s)
        window.slide(now)
        if len(window.hits) >= limit:
            return max(1, math.ceil(window.hits[0] + window_s - now))
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
            if at <= now - LIMITS[key[0]].window_s:
                del self._ledgered[key]

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

    async def _ledger_refusal(self, name: str, key: Hashable, limit: Limit, ledger: RateLimitLedger) -> None:
        now, marker = self._now(), (name, key)
        last = self._ledgered.get(marker)
        if last is not None and last > now - limit.window_s:
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
    """One open stream's place; `release()` (or leaving its `with` block) frees it, once."""

    def __init__(self, slots: "StreamSlots", session_id: str, ip: str | None):
        self._slots, self._session_id, self._ip = slots, session_id, ip
        self._held = True

    def release(self) -> None:
        if self._held:
            self._held = False
            self._slots._free(self._session_id, self._ip)

    def __enter__(self) -> "StreamSlot":
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.release()


class StreamSlots:
    """Open event streams, counted per session and per client address (None: exempt from the address cap)."""

    def __init__(self, per_session: int = STREAMS_PER_SESSION, per_ip: int = STREAMS_PER_IP):
        self.per_session, self.per_ip = per_session, per_ip
        self._sessions: dict[str, int] = {}
        self._ips: dict[str, int] = {}

    def acquire(self, session_id: str, ip: str | None) -> StreamSlot:
        """A place for one more stream, or `RateLimited` past either cap."""
        if self._sessions.get(session_id, 0) >= self.per_session or (
                ip is not None and self._ips.get(ip, 0) >= self.per_ip):
            raise RateLimited(STREAM_RETRY_AFTER_S)
        self._sessions[session_id] = self._sessions.get(session_id, 0) + 1
        if ip is not None:
            self._ips[ip] = self._ips.get(ip, 0) + 1
        return StreamSlot(self, session_id, ip)

    def _free(self, session_id: str, ip: str | None) -> None:
        for counts, key in ((self._sessions, session_id), (self._ips, ip)):
            if key is not None:
                counts[key] -= 1
                if not counts[key]:
                    del counts[key]

    def open_counts(self) -> tuple[dict[str, int], dict[str, int]]:
        """The open streams by session and by address."""
        return dict(self._sessions), dict(self._ips)
