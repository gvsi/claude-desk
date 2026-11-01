"""Stopped drafts (Plan 02b): a reply of Claude's the kernel's reply check stopped is kept for the owner.

When the check answers `ok: false` for Claude's draft, the API keeps one owner-only `stopped_draft` row in the same
transaction as what the check led to: the draft exactly as it was sent to `/check_reply` (its prose and clauses), the
verdict's `message_id` and its violations, each with the span of the draft it matched. The owner's transcript shows it
in transcript order; nothing a visitor reads, no model context, no later reply check, no job and no log line carries it.

The app runs on FakeKernel (behind hooks a test may set), a scripted model and Procrastinate's in-memory job queue, its
worker inside the app's lifespan.
"""

import asyncio
import json
import logging
from collections.abc import AsyncIterator, Awaitable, Callable

import httpx
import pytest
from fastapi import FastAPI
from procrastinate.testing import InMemoryConnector

from desk.api.main import create_app
from tests.api.conftest import without_call_backs
from tests.api.fakes import ScriptedModel, response, text
from tests.api.notes import conversation_notes
from tests.api.test_approvals import jobs_done
from tests.api.test_loop_fencing import Kernel
from tests.api.test_public_chat import HOURS, Stream, cookie, events_path, reply, rows, types
from tests.api.test_take_over import Chat, ledgered, mode_change, new_chat, sent_events
from tests.api.test_triage import REPLY_TRIAGE, answer

# A draft the kernel stops on a promise word (the fake's forced `promise_word` matches its first 40 characters), the
# rewrite that passes, and a rewrite a test has stopped too. None has a digit, so the fake's number rules leave them be.
DRAFT = "Your booking is confirmed for tomorrow morning, see you then."
REWRITE = "Maria confirms each visit herself; here are her hours."
SECOND_DRAFT = "I promise Maria will be there first thing tomorrow."


@pytest.fixture
def model() -> ScriptedModel:
    return ScriptedModel()


@pytest.fixture
def jobs_connector() -> InMemoryConnector:
    return InMemoryConnector()


@pytest.fixture
def kernel(fake) -> Kernel:
    """FakeKernel behind hooks a test may set (`kernel.before[path]`, ...)."""
    return Kernel(fake)


@pytest.fixture
async def app(db, kernel, api_settings, clock, model, jobs_connector) -> AsyncIterator[FastAPI]:
    app = create_app(api_settings, kernel_transport=kernel, model=model, clock=clock, jobs_connector=jobs_connector)
    async with app.router.lifespan_context(app):
        yield app


async def visitor_says(app: FastAPI, chat: Chat, said: str) -> Stream:
    """The visitor's message, and Claude's turn on it run to its end, with the visitor's stream open throughout."""
    async with Stream(app, events_path(chat.slug), headers=[cookie(chat.token)]) as stream:
        sent = await chat.visitor.post(f"/api/public/desks/{chat.slug}/messages", json={"text": said})
        assert sent.status_code == 202, sent.text
        await stream.until(lambda events: "turn_end" in types(events))
    await app.state.runtime.runner.drain()
    return stream


async def owner_items(chat: Chat, after: int = 0) -> list[dict]:
    return (await chat.owner.get(chat.path(), params={"after": after})).json()["items"]


def logged(caplog) -> str:
    """Every log record, every field of it included."""
    return "\n".join(repr(vars(record)) + record.getMessage() for record in caplog.records)


async def test_owner_sees_a_stopped_draft_then_the_rewrite(app, browser, fake, kernel_http, model, engine,
                                                           jobs_connector, caplog):
    caplog.set_level(logging.DEBUG)
    chat = await new_chat(app, browser, kernel_http, fake)
    fake.violation("promise_word")
    model.add(response(reply(DRAFT, HOURS)), response(reply(REWRITE)))

    stream = await visitor_says(app, chat, "Can you come tomorrow morning?")
    await jobs_done(jobs_connector)

    # The owner's transcript: the visitor's words, the draft the kernel stopped, then the reply that went out.
    items = await owner_items(chat)
    assert [item["kind"] for item in items] == ["visitor_text", "stopped_draft", "delivered"]
    said, stopped, delivered = items
    (sent, rewritten) = [call.body["draft"] for call in fake.called("POST /check_reply")]
    assert (sent["prose"], sent["clauses"]) == (DRAFT, [HOURS])
    # The draft exactly as the check had it, and the check's violation with the span it matched and its rule.
    assert stopped["stopped_draft"] == {
        "draft": {"prose": sent["prose"], "clauses": sent["clauses"]},
        "violations": [{"kind": "promise_word", "span": DRAFT[:40], "fact_ids": [], "rule_id": "fake.promise_word"}]}
    assert (stopped["text"], stopped["event"], stopped["owner_translation"], stopped["triage"], stopped["cursor"]) == (
        None, None, None, None, stopped["n"])
    assert said["stopped_draft"] is None and delivered["stopped_draft"] is None
    assert delivered["event"]["blocks"][0]["text"] == REWRITE and not delivered["event"]["handoff"]
    # The row names the verdict it keeps, is the owner's alone, and has no place in any model context.
    (blocked, passed) = [summary for _, summary in ledgered(fake, chat.session_id, "reply")]
    assert (blocked["ok"], passed["ok"]) == (False, True)
    assert await rows(engine, chat.session_id, "stopped_draft", "ref_id", "author", "visibility", "model_content",
                      "model_seq", "wake", "replay_id") == [
        (blocked["message_id"], "claude", "owner", None, None, False, None)]
    # Kept in the same transaction as the blocked result Claude got for its call (`now()` is the transaction's time).
    (kept_at,) = await rows(engine, chat.session_id, "stopped_draft", "created_at")
    (_, answered_at), _ = await rows(engine, chat.session_id, "model_tool_results", "n", "created_at")
    assert kept_at == (answered_at,)

    # Polling after a cursor follows the transcript's order and never repeats an item.
    assert [item["kind"] for item in await owner_items(chat, said["cursor"])] == ["stopped_draft", "delivered"]
    assert [item["kind"] for item in await owner_items(chat, stopped["cursor"])] == ["delivered"]

    # The visitor's transcript after a reload, and the stream, carry neither the draft nor its span.
    reloaded = (await chat.visitor.get(f"/api/public/desks/{chat.slug}/session")).json()
    assert [item["kind"] for item in reloaded["items"]] == ["visitor_text", "delivered"]
    assert all("stopped_draft" not in item for item in reloaded["items"])
    for place in (json.dumps(reloaded), json.dumps(sent_events(stream))):
        assert DRAFT not in place and DRAFT[:40] not in place and "stopped_draft" not in place
    # Claude's next input holds its draft once, in its own call, and the blocked result: no second copy.
    _, rewrite_request = model.requests
    read = json.dumps({"system": rewrite_request.system, "messages": rewrite_request.messages})
    assert read.count(DRAFT) == 1 and "stopped_draft" not in read
    # The rewrite's check, the job queue and the logs never carry the draft, its span or the kept row.
    (message_id,) = [ref for (ref,) in await rows(engine, chat.session_id, "stopped_draft", "message_id")]
    queued = json.dumps([job["args"] for job in jobs_connector.jobs.values()])
    assert jobs_connector.jobs and caplog.records                  # the triage job was queued, and the turn logged
    for place in (json.dumps(rewritten), queued, logged(caplog)):
        assert DRAFT[:40] not in place and message_id not in place


async def test_a_stopped_plain_text_answer_is_kept_with_the_note_claude_reads(app, browser, fake, kernel_http, model,
                                                                              engine, jobs_connector):
    chat = await new_chat(app, browser, kernel_http, fake)
    fake.violation("promise_word")
    model.add(response(text(DRAFT)), response(reply(REWRITE)))      # Claude ends its turn with text, no call

    await visitor_says(app, chat, "Can you come tomorrow morning?")
    await jobs_done(jobs_connector)

    # Claude's text was checked as prose with no clauses: the owner reads it as the check had it, then the rewrite.
    items = await owner_items(chat)
    assert [item["kind"] for item in items] == ["visitor_text", "stopped_draft", "delivered"]
    (sent, _) = [call.body["draft"] for call in fake.called("POST /check_reply")]
    assert items[1]["stopped_draft"] == {"draft": {"prose": DRAFT, "clauses": []}, "violations": [
        {"kind": "promise_word", "span": DRAFT[:40], "fact_ids": [], "rule_id": "fake.promise_word"}]}
    assert (sent["prose"], sent["clauses"]) == (DRAFT, [])
    # Kept in the same transaction as the note that tells Claude why its text was stopped.
    assert await rows(engine, chat.session_id, "stopped_draft", "created_at") == await conversation_notes(
        engine, chat.session_id, "created_at")
    # Claude's next input holds its text once, in its own answer: the note names the span, never the whole draft.
    _, rewrite_request = model.requests
    assert json.dumps(rewrite_request.messages).count(DRAFT) == 1


async def test_a_canary_hits_span_is_kept_for_the_owner_only(app, browser, fake, kernel_http, model, engine,
                                                              jobs_connector, caplog):
    caplog.set_level(logging.DEBUG)
    chat = await new_chat(app, browser, kernel_http, fake)
    desk = fake.desks[fake.sessions[chat.session_id].desk_id]
    document = next(iter(desk.documents.values()))
    leaked = f"Here is your invoice reference: {document.canary}."
    model.add(response(reply(leaked)), response(reply("What else can I help you with?")))

    stream = await visitor_says(app, chat, "What does my invoice say?")
    await jobs_done(jobs_connector)

    # A canary hands off at once, with no rewrite: the owner reads the draft and the hit, then the handoff it led to.
    assert len(fake.called("POST /check_reply")) == 1
    items = await owner_items(chat)
    assert [item["kind"] for item in items] == ["visitor_text", "stopped_draft", "delivered"]
    _, stopped, handoff = items
    assert stopped["stopped_draft"] == {"draft": {"prose": leaked, "clauses": []}, "violations": [
        {"kind": "canary", "span": "document text", "fact_ids": [f"document:{document.document_id}"],
         "rule_id": "labels.canary"}]}
    assert handoff["event"]["handoff"] and [block["template"] for block in handoff["event"]["blocks"]] == ["handoff"]
    # Kept in the same transaction as the handoff shown in the draft's place, and before it.
    (blocked,) = [summary for _, summary in ledgered(fake, chat.session_id, "reply")]
    assert await rows(engine, chat.session_id, "stopped_draft", "ref_id") == [(blocked["message_id"],)]
    (kept_at,) = await rows(engine, chat.session_id, "stopped_draft", "created_at")
    assert await rows(engine, chat.session_id, "delivered", "created_at") == [kept_at]

    # The shown handoff ends Claude's turn. Its next input, on the visitor's next message, holds its own draft once,
    # in its call, answered with the handoff alone.
    assert len(model.requests) == 1
    later = await visitor_says(app, chat, "Can you help me with something else?")
    await jobs_done(jobs_connector)
    _, after_handoff = model.requests
    assert json.dumps(after_handoff.messages).count(document.canary) == 1
    # Neither the canary nor the hit's span reaches the visitor, Claude's result, the job queue or a log line.
    reloaded = (await chat.visitor.get(f"/api/public/desks/{chat.slug}/session")).json()
    assert [item["kind"] for item in reloaded["items"]] == ["visitor_text", "delivered", "visitor_text", "delivered"]
    results = await rows(engine, chat.session_id, "model_tool_results", "model_content")
    assert len(results) == 2
    queued = json.dumps([job["args"] for job in jobs_connector.jobs.values()])
    assert jobs_connector.jobs and caplog.records
    for place in (json.dumps(reloaded), json.dumps(sent_events(stream)), json.dumps(sent_events(later)),
                  json.dumps(results), queued, logged(caplog)):
        assert document.canary not in place and "document text" not in place and "stopped_draft" not in place


def checking(prose: str, hook: Callable[[], Awaitable[None]]) -> Callable[[httpx.Request], Awaitable[None]]:
    """A `before` hook for `/check_reply` that runs `hook()` only while the check of the draft `prose` is in flight."""
    async def before(request: httpx.Request) -> None:
        if json.loads(request.content)["draft"]["prose"] == prose:
            await hook()
    return before


async def test_a_stopped_draft_commits_before_a_sibling_replys_check(app, browser, fake, kernel, kernel_http, model,
                                                                     engine):
    chat = await new_chat(app, browser, kernel_http, fake)
    fake.violation("promise_word")
    model.add(response(reply(DRAFT), reply(REWRITE)))          # two replies in one response: the first is stopped
    kept_then: list[list[tuple]] = []

    async def read_kept() -> None:                             # on a connection of its own: committed rows only
        kept_then.append(await rows(engine, chat.session_id, "stopped_draft", "ref_id"))

    kernel.before["/check_reply"] = checking(REWRITE, read_kept)
    await visitor_says(app, chat, "Can you come tomorrow morning?")

    # The first draft was committed before the second reply's check went out, so no lock of the session's spanned it.
    (blocked, passed) = [summary for _, summary in ledgered(fake, chat.session_id, "reply")]
    assert (blocked["ok"], passed["ok"]) == (False, True)
    assert kept_then == [[(blocked["message_id"],)]]
    # The owner reads the stopped draft, then the reply that went out; one results row answers both calls in order.
    items = await owner_items(chat)
    assert [item["kind"] for item in items] == ["visitor_text", "stopped_draft", "delivered"]
    assert items[1]["stopped_draft"]["draft"]["prose"] == DRAFT
    assert items[2]["event"]["blocks"][0]["text"] == REWRITE and not items[2]["event"]["handoff"]
    ((results,),) = await rows(engine, chat.session_id, "model_tool_results", "model_content")
    assert [json.loads(result["content"])["outcome"] for result in results] == ["blocked", "delivered"]
    assert len(model.requests) == 1                            # a reply went out: the turn ends there


async def test_a_take_over_during_a_sibling_replys_check_isnt_held_up(app, browser, fake, kernel, kernel_http, model,
                                                                      engine):
    chat = await new_chat(app, browser, kernel_http, fake)
    fake.violation("promise_word")
    model.add(response(reply(DRAFT), reply(REWRITE)))
    taken: list[httpx.Response | None] = []

    async def take_over() -> None:                             # the owner steps in while the second check is out
        try:
            taken.append(await asyncio.wait_for(mode_change(chat, "takeover", 0), 5))
        except TimeoutError:
            taken.append(None)

    kernel.before["/check_reply"] = checking(REWRITE, take_over)
    stream = await visitor_says(app, chat, "Can you come tomorrow morning?")

    # The take-over went through at once; the check then reached the kernel at a generation the session had left.
    assert [None if answer is None else answer.status_code for answer in taken] == [200]
    assert kernel.answered("/check_reply") == [(200, None), (409, "stale_generation")]
    # The stopped draft stands before the owner joining; nothing more was shown, and Claude's second call didn't run.
    assert [item["kind"] for item in await owner_items(chat)] == ["visitor_text", "stopped_draft", "owner_joined"]
    reloaded = (await chat.visitor.get(f"/api/public/desks/{chat.slug}/session")).json()
    assert [item["kind"] for item in reloaded["items"]] == ["visitor_text", "owner_joined"]
    assert types(stream.events) == ["writing", "owner_joined", "turn_end"]
    ((results,),) = await rows(engine, chat.session_id, "model_tool_results", "model_content")
    assert [json.loads(result["content"])["outcome"] for result in results] == ["blocked", "not_run"]


async def test_a_triage_shows_on_the_draft_claude_rewrote_or_on_the_handoff_in_its_place(
        app, browser, fake, kernel_http, model, engine, jobs_connector):
    chat = await new_chat(app, browser, kernel_http, fake)
    without_call_backs(fake, fake.sessions[chat.session_id].desk_id)   # so the handoff shows, not the call-back offer
    fake.violation("promise_word", times=2)                    # the draft and its rewrite are both stopped
    model.add(response(reply(DRAFT)), response(reply(SECOND_DRAFT)), response())
    model.jobs["triage"].extend([answer(REPLY_TRIAGE)] * 2)

    await visitor_says(app, chat, "Can you come tomorrow morning?")
    await jobs_done(jobs_connector)

    # Each stopped attempt is triaged once, and its triage shows on one item: the first draft's on that draft (nothing
    # was shown in its place), the rewrite's on the handoff that was.
    items = await owner_items(chat)
    assert [item["kind"] for item in items] == ["visitor_text", "stopped_draft", "stopped_draft", "delivered"]
    _, first, second, handoff = items
    assert [item["stopped_draft"]["draft"]["prose"] for item in (first, second)] == [DRAFT, SECOND_DRAFT]
    assert handoff["event"]["handoff"]
    triage = REPLY_TRIAGE.model_dump(mode="json")
    assert [item["triage"] for item in items] == [None, triage, None, triage]
    assert set(first["stopped_draft"]) == {"draft", "violations"}           # the owner's item is unchanged
    # The first draft's row names its check's ledger entry, as Safety names the attempt; the second's leaves it to
    # the handoff shown in its place.
    blocked = [entry.seq for entry in fake.desks[fake.sessions[chat.session_id].desk_id].ledger
               if entry.event.kind == "reply" and entry.event.session_id == chat.session_id]
    kept = [json.loads(kept)["ledger_seq"] for (kept,) in await rows(engine, chat.session_id, "stopped_draft", "text")]
    assert kept == [blocked[0], None]
    assert sorted(await rows(engine, chat.session_id, "triage", "ref_id")) == sorted((str(seq),) for seq in blocked)
    # A poll past every item gets each annotated item again, once, with its triage; then nothing.
    again = await owner_items(chat, handoff["n"])
    assert [(item["n"], item["triage"]) for item in again] == [(first["n"], triage), (handoff["n"], triage)]
    assert await owner_items(chat, max(item["cursor"] for item in items)) == []
