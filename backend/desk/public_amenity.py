"""Public policy text may offer an amenity for free, never a service.

"Free parking.", "Complimentary coffee while you wait." and "Estacionamiento gratis." pass in public policy
text. "Free estimates.", "Consultations are complimentary." and "Consulta gratis." stay refused, as every one of
these words stays refused in Claude's own reply prose. Pure, and shared by the kernel and its contract fake.
"""

import re
import unicodedata

EN_WORDS = frozenset({"free", "complimentary", "no cost", "at no cost"})
ES_WORDS = frozenset({"gratis", "gratuito", "gratuita", "gratuitos", "gratuitas"})

_EN = r"(?:(?:on-site|street|covered|secure|high-speed|hot)\s+)?(?:parking|wi-?fi|coffee|water|tea|snacks?|(?:a\s+)?waiting\s+(?:area|room))"
_ES = r"(?:estacionamiento|aparcamiento|wi-?fi|cafe|agua|sala\s+de\s+espera)"
_JOIN = r"(?:\s*,\s*(?:(?:and|or|y|o)\s+)?|\s*&\s*|\s+(?:and|or|y|o)\s+)"
# Read only complete amenity phrases, with at most six amenities in one list.
_EN_AFTER = re.compile(
    rf"[\s-]+(?>{_EN}(?:{_JOIN}{_EN}){{0,5}})(?=\s*(?:[.!?);]|$)|\s*,?\s+(?:while|for|during|in|at|on|with|when)\b)",
    re.IGNORECASE)
_ES_BEFORE = re.compile(
    rf"(?:^|[.!?:;¡¿(]\s*|\b(?:hay|ofrecemos|tenemos|con)\s+){_ES}(?:{_JOIN}{_ES}){{0,5}}\s+$",
    re.IGNORECASE)
_EN_BEFORE = re.compile(rf"(?:^|[.!?:;(]\s*){_EN}(?:{_JOIN}{_EN}){{0,5}}\s+$", re.IGNORECASE)
_DASHES = dict.fromkeys(map(ord, "‐‑‒–—−"), "-")


def _plain(text: str) -> str:
    """Accents dropped and dashes read as "-"."""
    return "".join(ch for ch in unicodedata.normalize("NFKD", text) if not unicodedata.combining(ch)).translate(_DASHES)


def offers_amenity(text: str, start: int, end: int) -> bool:
    """Whether the price phrase at `text[start:end]` offers an amenity: "free", "complimentary" or "no cost" before a
    complete list of at most six amenities (parking, wi-fi, coffee, water, tea, snacks, a waiting area),
    or "gratis" or "gratuito" right after one (estacionamiento, aparcamiento, wifi, café, agua, sala de espera)
    that starts at a sentence boundary or a fixed offering word. "Costs nothing" follows a complete
    English list at a sentence boundary. `text` is one policy's text, so a
    neighbouring card never supplies the amenity. Each context window is at most 200 characters."""
    word = re.sub(r"[\s-]+", " ", _plain(text[start:end])).casefold()
    # A cut window edge is not a sentence boundary or the end of the policy.
    before = ("\0" if start > 200 else "") + _plain(text[max(0, start - 200):start])
    after = _plain(text[end:end + 200]) + ("\0" if end + 200 < len(text) else "")
    if word in EN_WORDS:
        return _EN_AFTER.match(after) is not None
    if word in ES_WORDS:
        return _ES_BEFORE.search(before) is not None
    if word in {"cost nothing", "costs nothing"}:
        return _EN_BEFORE.search(before) is not None
    return False
