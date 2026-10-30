"""The language of a draft's prose: English, Spanish, another language, or too little to tell.

`detect` counts function words. The text is NFKC-normalized and lowercased, and its words are
runs of letters, accents kept, so "qué" is Spanish and "que", which French and Portuguese share,
counts for none. The three marker sets are disjoint and leave out the words the languages share
("de", "que", "le", "no", "me"), except "la" and "un" and the short words a Spanish reply leans
on ("tu", "te", "ti", "lo", "del", "al", "está", "claro"), which Spanish keeps although French,
Portuguese or Italian write them too: frequent words of those languages that neither English nor
Spanish writes ("à", "quand", "já", "vou", "certo", "subito") outweigh them there. "para" and
"por" count for none, since Portuguese writes them as often as Spanish does.

Prose in any language but English or Spanish hands off to the owner (`unsupported_language`), so
a misreading in that direction costs a handoff, never an unchecked reply: both lexicons run on
every draft whatever its language. Words with no marker at all are too little to tell while the
session has no last language (until a reply reads as English or Spanish), so a first reply in
Spanish words no list holds falls back as an empty reply does rather than handing off in English;
once the session has a language, four or more of them are another language. An unmarked reply in
another language before that is shown only if both lexicons and the soft-promise check pass it.
"""

import re
import unicodedata
from typing import Literal

Detected = Literal["en", "es", "other", "none"]

NON_LATIN_SHARE = 0.3                     # more of the letters than this outside the Latin script: other
MIN_UNMARKED_WORDS = 4                    # this many words with no marker, once the session has a language: other
SPANISH_MARKS = ("ñ", "¿", "¡")
SPANISH_MARK_BONUS = 2

EN_MARKERS = frozenset("""
    the an and or but of to in on at for with from by about into
    is are was were be been being am can could will would should may might must
    have had does did this that these those there here what which who whom when where how why
    i you she it we they my your his her its our their him us them
    not if just only also any some all more very please thanks thank hello hi yes sure
    help need want like know get let see look call
""".split())

ES_MARKERS = frozenset("""
    el la los las un una unos unas y es están estoy soy eres usted ustedes pero cómo qué cuál cuándo dónde
    cuando donde cual muy más sí también hay puedo puede necesito quiero gracias hola esto eso ese esa aquí
    ahí tiene tengo hacer bueno gusto ayudo ayudar día con su sus tus yo nuestro nuestra hasta entonces ahora
    está estás tu te ti lo ya del al claro listo perfecto enseguida quedó
""".split())

# French, Portuguese, Italian and German words that are neither English nor Spanish markers
OTHER_MARKERS = frozenset("""
    je vous nous il elle est sont avec pour dans pas une des du ce mais ça peux suis avez oui merci bonjour
    votre très voudrais aider et qui sur você não com uma isso obrigado obrigada pode posso ajudar muito eu
    sim pela che sono non questo grazie anche molto ciao ich und nicht das ist mit ein bitte danke kann für
    sie wir ihnen gerne
    à au toi moi tout quand demain já vou estou tudo depois assim bem certo perfeito
    ci gli più bene tutto perfetto subito dopo
""".split())

if EN_MARKERS & ES_MARKERS or (EN_MARKERS | ES_MARKERS) & OTHER_MARKERS:
    raise RuntimeError("the language marker sets are disjoint")

WORD = re.compile(r"[^\W\d_]+")


def detect(text: str, last_language: str | None) -> Detected:
    """`en` or `es` when that language's markers lead; `other` for another script, more markers
    of another language, or four or more words with no marker once the session has a
    `last_language`; `none` for no words, a tie, a few unmarked words ("OK"), or unmarked words
    while the session has no last language, which then read as an empty reply does."""
    lowered = unicodedata.normalize("NFKC", text).lower()
    words = WORD.findall(lowered)
    if not words:
        return "none"
    letters = [ch for ch in lowered if ch.isalpha()]
    non_latin = sum(not unicodedata.name(ch, "").startswith("LATIN ") for ch in letters)
    if non_latin > NON_LATIN_SHARE * len(letters):
        return "other"
    en = sum(word in EN_MARKERS for word in words)
    es = sum(word in ES_MARKERS for word in words)
    if any(mark in lowered for mark in SPANISH_MARKS):
        es += SPANISH_MARK_BONUS
    other = sum(word in OTHER_MARKERS for word in words)
    if other > en and other > es:
        return "other"
    if en == es == 0:
        return "other" if last_language is not None and len(words) >= MIN_UNMARKED_WORDS else "none"
    if en == es:
        return "none"
    return "en" if en > es else "es"
