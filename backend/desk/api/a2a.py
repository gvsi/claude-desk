"""The A2A endpoint's work (Plan 02b, Task 4; master plan, "Agent sessions"): another person's agent talks to a Desk
with signed requests, `POST /api/a2a/{slug}`.

The API never checks a signature. It forwards the agent's four `AgentAuth` headers and the sha256 of the raw body on
every kernel call the request makes (`KernelHttp.agent`), and the kernel verifies them, binds the nonce to the session
and the body, and refuses another agent's session. What the API checks itself is defence in depth only. A request runs
in order:

1. The per-address limit; then the headers are there and `ts` is a `SignedTime`, and the body is an `A2ARequest` of
   at most 32 KiB naming the path's Desk.
2. The session. An opening request (`session_id` None) gets it from `POST /sessions`, a resent one the session its
   nonce is bound to; then `GET /whoami?session_id=` names the session's copy, Desk and state. A refusal is 401
   (409 for a closed session) before anything of the API's is read or Claude is called; a nonce whose turn is over
   (409 `replayed`) is answered from step 4's row, and a row left to be tried again (step 8) gets its final answer
   then, since it can't run again (`spent_answer`).
3. The per-key limit, counted only now that the kernel accepted the signature.
4. The turn's row in `app.a2a_turns`, keyed `(agent_key_id, session_id, nonce)`, inserted `running`. A row already
   there answers instead: its stored answer once `done`, else 409 `in_progress`, and nothing runs; but a row an
   earlier try left to be tried again (step 8) is taken over, and the request runs again, resuming that try: its
   message is stored only if that try didn't store it, and its tool calls are found by their call IDs, never decided
   again (an allow whose run it couldn't learn runs once, or returns its stored result: `loop`, `tools`), so no
   effect is repeated. A call that moves money is resumed so only by this same request, and only while no other
   request of the session has begun since its first try; any other request answers it from its decision. A row
   under another key or session is never read.
5. What the session's control rows left (a held request answered, an outcome now known), handled with the agent's
   credential.
6. A `verify_code` goes to `/verify/check` alone: it is never stored, logged or shown to Claude, and a wrong one is
   422 `invalid`.
7. In mode `owner` the message waits for the owner and Claude isn't called. Otherwise it wakes Claude's turn, run in
   the request and ended at Claude's reply, after up to 30 s waiting for a turn already running in the session (then
   409 `in_progress`). It is the request's only turn, since the reply spends its nonce: work that wakes the session
   meanwhile waits for the agent's next request. A paused session's turn is the kernel's handoff, with no model call.
   A turn the session left meanwhile is answered as the session now stands: taken over, what it was shown; handed
   back, 409 `stale_generation`; closed, 409 `closed`. The stored message's translation for the owner is queued
   (Plan 02b, Task 10) unless the session is paused or its `translate` limit is spent; it never reaches the agent.
8. The answer: an `A2AResponse` of what the session was shown since the agent's last answer, in order (the owner's
   says, payment confirmations and resolved requests first, then the turn's own), stored `done` with the last event
   it covers. Every answer is stored once the row exists, errors included; an error covers nothing, so the next
   answer carries what an unfinished turn showed. "Try later" (`RETRY_LATER`: a turn already running held the session
   past the wait, or the kernel couldn't be reached) is no answer to store: the row stays `running`, marked with the
   try's status, and the same request sent again until the kernel ends the nonce's turn (at most 300 s after its first
   use) runs. Sent again once the kernel has ended that turn (it checked the reply and its answer was lost, or the
   turn's time ran out), it gets a final answer, stored: what the session was shown, when Claude's checked reply was
   published meanwhile, else 409 `replayed`.

Every answer says it comes from an AI: an `A2AResponse` has `disclosure: "ai"`, and an error is `{code, disclosure:
"ai"}` (`A2AError`), with the master's A2A statuses: 400 a body that doesn't fit, 401 a signature or session the
kernel refused, 409 `closed`, `in_progress`, `replayed` or `stale_generation`, 422 a wrong code, 429 a limit, 503 an
unreachable kernel, 500 a failure of the API's own. No answer is cached (it can carry a verified person's link), and
nothing here logs a body or a header value.
"""

import hashlib
import logging
from datetime import datetime
from typing import Literal

from fastapi import Request
from fastapi.responses import JSONResponse, Response
from pydantic import ValidationError
from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncConnection

from desk.api.deps import Runtime, client_ip
from desk.api.jobs import defer_translation
from desk.api.kernel_client import CredentialView, KernelFailed, KernelUnavailable
from desk.api.prompts import NOTES
from desk.api.ratelimit import RateLimited, RateLimitLedger
from desk.api.ro import KernelRO
from desk.api.sse import RUN_EVENTS
from desk.api.store import MESSAGES, Ids, append_message, append_note_once, lock_key, mode_for_message
from desk.api.tools import Caller
from desk.contracts import A2ARequest, AgentAuth, SessionState
from desk.db.models import A2AError, A2ATurn
from desk.events import A2AResponse
from desk.kernel_api import CreateSessionRequest, VerifyCheckRequest

logger = logging.getLogger(__name__)

A2A_PATH = "/api/a2a/"
MAX_BODY_BYTES = 32 * 1024
TURNS = A2ATurn.__table__
DISCLOSURE: Literal["ai"] = "ai"
NO_STORE = {"Cache-Control": "no-store"}
STATUSES = frozenset({"receipt", "held", "resolved"})     # a decision's signed status, as deliver() published it
KERNEL_FAULTS = frozenset({"seed_unproved", "internal"})
# How the request's turn ended (`loop.run_pending`), as an answer: shown, or an error's status and code.
SHOWN = frozenset({"done", "handoff", "not_ai", "idle"})
OUTCOME_ERRORS: dict[str, tuple[int, str]] = {
    "busy": (409, "in_progress"),                 # a turn already running held the session past the wait
    "turn_over": (409, "replayed"),               # the kernel ended the nonce's turn under it
    "session_ended": (401, "auth"),               # the kernel no longer takes the credential (a closed one is 409)
    "kernel_unavailable": (503, "kernel_unavailable"),
    "internal": (500, "internal"),
}
# Answers that say "try later": never stored as the turn's answer, so the same request sent again runs
# (module docstring, step 8).
RETRY_LATER = frozenset({(409, "in_progress"), (503, "kernel_unavailable")})


class A2AFailure(Exception):
    """An error answer: its status and `A2AError.code`."""

    def __init__(self, status: int, code: str):
        super().__init__(f"{status} {code}")
        self.status, self.code = status, code


def error_response(status: int, code: str, *, headers: dict[str, str] | None = None) -> JSONResponse:
    """An A2A error answer: `{code, disclosure: "ai"}`."""
    return JSONResponse(A2AError(code=code, disclosure=DISCLOSURE).model_dump(), status_code=status,
                        headers={**(headers or {}), **NO_STORE})


def _answer(status: int, body: A2AResponse | A2AError) -> JSONResponse:
    return JSONResponse(body.model_dump(mode="json"), status_code=status, headers=NO_STORE)


def _refused(failure: KernelFailed) -> A2AFailure:
    """A kernel refusal as the agent's answer: a signature, key or session the kernel doesn't accept is 401 alike
    (another agent's session included); anything else keeps the kernel's status and code."""
    if failure.code in ("auth", "not_found"):
        return A2AFailure(401, "auth")
    return A2AFailure(failure.status, failure.code)


def _unreachable(failure: KernelUnavailable) -> A2AFailure:
    return A2AFailure(503, failure.code if failure.code in KERNEL_FAULTS else "kernel_unavailable")


# Step 1: the request as sent ----------------------------------------------------------------------------------


def agent_auth(key_id: str | None, ts: str | None, nonce: str | None, sig: str | None) -> AgentAuth:
    """The request's `AgentAuth` headers, each present and `ts` a `SignedTime`; else 401. Not a signature check."""
    try:
        return AgentAuth(agent_key_id=key_id, ts=ts, nonce=nonce, sig=sig)
    except ValidationError:
        raise A2AFailure(401, "auth") from None


async def read_body(request: Request) -> bytes:
    """The raw body, refused (400) past 32 KiB without reading further."""
    declared = request.headers.get("content-length")
    if declared is not None and (not declared.isdigit() or int(declared) > MAX_BODY_BYTES):
        raise A2AFailure(400, "invalid")
    chunks, size = [], 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > MAX_BODY_BYTES:
            raise A2AFailure(400, "invalid")
        chunks.append(chunk)
    return b"".join(chunks)


def parse_body(raw: bytes, slug: str) -> A2ARequest:
    """The body as an `A2ARequest` naming the path's Desk; else 400, echoing nothing (the parser's error would quote
    the body, a `verify_code` included)."""
    try:
        body = A2ARequest.model_validate_json(raw)
    except ValidationError:
        raise A2AFailure(400, "invalid") from None
    if body.desk_slug != slug:
        raise A2AFailure(400, "invalid")
    return body


# The turn's row -------------------------------------------------------------------------------------------------


def _row(agent_key_id: str, session_id: str, nonce: str) -> tuple:
    return TURNS.c.agent_key_id == agent_key_id, TURNS.c.session_id == session_id, TURNS.c.nonce == nonce


async def begin_turn(conn: AsyncConnection, agent_key_id: str, ids: Ids, nonce: str) -> bool:
    """Insert the turn's row, `running`; False when a row for this key and nonce is already there."""
    inserted = await conn.execute(pg_insert(TURNS).values(
        agent_key_id=agent_key_id, session_id=ids.session_id, nonce=nonce, copy_id=ids.copy_id, desk_id=ids.desk_id,
        status="running").on_conflict_do_nothing().returning(TURNS.c.nonce))
    began = inserted.first() is not None
    await conn.commit()
    return began


async def retry_turn(conn: AsyncConnection, agent_key_id: str, session_id: str, nonce: str) -> datetime | None:
    """Take over the row an earlier try left to be tried again (`running`, marked with that try's status), clearing the
    mark so no other request takes it too: when its row was made, or None when there is no such row to take."""
    taken = (await conn.execute(update(TURNS).where(
        *_row(agent_key_id, session_id, nonce), TURNS.c.status == "running", TURNS.c.http_status.is_not(None))
        .values(http_status=None, updated_at=func.now()).returning(TURNS.c.created_at))).first()
    await conn.commit()
    return None if taken is None else taken.created_at


async def try_later(conn: AsyncConnection, agent_key_id: str, ids: Ids, nonce: str, status: int,
                    code: str) -> Response:
    """End a try that says "try later" (`RETRY_LATER`): the row stays `running`, marked with the try's status, for the
    same request sent again to take over (`retry_turn`); nothing is stored as the turn's answer."""
    await conn.execute(update(TURNS).where(*_row(agent_key_id, ids.session_id, nonce), TURNS.c.status == "running")
                       .values(http_status=status, updated_at=func.now()))
    await conn.commit()
    return error_response(status, code)


async def stored_answer(conn: AsyncConnection, agent_key_id: str, session_id: str, nonce: str) -> Response:
    """The answer of the row keyed by this key, session and nonce: its stored answer once `done`, else 409
    `in_progress`. No such row (the key's nonce belongs to another of its sessions, whose row is never read) is 409
    `replayed`."""
    row = (await conn.execute(select(TURNS.c.status, TURNS.c.http_status, TURNS.c.response).where(
        *_row(agent_key_id, session_id, nonce)))).first()
    await conn.commit()
    if row is None:
        return error_response(409, "replayed")
    if row.status != "done" or row.response is None:
        return error_response(409, "in_progress")
    return _answer(row.http_status, row.response)


async def spent_answer(conn: AsyncConnection, agent_key_id: str, session_id: str, nonce: str) -> Response:
    """The answer to a request whose nonce's turn the kernel has ended (409 `replayed` from `/whoami`): its row's
    stored answer (`stored_answer`). A row an earlier try left to be tried again (`try_later`, the kernel's answer lost
    after it ended the turn, or the turn's time run out) can't run again on that nonce, so it gets its final answer
    now, once, stored `done`: what the session was shown since the agent's last answer when Claude's checked reply was
    published meanwhile, else 409 `replayed`, which covers nothing.

    No model call is made, so the row is locked, settled and stored in one transaction: a failure part way rolls it
    all back and leaves the row marked for the next resend, and a resend racing this one waits for the row and then
    reads the stored answer."""
    try:
        await _answer_lock(conn, session_id)
        marked = (await conn.execute(select(TURNS.c.copy_id, TURNS.c.desk_id, TURNS.c.created_at).where(
            *_row(agent_key_id, session_id, nonce), TURNS.c.status == "running", TURNS.c.http_status.is_not(None))
            .with_for_update())).first()
        if marked is None:
            await conn.commit()
            return await stored_answer(conn, agent_key_id, session_id, nonce)
        ids = Ids(copy_id=marked.copy_id, desk_id=marked.desk_id, session_id=session_id)
        status, code = ((200, None) if await _replied_since(conn, agent_key_id, ids, marked.created_at)
                        else OUTCOME_ERRORS["turn_over"])
        body = await _store_answer(conn, agent_key_id, ids, nonce, status, code)
        await conn.commit()
    except BaseException:
        await conn.rollback()
        raise
    return _answer(status, body)


async def _replied_since(conn: AsyncConnection, agent_key_id: str, ids: Ids, since: datetime) -> bool:
    """Whether a checked reply of Claude's was published to the session since `since` that no answer to this agent
    has covered yet."""
    covered = await _covered(conn, agent_key_id, ids.session_id)
    found = (await conn.execute(select(RUN_EVENTS.c.seq).where(
        RUN_EVENTS.c.copy_id == ids.copy_id, RUN_EVENTS.c.session_id == ids.session_id, RUN_EVENTS.c.kind == "sse",
        RUN_EVENTS.c.type == "message", RUN_EVENTS.c.payload["author"].astext == "claude",
        RUN_EVENTS.c.seq > covered, RUN_EVENTS.c.created_at >= since).limit(1))).first()
    return found is not None


async def _covered(conn: AsyncConnection, agent_key_id: str, session_id: str) -> int:
    """The last event the session's earlier answers to this agent covered (0 before the first)."""
    found = (await conn.execute(select(func.max(TURNS.c.through_seq)).where(
        TURNS.c.agent_key_id == agent_key_id, TURNS.c.session_id == session_id, TURNS.c.status == "done"))
    ).scalar_one()
    return found or 0


async def shown_since(conn: AsyncConnection, ids: Ids, after: int) -> tuple[A2AResponse, int]:
    """What the session was shown after event `after`, in order, as `deliver()` stored it: each checked reply's blocks
    and each signed decision status, unchanged. Also the last event read."""
    rows = await conn.execute(select(RUN_EVENTS.c.seq, RUN_EVENTS.c.type, RUN_EVENTS.c.payload).where(
        RUN_EVENTS.c.copy_id == ids.copy_id, RUN_EVENTS.c.session_id == ids.session_id, RUN_EVENTS.c.kind == "sse",
        RUN_EVENTS.c.seq > after).order_by(RUN_EVENTS.c.seq))
    blocks, receipts, through = [], [], after
    for seq, type, payload in rows:
        through = seq
        if type == "message":
            blocks.extend(payload["blocks"])
        elif type in STATUSES:
            receipts.append(payload)
    answer = A2AResponse.model_validate({"session_id": ids.session_id, "disclosure": DISCLOSURE, "blocks": blocks,
                                         "receipts": receipts})
    return answer, through


async def _answer_lock(conn: AsyncConnection, session_id: str) -> None:
    """The session's answer lock, held until the transaction ends: one answer of the session is built and stored at a
    time, so two never cover the same events."""
    await conn.execute(select(func.pg_advisory_xact_lock(lock_key("a2a:" + session_id))))


async def _store_answer(conn: AsyncConnection, agent_key_id: str, ids: Ids, nonce: str, status: int,
                        code: str | None) -> A2AResponse | A2AError:
    """Store the turn's answer `done`, in the caller's transaction and under its answer lock (`_answer_lock`), and
    return it: for a 200, what the session was shown since the agent's last answer; else the error, covering
    nothing."""
    covered = await _covered(conn, agent_key_id, ids.session_id)
    if status == 200:
        body, through = await shown_since(conn, ids, covered)
    else:
        body, through = A2AError(code=code, disclosure=DISCLOSURE), covered
    await conn.execute(update(TURNS).where(*_row(agent_key_id, ids.session_id, nonce), TURNS.c.status == "running")
                       .values(status="done", http_status=status, response=body, through_seq=through,
                               updated_at=func.now()))
    return body


async def finish_turn(conn: AsyncConnection, agent_key_id: str, ids: Ids, nonce: str, status: int,
                      code: str | None = None) -> Response:
    """Store the turn's answer `done` and return it (`_store_answer`), under the session's answer lock."""
    await _answer_lock(conn, ids.session_id)
    body = await _store_answer(conn, agent_key_id, ids, nonce, status, code)
    await conn.commit()
    return _answer(status, body)


# The request -----------------------------------------------------------------------------------------------------


async def serve(state: Runtime, request: Request, slug: str, key_id: str | None, ts: str | None, nonce: str | None,
                sig: str | None) -> Response:
    """Answer one A2A request, in the order the module docstring gives."""
    try:
        await state.limiter.enforce("a2a_ip", client_ip(request))
        auth = agent_auth(key_id, ts, nonce, sig)
        raw = await read_body(request)
        body = parse_body(raw, slug)
        try:
            kernel = state.kernel.agent(auth, hashlib.sha256(raw).hexdigest())
        except ValueError:                                  # not a header value a signature could be
            raise A2AFailure(401, "auth") from None
        return await _serve(state, kernel, auth, slug, body)
    except A2AFailure as failure:
        return error_response(failure.status, failure.code)
    except RateLimited as limited:
        return error_response(429, "rate_limited", headers={"Retry-After": str(limited.retry_after)})


async def _session_id(kernel: CredentialView, slug: str, body: A2ARequest) -> str:
    """The session the request is for: the body's, or, for an opening request, the one `POST /sessions` opens (or the
    one a resent opening request's nonce is already bound to)."""
    if body.session_id is not None:
        return body.session_id
    try:
        created = await kernel.call("POST /sessions", CreateSessionRequest(desk_slug=slug, kind="agent",
                                                                           mandate=body.mandate))
    except KernelFailed as failure:
        raise _refused(failure) from None
    except KernelUnavailable as failure:
        raise _unreachable(failure) from None
    return created.state.session_id


async def _serve(state: Runtime, kernel: CredentialView, auth: AgentAuth, slug: str, body: A2ARequest) -> Response:
    session_id = await _session_id(kernel, slug, body)
    try:
        who = await kernel.whoami(session_id)
    except KernelFailed as failure:
        if not failure.turn_over:
            raise _refused(failure) from None
        await state.limiter.enforce("a2a", auth.agent_key_id)          # a valid signature on a spent nonce
        async with state.database().connect() as conn:
            return await spent_answer(conn, auth.agent_key_id, session_id, auth.nonce)
    except KernelUnavailable as failure:
        raise _unreachable(failure) from None
    session = who.session
    if who.kind != "agent" or session is None or who.desk_id is None or session.session_id != session_id:
        raise A2AFailure(401, "auth")
    ids = Ids(copy_id=who.copy_id, desk_id=who.desk_id, session_id=session_id)
    caller = Caller(copy_id=ids.copy_id, desk_id=ids.desk_id, session_id=session_id, kind="agent", kernel=kernel,
                    ro_schema=state.settings.kernel_ro_schema)
    async with state.database().connect() as conn:
        await _check_named(conn, caller, slug, auth.agent_key_id)
        await state.limiter.enforce("a2a", auth.agent_key_id,
                                    ledger=RateLimitLedger(kernel, desk_id=ids.desk_id, session_id=session_id))
        since = None                                    # a retried row: when it was made
        if not await begin_turn(conn, auth.agent_key_id, ids, auth.nonce):
            since = await retry_turn(conn, auth.agent_key_id, session_id, auth.nonce)
            if since is None:
                return await stored_answer(conn, auth.agent_key_id, session_id, auth.nonce)
        try:
            status, code = await _turn(state, conn, caller, session, body, since)
        except A2AFailure as failure:
            status, code = failure.status, failure.code
        except Exception as error:
            logger.error("an agent's turn failed with %s", type(error).__name__)
            await conn.rollback()
            status, code = 500, "internal"
        if (status, code) in RETRY_LATER:
            return await try_later(conn, auth.agent_key_id, ids, auth.nonce, status, code)
        return await finish_turn(conn, auth.agent_key_id, ids, auth.nonce, status, code)


async def _check_named(conn: AsyncConnection, caller: Caller, slug: str, agent_key_id: str) -> None:
    """Defence in depth: the session the kernel named is on the path's Desk and bound to the request's key."""
    ro = KernelRO(conn, caller.copy_id, caller.ro_schema)
    desk = await ro.one("desks", desk_id=caller.desk_id)
    session = await ro.session(caller.session_id)
    await conn.commit()
    if desk is None or desk["slug"] != slug or session is None or session["agent_key_id"] != agent_key_id:
        raise A2AFailure(401, "auth")


async def _stored_since(conn: AsyncConnection, ids: Ids, message: str, since: datetime) -> bool:
    """Whether the session holds `message` as an agent's, stored since `since`: what an earlier try of the same signed
    request (the kernel binds its nonce to the body) stored before it said "try later"."""
    found = (await conn.execute(select(MESSAGES.c.n).where(
        MESSAGES.c.copy_id == ids.copy_id, MESSAGES.c.session_id == ids.session_id, MESSAGES.c.kind == "agent_text",
        MESSAGES.c.text == message, MESSAGES.c.created_at >= since).limit(1))).first()
    await conn.commit()
    return found is not None


async def _later_request(conn: AsyncConnection, ids: Ids, since: datetime) -> bool:
    """Whether another request of the session began after `since` (a retried row's first try)."""
    found = (await conn.execute(select(TURNS.c.nonce).where(TURNS.c.session_id == ids.session_id,
                                                            TURNS.c.created_at > since).limit(1))).first()
    await conn.commit()
    return found is not None


async def _turn(state: Runtime, conn: AsyncConnection, caller: Caller, session: SessionState, body: A2ARequest,
                since: datetime | None = None) -> tuple[int, str | None]:
    """Steps 5 to 7: the control rows, the code, the message and Claude's turn; the answer's status and error code.
    `since` is when a retried row was made: a message an earlier try of it stored isn't stored again, and, when no
    other request of the session began since, a call that moves money its tries left open may run (`resend_since`),
    which no other request's turn ever does."""
    await state.runner.handle_controls(conn, caller)
    if body.verify_code is not None:
        await _verify(conn, caller, body.verify_code)
    mode = session.mode
    if body.message.strip() and not (since is not None and await _stored_since(conn, caller.ids, body.message, since)):
        # The mode now, not the one the request was named in: a hand-back since then has already looked for this
        # message.
        mode = await mode_for_message(KernelRO(conn, caller.copy_id, caller.ro_schema), caller.session_id, mode)
        n = await append_message(conn, caller.ids, "agent_text", text=body.message, wake=mode != "owner")
        message_id = (await conn.execute(select(MESSAGES.c.message_id).where(MESSAGES.c.n == n))).scalar_one()
        await conn.commit()
        if mode != "paused":                            # the owner's English copy, if it needs one (none when paused)
            await defer_translation(state.jobs, caller.ids, message_id, limiter=state.limiter, ledger=RateLimitLedger(
                caller.kernel, desk_id=caller.desk_id, session_id=caller.session_id))
    if mode == "owner":                                 # the owner has the chat: the message waits for them
        return 200, None
    resend = since if since is not None and not await _later_request(conn, caller.ids, since) else None
    outcome = await state.runner.run_agent_turn(caller, resend_since=resend)
    if outcome in SHOWN:
        return 200, None
    if outcome in ("fenced", "session_ended"):          # the session moved on, or ended, mid-turn: as it stands now
        now = await KernelRO(conn, caller.copy_id, caller.ro_schema).session(caller.session_id)
        await conn.commit()
        if outcome == "fenced":                         # taken over (or handed back)
            return (200, None) if now is not None and now["mode"] == "owner" else (409, "stale_generation")
        if now is not None and now["closed_at"] is not None:
            return 409, "closed"                        # the conversation was closed
    return OUTCOME_ERRORS.get(outcome, (500, "internal"))


async def _verify(conn: AsyncConnection, caller: Caller, code: str) -> None:
    """The agent's code, to the kernel alone; a wrong, expired or used-up one is 422 `invalid`. Once the session is
    verified, a note tells Claude, once a session, as for a visitor (`store.append_note_once`)."""
    try:
        checked = await caller.kernel.call("POST /verify/check", VerifyCheckRequest(session_id=caller.session_id,
                                                                                     code=code))
    except KernelFailed as failure:
        if (failure.status, failure.code) == (422, "invalid"):
            raise A2AFailure(422, "invalid") from None
        raise _refused(failure) from None
    except KernelUnavailable as failure:
        raise _unreachable(failure) from None
    if checked.verified:
        await append_note_once(conn, caller.ids, NOTES["verified"], wake=True)
        await conn.commit()
