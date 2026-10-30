"""POST /check_reply and GET /public/{desk_slug}: what a visitor may be shown.

A draft from Claude is guarded prose plus typed clauses. The kernel scans the prose in English and
Spanish for numbers, money, percentages, dates, promise words and links, renders each clause from
a fact the session may read, in the reply's language, and answers with a signed, ledgered verdict:
the prose and cards when everything passed, else only the handoff clause.

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
from .test_decide import PASS, Visitor, decided, desk_with, open_visitor, set_mode, set_session
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


AMOUNT_AND_TIME_WORDS = [   # (prose, rule_id, span): amounts, fractions, "free" and near times in other words
    ("It costs zero for the visit.", "lex.en.number", "zero"),
    ("La visita cuesta cero.", "lex.es.number", "cero"),
    ("The visit is a quarter off for you.", "lex.en.number", "quarter"),       # a fraction
    ("Maria can come at a quarter past.", "lex.en.number", "quarter"),         # a time, blocked as well
    ("That leaves a couple of quarters.", "lex.en.number", "quarters"),
    ("Le hacemos un cuarto menos.", "lex.es.number", "cuarto"),
    ("Le rebajamos una cuarta parte.", "lex.es.number", "cuarta"),
    ("I can take a third off the drain clearing.", "lex.en.number", "third"),
    ("You can pay it in thirds.", "lex.en.number", "thirds"),
    ("Le quito un tercio del precio.", "lex.es.number", "tercio"),
    ("Se puede pagar en tercios.", "lex.es.number", "tercios"),
    ("Le rebajo una tercera parte.", "lex.es.number", "tercera parte"),
    ("That comes to a couple grand.", "lex.en.money", "grand"),
    ("Eso sale en un par de miles.", "lex.es.number", "miles"),                 # Spanish says "mil", held already
    ("It is on us this time.", "lex.en.promise", "on us"),
    ("This one's on us.", "lex.en.promise", "on us"),
    ("La visita corre por nuestra cuenta.", "lex.es.promise", "por nuestra cuenta"),
    ("Esta va por cuenta de la casa.", "lex.es.promise", "por cuenta de la casa"),   # "on the house"
    ("There is no fee for the visit.", "lex.en.promise", "no fee"),
    ("There are no hidden fees.", "lex.en.promise", "no hidden fees"),
    ("There's no call-out fee.", "lex.en.promise", "no call-out fee"),
    ("La visita va sin comisión.", "lex.es.promise", "sin comisión"),
    ("Sin ninguna comisión por la visita.", "lex.es.promise", "Sin ninguna comisión"),
    ("Maria can be there in an hour.", "lex.en.date", "in an hour"),
    ("She can be there in a few minutes.", "lex.en.date", "in a few minutes"),
    ("Maria can come in a couple of hours.", "lex.en.date", "in a couple of hours"),
    ("Maria can be there in under an hour.", "lex.en.date", "in under an hour"),
    ("She can be there within the hour.", "lex.en.date", "within the hour"),
    ("She'll be there in minutes.", "lex.en.date", "in minutes"),
    ("Maria llega en una hora.", "lex.es.date", "en una hora"),
    ("Llega en unos pocos minutos.", "lex.es.date", "en unos pocos minutos"),
    ("Maria llega dentro de un par de horas.", "lex.es.date", "dentro de un par de horas"),
    ("Maria llega en media hora.", "lex.es.date", "en media hora"),
    ("Maria can come right away.", "lex.en.date", "right away"),
    ("Maria va enseguida.", "lex.es.date", "enseguida"),
    ("Maria sale en seguida.", "lex.es.date", "en seguida"),
    ("She can come first thing in the morning.", "lex.en.date", "first thing in the morning"),
    ("Maria can be there first thing.", "lex.en.date", "first thing"),
    ("She can be there the first thing in the morning.", "lex.en.date", "first thing in the morning"),
    ("Maria llega a primera hora.", "lex.es.date", "a primera hora"),
    # the ordinals and fractions the evals read as a date or an amount ("on the fifth", "a fifth off")
    ("I can take a fifth off the price.", "lex.en.number", "fifth"),
    ("That is a tenth of the price.", "lex.en.number", "tenth"),
    ("See you on the twelfth.", "lex.en.number", "twelfth"),
    ("Come by Nov. fourth.", "lex.en.number", "fourth"),
    ("Maria can come on the nineteenth.", "lex.en.number", "nineteenth"),
    ("We can do it on the twentieth.", "lex.en.number", "twentieth"),
    ("Le quito un quinto del precio.", "lex.es.number", "quinto"),
    ("Le rebajo una décima parte.", "lex.es.number", "décima"),
    ("Le rebajo dos décimos.", "lex.es.number", "dos"),             # the plural, by its number word
    ("Le hago un octavo menos.", "lex.es.number", "octavo"),
    ("Le quito un sétimo.", "lex.es.number", "sétimo"),
    ("Nos vemos el mes que viene.", "lex.es.date", "el mes que viene"),
]


@pytest.mark.parametrize(("prose", "rule_id", "span"), AMOUNT_AND_TIME_WORDS)
def test_amount_and_time_words_are_blocked(prose, rule_id, span):
    """Amounts, fractions, a price of nothing and a time soon, in words the first lexicons lacked,
    in English and Spanish: each is the one violation its rule finds."""
    kind = reply_check.CATEGORIES[rule_id.rsplit(".", 1)[1]]
    assert [(v.kind, v.rule_id, v.span) for v in reply_check.scan_prose(prose)] == [(kind, rule_id, span)]


@pytest.mark.parametrize("prose", [
    "You can count on us.",                                 # "on us" after count, rely or depend
    "You can always rely on us for repairs.",
    "It depends on us getting a look at it.",
    "The first thing to do is turn off the water.",         # "first thing" after a determiner is advice
    "Your first thing to check is the valve under the sink.",
    "Lo primero es cerrar la llave del agua.",
    "First, let me check with Maria.",                      # "first" and "second" are no fraction or day
    "One second, please.",
    "Un segundo, por favor.",
    "Le decimos qué opciones hay.",                         # "decimos" (we tell) is no "décimos"
])
def test_ordinary_words_beside_the_amount_and_time_words_pass(prose):
    assert reply_check.scan_prose(prose) == []


@pytest.mark.parametrize(("prose", "found"), [
    ("It costs zеro.", [("lex.en.number", "zеro"), ("mixed_script", "zеro")]),         # Cyrillic e
    ("Le hacemos un cuаrto menos.", [("lex.es.number", "cuаrto"), ("mixed_script", "cuаrto")]),
    ("It is оn us.", [("lex.en.promise", "оn us"), ("mixed_script", "оn")]),             # Cyrillic o
    ("Maria can be there ın an hour.", [("lex.en.date", "ın an hour")]),                    # dotless i
    ("Va sin comisiоn.", [("lex.es.promise", "sin comisiоn"), ("mixed_script", "comisiоn")]),
    ("Maria can come RIGHT AWAY.", [("lex.en.date", "RIGHT AWAY")]),
    ("That comes to a couple GRAND.", [("lex.en.money", "GRAND")]),
])
def test_amount_and_time_words_read_lookalike_letters(prose, found):
    """Letters of another script that look like Latin ones, and capitals, are read as the words
    they spell (and a word mixing scripts is blocked on its own)."""
    assert [(v.rule_id, v.span) for v in reply_check.scan_prose(prose)] == found


async def test_a_fraction_beside_its_quote_is_blocked(app, client, reviewer):
    """"A quarter off" beside the quote card it describes is blocked by the prose scan, before the
    soft-promise check is asked."""
    copy, visitor = await visitor_of(app, client)
    quote = await own_quote(client, visitor)
    reviewer.soft_answer = NOTHING_FLAGGED
    verdict = await checked(client, visitor, "That's a quarter off.", [clause("quote", quote.fact_id)])
    assert [(v.kind, v.rule_id, v.span) for v in verdict.violations] == [("number_in_prose", "lex.en.number",
                                                                          "quarter")]
    assert_handed_off(verdict)
    assert reviewer.soft_inputs == []


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
    ("booking-confirmed", "lex.en.booking"), ("we-have-you-booked", "lex.en.booking"),
    ("reserva-confirmada", "lex.es.booking"), ("quedó-apartado", "lex.es.booking"),
    ("on-us", "lex.en.promise"), ("no-call-out-fee", "lex.en.promise"), ("in-a-few-minutes", "lex.en.date"),
    ("right-away", "lex.en.date"), ("first-thing-in-the-morning", "lex.en.date"),
    ("por-nuestra-cuenta", "lex.es.promise"), ("por-cuenta-de-la-casa", "lex.es.promise"),
    ("sin-comisión", "lex.es.promise"), ("en-una-hora", "lex.es.date"), ("dentro-de-unos-minutos", "lex.es.date"),
    ("en-seguida", "lex.es.date"), ("a-primera-hora", "lex.es.date"), ("tercera-parte", "lex.es.number"),
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
    for booked in (f"You{apostrophe}re booked", f"It{apostrophe}s all booked", f"The spot{apostrophe}s been set"):
        found = reply_check.scan_prose(f"{booked}.")
        assert [(v.rule_id, v.span) for v in found] == [("lex.en.booking", reply_check.shown(booked))], booked
    for prose in (f"It{apostrophe}s on us.", f"This one{apostrophe}s on us."):
        assert [(v.rule_id, v.span) for v in reply_check.scan_prose(prose)] == [("lex.en.promise", "on us")], prose
    found = reply_check.scan_prose(f"She{apostrophe}ll be there in a few minutes.")
    assert [(v.rule_id, v.span) for v in found] == [("lex.en.date", "in a few minutes")]


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


async def test_a_card_citing_the_catalog_backs_nothing(app, client):
    # the catalog is a fact every session reads (`/context`), checked like any other citation; no
    # template renders it, so it backs no card and no price
    copy, visitor = await visitor_of(app, client)
    for template in ("quote", "policy", "hours", "contact", "booking_options", "booking_confirmed"):
        verdict = await checked(client, visitor, "Here is what we do.", [clause(template, "catalog")])
        assert [(v.kind, v.rule_id, v.fact_ids) for v in verdict.violations] == [
            ("unknown_fact", "template_mismatch", ["catalog"])], template
        assert_handed_off(verdict)
    assert {entry.event.summary["rule_ids"][0] for entry in await reply_entries(app, copy)} == {"template_mismatch"}
    # a Desk that sells nothing has no catalog to cite
    rows = await desk_with(app, [], [])
    stranger = await open_visitor(client, rows)
    verdict = await checked(client, stranger, "Here is what we do.", [clause("quote", "catalog")])
    assert [(v.kind, v.rule_id, v.fact_ids) for v in verdict.violations] == [
        ("unknown_fact", "no_such_fact", ["catalog"])]


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


@pytest.mark.parametrize(("prose", "rule_ids"), [
    ("Perfecto, ya lo reviso.", []),
    ("Claro, enseguida lo reviso.", ["lex.es.date"]),                  # "enseguida" is a time: in Spanish now
    ("Tu cita está confirmada.", ["lex.es.booking"]),                  # a booking claim: in Spanish now
    ("Maria te escribe antes de llegar.", []),
    ("Listo, quedó anotado para ti.", []),
    ("Listo, quedó apartado para ti.", ["lex.es.booking"]),             # a booking claim: in Spanish now
    ("Perfecto, lo anoto.", []),
    ("Listo, ya quedó anotado.", []),
    ("Claro, lo vemos juntos.", []),
    ("Estás en buenas manos.", []),
    ("Te escribo al terminar.", []),
])
async def test_short_spanish_replies_read_as_spanish(app, client, prose, rule_ids):
    # a first reply, so there is no last language to fall back on: words that only Spanish
    # writes this way ("ya", "lo", "te", "está", "quedó") keep it Spanish, never another language
    copy, visitor = await visitor_of(app, client)
    assert lang.detect(prose) == "es"
    verdict = await checked(client, visitor, prose)
    assert [v.rule_id for v in verdict.violations] == rule_ids
    if rule_ids:
        assert_handed_off(verdict, "es")                                # the handoff speaks Spanish too
    else:
        assert (verdict.ok, verdict.language, verdict.blocks) == (True, "es", [RenderedBlock(kind="prose", text=prose)])
    assert (await session_of(app, copy, visitor)).last_language == "es"


@pytest.mark.parametrize("prose", [
    "Je te rappelle demain.",                       # French "te" and "tu" are Spanish markers now
    "Tu peux me dire quand?",
    "Merci, je vérifie pour toi.",
    "Je te dis ça tout à l'heure.",
    "Está tudo certo, já vou ver.",                 # Portuguese shares "está", "te", "ti" and "claro"
    "Perfeito, já está anotado.",
    "Vou verificar isso para você.",                # "para" and "por" stay unmarked: Portuguese writes them too
    "Obrigada por esperar.",
    "Certo, lo controllo subito.",                  # Italian shares "lo", "ti", "del" and "al"
    "Perfetto, ti scrivo dopo.",
    "Va bene, ci penso io.",
    "Te aviso assim que souber.",                   # a tie with Spanish goes to the other language
    "Grazie per la pazienza.",
])
def test_other_languages_outweigh_the_words_spanish_shares(prose):
    # their own markers decide, so they hand off on a first reply too
    assert lang.detect(prose) == "other"


@pytest.mark.parametrize("prose", [
    "Don't pour grease down the drain.",            # "pour" and "et" mark no other language
    "Don't pour it.",
    "We fix sinks, tubs, et cetera.",
])
async def test_plumbing_english_with_a_dropped_word_reads_as_english(app, client, prose):
    copy, visitor = await visitor_of(app, client)
    assert lang.detect(prose) == "en"
    verdict = await checked(client, visitor, prose)
    assert (verdict.ok, verdict.language, verdict.blocks) == (True, "en", [RenderedBlock(kind="prose", text=prose)])
    assert (await session_of(app, copy, visitor)).last_language == "en"


@pytest.mark.parametrize("prose", [
    "It's non-toxic.",                              # "non" stays an Italian marker
    "Sure, ciao!",                                  # "ciao" stays one too
    "Ciao, I'm on it.",                             # "i" and "on" count for English, "it" ties "ciao"
])
async def test_a_tie_with_english_reads_as_english(app, client, prose):
    # another language must outnumber English's markers to hand off, so one word it shares with
    # English can't outvote one English word on a first reply; a tie with Spanish still hands off
    copy, visitor = await visitor_of(app, client)
    assert lang.detect(prose) == "en"
    verdict = await checked(client, visitor, prose)
    assert (verdict.ok, verdict.language, verdict.blocks) == (True, "en", [RenderedBlock(kind="prose", text=prose)])
    assert (await session_of(app, copy, visitor)).last_language == "en"


@pytest.mark.parametrize("prose", [
    "On vient à dix heures.",                       # French writes "on": a time in its own words
    "On passe demain.",
    "On fait ça pour trente.",                      # a price in its own words
    "Le but est de venir demain.",                  # and "but" ("goal")
    "Ich komme am Montag.",                         # German writes "am", "in", "an", "was", "will", "also"
    "Ich bin in zehn Minuten da.",
    "Wir sind am Montag da.",
    "Ich will morgen kommen.",
    "Was machen wir morgen?",
    "Ich rufe an.",
    "Also, ich komme um zehn.",
    "Wir kommen morgen her.",                       # and "her" (hither)
    "I tecnici arrivano subito.",                   # Italian writes "i" and "in"
    "Arrivo in un'ora, grazie.",
    "Il tecnico arriva all'una.",                   # and "all", as "all'" ("at one o'clock")
    "Se for urgente, vou às dez.",                  # Portuguese writes "for" ("se for", "if it is")
])
async def test_english_markers_another_language_writes_dont_outvote_it(app, client, prose):
    # "on", "in", "an", "am", "was", "will", "i", "also", "her", "all", "for" and "but" are English
    # markers that French, German, Italian or Portuguese write as their own, so they don't count
    # against that language: one of its own markers still hands off on a first reply, and a time, a
    # day or a price in its words never rests on the model check alone
    copy, visitor = await visitor_of(app, client)
    assert lang.detect(prose) == "other"
    verdict = await checked(client, visitor, prose)
    assert [(v.kind, v.rule_id) for v in verdict.violations] == [("unsupported_language", "language")]
    assert_handed_off(verdict, "en")
    assert (await session_of(app, copy, visitor)).last_language is None


@pytest.mark.parametrize(("prose", "language"), [
    ("Nos das un momento?", "es"),                  # Spanish writes "das" (dar) and "des"
    ("No me des tu número.", "es"),
    ("Cubrimos la zona sur.", "es"),                # "sur" (south)
    ("Une los tubos.", "es"),                       # "une" (unir)
    ("Pela el cable.", "es"),                       # "pela" (pelar)
    ("Pode las ramas secas.", "es"),                # "pode" (podar)
    ("Che, te aviso.", "es"),                       # "che", as Argentina and Uruguay write it
    ("Pour it, et cetera.", "en"),                  # English writes "pour" and "et cetera"
    ("Swap the EU SIM.", "en"),                     # "EU" and "SIM"
    ("Times are EST, et cetera.", "en"),            # "EST"
])
async def test_words_english_or_spanish_write_mark_no_other_language(app, client, prose, language):
    # no other-language marker is a word English or Spanish writes, so these, where it would tie
    # with Spanish or outnumber English, read as their own language on a first reply
    copy, visitor = await visitor_of(app, client)
    assert lang.detect(prose) == language
    verdict = await checked(client, visitor, prose)
    assert (verdict.ok, verdict.language, verdict.blocks) == (True, language,
                                                              [RenderedBlock(kind="prose", text=prose)])
    assert (await session_of(app, copy, visitor)).last_language == language


@pytest.mark.parametrize("prose", [
    "Pour slowly.",
    "Et cetera.",
    "EST hours.",
    "EU plugs.",
    "SIM swaps.",
])
def test_a_dropped_english_word_alone_is_too_little_to_tell(prose):
    # one word English writes and no marker of any language, so if that word marked another
    # language again it would outnumber English's markers and hand off
    assert lang.detect(prose) == "none"


@pytest.mark.parametrize("prose", [
    "Avoid pouring grease down drains.",
    "Clean up spills quickly.",
    "Clear out drains regularly.",
    "Turn everything off quickly.",
    "Rinse, then dry thoroughly.",
    "Everything looks fine now.",
    "Wait until Maria arrives.",
    "Rinse pipes after cleaning.",
    "Shut valves before leaving.",
    "Faster than expected, honestly.",
    "Maria checks heaters too.",
])
async def test_frequent_english_words_keep_plumbing_english_english(app, client, prose):
    # four or more words with no marker of any language hand off; one frequent English word
    # neither other list holds ("down", "up", "out", "off", "then", "now", "until", "after",
    # "before", "than", "too") makes these English, on a first reply too
    copy, visitor = await visitor_of(app, client)
    assert lang.detect(prose) == "en"
    verdict = await checked(client, visitor, prose)
    assert (verdict.ok, verdict.language, verdict.blocks) == (True, "en", [RenderedBlock(kind="prose", text=prose)])
    assert (await session_of(app, copy, visitor)).last_language == "en"


@pytest.mark.parametrize("prose", [
    "Entendido, revisamos ambos grifos.",           # Spanish in words no list holds hands off too
    "Por favor, me diga o endereço.",               # Portuguese with no Portuguese marker
    "O técnico chega às dez, combinado?",           # a time in words neither lexicon reads
    "Harganya lima puluh ribu rupiah saja.",        # a price in a language no list covers
])
async def test_an_unmarked_reply_hands_off_on_a_first_reply_too(app, client, prose):
    # four or more words and no marker of any language are another language whether or not the
    # session has a language yet, so a time or a price in words no lexicon reads never reaches the
    # visitor on the model check alone; the handoff is in the session's last language, else English
    copy, visitor = await visitor_of(app, client)
    verdict = await checked(client, visitor, prose)
    assert [(v.kind, v.rule_id) for v in verdict.violations] == [("unsupported_language", "language")]
    assert_handed_off(verdict, "en")
    assert (await session_of(app, copy, visitor)).last_language is None
    assert (await checked(client, visitor, "Con gusto le ayudo.")).language == "es"
    verdict = await checked(client, visitor, prose)
    assert [(v.kind, v.rule_id) for v in verdict.violations] == [("unsupported_language", "language")]
    assert_handed_off(verdict, "es")
    assert (await session_of(app, copy, visitor)).last_language == "es"
    assert lang.detect(prose) == "other"


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


# The soft-promise check flagging nothing, so a block below is the code's own.
NOTHING_FLAGGED = SoftPromiseVerdict(prose_states_terms=False, denies_being_ai=False)


async def test_a_booking_claim_beside_its_card_is_blocked(app, client, reviewer):
    """A booking appears only in its card: "You're booked." is blocked even beside the booking card
    it repeats, by the prose scan, before the soft-promise check is asked."""
    copy, visitor = await visitor_of(app, client)
    booking = await own_booking(client, reviewer, visitor)
    reviewer.soft_answer = NOTHING_FLAGGED
    verdict = await checked(client, visitor, "You're booked.", [clause("booking_confirmed", booking.fact_id)])
    assert [(v.kind, v.rule_id, v.span) for v in verdict.violations] == [
        ("promise_word", "lex.en.booking", "You're booked")]
    assert_handed_off(verdict)
    assert reviewer.soft_inputs == []


async def test_a_reply_naming_only_the_card_passes(app, client, reviewer):
    """Prose that points at the booking card, and claims nothing itself, is shown with it."""
    copy, visitor = await visitor_of(app, client)
    booking = await own_booking(client, reviewer, visitor)
    reviewer.soft_answer = NOTHING_FLAGGED
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
    ("Your appointment's confirmed.", "lex.en.booking", "Your appointment's confirmed"),
    ("Your booking’s confirmed.", "lex.en.booking", "Your booking’s confirmed"),
    ("Your visit's been scheduled.", "lex.en.booking", "Your visit's been scheduled"),
    ("Your next appointment is confirmed.", "lex.en.booking", "Your next appointment is confirmed"),
    # a claim's parts, whatever the phrasing: the nouns, participles, verbs and determiners
    ("Your reservation is confirmed.", "lex.en.booking", "Your reservation is confirmed"),
    ("Your slot is booked.", "lex.en.booking", "Your slot is booked"),
    ("Your time slot is reserved.", "lex.en.booking", "Your time slot is reserved"),
    ("The spot's been set.", "lex.en.booking", "The spot's been set"),
    ("Your appointment was scheduled.", "lex.en.booking", "Your appointment was scheduled"),
    ("Both your visits are booked.", "lex.en.booking", "your visits are booked"),
    ("Reservation's confirmed.", "lex.en.booking", "Reservation's confirmed"),       # no determiner
    ("Ana's visit is confirmed.", "lex.en.booking", "Ana's visit is confirmed"),     # a possessive
    ("Your service call is booked.", "lex.en.booking", "Your service call is booked"),   # anything of yours
    ("It's booked.", "lex.en.booking", "It's booked"),
    ("It's all booked.", "lex.en.booking", "It's all booked"),
    ("That's confirmed.", "lex.en.booking", "That's confirmed"),
    ("Everything is set.", "lex.en.booking", "Everything is set"),
    ("Everything's been reserved.", "lex.en.booking", "Everything's been reserved"),
    ("You're reserved for that time.", "lex.en.booking", "You're reserved"),
    ("You were booked with Maria.", "lex.en.booking", "You were booked"),
    ("We have you booked.", "lex.en.booking", "We have you booked"),
    ("We've got you down for that time.", "lex.en.booking", "We've got you down"),
    ("I've got you all set.", "lex.en.booking", "I've got you all set"),
    ("Booked you in.", "lex.en.booking", "Booked you"),                               # no subject
    ("Maria booked you with her crew.", "lex.en.booking", "booked you"),
    ("I've reserved the slot for you.", "lex.en.booking", "I've reserved the slot"),
    ("I reserved your visit.", "lex.en.booking", "I reserved your visit"),
    ("We've reserved a time slot for you.", "lex.en.booking", "We've reserved a time slot"),
    ("We reserved it.", "lex.en.booking", "We reserved it"),
    ("She's confirmed your reservation.", "lex.en.booking", "She's confirmed your reservation"),
    ("Booking confirmed.", "lex.en.booking", "Booking confirmed"),                    # the headline
    ("Great, appointment booked!", "lex.en.booking", "appointment booked"),
    ("Visit: scheduled.", "lex.en.booking", "Visit: scheduled"),
    ("All booked.", "lex.en.booking", "All booked"),
    ("Done, all confirmed.", "lex.en.booking", "all confirmed"),
    ("Tu cita está confirmada.", "lex.es.booking", "Tu cita está confirmada"),
    ("Su visita queda agendada.", "lex.es.booking", "Su visita queda agendada"),
    ("Su reserva ya está confirmada.", "lex.es.booking", "Su reserva ya está confirmada"),
    ("La cita ha quedado reservada.", "lex.es.booking", "La cita ha quedado reservada"),
    ("Su cita quedó confirmada.", "lex.es.booking", "Su cita quedó confirmada"),
    ("Ya quedó agendada.", "lex.es.booking", "Ya quedó agendada"),
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
    ("La suya está confirmada.", "lex.es.booking", "está confirmada"),                # a word ending in "ya"
    ("Sí, la suya está confirmada.", "lex.es.booking", "está confirmada"),
    ("La tuya ya está confirmada.", "lex.es.booking", "ya está confirmada"),
    ("La cita suya está confirmada.", "lex.es.booking", "está confirmada"),
    ("Bueno, la suya quedó agendada.", "lex.es.booking", "quedó agendada"),
    ("Ya ya está confirmada.", "lex.es.booking", "ya está confirmada"),               # "ya" twice
    ("Tu cita fue confirmada.", "lex.es.booking", "Tu cita fue confirmada"),
    ("Su reserva quedó hecha.", "lex.es.booking", "Su reserva quedó hecha"),
    ("Su turno quedó reservado.", "lex.es.booking", "Su turno quedó reservado"),
    ("Tu hora está apartada.", "lex.es.booking", "Tu hora está apartada"),
    ("La visita ha sido agendada.", "lex.es.booking", "La visita ha sido agendada"),
    ("Las citas están confirmadas.", "lex.es.booking", "Las citas están confirmadas"),     # plural
    ("Sus visitas ya fueron reservadas.", "lex.es.booking", "Sus visitas ya fueron reservadas"),
    ("Listo, quedó apartado para ti.", "lex.es.booking", "quedó apartado"),
    ("Queda confirmada la cita.", "lex.es.booking", "Queda confirmada"),              # the verb first
    ("Fue agendada con Maria.", "lex.es.booking", "Fue agendada"),
    ("Quedaste agendado.", "lex.es.booking", "Quedaste agendado"),
    ("Reserva confirmada.", "lex.es.booking", "Reserva confirmada"),                  # the headline
    ("Cita agendada.", "lex.es.booking", "Cita agendada"),
    ("¡Listo! Turno reservado.", "lex.es.booking", "Turno reservado"),
    ("Visita: confirmada.", "lex.es.booking", "Visita: confirmada"),
    ("Perfecto, reserva hecha.", "lex.es.booking", "reserva hecha"),
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
    found = [(v.rule_id, v.span) for v in reply_check.scan_prose("Іt's booked.")]     # a Cyrillic I, a stroke
    assert found == [("lex.en.booking", "Іt's booked"), ("mixed_script", "Іt")]
    found = [(v.rule_id, v.span) for v in reply_check.scan_prose("Rеserva confirmada.")]   # Cyrillic e
    assert found == [("lex.es.booking", "Rеserva confirmada"), ("mixed_script", "Rеserva")]


@pytest.mark.parametrize("prose", [
    "Once you're booked, Maria will text you.",
    "When your visit is confirmed, you'll get a message.",
    "If you're booked already, I can look it up.",
    "IF YOU'RE BOOKED, MARIA WILL CALL.",                   # a capital I is read as l too
    "As soon as you are scheduled, Maria will reach out.",
    "After we've booked you, Maria will reach out.",
    "Until your appointment is confirmed, the time isn't held.",
    "When your next appointment's confirmed, Maria will text you.",
    "Cuando tu cita esté confirmada, te escribimos.",
    "Cuando tu cita está confirmada, Maria te escribe.",
    "Cuando tu cita ya está confirmada, Maria te escribe.",
    "Cuando su próxima cita está confirmada, le llega un mensaje.",   # a word between, a claim inside
    "Si tu nueva visita está agendada, Maria le avisa.",
    "Cuando una cita está confirmada, Maria lo anota.",
    "Si ya está confirmada, Maria le avisa.",
    "SI YA ESTÁ CONFIRMADA, MARIA LE AVISA.",
    "Una vez que su reserva queda confirmada, le llega un mensaje.",
    "Once it's booked, Maria will text you.",
    "When your reservation is confirmed, you'll get a message.",
    "If we have you booked already, I can look it up.",
    "Until everything is set, the time isn't held.",
    "After I've reserved the slot, Maria will call.",
    "After I've booked you, Maria will reach out.",
    "AFTER I'VE BOOKED YOU, MARIA WILL CALL.",              # "I" read as l is still the subject
    "Cuando su cita fue confirmada, le llegó un mensaje.",
    "Cuando las citas están confirmadas, Maria las anota.",
    "Si quedó apartado, Maria le avisa.",
    "Una vez que la reserva está hecha, le llega un mensaje.",
])
def test_a_condition_before_a_booking_claim_passes(prose):
    """A condition straight before the claim says what happens once a booking exists, which claims
    none: "once you're booked", "cuando tu cita esté confirmada"."""
    assert reply_check.scan_prose(prose) == []


@pytest.mark.parametrize("prose", [
    "Is your booking confirmed?",                       # no form of "be" before the participle
    "Most visits are booked a day ahead.",              # a word straight before the noun
    "All scheduled visits include a call ahead.",       # "all" before a booking noun
    "All set, I've passed your message on.",            # "all set" says something is done
    "Have you booked it yet?",                          # "booked it" with no subject
    "I've confirmed it's in our service area.",         # the object starts a clause of its own
    "Maria confirmed you're in our service area.",
    "Para dejar una cita confirmada, necesito su dirección.",   # the participle describes the noun
    "El tubo está hecho de cobre.",                     # "hecho" counts only after a booking noun
    "La reparación ya está hecha.",
])
def test_replies_using_the_booking_words_otherwise_pass(prose):
    """The booking lines are written from a claim's parts, so the same words in another order or
    sense claim nothing and pass."""
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
    reviewer.soft_answer = NOTHING_FLAGGED
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
    reviewer.soft_answer = NOTHING_FLAGGED
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
    await change_fact(app, copy, "charter:contact", claims=[
        {"key": "contact", "kind": "text", "value": "Text the shop line and Maria calls back."}])
    await change_fact(app, copy, "charter:policy:arrival", readers=["owner"])
    for prose in ("Maria texts before she arrives.", "Just text the shop line and Maria calls back."):
        assert (await checked(client, visitor, prose)).violations == [], prose
    assert not reply_check.states_rule("contact")


@pytest.mark.parametrize(("prose", "span", "language"), [
    ("Pay for it at rivera-pay.example/checkout", "rivera-pay.example/checkout", "en"),
    ("Email maria@riverapl.example to confirm.", "maria@riverapl.example", "en"),
    ("Pague en rivera-pay.example/checkout antes de la visita.", "rivera-pay.example/checkout", "es"),
    ("Escríbale a maria@riverapl.example para confirmar la visita.", "maria@riverapl.example", "es"),
    ("Pay for it at…rivera-pay.example/checkout", "at...rivera-pay.example/checkout", "en"),
    ("Pague en…rivera-pay.example/checkout antes de la visita.", "en...rivera-pay.example/checkout", "es"),
])
async def test_a_link_beside_a_quote_card_is_blocked(app, client, reviewer, prose, span, language):
    """A link or an email address reaches a visitor only on a card (a payment or document card's
    `href`, the contact clause), so prose holding one is blocked even beside the quote it is about,
    by the prose scan, before the soft-promise check is asked; the ledger names the rule, never
    the link."""
    copy, visitor = await visitor_of(app, client)
    quote = await own_quote(client, visitor)
    reviewer.soft_answer = NOTHING_FLAGGED
    verdict = await checked(client, visitor, prose, [clause("quote", quote.fact_id)])
    assert [(v.kind, v.rule_id, v.span) for v in verdict.violations] == [("promise_word", "link", span)]
    assert_handed_off(verdict, language)
    assert reviewer.soft_inputs == []
    [entry] = await reply_entries(app, copy)
    assert (entry.event.summary["violations"], entry.event.summary["rule_ids"]) == (["promise_word"], ["link"])
    assert span not in json.dumps(entry.event.summary)


LINK_TLDS = ["com", "net", "org", "io", "co", "us", "app", "dev", "info", "biz", "mx", "es", "example"]


@pytest.mark.parametrize(("prose", "span"), [
    ("Open https://riverapl to pay.", "https://riverapl"),                        # a scheme
    ("Open http://localhost/pay to finish.", "http://localhost/pay"),
    ("Try ftp://riverapl/files for the photos.", "ftp://riverapl/files"),          # any scheme before "://"
    ("Open https:riverapl.shop to pay.", "https:riverapl.shop"),                  # no slashes, as browsers take it
    ("Open mailto:riverapl to write to Maria.", "mailto:riverapl"),
    ("Tap tel:riveraplumbing to call Maria.", "tel:riveraplumbing"),
    ("See www.riveraplumbing.shop for photos.", "www.riveraplumbing.shop"),      # www.
    ("Maria's page is rivera.shop/maria.", "rivera.shop/maria"),                  # a domain before a path
    ("Find us at riveraplumbing.com.", "riveraplumbing.com"),                     # a bare domain
    ("Find us at riverapl.co.uk as well.", "riverapl.co.uk"),
    ("FIND US AT RIVERAPL.COM", "RIVERAPL.COM"),
    ("Reach her at maria@rivera.", "maria@rivera"),                               # an @ between word characters
    ("Write to mailto:maria@riverapl.example.", "mailto:maria@riverapl.example"),   # several shapes, one link
    ("(See https://rivera-pay.example/checkout?visit=next.)", "https://rivera-pay.example/checkout?visi"),   # cut to 40
    ("Pague en https://rivera-pay.example/checkout antes de la visita.", "https://rivera-pay.example/checkout"),
    ("Visite www.riverapl.mx para ver fotos.", "www.riverapl.mx"),
    ("Estamos en riverapl.es, con fotos.", "riverapl.es"),
    ("¿Ya vio riverapl.org?", "riverapl.org"),
    ("Lo tiene en «riverapl.com/visitas».", "riverapl.com/visitas"),
    ("Llame a tel:riverapl desde su teléfono.", "tel:riverapl"),
    ("Escriba a maria.rivera@riverapl.example y se lo confirmamos.", "maria.rivera@riverapl.example"),
    ("Hola a tod@s, gracias por escribir.", "tod@s"),                               # fails closed: a cost
    *((f"Find us at riverapl.{tld} any time.", f"riverapl.{tld}") for tld in LINK_TLDS),
    # an ellipsis, dots, a dash, a hyphen or an underscore glued to the front of a domain, or an
    # underscore after it (NFKC writes "…" as "...", and every reading writes a dash as "-")
    ("Pay for it at…rivera-pay.example/checkout", "at...rivera-pay.example/checkout"),
    ("Pay for it at...rivera-pay.example/checkout", "at...rivera-pay.example/checkout"),
    ("Find us at…riverapl.com", "at...riverapl.com"),
    ("Pay at .rivera-pay.example/checkout", ".rivera-pay.example/checkout"),
    ("Pay at —rivera-pay.example/checkout", "—rivera-pay.example/checkout"),
    ("Photos: —www.riverapl.shop", "—www.riverapl.shop"),
    ("Pay at -riverapl.com", "-riverapl.com"),
    ("Pay at _rivera-pay.example/checkout_", "_rivera-pay.example/checkout_"),
    ("Find us at _riverapl.com_ any time.", "_riverapl.com_"),
    ("Find us at riverapl.com_ now", "riverapl.com_"),
    ("Email maria@-riverapl.example now", "maria@-riverapl.example"),
    ("Open _https:riverapl.shop_ to pay.", "_https:riverapl.shop_"),
    ("Pague en…rivera-pay.example/checkout antes de la visita.", "en...rivera-pay.example/checkout"),
    ("Pague en...rivera-pay.example/checkout antes de la visita.", "en...rivera-pay.example/checkout"),
    ("Estamos en…riverapl.es, con fotos.", "en...riverapl.es"),
    ("Pague en .rivera-pay.example/checkout antes de la visita.", ".rivera-pay.example/checkout"),
    ("Pague en —rivera-pay.example/checkout antes de la visita.", "—rivera-pay.example/checkout"),
    ("Fotos: —www.riverapl.mx", "—www.riverapl.mx"),
    ("Estamos en -riverapl.es, con fotos.", "-riverapl.es"),
    ("Pague en _rivera-pay.example/checkout_ antes de la visita.", "_rivera-pay.example/checkout_"),
    ("Estamos en _riverapl.es_ con fotos.", "_riverapl.es_"),
    ("Estamos en riverapl.es_ con fotos.", "riverapl.es_"),
    ("Escriba a maria@-riverapl.example y se lo confirmamos.", "maria@-riverapl.example"),
])
def test_links_and_email_addresses_in_prose_are_blocked(prose, span):
    """A URL scheme, "www.", a domain before a path, a bare domain ending in a common top-level
    domain and an "@" between word characters are each a link in prose, in English and Spanish,
    whatever dots, dashes or underscores are glued to them: one violation for each run of text
    between blanks, spanning it without the punctuation around it."""
    assert [(v.kind, v.rule_id, v.span) for v in reply_check.scan_prose(prose)] == [("promise_word", "link", span)]


def test_each_link_in_a_reply_is_one_violation():
    found = reply_check.scan_prose("Pay at riverapl.com/pay or write to maria@riverapl.example.")
    assert [(v.rule_id, v.span) for v in found] == [("link", "riverapl.com/pay"), ("link", "maria@riverapl.example")]


@pytest.mark.parametrize("prose", [
    "Maria can look at a few options, e.g. a new valve.",
    "Turn off the main valve, i.e. the one under the sink.",
    "Thanks. Maria will call you back.",                    # a sentence's full stop
    "That's all... Maria will call you back.",
    "Mr. Rivera and Dr. Lee are both on the job.",
    "Maria fixes drains and/or water heaters.",
    "Maria works across the U.S. and the whole bay.",
    "Maria is @ the shop right now.",                       # an "@" between blanks
    "Hotel: the one by the station.",                       # "tel:" inside a word
    "Gracias. Maria le llama de vuelta.",
    "Puede ser una llave nueva, p.ej. la de paso.",
    "Hay talleres en EE.UU. y en México.",
    "Maria fixes drains—and water heaters…and sinks.",   # dashes, ellipses and underscores glued on
    "Turn off the valve —i.e. the one under the sink.",
    "Wait...e.g. the valve under the sink.",
    "_Maria_ will call you back about the __valve__.",
    "Maria arregla desagües—y calentadores…y lavabos.",
    "Cierre la llave —p.ej. la de paso.",
])
def test_ordinary_dots_and_signs_are_no_link(prose):
    assert reply_check.scan_prose(prose) == []


@pytest.mark.parametrize(("prose", "found"), [
    ("Find us at riverapl.\u0441\u043em.", [("link", "riverapl.\u0441\u043em"), ("mixed_script", "\u0441\u043em")]),
    ("See \u051d\u051d\u051d.riverapl.shop for photos.", [("link", "\u051d\u051d\u051d.riverapl.shop")]),   # Cyrillic we
    ("Find us at riverapl.\u0131o now.", [("link", "riverapl.\u0131o")]),                       # a dotless i
    ("See \uff57\uff57\uff57\uff0eriverapl\uff0eshop for photos.", [("link", "www.riverapl.shop")]),   # full width
    ("Pay at rivera-pay\u3002example/checkout before the visit.", [("link", "rivera-pay\u3002example/checkout")]),
    ("Pay at rivera.shop\u2044checkout before the visit.", [("link", "rivera.shop\u2044checkout")]),   # a fraction slash
    ("Pay at rivera.shop\u2215checkout before the visit.", [("link", "rivera.shop\u2215checkout")]),   # a division slash
    ("Try ftp:\u2044\u2044riverapl/files for the photos.", [("link", "ftp:\u2044\u2044riverapl/files")]),   # in "://"
    ("Pay at rivera-pay.ex\u200bample/checkout first.", [("link", "rivera-pay.example/checkout")]),   # a zero-width space
    ("Pay at rivera\u2010pay.example/checkout first.", [("link", "rivera\u2010pay.example/checkout")]),   # a Unicode hyphen
    ("Email maria\uff20riverapl.example to confirm.", [("link", "maria@riverapl.example")]),   # a full-width @
    ("Email maria\ufe6briverapl.example to confirm.", [("link", "maria@riverapl.example")]),   # a small @
])
def test_links_read_lookalikes(prose, found):
    """A link written with letters of another script that look like Latin ones, with full-width
    characters, an ideographic full stop for a dot, a fraction or division slash for a slash, or an
    invisible character inside, is a link too (and a word mixing scripts is blocked on its own)."""
    assert [(v.rule_id, v.span) for v in reply_check.scan_prose(prose)] == found


def test_a_long_draft_of_near_links_is_scanned_in_one_pass():
    """Long words, dotted runs and many links in one run of text are read in one pass: a domain is
    looked for only where no letter, digit, dot or hyphen comes before it, and the links in one run
    of text are one violation."""
    started = time.perf_counter()
    found = reply_check.scan_prose("x" * 40_000 + " " + "a." * 20_000 + " " + "rivera.pay.section " * 2_000
                                   + "a.b/" * 10_000)
    assert time.perf_counter() - started < 2
    assert [(v.rule_id, v.span) for v in found] == [("link", ("a.b/" * 10)[:40])]


def test_a_m_and_p_m_are_no_link():
    """"a.m." and "p.m." are time words, never a domain: each is the date word alone."""
    found = reply_check.scan_prose("Maria takes calls in the a.m./p.m. hours.")
    assert [(v.rule_id, v.span) for v in found] == [("lex.en.date", "a.m."), ("lex.en.date", "p.m.")]


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
