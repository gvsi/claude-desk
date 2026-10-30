"""POST /check_reply and GET /public/{desk_slug}: what a visitor may be shown.

A draft from Claude is guarded prose plus typed clauses. The kernel scans the prose in English and
Spanish for numbers, money, percentages, dates and promise words, renders each clause from a fact
the session may read, in the reply's language, and answers with a signed, ledgered verdict: the
prose and cards when everything passed, else only the handoff clause.

Tests run on Rivera Plumbing copies as `POST /copies` seeds them (Friday 10:04 in Oakland), with
the facts made the way a conversation makes them: a quote, open times and a booking decided and
executed through `/decide` and `/execute`.
"""

import hashlib
import json
import sys
import time
import unicodedata

import desk_kernel
import httpx
import pytest
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from fastapi import FastAPI
from sqlalchemy import select

from desk.contracts import CardOption, Claim, Fact, Label, RenderedBlock, ReplyVerdict
from desk.db.models import ActorSession, Business, Desk, Document
from desk.db.models import Fact as FactRow
from desk.kernel_api import PublicDesk
from desk.kernel_service import labels, lang, ledger, reply_check
from desk.kernel_service.decisions import SoftPromiseVerdict
from scripts import lookalikes

from .fakes import FakeDecisions
from .helpers import kernel_ctx, ledger_rows, rows_of
from .test_adapters import Rivera, book, quote_args, visitor_of
from .test_approvals import answered
from .test_decide import PASS, Visitor, decided, open_visitor, set_mode, set_session
from .test_execute import executed

ROUTE = "POST /check_reply"


def clause(template: str, fact_id: str | None = None) -> dict:
    return {"template": template, "fact_id": fact_id}


async def post_check(client: httpx.AsyncClient, visitor: Visitor, prose: str, clauses=(), *, generation: int = 0,
                     headers: dict[str, str] | None = None) -> httpx.Response:
    return await client.post("/check_reply", headers=visitor.headers if headers is None else headers, json={
        "draft": {"session_id": visitor.session_id, "generation": generation, "prose": prose,
                  "clauses": list(clauses)}})


async def checked(client: httpx.AsyncClient, visitor: Visitor, prose: str, clauses=(), **kwargs) -> ReplyVerdict:
    response = await post_check(client, visitor, prose, clauses, **kwargs)
    assert response.status_code == 200, response.text
    return ReplyVerdict.model_validate(response.json())


async def own_quote(client: httpx.AsyncClient, visitor: Visitor, *items: tuple[str, int],
                    call_id: str = "call-quote") -> Fact:
    """The visitor's quote at list price (`rv-quote`), decided and executed: its fact."""
    decision = await decided(client, visitor, "native.quote", quote_args(*(items or (("drain", 1),))), call_id=call_id)
    assert decision.outcome == "allow", decision.reason_plain
    [fact] = (await executed(client, visitor, decision)).facts
    return fact


async def session_of(app: FastAPI, copy: Rivera, visitor: Visitor) -> ActorSession:
    [row] = await rows_of(app, copy.copy_id, select(ActorSession).where(ActorSession.session_id == visitor.session_id))
    return row


async def reply_entries(app: FastAPI, copy: Rivera) -> list:
    return [entry for entry in await ledger_rows(app, copy) if entry.event.kind == "reply"]


async def test_clean_prose_with_a_quote_card_passes(app, client):
    copy, visitor = await visitor_of(app, client)
    quote = await own_quote(client, visitor)
    verdict = await checked(client, visitor, "Here is your quote.", [clause("quote", quote.fact_id)])
    assert (verdict.ok, verdict.language, verdict.violations, verdict.generation) == (True, "en", [], 0)
    prose, card = verdict.blocks
    assert prose == RenderedBlock(kind="prose", text="Here is your quote.")
    assert (card.kind, card.template, card.fact_id, card.title) == ("card", "quote", quote.fact_id, "$180.00")
    assert card.lines == ["Drain clearing", "Good until Monday, November 2, 9:04 am"]   # 72 hours on, in Oakland
    assert verdict.visitor_plain == "Reply checked against Maria Rivera's rules"
    # the verdict is on the ledger, and the session reads on in the language it was written in
    [entry] = await reply_entries(app, copy)
    assert (entry.seq, entry.event.session_id, entry.event.ref_id) == (verdict.ledger_seq, visitor.session_id,
                                                                      verdict.message_id)
    assert entry.event.summary == {"message_id": verdict.message_id, "author": "claude", "ok": True, "language": "en",
                                   "violations": [], "rule_ids": [], "fact_ids": [quote.fact_id],
                                   "soft_promise": FakeDecisions.SOFT_USAGE | {"status": "ok"}}   # the check passed it
    assert (await session_of(app, copy, visitor)).last_language == "en"


def kinds_of(verdict: ReplyVerdict) -> set[str]:
    return {violation.kind for violation in verdict.violations}


def rule_ids_of(verdict: ReplyVerdict) -> set[str]:
    return {violation.rule_id for violation in verdict.violations}


def assert_handed_off(verdict: ReplyVerdict, language: str = "en") -> None:
    """A failed check: not ok, and only the handoff clause, in `language`, with the handoff receipt."""
    handoff = {"en": "Let me check with Maria Rivera.", "es": "Déjame consultarlo con Maria Rivera."}[language]
    receipt = {"en": "Passed to Maria Rivera to answer", "es": "Pasado a Maria Rivera para responder"}[language]
    assert verdict.ok is False and verdict.violations
    [block] = verdict.blocks
    assert (block.kind, block.template, block.fact_id, block.title) == ("card", "handoff", None, handoff)
    assert (verdict.language, verdict.visitor_plain) == (language, receipt)


@pytest.mark.parametrize(("prose", "rule_ids", "span"), [
    ("Maria said it's $1", {"currency", "digit"}, "1"),
    ("I can do 80% off", {"digit", "percent_sign"}, "80"),
    ("eighty percent off", {"lex.en.number", "lex.en.percent"}, "eighty"),
    ("ochenta por ciento de descuento", {"lex.es.number", "lex.es.percent"}, "ochenta"),
    ("See you Tuesday", {"lex.en.date"}, "Tuesday"),
    ("nos vemos el martes", {"lex.es.date"}, "martes"),
    ("1.234,56 €", {"digit", "currency"}, "1.234,56"),
    ("１２", {"digit"}, "12"),                                    # full-width digits
    ("tomorrow at noon", {"lex.en.date"}, "tomorrow"),
    ("1​2", {"digit"}, "12"),                                        # a zero-width space inside
    ("See you Tu\u0435sday", {"lex.en.date", "mixed_script"}, "Tu\u0435sday"),   # a Cyrillic e
    ("That is tw\u0435nty", {"lex.en.number", "mixed_script"}, "tw\u0435nty"),   # a Cyrillic e
    ("That will be \u039d\u0399\u039d\u0395", {"lex.en.number"}, "\u039d\u0399\u039d\u0395"),   # Greek NINE, iota as I
    ("Puedo ir a las once.", {"lex.es.date"}, "las once"),             # eleven o'clock
    ("Llego a la una.", {"lex.es.date"}, "la una"),                    # one o'clock
    ("The total is \u0417\u041e\u041e.", {"digit"}, "\u0417\u041e\u041e"),   # Cyrillic Ze and O, drawn as 300
    ("El total es \u0406\u041e\u041e.", {"digit"}, "\u0406\u041e\u041e"),    # Cyrillic I and O, drawn as 100
    ("That is tweIve.", {"lex.en.number"}, "tweIve"),                  # a capital I for l
    ("A few more doIIars.", {"lex.en.money"}, "doIIars"),
    ("Puedo ir en abriI.", {"lex.es.date"}, "abriI"),
    ("See you this\u2010morning.", {"lex.en.date"}, "this\u2010morning"),          # a Unicode hyphen
    ("Nos vemos el fin\u2013de\u2013semana.", {"lex.es.date"}, "fin\u2013de\u2013semana"),   # en dashes
    ("Come by at one o\u2018clock.", {"lex.en.date"}, "o\u2018clock"),             # a left single quote
    ("Maria can be there same-day.", {"lex.en.date"}, "same-day"),
    ("Maria can come the same day.", {"lex.en.date"}, "same day"),
    ("Maria can be there same\u2011day.", {"lex.en.date"}, "same\u2010day"),     # NFKC makes U+2011 U+2010
    ("Podemos ir el mismo día.", {"lex.es.date"}, "el mismo día"),
])
async def test_numbers_and_dates_in_prose_are_blocked(app, client, prose, rule_ids, span):
    copy, visitor = await visitor_of(app, client)
    verdict = await checked(client, visitor, prose)
    assert "number_in_prose" in kinds_of(verdict) and rule_ids <= rule_ids_of(verdict), verdict.violations
    numbers = [violation for violation in verdict.violations if violation.kind == "number_in_prose"]
    assert span in [violation.span for violation in numbers]
    assert all(len(violation.span) <= 40 for violation in verdict.violations)
    spanish = prose in ("nos vemos el martes", "Puedo ir a las once.", "Llego a la una.",
                        "El total es \u0406\u041e\u041e.", "Puedo ir en abriI.",
                        "Nos vemos el fin\u2013de\u2013semana.", "Podemos ir el mismo día.")
    assert_handed_off(verdict, "es" if spanish else "en")


@pytest.mark.parametrize(("prose", "rule_id", "span", "language"), [
    ("I guarantee it.", "lex.en.promise", "guarantee", "en"),
    ("That part is free.", "lex.en.promise", "free", "en"),
    ("The first visit is free to everyone.", "lex.en.promise", "free", "en"),     # "free to" stating a price
    ("It is free to all customers.", "lex.en.promise", "free", "en"),
    ("Inspections are free to members.", "lex.en.promise", "free", "en"),
    ("As a member you are free to all classes.", "lex.en.promise", "free", "en"),   # an audience after "free to"
    ("As a member you're free to most classes.", "lex.en.promise", "free", "en"),   # a quantifier
    ("As a member you're free to these classes.", "lex.en.promise", "free", "en"),  # a demonstrative
    ("You are free to first-time visitors.", "lex.en.promise", "free", "en"),       # an audience with a modifier
    ("Como socio, usted tiene acceso libre a todas las clases.", "lex.es.promise", "libre", "es"),
    ("La entrada es libre al público.", "lex.es.promise", "libre", "es"),            # "a" + "el" is "al"
    ("La primera clase es libre de costo.", "lex.es.promise", "libre de costo", "es"),   # free of charge
    ("Eso es gratis.", "lex.es.promise", "gratis", "es"),
    ("Le prometo.", "lex.es.promise", "prometo", "en"),      # too few words to tell: English
    ("There is no\u2014charge for that.", "lex.en.promise", "no\u2014charge", "en"),   # an em dash
    ("Es sin\u2212costo.", "lex.es.promise", "sin\u2212costo", "es"),                 # a minus sign
    ("Entrada libre.", "lex.es.promise", "Entrada libre", "en"),                      # free admission
    ("La clase tiene entrada libre.", "lex.es.promise", "entrada libre", "es"),
    ("Hay entradas libres para el concierto.", "lex.es.promise", "entradas libres", "es"),
    ("Todo es libre de impuestos.", "lex.es.promise", "libre de impuestos", "es"),     # tax-free
    ("La clase es libre para usted.", "lex.es.promise", "libre", "es"),               # free for you
    ("Las clases son libres para ustedes.", "lex.es.promise", "libres", "es"),
    ("El taller es libre para ti.", "lex.es.promise", "libre", "es"),
    ("La visita es libre para vos.", "lex.es.promise", "libre", "es"),
    ("La visita es libre para vosotros.", "lex.es.promise", "libre", "es"),
    ("¿Tiene un horario libre para usted?", "lex.es.promise", "libre", "es"),   # "libre para usted" whatever is free
])
async def test_promise_words_are_blocked(app, client, prose, rule_id, span, language):
    copy, visitor = await visitor_of(app, client)
    verdict = await checked(client, visitor, prose)
    assert [(v.kind, v.rule_id, v.span) for v in verdict.violations] == [("promise_word", rule_id, span)]
    assert_handed_off(verdict, language)


@pytest.mark.parametrize(("prose", "span"), [
    ("Come by on the wee\u043aend.", "wee\u043aend"),        # a Cyrillic k, which no table reads as k
    ("H\u0435llo, how can I help?", "H\u0435llo"),            # a Cyrillic e in a word no lexicon holds
])
async def test_a_word_mixing_scripts_is_blocked(app, client, prose, span):
    copy, visitor = await visitor_of(app, client)
    verdict = await checked(client, visitor, prose)
    assert [(v.kind, v.rule_id, v.span) for v in verdict.violations] == [("unsupported_language", "mixed_script", span)]
    assert_handed_off(verdict)


async def rename(app: FastAPI, copy: Rivera, *, business: str, desk: str) -> None:
    """Gives the copy's business and Desk these names, as the owner's setup would."""
    async with kernel_ctx(app) as ctx:
        repo = ctx.bind(copy.copy_id)
        desk_row = (await ctx.db.scalars(repo.scoped(select(Desk).where(Desk.desk_id == copy.desk_id)))).one()
        business_row = (await ctx.db.scalars(repo.scoped(select(Business).where(
            Business.business_id == desk_row.business_id)))).one()
        desk_row.name, business_row.name = desk, business


SIGMA = "\u03a3igma Plumbing"          # a Greek capital sigma
MAIN_LINE = "\u039cain line"           # a Greek capital mu


@pytest.mark.parametrize(("prose", "language"), [
    (f"Welcome to {SIGMA}. How can I help?", "en"),
    (f"Hola, soy el asistente de {MAIN_LINE}. ¿En qué le puedo ayudar?", "es"),
])
async def test_the_desks_own_names_may_mix_scripts(app, client, prose, language):
    """A business or Desk the owner named with letters of two scripts can be named in a reply."""
    copy, visitor = await visitor_of(app, client)
    await rename(app, copy, business=SIGMA, desk=MAIN_LINE)
    verdict = await checked(client, visitor, prose)
    assert (verdict.ok, verdict.violations, verdict.language) == (True, [], language)


async def test_only_the_desks_own_names_may_mix_scripts(app, client):
    copy, visitor = await visitor_of(app, client)
    await rename(app, copy, business=SIGMA, desk=MAIN_LINE)
    verdict = await checked(client, visitor, f"\u03a3igma can help. {SIGMA} says h\u0435llo.")   # a Cyrillic e
    assert [(v.kind, v.rule_id, v.span) for v in verdict.violations] == [
        ("unsupported_language", "mixed_script", "\u03a3igma"), ("unsupported_language", "mixed_script", "h\u0435llo")]
    assert_handed_off(verdict)


@pytest.mark.parametrize(("prose", "names"), [
    ("l" * 20_000, ()), ("I l O " * 4_000, ()), ("\u041e" * 20_000, ()),
    ("\u03a3a " * 12_000, ("\u03a3a",)),                  # a Desk's own name, mixing scripts, over and over
])
def test_a_long_draft_is_scanned_in_one_pass(prose, names):
    """Letters shaped like 0 or 1 that make no number are passed over once, not once per letter,
    and each mixed-script word is looked up once among the Desk's names, not once per mention."""
    started = time.perf_counter()
    reply_check.scan_prose(prose, names=names)
    assert time.perf_counter() - started < 2


def test_the_lookalike_table_is_what_its_script_makes():
    """`lexicon/lookalikes.txt` is exactly what `scripts/lookalikes.py` makes from the lines of
    Unicode's confusables.txt it keeps, so anyone can check the table and remake it."""
    committed = (reply_check.LEXICON_DIR / "lookalikes.txt").read_text(encoding="utf-8")
    assert committed == lookalikes.table()


# Every Unicode dash and hyphen but "-" itself (category Pd: U+2010 to U+2015, U+FE58, U+FE63, U+FF0D
# and the rest), and the minus sign
DASHES = [ch for ch in map(chr, range(sys.maxunicode + 1)) if unicodedata.category(ch) == "Pd" and ch != "-"]
DASHES.append("\u2212")
HYPHENATED = [                       # lexicon phrases whose words a dash may join, and the rule each breaks
    ("this-morning", "lex.en.date"), ("next-week", "lex.en.date"), ("no-charge", "lex.en.promise"),
    ("money-back", "lex.en.promise"), ("on-the-house", "lex.en.promise"), ("last-year", "lex.en.date"),
    ("same-day", "lex.en.date"), ("fin-de-semana", "lex.es.date"), ("la-próxima-semana", "lex.es.date"),
    ("sin-costo", "lex.es.promise"), ("de-regalo", "lex.es.promise"), ("el-mismo-día", "lex.es.date"),
    ("entrada-libre", "lex.es.promise"), ("libre-de-impuestos", "lex.es.promise"),
    ("you're-booked", "lex.en.booking"), ("your-visit-is-confirmed", "lex.en.booking"),
    ("tu-cita-está-confirmada", "lex.es.booking"), ("ya-estás-reservado", "lex.es.booking"),
]


@pytest.mark.parametrize("dash", DASHES, ids=lambda dash: f"U+{ord(dash):04X}")
def test_every_dash_reads_as_a_hyphen(dash):
    """NFKC keeps most dashes as they are ("this‐morning" with U+2010), so the lexicons read every
    dash and hyphen, and the minus sign, as the "-" their separators take, and the span quotes the
    prose as it is shown."""
    for phrase, rule_id in HYPHENATED:
        prose = phrase.replace("-", dash)
        assert [(v.rule_id, v.span) for v in reply_check.scan_prose(prose)] == [
            (rule_id, reply_check.shown(prose))], prose


APOSTROPHES = ["\u2018", "\u201b", "\u02bc", "\u02bb", "\u2032", "\u2035", "\uff07", "`", "\u00b4"]  # ‘‛ʼʻ′‵＇`´


@pytest.mark.parametrize("apostrophe", APOSTROPHES, ids=lambda apostrophe: f"U+{ord(apostrophe):04X}")
def test_every_apostrophe_reads_as_the_plain_one(apostrophe):
    """Each apostrophe variant reads as "’": "o‘clock" is a time, and "you‘re free to" keeps the
    exemption "you’re free to" has, while "free to" before an audience is still a promise. An acute
    accent reads as the space NFKC puts before it too (below), so its "free to" fails closed."""
    o_clock = f"o{apostrophe}clock"
    found = reply_check.scan_prose(f"Come by at one {o_clock}.")
    assert [(v.rule_id, v.span) for v in found] == [("lex.en.date", reply_check.shown(o_clock))]
    exempt = [("lex.en.promise", "free")] if apostrophe == "\u00b4" else []
    for prose in (f"You{apostrophe}re free to ask me anything.", f"You{apostrophe}ll be free to call me anytime."):
        assert [(v.rule_id, v.span) for v in reply_check.scan_prose(prose)] == exempt, prose
    found = reply_check.scan_prose(f"As a member you{apostrophe}re free to all classes.")
    assert [(v.rule_id, v.span) for v in found] == [("lex.en.promise", "free")]
    booked = f"You{apostrophe}re booked"
    found = reply_check.scan_prose(f"{booked}.")
    assert [(v.rule_id, v.span) for v in found] == [("lex.en.booking", reply_check.shown(booked))]


@pytest.mark.parametrize(("prose", "rule_id"), [
    ("no\u00b4charge", "lex.en.promise"), ("next\u00b4week", "lex.en.date"), ("sin\u00b4costo", "lex.es.promise"),
])
def test_an_acute_accent_between_words_still_reads_as_a_space(prose, rule_id):
    """NFKC writes an acute accent (´) as a space and a combining acute ("no ́charge"). Read as "’"
    for "o´clock", the pair still reads as the space it is drawn on too, so a phrase it joins is found."""
    assert [(v.rule_id, v.span) for v in reply_check.scan_prose(prose)] == [(rule_id, reply_check.shown(prose))]


@pytest.mark.parametrize(("prose", "language"), [
    ("I can help with that. Which day works for you?", "en"),
    ("Con gusto le ayudo. ¿Qué día le viene bien?", "es"),
    ("You may want to turn off the water.", "en"),          # the modal, not the month
    ("Feel free to ask me anything.", "en"),                # free, not a price
    ("You're free to ask me anything.", "en"),
    ("You're free to choose any day.", "en"),               # a verb after "free to", then a quantifier
    ("You are free to call me anytime.", "en"),
    ("You\u02bcre free to ask me anything.", "en"),          # a modifier letter apostrophe
    ("You\u2018re free to call me anytime.", "en"),          # a left single quote
    ("Usted es libre de preguntarme lo que quiera.", "es"),   # free to ask, not a price
    ("¿Tiene usted un horario libre?", "es"),               # a time that is open, not a price
    ("Hay un hueco libre.", "es"),
    ("Tengo la tarde libre.", "es"),
    ("¿Está libre para la cita?", "es"),
    ("Hay un espacio libre al lado de la entrada.", "es"),
    ("BILLING IS IN ILLINOIS.", "en"),                      # capitals with I, which is read as l too
    ("Isla, Inés, Iván e Isabel ya están en la lista.", "es"),
    ("OK, I will call.", "en"),                             # I and O as words, not numbers
    ("It is the same. Day and time are on the card.", "en"),   # a sentence ends between "same" and "day"
    ("Es lo mismo. Día y hora van en la tarjeta.", "es"),
])
async def test_plain_prose_passes(app, client, prose, language):
    copy, visitor = await visitor_of(app, client)
    verdict = await checked(client, visitor, prose)
    assert (verdict.ok, verdict.violations, verdict.language) == (True, [], language)
    assert verdict.blocks == [RenderedBlock(kind="prose", text=prose)]
    owner = "Maria Rivera"
    assert verdict.visitor_plain == {"en": f"Reply checked against {owner}'s rules",
                                     "es": f"Respuesta revisada con las reglas de {owner}"}[language]


async def keep_alive_until(client: httpx.AsyncClient, frozen_clock, visitor: Visitor, hours: int) -> None:
    """Moves the clock on by `hours` in half-day hops, the visitor reading `/whoami` after each, so
    the session never sits idle for the day that closes it."""
    for _ in range(hours // 12):
        frozen_clock.advance(12 * 3600)
        assert (await client.get("/whoami", headers=visitor.headers)).status_code == 200


async def own_booking(client: httpx.AsyncClient, reviewer, visitor: Visitor, slot_id: str = "S-20261102-1000") -> Fact:
    """The visitor's booking of a weekday slot (`rv-book-wk`, the reviewer passing it): its fact."""
    reviewer.answer = PASS
    decision = await book(client, visitor, slot_id)
    assert decision.outcome == "allow", decision.reason_plain
    [fact] = (await executed(client, visitor, decision)).facts
    return fact


@pytest.mark.parametrize(("case", "kind", "rule_id"), [
    ("an unknown fact", "unknown_fact", "no_such_fact"),
    ("an expired quote", "stale_fact", "not_current"),
    ("another session's quote", "unentitled_fact", "not_a_reader"),
    ("a booking under quote", "unknown_fact", "template_mismatch"),
    ("payment_link", "unknown_fact", "template_unavailable"),
    ("a hostile fact_id", "unknown_fact", "no_such_fact"),
])
async def test_clause_checks(app, client, reviewer, frozen_clock, case, kind, rule_id):
    copy, visitor = await visitor_of(app, client)
    template = "quote"
    if case == "an unknown fact":
        fact_id = "quote:quote-aaaaaaaaaaaaaaaa"
    elif case == "an expired quote":
        fact_id = (await own_quote(client, visitor)).fact_id
        await keep_alive_until(client, frozen_clock, visitor, 72)          # a quote is good for 72 hours
    elif case == "another session's quote":
        fact_id = (await own_quote(client, await open_visitor(client, copy))).fact_id
    elif case == "a booking under quote":
        fact_id = (await own_booking(client, reviewer, visitor)).fact_id
    elif case == "payment_link":                                           # registered by Plan 01c
        template, fact_id = "payment_link", "payment_link:link-aaaaaaaaaaaaaaaa"
    else:
        fact_id = "dana@example.com"
    verdict = await checked(client, visitor, "Here is your quote.", [clause(template, fact_id)])
    assert [(v.kind, v.rule_id, v.fact_ids) for v in verdict.violations] == [(kind, rule_id, [fact_id])]
    assert_handed_off(verdict)
    # the attempt is on the ledger, whatever the fact ID holds, and the ledger never holds the ID itself
    # when it isn't a plain identifier
    [entry] = await reply_entries(app, copy)
    ref = ledger.safe_ref(fact_id)
    assert (entry.event.summary["ok"], entry.event.summary["violations"], entry.event.summary["rule_ids"],
            entry.event.summary["fact_ids"]) == (False, [kind], [rule_id], [ref])
    if case == "a hostile fact_id":
        assert ref == {"invalid": True, "sha256": hashlib.sha256(fact_id.encode()).hexdigest()[:16]}
        assert fact_id not in entry.envelope_jcs


async def test_a_canary_in_prose_is_blocked(app, client):
    copy, visitor = await visitor_of(app, client)
    canaries = [row.canary for row in await rows_of(app, copy.copy_id, select(Document))]
    assert len(canaries) == 2                                             # Dana's invoice and Bob's warranty
    for prose in (f"Your invoice reference is {canaries[0]}.",
                  f"Your reference is {canaries[1][:6]}​{canaries[1][6:]}."):   # hidden behind a zero-width space
        verdict = await checked(client, visitor, prose)
        # only the canary: its digits aren't read as an amount, and nothing echoes it
        assert [(v.kind, v.span, v.rule_id) for v in verdict.violations] == [("canary", "", "canary")]
        assert_handed_off(verdict)
        assert not any(canary in verdict.model_dump_json() for canary in canaries)
    entries = await reply_entries(app, copy)
    assert [entry.event.summary["violations"] for entry in entries] == [["canary"], ["canary"]]
    assert not any(canary in entry.envelope_jcs for entry in entries for canary in canaries)


@pytest.mark.parametrize(("prose", "detected"), [
    ("I can help with that.", "en"),
    ("Con gusto le ayudo.", "es"),
    ("Je peux vous aider avec ça.", "other"),
    ("Je peux envoyer un plombier pour la fuite.", "other"),            # French, with Spanish's "la" and "un"
    ("Posso ajudar você com isso.", "other"),                           # Portuguese
    ("OK", "none"),                                                     # too little to tell: the last language
])
async def test_language_detection(app, client, prose, detected):
    copy, visitor = await visitor_of(app, client)
    assert lang.detect(prose) == detected
    if detected == "none":
        assert (await checked(client, visitor, "Con gusto le ayudo.")).language == "es"
    verdict = await checked(client, visitor, prose)
    if detected == "other":
        assert [(v.kind, v.rule_id) for v in verdict.violations] == [("unsupported_language", "language")]
        assert_handed_off(verdict, "en")                                # in the session's last language
        assert (await session_of(app, copy, visitor)).last_language is None
    else:
        language = "es" if detected == "none" else detected
        assert (verdict.ok, verdict.language, verdict.blocks) == (True, language, [RenderedBlock(kind="prose",
                                                                                                text=prose)])
        assert (await session_of(app, copy, visitor)).last_language == language


async def own_slots(client: httpx.AsyncClient, visitor: Visitor, call_id: str = "call-slots") -> Fact:
    """The open times `native.find_slots` lists for the visitor (the six earliest): their fact."""
    decision = await decided(client, visitor, "native.find_slots", {}, call_id=call_id)
    assert decision.outcome == "allow", decision.reason_plain
    [fact] = (await executed(client, visitor, decision)).facts
    return fact


SLOTS_ES = [("S-20261031-0900", "sábado 31 de octubre, 9:00"), ("S-20261031-1100", "sábado 31 de octubre, 11:00"),
            ("S-20261102-0800", "lunes 2 de noviembre, 8:00"), ("S-20261102-1000", "lunes 2 de noviembre, 10:00"),
            ("S-20261102-1200", "lunes 2 de noviembre, 12:00"), ("S-20261102-1400", "lunes 2 de noviembre, 14:00")]


async def test_clauses_render_in_the_replys_language(app, client):
    copy, visitor = await visitor_of(app, client)
    quote, slots = await own_quote(client, visitor), await own_slots(client, visitor)
    cited = [clause("quote", quote.fact_id), clause("booking_options", slots.fact_id), clause("hours", "charter:hours")]

    verdict = await checked(client, visitor, "Aquí tiene su cotización y los horarios libres.", cited)
    assert (verdict.ok, verdict.language, verdict.visitor_plain) == (
        True, "es", "Respuesta revisada con las reglas de Maria Rivera")
    _, quote_card, slots_card, hours_card = verdict.blocks
    assert (quote_card.title, quote_card.lines) == (
        "$180.00", ["Drain clearing", "Válido hasta lunes 2 de noviembre, 9:04"])
    assert (slots_card.title, slots_card.lines) == ("Horarios disponibles", [label for _, label in SLOTS_ES])
    assert [(option.option_id, option.label) for option in slots_card.options] == SLOTS_ES
    assert (hours_card.title, hours_card.lines) == ("De lunes a viernes, de 8:00 a 18:00", ["Sábado, de 9:00 a 13:00"])

    # a reply with no prose renders in the session's last language; the next English reply in English
    card_only = await checked(client, visitor, "", [clause("quote", quote.fact_id)])
    assert (card_only.language, [block.lines[-1] for block in card_only.blocks]) == (
        "es", ["Válido hasta lunes 2 de noviembre, 9:04"])
    english = await checked(client, visitor, "Here is your quote and the open times.", cited)
    assert (english.language, english.visitor_plain) == ("en", "Reply checked against Maria Rivera's rules")
    assert [block.title for block in english.blocks[1:]] == [
        "$180.00", "Times that are open", "Monday to Friday, 8:00 am to 6:00 pm"]
    assert english.blocks[3].lines == ["Saturday, 9:00 am to 1:00 pm"]


async def discounted_quote(client: httpx.AsyncClient, copy: Rivera, visitor: Visitor) -> Fact:
    """Drain clearing at 15% off: `rv-quote` holds it, and Maria allows it once."""
    held = await decided(client, visitor, "native.quote", quote_args(("drain", 1), discount_bp=1500),
                         call_id="call-discount")
    assert held.outcome == "hold", held.reason_plain
    result = await answered(client, copy.owner, held.decision_id, "allow_once")
    [fact] = result.execution.facts
    return fact


async def test_card_text_is_headline_then_details(app, client, reviewer):
    copy, visitor = await visitor_of(app, client)
    quote = await discounted_quote(client, copy, visitor)
    slots = await own_slots(client, visitor)
    booking = await own_booking(client, reviewer, visitor, "S-20261102-1000")     # one of the six open times
    verdict = await checked(client, visitor, "Here are the details.", [
        clause("quote", quote.fact_id), clause("booking_options", slots.fact_id),
        clause("booking_confirmed", booking.fact_id), clause("hours", "charter:hours"),
        clause("policy", "charter:policy:service_area"), clause("contact", "charter:contact"), clause("handoff"),
        clause("verify_prompt")])
    assert verdict.ok, verdict.violations
    cards = {block.template: block for block in verdict.blocks[1:]}
    open_times = [("S-20261031-0900", "Saturday, October 31, 9:00 am"),
                  ("S-20261031-1100", "Saturday, October 31, 11:00 am"),
                  ("S-20261102-0800", "Monday, November 2, 8:00 am"),
                  ("S-20261102-1200", "Monday, November 2, 12:00 pm"),      # 10:00 is booked, so left out
                  ("S-20261102-1400", "Monday, November 2, 2:00 pm")]
    assert {template: (card.title, card.lines) for template, card in cards.items()} == {
        "quote": ("$153.00", ["Drain clearing", "Includes 15% off $180.00", "Good until Monday, November 2, 9:04 am"]),
        "booking_options": ("Times that are open", [label for _, label in open_times]),
        "booking_confirmed": ("Monday, November 2", ["Arriving 10:00 am to 12:00 pm", "With Maria Rivera"]),
        "hours": ("Monday to Friday, 8:00 am to 6:00 pm", ["Saturday, 9:00 am to 1:00 pm"]),
        "policy": ("We work in Oakland, Berkeley, Alameda and Emeryville.", []),
        "contact": ("(510) 555-0142", []),
        "handoff": ("Let me check with Maria Rivera.", ["Maria Rivera will reply here."]),
        "verify_prompt": ("I'll send a code to the contact on record.", []),
    }
    for template, card in cards.items():
        assert card.text == "\n".join([card.title, *card.lines]), template
        assert card.href is None, template
        assert card.options == ([CardOption(option_id=slot_id, label=label) for slot_id, label in open_times]
                                if template == "booking_options" else []), template
    assert (cards["booking_confirmed"].fact_id, cards["handoff"].fact_id) == (booking.fact_id, None)
    assert not any(booking.fact_id.removeprefix("booking:") in card.text for card in cards.values())   # no booking id

    # the clauses that name no fact name none; the Spanish booking card reads the same way
    named = await checked(client, visitor, "Here are the details.", [clause("verify_prompt", "charter:contact")])
    assert [(v.kind, v.rule_id) for v in named.violations] == [("unknown_fact", "names_no_fact")]
    spanish = await checked(client, visitor, "Aquí tiene los detalles.",
                            [clause("booking_confirmed", booking.fact_id)])
    assert (spanish.blocks[1].title, spanish.blocks[1].lines) == (
        "lunes 2 de noviembre", ["Llegada de 10:00 a 12:00", "Con Maria Rivera"])


# The soft-promise check finding nothing beyond the cards, so a block below is the code's own.
NOTHING_BEYOND_THE_CARDS = SoftPromiseVerdict(promises_beyond_cards=False, denies_being_ai=False)


async def test_a_booking_claim_beside_its_card_is_blocked(app, client, reviewer):
    """A booking appears only in its card: "You're booked." is blocked even beside the booking card
    it repeats, by the prose scan, before the soft-promise check is asked."""
    copy, visitor = await visitor_of(app, client)
    booking = await own_booking(client, reviewer, visitor)
    reviewer.soft_answer = NOTHING_BEYOND_THE_CARDS
    verdict = await checked(client, visitor, "You're booked.", [clause("booking_confirmed", booking.fact_id)])
    assert [(v.kind, v.rule_id, v.span) for v in verdict.violations] == [
        ("promise_word", "lex.en.booking", "You're booked")]
    assert_handed_off(verdict)
    assert reviewer.soft_inputs == []


async def test_a_reply_naming_only_the_card_passes(app, client, reviewer):
    """Prose that points at the booking card, and claims nothing itself, is shown with it."""
    copy, visitor = await visitor_of(app, client)
    booking = await own_booking(client, reviewer, visitor)
    reviewer.soft_answer = NOTHING_BEYOND_THE_CARDS
    for prose, language in (("The booking is below.", "en"), ("Abajo tiene los datos de su reserva.", "es")):
        verdict = await checked(client, visitor, prose, [clause("booking_confirmed", booking.fact_id)])
        assert (verdict.ok, verdict.violations, verdict.language) == (True, [], language)
        assert [(block.kind, block.template) for block in verdict.blocks] == [("prose", None),
                                                                              ("card", "booking_confirmed")]


@pytest.mark.parametrize(("prose", "rule_id", "span"), [
    ("You're booked.", "lex.en.booking", "You're booked"),
    ("You are all set.", "lex.en.booking", "You are all set"),
    ("You’re now confirmed for that time.", "lex.en.booking", "You’re now confirmed"),
    ("You're already scheduled.", "lex.en.booking", "You're already scheduled"),
    ("I've booked you in.", "lex.en.booking", "I've booked you"),
    ("We have scheduled you with Maria.", "lex.en.booking", "We have scheduled you"),
    ("We've confirmed you.", "lex.en.booking", "We've confirmed you"),
    ("I booked you with Maria.", "lex.en.booking", "I booked you"),
    ("I've confirmed your appointment.", "lex.en.booking", "I've confirmed your appointment"),
    ("Your booking is confirmed.", "lex.en.booking", "Your booking is confirmed"),
    ("Your appointment is set.", "lex.en.booking", "Your appointment is set"),
    ("Your visit is now scheduled.", "lex.en.booking", "Your visit is now scheduled"),
    ("The appointment has been confirmed.", "lex.en.booking", "The appointment has been confirmed"),
    ("You've been booked.", "lex.en.booking", "You've been booked"),
    ("Your booking is aIready confirmed.", "lex.en.booking", "Your booking is aIready confirmed"),   # I for l
    ("Tu cita está confirmada.", "lex.es.booking", "Tu cita está confirmada"),
    ("Su visita queda agendada.", "lex.es.booking", "Su visita queda agendada"),
    ("Su reserva ya está confirmada.", "lex.es.booking", "Su reserva ya está confirmada"),
    ("La cita ha quedado reservada.", "lex.es.booking", "La cita ha quedado reservada"),
    ("Ya estás reservado.", "lex.es.booking", "Ya estás reservado"),
    ("Está confirmada.", "lex.es.booking", "Está confirmada"),
    ("Usted ya está agendado con Maria.", "lex.es.booking", "ya está agendado"),
    ("Su próxima cita está confirmada.", "lex.es.booking", "Su próxima cita está confirmada"),   # a word between
    ("Tu nueva visita está agendada.", "lex.es.booking", "Tu nueva visita está agendada"),
    ("Su primera reserva está confirmada.", "lex.es.booking", "Su primera reserva está confirmada"),
    ("Esta cita está confirmada.", "lex.es.booking", "Esta cita está confirmada"),     # another determiner
    ("Mi cita está confirmada.", "lex.es.booking", "Mi cita está confirmada"),
    ("La cita de Ana está confirmada.", "lex.es.booking", "está confirmada"),         # any words before "está"
    ("Sí está confirmada.", "lex.es.booking", "está confirmada"),                     # "sí" (yes) is no "si" (if)
    ("Sí ya está confirmada.", "lex.es.booking", "ya está confirmada"),
    ("Sí tu cita está confirmada.", "lex.es.booking", "tu cita está confirmada"),
    ("SÍ ESTÁ CONFIRMADA.", "lex.es.booking", "ESTÁ CONFIRMADA"),
    ("S\u0131\u0301 está confirmada.", "lex.es.booking", "está confirmada"),          # a dotless i and an acute
])
def test_booking_claims_in_prose_are_blocked(prose, rule_id, span):
    """Only a booking card says a visit is booked: the claim in prose is a promise word, in English
    and Spanish, whatever card is beside it."""
    assert [(v.kind, v.rule_id, v.span) for v in reply_check.scan_prose(prose)] == [("promise_word", rule_id, span)]


def test_booking_claims_read_lookalike_letters():
    """Letters of another script that look like Latin ones are read as them in a booking claim too
    (and the word mixing scripts is blocked on its own)."""
    found = [(v.rule_id, v.span) for v in reply_check.scan_prose("You're bооked.")]   # Cyrillic o
    assert found == [("lex.en.booking", "You're bооked"), ("mixed_script", "bооked")]
    found = [(v.rule_id, v.span) for v in reply_check.scan_prose("Tu citа está confirmada.")]   # Cyrillic a
    assert found == [("lex.es.booking", "Tu citа está confirmada"), ("mixed_script", "citа")]


@pytest.mark.parametrize("prose", [
    "Once you're booked, Maria will text you.",
    "When your visit is confirmed, you'll get a message.",
    "If you're booked already, I can look it up.",
    "IF YOU'RE BOOKED, MARIA WILL CALL.",                   # a capital I is read as l too
    "As soon as you are scheduled, Maria will reach out.",
    "After we've booked you, Maria will reach out.",
    "Until your appointment is confirmed, the time isn't held.",
    "Cuando tu cita esté confirmada, te escribimos.",
    "Cuando tu cita está confirmada, Maria te escribe.",
    "Cuando su próxima cita está confirmada, le llega un mensaje.",   # a word between, a claim inside
    "Si tu nueva visita está agendada, Maria le avisa.",
    "Cuando una cita está confirmada, Maria lo anota.",
    "Si ya está confirmada, Maria le avisa.",
    "SI YA ESTÁ CONFIRMADA, MARIA LE AVISA.",
    "Una vez que su reserva queda confirmada, le llega un mensaje.",
])
def test_a_condition_before_a_booking_claim_passes(prose):
    """A condition straight before the claim says what happens once a booking exists, which claims
    none: "once you're booked", "cuando tu cita esté confirmada"."""
    assert reply_check.scan_prose(prose) == []


def test_a_long_draft_of_booking_claims_is_scanned_in_one_pass():
    """Thousands of booking claims, conditioned or not and each holding a shorter one, are read in
    one pass: a condition is looked for just before each claim, and claims inside others drop out
    in one sweep."""
    started = time.perf_counter()
    found = reply_check.scan_prose("si ya está confirmada " * 4_000 + "tu cita está confirmada " * 4_000)
    assert time.perf_counter() - started < 2
    assert {(v.rule_id, v.span) for v in found} == {("lex.es.booking", "tu cita está confirmada")}
    assert len(found) == 4_000


SERVICE_AREA = "We work in Oakland, Berkeley, Alameda and Emeryville."        # Rivera's seeded policy
AREA_ES = "Trabajamos en Oakland, Berkeley, Alameda y Emeryville."
NOTICE_ES = "Para cancelar la visita, avísenos con un día de antelación."


@pytest.mark.parametrize(("prose", "policy", "span"), [
    (SERVICE_AREA, SERVICE_AREA, "We work in Oakland, Berkeley, Alameda an"),            # cut to 40 characters
    ("Good news: we WORK IN OAKLAND; Berkeley too.", SERVICE_AREA, "we WORK IN OAKLAND; Berkeley"),   # case, commas
    ("We work in OakIand, BerkeIey and more.", SERVICE_AREA, "We work in OakIand, BerkeIey"),    # a capital I for l
    ("We work in Oakland—Berkeley and around.", SERVICE_AREA, "We work in Oakland—Berkeley"),   # a dash
    ("Sí, trabajamos en Oakland, Berkeley, Alameda y Emeryville.", AREA_ES,
     "trabajamos en Oakland, Berkeley, Alameda"),
    ("Recuerde: para cancelar la visita, avisenos con un dia de antelacion.", NOTICE_ES,   # accents dropped
     "para cancelar la visita, avisenos con un"),
])
def test_prose_repeating_a_policy_is_blocked(prose, policy, span):
    """A policy appears only in its card: five or more words in a row shared with a policy's text,
    in either language, with case, punctuation and the lexicons' readings set aside, is the policy
    in prose, and names the policy it repeats."""
    found = reply_check.scan_prose(prose, policies=[("charter:policy:rule", policy)])
    assert [(v.kind, v.rule_id, v.span, v.fact_ids) for v in found] == [
        ("promise_word", "policy_echo", span, ["charter:policy:rule"])]


@pytest.mark.parametrize("prose", [
    "We work in Oakland.",                                                  # four words in a row
    "We work in Oakland and nearby towns.",
    "Maria covers Oakland and Berkeley, plus Alameda and Emeryville.",      # the policy in other words
    "Trabajamos en toda la zona de Oakland.",
])
def test_shorter_overlaps_and_paraphrases_of_a_policy_pass(prose):
    """Fewer than five words in a row, or the policy in other words, is left to the soft-promise
    check."""
    policies = [("charter:policy:a", SERVICE_AREA), ("charter:policy:b", AREA_ES)]
    assert reply_check.scan_prose(prose, policies=policies) == []


def test_a_long_draft_repeating_a_policy_is_scanned_in_one_pass():
    """A draft that repeats one word of a policy over and over is one stretch, found in one pass."""
    started = time.perf_counter()
    found = reply_check.scan_prose("the " * 5_000, policies=[("charter:policy:a", "the " * 400)])
    assert time.perf_counter() - started < 2
    assert [(v.rule_id, v.span) for v in found] == [("policy_echo", ("the " * 10)[:40])]


async def test_a_policy_echo_beside_its_card_is_blocked(app, client, reviewer):
    """The seeded service area's text in prose is blocked even beside the policy card it repeats,
    by the prose scan, before the soft-promise check is asked; the ledger names the rule."""
    copy, visitor = await visitor_of(app, client)
    reviewer.soft_answer = NOTHING_BEYOND_THE_CARDS
    verdict = await checked(client, visitor, SERVICE_AREA, [clause("policy", "charter:policy:service_area")])
    assert [(v.kind, v.rule_id, v.span, v.fact_ids) for v in verdict.violations] == [
        ("promise_word", "policy_echo", "We work in Oakland, Berkeley, Alameda an", ["charter:policy:service_area"])]
    assert_handed_off(verdict)
    assert reviewer.soft_inputs == []
    [entry] = await reply_entries(app, copy)
    assert (entry.event.summary["violations"], entry.event.summary["rule_ids"]) == (["promise_word"], ["policy_echo"])


async def add_charter(app: FastAPI, copy: Rivera, key: str, value: str) -> str:
    """A public charter claim `key` on the copy's Desk, as the owner's setup would write it: its fact ID."""
    fact = Fact(fact_id=f"charter:{key}", kind="charter", status="available", source="kernel",
                claims=[Claim(key=key, kind="text", value=value)], label=Label(readers=["public"]))
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        ctx.db.add(labels.fact_row(copy.copy_id, copy.desk_id, fact, ctx.clock.now()))
    return fact.fact_id


async def test_policy_echoes_cover_the_rules_the_session_reads(app, client, reviewer):
    """Every charter claim stating a rule counts, `policy:*` and the service area, deposit and
    cancellation claims, in either language; a policy the session can't read isn't one it is
    shown, so repeating it isn't this check's to block (a session learns nothing about it)."""
    copy, visitor = await visitor_of(app, client)
    reviewer.soft_answer = NOTHING_BEYOND_THE_CARDS
    deposit = await add_charter(app, copy, "deposit", "The deposit is taken when you book the visit.")
    cancellation = await add_charter(app, copy, "cancellation", "Cancel any time up until the evening before.")
    area = await add_charter(app, copy, "service_area", "Maria drives out to the whole East Bay.")
    for prose, fact_id in (("Just so you know, the deposit is taken when you book the visit.", deposit),
                           ("You can cancel any time up until the evening before.", cancellation),
                           ("Maria drives out to the whole East Bay.", area)):
        verdict = await checked(client, visitor, prose)
        assert [(v.rule_id, v.fact_ids) for v in verdict.violations] == [("policy_echo", [fact_id])], prose
        assert_handed_off(verdict)

    # in Spanish: a policy the owner wrote in Spanish, repeated in a Spanish reply
    await change_fact(app, copy, "charter:policy:first_visit",
                      claims=[{"key": "policy:first_visit", "kind": "text", "value": AREA_ES}])
    verdict = await checked(client, visitor, f"Claro. {AREA_ES}")
    assert [(v.rule_id, v.fact_ids) for v in verdict.violations] == [("policy_echo", ["charter:policy:first_visit"])]
    assert_handed_off(verdict, "es")

    # the contact isn't a rule, and an owner-only policy is no policy this session reads
    await change_fact(app, copy, "charter:policy:arrival", readers=["owner"])
    for prose in ("Maria texts before she arrives.", "Maria will text you before she arrives."):
        assert (await checked(client, visitor, prose)).violations == [], prose
    assert not reply_check.states_rule("contact")


def verify_verdict(public_key_hex: str, session_id: str, verdict: ReplyVerdict) -> None:
    """Checks `verdict.signature` with `cryptography`, as anyone holding the public key can: Ed25519
    over `b"desk-verdict-v1\\0"` + sha256 of the canonical six fields, `blocks_sha256` being the hex
    sha256 of the blocks' canonical JSON. Raises `InvalidSignature` when it doesn't hold."""
    blocks = desk_kernel.canonical_json(json.dumps([block.model_dump(mode="json") for block in verdict.blocks]))
    body = {"session_id": session_id, "generation": verdict.generation, "message_id": verdict.message_id,
            "blocks_sha256": hashlib.sha256(blocks.encode()).hexdigest(), "visitor_plain": verdict.visitor_plain,
            "ledger_seq": verdict.ledger_seq}
    digest = hashlib.sha256(desk_kernel.canonical_json(json.dumps(body)).encode()).digest()
    Ed25519PublicKey.from_public_bytes(bytes.fromhex(public_key_hex)).verify(
        bytes.fromhex(verdict.signature), b"desk-verdict-v1\0" + digest)


async def public_key(client: httpx.AsyncClient) -> str:
    return (await client.get("/health")).json()["public_key_hex"]


async def test_a_failed_check_returns_a_signed_handoff(app, client):
    copy, visitor = await visitor_of(app, client)
    quote = await own_quote(client, visitor)
    key = await public_key(client)
    english = await checked(client, visitor, "That will be $180.", [clause("quote", quote.fact_id)])
    spanish = await checked(client, visitor, "Le hago el cincuenta por ciento de descuento, con gusto.")
    for verdict, language in ((english, "en"), (spanish, "es")):
        assert_handed_off(verdict, language)                              # neither the prose nor the card
        verify_verdict(key, visitor.session_id, verdict)
    entries = await reply_entries(app, copy)
    assert [(entry.seq, entry.event.ref_id, entry.event.summary["ok"], entry.event.summary["language"])
            for entry in entries] == [(english.ledger_seq, english.message_id, False, "en"),
                                      (spanish.ledger_seq, spanish.message_id, False, "es")]
    assert entries[0].event.summary["fact_ids"] == [quote.fact_id]


async def test_old_generation_and_owner_mode_drafts_are_409(app, client):
    copy, visitor = await visitor_of(app, client)
    assert (await set_mode(client, copy, visitor.session_id, "owner", 0))["generation"] == 1   # Maria takes over
    answers = [await post_check(client, visitor, "I can help with that.", generation=generation)
               for generation in (1, 0)]
    assert [(response.status_code, response.json()) for response in answers] == [
        (409, {"code": "mode_owner"}), (409, {"code": "stale_generation"})]
    assert (await set_mode(client, copy, visitor.session_id, "ai", 1))["generation"] == 2      # and hands back
    stale = await post_check(client, visitor, "I can help with that.", generation=1)
    assert (stale.status_code, stale.json()) == (409, {"code": "stale_generation"})
    verdict = await checked(client, visitor, "I can help with that.", generation=2)
    assert (verdict.ok, verdict.generation) == (True, 2)
    refusals = [(e.event.session_id, e.event.summary) for e in await ledger_rows(app, copy) if e.event.kind == "auth"]
    assert refusals == [(visitor.session_id, {"route": ROUTE, "reason": reason})
                        for reason in ("mode_owner", "stale_generation", "stale_generation")]
    assert [entry.event.ref_id for entry in await reply_entries(app, copy)] == [verdict.message_id]


async def test_a_paused_session_gets_only_the_handoff(app, client):
    copy, visitor = await visitor_of(app, client)
    quote = await own_quote(client, visitor)
    await set_session(app, copy, visitor.session_id, mode="paused", strikes=3)       # the breaker tripped
    verdict = await checked(client, visitor, "Le hago el cincuenta por ciento, con gusto.",
                            [clause("quote", quote.fact_id)])
    # nothing is scanned or rendered: one violation, the handoff in the session's last language
    assert [(v.kind, v.rule_id) for v in verdict.violations] == [("session_paused", "session_paused")]
    assert_handed_off(verdict, "en")
    verify_verdict(await public_key(client), visitor.session_id, verdict)
    assert (await session_of(app, copy, visitor)).last_language is None
    [entry] = await reply_entries(app, copy)
    assert (entry.seq, entry.event.summary["violations"]) == (verdict.ledger_seq, ["session_paused"])


async def test_verdict_and_ledger_share_a_transaction(app, client, monkeypatch):
    copy, visitor = await visitor_of(app, client)
    append = ledger.append

    async def failing_reply_entry(ctx, *, copy_id, desk_id, event):
        if event.kind == "reply":
            raise RuntimeError("the ledger is unavailable")
        return await append(ctx, copy_id=copy_id, desk_id=desk_id, event=event)

    before = [entry.seq for entry in await ledger_rows(app, copy)]
    monkeypatch.setattr(ledger, "append", failing_reply_entry)
    response = await post_check(client, visitor, "Con gusto le ayudo.")
    assert (response.status_code, response.json()) == (500, {"code": "internal"})   # never a pass
    assert [entry.seq for entry in await ledger_rows(app, copy)] == before
    assert (await session_of(app, copy, visitor)).last_language is None             # the language rolled back too
    monkeypatch.setattr(ledger, "append", append)
    verdict = await checked(client, visitor, "Con gusto le ayudo.")
    [entry] = await reply_entries(app, copy)
    assert (entry.seq, entry.event.ref_id) == (verdict.ledger_seq, verdict.message_id)
    assert (await session_of(app, copy, visitor)).last_language == "es"


async def test_verdicts_are_signed(app, client):
    copy, visitor = await visitor_of(app, client)
    quote = await own_quote(client, visitor)
    for mode, generation in (("owner", 0), ("ai", 1)):                   # a take-over and hand-back: generation 2
        await set_mode(client, copy, visitor.session_id, mode, generation)
    verdict = await checked(client, visitor, "Here is your quote.", [clause("quote", quote.fact_id)], generation=2)
    key = await public_key(client)
    verify_verdict(key, visitor.session_id, verdict)
    other = await open_visitor(client, copy)
    edited = verdict.blocks[1].model_copy(update={"title": "$1.00"})
    # the signature covers each of the six fields: the session, the generation, the message, the blocks,
    # the receipt and the ledger entry
    for session_id, changed in [
        (other.session_id, verdict),
        (visitor.session_id, verdict.model_copy(update={"generation": 0})),
        (visitor.session_id, verdict.model_copy(update={"message_id": "msg-aaaaaaaaaaaaaaaa"})),
        (visitor.session_id, verdict.model_copy(update={"blocks": [verdict.blocks[0], edited]})),
        (visitor.session_id, verdict.model_copy(update={"blocks": verdict.blocks[:1]})),
        (visitor.session_id, verdict.model_copy(update={"visitor_plain": "Passed to Maria Rivera to answer"})),
        (visitor.session_id, verdict.model_copy(update={"ledger_seq": verdict.ledger_seq - 1})),
    ]:
        with pytest.raises(InvalidSignature):
            verify_verdict(key, session_id, changed)


async def change_fact(app: FastAPI, copy: Rivera, fact_id: str, **values) -> None:
    async with kernel_ctx(app) as ctx:
        repo = ctx.bind(copy.copy_id)
        row = (await ctx.db.scalars(repo.scoped(select(FactRow).where(FactRow.fact_id == fact_id)))).one()
        for name, value in values.items():
            setattr(row, name, value)


async def test_public_desk_serves_only_public_fields(app, client, frozen_clock):
    copy, visitor = await visitor_of(app, client)
    await own_quote(client, visitor)                                     # a session fact, which stays private
    response = await client.get(f"/public/{copy.slug}", params={"lang": "es"})
    assert response.status_code == 200, response.text
    public = PublicDesk.model_validate(response.json())
    assert (public.business_name, public.desk_name, public.owner_display_name, public.brand, public.agent_card) == (
        "Rivera Plumbing", "Main line", "Maria Rivera", {"primary": "#1F4E4A", "accent": "#B87333"}, [])
    assert [(block.template, block.fact_id, block.title, block.lines) for block in public.charter] == [
        ("hours", "charter:hours", "De lunes a viernes, de 8:00 a 18:00", ["Sábado, de 9:00 a 13:00"]),
        ("contact", "charter:contact", "(510) 555-0142", []),
        ("policy", "charter:policy:arrival", "Maria texts before she arrives.", []),
        ("policy", "charter:policy:first_visit",
         "The service call deposit is credited to the repair if you go ahead.", []),
        ("policy", "charter:policy:service_area", "We work in Oakland, Berkeley, Alameda and Emeryville.", []),
    ]
    # no people, contacts on record, prices, quotes or documents
    canaries = [row.canary for row in await rows_of(app, copy.copy_id, select(Document))]
    for private in ("Dana", "Bob", "example.com", "Drain clearing", "180", "Invoice", "Warranty", "quote:",
                    copy.copy_id, copy.desk_id, *canaries):
        assert private not in response.text, private
    # English unless Spanish is asked for
    for params in ({}, {"lang": "fr"}):
        english = PublicDesk.model_validate((await client.get(f"/public/{copy.slug}", params=params)).json())
        assert english.charter[0].title == "Monday to Friday, 8:00 am to 6:00 pm"
    # only public-labelled charter facts, and a Desk without hours makes no hours card
    await change_fact(app, copy, "charter:policy:arrival", readers=["owner"])
    await change_fact(app, copy, "charter:hours", claims=[Claim(key="windows", kind="text", value="[]")])
    trimmed = PublicDesk.model_validate((await client.get(f"/public/{copy.slug}")).json())
    assert [block.fact_id for block in trimmed.charter] == [
        "charter:contact", "charter:policy:first_visit", "charter:policy:service_area"]
    # an unknown or deleted slug is 404
    unknown = await client.get("/public/no-such-desk")
    assert (unknown.status_code, unknown.json()) == (404, {"code": "not_found"})
    async with kernel_ctx(app) as ctx:
        repo = ctx.bind(copy.copy_id)
        desk = (await ctx.db.scalars(repo.scoped(select(Desk).where(Desk.desk_id == copy.desk_id)))).one()
        desk.deleted_at = frozen_clock.now()
    deleted = await client.get(f"/public/{copy.slug}")
    assert (deleted.status_code, deleted.json()) == (404, {"code": "not_found"})
