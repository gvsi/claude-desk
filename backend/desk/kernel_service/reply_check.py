"""The reply check (`POST /check_reply`): nothing Claude drafts reaches a visitor unchecked.

A draft is prose plus clauses. `check_draft` runs the plan's steps after the route has answered
the session-state rows ("Session state responses": token, copy, closed, generation, mode `owner`):

1. A paused session (the breaker) gets only the handoff clause and a `session_paused` violation;
   nothing is scanned.
2. Language: `lang.detect` on the prose. Another language is `unsupported_language`; too little to
   tell falls back to the session's last language, else English. Cards render in this language.
3. `scan_prose`: numerals, currency and percent signs, words mixing Latin letters with another
   script, both lexicons (`lexicon/en.txt` and `lexicon/es.txt`, whatever the language, with
   each letter that looks like a Latin one read as it, from `lexicon/lookalikes.txt`) and the
   Desk's document canaries.
4. Each clause renders from a fact this session may read, current, of the template's kind and ID,
   with no canary in what it renders.
5. The soft-promise check, only when steps 2 to 4 found nothing and there is prose: Haiku 5.5
   reads the prose and the cards' texts (never the visitor's words) and flags a promise the cards
   don't hold (`soft.promise`) or prose that says or suggests the writer is a human
   (`soft.denies_ai`). No verdict (a timeout, an error, a refusal, an unparsable answer) blocks
   too (`soft.unavailable`).
6. `ok` when nothing was found: the prose (when not empty) and the cards; otherwise only the
   handoff clause, in the reply's language.
7. `finalize`: the session keeps a detected language for its next reply and status lines, and
   the verdict is ledgered (`reply`) and signed in the same transaction.

What is shown is exactly what was checked: the prose block holds the prose as the scan read it
(`shown`: NFKC, without the characters no font draws, such as zero-width spaces, soft hyphens,
variation selectors and control characters, and with Hangul fillers as the blank they are drawn
as), so a number can't hide behind an invisible character and come back in the visitor's view.

Spans quote what a rule matched, at most 40 characters, and never a canary: canaries are blanked
out before anything else is scanned, and a canary violation's span is empty. The ledger holds
kinds, rule IDs and the cited fact IDs (through `ledger.safe_ref`), never prose.
"""

import hashlib
import json
import re
import unicodedata
from collections.abc import Iterable, Sequence
from pathlib import Path

import desk_kernel
from fastapi import APIRouter, Request
from sqlalchemy import select

from desk.contracts import Clause, Fact, LedgerEvent, RenderedBlock, ReplyDraft, ReplyVerdict, Violation
from desk.db.models import Booking, Business, CalendarSlot, Desk, Document
from desk.db.models import Fact as FactRow
from desk.kernel_api import CheckReplyRequest
from desk.kernel_service import auth, labels, lang, ledger, render
from desk.kernel_service.auth import AuthError, Named, SessionRow
from desk.kernel_service.decisions import CallUsage, SoftPromiseInput
from desk.kernel_service.render.cards import DeskInfo, slot_claims
from desk.kernel_service.repo import Ctx, KernelCtx, new_id, route_template

VERDICT_DOMAIN = b"desk-verdict-v1\0"
SPAN_CHARS = 40
KERNEL_ONLY = frozenset({"owner_said", "payment_confirmed"})   # only the kernel issues these clauses
NUMBER_SEPARATORS = frozenset(".,:'’ ")                        # inside one number: "1.234,56", "10:30"

# ---- Prose ----------------------------------------------------------------------------------------

LEXICON_DIR = Path(__file__).resolve().parent / "lexicon"
CATEGORIES = {"number": "number_in_prose", "money": "number_in_prose", "percent": "number_in_prose",
              "date": "number_in_prose", "promise": "promise_word"}


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


def _load_lookalikes() -> tuple[dict[str, str], dict[str, str]]:
    """`lexicon/lookalikes.txt` (made by `scripts/lookalikes.py` from Unicode's confusables.txt):
    the letters of other scripts, and the rarer Latin ones, that look like one ASCII letter, and
    the characters drawn as one ASCII digit, one `<code point>\\t<letter or digit>` per line: the
    letters and the digit lookalikes apart, each with what it looks like. A malformed line stops
    the kernel from starting."""
    path = LEXICON_DIR / "lookalikes.txt"
    letters, digits = {}, {}
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip() or line.startswith("#"):
            continue
        code, tab, rest = line.partition("\t")
        looks_like = rest.split("#", 1)[0].strip()
        if (not tab or not re.fullmatch(r"[0-9A-F]{4,6}", code) or int(code, 16) < 0x80
                or not re.fullmatch(r"[A-Za-z0-9]", looks_like)):
            raise ValueError(f"{path.name}:{number} is not a <code point>\\t<letter or digit> line")
        (digits if looks_like.isdigit() else letters)[chr(int(code, 16))] = looks_like
    return letters, digits


LOOKALIKES, DIGIT_LOOKALIKES = _load_lookalikes()
STROKES = frozenset(ch for ch, letter in LOOKALIKES.items() if letter == "l")   # drawn as a bare stroke: l or I
# Shaped like 0 or 1, the prototype of 0 being O and of 1 being l: read as digits next to a digit
# ("ЗОО"), or in a word made only of them that isn't plain ASCII ("ІОО"; "I" and "OK" stay words).
ZERO_OR_ONE = frozenset("OlI") | frozenset(ch for ch, letter in LOOKALIKES.items() if letter in ("O", "l"))
SCRIPT_LETTERS = frozenset(("Lu", "Ll", "Lt", "Lo"))     # modifier letters (Lm), such as ʼ, belong to no script


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


def _fold(text: str, stroke: str = "l") -> tuple[str, list[int]]:
    """`text` for the lexicons: accents and other combining marks dropped, each letter that looks
    like an ASCII one read as it ("Tuеsday" with a Cyrillic е is Tuesday), a bare stroke read as
    `stroke`, and each run of whitespace one space; and the index in `text` each folded character
    came from."""
    chars: list[str] = []
    origin: list[int] = []
    for i, ch in enumerate(text):
        if ch.isspace():
            if not chars or chars[-1] != " ":
                chars.append(" ")
                origin.append(i)
            continue
        for part in unicodedata.normalize("NFKD", ch):
            if unicodedata.category(part) not in ("Mn", "Me"):
                chars.append(stroke if part in STROKES else LOOKALIKES.get(part, part))
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


def _span(text: str) -> str:
    return text[:SPAN_CHARS]


def _blank_canaries(text: str, canaries: Iterable[str]) -> tuple[str, list[str]]:
    """`text` with every canary in it blanked out (same length), and the canaries found."""
    found = []
    for canary in canaries:
        if canary and canary in text:
            found.append(canary)
            text = text.replace(canary, " " * len(canary))
    return text, found


def scan_prose(text: str, canaries: Iterable[str] = ()) -> list[Violation]:
    """Every number, currency sign, lexicon word and canary in `text`, after `shown`: any Unicode
    numeral (`digit`, with the separators inside one number in the same span), currency sign
    (`currency`) or percent sign (`percent_sign`) and every match of both lexicons
    (`lex.<lang>.<category>`) is `number_in_prose`, or `promise_word` for the promise category; a
    word mixing Latin letters with another script is `unsupported_language` (`mixed_script`); a
    canary verbatim is `canary`. The lexicons read lookalike letters as the Latin ones, and a
    bare stroke both as l and as I. Canaries come first, then the rest in the order they appear."""
    text, found = _blank_canaries(shown(text), canaries)
    hits: list[tuple[int, str, Violation]] = [
        (-1, "canary", Violation(kind="canary", span="", rule_id="canary")) for _ in found]
    i = 0
    while i < len(text):
        category = unicodedata.category(text[i])
        if text[i] in PERCENT_SIGNS:
            hits.append((i, "percent_sign", Violation(kind="number_in_prose", span=text[i], rule_id="percent_sign")))
        elif text[i] == KEYCAP_TEN:
            hits.append((i, "digit", Violation(kind="number_in_prose", span=text[i], rule_id="digit")))
        if _numeral(text[i]) or text[i] in ZERO_OR_ONE:
            end = _number_end(text, i)
            if any(_numeral(ch) for ch in text[i:end]) or (_alone(text, i, end) and not text[i:end].isascii()):
                hits.append((i, "digit", Violation(kind="number_in_prose", span=_span(text[i:end]), rule_id="digit")))
                i = end
                continue
        if category == "Sc":
            hits.append((i, "currency", Violation(kind="number_in_prose", span=text[i], rule_id="currency")))
        i += 1
    hits += [(start, "mixed_script", Violation(kind="unsupported_language", span=_span(word), rule_id="mixed_script"))
             for start, word in _words(text) if _mixes_scripts(word)]
    folded, origin = _fold(text)
    readings = dict.fromkeys((folded, _fold(text, stroke="i")[0]))     # a bare stroke as l, and as I
    seen: set[tuple[str, int, int]] = set()
    for language, entries in LEXICONS.items():
        for category, pattern in entries:
            rule_id = f"lex.{language}.{category}"
            for match in (match for reading in readings for match in pattern.finditer(reading)):
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

def _storable(text: str) -> bool:
    """A fact ID the database could hold: valid UTF-8 without NUL. Any other can't name a fact."""
    try:
        text.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return "\0" not in text


def _clause_violation(clause: Clause, kind: str, rule_id: str) -> Violation:
    """A refused clause, naming its template and the fact ID it cited; an ID no text could hold
    (a NUL, a lone surrogate) names no fact, so the verdict can always be sent."""
    cited = clause.fact_id is not None and _storable(clause.fact_id)
    return Violation(kind=kind, span=clause.template, rule_id=rule_id, fact_ids=[clause.fact_id] if cited else [])


def carries(block: RenderedBlock, canaries: Sequence[str]) -> bool:
    """Whether any canary appears verbatim in what the block shows."""
    texts = [block.text, block.title or "", *block.lines, *(option.label for option in block.options)]
    return any(canary and canary in text for canary in canaries for text in texts)


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
                        canaries: Sequence[str]) -> tuple[list[RenderedBlock], list[Violation]]:
    """Step 4: each clause's card, or why it can't be shown. A clause must name a registered
    template Claude may draft (`template_unavailable`, `kernel_only_template`); a handoff or
    verify prompt names no fact; any other names a fact of this copy and Desk (`unknown_fact`)
    that the session may read (`unentitled_fact`; a session learns nothing more about a fact it
    can't read), of the template's kind and ID (`template_mismatch`), current (`stale_fact`), and
    with no canary in what it renders (`canary`)."""
    wanted = {clause.fact_id for clause in clauses if clause.fact_id is not None and _storable(clause.fact_id)}
    rows = {}
    if wanted:
        rows = {row.fact_id: row for row in await ctx.db.scalars(ctx.repo.scoped(select(FactRow).where(
            FactRow.desk_id == desk_id, FactRow.fact_id.in_(sorted(wanted)))))}
    readers = labels.session_readers(session_row)
    now = ctx.clock.now()
    blocks: list[RenderedBlock] = []
    violations: list[Violation] = []
    for clause in clauses:
        template = render.TEMPLATES.get(clause.template)
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
            if not labels.can_read(row.readers, readers):
                violations.append(_clause_violation(clause, "unentitled_fact", "not_a_reader"))
                continue
            fact = labels.fact_of(row)
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
            block = render.render_clause(clause, fact, language, desk)
        except render.NothingToShow:
            violations.append(_clause_violation(clause, "stale_fact", "nothing_to_show"))
            continue
        if carries(block, canaries):
            violations.append(_clause_violation(clause, "canary", "canary"))
            continue
        blocks.append(block)
    return blocks, violations


# ---- The verdict ----------------------------------------------------------------------------------

async def _desk_info(ctx: KernelCtx, desk_id: str) -> DeskInfo:
    business = (await ctx.db.scalars(ctx.repo.scoped(
        select(Business).join(Desk, Desk.business_id == Business.business_id).where(Desk.desk_id == desk_id)))).one()
    return DeskInfo(owner_display_name=business.owner_display_name, timezone=business.timezone)


async def desk_canaries(ctx: KernelCtx, desk_id: str) -> list[str]:
    """The canaries of the Desk's documents."""
    return list(await ctx.db.scalars(ctx.repo.scoped(
        select(Document.canary).where(Document.desk_id == desk_id).order_by(Document.document_id))))


def handoff(language: render.Language, desk: DeskInfo) -> RenderedBlock:
    """The handoff clause: "Let me check with Maria Rivera." in the reply's language."""
    return render.render_clause(Clause(template="handoff"), None, language, desk)


async def check_draft(ctx: KernelCtx, session_row: SessionRow, draft: ReplyDraft) -> ReplyVerdict:
    """Steps 1 to 7 for a draft from Claude in an authenticated session ("Reply check")."""
    desk_id = session_row.desk_id
    desk = await _desk_info(ctx, desk_id)
    fallback = render.language(session_row.last_language)
    fact_ids = [clause.fact_id for clause in draft.clauses if clause.fact_id is not None]
    if session_row.mode == "paused":
        return await finalize(ctx, session_row, blocks=[handoff(fallback, desk)], language=fallback, author="claude",
                              violations=[Violation(kind="session_paused", span="", rule_id="session_paused")],
                              fact_ids=fact_ids)
    canaries = await desk_canaries(ctx, desk_id)
    prose = shown(draft.prose)
    detected = lang.detect(prose)
    language: render.Language = detected if detected in ("en", "es") else fallback
    violations: list[Violation] = []
    if detected == "other":
        excerpt, _ = _blank_canaries(prose, canaries)
        violations.append(Violation(kind="unsupported_language", span=_span(excerpt), rule_id="language"))
    violations += scan_prose(draft.prose, canaries)
    cards, refused = await check_clauses(ctx, session_row, desk_id, desk, draft.clauses, language, canaries)
    violations += refused
    usage = None
    if not violations and prose.strip():
        found, usage = await soft_promises(ctx, language, prose, cards)
        violations += found
    if violations:
        blocks = [handoff(language, desk)]
    else:
        blocks = ([RenderedBlock(kind="prose", text=prose)] if prose.strip() else []) + cards
    if detected in ("en", "es"):
        session_row.last_language = detected
    return await finalize(ctx, session_row, blocks=blocks, violations=violations, language=language,
                          author="claude", fact_ids=fact_ids, soft_promise=usage)


async def soft_promises(ctx: KernelCtx, language: render.Language, prose: str,
                        cards: Sequence[RenderedBlock]) -> tuple[list[Violation], CallUsage | None]:
    """Step 5: the soft-promise check on prose the scan passed and the cards rendered for it. A
    `soft_promise` violation per flag set (`soft.promise`, `soft.denies_ai`), or `soft.unavailable`
    when there is no verdict, each spanning the prose's start; and the call's usage, for the
    ledger."""
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
                   fact_ids: Sequence[str] = (), soft_promise: CallUsage | None = None) -> ReplyVerdict:
    """Step 7's record, in the caller's transaction: the `reply` ledger entry
    `{message_id, author, ok, language, violations, rule_ids, fact_ids, soft_promise}`, the reply
    receipt and the signature, at the session's generation. `ok` is no violations. Plan 01b's
    owner say ends here too."""
    ok = not violations
    message_id = new_id("msg")
    summary = {"message_id": message_id, "author": author, "ok": ok, "language": language,
               "violations": [violation.kind for violation in violations],
               "rule_ids": [violation.rule_id for violation in violations],
               "fact_ids": [ledger.safe_ref(fact_id) for fact_id in fact_ids],
               "soft_promise": soft_promise.model_dump(mode="json") if soft_promise is not None else None}
    entry = await ledger.append(ctx, copy_id=session_row.copy_id, desk_id=session_row.desk_id, event=LedgerEvent(
        kind="reply", origin="kernel", session_id=session_row.session_id, ref_id=message_id, summary=summary))
    owner = (await _desk_info(ctx, session_row.desk_id)).owner_display_name
    visitor_plain = render.status("reply_checked" if ok else "reply_handed_off", language, owner=owner)
    signature = sign_verdict(ctx.signer, session_id=session_row.session_id, generation=session_row.generation,
                             message_id=message_id, blocks=blocks, visitor_plain=visitor_plain, ledger_seq=entry.seq)
    return ReplyVerdict(ok=ok, language=language, blocks=list(blocks), violations=list(violations),
                        message_id=message_id, generation=session_row.generation, visitor_plain=visitor_plain,
                        ledger_seq=entry.seq, signature=signature)


# ---- Route ----------------------------------------------------------------------------------------

router = APIRouter()


@router.post("/check_reply", response_model=ReplyVerdict)
async def post_check_reply(body: CheckReplyRequest, ctx: Ctx, request: Request) -> ReplyVerdict:
    """A visitor session's draft, once the session-state rows pass: its own token, open, at its
    generation, on a Desk not deleted, and not taken over by the owner (409 `mode_owner`); each
    refusal is ledgered `auth`."""
    draft = body.draft
    row = await auth.require_session(ctx, request, draft.session_id, generation=draft.generation)
    await auth.require_desk(ctx, request, row, row.desk_id)
    if row.mode == "owner":
        raise AuthError(409, "mode_owner", "mode_owner", route=route_template(request),
                        named=Named(copy_id=row.copy_id, desk_id=row.desk_id, session_id=row.session_id))
    return await check_draft(ctx, row, draft)
