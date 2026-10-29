"""The transcript store (`app.messages`): append-only conversations and the model input built from them."""

from dataclasses import dataclass


@dataclass(frozen=True)
class Ids:
    """The copy, Desk and session a request works in, taken only from a kernel answer (`/whoami`)."""

    copy_id: str
    desk_id: str
    session_id: str
