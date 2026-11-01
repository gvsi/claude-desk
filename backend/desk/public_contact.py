"""The public contact claim is a list of contact endpoints, never free text."""

import re
import unicodedata
from urllib.parse import urlsplit

EMAIL = re.compile(r"[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@"
                   r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
                   r"(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+")
# A phone, optionally followed by a numeric extension ("ext. 2", "x12", "extension 4").
PHONE = re.compile(r"(?P<phone>\+?[0-9 ().-]++)(?:\s*(?:extension|ext\.?|x)\s*[0-9]{1,6})?", re.IGNORECASE)
# The only words allowed before an endpoint, in any case, each optionally followed by a colon.
LABEL = re.compile(r"(?:call\s+us\s+at|call\s+or\s+text(?:\s+us\s+at)?|call|text\s+or\s+call|text\s+us\s+at|"
                   r"text|whatsapp|email\s+us\s+at|email|phone|tel|"
                   r"mobile|office|website|web|ll[aá]manos\s+al|escr[ií]benos\s+a|tel[eé]fono|correo)(?:\s*:\s*|\s+)",
                   re.IGNORECASE)
# A whole https URL, up to whitespace, which may hold commas and semicolons; one at its end separates.
URL = re.compile(r"https://\S*[^\s,;|·]", re.IGNORECASE)
# " or " separates, except inside "Call or text" and "Text or call".
SEPARATOR = re.compile(r"\r\n|(?<!\s)\s+·\s+|[,;|\r\n]|(?<!\s)\s+/\s+|(?<!\s)\s+(?:and|o|y)\s+|"
                       r"(?<!\bcall)(?<!\btext)(?<!\s)\s+or\s+|(?<!\s)\s+or\s+(?!(?:text|call)\b)",
                       re.IGNORECASE)
DOMAIN = re.compile(r"(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}(?:/[^\s]*)?")
CALL_OR_TEXT = re.compile(r"\s+\(call\s+or\s+text\)$", re.IGNORECASE)
HELD = re.compile("\x00([0-9]+)\x00")


def valid_public_contact(value: str) -> bool:
    """Every part is an email, a 7–15 digit phone with an optional numeric extension, an HTTPS URL with a
    host, or a bare domain with an optional path ("www.example.com/book"), each optionally after a fixed
    label in any case ("Call us at", "Call or text us at", "Text or call", "WhatsApp:", "Email:",
    "Website:", "Teléfono:"). Parts are separated by " · ", ",",
    ";", "|", a line break, a spaced "/" or " or ", " and ", " o ", " y "; whole https URLs are taken out
    first, so their own commas and semicolons don't split them. A trailing separator is ignored.
    Phones may end with the fixed "(call or text)" suffix. Contacts over 500 characters are refused
    before parsing."""
    if len(value) > 500:
        return False
    if any(unicodedata.category(ch).startswith("C") and ch not in "\r\n" for ch in value):
        return False
    urls: list[str] = []

    def hold(match: re.Match[str]) -> str:
        urls.append(match.group())
        return f"\x00{len(urls) - 1}\x00"

    parts = SEPARATOR.split(URL.sub(hold, value))
    if len(parts) > 1 and not parts[-1].strip():
        parts.pop()
    return bool(parts) and all(_part(HELD.sub(lambda held: urls[int(held[1])], part).strip()) for part in parts)


def _part(value: str) -> bool:
    if label := LABEL.match(value):
        value = value[label.end():]
    return _endpoint(value)


def _endpoint(value: str) -> bool:
    if not value:
        return False
    if EMAIL.fullmatch(value) and len(value) <= 254:
        return True
    phone = PHONE.fullmatch(CALL_OR_TEXT.sub("", value))
    if phone and 7 <= sum(ch in "0123456789" for ch in phone["phone"]) <= 15:
        return True
    if any(ch.isspace() for ch in value):
        return False
    if DOMAIN.fullmatch(value) and len(value.split("/", 1)[0]) <= 253:
        return True
    try:
        url = urlsplit(value)
        return url.scheme == "https" and bool(url.hostname) and url.port != 0
    except ValueError:
        return False
