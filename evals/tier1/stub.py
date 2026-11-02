"""The contract stub: a kernel stand-in that checks each call against the kernel API models.

It validates the request against its route's model, refuses unknown routes and expectations that
name paths the response model lacks, and answers with a seeded, valid response carrying the
expected values. Its results are "contract-checked", never passes: nothing real answered.
"""

import copy
import hashlib
import json
import types
from collections import deque
from collections.abc import Callable, Iterator
from datetime import date, datetime, time, timedelta
from itertools import chain
from random import Random
from typing import Annotated, Any, Literal, Union, get_args, get_origin
from zoneinfo import ZoneInfo

from faker import Faker
from polyfactory.exceptions import FactoryException
from polyfactory.factories.pydantic_factory import ModelFactory
from pydantic import (
    AwareDatetime,
    BaseModel,
    FutureDate,
    FutureDatetime,
    NaiveDatetime,
    PastDate,
    PastDatetime,
    TypeAdapter,
    ValidationError,
    create_model,
)

from desk.contracts import (
    ApprovalResult,
    CopyCreated,
    DemoAgentIssued,
    Fact,
    PolicyVersion,
    Probe,
    ProbeResult,
    RuleCard,
    SessionCreated,
    ToolCall,
)
from desk.kernel_api import AgentAbility, KernelError, OpenStatus, PublicDesk
from evals.tier1.harness import (
    PLANS,
    Auth,
    Called,
    ContractError,
    Expect,
    TravelClock,
    check_expect_paths,
    check_request,
    is_matcher,
    match_expect,
    matches,
    response_type,
    validation_summary,
)

__all__ = ["STUB_CARD", "ContractError", "ContractStub", "build"]

SEED = 5   # each response's generators start from this seed, so the same call gets the same answer
RESEEDS = 8   # further seeds a field is built from when `$not` rejects its generated value
MOMENT_SPREAD_S = 30 * 24 * 3600   # a generated date or time is within thirty days of the open status's as_of
PLAIN_VALUES = ("str", "int", "float", "bool")   # the Faker value types a bare collection holds

# A rule card that passes RuleCard's validator, for responses whose expectations need one.
STUB_CARD = RuleCard(
    card_id="stub-ask-quote", applies_to="native.quote", mode="ask", who="anyone", reason="Mike checks quotes first."
)
# A probe that passes Probe's validator (only a scoped caller names a subject).
STUB_PROBE = Probe(
    actor="visitor", who="anyone", call=ToolCall(call_id="stub-probe", tool="native.quote", args={}), resource_kind="desk"
)
# An open status that passes OpenStatus's validator (an open one names only `until`, after `as_of`;
# `refresh_at` is after `as_of`, at or before the boundary and within 25 hours): a Tuesday morning
# in the Turner seed's time zone, open until five.
_STUB_TZ = ZoneInfo("America/Los_Angeles")
STUB_OPEN_STATUS = OpenStatus(
    open=True, until=datetime(2026, 11, 3, 17, 0, tzinfo=_STUB_TZ), opens_at=None, text="Open until five this afternoon",
    as_of=datetime(2026, 11, 3, 10, 0, tzinfo=_STUB_TZ), refresh_at=datetime(2026, 11, 3, 17, 0, tzinfo=_STUB_TZ),
)
# An Agent Card ability that passes AgentAbility's validator (an outcome comes with its words).
STUB_ABILITY = AgentAbility(kind="prose", text="Book a visit", outcome="allowed", outcome_text="Allowed")
# Credentials a case can use on its next call: a visitor's session token, and an agent key that
# signs (a fixed test key, not a secret). The stub's Desks share one slug.
STUB_SESSION_TOKEN = "stub-session-token"
STUB_AGENT_KEY_HEX = hashlib.sha256(b"claude desk contract stub agent").hexdigest()
STUB_SLUG = "turner-plumbing-stub00"

# The error code for a status when the expectation names none ("Session state responses"); every
# 5xx is "internal".
ERROR_CODES = {400: "invalid", 401: "auth", 404: "not_found", 409: "conflict", 422: "invalid"}

_FAKER = Faker()


def _fixed_fields(model: type[BaseModel]) -> dict[str, Any]:
    """Fields a random value would break: models with validators are fixtures or left out, and
    credentials are ones the next call can use."""
    return {
        PolicyVersion: {"cards": []},
        ApprovalResult: {"card_diff": None},
        Fact: {"claims": []},
        ProbeResult: {"probe": STUB_PROBE},
        PublicDesk: {"open_status": STUB_OPEN_STATUS, "agent_card": [STUB_ABILITY]},
        KernelError: {"detail": None},
        SessionCreated: {"session_token": STUB_SESSION_TOKEN},
        DemoAgentIssued: {"agent_private_key_hex": STUB_AGENT_KEY_HEX},
    }.get(model, {})


def _relative_to_today(tp: type) -> Callable[[], Any]:
    """A provider for a past or a future date type that fails the build, naming the type."""

    def refuse() -> Any:
        raise NotImplementedError(
            f"the contract stub can't build a {tp.__name__}: polyfactory fills one from the wall clock and "
            "pydantic checks it against today, so no seeded value stays valid; give the stub a fixed value for "
            "the field before a contract uses the type"
        )

    return refuse


def _clock_free(rng: Random, faker: Faker) -> dict[Any, Callable[[], Any]]:
    """Providers in place of polyfactory's that read the wall clock: those for each date and time
    type, and Faker's bare collections, whose plain values include a `date_time`. A date or time is
    drawn from `rng` within thirty days of the open status's Tuesday morning, so the same call gets
    the same answer whenever it is built. A past or a future date has no such value, so building one
    fails, naming its type (`_relative_to_today`); an optional one that a build leaves empty fails
    only when an expectation needs a value for it. (Bounded dates still read the clock through
    polyfactory; no contract has one, and the stub's wall clock test would fail on one.)"""

    def moment() -> datetime:
        return STUB_OPEN_STATUS.as_of + timedelta(seconds=rng.randrange(-MOMENT_SPREAD_S, MOMENT_SPREAD_S))

    plain = {"value_types": PLAIN_VALUES}
    return {
        datetime: moment,
        AwareDatetime: moment,
        NaiveDatetime: lambda: moment().replace(tzinfo=None),
        date: lambda: moment().date(),
        time: lambda: moment().time(),   # a time of day carries no offset
        timedelta: lambda: timedelta(seconds=rng.randrange(MOMENT_SPREAD_S)),
        **{tp: _relative_to_today(tp) for tp in (PastDate, FutureDate, PastDatetime, FutureDatetime)},
        dict: lambda: faker.pydict(**plain),
        list: lambda: faker.pylist(**plain),
        tuple: lambda: faker.pytuple(**plain),
        set: lambda: faker.pyset(**plain),
        frozenset: lambda: frozenset(faker.pyset(**plain)),
        deque: lambda: deque(faker.pylist(**plain)),
    }


class _SameGenerators:
    """A factory mixin: nested models are built from the same seeded generators, with fixed fields,
    and never from the wall clock."""

    @classmethod
    def _get_or_create_factory(cls, model: Any) -> Any:
        if isinstance(model, type) and issubclass(model, BaseModel):
            return _factory(model, cls.__random__, cls.__faker__)
        return super()._get_or_create_factory(model)

    @classmethod
    def get_provider_map(cls) -> dict[Any, Callable[[], Any]]:
        return {**super().get_provider_map(), **_clock_free(cls.__random__, cls.__faker__)}


def _factory(model: type[BaseModel], rng: Random, faker: Faker) -> type[ModelFactory]:
    return ModelFactory.create_factory(
        model, bases=(_SameGenerators,), __random__=rng, __faker__=faker, **_fixed_fields(model)
    )


class _Builder:
    """JSON values of any contract type, from generators seeded afresh for each response."""

    def __init__(self) -> None:
        self.rng = Random(SEED)
        _FAKER.seed_instance(SEED)

    def build(self, tp: Any) -> Any:
        origin = get_origin(tp)
        if origin is Annotated:
            return self.build(get_args(tp)[0])
        if origin in (Union, types.UnionType):
            return self.build(next(member for member in get_args(tp) if member is not type(None)))
        if origin is Literal:
            return get_args(tp)[0]
        if origin in (list, tuple):
            return [self.build(get_args(tp)[0])]
        if tp is RuleCard:
            return STUB_CARD.model_dump(mode="json")
        if tp is Probe:
            return STUB_PROBE.model_dump(mode="json")
        if tp is OpenStatus:
            return STUB_OPEN_STATUS.model_dump(mode="json")
        if tp is AgentAbility:
            return STUB_ABILITY.model_dump(mode="json")
        if isinstance(tp, type) and issubclass(tp, BaseModel):
            return _factory(tp, self.rng, _FAKER).build().model_dump(mode="json")
        if tp is dict or origin is dict:
            return {}
        if tp is bool:
            return False
        if tp is int:
            return 0
        if tp is str:
            return f"stub-{self.rng.getrandbits(32):08x}"
        return None


def build(tp: Any, expect: Expect = Expect()) -> Any:
    """A seeded, valid instance of a response type with the expected values written over it.

    Raises `ValidationError` when the expected values don't fit the type."""
    builder = _Builder()
    body = builder.build(tp)
    if tp is KernelError:
        body["code"] = "internal" if 500 <= expect.status < 600 else ERROR_CODES.get(expect.status, body["code"])
    for path, expected in expect.fields.items():
        body = _write(body, tp, path.split("."), expected, builder)
    return TypeAdapter(tp).validate_json(json.dumps(body))


def _write(body: Any, tp: Any, segments: list[str], expected: Any, builder: _Builder) -> Any:
    """`body` with the expected value written at the dotted path, building any missing parents."""
    if not segments:
        return _satisfy(body, tp, expected, builder)
    head, rest = segments[0], segments[1:]
    child_tp = _child_type(tp, head)
    if isinstance(body, list):
        index = int(head)
        while len(body) <= index:
            body.append(builder.build(child_tp))
        body[index] = _write(body[index], child_tp, rest, expected, builder)
        return body
    if not isinstance(body, dict):
        body = builder.build(tp)
    current = body.get(head)
    if current is None and rest:
        current = builder.build(child_tp)
    body[head] = _write(current, child_tp, rest, expected, builder)
    return body


def _child_type(tp: Any, segment: str) -> Any:
    """The type one path segment below `tp` (`check_expect_paths` has checked the path exists)."""
    origin = get_origin(tp)
    if origin is Annotated:
        return _child_type(get_args(tp)[0], segment)
    if origin in (Union, types.UnionType):
        members = [member for member in get_args(tp) if member is not type(None)]
        return next((child for member in members if (child := _child_type(member, segment)) is not None), None)
    if origin in (list, tuple):
        return get_args(tp)[0] if segment.isdigit() else None
    if tp is dict or origin is dict:
        args = get_args(tp)
        return args[1] if args else Any
    if isinstance(tp, type) and issubclass(tp, BaseModel):
        field = tp.model_fields.get(segment)
        if field is None:
            return None
        # The field's constraints (ge, pattern, strict) stay on its type, so a value can be checked alone.
        return Annotated[(field.annotation, *field.metadata)] if field.metadata else field.annotation
    return Any if tp is Any else None


def _satisfy(current: Any, tp: Any, expected: Any, builder: _Builder) -> Any:
    """A field value meeting the expectation: the expected value, or a valid value of the field's
    type that every matcher accepts. That is the first `$in` option they all accept, or the
    generated value sized to `$len` and holding `$has`; when `$not` rejects it, another value of the
    type (another literal, None for an optional, a flipped bool, another list or object, or a build
    from another seed). With none, the generated value: the match check after the build reports it."""
    if not is_matcher(expected):
        return expected
    accepts = _acceptor(tp, expected)
    generated = builder.build(tp) if current is None else current
    if "$in" in expected:
        options = expected["$in"]
        return next((option for option in options if accepts(option)), options[0] if options else generated)
    candidates = (_shape(value, tp, expected, builder) for value in chain([generated], _alternatives(tp, builder)))
    first = next(candidates)
    if accepts(first):
        return first
    return next((value for value in candidates if accepts(value)), first)


def _acceptor(tp: Any, expected: Any) -> Callable[[Any], bool]:
    """Whether a value is valid for the field's type and, as the type gives it back, meets `expected`."""
    adapter = TypeAdapter(tp)

    def accepts(value: Any) -> bool:
        try:
            checked = adapter.dump_python(adapter.validate_json(json.dumps(value)), mode="json")
        except (TypeError, ValueError):   # not JSON, or not valid for the type (ValidationError)
            return False
        return matches(checked, expected)

    return accepts


def _shape(value: Any, tp: Any, expected: Any, builder: _Builder) -> Any:
    """A copy of `value` sized to `$len` and holding `$has`, where it is a list, string or object."""
    value = copy.deepcopy(value)
    count = expected.get("$len")
    has, item = "$has" in expected, expected.get("$has")
    if isinstance(value, list):
        if count is not None:
            del value[count:]
            value.extend(builder.build(_child_type(tp, "0")) for _ in range(count - len(value)))
        if has and not matches(value, {"$has": item}):
            if count is not None and value:
                value[-1] = item
            else:
                value.append(item)
    elif isinstance(value, str):
        if has and isinstance(item, str) and (count is not None or item not in value):
            value = item if count is None else item + value   # the item first, so sizing keeps it
        if count is not None:
            value = (value + "x" * count)[:count]
    elif isinstance(value, dict):
        if has and isinstance(item, str) and item not in value:
            value[item] = builder.build(_child_type(tp, item))
        if count is not None:
            for key in [key for key in value if key != item][: max(len(value) - count, 0)]:
                del value[key]
            for key in (f"stub-key-{n}" for n in range(2 * count)):
                if len(value) >= count:
                    break
                if key not in value:
                    value[key] = builder.build(_child_type(tp, key))
    return value


def _alternatives(tp: Any, builder: _Builder) -> Iterator[Any]:
    """Other values of `tp`, in a fixed order, for a field whose generated value `$not` rejects."""
    base = get_args(tp)[0] if get_origin(tp) is Annotated else tp
    origin = get_origin(base)
    if origin in (Union, types.UnionType):
        members = [member for member in get_args(base) if member is not type(None)]
        if len(members) < len(get_args(base)):
            yield None
        for member in members:
            yield from _alternatives(member, builder)
    elif origin is Literal:
        yield from get_args(base)
    elif base is bool:
        yield from (False, True)
    elif origin in (list, tuple):
        for length in range(3):
            yield [builder.build(get_args(base)[0]) for _ in range(length)]
    elif base is dict or origin is dict:
        yield {}
    else:
        # A one-field model, so the factory honours the field's constraints (a pattern, a range).
        holder = create_model("StubValue", value=(tp, ...))
        for seed in range(SEED + 1, SEED + 1 + RESEEDS):
            try:
                built = _factory(holder, Random(seed), _FAKER).build()
            except (FactoryException, ValidationError):   # e.g. a model whose validator a random value breaks
                continue
            yield built.model_dump(mode="json")["value"]


class ContractStub:
    """The contract stub target: nothing is real, and every plan counts as landed."""

    is_real = False

    def __init__(self) -> None:
        self.clock = TravelClock()
        self.responses: list[Called] = []

    async def call(
        self,
        route: str,
        *,
        path: dict[str, Any] | None = None,
        query: dict[str, Any] | None = None,
        body: dict[str, Any] | BaseModel | None = None,
        raw_body: Any = None,
        auth: Auth,
        expect: Expect = Expect(),
    ) -> Any:
        request = check_request(route, path=path, query=query, body=body, raw_body=raw_body)
        auth.headers()   # a credential that can't be built fails on the stub too
        check_expect_paths(route, expect)
        answer = expect.any_of[0] if expect.any_of else expect
        tp = response_type(route, answer.status)
        try:
            model = None if tp is None else build(tp, answer)
        except TypeError:
            raise ContractError(f"{route}: the expected values aren't JSON") from None
        except ValidationError as error:   # told by place and kind: pydantic's own text quotes the values
            raise ContractError(f"{route}: the expected values don't fit the response model: "
                                f"{validation_summary(error, tp)}") from None
        response = None if tp is None else TypeAdapter(tp).dump_python(model, mode="json")
        if tp is KernelError and response["detail"] is None:
            del response["detail"]
        self.responses.append(Called(route=route, request=request, status=answer.status, body=response, raw=response))
        if mismatches := match_expect(answer.status, response, expect):
            raise ContractError(f"{route}: the stub can't build the expected answer: {'; '.join(mismatches)}")
        return model

    def landed(self, plan: str) -> bool:
        """True for every plan, so a case's later-plan steps are contract-checked too."""
        if plan not in PLANS:
            raise ValueError(f"unknown plan {plan!r}; the plans are {list(PLANS)}")
        return True

    async def new_copy(self) -> CopyCreated:
        return await self.call("POST /copies", body={}, auth=Auth.none())

    async def visitor(self, copy: CopyCreated) -> SessionCreated:
        return await self.call("POST /sessions", body={"desk_slug": STUB_SLUG, "kind": "visitor"}, auth=Auth.none())
