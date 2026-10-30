"""Lowering a Desk's money cap: the active money cards come down to the new cap in the draft.

The money cap is a field of each rules version (master plan, "Money cap"), and every change, up or
down, is a draft the owner confirms. Drafting at a lower cap, the active auto money cards above it
would make the draft fail its own checks, so they come down to the cap in the draft's own cards:
they show in the owner's diff and are validated, compiled and proved like any card, and the draft
is consistent on its own. The money-limit route of the API's owner tools (Plan 02b) drafts a lower
cap from the active cards through `lower_to_cap`; every other draft is at the active version's cap,
which its carried cards already fit.

Which cards the cap bounds is decided here alone (`auto_money`), and the kernel's compiler holds
cards to the cap with this same predicate, so the draft check and the lowering can't drift apart.
Which cards move money at all is `desk.contracts.moves_money`, the one `RuleCard` checks with.

Both processes may import this module, so it imports nothing but `desk.contracts`, like
`desk.presets`.
"""

from collections.abc import Iterable

from desk.contracts import AUTO_MONEY_HARD_CAP_CENTS, RuleCard, moves_money


def auto_money(card: RuleCard) -> bool:
    """Is the card one the money cap bounds: an auto card that takes or pays out money."""
    return card.mode == "auto" and moves_money(card)


def lower_to_cap(cards: Iterable[RuleCard], active: Iterable[RuleCard], cap: int) -> list[RuleCard]:
    """`cards` for a draft at the money cap `cap`, each carried auto money card above it brought
    down to it.

    A carried card is one whose `card_id` is an active card's, matched by ID alone, so a card the
    model re-emits with a reworded `reason` still counts. Each carried auto money card whose
    `max_amount_cents` is above `cap` comes back with `max_amount_cents = cap`, or, when `cap` is
    0, as an `ask` card with the same scope and its auto-only limits dropped. Every other card is
    returned unchanged, so a new card above the cap still fails validation at draft. Raises
    ValueError for a cap that isn't a whole number of cents from 0 to the platform ceiling."""
    if type(cap) is not int or not 0 <= cap <= AUTO_MONEY_HARD_CAP_CENTS:
        raise ValueError("a money cap is a whole number of cents from 0 to the platform ceiling")
    carried = {card.card_id for card in active}
    lowered: list[RuleCard] = []
    for card in cards:
        above = card.max_amount_cents is None or card.max_amount_cents > cap
        if card.card_id not in carried or not auto_money(card) or not above:
            lowered.append(card)
        elif cap == 0:
            lowered.append(RuleCard.model_validate({**card.model_dump(), "mode": "ask", "max_amount_cents": None,
                                                    "max_discount_bp": 0, "hours": None, "review": False}))
        else:
            lowered.append(RuleCard.model_validate({**card.model_dump(), "max_amount_cents": cap}))
    return lowered
