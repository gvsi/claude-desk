"""The reply check (`POST /check_reply`): nothing Claude drafts reaches a visitor unchecked.

A draft is prose plus clauses. `check_draft` runs the plan's steps after the route has answered
the session-state rows ("Session state responses": token, copy, closed, generation, mode `owner`):

1. A paused session (the breaker) gets only the handoff clause and a `session_paused` violation;
   nothing is scanned.
2. Language: `lang.detect` on the prose. Another language is `unsupported_language`; too little to
   tell falls back to the session's language, else English. Cards render in this language. The
   session's language is set at turn start from the visitor's latest message
   (`POST /sessions/{session_id}/turn`, `turn.py`), and kept or changed at the end by the language
   of Claude's prose (step 7). It decides only the language a reply whose prose can't be told
   renders in: the code's checks find the same in a draft whichever language the session reads,
   since both lexicons always run; the soft-promise check is told that language, with the cards
   rendered in it.
3. `scan_prose`: numerals and the letters drawn as digits, currency and percent signs, words
   mixing Latin letters with another script (but for the Desk's own name and its business's
   name, as the owner set them), both lexicons (`lexicon/en.txt` and `lexicon/es.txt`, whatever
   the language, with each letter that looks like a Latin one read as it, from
   `lexicon/lookalikes.txt`, every dash as "-" and every apostrophe as "’"; booking claims such
   as "you're booked" among them, unless the reply carries a booking card that step 4 passed;
   call claims instead need a callback card that passed those same clause checks), and
   the copy's document canaries, even split by spaces or accented letters, in another case or
   width, accented, or with letters or digits of other scripts drawn like its own, or all of these
   at once (`labels.canary_spans`, which reads the same lookalike table, its letters and its
   digits). Since the owner's decisions of 2026-10-30, a booking claim passes beside the booking's
   card, which says the same, a policy's words are left to the soft-promise check, which reads the
   prose with the cards, and Claude may write links and email addresses, which its prompt keeps to
   the business's own.
4. Each clause renders from a fact this session may read, current, of the template's kind and ID,
   with no canary in any field it renders or in the fact ID it names. The Desk's catalog
   (`context.catalog_fact`) is cited like a stored fact, and no template renders it, so it backs
   no card. The clauses are checked before the prose is scanned, so the scan knows which cards
   pass; their refusals follow the scan's.
5. The soft-promise check, only when steps 2 to 4 found nothing and there is prose: Haiku 5.5
   reads the prose and the cards' texts (never the visitor's words) and flags a promise the cards
   don't hold (`soft.promise`) or prose that says or suggests the writer is a human
   (`soft.denies_ai`). No verdict (a timeout, an error, a refusal, an unparsable answer) blocks
   too (`soft.unavailable`). While the session has an open handoff the handoff card opened
   (`open_handoff_ids`, kind `card`), the card's text is one of those cards, though the reply
   doesn't show it again: the owner has the conversation, so a later "Maria Rivera will reply
   here" is backed, as the card that opened it said. A call-back request backs nothing (the
   owner's decision of 2026-10-31): its own card names a time and never says the owner will
   reply here, and once its window has passed nothing promises a call. That handoff is read
   without a lock, so the model never holds one; a reply that passes with its card is checked
   again in step 7.
6. `ok` when nothing was found: the prose (when not empty) and the cards; otherwise only the
   handoff clause, in the reply's language, or no block at all for a first attempt the API
   rewrites (`final` false, every violation one a rewrite can fix), which is never shown.
7. `finalize`: the session is seen and keeps a detected language for its next reply and status
   lines, until the next turn starts (its row written only now, so no lock on it is held while the
   model reads the draft); a reply that passed step 5 with an open handoff's card passes only if a
   handoff is still open, held until the verdict commits (`handoff_still_open`), and otherwise fails
   as the check would have failed it without the card (`soft.handoff_closed`); when the verdict
   shows the handoff card, an owner handoff is opened for the session unless one is open already
   (`open_card_handoff`, the owner's decision of 2026-10-30); and the verdict is ledgered (`reply`)
   and signed in the same transaction.

The owner's messages (`owner_message`) end in the same record: a say is checked for canaries
alone and shown as typed in an `owner_said` card, and a whisper is only ledgered.

What is shown is exactly what was checked: the prose block holds the prose as the scan read it
(`shown`: NFKC, without the characters no font draws, such as zero-width spaces, soft hyphens,
variation selectors and control characters, and with Hangul fillers as the blank they are drawn
as), so a number can't hide behind an invisible character and come back in the visitor's view.

Spans quote what a rule matched, at most 40 characters, and never a canary: canaries are blanked
out before anything else is scanned, and a canary violation (`labels.canary`) spans only the words
"document text" and names the facts of the documents it came from. The ledger holds kinds, rule
IDs and the cited fact IDs (through `ledger.safe_ref`; one holding a canary only as a hash),
never prose.
"""

import hashlib
import json
import logging
import re
import unicodedata
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path

import desk_kernel
from fastapi import APIRouter, Request
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError

from desk.contracts import (Claim, Clause, Fact, Label, LedgerEvent, OwnerMessageResult, RenderedBlock, ReplyDraft,
                            ReplyVerdict, Violation)
from desk.db.models import Booking, Business, CalendarSlot, Desk, Handoff, Person
from desk.db.models import Decision as DecisionRow
from desk.db.models import Fact as FactRow
from desk.kernel_api import CheckReplyRequest, OwnerMessageRequest
from desk.kernel_service import agents, auth, context, demo_inbox, labels, lang, ledger, render, sessions
from desk.kernel_service.auth import AuthError, Named, OwnerCtx, SessionRow
from desk.kernel_service.decisions import CallUsage, SoftPromiseInput
from desk.kernel_service.render.cards import DeskInfo, slot_claims
from desk.kernel_service.repo import Ctx, KernelCtx, KernelFailure, log_error, new_id, route_template, storable
from desk.kernel_service.sessions import verified
from desk.rewrites import REWRITABLE

VERDICT_DOMAIN = b"desk-verdict-v1\0"
SPAN_CHARS = 40
KERNEL_ONLY = frozenset({"owner_said", "payment_confirmed", "link_cancelled"})   # only the kernel issues these
NUMBER_SEPARATORS = frozenset(".,:'’ ")                        # inside one number: "1.234,56", "10:30"
NO_CANARIES = labels.NO_CANARIES
logger = logging.getLogger(__name__)
HANDOFF_CLOSED = "soft.handoff_closed"   # a reply passed on an open handoff's card, and the handoff was done by the end

# ---- Prose ----------------------------------------------------------------------------------------

LEXICON_DIR = Path(__file__).resolve().parent / "lexicon"
CATEGORIES = {"number": "number_in_prose", "money": "number_in_prose", "percent": "number_in_prose",
              "date": "number_in_prose", "promise": "promise_word", "booking": "promise_word",
              "callback": "promise_word"}
# A condition straight before a booking claim, on folded text in either language: "once you're
# booked", "cuando tu cita está confirmada" say what happens once a booking exists and claim none.
# Each i may be an l, as the capital-I reading writes it ("IF" is read as "lF" too). The folded
# text has no accents, so "si" (if) counts only where the prose writes no mark on it (`_conditioned`).
BOOKING_CONDITION = re.compile(
    r"(?<!\w)(?:once|whenever|when|[il]f|after|before|unt[il]l|t[il]ll|unless|as soon as"
    r"|cuando|(?P<si>s[il])|una vez que|en cuanto|apenas|tan pronto como|despues de que|antes de que|hasta que) "
    r"(?:(?:ya|me|te|le|lo|la|nos|os|les|los|las|se) ){0,3}\Z",
    re.IGNORECASE)
CONDITION_REACH = 48               # longest condition plus bounded Spanish clitics and ya before he/hemos


# Default-ignorable code points beyond category Cf (Unicode's DerivedCoreProperties): the combining
# grapheme joiner, Khmer inherent vowels, Mongolian variation selectors, variation selectors and the
# code points reserved as ignorable. A font draws none of them, so a word can't hide behind one.
IGNORABLE = ((0x034F, 0x034F), (0x17B4, 0x17B5), (0x180B, 0x180F), (0x2065, 0x2065), (0xFE00, 0xFE0F),
             (0xFFF0, 0xFFF8), (0xE0000, 0xE0FFF))
HANGUL_FILLERS = frozenset(map(chr, (0x115F, 0x1160, 0x3164, 0xFFA0)))   # default-ignorable, drawn as a blank
PERCENT_SIGNS = frozenset("%٪‰‱")                        # percent, Arabic percent, per mille, ‱
KEYCAP_TEN = "\U0001f51f"


LINE_CONTROLS = frozenset("\t\n\r")


def _unseen(ch: str) -> bool:
    """A character no font draws: a format character (zero-width spaces and joiners, soft hyphens,
    bidi controls), another default-ignorable code point, a control character other than a tab or
    a line break (NUL included, which no database text can hold), or a lone surrogate, which no
    encoded text can carry."""
    category = unicodedata.category(ch)
    return (category in ("Cf", "Cs") or (category == "Cc" and ch not in LINE_CONTROLS)
            or any(low <= ord(ch) <= high for low, high in IGNORABLE))


def _drawn(text: str) -> str:
    return "".join(" " if ch in HANGUL_FILLERS else ch for ch in text if not _unseen(ch))


def shown(text: str) -> str:
    """Text as the scan reads it and a visitor sees it: NFKC, with the characters no font draws
    removed before and after, and Hangul fillers as the blank a font draws for them."""
    return _drawn(unicodedata.normalize("NFKC", _drawn(text)))


LOOKALIKES = labels.LOOKALIKES              # `lexicon/lookalikes.txt`, which the canary reading reads too
DIGIT_LOOKALIKES = labels.DIGIT_LOOKALIKES  # the same table's characters drawn as a digit
STROKES = frozenset(ch for ch, letter in LOOKALIKES.items() if letter == "l")   # drawn as a bare stroke: l or I
STROKES_AND_I = STROKES | {"I"}                          # with the ASCII capital I, read as l ("tweIve")
# Shaped like 0 or 1, the prototype of 0 being O and of 1 being l: read as digits next to a digit
# ("ЗОО"), or in a word made only of them that isn't plain ASCII ("ІОО"; "I" and "OK" stay words).
ZERO_OR_ONE = frozenset("OlI") | frozenset(ch for ch, letter in LOOKALIKES.items() if letter in ("O", "l"))
SCRIPT_LETTERS = frozenset(("Lu", "Ll", "Lt", "Lo"))     # modifier letters (Lm), such as ʼ, belong to no script
MINUS_SIGN = "\u2212"                                   # a math symbol (Sm), drawn as a dash
APOSTROPHES = frozenset("\u2018\u201b\u02bc\u02bb\u2032\u2035\uff07`\u00b4")   # ‘ ‛ ʼ ʻ ′ ‵ ＇ ` ´, read as ’
SPACED_ACUTE = re.compile(r"\s\u0301")   # NFKC writes an acute accent (´) as a space and a combining acute


def _numeral(ch: str) -> bool:
    """A Unicode numeral, or a character drawn as a digit (a Cyrillic З for 3)."""
    return unicodedata.category(ch)[0] == "N" or ch in DIGIT_LOOKALIKES


def _number_end(text: str, start: int) -> int:
    """Where the number starting at `start` ends: numerals, digit lookalikes and the letters shaped
    like 0 or 1, with a separator between two numerals ("1.234,56", "10:30")."""
    end = start
    while end < len(text) and (_numeral(text[end]) or text[end] in ZERO_OR_ONE or (
            text[end] in NUMBER_SEPARATORS and end > start and _numeral(text[end - 1])
            and end + 1 < len(text) and _numeral(text[end + 1]))):
        end += 1
    return end


def _alone(text: str, start: int, end: int) -> bool:
    """Whether `text[start:end]` is a word of its own: no letter or mark right before or after it."""
    return all(unicodedata.category(text[j])[0] not in "LM" for j in (start - 1, end) if 0 <= j < len(text))


def _words(text: str) -> Iterable[tuple[int, str]]:
    """Each run of letters and combining marks in `text`, and where it starts."""
    start = None
    for i, ch in enumerate(f"{text} "):
        if unicodedata.category(ch)[0] in "LM":
            start = i if start is None else start
        elif start is not None:
            yield start, text[start:i]
            start = None


def _mixes_scripts(word: str) -> bool:
    """Whether `word` has Latin letters and letters of another script ("Tuеsday" with a Cyrillic
    е), telling scripts apart the way `lang.detect` does."""
    latin = [unicodedata.name(ch, "").startswith("LATIN ") for ch in word
             if unicodedata.category(ch) in SCRIPT_LETTERS]
    return any(latin) and not all(latin)


def _plain(ch: str) -> str:
    """A dash or hyphen of any kind (category Pd, which NFKC mostly keeps: "this‐morning" with
    U+2010) and the minus sign read as "-", the one the lexicons' separators take, and an
    apostrophe variant as "’"."""
    if unicodedata.category(ch) == "Pd" or ch == MINUS_SIGN:
        return "-"
    return "’" if ch in APOSTROPHES else ch


def _fold(text: str, stroke: str = "l", strokes: frozenset[str] = STROKES,
          acute: bool = False) -> tuple[str, list[int]]:
    """`text` for the lexicons: accents and other combining marks dropped, each letter that looks
    like an ASCII one read as it ("Tuеsday" with a Cyrillic е is Tuesday), each of `strokes` (by
    default the bare strokes) read as `stroke`, each dash and hyphen as "-", each apostrophe as
    "’", and each run of whitespace one space, but with `acute`, a whitespace character before a
    combining acute (how NFKC writes ´) as "’"; and the index in `text` each folded character
    came from."""
    chars: list[str] = []
    origin: list[int] = []
    for i, ch in enumerate(text):
        if acute and SPACED_ACUTE.match(text, i):
            chars.append("’")
            origin.append(i)
            continue
        if ch.isspace():
            if not chars or chars[-1] != " ":
                chars.append(" ")
                origin.append(i)
            continue
        for part in unicodedata.normalize("NFKD", _plain(ch)):
            if unicodedata.category(part) not in ("Mn", "Me"):
                part = _plain(part)
                chars.append(stroke if part in strokes else LOOKALIKES.get(part, part))
                origin.append(i)
    return "".join(chars), origin


def _load_lexicon(language: str) -> list[tuple[str, re.Pattern[str]]]:
    """`lexicon/<language>.txt`: one `<category>\\t<regex>` per line (blank lines and `#` comments
    aside), matched case-insensitively, as whole words, on folded text. A malformed line stops the
    kernel from starting."""
    path = LEXICON_DIR / f"{language}.txt"
    entries = []
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip() or line.startswith("#"):
            continue
        category, tab, pattern = line.partition("\t")
        if not tab or category not in CATEGORIES or not pattern.strip():
            raise ValueError(f"{path.name}:{number} is not a <category>\\t<regex> line")
        folded, _ = _fold(pattern)
        entries.append((category, re.compile(rf"(?<!\w)(?:{folded})(?!\w)", re.IGNORECASE)))
    return entries


LEXICONS: dict[str, list[tuple[str, re.Pattern[str]]]] = {
    language: _load_lexicon(language) for language in ("en", "es")}
BOOKING_LINES = [(f"lex.{language}.booking", pattern) for language, entries in LEXICONS.items()
                 for category, pattern in entries if category == "booking"]
CALLBACK_LINES = [(f"lex.{language}.callback", pattern) for language, entries in LEXICONS.items()
                  for category, pattern in entries if category == "callback"]


def _named_reach(text: str, names: Iterable[str]) -> list[int]:
    """For each index of `text`, where the furthest-reaching mention of one of `names` (as `shown`
    reads it) that starts there or before ends, or 0: a word at `[start, end)` lies inside one
    mention when `reach[start] >= end`."""
    reach = [0] * (len(text) + 1)
    for name in (shown(name).strip() for name in names):
        start = text.find(name) if name else -1
        while start != -1:
            reach[start] = max(reach[start], start + len(name))
            start = text.find(name, start + 1)
    for i in range(1, len(reach)):
        reach[i] = max(reach[i], reach[i - 1])
    return reach


def _span(text: str) -> str:
    return text[:SPAN_CHARS]


def _blank_canaries(text: str, canaries: Mapping[str, str]) -> tuple[str, list[str]]:
    """`text` with every canary in it blanked out (same length), and the IDs of the documents
    whose canaries it held (`labels.find_canaries`)."""
    spans = labels.canary_spans(text, canaries)
    chars = list(text)
    for _, start, end in spans:
        chars[start:end] = " " * (end - start)
    found = {document_id for document_id, _, _ in spans}
    return "".join(chars), [document_id for document_id in canaries if document_id in found]


def _readings(text: str) -> dict[str, list[int]]:
    """The readings of `text` the lexicons take (`_fold`), each with the
    index in `text` each of its characters came from: a bare stroke as l, as I, and an ASCII
    capital I as l too ("doIIars"); where NFKC wrote an acute accent as a space and a combining
    acute, each also with that pair read as "’" ("o´clock") besides the space it is drawn on
    ("no´charge")."""
    variants: list[dict] = [{}, {"stroke": "i"}, {"strokes": STROKES_AND_I}]
    if SPACED_ACUTE.search(text):
        variants += [variant | {"acute": True} for variant in variants]
    return dict(_fold(text, **variant) for variant in variants)


def _marked(text: str) -> bool:
    """Whether any character of `text` carries an accent or another combining mark."""
    return any(unicodedata.category(part) in ("Mn", "Me") for ch in text for part in unicodedata.normalize("NFKD", ch))


def _conditioned(text: str, reading: str, origin: Sequence[int], start: int) -> bool:
    """Whether a condition (`BOOKING_CONDITION`) stands straight before the booking claim at `start`
    of `reading`, a reading of `text` (`origin` maps it back). The reading drops accents, so "si"
    counts only when `text` writes no mark from its "s" to the claim: "sí" (yes) is no condition
    ("Sí está confirmada" claims the booking)."""
    condition = BOOKING_CONDITION.search(reading, max(0, start - CONDITION_REACH), start)
    if condition is None:
        return False
    return condition.group("si") is None or not _marked(text[origin[condition.start("si")]:origin[start]])


def _claim_spans(pattern: re.Pattern[str], reading: str) -> Iterable[tuple[int, int]]:
    """A lexicon's claim spans. An optional `claim` group distinguishes a claim from lexical
    context consumed by another alternative, such as a Spanish call's subject and verb."""
    group = "claim" if "claim" in pattern.groupindex else 0
    for match in pattern.finditer(reading):
        start, end = match.span(group)
        if end > start:
            yield start, end


def _booking_claims(text: str, readings: dict[str, list[int]]) -> list[tuple[int, str, Violation]]:
    """A `promise_word` (`lex.<lang>.booking` or `lex.<lang>.callback`) for each claim in any reading, but
    for one with a condition straight before it (`_conditioned`: "once you're booked") or inside
    such a claim in the same category and reading ("cuando tu cita está confirmada" holds
    "está confirmada"). Containment is reduced within each category; booking and callback
    matches never suppress each other."""
    found: set[tuple[int, int, str]] = set()
    for reading, origin in readings.items():
        reach: dict[str, int] = {}  # conditioned reach within each category
        for start, end, rule_id in sorted((start, end, rule_id)
                                          for rule_id, pattern in (*BOOKING_LINES, *CALLBACK_LINES)
                                          for start, end in _claim_spans(pattern, reading)):
            category = rule_id.rsplit(".", 1)[1]
            if _conditioned(text, reading, origin, start):
                reach[category] = max(reach.get(category, -1), end)
            if reach.get(category, -1) < end:
                found.add((origin[start], origin[end - 1] + 1, rule_id))
    hits: list[tuple[int, str, Violation]] = []
    reaches: dict[str, int] = {}
    previous: dict[str, tuple[int, int]] = {}
    for start, end, rule_id in sorted(found, key=lambda claim: (claim[0], -claim[1], claim[2])):
        category = rule_id.rsplit(".", 1)[1]
        prior = previous.get(category)
        if prior is not None and prior != (start, end):
            reaches[category] = max(reaches.get(category, -1), prior[1])
        previous[category] = (start, end)
        if reaches.get(category, -1) < end:
            hits.append((start, rule_id, Violation(kind="promise_word", span=_span(text[start:end]), rule_id=rule_id)))
    return hits


def canary_violation(document_ids: Sequence[str]) -> Violation:
    """Text from private documents: the facts of the documents whose canaries it held, never the
    canary."""
    return Violation(kind="canary", span="document text", fact_ids=[f"document:{document_id}" for document_id
                                                                    in document_ids], rule_id="labels.canary")


def scan_prose(text: str, canaries: Mapping[str, str] = NO_CANARIES, names: Iterable[str] = (), *,
               booking_card: bool = False, callback_card: bool = False) -> list[Violation]:
    """Every number, currency sign, lexicon word and canary in `text`, after
    `shown`: any Unicode numeral or character drawn as a digit (`digit`, with the separators inside
    one number and the letters shaped like 0 or 1 next to it in the same span, and a word made only
    of such letters unless it is plain ASCII), currency sign (`currency`) or percent sign
    (`percent_sign`) and every match of both lexicons (`lex.<lang>.<category>`) is
    `number_in_prose`, or `promise_word` for the promise, booking and callback categories, but for a
    claim with a condition straight before it (`BOOKING_CONDITION`: "once you're booked", "si" but
    not "sí") or inside such a claim, a claim inside another being one (`_booking_claims`), and
    for every booking claim with `booking_card` (the reply carries a `booking_confirmed` card the
    clause checks passed, which says the same: the owner's decision of 2026-10-30). Call claims
    instead pass with `callback_card`, a `callback_confirmed` card those checks passed. Neither
    card exempts the other category. Overlapping claims are reduced only within their own
    category before either exemption. A word mixing
    Latin letters with another script is `unsupported_language` (`mixed_script`), unless it lies
    inside one of `names` (the Desk's own names) as it is written there; the canaries of
    `canaries` (document ID → canary), even split or disguised, are one `canary` violation naming
    their documents, and blanked out before the rest is scanned. Links and email addresses are
    none of these (the owner's decision of 2026-10-30: Claude may write them, and its prompt keeps
    them to the business's own). The lexicons read lookalike letters as the Latin ones, a bare
    stroke both as l and as I, an ASCII capital I as l too, every dash and hyphen as "-" and every
    apostrophe as "’", an acute accent (a space and a combining acute after NFKC) both as that
    space and as "’". The canary comes first, then the rest in the order they appear."""
    text, found = _blank_canaries(shown(text), canaries)
    hits: list[tuple[int, str, Violation]] = [(-1, "canary", canary_violation(found))] if found else []
    i = 0
    while i < len(text):
        category = unicodedata.category(text[i])
        if text[i] in PERCENT_SIGNS:
            hits.append((i, "percent_sign", Violation(kind="number_in_prose", span=text[i], rule_id="percent_sign")))
        elif text[i] == KEYCAP_TEN:
            hits.append((i, "digit", Violation(kind="number_in_prose", span=text[i], rule_id="digit")))
        if _numeral(text[i]) or text[i] in ZERO_OR_ONE:
            end = _number_end(text, i)          # no currency or percent sign inside, so passed over once
            if any(_numeral(ch) for ch in text[i:end]) or (_alone(text, i, end) and not text[i:end].isascii()):
                hits.append((i, "digit", Violation(kind="number_in_prose", span=_span(text[i:end]), rule_id="digit")))
            i = end
            continue
        if category == "Sc":
            hits.append((i, "currency", Violation(kind="number_in_prose", span=text[i], rule_id="currency")))
        i += 1
    reach = _named_reach(text, names)
    hits += [(start, "mixed_script", Violation(kind="unsupported_language", span=_span(word), rule_id="mixed_script"))
             for start, word in _words(text) if _mixes_scripts(word) and reach[start] < start + len(word)]
    readings = _readings(text)
    hits += [hit for hit in _booking_claims(text, readings)
             if not (booking_card and hit[1].endswith(".booking")
                     or callback_card and hit[1].endswith(".callback"))]
    seen: set[tuple[str, int, int]] = set()
    for language, entries in LEXICONS.items():
        for category, pattern in entries:
            rule_id = f"lex.{language}.{category}"
            if category in ("booking", "callback"):
                continue
            for reading, origin, match in ((reading, origin, match) for reading, origin in readings.items()
                                           for match in pattern.finditer(reading)):
                if match.end() == match.start():
                    continue
                start, end = origin[match.start()], origin[match.end() - 1] + 1
                if (rule_id, start, end) in seen:
                    continue
                seen.add((rule_id, start, end))
                hits.append((start, rule_id, Violation(kind=CATEGORIES[category], span=_span(text[start:end]),
                                                       rule_id=rule_id)))
    return [violation for _, _, violation in sorted(hits, key=lambda hit: (hit[0], hit[1]))]


# ---- Clauses --------------------------------------------------------------------------------------

def _clause_violation(clause: Clause, kind: str, rule_id: str) -> Violation:
    """A refused clause, naming its template and the fact ID it cited; an ID no text could hold
    (a NUL, a lone surrogate) names no fact, so the verdict can always be sent."""
    cited = clause.fact_id is not None and storable(clause.fact_id)
    return Violation(kind=kind, span=clause.template, rule_id=rule_id, fact_ids=[clause.fact_id] if cited else [])


def block_canaries(block: RenderedBlock, canaries: Mapping[str, str]) -> list[str]:
    """The documents whose canaries any field of the block holds: its text, title, lines, link and
    options."""
    return labels.find_canaries_in(block.model_dump(mode="json"), canaries)


def carries(block: RenderedBlock, canaries: Mapping[str, str]) -> bool:
    """Whether any canary appears in what the block shows."""
    return bool(block_canaries(block, canaries))


async def _free_slots(ctx: KernelCtx, desk_id: str, fact: Fact) -> Fact | None:
    """A slots fact with only the slots still free: on the calendar, not started, not booked. None
    when none is left."""
    pairs = slot_claims(fact)
    ids = [slot_id for slot_id, _ in pairs]
    starts = {slot_id: starts_at for slot_id, starts_at in (await ctx.db.execute(ctx.repo.scoped(
        select(CalendarSlot.slot_id, CalendarSlot.starts_at).where(
            CalendarSlot.desk_id == desk_id, CalendarSlot.slot_id.in_(ids))))).all()}
    booked = set(await ctx.db.scalars(ctx.repo.scoped(select(Booking.slot_id).where(
        Booking.desk_id == desk_id, Booking.status == "confirmed", Booking.slot_id.in_(ids)))))
    now = ctx.clock.now()
    free = [claim_pair for claim_pair, (slot_id, _) in zip(zip(fact.claims[0::2], fact.claims[1::2], strict=True),
                                                           pairs, strict=True)
            if slot_id in starts and starts[slot_id] > now and slot_id not in booked]
    if not free:
        return None
    return fact.model_copy(update={"claims": [claim for pair in free for claim in pair]})


async def check_clauses(ctx: KernelCtx, session_row: SessionRow, desk_id: str, desk: DeskInfo,
                        clauses: Sequence[Clause], language: render.Language,
                        canaries: Mapping[str, str]) -> tuple[list[RenderedBlock], list[Violation]]:
    """Step 4: each clause's card, or why it can't be shown. A clause must name a registered
    template Claude may draft (`template_unavailable`, `kernel_only_template`); a handoff or
    verify prompt names no fact; any other names a fact of this copy and Desk (`unknown_fact`)
    that the session may read (`unentitled_fact`; a session learns nothing more about a fact it
    can't read), of the template's kind and ID (`template_mismatch`), current (`stale_fact`), with
    a link to follow when its card links (`href_for`; else `stale_fact`), and with no canary in any
    field it renders (`canary`, naming the documents, as is a canary given as the fact ID). The
    catalog, which the kernel builds on each read rather than stores, is looked up with the stored
    facts and checked the same way."""
    wanted = {clause.fact_id for clause in clauses if clause.fact_id is not None and storable(clause.fact_id)}
    rows: dict[str, FactRow | Fact] = {}
    if wanted:
        rows = {row.fact_id: row for row in await ctx.db.scalars(ctx.repo.scoped(select(FactRow).where(
            FactRow.desk_id == desk_id, FactRow.fact_id.in_(sorted(wanted)))))}
    if context.CATALOG in wanted and (catalog := await context.catalog_fact(ctx, desk_id)) is not None:
        rows[context.CATALOG] = catalog
    readers = labels.session_readers(session_row)
    now = ctx.clock.now()
    blocks: list[RenderedBlock] = []
    violations: list[Violation] = []
    for clause in clauses:
        template = render.TEMPLATES.get(clause.template)
        if clause.fact_id is not None and (named := labels.find_canaries(clause.fact_id, canaries)):
            violations.append(canary_violation(named))      # a canary as the fact to cite, never echoed
            continue
        if clause.template in KERNEL_ONLY:
            violations.append(_clause_violation(clause, "unknown_fact", "kernel_only_template"))
            continue
        if template is None:
            violations.append(_clause_violation(clause, "unknown_fact", "template_unavailable"))
            continue
        fact = None
        if not template.fact_kinds:
            if clause.fact_id is not None:
                violations.append(_clause_violation(clause, "unknown_fact", "names_no_fact"))
                continue
        else:
            row = rows.get(clause.fact_id) if clause.fact_id is not None else None
            if row is None:
                violations.append(_clause_violation(clause, "unknown_fact", "no_such_fact"))
                continue
            if not labels.can_read(row.label if isinstance(row, Fact) else row.readers, readers):
                violations.append(_clause_violation(clause, "unentitled_fact", "not_a_reader"))
                continue
            fact = row if isinstance(row, Fact) else labels.fact_of(row)
            if not template.reads(fact):
                violations.append(_clause_violation(clause, "unknown_fact", "template_mismatch"))
                continue
            current = template.current(fact, now)
            if current and template.name == "booking_options":
                fact = await _free_slots(ctx, desk_id, fact)
                current = fact is not None
            if not current:
                violations.append(_clause_violation(clause, "stale_fact", "not_current"))
                continue
        try:
            href = await template.href_for(ctx, fact) if template.href_for is not None and fact is not None else None
            block = render.render_clause(clause, fact, language, desk, href=href)
        except render.NothingToShow:
            violations.append(_clause_violation(clause, "stale_fact", "nothing_to_show"))
            continue
        if found := block_canaries(block, canaries):
            violations.append(canary_violation(found))
            continue
        blocks.append(block)
    return blocks, violations


# ---- The verdict ----------------------------------------------------------------------------------

async def _desk_info(ctx: KernelCtx, desk_id: str) -> DeskInfo:
    business = (await ctx.db.scalars(ctx.repo.scoped(
        select(Business).join(Desk, Desk.business_id == Business.business_id).where(Desk.desk_id == desk_id)))).one()
    return DeskInfo(owner_display_name=business.owner_display_name, timezone=business.timezone)


async def desk_names(ctx: KernelCtx, desk_id: str) -> list[str]:
    """The Desk's own name and its business's name, which a reply may name whatever scripts they
    mix: the owner chose them, and the lexicons and the digit scan still read them."""
    names = (await ctx.db.execute(ctx.repo.scoped(select(Desk.name, Business.name).join(
        Business, Business.business_id == Desk.business_id).where(Desk.desk_id == desk_id)))).one()
    return list(names)




def handoff(language: render.Language, desk: DeskInfo) -> RenderedBlock:
    """The handoff clause: "Let me check with Maria Rivera." in the reply's language."""
    return render.render_clause(Clause(template="handoff"), None, language, desk)


async def check_draft(ctx: KernelCtx, session_row: SessionRow, draft: ReplyDraft, *,
                      final: bool = True) -> ReplyVerdict:
    """Steps 1 to 7 for a draft from Claude in an authenticated session ("Reply check"). `final` is
    `CheckReplyRequest.final`: false for a first attempt the API rewrites when every violation is
    rewritable."""
    desk_id = session_row.desk_id
    desk = await _desk_info(ctx, desk_id)
    fallback = render.language(session_row.last_language)
    fact_ids = [clause.fact_id for clause in draft.clauses if clause.fact_id is not None]
    canaries = await labels.copy_canaries(ctx)
    if session_row.mode == "paused":
        return await finalize(ctx, session_row, blocks=[handoff(fallback, desk)], language=fallback, author="claude",
                              violations=[Violation(kind="session_paused", span="", rule_id="session_paused")],
                              fact_ids=fact_ids, seen=True, canaries=canaries, final=final)
    prose = shown(draft.prose)
    # Canaries are attack tokens, not evidence of the reply's language.
    language_prose, _ = _blank_canaries(prose, canaries)
    detected = lang.detect(language_prose)
    language: render.Language = detected if detected in ("en", "es") else fallback
    violations: list[Violation] = []
    if detected == "other":
        violations.append(Violation(kind="unsupported_language", span=_span(language_prose), rule_id="language"))
    # Clauses first: the scan exempts only booking or callback cards that passed; refusals follow the prose's.
    cards, refused = await check_clauses(ctx, session_row, desk_id, desk, draft.clauses, language, canaries)
    violations += scan_prose(draft.prose, canaries, await desk_names(ctx, desk_id),
                             booking_card=any(card.template == "booking_confirmed" for card in cards),
                             callback_card=any(card.template == "callback_confirmed" for card in cards))
    violations += refused
    usage = None
    handoff_backed = False                  # the soft-promise check was shown an open handoff's card
    if not violations and prose.strip():
        backing = list(cards)
        if not any(card.template == "handoff" for card in cards) and await open_handoff_ids(ctx, session_row,
                                                                                             cards_only=True):
            backing.append(handoff(language, desk))    # the owner has the conversation: the card says so, unshown
            handoff_backed = True
        found, usage = await soft_promises(ctx, language, prose, backing)
        violations += found
    if violations:
        blocks = [handoff(language, desk)]
    else:
        blocks = ([RenderedBlock(kind="prose", text=prose)] if prose.strip() else []) + cards
    return await finalize(ctx, session_row, blocks=blocks, violations=violations, language=language,
                          author="claude", fact_ids=fact_ids, soft_promise=usage, seen=True,
                          detected=detected if detected in ("en", "es") else None, canaries=canaries,
                          handoff_backed=handoff_backed, final=final)


async def soft_promises(ctx: KernelCtx, language: render.Language, prose: str,
                        cards: Sequence[RenderedBlock]) -> tuple[list[Violation], CallUsage | None]:
    """Step 5: the soft-promise check on prose the scan passed and the cards that back it (those
    rendered for it, and an open handoff's card). A `soft_promise` violation per flag set
    (`soft.promise`, `soft.denies_ai`), or `soft.unavailable` when there is no verdict, each
    spanning the prose's start; and the call's usage, for the ledger. (`finalize` adds
    `soft.handoff_closed` when the open handoff's card it passed on is gone by its end.)"""
    verdict, usage = await ctx.decisions.soft_promise(
        SoftPromiseInput(language=language, prose=prose, cards=[card.text for card in cards]))
    if verdict is None:
        rule_ids = ["soft.unavailable"]
    else:
        rule_ids = (["soft.promise"] if verdict.promises_beyond_cards else []) + (
            ["soft.denies_ai"] if verdict.denies_being_ai else [])
    return [Violation(kind="soft_promise", span=_span(prose), rule_id=rule_id) for rule_id in rule_ids], usage


def sign_verdict(signer: desk_kernel.Signer, *, session_id: str, generation: int, message_id: str,
                 blocks: Sequence[RenderedBlock], visitor_plain: str, ledger_seq: int) -> str:
    """The master's `ReplyVerdict.signature`: Ed25519 over `b"desk-verdict-v1\\0"` + sha256 of
    `canonical_json({session_id, generation, message_id, blocks_sha256, visitor_plain, ledger_seq})`,
    `blocks_sha256` being the hex sha256 of the blocks' canonical JSON."""
    blocks_json = desk_kernel.canonical_json(json.dumps([block.model_dump(mode="json") for block in blocks]))
    body = {"session_id": session_id, "generation": generation, "message_id": message_id,
            "blocks_sha256": hashlib.sha256(blocks_json.encode()).hexdigest(), "visitor_plain": visitor_plain,
            "ledger_seq": ledger_seq}
    digest = hashlib.sha256(desk_kernel.canonical_json(json.dumps(body)).encode()).digest()
    return signer.sign(VERDICT_DOMAIN, digest)


async def finalize(ctx: KernelCtx, session_row: SessionRow, *, blocks: Sequence[RenderedBlock],
                   violations: Sequence[Violation], language: render.Language, author: str,
                   fact_ids: Sequence[str] = (), soft_promise: CallUsage | None = None, seen: bool = False,
                   detected: render.Language | None = None, visitor_plain_key: str | None = None,
                   message_id: str | None = None, canaries: Mapping[str, str] = NO_CANARIES,
                   handoff_backed: bool = False, final: bool = True) -> ReplyVerdict:
    """Step 7's record, in the caller's transaction: the `reply` ledger entry
    `{message_id, author, ok, language, violations, rule_ids, fact_ids, soft_promise, final}`, the reply
    receipt and the signature, at the session's generation as the request read it. `ok` is no
    violations. The receipt is the status line `visitor_plain_key`, or without one `reply_checked`
    when ok and `reply_handed_off` otherwise. The owner's say ends here too, with its own receipts
    and the message ID its fact is named after (`message_id`; a new one otherwise). A cited fact ID
    holding one of `canaries` is ledgered only as a marker of its hash (`ledger.withheld_ref`).

    With `seen` (a draft the session's own call sent), the session row is written first: seen
    now (`last_seen_at`) and, when its prose was English or Spanish, `detected` kept as its
    `last_language`. It is the request's first write to the row, so the request holds no lock on
    it while the soft-promise check runs and a take-over doesn't wait for the model; it comes
    before the ledger head, as the lock order says (`repo.py`). A take-over that commits while
    the check runs keeps its mode and generation (only these two columns are written), and the
    verdict carries the generation the draft was checked at, which `deliver()` then drops.

    With `handoff_backed` (the soft-promise check passed the prose shown an open handoff's card,
    which it read without a lock while the model ran), a passing verdict stands only if the
    session still has an open handoff of kind `card`, which `handoff_still_open` then holds `FOR
    SHARE` until the verdict commits, so the owner can't mark it done before the reply is on
    record. If the owner marked it done meanwhile, or a call-back request made it a call-back's,
    nothing backs the card's words any longer: the verdict fails as the
    check would have failed it without the card, with a `soft_promise` violation
    (`soft.handoff_closed`) and the handoff card in the prose's place, which then opens a new
    handoff.

    When the verdict of Claude's draft shows the handoff card and the visitor will see it, the
    session's owner handoff is opened next, before the ledger head (`open_card_handoff`), and
    ledgered just before the verdict: a reply that passed citing the handoff clause always; a
    blocked draft when it is `final`, or when one of its violations is outside the kinds a rewrite
    can fix (`desk.rewrites.REWRITABLE`), since the API then hands off at once. A first attempt
    (`final` false) blocked only for rewritable kinds is never shown, since the API asks Claude
    for a rewrite, so it opens none, and its verdict, still signed and ledgered, carries no blocks:
    the kernel never signs a showable handoff card that no handoff backs, and the API's rewrite
    reads only the violations. An owner's message never opens one, and neither does the
    owner's own preview of the Desk (`preview`; the owner's decision of 2026-10-31)."""
    if seen:
        session_row.last_seen_at = ctx.clock.now()
        if detected is not None:
            session_row.last_language = detected
        await ctx.db.flush()
    if handoff_backed and not violations and not await handoff_still_open(ctx, session_row):
        prose = next((block.text for block in blocks if block.kind == "prose"), "")
        violations = [Violation(kind="soft_promise", span=_span(prose), rule_id=HANDOFF_CLOSED)]
        blocks = [handoff(language, await _desk_info(ctx, session_row.desk_id))]
    shown = not violations or final or any(violation.kind not in REWRITABLE for violation in violations)
    if author == "claude" and not shown:
        blocks = []                    # the API rewrites it: no handoff card is signed that no handoff backs
    if author == "claude" and shown and not session_row.preview and any(block.template == "handoff"
                                                                        for block in blocks):
        await open_card_handoff(ctx, session_row)
    ok = not violations
    message_id = message_id if message_id is not None else new_id("msg")
    summary = {"message_id": message_id, "author": author, "ok": ok, "language": language,
               "violations": [violation.kind for violation in violations],
               "rule_ids": [violation.rule_id for violation in violations],
               "fact_ids": [ledger.withheld_ref(fact_id) if labels.find_canaries(fact_id, canaries)
                            else ledger.safe_ref(fact_id) for fact_id in fact_ids],
               "soft_promise": soft_promise.model_dump(mode="json") if soft_promise is not None else None,
               "final": final}
    entry = await ledger.append(ctx, copy_id=session_row.copy_id, desk_id=session_row.desk_id, event=LedgerEvent(
        kind="reply", origin="kernel", session_id=session_row.session_id, ref_id=message_id, summary=summary))
    owner = (await _desk_info(ctx, session_row.desk_id)).owner_display_name
    if visitor_plain_key is None:
        visitor_plain_key = "reply_checked" if ok else "reply_handed_off"
    visitor_plain = render.status(visitor_plain_key, language, owner=owner)
    signature = sign_verdict(ctx.signer, session_id=session_row.session_id, generation=session_row.generation,
                             message_id=message_id, blocks=blocks, visitor_plain=visitor_plain, ledger_seq=entry.seq)
    return ReplyVerdict(ok=ok, language=language, blocks=list(blocks), violations=list(violations),
                        message_id=message_id, generation=session_row.generation, visitor_plain=visitor_plain,
                        ledger_seq=entry.seq, signature=signature)


# ---- The handoff the card opens -------------------------------------------------------------------

# Owner-only text from kernel templates, in the owner's language (English, as the owner's previews are):
# no visitor text, no prose of Claude's, no contact.
CARD_REASON = "The Desk handed this to you."
A_VISITOR = "A visitor"


def card_alert(who: str) -> str:
    """The owner's alert for a handoff the card opened: who is waiting, and nothing of what was said."""
    return f"{who} is waiting in a conversation the Desk handed to you."


async def open_handoff_ids(ctx: KernelCtx, session_row: SessionRow, *, lock: bool = False,
                           cards_only: bool = False) -> list[str]:
    """The IDs of the session's open handoffs, of either kind, or with `cards_only` only those the
    handoff card opened: read without a lock, or with `lock` held `FOR SHARE` (step 10 of the lock
    order), so the owner can't mark one done until the caller's transaction ends."""
    stmt = select(Handoff.handoff_id).where(Handoff.desk_id == session_row.desk_id,
                                           Handoff.session_id == session_row.session_id, Handoff.status == "open")
    if cards_only:
        stmt = stmt.where(Handoff.kind == "card")
    if lock:
        stmt = stmt.order_by(Handoff.handoff_id).with_for_update(read=True)
    return list(await ctx.db.scalars(ctx.repo.scoped(stmt)))


async def _lock_session(ctx: KernelCtx, session_row: SessionRow):
    """Step 1 of the lock order: the session row `FOR NO KEY UPDATE`, the mode `finalize`'s write
    takes, read as columns (its generation, kind, assurance and person), so the row the request
    read keeps the generation the verdict is signed at."""
    return (await ctx.db.execute(ctx.repo.scoped(
        select(SessionRow.generation, SessionRow.kind, SessionRow.assurance, SessionRow.person_id).where(
            SessionRow.session_id == session_row.session_id).with_for_update(key_share=True)))).one()


async def handoff_still_open(ctx: KernelCtx, session_row: SessionRow) -> bool:
    """Whether the session still has an open handoff the handoff card opened, in the lock order:
    the session row, then those open handoffs `FOR SHARE`, held until the caller's transaction
    ends, so none of them is marked done, or made a call-back's, before what leans on it is on
    record."""
    await _lock_session(ctx, session_row)
    return bool(await open_handoff_ids(ctx, session_row, lock=True, cards_only=True))


async def _awaiting_holds(ctx: KernelCtx, session_row: SessionRow) -> list[str]:
    """The IDs of the session's held decisions the owner hasn't answered and that haven't expired,
    read without a lock (a read waits for nothing, so it keeps the lock order)."""
    return list(await ctx.db.scalars(ctx.repo.scoped(select(DecisionRow.decision_id).where(
        DecisionRow.session_id == session_row.session_id, DecisionRow.state == "held",
        DecisionRow.expires_at > ctx.clock.now()))))


async def awaits_the_owner(ctx: KernelCtx, session_row: SessionRow) -> bool:
    """Whether the session has a held request awaiting the owner: one neither answered, cancelled
    nor past its expiry, which a read would expire. A read that fails counts as none, in a savepoint
    of its own, so the transaction goes on: skipping the handoff only spares the owner a second
    alert, so not knowing fails toward telling the owner."""
    try:
        async with ctx.db.begin_nested():
            return bool(await _awaiting_holds(ctx, session_row))
    except SQLAlchemyError as error:
        log_error(logger, error, "held_decisions_unread")
        return False


async def _waiting(ctx: KernelCtx, kind: str, assurance: str, person_id: str | None) -> str:
    """Who is waiting, as the owner's records name them: a verified person's display name, else
    "A visitor" (an agent's key has no name of its own)."""
    if not verified(kind, assurance, person_id):
        return A_VISITOR
    name = (await ctx.db.execute(ctx.repo.scoped(select(Person.display_name).where(
        Person.person_id == person_id, Person.removed_at.is_(None))))).scalar_one_or_none()
    return name or A_VISITOR


async def open_card_handoff(ctx: KernelCtx, session_row: SessionRow) -> str | None:
    """The owner's handoff for a verdict that shows the handoff card ("Let me check with Maria
    Rivera. Maria Rivera will reply here."), in the verdict's transaction, so the card's promise
    has something behind it (the owner's decision of 2026-10-30). Returns its ID, or None when it
    opens none.

    In the lock order: the session row first (`FOR NO KEY UPDATE`, the mode `finalize`'s write
    takes, read as columns, so the row the request read keeps the generation the verdict is signed
    at), then the session's open handoffs `FOR SHARE`, then the ledger head. Two checks of one
    session, a call-back's execution (which holds the session row `FOR UPDATE`) and the owner's
    mark of done (which holds the handoff `FOR UPDATE`) each come wholly before or after it.

    It opens none when a take-over or hand-back has moved the session to another generation since
    the request read it (`deliver()` drops the verdict, so the visitor never sees the card); while
    the session has a held request awaiting the owner, whose alert and item the owner already has
    for the conversation (`awaits_the_owner`, the owner's decision of 2026-10-31), so the owner sees
    one item and gets one alert; or when the session already has an open handoff of either kind (an
    earlier card, or a call-back request): one at a time, so a conversation of blocked drafts alerts
    the owner once. Otherwise
    it inserts one of kind `card`: open, no call-back window and no fact (it promises no call
    back), the kernel's reason (`CARD_REASON`), and as `action_id` its own ID, which no action's
    can equal; alerts the owner (`handoff`, under the Desk's notification preferences, with no
    decision) with who is waiting (`card_alert`); and ledgers `desk_data` `{part: "handoffs",
    refs: [handoff_id], kind: "card"}` on the session, the entry the owner's mark of done writes
    too. The owner marks it done with `POST /handoffs/{id}/done`, after which the next card opens
    a new one; a session closing changes nothing of it."""
    current = await _lock_session(ctx, session_row)
    if current.generation != session_row.generation:
        return None
    if await awaits_the_owner(ctx, session_row):
        return None
    if await open_handoff_ids(ctx, session_row, lock=True):
        return None
    copy_id, desk_id, session_id = session_row.copy_id, session_row.desk_id, session_row.session_id
    handoff_id = new_id("handoff")
    ctx.db.add(Handoff(handoff_id=handoff_id, copy_id=copy_id, desk_id=desk_id, session_id=session_id,
                       reason=CARD_REASON, callback_window=None, status="open", kind="card", action_id=handoff_id,
                       window_start=None, window_end=None, created_at=ctx.clock.now()))
    await ctx.db.flush()
    who = await _waiting(ctx, current.kind, current.assurance, current.person_id)
    await demo_inbox.alert_owner(ctx, desk_id, "handoff", render.owner_preview("handoff"), card_alert(who))
    await ledger.append(ctx, copy_id=copy_id, desk_id=desk_id, event=LedgerEvent(
        kind="desk_data", origin="kernel", session_id=session_id,
        summary={"part": "handoffs", "refs": [handoff_id], "kind": "card"}))
    return handoff_id


# ---- The owner's messages -------------------------------------------------------------------------

OWNER_TEXT_CHARS = 2000


async def owner_message(ctx: KernelCtx, owner: OwnerCtx, session_row: SessionRow,
                        req: OwnerMessageRequest) -> OwnerMessageResult:
    """The owner's message in a conversation the route has checked (`POST /owner/messages`): a
    visitor's or agent's session of the owner's copy, open, on a Desk not deleted, in any mode. The
    text holds 1 to 2000 characters and something to show, else 422 `invalid`.

    A `say` is shown to the visitor as the owner typed it, in one `owner_said` card: only the
    characters no font draws are left out (`_drawn`), so an ellipsis, a fraction or a ligature
    stays as typed. Every check reads it as Claude's prose is read (`shown`, which also applies
    NFKC): the blank check above and the canaries of the Desk's documents. Those are all a say is
    checked for; the number rule is for Claude's prose, and no model reads the owner's words.
    Clean, the words become the `owner_statement` fact `owner:<message_id>` (one text claim, read by the
    owner and this session; only the kernel's `owner_said` card renders it, so it backs no
    price), and `finalize` ledgers and signs the verdict with the `owner_said` receipt, in the
    session's last language. With a canary, even split by spaces, in another case or width,
    accented or in lookalike letters (`labels.find_canaries`, on the text as checked and as
    shown), there is no fact and no card: `ok: false`, one `canary` violation naming the
    documents, and the `owner_say_blocked` receipt, which the API shows the owner and never
    delivers.

    A `whisper` is a note for Claude, which the API adds to its context as untrusted text. The
    kernel ledgers it (`whisper` `{message_id, chars}`, never the text) and keeps nothing else."""
    if session_row.copy_id != owner.copy_id or session_row.kind == "owner":
        raise ValueError("the owner writes only in the conversations of its own copy")
    if len(req.text) > OWNER_TEXT_CHARS:                # measured before any of it is normalized
        raise KernelFailure(422, "invalid", "owner_message_text")
    text = shown(req.text)
    if not text.strip():
        raise KernelFailure(422, "invalid", "owner_message_text")
    copy_id, desk_id, session_id = session_row.copy_id, session_row.desk_id, session_row.session_id
    message_id = new_id("msg")
    if req.kind == "whisper":
        entry = await ledger.append(ctx, copy_id=copy_id, desk_id=desk_id, event=LedgerEvent(
            kind="whisper", origin="kernel", session_id=session_id, ref_id=message_id,
            summary={"message_id": message_id, "chars": len(req.text)}))
        return OwnerMessageResult(message_id=message_id, verdict=None, ledger_seq=entry.seq)
    language = render.language(session_row.last_language)
    typed, canaries = _drawn(req.text), await labels.copy_canaries(ctx)
    held = {*labels.find_canaries(text, canaries), *labels.find_canaries(typed, canaries)}
    found = [document_id for document_id in canaries if document_id in held]
    if found:
        verdict = await finalize(ctx, session_row, blocks=[], language=language, author="owner",
                                 violations=[canary_violation(found)],
                                 visitor_plain_key="owner_say_blocked", message_id=message_id)
        return OwnerMessageResult(message_id=message_id, verdict=verdict, ledger_seq=verdict.ledger_seq)
    # the owner saying something in the conversation is the owner handling it: the card's handoff closes
    closing = await sessions.close_card_handoffs(ctx, session_row)
    fact = Fact(fact_id=f"owner:{message_id}", kind="owner_statement", status="available", source="owner",
                claims=[Claim(key="text", kind="text", value=typed)],
                label=Label(readers=["owner", f"session:{session_id}"]))
    ctx.db.add(labels.fact_row(copy_id, desk_id, fact, ctx.clock.now(), session_id=session_id))
    block = render.render_clause(Clause(template="owner_said", fact_id=fact.fact_id), fact, language,
                                 await _desk_info(ctx, desk_id))
    verdict = await finalize(ctx, session_row, blocks=[block], violations=[], language=language, author="owner",
                             fact_ids=[fact.fact_id], visitor_plain_key="owner_said", message_id=message_id)
    await sessions.ledger_card_handoffs_closed(ctx, session_row, closing, "owner_message")
    return OwnerMessageResult(message_id=message_id, verdict=verdict, ledger_seq=verdict.ledger_seq)


# ---- Route ----------------------------------------------------------------------------------------

router = APIRouter()


@router.post("/check_reply", response_model=ReplyVerdict)
async def post_check_reply(body: CheckReplyRequest, ctx: Ctx, request: Request) -> ReplyVerdict:
    """A visitor or agent session's draft, once the session-state rows pass: its own token (an
    agent's signature), open, at its generation, on a Desk not deleted, and not taken over by the
    owner (409 `mode_owner`); each refusal is ledgered. An agent's check counts against its turn,
    which a passing verdict, an immediate handoff or the turn's second check ends
    (`agents.end_turn`), in the verdict's transaction."""
    draft = body.draft
    # seen at the end (`finalize`), so the session row isn't locked while the model reads the draft
    row = await auth.require_session(ctx, request, draft.session_id, generation=draft.generation, seen=False)
    await auth.require_desk(ctx, request, row, row.desk_id)
    if row.mode == "owner":
        raise AuthError(409, "mode_owner", "mode_owner", route=route_template(request),
                        named=Named(copy_id=row.copy_id, desk_id=row.desk_id, session_id=row.session_id))
    verdict = await check_draft(ctx, row, draft, final=body.final)
    if row.kind == "agent":            # a turn ends at a blocked check only when the API said it was final
        await agents.end_turn(ctx, request, verdict, final=body.final and "final" in body.model_fields_set)
    return verdict
