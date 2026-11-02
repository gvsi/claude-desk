"""Owner display streams never become setup state or rule cards."""

import json

from desk.api.owner_streaming import StringField


def test_string_field_at_every_byte_boundary():
    value = 'Hello "owner"\n雪 😀 \\ /\t\b\f\r'
    for ascii_only in (False, True):
        raw = json.dumps({"other": {"reply": "hidden"}, "reply": value, "cards": ["hidden"]},
                         ensure_ascii=ascii_only).encode()
        for edge in range(len(raw) + 1):
            field = StringField("reply")
            values = [text for part in (raw[:edge], raw[edge:]) if (text := field.feed(part)) is not None]
            assert values[-1] == value
            assert all(value.startswith(text) for text in values)
        field = StringField("reply")
        values = [text for byte in raw if (text := field.feed(bytes([byte]))) is not None]
        assert values[-1] == value
        assert all(value.startswith(text) for text in values)
    field = StringField("reply")
    assert field.feed('{"nested":{"reply":"hidden"},"choices":["hidden"]}') is None


async def test_sdk_structured_stream_delivers_text_before_validation():
    import httpx2
    import pytest
    from pydantic import BaseModel
    from desk.api.model import AnthropicModel, ModelRequest, ModelUnavailable
    from tests.api.fakes import FakeMessagesApi

    class Answer(BaseModel):
        reply: str

    def scripted(raw):
        events = [
            ("message_start", {"type": "message_start", "message": {
                "id": "msg_1", "type": "message", "role": "assistant", "model": "claude-opus-5-5",
                "content": [], "stop_reason": None, "stop_sequence": None,
                "usage": {"input_tokens": 5, "output_tokens": 1}}}),
            ("content_block_start", {"type": "content_block_start", "index": 0,
                                     "content_block": {"type": "text", "text": ""}}),
        ]
        for piece in raw:
            events.append(("content_block_delta", {"type": "content_block_delta", "index": 0,
                                                   "delta": {"type": "text_delta", "text": piece}}))
        events += [
            ("content_block_stop", {"type": "content_block_stop", "index": 0}),
            ("message_delta", {"type": "message_delta", "delta": {"stop_reason": "end_turn"},
                               "usage": {"output_tokens": 12}}),
            ("message_stop", {"type": "message_stop"}),
        ]
        return httpx2.Response(200, headers={"content-type": "text/event-stream"}, content="".join(
            f"event: {name}\ndata: {json.dumps(data)}\n\n" for name, data in events).encode())

    server = FakeMessagesApi(scripted(['{"reply":"Got', ' it"}']), scripted(['{"reply":42}']))
    model = AnthropicModel("test-key", base_url="https://model.test", http_client=server.client())
    chunks = []
    request = ModelRequest(route="setup", system=[{"type": "text", "text": "test"}], messages=[],
                           output_schema=Answer, on_text=chunks.append)
    try:
        result = await model.call(request)
        assert chunks == ['{"reply":"Got', ' it"}']
        assert result.parsed == Answer(reply="Got it")
        assert result.usage.output_tokens == 12
        with pytest.raises(ModelUnavailable):
            await model.call(request)
        assert len(server.requests) == 2
        assert all(json.loads(sent.content)["stream"] is True for sent in server.requests)
    finally:
        await model.aclose()


# Exercise real owner auth, setup commits and rules proofs with no network/model calls.
import asyncio
import contextlib

import pytest

from desk.api import setup
from tests.api.fakes import response, text, unavailable
from tests.api.test_setup_questions import (
    app, model, answer_turn, begin, consent, new_owner, until,
)


class LiveEvents:
    """Observe ASGI body sends, since httpx's in-memory transport buffers a whole SSE response."""

    def __init__(self, app, browser, owner):
        self.sent = asyncio.Queue()

        async def capture(scope, receive, send):
            async def observe(message):
                if message["type"] == "http.response.body":
                    self.sent.put_nowait(message.get("body", b""))
                await send(message)
            await app(scope, receive, observe)

        self.client = browser(capture)
        self.client.cookies.update(owner.browser.cookies)
        self.task = None
        self.buffer = ""
        self.opened = False

    def open(self, path, *, body=None):
        if body is None:
            self.task = asyncio.create_task(self.client.get(path))
        else:
            self.task = asyncio.create_task(self.client.post(path, json=body, headers={"Accept": "text/event-stream"}))
        return self

    async def frame(self, timeout: float = 5) -> str:
        while "\n\n" not in self.buffer:
            chunk = await asyncio.wait_for(self.sent.get(), timeout)
            self.buffer += chunk.decode().replace("\r\n", "\n")
        frame, self.buffer = self.buffer.split("\n\n", 1)
        return frame

    async def opening(self, timeout: float = 5) -> str:
        """The stream's first frame."""
        self.opened = True
        return await self.frame(timeout)

    async def next(self):
        """The next frame after the comment every stream opens with, which comes first."""
        if not self.opened:
            assert await self.opening() == ": open"
        frame = await self.frame()
        lines = frame.splitlines()
        if frame.startswith(":"):
            return ("comment", frame)
        return (next(line[7:] for line in lines if line.startswith("event: ")),
                json.loads(next(line[6:] for line in lines if line.startswith("data: "))))

    async def close(self):
        if self.task:
            self.task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.task


def streaming(raw, pieces, releases, entered=None, fail=False):
    """Send selected raw JSON pieces, pausing after each so HTTP sends are observable."""
    async def call(request):
        assert request.on_text is not None
        if entered is not None:
            entered.set()
        for piece, release in zip(pieces, releases, strict=True):
            request.on_text(piece)
            await release.wait()
        if fail:
            raise unavailable()
        return response(text(raw))
    return call


async def question_ready(app, browser, kernel_http, model):
    owner = await new_owner(app, browser, kernel_http)
    state = await begin(owner, model)
    state = await consent(owner, state["interview_id"], False, model, cards=True)
    return owner, state, f"/api/owner/setup/{state['interview_id']}"


OPENING = "Thanks. From your site, you fix leaks and water heaters."
HOST = "turner-plumbing.example"
QUERIES = ["plumber service calls", "water heater repair pricing"]       # the second search fails


def opening():
    """The consultant's opening as raw JSON, and its reply split over two pieces: "…you fix leaks", then the rest."""
    from tests.api.test_setup_questions import understanding

    raw = json.dumps(understanding(reply=OPENING))
    prefix, rest = raw.split('"reply": ', 1)
    remaining = rest[len(json.dumps(OPENING)):]
    return raw, [prefix + '"reply": "Thanks. From your site, you fix leaks', ' and water heaters."' + remaining]


async def consenting(app, browser, fake, kernel_http, model, website, queries=()):
    """A new interview whose site reads as `website` ("pages" or "failed") and that searches the web for `queries`;
    its owner and state path."""
    from tests.api.test_setup_questions import WEBSITE

    if website == "pages":
        fake.script("native.fetch_website", model_view={"title": "Turner Plumbing", "text": "Leaks.", "pages": 3})
    else:
        fake.script("native.fetch_website", exec_state="failed")
    owner = await new_owner(app, browser, kernel_http)
    state = await begin(owner, model, website=WEBSITE, search_queries=list(queries))
    return owner, f"/api/owner/setup/{state['interview_id']}", state["interview_id"]


def failing_search(fake, monkeypatch, query):
    """The web search for `query` fails; every other read runs as usual."""
    execute = setup.execute_setup_tool

    async def executing(owner, tool, decision, **kwargs):
        (call,) = [call.body["call"] for call in fake.called("POST /decide")
                   if call.body["call"]["call_id"] == decision.call_id]
        if tool == "native.web_search" and call["args"]["query"] == query:
            return None
        return await execute(owner, tool, decision, **kwargs)

    monkeypatch.setattr(setup, "execute_setup_tool", executing)


def saved_messages(state):
    return [(message["role"], message["text"]) for message in state["messages"]]


@pytest.mark.parametrize("website", ["pages", "failed"])
async def test_setup_yes_streams_each_read_then_the_opening_and_saves_only_the_turn(
        app, browser, fake, kernel_http, model, monkeypatch, website, caplog):
    from tests.api.test_setup_questions import landed, understanding

    failing_search(fake, monkeypatch, QUERIES[1])
    owner, path, interview_id = await consenting(app, browser, fake, kernel_http, model, website, QUERIES)
    raw, pieces = opening()
    gates = [asyncio.Event() for _ in pieces]
    entered = asyncio.Event()
    model.add(streaming(raw, pieces, gates, entered))
    reads = fake.gate("POST /execute")
    live = None
    try:
        busy = await asyncio.wait_for(owner.browser.post(path + "/consent?cards=1", json={"allow": True}), 2)
        assert busy.status_code == 202 and busy.json()["busy"] is True
        await until(lambda: len(fake.called("POST /execute")) == 3)   # memory, website and a search run at once
        live = LiveEvents(app, browser, owner).open(path + "/events")
        name, data = await live.next()
        run = data["run"]
        assert isinstance(run, str) and run
        # One reading per read, in saved order, then one label per read in that order, then the opening.
        assert (name, data) == ("reading", {"run": run, "read": "memory", "host": None})
        assert await live.next() == ("reading", {"run": run, "read": "website", "host": HOST})
        assert await live.next() == ("reading", {"run": run, "read": "web_search", "host": None})
        assert await live.next() == ("reading", {"run": run, "read": "web_search", "host": None})
        await asyncio.sleep(0.05)
        assert live.sent.empty() and not live.buffer         # the failed search waits for the reads before it
        reads.set()
        site = f"Read {HOST}, 3 pages" if website == "pages" else f"Couldn't read {HOST}"
        labels = ["Searched your Claude memory", site, f"Searched the web: {QUERIES[0]}",
                  "Couldn't search the web just now"]
        for read, label in zip(["memory", "website", "web_search", "web_search"], labels, strict=True):
            assert await live.next() == ("label", {"run": run, "read": read, "text": label})
        await asyncio.wait_for(entered.wait(), 5)
        assert await live.next() == ("delta", {"run": run, "text": "Thanks. From your site, you fix leaks"})
        assert (await owner.browser.get(path)).json()["busy"] is True   # nothing is saved before the turn lands
        gates[0].set()
        assert await live.next() == ("delta", {"run": run, "text": OPENING})
        gates[1].set()
        assert await live.next() == ("done", {"run": run})
        await live.task
        saved = await landed(owner, interview_id, cards=True)
        assert saved_messages(saved) == [
            ("claude", setup.CONSENT_QUESTION), ("owner", "Yes, use it"),
            *(("tool_label", label) for label in labels), ("claude", OPENING), ("claude", understanding()["question"])]
        assert OPENING not in caplog.text
        # The same consent with nobody subscribed saves the same state.
        other, other_path, other_id = await consenting(app, browser, fake, kernel_http, model, website, QUERIES)
        model.add(response(text(raw)))
        assert (await other.browser.post(other_path + "/consent?cards=1", json={"allow": True})).status_code == 202
        omit = {"interview_id", "desk_id", "slug"}
        assert {key: value for key, value in (await landed(other, other_id, cards=True)).items()
                if key not in omit} == {key: value for key, value in saved.items() if key not in omit}
    finally:
        reads.set()
        for gate in gates:
            gate.set()
        if live is not None:
            await live.close()
        await app.state.runtime.turn_runs.wait(interview_id)


async def test_setup_no_streams_only_the_opening(app, browser, fake, kernel_http, model):
    from tests.api.test_setup_questions import landed, understanding

    owner, path, interview_id = await consenting(app, browser, fake, kernel_http, model, "pages")
    raw, pieces = opening()
    gates = [asyncio.Event() for _ in pieces]
    entered = asyncio.Event()
    model.add(streaming(raw, pieces, gates, entered))
    live = None
    try:
        busy = await asyncio.wait_for(owner.browser.post(path + "/consent?cards=1", json={"allow": False}), 2)
        assert busy.status_code == 202 and busy.json()["busy"] is True
        await asyncio.wait_for(entered.wait(), 5)
        # Opened once the opening is being written, so any read event would have come first.
        live = LiveEvents(app, browser, owner).open(path + "/events")
        name, data = await live.next()
        run = data["run"]
        assert (name, data) == ("delta", {"run": run, "text": "Thanks. From your site, you fix leaks"})
        gates[0].set()
        assert await live.next() == ("delta", {"run": run, "text": OPENING})
        gates[1].set()
        assert await live.next() == ("done", {"run": run})
        await live.task
        saved = await landed(owner, interview_id, cards=True)
        assert saved_messages(saved) == [("claude", setup.CONSENT_QUESTION), ("owner", "No, I'll type it"),
                                         ("claude", OPENING), ("claude", understanding()["question"])]
        assert fake.called("POST /decide") == [] and fake.called("POST /execute") == []
    finally:
        for gate in gates:
            gate.set()
        if live is not None:
            await live.close()
        await app.state.runtime.turn_runs.wait(interview_id)


async def test_setup_late_subscribers_get_the_reads_in_order_then_done(app, browser, fake, kernel_http, model):
    from tests.api.test_setup_questions import landed

    owner, path, interview_id = await consenting(app, browser, fake, kernel_http, model, "failed")
    raw, pieces = opening()
    gates = [asyncio.Event() for _ in pieces]
    entered = asyncio.Event()
    model.add(streaming(raw, pieces, gates, entered))
    live = None
    try:
        busy = await asyncio.wait_for(owner.browser.post(path + "/consent?cards=1", json={"allow": True}), 2)
        assert busy.status_code == 202
        await asyncio.wait_for(entered.wait(), 5)       # both reads have finished and the opening is being written
        live = LiveEvents(app, browser, owner).open(path + "/events")
        frames = [await live.next() for _ in range(5)]
        run = frames[0][1]["run"]
        assert frames == [
            ("reading", {"run": run, "read": "memory", "host": None}),
            ("reading", {"run": run, "read": "website", "host": HOST}),
            ("label", {"run": run, "read": "memory", "text": "Searched your Claude memory"}),
            ("label", {"run": run, "read": "website", "text": f"Couldn't read {HOST}"}),
            ("delta", {"run": run, "text": "Thanks. From your site, you fix leaks"})]
        for gate in gates:
            gate.set()
        assert await live.next() == ("delta", {"run": run, "text": OPENING})
        assert await live.next() == ("done", {"run": run})
        await live.task
        await landed(owner, interview_id)
        await app.state.runtime.turn_runs.wait(interview_id)
        # After the turn has landed, a subscriber gets done at once and refetches the saved state.
        after = await owner.browser.get(path + "/events")
        assert after.status_code == 200 and after.text.replace("\r\n", "\n") == (
            ': open\n\nevent: done\ndata: {"run":null}\n\n')
    finally:
        for gate in gates:
            gate.set()
        if live is not None:
            await live.close()
        await app.state.runtime.turn_runs.wait(interview_id)


async def test_setup_contract_example_is_live_and_saves_only_validated_state(
        app, browser, kernel_http, model, monkeypatch, caplog):
    owner, initial, path = await question_ready(app, browser, kernel_http, model)
    monkeypatch.setattr(setup, "TURN_WAIT_S", 0)
    reply = "Got it: leaks and blocked drains. Do you take emergency calls"
    result = answer_turn(setup.SETUP_TURNS["what_you_do"], reply, step_done=False)
    raw = result.model_dump_json()
    prefix, rest = raw.split('"reply":', 1)
    remaining = rest[len(json.dumps(reply)):]
    pieces = [prefix + '"reply":"Got', " it: leaks and blocked", " drains. Do you take emergency calls" + '"' + remaining]
    gates = [asyncio.Event() for _ in pieces]
    entered = asyncio.Event()
    model.add(streaming(raw, pieces, gates, entered))
    baseline_calls = len(model.requests)
    busy = await owner.browser.post(path + "/answer?cards=1", json={"question": "what_you_do", "text": "We fix leaks and blocked drains"})
    assert busy.status_code == 202 and busy.json()["busy"] is True
    await asyncio.wait_for(entered.wait(), 5)
    live = LiveEvents(app, browser, owner).open(path + "/events")
    try:
        first = await live.next()
        assert first[0] == "delta"
        run = first[1]["run"]
        assert isinstance(run, str) and run
        assert first == ("delta", {"run": run, "text": "Got"})
        gates[0].set()
        assert await live.next() == ("delta", {"run": run, "text": "Got it: leaks and blocked"})
        gates[1].set()
        assert await live.next() == ("delta", {"run": run, "text": reply})
        # Neither incomplete display text nor choices/card/plan JSON have reached saved state.
        stored = (await owner.browser.get(path + "?cards=1")).json()
        assert stored["busy"] is True and reply not in [message["text"] for message in stored["messages"]]
        gates[2].set()
        assert await live.next() == ("done", {"run": run})
        sse = await live.task
        assert sse.status_code == 200 and sse.headers["content-type"].startswith("text/event-stream")
        landed = (await owner.browser.get(path + "?cards=1")).json()
        assert landed["busy"] is False
        assert reply in [message["text"] for message in landed["messages"]]
        assert landed["question"] == initial["question"]
        assert len(model.requests) == baseline_calls + 1
        assert reply not in caplog.text
        # A second interview takes today's ordinary JSON path with the identical full output.
        monkeypatch.setattr(setup, "TURN_WAIT_S", 25)
        other, _, fallback_path = await question_ready(app, browser, kernel_http, model)
        model.add(response(text(raw)))
        fallback = await other.browser.post(fallback_path + "/answer?cards=1", json={
            "question": "what_you_do", "text": "We fix leaks and blocked drains"})
        assert fallback.status_code == 200
        omit = {"interview_id", "desk_id", "slug"}
        assert {key: value for key, value in landed.items() if key not in omit} == {
            key: value for key, value in fallback.json().items() if key not in omit}
    finally:
        for gate in gates:
            gate.set()
        await live.close()
        await app.state.runtime.turn_runs.wait(initial["interview_id"])


async def test_rules_contract_example_and_json_fallback(app, browser, fake, kernel_http, model):
    from tests.api.test_owner_desks import new_owner as rules_owner
    from desk.api.prompts import RuleChat

    owner = await rules_owner(app, browser, fake, kernel_http)
    path = f"/api/owner/policy/{owner.desk_id}/chat"
    answer = "Yes. Right now every payment asks you first. Want me to draft a rule for deposits on jobs over $500?"
    raw = RuleChat(answer=answer, change=None).model_dump_json()
    gates = [asyncio.Event() for _ in range(2)]
    pieces = ['{"answer":"Yes', '. Right now every payment asks you first']
    model.add(streaming(raw, pieces, gates))
    live = LiveEvents(app, browser, owner).open(path, body={"text": "Can I take deposits for big jobs?"})
    try:
        assert await live.next() == ("delta", {"text": "Yes"})
        gates[0].set()
        assert await live.next() == ("delta", {"text": "Yes. Right now every payment asks you first"})
        gates[1].set()
        expected = {"answer": answer, "draft": None}
        assert await live.next() == ("final", expected)
        result = await live.task
        assert result.status_code == 200 and result.headers["content-type"].startswith("text/event-stream")
        # Reposting JSON takes the existing proving answer, exactly as before: no extra model call.
        fallback = await owner.browser.post(path, json={"text": "Can I take deposits for big jobs?"})
        assert fallback.status_code == 200
        assert fallback.headers["content-type"].startswith("application/json")
        assert fallback.json() == expected
        assert len(model.requests) == 1 and fake.called("POST /policy/draft") == []
    finally:
        for gate in gates:
            gate.set()
        await live.close()


@pytest.mark.parametrize("outcome", ["retry", "model_error"])
async def test_setup_retry_and_error_contract(app, browser, kernel_http, model, monkeypatch, outcome):
    owner, initial, path = await question_ready(app, browser, kernel_http, model)
    monkeypatch.setattr(setup, "TURN_WAIT_S", 0)
    first, second = asyncio.Event(), asyncio.Event()
    raw = '{"reply":"Here\'s what I\'d","invalid":true}'
    model.add(streaming(raw, [raw], [first], fail=outcome == "model_error"))
    good = answer_turn(setup.SETUP_TURNS["what_you_do"], "Here's the plan", step_done=False).model_dump_json()
    if outcome == "retry":
        model.add(streaming(good, [good], [second]))
    busy = await owner.browser.post(path + "/answer?cards=1", json={"question": "what_you_do", "text": "Leaky taps"})
    assert busy.status_code == 202
    live = LiveEvents(app, browser, owner).open(path + "/events")
    try:
        name, data = await live.next()
        run = data["run"]
        assert (name, data) == ("delta", {"run": run, "text": "Here's what I'd"})
        first.set()
        if outcome == "retry":
            assert await live.next() == ("reset", {"run": run})
            assert await live.next() == ("delta", {"run": run, "text": "Here's the plan"})
            second.set()
            assert await live.next() == ("done", {"run": run})
            landed = (await owner.browser.get(path + "?cards=1")).json()
            assert "Here's the plan" in [entry["text"] for entry in landed["messages"]]
            assert "Here's what I'd" not in [entry["text"] for entry in landed["messages"]]
        else:
            assert await live.next() == ("error", {"run": run, "error": "model_unavailable"})
            assert (await owner.browser.get(path + "?cards=1")).json() == initial
        await live.task
    finally:
        first.set()
        second.set()
        await live.close()
        with contextlib.suppress(Exception):
            await app.state.runtime.turn_runs.wait(initial["interview_id"])


async def test_setup_late_subscriber_and_scoping_are_json_before_stream(app, browser, kernel_http, model):
    owner, state, path = await question_ready(app, browser, kernel_http, model)
    late = await owner.browser.get(path + "/events")
    assert late.status_code == 200 and late.text.replace("\r\n", "\n") == (
        ': open\n\nevent: done\ndata: {"run":null}\n\n')
    other = await new_owner(app, browser, kernel_http)
    for client, url, status in [(other.browser, path + "/events", 404),
                                (owner.browser, "/api/owner/setup/unknown/events", 404),
                                (browser(app), path + "/events", 401)]:
        reply = await client.get(url)
        assert reply.status_code == status
        assert reply.headers["content-type"].startswith("application/json")
        assert "error" in reply.json()
    assert len(model.requests) == 2


async def test_rules_draft_is_only_final_after_kernel_proof(app, browser, fake, kernel_http, model):
    from tests.api.test_owner_desks import new_owner as rules_owner
    from tests.api.test_rules import chat_card, chatted, owner_cards

    owner = await rules_owner(app, browser, fake, kernel_http)
    path = f"/api/owner/policy/{owner.desk_id}/chat"
    result = chatted("Every quote waits for you.", *(chat_card(card, mode="ask", reason="Quotes ask you first.")
                       if card.card_id == "rv-quote" else chat_card(card) for card in owner_cards(fake, owner.desk_id)))
    raw = result.content[0]["text"]
    gate = asyncio.Event()
    release_proof = fake.gate("POST /policy/draft")
    model.add(streaming(raw, [raw], [gate]))
    live = LiveEvents(app, browser, owner).open(path, body={"text": "Ask before every quote"})
    try:
        assert await live.next() == ("delta", {"text": "Every quote waits for you."})
        assert fake.called("POST /policy/draft") == []
        gate.set()
        await until(lambda: bool(fake.called("POST /policy/draft")))
        assert not live.task.done() and live.sent.empty()
        release_proof.set()
        name, final = await live.next()
        assert name == "final" and final["answer"] == "Every quote waits for you."
        assert final["draft"]["proof"]["ok"] is True
        assert final["draft"]["cards"]
        await live.task
        fallback = await owner.browser.post(path, json={"text": "Ask before every quote"})
        assert fallback.status_code == 200 and fallback.json() == final
        assert len(model.requests) == 1 and len(fake.called("POST /policy/draft")) == 1
    finally:
        gate.set()
        release_proof.set()
        await live.close()


@pytest.mark.parametrize("outcome", ["retry", "model_error", "proof_error"])
async def test_rules_reset_and_error_shapes(app, browser, fake, kernel_http, model, monkeypatch, outcome, caplog):
    from desk.api import rules
    from desk.api.deps import ApiProblem
    from desk.api.prompts import RuleChat
    from tests.api.test_owner_desks import new_owner as rules_owner
    from tests.api.test_rules import chat_card, chatted, owner_cards

    owner = await rules_owner(app, browser, fake, kernel_http)
    path = f"/api/owner/policy/{owner.desk_id}/chat"
    first, second = asyncio.Event(), asyncio.Event()
    first_raw = '{"answer":"Wrong attempt","invalid":true}'
    if outcome == "proof_error":
        result = chatted("A proposed change.", *(chat_card(card) for card in owner_cards(fake, owner.desk_id)))
        first_raw = result.content[0]["text"]

        async def cannot_prove(*args, **kwargs):
            raise ApiProblem(409, "rules_cannot_be_checked")
        monkeypatch.setattr(rules, "draft", cannot_prove)
    model.add(streaming(first_raw, [first_raw], [first], fail=outcome == "model_error"))
    good = RuleChat(answer="A checked answer.", change=None).model_dump_json()
    if outcome == "retry":
        model.add(streaming(good, [good], [second]))
    live = LiveEvents(app, browser, owner).open(path, body={"text": "Explain the rules"})
    try:
        assert await live.next() == ("delta", {"text": "A proposed change." if outcome == "proof_error" else "Wrong attempt"})
        first.set()
        if outcome == "retry":
            assert await live.next() == ("reset", {})
            assert await live.next() == ("delta", {"text": "A checked answer."})
            second.set()
            assert await live.next() == ("final", {"answer": "A checked answer.", "draft": None})
        else:
            status, code = (409, "rules_cannot_be_checked") if outcome == "proof_error" else (503, "model_unavailable")
            assert await live.next() == ("error", {"status": status, "error": code})
        await live.task
        assert "Wrong attempt" not in caplog.text and "A proposed change." not in caplog.text
    finally:
        first.set()
        second.set()
        await live.close()


@pytest.mark.parametrize("reason", ["rate_limit", "demo_budget", "validation", "missing_desk", "foreign_desk", "auth"])
async def test_rules_admission_errors_stay_json(app, browser, fake, kernel_http, model, monkeypatch, reason):
    from desk.api.deps import ApiProblem
    from desk.api.ratelimit import RateLimited
    from desk.api.routes import rules as routes
    from tests.api.test_owner_desks import new_owner as rules_owner

    owner = await rules_owner(app, browser, fake, kernel_http)
    client = owner.browser
    path = f"/api/owner/policy/{owner.desk_id}/chat"
    body = {"text": "Can I take deposits?"}
    expected = {"rate_limit": (429, "rate_limited"), "demo_budget": (503, "demo_budget"),
                "validation": (422, "invalid"), "missing_desk": (404, "not_found"),
                "foreign_desk": (404, "not_found"), "auth": (401, "no_owner_session")}
    if reason == "rate_limit":
        async def limited(bucket, *args, **kwargs):
            assert bucket == "owner_ai"
            raise RateLimited(60)
        monkeypatch.setattr(app.state.runtime.limiter, "enforce", limited)
    elif reason == "demo_budget":
        async def budget(request):
            raise ApiProblem(503, "demo_budget")
        monkeypatch.setattr(routes, "require_model_budget", budget)
    elif reason == "validation":
        body = {"text": ""}
    elif reason == "missing_desk":
        path = "/api/owner/policy/missing/chat"
    elif reason == "foreign_desk":
        other = await rules_owner(app, browser, fake, kernel_http)
        client = other.browser
    else:
        client = browser(app)
    answer = await client.post(path, json=body, headers={"Accept": "text/event-stream"})
    assert answer.status_code == expected[reason][0]
    assert answer.headers["content-type"].startswith("application/json")
    assert answer.json()["error"] == expected[reason][1]
    assert model.requests == []


async def test_setup_keepalives_are_ping_comments_every_15_seconds(app, browser, kernel_http, model, monkeypatch):
    from desk.api import owner_streaming

    owner, initial, path = await question_ready(app, browser, kernel_http, model)
    monkeypatch.setattr(setup, "TURN_WAIT_S", 0)
    real_response = owner_streaming.EventSourceResponse
    intervals = []

    def fast_response(*args, **kwargs):
        intervals.append(kwargs["ping"])
        kwargs["ping"] = 0.01  # Exercise real SSE keepalives without a 15-second test delay.
        return real_response(*args, **kwargs)

    monkeypatch.setattr(owner_streaming, "EventSourceResponse", fast_response)
    release = asyncio.Event()
    result = answer_turn(setup.SETUP_TURNS["what_you_do"], "Got it", step_done=False)

    async def waiting(request):
        await release.wait()
        return response(text(result.model_dump_json()))

    model.add(waiting)
    busy = await owner.browser.post(path + "/answer", json={"question": "what_you_do", "text": "Repairs"})
    assert busy.status_code == 202
    live = LiveEvents(app, browser, owner).open(path + "/events")
    try:
        assert await live.next() == ("comment", ": ping")
        assert await live.next() == ("comment", ": ping")
        assert intervals == [15]
        release.set()
        while (item := await live.next())[0] == "comment":
            pass
        assert item[0] == "done"
        await live.task
    finally:
        release.set()
        await live.close()
        await app.state.runtime.turn_runs.wait(initial["interview_id"])


@pytest.mark.parametrize("stream", ["setup", "rules"])
async def test_owner_streams_open_at_once_with_nothing_to_send(app, browser, fake, kernel_http, model, monkeypatch,
                                                               stream):
    """A browser's EventSource opens at the body's first byte. A setup turn's events and an Ask Claude answer, while
    Claude hasn't answered yet, send a comment as they start, long before their first 15 s keep-alive."""
    from desk.api.prompts import RuleChat
    from tests.api.test_owner_desks import new_owner as rules_owner

    initial = None
    if stream == "setup":
        owner, initial, path = await question_ready(app, browser, kernel_http, model)
        monkeypatch.setattr(setup, "TURN_WAIT_S", 0)
        raw = answer_turn(setup.SETUP_TURNS["what_you_do"], "Got it", step_done=False).model_dump_json()
    else:
        owner = await rules_owner(app, browser, fake, kernel_http)
        path = f"/api/owner/policy/{owner.desk_id}/chat"
        raw = RuleChat(answer="Every payment asks you first.", change=None).model_dump_json()
    release = asyncio.Event()

    async def waiting(request):
        await release.wait()
        return response(text(raw))

    model.add(waiting)
    live = LiveEvents(app, browser, owner)
    try:
        if stream == "setup":
            busy = await owner.browser.post(path + "/answer", json={"question": "what_you_do", "text": "Repairs"})
            assert busy.status_code == 202
            live.open(path + "/events")
        else:
            live.open(path, body={"text": "Do payments ask me first?"})
        assert await live.opening(timeout=1) == ": open"         # no event, data or id: only the stream's start
        release.set()
        while (item := await live.next())[0] == "comment":
            pass
        assert item[0] == ("done" if stream == "setup" else "final")
        await live.task
    finally:
        release.set()
        await live.close()
        if initial is not None:
            await app.state.runtime.turn_runs.wait(initial["interview_id"])


async def test_rules_stream_joins_json_work_and_disconnect_leaves_it_running(
        app, browser, fake, kernel_http, model, monkeypatch):
    from desk.api import proving
    from desk.api.prompts import RuleChat
    from tests.api.test_owner_desks import new_owner as rules_owner

    owner = await rules_owner(app, browser, fake, kernel_http)
    path = f"/api/owner/policy/{owner.desk_id}/chat"
    body = {"text": "Explain my rules"}
    monkeypatch.setattr(proving, "PROVING_WAIT_S", 0)
    gate = asyncio.Event()
    raw = RuleChat(answer="A shared answer.", change=None).model_dump_json()
    model.add(streaming(raw, [raw], [gate]))
    pending = await owner.browser.post(path, json=body)
    assert pending.status_code == 202 and pending.json() == {"retry": {"path": path, "body": body}}
    live = LiveEvents(app, browser, owner).open(path, body=body)
    try:
        assert await live.next() == ("delta", {"text": "A shared answer."})
        await live.close()
        assert len(model.requests) == 1
        gate.set()
        monkeypatch.setattr(proving, "PROVING_WAIT_S", 25)
        final = await owner.browser.post(path, json=body)
        assert final.status_code == 200 and final.json() == {"answer": "A shared answer.", "draft": None}
        assert len(model.requests) == 1
    finally:
        gate.set()
        await live.close()


async def test_slow_subscriber_gets_reset_before_done_after_failed_attempt():
    from desk.api.owner_streaming import Display

    display = Display("r_7f3b")
    first = display.begin("reply")
    first('{"reply":"Here\'s what I\'d"}')
    events = display.events()
    assert await anext(events) == {"event": "delta", "data": '{"run":"r_7f3b","text":"Here\'s what I\'d"}'}
    # The network pauses after the first send while the model retries and finishes.
    second = display.begin("reply")
    second('{"reply":"Here\'s the plan"}')
    display.finish("done", {"run": "r_7f3b"})
    assert await anext(events) == {"event": "reset", "data": '{"run":"r_7f3b"}'}
    assert await anext(events) == {"event": "delta", "data": '{"run":"r_7f3b","text":"Here\'s the plan"}'}
    assert await anext(events) == {"event": "done", "data": '{"run":"r_7f3b"}'}
    with pytest.raises(StopAsyncIteration):
        await anext(events)


async def test_malformed_json_keys_do_not_bypass_the_existing_validation_retry():
    from desk.api.model import ModelRequest
    from desk.api.owner_streaming import Display, displaying
    from desk.api.prompts import RuleChat
    from tests.api.fakes import ScriptedModel

    def malformed(request: ModelRequest):
        raw = '{"bad\\q":"ignored","answer":"Unusable","change":null}'
        request.on_text(raw)
        return response(text(raw))

    valid = RuleChat(answer="Validated answer", change=None)
    fake = ScriptedModel([malformed, response(text(valid.model_dump_json()))])

    async def record(response):
        pass

    with displaying(Display()):
        answer = await setup.ask_model(fake, record, "test", [], RuleChat, max_tokens=8192, route="rules_chat")
    assert answer == valid and len(fake.requests) == 2


async def test_an_answer_sent_the_moment_done_arrives_is_taken(app, browser, kernel_http, model, monkeypatch):
    """A client that refetches and answers as soon as `done` arrives isn't refused for racing the turn's cleanup."""
    from tests.api.test_setup_questions import answer as answering

    owner = await new_owner(app, browser, kernel_http)
    state = await begin(owner, model)
    interview_id = state["interview_id"]
    path = f"/api/owner/setup/{interview_id}"
    detached = setup.detached

    @contextlib.asynccontextmanager
    async def slow_cleanup(*args):
        async with detached(*args) as ctx:
            yield ctx
        await asyncio.sleep(0.2)                    # the turn's cleanup outlasts its final commit

    monkeypatch.setattr(setup, "detached", slow_cleanup)
    raw, pieces = opening()
    gates = [asyncio.Event() for _ in pieces]
    model.add(streaming(raw, pieces, gates))
    live = None
    try:
        assert (await owner.browser.post(path + "/consent", json={"allow": False})).status_code == 202
        live = LiveEvents(app, browser, owner).open(path + "/events")
        name, data = await live.next()
        assert name == "delta"
        for gate in gates:
            gate.set()
        while (frame := await live.next())[0] == "delta":
            pass
        assert frame == ("done", {"run": data["run"]})
        reply = await answering(owner, model, interview_id, "We fix leaks and blocked drains.")
        assert reply.status_code in (200, 202), reply.text
    finally:
        for gate in gates:
            gate.set()
        if live is not None:
            await live.close()
        await app.state.runtime.turn_runs.wait(interview_id)


async def test_done_comes_after_a_slow_after_hook(app, browser, kernel_http, model, monkeypatch):
    owner = await new_owner(app, browser, kernel_http)
    state = await begin(owner, model)
    interview_id = state["interview_id"]
    path = f"/api/owner/setup/{interview_id}"
    after_entered, after_release = asyncio.Event(), asyncio.Event()

    async def turn(ctx, interview, staged):
        interview.transcript.append(setup.Entry(role="claude", text="Committed turn"))

    async def after(ctx, interview):
        after_entered.set()
        await after_release.wait()

    async def custom(ctx, engine, model, interview_id, allow, **kwargs):
        kwargs.pop("cards", None)
        kwargs.pop("business_tools_enabled", None)
        return await setup.run_turn(ctx, engine, model, interview_id, **kwargs, check=lambda interview: None,
                                    stage=lambda interview: [setup.Entry(role="owner", text="")], turn=turn,
                                    keep_staged=False, after=after)

    monkeypatch.setattr(setup, "consent", custom)
    monkeypatch.setattr(setup, "TURN_WAIT_S", 0)
    live = None
    try:
        assert (await owner.browser.post(path + "/consent", json={"allow": False})).status_code == 202
        await asyncio.wait_for(after_entered.wait(), 5)
        assert (await owner.browser.get(path)).json()["messages"][-1]["text"] == "Committed turn"
        live = LiveEvents(app, browser, owner).open(path + "/events")
        with pytest.raises(TimeoutError):          # saved, but the after hook still holds the interview
            await asyncio.wait_for(live.next(), 0.2)
        after_release.set()
        name, data = await live.next()
        assert name == "done" and isinstance(data["run"], str) and data["run"]
        assert interview_id not in setup._RUNNING
    finally:
        after_release.set()
        if live is not None:
            await live.close()
        await app.state.runtime.turn_runs.wait(interview_id)


def writing(raw, release, entered, given):
    """A call that streams `raw` whole when it is given a display callback, recording whether it was given one."""
    async def call(request):
        given.append(request.on_text is not None)
        entered.set()
        if request.on_text is not None:
            request.on_text(raw)
        await release.wait()
        return response(text(raw))
    return call


async def answered_up_to(app, browser, kernel_http, model, question):
    """An interview whose owner has answered each topic before `question`, which is now waiting."""
    from tests.api.test_setup_questions import answer as answering

    owner, state, path = await question_ready(app, browser, kernel_http, model)
    while (waiting := (await owner.browser.get(path)).json()["question"]) != question:
        reply = await answering(owner, model, state["interview_id"], "Yes, that's right.")
        assert reply.status_code == 200, reply.text
        assert (await owner.browser.get(path)).json()["question"] != waiting
    return owner, state["interview_id"], path


async def test_a_reply_before_a_limit_question_streams_nothing(app, browser, kernel_http, model, monkeypatch):
    owner, interview_id, path = await answered_up_to(app, browser, kernel_http, model, "hours_and_area")
    reply = "Got it: weekdays 8 to 6 around Oakland, from what your site says."
    raw = answer_turn(setup.SETUP_TURNS["hours_and_area"], reply).model_dump_json()
    assert json.loads(raw)["next"] == {"kind": "topic", "topic": "quote_limit"}
    release, entered, given = asyncio.Event(), asyncio.Event(), []
    model.add(writing(raw, release, entered, given))
    monkeypatch.setattr(setup, "TURN_WAIT_S", 0)
    live = None
    try:
        busy = await owner.browser.post(path + "/answer", json={"question": "hours_and_area", "text": "Weekdays 8-6"})
        assert busy.status_code == 202
        await asyncio.wait_for(entered.wait(), 5)
        live = LiveEvents(app, browser, owner).open(path + "/events")
        release.set()
        name, data = await live.next()
        assert (name, data) == ("done", {"run": data["run"]}) and data["run"]
        assert given == [False]
        landed = (await owner.browser.get(path)).json()
        assert landed["question"] == "quote_limit"
        assert reply not in [message["text"] for message in landed["messages"]]
    finally:
        release.set()
        if live is not None:
            await live.close()
        await app.state.runtime.turn_runs.wait(interview_id)


async def test_a_limit_reply_streams_and_its_planning_call_does_not(app, browser, kernel_http, model, monkeypatch):
    from desk.api.prompts import SetupNextStep
    from tests.api.test_setup_questions import next_ask, structured

    owner, interview_id, path = await answered_up_to(app, browser, kernel_http, model, "quote_limit")
    reply = "Got it: quotes up to $500 go out on their own."
    raw = answer_turn(setup.SETUP_TURNS["quote_limit"], reply).model_dump_json()
    prefix, rest = raw.split('"reply":"Got it:', 1)
    pieces = [prefix + '"reply":"Got it:', rest]
    gates = [asyncio.Event() for _ in pieces]
    entered = asyncio.Event()
    model.add(streaming(raw, pieces, gates, entered))
    planned, given = asyncio.Event(), []

    def planning(request):
        given.append(request.on_text is not None)
        planned.set()
        return structured(SetupNextStep(reply="Next, the discounts you allow.", next=next_ask("discounts"),
                                        question="", choices=[], skip=[], drop=[], add_jobs=[], plan=""))

    model.add(planning)
    monkeypatch.setattr(setup, "TURN_WAIT_S", 0)
    live = None
    try:
        busy = await owner.browser.post(path + "/answer", json={"question": "quote_limit", "text": "Up to $500"})
        assert busy.status_code == 202
        await asyncio.wait_for(entered.wait(), 5)
        live = LiveEvents(app, browser, owner).open(path + "/events")
        name, data = await live.next()
        run = data["run"]
        assert (name, data) == ("delta", {"run": run, "text": "Got it:"})
        gates[0].set()
        assert await live.next() == ("delta", {"run": run, "text": reply})
        gates[1].set()
        # The turn's second call, its next step, shows nothing: no reset, no text of its own, then done.
        assert await live.next() == ("done", {"run": run})
        assert planned.is_set() and given == [False]
        landed = (await owner.browser.get(path)).json()
        assert landed["question"] == "discounts"
        texts = [message["text"] for message in landed["messages"]]
        assert reply in texts and "Next, the discounts you allow." not in texts
    finally:
        for gate in gates:
            gate.set()
        if live is not None:
            await live.close()
        await app.state.runtime.turn_runs.wait(interview_id)


async def test_a_streamed_reply_hidden_before_a_limit_question_is_reset_before_done(
        app, browser, kernel_http, model, monkeypatch):
    from tests.api.test_setup_questions import next_ask

    owner, state, path = await question_ready(app, browser, kernel_http, model)
    interview_id = state["interview_id"]
    assert state["question"] == "what_you_do"          # code would ask hours_and_area next, so this reply streams
    reply = "Got it: leaks and water heaters. Your site says you approve any payment up to $10,000."
    raw = answer_turn(setup.SETUP_TURNS["what_you_do"], reply, next=next_ask("quote_limit")).model_dump_json()
    gate, entered = asyncio.Event(), asyncio.Event()
    model.add(streaming(raw, [raw], [gate], entered))
    monkeypatch.setattr(setup, "TURN_WAIT_S", 0)
    live = None
    try:
        busy = await owner.browser.post(path + "/answer", json={"question": "what_you_do", "text": "Repairs"})
        assert busy.status_code == 202
        await asyncio.wait_for(entered.wait(), 5)
        live = LiveEvents(app, browser, owner).open(path + "/events")
        name, data = await live.next()
        run = data["run"]
        assert (name, data) == ("delta", {"run": run, "text": reply})
        gate.set()
        # The model asked the quote limit next, so setup hides this reply: the display takes it back first.
        assert await live.next() == ("reset", {"run": run})
        assert await live.next() == ("done", {"run": run})
        landed = (await owner.browser.get(path)).json()
        assert landed["question"] == "quote_limit"
        assert reply not in [message["text"] for message in landed["messages"]]
    finally:
        gate.set()
        if live is not None:
            await live.close()
        await app.state.runtime.turn_runs.wait(interview_id)


@pytest.mark.parametrize("chat", ["setup", "rules"])
async def test_a_subscriber_holds_no_database_connection(app, browser, fake, kernel_http, model, monkeypatch, chat):
    from desk.api import proving
    from desk.api.prompts import RuleChat
    from tests.api.test_owner_desks import new_owner as rules_owner

    gate, entered = asyncio.Event(), asyncio.Event()
    if chat == "setup":
        owner, initial, path = await question_ready(app, browser, kernel_http, model)
        raw = answer_turn(setup.SETUP_TURNS["what_you_do"], "Got it: repairs.", step_done=False).model_dump_json()
        monkeypatch.setattr(setup, "TURN_WAIT_S", 0)
        start, body, events = (path + "/answer", {"question": "what_you_do", "text": "Repairs"}), None, path + "/events"
    else:
        owner = await rules_owner(app, browser, fake, kernel_http)
        path = f"/api/owner/policy/{owner.desk_id}/chat"
        raw = RuleChat(answer="Got it: repairs.", change=None).model_dump_json()
        monkeypatch.setattr(proving, "PROVING_WAIT_S", 0)
        body = {"text": "Explain my rules"}
        start, events = (path, body), path
    model.add(streaming(raw, [raw], [gate], entered))
    started = await owner.browser.post(start[0], json=start[1])
    pool = app.state.runtime.engine.pool
    live = None
    try:
        assert started.status_code == 202
        await asyncio.wait_for(entered.wait(), 5)
        working = pool.checkedout()                # the running work's own connection, and nothing for requests
        live = LiveEvents(app, browser, owner).open(events, body=body)
        assert (await live.next())[0] == "delta"
        assert pool.checkedout() == working        # an open stream holds no connection of its own
    finally:
        gate.set()
        if live is not None:
            await live.close()
        if chat == "setup":
            await app.state.runtime.turn_runs.wait(initial["interview_id"])


@pytest.mark.parametrize("failure", ["above_money_cap", "changes_always_on", "model_unavailable", "kernel",
                                     "kernel_unavailable", "internal"])
async def test_a_streamed_rules_error_is_the_json_error_and_its_status(
        app, browser, fake, kernel_http, model, monkeypatch, failure):
    import httpx

    from desk.api import rules
    from desk.api.deps import ApiProblem
    from desk.api.kernel_client import KernelFailed, KernelUnavailable
    from desk.api.versions import ChangesAlwaysOn
    from tests.api.test_owner_desks import new_owner as rules_owner

    raised = {"above_money_cap": lambda: rules.AboveMoneyCap(0),        # no money limit set yet
              "changes_always_on": lambda: ChangesAlwaysOn(["rv-verify"]),
              "model_unavailable": lambda: ApiProblem(503, "model_unavailable"),
              "kernel": lambda: KernelFailed(409, "version_conflict"),
              "kernel_unavailable": lambda: KernelUnavailable("POST /policy/draft", 503, "internal"),
              "internal": lambda: RuntimeError("private detail")}[failure]

    async def failing(*args, **kwargs):
        raise raised()

    monkeypatch.setattr(rules, "chat", failing)
    owner = await rules_owner(app, browser, fake, kernel_http)
    path, body = f"/api/owner/policy/{owner.desk_id}/chat", {"text": "Take deposits on their own"}
    plain = httpx.AsyncClient(transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
                              base_url="https://desk.test", cookies=owner.browser.cookies)
    live = None
    try:
        answered = await plain.post(path, json=body)
        assert answered.headers["content-type"].startswith("application/json")
        assert answered.status_code == {"above_money_cap": 422, "changes_always_on": 422, "model_unavailable": 503,
                                        "kernel": 409, "kernel_unavailable": 503, "internal": 500}[failure]
        live = LiveEvents(app, browser, owner).open(path, body=body)
        assert await live.next() == ("error", {"status": answered.status_code, **answered.json()})
        assert "private detail" not in json.dumps(answered.json())
    finally:
        if live is not None:
            await live.close()
        await plain.aclose()


async def test_cancelled_work_ends_its_streams_with_an_error():
    from desk.api.proving import Proving
    from desk.api.turn_runs import TurnRuns

    # A setup turn cancelled (the process shutting down) before it ever ran.
    runs = TurnRuns()

    async def never_runs():
        pytest.fail("the turn was cancelled before it started")

    runs.start("interview-1", never_runs())
    display = runs.display("interview-1")
    events = display.events()
    await runs.close()
    assert await asyncio.wait_for(anext(events), 1) == {
        "event": "error", "data": json.dumps({"run": display.run, "error": "internal"}, separators=(",", ":"))}

    # Ask Claude's work cancelled while it runs.
    proving, started = Proving(), asyncio.Event()

    async def chat():
        started.set()
        await asyncio.Event().wait()

    async def admit():
        pass

    events = await proving.stream(("desk-1", "/chat", "body"), chat, admit=admit)
    await asyncio.wait_for(started.wait(), 1)
    await proving.close()
    assert await asyncio.wait_for(anext(events), 1) == {"event": "error", "data": '{"status":500,"error":"internal"}'}


async def test_a_stream_opened_while_the_answer_request_waits_gets_the_same_events(
        app, browser, kernel_http, model):
    owner, initial, path = await question_ready(app, browser, kernel_http, model)
    assert setup.TURN_WAIT_S == 25                      # the answer request is still waiting for its turn
    reply = "Got it: leaks and blocked drains. Do you take emergency calls"
    raw = answer_turn(setup.SETUP_TURNS["what_you_do"], reply, step_done=False).model_dump_json()
    prefix, rest = raw.split('"reply":"Got', 1)
    pieces = [prefix + '"reply":"Got', rest]
    gates = [asyncio.Event() for _ in pieces]
    entered = asyncio.Event()
    model.add(streaming(raw, pieces, gates, entered))
    request = asyncio.create_task(owner.browser.post(path + "/answer?cards=1", json={
        "question": "what_you_do", "text": "We fix leaks and blocked drains"}))
    live = None
    try:
        await asyncio.wait_for(entered.wait(), 5)
        assert not request.done()
        live = LiveEvents(app, browser, owner).open(path + "/events")
        name, data = await live.next()
        run = data["run"]
        assert (name, data) == ("delta", {"run": run, "text": "Got"})
        gates[0].set()
        assert await live.next() == ("delta", {"run": run, "text": reply})
        gates[1].set()
        assert await live.next() == ("done", {"run": run})
        answered = await asyncio.wait_for(request, 5)
        assert answered.status_code == 200 and answered.json()["busy"] is False
        assert answered.json() == (await owner.browser.get(path + "?cards=1")).json()
        assert reply in [message["text"] for message in answered.json()["messages"]]
    finally:
        for gate in gates:
            gate.set()
        if live is not None:
            await live.close()
        await asyncio.gather(request, return_exceptions=True)
        await app.state.runtime.turn_runs.wait(initial["interview_id"])
