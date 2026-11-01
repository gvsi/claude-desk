"""Phone directions before a future person claim, shared by both policy scanners."""

import re

_FUTURE = re.compile(r"you(?:['’]ll|\s+will)\s+be\b", re.IGNORECASE)
_CALL = re.compile(r"\b(?:call|phone|ring|visit)\b", re.IGNORECASE)


def future_person_direction(text: str, start: int) -> bool:
    """A preceding call direction exempts only a future claim in the same sentence and card."""
    if not _FUTURE.match(text, start):
        return False
    prefix = re.split(r"[.!?\n]", text[:start])[-1]
    return _CALL.search(prefix) is not None
