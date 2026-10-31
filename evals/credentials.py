"""Credential masking for every error text the evals write: a run's error detail (`RunError`), an API
refusal's message (`ApiCallFailed`) and the reason a run was charged its estimate. Each masks first and
cuts after, so a credential that crosses a cut is masked whole, never written in part."""

import re

# A URL's password (`scheme://user:password@host`, up to the token's last @, so an unencoded @ in the password
# is masked whole, or to the end of the text when a message cut before it was masked ends inside it) and any
# value a password key sets (`password=`, `PGPASSWORD=`, `'password': '…'`, `password: …`), as a database or
# HTTP error's message can carry them. A quoted value is masked whole, to its closing quote (or the end of the
# text), its escaped quotes and spaces included, as a libpq connection string quotes one.
_URL_PASSWORD = re.compile(r"(?P<head>\b[a-zA-Z][a-zA-Z0-9+.\-]*://[^:/?#@\s'\"]*:)(?:[^\s'\"]*(?P<at>@)|[^\s'\"]*\Z)")
_PASSWORD_VALUE = re.compile(r"""(?i)(?P<key>\b\w*password\b['"]?\s*[:=]\s*)"""
                             r"""(?:(?P<quote>['"])(?:\\.|(?!(?P=quote))[^\\])*(?P=quote)?|[^\s'"&,}]*)""", re.DOTALL)
MASKED = "***"


def mask_credentials(text: str) -> str:
    """`text` with each URL's password and every value a password key sets replaced by `***`."""
    text = _URL_PASSWORD.sub(lambda m: m.group("head") + MASKED + (m.group("at") or ""), text)
    return _PASSWORD_VALUE.sub(_masked_value, text)


def _masked_value(match: re.Match[str]) -> str:
    quote = match.group("quote") or ""
    return match.group("key") + quote + MASKED + quote


__all__ = ["MASKED", "mask_credentials"]
