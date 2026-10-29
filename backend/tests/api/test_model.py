"""The model client: the conversation call and the structured routes, built as Plan 02a's Task 4 says.

No test reaches the live API: `AnthropicModel` gets an `httpx2.MockTransport` (the SDK's HTTP client) that
records each request and answers as the Messages API would.
"""

import asyncio
import copy
import json
from datetime import UTC, datetime
from typing import Literal

import httpx2
import pytest
from pydantic import BaseModel, Field, StrictInt, ValidationError

from desk.api.model import (
    TOOL_CHANGES_BETA,
    AnthropicModel,
    ModelRequest,
    ModelUnavailable,
    ModelUsage,
    build_kwargs,
    parse_structured,
    strict_schema,
)
from tests.api.fakes import ScriptedModel, gated, response, text, thinking, tool_use, unavailable

SYSTEM = [{"type": "text", "text": "You answer visitors for Rivera Plumbing."}]
TOOLS = [
    {"name": "native__quote", "description": "Quote services.", "input_schema": {
        "type": "object", "properties": {}, "required": [], "additionalProperties": False}},
    {"name": "native__release_document", "description": "Send a document.", "defer_loading": True, "input_schema": {
        "type": "object", "properties": {}, "required": [], "additionalProperties": False}},
]
MESSAGES = [{"role": "user", "content": [{"type": "text", "text": "<visitor_message>Hi</visitor_message>"}]}]


class FakeMessagesApi:
    """The Messages API as an `httpx2.MockTransport`: records each request and gives the next scripted answer
    (the last one again once the script runs out)."""

    def __init__(self, *answers: httpx2.Response):
        self.answers = list(answers)
        self.requests: list[httpx2.Request] = []

    def handle(self, request: httpx2.Request) -> httpx2.Response:
        self.requests.append(request)
        return self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]

    def client(self) -> httpx2.AsyncClient:
        return httpx2.AsyncClient(transport=httpx2.MockTransport(self.handle))


def stream_events(*blocks: dict, stop_reason: str, usage: dict, model: str = "claude-opus-5-5") -> httpx2.Response:
    """A streamed message: each block whole in its content_block_start, tool input as one JSON delta."""
    start_usage = {**usage, "output_tokens": 1}
    events = [("message_start", {"type": "message_start", "message": {
        "id": "msg_1", "type": "message", "role": "assistant", "model": model, "content": [], "stop_reason": None,
        "stop_sequence": None, "usage": start_usage}})]
    for index, block in enumerate(blocks):
        opened = {**block, "input": {}} if block["type"] == "tool_use" else block
        events.append(("content_block_start", {"type": "content_block_start", "index": index, "content_block": opened}))
        if block["type"] == "tool_use":
            events.append(("content_block_delta", {"type": "content_block_delta", "index": index, "delta": {
                "type": "input_json_delta", "partial_json": json.dumps(block["input"])}}))
        events.append(("content_block_stop", {"type": "content_block_stop", "index": index}))
    events.append(("message_delta", {"type": "message_delta", "delta": {"stop_reason": stop_reason,
                                                                        "stop_sequence": None},
                                     "usage": {"output_tokens": usage["output_tokens"]}}))
    events.append(("message_stop", {"type": "message_stop"}))
    body = "".join(f"event: {name}\ndata: {json.dumps(data)}\n\n" for name, data in events)
    return httpx2.Response(200, headers={"content-type": "text/event-stream"}, content=body.encode())


def conversation(**fields) -> ModelRequest:
    return ModelRequest(**{"route": "conversation", "system": SYSTEM, "messages": MESSAGES, "tools": TOOLS, **fields})


def test_conversation_kwargs():
    request = conversation()
    before = copy.deepcopy(request)

    assert build_kwargs(request) == {
        "model": "claude-opus-5-5",
        "max_tokens": 16000,
        "system": [{"type": "text", "text": "You answer visitors for Rivera Plumbing.",
                    "cache_control": {"type": "ephemeral"}}],
        "tools": TOOLS,
        "messages": MESSAGES,
        "thinking": {"type": "adaptive"},
        "output_config": {"effort": "medium"},
        "cache_control": {"type": "ephemeral"},
        "betas": [TOOL_CHANGES_BETA],
    }
    assert TOOL_CHANGES_BETA == "mid-conversation-tool-changes-2026-07-01"
    # the request itself is left as it was: its system blocks and tools are frozen per model context
    assert request == before


def test_conversation_never_forces_or_streams_tool_input():
    kwargs = build_kwargs(conversation())
    assert "tool_choice" not in kwargs
    assert not any({"eager_input_streaming", "strict"} & set(tool) for tool in kwargs["tools"])
    for field in ("eager_input_streaming", "strict"):
        with pytest.raises(ValueError):
            build_kwargs(conversation(tools=[{**TOOLS[0], field: True}]))


async def test_conversation_call_streams_through_the_sdk():
    server = FakeMessagesApi(stream_events(
        {"type": "thinking", "thinking": "", "signature": "sig-1"},
        {"type": "tool_use", "id": "toolu_1", "name": "send_reply",
         "input": {"prose": "Happy to help.", "clauses": []}},
        stop_reason="tool_use", usage={"input_tokens": 120, "cache_read_input_tokens": 4000,
                                       "cache_creation_input_tokens": 0, "output_tokens": 42}))
    finish = datetime(2026, 10, 30, 17, 0, 5, tzinfo=UTC)
    model = AnthropicModel("test-key", base_url="https://model.test", http_client=server.client(),
                           clock=lambda: finish)

    response = await model.call(conversation())

    assert response.stop_reason == "tool_use"
    assert response.content == [
        {"type": "thinking", "thinking": "", "signature": "sig-1"},
        {"type": "tool_use", "id": "toolu_1", "name": "send_reply",
         "input": {"prose": "Happy to help.", "clauses": []}}]
    assert response.usage == ModelUsage(input_tokens=120, cache_read_input_tokens=4000,
                                        cache_creation_input_tokens=0, output_tokens=42)
    assert response.model == "claude-opus-5-5" and response.parsed is None
    assert response.finished_at == finish and response.latency_ms >= 0
    # one request, carrying exactly build_kwargs, the beta as a header
    (sent,) = server.requests
    assert sent.url.path == "/v1/messages" and sent.headers["anthropic-beta"] == TOOL_CHANGES_BETA
    body = json.loads(sent.content)
    expected = {key: value for key, value in build_kwargs(conversation()).items() if key != "betas"}
    assert body == {**expected, "stream": True}


class Slot(BaseModel):
    slot_id: str = Field(pattern=r"^S-[0-9]{8}-[0-9]{4}$")
    minutes: StrictInt = Field(ge=30, le=240)


class Plan(BaseModel):
    title: str = Field(min_length=1, max_length=80)
    score_bp: StrictInt = Field(ge=0, le=10_000, multiple_of=5)
    kind: Literal["quote", "booking"]
    first: Slot
    slots: list[Slot] = Field(min_length=1, max_length=3)
    note: str | None = None


SLOT = {"slot_id": "S-20261102-0800", "minutes": 120}
GOOD_PLAN = {"title": "Drain", "score_bp": 500, "kind": "quote", "first": SLOT, "slots": [SLOT]}


def walk(schema: object):
    """Every dict in a JSON schema, nested ones included."""
    if isinstance(schema, dict):
        yield schema
        for value in schema.values():
            yield from walk(value)
    elif isinstance(schema, list):
        for value in schema:
            yield from walk(value)


def test_strict_schema_closes_every_object():
    schema = strict_schema(Plan)
    nodes = list(walk(schema))
    objects = [node for node in nodes if node.get("type") == "object"]
    assert len(objects) == 2                       # Plan, and Slot once in $defs
    assert all(node["additionalProperties"] is False for node in objects)
    dropped = {"minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength",
               "pattern", "maxItems"}
    assert not any(dropped & set(node) for node in nodes)
    assert schema["properties"]["kind"]["enum"] == ["quote", "booking"]
    assert schema["$defs"]["Slot"]["required"] == ["slot_id", "minutes"]
    # what the schema leaves out is checked again when the answer is parsed
    good = GOOD_PLAN
    assert parse_structured(Plan, json.dumps(good)).title == "Drain"
    for bad in ({**good, "score_bp": 10_005}, {**good, "title": ""}, {**good, "slots": []},
                {**good, "first": {"slot_id": "tomorrow", "minutes": 120}}, {**good, "score_bp": "500"},
                {**good, "extra": True}):
        with pytest.raises(ValidationError):
            parse_structured(Plan, json.dumps(bad))


USAGE = {"input_tokens": 300, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0, "output_tokens": 80}


def message(*blocks: dict, stop_reason: str = "end_turn") -> httpx2.Response:
    return httpx2.Response(200, json={
        "id": "msg_2", "type": "message", "role": "assistant", "model": "claude-opus-5-5", "content": list(blocks),
        "stop_reason": stop_reason, "stop_sequence": None, "usage": USAGE})


def structured(**fields) -> ModelRequest:
    return ModelRequest(**{"route": "setup", "system": SYSTEM, "messages": MESSAGES, "output_schema": Plan,
                           "effort": "low", "max_tokens": 4000, **fields})


async def test_structured_kwargs_use_output_config_format():
    assert build_kwargs(structured()) == {
        "model": "claude-opus-5-5",
        "max_tokens": 4000,
        "system": SYSTEM,
        "messages": MESSAGES,
        "output_config": {"format": {"type": "json_schema", "schema": strict_schema(Plan)}, "effort": "low"},
    }
    with pytest.raises(ValueError):
        ModelRequest(route="setup", system=SYSTEM, messages=MESSAGES)              # a structured route names its model
    with pytest.raises(ValueError):
        ModelRequest(route="conversation", system=SYSTEM, messages=MESSAGES, output_schema=Plan)

    server = FakeMessagesApi(
        message({"type": "thinking", "thinking": "", "signature": "sig-2"},
                {"type": "text", "text": json.dumps(GOOD_PLAN)}),
        message({"type": "text", "text": json.dumps({**GOOD_PLAN, "score_bp": 10_005})}),
        message({"type": "text", "text": "{\"title\": \"Dra"}, stop_reason="max_tokens"))
    model = AnthropicModel("test-key", base_url="https://model.test", http_client=server.client())

    response = await model.call(structured())
    assert response.parsed == Plan.model_validate(GOOD_PLAN) and response.stop_reason == "end_turn"
    sent = server.requests[0]
    assert sent.url.path == "/v1/messages" and "anthropic-beta" not in sent.headers
    assert json.loads(sent.content) == build_kwargs(structured())
    # an answer that breaks a constraint, or one cut short, is unavailable, with the call's usage kept for its row
    for _ in range(2):
        with pytest.raises(ModelUnavailable) as failed:
            await model.call(structured())
        assert failed.value.response.usage == ModelUsage(300, 0, 0, 80) and failed.value.response.parsed is None


async def test_api_errors_become_model_unavailable():
    overloaded = httpx2.Response(529, headers={"retry-after-ms": "1"},
                                 json={"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}})
    finish = datetime(2026, 10, 30, 17, 0, 9, tzinfo=UTC)
    for request in (conversation(), structured()):
        server = FakeMessagesApi(overloaded)
        model = AnthropicModel("test-key", base_url="https://model.test", http_client=server.client(),
                               clock=lambda: finish)
        with pytest.raises(ModelUnavailable) as failed:
            await model.call(request)
        assert len(server.requests) == 3                  # the first try and max_retries=2
        failure = failed.value.response
        assert (failure.usage, failure.stop_reason, failure.content, failure.parsed) == (None, "error", [], None)
        assert failure.finished_at == finish and failure.model == "claude-opus-5-5"
        assert "test-key" not in str(failed.value) and failed.value.__cause__ is None

    def refuse(request: httpx2.Request) -> httpx2.Response:
        raise httpx2.ConnectError("refused", request=request)

    unreachable = AnthropicModel("test-key", base_url="https://model.test",
                                 http_client=httpx2.AsyncClient(transport=httpx2.MockTransport(refuse)))
    with pytest.raises(ModelUnavailable):
        await unreachable.call(conversation())

    # a stream that breaks halfway through
    whole = stream_events({"type": "text", "text": "Hello"}, stop_reason="end_turn", usage=USAGE).content

    async def broken():
        yield whole[: len(whole) // 2]
        raise httpx2.ReadError("connection reset")

    cut = AnthropicModel("test-key", base_url="https://model.test", http_client=httpx2.AsyncClient(
        transport=httpx2.MockTransport(lambda request: httpx2.Response(
            200, headers={"content-type": "text/event-stream"}, content=broken()))))
    with pytest.raises(ModelUnavailable):
        await cut.call(conversation())


async def test_scripted_model_plays_its_script():
    release = asyncio.Event()
    first = response(thinking(), tool_use("native__quote", {"items": []}, id="toolu_a"))
    gate = gated(response(text("Done.")), release)
    model = ScriptedModel([first, unavailable(), lambda request: response(text(request.route)), gate])

    assert await model.call(conversation()) is first and first.stop_reason == "tool_use"
    with pytest.raises(ModelUnavailable) as failed:
        await model.call(conversation())
    assert failed.value.response.usage is None and failed.value.response.stop_reason == "error"
    assert (await model.call(conversation())).content == [{"type": "text", "text": "conversation"}]
    waiting = asyncio.create_task(model.call(conversation()))
    await asyncio.wait_for(gate.entered.wait(), 1)
    assert not waiting.done()                                   # held until the test releases it
    release.set()
    assert (await waiting).stop_reason == "end_turn"
    assert len(model.requests) == 4 and model.requests[0] == conversation()
    with pytest.raises(AssertionError):
        await model.call(conversation())                        # nothing left to play
