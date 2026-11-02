"""Turns per session, one at a time: the turn lock, generation fencing, failure paths and recovery by call ID (Plan
02a, Task 6). Claude runs on a scripted model, the kernel is FakeKernel, and each run goes through `run_pending`, the
way a request starts a turn."""

import asyncio
import itertools
import json
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import replace
from types import SimpleNamespace

import httpx
import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from desk.api import loop, prompts, tools
from desk.api.deliver import Reply, Status, deliver, run_lock
from desk.api.kernel_client import KernelHttp
from desk.api.loop import TURN_LOCK_POOL_SIZE, run_pending, turn_lock
from desk.api.prompts import conversation_system
from desk.api.runner import TurnRunner
from desk.api.sse import emit
from desk.api.store import (
    append_assistant,
    append_message,
    append_time_note,
    has_pending,
    latest_said,
    lock_key,
    prepare_model_input,
    transcript,
)
from desk.api.tools import Caller, send_reply
from desk.contracts import Clause, RenderedBlock, ReplyDraft, ToolCall
from desk.db.session import API_CONNECT_OPTIONS, database_url
from desk.events import EvOwnerJoined
from desk.kernel_api import CheckReplyRequest, DecideRequest, KernelError
from tests.api.conftest import new_visitor
from tests.api.fakes import ScriptedModel, gated, response, thinking, tool_use, unavailable
from tests.api.test_deliver import waiting_for_lock
from tests.api.test_loop_turns import (
    DRAIN,
    HOURS,
    RIVERA,
    events,
    frozen_systems,
    metric_rows,
    new_caller,
    open_slot,
    opens_from_the_summary,
    quote_fact,
    reply,
    rows,
    said,
    thinking_blocks,
    tool_results,
)
from tests.kernel_contract.fake_kernel import fake_kernel_app

Hook = Callable[[httpx.Request], Awaitable[None]]


@pytest.mark.parametrize("handoff", [True, False])
@pytest.mark.parametrize("prose_shown", [True, False])
def test_recovered_reply_reads_the_delivered_handoff_flag_and_whether_its_prose_showed(handoff, prose_shown):
    # The delivered row's blocks, as stored: the prose Claude drafted shows as a prose block only when it passed.
    blocks = [*([RenderedBlock(kind="prose", text="Here is the quote.")] if prose_shown else []),
              RenderedBlock(kind="card", template="quote", text="Drain clearing"),
              RenderedBlock(kind="card", template="handoff", text="Let me check with Mike Turner.")]
    shown = SimpleNamespace(ref_id="msg-recovered", handoff=handoff, blocks=blocks)
    outcome = loop._recovered_reply(shown, tool_use("send_reply", {"prose": "Here is the quote.", "clauses": []}))
    assert outcome.delivered == ("handoff" if handoff else "reply")
    assert outcome.result["outcome"] == ("delivered_handoff" if handoff else "delivered")
    assert outcome.result.get("prose_shown", True) is prose_shown
    # a draft with no prose, or input that wasn't a draft, had no prose to leave out
    for tool_input in ({"prose": "", "clauses": []}, {"prose": 7}):
        assert "prose_shown" not in loop._recovered_reply(shown, tool_use("send_reply", tool_input)).result


@pytest.mark.parametrize("language", ["en", "es"])
def test_a_recovered_call_back_offer_is_a_reply_whose_prose_wasnt_shown(language):
    # The kernel's call-back offer is a prose block it writes in place of a draft blocked only for its prose with no
    # card to keep: delivered as a reply with no handoff, and Claude's own prose wasn't shown, the offer's words were
    # (`shown_instead`), unless those were its words (a passing reply that asks the same question shows Claude's prose).
    offer = prompts.STATUS_LINES["offer_callback"][language]
    shown = SimpleNamespace(ref_id="msg-recovered", handoff=False, blocks=[RenderedBlock(kind="prose", text=offer)])
    blocked = loop._recovered_reply(shown, tool_use("send_reply", {"prose": "It's $89.", "clauses": []}))
    assert (blocked.delivered, blocked.result) == (
        "reply", {"outcome": "delivered", "message_id": "msg-recovered", "prose_shown": False, "shown_instead": offer})
    asked = loop._recovered_reply(shown, tool_use("send_reply", {"prose": offer, "clauses": []}))
    assert asked.result == {"outcome": "delivered", "message_id": "msg-recovered"}


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


@pytest.mark.parametrize("kind", ["visitor", "agent"])
async def test_a_time_note_alone_starts_no_turn(api_conn, engine, locks, caller, fake, kind):
    caller = replace(caller, kind=kind)
    context = await caller.kernel.call("GET /context/{session_id}?desk_id=",
                                       path={"session_id": caller.session_id})
    assert await append_time_note(api_conn, caller.ids, context.clock) is not None
    assert not await has_pending(api_conn, caller.session_id)
    assert await latest_said(api_conn, caller.session_id) is None
    await api_conn.commit()
    fake.calls.clear()
    model = ScriptedModel()

    assert await pending(caller, model, engine, locks, end_on_reply=kind == "agent") == "idle"
    assert model.requests == [] and fake.calls == []
    assert await rows(api_conn, caller.session_id, "model_assistant", "n") == []
    assert await events(api_conn, caller.session_id) == []


async def test_take_over_mid_turn_blocks_everything(api_conn, engine, locks, caller, visitor, fake):
    # an earlier request is held for the owner
    held = await caller.kernel.call("POST /decide", DecideRequest(
        session_id=caller.session_id, generation=0, call=ToolCall(
            call_id="toolu_earlier", tool="native.quote", args={**DRAIN, "requested_discount_bp": 5000})))
    assert held.state == "held"

    await said(api_conn, caller, "Book me the earliest visit.")
    release = asyncio.Event()
    booking = gated(response(tool_use("native__book", {"slot_id": open_slot(fake, caller), "name": "Jane Doe", "contact": "jane@example.com"}, id="toolu_book"),
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
    model = ScriptedModel([response(tool_use("native__book", {"slot_id": open_slot(fake, caller), "name": "Jane Doe", "contact": "jane@example.com"}, id="toolu_book"),
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
    # the booking may still run, so it isn't answered `unavailable`: the response is left without its results row
    assert await rows(api_conn, caller.session_id, "model_tool_results", "model_content") == []

    # The next request finds the call by its ID, never deciding it again: the allow runs once, and Claude reads that
    # it ran before it replies.
    fake.fail("/execute", None)
    model.add(response(reply("You're booked.", id="toolu_booked")))
    await said(api_conn, caller, "Did it go through?")
    assert await pending(caller, model, engine, locks) == "done"
    assert len(fake.called("/decide")) == 1 and len(fake.called("/decisions/by_call")) == 1
    assert [entry.event.summary.get("repeat", False) for entry in fake.desks[caller.desk_id].ledger
            if entry.event.kind == "execute"] == [False]                # it ran once
    assert [(result["tool_use_id"], result["content"]["outcome"]) for result in tool_results(model.requests[-1])] == [
        ("toolu_book", "done"), ("toolu_say", "not_run")]
    assert fake.decisions[decision_id].decision.state == "executed"


async def test_a_money_call_left_open_is_never_run_by_a_later_visitor_message(api_conn, engine, locks, caller, fake,
                                                                             monkeypatch):
    # A payment link the kernel allowed, whose `/execute` couldn't reach it: the visitor's next message is another
    # request, so the call is answered from its decision, `unknown`, and `/execute` is never sent again for it; the
    # decision is left to its pending row and the kernel's reconciliation.
    monkeypatch.setattr(tools, "EXECUTE_POLL_S", 0)
    await said(api_conn, caller, "Can I pay the deposit now?")

    def link_with_the_kernel_down(request):
        (quoted,) = [result for result in tool_results(request) if result["content"]["outcome"] == "done"]
        fake.fail("/execute", "connect")
        return response(tool_use("native__payment_link", {"quote_id": quoted["content"]["result"]["quote_id"]},
                                 id="toolu_link"), reply("Here's the link.", id="toolu_say"))

    model = ScriptedModel([response(tool_use("native__quote", {"items": [{"item_id": "deposit", "qty": 1}]},
                                             id="toolu_quote")), link_with_the_kernel_down])
    assert await pending(caller, model, engine, locks) == "kernel_unavailable"
    (link,) = [record.decision for record in fake.decisions.values()
               if record.decision.session_id == caller.session_id and record.decision.action is not None
               and record.decision.action.tool == "native.payment_link"]
    assert link.state == "allowed"
    tries = [call for call in fake.called("/execute") if call.body["decision_id"] == link.decision_id]

    fake.fail("/execute", None)
    model.add(response(reply("I couldn't confirm the link yet.", id="toolu_later")))
    await said(api_conn, caller, "Did it work?")
    assert await pending(caller, model, engine, locks) == "done"
    assert [call for call in fake.called("/execute") if call.body["decision_id"] == link.decision_id] == tries
    assert [(result["tool_use_id"], result["content"]["outcome"]) for result in tool_results(model.requests[-1])] == [
        ("toolu_link", "unknown"), ("toolu_say", "not_run")]
    assert fake.decisions[link.decision_id].decision.state == "allowed"
    assert ("decision_pending", {"decision_id": link.decision_id}) in await control_rows(api_conn, caller.session_id)


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
    model = ScriptedModel([response(tool_use("native__book", {"slot_id": open_slot(fake, caller), "name": "Jane Doe", "contact": "jane@example.com"}, id="toolu_book"))])
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


async def interrupted_after_booking(api_conn, engine, locks, caller, visitor, fake) -> str:
    """A turn whose booking ran in the kernel before the worker stopped (a deploy): Claude's call is on record with no
    result. Returns the call's decision ID."""
    executed = asyncio.Event()

    async def stall(request: httpx.Request) -> None:
        executed.set()
        await asyncio.Event().wait()

    await said(api_conn, caller, "Book me the earliest visit.")
    model = ScriptedModel([response(thinking(), tool_use("native__book", {"slot_id": open_slot(fake, caller), "name": "Jane Doe", "contact": "jane@example.com"},
                                                         id="toolu_book"))])
    async with KernelHttp("http://fake-kernel", transport=Kernel(fake, after={"/execute": stall})) as http:
        run = asyncio.create_task(pending(replace(caller, kernel=http.session(visitor.token)), model, engine, locks))
        await asyncio.wait_for(executed.wait(), 5)
        run.cancel()
        with pytest.raises(asyncio.CancelledError):
            await run
    (decision_id,) = [call.body["decision_id"] for call in fake.called("/execute")]
    return decision_id


async def test_a_deploy_that_changes_the_prompt_mid_turn_lets_claude_read_what_ran_first(
        api_conn, engine, locks, caller, visitor, fake, monkeypatch):
    """The deploy that stopped a turn after its booking ran also changed the prompt. The recovered result is read in
    the context that made the call, on the prompt it froze, so Claude learns the booking ran (and never proposes it
    again); the new prompt opens a fresh context at the next turn."""
    opened_with = conversation_system(RIVERA)
    decision_id = await interrupted_after_booking(api_conn, engine, locks, caller, visitor, fake)
    monkeypatch.setattr(prompts, "SYSTEM_PROMPT", prompts.SYSTEM_PROMPT + "\n- Mention our new rule.")

    model = ScriptedModel([response(reply("You're booked.", id="toolu_done"))])
    assert await pending(caller, model, engine, locks) == "done"
    (request,) = model.requests
    assert request.system == opened_with and len(thinking_blocks(request)) == 1
    (result,) = [block for block in request.messages[-1]["content"] if block["type"] == "tool_result"]
    assert (result["tool_use_id"], json.loads(result["content"])["decision_id"]) == ("toolu_book", decision_id)
    assert [context for context, _ in await frozen_systems(api_conn, caller.session_id)] == [0]

    await said(api_conn, caller, "Thanks!")
    model = ScriptedModel([response(reply("You're welcome."))])
    assert await pending(caller, model, engine, locks) == "done"
    (fresh,) = model.requests
    assert fresh.system == conversation_system(RIVERA) != opened_with and thinking_blocks(fresh) == []
    opens_from_the_summary(fresh, "visitor: Book me the earliest visit.",
                           "claude (shown to the visitor): You're booked.")
    assert [context for context, _ in await frozen_systems(api_conn, caller.session_id)] == [0, 1]
    assert len(fake.called("/decide")) == 1 and len(fake.desks[caller.desk_id].booked) == 1


async def test_a_fresh_context_carries_the_results_claude_had_not_read(api_conn, engine, locks, caller, visitor,
                                                                       fake):
    """A conversation under way before contexts froze their prompt can't stay in its context, so the turn that
    recovers a call that ran opens a fresh one. The summary carries the result Claude hadn't read, one line, escaped
    inside <conversation_so_far> like any untrusted text, so Claude learns the booking ran."""
    decision_id = await interrupted_after_booking(api_conn, engine, locks, caller, visitor, fake)
    await api_conn.execute(text("UPDATE app.messages SET model_content = model_content - 'system'"
                                " WHERE session_id = :s AND kind = 'context_start'"), {"s": caller.session_id})
    await api_conn.commit()

    model = ScriptedModel([response(reply("You're booked.", id="toolu_done"))])
    assert await pending(caller, model, engine, locks) == "done"
    (fresh,) = model.requests
    assert fresh.system == conversation_system(RIVERA) and thinking_blocks(fresh) == []
    opens_from_the_summary(fresh, "visitor: Book me the earliest visit.", "result of native__book: {")
    (line,) = [line for line in fresh.messages[0]["content"][0]["text"].splitlines()
               if line.startswith("result of native__book: ")]
    result = json.loads(line.removeprefix("result of native__book: "))
    assert (result["outcome"], result["decision_id"]) == ("done", decision_id)
    assert [context for context, _ in await frozen_systems(api_conn, caller.session_id)] == [0, 1]
    assert len(fake.called("/decide")) == 1 and len(fake.desks[caller.desk_id].booked) == 1


async def test_a_recovery_whose_reply_showed_only_as_the_handoff_asks_claude_nothing_more(
        api_conn, engine, locks, caller, visitor, fake, monkeypatch):
    """Claude booked and replied in one response; the reply showed only as the handoff (it carried a canary), and the
    worker stopped before the results row. A shown handoff ends a turn as any shown reply does, so recovering the
    calls runs no turn of its own and nothing shows after the handoff; after a deploy that changed the prompt, the
    visitor's next message opens a fresh context at once."""
    opened_with = conversation_system(RIVERA)
    await said(api_conn, caller, "Book me the earliest visit.")
    fake.violation("canary")                         # the reply carries a document canary: the handoff in its place
    stopped, write = asyncio.Event(), loop.append_tool_results

    async def stop_before_the_results(*args, **kwargs):  # the worker stops (a deploy) after the handoff showed
        stopped.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(loop, "append_tool_results", stop_before_the_results)
    model = ScriptedModel([response(thinking(), tool_use("native__book", {"slot_id": open_slot(fake, caller), "name": "Jane Doe", "contact": "jane@example.com"},
                                                         id="toolu_book"), reply("Booking you in.", id="toolu_say"))])
    run = asyncio.create_task(pending(caller, model, engine, locks))
    await asyncio.wait_for(stopped.wait(), 5)
    run.cancel()
    with pytest.raises(asyncio.CancelledError):
        await run
    monkeypatch.setattr(loop, "append_tool_results", write)
    assert [blocks[0]["template"] for (blocks,) in await rows(api_conn, caller.session_id, "delivered", "blocks")] == [
        "handoff"]

    monkeypatch.setattr(prompts, "SYSTEM_PROMPT", prompts.SYSTEM_PROMPT + "\n- Mention our new rule.")
    model = ScriptedModel()
    assert await pending(caller, model, engine, locks) == "idle"
    assert model.requests == []
    *_, (results,) = await rows(api_conn, caller.session_id, "model_tool_results", "model_content")
    assert [(result["tool_use_id"], json.loads(result["content"])["outcome"]) for result in results] == [
        ("toolu_book", "done"), ("toolu_say", "delivered_handoff")]
    assert [blocks[0]["template"] for (blocks,) in await rows(api_conn, caller.session_id, "delivered", "blocks")] == [
        "handoff"]
    assert [context for context, _ in await frozen_systems(api_conn, caller.session_id)] == [0]

    await said(api_conn, caller, "Thanks!")
    model = ScriptedModel([response(reply("You're welcome."))])
    assert await pending(caller, model, engine, locks) == "done"
    assert model.requests[0].system == conversation_system(RIVERA) != opened_with
    assert [context for context, _ in await frozen_systems(api_conn, caller.session_id)] == [0, 1]


async def test_a_recovery_whose_reply_showed_opens_the_new_prompt_at_once(
        api_conn, engine, locks, caller, visitor, fake, monkeypatch):
    """Claude booked and replied in one response, the reply showed, and the worker stopped before the results row.
    Claude has had its say, so recovering the calls needs no turn of its own: after a deploy that changed the prompt,
    the visitor's next message opens a fresh context at once, its summary carrying the booking's result."""
    opened_with = conversation_system(RIVERA)
    await said(api_conn, caller, "Book me the earliest visit.")
    stopped, write = asyncio.Event(), loop.append_tool_results

    async def stop_before_the_results(*args, **kwargs):  # the worker stops (a deploy) after the reply showed
        stopped.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(loop, "append_tool_results", stop_before_the_results)
    model = ScriptedModel([response(thinking(), tool_use("native__book", {"slot_id": open_slot(fake, caller), "name": "Jane Doe", "contact": "jane@example.com"},
                                                         id="toolu_book"), reply("Booking you in.", id="toolu_say"))])
    run = asyncio.create_task(pending(caller, model, engine, locks))
    await asyncio.wait_for(stopped.wait(), 5)
    run.cancel()
    with pytest.raises(asyncio.CancelledError):
        await run
    monkeypatch.setattr(loop, "append_tool_results", write)
    assert await rows(api_conn, caller.session_id, "delivered", "author", "call_id") == [("claude", "toolu_say")]

    monkeypatch.setattr(prompts, "SYSTEM_PROMPT", prompts.SYSTEM_PROMPT + "\n- Mention our new rule.")
    await said(api_conn, caller, "Is that confirmed?")
    model = ScriptedModel([response(reply("Your visit is booked."))])
    assert await pending(caller, model, engine, locks) == "done"
    (fresh,) = model.requests
    assert fresh.system == conversation_system(RIVERA) != opened_with and thinking_blocks(fresh) == []
    opens_from_the_summary(fresh, "claude (shown to the visitor): Booking you in.", "result of native__book: ")
    assert [context for context, _ in await frozen_systems(api_conn, caller.session_id)] == [0, 1]
    assert len(fake.called("/decide")) == 1 and len(fake.desks[caller.desk_id].booked) == 1


async def test_a_carried_result_survives_a_second_fresh_context_before_claude_answers(
        api_conn, engine, locks, caller, visitor, fake, monkeypatch):
    """The fresh context that carried the recovered booking never got an answer (the model was unavailable), and a
    deploy changed the prompt before the next turn: the next summary carries the booking again."""
    decision_id = await interrupted_after_booking(api_conn, engine, locks, caller, visitor, fake)
    await api_conn.execute(text("UPDATE app.messages SET model_content = model_content - 'system'"
                                " WHERE session_id = :s AND kind = 'context_start'"), {"s": caller.session_id})
    await api_conn.commit()
    failed = ScriptedModel([unavailable()])
    assert await pending(caller, failed, engine, locks) == "handoff"
    assert decision_id in failed.requests[0].messages[0]["content"][0]["text"]

    monkeypatch.setattr(prompts, "SYSTEM_PROMPT", prompts.SYSTEM_PROMPT + "\n- Mention our new rule.")
    await said(api_conn, caller, "Did that go through?")
    model = ScriptedModel([response(reply("Your visit is booked."))])
    assert await pending(caller, model, engine, locks) == "done"
    (fresh,) = model.requests
    opens_from_the_summary(fresh, "result of native__book: ")
    assert decision_id in fresh.messages[0]["content"][0]["text"]
    assert [context for context, _ in await frozen_systems(api_conn, caller.session_id)] == [0, 1, 2]


def failing_statuses(times: int) -> tuple[list[str], Callable]:
    """A `deliver` whose first `times` statuses fail as a dropped connection would, after the kernel acted; it records
    each failed phase. Replies are delivered as usual."""
    publish, failed = tools.deliver, []

    async def deliver(conn, ids, item, **options):
        if isinstance(item, Status) and len(failed) < times:
            failed.append(item.phase)
            raise ConnectionError("the connection dropped")
        return await publish(conn, ids, item, **options)

    return failed, deliver


def session_decisions(fake, session_id: str) -> list[str]:
    return [record.decision.decision_id for record in fake.decisions.values()
            if record.decision.session_id == session_id]


async def test_a_call_that_raised_once_the_kernel_had_it_is_found_by_its_id(api_conn, engine, locks, caller, fake,
                                                                             monkeypatch):
    """A call whose routing raised once the kernel had it (here its receipt failed to publish, after the booking ran)
    is found by its call ID and settled in the same turn, never answered `not_run`: Claude and the visitor learn what
    the kernel did, and nothing is decided or run again."""
    failed, deliver = failing_statuses(1)
    monkeypatch.setattr(tools, "deliver", deliver)
    await said(api_conn, caller, "Book me the earliest visit.")
    model = ScriptedModel([response(tool_use("native__book", {"slot_id": open_slot(fake, caller), "name": "Jane Doe", "contact": "jane@example.com"}, id="toolu_book")),
                           response(reply("You're booked.", id="toolu_say"))])

    assert await pending(caller, model, engine, locks) == "done"

    assert failed == ["receipt"]
    (decision_id,) = session_decisions(fake, caller.session_id)
    assert len(fake.called("/decide")) == 1 and len(fake.desks[caller.desk_id].booked) == 1
    assert [entry.event.summary.get("repeat", False) for entry in fake.desks[caller.desk_id].ledger
            if entry.event.kind == "execute"] == [False, True]  # one booking; the repeat returned its stored result
    (result,) = tool_results(model.requests[1])
    assert (result["tool_use_id"], result["content"]["outcome"], result["content"]["decision_id"],
            result["is_error"]) == ("toolu_book", "done", decision_id, False)
    assert [(event.type, getattr(event, "decision_id", None)) for event in await events(api_conn, caller.session_id)] \
        == [("writing", None), ("receipt", decision_id), ("message", None), ("turn_end", None)]
    assert await control_rows(api_conn, caller.session_id) == []


@pytest.mark.parametrize(("mode", "code"), [("owner", "stale_generation"), ("paused", "mode_paused")])
async def test_a_call_that_raised_before_a_take_over_is_answered_from_what_ran(
        api_conn, engine, locks, caller, visitor, fake, monkeypatch, mode, code):
    """A take-over (or the breaker's pause) that lands between a call that raised and its recovery leaves the kernel
    refusing the repeat of /execute that would return the stored result. The booking ran, so the call is answered from
    its decision, as its receipt shows it, never `not_run`, and the turn stops quietly: once the conversation comes
    back to Claude, it reads that the booking went through and has no reason to propose it again."""
    publish, failed = tools.deliver, []

    async def deliver(conn, ids, item, **options):
        if isinstance(item, Status) and not failed:
            failed.append(item.phase)
            fake.set_mode(caller.session_id, mode)             # the owner takes over meanwhile
            raise ConnectionError("the connection dropped")
        return await publish(conn, ids, item, **options)

    monkeypatch.setattr(tools, "deliver", deliver)
    await said(api_conn, caller, "Book me the earliest visit.")
    model = ScriptedModel([response(tool_use("native__book", {"slot_id": open_slot(fake, caller), "name": "Jane Doe", "contact": "jane@example.com"}, id="toolu_book"))])
    kernel = Kernel(fake)
    async with KernelHttp("http://fake-kernel", transport=kernel) as http:
        outcome = await pending(replace(caller, kernel=http.session(visitor.token)), model, engine, locks)

    assert (outcome, failed, len(model.requests)) == ("fenced", ["receipt"], 1)
    assert kernel.answered("/execute") == [(200, None), (409, code)]      # the booking, then the refused repeat
    (decision_id,) = session_decisions(fake, caller.session_id)
    decision = fake.decisions[decision_id].decision
    assert decision.state == "executed" and len(fake.desks[caller.desk_id].booked) == 1
    assert len(fake.called("/decide")) == 1
    ((results,),) = await rows(api_conn, caller.session_id, "model_tool_results", "model_content")
    assert [(result["tool_use_id"], json.loads(result["content"]), result["is_error"]) for result in results] == [
        ("toolu_book", {"outcome": "done", "decision_id": decision_id, "message": decision.visitor_plain}, False)]
    assert [(event.type, getattr(event, "decision_id", None)) for event in await events(api_conn, caller.session_id)] \
        == [("writing", None), ("receipt", decision_id), ("turn_end", None)]
    assert await control_rows(api_conn, caller.session_id) == []


async def test_a_call_nothing_could_settle_stays_open_for_the_next_request(api_conn, engine, locks, caller, fake,
                                                                           monkeypatch):
    """When settling a call that raised fails too, the turn leaves Claude's call open, and a decision that isn't final
    as a `decision_pending` row; the session's next request settles it by call ID before Claude is asked anything."""
    failed, deliver = failing_statuses(2)
    monkeypatch.setattr(tools, "deliver", deliver)
    await said(api_conn, caller, "Can I get the drain clearing at half price?")
    model = ScriptedModel([response(tool_use("native__quote", {**DRAIN, "requested_discount_bp": 5000},
                                             id="toolu_half"))])

    assert await pending(caller, model, engine, locks) == "internal"

    assert failed == ["held", "held"]                          # the call's publication, then the recovery's
    (decision_id,) = session_decisions(fake, caller.session_id)
    assert fake.decisions[decision_id].decision.state == "held"
    assert await rows(api_conn, caller.session_id, "model_tool_results", "n") == []      # the call stays open
    assert await control_rows(api_conn, caller.session_id) == [("decision_pending", {"decision_id": decision_id})]
    assert [(event.type, getattr(event, "code", None)) for event in await events(api_conn, caller.session_id)] == [
        ("writing", None), ("error", "internal"), ("turn_end", None)]

    model = ScriptedModel([response(reply(prompts.STATUS_LINES["check_status"]["en"]))])
    assert await pending(caller, model, engine, locks) == "done"
    assert len(fake.called("/decide")) == 1                    # never decided again
    (held,) = tool_results(model.requests[0])
    assert (held["tool_use_id"], held["content"]) == ("toolu_half", {
        "outcome": "held_for_owner", "decision_id": decision_id,
        "message": fake.decisions[decision_id].decision.visitor_plain})
    assert [(event.type, getattr(event, "decision_id", None)) for event in await events(
        api_conn, caller.session_id)][3:] == [("held", decision_id), ("writing", None), ("message", None),
                                              ("turn_end", None)]


async def test_a_call_whose_decision_cant_be_read_stays_open_until_it_can(api_conn, engine, locks, caller, fake,
                                                                          monkeypatch):
    """The booking ran, but neither its receipt nor the recovery's reached the visitor, and the next request can't reach
    the kernel to find the call's decision. Whether it ran isn't known there, so Claude's call stays open, with no
    results row, and the turn stops before Claude is asked anything. The request after that, with the kernel back,
    settles it: the visitor sees the receipt once, and Claude reads that the booking went through, never that it was
    unavailable, so it has no reason to propose it again."""
    failed, deliver = failing_statuses(2)
    monkeypatch.setattr(tools, "deliver", deliver)
    await said(api_conn, caller, "Book me the earliest visit.")
    model = ScriptedModel([response(tool_use("native__book", {"slot_id": open_slot(fake, caller), "name": "Jane Doe", "contact": "jane@example.com"}, id="toolu_book"))])
    assert await pending(caller, model, engine, locks) == "internal"
    assert failed == ["receipt", "receipt"]                    # the call's publication, then the recovery's
    (decision_id,) = session_decisions(fake, caller.session_id)
    assert fake.decisions[decision_id].decision.state == "executed"
    assert await rows(api_conn, caller.session_id, "model_tool_results", "n") == []

    fake.fail("GET /decisions/by_call", "connect", times=1)    # the next request can't reach the kernel to find it
    model = ScriptedModel()
    assert await pending(caller, model, engine, locks) == "kernel_unavailable"
    assert model.requests == []
    assert await rows(api_conn, caller.session_id, "model_tool_results", "n") == []      # the call stays open
    assert await control_rows(api_conn, caller.session_id) == []
    assert [(event.type, getattr(event, "code", None)) for event in await events(api_conn, caller.session_id)] == [
        ("writing", None), ("error", "internal"), ("turn_end", None), ("error", "kernel_unavailable"),
        ("turn_end", None)]

    model = ScriptedModel([response(reply("You're booked.", id="toolu_done"))])
    assert await pending(caller, model, engine, locks) == "done"
    assert len(fake.called("/decide")) == 1 and len(fake.desks[caller.desk_id].booked) == 1
    (result,) = tool_results(model.requests[0])
    assert (result["tool_use_id"], result["content"]["outcome"], result["content"]["decision_id"],
            result["is_error"]) == ("toolu_book", "done", decision_id, False)
    answered = await rows(api_conn, caller.session_id, "model_tool_results", "model_content")
    assert [[result["tool_use_id"] for result in results] for (results,) in answered] == [["toolu_book"],
                                                                                          ["toolu_done"]]
    assert [(event.type, getattr(event, "decision_id", None)) for event in await events(
        api_conn, caller.session_id)][5:] == [("receipt", decision_id), ("writing", None), ("message", None),
                                              ("turn_end", None)]


async def test_a_conflict_whose_decision_cant_be_read_is_never_sent_to_execute_again(
        api_conn, engine, locks, caller, visitor, fake):
    """A call whose routing raised once the kernel had it (here its `/decide` answer was lost to an error the API can't
    name) is settled by call ID. Its `/execute` answers 409 `conflict` (another request began it a moment ago) and the
    decision can't be read after it. The kernel was asked, so the call isn't left open as one it never had: Claude
    reads `unknown`, the decision is left for the visitor's next request, which publishes its final state, and
    `/execute` is never sent again for it."""
    async def lost(request: httpx.Request) -> None:
        raise RuntimeError("the answer was lost")

    await said(api_conn, caller, "Book me the earliest visit.")
    fake.in_flight("native.book")
    fake.fail("GET /decisions/{id}", "connect", times=1)
    model = ScriptedModel([response(tool_use("native__book", {"slot_id": open_slot(fake, caller), "name": "Jane Doe", "contact": "jane@example.com"}, id="toolu_book"))])
    kernel = Kernel(fake, after={"/decide": lost})
    async with KernelHttp("http://fake-kernel", transport=kernel) as http:
        outcome = await pending(replace(caller, kernel=http.session(visitor.token)), model, engine, locks)

    assert outcome == "kernel_unavailable"
    (decision_id,) = session_decisions(fake, caller.session_id)
    assert kernel.answered("/execute") == [(409, "conflict")]
    assert await control_rows(api_conn, caller.session_id) == [("decision_pending", {"decision_id": decision_id})]
    ((results,),) = await rows(api_conn, caller.session_id, "model_tool_results", "model_content")
    assert [(result["tool_use_id"], json.loads(result["content"]), result["is_error"]) for result in results] == [
        ("toolu_book", {"outcome": "unknown", "decision_id": decision_id}, True)]

    # the next request finds nothing open, and sends nothing to /execute
    assert await pending(caller, ScriptedModel(), engine, locks) == "idle"
    assert len(fake.called("/execute")) == 1 and len(fake.called("/decide")) == 1


async def interrupt_after(path: str, caller: Caller, visitor, fake, engine: AsyncEngine, locks: AsyncEngine,
                          script: list) -> None:
    """Run a turn on `script` and stop its worker (a deploy, a crash) once the kernel answered `path`, before the
    API hears the answer: Claude's call stays on record with no result."""
    answered = asyncio.Event()

    async def stall(request: httpx.Request) -> None:
        answered.set()
        await asyncio.Event().wait()

    async with KernelHttp("http://fake-kernel", transport=Kernel(fake, after={path: stall})) as http:
        run = asyncio.create_task(pending(replace(caller, kernel=http.session(visitor.token)), ScriptedModel(script),
                                          engine, locks))
        await asyncio.wait_for(answered.wait(), 5)
        run.cancel()
        with pytest.raises(asyncio.CancelledError):
            await run


async def test_recovery_after_a_take_over_and_hand_back_answers_from_what_ran(
        api_conn, engine, locks, caller, visitor, fake):
    # the booking ran at generation 0, and the worker stopped before Claude or the visitor heard of it
    await said(api_conn, caller, "Book me the earliest visit.")
    await interrupt_after("/execute", caller, visitor, fake, engine, locks, [
        response(tool_use("native__book", {"slot_id": open_slot(fake, caller), "name": "Jane Doe", "contact": "jane@example.com"}, id="toolu_book"))])
    (decision_id,) = [call.body["decision_id"] for call in fake.called("/execute")]
    decision = fake.decisions[decision_id].decision
    assert decision.state == "executed"
    # the visitor saw nothing, so the owner takes the conversation over and hands it back: generation 2
    fake.set_mode(caller.session_id, "owner")
    fake.set_mode(caller.session_id, "ai")
    assert fake.sessions[caller.session_id].generation == 2

    await said(api_conn, caller, "Did that go through?")
    model = ScriptedModel([response(reply("You're booked.", id="toolu_done"))])
    assert await pending(caller, model, engine, locks) == "done"

    # the call is found at the generation its turn ran at, and nothing is decided or run again
    (lookup,) = fake.called("/decisions/by_call")
    assert lookup.query == {"session_id": caller.session_id, "generation": "0", "call_id": "toolu_book"}
    assert len(fake.called("/decide")) == 1 and len(fake.called("/execute")) == 1
    assert len(fake.desks[caller.desk_id].booked) == 1
    # Claude learns the booking ran, so it isn't proposed again under a new ID, and the visitor sees the receipt
    (request,) = model.requests
    (result,) = [block for block in request.messages[-1]["content"] if block["type"] == "tool_result"]
    assert (result["tool_use_id"], json.loads(result["content"]), result["is_error"]) == (
        "toolu_book", {"outcome": "done", "decision_id": decision_id, "message": decision.visitor_plain}, False)
    assert [(event.type, getattr(event, "decision_id", None)) for event in await events(api_conn, caller.session_id)] \
        == [("writing", None), ("receipt", decision_id), ("writing", None), ("message", None), ("turn_end", None)]


async def test_recovery_during_a_take_over_runs_nothing_and_leaves_an_open_allow_pending(
        api_conn, engine, locks, caller, visitor, fake):
    # an earlier take-over and hand-back: the session is at generation 2
    fake.set_mode(caller.session_id, "owner")
    fake.set_mode(caller.session_id, "ai")
    # the kernel allowed the booking at generation 2, and the worker stopped before it asked to run it
    await said(api_conn, caller, "Book me the earliest visit.")
    await interrupt_after("/decide", caller, visitor, fake, engine, locks, [
        response(tool_use("native__book", {"slot_id": open_slot(fake, caller), "name": "Jane Doe", "contact": "jane@example.com"}, id="toolu_book"))])
    (decision,) = [found.decision for found in fake.decisions.values() if found.decision.call_id == "toolu_book"]
    assert decision.state == "allowed"
    fake.set_mode(caller.session_id, "owner")                # the owner takes over: generation 3

    # the visitor writes meanwhile: their request answers the open call, and Claude stays quiet
    await said(api_conn, caller, "Hello?")
    model = ScriptedModel()
    assert await pending(caller, model, engine, locks) == "not_ai"

    # found at generation 2 and never run at generation 3, where the kernel would refuse it; how it ends is left
    # for the visitor's next request, which publishes its final state
    (lookup,) = fake.called("/decisions/by_call")
    assert lookup.query["generation"] == "2"
    assert fake.called("/execute") == [] and len(fake.called("/decide")) == 1
    assert fake.desks[caller.desk_id].booked == set()
    assert await control_rows(api_conn, caller.session_id) == [
        ("decision_pending", {"decision_id": decision.decision_id})]
    # Claude will read that it's not known to have gone through, rather than that it never ran
    ((results,),) = await rows(api_conn, caller.session_id, "model_tool_results", "model_content")
    assert [(result["tool_use_id"], json.loads(result["content"]), result["is_error"]) for result in results] == [
        ("toolu_book", {"outcome": "unknown", "decision_id": decision.decision_id,
                        "message": decision.visitor_plain}, True)]
    assert model.requests == []
    assert [event.type for event in await events(api_conn, caller.session_id)] == ["writing"]


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
    busy, calls_before_turn = [], []

    async def meanwhile(request: httpx.Request) -> None:      # the visitor writes again while the slots are looked up
        if not busy:
            await said(api_conn, caller, "Saturday would be best.")
            busy.append(await pending(caller, ScriptedModel(), engine, locks))

    async def turn_starts(request: httpx.Request) -> None:
        calls_before_turn.append(len(model.requests))

    await said(api_conn, caller, "When could you come?")
    model = ScriptedModel([response(tool_use("native__find_slots", {"days": 3}, id="toolu_slots")),
                           response(reply("Here are the open times, Saturday included."))])
    kernel = Kernel(fake, before={"/decide": meanwhile, f"/sessions/{caller.session_id}/turn": turn_starts})
    async with KernelHttp("http://fake-kernel", transport=kernel) as http:
        assert await pending(replace(caller, kernel=http.session(visitor.token)), model, engine, locks) == "done"

    # the message's own request found the turn running; Claude read the message with the call's result, in one user
    # message (the result first), and the turn answered both with no third call
    assert busy == ["busy"] and len(model.requests) == 2
    # the kernel heard each message before Claude read it (GitHub issue #121): the first as the turn started, the
    # second before the call that read it, once
    assert [call.body["text"] for call in fake.called("POST /sessions/{session_id}/turn")] == [
        "When could you come?", "Saturday would be best."]
    assert calls_before_turn == [0, 1]
    first, second = model.requests
    added = second.messages[len(first.messages):]
    assert [message["role"] for message in added] == ["assistant", "user"]
    assert [block["type"] for block in added[1]["content"]] == ["tool_result", "text"]
    assert added[1]["content"][0]["tool_use_id"] == "toolu_slots"
    assert added[1]["content"][1]["text"] == "<visitor_message>Saturday would be best.</visitor_message>"
    assert [kind for kind, _ in await metric_rows(api_conn, caller.session_id)].count("turn") == 1
    assert not await has_pending(api_conn, caller.session_id)


@pytest.mark.parametrize("end_on_reply", [True, False], ids=["agent", "visitor"])
@pytest.mark.parametrize("drafted_handoff", [True, False], ids=["cards-then-handoff", "cards-alone"])
async def test_recovered_final_prose_failure_ends_the_request_without_another_call(
        api_conn, engine, locks, caller, fake, end_on_reply, drafted_handoff):
    # A turn stopped after its final reply was delivered and before the results row: only the prose failed, so the
    # kernel's verdict keeps the checked hours card and, after it, the handoff clause Claude drafted, when it drafted
    # one. Recovery answers the call from that delivery, saying its prose wasn't shown, and asks Claude nothing more,
    # for an agent's request and a visitor's alike.
    await said(api_conn, caller, "Hello")
    assert await pending(caller, ScriptedModel([response(reply("Hello, how can I help?"))]), engine, locks) == "done"
    await said(api_conn, caller, "When are you open?")
    await prepare_model_input(api_conn, caller.session_id)
    clauses = [HOURS, *([{"template": "handoff"}] if drafted_handoff else [])]
    block = reply("Here is $89.", *clauses, id="toolu_crashed")
    await append_assistant(api_conn, caller.ids, [block], generation=0)
    await api_conn.commit()
    verdict = await caller.kernel.call("POST /check_reply", CheckReplyRequest(draft=ReplyDraft(
        session_id=caller.session_id, generation=0, prose=block["input"]["prose"],
        clauses=[Clause(**clause) for clause in clauses]), final=True))
    templates = ["hours", "handoff"] if drafted_handoff else ["hours"]
    assert not verdict.ok and [b.template for b in verdict.blocks] == templates
    await deliver(api_conn, caller.ids, Reply(verdict, "claude", "model", call_id=block["id"]),
                  ro_schema=caller.ro_schema)
    await api_conn.commit()
    model = ScriptedModel()
    assert await pending(caller, model, engine, locks, end_on_reply=end_on_reply) == "idle"
    assert model.requests == [] and len(fake.called("/check_reply")) == 2
    results = (await rows(api_conn, caller.session_id, "model_tool_results", "model_content"))[-1][0]
    assert json.loads(results[0]["content"]) == (
        {"outcome": "delivered_handoff", "prose_shown": False} if drafted_handoff else
        {"outcome": "delivered", "message_id": verdict.message_id, "prose_shown": False})
    item = next(item for item in await transcript(api_conn, caller.ids, "owner")
                if item.kind == "delivered" and item.event.message_id == verdict.message_id)
    assert item.event.handoff is drafted_handoff and [b.template for b in item.event.blocks] == templates


async def test_a_recovered_call_back_offer_reaches_claude_before_the_visitors_yes(api_conn, engine, locks, caller,
                                                                                  fake):
    # A turn stopped after its final reply was delivered and before the results row, the reply blocked for its prose
    # with no card to keep, so the kernel's call-back offer showed in its place. Recovery answers the call from that
    # delivery with the offer's words (`shown_instead`), so the visitor's "Yes" reaches Claude with its question.
    await said(api_conn, caller, "Hello")
    assert await pending(caller, ScriptedModel([response(reply("Hello, how can I help?"))]), engine, locks) == "done"
    await said(api_conn, caller, "OK, what's the next step?")
    await prepare_model_input(api_conn, caller.session_id)
    block = reply("It's $89 to come out.", id="toolu_crashed")
    await append_assistant(api_conn, caller.ids, [block], generation=0)
    await api_conn.commit()
    verdict = await caller.kernel.call("POST /check_reply", CheckReplyRequest(draft=ReplyDraft(
        session_id=caller.session_id, generation=0, prose=block["input"]["prose"]), final=True))
    offer = prompts.STATUS_LINES["offer_callback"]["en"]
    assert not verdict.ok and verdict.blocks == [RenderedBlock(kind="prose", text=offer)]
    await deliver(api_conn, caller.ids, Reply(verdict, "claude", "model", call_id=block["id"]),
                  ro_schema=caller.ro_schema)
    await api_conn.commit()
    assert await pending(caller, ScriptedModel(), engine, locks) == "idle"
    results = (await rows(api_conn, caller.session_id, "model_tool_results", "model_content"))[-1][0]
    assert json.loads(results[0]["content"]) == {"outcome": "delivered", "message_id": verdict.message_id,
                                                 "prose_shown": False, "shown_instead": offer}
    await said(api_conn, caller, "Yes")
    later = ScriptedModel([response(reply("What's the best number to reach you?"))])
    assert await pending(caller, later, engine, locks) == "done"
    texts = json.dumps(later.requests[-1].messages)
    assert offer in texts and "Yes" in texts


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
    await append_assistant(api_conn, caller.ids, [shown, bad, lost], generation=0)
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
    await append_assistant(api_conn, caller.ids, [reply("We do.", id="toolu_gone")], generation=0)
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


async def test_a_run_ended_on_its_reply_leaves_work_woken_meanwhile(api_conn, engine, locks, caller, visitor, fake):
    # an agent's request runs one turn: its reply spends the request's nonce, so work that wakes the session during
    # the turn (an owner's answer, a whisper, the agent's next message) waits for the next request
    woken = []

    async def meanwhile(request: httpx.Request) -> None:      # a message lands as the reply is checked
        if not woken:
            await said(api_conn, caller, "Is Saturday possible?")
            woken.append(True)

    await said(api_conn, caller, "When could you come?")
    model = ScriptedModel([response(reply("Here are the open times."))])
    async with KernelHttp("http://fake-kernel", transport=Kernel(fake, before={"/check_reply": meanwhile})) as http:
        assert await pending(replace(caller, kernel=http.session(visitor.token)), model, engine, locks,
                             blocking=True, end_on_reply=True) == "done"
    assert woken and len(model.requests) == 1 and await has_pending(api_conn, caller.session_id)

    # the next request's turn reads it
    model.add(response(reply("Saturday mornings work.")))
    assert await pending(caller, model, engine, locks, blocking=True, end_on_reply=True) == "done"
    assert len(model.requests) == 2 and not await has_pending(api_conn, caller.session_id)
    assert visitor_texts(model.requests[1])[-1] == "<visitor_message>Is Saturday possible?</visitor_message>"
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
                                                                                    fake, monkeypatch, caplog):
    await said(api_conn, caller, "Hello!")
    assert await pending(caller, ScriptedModel([response(reply("Hi, how can I help?"))]), engine, locks) == "done"
    shown = len(await events(api_conn, caller.session_id))

    # an interrupted turn's call can't be recovered just now: the visitor sees the static error, the call stays open,
    # and Claude isn't asked anything
    await said(api_conn, caller, "Quote me a drain clearing.")
    await prepare_model_input(api_conn, caller.session_id)
    await append_assistant(api_conn, caller.ids, [tool_use("native__quote", DRAIN, id="toolu_quote")], generation=0)
    await api_conn.commit()
    recover, broken = loop.recover_call, RuntimeError("recovery broke")

    async def failing(*args, **kwargs):
        raise broken

    monkeypatch.setattr(loop, "recover_call", failing)
    assert await pending(caller, ScriptedModel(), engine, locks) == "internal"
    # the log says where it broke, for tracing, and never what the error said, which can carry bound parameters
    (logged,) = [record.getMessage() for record in caplog.records if record.name == "desk.api.loop"]
    assert f"RuntimeError at {__file__}:{failing.__code__.co_firstlineno + 1}" in logged
    assert "recovery broke" not in logged
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
    # past today's model budget a turn hands off with no model call: the run shows the handoff once and stops,
    # rather than handing off again and again, and the message waits for the model's next call without waking
    # turns; a message that arrives meanwhile gets its own
    await api_conn.execute(text(
        "INSERT INTO app.model_calls (copy_id, route, model, input_tokens, cached_tokens, cache_write_tokens,"
        " output_tokens, latency_ms, stop_reason, created_at) VALUES ('copy-earlier', 'conversation',"
        " 'claude-opus-5-5', 0, 0, 0, 8000000, 900, 'end_turn', :at)"), {"at": clock()})
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
    assert await rows(api_conn, caller.session_id, "visitor_text", "model_seq", "wake") == [(None, False)] * 2


async def test_past_the_budget_reopening_the_stream_hands_off_once(api_conn, engine, locks, caller, fake, clock):
    """Past today's model budget a message gets the handoff with no model call and then stops waking turns, as in a
    paused session, so a visitor who reopens the stream or reloads the page (each starts the session's work) sees
    no further handoff. A message they send after it gets its own."""
    await api_conn.execute(text(
        "INSERT INTO app.model_calls (copy_id, route, model, input_tokens, cached_tokens, cache_write_tokens,"
        " output_tokens, latency_ms, stop_reason, created_at) VALUES ('copy-earlier', 'conversation',"
        " 'claude-opus-5-5', 0, 0, 0, 8000000, 900, 'end_turn', :at)"), {"at": clock()})
    await said(api_conn, caller, "Hello!")
    model = ScriptedModel()
    runner = TurnRunner(model, engine=engine, lock_engine=locks, production=True, clock=clock)

    async def stream_opens() -> list[list[str]]:
        runner.start(caller)
        await asyncio.wait_for(runner.drain(), 5)
        return [[block.template for block in event.blocks] for event in await events(api_conn, caller.session_id)
                if event.type == "message"]

    assert [await stream_opens() for _ in range(2)] == [[["handoff"]], [["handoff"]]]
    assert model.requests == []
    assert await rows(api_conn, caller.session_id, "visitor_text", "model_seq", "wake") == [(None, False)]
    await said(api_conn, caller, "Is anyone there?")
    assert await stream_opens() == [["handoff"], ["handoff"]]


# The turn's language (GitHub issue #121) --------------------------------------------------------------------------


def turn_path(caller: Caller) -> str:
    return f"/sessions/{caller.session_id}/turn"


def context_path(caller: Caller) -> str:
    return f"/context/{caller.session_id}"


@pytest.mark.parametrize(("status", "code", "ended", "shown"), [
    (409, "closed", "session_ended", [("writing", None), ("error", "session"), ("turn_end", None)]),
    (409, "stale_generation", "fenced", [("writing", None), ("turn_end", None)]),
    (422, "invalid", "kernel_unavailable", [("writing", None), ("error", "kernel_unavailable"), ("turn_end", None)]),
    (500, "internal", "kernel_unavailable", [("writing", None), ("error", "kernel_unavailable"), ("turn_end", None)]),
], ids=["closed", "stale_generation", "invalid", "unavailable"])
async def test_the_turn_routes_refusals_end_the_turn_as_contexts_do(api_conn, engine, kernel_http, fake, ro_schema,
                                                                    status, code, ended, shown):
    """`POST /sessions/{session_id}/turn` runs right after the session and mode checks, and again before a model call
    that places a newer message (here one the visitor sent during `/context`). The same answer from either call or
    from `/context` ends the turn the same way: a closed session with the session error, a stale generation silently,
    anything else as the kernel being unavailable. Claude is never called, no tool runs, and every message still waits
    for a turn. The first call comes before Claude starts writing, so its refusal shows no `writing`."""
    seen = {}
    for refused in ("start", "newer", "context"):
        visitor = await new_visitor(kernel_http, fake)
        kernel = Kernel(fake)
        async with KernelHttp("http://fake-kernel", transport=kernel) as http:
            caller = Caller(copy_id=visitor.ids.copy_id, desk_id=visitor.ids.desk_id,
                            session_id=visitor.ids.session_id, kind="visitor", kernel=http.session(visitor.token),
                            ro_schema=ro_schema)
            turns = []

            async def sent_again(request: httpx.Request) -> None:   # this answer is for the newer message's call
                turns.append(request)
                if len(turns) == 2:
                    kernel.refuse[turn_path(caller)] = (status, code)

            async def meanwhile(request: httpx.Request) -> None:     # the visitor writes again during /context
                async with engine.connect() as conn:
                    await said(conn, caller, "Can someone come on Saturday instead?")

            if refused == "start":
                kernel.refuse[turn_path(caller)] = (status, code)
            elif refused == "context":
                kernel.refuse[context_path(caller)] = (status, code)
            else:
                kernel.before.update({turn_path(caller): sent_again, context_path(caller): meanwhile})
            await said(api_conn, caller, "Hola, ¿tienen citas mañana?")
            model = ScriptedModel()
            outcome = await loop.run_turn(api_conn, caller, model)
        events_shown = [(event.type, getattr(event, "code", None)) for event in await events(api_conn,
                                                                                             caller.session_id)]
        seen[refused] = (outcome, events_shown, model.requests)
        assert kernel.answered("/decide") == [], refused
        assert {seq for (seq,) in await rows(api_conn, caller.session_id, "visitor_text", "model_seq")} == {None}
        if refused == "start":
            assert kernel.answered(context_path(caller)) == []
        if refused == "newer":
            assert len(kernel.answered(turn_path(caller))) == 2
    assert seen["context"] == seen["newer"] == (ended, shown, [])
    assert seen["start"] == (ended, [event for event in shown if event != ("writing", None)], [])


@pytest.mark.parametrize(("status", "code", "outcome"), [(500, "internal", "kernel_unavailable"),
                                                       (409, "stale_generation", "fenced")],
                         ids=["unavailable", "stale_generation"])
async def test_a_message_landing_as_a_call_places_its_rows_waits_when_its_turn_is_refused(
        api_conn, engine, caller, visitor, fake, monkeypatch, status, code, outcome):
    """A message that lands while a model call places the waiting rows (after the loop looked for a newer one) isn't
    placed by that call: it waits for the next call, which sends it to `/turn` first. When that `/turn` is refused, the
    message is still unplaced and waiting, so it wakes a retry, as a refused `/context` leaves it; Claude never read
    it."""
    words = "Hola, ¿pueden venir mañana?"
    await said(api_conn, caller, "Hi, do you clear drains?")
    placing = loop.prepare_model_input
    newer = []

    async def admit_newer(conn, session_id, **bounds):     # the visitor writes again as the first call places rows
        if not newer:
            async with engine.connect() as incoming:
                newer.append(await append_message(incoming, caller.ids, "visitor_text", text=words))
                await incoming.commit()
        return await placing(conn, session_id, **bounds)

    monkeypatch.setattr(loop, "prepare_model_input", admit_newer)
    kernel = Kernel(fake)
    turns = []

    async def refuse_newer(request: httpx.Request) -> None:
        turns.append(request)
        if len(turns) == 2:                                   # the newer message's `/turn`
            kernel.refuse[request.url.path] = (status, code)

    kernel.before[turn_path(caller)] = refuse_newer
    model = ScriptedModel([response(tool_use("native__find_slots", {"days": 3}, id="toolu_slots"))])
    async with KernelHttp("http://fake-kernel", transport=kernel) as http:
        result = await loop.run_turn(api_conn, replace(caller, kernel=http.session(visitor.token)), model)

    found = dict(await rows(api_conn, caller.session_id, "visitor_text", "n", "model_seq"))
    assert found[newer[0]] is None, f"the refused /turn's message was placed: {found}"
    assert await has_pending(api_conn, caller.session_id)
    assert (result, len(turns), len(model.requests)) == (outcome, 2, 1)
    assert words not in json.dumps(model.requests[0].messages, ensure_ascii=False)


async def events_lock_waiters(engine: AsyncEngine, session_id: str) -> int:
    """How many connections wait for the session's events lock (`store.lock_events`)."""
    key = lock_key("events:" + session_id)
    async with engine.connect() as conn:
        return (await conn.execute(text(
            "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND classid::bigint = :high"
            " AND objid::bigint = :low AND objsubid = 1"),
            {"high": (key >> 32) & 0xFFFFFFFF, "low": key & 0xFFFFFFFF})).scalar_one()


async def test_a_message_still_committing_as_the_next_call_looks_goes_to_the_kernel_first(
        api_conn, engine, caller, visitor, fake, monkeypatch):
    """A visitor's message takes its `n` as it is inserted, under the session's events lock, and commits a moment
    later; the loop writes its own rows (here its tool results) without that lock, so they can take a higher `n` and
    commit first. The next model call's cutoff waits for the events lock (`store.newest_row`), so the message is
    committed, seen by the look and sent to `/turn` before the call places it: Claude never reads a message whose
    language the kernel didn't hear first."""
    words = "Hola, ¿pueden venir mañana por la mañana?"
    opened, look_done = asyncio.Event(), asyncio.Event()
    late: list[int] = []

    async def visitor_writes() -> None:                       # the public route's append, still open
        async with engine.connect() as conn:
            late.append(await append_message(conn, caller.ids, "visitor_text", text=words))
            opened.set()
            while not look_done.is_set() and not await events_lock_waiters(engine, caller.session_id):
                await asyncio.sleep(0.01)
            await conn.commit()

    writing: list[asyncio.Task] = []
    answering, looking = loop.append_tool_results, loop.latest_said

    async def answer_while_open(conn, ids, assistant_n, results):   # the loop's tool results, as the message is open
        if not writing:
            writing.append(asyncio.create_task(visitor_writes()))
            await opened.wait()
        return await answering(conn, ids, assistant_n, results)

    async def look(conn, session_id, **bounds):
        found = await looking(conn, session_id, **bounds)
        if opened.is_set() and not look_done.is_set():      # the look before the next call: then the message commits
            look_done.set()
            await writing[0]
        return found

    monkeypatch.setattr(loop, "append_tool_results", answer_while_open)
    monkeypatch.setattr(loop, "latest_said", look)
    await said(api_conn, caller, "Hi, can someone come on Friday?")
    model = ScriptedModel([response(tool_use("native__find_slots", {"days": 3}, id="toolu_slots")),
                           response(reply("Tengo horarios mañana por la mañana."))])
    calls_before_turn = []

    async def turn_starts(request: httpx.Request) -> None:
        calls_before_turn.append(len(model.requests))

    kernel = Kernel(fake, before={turn_path(caller): turn_starts})
    async with KernelHttp("http://fake-kernel", transport=kernel) as http:
        assert await loop.run_turn(api_conn, replace(caller, kernel=http.session(visitor.token)), model) == "done"

    assert [call.body["text"] for call in fake.called("POST /sessions/{session_id}/turn")] == [
        "Hi, can someone come on Friday?", words]
    assert calls_before_turn == [0, 1]                         # before the second call, which reads it
    assert words in json.dumps(model.requests[1].messages, ensure_ascii=False)
    tool_results_n = max(n for (n,) in await rows(api_conn, caller.session_id, "model_tool_results", "n"))
    assert late[0] < tool_results_n                            # the race: the message's `n` is below the loop's row


async def test_a_take_over_or_a_close_just_before_the_turn_starts_ends_it(api_conn, kernel_http, fake, ro_schema):
    """The session moved on between `/whoami` and the turn's first call: a take-over (a new generation) makes the
    kernel refuse the turn as stale, and the turn ends silently; a closed conversation ends with the session error.
    Either way nothing reaches Claude, and `/context` isn't read."""
    for change, ended, shown in (("take_over", "fenced", ["turn_end"]),
                                 ("close", "session_ended", ["error", "turn_end"])):
        visitor = await new_visitor(kernel_http, fake)
        session_id = visitor.ids.session_id

        async def moved_on(request: httpx.Request) -> None:
            if change == "take_over":
                fake.set_mode(session_id, "owner")
            else:
                fake.sessions[session_id].closed_at = fake.now

        kernel = Kernel(fake, before={f"/sessions/{session_id}/turn": moved_on})
        async with KernelHttp("http://fake-kernel", transport=kernel) as http:
            caller = Caller(copy_id=visitor.ids.copy_id, desk_id=visitor.ids.desk_id, session_id=session_id,
                            kind="visitor", kernel=http.session(visitor.token), ro_schema=ro_schema)
            await said(api_conn, caller, "Can someone come tomorrow?")
            model = ScriptedModel()
            assert await loop.run_turn(api_conn, caller, model) == ended, change
        assert kernel.answered(turn_path(caller)) == [(409, "stale_generation" if change == "take_over" else "closed")]
        assert kernel.answered(context_path(caller)) == [] and model.requests == [], change
        assert [event.type for event in await events(api_conn, session_id)] == shown, change


async def test_a_take_over_after_the_turn_read_the_session_shows_no_writing_after_it(api_conn, engine, caller,
                                                                                     visitor, fake):
    """The turn reads the session's mode, then shows `writing`. A take-over landing in between (here as the kernel
    answers the turn's `/turn`) shows `owner_joined` first, and a `writing` after it would read as Claude having the
    chat again, hiding the owner's line. So the turn shows `writing` only while the session is still at the
    generation it read, checked under the run lock a take-over holds around its mode change and its event."""
    async def take_over(request: httpx.Request) -> None:      # as the owner's take-over route does it
        async with engine.connect() as conn:
            await run_lock(conn, caller.session_id)
            fake.set_mode(caller.session_id, "owner")
            await emit(conn, caller.ids, EvOwnerJoined(type="owner_joined", name="Mike Turner"))
            await conn.commit()

    await said(api_conn, caller, "Can someone come tomorrow?")
    model = ScriptedModel([response(reply("Yes, we can come tomorrow."))])
    kernel = Kernel(fake, after={turn_path(caller): take_over})
    async with KernelHttp("http://fake-kernel", transport=kernel) as http:
        outcome = await loop.run_turn(api_conn, replace(caller, kernel=http.session(visitor.token)), model)

    assert outcome == "fenced"                                 # Claude's reply, at the old generation, is fenced too
    assert [event.type for event in await events(api_conn, caller.session_id)] == ["owner_joined", "turn_end"]
