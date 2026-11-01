"""The API target, what a visitor's stream carries, and whose data a cookie or a code reaches.

These cases drive the API process over the real kernel (`--target api`), through `DeskClient` as a
visitor's browser, an owner's or another person's agent would, with every model call scripted on
the kernel target's fake model server. Until Plan 02a's Task 9 adds `02a` to `landed.toml` (with
`api_impl.py`), they are pending; the take-over and A2A cases wait for `02` (Plan 02b's Task 12).

The payload cases play one conversation. Claude quotes a drain clearing and replies "Here is your
quote." with the quote card; then it twice answers in plain text with "It costs $89,
eighty-nine dollars.", which the kernel blocks, so the second turn ends in the kernel's call-back offer
(a Rivera copy offers call backs, so the visitor is asked before the owner is involved). Each case
then judges one part with the evals' own oracles: the visitor's stream and `app.run_events`
show no digit, currency or percent outside cards; every signed event verifies against the
kernel's key; "Claude is writing" comes first and carries nothing; the usage stored is the usage
scripted. The rest check whose data a cookie or an A2A code reaches: another copy's records,
another visitor's session, a reply checked before the owner took over, and a verification code an
agent sends, which never reaches a model, a stored row or a log.
"""

import asyncio
import json
import logging
import random
import re
from collections.abc import AsyncIterator, Iterable
from contextlib import AsyncExitStack, aclosing, asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest
from pydantic import TypeAdapter
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from desk.api.prompts import STATUS_LINES
from desk.contracts import Decision, DemoAgentIssued, LedgerPage
from desk.events import A2AResponse, SseEvent
from desk.kernel_api import Health
from evals.client import ApiCallFailed, DeskClient, StreamEvent
from evals.fakes import FakeAnthropic, Json, LoopbackServer, Reply, Sleep, Text, ToolUse, Usage
from evals.oracles import planted_marker, scan_visible, verify_decision_sig, verify_verdict_sig, visible_texts
from evals.oracles.markers import find_markers
from evals.routes import ROUTES
from evals.tier1.args import quote_args, start_verification_args
from evals.tier1.golden_desk import REVIEW_PASS, REVIEWER_MODEL, START, GoldenDesk, golden_desk
from evals.tier1.harness import UNDECLARED, AgentTurns, Auth, Expect
from evals.tier1.targets import SOFT_PROMISE_MODEL, SOFT_PROMISE_PASS, ApiTarget, KernelTarget
from evals.tier1.test_verification import DANA, code_in, holds_a_code, redacted, wrong_codes

REPO_ROOT = Path(__file__).resolve().parents[2]
OPENAPI = REPO_ROOT / "backend" / "desk" / "api" / "openapi.json"   # the committed export of the app's OpenAPI document (Plan 02a)
OPUS = "claude-opus-5-5"                 # the conversation model (Plan 02a)
SOFT_PROMISE_SCHEMA = "SoftPromiseVerdict"   # the soft-promise check's output schema (Plan 01a)
TURN_TIMEOUT_S = 60.0
QUIET_S = 2.0                            # how long a probe reads a stream that should carry nothing new
SIGNED = ("message", "receipt", "held", "resolved")
HTTP_METHODS = ("get", "post", "put", "patch", "delete")
SHOWN_AS_NUMBERS = ("digit", "currency", "percent")   # what prose may never show a visitor

FIRST_MESSAGE = "How much is a drain clearing?"
SECOND_MESSAGE = "So what does it come to, all in?"
QUOTE_PROSE = "Here is your quote."
NUMBERS_PROSE = "It costs $89, eighty-nine dollars."   # blocked: amounts belong in cards
GREETING = "Hello, how can I help you?"   # no "today": a relative date the reply check would block
ASK_FOR_THE_CODE = "Please send the code from your inbox."
VERIFIED_REPLY = "Thank you, you are verified."


def usage(n: int) -> Usage:
    """The usage the n-th scripted conversation call reports: distinct per call, so rows can't swap."""
    return Usage(input_tokens=1_000 + n, output_tokens=40 + n, cache_read_input_tokens=700 + n,
                 cache_creation_input_tokens=300 + n)


CALL_USAGE = [usage(n) for n in range(1, 5)]           # the conversation's four model calls
CALL_STOPS = ["tool_use", "tool_use", "end_turn", "end_turn"]
SOFT_PROMISE_USAGE = Usage(input_tokens=211, output_tokens=17, cache_read_input_tokens=5,
                           cache_creation_input_tokens=3)


# What Claude is scripted to say

def _blocks(message: dict) -> list[dict]:
    content = message.get("content")
    return [block for block in content if isinstance(block, dict)] if isinstance(content, list) else []


def _tool_result_json(block: dict) -> Any:
    """A `tool_result` block's content as JSON: a string, or text blocks joined; None if it isn't JSON."""
    content = block.get("content")
    if isinstance(content, list):
        content = "".join(part.get("text", "") for part in content if isinstance(part, dict))
    try:
        return json.loads(content) if isinstance(content, str) else None
    except ValueError:
        return None


def quote_fact_id(body: dict) -> str | None:
    """The fact a quote's tool result names, in a Messages request Claude was sent: the one
    `fact_ids` entry of the result answering a `native__quote` call (Plan 02a's `{"outcome":
    "done", "decision_id", "result", "fact_ids"}`). None while no quote result is in the history;
    a quote that wasn't done, or names other than one fact, fails the request, naming its outcome."""
    messages = body.get("messages", [])
    calls = {block.get("id") for message in messages if message.get("role") == "assistant"
             for block in _blocks(message) if block.get("type") == "tool_use" and block.get("name") == "native__quote"}
    for message in messages:
        for block in _blocks(message):
            if block.get("type") == "tool_result" and block.get("tool_use_id") in calls:
                result = _tool_result_json(block)
                outcome = result.get("outcome") if isinstance(result, dict) else None
                fact_ids = result.get("fact_ids") if isinstance(result, dict) else None
                if outcome != "done" or not isinstance(fact_ids, list) or len(fact_ids) != 1:
                    raise AssertionError(f"the quote's tool result is {outcome!r} with fact ids {fact_ids!r}, "
                                         "not one quote done")
                return fact_ids[0]
    return None


class QuoteScript:
    """Claude quotes a drain clearing, then cites the quote's fact in `send_reply`, then gives
    `follow_ups`. The reply is scripted only once the quote's result reaches Claude, since its
    fact id comes from the kernel: the request carrying it scripts the rest."""

    def __init__(self, fake: FakeAnthropic, follow_ups: Iterable[Reply] = ()):
        self.fake, self.follow_ups = fake, list(follow_ups)
        self.fact_id: str | None = None

    def start(self) -> "QuoteScript":
        self.fake.script(OPUS, ToolUse("native__quote", quote_args("drain"), usage=CALL_USAGE[0]))
        self.fake.on_request(OPUS, self._after_quote)
        return self

    def _after_quote(self, body: dict) -> None:
        if self.fact_id is not None or (fact_id := quote_fact_id(body)) is None:
            return
        self.fact_id = fact_id
        reply = {"prose": QUOTE_PROSE, "clauses": [{"template": "quote", "fact_id": fact_id}]}
        self.fake.script(OPUS, ToolUse("send_reply", reply, usage=CALL_USAGE[1]), *self.follow_ups)


def send_reply(prose: str) -> ToolUse:
    return ToolUse("send_reply", {"prose": prose, "clauses": []})


# Reading the stream

async def read_turn(client: DeskClient, after: Any, timeout_s: float = TURN_TIMEOUT_S) -> list[StreamEvent]:
    """The open chat's events after `after` (an event id, or None for all), up to and including the
    next `turn_end`. A stream that ends first, or no turn end within `timeout_s`, fails the case."""
    events: list[StreamEvent] = []
    try:
        async with asyncio.timeout(timeout_s), aclosing(client.events(after)) as stream:
            async for event in stream:
                events.append(event)
                if event.type == "turn_end":
                    return events
    except TimeoutError:
        raise AssertionError(f"no turn_end within {timeout_s} s; the stream carried "
                             f"{[event.type for event in events]}") from None
    raise AssertionError(f"the stream ended before turn_end, after {[event.type for event in events]}")


async def read_quietly(client: DeskClient, after: Any = None, *, query: dict[str, Any] | None = None,
                       seconds: float = QUIET_S) -> list[StreamEvent]:
    """Whatever the open chat's stream sends within `seconds`, for probes that expect nothing new."""
    events: list[StreamEvent] = []
    try:
        async with asyncio.timeout(seconds), aclosing(client.events(after, query=query)) as stream:
            async for event in stream:
                events.append(event)
    except TimeoutError:
        pass
    return events


async def chat_turn(client: DeskClient, text: str, after: Any) -> list[StreamEvent]:
    """Send `text` in the open chat, then read its turn from after `after`."""
    await client.send(text)
    return await read_turn(client, after)


def last_id(events: list[StreamEvent]) -> str | None:
    return events[-1].id if events else None


# What the API stored

def _payload(row: dict) -> Any:
    """A run event row's payload: JSON as stored, a string of JSON parsed."""
    payload = row.get("payload")
    if isinstance(payload, str):
        try:
            return json.loads(payload)
        except ValueError:
            return payload
    return payload


def sse_payloads(rows: list[dict]) -> dict[int, Any]:
    """The session's published events by `seq`: `app.run_events` rows of kind `sse` (Plan 02a)."""
    return {row["seq"]: _payload(row) for row in rows if row.get("kind") == "sse"}


def digit_hits(payloads: Iterable[tuple[str, Any]]) -> list[tuple[str, str, str]]:
    """Each digit, currency or percent a visitor would read outside a card, as (where, kind, span):
    in every `visitor_plain`, prose block and Demo inbox preview of each payload."""
    return [(where, hit.kind, hit.span) for where, payload in payloads for text in visible_texts(payload)
            for hit in scan_visible(text) if hit.kind in SHOWN_AS_NUMBERS]


def turn_problems(turns: list[list[StreamEvent]]) -> list[str]:
    """How the turns break "Claude is writing first, carrying nothing; one turn end per turn": a
    message with no `writing` before it in its turn, a `writing` that carries more than its type,
    or a turn that doesn't end with its one `turn_end`."""
    problems = []
    for n, turn in enumerate(turns, start=1):
        types = [event.type for event in turn]
        if types.count("turn_end") != 1 or types[-1:] != ["turn_end"]:
            problems.append(f"turn {n} ends {types}, not with its one turn_end")
        for i, event in enumerate(turn):
            if event.type == "message" and "writing" not in types[:i]:
                problems.append(f"turn {n}: message {event.id} has no writing before it")
            if event.type == "writing" and (event.data != {"type": "writing"} or event.event != "writing"):
                carried = sorted(key if key == "type" else UNDECLARED for key in event.data)   # never another key
                problems.append(f"turn {n}: writing {event.id} carries {carried} as {event.event!r}")
    return problems


def found_in(text: str, needles: dict[str, str]) -> list[str]:
    """The labels of the `needles` (label → id or text) that `text` holds: ids as written, other
    text as `find_markers` reads it (case, accents, spacing and punctuation ignored)."""
    return [label for label, needle in needles.items()
            if needle in text or (" " in needle and find_markers(text, [needle]))]


def code_in_log(text: str, code: str) -> bool:
    """Whether log text holds the code as written: six digits with no letter or digit beside them.
    Logs hold timestamps and ids, so a code is looked for only as itself."""
    return re.search(rf"(?<![0-9A-Za-z]){re.escape(code)}(?![0-9A-Za-z])", text) is not None


# What a read naming another copy's records may answer. Each field is checked by its own rule, so a
# record, a note or an id can't sit in a field a nothing-answer has, or in one it doesn't have.
_NAME = re.compile(r"[a-z][a-z0-9_]{0,63}")      # an ApiError's error or code: "kernel", "not_found"
_HEX = re.compile(r"[0-9a-f]{1,64}")


def _optional(rule: Any) -> Any:
    return lambda value: value is None or rule(value)


def _is_name(value: Any) -> bool:
    return isinstance(value, str) and _NAME.fullmatch(value) is not None


def _is_int(value: Any) -> bool:
    return type(value) is int


def _is_hex(length: int | None = None) -> Any:
    return lambda value: (isinstance(value, str) and _HEX.fullmatch(value) is not None
                          and (length is None or len(value) == length))


# The API's error body (`ApiError{error, code, retry_after}`, Plan 02a), with a 404.
ERROR_BODY = {"error": _is_name, "code": _optional(_is_name), "retry_after": _optional(_is_int)}
# A success holding nothing, beyond no body, `[]` and `{}`: its fields and each one's rule, per read.
EMPTY_SUCCESS: dict[str, dict[str, Any]] = {
    "owner_session": {"items": lambda value: value == [], "state": lambda value: value is None},   # OwnerTranscript
    "owner_decision": {},                                                                          # Decision
    "owner_ledger": {"entries": lambda value: value == [], "head": _is_hex(64),                   # LedgerPage
                     "chain_ok": lambda value: type(value) is bool, "first_bad_seq": _optional(_is_int),
                     "public_key_hex": _is_hex(64), "key_id": _is_hex()},
}
REQUIRED = {"error": "error", "owner_session": "items", "owner_ledger": "entries"}   # the field each shape needs
# The fields each answer's contract declares: the only keys a problem names. Any other key is the
# answer's own choice, which may be a token spelled like a field name, so it is never shown.
DECLARED: dict[str, frozenset[str]] = {
    "error": frozenset(ERROR_BODY),                                # ApiError (Plan 02a)
    "owner_session": frozenset(EMPTY_SUCCESS["owner_session"]),    # OwnerTranscript (Plan 02a): items, state
    "owner_decision": frozenset(Decision.model_fields),
    "owner_ledger": frozenset(LedgerPage.model_fields),
}


def empty_read_problems(op: str, status: int, body: Any) -> list[str]:
    """How an answer to `op` (a `ROUTES` owner read) naming another copy's records holds
    something: empty when it is a 404 with no body or the API's error body, or a success with no
    body, an empty list or object, or `op`'s empty shape (`EMPTY_SUCCESS`: a transcript with no
    items and no state, a ledger page with no entries and only its documented metadata). Any other
    status, field or value is a problem, a scalar field or body above all; a problem names fields
    and types, never what they hold."""
    if status == 404:
        if body is None:
            return []
        return _shape_problems(body, ERROR_BODY, REQUIRED["error"], DECLARED["error"], "the API's error body")
    if not 200 <= status < 300:
        return [f"it answered {status}, neither 404 nor a success holding nothing"]
    if body is None or body == [] or body == {}:
        return []
    return _shape_problems(body, EMPTY_SUCCESS[op], REQUIRED.get(op), DECLARED[op], f"an empty {op} answer")


def _shape_problems(
    body: Any, shape: dict[str, Any], required: str | None, declared: frozenset[str], what: str
) -> list[str]:
    if not isinstance(body, dict):
        held = f"a list of {len(body)}" if isinstance(body, list) else f"a {type(body).__name__}"
        return [f"its body is {held}, not {what}"]
    problems = [f"its body has {_field(key, declared)}, which {what} doesn't" for key in body if key not in shape]
    problems += [f"its {key!r} holds a {type(body[key]).__name__}, which {what} can't"
                 for key in body if key in shape and not shape[key](body[key])]
    if required is not None and required not in body:
        problems.append(f"its body has no {required!r}, which {what} has")
    return problems


def _field(key: str, declared: frozenset[str]) -> str:
    """A key as a problem names it: a field the contract declares by its name, any other unnamed."""
    return repr(key) if key in declared else "a field its contract doesn't declare (its name not shown)"


# The conversation the payload cases play

@dataclass
class Chat:
    copy: dict
    desk: dict          # the copy's Desk: desk_id, slug
    session_id: str
    fact_id: str        # the quote's fact, which the reply cites
    turns: list[list[StreamEvent]] = field(default_factory=list)

    @property
    def events(self) -> list[StreamEvent]:
        return [event for turn in self.turns for event in turn]

    def messages(self, turn: int) -> list[StreamEvent]:
        return [event for event in self.turns[turn] if event.type == "message"]


async def scripted_chat(k: KernelTarget, api: ApiTarget, fake: FakeAnthropic) -> Chat:
    """A new copy and a visitor's chat on its Desk, in two turns: the quote and its card, then the
    blocked amounts and the kernel's call-back offer. A conversation that didn't go as scripted fails the case."""
    fake.default(REVIEWER_MODEL, Json(REVIEW_PASS))   # the reviewer passes, if the kernel asks it
    # Scripted for the soft-promise check alone: the API's owner translations and triage run on the same model.
    fake.script(SOFT_PROMISE_MODEL, Json(SOFT_PROMISE_PASS, usage=SOFT_PROMISE_USAGE), schema=SOFT_PROMISE_SCHEMA)
    script = QuoteScript(fake, [Text(NUMBERS_PROSE, usage=CALL_USAGE[2]), Text(NUMBERS_PROSE, usage=CALL_USAGE[3])])
    script.start()
    k.travel(START)
    async with DeskClient(api.base_url, api.passcode) as owner, DeskClient(api.base_url, api.passcode) as visitor:
        copy = await owner.enter()
        desk = copy["desks"][0]
        state = await visitor.open_chat(desk["slug"])
        first = await chat_turn(visitor, FIRST_MESSAGE, (await visitor.transcript())["last_seq"] or None)
        second = await chat_turn(visitor, SECOND_MESSAGE, last_id(first))
    assert script.fact_id is not None, "the quote's result never reached Claude, so the reply was never scripted"
    chat = Chat(copy=copy, desk=desk, session_id=state["session_id"], fact_id=script.fact_id, turns=[first, second])
    quoted, offered = chat.messages(0), chat.messages(1)
    assert len(quoted) == 1 and any(
        block.get("template") == "quote" and block.get("fact_id") == chat.fact_id
        for block in quoted[0].data["blocks"]), f"turn 1 shows no one quote card for {chat.fact_id}: {quoted}"
    offer = [{"kind": "prose", "text": STATUS_LINES["offer_callback"]["en"]}]
    assert len(offered) == 1 and offered[0].data["handoff"] is False and [
        {"kind": block["kind"], "text": block["text"]} for block in offered[0].data["blocks"]] == offer, (
        f"turn 2 isn't the one call-back offer after two blocked replies: {offered}")
    return chat


async def stored_events(records: Any, chat: Chat) -> dict[int, Any]:
    """What the API stored of the chat's stream; every event the visitor got is there, with its type."""
    stored = sse_payloads(await records.run_events(chat.session_id))
    for event in chat.events:
        assert event.id is not None and event.id.isdigit(), f"a {event.type} event came with no seq as its id"
        seq = int(event.id)
        assert seq in stored and stored[seq].get("type") == event.type, (
            f"event {seq} ({event.type}) reached the visitor but app.run_events has {stored.get(seq)}")
    return stored


# The API target

@pytest.mark.requires("01a", "02a")
async def test_api_target_conforms_and_routes_match_openapi(k: KernelTarget, api: ApiTarget, fake: FakeAnthropic):
    """Plan 02a's target fits the protocol over this kernel; `/api/health` reports the kernel's
    `Health`; the running app's OpenAPI document is the committed one, and every landed operation
    is in it; a visitor's message reaches the kernel target's fake model server."""
    assert isinstance(api, ApiTarget)
    assert api.kernel is k
    assert re.fullmatch(r"http://127\.0\.0\.1:\d+", api.base_url), api.base_url
    assert api.passcode and isinstance(api.passcode, str) and api.api_dsn and isinstance(api.api_dsn, str)
    fake.script(OPUS, send_reply(GREETING))
    async with DeskClient(api.base_url, api.passcode) as client:
        health = await client.health()
        assert health["ok"] is True
        assert Health.model_validate(health["kernel"]) == k.health
        served = await client.http.get("/openapi.json")   # what the running app serves, not the file on disk
        assert served.status_code == 200, f"the running app answers /openapi.json with {served.status_code}"
        document = served.json()
        assert document == json.loads(OPENAPI.read_text()), (
            f"the running app's OpenAPI document differs from the committed {OPENAPI.name}: the export is stale")
        operations = {(method.lower(), re.sub(r"{[^}]+}", "{}", path))
                      for path, item in document["paths"].items() for method in item if method.lower() in HTTP_METHODS}
        landed = {name: route for name, route in ROUTES.items() if k.landed(route.plan)}
        assert {route.plan for route in landed.values()} >= {"02a"}
        missing = {name: f"{route.method} {route.path}" for name, route in landed.items()
                   if route.operation not in operations}
        assert not missing, f"operations the running app's OpenAPI document doesn't serve: {missing}"
        copy = await client.enter()
        await client.open_chat(copy["desks"][0]["slug"])
        turn = await chat_turn(client, "Hello", (await client.transcript())["last_seq"] or None)
    assert [event.type for event in turn].count("message") == 1, [event.type for event in turn]
    assert len(fake.calls(OPUS)) == 1, "the visitor's message made no model call on the kernel target's fake"


@asynccontextmanager
async def echo_origin() -> AsyncIterator[tuple[str, list[tuple[str, str | None]]]]:
    """Another origin on loopback that records the path and `Cookie` header of each request."""
    seen: list[tuple[str, str | None]] = []

    async def echo(request: Request) -> JSONResponse:
        seen.append((request.url.path, request.headers.get("cookie")))
        return JSONResponse({}, status_code=404)

    server = LoopbackServer(Starlette(routes=[Route("/{path:path}", echo, methods=["GET", "POST"])]), name="echo")
    await asyncio.to_thread(server.start)
    try:
        yield server.url, seen
    finally:
        await asyncio.to_thread(server.stop)


@pytest.mark.requires("01a", "02a")
async def test_client_carries_secure_cookies_over_loopback(k: KernelTarget, api: ApiTarget):
    """The passcode gives a copy and the owner cookie, a chat gives the visitor cookie, and over
    plain loopback HTTP each authenticates its own requests; a client with neither is refused, and
    no cookie goes to another origin."""
    async with DeskClient(api.base_url, api.passcode) as client, DeskClient(api.base_url, api.passcode) as stranger:
        copy = await client.enter()
        desk = copy["desks"][0]
        assert ("desk_owner", "/api/owner") in client.cookies()
        ledger = await client.owner_ledger(desk["desk_id"])
        assert ledger["chain_ok"] is True and ledger["entries"], "the owner's ledger read isn't the copy's"
        state = await client.open_chat(desk["slug"])
        assert [name for name, path in client.cookies() if path.startswith("/api/public/desks/")] == ["desk_visitor"]
        assert (await client.transcript())["state"]["session_id"] == state["session_id"]
        refused = [(await stranger.request("owner_ledger", params={"desk_id": desk["desk_id"]})).status_code,
                   (await stranger.request("chat_session", params={"desk_slug": desk["slug"]})).status_code]
        assert all(400 <= status < 500 for status in refused), f"requests with no cookie answered {refused}"
        async with echo_origin() as (url, seen):
            for op, params in (("owner_ledger", {"desk_id": desk["desk_id"]}),
                               ("chat_session", {"desk_slug": desk["slug"]})):
                await client.http.get(url + ROUTES[op].url(**params))
    assert len(seen) == 2 and all(cookie is None for _, cookie in seen), f"another origin got cookies: {seen}"


# What a visitor's stream carries

@pytest.mark.requires("01a", "02a")
async def test_visitor_sse_payloads_carry_no_digits(k: KernelTarget, api: ApiTarget, fake: FakeAnthropic, records):
    """No digit, currency or percent reaches a visitor outside a card, on the stream or in what the
    API stored to replay it, though Claude wrote "$89" twice; the quote card is there."""
    chat = await scripted_chat(k, api, fake)
    stored = await stored_events(records, chat)
    rows = await records.run_events(chat.session_id)
    hits = digit_hits([(f"stream event {event.id} ({event.type})", event.data) for event in chat.events]
                      + [(f"app.run_events {row.get('kind')} {row.get('seq')}", _payload(row)) for row in rows])
    assert not hits, f"numbers in visitor text: {hits}"
    assert stored, "app.run_events holds none of the chat's events"
    cards = [block for event in chat.messages(0) for block in event.data["blocks"] if block["kind"] == "card"]
    assert [card["template"] for card in cards] == ["quote"], cards


@pytest.mark.requires("01a", "02a")
async def test_every_visitor_message_signature_verifies(k: KernelTarget, api: ApiTarget, fake: FakeAnthropic, records):
    """Every message the visitor got verifies as a reply verdict, and every receipt or hold as a
    decision, under the kernel's key for this session, as streamed and as stored."""
    chat = await scripted_chat(k, api, fake)
    stored = await stored_events(records, chat)
    key = k.health.public_key_hex
    signed: dict[str, int] = {}
    for source, payloads in (("stream", {int(event.id): event.data for event in chat.events}), ("stored", stored)):
        for seq, payload in payloads.items():
            kind = payload.get("type")
            if kind == "message":
                assert verify_verdict_sig(chat.session_id, payload, key), f"{source} message {seq} doesn't verify"
            elif kind in ("receipt", "held", "resolved"):
                assert verify_decision_sig(chat.session_id, payload, key), f"{source} {kind} {seq} doesn't verify"
            if kind in SIGNED:
                signed[f"{source} {kind}"] = signed.get(f"{source} {kind}", 0) + 1
            TypeAdapter(SseEvent).validate_python(payload)
    assert signed.get("stream message") == 2 and signed.get("stream receipt", 0) >= 1, signed
    assert signed["stored message"] == 2, signed


@pytest.mark.requires("01a", "02a")
async def test_writing_precedes_every_message_and_carries_no_text(
    k: KernelTarget, api: ApiTarget, fake: FakeAnthropic, records,
):
    """In each turn "Claude is writing" comes before any message and is only its type, and the
    turn ends with one `turn_end`; the API stored no other turn end."""
    chat = await scripted_chat(k, api, fake)
    assert not turn_problems(chat.turns), turn_problems(chat.turns)
    stored = await stored_events(records, chat)
    assert [payload.get("type") for payload in stored.values()].count("turn_end") == 2
    assert all(payload == {"type": "writing"} for payload in stored.values() if payload.get("type") == "writing")


@pytest.mark.requires("01a", "02a")
async def test_usage_records_match_the_scripted_usage(k: KernelTarget, api: ApiTarget, fake: FakeAnthropic, records):
    """The API stored one `conversation` usage row per model call, as each call reported it, and
    the kernel's `reply` entry for the checked reply holds the soft-promise call's usage."""
    chat = await scripted_chat(k, api, fake)
    rows = [row for row in await records.model_calls(chat.session_id) if row["route"] == "conversation"]
    got = [(row["model"], row["input_tokens"], row["cached_tokens"], row["cache_write_tokens"], row["output_tokens"],
            row["stop_reason"]) for row in rows]
    want = [(OPUS, u.input_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens, u.output_tokens, stop)
            for u, stop in zip(CALL_USAGE, CALL_STOPS, strict=True)]
    assert got == want
    assert all(isinstance(row["latency_ms"], int) and row["latency_ms"] >= 0 for row in rows), rows
    [quoted] = chat.messages(0)
    entries = await records.ledger_entries(chat.copy["copy_id"], chat.desk["desk_id"])
    replies = [entry.event.summary for entry in entries if entry.event.kind == "reply"]   # a fresh copy: this chat's
    checked = [summary for summary in replies if summary.get("message_id") == quoted.data["message_id"]]
    assert len(checked) == 1, f"{len(checked)} reply entries name the delivered reply {quoted.data['message_id']}"
    checked = checked[0]
    soft = checked.get("soft_promise") or {}
    assert {name: soft.get(name) for name in ("model", "status", "input_tokens", "cached_tokens",
                                              "cache_write_tokens", "output_tokens")} == {
        "model": SOFT_PROMISE_MODEL, "status": "ok", "input_tokens": SOFT_PROMISE_USAGE.input_tokens,
        "cached_tokens": SOFT_PROMISE_USAGE.cache_read_input_tokens,
        "cache_write_tokens": SOFT_PROMISE_USAGE.cache_creation_input_tokens,
        "output_tokens": SOFT_PROMISE_USAGE.output_tokens,
    }, checked
    assert isinstance(soft.get("latency_ms"), int)
    checks = fake.calls(SOFT_PROMISE_MODEL, schema=SOFT_PROMISE_SCHEMA)
    assert len(checks) == sum(1 for summary in replies if summary.get("soft_promise")), (
        "each soft-promise call is in one reply entry")


@pytest.mark.requires("01a", "02")
async def test_reply_checked_before_take_over_is_never_shown(
    k: KernelTarget, api: ApiTarget, fake: FakeAnthropic, records,
):
    """The owner takes over while Claude's reply is being checked: the check passes, but the reply
    was checked for the generation before, so no Claude message for that turn reaches the visitor's
    stream or `app.run_events`."""
    fake.default(REVIEWER_MODEL, Json(REVIEW_PASS))
    script = QuoteScript(fake).start()
    fake.script(SOFT_PROMISE_MODEL, Sleep(1.5, Json(SOFT_PROMISE_PASS)), schema=SOFT_PROMISE_SCHEMA)
    k.travel(START)
    taken: list[dict] = []
    async with DeskClient(api.base_url, api.passcode) as owner, DeskClient(api.base_url, api.passcode) as visitor:
        copy = await owner.enter()
        state = await visitor.open_chat(copy["desks"][0]["slug"])

        async def take_over(body: dict) -> None:   # as the soft-promise check's request arrives
            # At the generation the chat opened with, so the take-over is one call inside the check's timeout.
            taken.append(await owner.owner_take_over(state["session_id"], generation=state["generation"]))

        fake.on_request(SOFT_PROMISE_MODEL, take_over, schema=SOFT_PROMISE_SCHEMA)
        turn = await chat_turn(visitor, FIRST_MESSAGE, (await visitor.transcript())["last_seq"] or None)
    assert script.fact_id is not None, "the quote's result never reached Claude, so the reply was never scripted"
    assert len(taken) == 1 and taken[0]["generation"] > state["generation"], f"the take-over didn't happen: {taken}"
    assert len(fake.calls(SOFT_PROMISE_MODEL, schema=SOFT_PROMISE_SCHEMA)) == 1, "the reply was never checked"
    shown = [event.id for event in turn if event.type == "message" and event.data.get("author") == "claude"]
    assert not shown, f"Claude messages checked before the take-over reached the stream: {shown}"
    stored = sse_payloads(await records.run_events(state["session_id"]))
    stored_claude = [seq for seq, payload in stored.items()
                     if payload.get("type") == "message" and payload.get("author") == "claude"]
    assert not stored_claude, f"app.run_events holds Claude messages: {stored_claude}"
    joined = [payload for payload in stored.values() if payload.get("type") == "owner_joined"]
    assert joined, "the visitor's stream never showed the owner joining"


# Whose data a cookie reads

@asynccontextmanager
async def clients(api: ApiTarget, n: int) -> AsyncIterator[list[DeskClient]]:
    """`n` people's clients for the API: each its own browser, with its own cookies."""
    async with AsyncExitStack() as stack:
        yield [await stack.enter_async_context(DeskClient(api.base_url, api.passcode)) for _ in range(n)]


def planted_replies(fake: FakeAnthropic, rng: random.Random) -> str:
    """Claude answers every message with a reply holding planted words; returns them."""
    reply = planted_marker(rng).text
    fake.default(REVIEWER_MODEL, Json(REVIEW_PASS))
    fake.default(OPUS, send_reply(f"Thank you, I have noted it: {reply}."))
    return reply


async def plant(client: DeskClient, words: str, reply: str) -> dict[str, str]:
    """A turn in the client's open chat with planted words both ways, its message and Claude's
    reply; returns what is that chat's alone, by label: its session, its messages, the words."""
    turn = await chat_turn(client, f"Please note this down: {words}.", (await client.transcript())["last_seq"] or None)
    shown = "\n".join(text for event in turn for text in visible_texts(event.data))
    assert find_markers(shown, [reply]), f"the planted reply never reached the chat: {[e.type for e in turn]}"
    owned = {"session id": client.session_id, "planted message": words, "planted reply": reply}
    return owned | {f"message {e.id}": e.data["message_id"] for e in turn if e.type == "message"}


@pytest.mark.requires("01a", "02a")
async def test_owner_cookie_with_another_copys_ids_reads_nothing(
    k: KernelTarget, api: ApiTarget, fake: FakeAnthropic, records,
):
    """Copy A's owner names copy B's session, decision and Desk: each read is a 404 with the API's
    error body, or a success holding nothing in its operation's shape (`empty_read_problems`), and
    no answer holds B's ids or the text planted in B's chat. A's own reads answer, so the cookie
    works."""
    rng = random.Random(1205)
    reply = planted_replies(fake, rng)
    k.travel(START)
    async with clients(api, 4) as (owner_a, owner_b, visitor_a, visitor_b):
        copy_a, copy_b = await owner_a.enter(), await owner_b.enter()
        desk_a, desk_b = copy_a["desks"][0], copy_b["desks"][0]
        state_a = await visitor_a.open_chat(desk_a["slug"])
        await visitor_b.open_chat(desk_b["slug"])
        b_owns = await plant(visitor_b, planted_marker(rng).text, reply)
        decisions_a = [row["decision_id"] for row in await records.decisions(copy_a["copy_id"])]
        decisions_b = [row["decision_id"] for row in await records.decisions(copy_b["copy_id"])]
        assert decisions_a and decisions_b, "each copy holds the seed's held request"
        b_owns |= {"copy id": copy_b["copy_id"], "Desk id": desk_b["desk_id"], "slug": desk_b["slug"]}
        b_owns |= {f"decision {n}": decision_id for n, decision_id in enumerate(decisions_b)}
        b_owns |= {f"ledger entry {entry.seq}": entry.hash
                   for entry in await records.ledger_entries(copy_b["copy_id"], desk_b["desk_id"])}
        # A's own reads answer: the owner cookie works.
        assert (await owner_a.owner_session(state_a["session_id"]))["state"]["session_id"] == state_a["session_id"]
        assert (await owner_a.owner_decision(decisions_a[0]))["decision_id"] == decisions_a[0]
        assert (await owner_a.owner_ledger(desk_a["desk_id"]))["entries"]
        answers = {
            "owner_session": await owner_a.request("owner_session", params={"session_id": b_owns["session id"]}),
            "owner_decision": await owner_a.request("owner_decision", params={"decision_id": decisions_b[0]}),
            "owner_ledger": await owner_a.request("owner_ledger", params={"desk_id": desk_b["desk_id"]}),
        }
    for op, response in answers.items():
        read = op.removeprefix("owner_")
        try:
            body = response.json() if response.content else None
        except ValueError:
            body = response.text   # not JSON: a scalar body, which no read naming B's records answers
        problems = empty_read_problems(op, response.status_code, body)
        assert not problems, f"A's owner reading B's {read} got {response.status_code}: {problems}"
        assert not found_in(response.text, b_owns), f"B's {read} answered with B's {found_in(response.text, b_owns)}"


@pytest.mark.requires("01a", "02a")
async def test_visitor_cookie_with_another_session_id_reads_nothing(
    k: KernelTarget, api: ApiTarget, fake: FakeAnthropic, records,
):
    """Visitor A names visitor B's session on the same Desk wherever a public route could take it
    (a query, a body, the owner's path): each answer is 403, 404 or A's own (401 on the owner's
    route, which A has no cookie for), never B's session, messages or planted text."""
    rng = random.Random(1206)
    reply = planted_replies(fake, rng)
    k.travel(START)
    async with clients(api, 3) as (owner, visitor_a, visitor_b):
        slug = (await owner.enter())["desks"][0]["slug"]
        state_a = await visitor_a.open_chat(slug)
        await visitor_b.open_chat(slug)
        b_owns = await plant(visitor_b, planted_marker(rng).text, reply)
        named = {"session_id": b_owns["session id"]}
        answers = {
            "GET session?session_id=": await visitor_a.request("chat_session", params={"desk_slug": slug}, query=named),
            "POST sessions {session_id}": await visitor_a.request("open_chat", params={"desk_slug": slug}, json=named),
            "GET owner conversation": await visitor_a.request("owner_session", params=named),
        }
        try:
            streamed = await read_quietly(visitor_a, query=named)
        except ApiCallFailed as refused:
            assert refused.status in (403, 404), f"A's stream naming B answered {refused.status}: {refused.body}"
            streamed = []
    for probe, response in answers.items():
        allowed = (401, 403, 404) if probe.startswith("GET owner") else (403, 404)
        if response.status_code not in allowed:
            assert 200 <= response.status_code < 300, f"{probe} answered {response.status_code}: {response.text[:300]}"
            body = response.json()
            state = body.get("state") if isinstance(body, dict) else None
            assert state is None or state.get("session_id") == state_a["session_id"], f"{probe} answered {state}"
        assert not found_in(response.text, b_owns), f"{probe} answered with B's {found_in(response.text, b_owns)}"
    stream_text = json.dumps([event.data for event in streamed])
    assert not found_in(stream_text, b_owns), f"A's stream naming B carried B's {found_in(stream_text, b_owns)}"


# A verification code an agent sends

async def agent_turn(client: DeskClient, agent: AgentTurns, *, session_id: str | None, message: str,
                     verify_code: str | None = None) -> Any:
    """The agent's next A2A request, signed on the kernel's clock, as its runner sends it."""
    agent.new_turn(session_id=session_id, message=message, verify_code=verify_code)
    return await client.a2a(agent.desk_slug, agent.body, agent.a2a_headers())


async def agent_session(
    k: KernelTarget, client: DeskClient, desk: GoldenDesk,
) -> tuple[DemoAgentIssued, AgentTurns, str]:
    """A fresh demo agent's key, and the session its first A2A request opens: Claude starts Dana's
    verification and asks for the code."""
    issued = await k.call("POST /agents/demo", body={"desk_id": desk.desk_id}, auth=desk.owner)
    agent = Auth.agent(issued, desk.slug, k.clock)
    response = await agent_turn(client, agent, session_id=None, message="I'm Dana. Please verify me.")
    assert response.status_code == 200, f"the opening A2A request answered {response.status_code}: {response.text}"
    opened = A2AResponse.model_validate_json(response.content)
    return issued, agent, opened.session_id


async def code_from_session(k: KernelTarget, issued: DemoAgentIssued, desk: GoldenDesk, session_id: str) -> str:
    """The code Dana's challenge sent, from the agent session's own Demo inbox (the verification
    this case plays), read from the kernel with the agent's signature."""
    reader = Auth.agent(issued, desk.slug, k.clock)
    reader.new_turn(session_id=session_id)
    entries = await k.call("GET /demo_inbox?session_id=", query={"session_id": session_id}, auth=reader)
    codes = [entry for entry in entries if entry.kind == "verification_code"]
    assert len(codes) == 1, f"the agent session's Demo inbox holds {len(codes)} codes, not one"
    return code_in(codes[0])


@pytest.mark.requires("01c", "02")
async def test_a2a_verify_code_never_leaks(
    k: KernelTarget, api: ApiTarget, fake: FakeAnthropic, records, caplog: pytest.LogCaptureFixture, capfd,
):
    """An agent's `verify_code` goes to the kernel's check and nowhere else: a wrong one gets 422
    `invalid` with no model call, five use up the challenge so the right code then fails too, and
    on a new challenge the right code verifies the agent's session as Dana. No code, right or
    wrong, reaches the fake model server, a stored `app.*` row or a log."""
    caplog.set_level(logging.INFO)
    caplog.set_level(logging.DEBUG, logger="desk")
    fake.default(REVIEWER_MODEL, Json(REVIEW_PASS))
    start, ask = ToolUse("native__start_verification", start_verification_args(DANA)), send_reply(ASK_FOR_THE_CODE)
    fake.script(OPUS, start, ask, start, ask, send_reply(VERIFIED_REPLY))
    desk = await golden_desk(k)
    async with DeskClient(api.base_url, api.passcode) as client:
        # Session A: five wrong codes use up its challenge.
        issued_a, agent_a, session_a = await agent_session(k, client, desk)
        code_a = await code_from_session(k, issued_a, desk, session_a)
        wrong = wrong_codes(code_a, 5)
        refusals = []
        for n, sent in enumerate([*wrong, code_a], start=1):
            calls = len(fake.calls(OPUS))
            response = await agent_turn(client, agent_a, session_id=session_a, message="Here is the code.",
                                        verify_code=sent)
            body = response.json()
            shown = redacted(response.text, [*wrong, code_a])   # a failure never prints a code
            assert (response.status_code, body.get("code"), body.get("disclosure")) == (422, "invalid", "ai"), (
                f"attempt {n} of six on a challenge with five answered {response.status_code}: {shown}")
            assert len(fake.calls(OPUS)) == calls, f"refused attempt {n} made a model call"
            refusals.append(body)
        assert all(body == refusals[0] for body in refusals), "the six refusals aren't uniform"
        # Session B: a new challenge, and its code verifies the session.
        issued_b, agent_b, session_b = await agent_session(k, client, desk)
        code_b = await code_from_session(k, issued_b, desk, session_b)
        response = await agent_turn(client, agent_b, session_id=session_b, message="Here is the code.",
                                    verify_code=code_b)
        assert response.status_code == 200, (
            f"the right code answered {response.status_code}: {redacted(response.text, [code_b])}")
        assert A2AResponse.model_validate_json(response.content).session_id == session_b
    reader = Auth.agent(issued_b, desk.slug, k.clock)
    reader.new_turn(session_id=session_b)
    await k.call("GET /whoami", query={"session_id": session_b}, auth=reader, expect=Expect(fields={
        "session.session_id": session_b, "session.verified": True, "session.assurance": "demo_code"}))
    [row] = [row for row in await records.sessions(desk.copy.copy_id) if row["session_id"] == session_b]
    assert row["person_id"] == desk.people["dana"], "the right code verified someone other than Dana"
    assert len(fake.calls(OPUS)) == 5, "two opening turns of two calls, and one call after the right code"
    codes = [code_a, code_b, *wrong]
    leaked = [f"model request {n}" for n, body in enumerate(fake.calls()) if holds_a_code(body, codes)]
    for session_id in (session_a, session_b):
        for line in (await records.app_rows(session_id)).splitlines():
            table, _, row_json = line.partition(" ")
            if holds_a_code(json.loads(row_json), codes):
                leaked.append(table)
    out, err = capfd.readouterr()
    for source, text in (("log records", caplog.text), ("stdout", out), ("stderr", err)):
        if any(code_in_log(text, code) for code in codes):
            leaked.append(source)
    assert not leaked, f"a code reached: {sorted(set(leaked))}"
