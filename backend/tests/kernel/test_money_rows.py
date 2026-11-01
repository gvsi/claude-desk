"""The money rows of the master plan's rule-card cases, end to end on payment links and refunds.

Each test drafts and confirms its cards on a Turner Plumbing copy (at the seed's $500 money cap), as
the owner app does, then asks `/decide` for a link to a quote the visitor just got, or for a refund of
one of the visitor's own past payments: the cards compile to Cedar by code, prove, activate, and
decide the call as they would any request. A link's amount is its quote's, so each test prices the
quote it needs from the seed's price list (deposit $20, heater flush $150, leak repair $250); a
refund's is the charge's, as the mock payments provider records it. Every test proves a draft, so
needs the solver (`solver`).
"""

import pytest
from fastapi import FastAPI
from sqlalchemy import select

from desk.contracts import RuleCard
from desk.db.models import Person

from .helpers import draft_and_confirm, rows_of
from .test_adapters import Rivera, rivera
from .test_decide import decided, open_visitor
from .test_payment_links import QUOTES, link_for, quoted
from .test_payments_adapters import REFUND, seed_charge
from .test_release_document import BOB, DANA, confirmed

pytestmark = pytest.mark.solver


def charges(mode: str, cents: int | None = None) -> RuleCard:
    return RuleCard(card_id=f"charges-{mode}", applies_to="effect:charge", mode=mode, who="anyone",
                    max_amount_cents=cents, reason="Charges for anyone.")


def dana_links(dana_id: str, cents: int) -> RuleCard:
    return RuleCard(card_id="dana-links", applies_to="native.payment_link", mode="auto", who="person",
                    person_id=dana_id, max_amount_cents=cents, reason="Dana's payment links.")


async def dana_of(app: FastAPI, copy: Rivera) -> str:
    [dana] = await rows_of(app, copy.copy_id, select(Person.person_id).where(Person.ref == "dana"))
    return dana


async def test_charge_ask_with_person_auto_link(desk_prove, app, client):
    copy = await rivera(app, client)
    await draft_and_confirm(client, copy.owner_token, copy.desk_id,
                            [QUOTES, charges("ask"), dana_links(await dana_of(app, copy), 10_000)])
    dana, bob = await confirmed(client, copy, DANA), await confirmed(client, copy, BOB)
    allowed = await link_for(client, dana, await quoted(client, dana, ("deposit", 4)))          # $80
    assert (allowed.outcome, allowed.card_ids) == ("allow", ["dana-links"]), allowed.reason_plain
    held = await link_for(client, bob, await quoted(client, bob, ("deposit", 4)))
    assert (held.outcome, held.card_ids) == ("hold", ["charges-ask"]), held.reason_plain


async def test_effect_auto_100_with_dana_link_auto_20(desk_prove, app, client):
    copy = await rivera(app, client)
    await draft_and_confirm(client, copy.owner_token, copy.desk_id,
                            [QUOTES, charges("auto", 10_000), dana_links(await dana_of(app, copy), 2_000)])
    dana, stranger = await confirmed(client, copy, DANA), await open_visitor(client, copy)
    # Dana's own card is the narrower one, so her $80 link isn't auto-allowed by the wider one: it holds
    held = await link_for(client, dana, await quoted(client, dana, ("deposit", 4)))
    assert held.outcome == "hold" and "dana-links" in held.card_ids, held.reason_plain
    allowed = await link_for(client, stranger, await quoted(client, stranger, ("deposit", 4)))
    assert (allowed.outcome, allowed.card_ids) == ("allow", ["charges-auto"]), allowed.reason_plain


async def test_money_without_a_card_holds(desk_prove, app, client):
    copy = await rivera(app, client)
    version = await draft_and_confirm(client, copy.owner_token, copy.desk_id, [QUOTES])
    # the proof shows no auto rule lets a link through without a card that covers it
    assert {check.name: check.ok for check in version.proof.checks}["money_needs_card"] is True
    visitor = await open_visitor(client, copy)
    held = await link_for(client, visitor, await quoted(client, visitor, ("deposit", 1)))
    assert (held.outcome, held.card_ids) == ("hold", ["default:native.payment_link"]), held.reason_plain


async def test_eight_hundred_dollar_link_offers_no_allow_person(desk_prove, app, client):
    copy = await rivera(app, client)
    await draft_and_confirm(client, copy.owner_token, copy.desk_id, [QUOTES, charges("auto", 10_000)])
    dana = await confirmed(client, copy, DANA)
    # a $300 link Dana can't have automatically may still be allowed for her from now on, within the
    # $500 money cap; an $800 one can't, so the owner isn't offered it. Both are the auto card's limit
    # holds, not an ask card's, so neither offers deny_always (`decide.held_by_ask`)
    within = await link_for(client, dana, await quoted(client, dana, ("heater", 2)), call_id="call-300")
    assert (within.outcome, within.answers) == ("hold", ["allow_once", "deny_once", "allow_person"])
    above = await link_for(client, dana, await quoted(client, dana, ("leak", 2), ("heater", 2), call_id="call-q2"),
                           call_id="call-800")
    assert above.action.amount_cents == 80_000
    assert (above.outcome, above.answers) == ("hold", ["allow_once", "deny_once"]), above.reason_plain


@pytest.mark.parametrize(("cents", "outcome"), [(40_000, "hold"), (4_000, "allow")])
async def test_joint_pay_out_and_private_data_hold_a_large_refund(desk_prove, app, client, cents, outcome):
    copy = await rivera(app, client)
    # a refund pays money out of a customer's private record, so it is auto-allowed only where a card
    # for each of its effects allows it: refunds up to $50 for anyone, private data for verified people
    await draft_and_confirm(client, copy.owner_token, copy.desk_id, [
        RuleCard(card_id="pay-out-50", applies_to="effect:pay_out", mode="auto", who="anyone", max_amount_cents=5_000,
                 reason="Money paid back, up to $50."),
        RuleCard(card_id="private-verified", applies_to="effect:private_data", mode="auto", who="verified",
                 reason="Private data for verified people.")])
    charge_id = await seed_charge(app, copy, await dana_of(app, copy), cents, "Kitchen faucet")
    dana = await confirmed(client, copy, DANA)
    decided_refund = await decided(client, dana, REFUND, {"charge_id": charge_id})
    assert decided_refund.action.amount_cents == cents
    assert decided_refund.outcome == outcome, decided_refund.reason_plain
    # both cards decide it together: within both, allowed; above the $50, the owner is asked
    assert {"pay-out-50", "private-verified"} <= set(decided_refund.card_ids), decided_refund.card_ids
