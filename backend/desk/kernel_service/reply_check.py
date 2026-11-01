"""The reply check (`POST /check_reply`): nothing Claude drafts reaches a visitor unchecked.

A draft is prose plus clauses. `check_draft` runs the plan's steps after the route has answered
the session-state rows ("Session state responses": token, copy, closed, generation, mode `owner`):

1. A paused session (the breaker) gets only the handoff clause and a `session_paused` violation;
   nothing is scanned.
2. Language: `lang.detect` on the prose. Positive evidence of another language is
   `unsupported_language`; four or more unmarked words are `uncertain_language`, one checked
   rewrite. Both use the session's language, else English, as does too little to tell. Cards
   render in this language. The session's language is set at turn start from the visitor's latest
   message (`POST /sessions/{session_id}/turn`, `turn.py`), and kept or changed at the end by the
   language of Claude's prose (step 7); neither unmarked nor unsupported prose changes it. It
   decides only the language a reply whose prose can't be told renders in: the code's checks find
   the same in a draft whichever language the session reads, since both lexicons always run; the
   soft-promise check is told that language, with the cards rendered in it.
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
   pass; their refusals follow the scan's. The shown prose followed by free-text charter policy
   cards is also scanned in reply order, separated by newlines, using the public-text rules.
   Unsafe policy clauses are refused as `unknown_fact` / `policy_combined`, naming the facts
   contributing to the match. Structured cards stay outside this public-text scan.
5. The soft-promise check, only when steps 2 to 4 found nothing and there is prose: Sonnet 5.5
   reads the prose and the cards, each as its kind's label and its text (`render.check_text`,
   "Payment link card: ..."; never the visitor's words), and flags a promise the cards
   don't hold (`soft.promise`) or prose that says or suggests the writer is a human
   (`soft.denies_ai`). One try within `SOFT_PROMISE_TIMEOUT_S` (8 s), with no recheck and no
   fallback (the owner's decision of 2026-10-31), inside the API's 12 s for the route: no
   verdict (a timeout, an error, a refusal, an unparsable answer) is `check_unavailable`
   (`soft.unavailable`), which gets one rewrite like the other prose kinds (the owner's ruling
   of 2026-11-01); the final check makes its own try. While the session has an open handoff the
   handoff card opened
   (`open_handoff_ids`, kind `card`), the card's text is one of those cards, though the reply
   doesn't show it again: the owner has the conversation, so a later "Maria Rivera will reply
   here" is backed, as the card that opened it said. A call-back request backs nothing (the
   owner's decision of 2026-10-31): its own card names a time and never says the owner will
   reply here, and once its window has passed nothing promises a call. That handoff is read
   without a session or handoff lock; an agent request holds its nonce row `FOR UPDATE`, and
   each check one pooled connection, across the try. A reply that passes with the handoff's
   card is checked again in step 7. When configured, TypeSafe Jev evaluates the same prose, labelled
   cards and fixed next steps concurrently, within three seconds of Sonnet's eight-second window.
   Its top score at or above 0.95 adds `soft.jev`; its failure leaves Sonnet's verdict standing.
   No key means no Jev call. Both verdicts are ledgered; Jev scores are decimal strings, not
   ledger floats.
6. `ok` when nothing was found: the prose (when not empty) and the cards. A prose-only failure
   keeps checked cards without the prose, then the handoff clause if Claude drafted one, which
   opens the owner's handoff as the handoff card does. With no card at all, it asks the visitor
   before involving the owner when the session's tools offer a call back and it has no open
   handoff (`call_back_offered`): the kernel's call-back offer alone, as prose, which opens
   nothing (the owner's decision of 2026-11-01). A drafted handoff is honoured, and a checker
   outage hands off. Any other failure, or no card to keep and no call back to offer, shows only
   the handoff clause. A first attempt the API rewrites (`final` false, every violation one a rewrite
   can fix) has no blocks and is never shown.
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

import asyncio
import hashlib
import json
import logging
import re
import unicodedata
from bisect import bisect_left, bisect_right
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

import desk_kernel
from fastapi import APIRouter, Request
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError

from desk.public_amenity import offers_amenity
from desk.public_person import future_person_direction
from desk.public_contact import valid_public_contact
from desk.contracts import (Claim, Clause, Fact, Label, LedgerEvent, OwnerMessageResult, RenderedBlock, ReplyDraft,
                            ReplyVerdict, ToolProfile, Violation)
from desk.db.models import Booking, Business, CalendarSlot, Desk, Handoff, LedgerHead, Person
from desk.db.models import Decision as DecisionRow
from desk.db.models import Fact as FactRow
from desk.kernel_api import CheckReplyRequest, OwnerMessageRequest
from desk.kernel_service import agents, auth, context, demo_inbox, jev, labels, lang, ledger, render, sessions
from desk.kernel_service.auth import AuthError, Named, OwnerCtx, SessionRow
from desk.kernel_service.decisions import CallUsage, SoftPromiseInput
from desk.kernel_service.render.cards import DeskInfo, slot_claims
from desk.kernel_service.repo import Ctx, KernelCtx, KernelFailure, log_error, new_id, route_template, storable
from desk.kernel_service.sessions import principal_for, verified
from desk.next_steps import NEXT_STEPS, next_steps
from desk.rewrites import PROSE_ONLY, REWRITABLE

VERDICT_DOMAIN = b"desk-verdict-v1\0"
SPAN_CHARS = 40
PUBLIC_POLICY_MAX_COUNT = 40
PUBLIC_POLICY_MAX_CHARS = 8_000
FREE_WORDS = frozenset({"free", "gratis", "gratuito", "gratuita", "gratuitos", "gratuitas"})
KERNEL_ONLY = frozenset({"owner_said", "payment_confirmed", "link_cancelled"})   # only the kernel issues these
NUMBER_SEPARATORS = frozenset(".,:'’ ")                        # inside one number: "1.234,56", "10:30"
NO_CANARIES = labels.NO_CANARIES
logger = logging.getLogger(__name__)
HANDOFF_CLOSED = "soft.handoff_closed"   # a reply passed on an open handoff's card, and the handoff was done by the end
CALL_BACK_STEP = NEXT_STEPS["native.request_callback"]   # the next step a session offered a call back has

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
          acute: bool = False, keep_accents: bool = False) -> tuple[str, list[int]]:
    """`text` for the lexicons: accents and other combining marks dropped, each letter that looks
    like an ASCII one read as it ("Tuеsday" with a Cyrillic е is Tuesday), each of `strokes` (by
    default the bare strokes) read as `stroke`, each dash and hyphen as "-", each apostrophe as
    "’", and each run of whitespace one space, but with `acute`, a whitespace character before a
    combining acute (how NFKC writes ´) as "’"; and the index in `text` each folded character
    came from. `keep_accents` preserves marks for accent-sensitive policy entries."""
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
            if keep_accents or unicodedata.category(part) not in ("Mn", "Me"):
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


def _load_policy_phrases(filename: str) -> dict[bool, list[re.Pattern[str]]]:
    """Policy-only terms; accented entries preserve marks in both pattern and reading."""
    path = LEXICON_DIR / filename
    entries: dict[bool, list[re.Pattern[str]]] = {False: [], True: []}
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip() or line.startswith("#"):
            continue
        reading, tab, pattern = line.partition("\t")
        if not tab or reading not in ("folded", "accented") or not pattern.strip():
            raise ValueError(f"{path.name}:{number} is not a <reading>\\t<regex> line")
        keep_accents = reading == "accented"
        folded, _ = _fold(pattern, keep_accents=keep_accents)
        entries[keep_accents].append(re.compile(rf"(?<!\w)(?:{folded})(?!\w)", re.IGNORECASE))
    return entries


POLICY_PHRASES = {
    "language": _load_policy_phrases("other_promises.txt"),
    "policy.ai_denial": _load_policy_phrases("policy_ai_denial.txt"),
    "policy.free_price": _load_policy_phrases("policy_free_price.txt"),
}


def _policy_phrase_spans(text: str) -> set[tuple[int, int, str]]:
    """Whole policy-only phrases with their rule IDs, independent of the language detector."""
    spans = set()
    readings = {keep: _readings(text, keep_accents=keep) for keep in (False, True)}
    for rule, entries in POLICY_PHRASES.items():
        for keep_accents, patterns in entries.items():
            for reading, origin in readings[keep_accents].items():
                for pattern in patterns:
                    for match in pattern.finditer(reading):
                        start = origin[match.start()]
                        if rule == "policy.ai_denial" and future_person_direction(text, start):
                            continue
                        spans.add((start, origin[match.end() - 1] + 1, rule))
    return spans


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


def _real_spelling(text: str) -> tuple[str, list[int]]:
    """`text` read across case, width and accents, with each dash and apostrophe read as the
    lexicons read them (`_plain`) and each run of whitespace as one space, but no lookalike letter
    read as another (as `_allowed_public_hit` reads a word); and the index in `text` each character
    came from."""
    chars: list[str] = []
    origin: list[int] = []
    for index, char in enumerate(text):
        if char.isspace():
            if not chars or chars[-1] != " ":
                chars.append(" ")
                origin.append(index)
            continue
        for part in unicodedata.normalize("NFKD", "’" if char == "'" else _plain(char)):
            if unicodedata.category(part) not in ("Mn", "Me"):
                folded = part.casefold()
                chars.append(folded)
                origin += [index] * len(folded)
    return "".join(chars), origin


def _free_name_reach(text: str, names: Iterable[str]) -> list[int] | None:
    """`_named_reach` for the names of a Desk's enabled business tools, each found in `text` as
    `_real_spelling` reads both; None when no name is there. A name made only of free words is
    never looked for: it would be every free word (the owner's decision of 2026-10-31)."""
    keys = [key for key, _ in (_real_spelling(shown(name).strip()) for name in names)
            if not all(word in FREE_WORDS for word in re.findall(r"\w+", key))]
    if not keys:
        return None
    folded, origin = _real_spelling(text)
    reach = [0] * (len(text) + 1)
    for name in keys:
        start = folded.find(name)
        while start != -1:
            if start == 0 or not folded[start - 1].isalnum():   # a repeat starts at a word's start
                low, high = origin[start], origin[start + len(name) - 1] + 1
                reach[low] = max(reach[low], high)
            start = folded.find(name, start + 1)
    if not any(reach):
        return None
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


def _readings(text: str, *, keep_accents: bool = False) -> dict[str, list[int]]:
    """The readings of `text` the lexicons take (`_fold`), each with the
    index in `text` each of its characters came from: a bare stroke as l, as I, and an ASCII
    capital I as l too ("doIIars"); where NFKC wrote an acute accent as a space and a combining
    acute, each also with that pair read as "’" ("o´clock") besides the space it is drawn on
    ("no´charge")."""
    variants: list[dict] = [{}, {"stroke": "i"}, {"strokes": STROKES_AND_I}]
    if SPACED_ACUTE.search(text):
        variants += [variant | {"acute": True} for variant in variants]
    return dict(_fold(text, keep_accents=keep_accents, **variant) for variant in variants)


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


@dataclass(frozen=True)
class _Lookahead:
    """A matched expression and its original reading, retained only for right-context checks."""

    reading: str
    origin: Sequence[int]
    pattern: re.Pattern[str]
    start: int
    end: int

    def holds_at(self, boundary: int) -> bool:
        # Match only this expression at its known start; never rescan a growing full prefix.
        match = self.pattern.match(self.reading, self.start, bisect_left(self.origin, boundary))
        return match is not None and match.end() == self.end


RightContext = dict[tuple[int, int, str], list[_Lookahead]]


def _claim_spans(pattern: re.Pattern[str], reading: str) -> Iterable[tuple[int, int, re.Match[str]]]:
    """A lexicon's claim spans, each with its whole match. An optional `claim` group distinguishes a
    claim from lexical context consumed by another alternative, such as a Spanish call's subject and verb."""
    group = "claim" if "claim" in pattern.groupindex else 0
    for match in pattern.finditer(reading):
        start, end = match.span(group)
        if end > start:
            yield start, end, match


def _booking_claims(text: str, readings: dict[str, list[int]],
                    right_context: RightContext | None = None) -> list[tuple[int, int, str, Violation]]:
    """A `promise_word` (`lex.<lang>.booking` or `lex.<lang>.callback`) for each claim in any reading, but
    for one with a condition straight before it (`_conditioned`: "once you're booked") or inside
    such a claim in the same category and reading ("cuando tu cita está confirmada" holds
    "está confirmada"). Containment is reduced within each category; booking and callback
    matches never suppress each other."""
    found: set[tuple[int, int, str]] = set()
    for reading, origin in readings.items():
        reach: dict[str, int] = {}  # conditioned reach within each category
        claims = ((start, end, rule_id, pattern, match) for rule_id, pattern in (*BOOKING_LINES, *CALLBACK_LINES)
                  for start, end, match in _claim_spans(pattern, reading))
        for start, end, rule_id, pattern, match in sorted(claims, key=lambda claim: claim[:3]):
            category = rule_id.rsplit(".", 1)[1]
            if _conditioned(text, reading, origin, start):
                reach[category] = max(reach.get(category, -1), end)
            if reach.get(category, -1) < end:
                hit = (origin[start], origin[end - 1] + 1, rule_id)
                found.add(hit)
                if right_context is not None and "(?=" in pattern.pattern:
                    right_context.setdefault(hit, []).append(
                        _Lookahead(reading, origin, pattern, match.start(), match.end()))
    hits: list[tuple[int, int, str, Violation]] = []
    reaches: dict[str, int] = {}
    previous: dict[str, tuple[int, int]] = {}
    for start, end, rule_id in sorted(found, key=lambda claim: (claim[0], -claim[1], claim[2])):
        category = rule_id.rsplit(".", 1)[1]
        prior = previous.get(category)
        if prior is not None and prior != (start, end):
            reaches[category] = max(reaches.get(category, -1), prior[1])
        previous[category] = (start, end)
        if reaches.get(category, -1) < end:
            hits.append((start, end, rule_id, Violation(kind="promise_word", span=_span(text[start:end]),
                                                        rule_id=rule_id)))
    return hits


def canary_violation(document_ids: Sequence[str]) -> Violation:
    """Text from private documents: the facts of the documents whose canaries it held, never the
    canary."""
    return Violation(kind="canary", span="document text", fact_ids=[f"document:{document_id}" for document_id
                                                                    in document_ids], rule_id="labels.canary")


def scan_prose(text: str, canaries: Mapping[str, str] = NO_CANARIES, names: Iterable[str] = (), *,
               booking_card: bool = False, callback_card: bool = False,
               approved_free_names: Iterable[str] = ()) -> list[Violation]:
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
    category before either exemption. A free word (`FREE_WORDS`, spelled as it is, across case,
    width and accents, but no lookalike letters) passes as a promise word only inside a repeat of one
    of `approved_free_names` (the titles and appointment types of the Desk's enabled business tools,
    the owner's decision of 2026-10-31), read the same way, and when its expression needs no text
    past that repeat ("free to all"); a name of free words alone backs none. A word mixing
    Latin letters with another script is `unsupported_language` (`mixed_script`), unless it lies
    inside one of `names` (the Desk's own names) as it is written there; the canaries of
    `canaries` (document ID → canary), even split or disguised, are one `canary` violation naming
    their documents, and blanked out before the rest is scanned. Links and email addresses are
    none of these (the owner's decision of 2026-10-30: Claude may write them, and its prompt keeps
    them to the business's own). The lexicons read lookalike letters as the Latin ones, a bare
    stroke both as l and as I, an ASCII capital I as l too, every dash and hyphen as "-" and every
    apostrophe as "’", an acute accent (a space and a combining acute after NFKC) both as that
    space and as "’". The canary comes first, then the rest in the order they appear."""
    return [violation for _, _, _, violation in _prose_hits(text, canaries, names, booking_card=booking_card,
                                                            callback_card=callback_card,
                                                            approved_free_names=approved_free_names)]


def _prose_hits(text: str, canaries: Mapping[str, str] = NO_CANARIES, names: Iterable[str] = (), *,
                booking_card: bool = False, callback_card: bool = False,
                right_context: RightContext | None = None,
                approved_free_names: Iterable[str] = ()) -> list[tuple[int, int, str, Violation]]:
    """The prose scan with full match offsets in `shown(text)`, before display spans are truncated."""
    text, found = _blank_canaries(shown(text), canaries)
    hits: list[tuple[int, int, str, Violation]] = [(-1, -1, "canary", canary_violation(found))] if found else []
    i = 0
    while i < len(text):
        category = unicodedata.category(text[i])
        if text[i] in PERCENT_SIGNS:
            hits.append((i, i + 1, "percent_sign", Violation(kind="number_in_prose", span=text[i],
                                                            rule_id="percent_sign")))
        elif text[i] == KEYCAP_TEN:
            hits.append((i, i + 1, "digit", Violation(kind="number_in_prose", span=text[i], rule_id="digit")))
        if _numeral(text[i]) or text[i] in ZERO_OR_ONE:
            end = _number_end(text, i)          # no currency or percent sign inside, so passed over once
            if any(_numeral(ch) for ch in text[i:end]) or (_alone(text, i, end) and not text[i:end].isascii()):
                hits.append((i, end, "digit", Violation(kind="number_in_prose", span=_span(text[i:end]),
                                                        rule_id="digit")))
            i = end
            continue
        if category == "Sc":
            hits.append((i, i + 1, "currency", Violation(kind="number_in_prose", span=text[i], rule_id="currency")))
        i += 1
    reach = _named_reach(text, names)
    hits += [(start, start + len(word), "mixed_script", Violation(kind="unsupported_language", span=_span(word),
                                                                rule_id="mixed_script"))
             for start, word in _words(text) if _mixes_scripts(word) and reach[start] < start + len(word)]
    readings = _readings(text)
    free_reach = _free_name_reach(text, approved_free_names)
    hits += [hit for hit in _booking_claims(text, readings, right_context)
             if not (booking_card and hit[2].endswith(".booking")
                     or callback_card and hit[2].endswith(".callback"))]
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
                if (free_reach is not None and free_reach[start] >= end
                        and _allowed_public_hit(text, start, end, rule_id, FREE_WORDS)
                        and ("(?=" not in pattern.pattern or _Lookahead(
                            reading, origin, pattern, match.start(), match.end()).holds_at(free_reach[start]))):
                    continue
                # Expressions with the same consumed span can require different right
                # context. Preserve every dependency before deduplicating display hits.
                if right_context is not None and "(?=" in pattern.pattern:
                    right_context.setdefault((start, end, rule_id), []).append(
                        _Lookahead(reading, origin, pattern, match.start(), match.end()))
                if (rule_id, start, end) in seen:
                    continue
                seen.add((rule_id, start, end))
                hits.append((start, end, rule_id, Violation(kind=CATEGORIES[category], span=_span(text[start:end]),
                                                           rule_id=rule_id)))
    return sorted(hits, key=lambda hit: (hit[0], hit[2]))


def _allowed_public_hit(text: str, start: int, end: int, rule: str, allow_words: frozenset[str]) -> bool:
    """A promise hit in public text passes only as a real word the owner allowed for this key, read across
    case, width and accents without substituting lookalikes, or as an English or Spanish free-price
    phrase offering an amenity (`offers_amenity`): "Free parking." passes, "Free estimates." and
    "Consultations are complimentary." don't. `text` is the key's own text."""
    word = "".join(char for char in unicodedata.normalize("NFKD", text[start:end])
                   if unicodedata.category(char) not in ("Mn", "Me")).casefold()
    promise = rule.startswith("lex.") and rule.endswith(".promise")
    return ((promise and word in allow_words)
            or ((promise or rule == "policy.free_price") and offers_amenity(text, start, end)))


# The service area's allowance (the owner's ruling: distances, number words, years and day words).
# Each pattern reads the policy's own text from a hit's end, so a unit can't come from another card.
_BLANK = r"[\s\-‐‑]"
_DISTANCE_UNIT = r"(?:miles?|mi|kms?|kilomet(?:er|re)s?|kil[oó]metros?|millas?)\b"
_CARDINAL = (r"(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve"
             r"|(?:thir|four|fif|six|seven|eigh|nine)teen|(?:twen|thir|for|four|fif|six|seven|eigh|nine)ty"
             r"|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince"
             r"|dieci(?:s[eé]is|siete|ocho|nueve)|veinte|veinti\w+"
             r"|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa)")
_DAYS_A_WEEK = rf"(?:days?{_BLANK}+a{_BLANK}+week|d[ií]as?{_BLANK}+a{_BLANK}+la{_BLANK}+semana)\b"
# After a number: a distance unit, singular or plural, with a hyphen or blanks between ("25 miles",
# "a 30-mile radius", "1 kilómetro", "50-km"), maybe after a range to a second number ("20-30 miles",
# "20 to 30 miles", "20 a 30 km", "20 hasta 30 km"); or "days a week" ("7 días a la semana").
SERVICE_AREA_AFTER_DIGITS = re.compile(
    rf"(?:(?:{_BLANK}*[-–—]{_BLANK}*|{_BLANK}+(?:to|a|hasta){_BLANK}+)[0-9]+(?:[.,][0-9]+)*)?"
    rf"{_BLANK}*{_DISTANCE_UNIT}|{_BLANK}+{_DAYS_A_WEEK}", re.IGNORECASE)
SERVICE_AREA_YEAR_PREFIX = re.compile(r"\b(?:since|in|from|est\.|established|founded|desde|en)\s+$", re.IGNORECASE)
SERVICE_AREA_YEAR = re.compile(r"(?:19|20)[0-9]{2}")
SERVICE_AREA_CARDINAL = re.compile(_CARDINAL, re.IGNORECASE)
# Half or a hundred is a distance only right before its unit ("half a mile", "a hundred miles").
SERVICE_AREA_HALF_OR_HUNDRED = re.compile(rf"half|(?:one{_BLANK}+)?hundred|cien", re.IGNORECASE)
SERVICE_AREA_BEFORE_UNIT = re.compile(rf"{_BLANK}+(?:an?{_BLANK}+)?{_DISTANCE_UNIT}", re.IGNORECASE)
SERVICE_AREA_UNIT_WORDS = re.compile(r"miles|millas", re.IGNORECASE)   # the Spanish lexicon's "miles" (thousands)
# Weekdays, weekends and the parts of the day, but no date, time or time window.
SERVICE_AREA_DAY_WORDS = re.compile(
    r"(?:mon|tues|wednes|thurs|fri|satur|sun)days?|weekends?"
    rf"|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bados?|domingos?|fin(?:es)?{_BLANK}+de{_BLANK}+semana"
    r"|mornings|afternoons|evenings|nights|ma[nñ]anas|tardes|noches", re.IGNORECASE)
SERVICE_AREA_MORNING = re.compile(r"\b(?:por|en|de)\s+la\s+$", re.IGNORECASE)

# ZIP ranges keep both five-digit endpoints under the same postal marker.
SERVICE_AREA_POSTAL_PREFIX = re.compile(
    r"\b(?:(?i:zip(?:\s+codes?)?|c[oó]digo\s+postal)|(?:AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|"
    r"LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY))"
    r"\s+(?:[0-9]{5}\s*[-–—]\s*)?$")
SERVICE_AREA_ROAD_PREFIX = re.compile(r"\b(?:I-\s*|(?:Highway|Hwy)\s+)$", re.IGNORECASE)
SERVICE_AREA_ALWAYS = re.compile(r"\b24/7\b")
SERVICE_AREA_PREFIX_REACH = 40   # a year, ZIP or road marker sits right before its number: read only that far back


def _service_area_prefix(pattern: re.Pattern[str], text: str, start: int) -> bool:
    return pattern.search(text, max(0, start - SERVICE_AREA_PREFIX_REACH), start) is not None


def _allowed_service_area_hit(key: str | None, text: str, start: int, end: int, rule: str) -> bool:
    """Allow only the service area's numeric, geographic and day-part shapes, within its own text.

    Digits need a distance unit (possibly after a range), "days a week", an explicit year marker,
    a ZIP or road prefix, or literal "24/7". Cardinal words pass anywhere; half or a hundred needs
    a distance unit. Weekdays, weekends and day parts pass, with singular mañana needing morning
    context. A fee written in words ("trip fee: fifty") passes: a known limit. Other amounts,
    fractions, dates and time windows retain their ordinary refusals."""
    if key not in {"policy:service_area", "charter:policy:service_area"}:
        return False
    hit = text[start:end]
    if rule == "digit":
        return ((SERVICE_AREA_YEAR.fullmatch(hit) is not None
                 and _service_area_prefix(SERVICE_AREA_YEAR_PREFIX, text, start))
                or SERVICE_AREA_AFTER_DIGITS.match(text, end) is not None
                or (re.fullmatch(r"[0-9]{5}", hit) is not None
                    and _service_area_prefix(SERVICE_AREA_POSTAL_PREFIX, text, start))
                or (hit.isascii() and hit.isdigit() and _service_area_prefix(SERVICE_AREA_ROAD_PREFIX, text, start))
                or any(match.start() <= start and end <= match.end()
                       for match in SERVICE_AREA_ALWAYS.finditer(text, max(0, start - 4), end + 4)))
    if rule in ("lex.en.number", "lex.es.number"):
        return (SERVICE_AREA_UNIT_WORDS.fullmatch(hit) is not None or SERVICE_AREA_CARDINAL.fullmatch(hit) is not None
                or (SERVICE_AREA_HALF_OR_HUNDRED.fullmatch(hit) is not None
                    and SERVICE_AREA_BEFORE_UNIT.match(text, end) is not None))
    if rule in ("lex.en.date", "lex.es.date"):
        return (SERVICE_AREA_DAY_WORDS.fullmatch(hit) is not None
                or (hit.casefold() in {"mañana", "manana"}
                    and _service_area_prefix(SERVICE_AREA_MORNING, text, start)))
    return False


def scan_public_text(text: str, allow_words: frozenset[str] = frozenset(), *,
                     policy_key: str | None = None) -> list[str]:
    """Rule IDs for public text: the prose scan with no canaries, names or booking card.

    Both prose lexicons run, whatever the text's language. Policy-only phrases also refuse
    AI denials, implied free prices and selected other-language commitments. Positive language
    evidence is refused; undetermined text keeps passing.
    Format controls are refused because
    policy cards render the original text, whereas the prose scan reads normalized text.
    Pure: no reads or writes, and no matched text returned to callers that record a refusal.
    """
    normalized = shown(text)
    rules = {rule for start, end, rule, _ in _prose_hits(normalized)
             if not _allowed_public_hit(normalized, start, end, rule, allow_words)
             and not _allowed_service_area_hit(policy_key, normalized, start, end, rule)}
    rules.update(rule for start, end, rule in _policy_phrase_spans(normalized)
                 if not _allowed_public_hit(normalized, start, end, rule, allow_words))
    if lang.positive_other_language(normalized):
        rules.add("language")
    if any(unicodedata.category(char) == "Cf" for char in text):
        rules.add("format_control")
    return sorted(rules)


def scan_public_policies(values: Mapping[str, str],
                         allow_words: Mapping[str, frozenset[str]] = {}) -> dict[str, list[str]]:
    """Scan policies individually and as adjacent paragraphs/cards, separated by a newline.

    Keys sort like their `charter:<key>` fact IDs on the public page (C collation). Offsets
    refer to normalized pieces, so Unicode expansion cannot shift a hit onto another key.
    Keep full match ranges for attribution, even when a violation's display span is truncated.
    Only contributing keys and rule IDs leave the scan. Allowed words apply to one key only;
    matches or their required right context crossing a key boundary remain refused.
    """
    return _scan_public_parts(sorted(values.items()), allow_words)


def _scan_public_parts(values: Sequence[tuple[str | None, str]],
                       allow_words: Mapping[str, frozenset[str]] = {}) -> dict[str, list[str]]:
    """The public-text rules in the supplied rendering order, attributed to policy IDs.

    A None key is reply prose: it supplies context, but its own refusals stay with the
    existing prose checks. Newline boundaries keep separate cards from joining word fragments.
    """
    fields: dict[str, set[str]] = {}
    for key, value in values:
        if key is not None:
            fields.setdefault(key, set()).update(scan_public_text(
                value, allow_words.get(key, frozenset()), policy_key=key))
    ranges: list[tuple[str | None, int, int]] = []
    pieces: list[str] = []
    offset = 0
    for key, value in values:
        text = shown(value)
        pieces.append(text)
        ranges.append((key, offset, offset + len(text)))
        offset += len(text) + 1
    combined = "\n".join(pieces)
    if lang.positive_other_language(combined):
        for key, low, high in ranges:
            if key is not None and low < high:
                fields[key].add("language")
    # Attribute lexical commitments only to intersecting policies. A term wholly inside
    # reply prose stays with the existing prose rules, even beside a harmless policy card.
    for start, end, rule in _policy_phrase_spans(combined):
        if any(key is not None and low <= start and end <= high
               and _allowed_public_hit(combined[low:high], start - low, end - low, rule,
                                       allow_words.get(key, frozenset()))
               for key, low, high in ranges):
            continue
        for key, low, high in ranges:
            if key is not None and low < high and low < end and start < high:
                fields[key].add(rule)
    right_context: RightContext = {}
    hits = _prose_hits(combined, right_context=right_context)
    boundaries = [high for _, _, high in ranges]
    starts = [low for _, low, _ in ranges]
    for start, end, rule, _ in hits:
        match_end = end
        # Ordinary matches already carry their full range from the single combined scan.
        # Only a positive lookahead may depend on text beyond that range ("libres" /
        # "para todos"). Find the first card boundary preserving every expression's
        # dependency, so an allowance cannot hide a longer cross-key dependency.
        if (start, end, rule) in right_context:
            for boundary in boundaries[bisect_left(boundaries, end):]:
                if all(match.holds_at(boundary) for match in right_context[start, end, rule]):
                    end = boundary
                    break
        contributors = ranges[bisect_right(boundaries, start):bisect_left(starts, end)]
        if any(key is not None and low <= start and end <= high
               and (_allowed_public_hit(combined[low:high], start - low, match_end - low, rule,
                                        allow_words.get(key, frozenset()))
                    or _allowed_service_area_hit(key, combined[low:high], start - low, match_end - low, rule))
               for key, low, high in contributors):
            continue
        for key, low, high in contributors:
            if key is not None and low < high:
                fields[key].add(rule)
    return {key: sorted(rules) for key, rules in sorted(fields.items()) if rules}


def policy_card_rules(prose: str, cards: Sequence[RenderedBlock]) -> dict[str, list[str]]:
    """The policy cards that fail the public-text scan in the order a reply would show them
    after `prose`, by fact ID in that order, each with its rule IDs and never its text.

    Only free-text charter policies join the prose; structured cards legitimately carry numbers.
    """
    policies = [(card.fact_id, card.text) for card in cards
                if card.template == "policy" and card.fact_id is not None
                and card.fact_id.startswith("charter:policy:")]
    if not policies:
        return {}
    refused = _scan_public_parts([(None, prose), *policies])
    return {fact_id: refused[fact_id] for fact_id in dict.fromkeys(fact_id for fact_id, _ in policies)
            if fact_id in refused}


def policy_card_violations(prose: str, cards: Sequence[RenderedBlock]) -> list[Violation]:
    """Refuse unsafe policy text in the order a reply would show it, before signing: one
    `policy_combined` violation naming the contributing fact IDs in reply order (`policy_card_rules`)."""
    fact_ids = list(policy_card_rules(prose, cards))
    if not fact_ids:
        return []
    return [Violation(kind="unknown_fact", span="policy", rule_id="policy_combined", fact_ids=fact_ids)]


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
                        canaries: Mapping[str, str]) -> tuple[list[RenderedBlock], list[Violation], dict[str, list[Claim]]]:
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
    rendered_claims: dict[str, list[Claim]] = {}
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
            # Preserve the source claims before slot filtering and before any locked ORM refresh.
            rendered_claims[fact.fact_id] = [claim.model_copy(deep=True) for claim in fact.claims]
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
        if template.name == "contact" and not valid_public_contact(block.text):
            violations.append(_clause_violation(clause, "unknown_fact", "contact_format"))
            continue
        blocks.append(block)
    return blocks, violations, rendered_claims


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


def call_back_offer(language: render.Language) -> RenderedBlock:
    """The call-back offer: "Would you like me to arrange a callback?" in the reply's language, as
    prose the kernel writes (the API's signed `STATUS_LINES["offer_callback"]`)."""
    return RenderedBlock(kind="prose", text=render.status("offer_callback", language))


async def session_tools(ctx: KernelCtx, session_row: SessionRow) -> list[ToolProfile]:
    """The session's resolved tools (`context.resolved_tools`), which both the soft-promise check's
    fixed next steps and the call-back offer read."""
    desk_row = (await ctx.db.scalars(ctx.repo.scoped(select(Desk).where(
        Desk.desk_id == session_row.desk_id)))).one()
    return await context.resolved_tools(ctx, principal_for(session_row), session_row, desk_row)


def offer_fits(cards: Sequence[RenderedBlock], violations: Sequence[Violation]) -> bool:
    """Whether a blocked draft may show the call-back offer: every violation is a failure of
    Claude's own words (`PROSE_ONLY`) other than a checker outage (`check_unavailable`, which hands
    off), and it has no card at all: no checked card to keep, and no handoff clause Claude drafted,
    which is honoured as the handoff card."""
    return (bool(violations) and all(violation.kind in PROSE_ONLY and violation.kind != "check_unavailable"
                                     for violation in violations)
            and not any(card.kind == "card" for card in cards))


async def offers_call_back(ctx: KernelCtx, session_row: SessionRow) -> bool:
    """Whether the session may be asked about a call back: it has no open handoff of either kind
    (a card's or a call-back request's: the owner already has the conversation, so it sees the
    handoff card, which opens nothing new), and its resolved tools offer one (`desk.next_steps`:
    `native.request_callback`, or a business tool of block `urgent`)."""
    if await open_handoff_ids(ctx, session_row):
        return False
    return CALL_BACK_STEP in next_steps(await session_tools(ctx, session_row))


async def call_back_offered(ctx: KernelCtx, session_row: SessionRow, cards: Sequence[RenderedBlock],
                            violations: Sequence[Violation], *, final: bool) -> bool:
    """Whether a blocked draft shows the call-back offer: it will be shown (`final`: a prose-only
    block is one a rewrite can fix, so a first attempt never is), the offer fits it (`offer_fits`),
    and the session may be asked (`offers_call_back`). The session's handoffs and tools are read
    only when the rest holds."""
    return final and offer_fits(cards, violations) and await offers_call_back(ctx, session_row)


def blocked_blocks(cards: Sequence[RenderedBlock], violations: Sequence[Violation],
                   language: render.Language, desk: DeskInfo, *, call_back: bool) -> list[RenderedBlock]:
    """Keep checked cards for prose-only failures, without the prose, and after them the handoff
    clause when Claude drafted one (the owner's ruling of 2026-11-01), rendered by the kernel in the
    reply's language; `finalize` then opens the owner's handoff for it as for any shown handoff
    card. A prose-only failure with no card at all asks the visitor before involving the owner
    when the session may be asked (`call_back`, from `call_back_offered`; the owner's decision of
    2026-11-01): the kernel's call-back offer alone (`call_back_offer`), in place of the handoff
    clause, so no owner handoff opens. A drafted handoff, a session with an open handoff, a
    checker outage and every other failure, or no card to keep and no call back to offer, show
    the handoff clause alone."""
    if violations and all(violation.kind in PROSE_ONLY for violation in violations):
        kept = [card for card in cards if card.kind == "card" and card.template != "handoff"]
        if kept:
            drafted = any(card.kind == "card" and card.template == "handoff" for card in cards)
            return kept + ([handoff(language, desk)] if drafted else [])
        if call_back and offer_fits(cards, violations):
            return [call_back_offer(language)]
    return [handoff(language, desk)]


async def recheck_cards(ctx: KernelCtx, session_row: SessionRow,
                        blocks: Sequence[RenderedBlock], *,
                        rendered_claims: Mapping[str, list[Claim]]) -> tuple[list[RenderedBlock], list[Violation]]:
    """Re-read card entitlements and currency after holding the session row, before signing.

    The explicit lock also covers a repeated check whose frozen last-seen value caused no UPDATE.
    Open handoffs are held before facts, including for a possible last-card fallback. Fact rows
    are refreshed FOR SHARE in fact ID order, rather than using earlier ORM identity-map values:
    a withdrawal either commits first or waits until this verdict's transaction commits.
    No model call runs under this lock; the draft's generation remains unchanged for its signature.
    """
    cards = [block for block in blocks if block.kind == "card" and block.fact_id is not None]
    if not cards:
        return list(blocks), []
    current = await _lock_session(ctx, session_row)
    await open_handoff_ids(ctx, session_row, lock=True)
    rows = {row.fact_id: row for row in await ctx.db.scalars(ctx.repo.scoped(select(FactRow).where(
        FactRow.desk_id == session_row.desk_id, FactRow.fact_id.in_([card.fact_id for card in cards]))
        .order_by(FactRow.fact_id).with_for_update(read=True).execution_options(populate_existing=True)))}
    # Every Desk already has a head. Take the final lock before checking expiry too: waiting for
    # the reply's append must not let a card age out between its currency check and signing.
    (await ctx.db.execute(ctx.repo.scoped(select(LedgerHead.desk_id).where(
        LedgerHead.desk_id == session_row.desk_id).with_for_update()))).scalar_one()
    readers, now = labels.session_readers(current), ctx.clock.now()
    kept, refused = [], []
    for block in blocks:
        if block not in cards:
            kept.append(block)
            continue
        clause = Clause(template=block.template, fact_id=block.fact_id)
        row = rows.get(block.fact_id)
        if current.closed_at is not None or (row is not None and not labels.can_read(row.readers, readers)):
            refused.append(_clause_violation(clause, "unentitled_fact", "not_a_reader"))
        elif row is None:
            refused.append(_clause_violation(clause, "unknown_fact", "no_such_fact"))
        elif not render.TEMPLATES[block.template].current(labels.fact_of(row), now):
            refused.append(_clause_violation(clause, "stale_fact", "not_current"))
        elif row.claims != rendered_claims.get(block.fact_id):
            refused.append(_clause_violation(clause, "stale_fact", "claims_changed"))
        else:
            kept.append(block)
    return kept, refused


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
    if detected in ("other", "unmarked"):
        violations.append(Violation(
            kind="uncertain_language" if detected == "unmarked" else "unsupported_language",
            span=_span(language_prose), rule_id="language_uncertain" if detected == "unmarked" else "language"))
    # Clauses first: the scan exempts only booking or callback cards that passed; refusals follow the prose's.
    cards, refused, rendered_claims = await check_clauses(
        ctx, session_row, desk_id, desk, draft.clauses, language, canaries)
    violations += scan_prose(draft.prose, canaries, await desk_names(ctx, desk_id),
                             booking_card=any(card.template == "booking_confirmed" for card in cards),
                             callback_card=any(card.template == "callback_confirmed" for card in cards))
    violations += refused
    violations += policy_card_violations(prose, cards)
    detected_language = detected if detected in ("en", "es") else None
    if any(violation.kind == "unsupported_language" for violation in violations):
        # The scan can reject mixed-script prose even when ordinary markers detected English.
        language, detected_language = fallback, None
    usage = None
    soft_checks = None
    handoff_backed = False                  # the soft-promise check was shown an open handoff's card
    if not violations and prose.strip():
        backing = list(cards)
        if not any(card.template == "handoff" for card in cards) and await open_handoff_ids(ctx, session_row,
                                                                                             cards_only=True):
            backing.append(handoff(language, desk))    # the owner has the conversation: the card says so, unshown
            handoff_backed = True
        found, usage, soft_checks = await soft_promises(ctx, session_row, language, prose, backing)
        violations += found
    if violations:
        blocks = blocked_blocks(cards, violations, language, desk, call_back=await call_back_offered(
            ctx, session_row, cards, violations, final=final))
    else:
        blocks = ([RenderedBlock(kind="prose", text=prose)] if prose.strip() else []) + cards
    return await finalize(ctx, session_row, blocks=blocks, violations=violations, language=language,
                          author="claude", fact_ids=fact_ids, soft_promise=usage, soft_checks=soft_checks, seen=True,
                          detected=detected_language, canaries=canaries,
                          handoff_backed=handoff_backed, final=final, rendered_claims=rendered_claims)


async def soft_promises(ctx: KernelCtx, session_row: SessionRow, language: render.Language, prose: str,
                        cards: Sequence[RenderedBlock]) -> tuple[list[Violation], CallUsage | None, dict]:
    """Step 5: the soft-promise check on prose the scan passed and the cards that back it (those
    rendered for it, and an open handoff's card), each shown to Sonnet and Jev alike as its kind's
    label and its text (`render.check_text`), with the session's fixed next steps from its
    resolved tools. One Sonnet try within `decisions.SOFT_PROMISE_TIMEOUT_S`, with no recheck and
    no fallback (the owner's decision of 2026-10-31). A `soft_promise` violation per flag set
    (`soft.promise`, `soft.denies_ai`), each spanning the prose's start; no verdict (a timeout, an
    error, a refusal, an unparsable answer) is `check_unavailable` (`soft.unavailable`). Optional
    Jev runs beside it, bounded on its own, and adds `soft.jev` (a `soft_promise`), also spanning
    the prose's start. Returns the violations, Sonnet's usage and both verdicts for the ledger.
    (`finalize` adds
    `soft.handoff_closed` when the open handoff's card it passed on is gone by its end.)"""
    tools = await session_tools(ctx, session_row)
    data = SoftPromiseInput(language=language, prose=prose, cards=[render.check_text(card) for card in cards],
                            next_steps=next_steps(tools))
    if ctx.settings.typesafe_api_key:
        # Reveal waits for both: Jev has an independent three-second bound, Sonnet six.
        (verdict, usage), jev_result = await asyncio.gather(
            ctx.decisions.soft_promise(data),
            jev.evaluate(data.prose, data.cards, data.next_steps, api_key=ctx.settings.typesafe_api_key))
    else:
        verdict, usage = await ctx.decisions.soft_promise(data)
        jev_result = jev.Result(status="off")
    if verdict is None:
        violations = [Violation(kind="check_unavailable", span=_span(prose), rule_id="soft.unavailable")]
    else:
        rule_ids = (["soft.promise"] if verdict.promises_beyond_cards else []) + (
            ["soft.denies_ai"] if verdict.denies_being_ai else [])
        violations = [Violation(kind="soft_promise", span=_span(prose), rule_id=rule_id) for rule_id in rule_ids]
    record = {"sonnet": {"flags": verdict.model_dump(mode="json") if verdict is not None else None,
                         "blocked": bool(violations)}, "jev": jev_result.ledger_summary()}
    if jev_result.blocked:
        violations.append(Violation(kind="soft_promise", span=_span(prose), rule_id="soft.jev"))
    return violations, usage, record


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
                   fact_ids: Sequence[str] = (), soft_promise: CallUsage | None = None,
                   soft_checks: dict | None = None, seen: bool = False,
                   detected: render.Language | None = None, visitor_plain_key: str | None = None,
                   message_id: str | None = None, canaries: Mapping[str, str] = NO_CANARIES,
                   handoff_backed: bool = False, final: bool = True,
                   rendered_claims: Mapping[str, list[Claim]] | None = None) -> ReplyVerdict:
    """Step 7's record, in the caller's transaction: the `reply` ledger entry
    `{message_id, author, ok, language, violations, rule_ids, fact_ids, soft_promise, soft_checks, dropped,
    final}`, the reply receipt and the signature, at the session's generation as the request read it.
    `dropped` names each card refused at signing (`{fact_id, rule_id}`, never text), so a card a
    prose-blocked draft lost is still accounted for. `ok` is no violations. The receipt is the
    status line `visitor_plain_key`, or for a shown reply `reply_handed_off` exactly when its blocks
    include the handoff clause (template `handoff`), otherwise `reply_checked`, so checked cards
    kept alone after a prose-only failure, and the call-back offer, carry the reply receipt. A
    blocked first attempt with no shown blocks keeps `reply_handed_off`. The owner's say ends here
    too, with its own receipts and the message ID its fact is named after (`message_id`; a new one
    otherwise). A cited fact ID holding one of `canaries` is ledgered only as a marker of its hash
    (`ledger.withheld_ref`).

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
    (`soft.handoff_closed`). The shared blocked-block helper keeps checked cards, and a drafted
    handoff after them; with no card at all it shows the call-back offer when the session may be
    asked (`call_back_offered`), and otherwise substitutes the handoff card, which may open a new
    handoff.

    Cards on passing and blocked drafts are rechecked under the session lock before signing:
    closed_at, person and assurance are read afresh, then all cited facts' readers, status and
    expiry and claims in one ordered FOR SHARE query, held through the signature and commit. Claims
    must match the snapshot used to render the cards, including facts replaced in place. Open handoffs
    are locked before facts so a last-card refusal can fall back without reversing the lock order.
    Currency is checked after taking the ledger head too, so expiry is current after every lock
    wait. A blocked draft drops cards that no longer pass. A passing draft whose backing card
    was withdrawn fails with that clause's refusal, so none of its prose is shown.

    When the verdict of Claude's draft shows the handoff card and the visitor will see it, the
    session's owner handoff is opened next (`open_card_handoff`) and ledgered just before the
    verdict, reusing any locks the card recheck already holds: a reply that passed citing the
    handoff clause always; a blocked draft when it is `final`, or when one of its violations is
    outside the kinds a rewrite can fix (`desk.rewrites.REWRITABLE`), since the API then hands off
    at once. A first attempt
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
        blocks = blocked_blocks(blocks, violations, language, await _desk_info(ctx, session_row.desk_id),
                                call_back=await call_back_offered(ctx, session_row, blocks, violations, final=final))
    dropped: list[Violation] = []      # cards refused at signing, whether or not the prose had passed
    if author == "claude":
        blocks, refused = await recheck_cards(ctx, session_row, blocks, rendered_claims=rendered_claims or {})
        dropped = refused
        if refused:
            # A passing draft may have relied on a card just withdrawn: none of its prose is safe
            # to keep. Already-blocked prose keeps only the cards that still pass, in draft order.
            if not violations:
                violations = refused
            blocks = blocked_blocks(blocks, violations, language, await _desk_info(ctx, session_row.desk_id),
                                    call_back=await call_back_offered(ctx, session_row, blocks, violations,
                                                                      final=final))
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
               "fact_ids": [_ref(fact_id, canaries) for fact_id in fact_ids],
               "soft_promise": soft_promise.model_dump(mode="json") if soft_promise is not None else None,
               "soft_checks": soft_checks,
               "dropped": [{"fact_id": _ref(fact_id, canaries), "rule_id": violation.rule_id}
                           for violation in dropped for fact_id in violation.fact_ids],
               "final": final}
    entry = await ledger.append(ctx, copy_id=session_row.copy_id, desk_id=session_row.desk_id, event=LedgerEvent(
        kind="reply", origin="kernel", session_id=session_row.session_id, ref_id=message_id, summary=summary))
    owner = (await _desk_info(ctx, session_row.desk_id)).owner_display_name
    if visitor_plain_key is None:
        visitor_plain_key = ("reply_handed_off" if not shown or any(block.template == "handoff" for block in blocks)
                             else "reply_checked")
    visitor_plain = render.status(visitor_plain_key, language, owner=owner)
    signature = sign_verdict(ctx.signer, session_id=session_row.session_id, generation=session_row.generation,
                             message_id=message_id, blocks=blocks, visitor_plain=visitor_plain, ledger_seq=entry.seq)
    return ReplyVerdict(ok=ok, language=language, blocks=list(blocks), violations=list(violations),
                        message_id=message_id, generation=session_row.generation, visitor_plain=visitor_plain,
                        ledger_seq=entry.seq, signature=signature)



def _ref(fact_id: str, canaries: Mapping[str, str]) -> str:
    """A fact ID as a reply's ledger entry names it: one holding a canary only as its hash's marker."""
    return ledger.withheld_ref(fact_id) if labels.find_canaries(fact_id, canaries) else ledger.safe_ref(fact_id)

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
        select(SessionRow.session_id, SessionRow.generation, SessionRow.kind, SessionRow.assurance,
               SessionRow.person_id, SessionRow.closed_at).where(
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
    mark of done (which holds the handoff `FOR UPDATE`) each come wholly before or after it. A
    last-card fallback reuses these locks from `recheck_cards`; its new handoff has a fresh key.

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
    if row.kind == "agent":            # immediate kinds, an explicit final check, or the second check end the turn
        await agents.end_turn(ctx, request, verdict, final=body.final and "final" in body.model_fields_set)
    return verdict
