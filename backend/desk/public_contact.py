"""The public contact claim is a list of contact endpoints, never free text."""

import re
import unicodedata
from urllib.parse import urlsplit

EMAIL = re.compile(r"[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@"
                   r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
                   r"(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+")
# A phone, optionally followed by a numeric extension ("ext. 2", "x12", "extension 4").
PHONE = re.compile(r"(?P<phone>\+?[0-9 ().-]+?)(?:\s*(?:extension|ext\.?|x)\s*[0-9]{1,6})?", re.IGNORECASE)
# The only words allowed before an endpoint, each optionally followed by a colon.
LABEL = re.compile(r"(?:call\s+us\s+at|call|text\s+us\s+at|text|email\s+us\s+at|email|phone|"
                   r"ll[aá]manos\s+al|escr[ií]benos\s+a|tel[eé]fono|correo)(?:\s*:\s*|\s+)", re.IGNORECASE)


def valid_public_contact(value: str) -> bool:
    """Every nonempty part is an email, a 7–15 digit phone with an optional numeric extension, or an HTTPS
    URL with a host, each optionally after one of a few fixed labels ("Call us at", "Email:", "Teléfono:")."""
    if any(unicodedata.category(ch).startswith("C") and ch not in "\r\n" for ch in value):
        return False
    parts = re.split(r" · |[,;\r\n]", value)
    return bool(parts) and all(_part(part.strip()) for part in parts)


def _part(value: str) -> bool:
    if label := LABEL.match(value):
        value = value[label.end():]
    return _endpoint(value)


def _endpoint(value: str) -> bool:
    if not value:
        return False
    if EMAIL.fullmatch(value) and len(value) <= 254:
        return True
    if (phone := PHONE.fullmatch(value)) and 7 <= sum(ch in "0123456789" for ch in phone["phone"]) <= 15:
        return True
    if any(ch.isspace() for ch in value):
        return False
    try:
        url = urlsplit(value)
        return url.scheme == "https" and bool(url.hostname) and url.port != 0
    except ValueError:
        return False
