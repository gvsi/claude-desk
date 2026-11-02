"""What a tier 1 case states and calls: plans, credentials, expected responses and the harness.

A case names the plans it needs, then calls kernel routes through a `KernelHarness` (the
contract stub, or the real kernel in-process) with an `Auth` and the `Expect`ed response; the
harness checks every call against the kernel API contract and the answer against the expectation.
Nothing here imports kernel code: the evals judge the kernel from outside its HTTP contract.
"""

import hashlib
import json
import re
import secrets
import time
import tomllib
import types
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Annotated, Any, Literal, Protocol, Union, get_args, get_origin, runtime_checkable

import rfc8785
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from pydantic import BaseModel, ValidationError

from desk.contracts import A2ARequest, AgentAuth, CopyCreated, DemoAgentIssued, Mandate, SessionCreated
from desk.kernel_api import KERNEL_ROUTES, KernelError

# Plans and targets

# Plan ids a case can require. Kernel ids land in this order, so a case names the last kernel id
# it needs, plus 02a or 02 when it goes through the API (Plan 02a Task 9; Plan 02b Task 12).
PLANS = ("master", "01a", "01b", "01c", "01c-setup", "02a", "02")
KERNEL_PLANS = PLANS[:5]
API_PLANS = PLANS[5:]
TARGETS = ("stub", "kernel", "api")
TIER1_DIR = Path(__file__).resolve().parent
LANDED_FILE = TIER1_DIR / "landed.toml"
SUMMARY_FILE = TIER1_DIR.parent / "out" / "tier1-summary.json"


# The file whose presence says a plan's code is on the branch, so a branch holding the code but
# not the id in landed.toml is named at collection (`unlisted_landed`): a failure on the gate run
# (CI, or `--strict-landed`), a warning elsewhere, since each kernel plan creates its file in an
# early task and adds its id only in its last, with `make evals-tier1` run at every task between
# (its cases skip as pending until then). Checked by path, never imported; master is always listed.
_BACKEND = TIER1_DIR.parents[1] / "backend" / "desk"
LANDS: dict[str, Path] = {
    "01a": _BACKEND / "kernel_service" / "app.py",            # `create_app`: Plan 01a Task 1; the id in Task 18
    "01b": _BACKEND / "kernel_service" / "verification.py",   # Plan 01b Task 1; the id in Task 7
    "01c": _BACKEND / "mockpay" / "server.py",                # mock payments server: Plan 01c Task 1; the id in Task 10
    "01c-setup": _BACKEND / "kernel_service" / "fetch_guard.py",   # Plan 01c Task 8; the id in Task 10
    "02a": TIER1_DIR / "api_impl.py",                         # `make_api_target`: Plan 02a Task 9, with the id
    "02": TIER1_DIR / "test_02_a2a.py",                       # Plan 02b's cases: its Task 12, with the id
}


def unlisted_landed(landed: tuple[str, ...], lands: dict[str, Path] = LANDS) -> list[str]:
    """The plans whose code is on this branch (`lands` names the file that marks it, which a plan
    creates in an early task) but which `landed` leaves out, in plan order."""
    return [plan for plan in PLANS if plan in lands and plan not in landed and lands[plan].exists()]


def unlisted_sentence(unlisted: list[str]) -> str:
    """What collection says of the plans `unlisted_landed` found: the gate run's failure."""
    return "; ".join(f"code for {plan} is on this branch but landed.toml doesn't list it" for plan in unlisted)


def unlisted_warning(unlisted: list[str]) -> str:
    """The same sentence off the gate, as a warning: where the plans' cases go, and what the gate does."""
    whose = "its" if len(unlisted) == 1 else "their"
    return (f"{unlisted_sentence(unlisted)}; {whose} cases skip as pending on the kernel and API targets, "
            "and the gate run (CI, or --strict-landed) fails")


def load_landed(path: Path = LANDED_FILE) -> tuple[str, ...]:
    """The landed plan ids in `landed.toml`, in plan order; a malformed file raises ValueError."""
    plans = tomllib.loads(path.read_text()).get("plans")
    if not isinstance(plans, list) or not all(isinstance(plan, str) for plan in plans):
        raise ValueError(f"{path.name} needs plans = [plan ids]")
    if unknown := sorted(set(plans) - set(PLANS)):
        raise ValueError(f"{path.name} names unknown plans {unknown}; the plans are {list(PLANS)}")
    if "master" not in plans:
        raise ValueError(f"{path.name} must list master")
    kernel = [plan for plan in KERNEL_PLANS if plan in plans]
    if kernel != list(KERNEL_PLANS[: len(kernel)]):
        raise ValueError(f"{path.name}: kernel plans land in the order {list(KERNEL_PLANS)}, not {kernel}")
    return tuple(plan for plan in PLANS if plan in plans)


def skip_reason(target: str, plans: set[str], white_box: bool, landed: tuple[str, ...]) -> str | None:
    """Why a case needing `plans` doesn't run on `target`, or None when it runs.

    The stub runs every case but API and white-box ones, landed or not; the kernel runs landed
    cases that don't need the API; the API target runs every landed case. A landed API case gates
    its plan's PR, so on the API target it never skips: without Plan 02a's `api_impl.py` its `api`
    fixture fails it. A case waiting on several plans is pending the last of them to land."""
    if target in ("stub", "kernel") and plans & set(API_PLANS):
        return "needs api"
    if target == "stub":
        return "needs kernel code" if white_box else None
    pending = [plan for plan in PLANS if plan in plans and plan not in landed]
    return f"pending {pending[-1]}" if pending else None


# Time

def signed_time(moment: datetime) -> str:
    """A signed timestamp, as the `SignedTime` contract states it: RFC 3339 UTC, microseconds, "Z"."""
    if moment.tzinfo is None:
        raise ValueError("a signed time needs an aware datetime")
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


class TravelClock:
    """A ticking clock a case can move: `travel(to)` jumps, `advance(seconds)` moves forward.

    It gives aware UTC, whatever zone it starts or travels in. The real kernel target runs on the
    same clock, so kernel time moves with it. The kernel reads it from its own thread, so its
    state is one tuple, swapped whole: a read never sees a new anchor with an old tick count."""

    def __init__(self, start: datetime | None = None):
        start = start or datetime.now(UTC)
        if start.tzinfo is None:
            raise ValueError("a TravelClock starts at an aware datetime")
        self._state = (start.astimezone(UTC), time.monotonic())   # (the time at the tick count, the tick count)

    def now(self) -> datetime:
        anchor, ticks_from = self._state
        return anchor + timedelta(seconds=time.monotonic() - ticks_from)

    def travel(self, to: datetime) -> None:
        if to.tzinfo is None:
            raise ValueError("travel to an aware datetime")
        self._state = (to.astimezone(UTC), time.monotonic())

    def advance(self, seconds: float) -> None:
        anchor, ticks_from = self._state
        self._state = (anchor + timedelta(seconds=seconds), ticks_from)


# Credentials

class Auth:
    """The credential headers a call carries. Build one with a classmethod; `headers()` gives them."""

    def __init__(self, headers: dict[str, str] | None = None):
        self._headers = dict(headers or {})

    def headers(self) -> dict[str, str]:
        return dict(self._headers)

    @classmethod
    def none(cls) -> "Auth":
        """No credential."""
        return cls()

    @classmethod
    def session(cls, created: SessionCreated) -> "Auth":
        """A visitor or owner session's token (`X-Session-Token`)."""
        if created.session_token is None:
            raise ValueError("an agent session has no token; agents sign each call with Auth.agent")
        return cls({"X-Session-Token": created.session_token})

    @classmethod
    def owner(cls, copy: CopyCreated) -> "Auth":
        """The copy's owner token (`X-Owner-Session`)."""
        return cls({"X-Owner-Session": copy.owner_token})

    @classmethod
    def raw(cls, headers: dict[str, str]) -> "Auth":
        """Headers sent exactly as given, for forged and mismatched credentials."""
        return cls(headers)

    @classmethod
    def agent(
        cls, issued: DemoAgentIssued, desk_slug: str, clock: TravelClock, ts_offset_s: float = 0
    ) -> "AgentTurns":
        """An agent's signature headers, as the API forwards them, one A2A turn at a time."""
        return AgentTurns(issued, desk_slug, clock, ts_offset_s)


class AgentTurns(Auth):
    """An agent's `AgentAuth` headers plus `X-Agent-Body-Sha256`, one A2A turn at a time.

    Each turn signs a synthetic A2A body (`body`) under a fresh nonce, with `ts` from the target's
    clock plus `ts_offset_s`, since the kernel checks `ts` against its own travelled clock (the
    eval plays the forwarding API). Every call in a turn repeats the same headers; `new_turn()`
    starts the next turn."""

    def __init__(self, issued: DemoAgentIssued, desk_slug: str, clock: TravelClock, ts_offset_s: float = 0):
        super().__init__()
        self._key = Ed25519PrivateKey.from_private_bytes(bytes.fromhex(issued.agent_private_key_hex))
        self.agent_key_id = issued.agent_key_id
        self.desk_slug = desk_slug
        self._clock = clock
        self._ts_offset_s = ts_offset_s
        self.new_turn()

    def new_turn(
        self,
        *,
        session_id: str | None = None,
        message: str | None = None,
        nonce: str | None = None,
        verify_code: str | None = None,
        mandate: Mandate | None = None,
    ) -> None:
        """Sign the next turn: a fresh nonce over a new A2A body naming this session and message,
        and the verification code or mandate the agent sends with it, if any. `nonce` signs it
        under a nonce already used instead, for a case that reuses one."""
        request = A2ARequest(
            desk_slug=self.desk_slug, session_id=session_id, message=message or f"Turn {secrets.token_hex(4)}",
            mandate=mandate, verify_code=verify_code,
        )
        self.body = request.model_dump_json().encode()
        body_sha256 = hashlib.sha256(self.body).hexdigest()
        ts = signed_time(self._clock.now() + timedelta(seconds=self._ts_offset_s))
        nonce = nonce or secrets.token_urlsafe(16)
        signed = rfc8785.dumps({"desk_slug": self.desk_slug, "ts": ts, "nonce": nonce, "body_sha256": body_sha256})
        auth = AgentAuth(agent_key_id=self.agent_key_id, ts=ts, nonce=nonce, sig=self._key.sign(signed).hex())
        self._headers = {
            "X-Agent-Key-Id": auth.agent_key_id,
            "X-Agent-Ts": auth.ts,
            "X-Agent-Nonce": auth.nonce,
            "X-Agent-Sig": auth.sig,
            "X-Agent-Body-Sha256": body_sha256,
        }

    def a2a_headers(self) -> dict[str, str]:
        """The headers the agent itself sends with `body` to the API's A2A route: the four
        `AgentAuth` headers. The body hash is the API's to work out from the body it gets."""
        return {name: value for name, value in self._headers.items() if name != "X-Agent-Body-Sha256"}


# Expected responses

MATCHERS = ("$in", "$has", "$len", "$not")


@dataclass(frozen=True)
class Expect:
    """The response a call expects: its status and dotted paths into its body.

    `fields` maps a dotted path (`"outcome"`, `"execution.state"`, `"0.outcome"`, `"code"` on a
    `KernelError`) to a value matched by strict equality (a bool never equals a number), or to a
    matcher: `{"$in": [values]}`, `{"$has": item}` (an element of a list, a substring of a string,
    a key of an object), `{"$len": n}` or `{"$not": value or matcher}`; several matchers in one
    object must all hold. With `any_of`, the response matches one of the alternatives, each with
    its own status and fields (the outer status is then unused)."""

    status: int = 200
    fields: dict[str, Any] = field(default_factory=dict)
    any_of: list["Expect"] = field(default_factory=list)

    def __post_init__(self) -> None:
        if self.any_of and self.fields:
            raise ValueError("with any_of, each alternative names its own fields")
        for path, expected in self.fields.items():
            if "" in path.split("."):
                raise ValueError(f"{path!r} is not a dotted path")
            _check_matcher(expected)


def match_expect(status: int, body: Any, expect: Expect, *, declared: frozenset[str] = frozenset()) -> list[str]:
    """Every way a response differs from the expectation; empty when it matches. A mismatch shows
    what the response held only as `described` allows, so it never prints a code, a contact or a
    token the response carries: a string only when the expectation names it or it is one of
    `declared`, the words the response's contract declares (`declared_names` of the type it was
    read as: field names and enum values, fixed public words, never a value a response chose)."""
    return _mismatches(status, body, expect, named_strings(expect) | declared)


def _mismatches(status: int, body: Any, expect: Expect, named: frozenset[str]) -> list[str]:
    if expect.any_of:
        missed = [_mismatches(status, body, alternative, named) for alternative in expect.any_of]
        if all(missed):
            return [f"matches none of {len(missed)} alternatives: " + " | ".join("; ".join(m) for m in missed)]
        return []
    mismatches = [f"status: expected {expect.status}, got {status}"] if status != expect.status else []
    for path, expected in expect.fields.items():
        actual = _lookup(body, path)
        if actual is _MISSING:
            mismatches.append(f"{path}: missing")
        elif not matches(actual, expected):
            mismatches.append(f"{path}: expected {expected!r}, got {described(actual, named)}")
    return mismatches


def named_strings(expect: Expect) -> frozenset[str]:
    """Every string the expectation names as a value: its fields' values, its matchers' arguments
    and the strings in the lists and objects it expects, across all its alternatives."""
    found: set[str] = set()

    def walk(value: Any) -> None:
        if isinstance(value, str):
            found.add(value)
        elif isinstance(value, list):
            for item in value:
                walk(item)
        elif isinstance(value, dict):
            for item in value.values():
                walk(item)
        elif isinstance(value, Expect):
            walk([*value.fields.values(), *value.any_of])

    walk(expect)
    return frozenset(found)


# A string a mismatch may show, when the expectation names it or the response's contract declares
# it: shaped like the contract's field names and enum values (lowercase words joined by
# underscores, a tool's dotted name) and no longer than one (the longest is 29 characters). A
# code starts with a digit; a token mixes case or runs longer (a 256-bit session token takes at
# least 43 characters, sixteen bytes in hex 32).
SHOWN_STRING = re.compile(r"[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)?")
SHOWN_MAX = 30


def described(value: Any, named: frozenset[str] = frozenset()) -> str:
    """How a mismatch shows a value the response held: a number, a boolean or None as it is; a
    string as it is only when it is one of `named` (what the expectation names, and the words the
    response's contract declares where the caller gives them) and it is a short field name or enum
    value (`SHOWN_STRING`, `SHOWN_MAX`); any other string, and every list and object, by its type
    and size alone, since it may be or hold a code, a contact or a token."""
    if value is None or isinstance(value, bool | int | float):
        return repr(value)
    if isinstance(value, str):
        if value in named and len(value) <= SHOWN_MAX and SHOWN_STRING.fullmatch(value):
            return repr(value)
        return _sized("a string of", len(value), "character", "an empty string")
    if isinstance(value, list):
        return _sized("a list of", len(value), "item", "an empty list")
    if isinstance(value, dict):
        return _sized("an object with", len(value), "field", "an empty object")
    return f"a {type(value).__name__}"


def _sized(kind: str, n: int, unit: str, empty: str) -> str:
    return empty if n == 0 else f"{kind} {n} {unit}{'' if n == 1 else 's'}"


def is_matcher(expected: Any) -> bool:
    return isinstance(expected, dict) and any(isinstance(key, str) and key.startswith("$") for key in expected)


def _check_matcher(expected: Any) -> None:
    if not is_matcher(expected):
        return
    if unknown := [key for key in expected if key not in MATCHERS]:
        raise ValueError(f"unknown matcher {unknown}; the matchers are {list(MATCHERS)}")
    if "$in" in expected and not isinstance(expected["$in"], list):
        raise ValueError("$in takes a list of values")
    if "$len" in expected and (type(expected["$len"]) is not int or expected["$len"] < 0):
        raise ValueError("$len takes a count")
    if "$not" in expected:
        _check_matcher(expected["$not"])


def matches(actual: Any, expected: Any) -> bool:
    """Whether one value meets an expected value or matcher."""
    if not is_matcher(expected):
        return _equal(actual, expected)
    checks = {
        "$in": lambda options: any(_equal(actual, option) for option in options),
        "$has": lambda item: _has(actual, item),
        "$len": lambda n: isinstance(actual, (list, str, dict)) and len(actual) == n,
        "$not": lambda inner: not matches(actual, inner),
    }
    return all(checks[name](argument) for name, argument in expected.items())


def _has(actual: Any, item: Any) -> bool:
    if isinstance(actual, list):
        return any(_equal(element, item) for element in actual)
    if isinstance(actual, (str, dict)):
        return isinstance(item, str) and item in actual
    return False


def _equal(actual: Any, expected: Any) -> bool:
    """JSON equality where a bool is never a number (`True != 1`)."""
    if isinstance(actual, bool) or isinstance(expected, bool):
        return type(actual) is type(expected) and actual == expected
    if isinstance(actual, dict) and isinstance(expected, dict):
        return actual.keys() == expected.keys() and all(_equal(actual[key], expected[key]) for key in actual)
    if isinstance(actual, list) and isinstance(expected, list):
        return len(actual) == len(expected) and all(map(_equal, actual, expected))
    return actual == expected


_MISSING = object()


def _lookup(body: Any, path: str) -> Any:
    for segment in path.split("."):
        if isinstance(body, dict) and segment in body:
            body = body[segment]
        elif isinstance(body, list) and segment.isdigit() and int(segment) < len(body):
            body = body[int(segment)]
        else:
            return _MISSING
    return body


# The kernel API contract

class ContractError(AssertionError):
    """A call, or what it expects, breaks the kernel API contract."""


@dataclass(frozen=True)
class Route:
    """A parsed `KERNEL_ROUTES` key, such as `GET /ledger/{desk_id}?verify=true`."""

    method: str
    template: str
    params: tuple[str, ...]   # path parameters, in order
    query: dict[str, str]     # declared query parameters: a value is fixed, "" is the caller's to give


def parse_route(route: str) -> Route:
    if route not in KERNEL_ROUTES:
        raise ContractError(f"{route!r} is not a kernel route (KERNEL_ROUTES)")
    method, _, target = route.partition(" ")
    template, _, query = target.partition("?")
    declared = dict(pair.partition("=")[::2] for pair in query.split("&")) if query else {}
    return Route(method, template, tuple(re.findall(r"{(\w+)}", template)), declared)


# Declared query parameters a caller may leave out: /context's desk_id is required only of an
# owner session ("Kernel HTTP API v2").
OPTIONAL_QUERY = {"GET /context/{session_id}?desk_id=": {"desk_id"}}
# Query parameters a route takes beyond its KERNEL_ROUTES key, which leaves them out because a
# caller may: the public Desk's language, `en` unless `es`, and the session an agent's signed
# `/whoami` names, which a token caller leaves out ("Kernel HTTP API v2").
UNDECLARED_QUERY = {"GET /public/{desk_slug}": {"lang"}, "GET /whoami": {"session_id"}}


def check_request(
    route: str,
    *,
    path: dict[str, Any] | None,
    query: dict[str, Any] | None,
    body: dict[str, Any] | BaseModel | None,
    raw_body: Any,
) -> Any:
    """Check a call against its route and request model; return the JSON body to send.

    `raw_body` is sent as given, unvalidated, for cases that send what the model would refuse."""
    parsed = parse_route(route)
    path, query = path or {}, query or {}
    if set(path) != set(parsed.params):
        raise ContractError(f"{route} takes path parameters {list(parsed.params)}, not {sorted(path)}")
    if unknown := set(query) - set(parsed.query) - UNDECLARED_QUERY.get(route, set()):
        raise ContractError(f"{route} takes no query parameter {sorted(unknown)}")
    for name, fixed in parsed.query.items():
        if fixed and str(query.get(name, fixed)).lower() != fixed:
            raise ContractError(f"{route} fixes {name}={fixed}")
        if not fixed and name not in query and name not in OPTIONAL_QUERY.get(route, set()):
            raise ContractError(f"{route} needs the query parameter {name}")
    request_model = KERNEL_ROUTES[route][0]
    if body is not None and raw_body is not None:
        raise ContractError(f"{route}: send body or raw_body, not both")
    if raw_body is not None:
        return raw_body
    if isinstance(body, BaseModel):
        body = body.model_dump(mode="json")
    if request_model is None:
        if body is not None:
            raise ContractError(f"{route} takes no body")
        return None
    if body is None:
        raise ContractError(f"{route} needs a {request_model.__name__} body")
    try:
        request_model.model_validate_json(json.dumps(body))
    except TypeError:
        raise ContractError(f"{route}: the request body isn't JSON") from None
    except ValidationError as error:   # told by place and kind: pydantic's own text quotes the request
        raise ContractError(f"{route}: the request breaks {request_model.__name__}: "
                            f"{validation_summary(error, request_model)}") from None
    return body


def response_type(route: str, status: int) -> Any:
    """The type a route answers with at `status`: its response model on 2xx, else `KernelError`."""
    return KERNEL_ROUTES[route][1] if 200 <= status < 300 else KernelError


def validation_summary(error: ValidationError, tp: Any) -> str:
    """A validation failure of a body read as `tp` (a kernel answer, a request, the stub's expected
    values), told by where each error is and its kind ("message: missing; inbox.0.entry_id:
    string_type"), never by what the body held: pydantic's own text quotes the input, which may be
    a code or a token. A place is shown by its field names and list indexes; any other part of it
    (a key the body chose, a union member's label) is `*`."""
    names = declared_names(tp)

    def where(loc: tuple[int | str, ...]) -> str:
        return ".".join(str(part) if isinstance(part, int) or part in names else "*" for part in loc) or "the body"

    errors = error.errors(include_url=False, include_context=False, include_input=False)
    return "; ".join(dict.fromkeys(f"{where(item['loc'])}: {item['type']}" for item in errors))


def declared_names(tp: Any) -> frozenset[str]:
    """Every field name and alias of the models `tp` reaches, and every string a `Literal` in it
    allows (a tagged union's tags): the parts of an error's place that come from the contract."""
    names: set[str] = set()
    seen: set[type] = set()

    def walk(node: Any) -> None:
        if isinstance(node, type) and issubclass(node, BaseModel):
            if node not in seen:
                seen.add(node)
                for name, info in node.model_fields.items():
                    names.update(alias for alias in (name, info.alias) if alias)
                    walk(info.annotation)
        elif get_origin(node) is Literal:
            names.update(arg for arg in get_args(node) if isinstance(arg, str))
        else:
            for arg in get_args(node):
                walk(arg)

    walk(tp)
    return frozenset(names)


UNDECLARED = "*"   # how a path shows a key the answer chose: never the key itself, whatever its spelling


def undeclared_fields(raw: Any, value: Any, path: str = "") -> list[str]:
    """The dotted paths of every field in `raw` (a kernel answer, parsed) that its response model
    doesn't declare, nested ones included; `value` is the answer validated as that model, which
    says what each part was read as. The models drop what they don't declare, so a code or a
    canary in such a field would vanish before any scan saw it: a field the contract doesn't
    declare is itself a contract break. Whatever a `dict` or `Any` field holds is declared by it.
    A path shows only the contract's own field names and list indexes; every key the answer chose
    (one the model doesn't declare, or a `dict` field's key) shows as `*`, since a code or a token
    can be spelled like a field name."""
    def at(segment: str) -> str:
        return f"{path}.{segment}" if path else segment

    if isinstance(value, BaseModel) and isinstance(raw, dict):
        fields = type(value).model_fields
        by_key = {name: name for name in fields} | {field.alias: name for name, field in fields.items() if field.alias}
        found = []
        for key, item in raw.items():
            if key in by_key:   # a name the contract declares, so safe to show
                found += undeclared_fields(item, getattr(value, by_key[key]), at(key))
            else:
                found.append(at(UNDECLARED))
        return found
    if isinstance(value, list | tuple) and isinstance(raw, list):
        return [found for n, (item, element) in enumerate(zip(raw, value, strict=False))
                for found in undeclared_fields(item, element, at(str(n)))]
    if isinstance(value, dict) and isinstance(raw, dict):
        return [found for key, item in raw.items() if key in value
                for found in undeclared_fields(item, value[key], at(UNDECLARED))]
    return []


def check_expect_paths(route: str, expect: Expect) -> None:
    """Refuse an expectation naming a path the response type at its status doesn't have."""
    for alternative in expect.any_of or [expect]:
        tp = response_type(route, alternative.status)
        for path in alternative.fields:
            if tp is None:
                raise ContractError(f"{route} answers {alternative.status} with no body, so it has no {path!r}")
            _walk(tp, path.split("."), path, route)


def _walk(tp: Any, segments: list[str], path: str, route: str) -> None:
    """Follow dotted `segments` through a type: model fields, list indexes, any key of a dict."""
    if not segments or tp is Any:
        return
    head, rest = segments[0], segments[1:]
    origin = get_origin(tp)
    if origin is Annotated:
        return _walk(get_args(tp)[0], segments, path, route)
    if origin in (Union, types.UnionType):
        members = [member for member in get_args(tp) if member is not type(None)]
        for member in members[:-1]:
            try:
                return _walk(member, segments, path, route)
            except ContractError:
                continue
        return _walk(members[-1], segments, path, route)
    if origin in (list, tuple):
        if not head.isdigit():
            raise ContractError(f"{route}: {path!r} indexes a list with {head!r}, not a number")
        return _walk(get_args(tp)[0], rest, path, route)
    if tp is dict or origin is dict:
        args = get_args(tp)
        return _walk(args[1] if args else Any, rest, path, route)
    if isinstance(tp, type) and issubclass(tp, BaseModel):
        if head not in tp.model_fields:
            raise ContractError(f"{route}: {path!r} names {head!r}, which {tp.__name__} doesn't have")
        return _walk(tp.model_fields[head].annotation, rest, path, route)
    raise ContractError(f"{route}: {path!r} reaches {head!r} inside a {tp!r}, which has no fields")


# The harness

@dataclass(frozen=True)
class Called:
    """One recorded call, for oracles: the route, the JSON sent, the status, and the answer read
    two ways. `body` is the contract's reading, the validated response model dumped, so a declared
    field the kernel left out is there at its default; `raw` is what the kernel sent, its JSON
    parsed (the text of a non-JSON answer, such as the document bytes; None for a 204 or a call
    the kernel never answered). Leak, marker and uniformity scans read `raw`. Credentials are
    never recorded."""

    route: str
    request: Any
    status: int
    body: Any
    raw: Any


@runtime_checkable
class KernelHarness(Protocol):
    """What a tier 1 case calls: the contract stub (`stub.ContractStub`) or the real kernel in-process.

    A case states each call's expected response, and `call` fails on any other answer, returning
    the validated response model (a `KernelError` on non-2xx). Assertions only a real kernel can
    back sit under `if k.is_real:`, and steps that need a later plan under `if k.landed(plan):`."""

    is_real: bool
    clock: TravelClock
    responses: list[Called]   # every call so far, for oracles

    def landed(self, plan: str) -> bool:
        """Whether `plan` is in landed.toml; always true on the stub."""
        ...

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
        """Call `route` (a `KERNEL_ROUTES` key); `raw_body` is sent unvalidated, for strict-type cases."""
        ...

    async def new_copy(self) -> CopyCreated:
        """A fresh copy of the Turner seed."""
        ...

    async def visitor(self, copy: CopyCreated) -> SessionCreated:
        """A new visitor session on the copy's Desk."""
        ...
