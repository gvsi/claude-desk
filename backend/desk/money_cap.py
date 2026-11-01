"""Lowering a Desk's money cap: the active money cards come down to the new cap in the draft.

The money cap is a field of each rules version (master plan, "Money cap"), and every change, up or
down, is a draft the owner confirms. Drafting at a lower cap, the active auto money cards above it
would make the draft fail its own checks, so they come down to the cap in the draft's own cards:
they show in the owner's diff and are validated, compiled and proved like any card, and the draft
is consistent on its own. The money-limit route of the API's owner tools (Plan 02b) drafts a lower
cap from the active cards through `lower_to_cap`; every other draft is at the active version's cap,
which its carried cards already fit.

A lowered card's reason is replaced whole by a sentence this module builds from the new limit
(`LOWERED_REASONS`), in the language the owner reads the rules in, so a card never keeps words
that quote its old amount. The caller names that language; it is never read from a model.

Which cards the cap bounds is decided here alone (`auto_money`), and the kernel's compiler holds
cards to the cap with this same predicate, so the draft check and the lowering can't drift apart.
Which cards move money at all is `desk.contracts.moves_money`, the one `RuleCard` checks with.

Both processes may import this module, so it imports nothing but `desk.contracts`, like
`desk.presets`.
"""

from collections.abc import Collection, Iterable, Mapping
from types import MappingProxyType
from typing import Literal

from desk.contracts import AUTO_MONEY_HARD_CAP_CENTS, RuleCard, moves_money

Language = Literal["en", "es"]
# A lowered card's reason, by language: above 0 the card takes or pays out up to the new limit on its own; at 0 it
# asks instead. `{amount}` is the limit as `amount` writes it.
LOWERED_REASONS: Mapping[str, str] = MappingProxyType({
    "en": "Up to {amount}, your payment limit.",
    "es": "Hasta {amount}, tu límite de pago.",
})
ZERO_REASONS: Mapping[str, str] = MappingProxyType({
    "en": "Your payment limit is {amount}.",
    "es": "Tu límite de pago es {amount}.",
})


def amount(cents: int) -> str:
    """A limit as the owner reads it, in either language: "$1,500" for whole dollars, with thousands separators,
    and cents only when there are some ("$100.50")."""
    dollars, rest = divmod(cents, 100)
    return f"${dollars:,}" + (f".{rest:02d}" if rest else "")


def lowered_reason(cap: int, language: Language) -> str:
    """The reason of a card lowered to the money cap `cap`, in `language`."""
    return (LOWERED_REASONS if cap else ZERO_REASONS)[language].format(amount=amount(cap))


def auto_money(card: RuleCard, money_tools: Collection[str] = frozenset()) -> bool:
    """An auto money card; callers supply the Desk's money tool names for business targets."""
    return card.mode == "auto" and moves_money(card, money_tools)


def lower_to_cap(cards: Iterable[RuleCard], active: Iterable[RuleCard], cap: int,
                 language: Language, *, money_tools: Collection[str] = frozenset()) -> list[RuleCard]:
    """`cards` for a draft at the money cap `cap`, each carried auto money card above it brought
    down to it, its reason stating the new limit in `language`.

    `money_tools` names the Desk's tools whose profiles take or pay out money, including business tools.
    A carried card is one whose `card_id` is an active card's, matched by ID alone, so a card the
    model re-emits with a reworded `reason` still counts. Each carried auto money card whose
    `max_amount_cents` is above `cap` comes back with `max_amount_cents = cap`, or, when `cap` is
    0, as an `ask` card with the same scope and its auto-only limits dropped; either way its
    `reason` is replaced whole by `lowered_reason`. Every other card is returned unchanged, reason
    included, so a new card above the cap still fails validation at draft. Raises ValueError for a
    cap that isn't a whole number of cents from 0 to the platform ceiling, or a language other than
    "en" or "es"."""
    if type(cap) is not int or not 0 <= cap <= AUTO_MONEY_HARD_CAP_CENTS:
        raise ValueError("a money cap is a whole number of cents from 0 to the platform ceiling")
    if not isinstance(language, str) or language not in LOWERED_REASONS:
        raise ValueError('a lowered card\'s reason is written in "en" or "es"')
    reason = lowered_reason(cap, language)
    carried = {card.card_id for card in active}
    lowered: list[RuleCard] = []
    for card in cards:
        above = card.max_amount_cents is None or card.max_amount_cents > cap
        if card.card_id not in carried or not auto_money(card, money_tools) or not above:
            lowered.append(card)
        elif cap == 0:
            lowered.append(RuleCard.model_validate({**card.model_dump(), "mode": "ask", "max_amount_cents": None,
                                                    "max_discount_bp": 0, "hours": None, "review": False,
                                                    "reason": reason}))
        else:
            lowered.append(RuleCard.model_validate({**card.model_dump(), "max_amount_cents": cap, "reason": reason}))
    return lowered
