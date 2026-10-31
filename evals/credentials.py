"""Credential masking for every error text the evals write: a run's error detail (`RunError`), an API
refusal's message (`ApiCallFailed`) and the reason a run was charged its estimate. Each masks first and
cuts after, so a credential that crosses a cut is masked whole, never written in part."""

import re
from typing import Any

# A URL's password (`scheme://user:password@host`, up to the token's last @, so an unencoded @ in the password
# is masked whole, or to the end of the text when a message cut before it was masked ends inside it) and any
# value a password key sets (`password=`, `PGPASSWORD=`, `'password': '…'`, `password: …`), as a database or
# HTTP error's message can carry them. A quoted value is masked whole, to its closing quote (or the end of the
# text), its escaped quotes and spaces included, as a libpq connection string quotes one.
_URL_PASSWORD = re.compile(r"(?P<head>\b[a-zA-Z][a-zA-Z0-9+.\-]*://[^:/?#@\s'\"]*:)(?:[^\s'\"]*(?P<at>@)|[^\s'\"]*\Z)")
_PASSWORD_VALUE = re.compile(r"""(?i)(?P<key>\b\w*password\b['"]?\s*[:=]\s*)"""
                             r"""(?:(?P<quote>['"])(?:\\.|(?!(?P=quote))[^\\])*(?P=quote)?|[^\s'"&,}]*)""", re.DOTALL)
_PASSWORD_KEY = re.compile(r"(?i)password")
MASKED = "***"


def mask_credentials(text: str) -> str:
    """`text` with each URL's password and every value a password key sets replaced by `***`."""
    text = _URL_PASSWORD.sub(lambda m: m.group("head") + MASKED + (m.group("at") or ""), text)
    return _PASSWORD_VALUE.sub(_masked_value, text)


def mask_values(value: Any) -> Any:
    """A display copy of a JSON value: every password key's value, whatever its type, replaced by `***`,
    and every string masked (`mask_credentials`). Mask before serializing: serializing escapes a quoted
    password's quotes, and the masking would misread the escaped text and show the password's tail."""
    if isinstance(value, str):
        return mask_credentials(value)
    if isinstance(value, dict):
        return {key: MASKED if _PASSWORD_KEY.search(str(key)) else mask_values(item) for key, item in value.items()}
    if isinstance(value, list | tuple):
        return [mask_values(item) for item in value]
    return value


def _masked_value(match: re.Match[str]) -> str:
    quote = match.group("quote") or ""
    return match.group("key") + quote + MASKED + quote


__all__ = ["MASKED", "mask_credentials", "mask_values"]
