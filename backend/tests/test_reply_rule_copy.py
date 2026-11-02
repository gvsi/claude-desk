"""What the kernel's soft checks are shown, and the owner's explanations of the rule IDs their result
path emits."""

from types import SimpleNamespace
from typing import get_args
from unittest.mock import AsyncMock

import pytest

from desk.api.owner_reads import REPLY_WHY_BY_RULE, reply_reason
from desk.contracts import ClauseTemplate, RenderedBlock
from desk.kernel_service import jev, render, reply_check
from desk.kernel_service.adapters import payment_link, release_document  # noqa: F401 -- register link templates
from desk.kernel_service.decisions import SoftPromiseInput, SoftPromiseVerdict


def stub_ctx(soft_promise: AsyncMock) -> SimpleNamespace:
    """A kernel context with only what `soft_promises` reads: the Sonnet check, a Jev key and a Desk."""
    return SimpleNamespace(decisions=SimpleNamespace(soft_promise=soft_promise),
                           settings=SimpleNamespace(typesafe_api_key="fake-key"),
                           repo=SimpleNamespace(scoped=lambda query: query),
                           db=SimpleNamespace(scalars=AsyncMock(return_value=SimpleNamespace(one=lambda: None))))


def test_every_card_template_has_a_label_for_the_soft_checks():
    """Each card reaches the soft checks named by its kind (the owner's decision of 2026-11-01), so
    every template the kernel registers, and every one the contract lists, has a fixed label: a new
    template without one fails here."""
    assert set(render.CHECK_LABELS) == set(render.TEMPLATES) == set(get_args(ClauseTemplate))
    assert all(label.strip() == label and label for label in render.CHECK_LABELS.values())


def test_a_request_receipt_reaches_the_soft_checks_with_a_label_no_card_has():
    """The session's request receipts aren't templates: held or resolved, they share one English label of
    their own, which no card's label shares, then what was asked for, in the reply's language, so a Spanish
    reply about another request reads as one. While the request is held, a fixed note in that language
    follows its status line: the card states only this request's status, nothing about another, nor whether
    or when the owner will answer. A request the owner answered, or that closed or ran, has no such note,
    since he has answered or it no longer waits for him."""
    assert render.RECEIPT_LABEL == "Request receipt"
    assert render.RECEIPT_LABEL not in render.CHECK_LABELS.values()
    assert render.receipt_check_text("native.quote", "Waiting for Mike Turner to approve", "en", held=True) == (
        "Request receipt card: Quote request: Waiting for Mike Turner to approve (this card states only this quote"
        " request's status; it says nothing about any other request, or whether or when the owner will answer)")
    assert render.receipt_check_text("native.quote", "Esperando la aprobación de Mike Turner", "es", held=True) == (
        "Request receipt card: Solicitud de presupuesto: Esperando la aprobación de Mike Turner (esta tarjeta solo"
        " indica el estado de esta solicitud de presupuesto; no dice nada de otras solicitudes, ni si el dueño"
        " responderá ni cuándo)")
    assert render.receipt_check_text("native.quote", "Mike Turner decided not to go ahead", "en", held=False) == (
        "Request receipt card: Quote request: Mike Turner decided not to go ahead")
    assert render.receipt_check_text("block:intake", "Cancelado", "es", held=False) == (
        "Request receipt card: Solicitud de datos: Cancelado")


def test_every_tool_and_business_block_a_decision_can_hold_has_a_receipt_subject():
    """Any enabled tool can be held (the compiler's default ask covers every tool no card for anyone does), so
    every native and payments tool, and every business tool's block (`block:<name>`), names what was asked
    for in each language: a new one without a subject fails here (until it has one, its receipts back
    nothing)."""
    from desk.contracts import BlockConfig, ToolName

    blocks = {get_args(config.model_fields["block"].annotation)[0] for config in get_args(get_args(BlockConfig)[0])}
    asked = set(get_args(ToolName)) | {f"block:{block}" for block in blocks}
    assert set(render.RECEIPT_SUBJECTS) == {"en", "es"}
    assert all(set(subjects) == asked for subjects in render.RECEIPT_SUBJECTS.values())
    assert all(subject.strip() == subject and subject for subjects in render.RECEIPT_SUBJECTS.values()
               for subject in subjects.values())
    assert [render.RECEIPT_SUBJECTS["en"][tool] for tool in (
        "native.quote", "native.book", "native.payment_link", "native.release_document", "payments.create_refund",
        "payments.list_charges")] == [
        "Quote request", "Booking request", "Payment link request", "Document request", "Refund request",
        "Payment history request"]
    assert [render.RECEIPT_SUBJECTS["es"][tool] for tool in (
        "native.quote", "native.book", "native.payment_link", "native.release_document", "payments.create_refund",
        "payments.list_charges")] == [
        "Solicitud de presupuesto", "Solicitud de reserva", "Solicitud de enlace de pago", "Solicitud de documento",
        "Solicitud de reembolso", "Solicitud de historial de pagos"]


async def test_both_soft_checkers_read_the_receipts_after_the_cards(monkeypatch):
    """Sonnet and Jev are shown one list: the reply's cards, each with its kind, then the receipts as given."""
    soft_promise = AsyncMock(return_value=(SoftPromiseVerdict(promises_beyond_cards=False, denies_being_ai=False),
                                           None))
    evaluate = AsyncMock(return_value=jev.Result(status="ok", scores=dict.fromkeys(jev.STATEMENTS, 0.0),
                                                 blocked=False))
    monkeypatch.setattr(reply_check.context, "resolved_tools", AsyncMock(return_value=[]))
    monkeypatch.setattr(reply_check, "principal_for", lambda session: None)
    monkeypatch.setattr(jev, "evaluate", evaluate)
    prose = "Your request is with Mike Turner now."
    receipts = ["Request receipt card: Quote request: Waiting for Mike Turner to approve",
                "Request receipt card: Quote request: Cancelled"]

    await reply_check.soft_promises(stub_ctx(soft_promise), SimpleNamespace(desk_id="desk"), "en", prose,
                                    DEPOSIT_CARDS[:1], receipts=receipts)

    seen = ["Quote card: $20.00\nService call deposit\nGood until Monday, November 2, 9:04 am", *receipts]
    soft_promise.assert_awaited_once_with(SoftPromiseInput(language="en", prose=prose, cards=seen))
    evaluate.assert_awaited_once_with(prose, seen, [], api_key="fake-key")


# A live deposit reply's cards: the quote, its payment link and a policy, as the kernel renders them.
DEPOSIT_CARDS = [
    RenderedBlock(kind="card", template="quote",
                  text="$20.00\nService call deposit\nGood until Monday, November 2, 9:04 am"),
    RenderedBlock(kind="card", template="payment_link", text="Service call deposit, $20.00"),
    RenderedBlock(kind="card", template="policy", text="We work in Oakland, Berkeley, Alameda and Emeryville."),
]


@pytest.mark.parametrize(("language", "prose"), [("en", "Here's the quote and the link to pay."),
                                                 ("es", "Aquí tiene el presupuesto y el enlace para pagar.")])
async def test_both_soft_checkers_read_each_card_with_its_kind(language, prose, monkeypatch):
    """The owner's decision of 2026-11-01: a card's text alone ("Service call deposit, $20.00") doesn't
    say it is a payment link, so an honest "here's the link to pay" read as a promise no card backed.
    Each card goes to Sonnet and to Jev as its kind's fixed English label, whatever the reply's
    language, then its text, and both checkers are shown the same list."""
    soft_promise = AsyncMock(return_value=(SoftPromiseVerdict(promises_beyond_cards=False, denies_being_ai=False),
                                           None))
    evaluate = AsyncMock(return_value=jev.Result(status="ok", scores=dict.fromkeys(jev.STATEMENTS, 0.0),
                                                 blocked=False))
    monkeypatch.setattr(reply_check.context, "resolved_tools", AsyncMock(return_value=[]))
    monkeypatch.setattr(reply_check, "principal_for", lambda session: None)
    monkeypatch.setattr(jev, "evaluate", evaluate)

    violations, _, _ = await reply_check.soft_promises(stub_ctx(soft_promise), SimpleNamespace(desk_id="desk"),
                                                       language, prose, DEPOSIT_CARDS)

    labelled = ["Quote card: $20.00\nService call deposit\nGood until Monday, November 2, 9:04 am",
                "Payment link card: Service call deposit, $20.00",
                "Policy card: We work in Oakland, Berkeley, Alameda and Emeryville."]
    soft_promise.assert_awaited_once_with(SoftPromiseInput(language=language, prose=prose, cards=labelled))
    evaluate.assert_awaited_once_with(prose, labelled, [], api_key="fake-key")
    assert violations == []


@pytest.mark.parametrize(("verdict", "jev_blocked", "found"), [
    pytest.param(None, False, [("check_unavailable", "soft.unavailable")], id="unavailable"),
    pytest.param(SoftPromiseVerdict(promises_beyond_cards=False, denies_being_ai=True), False,
                 [("soft_promise", "soft.denies_ai")], id="denies-ai"),
    pytest.param(SoftPromiseVerdict(promises_beyond_cards=False, denies_being_ai=False), True,
                 [("soft_promise", "soft.jev")], id="jev"),
])
async def test_owner_copy_covers_the_kernels_soft_check_rule_ids(verdict, jev_blocked, found, monkeypatch):
    """One Sonnet try (no recheck): the kernel asks the model once, with no per-try timeout of its own."""
    soft_promise = AsyncMock(return_value=(verdict, None))
    ctx = stub_ctx(soft_promise)
    monkeypatch.setattr(reply_check.context, "resolved_tools", AsyncMock(return_value=[]))
    monkeypatch.setattr(reply_check, "principal_for", lambda session: None)
    scores = dict.fromkeys(jev.STATEMENTS, 0.0)
    scores["owner_promised"] = 0.95 if jev_blocked else 0.0
    monkeypatch.setattr(jev, "evaluate", AsyncMock(return_value=jev.Result(status="ok", scores=scores,
                                                                          blocked=jev_blocked)))
    prose = "Here is the information."

    violations, usage, record = await reply_check.soft_promises(ctx, SimpleNamespace(desk_id="desk"), "en", prose, [])

    soft_promise.assert_awaited_once_with(SoftPromiseInput(language="en", prose=prose, cards=[]))
    assert usage is None
    assert [(violation.kind, violation.rule_id) for violation in violations] == found
    assert {violation.rule_id for violation in violations} <= REPLY_WHY_BY_RULE.keys()
    if jev_blocked:
        assert REPLY_WHY_BY_RULE["soft.jev"] == "a second check flagged a promise the business's records don't back"


def test_both_promise_checkers_have_one_owner_explanation():
    assert reply_reason([("soft_promise", "soft.promise"), ("soft_promise", "soft.jev")]) == (
        "A reply was stopped before it was shown, because it made a promise the rules don't back.")
    assert reply_reason([("soft_promise", "soft.jev")]) == (
        "A reply was stopped before it was shown, because "
        "a second check flagged a promise the business's records don't back.")
