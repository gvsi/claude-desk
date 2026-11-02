"""The built-in visiting agent (Plan 02b, Task 5; master plan, "Trust boundary": the simulated third party).

A visitor on a Desk's public page can send Alex Kim's assistant, an AI agent this process runs, to do one of three
tasks on the Desk (`DEMO_TASKS`): book, pay up front within its spending limit, or ask for a charge above that limit.
Each task is a fixed line from the Desk's set (plan 09, C2): code picks it by the business type setup stored for the
Desk, or Turner's for the copy's own Desk (`demo_task_set`), so the agent asks a CPA's Desk for a consult and a
landlord's for a viewing, and no business's, owner's or visitor's words reach its model through its task. The kernel
mints the agent for the visitor's session (`POST /agents/demo`): an Ed25519 key and a spending limit (a mandate) its
demo wallet signs.

The agent talks to the Desk as another person's agent would: as a separate client of the public A2A endpoint
(`settings.a2a_loopback`), signing each request with its key, so the kernel checks every signature, binds every
nonce and bounds every charge by the mandate exactly as for any agent. `run_demo_agent` holds the key, which exists
in that coroutine alone: never in the run's record, the database, a log or a model request. (The API process holds
it in memory meanwhile, so the signature protects external agents, not this one, against the API process: master
plan, "Trust boundary".)

Each step is one structured model call (route `visiting_agent`, low effort, `AgentStep`), at most six a run, each but
a final `done` followed by one A2A request. The Desk's answer reaches the agent's model only inside `<desk_reply>`
(`prompts.wrap`), as information. A model that can't answer, an A2A answer other than a 200 `A2AResponse`, an issued
key that isn't one or, in production, today's model budget spent before a step ends the run `failed`.

What the launcher's panel reads (`DemoAgentRun`): each exchange as the agent's turn, carrying the message it signed
and sent, exactly as sent (the agent's own untrusted words, echoed to its launcher as a visitor's own message is, and
shown quoted as the agent's: owner decision, 2026-11-01), then the Desk's, with the blocks and signed statuses the
kernel checked and no text of its own. Runs live in this process's memory (`DemoAgents`): the 50 newest, for an hour,
each readable by its launching session alone.

Each send carries the client's idempotency key (one per click, required) and claims it in the copy before the kernel
mints the agent (`DemoAgents.claim`, which checks and takes it with no await between, so of two requests racing in the
process one takes it): a repeat answers the run the first started and starts nothing; one for another task, or from
another session or to another Desk than the key's, is `KeyReused`. A run whose agent the kernel refused to mint (a
4xx) ends `failed` and frees its key, since nothing was made, so the same request can be sent again; a mint that went
unanswered may have happened, so that failed run keeps its key, as does a run that started, however it ends. Keys
live in memory beside the runs, in a map of their own that keeps each for its run's hour, so a key outlives a run
record the 50-run bound dropped: its repeat answers the same run ID, whose poll is then 404, and never starts a second
run. The map holds at most 1000 and never drops a key early: full, it refuses a new one (`KeysFull`) until the oldest
key's hour ends. Like the runs, keys are this process's alone: a process restart, or a repeat routed to the other task
during a deploy's overlap, forgets them.
"""

import asyncio
import hashlib
import json
import logging
import math
import secrets
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import get_args
from urllib.parse import quote

import httpx
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from desk.api.idempotency import Admissions
from desk.api.metrics import over_daily_budget, record_model_call
from desk.api.model import CONVERSATION_MODEL, ModelClient, ModelRequest, ModelResponse, ModelUnavailable
from desk.api.prompts import (
    DESK_REPLY_TAG,
    VISITING_AGENT_SYSTEM,
    AgentStep,
    BusinessType,
    DemoTask,
    DemoTaskSet,
    agent_task,
    desk_reply_text,
    wrap,
)
from desk.api.ro import KernelRO
from desk.api.schemas import AgentTurn, DemoAgentRun
from desk.api.settings import Settings
from desk.api.store import Ids
from desk.contracts import A2ARequest, DemoAgentIssued
from desk.db.models import SetupInterview
from desk.events import A2AResponse

logger = logging.getLogger(__name__)

ROUTE = "visiting_agent"
MAX_EXCHANGES = 6               # model calls a run, and so A2A requests
MAX_TOKENS = 1024               # one short message as JSON
MAX_RUNS = 50
MAX_KEYS = 1000                 # the idempotency keys held at once, each for its run's hour
RUN_LIFE = timedelta(hours=1)
A2A_TIMEOUT_S = 120.0           # an answer waits for the Desk's turn: up to 30 s for the session's lock, then the turn

Record = Callable[[ModelResponse], Awaitable[None]]
Spent = Callable[[], Awaitable[bool]]
INTERVIEWS = SetupInterview.__table__
BUSINESS_TYPES: frozenset[str] = frozenset(get_args(BusinessType))


class RunFailed(Exception):
    """The run can't go on; the message says why without any of the Desk's or the model's text."""


class KeyReused(Exception):
    """The idempotency key's first request in the copy had another body, or came from another session or to another
    Desk."""


class KeysFull(Exception):
    """The key map holds `MAX_KEYS` keys, none of them past its hour: a new one fits in `retry_after` seconds."""

    def __init__(self, retry_after: int):
        super().__init__(f"the key map is full for {retry_after} s")
        self.retry_after = retry_after


@dataclass(frozen=True)
class HeldKey:
    """An idempotency key a request took in its copy: the run it started, the request's hash, the session that sent
    it, the Desk it went to and when it was claimed. A visitor session belongs to one Desk, so the session alone
    already ties the key to its Desk; `slug` is kept as defence in depth."""

    run_id: str
    request_sha256: str
    session_id: str
    slug: str
    claimed_at: datetime


# Signing ------------------------------------------------------------------------------------------------------


def signed_time(moment: datetime) -> str:
    """A `SignedTime`: RFC 3339 UTC with microseconds and "Z"."""
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def signature_payload(desk_slug: str, ts: str, nonce: str, body_sha256: str) -> bytes:
    """What an agent signs ("Agent sessions"): `{desk_slug, ts, nonce, body_sha256}` as sorted, compact JSON, which
    for ASCII values is their RFC 8785 form; a value that isn't ASCII is refused rather than signed differently."""
    fields = {"desk_slug": desk_slug, "ts": ts, "nonce": nonce, "body_sha256": body_sha256}
    if not all(value.isascii() for value in fields.values()):
        raise RunFailed("a signed field isn't ASCII")
    return json.dumps(fields, sort_keys=True, separators=(",", ":")).encode()


def signed_headers(key: Ed25519PrivateKey, agent_key_id: str, desk_slug: str, raw: bytes, ts: str,
                   nonce: str) -> dict[str, str]:
    """The `AgentAuth` headers of one request: its Ed25519 signature, in lowercase hex, over the raw body's hash."""
    sig = key.sign(signature_payload(desk_slug, ts, nonce, hashlib.sha256(raw).hexdigest())).hex()
    return {"Content-Type": "application/json", "X-Agent-Key-Id": agent_key_id, "X-Agent-Ts": ts,
            "X-Agent-Nonce": nonce, "X-Agent-Sig": sig}


# Which task lines -----------------------------------------------------------------------------------------------


async def demo_task_set(conn: AsyncConnection, ro: KernelRO, desk_id: str) -> DemoTaskSet:
    """Which fixed task lines the agent reads on the Desk (`DEMO_TASKS`): the business type setup stored for it, on the
    newest of the copy's setup interviews that made it (`other` when that one has none); with no such interview, the
    copy's own Desk, its oldest (the Turner seed), reads `rivera` and any other `other`. Only that closed type and which
    Desk is the copy's oldest decide the set; no business's, owner's or visitor's words reach the agent."""
    found = await conn.execute(select(INTERVIEWS.c.business_type).where(
        INTERVIEWS.c.copy_id == ro.copy_id, INTERVIEWS.c.desk_id == desk_id).order_by(
        INTERVIEWS.c.created_at.desc(), INTERVIEWS.c.interview_id.desc()).limit(1))
    row = found.first()
    if row is not None:
        return row.business_type if row.business_type in BUSINESS_TYPES else "other"
    desks = await ro.desks()
    return "rivera" if desks and desks[0]["desk_id"] == desk_id else "other"


async def demo_tasks(ro: KernelRO, desk_id: str) -> list[DemoTask]:
    """The page's tasks in order: booking always, payments only with an enabled agent payment tool."""
    enabled = {row["tool"] for row in await ro.rows("tools", desk_id=desk_id, status="enabled")}
    if enabled & {"native.payment_link", "native.charge_mandate"}:
        return ["book_visit", "quote_and_deposit", "push_the_limit"]
    return ["book_visit"]


# One run ------------------------------------------------------------------------------------------------------


def _private_key(hex_key: str) -> Ed25519PrivateKey:
    """The issued Ed25519 key; `RunFailed`, naming none of it, when it isn't one."""
    try:
        return Ed25519PrivateKey.from_private_bytes(bytes.fromhex(hex_key))
    except (ValueError, TypeError):
        raise RunFailed("the issued key isn't an Ed25519 key") from None


def _user(text: str) -> dict:
    return {"role": "user", "content": [{"type": "text", "text": text}]}


async def _step(model: ModelClient, messages: list[dict], record: Record) -> AgentStep:
    """The agent's next step, its usage recorded right after the call; `ModelUnavailable` when there is none."""
    request = ModelRequest(route=ROUTE, system=[{"type": "text", "text": VISITING_AGENT_SYSTEM}],
                           messages=list(messages), model=CONVERSATION_MODEL, effort="low", max_tokens=MAX_TOKENS,
                           output_schema=AgentStep)
    try:
        response = await model.call(request)
    except ModelUnavailable as unavailable:
        await record(unavailable.response)
        raise
    await record(response)
    if not isinstance(response.parsed, AgentStep):
        raise ModelUnavailable(response, "no agent step")
    return response.parsed


async def _send(a2a: httpx.AsyncClient, path: str, raw: bytes, headers: dict[str, str]) -> A2AResponse:
    """The Desk's answer to one signed request; `RunFailed` for anything but a 200 `A2AResponse`."""
    try:
        answer = await a2a.post(path, content=raw, headers=headers)
    except httpx.HTTPError as error:
        raise RunFailed(f"the A2A request failed ({type(error).__name__})") from None
    if answer.status_code != 200:
        raise RunFailed(f"the Desk answered {answer.status_code}")
    try:
        return A2AResponse.model_validate_json(answer.content)
    except ValidationError:
        raise RunFailed("the Desk's answer isn't an A2A response") from None


async def run_demo_agent(issued: DemoAgentIssued, task: DemoTask, slug: str, a2a: httpx.AsyncClient,
                         model: ModelClient, run: DemoAgentRun, *, task_set: DemoTaskSet,
                         clock: Callable[[], datetime], record: Record, spent: Spent | None = None) -> None:
    """Run the agent on `task`, in the fixed line of the Desk's `task_set`, against the slug's Desk through `a2a`, the
    public endpoint's client, filling in `run` as it goes and ending it `done` or `failed`. Each model call is recorded
    with `record`; requests are signed with the issued key at `clock`'s time, the first opening the session with the
    issued mandate. With `spent` (production: whether today's model budget is spent), it is asked before each step,
    and once it says so the run ends `failed` with no further model call."""
    session_id: str | None = None
    try:                                            # everything in the run ends it `done` or `failed`, the key too
        key = _private_key(issued.agent_private_key_hex)
        agent_key_id, mandate = issued.agent_key_id, issued.mandate
        path = f"/api/a2a/{quote(slug, safe='')}"
        messages = [_user(agent_task(task, task_set))]
        for n in range(1, MAX_EXCHANGES + 1):
            if spent is not None and await spent():
                raise RunFailed("today's model budget is spent")
            step = await _step(model, messages, record)
            if step.done:
                break
            raw = A2ARequest(desk_slug=slug, session_id=session_id, message=step.message,
                             mandate=mandate if session_id is None else None).model_dump_json().encode()
            headers = signed_headers(key, agent_key_id, slug, raw, signed_time(clock()), secrets.token_hex(16))
            run.turns.append(AgentTurn(author="agent", n=n, text=step.message, blocks=[], receipts=[]))
            answer = await _send(a2a, path, raw, headers)
            if session_id is not None and answer.session_id != session_id:
                raise RunFailed("the Desk answered for another session")
            session_id = answer.session_id
            run.turns.append(AgentTurn(author="desk", n=n, text=None, blocks=answer.blocks, receipts=answer.receipts))
            messages += [{"role": "assistant", "content": [{"type": "text", "text": step.model_dump_json()}]},
                         _user(wrap(DESK_REPLY_TAG, desk_reply_text(answer)))]
    except ModelUnavailable:
        _fail(run, "the model was unavailable")
    except RunFailed as failed:
        _fail(run, str(failed))
    except asyncio.CancelledError:
        _fail(run, "the process is stopping")
        raise
    except Exception as error:                      # logged by type only: a message can quote the Desk
        _fail(run, type(error).__name__)
    else:
        run.state = "done"


def _fail(run: DemoAgentRun, reason: str) -> None:
    run.state = "failed"
    logger.warning("a demo agent's run failed: %s", reason)


# The process's runs -------------------------------------------------------------------------------------------


def a2a_client(settings: Settings, transport: httpx.AsyncBaseTransport | None = None) -> httpx.AsyncClient:
    """The agent's client of the public A2A endpoint at `settings.a2a_loopback`, with no proxy from the environment
    and no redirects. `transport` is a test hook (the app itself, in process), refused in production."""
    if transport is not None and settings.production:
        raise RuntimeError("an injected A2A transport is a test hook; production refuses it")
    return httpx.AsyncClient(base_url=settings.a2a_loopback, transport=transport, timeout=A2A_TIMEOUT_S,
                             trust_env=False, follow_redirects=False)


class DemoAgents:
    """The built-in agent's runs in this process: each launched in a task of its own, its record kept for an hour
    (the 50 newest) and read only by the session that launched it. In `production`, each step of a run first checks
    today's model budget (`metrics.over_daily_budget`) and the run ends `failed` once it is spent."""

    def __init__(self, model: ModelClient, *, a2a: httpx.AsyncClient, engine: AsyncEngine,
                 clock: Callable[[], datetime], production: bool):
        self._model, self._a2a, self._engine, self._clock = model, a2a, engine, clock
        self._production = production
        self._runs: dict[str, tuple[DemoAgentRun, datetime]] = {}      # oldest first
        self._keys: dict[tuple[str, str], HeldKey] = {}                # by (copy, idempotency key), oldest first
        self.admissions = Admissions()                                  # a keyed send's lookup, limits and claim
        self._tasks: set[asyncio.Task] = set()

    def _new_run(self, task: DemoTask, slug: str, launcher: Ids) -> DemoAgentRun:
        """A new `running` run's record for the launcher's session, kept from now."""
        now = self._clock()
        self._forget(now, room=1)
        run = DemoAgentRun(run_id="run-" + secrets.token_hex(16), launcher_session_id=launcher.session_id, slug=slug,
                           task=task, state="running", turns=[])
        self._runs[run.run_id] = (run, now)
        return run

    def keyed(self, copy_id: str, key: str, request_sha256: str, slug: str, launcher: Ids) -> str | None:
        """The ID of the run a request with this key started in the copy within the hour, or None; `KeyReused` when
        that request's body hashed otherwise, or it came from another session or went to another Desk."""
        self._forget_keys(self._clock())
        held = self._keys.get((copy_id, key))
        if held is None:
            return None
        if (held.request_sha256, held.session_id, held.slug) != (request_sha256, launcher.session_id, slug):
            raise KeyReused
        return held.run_id

    def claim(self, copy_id: str, key: str, request_sha256: str, task: DemoTask, slug: str,
              launcher: Ids) -> tuple[str, DemoAgentRun | None]:
        """Take the key in the copy for a new `running` run, checked and taken with no await between: the run's ID
        and its record, which the caller then `launch`es, `fail`s or `free`s. When the copy already holds the key, the
        ID of the run it started and None (`KeyReused` for another body, session or Desk); `KeysFull` when the map
        holds `MAX_KEYS`."""
        held = self.keyed(copy_id, key, request_sha256, slug, launcher)
        if held is not None:
            return held, None
        wait = self.key_wait()
        if wait is not None:
            raise KeysFull(wait)
        run = self._new_run(task, slug, launcher)
        self._keys[(copy_id, key)] = HeldKey(run_id=run.run_id, request_sha256=request_sha256,
                                             session_id=launcher.session_id, slug=slug, claimed_at=self._clock())
        return run.run_id, run

    def key_wait(self) -> int | None:
        """None while a new key fits; else the whole seconds, at least 1, until the oldest key's hour ends."""
        now = self._clock()
        self._forget_keys(now)
        if len(self._keys) < MAX_KEYS:
            return None
        oldest = next(iter(self._keys.values()))
        return max(1, math.ceil((oldest.claimed_at + RUN_LIFE - now).total_seconds()))

    def fail(self, run: DemoAgentRun, reason: str) -> None:
        """End a claimed run `failed` whose mint may have happened (no answer came back): its key keeps it."""
        _fail(run, reason)

    def free(self, copy_id: str, key: str, run: DemoAgentRun, reason: str) -> None:
        """End a claimed run `failed` whose agent the kernel refused to mint, and let its key go: nothing was made, so
        the same request may be sent again. A repeat that already has the run's ID reads it `failed`."""
        _fail(run, reason)
        held = self._keys.get((copy_id, key))
        if held is not None and held.run_id == run.run_id:
            del self._keys[(copy_id, key)]

    def launch(self, issued: DemoAgentIssued, task: DemoTask, slug: str, launcher: Ids, *, run: DemoAgentRun,
               task_set: DemoTaskSet) -> str:
        """Start a run of the issued agent on `task`, in the line of the Desk's `task_set`, for the launcher's session,
        in the record its key's claim made; its run ID. The issued key goes to the run's coroutine alone."""

        async def record(response: ModelResponse) -> None:
            async with self._engine.connect() as conn:
                await record_model_call(conn, launcher.copy_id, launcher.session_id, ROUTE, response)
                await conn.commit()

        async def spent() -> bool:
            async with self._engine.connect() as conn:
                return await over_daily_budget(conn, self._clock)

        work = asyncio.create_task(run_demo_agent(issued, task, slug, self._a2a, self._model, run, task_set=task_set,
                                                  clock=self._clock, record=record,
                                                  spent=spent if self._production else None),
                                   name="desk-demo-agent")
        self._tasks.add(work)
        work.add_done_callback(self._tasks.discard)
        return run.run_id

    def run(self, run_id: str, launcher_session_id: str) -> DemoAgentRun | None:
        """The run as it stands, when `launcher_session_id` launched it within the hour; else None."""
        self._forget(self._clock())
        found = self._runs.get(run_id)
        if found is None or found[0].launcher_session_id != launcher_session_id:
            return None
        return found[0].model_copy(deep=True)

    def _forget(self, now: datetime, room: int = 0) -> None:
        """Drop the runs older than an hour, then the oldest until `room` more fit."""
        for run_id, (_, launched) in list(self._runs.items()):
            if now - launched >= RUN_LIFE:
                del self._runs[run_id]
        while self._runs and len(self._runs) + room > MAX_RUNS:
            del self._runs[next(iter(self._runs))]

    def _forget_keys(self, now: datetime) -> None:
        """Drop the keys claimed an hour ago or more, and only those."""
        for copy_key, held in list(self._keys.items()):
            if now - held.claimed_at >= RUN_LIFE:
                del self._keys[copy_key]

    async def drain(self) -> None:
        """Wait until no run is going in this process."""
        while self._tasks:
            await asyncio.gather(*list(self._tasks), return_exceptions=True)

    async def close(self) -> None:
        """Stop every run still going (the process is stopping); each ends `failed`."""
        tasks = list(self._tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
