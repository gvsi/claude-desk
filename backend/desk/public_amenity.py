"""Public policy text may offer an amenity for free, never a service.

"Free parking.", "Complimentary coffee while you wait." and "Estacionamiento gratis." pass in public policy
text. "Free estimates.", "Consultations are complimentary." and "Consulta gratis." stay refused, as every one of
these words stays refused in Claude's own reply prose. Pure, and shared by the kernel and its contract fake.
"""

import re
import unicodedata

EN_WORDS = frozenset({"free", "complimentary"})
ES_WORDS = frozenset({"gratis", "gratuito", "gratuita", "gratuitos", "gratuitas"})

_EN = r"(?:parking|wi-?fi|coffee|water|tea|snacks?|(?:a\s+)?waiting\s+(?:area|room))"
_ES = r"(?:estacionamiento|aparcamiento|wi-?fi|cafe|agua|sala\s+de\s+espera)"
_JOIN = r"(?:\s*,\s*(?:(?:and|or|y|o)\s+)?|\s*&\s*|\s+(?:and|or|y|o)\s+)"
_SERVICE = (r"(?:services?|visits?|consultations?|consults?|inspections?|estimates?|quotes?|"
            r"servicios?|visitas?|consultas?|inspeccion(?:es)?|presupuestos?|cotizacion(?:es)?)")
# An amenity list straight after the word, read whole (atomic), that doesn't go on to a service.
_EN_AFTER = re.compile(rf"[\s-]+(?>{_EN}(?:{_JOIN}{_EN})*)(?!\w)(?!{_JOIN}(?:\w+\s+){{0,2}}{_SERVICE}(?!\w))",
                       re.IGNORECASE)
_ES_BEFORE = re.compile(rf"(?<!\w){_ES}(?:{_JOIN}{_ES})*\s+$", re.IGNORECASE)
_SERVICE_BEFORE = re.compile(rf"(?<!\w){_SERVICE}{_JOIN}$", re.IGNORECASE)
_DASHES = dict.fromkeys(map(ord, "‐‑‒–—−"), "-")


def _plain(text: str) -> str:
    """Accents dropped and dashes read as "-"."""
    return "".join(ch for ch in unicodedata.normalize("NFKD", text) if not unicodedata.combining(ch)).translate(_DASHES)


def offers_amenity(text: str, start: int, end: int) -> bool:
    """Whether the promise word at `text[start:end]` offers an amenity: "free" or "complimentary" right before a
    short amenity list (parking, wi-fi, coffee, water, tea, snacks, a waiting area) that goes on to no service,
    or "gratis" or "gratuito" right after one (estacionamiento, aparcamiento, wifi, café, agua, sala de espera)
    that follows no service. `text` is one policy's text, so a neighbouring card never supplies the amenity."""
    word = _plain(text[start:end]).casefold()
    if word in EN_WORDS:
        return _EN_AFTER.match(_plain(text[end:])) is not None
    if word in ES_WORDS:
        before = _plain(text[:start])
        found = _ES_BEFORE.search(before)
        return found is not None and _SERVICE_BEFORE.search(before[:found.start()]) is None
    return False
