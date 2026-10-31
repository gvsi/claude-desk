"""Client idempotency keys and request hashes.

A route that starts something its client finds again only through the answer takes an optional `idempotency_key`, one
per click: a repeat with the same key in the same copy answers what the first started and starts nothing. A repeat is
compared with the first by the sha256 of its canonical body, the key left out, so the same key with another body is
409 `conflict`. The proving routes key their kept work by the same hash.
"""

import hashlib
import json
from typing import Annotated, Any

from pydantic import StringConstraints

# Opaque to the API: 1 to 128 characters, none of them a control character (Postgres text can't hold a NUL).
IdempotencyKey = Annotated[str, StringConstraints(min_length=1, max_length=128, pattern=r"^[^\x00-\x1f\x7f]+$")]

NO_BODY = hashlib.sha256(b"").hexdigest()


def body_sha256(body: dict[str, Any] | None) -> str:
    """The sha256 of a request body's canonical JSON (keys sorted, no spaces), or of no body."""
    if body is None:
        return NO_BODY
    return hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
                          ).hexdigest()
