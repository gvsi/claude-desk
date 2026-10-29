"""Turns per session, one at a time: the turn lock, generation fencing, failure paths and recovery by call ID (Plan
02a, Task 6). Claude runs on a scripted model, the kernel is FakeKernel, and each run goes through `run_pending`, the
way a request starts a turn."""

import asyncio
import itertools
import json
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import replace

import httpx
import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from desk.api import loop, tools
from desk.api.deliver import run_lock
from desk.api.kernel_client import KernelHttp
from desk.api.loop import TURN_LOCK_POOL_SIZE, run_pending, turn_lock
from desk.api.store import append_assistant, has_pending, lock_key, prepare_model_input
from desk.api.tools import Caller, send_reply
from desk.contracts import ToolCall
from desk.db.session import API_CONNECT_OPTIONS, database_url
from desk.kernel_api import DecideRequest, KernelError
from tests.api.fakes import ScriptedModel, gated, response, tool_use
from tests.api.test_deliver import waiting_for_lock
from tests.api.test_loop_turns import (
    DRAIN,
    HOURS,
    events,
    metric_rows,
    new_caller,
    open_slot,
    quote_fact,
    reply,
    rows,
    said,
    tool_results,
)
from tests.kernel_contract.fake_kernel import fake_kernel_app

Hook = Callable[[httpx.Request], Awaitable[None]]


@pytest.fixture
async def locks(db) -> AsyncIterator[AsyncEngine]:
    """The turn-lock pool, as the API process opens it: connections of their own, apart from the API's pool."""
    engine = create_async_engine(database_url("API"), connect_args={"options": API_CONNECT_OPTIONS},
                                 pool_size=TURN_LOCK_POOL_SIZE, max_overflow=0)
    yield engine
    await engine.dispose()


@pytest.fixture
def caller(visitor, ro_schema) -> Caller:
    return Caller(copy_id=visitor.ids.copy_id, desk_id=visitor.ids.desk_id, session_id=visitor.ids.session_id,
                  kind="visitor", kernel=visitor.kernel, ro_schema=ro_schema)


class Kernel(httpx.AsyncBaseTransport):
    """FakeKernel as a test watches it: `before[path]` is awaited before a request to that path reaches the fake,
    `after[path]` once the fake answered, `refuse[path]` answers (status, code) in the fake's place, and each answer
    is recorded in `answers` as (path, status, code)."""

    def __init__(self, fake, *, before: dict[str, Hook] | None = None, after: dict[str, Hook] | None = None,
                 refuse: dict[str, tuple[int, str]] | None = None):
        self._inner = httpx.ASGITransport(app=fake_kernel_app(fake))
        self.before, self.after, self.refuse = before or {}, after or {}, refuse or {}
        self.answers: list[tuple[str, int, str | None]] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path in self.before:
            await self.before[path](request)
        if path in self.refuse:
            status, code = self.refuse[path]
            answer = httpx.Response(status, content=KernelError(code=code).model_dump_json(),
                                    headers={"content-type": "application/json"})
        else:
            answer = await self._inner.handle_async_request(request)
        body = await answer.aread()
        code = KernelError.model_validate_json(body).code if answer.status_code >= 400 else None
        self.answers.append((path, answer.status_code, code))
        if path in self.after:
            await self.after[path](request)
        return answer

    def answered(self, path: str) -> list[tuple[int, str | None]]:
        return [(status, code) for at, status, code in self.answers if at == path]


async def turn_locks_held(engine: AsyncEngine, session_id: str) -> int:
    """How many connections hold the session's turn lock (a bigint advisory key: classid holds its high 32 bits)."""
    key = lock_key("turn:" + session_id)
    async with engine.connect() as conn:
        return (await conn.execute(text(
            "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND granted AND classid::bigint = :high"
            " AND objid::bigint = :low AND objsubid = 1"),
            {"high": (key >> 32) & 0xFFFFFFFF, "low": key & 0xFFFFFFFF})).scalar_one()


async def pending(caller: Caller, model, engine: AsyncEngine, locks: AsyncEngine, **options):
    """Run the session's pending work as a request would."""
    return await run_pending(caller, model, engine=engine, lock_engine=locks, production=False, **options)


async def test_take_over_mid_turn_blocks_everything(api_conn, engine, locks, caller, visitor, fake):
    # an earlier request is held for the owner
    held = await caller.kernel.call("POST /decide", DecideRequest(
        session_id=caller.session_id, generation=0, call=ToolCall(
            call_id="toolu_earlier", tool="native.quote", args={**DRAIN, "requested_discount_bp": 5000})))
    assert held.state == "held"

    await said(api_conn, caller, "Book me the earliest visit.")
    release = asyncio.Event()
    booking = gated(response(tool_use("native__book", {"slot_id": open_slot(fake, caller)}, id="toolu_book"),
                             reply("You're booked.", id="toolu_say")), release)
    model = ScriptedModel([booking])
    kernel = Kernel(fake)
    async with KernelHttp("http://fake-kernel", transport=kernel) as http:
        watched = replace(caller, kernel=http.session(visitor.token))
        run = asyncio.create_task(pending(watched, model, engine, locks))
        await asyncio.wait_for(booking.entered.wait(), 5)
        fake.set_mode(caller.session_id, "owner")             # the owner takes over while Claude is writing
        release.set()
        outcome = await asyncio.wait_for(run, 10)

    assert outcome == "fenced" and len(model.requests) == 1
    # the kernel refused both of Claude's calls at the old generation, and nothing ran or showed
    assert kernel.answered("/decide") == [(409, "stale_generation")]
    assert kernel.answered("/check_reply") == [(409, "stale_generation")]
    assert fake.called("/execute") == []
    assert [event.type for event in await events(api_conn, caller.session_id)] == ["writing", "turn_end"]
    ((results,),) = await rows(api_conn, caller.session_id, "model_tool_results", "model_content")
    assert [(result["tool_use_id"], result["content"], result["is_error"]) for result in results] == [
        ("toolu_book", '{"outcome":"not_run"}', True), ("toolu_say", '{"outcome":"not_run"}', True)]
    # a take-over doesn't cancel what the owner was already asked
    assert fake.decisions[held.decision_id].decision.state == "held"

    # while the owner has the conversation, a new message starts no turn: it waits for the hand-back
    await said(api_conn, caller, "Hello? Is anyone there?")
    assert await pending(caller, ScriptedModel(), engine, locks) == "not_ai"
    assert [event.type for event in await events(api_conn, caller.session_id)] == ["writing", "turn_end"]


async def test_delivery_paused_after_check_reply_shows_nothing_after_take_over(
        api_conn, engine, locks, caller, visitor, fake):
    # another API worker, on an engine of its own, takes the conversation over just as Claude's checked reply is about
    # to show: it holds the run lock around the mode change, as take-over does, so delivery waits and then reads the
    # new generation
    other = create_async_engine(database_url("API"), connect_args={"options": API_CONNECT_OPTIONS})
    taking_over: list[asyncio.Task] = []

    async def take_over(request: httpx.Request) -> None:
        conn = await other.connect()
        await run_lock(conn, caller.session_id)

        async def change_mode() -> None:
            await asyncio.wait_for(waiting_for_lock(engine, "run:" + caller.session_id), 5)
            fake.set_mode(caller.session_id, "owner")
            await conn.commit()
            await conn.close()

        taking_over.append(asyncio.create_task(change_mode()))

    await said(api_conn, caller, "Can you help with my drain?")
    model = ScriptedModel([response(reply("Happy to help with your drain.", id="toolu_say"))])
    kernel = Kernel(fake, after={"/check_reply": take_over})
    try:
        async with KernelHttp("http://fake-kernel", transport=kernel) as http:
            outcome = await pending(replace(caller, kernel=http.session(visitor.token)), model, engine, locks)
        await asyncio.wait_for(taking_over[0], 5)
    finally:
        await other.dispose()

    assert outcome == "fenced"
    assert kernel.answered("/check_reply") == [(200, None)]        # the kernel passed the reply at generation 0
    assert [event.type for event in await events(api_conn, caller.session_id)] == ["writing", "turn_end"]
    assert await rows(api_conn, caller.session_id, "delivered", "n") == []
    ((results,),) = await rows(api_conn, caller.session_id, "model_tool_results", "model_content")
    assert [(result["tool_use_id"], result["content"]) for result in results] == [
        ("toolu_say", '{"outcome":"not_run"}')]


async def control_rows(conn, session_id: str) -> list[tuple[str, dict]]:
    found = await conn.execute(text("SELECT type, payload FROM app.run_events WHERE session_id = :s"
                                    " AND kind = 'control' ORDER BY id"), {"s": session_id})
    return [(type, payload) for type, payload in found]


async def test_kernel_unavailable_mid_turn(api_conn, engine, locks, caller, fake, monkeypatch):
    monkeypatch.setattr(tools, "EXECUTE_POLL_S", 0.001)       # the ten polls, a second apart in production
    await said(api_conn, caller, "Book me the earliest visit.")
    fake.fail("/execute", "connect")                          # the kernel can't be reached to run the booking
    model = ScriptedModel([response(tool_use("native__book", {"slot_id": open_slot(fake, caller)}, id="toolu_book"),
                                    reply("You're booked.", id="toolu_say"))])

    assert await pending(caller, model, engine, locks) == "kernel_unavailable"

    # decided once, never again; the decision was read after the failure, and left for the visitor's next request
    assert len(fake.called("/decide")) == 1 and len(fake.called("/execute")) == 1
    (decision_id,) = {call.body["decision_id"] for call in fake.called("/execute")}
    assert len(fake.called("/decisions/{id}")) == tools.EXECUTE_POLLS
    assert await control_rows(api_conn, caller.session_id) == [("decision_pending", {"decision_id": decision_id})]
    # nothing showed but the static error; the reply was never checked, and Claude wasn't asked again
    assert fake.called("/check_reply") == [] and len(model.requests) == 1
    assert [(event.type, getattr(event, "code", None)) for event in await events(api_conn, caller.session_id)] == [
        ("writing", None), ("error", "kernel_unavailable"), ("turn_end", None)]
    ((results,),) = await rows(api_conn, caller.session_id, "model_tool_results", "model_content")
    assert [(result["tool_use_id"], result["content"]) for result in results] == [
        ("toolu_book", '{"outcome":"unavailable"}'), ("toolu_say", '{"outcome":"unavailable"}')]


async def test_session_error_mid_turn(api_conn, engine, locks, caller, visitor, fake):
    await said(api_conn, caller, "What times do you have?")
    model = ScriptedModel([response(tool_use("native__find_slots", {"days": 3}, id="toolu_slots"),
                                    reply("Let me look.", id="toolu_say"))])
    kernel = Kernel(fake, refuse={"/decide": (401, "auth")})   # the session's credential stopped working
    async with KernelHttp("http://fake-kernel", transport=kernel) as http:
        outcome = await pending(replace(caller, kernel=http.session(visitor.token)), model, engine, locks)

    assert outcome == "session_ended" and len(model.requests) == 1
    assert kernel.answered("/check_reply") == []
    assert [(event.type, getattr(event, "code", None)) for event in await events(api_conn, caller.session_id)] == [
        ("writing", None), ("error", "session"), ("turn_end", None)]
    ((results,),) = await rows(api_conn, caller.session_id, "model_tool_results", "model_content")
    assert [result["content"] for result in results] == ['{"outcome":"not_run"}'] * 2


async def committed(engine, sql: str, **params) -> int:
    async with engine.connect() as conn:
        return (await conn.execute(text(sql), params)).scalar_one()


async def test_interrupted_turn_recovers_by_call_without_redeciding(api_conn, engine, locks, caller, visitor, fake):
    executed = asyncio.Event()

    async def stall(request: httpx.Request) -> None:          # the booking ran; the API stops before it hears more
        executed.set()
        await asyncio.Event().wait()

    await said(api_conn, caller, "Book me the earliest visit.")
    model = ScriptedModel([response(tool_use("native__book", {"slot_id": open_slot(fake, caller)}, id="toolu_book"))])
    async with KernelHttp("http://fake-kernel", transport=Kernel(fake, after={"/execute": stall})) as http:
        run = asyncio.create_task(pending(replace(caller, kernel=http.session(visitor.token)), model, engine, locks))
        await asyncio.wait_for(executed.wait(), 5)
        assert await turn_locks_held(engine, caller.session_id) == 1
        run.cancel()                                           # the worker stops (a deploy, a crash)
        with pytest.raises(asyncio.CancelledError):
            await run
    assert await turn_locks_held(engine, caller.session_id) == 0     # let go, though the turn never finished

    # Claude's call is on record with no result, and the booking ran in the kernel without reaching the visitor
    (decision_id,) = [call.body["decision_id"] for call in fake.called("/execute")]
    assert fake.decisions[decision_id].decision.state == "executed"
    assert await rows(api_conn, caller.session_id, "model_tool_results", "n") == []
    assert [event.type for event in await events(api_conn, caller.session_id)] == ["writing"]

    # the next request finds the call by its ID before Claude is asked anything
    async def answer(request):
        assert await committed(engine, "SELECT count(*) FROM app.messages WHERE session_id = :s"
                                       " AND kind = 'model_tool_results'", s=caller.session_id) == 1
        return response(reply("You're booked.", id="toolu_done"))

    model = ScriptedModel([answer])
    assert await pending(caller, model, engine, locks) == "done"

    assert len(fake.called("/decide")) == 1                    # never decided again
    assert len(fake.called("/decisions/by_call")) == 1
    assert [call.body["decision_id"] for call in fake.called("/execute")] == [decision_id] * 2   # the repeat
    assert len(fake.desks[caller.desk_id].booked) == 1
    assert [entry.event.summary.get("repeat", False) for entry in fake.desks[caller.desk_id].ledger
            if entry.event.kind == "execute"] == [False, True]  # one booking; the repeat returned its stored result
    # Claude learns what happened, in place of the call's missing result, and the visitor sees the signed receipt
    (request,) = model.requests
    (result,) = [block for block in request.messages[-1]["content"] if block["type"] == "tool_result"]
    content = json.loads(result["content"])
    assert (result["tool_use_id"], content["outcome"], content["decision_id"], result["is_error"]) == (
        "toolu_book", "done", decision_id, False)
    assert [(event.type, getattr(event, "decision_id", None)) for event in await events(api_conn, caller.session_id)] \
        == [("writing", None), ("receipt", decision_id), ("writing", None), ("message", None), ("turn_end", None)]


async def test_context_unavailable_leaves_work_pending(api_conn, engine, locks, caller, fake):
    await said(api_conn, caller, "Do you fix leaks?")
    fake.fail("/context/{session_id}", "connect", times=1)    # the kernel is out of reach for the context
    model = ScriptedModel([response(reply("Yes, we fix leaks."))])

    assert await pending(caller, model, engine, locks) == "kernel_unavailable"

    # Claude wasn't asked, the visitor saw the static error, and the message still waits for a turn
    assert model.requests == []
    assert [(event.type, getattr(event, "code", None)) for event in await events(api_conn, caller.session_id)] == [
        ("writing", None), ("error", "kernel_unavailable"), ("turn_end", None)]
    assert await has_pending(api_conn, caller.session_id)
    assert await rows(api_conn, caller.session_id, "visitor_text", "model_seq", "wake") == [(None, True)]

    # once the kernel answers, the next request's turn takes it up
    assert await pending(caller, model, engine, locks) == "done"
    (request,) = model.requests
    assert request.messages[0]["content"][0]["text"] == "<visitor_message>Do you fix leaks?</visitor_message>"
    assert not await has_pending(api_conn, caller.session_id)

    # with nothing waiting, a request starts no turn and asks the kernel nothing
    calls = len(fake.calls)
    assert await pending(caller, ScriptedModel(), engine, locks) == "idle"
    assert len(fake.calls) == calls


class Counting(ScriptedModel):
    """A scripted model that also records how many calls it had in flight at most."""

    def __init__(self, script=()):
        super().__init__(script)
        self.in_flight = self.most = 0

    async def call(self, request):
        self.in_flight += 1
        self.most = max(self.most, self.in_flight)
        try:
            return await super().call(request)
        finally:
            self.in_flight -= 1


def visitor_texts(request) -> list[str]:
    return [block["text"] for message in request.messages if message["role"] == "user" for block in message["content"]
            if block["type"] == "text" and block["text"].startswith("<visitor_message>")]


async def test_run_lock_serializes_and_coalesces(api_conn, engine, locks, caller, fake, monkeypatch):
    release = asyncio.Event()
    first = gated(response(reply("Hi, how can I help?")), release)
    model = Counting([first, response(reply("Yes, we fix leaks under the sink."))])
    await said(api_conn, caller, "Hello!")
    running = asyncio.create_task(pending(caller, model, engine, locks))
    await asyncio.wait_for(first.entered.wait(), 5)

    # two more messages arrive while Claude writes: each request finds the session busy and starts no turn of its own
    for words in ("Do you fix leaks?", "Under the sink, I mean."):
        await said(api_conn, caller, words)
        assert await pending(caller, model, engine, locks) == "busy"
    release.set()
    assert await asyncio.wait_for(running, 10) == "done"

    # the running worker took both up in one more turn: no model calls overlapped, and no message was lost
    assert model.most == 1 and len(model.requests) == 2
    assert visitor_texts(model.requests[1]) == [f"<visitor_message>{words}</visitor_message>" for words in (
        "Hello!", "Do you fix leaks?", "Under the sink, I mean.")]
    assert [kind for kind, _ in await metric_rows(api_conn, caller.session_id)].count("turn") == 2
    assert not await has_pending(api_conn, caller.session_id)

    # a message that lands just after the worker last looked, while it still holds the lock, is answered once it lets go
    looked, late = loop.latest_pending, ["Are you open on Saturday?"]

    async def late_message(conn, session_id: str) -> int | None:
        found = await looked(conn, session_id)
        if found is None and late:
            await said(api_conn, caller, late.pop())
            assert await pending(caller, model, engine, locks) == "busy"
        return found

    monkeypatch.setattr(loop, "latest_pending", late_message)
    await said(api_conn, caller, "Thanks!")
    model.add(response(reply("You're welcome.")), response(reply("We're open Saturday mornings.", HOURS)))
    assert await pending(caller, model, engine, locks) == "done"
    assert late == [] and len(model.requests) == 4 and model.most == 1
    assert await turn_locks_held(engine, caller.session_id) == 0
    assert visitor_texts(model.requests[3])[-1] == "<visitor_message>Are you open on Saturday?</visitor_message>"
    assert await looked(api_conn, caller.session_id) is None


async def test_messages_stay_append_only_across_turns(api_conn, engine, locks, caller, fake):
    model = ScriptedModel([
        response(reply("Hi, how can I help?")),
        response(tool_use("native__quote", DRAIN, id="toolu_quote")),
        lambda request: response(reply("Here's your quote.", {"template": "quote", "fact_id": quote_fact(request)})),
        response(tool_use("native__find_slots", {"days": 3}, id="toolu_slots")),
        response(reply("Those are the open times.")),
    ])
    for words in ("Hello!", "How much is a drain clearing?", "When could you come?"):
        await said(api_conn, caller, words)
        assert await pending(caller, model, engine, locks) == "done", words

    # every request extends the one before it: nothing Claude was sent is ever edited, reordered or dropped
    assert len(model.requests) == 5
    for before, after in itertools.pairwise(model.requests):
        assert after.messages[:len(before.messages)] == before.messages
        assert len(after.messages) > len(before.messages)
    # and the cached prefix stays byte for byte the same: the system prompt and the context's tools
    assert len({json.dumps(request.system) for request in model.requests}) == 1
    assert len({json.dumps(request.tools) for request in model.requests}) == 1


async def test_new_visitor_message_joins_the_next_call(api_conn, engine, locks, caller, visitor, fake):
    busy = []

    async def meanwhile(request: httpx.Request) -> None:      # the visitor writes again while the slots are looked up
        if not busy:
            await said(api_conn, caller, "Saturday would be best.")
            busy.append(await pending(caller, ScriptedModel(), engine, locks))

    await said(api_conn, caller, "When could you come?")
    model = ScriptedModel([response(tool_use("native__find_slots", {"days": 3}, id="toolu_slots")),
                           response(reply("Here are the open times, Saturday included."))])
    async with KernelHttp("http://fake-kernel", transport=Kernel(fake, before={"/decide": meanwhile})) as http:
        assert await pending(replace(caller, kernel=http.session(visitor.token)), model, engine, locks) == "done"

    # the message's own request found the turn running; Claude read the message with the call's result, in one user
    # message (the result first), and the turn answered both with no third call
    assert busy == ["busy"] and len(model.requests) == 2
    first, second = model.requests
    added = second.messages[len(first.messages):]
    assert [message["role"] for message in added] == ["assistant", "user"]
    assert [block["type"] for block in added[1]["content"]] == ["tool_result", "text"]
    assert added[1]["content"][0]["tool_use_id"] == "toolu_slots"
    assert added[1]["content"][1]["text"] == "<visitor_message>Saturday would be best.</visitor_message>"
    assert [kind for kind, _ in await metric_rows(api_conn, caller.session_id)].count("turn") == 1
    assert not await has_pending(api_conn, caller.session_id)


async def test_recovered_replies_answer_from_what_was_delivered(api_conn, engine, locks, caller, fake):
    await said(api_conn, caller, "Hello!")
    assert await pending(caller, ScriptedModel([response(reply("Hi, how can I help?"))]), engine, locks) == "done"

    # a turn stopped after its replies went out: one showed, one was bad input on its second try (the handoff showed
    # in its place), and one never reached the kernel
    await said(api_conn, caller, "Do you fix leaks?")
    await prepare_model_input(api_conn, caller.session_id)
    shown = reply("Yes, we fix leaks.", id="toolu_shown")
    bad = tool_use("send_reply", {"prose": 7}, id="toolu_bad")
    lost = reply("Want me to find a time?", id="toolu_lost")
    await append_assistant(api_conn, caller.ids, [shown, bad, lost])
    await api_conn.commit()
    for block, attempt in ((shown, 1), (bad, 2)):
        await send_reply(api_conn, caller, 0, block["input"], attempt, call_id=block["id"])

    model = ScriptedModel()
    assert await pending(caller, model, engine, locks) == "idle"

    # each is answered from the delivered rows, without a kernel call or a model call: a reply showed, so the turn
    # had ended
    assert model.requests == [] and len(fake.called("/check_reply")) == 3
    *_, (results,) = await rows(api_conn, caller.session_id, "model_tool_results", "model_content")
    (message_id,) = [ref for ref, call in await rows(api_conn, caller.session_id, "delivered", "ref_id", "call_id")
                     if call == "toolu_shown"]
    assert [(result["tool_use_id"], json.loads(result["content"]), result["is_error"]) for result in results] == [
        ("toolu_shown", {"outcome": "delivered", "message_id": message_id}, False),
        ("toolu_bad", {"outcome": "delivered_handoff"}, True),
        ("toolu_lost", {"outcome": "not_run"}, True)]

    # a reply that never showed leaves the visitor unanswered: Claude is asked again, and reads why
    await prepare_model_input(api_conn, caller.session_id)
    await append_assistant(api_conn, caller.ids, [reply("We do.", id="toolu_gone")])
    await api_conn.commit()
    model = ScriptedModel([response(reply("Yes, we fix leaks."))])
    assert await pending(caller, model, engine, locks) == "done"
    (request,) = model.requests
    assert [(result["tool_use_id"], result["content"]) for result in tool_results(request)] == [
        ("toolu_gone", {"outcome": "not_run"})]


async def test_a_blocking_request_waits_for_the_turn_then_gives_up(api_conn, engine, locks, caller, fake, monkeypatch):
    # an agent's request waits for the turn running in its session (another worker's, here), then runs its own work
    key = "turn:" + caller.session_id
    await said(api_conn, caller, "Book the earliest visit for Alex Kim.")
    model = ScriptedModel([response(reply("Here are the open times."))])
    async with turn_lock(locks, caller.session_id) as taken:
        assert taken
        assert await pending(caller, model, engine, locks) == "busy"           # a visitor's request doesn't wait
        waiting = asyncio.create_task(pending(caller, model, engine, locks, blocking=True, end_on_reply=True))
        await asyncio.wait_for(waiting_for_lock(engine, key), 5)
        assert not waiting.done() and model.requests == []
    assert await asyncio.wait_for(waiting, 5) == "done" and len(model.requests) == 1

    # past the wait (30 s in production) it gives up, leaving the work for later, and the lock is free again after
    monkeypatch.setattr(loop, "TURN_LOCK_WAIT_S", 0.2)
    await said(api_conn, caller, "Is Saturday possible?")
    async with turn_lock(locks, caller.session_id) as taken:
        assert taken
        assert await pending(caller, model, engine, locks, blocking=True) == "busy"
    assert len(model.requests) == 1 and await has_pending(api_conn, caller.session_id)
    model.add(response(reply("Saturday mornings work.")))
    assert await pending(caller, model, engine, locks, blocking=True) == "done"
    assert await turn_locks_held(engine, caller.session_id) == 0


async def test_an_internal_error_ends_the_turn_with_the_static_error(api_conn, engine, locks, kernel_http, fake,
                                                                   ro_schema):
    async def ended_with_internal(caller: Caller) -> None:
        assert [(event.type, getattr(event, "code", None)) for event in await events(api_conn, caller.session_id)] == [
            ("writing", None), ("error", "internal"), ("turn_end", None)]
        assert await rows(api_conn, caller.session_id, "delivered", "n") == []
        (turn,) = [payload for kind, payload in await metric_rows(api_conn, caller.session_id) if kind == "turn"]
        assert turn["outcome"] == "internal"

    # the API's pool has no connection left for a call: it never reaches the kernel, the reply after it isn't
    # checked, and the turn ends at once
    small = create_async_engine(database_url("API"), connect_args={"options": API_CONNECT_OPTIONS},
                                pool_size=1, max_overflow=0, pool_timeout=0.2)
    try:
        caller = await new_caller(kernel_http, fake, ro_schema)
        await said(api_conn, caller, "What times do you have?")
        model = ScriptedModel([response(tool_use("native__find_slots", {"days": 3}, id="toolu_slots"),
                                        reply("Let me look.", id="toolu_say"))])
        assert await pending(caller, model, small, locks) == "internal"
    finally:
        await small.dispose()
    assert len(model.requests) == 1 and fake.called("/decide") == [] and fake.called("/check_reply") == []
    ((results,),) = await rows(api_conn, caller.session_id, "model_tool_results", "model_content")
    assert [result["content"] for result in results] == ['{"outcome":"not_run"}'] * 2
    await ended_with_internal(caller)

    # anything else the turn didn't expect ends it the same way
    caller = await new_caller(kernel_http, fake, ro_schema)
    await said(api_conn, caller, "Hello!")

    def broken(request):
        raise RuntimeError("the model client broke")

    assert await pending(caller, ScriptedModel([broken]), engine, locks) == "internal"
    await ended_with_internal(caller)


async def test_a_run_that_fails_outside_a_turn_leaves_its_work_for_the_next_request(api_conn, engine, locks, caller,
                                                                                    fake, monkeypatch):
    await said(api_conn, caller, "Hello!")
    assert await pending(caller, ScriptedModel([response(reply("Hi, how can I help?"))]), engine, locks) == "done"
    shown = len(await events(api_conn, caller.session_id))

    # an interrupted turn's call can't be recovered just now: the visitor sees the static error, the call stays open,
    # and Claude isn't asked anything
    await said(api_conn, caller, "Quote me a drain clearing.")
    await prepare_model_input(api_conn, caller.session_id)
    await append_assistant(api_conn, caller.ids, [tool_use("native__quote", DRAIN, id="toolu_quote")])
    await api_conn.commit()
    recover, broken = loop.recover_call, RuntimeError("recovery broke")

    async def failing(*args):
        raise broken

    monkeypatch.setattr(loop, "recover_call", failing)
    assert await pending(caller, ScriptedModel(), engine, locks) == "internal"
    assert [(event.type, getattr(event, "code", None)) for event in await events(api_conn, caller.session_id)][
        shown:] == [("error", "internal"), ("turn_end", None)]
    assert len(await rows(api_conn, caller.session_id, "model_tool_results", "n")) == 1      # the first turn's only

    # the next request recovers it (no decision was made for it, so it never ran) and Claude goes on
    monkeypatch.setattr(loop, "recover_call", recover)
    model = ScriptedModel([response(reply("Let me get you that quote."))])
    assert await pending(caller, model, engine, locks) == "done"
    assert [(result["tool_use_id"], result["content"]) for result in tool_results(model.requests[0])] == [
        ("toolu_quote", {"outcome": "not_run"})]

    # with no connection to be had, nothing can be shown or stored: the message waits for the next request
    small = create_async_engine(database_url("API"), connect_args={"options": API_CONNECT_OPTIONS},
                                pool_size=1, max_overflow=0, pool_timeout=0.2)
    await said(api_conn, caller, "Thanks!")
    shown = len(await events(api_conn, caller.session_id))
    try:
        async with small.connect():
            assert await pending(caller, ScriptedModel(), small, locks) == "internal"
    finally:
        await small.dispose()
    assert len(await events(api_conn, caller.session_id)) == shown
    assert await has_pending(api_conn, caller.session_id)
    assert await turn_locks_held(engine, caller.session_id) == 0


async def test_a_handoff_that_leaves_the_message_waiting_runs_once(api_conn, engine, locks, caller, visitor, fake,
                                                                    clock):
    # past today's model budget a turn hands off with no model call, so the visitor's message still waits: the run
    # shows the handoff once and stops, rather than handing off again and again; a message that arrives meanwhile
    # gets its own
    await api_conn.execute(text(
        "INSERT INTO app.model_calls (copy_id, route, model, input_tokens, cached_tokens, cache_write_tokens,"
        " output_tokens, latency_ms, stop_reason, created_at) VALUES ('copy-earlier', 'conversation',"
        " 'claude-opus-5-5', 0, 0, 0, 5000000, 900, 'end_turn', :at)"), {"at": clock()})
    await said(api_conn, caller, "Hello!")
    model, busy = ScriptedModel(), []

    async def meanwhile(request: httpx.Request) -> None:
        if not busy:
            await said(api_conn, caller, "Hello? Anyone there?")
            busy.append(await pending(caller, model, engine, locks))

    async with KernelHttp("http://fake-kernel", transport=Kernel(fake, before={"/check_reply": meanwhile})) as http:
        outcome = await asyncio.wait_for(run_pending(
            replace(caller, kernel=http.session(visitor.token)), model, engine=engine, lock_engine=locks,
            production=True, clock=clock), 5)

    assert outcome == "handoff" and busy == ["busy"] and model.requests == []
    assert [event.type for event in await events(api_conn, caller.session_id)] == [
        "message", "turn_end", "message", "turn_end"]
    assert await has_pending(api_conn, caller.session_id)
