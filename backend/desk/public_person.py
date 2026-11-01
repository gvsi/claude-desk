"""Phone and visit directions before a future person claim, shared by both policy scanners."""

import re

_FUTURE = re.compile(r"you(?:['’]ll|\s+will)\s+be\b", re.IGNORECASE)
_FUTURE_ES = re.compile(r"(?:hablar[aá]s?|vas?\s+a\s+hablar)\b", re.IGNORECASE)
_CALL_ES = re.compile(r"\b(?:llam[ae]s?|visite?s?)\b", re.IGNORECASE)
_CALL = re.compile(r"\b(?:call|phone|ring|visit)\b", re.IGNORECASE)


def future_person_direction(text: str, start: int) -> bool:
    """A preceding call direction exempts only a future claim in the same sentence and card."""
    if _FUTURE.match(text, start):
        call = _CALL
    elif _FUTURE_ES.match(text, start):
        call = _CALL_ES
    else:
        return False
    prefix = re.split(r"[.!?\n]", text[:start])[-1]
    return call.search(prefix) is not None
