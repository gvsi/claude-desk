"""The language of a draft's prose: English, Spanish, another language, or too little to tell.

`detect` counts function words. The text is NFKC-normalized and lowercased, and its words are
runs of letters, accents kept, so "qué" is Spanish and "que", which French and Portuguese share,
counts for none. The three marker sets are disjoint and leave out the words the languages share
("de", "que", "le", "no", "me"), except "la" and "un" and the short words a Spanish reply leans
on ("tu", "te", "ti", "lo", "del", "al", "está", "claro"), which Spanish keeps although French,
Portuguese or Italian write them too: frequent words of those languages that neither English nor
Spanish writes ("à", "quand", "já", "vou", "certo", "subito") outweigh them there, and a tie
with Spanish goes to the other language. A word English or Spanish writes on its own ("pour",
"et cetera", "EU", "das", "sur") marks no other language, and another language must outnumber
English's markers, since English writes some of them as prefixes ("non-toxic"). "para" and
"por" count for none, since Portuguese writes them as often as Spanish does.

Prose in any language but English or Spanish hands off to the owner (`unsupported_language`), so
a misreading in that direction costs a handoff, never an unchecked reply: both lexicons run on
every draft whatever its language. Four or more words with no marker of any language are
another language on every reply, the session's first included, so prose in a language no list
covers, and a time or a price in its words, hands off rather than resting on the model check.
"""

import re
import unicodedata
from typing import Literal

Detected = Literal["en", "es", "other", "none"]

NON_LATIN_SHARE = 0.3                     # more of the letters than this outside the Latin script: other
MIN_UNMARKED_WORDS = 4                    # this many words with no marker of any language: other
SPANISH_MARKS = ("ñ", "¿", "¡")
SPANISH_MARK_BONUS = 2

EN_MARKERS = frozenset("""
    the an and or but of to in on at for with from by about into
    is are was were be been being am can could will would should may might must
    have had does did this that these those there here what which who whom when where how why
    i you she it we they my your his her its our their him us them
    not if just only also any some all more very please thanks thank hello hi yes sure
    help need want like know get let see look call
    down up out off then now until after before than too
""".split())

ES_MARKERS = frozenset("""
    el la los las un una unos unas y es están estoy soy eres usted ustedes pero cómo qué cuál cuándo dónde
    cuando donde cual muy más sí también hay puedo puede necesito quiero gracias hola esto eso ese esa aquí
    ahí tiene tengo hacer bueno gusto ayudo ayudar día con su sus tus yo nuestro nuestra hasta entonces ahora
    está estás tu te ti lo ya del al claro listo perfecto enseguida quedó
""".split())

# French, Portuguese, Italian and German words that English and Spanish don't write on their own:
# the homographs ("pour", "et", "est", "eu", "sim"; "das", "des", "une", "sur", "pela", "pode",
# "che") are left out
OTHER_MARKERS = frozenset("""
    je vous nous il elle sont avec dans pas du ce mais ça peux suis avez oui merci bonjour votre très
    voudrais aider qui você não com uma isso obrigado obrigada posso ajudar muito sono non questo grazie
    anche molto ciao ich und nicht ist mit ein bitte danke kann für sie wir ihnen gerne
    à au toi moi tout quand demain já vou estou tudo depois assim bem certo perfeito
    ci gli più bene tutto perfetto subito dopo
""".split())

if EN_MARKERS & ES_MARKERS or (EN_MARKERS | ES_MARKERS) & OTHER_MARKERS:
    raise RuntimeError("the language marker sets are disjoint")

WORD = re.compile(r"[^\W\d_]+")


def detect(text: str) -> Detected:
    """`en` or `es` when that language's markers lead; `other` for another script, more markers
    of another language than of English and at least as many as of Spanish, or four or more words
    with no marker of any language; `none` for no words, a tie between English and Spanish, or a
    few unmarked words ("OK")."""
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
    if other > en and other >= es:
        return "other"
    if en == es == 0:
        return "other" if len(words) >= MIN_UNMARKED_WORDS else "none"
    if en == es:
        return "none"
    return "en" if en > es else "es"
