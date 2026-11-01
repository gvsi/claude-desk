"""The fake model server, driven by the Anthropic SDK as the kernel and the API drive the real one."""

import asyncio
import errno
import gc
import json
import re
import socket
import time
import warnings

import anthropic
import pytest
from anthropic import AsyncAnthropic
from starlette.applications import Starlette

from evals.fakes import FakeAnthropic, HttpError, Json, LoopbackServer, Refusal, Sleep, Text, ToolUse, Turn, Usage


@pytest.fixture
def fake():
    server = FakeAnthropic().start()
    yield server
    server.stop()


@pytest.fixture
def client(fake: FakeAnthropic) -> AsyncAnthropic:
    return AsyncAnthropic(base_url=fake.url, api_key="sk-ant-test-key", max_retries=0)


REVIEW_PASS = {"within_charter_bp": 10000, "manipulation_bp": 0, "recommendation": "allow"}


def ask(**extra: object) -> dict:
    return {"max_tokens": 64, "messages": [{"role": "user", "content": "Hello"}], **extra}


async def test_json_reply_round_trips(fake: FakeAnthropic, client: AsyncAnthropic):
    verdict = REVIEW_PASS
    usage = Usage(input_tokens=310, output_tokens=41, cache_read_input_tokens=7, cache_creation_input_tokens=3)
    fake.script("claude-sonnet-5-5", Json(verdict, usage=usage))

    message = await client.messages.create(model="claude-sonnet-5-5", **ask())

    assert message.model == "claude-sonnet-5-5"
    assert message.stop_reason == "end_turn"
    assert [block.type for block in message.content] == ["text"]
    assert json.loads(message.content[0].text) == verdict
    assert (message.usage.input_tokens, message.usage.output_tokens) == (310, 41)
    assert (message.usage.cache_read_input_tokens, message.usage.cache_creation_input_tokens) == (7, 3)


async def test_streaming_tool_use_round_trips(fake: FakeAnthropic, client: AsyncAnthropic):
    quote = {"items": [{"item_id": "drain", "qty": 1}], "requested_discount_bp": 8000, "note": "Bitte überprüfen"}
    fake.script("claude-opus-5-5", Turn(Text("Let me check that price for you."), ToolUse("native__quote", quote)))

    async with client.messages.stream(model="claude-opus-5-5", **ask()) as stream:
        events = [event.type async for event in stream]
        message = await stream.get_final_message()

    assert message.model == "claude-opus-5-5"
    assert message.stop_reason == "tool_use"
    assert [block.type for block in message.content] == ["text", "tool_use"]
    assert message.content[0].text == "Let me check that price for you."
    assert (message.content[1].name, message.content[1].input) == ("native__quote", quote)
    assert message.content[1].id.startswith("toolu_")
    assert (message.usage.input_tokens, message.usage.output_tokens) == (100, 20)
    # The documented event sequence, with text arriving in more than one delta.
    assert events[0] == "message_start" and events[-1] == "message_stop"
    assert events.count("text") > 1 and "input_json" in events


async def test_refusal_sets_stop_reason(fake: FakeAnthropic, client: AsyncAnthropic):
    fake.script("claude-sonnet-5-5", Refusal(), Refusal())

    message = await client.messages.create(model="claude-sonnet-5-5", **ask())
    async with client.messages.stream(model="claude-sonnet-5-5", **ask()) as stream:
        streamed = await stream.get_final_message()

    for reply in (message, streamed):
        assert (reply.stop_reason, reply.content) == ("refusal", [])
        assert reply.stop_details is not None and reply.stop_details.type == "refusal"


async def test_http_error_raises_status_error(fake: FakeAnthropic, client: AsyncAnthropic):
    fake.script("claude-haiku-5-5", HttpError(500), HttpError(529), HttpError(500))

    with pytest.raises(anthropic.InternalServerError) as raised:
        await client.messages.create(model="claude-haiku-5-5", **ask())
    assert raised.value.status_code == 500
    with pytest.raises(anthropic.OverloadedError):
        await client.messages.create(model="claude-haiku-5-5", **ask())
    with pytest.raises(anthropic.InternalServerError):
        async with client.messages.stream(model="claude-haiku-5-5", **ask()) as stream:
            await stream.get_final_message()


async def test_sleep_delays_the_reply(fake: FakeAnthropic, client: AsyncAnthropic):
    passing = {"promises_beyond_cards": False, "denies_being_ai": False}
    fake.script("claude-haiku-5-5", Sleep(0.4, Json(passing)), Sleep(0.4, Text("Late anyway")), Sleep(2, Json(passing)))

    started = time.monotonic()
    message = await client.messages.create(model="claude-haiku-5-5", **ask())
    assert time.monotonic() - started >= 0.4
    assert json.loads(message.content[0].text) == passing

    started = time.monotonic()
    async with client.messages.stream(model="claude-haiku-5-5", **ask()) as stream:
        streamed = await stream.get_final_message()
    assert time.monotonic() - started >= 0.4
    assert streamed.content[0].text == "Late anyway"

    # A client that stops waiting gets nothing (the kernel's timeouts).
    with pytest.raises(anthropic.APITimeoutError):
        await client.with_options(timeout=0.3).messages.create(model="claude-haiku-5-5", **ask())


async def test_unscripted_call_is_recorded(fake: FakeAnthropic, client: AsyncAnthropic):
    fake.script("claude-sonnet-5-5", Text("Only one"))
    await client.messages.create(model="claude-sonnet-5-5", **ask())

    for model in ("claude-sonnet-5-5", "claude-opus-5-5"):   # a script run out, and a model never scripted
        with pytest.raises(anthropic.InternalServerError, match="unscripted"):
            await client.messages.create(model=model, **ask())
    with pytest.raises(anthropic.InternalServerError):
        async with client.messages.stream(model="claude-opus-5-5", **ask()) as stream:
            await stream.get_final_message()

    with pytest.raises(anthropic.InternalServerError, match="unscripted"):   # any other endpoint is unscripted too
        await client.messages.count_tokens(model="claude-opus-5-5", messages=[{"role": "user", "content": "Hi"}])

    models = [body["model"] for body in fake.unscripted()]
    assert models == ["claude-sonnet-5-5", "claude-opus-5-5", "claude-opus-5-5", "claude-opus-5-5"]
    assert fake.unscripted()[-1]["path"] == "/v1/messages/count_tokens"
    with pytest.raises(AssertionError, match="4 unscripted model calls"):
        fake.check()


async def test_check_reports_scripted_replies_left_unused(fake: FakeAnthropic, client: AsyncAnthropic):
    """A scripted reply is one the case expects a call to use: `check()` fails while any is left,
    naming the model (and schema) and how many, since a call the kernel skipped would otherwise
    pass unnoticed. A default answers only if called, so it is never owed one."""
    fake.script("claude-sonnet-5-5", Json(REVIEW_PASS), Text("Never asked for"))
    fake.script("claude-haiku-5-5", Text("Checked"), schema="SoftPromiseVerdict")
    fake.script("claude-opus-5-5", Text("Again and again"), repeat_last=True)
    fake.default("claude-opus-5-5", Text("A default"), schema="Other")
    await client.messages.create(model="claude-sonnet-5-5", **ask())
    with pytest.raises(AssertionError, match=re.escape(
            "3 scripted replies were never used (claude-haiku-5-5 with schema SoftPromiseVerdict: 1, "
            "claude-opus-5-5: 1, claude-sonnet-5-5: 1)")):
        fake.check()

    structured = {"output_config": {"format": {"type": "json_schema", "schema": SOFT_PROMISE_SCHEMA}}}
    for model, extra in (("claude-sonnet-5-5", {}), ("claude-haiku-5-5", structured), ("claude-opus-5-5", {}),
                         ("claude-opus-5-5", {})):
        await client.messages.create(model=model, **ask(**extra))
    fake.check()   # every scripted reply used, the repeated one more than once; the default never called


async def test_calls_are_recorded_by_model(fake: FakeAnthropic, client: AsyncAnthropic):
    fake.default("claude-sonnet-5-5", Json(REVIEW_PASS))
    fake.default("claude-haiku-5-5", Json({"promises_beyond_cards": False, "denies_being_ai": False}))
    for model, text in [("claude-sonnet-5-5", "one"), ("claude-haiku-5-5", "two"), ("claude-sonnet-5-5", "three")]:
        await client.messages.create(model=model, max_tokens=64, messages=[{"role": "user", "content": text}])

    sonnet = fake.calls("claude-sonnet-5-5")
    assert [call["messages"][0]["content"] for call in sonnet] == ["one", "three"]
    assert [call["messages"][0]["content"] for call in fake.calls("claude-haiku-5-5")] == ["two"]
    assert [call["model"] for call in fake.calls()] == ["claude-sonnet-5-5", "claude-haiku-5-5", "claude-sonnet-5-5"]
    assert fake.calls("claude-opus-5-5") == []
    sonnet[0]["model"] = "edited"   # each call is a copy: a case can't edit the record
    assert fake.calls("claude-sonnet-5-5")[0]["model"] == "claude-sonnet-5-5"
    fake.check()   # every call had a reply


REVIEW_SCHEMA = {
    "title": "Review",
    "type": "object",
    "properties": {
        "within_charter_bp": {"type": "integer"},
        "manipulation_bp": {"type": "integer"},
        "recommendation": {"type": "string", "enum": ["allow", "hold", "block"]},
    },
    "required": ["within_charter_bp", "manipulation_bp", "recommendation"],
    "additionalProperties": False,
}
SOFT_PROMISE_SCHEMA = {
    "title": "SoftPromiseVerdict",
    "type": "object",
    "properties": {"promises_beyond_cards": {"type": "boolean"}, "denies_being_ai": {"type": "boolean"}},
    "required": ["promises_beyond_cards", "denies_being_ai"],
    "additionalProperties": False,
}


async def test_reviewer_and_soft_promise_request_shapes_are_accepted(fake: FakeAnthropic, client: AsyncAnthropic):
    """The kernel's two checks, called as Plan 01a calls them, and the API's betas and fallbacks."""
    fake.default("claude-sonnet-5-5", Json(REVIEW_PASS))
    fake.default("claude-sonnet-5-5", Json({"promises_beyond_cards": False, "denies_being_ai": False}),
                 schema="SoftPromiseVerdict")
    review = {
        "model": "claude-sonnet-5-5", "max_tokens": 2048, "system": "You review one proposed action.",
        "messages": [{"role": "user", "content": '{"action": {"tool": "native.quote"}}'}],
        "thinking": {"type": "between_tools"},
        "output_config": {"effort": "low", "format": {"type": "json_schema", "schema": REVIEW_SCHEMA}},
    }
    soft_promise = {
        "model": "claude-sonnet-5-5", "max_tokens": 1024, "system": "You check one reply.",
        "messages": [{"role": "user", "content": '{"language": "en", "prose": "Here is your quote."}'}],
        "thinking": {"type": "adaptive"},
        "output_config": {"effort": "low", "format": {"type": "json_schema", "schema": SOFT_PROMISE_SCHEMA}},
    }
    checked = client.with_options(timeout=6.0, max_retries=0)
    reviewed = await checked.messages.create(**review)
    verdict = await checked.messages.create(**soft_promise)
    beta = await client.beta.messages.create(
        **review, betas=["context-management-2025-06-27"], extra_body={"fallbacks": [{"model": "claude-opus-5-5"}]}
    )

    assert json.loads(reviewed.content[0].text)["recommendation"] == "allow"
    assert json.loads(verdict.content[0].text) == {"promises_beyond_cards": False, "denies_being_ai": False}
    assert beta.model == "claude-sonnet-5-5"
    assert fake.calls("claude-sonnet-5-5") == [review, soft_promise,
        {**review, "fallbacks": [{"model": "claude-opus-5-5"}]}]
    assert fake.calls("claude-sonnet-5-5", schema="SoftPromiseVerdict") == [soft_promise]


async def test_auth_headers_are_never_stored(fake: FakeAnthropic):
    fake.script("claude-haiku-5-5", Text("Hello"))
    keyed = AsyncAnthropic(base_url=fake.url, api_key="sk-ant-key-that-must-not-be-kept", max_retries=0)
    bearer = AsyncAnthropic(base_url=fake.url, auth_token="bearer-token-that-must-not-be-kept", max_retries=0)
    await keyed.messages.create(model="claude-haiku-5-5", **ask())
    with pytest.raises(anthropic.InternalServerError):   # unscripted calls are kept too
        await bearer.messages.create(model="claude-haiku-5-5", **ask())

    kept = json.dumps([fake.calls(), fake.unscripted()]) + repr(vars(fake))
    assert len(fake.calls()) == 2 and len(fake.unscripted()) == 1
    for secret in ("must-not-be-kept", "x-api-key", "authorization"):
        assert secret not in kept.lower()


async def test_on_request_runs_before_the_reply(fake: FakeAnthropic, client: AsyncAnthropic):
    order: list[str] = []
    case_loop = asyncio.get_running_loop()

    async def take_over(body: dict) -> None:
        # It runs on the case's own loop, so it can use the case's clients, while the request waits.
        assert asyncio.get_running_loop() is case_loop
        order.append("take-over starts: " + body["messages"][0]["content"])
        await asyncio.sleep(0.2)
        order.append("take-over done")

    def note(body: dict) -> None:
        order.append("noted " + body["model"])

    fake.default("claude-haiku-5-5", Text("Checked"))
    fake.default("claude-sonnet-5-5", Text("Reviewed"))
    fake.on_request("claude-haiku-5-5", take_over)
    fake.on_request("claude-haiku-5-5", note)

    message = await client.messages.create(model="claude-haiku-5-5", **ask())
    order.append("reply: " + message.content[0].text)
    await client.messages.create(model="claude-sonnet-5-5", **ask())   # no callback for this model

    assert order == ["take-over starts: Hello", "take-over done", "noted claude-haiku-5-5", "reply: Checked"]

    def broken(body: dict) -> None:
        raise RuntimeError("the take-over failed")

    fake.on_request("claude-sonnet-5-5", broken)   # a failing callback fails the request and the case
    with pytest.raises(anthropic.InternalServerError):
        await client.messages.create(model="claude-sonnet-5-5", **ask())
    with pytest.raises(AssertionError, match="the take-over failed"):
        fake.check()


async def test_scripts_are_matched_by_schema(fake: FakeAnthropic, client: AsyncAnthropic):
    def structured(schema: dict) -> dict:
        return {"output_config": {"effort": "low", "format": {"type": "json_schema", "schema": schema}}}

    passing = {"promises_beyond_cards": False, "denies_being_ai": False}
    flagged = {"promises_beyond_cards": True, "denies_being_ai": False}
    fake.default("claude-haiku-5-5", Json(passing))                                # the model's schema-less script
    fake.script("claude-haiku-5-5", Json(flagged), schema="SoftPromiseVerdict")   # then its script for one schema
    fake.script("claude-sonnet-5-5", Text("Reviewed"), repeat_last=True, schema="Review")
    seen: list[str] = []
    fake.on_request("claude-haiku-5-5", lambda body: seen.append("soft promise"), schema="SoftPromiseVerdict")

    async def text(model: str, **extra: object) -> str:
        return (await client.messages.create(model=model, **ask(**extra))).content[0].text

    assert json.loads(await text("claude-haiku-5-5", **structured(SOFT_PROMISE_SCHEMA))) == flagged
    assert json.loads(await text("claude-haiku-5-5", **structured(SOFT_PROMISE_SCHEMA))) == passing   # script ran out
    assert json.loads(await text("claude-haiku-5-5")) == passing                                       # no schema
    for _ in range(3):
        assert await text("claude-sonnet-5-5", **structured(REVIEW_SCHEMA)) == "Reviewed"           # repeat_last
    with pytest.raises(anthropic.InternalServerError):   # Sonnet has no script for this schema, nor a schema-less one
        await text("claude-sonnet-5-5", **structured({**REVIEW_SCHEMA, "title": "Other"}))

    assert seen == ["soft promise", "soft promise"]
    assert len(fake.calls("claude-haiku-5-5", schema="SoftPromiseVerdict")) == 2
    assert len(fake.calls(schema="Review")) == 3 and len(fake.calls("claude-haiku-5-5")) == 3
    assert [body["output_config"]["format"]["schema"]["title"] for body in fake.unscripted()] == ["Other"]


def test_a_failed_bind_leaves_no_socket_open():
    """A start on a taken port raises and closes its socket, so a caller that retries on a fresh
    port leaves nothing unclosed."""
    taken = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        taken.bind(("127.0.0.1", 0))
        taken.listen()
        gc.collect()   # what earlier tests left unclosed warns now, outside the check
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            with pytest.raises(OSError) as raised:
                LoopbackServer(Starlette(), port=taken.getsockname()[1], name="second server").start()
            assert raised.value.errno == errno.EADDRINUSE
            del raised   # its traceback holds the failed start's frame, and so its socket
            gc.collect()
    finally:
        taken.close()

    assert [str(warning.message) for warning in caught if issubclass(warning.category, ResourceWarning)] == []


@pytest.mark.parametrize("step", ["uvicorn.Config", "threading.Thread.start"])
def test_a_failed_setup_after_the_bind_leaves_no_socket_open(monkeypatch: pytest.MonkeyPatch, step: str):
    """A start that fails after its bind, from the server's setup up to starting the thread that
    would own the socket, raises and closes the socket: that thread never ran to close it. It keeps
    no server or thread either, so a later `stop()` (a fixture's teardown, say) does nothing rather
    than raise over the real error."""

    def fail(*args: object, **kwargs: object) -> None:
        raise RuntimeError(f"{step} failed")

    monkeypatch.setattr(step, fail)
    server = LoopbackServer(Starlette(), name="server")
    gc.collect()   # what earlier tests left unclosed warns now, outside the check
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        with pytest.raises(RuntimeError, match=f"^{re.escape(step)} failed$") as raised:
            server.start()
        del raised   # its traceback holds the failed start's frame, and so its socket
        gc.collect()

    assert [str(warning.message) for warning in caught if issubclass(warning.category, ResourceWarning)] == []
    server.stop()   # nothing started, so nothing to stop
    assert (server._server, server._thread) == (None, None)
