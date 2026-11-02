"""The rule Today's Needs you names for a held request ("Held by your rule: …", `NeedsYouItem.held_by`), read as the
API reads it (`owner_reads.needs_you`, over the real `kernel_ro` views) from a decision the real kernel made.

The kernel stores a hold's `card_ids` as every card behind its matching hold permits, sorted by `card_id`
(`decide._card_ids`), so the compiler's default ask for anyone is among them whenever cards for anyone don't cover the
tool, and it can come first. The card the owner reads is the one the decision's own `reason_plain` quotes
(`decide.hold_decider`), never just the first listed.
"""

import httpx
from sqlalchemy.ext.asyncio import create_async_engine

from desk.api import owner_reads
from desk.api.deps import OwnerCtx
from desk.api.kernel_client import KernelHttp
from desk.api.ro import KernelRO
from desk.api.schemas import NeedsYouItem
from desk.db.session import API_CONNECT_OPTIONS, database_url
from desk.kernel_service import seed
from desk.kernel_service.adapters.base import quoted

from .test_adapters import Rivera, rivera
from .test_decide import decided
from .test_payments_adapters import REFUND, person_of, provider_charges
from .test_release_document import DANA, confirmed


async def needs_you_of(app, copy: Rivera) -> list[NeedsYouItem]:
    """The copy's Needs you as the owner's route reads it: the owner context from `GET /whoami` for the owner's token,
    as `deps.owner_context` builds it, over the API's own database login."""
    engine = create_async_engine(database_url("API"), connect_args={"options": API_CONNECT_OPTIONS})
    try:
        async with KernelHttp("http://kernel", transport=httpx.ASGITransport(app)) as kernel, engine.connect() as conn:
            owner = kernel.owner(copy.owner_token)
            who = await owner.whoami()
            ctx = OwnerCtx(copy_id=who.copy_id, desk_ids=tuple(who.desk_ids), owner_session_id=who.session.session_id,
                           owner_generation=who.session.generation, kernel=owner, ro=KernelRO(conn, who.copy_id))
            return await owner_reads.needs_you(ctx, copy.desk_id)
    finally:
        await engine.dispose()


async def test_a_held_refund_names_the_refund_rule_not_the_default_ask(app, client):
    """Verified Dana asks for a refund of her own payment on a new Turner copy: the seed's refund card (an ask card
    for record owners) holds it, and the default ask for anyone matches too, listed first. Needs you names the refund
    card, the rule the decision's account quotes."""
    copy = await rivera(app, client)
    [(drain, _, _), _] = provider_charges(copy, await person_of(app, copy, "dana"))
    dana = await confirmed(client, copy, DANA)
    held = await decided(client, dana, REFUND, {"charge_id": drain})
    [refunds] = [card for card in seed.RIVERA_CARDS if card.card_id == "rv-refund"]
    assert held.outcome == "hold", held.reason_plain
    assert held.card_ids == [f"default:{REFUND}", "rv-refund"]        # the default ask's ID sorts first
    assert f"Your rule asks you first: {quoted(refunds.reason)}" in held.reason_plain

    [item] = [item for item in await needs_you_of(app, copy)
              if item.decision is not None and item.decision.decision_id == held.decision_id]

    assert item.held_by == refunds.reason == "Refunds of a customer's own payment ask you first."


async def test_a_quote_held_past_an_automatic_rules_limit_names_no_rule(app, client):
    """The seed's held quote on a new Turner copy: drain clearing at 15% off, past the list-price quote card (an
    automatic card, `rv-quote`). The decision's headline already quotes that card ("It goes past your rule…"), and the
    card didn't ask for the hold, so Needs you names no rule ("Held by your rule" is left out)."""
    copy = await rivera(app, client)
    [quotes] = [card for card in seed.RIVERA_CARDS if card.card_id == "rv-quote"]
    assert quotes.mode == "auto"

    [item] = [item for item in await needs_you_of(app, copy)
              if item.decision is not None and item.decision.call_id == seed.HELD_REQUEST.call_id]

    assert quoted(quotes.reason) in item.decision.reason_plain
    assert "rv-quote" in item.decision.card_ids
    assert item.held_by is None
