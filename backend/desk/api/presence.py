"""Presence: who is typing in a conversation, in this process's memory (Plan 02b, Task 1).

Typing is presence, not a message: it carries no text and makes no kernel call beyond naming the caller, and no ledger
entry; the visitor's is never stored. A visitor's typing shows to the owner alone, as `OwnerTranscript.typing_until`.
The owner's typing after a take-over shows to the visitor as an `owner_typing` event, which names the owner as the
kernel does and carries an end time but no text; the route emits it, and `Presence` only spaces those events out.

A signal shows for five seconds, and one within two seconds of the last that counted changes nothing. A client sends
about one every two seconds while its person types, never one per keystroke: each signal still costs a kernel
`GET /whoami`, a pooled database connection and kernel_ro reads. Plan 06b runs one task, so this memory is the whole
of it; a restart forgets at most a few seconds of dots. Entries that can no longer matter are dropped as new signals
come in.
"""

from datetime import datetime, timedelta

TYPING_SHOWS_FOR = timedelta(seconds=5)
TYPING_COUNTS_EVERY = timedelta(seconds=2)


class Presence:
    """The typing signals of this process's sessions, by session ID (module docstring). Callers pass the time."""

    def __init__(self) -> None:
        self._visitors: dict[str, tuple[datetime, datetime]] = {}  # session_id -> (when it counted, when it ends)
        self._owners: dict[str, datetime] = {}                      # session_id -> when the owner's dots last went out

    def visitor_typing(self, session_id: str, now: datetime) -> bool:
        """The session's visitor is typing: their dots show to the owner until five seconds from now. False, and
        nothing changes, within two seconds of the last signal that counted."""
        self._forget(now)
        counted = self._visitors.get(session_id)
        if counted is not None and now - counted[0] < TYPING_COUNTS_EVERY:
            return False
        self._visitors[session_id] = (now, now + TYPING_SHOWS_FOR)
        return True

    def visitor_typing_until(self, session_id: str, now: datetime) -> datetime | None:
        """When the visitor's dots stop, while that is still to come; else None."""
        counted = self._visitors.get(session_id)
        return counted[1] if counted is not None and counted[1] > now else None

    def owner_typing(self, session_id: str, now: datetime) -> datetime | None:
        """When the owner's dots, if sent now, stop showing to the visitor: five seconds from now. None, and nothing is
        to be sent, within two seconds of the dots last sent. It records nothing: the route calls `owner_typing_sent`
        once their event is committed, so dots that never went out hold no later signal back."""
        self._forget(now)
        sent = self._owners.get(session_id)
        if sent is not None and now - sent < TYPING_COUNTS_EVERY:
            return None
        return now + TYPING_SHOWS_FOR

    def owner_typing_sent(self, session_id: str, now: datetime) -> None:
        """The owner's dots of `now` went out (their event is committed): a signal in the next two seconds sends
        none."""
        self._owners[session_id] = now

    def _forget(self, now: datetime) -> None:
        """Drop the signals that can no longer show or hold a later one back (both are older than five seconds)."""
        self._visitors = {session_id: counted for session_id, counted in self._visitors.items() if counted[1] > now}
        self._owners = {session_id: sent for session_id, sent in self._owners.items()
                        if sent + TYPING_SHOWS_FOR > now}
