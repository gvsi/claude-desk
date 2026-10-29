"""Activation: what has to hold before a compiled rule set may decide anything.

The bounded check (`bounded_check`) stands in for the SymCC proofs when `desk-prove` can't run
(the kernel's `bounded` proof mode). It evaluates requests generated on every card boundary with
the real engine and compares the compiled sets with the reference generator's, check by check, as
the proofs would. A bounded report says "checked on N cases", never "proved", and never activates
an owner's draft: it tells the owner what a proof would most likely have found.

The engine has no unload, so `drop_keys` drops a key with a load that is built to fail: the engine
drops whatever it cached under a key whose load fails.
"""

import itertools
import json
import logging
import threading
from collections.abc import Iterable, Iterator, Mapping, Sequence
from datetime import time
from typing import Any, NamedTuple

import desk_kernel

from desk.contracts import AUTO_MONEY_HARD_CAP_CENTS, MONEY_TOOLS, ProofCheck, ProofReport, RuleCard, ToolProfile
from desk.kernel_service import compiler, review_thresholds
from desk.kernel_service.reference import RefSets

log = logging.getLogger(__name__)

# The bounded checks, in the order a report lists them. Each holds when, on every case:
# - auto_within_cards: `:policy` auto-allows => `:R` auto-allows;
# - review_only_narrows: `:policy` auto-allows => `:a0` auto-allows;
# - hold_within_cards: `:approvable` holds => `:R_hold` holds;
# - money_needs_card: for a money tool no non-default card covers, `:policy` never auto-allows;
# - never_errors: no evaluation on any key returns errors.
BOUNDED_CHECKS = ("auto_within_cards", "review_only_narrows", "hold_within_cards", "money_needs_card", "never_errors")
MAX_BOUNDED_CASES = 5000
# What each bounded key loads, as (F, A, H) from the compiled sets, A0 and the reference sets.
_BOUNDED_SETS = ("policy", "approvable", "a0", "R", "R_hold")
_MONEY_EFFECTS = frozenset({"charge", "pay_out"})
_PROVER_PLAIN = "Your rules couldn't be checked, so nothing changed."

_in_use: set[str] = set()
_in_use_lock = threading.Lock()


def bounded_keys(key_prefix: str) -> list[str]:
    """The engine keys a bounded check of `key_prefix` loads, in `_BOUNDED_SETS` order. They live
    under `bounded:`, apart from the `<desk_id>:<version>` keys of loaded versions, so dropping them
    can never evict a version that is deciding."""
    return [f"bounded:{key_prefix}:{name}" for name in _BOUNDED_SETS]


def drop_keys(engine: desk_kernel.PolicyEngine, keys: Iterable[str]) -> None:
    """Drops each key from `engine` with a load that fails (an empty sets object doesn't lint), so
    deciding on it refuses as "not loaded". Raises if a load ever succeeds instead."""
    for key in keys:
        if not engine.load(key, "{}", "{}"):
            raise RuntimeError("a load built to fail was accepted, so a key wasn't dropped")


def money_uncovered(cards: Iterable[RuleCard], profiles: Sequence[ToolProfile]) -> list[str]:
    """The enabled money tools (a `charge` or `pay_out` effect, or in `MONEY_TOOLS`) that no
    non-default card covers: `money_needs_card` requires the auto set never to allow them."""
    owned = [card for card in cards if not card.is_default]
    return sorted(p.tool for p in profiles
                  if _is_money(p.tool, frozenset(p.effects))
                  and not any(compiler.covers(card, p.tool, profiles, owned) for card in owned))


def bounded_check(engine: desk_kernel.PolicyEngine, *, key_prefix: str, schema_json: str,
                  compiled: compiler.CompiledSets, a0: str, refs: RefSets, cards: Sequence[RuleCard],
                  profiles: Sequence[ToolProfile]) -> ProofReport:
    """Checks `compiled` (with `a0`, the auto set compiled without review gates) against the
    reference sets on the requests `bounded_cases` generates, and returns a `method="bounded"`
    report whose `cases` is how many it evaluated. Synchronous: call it through
    `asyncio.to_thread`. It loads five keys (`bounded_keys(key_prefix)`):

    - `:policy` (`F`, `A`, `H`), `:approvable` (`F`, empty, `H`), `:a0` (`F`, `A0`, `H`);
    - `:R` (the reference's never forbids, `R`, empty) and `:R_hold` (never, empty, `R_hold`);

    and drops all five when done, whatever happens. A load error fails the `lint` check and
    nothing is evaluated; any other error fails a `prover` check. Each failing check carries the
    first failing request in `counterexample_raw`. A key prefix can be checked once at a time."""
    keys = bounded_keys(key_prefix)
    with _in_use_lock:
        if key_prefix in _in_use:
            raise RuntimeError("a bounded check of this key prefix is already running")
        _in_use.add(key_prefix)
    try:
        sets = {
            "policy": (compiled.F, compiled.A, compiled.H),
            "approvable": (compiled.F, "", compiled.H),
            "a0": (compiled.F, a0, compiled.H),
            "R": (refs.never, refs.R, ""),
            "R_hold": (refs.never, "", refs.R_hold),
        }
        for name, key in zip(_BOUNDED_SETS, keys, strict=True):
            f, a, h = sets[name]
            errors = engine.load(key, schema_json, json.dumps({"F": f, "A": a, "H": h}))
            if errors:
                log.warning("bounded check: %s doesn't load: %s", name, errors)
                return ProofReport(ok=False, method="bounded", cases=0, checks=[ProofCheck(name="lint", ok=False)])
        try:
            cases = bounded_cases(cards, profiles, json.loads(schema_json))
            failures = _evaluate(engine, dict(zip(_BOUNDED_SETS, keys, strict=True)), cases,
                                 set(money_uncovered(cards, profiles)))
        except Exception:
            log.exception("bounded check failed to run")
            return ProofReport(ok=False, method="bounded", cases=0,
                               checks=[ProofCheck(name="prover", ok=False, counterexample_plain=_PROVER_PLAIN)])
        checks = [ProofCheck(name=name, ok=name not in failures, counterexample_raw=failures.get(name))
                  for name in BOUNDED_CHECKS]
        return ProofReport(ok=all(c.ok for c in checks), method="bounded", cases=len(cases), checks=checks)
    finally:
        try:
            drop_keys(engine, keys)
        finally:
            with _in_use_lock:
                _in_use.discard(key_prefix)


def _auto_allows(verdict: Mapping[str, Any]) -> bool:
    """Did the auto evaluation (`B ∪ F ∪ A`) allow? An allow, or a hold decided by an `A.` permit
    (decision step 5 holds money no owner card covers): the proofs compare Cedar's answers, before
    step 5, so the bounded check does too."""
    return verdict["outcome"] == "allow" or (
        verdict["outcome"] == "hold" and any(policy_id.startswith("A.") for policy_id in verdict["policy_ids"]))


def _evaluate(engine: desk_kernel.PolicyEngine, keys: Mapping[str, str], cases: Sequence[dict],
              uncovered: set[str]) -> dict[str, dict]:
    """The first failing case of each check that fails, by check name."""
    failures: dict[str, dict] = {}

    def fail(name: str, case: dict) -> None:
        failures.setdefault(name, case)

    for case in cases:
        text = json.dumps(case)
        verdict = {name: json.loads(engine.decide(key, text, "final")) for name, key in keys.items()}
        if any(v["errors"] for v in verdict.values()):
            fail("never_errors", case)
        policy_allows = _auto_allows(verdict["policy"])
        if policy_allows and not _auto_allows(verdict["R"]):
            fail("auto_within_cards", case)
        if policy_allows and not _auto_allows(verdict["a0"]):
            fail("review_only_narrows", case)
        if verdict["approvable"]["outcome"] == "hold" and verdict["R_hold"]["outcome"] != "hold":
            fail("hold_within_cards", case)
        if policy_allows and case["action"] in uncovered:
            fail("money_needs_card", case)
    return failures


# ---- The cases ----------------------------------------------------------------------------------
#
# Per enabled tool: the principal kinds it applies to × unverified, verified and record-owner
# standings × no person, each person named in cards and one other × for agents, each agent key
# named in cards and one other, and on charge tools with and without mandate room; crossed with
# amounts, discounts, times and reviews, each only where an auto card on the tool limits it:
#
# - amounts {each limit and limit + 1, absent, 0, 50000, 50001, 1000000} (always on money tools);
# - discounts {each limit and limit + 1, absent, 10000} (every auto card has a discount limit);
# - times {each window's start, start - 1, end - 1, end, and its start on each day outside it};
# - reviews {the tool's thresholds and each ± 1, absent, (10000, 0), (0, 10000)}.
#
# Each list starts with a value inside the limits. Boundary values come first, in three passes,
# and the whole product follows:
#
# 1. boundaries: every principal with the first value of each list; then each auto card's own
#    boundaries, for the principals the card is for: inside all its limits, then one limit at a
#    time just past it (its amount and discount + 1, its window's edges and outside days, each
#    other review value);
# 2. every principal with each value of each list alone (the rest at their first);
# 3. every principal with every other combination, by the sum of the values' positions.
#
# Each pass runs for every tool before the next starts, the tools taking turns, so the cap cuts
# the least likely combinations first and never one tool's boundaries for another's. The result
# is deduplicated and capped at MAX_BOUNDED_CASES.

_ABSENT = None
_COPY = "case-copy"
_SESSION = "case-session"
_RESOURCE = "case-resource"
_OTHER_PERSON = "case-other-person"
_OTHER_AGENT = "case-other-agent"
_NO_HOURS = (1, 600)                                 # Tuesday 10:00, where no card has hours
_MANDATE_ROOM = 1_000_000
_STANDINGS = ("unverified", "verified", "record_owner")
_DAYS = {"mon": 0, "tue": 1, "wed": 2, "thu": 3, "fri": 4, "sat": 5, "sun": 6}


class _Principal(NamedTuple):
    kind: str                                        # the Cedar principal type
    resource: str                                    # the Cedar resource type
    standing: str                                    # unverified, verified or record_owner
    person: str | None
    agent: str | None
    mandate: int | None


def bounded_cases(cards: Iterable[RuleCard], profiles: Iterable[ToolProfile], schema: Mapping[str, Any]) -> list[dict]:
    """The bounded check's requests (`request_json`s) for `cards` over the enabled `profiles`,
    deduplicated, boundary values first and capped at `MAX_BOUNDED_CASES`. A profile whose tool
    the schema doesn't declare gets none (its policies couldn't load)."""
    owned = [card for card in cards if not card.is_default]
    persons = _named([card.person_id for card in owned if card.who == "person"], _OTHER_PERSON)
    agents = _named([card.agent_key_id for card in owned if card.who == "agent"], _OTHER_AGENT)
    actions = schema.get("", {}).get("actions", {})
    passes = [_tool_passes(p, actions[p.tool], owned, persons, agents)
              for p in sorted(profiles, key=lambda p: p.tool) if "appliesTo" in actions.get(p.tool, {})]
    cases: list[dict] = []
    seen: set[str] = set()
    for streams in (list(tool_passes) for tool_passes in zip(*passes, strict=True)):   # a pass at a time, all tools
        while streams and len(cases) < MAX_BOUNDED_CASES:
            for stream in list(streams):
                case = next(stream, None)
                if case is None:
                    streams.remove(stream)
                    continue
                key = json.dumps(case, sort_keys=True)
                if key not in seen:
                    seen.add(key)
                    cases.append(case)
                    if len(cases) == MAX_BOUNDED_CASES:
                        return cases
    return cases


def _is_money(tool: str, effects: frozenset[str]) -> bool:
    return tool in MONEY_TOOLS or bool(effects & _MONEY_EFFECTS)


def _named(values: Iterable[str | None], other: str) -> list[str]:
    """The named values, sorted, then one more that is none of them (the last)."""
    named = sorted({value for value in values if value})
    while other in named:
        other += "-x"
    return [*named, other]


def _dedup(values: Iterable[Any]) -> list[Any]:
    out: list[Any] = []
    for value in values:
        if value not in out:
            out.append(value)
    return out


def _tool_passes(profile: ToolProfile, action: Mapping[str, Any], owned: Sequence[RuleCard], persons: Sequence[str],
                 agents: Sequence[str]) -> tuple[Iterator[dict], Iterator[dict], Iterator[dict]]:
    """The tool's cases in the three passes: boundaries, each value alone, every combination."""
    tool, effects = profile.tool, frozenset(profile.effects)
    on_tool = [card for card in owned if card.applies_to == tool
               or (card.applies_to.startswith("effect:") and card.applies_to.removeprefix("effect:") in effects)]
    autos = [card for card in on_tool if card.mode == "auto"]
    dimensions = [_amounts(autos, money=_is_money(tool, effects)), _discounts(autos), _times(autos),
                  _reviews(autos, effects)]
    principals = [_Principal(kind, resource, standing, person, agent, mandate)
                  for kind in action["appliesTo"]["principalTypes"]
                  for resource in action["appliesTo"]["resourceTypes"]
                  for standing in _STANDINGS
                  for person in (_ABSENT, *persons)
                  for agent in (agents if kind == "Agent" else (_ABSENT,))
                  for mandate in ((_ABSENT, _MANDATE_ROOM) if kind == "Agent" and "charge" in effects else (_ABSENT,))]
    recipient = "verified_contact" if "send_message" in effects else _ABSENT

    def requests(values: tuple, who: Sequence[_Principal]) -> Iterator[dict]:
        amount, discount, (dow, minute), review = values
        for principal in who:
            yield _request(tool, principal, amount=amount, discount=discount, dow=dow, minute=minute, review=review,
                           recipient=recipient)

    def at(positions: tuple[int, ...]) -> tuple:
        return tuple(values[i] for values, i in zip(dimensions, positions, strict=True))

    def boundaries() -> Iterator[dict]:
        first = at(tuple(0 for _ in dimensions))
        yield from requests(first, principals)
        for card in autos:
            for values in _card_boundaries(card, first, dimensions):
                yield from requests(values, _for_card(card, principals, persons[-1], agents[-1]))

    def alone() -> Iterator[dict]:
        for positions in _alone([len(values) for values in dimensions]):
            yield from requests(at(positions), principals)

    def combined() -> Iterator[dict]:
        for positions in _combined([len(values) for values in dimensions]):
            yield from requests(at(positions), principals)

    return boundaries(), alone(), combined()


def _for_card(card: RuleCard, principals: Sequence[_Principal], other_person: str,
              other_agent: str) -> list[_Principal]:
    """The principals a card is for: those it names, or, for a card for a kind of principal, one
    of each kind and standing it takes (no person, or someone it doesn't name)."""
    def plain(p: _Principal) -> bool:
        return p.person in (_ABSENT, other_person) and p.agent in (_ABSENT, other_agent)

    match card.who:
        case "anyone":
            return [p for p in principals if plain(p)]
        case "verified":
            return [p for p in principals if plain(p) and p.standing != "unverified"]
        case "record_owner":
            return [p for p in principals if plain(p) and p.standing == "record_owner"]
        case "person":
            return [p for p in principals
                    if p.person == card.person_id and p.agent in (_ABSENT, other_agent) and p.standing != "unverified"]
        case "agent":
            return [p for p in principals
                    if p.kind == "Agent" and p.agent == card.agent_key_id and p.person in (_ABSENT, other_person)]
    return []


def _card_boundaries(card: RuleCard, first: tuple, dimensions: Sequence[list]) -> Iterator[tuple]:
    """Values inside all of `card`'s limits, then each of its limits just past (or on) its edge."""
    amount, discount, when, review = first
    if card.max_amount_cents is not None:
        amount = card.max_amount_cents
    discount = card.max_discount_bp
    window = _times([card]) if card.hours is not None else [when]
    when = window[0]
    inside = (amount, discount, when, review)
    yield inside
    if card.max_amount_cents is not None:
        yield (card.max_amount_cents + 1, discount, when, review)
    if card.max_discount_bp < 10_000:
        yield (amount, card.max_discount_bp + 1, when, review)
    for edge in window[1:]:
        yield (amount, discount, edge, review)
    if card.review:
        for other in dimensions[3][1:]:
            yield (amount, discount, when, other)


def _alone(sizes: Sequence[int]) -> Iterator[tuple[int, ...]]:
    """Positions into lists of `sizes` with one list past its first value, by position."""
    for position in range(1, max(sizes, default=1)):
        for dimension, size in enumerate(sizes):
            if position < size:
                yield tuple(position if d == dimension else 0 for d in range(len(sizes)))


def _combined(sizes: Sequence[int]) -> Iterator[tuple[int, ...]]:
    """Positions with two or more lists past their first value, by the sum of the positions.
    Lazy: the cap stops it long before the end of a large product."""
    for level in range(2, sum(size - 1 for size in sizes) + 1):
        for positions in _with_sum(level, sizes):
            if sum(1 for p in positions if p) >= 2:
                yield positions


def _with_sum(level: int, sizes: Sequence[int]) -> Iterator[tuple[int, ...]]:
    if not sizes:
        if level == 0:
            yield ()
        return
    rest = sum(size - 1 for size in sizes[1:])
    for position in range(max(0, level - rest), min(sizes[0] - 1, level) + 1):
        for tail in _with_sum(level - position, sizes[1:]):
            yield (position, *tail)


def _amounts(autos: Sequence[RuleCard], *, money: bool) -> list[int | None]:
    limits = sorted({card.max_amount_cents for card in autos if card.max_amount_cents is not None})
    if not (money or limits):
        return [_ABSENT]
    values = [*itertools.chain.from_iterable((limit, limit + 1) for limit in limits), _ABSENT, 0,
              AUTO_MONEY_HARD_CAP_CENTS, AUTO_MONEY_HARD_CAP_CENTS + 1, 1_000_000]
    return _dedup(v for v in values if v is _ABSENT or 0 <= v <= 1_000_000)


def _discounts(autos: Sequence[RuleCard]) -> list[int | None]:
    if not autos:
        return [_ABSENT]
    limits = sorted({card.max_discount_bp for card in autos})
    values = [*itertools.chain.from_iterable((limit, limit + 1) for limit in limits), _ABSENT, 10_000]
    return _dedup(v for v in values if v is _ABSENT or 0 <= v <= 10_000)


def _local(day: int, minute: int) -> tuple[int, int]:
    """A day and minute, carried into the day before or after when the minute falls outside it."""
    return ((day + minute // 1440) % 7, minute % 1440)


def _minute(value: time) -> int:
    return value.hour * 60 + value.minute


def _times(autos: Sequence[RuleCard]) -> list[tuple[int, int]]:
    windows = _dedup((tuple(card.hours.days), card.hours.start, card.hours.end) for card in autos if card.hours)
    if not windows:
        return [_NO_HOURS]
    values = []
    for days, start_time, end_time in windows:
        numbers = sorted({_DAYS[day] for day in days})
        start, end = _minute(start_time), _minute(end_time) or 1440        # an end of 00:00 is midnight
        values += [_local(numbers[0], start), _local(numbers[0], start - 1), _local(numbers[0], end - 1),
                   _local(numbers[0], end)]
        values += [(day, start) for day in range(7) if day not in numbers]
    return _dedup(values)


def _reviews(autos: Sequence[RuleCard], effects: frozenset[str]) -> list[tuple[int, int] | None]:
    if not any(card.review for card in autos):
        return [_ABSENT]
    row = review_thresholds.thresholds_for(sorted(effects))
    within, manipulation = row.min_within_charter_bp, row.max_manipulation_bp
    values = [(within, manipulation), (within - 1, manipulation), (within, manipulation + 1),
              (within + 1, manipulation), (within, manipulation - 1), _ABSENT, (10_000, 0), (0, 10_000)]
    return _dedup(v for v in values if v is _ABSENT or (0 <= v[0] <= 10_000 and 0 <= v[1] <= 10_000))


def _request(tool: str, principal: _Principal, *, amount: int | None, discount: int | None, dow: int, minute: int,
             review: tuple[int, int] | None, recipient: str | None) -> dict:
    principal_type, resource_type, standing, person, agent, mandate = principal
    verified = standing != "unverified"
    attrs: dict[str, Any] = {"verified": verified, "assurance": "demo_code" if verified else "none", "copy": _COPY}
    if person is not None:
        attrs["person_id"] = person
    if principal_type == "Agent":
        attrs["agent_key_id"] = agent
        if mandate is not None:
            attrs["mandate_remaining_cents"] = mandate
    context: dict[str, Any] = {"record_owner_match": standing == "record_owner", "local_dow": dow,
                               "local_minute": minute}
    if amount is not None:
        context["amount_cents"] = amount
    if discount is not None:
        context["discount_bp"] = discount
    if recipient is not None:
        context["recipient"] = recipient
    if review is not None:
        context["review"] = {"within_charter_bp": review[0], "manipulation_bp": review[1]}
    principal_uid = {"type": principal_type, "id": _SESSION}
    resource_uid = {"type": resource_type, "id": _RESOURCE}
    return {"principal": principal_uid, "action": tool, "resource": resource_uid, "context": context,
            "entities": [{"uid": principal_uid, "attrs": attrs, "parents": []},
                         {"uid": resource_uid, "attrs": {"copy": _COPY}, "parents": []}]}
