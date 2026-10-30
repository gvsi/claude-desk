"""Canonical JSON (RFC 8785), restated with the `rfc8785` library instead of the kernel's.

Every hash the master plan signs (ledger envelopes, decisions, verdicts and their blocks) is a
sha256 over this form. Floats are refused, as the kernel's `canonical_json` refuses them: money is
integer cents and scores are basis points, so a float in a signed payload is itself a defect.
"""

import hashlib
from typing import Any

import rfc8785


def canonical(obj: Any) -> bytes:
    """The RFC 8785 bytes of a JSON value: sorted keys, no insignificant whitespace, nulls kept.
    Raises ValueError on a float anywhere in it, a non-string key or an integer outside the safe
    range."""
    _refuse_floats(obj, "$")
    return rfc8785.dumps(obj)


def sha256_hex(obj: Any) -> str:
    """The lowercase hex sha256 of `canonical(obj)`."""
    return hashlib.sha256(canonical(obj)).hexdigest()


def _refuse_floats(obj: Any, path: str) -> None:
    if isinstance(obj, float):
        raise ValueError(f"{path} is a float ({obj!r}); canonical JSON here holds integers only")
    if isinstance(obj, dict):
        for key, value in obj.items():
            _refuse_floats(value, f"{path}.{key}")
    elif isinstance(obj, list | tuple):
        for index, value in enumerate(obj):
            _refuse_floats(value, f"{path}.{index}")
