"""The always-on tools: which cards could change them, checked the same way in both processes.

Verification belongs to the always-on baseline: codes go only to the contact on record, and no
rule can make a start ask, hold it or turn it off. The kernel's compiler refuses a card that could
change an always-on tool (`changes_always_on`) as `invalid_cards`, and adds the presets' own card
for it (`ALWAYS_ON_CARDS`) to a set that leaves it out. The API's owner tools (Plan 02b) check
drafted cards with the same function, to name the refused ones to the owner before drafting.

Both processes may import this module, so it imports nothing but `desk.contracts` and
`desk.presets`. Each tool's effects are stated here as data (`ALWAYS_ON_EFFECTS`), and a kernel
test holds them to the effect groups of the Cedar base schema. Cards are ranked by `specificity`,
the one ranking the compiler uses too, so the check and the compiler can't drift apart.
"""

from collections.abc import Mapping
from types import MappingProxyType

from desk.contracts import RuleCard
from desk.presets import PRESETS

# Each always-on tool's effects, as the Cedar base schema's effect groups name them: a card on one
# of them covers the tool too.
ALWAYS_ON_EFFECTS: Mapping[str, frozenset[str]] = MappingProxyType({
    "native.start_verification": frozenset({"send_message"}),
})
ALWAYS_ON_TOOLS: frozenset[str] = frozenset(ALWAYS_ON_EFFECTS)
# The presets' own cards for those tools (auto, for anyone): the always-on behaviour itself, which
# every preset and the seed carry and the API drafts back with the rest.
ALWAYS_ON_CARDS: tuple[RuleCard, ...] = tuple(c for c in PRESETS["ask_first"] if c.applies_to in ALWAYS_ON_TOOLS)


def specificity(card: RuleCard) -> tuple[int, int]:
    """How the compiler ranks a card (master plan, "Coverage and overlap (most specific wins)"):
    `(who is "person" or "agent", applies_to is a tool)`, compared in that order; `(-1, -1)` for a
    default card, which ranks below every card and never excludes or beats one. The compiler's
    `specificity` is this function."""
    if card.is_default:
        return (-1, -1)
    return (int(card.who in ("person", "agent")), int(not card.applies_to.startswith("effect:")))


def same_rule(card: RuleCard, shipped: RuleCard) -> bool:
    """Does `card` match `shipped` on every field but `reason`? The reason is the owner's words,
    which compile to nothing, and a carried card may come back reworded (as
    `desk.money_cap.lower_to_cap` allows)."""
    return card.model_copy(update={"reason": shipped.reason}) == shipped


def changes_always_on(card: RuleCard) -> str | None:
    """The always-on tool (`ALWAYS_ON_TOOLS`) `card` could change, or None. It could change one
    when it is a card on the tool other than the presets' own (`ALWAYS_ON_CARDS`, matched by
    `same_rule`); an `ask` or `never` card on one of its effects (`ALWAYS_ON_EFFECTS`); or an
    `auto` effect card whose specificity (`(who is person or agent, applies_to is a tool)`,
    compared in that order) is at least the presets' card's. So an `auto` effect card for anyone
    passes (as one for verified people or record owners does) and one for a person or an agent is
    refused. A `never` or `ask` effect card would refuse or hold the tool, and an `auto` one that
    outranks the presets' card would replace it for its principals with its own hours and review
    gate; one at the same rank is refused too, to fail closed. With no preset card for the tool,
    every card on one of its effects is refused."""
    effect = card.applies_to.removeprefix("effect:") if card.applies_to.startswith("effect:") else None
    for tool in sorted(ALWAYS_ON_TOOLS):
        shipped = [c for c in ALWAYS_ON_CARDS if c.applies_to == tool]
        if card.applies_to == tool:
            if not any(same_rule(card, c) for c in shipped):
                return tool
        elif effect in ALWAYS_ON_EFFECTS[tool]:
            if card.mode != "auto" or not shipped or any(specificity(card) >= specificity(c) for c in shipped):
                return tool
    return None
