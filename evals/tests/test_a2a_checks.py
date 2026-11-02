"""Plan 02b's A2A cases (`evals/tier1/test_02_a2a.py`), each run whole over a stand-in API.

The cases run on tier 1's API target (`--target api`), over Plan 01c's signed agent sessions and
nonces in the kernel and Plan 02b's A2A endpoint. These tests show each case failing on the fault it
exists to catch: they run each case as tier 1 would, over an in-memory stand-in for the A2A endpoint
and the kernel's agent rules behind it (the master plan's "Agent sessions": a signature checked
against the key it names, a nonce bound per key to one session and one body, an answer stored by
key, session and nonce), whose Claude is a real `FakeAnthropic` on loopback. Each case passes over
the faithful stand-in, and fails once the stand-in has a fault the case exists to catch, with the
failure its oracle names. A Claude call too many in a turn before a case's snapshot passes the
case's own checks, so they show the fake model server's check failing on it. They also pin the cases'
helpers: the translation stand-in, the calls `turn_calls` counts and the rows `session_rows`
compares. Nothing here calls the network or a live model.
"""

import asyncio
import hashlib
import json
import secrets
from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
import rfc8785
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from pydantic import ValidationError
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from desk.api.model import ModelRequest, build_kwargs, parse_structured, strict_schema
from desk.api.prompts import Translation
from desk.api.triage import ANNOTATION_MODEL, TRANSLATION_MAX_TOKENS, TRANSLATION_ROUTE, triage_request
from desk.contracts import A2ARequest, CopyCreated, DemoAgentIssued, Mandate, RenderedBlock
from desk.events import A2AResponse
from desk.kernel_service.decisions import (
    REVIEW_SCHEMA,
    SOFT_PROMISE_SCHEMA,
    WEB_SEARCH_MAX_TOKENS,
    WEB_SEARCH_MODEL,
    WEB_SEARCH_SYSTEM,
)
from evals.fakes import FakeAnthropic, LoopbackServer
from evals.tier1 import test_02_a2a as a2a
from evals.tier1.harness import Auth, Expect, TravelClock
from evals.tier1.stub import ContractStub
from evals.tier1.targets import SOFT_PROMISE_MODEL

FAULTS = (
    "unverified",                 # any signature passes
    "session_before_signature",   # an opening request makes its session before its signature is checked
    "nonce_ignores_body",         # a nonce reused under another body counts as the same request sent again
    "foreign_session",            # a request may name a session the kernel bound to another key
    "refuses_late",               # a refused nonce or session is refused only after the message is stored and Claude ran
    "nonce_by_text",              # nonces and stored answers are keyed by the nonce's text alone, for every key
    "rerun_resent",               # a request sent again runs a new turn instead of getting its stored answer
    "rerun_quietly",              # a request sent again gets its stored answer, but its turn runs again anyway
    "surplus_call",               # one turn calls Claude once more after its reply, and drops the answer
)
MAX_CALLS = 4   # Claude's calls in one stand-in turn before it gives up on a reply


class TurnFailed(Exception):
    """The stand-in's Claude gave no reply: the fake model server answered an error or no `send_reply`."""


def refusal(status: int, code: str) -> JSONResponse:
    return JSONResponse({"code": code, "disclosure": "ai"}, status_code=status)


class StandInDesk:
    """The A2A endpoint and the kernel's agent rules behind it, in memory, with at most one of `FAULTS`.

    A request's signature is checked over `{desk_slug, ts, nonce, body_sha256}` (canonical JSON) with
    the public key its `X-Agent-Key-Id` names, as the kernel checks it. A nonce is bound at its first
    use, per key, to one session and one body hash: the same request again gets its stored answer,
    and any other reuse is 401. An opening request opens a session bound to its key, and a request
    naming a session bound to another key is 401. A turn calls the fake model server until Claude's
    `send_reply`; each other tool call is a decision. With `surplus_call`, its `surplus_turn`th turn
    calls once more after the reply. What it keeps is what `StandInRecords` reads."""

    def __init__(self, fake: FakeAnthropic, fault: str | None = None, surplus_turn: int = 1):
        if fault is not None and fault not in FAULTS:
            raise ValueError(f"unknown fault {fault!r}; the faults are {list(FAULTS)}")
        self.fake, self.fault, self.surplus_turn = fake, fault, surplus_turn
        self.turns = 0
        self.keys: dict[str, Ed25519PublicKey] = {}
        self.sessions: dict[str, str] = {}                                  # session id -> the key it is bound to
        self.nonces: dict[tuple[str | None, str], tuple[str, str]] = {}     # (key, nonce) -> (session id, body hash)
        self.answers: dict[tuple[str | None, str, str], dict] = {}          # (key, session id, nonce) -> A2AResponse
        self.decisions: list[dict[str, str]] = []
        self.messages: list[dict[str, str]] = []
        self.app = Starlette(routes=[Route("/api/a2a/{desk_slug}", self.a2a, methods=["POST"])])

    def mint(self, desk_id: str) -> DemoAgentIssued:
        """A demo agent: a fresh Ed25519 key, named by the first 16 hex of its public key's sha256."""
        key = Ed25519PrivateKey.generate()
        key_id = hashlib.sha256(key.public_key().public_bytes_raw()).hexdigest()[:16]
        self.keys[key_id] = key.public_key()
        mandate = Mandate(mandate_id=f"mandate-{key_id}", issuer="demo-wallet", agent_key_id=key_id, desk_id=desk_id,
                          allowed_effects=["charge"], per_charge_cents=2_000, total_cents=10_000, currency="usd",
                          expires_at="2026-11-03T19:00:00.000000Z", nonce=secrets.token_hex(8), sig="00" * 64)
        return DemoAgentIssued(agent_key_id=key_id, agent_private_key_hex=key.private_bytes_raw().hex(), mandate=mandate)

    async def a2a(self, request: Request) -> JSONResponse:
        raw = await request.body()
        try:
            body = A2ARequest.model_validate_json(raw)
        except ValidationError:
            return refusal(400, "invalid")
        if body.desk_slug != request.path_params["desk_slug"]:
            return refusal(400, "invalid")
        key_id, nonce = request.headers.get("x-agent-key-id", ""), request.headers.get("x-agent-nonce", "")
        digest = hashlib.sha256(raw).hexdigest()
        if body.session_id is None and self.fault == "session_before_signature":
            self.sessions[f"agent-session-{len(self.sessions) + 1}"] = key_id
        if not self.signed(key_id, body.desk_slug, request.headers, digest):
            return refusal(401, "auth")
        holder = None if self.fault == "nonce_by_text" else key_id
        bound = self.nonces.get((holder, nonce))
        if bound is not None:
            session_id, bound_digest = bound
            if bound_digest != digest and self.fault != "nonce_ignores_body":
                return await self.refuse(session_id, body.message)
            if self.fault != "rerun_resent":
                stored = self.answers.get((holder, session_id, nonce))
                if stored is not None and self.fault == "rerun_quietly":
                    await self.quiet_turn(session_id, body.message)
                return JSONResponse(stored) if stored is not None else refusal(409, "replayed")
        elif body.session_id is None:
            session_id = f"agent-session-{len(self.sessions) + 1}"
            self.sessions[session_id] = key_id
        else:
            session_id = body.session_id
            if session_id not in self.sessions:
                return refusal(401, "auth")
            if self.sessions[session_id] != key_id and self.fault != "foreign_session":
                return await self.refuse(session_id, body.message)
        self.nonces[(holder, nonce)] = (session_id, digest)
        self.messages.append({"session_id": session_id, "kind": "agent_text", "text": body.message})
        try:
            blocks = await self.turn(session_id, body.message)
        except TurnFailed:
            return refusal(500, "internal")
        answer = A2AResponse(session_id=session_id, disclosure="ai", blocks=blocks, receipts=[]).model_dump(mode="json")
        self.answers[(holder, session_id, nonce)] = answer
        return JSONResponse(answer)

    def signed(self, key_id: str, slug: str, headers: Any, digest: str) -> bool:
        if self.fault == "unverified":
            return True
        key = self.keys.get(key_id)
        if key is None:
            return False
        signed = rfc8785.dumps({"desk_slug": slug, "ts": headers.get("x-agent-ts", ""),
                                "nonce": headers.get("x-agent-nonce", ""), "body_sha256": digest})
        try:
            key.verify(bytes.fromhex(headers.get("x-agent-sig", "")), signed)
        except (InvalidSignature, ValueError):
            return False
        return True

    async def refuse(self, session_id: str, message: str) -> JSONResponse:
        """401 for a nonce reused under another body or a session bound to another key; with `refuses_late`,
        only after the message was stored in the session and Claude ran on it."""
        if self.fault == "refuses_late":
            self.messages.append({"session_id": session_id, "kind": "agent_text", "text": message})
            await self.quiet_turn(session_id, message)
        return refusal(401, "auth")

    async def quiet_turn(self, session_id: str, message: str) -> None:
        """Claude's turn on `message`, for a fault: what it answers dropped, and a turn that fails ignored."""
        try:
            await self.turn(session_id, message)
        except TurnFailed:
            pass

    async def turn(self, session_id: str, message: str) -> list[RenderedBlock]:
        """Claude's turn on the fake model server: its replies until `send_reply`, each other tool call a decision."""
        self.turns += 1
        async with httpx.AsyncClient(base_url=self.fake.url, timeout=10, trust_env=False) as http:
            for _ in range(MAX_CALLS):
                answer = await ask_claude(http, message)
                if answer.status_code != 200:
                    raise TurnFailed
                uses = [block for block in answer.json()["content"] if block.get("type") == "tool_use"]
                if not uses:
                    raise TurnFailed
                if uses[0]["name"] == "send_reply":
                    if self.fault == "surplus_call" and self.turns == self.surplus_turn:
                        await ask_claude(http, message)   # one call too many, whatever it answers dropped
                    return [RenderedBlock(kind="prose", text=uses[0]["input"]["prose"])]
                self.decisions.append({"decision_id": f"decision-{len(self.decisions) + 1}", "session_id": session_id,
                                       "tool": uses[0]["name"].replace("__", ".")})
        raise TurnFailed


async def ask_claude(http: httpx.AsyncClient, message: str) -> httpx.Response:
    return await http.post("/v1/messages", json={
        "model": a2a.OPUS, "max_tokens": 64, "messages": [{"role": "user", "content": message}]})


class StandInRecords:
    """What the stand-in keeps, read as `Records` reads the real stack's rows."""

    def __init__(self, desk: StandInDesk):
        self.desk = desk

    async def sessions(self, copy_id: str) -> list[dict]:
        return [{"session_id": session_id, "kind": "agent", "agent_key_id": key_id}
                for session_id, key_id in self.desk.sessions.items()]

    async def decisions(self, copy_id: str) -> list[dict]:
        return [dict(row) for row in self.desk.decisions]

    async def a2a_turns(self, session_id: str) -> list[dict]:
        return [{"agent_key_id": key_id, "session_id": session, "nonce": nonce, "status": "done"}
                for key_id, session, nonce in self.desk.answers if session == session_id]

    async def app_rows(self, session_id: str) -> str:
        rows = [("messages", row) for row in self.desk.messages if row["session_id"] == session_id]
        rows += [("a2a_turns", row) for row in await self.a2a_turns(session_id)]
        return "\n".join(f"app.{table} {json.dumps(row, sort_keys=True)}" for table, row in rows)


class StandInKernel:
    """The kernel as the cases call it: a copy (the contract stub's), demo agents the stand-in knows, a clock."""

    is_real = False

    def __init__(self, desk: StandInDesk):
        self.desk, self.clock, self.responses = desk, TravelClock(), []

    def landed(self, plan: str) -> bool:
        return True

    async def new_copy(self) -> CopyCreated:
        return await ContractStub().new_copy()

    async def call(self, route: str, *, path: Any = None, query: Any = None, body: Any = None, raw_body: Any = None,
                   auth: Auth, expect: Expect = Expect()) -> Any:
        assert route == "POST /agents/demo", f"the stand-in kernel answers only POST /agents/demo, not {route}"
        return self.desk.mint(body["desk_id"])


@asynccontextmanager
async def world(fault: str | None = None, surplus_turn: int = 1):
    """A case's fixtures over the stand-in: `k`, `api`, `fake` and `records`."""
    fake = FakeAnthropic().start()
    desk = StandInDesk(fake, fault, surplus_turn)
    server = LoopbackServer(desk.app, name="stand-in A2A endpoint")
    try:
        await asyncio.to_thread(server.start)
        yield StandInKernel(desk), SimpleNamespace(base_url=server.url, passcode="a stand-in passcode"), fake, \
            StandInRecords(desk)
    finally:
        await asyncio.to_thread(server.stop)
        fake.stop()


CASES = {
    "forged_a2a_signature": a2a.test_forged_a2a_signature,
    "replayed_a2a_nonce_other_body": a2a.test_replayed_a2a_nonce_other_body,
    "a2a_other_agents_session": a2a.test_a2a_other_agents_session,
    "a2a_nonce_reused_by_another_agent": a2a.test_a2a_nonce_reused_by_another_agent,
    "a2a_resent_after_its_turn": a2a.test_a2a_resent_after_its_turn,
}

# Each case with a fault it exists to catch, and the start of the failure its oracle gives.
CAUGHT = [
    ("forged_a2a_signature", "unverified", "an opening request signed by a key the kernel never issued answered 200"),
    ("forged_a2a_signature", "session_before_signature", "a forged opening request created an agent session"),
    ("replayed_a2a_nonce_other_body", "nonce_ignores_body", "its nonce reused under another body, naming its session, "
                                                            "answered 200"),
    ("replayed_a2a_nonce_other_body", "refuses_late", "a request under a reused nonce was decided"),
    ("a2a_other_agents_session", "foreign_session", "the second agent's request naming the first agent's session "
                                                    "answered 500"),
    ("a2a_other_agents_session", "refuses_late", "the refused request wrote app.* rows naming the first agent's session"),
    ("a2a_nonce_reused_by_another_agent", "nonce_by_text", "the second agent's answer holds the first agent's"),
    ("a2a_resent_after_its_turn", "rerun_resent", "the opening request sent again answered 500, not its stored answer"),
    ("a2a_resent_after_its_turn", "rerun_quietly", "a request sent again was decided"),
]

# Each case whose Claude goes on answering once its script has run out (`any_further_turn_decides`), with its
# last turn before its snapshot: a stand-in with `surplus_call` ends that turn with one Claude call too many.
SURPLUS = [
    ("replayed_a2a_nonce_other_body", 1),   # the opening request's turn
    ("a2a_resent_after_its_turn", 2),       # the turn that looked for open slots
]


def test_every_case_and_fault_is_exercised():
    assert {name for name, _, _ in CAUGHT} == set(CASES)
    assert {fault for _, fault, _ in CAUGHT} | {"surplus_call"} == set(FAULTS)   # SURPLUS runs surplus_call


@pytest.mark.parametrize("name", CASES)
async def test_each_case_passes_over_the_faithful_stand_in(name: str):
    async with world() as (k, api, fake, records):
        await CASES[name](k, api, fake, records)
    fake.check()   # every reply the case scripted was used, and no call went unscripted


@pytest.mark.parametrize(("name", "fault", "failure"), CAUGHT, ids=[f"{name}-{fault}" for name, fault, _ in CAUGHT])
async def test_each_case_fails_on_the_fault_it_exists_to_catch(name: str, fault: str, failure: str):
    async with world(fault) as (k, api, fake, records):
        with pytest.raises(AssertionError) as caught:
            await CASES[name](k, api, fake, records)
    assert str(caught.value).startswith(failure), str(caught.value)


@pytest.mark.parametrize(("name", "turn"), SURPLUS, ids=[name for name, _ in SURPLUS])
async def test_a_surplus_claude_call_before_the_snapshot_fails_the_fake_model_servers_check(name: str, turn: int):
    """A Claude call too many in a turn before the case's snapshot passes the case's own checks, which compare only
    what came after it, so the fake model server's check is what fails on it: Claude's default answer, set only
    once the case has taken its snapshot, leaves the call unscripted."""
    async with world("surplus_call", surplus_turn=turn) as (k, api, fake, records):
        await CASES[name](k, api, fake, records)
    with pytest.raises(AssertionError) as caught:
        fake.check()
    assert str(caught.value) == f"1 unscripted model calls reached the fake model server ({a2a.OPUS})"


class RowsOf:
    """`Records.app_rows` for one session, from crafted rows."""

    def __init__(self, rows: list[tuple[str, dict]]):
        self.rows = rows

    async def app_rows(self, session_id: str) -> str:
        return "\n".join(f"app.{table} {json.dumps(row, sort_keys=True)}" for table, row in self.rows)


async def post(fake: FakeAnthropic, body: dict) -> httpx.Response:
    async with httpx.AsyncClient(base_url=fake.url, timeout=10, trust_env=False) as http:
        return await http.post("/v1/messages", json=body)


def structured(model: str, schema: dict) -> dict:
    """A structured call to `model` as the kernel's checks send one: the answer's JSON schema in `output_config`."""
    return {"model": model, "max_tokens": 64, "messages": [{"role": "user", "content": "{}"}],
            "output_config": {"effort": "low", "format": {"type": "json_schema", "schema": schema}}}


async def test_the_checks_answer_the_apis_translation_with_english():
    """`script_the_checks` answers the owner's translation as the API asks for it (`triage.translate_message`'s model
    and schema) with a `Translation` finding English, so the job stores nothing."""
    fake = FakeAnthropic().start()
    try:
        a2a.script_the_checks(fake)
        answer = await post(fake, build_kwargs(ModelRequest(
            route=TRANSLATION_ROUTE, system=[{"type": "text", "text": "Translate the message."}],
            messages=[{"role": "user", "content": a2a.HELLO}], model=ANNOTATION_MODEL, effort="low",
            max_tokens=TRANSLATION_MAX_TOKENS, output_schema=Translation)))
    finally:
        fake.stop()
    assert answer.status_code == 200, answer.text
    [block] = answer.json()["content"]
    assert parse_structured(Translation, block["text"]) == Translation(language="en", translation="")


async def test_turn_calls_count_claude_the_reviewer_and_the_soft_promise_check_once_each():
    """`turn_calls` counts Claude's calls and the kernel's checks', each once, though the reviewer and the soft-promise
    check share a model; the owner's translation isn't a turn's call."""
    fake = FakeAnthropic().start()
    try:
        for body in ({"model": a2a.OPUS, "max_tokens": 64, "messages": [{"role": "user", "content": a2a.HELLO}]},
                     structured(a2a.REVIEWER_MODEL, REVIEW_SCHEMA),
                     structured(SOFT_PROMISE_MODEL, SOFT_PROMISE_SCHEMA),
                     structured(ANNOTATION_MODEL, strict_schema(Translation))):
            await post(fake, body)   # unscripted, so each is answered 500, and each is kept as a call
        assert len(fake.calls()) == 4
        assert a2a.turn_calls(fake) == 3
    finally:
        fake.stop()


async def test_turn_calls_count_every_call_but_the_owners_annotation_jobs():
    """A turn's call that is neither Claude's nor one of the kernel's checks, the kernel's web search on Sonnet here,
    still counts: only the owner's annotation jobs, translation and triage on Haiku, are left out."""
    fake = FakeAnthropic().start()
    try:
        await post(fake, {   # as the kernel's `web_search` sends it: tools, but no structured answer
            "model": WEB_SEARCH_MODEL, "max_tokens": WEB_SEARCH_MAX_TOKENS, "system": WEB_SEARCH_SYSTEM,
            "messages": [{"role": "user", "content": "<query>emergency plumber opening hours</query>"}],
            "tools": [{"type": "web_search_20260209", "name": "web_search", "max_uses": 1}],
            "thinking": {"type": "between_tools"}})
        assert a2a.turn_calls(fake) == 1
        await post(fake, build_kwargs(triage_request({"tool": "native.find_slots", "effect": "deny"}, None)))
        assert len(fake.calls()) == 2
        assert a2a.turn_calls(fake) == 1
    finally:
        fake.stop()


async def test_session_rows_leave_out_only_the_annotation_jobs_usage():
    """The owner's translation and triage jobs write their usage rows beside the turns, whenever the job worker gets
    to them, so a comparison leaves those out; every other row, a conversation call's usage included, counts."""
    rows = [("messages", {"n": 1, "kind": "agent_text"}), ("model_calls", {"route": "conversation"}),
            ("model_calls", {"route": "translation"}), ("model_calls", {"route": "triage"}),
            ("a2a_turns", {"nonce": "n-1", "status": "done"}), ("run_events", {"seq": 3, "kind": "sse"})]
    kept = await a2a.session_rows(RowsOf(rows), "s-1")
    assert [line.split(" ", 1)[0] for line in kept] == [
        "app.messages", "app.model_calls", "app.a2a_turns", "app.run_events"]
    assert '"conversation"' in kept[1]
