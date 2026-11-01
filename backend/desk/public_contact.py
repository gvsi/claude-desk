"""The public contact claim is a list of contact endpoints, never free text."""

import re
import unicodedata
from urllib.parse import urlsplit

EMAIL = re.compile(r"[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@"
                   r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
                   r"(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+")
PHONE = re.compile(r"\+?[0-9 ().-]+")


def valid_public_contact(value: str) -> bool:
    """Every nonempty part is an email, a 7–15 digit phone, or an HTTPS URL with a host."""
    if any(unicodedata.category(ch).startswith("C") and ch not in "\r\n" for ch in value):
        return False
    parts = re.split(r" · |[,;\r\n]", value)
    return bool(parts) and all(_part(part.strip()) for part in parts)


def _part(value: str) -> bool:
    if not value:
        return False
    if EMAIL.fullmatch(value) and len(value) <= 254:
        return True
    if PHONE.fullmatch(value) and 7 <= sum(ch in "0123456789" for ch in value) <= 15:
        return True
    if any(ch.isspace() for ch in value):
        return False
    try:
        url = urlsplit(value)
        return url.scheme == "https" and bool(url.hostname) and url.port != 0
    except ValueError:
        return False
