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

import desk_kernel
import httpx
import pytest
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from fastapi import FastAPI
from sqlalchemy import select

from desk.contracts import CardOption, Claim, Fact, RenderedBlock, ReplyVerdict
from desk.db.models import ActorSession, Desk, Document
from desk.db.models import Fact as FactRow
from desk.kernel_api import PublicDesk
from desk.kernel_service import lang, ledger

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
                                   "violations": [], "rule_ids": [], "fact_ids": [quote.fact_id], "soft_promise": None}
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
])
async def test_numbers_and_dates_in_prose_are_blocked(app, client, prose, rule_ids, span):
    copy, visitor = await visitor_of(app, client)
    verdict = await checked(client, visitor, prose)
    assert "number_in_prose" in kinds_of(verdict) and rule_ids <= rule_ids_of(verdict), verdict.violations
    numbers = [violation for violation in verdict.violations if violation.kind == "number_in_prose"]
    assert span in [violation.span for violation in numbers]
    assert all(len(violation.span) <= 40 for violation in verdict.violations)
    assert_handed_off(verdict, "es" if prose == "nos vemos el martes" else "en")


@pytest.mark.parametrize(("prose", "rule_id", "span", "language"), [
    ("I guarantee it.", "lex.en.promise", "guarantee", "en"),
    ("That part is free.", "lex.en.promise", "free", "en"),
    ("Eso es gratis.", "lex.es.promise", "gratis", "es"),
    ("Le prometo.", "lex.es.promise", "prometo", "en"),      # too few words to tell: English
])
async def test_promise_words_are_blocked(app, client, prose, rule_id, span, language):
    copy, visitor = await visitor_of(app, client)
    verdict = await checked(client, visitor, prose)
    assert [(v.kind, v.rule_id, v.span) for v in verdict.violations] == [("promise_word", rule_id, span)]
    assert_handed_off(verdict, language)


@pytest.mark.parametrize(("prose", "language"), [
    ("I can help with that. Which day works for you?", "en"),
    ("Con gusto le ayudo. ¿Qué día le viene bien?", "es"),
    ("You may want to turn off the water.", "en"),          # the modal, not the month
    ("Feel free to ask me anything.", "en"),                # free, not a price
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
