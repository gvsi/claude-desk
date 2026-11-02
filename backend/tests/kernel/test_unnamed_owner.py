"""The kernel's lines name the business when the owner gave no name (the owner's decision of 2026-11-02).

Setup gives an owner who gave no name its fallback, `OWNER_NAME_FALLBACK` ("Owner"). Every kernel line
that names the owner then names the business instead: "Let me check with Turner Plumbing.", "Checked
against Turner Plumbing's rules", "Turner Plumbing will call you back", "With Turner Plumbing", in English
and Spanish. Only the name changes, never the words, and a named owner's lines are as before word for
word (the tests that pin them name Mike Turner: test_receipts_and_open_now.py, test_handoff_card.py).

The cards are rendered from code-built facts here; the status lines, receipts and cards the kernel sends
run on Turner Plumbing copies as `POST /copies` seeds them, with the owner's name set to the fallback.
"""

import re
from pathlib import Path

import pytest

from desk.contracts import OWNER_NAME_FALLBACK, BusinessToolDef, Claim, Clause, Fact, Label
from desk.kernel_service import render
from desk.kernel_service.render.cards import DeskInfo

from .test_adapters import Rivera, quote_args, visitor_of
from .test_approvals import answered
from .test_decide import decided, set_session
from .test_desk_writes import updated
from .test_execute import executed, read
from .test_link_completion import cancelled_links, lower_the_cap_to_100, rv_link
from .test_owner_messages import sent
from .test_reply_check import checked, clause

TZ = "America/Los_Angeles"
UNNAMED = DeskInfo(owner_display_name=OWNER_NAME_FALLBACK, business_name="Turner Plumbing", timezone=TZ)
# A business tool of each block, whose receipt is its block's line.
BLOCKS = {block: BusinessToolDef(title="Book a consult", description="Take details.", config={"block": block, **config})
          for block, config in {"typed_booking": {"appointment_type": "Consult", "minutes": 20},
                                "intake": {"questions": ["What?"]},
                                "purpose_payment": {"purpose": "Retainer", "amount_cents": 5000},
                                "urgent": {"urgent_when": "A burst pipe"}}.items()}


def fact(fact_id: str, kind: str, status: str, **claims: tuple[str, int | str]) -> Fact:
    return Fact(fact_id=fact_id, kind=kind, status=status, source="kernel", label=Label(readers=["owner"]),
                claims=[Claim(key=key, kind=claim_kind, value=value) for key, (claim_kind, value) in claims.items()])


def card_text(template: str, lang: str, fact: Fact | None = None) -> str:
    return render.render_clause(Clause(template=template, fact_id=fact.fact_id if fact else None), fact, lang,
                                UNNAMED).text


def test_the_handoff_card_names_the_business():
    assert card_text("handoff", "en") == "Let me check with Turner Plumbing.\nTurner Plumbing will reply here."
    assert card_text("handoff", "es") == ("Déjame consultarlo con Turner Plumbing.\n"
                                          "Turner Plumbing te responderá aquí.")


def test_the_handoff_card_keeps_one_full_stop_after_a_name_that_ends_in_one():
    # Owner names hold only letters, but a business name may end in "Inc." or "Co.": the sentence ends on its stop.
    incorporated = DeskInfo(owner_display_name=OWNER_NAME_FALLBACK, business_name="Turner Plumbing, Inc.", timezone=TZ)
    text = {lang: render.render_clause(Clause(template="handoff"), None, lang, incorporated).text for lang in ("en", "es")}
    assert text == {"en": "Let me check with Turner Plumbing, Inc.\nTurner Plumbing, Inc. will reply here.",
                    "es": "Déjame consultarlo con Turner Plumbing, Inc.\nTurner Plumbing, Inc. te responderá aquí."}


def test_the_shown_name_is_the_owners_own_or_the_fallback_without_a_business_name():
    assert render.shown_owner("Mike Turner", "Turner Plumbing") == "Mike Turner"
    assert render.shown_owner(OWNER_NAME_FALLBACK, "Turner Plumbing") == "Turner Plumbing"
    assert render.shown_owner(OWNER_NAME_FALLBACK, "") == OWNER_NAME_FALLBACK


def test_no_kernel_line_takes_the_stored_owner_name_unresolved():
    # Every status line and receipt names the owner through `render.shown_owner` (cards through `DeskInfo.owner`):
    # a caller passing the stored name as it is would bring "Owner" back on a Desk whose owner gave none.
    root = Path(render.__file__).resolve().parent.parent
    raw = re.compile(r"\bowner\s*=\s*(?!(?:render\.)?shown_owner\().*\.owner_display_name\b")
    assert [f"{path.relative_to(root)}:{number}" for path in sorted(root.rglob("*.py"))
            for number, line in enumerate(path.read_text().splitlines(), 1) if raw.search(line)] == []


def test_the_callback_card_names_the_business():
    window = fact("handoff:H-1", "handoff", "committed", window_start=("datetime", "2026-11-06T09:00:00-08:00"),
                  window_end=("datetime", "2026-11-06T11:00:00-08:00"))
    unscheduled = fact("handoff:H-2", "handoff", "committed")
    assert card_text("callback_confirmed", "en", window) == (
        "Turner Plumbing will call you back on Friday, November 6, between 9:00 am and 11:00 am")
    assert card_text("callback_confirmed", "es", window) == (
        "Turner Plumbing te llamará el viernes 6 de noviembre, entre las 9:00 y las 11:00")
    assert card_text("callback_confirmed", "en", unscheduled) == "Turner Plumbing will call you back"
    assert card_text("callback_confirmed", "es", unscheduled) == "Turner Plumbing te llamará"


def test_the_booking_card_names_the_business():
    booking = fact("booking:B-1", "booking", "committed", starts_at=("datetime", "2026-11-06T09:00:00-08:00"),
                   minutes=("text", "60"))
    typed = fact("booking:B-2", "booking", "committed", starts_at=("datetime", "2026-11-06T09:00:00-08:00"),
                 minutes=("text", "60"), appointment_type=("text", "Consult"), appointment_minutes=("text", "20"))
    assert card_text("booking_confirmed", "en", booking) == (
        "Friday, November 6\n9:00 am to 10:00 am\nWith Turner Plumbing")
    assert card_text("booking_confirmed", "es", booking) == "viernes 6 de noviembre\nDe 9:00 a 10:00\nCon Turner Plumbing"
    assert card_text("booking_confirmed", "en", typed) == (
        "Friday, November 6\n“Consult” at 9:00 am\nAbout 20 minutes\nWith Turner Plumbing")
    assert card_text("booking_confirmed", "es", typed) == (
        "viernes 6 de noviembre\n“Consult” a las 9:00\nUnos 20 minutos\nCon Turner Plumbing")


def test_the_cancelled_payment_link_card_names_the_business():
    link = fact("payment_link:L-1", "payment_link", "expired", total=("money", 30_000),
                title=("text", "Water heater flush × 2"))
    assert card_text("link_cancelled", "en", link) == (
        "$300.00\nWater heater flush × 2\nThis payment link was cancelled because Turner Plumbing's rules changed. "
        "Ask again if you still want to pay.")
    assert card_text("link_cancelled", "es", link) == (
        "$300.00\nWater heater flush × 2\nEste enlace de pago se canceló porque cambiaron las reglas de Turner "
        "Plumbing. Pídelo de nuevo si todavía quieres pagar.")


def test_every_status_line_and_receipt_names_the_business():
    owner = render.shown_owner(OWNER_NAME_FALLBACK, "Turner Plumbing")
    for lang in ("en", "es"):
        lines = {key: (template, render.status(key, lang, owner=owner))
                 for key, template in render.LANGUAGES[lang].items()}
        for tool, template in render.EXECUTED[lang].items():
            business = BLOCKS.get(tool)       # a business tool's line is its block's
            lines[tool] = (template, render.executed_status("desk.task" if business else tool, lang, owner=owner,
                                                            business=business))
        assert set(lines) == render.STATUS_KEYS | set(render.EXECUTED[lang])
        for key, (template, line) in lines.items():
            assert "Owner" not in line, (lang, key, line)
            assert ("Turner Plumbing" in line) == ("{owner}" in template), (lang, key, line)
    assert render.status("held", "en", owner=owner) == "Waiting for Turner Plumbing to approve"
    assert render.status("held", "es", owner=owner) == "Esperando la aprobación de Turner Plumbing"
    # a named owner is named as before
    assert render.shown_owner("Mike Turner", "Turner Plumbing") == "Mike Turner"


# ---- What the kernel sends ------------------------------------------------------------------------

async def unnamed(client, copy: Rivera) -> None:
    """The copy's owner, named as setup names an owner who gave no name."""
    await updated(client, copy, "business", {"name": "Turner Plumbing", "owner_display_name": OWNER_NAME_FALLBACK,
                                             "timezone": TZ})


async def test_a_requests_status_lines_and_receipts_name_the_business(app, client, reviewer):
    copy, visitor = await visitor_of(app, client)
    await unnamed(client, copy)
    allowed = await decided(client, visitor, "native.quote", quote_args(("drain", 1)))
    assert allowed.visitor_plain == "Checked against Turner Plumbing's rules"
    await executed(client, visitor, allowed)
    assert (await read(client, visitor.headers, allowed)).visitor_plain == "Quoted from Turner Plumbing's price list"
    held = await decided(client, visitor, "native.quote", quote_args(("drain", 1), discount_bp=8000),
                         call_id="call-held")
    assert held.visitor_plain == "Waiting for Turner Plumbing to approve"
    assert (await checked(client, visitor, "I can help with that.")).ok      # the soft checks read its receipt
    assert reviewer.soft_inputs[-1].cards == [
        "Request receipt card: Quote request: Waiting for Turner Plumbing to approve"]

    # in Spanish once the visitor writes it
    assert (await checked(client, visitor, "Hola, ¿qué tal?")).language == "es"
    allowed = await decided(client, visitor, "native.quote", quote_args(("drain", 1)), call_id="call-es")
    assert allowed.visitor_plain == "Revisado con las reglas de Turner Plumbing"
    await executed(client, visitor, allowed)
    assert (await read(client, visitor.headers, allowed)).visitor_plain == (
        "Cotizado con la lista de precios de Turner Plumbing")
    approved = await answered(client, copy.owner, held.decision_id, "allow_once")
    assert approved.approved.visitor_plain == "Turner Plumbing lo aprobó"
    held = await decided(client, visitor, "native.quote", quote_args(("drain", 1), discount_bp=8000),
                         call_id="call-held-es")
    assert held.visitor_plain == "Esperando la aprobación de Turner Plumbing"
    denied = await answered(client, copy.owner, held.decision_id, "deny_once")
    assert denied.decision.visitor_plain == "Turner Plumbing decidió no seguir adelante"


async def test_an_approved_request_that_ran_reads_the_business_approval_in_its_receipt(app, client, reviewer):
    # The check reads an approved request's receipt as the chat showed it ("Turner Plumbing approved this", then what
    # it did), so a reply saying the business approved it is backed on a Desk whose owner gave no name too.
    from .test_soft_promise import CLEAN, held_quote

    copy, visitor = await visitor_of(app, client)
    await unnamed(client, copy)
    held = await held_quote(client, visitor)
    result = await answered(client, copy.owner, held.decision_id, "allow_once")
    assert result.decision.state == "executed", result
    assert (await checked(client, visitor, CLEAN)).ok
    assert reviewer.soft_inputs[-1].cards == [
        "Request receipt card: Quote request: Turner Plumbing approved this; Quoted from Turner Plumbing's price list"]


async def test_a_replys_receipt_and_the_handoff_card_name_the_business(app, client):
    copy, visitor = await visitor_of(app, client)
    await unnamed(client, copy)
    checked_reply = await checked(client, visitor, "I can help with that.")
    assert checked_reply.visitor_plain == "Reply checked against Turner Plumbing's rules"
    handed = await checked(client, visitor, "", [clause("handoff")])
    assert ([block.text for block in handed.blocks], handed.visitor_plain) == (
        ["Let me check with Turner Plumbing.\nTurner Plumbing will reply here."], "Passed to Turner Plumbing to answer")
    said = (await sent(client, copy, visitor.session_id, "I'll call you within the hour, Sam.")).verdict
    assert said is not None and said.visitor_plain == "Written by Turner Plumbing"

    await set_session(app, copy, visitor.session_id, last_language="es")
    checked_reply = await checked(client, visitor, "Con gusto le ayudo.")
    assert (checked_reply.language, checked_reply.visitor_plain) == (
        "es", "Respuesta revisada con las reglas de Turner Plumbing")
    handed = await checked(client, visitor, "", [clause("handoff")])
    assert ([block.text for block in handed.blocks], handed.visitor_plain) == (
        ["Déjame consultarlo con Turner Plumbing.\nTurner Plumbing te responderá aquí."],
        "Pasado a Turner Plumbing para responder")
    said = (await sent(client, copy, visitor.session_id, "Le llamo en una hora, Sam.")).verdict
    assert said is not None and said.visitor_plain == "Escrito por Turner Plumbing"


@pytest.mark.solver
async def test_a_cancelled_payment_links_card_names_the_business(desk_prove, app, client, reviewer):
    copy, visitor = await visitor_of(app, client)
    await unnamed(client, copy)
    link = await rv_link(app, client, reviewer, copy, visitor, ("heater", 2))           # $300, over the new cap
    version = await lower_the_cap_to_100(client, copy)
    [line] = await cancelled_links(client, copy, version)
    assert (line.link_id, line.verdict.blocks[0].lines) == (link.link_id, [
        "Water heater flush × 2",
        "This payment link was cancelled because Turner Plumbing's rules changed. Ask again if you still want to pay."])
    await set_session(app, copy, visitor.session_id, last_language="es")
    [line] = await cancelled_links(client, copy, version)
    assert line.verdict.blocks[0].lines == [
        "Water heater flush × 2",
        "Este enlace de pago se canceló porque cambiaron las reglas de Turner Plumbing. "
        "Pídelo de nuevo si todavía quieres pagar."]
