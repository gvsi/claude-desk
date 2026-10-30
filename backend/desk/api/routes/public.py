"""The public routes: the kernel's public Desk at `/api/public/{slug}` and, under `/api/public/desks/{slug}/`, the
Agent Card and the visitor's chat.

The public Desk and the Agent Card read no cookie and set none. The chat routes act only for the session the
`desk_visitor` cookie names, as the kernel's `GET /whoami` answers for it (`deps.visitor_ctx`): an ID the browser
sends is never read. Claude's turns run in the process's `TurnRunner`, which holds the visitor's credential in
memory only; what they show reaches the visitor on the event stream.
"""

import contextlib
import json
from collections.abc import AsyncIterator
from typing import Annotated
from urllib.parse import quote

from fastapi import APIRouter, Depends, Header, Path, Query, Request, Response
from pydantic import BaseModel, ConfigDict, StringConstraints
from sqlalchemy import func, select
from sse_starlette import EventSourceResponse
from starlette.background import BackgroundTask

from desk.api.cookies import VISITOR_COOKIE, set_visitor_cookie
from desk.api.deliver import Status, deliver
from desk.api.deps import ApiProblem, VisitorCtx, client_ip, public_origin, runtime, visitor_context, visitor_ctx
from desk.api.ratelimit import StreamSlot
from desk.api.schemas import (
    AgentCardOut,
    AgentCardSigning,
    CancelAccepted,
    MessageAccepted,
    VisitorSession,
    VisitorTranscript,
    error_responses,
    operation_ids,
)
from desk.api.sse import RUN_EVENTS, ControlRow, Wakeup, event_stream
from desk.api.store import MESSAGES, append_message, transcript
from desk.contracts import LedgerEvent
from desk.kernel_api import CancelRequest, CreateSessionRequest, LedgerAppendRequest, PublicDesk

router = APIRouter(prefix="/api/public", generate_unique_id_function=operation_ids("public"))
NO_STORE = "no-store"
# `?lang=` goes to the kernel as it came: its templates are English unless it is "es".
Lang = Annotated[str | None, Query(max_length=35, pattern=r"^[A-Za-z0-9-]+$")]


@router.get("/{slug}", response_model=PublicDesk, responses=error_responses(404, 422, 503))
async def public_desk(slug: str, request: Request, response: Response, lang: Lang = None) -> PublicDesk:
    """The Desk's public page: the kernel's `PublicDesk`, unchanged. Never cached: the page's open status refetches
    on a delay that assumes a fresh answer (CloudFront doesn't cache `/api/*` either)."""
    desk = await runtime(request).started().kernel.public().call(
        "GET /public/{desk_slug}", path={"desk_slug": slug}, query={"lang": lang})
    response.headers["Cache-Control"] = NO_STORE
    return desk


# The signing rules the kernel checks ("Agent sessions"): the `AgentAuth` headers, and an Ed25519 signature over
# the RFC 8785 JSON of these fields, `body_sha256` being the sha256 of the raw request body.
AGENT_HEADERS = ["X-Agent-Key-Id", "X-Agent-Ts", "X-Agent-Nonce", "X-Agent-Sig"]
SIGNING = AgentCardSigning(headers=AGENT_HEADERS, payload_fields=["desk_slug", "ts", "nonce", "body_sha256"],
                           canonical="RFC 8785", algorithm="Ed25519", encoding="lowercase hex", ts_window_s=300)
EXAMPLE_HEADERS = {"X-Agent-Key-Id": "<your agent key id>", "X-Agent-Ts": "2026-10-30T17:04:05.123000Z",
                   "X-Agent-Nonce": "<a new random nonce for each request>",
                   "X-Agent-Sig": "<the signature, in lowercase hex>"}


def _example_request(endpoint: str, slug: str) -> str:
    body = json.dumps({"desk_slug": slug, "session_id": None, "message": "Hello, what can you help me with?"})
    headers = "".join(f"{name}: {value}\n" for name, value in
                      {"Content-Type": "application/json", **EXAMPLE_HEADERS}.items())
    return f"POST {endpoint}\n{headers}\n{body}"


@router.get("/desks/{slug}/agent_card", response_model=AgentCardOut, responses=error_responses(404, 422, 503))
async def agent_card(slug: str, request: Request) -> AgentCardOut:
    """Where agents send their requests and how they sign them, built by code from `PUBLIC_ORIGIN`, never from the
    request's own host headers. The kernel's public Desk is read only to answer 404 for an unknown slug."""
    await runtime(request).started().kernel.public().call("GET /public/{desk_slug}", path={"desk_slug": slug})
    endpoint = f"{public_origin(request)}/api/a2a/{quote(slug, safe='')}"
    return AgentCardOut(endpoint=endpoint, signing=SIGNING, example_request=_example_request(endpoint, slug))


# Sessions ----------------------------------------------------------------------------------------------------

# Resuming is never limited and each ledger append takes the Desk's ledger lock, so a resume's `session` entry is
# written at most once per session in this long: a loop of resumes can't queue writes on that lock without bound.
RESUME_LEDGERED_EVERY_S = 600


@router.post("/desks/{slug}/sessions", response_model=VisitorSession, responses=error_responses(404, 422, 429, 503))
async def open_session(slug: str, request: Request, response: Response) -> VisitorSession:
    """The visitor's session on the slug's Desk: the one the cookie holds while the kernel says it is open there (a
    returning visitor), else a new one, whose token only the cookie holds. Resuming is never limited, however often a
    page reloads (it creates nothing), and is ledgered as a `session` event at most once per session every ten
    minutes; a new chat counts toward `new_chat`."""
    state = runtime(request).started()
    token = request.cookies.get(VISITOR_COOKIE)
    if token:
        try:
            async with visitor_context(state, token, slug) as ctx:
                append = LedgerAppendRequest(desk_id=ctx.ids.desk_id, event=LedgerEvent(
                    kind="session", origin="api", session_id=ctx.ids.session_id, summary={"resumed": True}))
                await state.limiter.once_per_window(("resumed", ctx.ids.session_id), RESUME_LEDGERED_EVERY_S,
                                                    lambda: ctx.caller.kernel.call("POST /ledger/append", append))
                set_visitor_cookie(response, slug, token)
                return VisitorSession(state=ctx.state, resumed=True)
        except ApiProblem as problem:
            if (problem.status, problem.error) != (401, "no_session"):
                raise
    await state.limiter.enforce("new_chat", client_ip(request))
    created = await state.kernel.public().call("POST /sessions", CreateSessionRequest(desk_slug=slug, kind="visitor"))
    set_visitor_cookie(response, slug, created.session_token)
    return VisitorSession(state=created.state, resumed=False)


@router.get("/desks/{slug}/session", response_model=VisitorTranscript, responses=error_responses(401, 422, 503))
async def visitor_session(ctx: Annotated[VisitorCtx, Depends(visitor_ctx)]) -> VisitorTranscript:
    """The session's state and its transcript as the visitor sees it: their own words and what was delivered to
    them, never model, note, owner-only or other sessions' rows. `last_seq` is read in the same snapshot, so the
    event stream opened after it neither misses nor repeats an item."""
    conn = ctx.conn
    await conn.commit()
    await conn.execution_options(isolation_level="REPEATABLE READ")   # reset when the connection is pooled again
    items = await transcript(conn, ctx.ids, "visitor")
    last_seq = (await conn.execute(select(func.max(RUN_EVENTS.c.seq)).where(
        RUN_EVENTS.c.copy_id == ctx.ids.copy_id, RUN_EVENTS.c.session_id == ctx.ids.session_id,
        RUN_EVENTS.c.kind == "sse"))).scalar_one()
    await conn.commit()
    return VisitorTranscript(state=ctx.state, items=items, last_seq=last_seq or 0)


# Messages and the event stream -------------------------------------------------------------------------------


class MessageIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: Annotated[str, StringConstraints(min_length=1, max_length=2000)]


@router.post("/desks/{slug}/messages", status_code=202, response_model=MessageAccepted,
             responses=error_responses(401, 422, 429, 503))
async def send_message(body: MessageIn, request: Request,
                       ctx: Annotated[VisitorCtx, Depends(visitor_ctx)]) -> MessageAccepted:
    """Store the visitor's message and start Claude's turn; the answer arrives on the event stream.

    A message that starts a model turn (mode `ai`) counts toward the turn limits, per conversation and per address,
    and past either is refused before anything is stored. Then what control rows left for this session is done
    first, so an outcome that came in meanwhile precedes the message and the same turn answers both. The message
    wakes a turn unless the owner has taken the chat over (mode `owner`: the owner answers it). In a paused session
    that turn is the kernel's handoff, with no model call: it runs under the session's turn lock and stops the waiting
    work from starting more turns, so one handoff answers the message and whatever else was waiting. Neither counts
    toward the turn limits."""
    state = runtime(request).started()
    if ctx.state.mode == "ai":
        await state.limiter.enforce_all([("visitor_turn_conversation", ctx.ids.session_id),
                                         ("visitor_turn", client_ip(request))], ledger=ctx.ledger())
    conn, caller = ctx.conn, ctx.caller
    await conn.commit()
    await state.runner.handle_controls(conn, caller)
    n = await append_message(conn, ctx.ids, "visitor_text", text=body.text, wake=ctx.state.mode != "owner")
    message_id = (await conn.execute(select(MESSAGES.c.message_id).where(MESSAGES.c.n == n))).scalar_one()
    await conn.commit()
    state.runner.start(caller)
    return MessageAccepted(message_id=message_id)


def _cursor(last_event_id: str | None, after: int | None) -> int | None:
    """Where the stream resumes: the browser's `Last-Event-ID` on a reconnect, else `?after=`, else the start."""
    if last_event_id is None:
        return after
    if not (last_event_id.isascii() and last_event_id.isdigit()) or len(last_event_id) > 18:
        raise ApiProblem(422, "invalid")
    return int(last_event_id)


def _released(response: EventSourceResponse, slot: StreamSlot) -> EventSourceResponse:
    """Free the stream's place when it ends, however it ends: the background task runs after a normal end or a hang
    up, the body's `finally` when the stream failed. Closing the body closes the stream's frames at once, which lets
    go of their listener subscription."""
    frames = response.body_iterator

    async def releasing() -> AsyncIterator:
        try:
            async with contextlib.aclosing(frames):
                async for frame in frames:
                    yield frame
        finally:
            slot.release()

    response.body_iterator = releasing()
    response.background = BackgroundTask(slot.release)
    return response


@router.get("/desks/{slug}/events", response_class=EventSourceResponse,
            responses={200: {"content": {"text/event-stream": {}}, "description": "The session's events"},
                       **error_responses(401, 422, 429, 503)})
async def events(slug: str, request: Request, after: Annotated[int | None, Query(ge=0)] = None,
                 last_event_id: Annotated[str | None, Header()] = None) -> EventSourceResponse:
    """The session's events after the cursor, then live ones (SSE `id` is the event's `seq`). On opening, and as each
    control row appears while it is open, the session's runner does what control rows left and runs waiting work,
    with the visitor's credential, in a task of its own: a hang-up never cuts it short. Three streams per session
    and thirty per address may be open at once: a session's fourth closes its oldest (opening a stream is never
    refused for its session's streams, so a reload never is), and past the address's thirty it is 429."""
    state = runtime(request).started()
    cursor = _cursor(last_event_id, after)
    token = request.cookies.get(VISITOR_COOKIE)
    async with visitor_context(state, token, slug) as ctx:      # its connection is let go before the stream opens
        caller = ctx.caller
    wakeup = Wakeup()
    slot = state.stream_slots.acquire(caller.session_id, client_ip(request), on_close=wakeup.close)
    runner = state.runner

    async def on_open() -> None:
        runner.start(caller)

    async def on_control(row: ControlRow) -> None:
        runner.start(caller)                                 # it handles every waiting row, this one included

    try:
        response = event_stream(state.database(), state.listener, caller.ids, cursor, on_control=on_control,
                                on_open=on_open, wakeup=wakeup)
    except BaseException:
        slot.release()
        raise
    set_visitor_cookie(response, slug, token)
    return _released(response, slot)


# Held requests -----------------------------------------------------------------------------------------------


@router.post("/desks/{slug}/decisions/{decision_id}/cancel", status_code=202, response_model=CancelAccepted,
             responses=error_responses(401, 404, 409, 422, 503))
async def cancel_request(decision_id: Annotated[str, Path(max_length=128)],
                         ctx: Annotated[VisitorCtx, Depends(visitor_ctx)]) -> CancelAccepted:
    """Withdraw one of the visitor's own held requests. The kernel cancels it (409 once it is no longer held, 404
    for another session's); its signed outcome is then shown as `resolved`, and Claude reads it at the next turn
    (an `action_update` that starts none: the visitor already sees what happened)."""
    decision = await ctx.caller.kernel.call("POST /decisions/{decision_id}/cancel",
                                            CancelRequest(session_id=ctx.ids.session_id),
                                            path={"decision_id": decision_id})
    conn = ctx.conn
    await conn.commit()
    try:
        if await deliver(conn, ctx.ids, Status(decision, "resolved"), ro_schema=ctx.caller.ro_schema) is not None:
            await append_message(conn, ctx.ids, "action_update", text=decision.visitor_plain,
                                 ref_id=decision.decision_id, state=decision.state, wake=False)
        await conn.commit()
    except BaseException:
        await conn.rollback()
        raise
    return CancelAccepted(decision_id=decision.decision_id)
