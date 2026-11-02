"""The A2A endpoint (Plan 02b, Task 4; master plan, "Agent sessions"): another person's agent talks to a Desk with
signed requests at `POST /api/a2a/{slug}`.

The API forwards the agent's signature to the kernel and never checks it itself; the kernel binds each request's nonce
to its session and body. Each answer is stored by agent key, session and nonce, so a request sent again gets the answer
its first try got and runs nothing, and every answer, errors included, says it comes from an AI.

The app runs on FakeKernel, which verifies real Ed25519 signatures, and a scripted model. The test plays the agent
(`Agent`): a demo agent's key, held in the test's memory, signs each request it sends.
"""

import asyncio
import hashlib
import json
import logging
import secrets
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import timedelta

import httpx
import pytest
from fastapi import FastAPI
from procrastinate.testing import InMemoryConnector
from sqlalchemy import text

from desk.api import a2a, loop, tools
from desk.api import ro as ro_module
from desk.api.deliver import Reply, deliver
from desk.api.main import create_app
from desk.api.prompts import NOTES
from desk.api.ratelimit import LIMITS, Limit
from desk.api.runner import TurnRunner
from desk.api.store import Ids
from desk.contracts import AgentAuth, DemoAgentIssued, ReplyDraft
from desk.kernel_api import CheckReplyRequest, CreateCopyRequest, DemoAgentRequest
from tests.api.fakes import ScriptedModel, gated, response, tool_use
from tests.api.notes import conversation_notes
from tests.api.test_approvals import jobs_done, resolved
from tests.api.test_public_chat import DISCOUNTED_QUOTE, reply
from tests.api.test_secrets_at_rest import at_rest
from tests.api.test_verification import notes_fail
from tests.kernel_contract.fake_kernel import FakeKernelState, IDLE_LIMIT, agent_signature, fake_kernel_app, signed_time

DANA = "dana@example.com"               # on record in the Turner seed
CREDENTIALS = ("x-session-token", "x-owner-session")
AGENT_HEADERS = ("x-agent-key-id", "x-agent-ts", "x-agent-nonce", "x-agent-sig", "x-agent-body-sha256")
KEEP = object()


@pytest.fixture
def model() -> ScriptedModel:
    return ScriptedModel()


@pytest.fixture
def jobs_connector() -> InMemoryConnector:
    return InMemoryConnector()


@pytest.fixture
async def app(db, fake, api_settings, clock, model, jobs_connector) -> AsyncIterator[FastAPI]:
    app = create_app(api_settings, kernel_transport=httpx.ASGITransport(app=fake_kernel_app(fake)), model=model,
                     clock=clock, jobs_connector=jobs_connector)
    async with app.router.lifespan_context(app):
        yield app


@dataclass
class Sent:
    """One request as the agent sent it: its raw body and headers, to send again byte for byte."""

    raw: bytes
    headers: dict[str, str]


@dataclass
class Agent:
    """Another person's agent, played by the test: a demo agent's key signing each request it sends to the Desk."""

    issued: DemoAgentIssued
    slug: str
    fake: FakeKernelState
    client: httpx.AsyncClient
    owner_token: str
    session_id: str | None = None

    def body(self, message: str, *, session_id: object = KEEP, verify_code: str | None = None,
             mandate: bool = True) -> bytes:
        """An `A2ARequest`'s bytes; an opening request carries the agent's mandate unless `mandate` is False."""
        session_id = self.session_id if session_id is KEEP else session_id
        payload: dict = {"desk_slug": self.slug, "session_id": session_id, "message": message}
        if session_id is None and mandate:
            payload["mandate"] = self.issued.mandate.model_dump(mode="json")
        if verify_code is not None:
            payload["verify_code"] = verify_code
        return json.dumps(payload).encode()

    def sign(self, raw: bytes, *, nonce: str | None = None, signer: DemoAgentIssued | None = None) -> Sent:
        """The request signed as the agent signs it: `{desk_slug, ts, nonce, body_sha256}` with its key (or
        `signer`'s, under this agent's key name)."""
        ts, nonce = signed_time(self.fake.now), nonce or secrets.token_hex(16)
        sig = agent_signature((signer or self.issued).agent_private_key_hex, self.slug, ts, nonce,
                              hashlib.sha256(raw).hexdigest())
        return Sent(raw, {"Content-Type": "application/json", "X-Agent-Key-Id": self.issued.agent_key_id,
                          "X-Agent-Ts": ts, "X-Agent-Nonce": nonce, "X-Agent-Sig": sig})

    async def post(self, sent: Sent, *, slug: str | None = None) -> httpx.Response:
        answer = await self.client.post(f"/api/a2a/{slug or self.slug}", content=sent.raw, headers=sent.headers)
        if answer.status_code == 200 and self.session_id is None:
            self.session_id = answer.json()["session_id"]
        return answer

    async def send(self, message: str, *, nonce: str | None = None, **options) -> httpx.Response:
        return await self.post(self.sign(self.body(message, **options), nonce=nonce))


async def new_copy(kernel_http, fake) -> tuple[str, str, str]:
    """A fresh Turner copy: its owner token, its Desk's ID and slug."""
    copy = await kernel_http.public().call("POST /copies", CreateCopyRequest())
    return copy.owner_token, copy.desk_ids[0], fake.desks[copy.desk_ids[0]].slug


async def mint(kernel_http, owner_token: str, desk_id: str) -> DemoAgentIssued:
    return await kernel_http.owner(owner_token).call("POST /agents/demo", DemoAgentRequest(desk_id=desk_id))


async def new_agent(app, browser, fake, kernel_http) -> Agent:
    owner_token, desk_id, slug = await new_copy(kernel_http, fake)
    return Agent(await mint(kernel_http, owner_token, desk_id), slug, fake, browser(app), owner_token)


async def other_agent(kernel_http, agent: Agent) -> Agent:
    """A second demo agent on the same Desk, sending from its own client."""
    desk_id = agent.fake.sessions[agent.session_id].desk_id if agent.session_id else next(
        desk.desk_id for desk in agent.fake.desks.values() if desk.slug == agent.slug)
    return Agent(await mint(kernel_http, agent.owner_token, desk_id), agent.slug, agent.fake, agent.client,
                 agent.owner_token)


def say(prose: str) -> object:
    return response(reply(prose))


def disclosed_error(answer: httpx.Response, status: int, code: str) -> None:
    assert (answer.status_code, answer.json()) == (status, {"code": code, "disclosure": "ai"})
    assert answer.headers["cache-control"] == "no-store"


async def turns(engine) -> list[dict]:
    async with engine.connect() as conn:
        found = await conn.execute(text("SELECT agent_key_id, session_id, nonce, status, http_status, response,"
                                        " through_seq FROM app.a2a_turns ORDER BY created_at, nonce"))
        return [dict(row._mapping) for row in found]


async def sse(engine, session_id: str) -> list[tuple[int, str, dict]]:
    async with engine.connect() as conn:
        found = await conn.execute(text("SELECT seq, type, payload FROM app.run_events WHERE session_id = :s"
                                        " AND kind = 'sse' ORDER BY seq"), {"s": session_id})
        return [tuple(row) for row in found]


async def messages(engine, session_id: str, kind: str) -> list[tuple]:
    async with engine.connect() as conn:
        found = await conn.execute(text("SELECT text, wake FROM app.messages WHERE session_id = :s AND kind = :k"
                                        " ORDER BY n"), {"s": session_id, "k": kind})
        return [tuple(row) for row in found]


def ids_of(fake, session_id: str) -> Ids:
    session = fake.sessions[session_id]
    return Ids(copy_id=session.copy_id, desk_id=session.desk_id, session_id=session_id)


async def owner_says(engine, fake, session_id: str, said: str) -> None:
    """The owner's say, delivered to the session as the take-over route delivers it (Plan 02b, Task 1): the kernel's
    verdict, whose one `owner_said` card has the owner's text as its title and no lines."""
    verdict = fake.owner_verdict(session_id, said)
    async with engine.connect() as conn:
        assert await deliver(conn, ids_of(fake, session_id), Reply(verdict, "owner", "owner"),
                             ro_schema="fake_kernel_ro") is not None
        await conn.commit()


def model_text(request) -> str:
    """Every text block a model request's messages carry, as Claude reads them."""
    return "\n".join(block.get("text", "") for message in request.messages
                     for block in (message["content"] if isinstance(message["content"], list) else [])
                     if isinstance(block, dict))


# Every answer says it comes from an AI ------------------------------------------------------------------------


async def test_every_a2a_response_carries_the_disclosure(app, browser, fake, kernel_http, model, engine, monkeypatch):
    agent = await new_agent(app, browser, fake, kernel_http)
    model.add(say("Happy to help."))
    opened = await agent.send("Hello, can you help?")
    assert opened.status_code == 200 and opened.headers["cache-control"] == "no-store"
    assert opened.json()["disclosure"] == "ai" and opened.json()["session_id"] == agent.session_id

    # 400: a body that isn't an A2A request, or names another Desk than the path.
    disclosed_error(await agent.post(agent.sign(b"not json")), 400, "invalid")
    disclosed_error(await agent.post(agent.sign(agent.body("Hi")), slug=agent.slug + "-other"), 400, "invalid")
    too_big = agent.sign(agent.body("x" * (33 * 1024)))
    disclosed_error(await agent.post(too_big), 400, "invalid")
    # 401: no signature, a signature the kernel refuses, a Desk the kernel doesn't know.
    unsigned = agent.sign(agent.body("Hi"))
    disclosed_error(await agent.client.post(f"/api/a2a/{agent.slug}", content=unsigned.raw,
                                            headers={"Content-Type": "application/json"}), 401, "auth")
    forged = agent.sign(agent.body("Hi"), signer=(await other_agent(kernel_http, agent)).issued)
    disclosed_error(await agent.post(forged), 401, "auth")
    stranger = Agent(agent.issued, "no-such-desk", fake, agent.client, agent.owner_token)
    disclosed_error(await stranger.send("Hello?", session_id=None), 401, "auth")
    # 422: a wrong verification code.
    disclosed_error(await agent.send("My code", verify_code="000000"), 422, "invalid")
    # 503: the kernel can't be reached.
    fake.fail("GET /whoami", "connect", times=1)
    disclosed_error(await agent.send("Anyone there?"), 503, "kernel_unavailable")
    # 500: the API fails inside the turn; the answer is stored like any other.
    async def broken(self, caller):
        raise RuntimeError("the turn broke")
    monkeypatch.setattr(TurnRunner, "run_agent_turn", broken)
    failed = agent.sign(agent.body("Break, please"))
    disclosed_error(await agent.post(failed), 500, "internal")
    disclosed_error(await agent.post(failed), 500, "internal")         # sent again: the stored answer
    monkeypatch.undo()
    # 405: a method the endpoint doesn't take.
    disclosed_error(await agent.client.get(f"/api/a2a/{agent.slug}"), 405, "method_not_allowed")
    # 429: past a limit, with Retry-After.
    monkeypatch.setitem(LIMITS, "a2a_ip", Limit(1, 3600, "ip"))
    limited = await agent.send("Once more")
    disclosed_error(limited, 429, "rate_limited")
    assert int(limited.headers["retry-after"]) > 0
    monkeypatch.setitem(LIMITS, "a2a_ip", Limit(120, 3600, "ip"))
    # 409: a session the kernel closed.
    fake.now += IDLE_LIMIT + timedelta(seconds=1)
    disclosed_error(await agent.send("Still there?"), 409, "closed")
    assert len(model.requests) == 1


# The kernel checks the signature ------------------------------------------------------------------------------


async def test_signature_is_forwarded_not_verified(app, browser, fake, kernel_http, model):
    agent = await new_agent(app, browser, fake, kernel_http)
    model.add(response(tool_use("native__find_slots", {}), reply("Here are some open times.")))
    sent = agent.sign(agent.body("When can you come?"))
    fake.calls.clear()
    answered = await agent.post(sent)
    assert answered.status_code == 200
    routes = {call.route for call in fake.calls}
    assert {"POST /sessions", "GET /whoami", "GET /context/{session_id}?desk_id=", "POST /decide", "POST /execute",
            "POST /check_reply"} <= routes
    expected = {name.lower(): value for name, value in sent.headers.items() if name.lower().startswith("x-agent-")}
    expected["x-agent-body-sha256"] = hashlib.sha256(sent.raw).hexdigest()
    for call in fake.calls:                     # every call carries the agent's own headers, as sent, and no token
        assert {name: call.headers.get(name) for name in AGENT_HEADERS} == expected, call.route
        assert not set(CREDENTIALS) & set(call.headers), call.route

    # A signature the kernel refuses is the kernel's 401: the API sent it on, and nothing ran.
    bad = agent.sign(agent.body("Hello again"))
    bad.headers["X-Agent-Sig"] = "ab" * 64
    fake.calls.clear()
    disclosed_error(await agent.post(bad), 401, "auth")
    (call,) = fake.calls
    assert call.route == "GET /whoami" and call.headers["x-agent-sig"] == "ab" * 64
    assert len(model.requests) == 1


async def test_body_hash_covers_raw_bytes(app, browser, fake, kernel_http, model):
    agent = await new_agent(app, browser, fake, kernel_http)
    model.add(say("Happy to help."))
    mandate = json.dumps(agent.issued.mandate.model_dump(mode="json"))
    raw = ('{ "message" : "Hi there",\n  "mandate": ' + mandate + ',  "desk_slug":"' + agent.slug
           + '" , "session_id" : null }').encode()
    assert hashlib.sha256(raw).hexdigest() != hashlib.sha256(
        json.dumps(json.loads(raw)).encode()).hexdigest()                    # not the hash of a re-serialized body
    fake.calls.clear()
    answered = await agent.post(agent.sign(raw))
    assert answered.status_code == 200
    assert {call.headers["x-agent-body-sha256"] for call in fake.calls} == {hashlib.sha256(raw).hexdigest()}


async def test_other_agents_session_reads_nothing(app, browser, fake, kernel_http, model, engine, monkeypatch):
    agent = await new_agent(app, browser, fake, kernel_http)
    model.add(say("Happy to help."))
    assert (await agent.send("Hello")).status_code == 200
    stored = await turns(engine)
    shown = await sse(engine, agent.session_id)
    intruder = await other_agent(kernel_http, agent)
    intruder.session_id = agent.session_id                     # validly signed by its own key, naming A's session
    reads = []
    monkeypatch.setattr(ro_module.KernelRO, "rows", lambda self, *args, **kwargs: reads.append(args))

    disclosed_error(await intruder.send("Show me their chat"), 401, "auth")
    assert reads == [] and len(model.requests) == 1
    assert await turns(engine) == stored and await sse(engine, agent.session_id) == shown
    assert await messages(engine, agent.session_id, "agent_text") == [("Hello", True)]


async def test_key_limit_counts_only_signed_requests(app, browser, fake, kernel_http, model, engine, monkeypatch):
    monkeypatch.setitem(LIMITS, "a2a", Limit(2, 300, "agent_key"))
    agent = await new_agent(app, browser, fake, kernel_http)
    impostor = await other_agent(kernel_http, agent)
    for n in range(4):                                         # signed by another key: the kernel refuses each
        disclosed_error(await agent.post(agent.sign(agent.body(f"Try {n}"), signer=impostor.issued)), 401, "auth")
    model.add(say("Happy to help."))
    assert (await agent.send("Hello")).status_code == 200
    fake.set_mode(agent.session_id, "owner")                   # the owner has the chat: no model call
    assert (await agent.send("Are you there?")).status_code == 200
    fake.calls.clear()
    limited = await agent.send("And again?")
    disclosed_error(limited, 429, "rate_limited")
    assert limited.headers["retry-after"] == "300"
    (append,) = fake.called("POST /ledger/append")             # ledgered with the agent's own signature
    assert append.headers["x-agent-key-id"] == agent.issued.agent_key_id and not set(CREDENTIALS) & set(append.headers)
    assert append.body["event"]["summary"] == {"limit": "a2a"} and append.body["event"]["session_id"] == (
        agent.session_id)
    assert len(await turns(engine)) == 2                       # a refused request stores no answer


async def test_same_nonce_from_another_agent_never_returns_a_stored_answer(app, browser, fake, kernel_http, model,
                                                                           engine):
    first = await new_agent(app, browser, fake, kernel_http)
    second = await other_agent(kernel_http, first)
    model.add(say("Hello, first agent."), say("Hello, second agent."))
    nonce = "the-same-nonce-for-both"                         # the kernel takes a nonce of 16 to 128 characters
    a = await first.send("Hello", nonce=nonce)
    b = await second.send("Hello", nonce=nonce)
    assert a.status_code == b.status_code == 200
    assert first.session_id != second.session_id and b.json()["session_id"] == second.session_id
    assert [block["text"] for block in b.json()["blocks"]] == ["Hello, second agent."]
    assert len(model.requests) == 2
    assert {(row["agent_key_id"], row["session_id"], row["nonce"]) for row in await turns(engine)} == {
        (first.issued.agent_key_id, first.session_id, nonce),
        (second.issued.agent_key_id, second.session_id, nonce)}


# Turns end at the agent's answer ------------------------------------------------------------------------------


async def test_agent_turn_ends_at_its_reply(app, browser, fake, kernel_http, model, engine):
    agent = await new_agent(app, browser, fake, kernel_http)
    model.add(say("It costs 50 dollars."), say("Happy to help with that."))
    sent = agent.sign(agent.body("How much is a visit?"))
    fake.calls.clear()
    answered = await agent.post(sent)

    assert answered.status_code == 200
    assert answered.json() == {"session_id": agent.session_id, "disclosure": "ai", "receipts": [],
                               "blocks": [{"kind": "prose", "text": "Happy to help with that.", "template": None,
                                           "fact_id": None, "title": None, "lines": [], "href": None,
                                           "options": []}]}
    assert len(model.requests) == 2                            # the regenerated reply ended the turn
    (message,) = [payload for _, type, payload in await sse(engine, agent.session_id) if type == "message"]
    assert message["generation"] == fake.sessions[agent.session_id].generation and message["handoff"] is False
    assert len(fake.called("POST /check_reply")) == 2
    assert {call.headers["x-agent-nonce"] for call in fake.calls} == {sent.headers["X-Agent-Nonce"]}


async def test_work_woken_during_the_turn_waits_for_the_next_request(app, browser, fake, kernel_http, model, engine,
                                                                      jobs_connector):
    agent = await new_agent(app, browser, fake, kernel_http)
    model.add(response(tool_use("native__quote", DISCOUNTED_QUOTE), reply("I've asked Mike to look at this.")))
    assert (await agent.send("Can I get a discount on a drain clearing?")).status_code == 200
    (decision,) = [record.decision for record in fake.decisions.values()
                   if record.decision.session_id == agent.session_id]
    release = asyncio.Event()
    slow = gated(say("We're open on weekdays."), release)
    model.add(slow)
    sent = agent.sign(agent.body("When are you open?"))
    first = asyncio.create_task(agent.post(sent))
    await asyncio.wait_for(slow.entered.wait(), 5)

    # the owner answers the held request while Claude writes: the resume job wakes the session
    owner = browser(app, ip="198.51.100.30")
    owner.cookies.set("desk_owner", agent.owner_token, domain="desk.test", path="/api/owner")
    answered = await owner.post(f"/api/owner/approvals/{decision.decision_id}/answer", json={"answer": "deny_once"})
    assert answered.status_code == 200
    (shown,) = await resolved(engine, agent.session_id)
    await jobs_done(jobs_connector)
    assert await messages(engine, agent.session_id, "action_update") == [(shown["visitor_plain"], True)]
    release.set()
    replied = await asyncio.wait_for(first, 5)

    # the request's signature covers one reply: it gets that reply, and no second turn runs under its spent nonce
    assert replied.status_code == 200
    assert [block["text"] for block in replied.json()["blocks"]] == ["We're open on weekdays."]
    assert replied.json()["receipts"] == [shown] and len(model.requests) == 2
    assert [(row["status"], row["http_status"]) for row in await turns(engine)] == [("done", 200)] * 2
    again = await agent.post(sent)
    assert (again.status_code, again.json()) == (200, replied.json())

    # the woken work waits for the agent's next request, whose turn reads it
    model.add(say("Mike couldn't offer a discount this time."))
    later = await agent.send("Any news?")
    assert later.status_code == 200 and len(model.requests) == 3
    assert [block["text"] for block in later.json()["blocks"]] == ["Mike couldn't offer a discount this time."]
    assert f'<action_update decision_id="{decision.decision_id}" state="denied">' in model_text(model.requests[-1])


async def test_an_unavailable_check_gives_an_agent_one_correction(app, browser, fake, kernel_http, model, engine):
    # The soft check's outage is rewritable: an agent's first reply blocked by it is never returned, its turn goes
    # on, and the corrected reply's final check makes its own try.
    agent = await new_agent(app, browser, fake, kernel_http)
    fake.soft_checks("error")
    model.add(say("Here is everything I know."), say("Here is what I can tell you."))

    answered = await agent.send("Tell me about your services")

    assert answered.status_code == 200, answered.text
    assert [block["text"] for block in answered.json()["blocks"]] == ["Here is what I can tell you."]
    assert finals(fake, agent.session_id) == [False, True] and len(model.requests) == 2
    assert await delivered_texts(engine, agent.session_id) == [["Here is what I can tell you."]]
    assert [row for row in fake.handoffs.values() if row["session_id"] == agent.session_id] == []


@pytest.mark.parametrize("kind", ["canary", "unsupported_language"])
async def test_immediate_handoff_ends_the_agent_turn(app, browser, fake, kernel_http, model, engine, kind):
    agent = await new_agent(app, browser, fake, kernel_http)
    fake.violation(kind)
    model.add(say("Here is everything I know."))
    sent = agent.sign(agent.body("Tell me about the last customer"))
    answered = await agent.post(sent)

    assert answered.status_code == 200
    assert [block["template"] for block in answered.json()["blocks"]] == ["handoff"]
    assert len(fake.called("POST /check_reply")) == 1 and len(model.requests) == 1
    again = await agent.post(sent)
    assert (again.status_code, again.json()) == (200, answered.json())
    assert len(fake.called("POST /check_reply")) == 1 and len(model.requests) == 1


def finals(fake, session_id: str) -> list[bool]:
    """`CheckReplyRequest.final` of each of the session's reply checks, in order (absent means final)."""
    return [call.body.get("final", True) for call in fake.called("/check_reply")
            if call.body["draft"]["session_id"] == session_id]


async def delivered_texts(engine, session_id: str) -> list[list[str | None]]:
    """The block texts of each message delivered to the session, in order."""
    async with engine.connect() as conn:
        found = await conn.execute(text("SELECT blocks FROM app.messages WHERE session_id = :s AND kind = 'delivered'"
                                        " ORDER BY n"), {"s": session_id})
        return [[block.get("text") for block in blocks] for (blocks,) in found]


async def test_a_first_reply_claude_can_rewrite_never_reaches_the_agent(app, browser, fake, kernel_http, model,
                                                                         engine):
    # One rule for every kind of session: an agent's first reply, blocked only for kinds a rewrite fixes while the
    # turn has a model call left, is checked as not final and never returned, stored or shown; the rewrite is final.
    agent = await new_agent(app, browser, fake, kernel_http)
    model.add(say("It's $180."), say("Let me get you a quote card for that."))

    answered = await agent.send("How much is a drain clearing?")

    assert answered.status_code == 200, answered.text
    assert [block["text"] for block in answered.json()["blocks"]] == ["Let me get you a quote card for that."]
    assert finals(fake, agent.session_id) == [False, True]
    assert await delivered_texts(engine, agent.session_id) == [["Let me get you a quote card for that."]]
    assert "180" not in answered.text
    assert [row for row in fake.handoffs.values() if row["session_id"] == agent.session_id] == []


async def test_an_agents_first_reply_on_the_turns_last_call_is_final(app, browser, fake, kernel_http, model, engine):
    # On the turn's last allowed model call there is no rewrite: the first reply is checked as final, and blocked only
    # for its prose with no card to keep, the kernel's call-back offer is what the agent gets, once, and no owner
    # handoff opens (the owner's decision of 2026-11-01).
    agent = await new_agent(app, browser, fake, kernel_http)
    model.add(*(response(tool_use("native__find_slots", {"days": 3})) for _ in range(loop.MAX_MODEL_CALLS - 1)),
              say("It's $180."))

    answered = await agent.send("Find me a slot, then tell me the price.")

    assert answered.status_code == 200, answered.text
    assert len(model.requests) == loop.MAX_MODEL_CALLS
    assert [(block["template"], block["text"]) for block in answered.json()["blocks"]] == [
        (None, "Would you like me to arrange a callback?")]
    assert finals(fake, agent.session_id) == [True]
    assert [row for row in fake.handoffs.values() if row["session_id"] == agent.session_id] == []


async def test_response_carries_blocks_and_signed_receipts(app, browser, fake, kernel_http, model, engine,
                                                           jobs_connector):
    agent = await new_agent(app, browser, fake, kernel_http)
    model.add(response(tool_use("native__quote", DISCOUNTED_QUOTE), reply("I've asked Mike to look at this.")))
    held = await agent.send("Can I get a discount on a drain clearing?")
    assert held.status_code == 200
    (decision,) = [record.decision for record in fake.decisions.values()
                   if record.decision.session_id == agent.session_id]
    signed = {key: getattr(decision, key) for key in ("decision_id", "state", "visitor_plain", "ledger_seq",
                                                      "signature")}
    assert held.json()["receipts"] == [{"type": "held", **signed}]
    assert [block["text"] for block in held.json()["blocks"]] == ["I've asked Mike to look at this."]

    owner = browser(app, ip="198.51.100.30")
    owner.cookies.set("desk_owner", agent.owner_token, domain="desk.test", path="/api/owner")
    answered = await owner.post(f"/api/owner/approvals/{decision.decision_id}/answer", json={"answer": "deny_once"})
    assert answered.status_code == 200
    (shown,) = await resolved(engine, agent.session_id)
    await jobs_done(jobs_connector)
    await owner_says(engine, fake, agent.session_id, "Sorry, no discounts this month.")

    model.add(say("Mike couldn't offer a discount this time."))
    later = await agent.send("Any news?")
    assert later.status_code == 200
    assert later.json()["receipts"] == [shown] and shown["state"] == "denied"
    assert [block["template"] for block in later.json()["blocks"]] == ["owner_said", None]
    assert f'<action_update decision_id="{decision.decision_id}" state="denied">' in model_text(model.requests[-1])
    model.add(say("Anything else I can help with?"))
    last = await agent.send("Thanks")
    assert last.json()["receipts"] == [] and [block["text"] for block in last.json()["blocks"]] == [
        "Anything else I can help with?"]


async def test_agent_never_receives_the_owner_refusal_reason(app, browser, fake, kernel_http, model, engine,
                                                            jobs_connector):
    agent = await new_agent(app, browser, fake, kernel_http)
    model.add(response(tool_use("native__quote", DISCOUNTED_QUOTE), reply("I've asked Mike to look at this.")))
    assert (await agent.send("Can I get a discount on a drain clearing?")).status_code == 200
    (held,) = [record.decision for record in fake.decisions.values()
               if record.decision.session_id == agent.session_id]
    fake.never(fake.sessions[agent.session_id].desk_id, "native.quote")
    owner = browser(app, ip="198.51.100.30")
    owner.cookies.set("desk_owner", agent.owner_token, domain="desk.test", path="/api/owner")
    answered = await owner.post(f"/api/owner/approvals/{held.decision_id}/answer", json={"answer": "allow_once"})
    assert answered.status_code == 200
    owner_line = answered.json()["decision"]["owner_plain"]
    assert owner_line and answered.json()["decision"]["state"] == "refused_at_execution"
    await resolved(engine, agent.session_id)
    queued = await jobs_done(jobs_connector)

    # A fresh signed credential reads the same final decision without the owner's field.
    sent = agent.sign(agent.body("Any news?"))
    view = kernel_http.agent(AgentAuth(agent_key_id=agent.issued.agent_key_id, ts=sent.headers["X-Agent-Ts"],
                                      nonce=sent.headers["X-Agent-Nonce"], sig=sent.headers["X-Agent-Sig"]),
                            hashlib.sha256(sent.raw).hexdigest())
    read = await view.call("GET /decisions/{id}", path={"id": held.decision_id})
    assert read.owner_plain is None and owner_line not in read.model_dump_json()
    model.add(say("That request couldn't go ahead. Can I help with something else?"))
    later = await agent.post(sent)
    assert later.status_code == 200, later.text
    assert later.json()["receipts"][0]["state"] == "refused_at_execution"
    assert (await agent.post(sent)).json() == later.json()       # the stored A2A answer is safe on replay too
    async with engine.connect() as conn:
        rows = (await conn.execute(text(
            "SELECT row_to_json(m)::text FROM app.messages m WHERE session_id = :s"
            " UNION ALL SELECT row_to_json(e)::text FROM app.run_events e WHERE session_id = :s"
            " UNION ALL SELECT row_to_json(a)::text FROM app.a2a_turns a WHERE session_id = :s"),
            {"s": agent.session_id})).scalars().all()
    for serialized in (later.text, json.dumps(rows), json.dumps([job["args"] for job in queued]),
                       json.dumps(model.requests[-1].messages)):
        assert owner_line not in serialized
        assert "owner_plain" not in serialized


async def test_agent_gets_a_pending_decisions_final_state_on_its_next_request(app, browser, fake, kernel_http, model,
                                                                              engine):
    agent = await new_agent(app, browser, fake, kernel_http)
    fake.script("native.book", exec_state="unknown")
    slot_id = next(iter(fake.desks[next(iter(fake.desks))].slots))
    model.add(response(tool_use("native__book", {"slot_id": slot_id, "name": "Jane Doe", "contact": "jane@example.com"}), reply("I'm checking on that booking.")))
    first = await agent.send("Book me in, please")
    (receipt,) = first.json()["receipts"]
    assert (receipt["type"], receipt["state"]) == ("receipt", "unknown")
    final = fake.reconcile(receipt["decision_id"])

    model.add(say("Your booking went through."))
    fake.calls.clear()
    later = await agent.send("Did it work?")

    assert later.status_code == 200
    assert later.json()["receipts"] == [{"type": "receipt", "decision_id": final.decision_id, "state": "executed",
                                         "visitor_plain": final.visitor_plain, "ledger_seq": final.ledger_seq,
                                         "signature": final.signature}]
    assert f'<action_update decision_id="{final.decision_id}" state="executed">' in model_text(model.requests[-1])
    read = [call for call in fake.called("GET /decisions/{id}") if call.path.endswith(final.decision_id)]
    assert read and {call.headers["x-agent-key-id"] for call in read} == {agent.issued.agent_key_id}


async def test_a_booking_reads_what_the_session_waits_on_before_its_reply_spends_the_request(app, browser, fake,
                                                                                              kernel_http, model,
                                                                                              engine):
    """An agent's discount quote waits for the owner, then one response books a time and replies. The turn reads the
    held quote with the request's own signature before the reply's check spends it: the kernel closes the quote, and
    its `decision_due` row waits for the agent's next request. Read after the reply, the kernel would refuse it as a
    replay."""
    agent = await new_agent(app, browser, fake, kernel_http)
    model.add(response(tool_use("native__quote", DISCOUNTED_QUOTE), reply("I've asked Mike to look at this.")))
    assert (await agent.send("Can I get a discount on a drain clearing?")).status_code == 200
    (quote,) = [record.decision for record in fake.decisions.values()
                if record.decision.session_id == agent.session_id]
    assert quote.state == "held"
    desk_id = fake.sessions[agent.session_id].desk_id
    model.add(response(tool_use("native__book", {"slot_id": weekday_slot(fake, desk_id)}), reply("You're booked.")))
    fake.calls.clear()

    booked = await agent.send("Never mind, book me the earliest weekday visit at list price.")

    assert booked.status_code == 200, booked.text
    read = [call for call in fake.called("GET /decisions/{id}") if call.path.endswith(quote.decision_id)]
    assert read and {call.headers["x-agent-key-id"] for call in read} == {agent.issued.agent_key_id}
    assert fake.decisions[quote.decision_id].decision.state == "cancelled"
    assert await decisions_due(engine, agent.session_id) == [(quote.decision_id, True)]
    assert [entry.event.summary for entry in fake.desks[desk_id].ledger
            if entry.event.kind == "agent_auth" and entry.event.summary.get("reason") == "replayed"] == []


async def held_then_booked(app, browser, fake, kernel_http, model, monkeypatch, meanwhile):
    """An agent's discount quote waits for the owner. Then one response books the earliest weekday visit, searches
    the open times and replies, and `meanwhile` changes the kernel once the booking has run, before the search
    reaches it (`meanwhile(fake, agent, sent)`, `sent` being the request as signed). The agent, its quote, the
    Desk's ID and the request's answer."""
    agent = await new_agent(app, browser, fake, kernel_http)
    model.add(response(tool_use("native__quote", DISCOUNTED_QUOTE), reply("I've asked Mike to look at this.")))
    assert (await agent.send("Can I get a discount on a drain clearing?")).status_code == 200
    (quote,) = [record.decision for record in fake.decisions.values()
                if record.decision.session_id == agent.session_id]
    assert quote.state == "held"
    desk_id = fake.sessions[agent.session_id].desk_id
    sent = agent.sign(agent.body("Never mind, book me the earliest weekday visit at list price. Any other times?"))
    route_call, booked = loop.route_call, asyncio.Event()

    async def routing(conn, caller, generation, block):
        if block["name"] == "native__book":
            try:
                return await route_call(conn, caller, generation, block)
            finally:
                booked.set()
        await booked.wait()
        meanwhile(fake, agent, sent)
        return await route_call(conn, caller, generation, block)

    monkeypatch.setattr(loop, "route_call", routing)
    model.add(response(tool_use("native__book", {"slot_id": weekday_slot(fake, desk_id)}),
                       tool_use("native__find_slots", {"days": 3}), reply("You're booked.")))
    fake.calls.clear()
    answer = await agent.post(sent)
    (booking,) = [record.decision for record in fake.decisions.values()
                  if record.decision.session_id == agent.session_id and record.decision.action is not None
                  and record.decision.action.tool == "native.book"]
    assert booking.state == "executed"
    return agent, quote, desk_id, answer


async def decisions_due(engine, session_id: str) -> list[tuple[str, bool]]:
    """The session's `decision_due` rows: each decision's ID, and whether the row waits to be handled."""
    async with engine.connect() as conn:
        due = await conn.execute(text(
            "SELECT payload->>'decision_id', handled_at IS NULL FROM app.run_events WHERE session_id = :s"
            " AND kind = 'control' AND type = 'decision_due'"), {"s": session_id})
        return [tuple(row) for row in due]


def spend_the_request(fake, agent: Agent, sent: Sent) -> None:
    """The kernel ends the request's turn under it (at its time limit, say)."""
    fake.nonces[(agent.issued.agent_key_id, sent.headers["X-Agent-Nonce"])].spent_at = fake.now


def close_the_session(fake, agent: Agent, sent: Sent) -> None:
    """The kernel closes the conversation under it."""
    session = fake.sessions[agent.session_id]
    session.closed_at = fake.now
    fake._put_session(session)
    fake.flush()


def take_over(fake, agent: Agent, sent: Sent) -> None:
    """The owner takes the conversation over."""
    fake.set_mode(agent.session_id, "owner")


@pytest.mark.parametrize(("ending", "code"), [(spend_the_request, "replayed"), (close_the_session, "closed")],
                         ids=["turn_over", "session_ended"])
async def test_a_booking_turn_the_kernel_ended_reads_nothing_more(app, browser, fake, kernel_http, model, engine,
                                                                  monkeypatch, ending, code):
    """An agent's discount quote waits, then one response books a time, searches the open times and replies. The
    booking runs, but before the search reaches the kernel it ends the request's turn (`turn_over`: the signed request
    spent) or the conversation (`session_ended`: closed), refuses the search, and the turn stops. The turn doesn't read
    the waiting quote: the kernel would refuse that read too and ledger the refusal, one per waiting decision. The quote
    stays held for the owner's reads and the minute sweep."""
    agent, quote, desk_id, answer = await held_then_booked(app, browser, fake, kernel_http, model, monkeypatch,
                                                           ending)

    disclosed_error(answer, 409, code)
    assert [call.path for call in fake.called("GET /decisions/{id}") if call.path.endswith(quote.decision_id)] == []
    assert fake.decisions[quote.decision_id].decision.state == "held"
    assert await decisions_due(engine, agent.session_id) == []
    assert [entry.event.summary["route"] for entry in fake.desks[desk_id].ledger
            if entry.event.summary.get("reason") == code] == ["POST /decide"]     # the search's, and no read's


async def test_a_booking_turn_a_take_over_fenced_still_reads_what_waits(app, browser, fake, kernel_http, model, engine,
                                                                        monkeypatch):
    """The same, but the owner takes the conversation over once the booking has run: the kernel fences the search, and
    the turn stops silently. A take-over leaves the session's own reads working (`GET /decisions/{id}` checks neither
    its mode nor its generation, and doesn't spend the agent's request), so the turn still reads the waiting quote
    with the request's signature: the kernel closes it, its `decision_due` row waits, and no read is refused."""
    agent, quote, desk_id, answer = await held_then_booked(app, browser, fake, kernel_http, model, monkeypatch,
                                                           take_over)

    assert answer.status_code == 200, answer.text
    read = [call for call in fake.called("GET /decisions/{id}") if call.path.endswith(quote.decision_id)]
    assert read and {call.headers["x-agent-key-id"] for call in read} == {agent.issued.agent_key_id}
    assert fake.decisions[quote.decision_id].decision.state == "cancelled"
    assert await decisions_due(engine, agent.session_id) == [(quote.decision_id, True)]
    assert [entry.event.summary for entry in fake.desks[desk_id].ledger
            if entry.event.summary.get("route") == "GET /decisions/{decision_id}"] == []      # no read refused


# Requests sent again ------------------------------------------------------------------------------------------


async def test_resent_request_gets_the_stored_answer(app, browser, fake, kernel_http, model, engine):
    agent = await new_agent(app, browser, fake, kernel_http)
    model.add(say("Happy to help."))
    assert (await agent.send("Hello")).status_code == 200
    model.add(response(tool_use("native__quote", {"items": [{"item_id": "drain", "qty": 1}]}),
                       reply("Here is your quote.")))
    quoted = agent.sign(agent.body("How much to clear a drain?"))
    first = await agent.post(quoted)
    assert first.status_code == 200
    fake.violation("canary")
    model.add(say("Here is what I know."))
    handed_off = agent.sign(agent.body("Anything private?"))
    second = await agent.post(handed_off)
    assert [block["template"] for block in second.json()["blocks"]] == ["handoff"]
    made, decided, checked = len(model.requests), len(fake.called("POST /decide")), len(fake.called("/check_reply"))

    for sent, answer in ((quoted, first), (handed_off, second)):
        again = await agent.post(sent)
        assert (again.status_code, again.json()) == (200, answer.json())
    assert (len(model.requests), len(fake.called("POST /decide")), len(fake.called("/check_reply"))) == (
        made, decided, checked)
    assert await messages(engine, agent.session_id, "agent_text") == [
        ("Hello", True), ("How much to clear a drain?", True), ("Anything private?", True)]


async def test_resent_while_running_is_in_progress(app, browser, fake, kernel_http, model, engine):
    agent = await new_agent(app, browser, fake, kernel_http)
    model.add(say("Happy to help."))
    assert (await agent.send("Hello")).status_code == 200
    release = asyncio.Event()
    slow = gated(say("We're open on weekdays."), release)
    model.add(slow)
    sent = agent.sign(agent.body("When are you open?"))
    first = asyncio.create_task(agent.post(sent))
    await asyncio.wait_for(slow.entered.wait(), 5)

    disclosed_error(await agent.post(sent), 409, "in_progress")
    assert len(model.requests) == 2 and len(fake.called("POST /check_reply")) == 1
    assert await messages(engine, agent.session_id, "agent_text") == [("Hello", True), ("When are you open?", True)]
    release.set()
    answered = await asyncio.wait_for(first, 5)
    assert answered.status_code == 200 and answered.json()["blocks"][0]["text"] == "We're open on weekdays."
    again = await agent.post(sent)
    assert (again.status_code, again.json()) == (200, answered.json())


async def test_a_try_later_answer_leaves_the_nonce_to_be_sent_again(app, browser, fake, kernel_http, model, engine,
                                                                    monkeypatch):
    # "Try later" isn't the turn's answer: the same signed request sent again runs, and its message is stored once.
    agent = await new_agent(app, browser, fake, kernel_http)
    model.add(say("Happy to help."))
    assert (await agent.send("Hello")).status_code == 200

    # Busy: a turn already running holds the session past the wait.
    monkeypatch.setattr(loop, "TURN_LOCK_WAIT_S", 0.2)
    _, task, release = await mid_turn(agent, model, "When are you open?")
    later = agent.sign(agent.body("And on Saturdays?"))
    disclosed_error(await agent.post(later), 409, "in_progress")
    release.set()
    assert (await asyncio.wait_for(task, 5)).status_code == 200
    model.add(say("We're open on Saturday mornings."))
    again = await agent.post(later)
    assert again.status_code == 200 and again.json()["blocks"][0]["text"] == "We're open on Saturday mornings."
    assert (await agent.post(later)).json() == again.json()            # now it is the stored answer

    # The kernel can't be reached mid-turn.
    fake.fail("GET /context/{session_id}?desk_id=", "connect", times=1)
    unreached = agent.sign(agent.body("Do you fix water heaters?"))
    disclosed_error(await agent.post(unreached), 503, "kernel_unavailable")
    model.add(say("Yes, we do."))
    again = await agent.post(unreached)
    assert again.status_code == 200 and again.json()["blocks"][0]["text"] == "Yes, we do."
    said = [words for words, _ in await messages(engine, agent.session_id, "agent_text")]
    assert said.count("And on Saturdays?") == 1 and said.count("Do you fix water heaters?") == 1
    assert {row["status"] for row in await turns(engine)} == {"done"}


async def test_a_lost_check_answer_then_a_resend_gets_a_final_answer(app, browser, fake, kernel_http, model, engine):
    # The kernel checks the reply, which ends the nonce's turn, and its answer is lost: the try says "try later", but
    # the same request can't run again, so sent again it gets a final answer, never `in_progress`.
    agent = await new_agent(app, browser, fake, kernel_http)
    model.add(say("Happy to help."))
    assert (await agent.send("Hello")).status_code == 200
    fake.drop_response("POST /check_reply")
    model.add(say("We're open on weekdays."))
    lost = agent.sign(agent.body("When are you open?"))
    disclosed_error(await agent.post(lost), 503, "kernel_unavailable")
    assert fake.nonces[(agent.issued.agent_key_id, lost.headers["X-Agent-Nonce"])].spent_at is not None
    made, checked = len(model.requests), len(fake.called("POST /check_reply"))

    final = await agent.post(lost)
    disclosed_error(final, 409, "replayed")
    again = await agent.post(lost)
    assert (again.status_code, again.json()) == (final.status_code, final.json())
    assert (len(model.requests), len(fake.called("POST /check_reply"))) == (made, checked)
    (row,) = [row for row in await turns(engine) if row["nonce"] == lost.headers["X-Agent-Nonce"]]
    assert (row["status"], row["http_status"], row["response"]) == ("done", 409, {"code": "replayed",
                                                                                  "disclosure": "ai"})

    # The agent's next request runs as usual.
    model.add(say("Weekdays, eight to six."))
    answered = await agent.send("When are you open?")
    assert answered.status_code == 200 and answered.json()["blocks"][0]["text"] == "Weekdays, eight to six."


async def test_a_failure_while_settling_a_spent_row_leaves_it_to_settle_again(app, browser, fake, kernel_http, model,
                                                                           engine, monkeypatch):
    # Settling a row left to be tried again, once its nonce is spent, is one transaction: a failure part way leaves the
    # row marked as it was, so the next resend still gets the final answer, never `in_progress`.
    agent = await new_agent(app, browser, fake, kernel_http)
    model.add(say("Happy to help."))
    assert (await agent.send("Hello")).status_code == 200
    fake.drop_response("POST /check_reply")
    model.add(say("We're open on weekdays."))
    lost = agent.sign(agent.body("When are you open?"))
    disclosed_error(await agent.post(lost), 503, "kernel_unavailable")
    replied_since = a2a._replied_since

    async def fails(*args, **kwargs):
        raise RuntimeError("the connection dropped")

    monkeypatch.setattr(a2a, "_replied_since", fails)
    with pytest.raises(RuntimeError):
        await agent.post(lost)
    (row,) = [row for row in await turns(engine) if row["nonce"] == lost.headers["X-Agent-Nonce"]]
    assert (row["status"], row["http_status"], row["response"]) == ("running", 503, None)      # still marked

    monkeypatch.setattr(a2a, "_replied_since", replied_since)
    disclosed_error(await agent.post(lost), 409, "replayed")
    (row,) = [row for row in await turns(engine) if row["nonce"] == lost.headers["X-Agent-Nonce"]]
    assert (row["status"], row["http_status"]) == ("done", 409)


async def test_a_spent_nonce_gets_the_checked_reply_its_try_published(app, browser, fake, kernel_http, model, engine):
    # A try that said "try later" although Claude's checked reply reached the session: sent again on the spent nonce,
    # the request's answer is what the session was shown, stored, and the next answer doesn't carry it again.
    agent = await new_agent(app, browser, fake, kernel_http)
    model.add(say("Happy to help."))
    assert (await agent.send("Hello")).status_code == 200
    fake.drop_response("POST /check_reply")
    model.add(say("We're open on weekdays."))
    lost = agent.sign(agent.body("When are you open?"))
    disclosed_error(await agent.post(lost), 503, "kernel_unavailable")
    checker = agent.sign(b"{}")                         # Claude's reply, checked and published as the try's would be
    view = kernel_http.agent(AgentAuth(agent_key_id=agent.issued.agent_key_id, ts=checker.headers["X-Agent-Ts"],
                                       nonce=checker.headers["X-Agent-Nonce"], sig=checker.headers["X-Agent-Sig"]),
                             hashlib.sha256(checker.raw).hexdigest())
    verdict = await view.call("POST /check_reply", CheckReplyRequest(draft=ReplyDraft(
        session_id=agent.session_id, generation=fake.sessions[agent.session_id].generation,
        prose="We're open on weekdays.")))
    async with engine.connect() as conn:
        assert await deliver(conn, ids_of(fake, agent.session_id), Reply(verdict, "claude", "api"),
                             ro_schema="fake_kernel_ro") is not None
        await conn.commit()

    final = await agent.post(lost)
    assert final.status_code == 200 and [block["text"] for block in final.json()["blocks"]] == [
        "We're open on weekdays."]
    again = await agent.post(lost)
    assert (again.status_code, again.json()) == (200, final.json())
    (row,) = [row for row in await turns(engine) if row["nonce"] == lost.headers["X-Agent-Nonce"]]
    assert (row["status"], row["http_status"]) == ("done", 200)
    model.add(say("Anything else?"))
    answered = await agent.send("Thanks")
    assert [block["text"] for block in answered.json()["blocks"]] == ["Anything else?"]


def executions(fake, desk_id: str) -> int:
    """The tool executions the kernel ran on the Desk: each `execute` ledger entry but a repeat, which returns a stored
    result and runs nothing."""
    return sum(1 for entry in fake.desks[desk_id].ledger
               if entry.event.kind == "execute" and not entry.event.summary.get("repeat"))


def weekday_slot(fake, desk_id: str) -> str:
    """The Desk's first weekday slot (in opening hours, so a booking is allowed)."""
    slots = sorted(fake.desks[desk_id].slots.values(), key=lambda slot: slot.starts_at)
    return next(slot.slot_id for slot in slots if slot.starts_at.weekday() < 5)


def tool_results(request) -> dict[str, dict]:
    """Each tool result a model request's messages carry, by its call ID."""
    return {block["tool_use_id"]: json.loads(block["content"]) for message in request.messages
            if isinstance(message["content"], list) for block in message["content"]
            if isinstance(block, dict) and block.get("type") == "tool_result"}


async def test_a_resend_after_a_booking_ran_never_books_again(app, browser, fake, kernel_http, model, engine):
    # The booking was allowed and ran, then the reply check failed: its answer lost after the kernel ended the turn,
    # or the kernel out of reach before it did. Sent again, the request never decides or runs the booking again.
    for lost in ("answer", "connection"):
        agent = await new_agent(app, browser, fake, kernel_http)
        model.add(say("Happy to help."))
        assert (await agent.send("Hello")).status_code == 200
        desk_id = fake.sessions[agent.session_id].desk_id
        model.add(response(tool_use("native__book", {"slot_id": weekday_slot(fake, desk_id), "name": "Jane Doe", "contact": "jane@example.com"}),
                           reply("You're booked.")))
        if lost == "answer":
            fake.drop_response("POST /check_reply")
        else:
            fake.fail("POST /check_reply", "connect", times=1)
        sent = agent.sign(agent.body("Book me the earliest weekday visit."))
        disclosed_error(await agent.post(sent), 503, "kernel_unavailable")
        assert executions(fake, desk_id) == 1, lost
        decided, asked = len(fake.called("POST /decide")), len(model.requests)

        again = await agent.post(sent)
        if lost == "answer":                            # the kernel ended the turn: a final error
            disclosed_error(again, 409, "replayed")
        else:                                           # the turn stood: what it showed, the booking's receipt
            assert again.status_code == 200, again.text
            assert [(receipt["type"], receipt["state"]) for receipt in again.json()["receipts"]] == [
                ("receipt", "executed")]
        assert (executions(fake, desk_id), len(fake.called("POST /decide")), len(model.requests)) == (
            1, decided, asked), lost


async def test_a_resend_after_a_lost_execution_runs_the_booking_once(app, browser, fake, kernel_http, model, engine,
                                                                     monkeypatch):
    # The booking was allowed, then the kernel couldn't be reached to run it, or ran it and both its answer and the
    # reads after it were lost: the try says "try later" and leaves the call open. Sent again, the request finds the
    # call by its ID, never deciding it again: the allow runs once, or the run's stored result comes back, and Claude
    # reads that result before it replies.
    monkeypatch.setattr(tools, "EXECUTE_POLL_S", 0)
    for lost in ("before the run", "after the run"):
        agent = await new_agent(app, browser, fake, kernel_http)
        model.add(say("Happy to help."))
        assert (await agent.send("Hello")).status_code == 200
        desk_id = fake.sessions[agent.session_id].desk_id
        model.add(response(tool_use("native__book", {"slot_id": weekday_slot(fake, desk_id), "name": "Jane Doe", "contact": "jane@example.com"}, id="toolu_book"),
                           reply("You're booked.")))
        if lost == "before the run":
            fake.fail("POST /execute", "connect", times=1)
        else:
            fake.drop_response("POST /execute")
            fake.fail("GET /decisions/{id}", "connect", times=tools.EXECUTE_POLLS)
        sent = agent.sign(agent.body("Book me the earliest weekday visit."))
        disclosed_error(await agent.post(sent), 503, "kernel_unavailable")
        assert executions(fake, desk_id) == (0 if lost == "before the run" else 1), lost
        decided = len(fake.called("POST /decide"))
        looked_up = len(fake.called("GET /decisions/by_call"))

        model.add(say("You're booked for the earliest weekday visit."))
        again = await agent.post(sent)
        assert again.status_code == 200, again.text
        assert [block["text"] for block in again.json()["blocks"]] == ["You're booked for the earliest weekday visit."]
        assert [(receipt["type"], receipt["state"]) for receipt in again.json()["receipts"]] == [
            ("receipt", "executed")], lost
        assert (executions(fake, desk_id), len(fake.called("POST /decide"))) == (1, decided), lost
        assert len(fake.called("GET /decisions/by_call")) == looked_up + 1, lost
        assert tool_results(model.requests[-1])["toolu_book"]["outcome"] == "done", lost


async def booking_left_open(agent: Agent, fake, model, desk_id: str) -> Sent:
    """Send a booking request whose allow's `/execute` can't reach the kernel: the try says "try later" and leaves
    the call open. The request, to send again."""
    model.add(response(tool_use("native__book", {"slot_id": weekday_slot(fake, desk_id), "name": "Jane Doe", "contact": "jane@example.com"}, id="toolu_book"),
                       reply("You're booked.")))
    fake.fail("POST /execute", "connect", times=1)
    sent = agent.sign(agent.body("Book me the earliest weekday visit."))
    disclosed_error(await agent.post(sent), 503, "kernel_unavailable")
    return sent


async def test_a_resumed_call_the_kernel_refuses_is_final(app, browser, fake, kernel_http, model, engine, monkeypatch):
    # A resumed call goes through the same `/execute` as a fresh one, and a refusal is final: never sent again.
    monkeypatch.setattr(tools, "EXECUTE_POLL_S", 0)

    # The owner takes the chat over before the resend: the answer is the owner's, and nothing runs, then or after the
    # hand-back, when the next request answers the call from its decision at the generation it has left.
    agent = await new_agent(app, browser, fake, kernel_http)
    model.add(say("Happy to help."))
    assert (await agent.send("Hello")).status_code == 200
    desk_id = fake.sessions[agent.session_id].desk_id
    sent = await booking_left_open(agent, fake, model, desk_id)
    ran = len(fake.called("POST /execute"))
    fake.set_mode(agent.session_id, "owner")
    taken = await agent.post(sent)
    assert taken.status_code == 200 and taken.json()["blocks"] == []
    assert (await agent.post(sent)).json() == taken.json()                 # final: the stored answer
    fake.set_mode(agent.session_id, "ai")
    model.add(say("Let me know what else you need."))
    assert (await agent.send("Are you there?")).status_code == 200
    assert (executions(fake, desk_id), len(fake.called("POST /execute"))) == (0, ran)
    assert tool_results(model.requests[-1])["toolu_book"]["outcome"] == "unknown"

    # The owner takes over as the resend resumes the call: the kernel refuses its `/execute`, the answer is final,
    # and the call is closed, so the hand-back never sends it again.
    agent = await new_agent(app, browser, fake, kernel_http)
    model.add(say("Happy to help."))
    assert (await agent.send("Hello")).status_code == 200
    desk_id = fake.sessions[agent.session_id].desk_id
    sent = await booking_left_open(agent, fake, model, desk_id)
    by_call = tools._by_call

    async def found_then_taken_over(caller, generation, call_id):
        found = await by_call(caller, generation, call_id)
        fake.set_mode(caller.session_id, "owner")
        return found

    monkeypatch.setattr(tools, "_by_call", found_then_taken_over)
    refused = await agent.post(sent)
    monkeypatch.setattr(tools, "_by_call", by_call)
    assert refused.status_code == 200 and refused.json()["blocks"] == []
    assert (await agent.post(sent)).json() == refused.json()
    tries = len(fake.called("POST /execute"))
    fake.set_mode(agent.session_id, "ai")
    model.add(say("Let me know what else you need."))
    assert (await agent.send("Are you there?")).status_code == 200
    assert executions(fake, desk_id) == 0 and len(fake.called("POST /execute")) == tries
    assert tool_results(model.requests[-1])["toolu_book"]["outcome"] == "not_run"     # refused at execution


def charge_left_open(fake, quote_id: str) -> object:
    """Claude's charge of `quote_id` to the agent's mandate, whose allow's `/execute` can't reach the kernel."""
    def respond(request):
        fake.fail("POST /execute", "connect", times=1)
        return response(tool_use("native__charge_mandate", {"quote_id": quote_id}, id="toolu_charge"),
                        reply("I've taken care of that."))
    return respond


async def quoted_deposit(agent: Agent, fake, model) -> str:
    """Have the Desk quote the service call deposit; its quote's ID."""
    before = set(fake.quotes)
    model.add(response(tool_use("native__quote", {"items": [{"item_id": "deposit", "qty": 1}]})),
              say("Here is the deposit."))
    assert (await agent.send("How much is the deposit?")).status_code == 200
    (quote_id,) = set(fake.quotes) - before
    return quote_id


def committed(fake, agent: Agent) -> int:
    return sum(record.committed_cents for record in fake.mandates.values())


async def test_a_money_call_is_resumed_only_by_the_same_request(app, browser, fake, kernel_http, model, engine,
                                                                monkeypatch):
    # A call that moves money and whose run the API couldn't learn is resumed only by a resend of the request that
    # made it (its nonce and body, the same turn).
    monkeypatch.setattr(tools, "EXECUTE_POLL_S", 0)
    agent = await new_agent(app, browser, fake, kernel_http)
    model.add(say("Happy to help."))
    assert (await agent.send("Hello")).status_code == 200
    quote_id = await quoted_deposit(agent, fake, model)
    model.add(charge_left_open(fake, quote_id))
    sent = agent.sign(agent.body("Please charge the deposit to my spending limit."))
    disclosed_error(await agent.post(sent), 503, "kernel_unavailable")
    assert committed(fake, agent) == 0
    model.add(say("The deposit is paid."))
    again = await agent.post(sent)
    assert again.status_code == 200 and [block["text"] for block in again.json()["blocks"]] == ["The deposit is paid."]
    assert committed(fake, agent) == 2_000
    assert tool_results(model.requests[-1])["toolu_charge"]["outcome"] == "done"

    # Any other request closes it as `unknown`, never sending `/execute`: the decision is left to the pending row and
    # the kernel's reconciliation.
    agent = await new_agent(app, browser, fake, kernel_http)
    model.add(say("Happy to help."))
    assert (await agent.send("Hello")).status_code == 200
    quote_id = await quoted_deposit(agent, fake, model)
    model.add(charge_left_open(fake, quote_id))
    disclosed_error(await agent.send("Please charge the deposit to my spending limit."), 503, "kernel_unavailable")
    (charge,) = [record.decision for record in fake.decisions.values()
                 if record.decision.session_id == agent.session_id and record.decision.action is not None
                 and record.decision.action.tool == "native.charge_mandate"]
    tries = [call for call in fake.called("POST /execute") if call.body["decision_id"] == charge.decision_id]
    model.add(say("I couldn't confirm that charge yet."))
    other = await agent.send("Did the charge go through?")
    assert other.status_code == 200
    assert [call for call in fake.called("POST /execute") if call.body["decision_id"] == charge.decision_id] == tries
    assert tool_results(model.requests[-1])["toolu_charge"]["outcome"] == "unknown"
    assert fake.decisions[charge.decision_id].decision.state == "allowed" and committed(fake, agent) == 2_000


async def test_resent_opening_request_gets_its_session_and_answer(app, browser, fake, kernel_http, model, engine):
    agent = await new_agent(app, browser, fake, kernel_http)
    release = asyncio.Event()
    slow = gated(say("Happy to help."), release)
    model.add(slow)
    sent = agent.sign(agent.body("Hello"))
    first = asyncio.create_task(agent.post(sent))
    await asyncio.wait_for(slow.entered.wait(), 5)

    disclosed_error(await agent.post(sent), 409, "in_progress")
    agent_sessions = [session for session in fake.sessions.values() if session.kind == "agent"]
    assert len(agent_sessions) == 1
    release.set()
    answered = await asyncio.wait_for(first, 5)
    assert answered.status_code == 200 and answered.json()["session_id"] == agent_sessions[0].session_id
    made, decided = len(model.requests), len(fake.called("POST /decide"))

    again = await agent.post(sent)
    assert (again.status_code, again.json()) == (200, answered.json())
    assert [session for session in fake.sessions.values() if session.kind == "agent"] == agent_sessions
    assert (len(model.requests), len(fake.called("POST /decide"))) == (made, decided)
    (opening,) = [row for row in await turns(engine)]
    assert (opening["status"], opening["http_status"]) == ("done", 200)


# Turns that end without Claude's reply -----------------------------------------------------------------------


async def mid_turn(agent: Agent, model: ScriptedModel, message: str) -> tuple[Sent, asyncio.Task, asyncio.Event]:
    """Send `message` and hold Claude's reply until the returned event is set: the request, its task, the event."""
    release = asyncio.Event()
    slow = gated(say("We're open on weekdays."), release)
    model.add(slow)
    sent = agent.sign(agent.body(message))
    task = asyncio.create_task(agent.post(sent))
    await asyncio.wait_for(slow.entered.wait(), 5)
    return sent, task, release


async def test_a_conversation_closed_mid_turn_answers_closed(app, browser, fake, kernel_http, model, engine):
    agent = await new_agent(app, browser, fake, kernel_http)
    model.add(say("Happy to help."))
    assert (await agent.send("Hello")).status_code == 200
    sent, task, release = await mid_turn(agent, model, "When are you open?")

    session = fake.sessions[agent.session_id]          # the conversation is closed while Claude writes
    session.closed_at = fake.now
    fake._put_session(session)
    fake.flush()
    release.set()
    disclosed_error(await asyncio.wait_for(task, 5), 409, "closed")
    disclosed_error(await agent.post(sent), 409, "closed")              # sent again: the stored answer


async def test_turns_that_end_without_a_reply_answer_their_errors(app, browser, fake, kernel_http, model, engine,
                                                                   monkeypatch):
    agent = await new_agent(app, browser, fake, kernel_http)
    model.add(say("Happy to help."))
    assert (await agent.send("Hello")).status_code == 200

    # Busy: a turn already running holds the session past the wait, so the request runs nothing and is 409.
    monkeypatch.setattr(loop, "TURN_LOCK_WAIT_S", 0.2)
    _, task, release = await mid_turn(agent, model, "When are you open?")
    disclosed_error(await agent.send("And on Saturdays?"), 409, "in_progress")
    release.set()
    assert (await asyncio.wait_for(task, 5)).status_code == 200

    # Taken over while Claude writes: the turn is fenced, and the answer is what the session was shown, with no error.
    _, task, release = await mid_turn(agent, model, "Is anyone there?")
    fake.set_mode(agent.session_id, "owner")
    release.set()
    taken = await asyncio.wait_for(task, 5)
    assert taken.status_code == 200 and taken.json()["blocks"] == []
    # Taken over and handed back while Claude writes: the reply is for a generation gone, so 409 stale_generation.
    fake.set_mode(agent.session_id, "ai")
    _, task, release = await mid_turn(agent, model, "Hello again?")
    fake.set_mode(agent.session_id, "owner")
    fake.set_mode(agent.session_id, "ai")
    release.set()
    disclosed_error(await asyncio.wait_for(task, 5), 409, "stale_generation")

    # The kernel ends the nonce's turn under it (it was spent meanwhile): 409 replayed.
    sent, task, release = await mid_turn(agent, model, "Still there?")
    fake.nonces[(agent.issued.agent_key_id, sent.headers["X-Agent-Nonce"])].spent_at = fake.now
    release.set()
    disclosed_error(await asyncio.wait_for(task, 5), 409, "replayed")

    # A spent nonce that never got a turn's row (its request was refused at the key's limit) is 409 replayed, from
    # nothing stored, and runs nothing.
    monkeypatch.setitem(LIMITS, "a2a", Limit(1, 300, "agent_key"))
    limited = agent.sign(agent.body("One more?"))
    disclosed_error(await agent.post(limited), 429, "rate_limited")
    monkeypatch.setitem(LIMITS, "a2a", Limit(30, 300, "agent_key"))
    fake.nonces[(agent.issued.agent_key_id, limited.headers["X-Agent-Nonce"])].spent_at = fake.now
    stored = await turns(engine)
    made = len(model.requests)
    disclosed_error(await agent.post(limited), 409, "replayed")
    assert await turns(engine) == stored and len(model.requests) == made


# Codes and the owner -----------------------------------------------------------------------------------------


async def test_verify_code_goes_only_to_the_kernel(app, browser, fake, kernel_http, model, engine, db, caplog):
    caplog.set_level(logging.DEBUG)
    agent = await new_agent(app, browser, fake, kernel_http)
    model.add(response(tool_use("native__start_verification", {"contact": DANA}),
                       reply("I've sent a code to the contact on record.", {"template": "verify_prompt"})))
    assert (await agent.send("I'm asking for Dana Whitfield's invoice")).status_code == 200
    (code,) = [entry.body.split(" code is ")[1][:6] for _, entry in fake.inbox if entry.kind == "verification_code"]
    wrong = f"{(int(code) + 1) % 1_000_000:06d}"

    disclosed_error(await agent.send("Here is the code", verify_code=wrong), 422, "invalid")
    assert len(model.requests) == 1
    model.add(say("Thanks, you're confirmed."))
    fake.calls.clear()
    confirmed = await agent.send("Here is the code", verify_code=code)
    assert confirmed.status_code == 200
    (check,) = fake.called("POST /verify/check")
    assert check.body == {"session_id": agent.session_id, "code": code}
    assert check.headers["x-agent-key-id"] == agent.issued.agent_key_id
    assert fake.sessions[agent.session_id].verified
    sent_to_claude = json.dumps([request.messages for request in model.requests])
    assert NOTES["verified"] in sent_to_claude
    for place in (sent_to_claude, at_rest(db), json.dumps(await sse(engine, agent.session_id)), caplog.text):
        assert code not in place and wrong not in place


async def test_an_agents_verified_note_is_written_once(app, browser, fake, kernel_http, model, engine, monkeypatch):
    agent = await new_agent(app, browser, fake, kernel_http)
    model.add(response(tool_use("native__start_verification", {"contact": DANA}),
                       reply("I've sent a code to the contact on record.", {"template": "verify_prompt"})))
    assert (await agent.send("I'm asking for Dana Whitfield's invoice")).status_code == 200
    (code,) = [entry.body.split(" code is ")[1][:6] for _, entry in fake.inbox if entry.kind == "verification_code"]

    # The kernel verifies the session, then the note can't be written: the request answers 500, and nothing is noted.
    with notes_fail(monkeypatch):
        disclosed_error(await agent.send("Here is the code", verify_code=code), 500, "internal")
    assert fake.sessions[agent.session_id].verified and await conversation_notes(
        engine, agent.session_id, "text", "wake") == []

    # Sent again under a new nonce, the kernel answers that the session is verified: the note is written now, and
    # Claude reads it. Once noted, it isn't again.
    model.add(say("Thanks, you're confirmed."), say("You're all set."))
    assert (await agent.send("Here is the code", verify_code=code)).status_code == 200
    assert NOTES["verified"] in model_text(model.requests[-1])
    assert (await agent.send("Here it is again", verify_code=code)).status_code == 200
    assert await conversation_notes(engine, agent.session_id, "text", "wake") == [
        (NOTES["verified"], True)]


async def test_mode_owner_answers_with_the_owners_blocks(app, browser, fake, kernel_http, model, engine):
    agent = await new_agent(app, browser, fake, kernel_http)
    model.add(say("Happy to help."))
    assert (await agent.send("Hello")).status_code == 200
    fake.set_mode(agent.session_id, "owner")
    await owner_says(engine, fake, agent.session_id, "Hi, this is Mike. How can I help?")

    taken = await agent.send("Is someone there?")
    assert taken.status_code == 200
    assert [(block["template"], block["title"], block["text"]) for block in taken.json()["blocks"]] == [
        ("owner_said", "Hi, this is Mike. How can I help?", "Hi, this is Mike. How can I help?")]
    assert taken.json()["receipts"] == [] and len(model.requests) == 1
    assert await messages(engine, agent.session_id, "agent_text") == [("Hello", True), ("Is someone there?", False)]

    fake.set_mode(agent.session_id, "ai")
    fake.set_mode(agent.session_id, "paused")
    paused = await agent.send("Hello again")
    assert paused.status_code == 200
    assert [block["template"] for block in paused.json()["blocks"]] == ["handoff"]
    assert len(model.requests) == 1


# The turn's language (GitHub issue #121) --------------------------------------------------------------------------


async def test_an_agents_message_starts_its_turn_in_the_kernel(app, browser, fake, kernel_http, model, engine):
    """An agent's turn runs through the same loop as a visitor's: the message the agent signed goes to
    `POST /sessions/{session_id}/turn` under the request's own signature, once and before `/context`, so the
    kernel speaks the agent's language in the turn's receipts."""
    agent = await new_agent(app, browser, fake, kernel_http)
    model.add(say("Happy to help."))
    assert (await agent.send("Hello, can you help with a water heater?")).status_code == 200
    message = "Hola, ¿pueden revisar mi calentador mañana?"
    model.add(response(tool_use("native__find_slots", {"days": 3})), say("Tengo horarios mañana por la mañana."))
    sent = agent.sign(agent.body(message))
    fake.calls.clear()

    assert (await agent.post(sent)).status_code == 200

    (turn,) = fake.called("POST /sessions/{session_id}/turn")
    assert turn.path == f"/sessions/{agent.session_id}/turn"
    assert turn.body == {"generation": fake.sessions[agent.session_id].generation, "text": message, "desk_id": None}
    assert turn.headers["x-agent-nonce"] == sent.headers["X-Agent-Nonce"] and "x-session-token" not in turn.headers
    routes = [call.route for call in fake.calls]
    assert routes.index("POST /sessions/{session_id}/turn") < routes.index("GET /context/{session_id}?desk_id=")
    assert routes.index("GET /context/{session_id}?desk_id=") < routes.index("POST /decide")
    (receipt,) = [payload for _, type, payload in await sse(engine, agent.session_id) if type == "receipt"]
    assert receipt["visitor_plain"] == "Horarios tomados del calendario de Mike Turner"
