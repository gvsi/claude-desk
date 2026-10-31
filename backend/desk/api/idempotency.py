"""Client idempotency keys and request hashes.

A route that starts something its client finds again only through the answer requires an `idempotency_key`, one per
click (422 without one): a repeat with the same key in the same copy answers what the first started and starts
nothing. A repeat is compared with the first by the sha256 of its canonical body, the key left out, so the same key
with another body is 409 `conflict`. The proving routes key their kept work by the same hash.

A request is admitted (looked up, counted on its limits and claimed) under its key's lock in this process
(`Admissions`), so a concurrent repeat waits for the first's admission, then finds its claim and is never counted
itself. Another process admits on its own: during a deploy's overlap, a repeat routed to the other task can be counted
twice.
"""

import asyncio
import contextlib
import hashlib
import json
from collections.abc import AsyncIterator
from typing import Annotated, Any

from pydantic import StringConstraints

# Opaque to the API: 1 to 128 characters, none of them a control character (Postgres text can't hold a NUL).
IdempotencyKey = Annotated[str, StringConstraints(min_length=1, max_length=128, pattern=r"^[^\x00-\x1f\x7f]+$")]

NO_BODY = hashlib.sha256(b"").hexdigest()


class Admissions:
    """One lock per (copy, key) in this process, held while a keyed request is admitted; a lock goes once nothing
    holds or waits for it."""

    def __init__(self) -> None:
        self._locks: dict[tuple[str, str], tuple[asyncio.Lock, int]] = {}      # (copy, key) -> its lock, its users

    @contextlib.asynccontextmanager
    async def admitting(self, copy_id: str, key: str) -> AsyncIterator[None]:
        """Hold the (copy, key) admission, waiting while another request holds it."""
        held = (copy_id, key)
        lock, users = self._locks.get(held, (None, 0))
        lock = lock or asyncio.Lock()
        self._locks[held] = (lock, users + 1)
        try:
            async with lock:
                yield
        finally:
            lock, users = self._locks[held]
            if users == 1:
                del self._locks[held]
            else:
                self._locks[held] = (lock, users - 1)

    def __len__(self) -> int:
        return len(self._locks)

    def users(self) -> int:
        """How many requests hold or wait for an admission lock."""
        return sum(users for _, users in self._locks.values())


def body_sha256(body: dict[str, Any] | None) -> str:
    """The sha256 of a request body's canonical JSON (keys sorted, no spaces), or of no body."""
    if body is None:
        return NO_BODY
    return hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
                          ).hexdigest()
