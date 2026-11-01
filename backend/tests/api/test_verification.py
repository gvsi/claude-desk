"""Demo-code verification and the visitor's Demo inbox (Plan 02b, Task 2; master plan, "Demo limit: the Demo inbox").

The visitor asks for a code (`verify/start`, or Claude's `native.start_verification`); the kernel sends it only to the
contact on record, as a Demo inbox entry, and the visitor's stream gets a code-free notice of it. The visitor reads
the entry through the kernel (`demo_inbox`) and types the code into the verify card (`verify/check`), so the code
never passes through Claude, the API's tables, the event stream or a log. Owner alerts never reach a visitor.

The app runs on FakeKernel and a scripted model.
"""

import contextlib
import json
import logging
import re
from collections.abc import AsyncIterator, Iterator

import httpx
import pytest
from fastapi import FastAPI
from procrastinate.testing import InMemoryConnector
from sqlalchemy import text

from desk.api import store
from desk.api.main import create_app
from desk.api.prompts import NOTES
from desk.api.sse import emit_inbox
from desk.contracts import InboxNotice
from tests.api.conftest import CLIENT_IP, PASSCODE
from tests.api.fakes import ScriptedModel, response, tool_use
from tests.api.notes import conversation_notes
from tests.api.test_public_chat import (
    DISCOUNTED_QUOTE,
    Stream,
    cookie,
    events_path,
    ids_of,
    new_slug,
    open_session,
    reply,
    types,
)
from tests.api.test_secrets_at_rest import at_rest
from tests.kernel_contract.fake_kernel import fake_kernel_app

DANA = "dana@example.com"               # on record in the Turner seed
SIX_DIGITS = re.compile(r"[0-9]{6}")


@pytest.fixture
def model() -> ScriptedModel:
    return ScriptedModel()


@pytest.fixture
async def app(db, fake, api_settings, clock, model) -> AsyncIterator[FastAPI]:
    app = create_app(api_settings, kernel_transport=httpx.ASGITransport(app=fake_kernel_app(fake)), model=model,
                     clock=clock, jobs_connector=InMemoryConnector())
    async with app.router.lifespan_context(app):
        yield app


def verify_path(slug: str, step: str) -> str:
    return f"/api/public/desks/{slug}/verify/{step}"


def code_sent(fake, entry_id: str) -> str:
    """The code in the Demo inbox entry `entry_id`, as the kernel wrote it."""
    (body,) = [entry.body for _, entry in fake.inbox if entry.entry_id == entry_id]
    (code,) = SIX_DIGITS.findall(body)
    return code


async def stored_events(engine, session_id: str, type: str) -> list[dict]:
    async with engine.connect() as conn:
        found = await conn.execute(text("SELECT payload FROM app.run_events WHERE session_id = :s AND kind = 'sse'"
                                        " AND type = :t ORDER BY seq"), {"s": session_id, "t": type})
        return [row[0] for row in found]


async def rows_of(engine, session_id: str, kind: str) -> list[tuple]:
    """The session's `kind` transcript rows as (text, whether it was sent to Claude)."""
    async with engine.connect() as conn:
        found = await conn.execute(text("SELECT text, model_seq IS NOT NULL FROM app.messages WHERE session_id = :s"
                                        " AND kind = :k ORDER BY n"), {"s": session_id, "k": kind})
        return [tuple(row) for row in found]


async def test_verify_start_streams_a_code_free_notice(app, browser, fake, kernel_http, engine):
    slug = await new_slug(kernel_http, fake)
    client, token, opened = await open_session(app, browser, slug)
    session_id = opened["state"]["session_id"]
    fake.calls.clear()

    async with Stream(app, events_path(slug), headers=[cookie(token)]) as stream:
        started = await client.post(verify_path(slug, "start"), json={"contact": DANA})
        events = await stream.until(lambda events: "demo_inbox" in types(events))

    assert started.status_code == 200
    (call,) = fake.called("POST /verify/start")                     # the visitor's own credential and session
    assert call.headers["x-session-token"] == token and "x-owner-session" not in call.headers
    assert call.body == {"session_id": session_id, "contact": DANA}
    (notice,) = started.json()["inbox"]
    assert started.json()["message"] and notice["to"] != "owner"
    (frame,) = [frame for frame in stream.frames if frame.event == "demo_inbox"]
    payload = json.loads(frame.data)
    assert list(payload) == ["type", "entry_id", "to", "preview"]
    assert payload == {"type": "demo_inbox", **notice}
    assert [event.type for _, event in events] == ["demo_inbox"]
    code = code_sent(fake, notice["entry_id"])
    assert not SIX_DIGITS.search(payload["to"] + payload["preview"])
    assert code not in stream.body and code not in started.text

    # A contact not on record gets the same message, and nothing is streamed.
    stranger = await client.post(verify_path(slug, "start"), json={"contact": "nobody@example.com"})
    assert stranger.status_code == 200
    assert stranger.json() == {"message": started.json()["message"], "inbox": []}
    assert await stored_events(engine, session_id, "demo_inbox") == [payload]


async def test_code_is_never_stored_or_streamed(app, browser, fake, kernel_http, model, engine, db, caplog):
    caplog.set_level(logging.DEBUG)
    slug = await new_slug(kernel_http, fake)
    client, token, opened = await open_session(app, browser, slug)
    session_id = opened["state"]["session_id"]
    model.add(response(reply("Thanks, you're confirmed.")))           # the turn the verification wakes

    async with Stream(app, events_path(slug), headers=[cookie(token)]) as stream:
        started = await client.post(verify_path(slug, "start"), json={"contact": DANA})
        (notice,) = started.json()["inbox"]
        inbox = await client.get(f"/api/public/desks/{slug}/demo_inbox")
        assert inbox.status_code == 200 and inbox.headers["cache-control"] == "no-store"
        (entry,) = inbox.json()
        assert (entry["entry_id"], entry["kind"]) == (notice["entry_id"], "verification_code")
        code = code_sent(fake, notice["entry_id"])
        wrong = f"{(int(code) + 1) % 1_000_000:06d}"

        # Every failure is a 422 the verify card shows as one message: a wrong code is the kernel's 422 `invalid`,
        # passed through, and codes that aren't six ASCII digits never reach the kernel. None is echoed.
        failures = [await client.post(verify_path(slug, "check"), json={"code": typed})
                    for typed in (wrong, code[:5], code + "0", "١٢٣٤٥٦", f" {code}")]
        assert [(failed.status_code, failed.json()) for failed in failures] == (
            [(422, {"error": "kernel", "code": "invalid"})] + [(422, {"error": "invalid"})] * 4)
        assert len(fake.called("POST /verify/check")) == 1
        assert not any(code in failed.text or wrong in failed.text for failed in failures)

        checked = await client.post(verify_path(slug, "check"), json={"code": code})
        assert checked.status_code == 200
        assert checked.json() == {"state": fake.sessions[session_id].state().model_dump(mode="json")}
        assert checked.json()["state"]["verified"] and checked.json()["state"]["assurance"] == "demo_code"
        await stream.until(lambda events: "turn_end" in types(events))
    await app.state.runtime.runner.drain()

    sent_to_model = json.dumps([[request.system, request.messages, request.tools] for request in model.requests])
    logged = "\n".join(record.getMessage() + (record.exc_text or "") + repr(vars(record)) for record in caplog.records)
    assert len(model.requests) == 1 and "verified as the contact on record" in sent_to_model
    for where, seen in (("app and procrastinate tables", at_rest(db)), ("event stream", stream.body),
                        ("model requests", sent_to_model), ("logs", logged), ("answer", checked.text)):
        assert code not in seen and wrong not in seen, where


async def test_demo_inbox_read_uses_the_session_credential(app, browser, fake, kernel_http, db):
    owner = browser(app, ip="198.51.100.30")
    created = await owner.post("/api/owner/copies", json={"passcode": PASSCODE})
    slug = created.json()["desks"][0]["slug"]
    owner_token = created.cookies["desk_owner"]
    first, first_token, first_opened = await open_session(app, browser, slug)
    second, second_token, second_opened = await open_session(app, browser, slug, ip="198.51.100.20")
    first_id, second_id = first_opened["state"]["session_id"], second_opened["state"]["session_id"]
    started = await first.post(verify_path(slug, "start"), json={"contact": DANA})
    fake.calls.clear()

    # The session is the cookie's, as /whoami names it: a session ID in the query is ignored.
    read = await first.get(f"/api/public/desks/{slug}/demo_inbox", params={"session_id": second_id})
    assert read.status_code == 200 and read.headers["cache-control"] == "no-store"
    assert [entry["entry_id"] for entry in read.json()] == [notice["entry_id"] for notice in started.json()["inbox"]]
    (call,) = fake.called("GET /demo_inbox?session_id=")
    assert call.query == {"session_id": first_id}
    assert call.headers["x-session-token"] == first_token and "x-owner-session" not in call.headers
    assert (await second.get(f"/api/public/desks/{slug}/demo_inbox")).json() == []

    # No visitor cookie, or only the owner's (forged onto this path): 401, and no inbox is read.
    fake.calls.clear()
    stranger = browser(app, ip="198.51.100.40")
    stranger.cookies.set("desk_owner", owner_token, domain="desk.test", path=f"/api/public/desks/{slug}")
    refused = await stranger.get(f"/api/public/desks/{slug}/demo_inbox")
    assert (refused.status_code, refused.json()) == (401, {"error": "no_session"})
    assert fake.called("/demo_inbox") == [] and fake.calls == []
    code = code_sent(fake, started.json()["inbox"][0]["entry_id"])
    assert code not in at_rest(db)


async def test_owner_alerts_stay_off_the_visitor_stream(app, browser, fake, kernel_http, model, engine, monkeypatch):
    slug = await new_slug(kernel_http, fake)
    client, token, opened = await open_session(app, browser, slug)
    session_id = opened["state"]["session_id"]
    alert = InboxNotice(entry_id="inbox-owner-alert", to="owner", preview="A request is waiting for you.")
    shown = InboxNotice(entry_id="inbox-for-the-visitor", to="d•••@example.com", preview="New verification code")
    fake.script("native.find_slots", inbox=[alert, shown])
    seeded = len(fake.inbox)                                 # the copy's own entries (its seeded held request's alert)
    # Claude asks for a discount (held: the decision alerts the owner) and for open times (whose execution carries an
    # owner alert beside a notice for the visitor), then replies.
    model.add(response(tool_use("native__quote", DISCOUNTED_QUOTE), tool_use("native__find_slots", {}),
                       reply("I've asked Mike about the discount.")))
    assert (await client.post(f"/api/public/desks/{slug}/messages", json={"text": "Any discount?"})).status_code == 202
    await app.state.runtime.runner.drain()

    # The hold alerted the owner. Its /decide answer carried the alert, once (every read of the decision carries none),
    # and the copy's Demo inbox keeps it; neither it nor the execution's owner alert reached the visitor's stream.
    (held,) = [record.decision for record in fake.decisions.values()
               if record.decision.session_id == session_id and record.decision.outcome == "hold"]
    assert [(entry.to, entry.kind) for _, entry in fake.inbox[seeded:]] == [("owner", "alert")] and held.inbox == []
    assert await stored_events(engine, session_id, "demo_inbox") == [{"type": "demo_inbox", **shown.model_dump()}]

    # An owner alert in the kernel's answer to a start reaches the visitor neither in the answer nor on the stream.
    start = fake._start_challenge

    def start_and_alert(*args):
        message, notices = start(*args)
        return message, [alert, *notices]

    monkeypatch.setattr(fake, "_start_challenge", start_and_alert)
    started = await client.post(verify_path(slug, "start"), json={"contact": DANA})
    assert started.status_code == 200
    (notice,) = started.json()["inbox"]
    assert notice["to"] == "d•••@example.com"
    published = [{"type": "demo_inbox", **shown.model_dump()}, {"type": "demo_inbox", **notice}]
    assert await stored_events(engine, session_id, "demo_inbox") == published

    # A notice already published isn't again: a repeated execution answers with the stored result, notices included.
    async with engine.connect() as conn:
        assert await emit_inbox(conn, ids_of(fake, session_id), [alert, shown]) == []
        await conn.commit()
    assert await stored_events(engine, session_id, "demo_inbox") == published


async def test_a_notice_is_published_once_when_an_executions_answer_is_lost(app, browser, fake, kernel_http, model,
                                                                            engine):
    slug = await new_slug(kernel_http, fake)
    client, token, opened = await open_session(app, browser, slug)
    session_id = opened["state"]["session_id"]
    first = InboxNotice(entry_id="inbox-first", to="d•••@example.com", preview="New verification code")
    fake.script("native.find_slots", inbox=[first])

    # The kernel runs the call, then its answer is lost: the turn reads the decision, executed, and asks /execute again
    # for the stored result, whose notice reaches the visitor once.
    fake.drop_response("POST /execute")
    model.add(response(tool_use("native__find_slots", {}), reply("Here are some open times.")))
    sent = await client.post(f"/api/public/desks/{slug}/messages", json={"text": "When can you come?"})
    assert sent.status_code == 202
    await app.state.runtime.runner.drain()
    assert len(fake.called("POST /execute")) == 2
    assert await stored_events(engine, session_id, "demo_inbox") == [{"type": "demo_inbox", **first.model_dump()}]

    # The kernel answers, then the decision can't be read: the notice in its answer is still published, once.
    second = InboxNotice(entry_id="inbox-second", to="d•••@example.com", preview="New verification code")
    fake.script("native.find_slots", inbox=[second])
    fake.fail("GET /decisions/{id}", "timeout", times=1)
    model.add(response(tool_use("native__find_slots", {}), reply("Here are more open times.")))
    assert (await client.post(f"/api/public/desks/{slug}/messages", json={"text": "Any later?"})).status_code == 202
    await app.state.runtime.runner.drain()
    assert await stored_events(engine, session_id, "demo_inbox") == [
        {"type": "demo_inbox", **first.model_dump()}, {"type": "demo_inbox", **second.model_dump()}]


async def test_verification_wakes_claude_with_new_tools(app, browser, fake, kernel_http, model, engine):
    slug = await new_slug(kernel_http, fake)
    client, token, opened = await open_session(app, browser, slug)
    session_id = opened["state"]["session_id"]
    # Claude sends the code with its tool and shows the verify card; once the visitor is verified, it answers again.
    model.add(response(tool_use("native__start_verification", {"contact": DANA}),
                       reply("I've sent a code to the contact on record.", {"template": "verify_prompt"})),
              response(reply("Thanks, you're confirmed.")))

    async with Stream(app, events_path(slug), headers=[cookie(token)]) as stream:
        sent = await client.post(f"/api/public/desks/{slug}/messages", json={"text": "Can I see my invoice?"})
        assert sent.status_code == 202
        events = await stream.until(lambda events: types(events).count("turn_end") == 1)
        (notice,) = [event for _, event in events if event.type == "demo_inbox"]
        (entry,) = (await client.get(f"/api/public/desks/{slug}/demo_inbox")).json()
        assert entry["entry_id"] == notice.entry_id and entry["to"] == notice.to
        checked = await client.post(verify_path(slug, "check"),
                                    json={"code": code_sent(fake, notice.entry_id)})
        assert checked.status_code == 200 and checked.json()["state"]["verified"]
        events = await stream.until(lambda events: types(events).count("turn_end") == 2)
    await app.state.runtime.runner.drain()

    assert types(events) == ["writing", "receipt", "demo_inbox", "message", "turn_end",
                             "writing", "message", "turn_end"]
    assert [block.template for block in events[3][1].blocks] == [None, "verify_prompt"]
    first, second = model.requests
    deferred = {tool["name"] for tool in first.tools if tool.get("defer_loading")}
    assert "native__release_document" in deferred and "native__start_verification" not in deferred
    # The second call: the note in the user turn, then the tool changes, last before Claude's turn.
    *_, user, system = second.messages
    assert user["role"] == "user" and system["role"] == "system"
    assert {"type": "text", "text": "<note>" + NOTES["verified"] + "</note>"} in user["content"]
    changes = {(change["type"], change["tool"]["name"]) for change in system["content"]}
    assert ("tool_addition", "native__release_document") in changes
    assert ("tool_removal", "native__start_verification") in changes
    assert second.tools == first.tools                                  # the context's tools stay as they were
    assert await conversation_notes(engine, session_id, "text", "model_seq IS NOT NULL") == [
        (NOTES["verified"], True)]


async def test_verify_is_rate_limited(app, browser, fake, kernel_http, clock):
    slug = await new_slug(kernel_http, fake)
    client, token, opened = await open_session(app, browser, slug)
    session_id = opened["state"]["session_id"]
    other, _, _ = await open_session(app, browser, slug)
    fake.calls.clear()

    # Starts and code checks share the session's ten tries in ten minutes, whatever their answers.
    tries = [await client.post(verify_path(slug, "start"), json={"contact": DANA}) for _ in range(5)]
    tries += [await client.post(verify_path(slug, "check"), json={"code": "000000"}) for _ in range(5)]
    assert [answer.status_code for answer in tries] == [200] * 5 + [422] * 5
    for step, body in (("start", {"contact": DANA}), ("check", {"code": "000000"})):
        refused = await client.post(verify_path(slug, step), json=body)
        assert (refused.status_code, refused.json()) == (429, {"error": "rate_limited", "retry_after": 600})
    assert len(fake.called("POST /verify/start")) == 5 and len(fake.called("POST /verify/check")) == 5
    # The window's first refusal is ledgered once, with the visitor's own credential, naming only the limit.
    (append,) = fake.called("POST /ledger/append")
    assert append.headers["x-session-token"] == token and "x-owner-session" not in append.headers
    event = append.body["event"]
    assert (event["kind"], event["origin"], event["session_id"], event["summary"]) == (
        "rate_limit", "api", session_id, {"limit": "verify"})
    assert (await other.post(verify_path(slug, "start"), json={"contact": DANA})).status_code == 200   # per session

    clock.advance(600)                                        # the first try has left the window
    assert (await client.post(verify_path(slug, "start"), json={"contact": DANA})).status_code == 200


@contextlib.contextmanager
def notes_fail(monkeypatch) -> Iterator[None]:
    """While the block runs, writing a `note` row fails as a lost database connection would."""
    insert = store._insert

    async def failing(conn, ids, **values):
        if values.get("kind") == "note":
            raise RuntimeError("the database went away")
        return await insert(conn, ids, **values)

    with monkeypatch.context() as patched:
        patched.setattr(store, "_insert", failing)
        yield


async def test_the_verified_note_is_written_once_per_session(app, browser, fake, kernel_http, model, engine,
                                                              monkeypatch):
    slug = await new_slug(kernel_http, fake)
    client, token, opened = await open_session(app, browser, slug)
    session_id = opened["state"]["session_id"]
    # The same visitor, through a transport that answers an app error as the server would (500), not by raising it.
    answering = httpx.AsyncClient(transport=httpx.ASGITransport(app=app, client=(CLIENT_IP, 50000),
                                                                raise_app_exceptions=False),
                                  base_url="https://desk.test", cookies=client.cookies)
    (notice,) = (await answering.post(verify_path(slug, "start"), json={"contact": DANA})).json()["inbox"]
    code = code_sent(fake, notice["entry_id"])

    # The kernel verifies the session, then the note can't be written: the visitor gets the error and nothing is noted.
    with notes_fail(monkeypatch):
        assert (await answering.post(verify_path(slug, "check"), json={"code": code})).status_code == 500
    assert fake.sessions[session_id].verified and await conversation_notes(
        engine, session_id, "text", "model_seq IS NOT NULL") == []

    # Sent again, the kernel answers that the session is verified, and as it has no note yet, the note is written and
    # Claude is woken for it.
    model.add(response(reply("Thanks, you're confirmed.")))
    assert (await answering.post(verify_path(slug, "check"), json={"code": code})).status_code == 200
    await app.state.runtime.runner.drain()
    assert await conversation_notes(engine, session_id, "text", "model_seq IS NOT NULL") == [
        (NOTES["verified"], True)]
    assert len(model.requests) == 1

    # Once noted, it isn't again: another check writes no second note and wakes no turn.
    assert (await answering.post(verify_path(slug, "check"), json={"code": code})).status_code == 200
    await app.state.runtime.runner.drain()
    assert await conversation_notes(engine, session_id, "text", "model_seq IS NOT NULL") == [
        (NOTES["verified"], True)]
    assert len(model.requests) == 1
    await answering.aclose()
