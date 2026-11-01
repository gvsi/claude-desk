"""deliver(): checked replies and signed statuses become visitor events, fenced by generation under the run lock."""

import ast
import asyncio
from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest
from pydantic import TypeAdapter
from sqlalchemy import text

import desk.api
from desk.api.deliver import Reply, Status, deliver, run_lock
from desk.api.metrics import RevealMetric, TurnMetric, record_model_call, spent_today_cents
from desk.api.sse import append_metric
from desk.api.store import lock_key
from desk.contracts import Decision, ReplyDraft, ReplyVerdict, ToolCall
from desk.events import EvHeld, EvMessage, EvReceipt, EvResolved, SseEvent
from desk.kernel_api import (
    AnswerRequest,
    CancelRequest,
    CheckReplyRequest,
    CreateCopyRequest,
    DecideRequest,
    ExecuteRequest,
)
from tests.api.conftest import new_visitor, without_call_backs

EVENT = TypeAdapter(SseEvent)


async def check(visitor, prose: str, generation: int = 0) -> ReplyVerdict:
    draft = ReplyDraft(session_id=visitor.ids.session_id, generation=generation, prose=prose)
    return await visitor.kernel.call("POST /check_reply", CheckReplyRequest(draft=draft))


async def events(conn, session_id: str) -> list:
    rows = await conn.execute(text("SELECT seq, payload FROM app.run_events WHERE session_id = :s AND kind = 'sse'"
                                   " ORDER BY seq"), {"s": session_id})
    return [(seq, EVENT.validate_python(payload)) for seq, payload in rows]


async def message_rows(conn, session_id: str, kind: str) -> list[dict]:
    rows = await conn.execute(text("SELECT * FROM app.messages WHERE session_id = :s AND kind = :k ORDER BY n"),
                              {"s": session_id, "k": kind})
    return [dict(row._mapping) for row in rows]


def message_event(verdict: ReplyVerdict, author: str) -> EvMessage:
    return EvMessage(type="message", message_id=verdict.message_id, generation=verdict.generation, author=author,
                     language=verdict.language, handoff=any(block.template == "handoff" for block in verdict.blocks),
                     blocks=verdict.blocks,
                     visitor_plain=verdict.visitor_plain, ledger_seq=verdict.ledger_seq, signature=verdict.signature)


async def test_reply_becomes_a_message_event_and_row(api_conn, visitor, fake, ro_schema):
    ids = visitor.ids
    without_call_backs(fake, ids.desk_id)          # so the blocked draft shows the handoff card in its place
    passed = await check(visitor, "Hola, puedo ayudarle con eso.")
    blocked = await check(visitor, "It comes to $89 for the visit.")
    paid = await check(visitor, "Thanks, that went through.")
    assert passed.ok and passed.language == "es" and not blocked.ok

    assert await deliver(api_conn, ids, Reply(passed, "claude", "model", call_id="toolu_1"), ro_schema=ro_schema) == 1
    assert await deliver(api_conn, ids, Reply(blocked, "claude", "model", call_id="toolu_2"), ro_schema=ro_schema) == 2
    assert await deliver(api_conn, ids, Reply(paid, "desk", "kernel"), ro_schema=ro_schema) == 3
    # the same verdict twice is shown once
    assert await deliver(api_conn, ids, Reply(passed, "claude", "model", call_id="toolu_1"), ro_schema=ro_schema) is None
    # the author follows from who delivers: Claude (its send_reply, or a handoff), the owner (a say), the Desk
    authors = {"model": "claude", "api": "claude", "owner": "owner", "kernel": "desk"}
    for via, author in [(via, author) for via in authors for author in ("claude", "owner", "desk")
                        if authors[via] != author]:
        with pytest.raises(ValueError):
            Reply(passed, author, via, call_id="toolu_3" if via == "model" else None)

    assert await events(api_conn, ids.session_id) == [
        (1, message_event(passed, "claude")), (2, message_event(blocked, "claude")), (3, message_event(paid, "desk"))]
    (_, shown_blocked) = (await events(api_conn, ids.session_id))[1]
    assert shown_blocked.handoff and [block.template for block in shown_blocked.blocks] == ["handoff"]

    rows = await message_rows(api_conn, ids.session_id, "delivered")
    assert [(row["author"], row["call_id"], row["event_seq"], row["ref_id"], row["language"], row["visibility"])
            for row in rows] == [
        ("claude", "toolu_1", 1, passed.message_id, "es", "public"),
        ("claude", "toolu_2", 2, blocked.message_id, "en", "public"),
        ("desk", None, 3, paid.message_id, "en", "public")]
    assert rows[0]["blocks"] == [block.model_dump(mode="json") for block in passed.blocks]
    # Claude's replies reach the model through its send_reply calls; the Desk's as what the visitor was shown
    assert [row["model_content"] for row in rows[:2]] == [None, None]
    assert rows[2]["model_content"] == {
        "type": "text", "text": "<shown_to_visitor>Thanks, that went through.</shown_to_visitor>"}


async def waiting_for_lock(engine, name: str) -> None:
    """Returns once another transaction is queued on the advisory lock `name` (a bigint key: classid holds its
    high 32 bits, objid its low 32 bits)."""
    key = lock_key(name)
    while True:
        async with engine.connect() as conn:
            waiting = (await conn.execute(text(
                "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND NOT granted"
                " AND classid::bigint = :high AND objid::bigint = :low AND objsubid = 1"),
                {"high": (key >> 32) & 0xFFFFFFFF, "low": key & 0xFFFFFFFF})).scalar_one()
        if waiting:
            return
        await asyncio.sleep(0.01)


async def test_stale_reply_is_dropped_under_the_run_lock(engine, visitor, fake, ro_schema):
    ids = visitor.ids
    verdict = await check(visitor, "Happy to help with your drain.")
    assert verdict.generation == 0

    async def deliver_reply(reply: Reply) -> int | None:
        async with engine.begin() as conn:
            return await deliver(conn, ids, reply, ro_schema=ro_schema)

    # the owner takes over: holding the run lock around the mode change, as take-over does
    async with engine.connect() as take_over:
        await run_lock(take_over, ids.session_id)
        delivering = asyncio.create_task(deliver_reply(Reply(verdict, "claude", "model", call_id="toolu_1")))
        await asyncio.wait_for(waiting_for_lock(engine, "run:" + ids.session_id), 5)
        assert not delivering.done()                  # delivery waits for the lock
        fake.set_mode(ids.session_id, "owner")        # generation 1
        await take_over.commit()
    assert await delivering is None

    async with engine.connect() as conn:
        assert await events(conn, ids.session_id) == []
        assert await message_rows(conn, ids.session_id, "delivered") == []
    # handed back (generation 2): a reply checked now is shown
    fake.set_mode(ids.session_id, "ai")
    current = await check(visitor, "Happy to help with your drain.", generation=2)
    assert await deliver_reply(Reply(current, "claude", "model", call_id="toolu_2")) == 1


def quote(discount_bp: int = 0) -> dict:
    return {"items": [{"item_id": "drain", "qty": 1}], "requested_discount_bp": discount_bp}


async def decide(visitor, call_id: str, args: dict, generation: int = 0) -> Decision:
    call = ToolCall(call_id=call_id, tool="native.quote", args=args)
    return await visitor.kernel.call("POST /decide", DecideRequest(session_id=visitor.ids.session_id,
                                                                    generation=generation, call=call))


async def executed(visitor, decision: Decision) -> Decision:
    await visitor.kernel.call("POST /execute", ExecuteRequest(decision_id=decision.decision_id,
                                                               session_id=visitor.ids.session_id, generation=0))
    return await visitor.kernel.call("GET /decisions/{id}", path={"id": decision.decision_id})


async def cancelled(visitor, decision: Decision) -> Decision:
    return await visitor.kernel.call("POST /decisions/{decision_id}/cancel",
                                     CancelRequest(session_id=visitor.ids.session_id),
                                     path={"decision_id": decision.decision_id})


def signed(decision: Decision) -> dict:
    return {"decision_id": decision.decision_id, "state": decision.state, "visitor_plain": decision.visitor_plain,
            "ledger_seq": decision.ledger_seq, "signature": decision.signature}


@pytest.mark.parametrize("phase", ["receipt", "resolved"])
async def test_status_clears_owner_reason_before_delivery(kernel_http, fake, phase):
    copy = await kernel_http.public().call("POST /copies", CreateCopyRequest())
    visitor = await new_visitor(kernel_http, fake, copy)
    held = await decide(visitor, "owner-reason", quote(500))
    fake.never(visitor.ids.desk_id, "native.quote")
    answered = await kernel_http.owner(copy.owner_token).call(
        "POST /approvals/{decision_id}/answer", AnswerRequest(answer="allow_once"),
        path={"decision_id": held.decision_id})
    original = answered.decision.model_dump(mode="json")
    assert original["owner_plain"]

    status = Status(answered.decision, phase)

    assert status.decision.owner_plain is None
    assert signed(status.decision) == signed(answered.decision)
    assert answered.decision.model_dump(mode="json") == original


async def test_status_phases_map_to_events(api_conn, kernel_http, fake, visitor, ro_schema):
    ids = visitor.ids
    done = await executed(visitor, await decide(visitor, "toolu_a", quote()))
    held = await decide(visitor, "toolu_b", quote(500))
    held_again = await decide(visitor, "toolu_c", quote(1000))
    gone = await cancelled(visitor, held)
    assert (done.state, held.state, gone.state) == ("executed", "held", "cancelled")

    for decision, phase in ((done, "receipt"), (held, "held"), (gone, "resolved")):
        await deliver(api_conn, ids, Status(decision, phase), ro_schema=ro_schema)
    # statuses aren't fenced by generation: one still shows after a take-over
    fake.set_mode(ids.session_id, "owner")
    assert await deliver(api_conn, ids, Status(held_again, "held"), ro_schema=ro_schema) == 4

    assert await events(api_conn, ids.session_id) == [
        (1, EvReceipt(type="receipt", **signed(done))), (2, EvHeld(type="held", **signed(held))),
        (3, EvResolved(type="resolved", **signed(gone))), (4, EvHeld(type="held", **signed(held_again)))]
    rows = await message_rows(api_conn, ids.session_id, "status")
    assert [(row["ref_id"], row["event_seq"], row["text"], row["author"], row["visibility"], row["model_content"])
            for row in rows] == [(decision.decision_id, seq, None, "desk", "public", None)
                                 for seq, decision in enumerate((done, held, gone, held_again), start=1)]

    # a decision shows only in its own session, and only a held decision as held
    other = await new_visitor(kernel_http, fake)
    theirs = await decide(other, "toolu_x", quote(500))
    with pytest.raises(ValueError):
        await deliver(api_conn, ids, Status(theirs, "held"), ro_schema=ro_schema)
    with pytest.raises(ValueError):
        Status(done, "held")
    with pytest.raises(ValueError):
        Status(held, "receipt")
    assert len(await events(api_conn, ids.session_id)) == 4


async def test_status_delivery_is_idempotent(engine, visitor, ro_schema):
    ids = visitor.ids
    held = await decide(visitor, "toolu_b", quote(500))

    async def show(status: Status) -> int | None:
        async with engine.begin() as conn:
            return await deliver(conn, ids, status, ro_schema=ro_schema)

    # the same signed record, from two workers at once (a resume job and a visitor's request): shown once
    assert sorted(await asyncio.gather(show(Status(held, "held")), show(Status(held, "held"))),
                  key=lambda seq: seq or 0) == [None, 1]
    assert await show(Status(held, "held")) is None
    # its next state is a new ledger entry, shown once too
    gone = await cancelled(visitor, held)
    assert await show(Status(gone, "resolved")) == 2
    assert await show(Status(gone, "resolved")) is None
    async with engine.connect() as conn:
        assert [seq for seq, _ in await events(conn, ids.session_id)] == [1, 2]
        assert len(await message_rows(conn, ids.session_id, "status")) == 2


async def test_an_older_status_never_follows_a_later_one(engine, kernel_http, fake, ro_schema):
    """A status can reach deliver() after a later state of its decision was shown: a `/decide` answer held up while
    the owner answered the hold, or a receipt read before the kernel reconciled an `unknown` outcome. It is dropped,
    so the visitor never sees a decision go back."""
    copy = await kernel_http.public().call("POST /copies", CreateCopyRequest())
    visitor = await new_visitor(kernel_http, fake, copy)
    ids = visitor.ids

    async def show(status: Status) -> int | None:
        async with engine.begin() as conn:
            return await deliver(conn, ids, status, ro_schema=ro_schema)

    held = await decide(visitor, "toolu_held", quote(500))
    answered = await kernel_http.owner(copy.owner_token).call(
        "POST /approvals/{decision_id}/answer", AnswerRequest(answer="allow_once"),
        path={"decision_id": held.decision_id})
    assert answered.decision.state == "executed" and answered.decision.ledger_seq > held.ledger_seq
    assert await show(Status(answered.decision, "resolved")) == 1
    assert await show(Status(held, "held")) is None                    # the held-up `/decide` answer

    fake.script("native.quote", exec_state="unknown")
    unsure = await executed(visitor, await decide(visitor, "toolu_unsure", quote()))
    assert unsure.state == "unknown"
    assert await show(Status(fake.reconcile(unsure.decision_id), "receipt")) == 2
    assert await show(Status(unsure, "receipt")) is None                # the receipt read before it was reconciled

    async with engine.connect() as conn:
        assert [(event.type, event.state) for _, event in await events(conn, ids.session_id)] == [
            ("resolved", "executed"), ("receipt", "executed")]
        assert len(await message_rows(conn, ids.session_id, "status")) == 2


SIGNED_EVENTS = {"EvMessage", "EvReceipt", "EvHeld", "EvResolved"}


def annotation_nodes(tree: ast.AST) -> set[int]:
    """The ids of every node inside a type annotation, where naming an event type builds nothing."""
    roots = []
    for node in ast.walk(tree):
        if isinstance(node, ast.AnnAssign):
            roots.append(node.annotation)
        elif isinstance(node, ast.arg) and node.annotation is not None:
            roots.append(node.annotation)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.returns is not None:
            roots.append(node.returns)
    return {id(inner) for root in roots for inner in ast.walk(root)}


def signed_event_builders(source: str) -> set[str]:
    """What a module does that could build or publish a signed event: call a signed event type or one of its class
    methods, refer to the type any other way outside an annotation (an alias, a mapping of types), or call
    append_event."""
    tree = ast.parse(source)
    in_annotation = annotation_nodes(tree)
    calls = {id(node.func): node for node in ast.walk(tree) if isinstance(node, ast.Call)}
    found = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            function = node.func
            if (function.attr if isinstance(function, ast.Attribute) else getattr(function, "id", None)) == "append_event":
                found.add("append_event")
        name = node.id if isinstance(node, ast.Name) else node.attr if isinstance(node, ast.Attribute) else None
        if name not in SIGNED_EVENTS or id(node) in in_annotation:
            continue
        if id(node) in calls:
            found.add(name)
        else:
            parents = [parent for parent in ast.walk(tree) if isinstance(parent, ast.Attribute) and parent.value is node]
            method = next((parent.attr for parent in parents if id(parent) in calls), None)
            found.add(f"{name}.{method}" if method else f"{name} (reference)")
    return found


def test_only_deliver_builds_signed_events():
    # the scan sees each form
    assert signed_event_builders(
        "EvMessage(**x)\nevents.EvHeld(type='held')\nEvReceipt.model_validate(x)\nsse.append_event(c, i, e)\n"
        "EvResolved.model_construct()\nemit(c, i, e)") == {
        "EvMessage", "EvHeld", "EvReceipt.model_validate", "append_event", "EvResolved.model_construct"}
    assert signed_event_builders(
        "from desk.events import EvHeld\nKINDS = {'held': EvHeld}\nmake = events.EvReceipt\n"
        "def f(event: EvHeld | None) -> EvHeld: ...\nclass Item(BaseModel):\n    event: EvResolved | None") == {
        "EvHeld (reference)", "EvReceipt (reference)"}

    api = Path(desk.api.__file__).parent
    builders = {path.relative_to(api).as_posix(): signed_event_builders(path.read_text())
                for path in sorted(api.rglob("*.py"))}
    assert {"deliver.py", "sse.py", "store.py"} <= set(builders)
    assert builders.pop("deliver.py") == SIGNED_EVENTS | {"append_event"}
    assert builders.pop("sse.py") <= {"append_event"}          # emit() hands unsigned events on
    assert {path: found for path, found in builders.items() if found} == {}


FINISHED = datetime(2026, 10, 30, 17, 4, 5, 123456, tzinfo=UTC)


def model_response(model: str = "claude-opus-5-5", *, finished_at: datetime = FINISHED, stop_reason: str = "tool_use",
                   input_tokens: int = 1500, cached: int = 4500, written: int = 0, output_tokens: int = 350):
    """What the model client hands back (Task 4's ModelResponse): usage as the Anthropic SDK reports it."""
    usage = SimpleNamespace(input_tokens=input_tokens, cache_read_input_tokens=cached,
                            cache_creation_input_tokens=written, output_tokens=output_tokens)
    return SimpleNamespace(model=model, usage=usage, stop_reason=stop_reason, latency_ms=2400, finished_at=finished_at)


async def model_call_rows(conn) -> list[dict]:
    rows = await conn.execute(text("SELECT * FROM app.model_calls ORDER BY model_call_id"))
    return [dict(row._mapping) for row in rows]


async def test_model_call_rows_carry_the_finish_time(api_conn, ids):
    await record_model_call(api_conn, ids.copy_id, ids.session_id, "conversation", model_response(written=1200))
    # a failed call has no usage and no stop reason of its own: it is recorded as an error
    failed = SimpleNamespace(model="claude-opus-5-5", usage=None, stop_reason=None, latency_ms=6100,
                             finished_at=FINISHED + timedelta(seconds=9))
    await record_model_call(api_conn, ids.copy_id, None, "triage", failed)      # an owner route: no visitor session

    rows = await model_call_rows(api_conn)
    assert [{key: row[key] for key in ("copy_id", "session_id", "route", "model", "input_tokens", "cached_tokens",
                                       "cache_write_tokens", "output_tokens", "latency_ms", "stop_reason",
                                       "created_at")} for row in rows] == [
        {"copy_id": ids.copy_id, "session_id": ids.session_id, "route": "conversation", "model": "claude-opus-5-5",
         "input_tokens": 1500, "cached_tokens": 4500, "cache_write_tokens": 1200, "output_tokens": 350,
         "latency_ms": 2400, "stop_reason": "tool_use", "created_at": FINISHED},
        {"copy_id": ids.copy_id, "session_id": None, "route": "triage", "model": "claude-opus-5-5", "input_tokens": 0,
         "cached_tokens": 0, "cache_write_tokens": 0, "output_tokens": 0, "latency_ms": 6100, "stop_reason": "error",
         "created_at": FINISHED + timedelta(seconds=9)}]
    for wrong in ({"route": "chat"}, {"response": model_response(finished_at=FINISHED.replace(tzinfo=None))},
                  {"response": model_response(stop_reason=None)}, {"response": model_response(stop_reason="")}):
        call = {"route": "conversation", "response": model_response()} | wrong
        with pytest.raises(ValueError):
            await record_model_call(api_conn, ids.copy_id, ids.session_id, call["route"], call["response"])

    # reveal and turn timings are metric rows of the session
    reveal = RevealMetric(message_id="msg-1", model_finish_to_reveal_ms=640, check_reply_ms=12, attempts=1)
    turn = TurnMetric(turn_id="turn-1", model_calls=2, tool_calls=1, decide_ms=30, execute_ms=45, total_ms=5200,
                      outcome="done")
    await append_metric(api_conn, ids, reveal)
    await append_metric(api_conn, ids, turn)
    metrics = await api_conn.execute(text("SELECT type, payload FROM app.run_events WHERE kind = 'metric' ORDER BY id"))
    assert [tuple(row) for row in metrics] == [("reveal", reveal.model_dump()), ("turn", turn.model_dump())]


async def test_spend_today_uses_list_prices(api_conn, ids):
    today = datetime(2026, 10, 30, 23, 0, tzinfo=UTC)
    midnight = today.replace(hour=0)
    calls = [
        model_response(finished_at=midnight),                                  # $0.0139, the master's first call
        model_response(finished_at=today),                                     # $0.0139
        model_response("claude-haiku-5-5", finished_at=today, input_tokens=900, cached=0, output_tokens=40),  # $0.00011
        model_response("claude-sonnet-5-5", finished_at=today, input_tokens=0, cached=0, written=1000,
                       output_tokens=0),                                       # $0.0025
        model_response("claude-unlisted", finished_at=today, input_tokens=0, cached=0,
                       output_tokens=10_000),                                  # at the top rate: $0.20
        model_response(finished_at=midnight - timedelta(microseconds=1)),      # yesterday's
        model_response(finished_at=midnight + timedelta(days=1)),              # tomorrow's
    ]
    for response in calls:
        await record_model_call(api_conn, ids.copy_id, ids.session_id, "conversation", response)

    # 1.39 + 1.39 + 0.011 + 0.25 + 20 = 23.041 cents, rounded up
    assert await spent_today_cents(api_conn, lambda: today) == 24
    assert await spent_today_cents(api_conn, lambda: today.astimezone(timezone(timedelta(hours=-7)))) == 24
    assert await spent_today_cents(api_conn, lambda: today + timedelta(days=2)) == 0
