"""The reference generator: what the owner's cards allow, derived a second time.

The proofs `auto_within_cards` and `hold_within_cards` (and the bounded check that stands in for
them) compare the compiled sets with these, so a compiler that emits Cedar wider than the owner's
cards is caught. That only works if the two are written apart: this module imports nothing from
`compiler.py`, reads which tools exist and what effects they carry from the Desk's schema
(`memberOf`), and derives coverage, joint coverage and the default asks on its own, from the
master plan's "Coverage and overlap (most specific wins)":

- A tool card covers its tool. An ask or never effect card covers every tool with its effect. An
  auto effect card covers a tool only as part of a joint combination: one auto effect card per
  effect of the tool, all at one specificity (for a one-effect tool, each such card alone). An
  auto unit is an auto tool card alone or such a combination; its `who` is all its cards' `who`.
- Specificity, compared in order: person-scoped (`person`, `agent`) beats the rest, then a tool
  card beats an effect card. A default ask ranks below every card.
- An auto unit `u` wins a request when it matches (covers the tool, and its `who` holds) within
  its limits and nothing in `Beats(u)` matches: every non-default card or auto unit of higher
  specificity, and every non-default ask card at the same specificity.
- Every tool that cards for `anyone` don't cover (alone or jointly, in any mode) gets a default
  ask for anyone.

The output:

- `never`: one forbid per never card over the tools it covers.
- `R`: one permit per auto unit, `when { <who> && <limits> && !(<a beater matches> || ...) }`:
  no `unless`, and no review condition, since the reviewer may only narrow what the cards allow.
- `R_hold`: one permit per ask card (defaults included) and per auto unit, with scope and `who`
  only: whatever a card would allow within its limits, or asks for, the owner may approve.

Limits read optional attributes in the same guarded forms the compiler uses, which strict
validation accepts: `(if context has x then context.x <= N else true)`, and on money tools the
strict `context has amount_cents && context.amount_cents <= N` capped at
`AUTO_MONEY_HARD_CAP_CENTS`. Every policy carries `@id`, `@card`, `@tier` and `@applies_to`.
"""

import itertools
import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import time
from typing import Any

from desk.contracts import AUTO_MONEY_HARD_CAP_CENTS, RuleCard, money_tool

# Every string written into Cedar (card IDs, tool and effect names, person IDs, agent key IDs)
# matches this, so none can end a string literal or carry Cedar syntax.
_SAFE = re.compile(r"[A-Za-z0-9._:-]{1,80}")
_DAYS = {"mon": 0, "tue": 1, "wed": 2, "thu": 3, "fri": 4, "sat": 5, "sun": 6}
_MAX_LONG = 2**63 - 1
_DEFAULT_REASON = "Not covered by a rule yet, so it asks you."


@dataclass(frozen=True)
class RefSets:
    """The reference's Cedar texts: `never` (the never cards' forbids), `R` (one permit per auto
    card or joint combination, exclusions written out) and `R_hold` (one permit per ask card,
    defaults included, and per auto card or combination, with scope and `who` only)."""

    never: str
    R: str
    R_hold: str


def schema_tools(schema: Mapping[str, Any]) -> dict[str, frozenset[str]]:
    """Each tool the schema declares (an action with `appliesTo`) and the effects its `memberOf`
    names (`effect:<e>` groups). A schema with a namespace other than the empty one is refused:
    tools are named without one."""
    if set(schema) != {""}:
        raise ValueError("the Desk's schema has exactly the empty namespace")
    tools: dict[str, frozenset[str]] = {}
    for name, action in schema[""].get("actions", {}).items():
        if not isinstance(action, Mapping) or "appliesTo" not in action:
            continue                                    # an effect group, not a tool
        groups = [member.get("id", "") for member in action.get("memberOf", [])
                  if member.get("type", "Action") == "Action"]
        tools[_safe(name)] = frozenset(group.removeprefix("effect:") for group in groups if group.startswith("effect:"))
    return tools


def reference_sets(cards: Iterable[RuleCard], schema: Mapping[str, Any]) -> RefSets:
    """The reference sets for the owner's `cards` over every tool `schema` declares. Defaults in
    `cards` are dropped and derived again. Raises ValueError rather than write a card it can't
    express exactly (an unsafe string, a repeated ID, hours that aren't whole minutes)."""
    tools = schema_tools(schema)
    owned = [card for card in cards if not card.is_default]
    _check(owned)
    defaults = [RuleCard(card_id=f"default:{tool}", applies_to=tool, mode="ask", who="anyone", is_default=True,
                         reason=_DEFAULT_REASON)
                for tool in sorted(tools) if not _anyone_covers(tool, tools[tool], owned)]
    autos = [card for card in owned if card.mode == "auto"]

    # The auto units covering each tool, and the tools each unit covers.
    units_on: dict[str, list[tuple[RuleCard, ...]]] = {}
    unit_tools: dict[tuple[str, ...], tuple[tuple[RuleCard, ...], list[str]]] = {}
    for tool in sorted(tools):
        units_on[tool] = _auto_units(tool, tools[tool], autos)
        for unit in units_on[tool]:
            unit_tools.setdefault(_ids(unit), (unit, []))[1].append(tool)

    nevers, permits, holds = [], [], []
    for card in owned:
        if card.mode == "never" and (covered := _covered(card, tools)):
            nevers.append(_policy(f"never.{card.card_id}", [card], "refuse", "forbid", covered, _who(card)))
    for card in [*owned, *defaults]:
        if card.mode == "ask" and (covered := _covered(card, tools)):
            holds.append(_policy(f"ask.{card.card_id}", [card], "hold", "permit", covered, _who(card)))
    for unit, covered in unit_tools.values():
        name = "+".join(_ids(unit))
        money = {money_tool(tool, tools[tool]) for tool in covered}
        if len(money) != 1:
            raise ValueError("an auto unit covers money tools or other tools, never both")
        beaten = _beaten_where(unit, covered, owned, tools, units_on)
        condition = _conj([_unit_who(unit), _limits(unit, money=money == {True}), beaten])
        permits.append(_policy(f"auto.{name}", unit, "auto", "permit", covered, condition))
        holds.append(_policy(f"twin.{name}", unit, "hold", "permit", covered, _unit_who(unit)))
    return RefSets(never="\n\n".join(sorted(nevers)), R="\n\n".join(sorted(permits)), R_hold="\n\n".join(sorted(holds)))


# -- Coverage and specificity

def _effect(card: RuleCard) -> str | None:
    return card.applies_to.removeprefix("effect:") if card.applies_to.startswith("effect:") else None


def _rank(card: RuleCard) -> tuple[int, int]:
    """(person-scoped, a tool card); a default ask ranks below every card."""
    if card.is_default:
        return (-1, -1)
    return (int(card.who in ("person", "agent")), int(_effect(card) is None))


def _names(card: RuleCard, tool: str, effects: frozenset[str]) -> bool:
    """Does an ask or never card cover `tool`: its tool, or one of the tool's effects?"""
    return card.applies_to == tool or _effect(card) in effects


def _covered(card: RuleCard, tools: Mapping[str, frozenset[str]]) -> list[str]:
    return [tool for tool in sorted(tools) if _names(card, tool, tools[tool])]


def _auto_units(tool: str, effects: frozenset[str], autos: Sequence[RuleCard]) -> list[tuple[RuleCard, ...]]:
    """The auto units covering `tool`: each auto card for the tool alone, and every way to name
    each of its effects with one auto effect card, all at one specificity."""
    units = [(card,) for card in autos if card.applies_to == tool]
    if effects:
        per_effect = [[card for card in autos if _effect(card) == effect] for effect in sorted(effects)]
        for combination in itertools.product(*per_effect):
            if len({_rank(card) for card in combination}) == 1:
                units.append(tuple(sorted(combination, key=lambda card: card.card_id)))
    return units


def _anyone_covers(tool: str, effects: frozenset[str], owned: Sequence[RuleCard]) -> bool:
    anyone = [card for card in owned if card.who == "anyone"]
    if any(card.applies_to == tool or (card.mode != "auto" and _effect(card) in effects) for card in anyone):
        return True
    effect_autos = [card for card in anyone if card.mode == "auto" and _effect(card) is not None]
    return bool(_auto_units(tool, effects, effect_autos))


def _ids(unit: Sequence[RuleCard]) -> tuple[str, ...]:
    return tuple(card.card_id for card in unit)


def _beaten_where(unit: tuple[RuleCard, ...], covered: Sequence[str], owned: Sequence[RuleCard],
                  tools: Mapping[str, frozenset[str]], units_on: Mapping[str, list[tuple[RuleCard, ...]]]) -> str:
    """`!(...)` of every way something in `Beats(unit)` matches on the unit's tools, or `true`."""
    rank = _rank(unit[0])                               # a combination's cards share one
    beaters: dict[tuple[str, str], list[str]] = {}      # (kind and IDs, who) -> the tools where it beats the unit
    for tool in covered:
        for card in owned:
            if card.mode == "auto" or not _names(card, tool, tools[tool]):
                continue
            if _rank(card) > rank or (card.mode == "ask" and _rank(card) == rank):
                beaters.setdefault((f"{card.mode}.{card.card_id}", _who(card)), []).append(tool)
        for other in units_on[tool]:
            if _rank(other[0]) > rank:
                beaters.setdefault((f"auto.{'+'.join(_ids(other))}", _unit_who(other)), []).append(tool)
    if not beaters:
        return "true"
    terms = sorted(f"({_conj([_scope(where), who])})" for (_, who), where in beaters.items())
    return "!(" + " || ".join(dict.fromkeys(terms)) + ")"


# -- Text

def _safe(value: str) -> str:
    if not isinstance(value, str) or not _SAFE.fullmatch(value):
        raise ValueError("a string written into Cedar may hold only letters, digits and . _ : -, 80 at most")
    return value


def _int(value: Any, high: int) -> int:
    if type(value) is not int or not 0 <= value <= high:
        raise ValueError("a limit is a whole number in range")
    return value


def _check(owned: Sequence[RuleCard]) -> None:
    seen: set[str] = set()
    for card in owned:
        _safe(card.card_id)
        _safe(card.applies_to)
        if card.card_id in seen:
            raise ValueError("each card has its own card_id")
        seen.add(card.card_id)
        if card.card_id.startswith("default:"):
            raise ValueError("IDs starting with default: are kept for the default asks")
        if card.mode not in ("auto", "ask", "never"):
            raise ValueError("a card's mode is auto, ask or never")
        _who(card)


def _conj(parts: Iterable[str]) -> str:
    kept = list(dict.fromkeys(part for part in parts if part != "true"))
    return " && ".join(kept) or "true"


def _who(card: RuleCard) -> str:
    match card.who:
        case "anyone":
            return "true"
        case "verified":
            return "principal.verified"
        case "record_owner":
            return "principal.verified && context.record_owner_match"
        case "person":
            return f'principal has person_id && principal.person_id == "{_safe(card.person_id)}"'
        case "agent":
            return f'principal is Agent && principal.agent_key_id == "{_safe(card.agent_key_id)}"'
    raise ValueError("a card's who is anyone, verified, record_owner, person or agent")


def _unit_who(unit: Sequence[RuleCard]) -> str:
    return _conj(_who(card) for card in unit)


def _scope(tools: Sequence[str]) -> str:
    if len(tools) == 1:
        return f'action == Action::"{_safe(tools[0])}"'
    return "action in [" + ", ".join(f'Action::"{_safe(tool)}"' for tool in tools) + "]"


def _minute(value: time) -> int:
    if value.second or value.microsecond or value.tzinfo is not None:
        raise ValueError("hours are whole local minutes")
    return value.hour * 60 + value.minute


def _hours(card: RuleCard) -> str:
    if card.hours is None:
        return "true"
    start, end = _minute(card.hours.start), _minute(card.hours.end) or 1440   # an end of 00:00 is midnight
    if end <= start:
        raise ValueError("hours end after they start")
    if not card.hours.days or not set(card.hours.days) <= _DAYS.keys():
        raise ValueError("hours name days from mon to sun")
    days = ", ".join(str(day) for day in sorted({_DAYS[day] for day in card.hours.days}))
    return f"[{days}].contains(context.local_dow) && context.local_minute >= {start} && context.local_minute < {end}"


def _limits(unit: Sequence[RuleCard], *, money: bool) -> str:
    """The tightest discount and amount limits of the unit's cards, and each card's hours."""
    discount = min(_int(card.max_discount_bp, 10_000) for card in unit)
    parts = [f"(if context has discount_bp then context.discount_bp <= {discount} else true)"]
    amounts = [_int(card.max_amount_cents, _MAX_LONG) for card in unit if card.max_amount_cents is not None]
    if money:
        cap = min([*amounts, AUTO_MONEY_HARD_CAP_CENTS])
        parts.append(f"context has amount_cents && context.amount_cents <= {cap}")
    elif amounts:
        parts.append(f"(if context has amount_cents then context.amount_cents <= {min(amounts)} else true)")
    parts += [_hours(card) for card in unit]
    return _conj(parts)


def _policy(policy_id: str, cards: Sequence[RuleCard], tier: str, effect: str, tools: Sequence[str],
            condition: str) -> str:
    head = (f'@id("{policy_id}") @card("{",".join(_safe(card.card_id) for card in cards)}") @tier("{tier}") '
            f'@applies_to("{",".join(_safe(card.applies_to) for card in cards)}")')
    body = f"{effect} (principal, {_scope(tools)}, resource)"
    if condition != "true":
        body += f"\nwhen {{ {condition} }}"
    return f"{head}\n{body};"
