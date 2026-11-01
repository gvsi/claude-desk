"""The model client: the conversation call and the structured routes, built as Plan 02a's Task 4 says, and the
provider (Task 4b): the same calls on Amazon Bedrock for local evals, under the one credential rule.

No test reaches the live API or the network: `AnthropicModel` and `BedrockModel` get `FakeMessagesApi`
(tests/api/fakes.py), an `httpx2.MockTransport` for the SDK's HTTP client that records each request and answers as
the Messages API would.
"""

import asyncio
import copy
import json
import os
import subprocess
import sys
import tomllib
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

import anthropic
import httpx
import httpx2
import pytest
from pydantic import BaseModel, Field, StrictInt, ValidationError

from desk.api.main import app_factory, create_app
from desk.api.metrics import PRICES_PER_MTOK
from desk.api.model import (
    BEDROCK_MODEL_IDS,
    THINKING_BINDING_400,
    TOOL_CHANGES_BETA,
    AnthropicModel,
    BedrockModel,
    ModelRequest,
    ModelUnavailable,
    ModelUsage,
    ThinkingBoundElsewhere,
    build_kwargs,
    make_model,
    parse_structured,
    strict_schema,
)
from desk.api.settings import Settings
from tests.api.fakes import FakeMessagesApi, ScriptedModel, gated, response, text, thinking, tool_use, unavailable
from tests.kernel_contract.fake_kernel import fake_kernel_app

BACKEND = Path(__file__).resolve().parents[2]

SYSTEM = [{"type": "text", "text": "You answer visitors for Turner Plumbing."}]
TOOLS = [
    {"name": "native__quote", "description": "Quote services.", "input_schema": {
        "type": "object", "properties": {}, "required": [], "additionalProperties": False}},
    {"name": "native__release_document", "description": "Send a document.", "defer_loading": True, "input_schema": {
        "type": "object", "properties": {}, "required": [], "additionalProperties": False}},
]
MESSAGES = [{"role": "user", "content": [{"type": "text", "text": "<visitor_message>Hi</visitor_message>"}]}]
# The Messages API's 400 for a replayed thinking block whose conversation changed, as the API words it.
BOUND_ELSEWHERE_TEXT = (
    "messages.7.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. "
    "Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to \"drop_block\". Content that "
    "preceded this block when it was created is missing from this request, starting at `messages.2`.")


def bad_request(message: str) -> httpx2.Response:
    """The Messages API's 400, with this message."""
    return httpx2.Response(400, json={"type": "error", "error": {"type": "invalid_request_error", "message": message}})


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
        "system": [{"type": "text", "text": "You answer visitors for Turner Plumbing.",
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


def message(*blocks: dict, stop_reason: str = "end_turn", model: str = "claude-opus-5-5") -> httpx2.Response:
    return httpx2.Response(200, json={
        "id": "msg_2", "type": "message", "role": "assistant", "model": model, "content": list(blocks),
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


async def test_a_request_can_bound_each_try():
    """A request's `timeout_s` bounds each try the SDK makes, on the structured routes and the conversation alike
    (the annotation jobs' Haiku calls give up rather than hold their worker); the body sent is the same. Without
    one, the client's own timeout applies."""
    server = FakeMessagesApi(message({"type": "text", "text": json.dumps(GOOD_PLAN)}),
                             stream_events({"type": "text", "text": "Hello"}, stop_reason="end_turn", usage=USAGE),
                             message({"type": "text", "text": json.dumps(GOOD_PLAN)}))
    model = AnthropicModel("test-key", base_url="https://model.test", http_client=server.client())

    await model.call(structured(timeout_s=30.0))
    await model.call(conversation(timeout_s=30.0))
    await model.call(structured())

    bounded, streamed, unbounded = (request.extensions["timeout"] for request in server.requests)
    assert bounded == streamed == dict.fromkeys(("connect", "read", "write", "pool"), 30.0)
    assert unbounded == anthropic.DEFAULT_TIMEOUT.as_dict() and unbounded["read"] > 30.0
    assert json.loads(server.requests[0].content) == json.loads(server.requests[2].content) == build_kwargs(
        structured())


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


async def test_a_thinking_binding_400_is_told_apart_from_any_other_400():
    """The 400 for a replayed thinking block whose conversation changed is known by its message, the API's own words
    (`THINKING_BINDING_400`), and raised as `ThinkingBoundElsewhere`, still a `ModelUnavailable`; any other 400 is a
    plain `ModelUnavailable`, as before."""
    assert THINKING_BINDING_400 == "bound to a different conversation"
    assert THINKING_BINDING_400 in BOUND_ELSEWHERE_TEXT
    server = FakeMessagesApi(bad_request(BOUND_ELSEWHERE_TEXT))
    with pytest.raises(ThinkingBoundElsewhere) as failed:
        await claude(server).call(conversation())
    assert len(server.requests) == 1                    # a 400 isn't retried: the same body fails the same way
    assert isinstance(failed.value, ModelUnavailable) and str(failed.value) == "model unavailable: BadRequestError"
    assert (failed.value.response.stop_reason, failed.value.response.usage) == ("error", None)
    assert failed.value.__cause__ is None
    assert failed.value.path == "messages.7.content.0"             # the refused block, for the log: no content
    with pytest.raises(ThinkingBoundElsewhere) as failed:
        await claude(FakeMessagesApi(bad_request("The block is bound to a different conversation."))).call(
            conversation())
    assert failed.value.path is None

    for name, answer in (
            ("another 400", bad_request("prompt is too long: 230000 tokens > 200000 maximum")),
            ("the words, but not a 400", httpx2.Response(500, json={"type": "error", "error": {
                "type": "api_error", "message": BOUND_ELSEWHERE_TEXT}}))):
        with pytest.raises(ModelUnavailable) as failed:
            await claude(FakeMessagesApi(answer)).call(conversation())
        assert not isinstance(failed.value, ThinkingBoundElsewhere), name


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


# The provider (Task 4b): Amazon Bedrock for local evals, under the one credential rule ("The credentials").

DATABASE_URL = "postgresql+psycopg://desk_api:pw-in-the-url@localhost:5433/desk"
BEDROCK_KEY = "bedrock-key-for-tests"
# Not API_DATABASE_URL: each case that reads it sets its own, and `api_settings` reads the real one first.
PROVIDER_VARIABLES = ("DESK_ENV", "ANTHROPIC_API_KEY", "PASSCODE_HASH", "PUBLIC_ORIGIN",
                      "TRUSTED_PROXY_HOPS", "KERNEL_URL", "ANTHROPIC_BASE_URL", "MODEL_PROVIDER", "AWS_REGION",
                      "AWS_DEFAULT_REGION", "BEDROCK_BEARER_TOKEN", "AWS_BEARER_TOKEN_BEDROCK", "ANTHROPIC_AWS_API_KEY",
                      "ANTHROPIC_BEDROCK_MANTLE_BASE_URL", "ANTHROPIC_CUSTOM_HEADERS", "AWS_ACCESS_KEY_ID",
                      "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE")


@pytest.fixture
def environ(monkeypatch):
    """The provider's variables cleared, then `set_all(...)` sets some (an empty value counts as unset)."""
    for name in PROVIDER_VARIABLES:
        monkeypatch.delenv(name, raising=False)

    def set_all(values: dict[str, str]) -> None:
        for name, value in values.items():
            monkeypatch.setenv(name, value)

    return set_all


def test_environ_leaves_the_database_url(monkeypatch, request):
    """`environ` clears the provider's variables but not the database URL: `api_settings`, set up before it, reads that
    URL, so clearing it would point the app's lifespan at whatever the repository's .env names, or at nothing."""
    monkeypatch.setenv("API_DATABASE_URL", DATABASE_URL)
    request.getfixturevalue("environ")
    url = os.environ.get("API_DATABASE_URL")                    # a failure shows the one value, not the environment
    assert url == DATABASE_URL


def settings(**fields) -> Settings:
    return Settings(**{"api_database_url": DATABASE_URL, "desk_env": "test", "anthropic_base_url": "http://127.0.0.1:9",
                       **fields})


def bedrock(server: FakeMessagesApi, region: str = "us-west-2", token: str = BEDROCK_KEY) -> BedrockModel:
    return BedrockModel(region, bearer_token=token, http_client=server.client())


def claude(server: FakeMessagesApi) -> AnthropicModel:
    return AnthropicModel("test-key", base_url="https://model.test", http_client=server.client())


def answer_for(request: ModelRequest) -> httpx2.Response:
    """A fitting answer: a stream for the conversation, one message for a structured route."""
    if request.output_schema is None:
        return stream_events({"type": "text", "text": "Hello"}, stop_reason="end_turn", usage=USAGE)
    return message({"type": "text", "text": json.dumps(GOOD_PLAN)})


def no_mantle_client(monkeypatch) -> list[dict]:
    """A spy in place of the SDK's Bedrock client, until `monkeypatch` is undone: the list records attempts."""
    built: list[dict] = []
    monkeypatch.setattr(anthropic, "AsyncAnthropicBedrockMantle", lambda **kwargs: built.append(kwargs))
    return built


async def test_bedrock_uses_the_mantle_client_in_the_configured_region(environ, monkeypatch):
    # The SDK's own region and host variables are set and ignored: the region is Settings' (us-west-2 by default),
    # and the host is always built from it.
    environ({"API_DATABASE_URL": DATABASE_URL, "MODEL_PROVIDER": "bedrock", "BEDROCK_BEARER_TOKEN": BEDROCK_KEY,
             "AWS_DEFAULT_REGION": "eu-west-1", "ANTHROPIC_BEDROCK_MANTLE_BASE_URL": "https://elsewhere.example"})
    for region, host in ((None, "bedrock-mantle.us-west-2.api.aws"), ("us-east-1", "bedrock-mantle.us-east-1.api.aws")):
        if region is not None:
            monkeypatch.setenv("AWS_REGION", region)
        server = FakeMessagesApi(stream_events({"type": "text", "text": "No."}, stop_reason="refusal", usage=USAGE))
        model = make_model(Settings.from_env(), http_client=server.client())
        assert isinstance(model, BedrockModel)
        response = await model.call(conversation())
        (sent,) = server.requests
        assert str(sent.url) == f"https://{host}/anthropic/v1/messages"
        # no fallback: no `fallbacks` field, and only the tool changes beta (not the SDK middleware's fallback-credit)
        assert "fallbacks" not in json.loads(sent.content) and sent.headers["anthropic-beta"] == TOOL_CHANGES_BETA
        assert response.stop_reason == "refusal"                  # no fallback middleware: a refusal hands off
        await model.aclose()

    built = no_mantle_client(monkeypatch)
    for region in ("us-west-2.example.com#", "us-west-2\n", "not a region"):
        monkeypatch.setenv("AWS_REGION", region)
        with pytest.raises(RuntimeError, match="AWS_REGION"):
            make_model(Settings.from_env())
    assert built == []


async def test_bedrock_maps_every_production_model_and_nothing_else():
    assert BEDROCK_MODEL_IDS.keys() == PRICES_PER_MTOK.keys() == {"claude-opus-5-5", "claude-sonnet-5-5",
                                                                  "claude-haiku-5-5"}
    for name, model_id in BEDROCK_MODEL_IDS.items():
        assert name in model_id
        assert not any(other in model_id for other in BEDROCK_MODEL_IDS if other != name)

    server = FakeMessagesApi(message({"type": "text", "text": json.dumps(GOOD_PLAN)}))
    model = bedrock(server)
    for name in BEDROCK_MODEL_IDS:
        await model.call(structured(model=name))
        assert json.loads(server.requests[-1].content)["model"] == BEDROCK_MODEL_IDS[name]
    with pytest.raises(ValueError):
        await model.call(structured(model="claude-opus-4-1"))
    with pytest.raises(ValueError):
        await model.call(conversation(model=BEDROCK_MODEL_IDS["claude-opus-5-5"]))   # the table is not a pass-through
    assert len(server.requests) == len(BEDROCK_MODEL_IDS)


async def test_bedrock_sends_the_same_body_but_the_model():
    for request in (conversation(), structured()):
        on_claude, on_bedrock = FakeMessagesApi(answer_for(request)), FakeMessagesApi(answer_for(request))
        await claude(on_claude).call(request)
        await bedrock(on_bedrock).call(request)
        (sent_to_claude,), (sent_to_bedrock,) = on_claude.requests, on_bedrock.requests
        body_to_claude, body_to_bedrock = json.loads(sent_to_claude.content), json.loads(sent_to_bedrock.content)
        assert body_to_claude.pop("model") == request.model
        assert body_to_bedrock.pop("model") == BEDROCK_MODEL_IDS[request.model]
        assert body_to_claude == body_to_bedrock
        assert sent_to_claude.headers.get("anthropic-beta") == sent_to_bedrock.headers.get("anthropic-beta")
        if request.output_schema is None:
            assert sent_to_bedrock.headers["anthropic-beta"] == TOOL_CHANGES_BETA
        else:
            assert "anthropic-beta" not in sent_to_bedrock.headers


async def test_bedrock_records_the_served_model_by_its_production_name():
    opus, sonnet = BEDROCK_MODEL_IDS["claude-opus-5-5"], BEDROCK_MODEL_IDS["claude-sonnet-5-5"]
    assert opus.startswith("us.")
    for served, recorded in ((opus, "claude-opus-5-5"), (opus.removeprefix("us."), "claude-opus-5-5"),
                             (sonnet, "claude-sonnet-5-5"), ("other-model", "other-model")):
        server = FakeMessagesApi(stream_events({"type": "text", "text": "Hi"}, stop_reason="end_turn", usage=USAGE,
                                               model=served))
        response = await bedrock(server).call(conversation())
        assert response.model == recorded, served
        server = FakeMessagesApi(message({"type": "text", "text": json.dumps(GOOD_PLAN)}, model=served))
        assert (await bedrock(server).call(structured())).model == recorded

    overloaded = httpx2.Response(529, headers={"retry-after-ms": "1"},
                                 json={"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}})
    with pytest.raises(ModelUnavailable) as failed:
        await bedrock(FakeMessagesApi(overloaded)).call(conversation())
    assert failed.value.response.model == "claude-opus-5-5"


async def test_bedrock_needs_a_scoped_credential(environ, monkeypatch):
    # A developer's wider AWS credentials, and the SDK's own key variables, never stand in for the token.
    ambient = {"AWS_ACCESS_KEY_ID": "ambient-access", "AWS_SECRET_ACCESS_KEY": "ambient-secret",
               "AWS_PROFILE": "ambient-profile", "AWS_BEARER_TOKEN_BEDROCK": "ambient-bearer",
               "ANTHROPIC_AWS_API_KEY": "ambient-key"}
    environ({"API_DATABASE_URL": DATABASE_URL, "MODEL_PROVIDER": "bedrock", **ambient})
    with monkeypatch.context() as patched:
        built = no_mantle_client(patched)
        for build in (lambda: BedrockModel("us-west-2", bearer_token=None), lambda: make_model(Settings.from_env()),
                      lambda: make_model(settings(model_provider="bedrock", bedrock_bearer_token=""))):
            with pytest.raises(RuntimeError, match="BEDROCK_BEARER_TOKEN"):
                build()
        for bad in ("tok\n", " tok"):
            with pytest.raises(RuntimeError, match="BEDROCK_BEARER_TOKEN") as refused:
                BedrockModel("us-west-2", bearer_token=bad)
            assert "tok" not in str(refused.value)
        # make_model refuses ANTHROPIC_CUSTOM_HEADERS whichever the provider, before any client exists
        environ({"BEDROCK_BEARER_TOKEN": BEDROCK_KEY, "ANTHROPIC_CUSTOM_HEADERS": "Authorization: Bearer ambient"})
        with pytest.raises(RuntimeError, match="ANTHROPIC_CUSTOM_HEADERS") as refused:
            make_model(Settings.from_env())
        assert "ambient" not in str(refused.value)
        assert built == []

    # With the token, every request is a bearer call with that token and nothing of the environment's: no SigV4.
    for request in (conversation(), structured()):
        server = FakeMessagesApi(answer_for(request))
        await bedrock(server).call(request)
        (sent,) = server.requests
        assert sent.headers["authorization"] == f"Bearer {BEDROCK_KEY}"
        assert "x-amz-date" not in sent.headers and "AWS4-HMAC-SHA256" not in sent.headers["authorization"]
        assert not any("ambient" in value for value in sent.headers.values())
        assert "ambient" not in sent.content.decode()


def test_no_aws_libraries_in_the_api():
    # One pin with no extra, in no group: the image install resolves no AWS library.
    project = tomllib.loads((BACKEND / "pyproject.toml").read_text())
    pins = [*project["project"]["dependencies"],
            *(pin for group in project.get("dependency-groups", {}).values() for pin in group if isinstance(pin, str))]
    assert "anthropic==2.3.0" in pins
    assert not any(pin.startswith("anthropic[") or (pin.startswith("anthropic") and pin != "anthropic==2.3.0")
                   for pin in pins)
    environment = {name: value for name, value in os.environ.items() if name not in ("UV_LOCKED", "UV_FROZEN")}
    exported = subprocess.run(["uv", "export", "--frozen", "--no-dev", "--no-emit-project", "--no-emit-package",
                               "desk-kernel"], cwd=BACKEND, capture_output=True, text=True, check=True, env=environment)
    pins = [line.split()[0] for line in exported.stdout.splitlines() if line.split() and "==" in line.split()[0]]
    assert "anthropic==2.3.0" in pins
    assert not any(pin.startswith(("boto3==", "botocore==")) for pin in pins)

    # And at run time, with boto3 and botocore made unimportable: the API imports, both clients are built through
    # make_model, and a Bedrock call runs, without either library.
    script = """
import asyncio, importlib.abc, json, sys
from dataclasses import replace
class NoAws(importlib.abc.MetaPathFinder):
    def find_spec(self, name, path, target=None):
        if name.split(".")[0] in ("boto3", "botocore"):
            raise ModuleNotFoundError(f"{name} is not installed in the API")
        return None
sys.meta_path.insert(0, NoAws())
import httpx2
from pydantic import BaseModel
import desk.api.main
from desk.api.model import AnthropicModel, BedrockModel, ModelRequest, make_model
from desk.api.settings import Settings
settings = Settings(api_database_url="postgresql+psycopg://x@127.0.0.1/x", desk_env="test",
                    anthropic_base_url="http://127.0.0.1:9")
assert isinstance(make_model(settings), AnthropicModel)
class Verdict(BaseModel):
    urgent: bool
def handle(request):
    return httpx2.Response(200, json={"id": "m", "type": "message", "role": "assistant", "model": "claude-opus-5-5",
                                      "content": [{"type": "text", "text": json.dumps({"urgent": True})}],
                                      "stop_reason": "end_turn", "stop_sequence": None,
                                      "usage": {"input_tokens": 1, "output_tokens": 1}})
model = make_model(replace(settings, model_provider="bedrock", bedrock_bearer_token="bedrock-key-for-tests"),
                   http_client=httpx2.AsyncClient(transport=httpx2.MockTransport(handle)))
assert isinstance(model, BedrockModel)
request = ModelRequest(route="triage", system=[{"type": "text", "text": "Triage."}], output_schema=Verdict,
                       messages=[{"role": "user", "content": [{"type": "text", "text": "Hi"}]}], effort="low",
                       max_tokens=100)
assert asyncio.run(model.call(request)).parsed == Verdict(urgent=True)
print(json.dumps(sorted(name for name in sys.modules if name.split(".")[0] in ("boto3", "botocore"))))
"""
    ran = subprocess.run([sys.executable, "-c", script], cwd=BACKEND, capture_output=True, text=True, check=True)
    assert json.loads(ran.stdout) == []


async def test_app_builds_its_model_with_make_model(environ, api_settings, passcode_hash, monkeypatch, db, fake):
    default = create_app(settings()).state.runtime.model
    assert isinstance(default, AnthropicModel)
    await default.aclose()
    on_bedrock = create_app(settings(model_provider="bedrock", bedrock_bearer_token=BEDROCK_KEY)).state.runtime.model
    assert isinstance(on_bedrock, BedrockModel)
    await on_bedrock.aclose()
    with pytest.raises(RuntimeError, match="BEDROCK_BEARER_TOKEN"):
        create_app(settings(model_provider="bedrock"))          # refuses to start
    injected = ScriptedModel([])
    assert create_app(settings(), model=injected).state.runtime.model is injected

    # In production, through uvicorn's entry point, with the Bedrock variables cleared (the environ fixture).
    environ({"DESK_ENV": "production", "API_DATABASE_URL": DATABASE_URL, "ANTHROPIC_API_KEY": "key-for-tests",
             "PASSCODE_HASH": passcode_hash, "PUBLIC_ORIGIN": "https://desk.example.com", "TRUSTED_PROXY_HOPS": "2"})
    production = app_factory().state.runtime.model
    assert isinstance(production, AnthropicModel)
    await production.aclose()
    monkeypatch.delenv("DESK_ENV")

    # The lifespan closes the client the app built, and never an injected one.
    class Closing:
        closed = False

        async def aclose(self) -> None:
            self.closed = True

    built, given = Closing(), Closing()
    monkeypatch.setattr("desk.api.main.make_model", lambda settings, *, clock: built)
    transport = httpx.ASGITransport(app=fake_kernel_app(fake))
    app = create_app(api_settings, kernel_transport=transport)
    async with app.router.lifespan_context(app):
        assert app.state.runtime.model is built and not built.closed
    assert built.closed
    app = create_app(api_settings, kernel_transport=transport, model=given)
    async with app.router.lifespan_context(app):
        assert app.state.runtime.model is given
    assert not given.closed
