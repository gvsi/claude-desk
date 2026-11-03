"""The Cedar inputs every Desk shares, and the rule-card compiler.

Everything here loads from `CEDAR_DIR`, found from this file's path and never from the working
directory, so the kernel reads the same files from a test, the repo root or the image
(`/app/kernel/cedar`):

- `BASE_SCHEMA`: the master plan's "Cedar request shape" with one action per native tool, each a
  member of its effect groups (`effect:*`), which every Desk's schema starts from; `desk_schema`
  adds an action for each pinned MCP tool the Desk enables. Importing this module raises
  RuntimeError when `desk.always_on.ALWAYS_ON_EFFECTS`, the always-on tools' effects as the API
  reads them, differs from those groups, so such a kernel doesn't start.
- `BASELINE`: set `B`, the always-on forbids, which `PolicyEngine(BASELINE)` adds to every
  evaluation.
- `invariants(auto_money_cap_cents)`: the proof spec sets `desk-prove` checks every activation
  against (`invariants/always/` for `baseline_auto` and `baseline_approvable`, `invariants/auto/`
  for `baseline_auto`), by kind and file name, rendered at a version's money cap: the auto
  invariants hold the cap as a placeholder, so no text reaches `desk-prove` unrendered.

The compiler (`compile_cards`) turns the owner's rule cards into Cedar sets `F` (never cards), `A`
(auto cards) and `H` (ask cards and hold twins) by code, never freehand: every string it writes is
checked, and the text is deterministic, so a card set has one `cedar_sha256` in every copy. It
compiles at a version's money cap (master plan, "Money cap"): every auto permit on a money tool is
bounded by the cards' limits, the cap and `AUTO_MONEY_HARD_CAP_CENTS`, whichever is lowest.

The hashes name what a proof covered, so a report proved for other inputs is never reused.
"""

import copy
import hashlib
import itertools
import json
import re
from collections.abc import Collection, Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import time
from pathlib import Path
from typing import Any, Literal

import desk_kernel

from desk import always_on
from desk.always_on import ALWAYS_ON_CARDS, changes_always_on, same_rule, specificity
from desk.contracts import AUTO_MONEY_HARD_CAP_CENTS, RuleCard, ToolProfile, money_tool
from desk.contracts import moves_money  # noqa: F401  (compiler.moves_money stays importable)
from desk.kernel_service import review_thresholds
from desk.money_cap import auto_money

CEDAR_DIR = Path(__file__).resolve().parents[3] / "kernel" / "cedar"

BASE_SCHEMA: dict[str, Any] = json.loads((CEDAR_DIR / "schema.cedarschema.json").read_bytes())


def _check_always_on_effects(schema: Mapping[str, Any]) -> None:
    """Raise RuntimeError unless `desk.always_on.ALWAYS_ON_EFFECTS` gives each always-on tool
    exactly the effect groups (`effect:*` in its action's `memberOf`) `schema` gives it. The API
    checks drafted cards with that data and no schema, so a kernel whose shared data drifted from
    its schema refuses to start: this runs when the compiler is imported, as an explicit check
    (not an assert, so `python -O` keeps it)."""
    actions = schema[""]["actions"]
    for tool, effects in always_on.ALWAYS_ON_EFFECTS.items():
        if tool not in actions:
            raise RuntimeError(f"desk.always_on.ALWAYS_ON_EFFECTS names {tool}, which the Cedar base schema "
                               "doesn't declare")
        groups = frozenset(group["id"].removeprefix("effect:") for group in actions[tool].get("memberOf", ())
                           if group["id"].startswith("effect:"))
        if frozenset(effects) != groups:
            raise RuntimeError(f"desk.always_on.ALWAYS_ON_EFFECTS gives {tool} the effects {sorted(effects)}, "
                               f"but the Cedar base schema gives it {sorted(groups)}")


_check_always_on_effects(BASE_SCHEMA)
_BASELINE_BYTES = (CEDAR_DIR / "baseline.cedar").read_bytes()
BASELINE: str = _BASELINE_BYTES.decode("utf-8")


def _invariant_files(kind: str) -> dict[str, bytes]:
    files = {path.stem: path.read_bytes() for path in sorted((CEDAR_DIR / "invariants" / kind).glob("*.cedar"))}
    if not files:
        # desk-prove would refuse an empty list anyway; a kernel without invariants doesn't start
        raise RuntimeError(f"no invariants in {CEDAR_DIR / 'invariants' / kind}")
    return files


_INVARIANT_BYTES: dict[Literal["always", "auto"], dict[str, bytes]] = {
    "always": _invariant_files("always"),
    "auto": _invariant_files("auto"),
}
# What an invariant file holds where a version's money cap goes, and any placeholder at all.
CAP_PLACEHOLDER = "{auto_money_cap_cents}"
_PLACEHOLDER = re.compile(r"\{[A-Za-z_][A-Za-z0-9_]*\}")


def capped(auto_money_cap_cents: int) -> int:
    """A version's money cap as every check applies it: `min(cap, AUTO_MONEY_HARD_CAP_CENTS)`.
    Raises ValueError for anything but a whole number of cents from 0 (a bool included)."""
    if type(auto_money_cap_cents) is not int or auto_money_cap_cents < 0:
        raise ValueError("a money cap is a whole number of cents from 0")
    return min(auto_money_cap_cents, AUTO_MONEY_HARD_CAP_CENTS)


def invariants(auto_money_cap_cents: int) -> dict[Literal["always", "auto"], dict[str, str]]:
    """The invariant texts by kind and file name, rendered at a version's money cap (`capped`).
    Raises ValueError for a text that still holds a placeholder, so nothing unrendered is proved."""
    cap = str(capped(auto_money_cap_cents))
    rendered: dict[Literal["always", "auto"], dict[str, str]] = {}
    for kind, files in _INVARIANT_BYTES.items():
        rendered[kind] = {}
        for name, data in files.items():
            text = data.decode("utf-8").replace(CAP_PLACEHOLDER, cap)
            if _PLACEHOLDER.search(text):
                raise ValueError(f"invariants/{kind}/{name}.cedar holds a placeholder nothing renders")
            rendered[kind][name] = text
    return rendered


def _sha256_canonical(value: Any) -> str:
    return hashlib.sha256(desk_kernel.canonical_json(json.dumps(value)).encode()).hexdigest()


# The principal types each pinned MCP tool's action applies to: its "Given to" row in the master
# plan's "Model-visible tools" (a refund is a verified visitor's alone; agents never pay out).
MCP_PRINCIPAL_TYPES: dict[str, tuple[str, ...]] = {
    "payments.list_charges": ("Visitor", "Agent"),
    "payments.create_refund": ("Visitor",),
}
MCP_RESOURCE_TYPE = "Charge"


def desk_schema(profiles: Iterable[ToolProfile]) -> dict[str, Any]:
    """The Cedar schema for a Desk with these tool profiles: a fresh copy of the base schema, which
    declares every native tool, plus one action per MCP profile, a member of its effect groups,
    applying to the principal types of its "Given to" row (`MCP_PRINCIPAL_TYPES`) and to resource
    `Charge`. Raises ValueError for a native tool the base schema doesn't declare, an MCP tool with
    no "Given to" row, an effect with no group, or a tool given twice, rather than leave it out."""
    schema = copy.deepcopy(BASE_SCHEMA)
    actions = schema[""]["actions"]
    seen: set[str] = set()
    for profile in sorted(profiles, key=lambda p: p.tool):
        if profile.tool in seen:
            raise ValueError(f"{profile.tool} is given twice")
        seen.add(profile.tool)
        if profile.source == "native":
            if "appliesTo" not in actions.get(profile.tool, {}):
                raise ValueError(f"{profile.tool}: the base schema doesn't declare it")
            continue
        principals = MCP_PRINCIPAL_TYPES.get(profile.tool)
        resource = MCP_RESOURCE_TYPE
        if profile.source == "business":
            from desk.kernel_service.adapters.blocks import profile as block_profile
            if profile.business is None or block_profile(profile.tool, profile.business).effects != profile.effects:
                raise ValueError(f"{profile.tool}: invalid business profile")
            principals = ("Visitor", "Agent")
            resource = "Slot" if profile.business.config.block == "typed_booking" else "Desk"
        groups = [f"effect:{effect}" for effect in profile.effects]
        if principals is None or not groups or any(group not in actions for group in groups):
            raise ValueError(f"{profile.tool}: no action can be declared for it")
        actions[profile.tool] = {
            "memberOf": [{"id": group} for group in groups],
            "appliesTo": {"principalTypes": list(principals), "resourceTypes": [resource],
                          "context": {"type": "Ctx"}},
        }
    return schema


def schema_sha256(schema: dict[str, Any]) -> str:
    """sha256 of `canonical_json(schema)`."""
    return _sha256_canonical(schema)


def baseline_sha256() -> str:
    """sha256 of the baseline file's bytes, the text `BASELINE` holds."""
    return hashlib.sha256(_BASELINE_BYTES).hexdigest()


def invariants_sha256(checks: Iterable[str], auto_money_cap_cents: int) -> str:
    """sha256 of `canonical_json({files: {"<kind>/<name>.cedar": sha256 of its text rendered at
    the money cap}, checks, prove_version: desk_kernel.version()})`, the check names sorted. A
    changed invariant file, check list, prover or cap makes a different hash, so a report proved
    for other invariants, or at another cap, is never reused."""
    names = list(checks)
    if len(set(names)) != len(names):
        raise ValueError("each check is named once")
    files = {f"{kind}/{name}.cedar": hashlib.sha256(text.encode("utf-8")).hexdigest()
             for kind, by_name in invariants(auto_money_cap_cents).items() for name, text in by_name.items()}
    return _sha256_canonical({"files": files, "checks": sorted(names), "prove_version": desk_kernel.version()})


# ---- The rule-card compiler -------------------------------------------------------------------
#
# The master plan's "Policy sets" and "Coverage and overlap (most specific wins)". In short:
#
# - A card covers a tool when `applies_to` names it, or `effect:<e>` for one of its effects; an
#   auto effect card covers a tool only when every effect of the tool is named by an auto effect
#   card at its specificity. Such a set of cards, one per effect, is a joint combination: it gets
#   one permit of its own over the tools it covers, conjoining every card's who, hours and review
#   gate with the tightest amount and discount limits, and its cards emit nothing else for them.
# - Specificity: person-scoped (`person`, `agent`) beats the rest, then a tool card beats an effect
#   card; a default ask ranks below every card. A never card always wins (a forbid in `F`). An
#   auto permit carries `unless` exclusions for every non-default ask card at the same or higher
#   specificity and every auto card or combination at higher specificity that covers one of its
#   tools, each as its scope on the shared tools and its who: a card "matches" a request when it
#   covers the tool and its who holds, a combination when all its cards' who hold. Autos at the
#   same specificity add up. `A` is evaluated before `H`, so a broader ask needs no exclusion.
# - A set that lacks one of the presets' `ALWAYS_ON_CARDS` gets it before the defaults are
#   derived, so a start of the always-on verification never falls to a default ask.
# - Every enabled tool that cards for anyone don't cover (alone or jointly, any mode) gets a
#   default ask, so a card for some visitors never leaves the others refused.

DEFAULT_REASON = "Not covered by a rule yet, so it asks you."
CARD_ID = re.compile(r"[a-z0-9][a-z0-9._:-]{0,63}")
# Every string the compiler writes into Cedar (card IDs, tool and effect names, person IDs, agent
# key IDs) matches this, so none can end a string literal or carry Cedar syntax.
CEDAR_STRING = re.compile(r"[A-Za-z0-9._:-]{1,80}")
_DAY_NUMBERS = {"mon": 0, "tue": 1, "wed": 2, "thu": 3, "fri": 4, "sat": 5, "sun": 6}   # local_dow, Monday 0


@dataclass(frozen=True)
class CompiledSets:
    """A compiled card set: the Cedar texts of `F` (never cards), `A` (auto cards) and `H` (ask
    cards, defaults included, and hold twins), and the cards as compiled (`with_defaults`: with
    the always-on cards and the defaults), sorted by `card_id`."""

    F: str
    A: str
    H: str
    cards: list[RuleCard]

    def sets(self) -> dict[str, str]:
        """`{"F", "A", "H"}`, as `PolicyEngine.load` and `cedar_sha256` take them."""
        return {"F": self.F, "A": self.A, "H": self.H}


def cedar_sha256(sets: CompiledSets | Mapping[str, str]) -> str:
    """sha256 of `canonical_json({"F", "A", "H"})`."""
    texts = sets.sets() if isinstance(sets, CompiledSets) else sets
    return _sha256_canonical({name: texts[name] for name in ("F", "A", "H")})


# -- Coverage

def _effect_of(card: RuleCard) -> str | None:
    return card.applies_to.removeprefix("effect:") if card.applies_to.startswith("effect:") else None


def _tool_effects(profiles: Iterable[ToolProfile]) -> dict[str, frozenset[str]]:
    return {profile.tool: frozenset(profile.effects) for profile in profiles}


# `specificity(card)` ranks cards: `(who is "person" or "agent", applies_to is a tool)`, compared
# in that order, and `(-1, -1)` for a default card. It is defined in `desk.always_on`, so the check
# on always-on tools ranks cards as the compiler does.


def _combinations(effects: frozenset[str], cards: Iterable[RuleCard]) -> list[tuple[RuleCard, ...]]:
    """Every way to name each of a tool's effects with one auto effect card, all the cards at one
    specificity, each sorted by `card_id`. For a one-effect tool these are the auto cards for that
    effect, each alone."""
    if not effects:
        return []
    autos = [c for c in cards if c.mode == "auto" and not c.is_default and _effect_of(c) is not None]
    per_effect = [[c for c in autos if _effect_of(c) == effect] for effect in sorted(effects)]
    return [tuple(sorted(combination, key=lambda c: c.card_id))
            for combination in itertools.product(*per_effect)
            if len({specificity(c) for c in combination}) == 1]


def covers(card: RuleCard, tool: str, profiles: Iterable[ToolProfile], cards: Iterable[RuleCard]) -> bool:
    """Does `card` cover `tool` among the enabled `profiles`, given all the Desk's `cards`? A tool
    that isn't enabled is covered by nothing."""
    effects = _tool_effects(profiles).get(tool)
    if effects is None:
        return False
    if card.applies_to == tool:
        return True
    if _effect_of(card) not in effects:
        return False
    if card.mode != "auto":
        return True
    pool = list(cards)
    if card not in pool:
        pool.append(card)
    return any(card in combination for combination in _combinations(effects, pool))


def _anyone_covers(tool: str, effects: frozenset[str], cards: Sequence[RuleCard]) -> bool:
    anyone = [c for c in cards if c.who == "anyone" and not c.is_default]
    if any(c.applies_to == tool or (c.mode != "auto" and _effect_of(c) in effects) for c in anyone):
        return True
    return bool(_combinations(effects, anyone))       # auto effect cards for anyone, alone or jointly


def with_defaults(cards: Iterable[RuleCard], profiles: Iterable[ToolProfile]) -> list[RuleCard]:
    """The owner's cards, plus each of the presets' `ALWAYS_ON_CARDS` they lack (verification is
    always on, so a set that leaves its card out still allows a start rather than asking), plus a
    default ask for every enabled tool that cards for anyone don't cover (alone or jointly, in any
    mode), sorted by `card_id`. A card that differs from an always-on card only in its `reason`
    counts as it (`desk.always_on.same_rule`); another card under its ID is kept, and
    `compile_cards` refuses the repeated ID. Defaults in `cards` are dropped and derived again, so
    a stale one never survives a change of cards or tools."""
    owned = [c for c in cards if not c.is_default]
    owned += [shipped for shipped in ALWAYS_ON_CARDS if not any(same_rule(c, shipped) for c in owned)]
    effects = _tool_effects(profiles)
    defaults = [RuleCard(card_id=f"default:{tool}", applies_to=tool, mode="ask", who="anyone", is_default=True,
                         reason=DEFAULT_REASON)
                for tool in sorted(effects) if not _anyone_covers(tool, effects[tool], owned)]
    return sorted([*owned, *defaults], key=lambda c: c.card_id)


# The standings `outcome_for` reads cards for: a caller with no standing of its own, and the
# verified owner of a record. Neither names anyone, so no card for a person or an agent key counts.
ANYONE: frozenset[str] = frozenset({"anyone"})
VERIFIED_OWNER: frozenset[str] = frozenset({"anyone", "verified", "record_owner"})


def outcome_for(tool: str, cards: Iterable[RuleCard], profiles: Iterable[ToolProfile],
                who: frozenset[str] = ANYONE) -> Literal["auto", "ask", "never"]:
    """How the compiled `cards` decide `tool` among the enabled `profiles` for a caller whose
    standing matches the cards for `who` (`ANYONE`, or `VERIFIED_OWNER`), before an auto card's
    limits, hours and reviewer: from those cards alone (with the always-on cards a set lacks, as
    `with_defaults` adds them), so no card for a person or an agent key is ever read, and `who`
    naming either standing raises ValueError. `never` when a never card covers the tool (`F`
    always wins); `auto` when an auto card or joint combination covers it and no ask card at its
    specificity or above does (its permit's `unless`); else `ask`, by an ask card or the tool's
    default."""
    if not who <= VERIFIED_OWNER:
        raise ValueError("an outcome is read for standings that name no one")
    profiles = list(profiles)
    effects = _tool_effects(profiles)
    read = [c for c in with_defaults(cards, profiles) if c.who in who and not c.is_default]
    if any(c.mode == "never" and tool in _carried(c, effects) for c in read):
        return "never"
    asks = [c for c in read if c.mode == "ask" and tool in _carried(c, effects)]
    if any(tool in unit.tools and all(specificity(c) < unit.specificity for c in asks)
           for unit in _autos(read, effects)):
        return "auto"
    return "ask"


# -- Checks before compiling

ABOVE_MONEY_CAP = "above_money_cap"
# Tools of the always-on baseline (`desk.always_on.ALWAYS_ON_TOOLS`): verification codes go only
# to the contact on record, and no rule can make a start ask, hold it or turn it off. Which cards
# could change one is `desk.always_on.changes_always_on`, the check the API runs on drafted cards
# too, and `validate_cards` refuses each of them; `with_defaults` adds the presets' own card for
# each tool (`ALWAYS_ON_CARDS`) to a set that leaves it out.


def above_money_cap(cards: Iterable[RuleCard], auto_money_cap_cents: int, *,
                    money_tools: Collection[str]) -> list[RuleCard]:
    """The auto money cards (`desk.money_cap.auto_money`, the predicate `lower_to_cap` reads too)
    that would allow more than the money cap (`capped`) without asking. `money_tools` must include
    the Desk's money profiles of every status, since a card can precede enabling its tool."""
    cap = capped(auto_money_cap_cents)
    return [card for card in cards if auto_money(card, money_tools)
            and (card.max_amount_cents is None or card.max_amount_cents > cap)]


def validate_cards(cards: Iterable[RuleCard], *, people: Collection[str], agent_keys: Collection[str],
                   auto_money_cap_cents: int, money_tools: Collection[str]) -> list[str]:
    """Plain reasons a set of owner cards can't be compiled at a version's money cap; empty means
    it can. Defaults are left out (`with_defaults` drops and derives them again). A reason names a
    card by its `card_id` only when that is safe to show, and never repeats the offending value;
    an auto money card above the cap reads `<card>: above_money_cap: ...`, and a card that could
    change a tool of the always-on baseline (`desk.always_on.changes_always_on`), on the tool or
    on one of its effects, reads `<card>: <tool>: ...`."""
    cap = capped(auto_money_cap_cents)
    errors: list[str] = []
    seen: set[str] = set()
    for number, c in enumerate(cards, start=1):
        if c.is_default:
            continue
        label = c.card_id if CEDAR_STRING.fullmatch(c.card_id) else f"card {number}"
        if not CARD_ID.fullmatch(c.card_id):
            errors.append(f"{label}: a card ID is 1 to 64 lower-case letters, digits and . _ : -, starting with a "
                          "letter or digit")
        elif c.card_id in seen:
            errors.append(f"{label}: another card has the same ID")
        seen.add(c.card_id)
        if c.card_id.startswith("default:"):
            errors.append(f"{label}: IDs starting with default: are kept for the cards that ask by default")
        try:
            RuleCard.model_validate(c.model_dump())   # a card built without its checks gets them here
        except ValueError:
            errors.append(f"{label}: the card doesn't meet the rule card checks")
            continue
        if (tool := changes_always_on(c)) is not None:
            errors.append(f"{label}: {tool}: verification is always on, so no rule can change it")
        for field in ("applies_to", "person_id", "agent_key_id"):
            value = getattr(c, field)
            if value is not None and not CEDAR_STRING.fullmatch(value):
                errors.append(f"{label}: {field} may hold only letters, digits and . _ : -, 80 at most")
        if c.who == "person" and c.person_id not in people:
            errors.append(f"{label}: the person isn't one of this Desk's people")
        if c.who == "agent" and c.agent_key_id not in agent_keys:
            errors.append(f"{label}: the agent key isn't one this Desk knows")
        if c.hours is not None:
            try:
                _hours(c)
            except ValueError as e:
                errors.append(f"{label}: {e}")
        if above_money_cap([c], cap, money_tools=money_tools):
            errors.append(f"{label}: {ABOVE_MONEY_CAP}: it would take or pay out more than the money limit without "
                          "asking")
    return errors


# -- Emission: every piece of text comes from these helpers, and every string through _cedar_string

def _cedar_string(value: str) -> str:
    if not CEDAR_STRING.fullmatch(value):
        raise ValueError("a string written into Cedar may hold only letters, digits and . _ : -, 80 at most")
    return f'"{value}"'


def _conj(parts: Iterable[str]) -> str:
    """`a && b && ...` without trivially true parts or repeats; `true` when nothing is left."""
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
            return f"principal has person_id && principal.person_id == {_cedar_string(card.person_id or '')}"
        case "agent":
            return f"principal is Agent && principal.agent_key_id == {_cedar_string(card.agent_key_id or '')}"
    raise ValueError("unknown who")


def _scope(tools: Sequence[str], *, as_list: bool = False) -> str:
    if len(tools) == 1 and not as_list:
        return f"action == Action::{_cedar_string(tools[0])}"
    return "action in [" + ", ".join(f"Action::{_cedar_string(tool)}" for tool in tools) + "]"


def _minute(value: time, *, end: bool = False) -> int:
    if value.second or value.microsecond:
        raise ValueError("hours are whole minutes")
    minute = value.hour * 60 + value.minute
    return 1440 if end and minute == 0 else minute     # an end of 00:00 is midnight, the end of the day


def _hours(card: RuleCard) -> str:
    if card.hours is None:
        return "true"
    start, end = _minute(card.hours.start), _minute(card.hours.end, end=True)
    if end <= start:
        raise ValueError("hours end after they start")
    if not card.hours.days or not set(card.hours.days) <= _DAY_NUMBERS.keys():
        raise ValueError("hours name days from mon to sun")
    days = ", ".join(str(day) for day in sorted({_DAY_NUMBERS[day] for day in card.hours.days}))
    return f"[{days}].contains(context.local_dow) && context.local_minute >= {start} && context.local_minute < {end}"


def _policy(policy_id: str, cards: Sequence[RuleCard], tier: str, scope: str,
            conditions: Sequence[tuple[str, str]]) -> str:
    for c in cards:
        _cedar_string(c.card_id)
        _cedar_string(c.applies_to)
    effect = "forbid" if tier == "refuse" else "permit"
    lines = [f'@id("{policy_id}") @card("{",".join(c.card_id for c in cards)}") @tier("{tier}") '
             f'@applies_to("{",".join(c.applies_to for c in cards)}")',
             f"{effect} (principal, {scope}, resource)"]
    # `when { true }` says nothing and an empty body is no clause; `unless { true }` is never dropped
    lines += [f"{kind} {{ {body} }}" for kind, body in conditions if body and (kind, body) != ("when", "true")]
    return "\n".join(lines) + ";"


@dataclass(frozen=True)
class _Auto:
    """An auto permit to emit: one card, or a joint combination, over the tools it covers."""

    cards: tuple[RuleCard, ...]
    tools: tuple[str, ...]

    @property
    def name(self) -> str:
        return "+".join(c.card_id for c in self.cards)

    @property
    def who(self) -> str:
        return _conj(_who(c) for c in self.cards)

    @property
    def specificity(self) -> tuple[int, int]:
        return specificity(self.cards[0])          # a combination's cards share one

    @property
    def scope(self) -> str:
        return _scope(self.tools, as_list=len(self.cards) == 1 and _effect_of(self.cards[0]) is not None)


def _carried(card: RuleCard, effects: dict[str, frozenset[str]]) -> tuple[str, ...]:
    """The enabled tools an ask or never card covers: its tool, or every tool with its effect."""
    effect = _effect_of(card)
    if effect is None:
        return (card.applies_to,) if card.applies_to in effects else ()
    return tuple(sorted(tool for tool, tool_effects in effects.items() if effect in tool_effects))


def _autos(cards: Sequence[RuleCard], effects: dict[str, frozenset[str]]) -> list[_Auto]:
    """Each auto card over the enabled tools it covers alone (its tool, or the tools whose only
    effect is its effect), then each joint combination over the tools with several effects it
    covers (one combination covers only tools with the same effects)."""
    units = []
    for c in cards:
        if c.mode != "auto":
            continue
        effect = _effect_of(c)
        if effect is None:
            tools = (c.applies_to,) if c.applies_to in effects else ()
        else:
            tools = tuple(sorted(tool for tool, tool_effects in effects.items() if tool_effects == {effect}))
        if tools:
            units.append(_Auto((c,), tools))
    joint: dict[tuple[str, ...], tuple[tuple[RuleCard, ...], list[str]]] = {}   # by card IDs, which are unique
    for tool in sorted(effects):
        if len(effects[tool]) > 1:
            for combination in _combinations(effects[tool], cards):
                joint.setdefault(tuple(c.card_id for c in combination), (combination, []))[1].append(tool)
    units += [_Auto(combination, tuple(tools)) for _, (combination, tools) in sorted(joint.items())]
    return units


def _limits(unit: _Auto, effects: dict[str, frozenset[str]], cap: int) -> str:
    """The tightest discount and amount limits and every card's hours. On money tools the amount
    is required and bounded by the version's money cap `cap` (already `capped`, so never above
    AUTO_MONEY_HARD_CAP_CENTS) whatever the cards say; elsewhere a limit reads an optional
    attribute in the `if ... then ... else true` form strict validation takes."""
    money = {money_tool(tool, effects[tool]) for tool in unit.tools}
    if len(money) != 1:
        raise ValueError("an auto permit covers money tools or other tools, never both")
    discount = min(c.max_discount_bp for c in unit.cards)
    parts = [f"(if context has discount_bp then context.discount_bp <= {discount} else true)"]
    amounts = [c.max_amount_cents for c in unit.cards if c.max_amount_cents is not None]
    if money == {True}:
        bound = min([*amounts, cap, AUTO_MONEY_HARD_CAP_CENTS])
        parts.append(f"context has amount_cents && context.amount_cents <= {bound}")
    elif amounts:
        parts.append(f"(if context has amount_cents then context.amount_cents <= {min(amounts)} else true)")
    parts += [_hours(c) for c in unit.cards]
    return _conj(parts)


def _review_gate(unit: _Auto, effects: dict[str, frozenset[str]]) -> str:
    """The monotone gate, with the strictest thresholds across the tools' effects, when any of
    the unit's cards asks for the reviewer."""
    if not any(c.review for c in unit.cards):
        return "true"
    row = review_thresholds.thresholds_for(sorted(set().union(*(effects[tool] for tool in unit.tools))))
    return (f"context has review && context.review.within_charter_bp >= {row.min_within_charter_bp}"
            f" && context.review.manipulation_bp <= {row.max_manipulation_bp}")


def _exclusions(unit: _Auto, asks: Sequence[tuple[RuleCard, tuple[str, ...]]], autos: Sequence[_Auto]) -> str:
    """The cards that decide instead of `unit` where they overlap it, each as its scope on the
    shared tools and its who: non-default ask cards at the same or higher specificity, and auto
    cards or combinations at higher specificity."""
    beaters = [(f"ask.{c.card_id}", tools, _who(c)) for c, tools in asks
               if not c.is_default and specificity(c) >= unit.specificity]
    beaters += [(f"auto.{other.name}", other.tools, other.who) for other in autos
                if other.specificity > unit.specificity]
    found: dict[str, str] = {}
    for name, tools, who in beaters:
        shared = [tool for tool in unit.tools if tool in tools]
        if shared:
            found.setdefault(f"({_conj([_scope(shared), who])})", name)
    return " || ".join(sorted(found, key=lambda text: (found[text], text)))


def compile_cards(cards: Iterable[RuleCard], profiles: Iterable[ToolProfile], *, auto_money_cap_cents: int,
                  review: bool = True) -> CompiledSets:
    """Compiles rule cards over the enabled `profiles` into `F`, `A` and `H`, at the version's
    money cap (required, so no caller forgets it): every auto permit on a money tool bounds the
    amount by `min(<the cards' limits>, auto_money_cap_cents, AUTO_MONEY_HARD_CAP_CENTS)`. The
    always-on cards a set lacks are added and the default asks derived (`with_defaults`). A card
    for a tool that isn't enabled emits nothing. Cards are sorted by `card_id` and the text is
    deterministic, so the same cards compile to the same hash in every copy. `review=False` leaves
    out every review gate (`A0` for the `review_only_narrows` proof). Raises ValueError rather than
    emit a card it can't compile exactly (run `validate_cards` first for the owner's reasons)."""
    cap = capped(auto_money_cap_cents)
    profiles = list(profiles)
    effects = _tool_effects(profiles)
    for tool in effects:
        _cedar_string(tool)
    owned = [c for c in cards if not c.is_default]
    if any(c.card_id.startswith("default:") for c in owned):
        raise ValueError("IDs starting with default: are the compiler's")
    if any(c.mode not in ("auto", "ask", "never") for c in owned):
        raise ValueError("a card's mode is auto, ask or never")
    all_cards = with_defaults(owned, profiles)
    if len({c.card_id for c in all_cards}) != len(all_cards):
        raise ValueError("each card has its own card_id")

    forbids, permits, holds = [], [], []
    asks: list[tuple[RuleCard, tuple[str, ...]]] = []
    for c in all_cards:
        tools = _carried(c, effects)
        if not tools or c.mode == "auto":
            continue
        scope = _scope(tools, as_list=_effect_of(c) is not None)
        if c.mode == "never":
            forbids.append(_policy(f"never.{c.card_id}", [c], "refuse", scope, [("when", _who(c))]))
        else:
            asks.append((c, tools))
            holds.append(_policy(f"ask.{c.card_id}", [c], "hold", scope, [("when", _who(c))]))
    autos = _autos(all_cards, effects)
    for unit in autos:
        conditions = [("when", _conj([unit.who, _limits(unit, effects, cap)]))]
        if review:
            conditions.append(("when", _review_gate(unit, effects)))
        conditions.append(("unless", _exclusions(unit, asks, autos)))
        permits.append(_policy(f"auto.{unit.name}", unit.cards, "auto", unit.scope, conditions))
        holds.append(_policy(f"twin.{unit.name}", unit.cards, "hold", unit.scope, [("when", unit.who)]))
    return CompiledSets(F="\n\n".join(sorted(forbids)), A="\n\n".join(sorted(permits)),
                        H="\n\n".join(sorted(holds)), cards=all_cards)
