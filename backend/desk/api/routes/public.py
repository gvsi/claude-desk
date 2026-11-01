"""The public routes: the kernel's public Desk at `/api/public/{slug}` and, under `/api/public/desks/{slug}/`, the
Agent Card, the visitor's chat, demo-code verification, the visitor's Demo inbox and the demo agents.

The public Desk and the Agent Card read no cookie and set none. The chat routes act only for the session the
`desk_visitor` cookie names, as the kernel's `GET /whoami` answers for it (`deps.visitor_ctx`): an ID the browser
sends is never read. Claude's turns run in the process's `TurnRunner`, which holds the visitor's credential in
memory only; what they show reaches the visitor on the event stream.

Verification codes go only to the contact on record, as Demo inbox entries the visitor reads through the kernel; the
stream carries only their code-free notices, and a code the visitor types goes to the kernel alone: it is never stored,
logged, streamed or shown to Claude (master plan, "Demo limit: the Demo inbox").

A visitor can also send the built-in visiting agent to the Desk, or get a demo key to connect an agent of their own
(Plan 02b, Task 5): the kernel mints each agent for the visitor's session, and the key is handed over once or kept in
the run's memory alone, never stored (`agents.py`).
"""

import json
from typing import Annotated
from urllib.parse import quote

from fastapi import APIRouter, Depends, Header, Path, Query, Request, Response
from pydantic import BaseModel, ConfigDict, StringConstraints
from sqlalchemy import func, select
from sse_starlette import EventSourceResponse

from desk.api.agents import DemoAgents, KeyReused, KeysFull, demo_task_set
from desk.api.cookies import VISITOR_COOKIE, set_visitor_cookie
from desk.api.deliver import Status, deliver
from desk.api.deps import (
    ApiProblem,
    VisitorCtx,
    client_ip,
    public_origin,
    require_model_budget,
    runtime,
    visitor_context,
    visitor_ctx,
)
from desk.api.idempotency import IdempotencyKey, body_sha256
from desk.api.jobs import defer_translation
from desk.api.kernel_client import KernelFailed
from desk.api.prompts import NOTES, DemoTask
from desk.api.ratelimit import RateLimited
from desk.api.schemas import (
    AgentCardOut,
    AgentCardSigning,
    AgentRunStarted,
    AgentTasks,
    CancelAccepted,
    DemoAgentRun,
    MessageAccepted,
    VerifyChecked,
    VisitorSession,
    VisitorTranscript,
    error_responses,
    operation_ids,
)
from desk.api.sse import OWNER, RUN_EVENTS, ControlRow, Wakeup, emit_inbox, event_stream
from desk.api.store import MESSAGES, append_message, append_note_once, transcript
from desk.contracts import DemoAgentIssued, DemoInboxEntry, LedgerEvent, SessionState
from desk.kernel_api import (
    CancelRequest,
    CreateSessionRequest,
    DemoAgentRequest,
    LedgerAppendRequest,
    PublicDesk,
    VerifyCheckRequest,
    VerifyStarted,
    VerifyStartRequest,
)

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
async def visitor_session(slug: str, ctx: Annotated[VisitorCtx, Depends(visitor_ctx)]) -> VisitorTranscript:
    """The session's state and its transcript as the visitor sees it: their own words, what was delivered to them
    and where the owner joined and left, never model, note, owner-only or other sessions' rows.

    The items, `last_seq` and then the state (the session's kernel_ro row) are read in one snapshot. The kernel
    commits a take-over or a hand-back before the API writes its event, so the state holds every change whose event
    `last_seq` covers, and a later change's event comes past it: the event stream opened after `last_seq` neither
    misses nor repeats an item, and agrees with the state it starts from. The mode `GET /whoami` answered with is
    older and could predate a hand-back whose event `last_seq` covers. A session closed by then, or no longer the
    kernel's, is 401 `no_session`, which clears the cookie."""
    conn = ctx.conn
    await conn.commit()
    await conn.execution_options(isolation_level="REPEATABLE READ")   # reset when the connection is pooled again
    items = await transcript(conn, ctx.ids, "visitor")
    last_seq = (await conn.execute(select(func.max(RUN_EVENTS.c.seq)).where(
        RUN_EVENTS.c.copy_id == ctx.ids.copy_id, RUN_EVENTS.c.session_id == ctx.ids.session_id,
        RUN_EVENTS.c.kind == "sse"))).scalar_one()
    session = await ctx.ro.session(ctx.ids.session_id)
    await conn.commit()
    if session is None or session["closed_at"] is not None:
        raise ApiProblem(401, "no_session", clear_visitor=slug)
    state = SessionState(session_id=ctx.ids.session_id, kind=session["kind"], verified=session["verified"],
                         assurance=session["assurance"], mode=session["mode"], generation=session["generation"])
    return VisitorTranscript(state=state, items=items, last_seq=last_seq or 0)


# Messages and the event stream -------------------------------------------------------------------------------


class MessageIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: Annotated[str, StringConstraints(min_length=1, max_length=2000)]


@router.post("/desks/{slug}/messages", status_code=202, response_model=MessageAccepted,
             responses=error_responses(401, 422, 429, 503))
async def send_message(body: MessageIn, request: Request,
                       ctx: Annotated[VisitorCtx, Depends(visitor_ctx)]) -> MessageAccepted:
    """Store the visitor's message and start Claude's turn; the answer arrives on the event stream.

    Every message counts toward the post limit, in every mode, and one that starts a model turn (mode `ai`) toward the
    turn limits too, per conversation and per address; past any of them it is refused before anything is stored,
    checked or woken. Then what control rows left for this session is done first, so an outcome that came in
    meanwhile precedes the message and the same turn answers both. The message wakes a turn unless the owner has taken
    the chat over (mode `owner`: the owner answers it). In a paused session that turn is the kernel's handoff, with no
    model call: it runs under the session's turn lock and stops the waiting work from starting more turns, so one
    handoff answers the message and whatever else was waiting. Neither counts toward the turn limits. Once the message
    is stored, its translation for the owner is queued (Plan 02b, Task 10), unless the chat is paused or the
    conversation's `translate` limit is spent; a queue that can't take it changes nothing here."""
    state = runtime(request).started()
    limits = [("visitor_post", ctx.ids.session_id)]
    if ctx.state.mode == "ai":                    # the turn limits first: when one refuses, it names the wait
        limits = [("visitor_turn_conversation", ctx.ids.session_id), ("visitor_turn", client_ip(request)), *limits]
    await state.limiter.enforce_all(limits, ledger=ctx.ledger())
    conn, caller = ctx.conn, ctx.caller
    await conn.commit()
    await state.runner.handle_controls(conn, caller)
    n = await append_message(conn, ctx.ids, "visitor_text", text=body.text, wake=ctx.state.mode != "owner")
    message_id = (await conn.execute(select(MESSAGES.c.message_id).where(MESSAGES.c.n == n))).scalar_one()
    await conn.commit()
    if ctx.state.mode != "paused":                # the owner's English copy, if it needs one (none in a paused chat)
        await defer_translation(state.jobs, ctx.ids, message_id, limiter=state.limiter, ledger=ctx.ledger())
    state.runner.start(caller)
    return MessageAccepted(message_id=message_id)


@router.post("/desks/{slug}/typing", status_code=204, response_class=Response,
             responses=error_responses(401, 422, 503))
async def typing(request: Request, ctx: Annotated[VisitorCtx, Depends(visitor_ctx)]) -> None:
    """The visitor is typing: the owner's view of the conversation shows their dots for five seconds (Plan 02b).
    Presence, not a message: it carries no text, stores nothing and calls the kernel only to name the session. The
    page sends about one signal every two seconds while the visitor types, never one per keystroke: each one still
    costs a kernel call and database reads. A signal within two seconds of the last one that counted changes nothing,
    and nothing here is ever shown to the visitor or to Claude."""
    state = runtime(request)
    state.presence.visitor_typing(ctx.ids.session_id, state.clock())


def _cursor(last_event_id: str | None, after: int | None) -> int | None:
    """Where the stream resumes: the browser's `Last-Event-ID` on a reconnect, else `?after=`, else the start."""
    if last_event_id is None:
        return after
    if not (last_event_id.isascii() and last_event_id.isdigit()) or len(last_event_id) > 18:
        raise ApiProblem(422, "invalid")
    return int(last_event_id)


@router.get("/desks/{slug}/events", response_class=EventSourceResponse,
            responses={200: {"content": {"text/event-stream": {}}, "description": "The session's events"},
                       **error_responses(401, 422, 429, 503)})
async def events(slug: str, request: Request, after: Annotated[int | None, Query(ge=0)] = None,
                 last_event_id: Annotated[str | None, Header()] = None) -> EventSourceResponse:
    """The session's events after the cursor, then live ones (SSE `id` is the event's `seq`). On opening, and as each
    control row appears while it is open, the session's runner does what control rows left and runs waiting work,
    with the visitor's credential, in a task of its own: a hang-up never cuts it short. Three streams per session
    and thirty per address may be open at once: a session's fourth closes its oldest (opening a stream is never
    refused for its session's streams, so a reload never is), and past the address's thirty it is 429. A closed
    stream ends even while its client has stopped reading, and its place is freed once it has ended, however it
    ended."""
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
                                on_open=on_open, wakeup=wakeup, on_end=slot.release)
    except BaseException:
        slot.release()
        raise
    set_visitor_cookie(response, slug, token)
    return response


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


# Verification and the Demo inbox -----------------------------------------------------------------------------


class VerifyStartIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    contact: Annotated[str, StringConstraints(min_length=3, max_length=120)]    # the kernel's contact bound


@router.post("/desks/{slug}/verify/start", response_model=VerifyStarted,
             responses=error_responses(401, 409, 422, 429, 503))
async def verify_start(body: VerifyStartIn, request: Request,
                       ctx: Annotated[VisitorCtx, Depends(visitor_ctx)]) -> VerifyStarted:
    """Ask for a code for the contact the visitor typed. The kernel sends it only to the contact on record, as a Demo
    inbox entry, and answers with one message whether or not the contact is on record; the visitor's stream gets the
    entry's code-free notice. Owner alerts never reach the visitor, here or on the stream."""
    state = runtime(request).started()
    await state.limiter.enforce("verify", ctx.ids.session_id, ledger=ctx.ledger())
    started = await ctx.caller.kernel.call("POST /verify/start", VerifyStartRequest(
        session_id=ctx.ids.session_id, contact=body.contact))
    started = started.model_copy(update={"inbox": [notice for notice in started.inbox if notice.to != OWNER]})
    conn = ctx.conn
    await conn.commit()
    try:
        await emit_inbox(conn, ctx.ids, started.inbox)
        await conn.commit()
    except BaseException:
        await conn.rollback()
        raise
    return started


class VerifyCheckIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: Annotated[str, StringConstraints(pattern=r"^[0-9]{6}$")]          # six ASCII digits


@router.post("/desks/{slug}/verify/check", response_model=VerifyChecked,
             responses=error_responses(401, 409, 422, 429, 503))
async def verify_check(body: VerifyCheckIn, request: Request,
                       ctx: Annotated[VisitorCtx, Depends(visitor_ctx)]) -> VerifyChecked:
    """The code the visitor typed into the verify card, checked by the kernel; it is never stored, logged, streamed or
    shown to Claude. A wrong, expired or used-up code is the kernel's 422 `{"error": "kernel", "code": "invalid"}`,
    and a code that isn't six digits 422 `{"error": "invalid"}`: the card shows one message for both. Once the session
    is verified, a note tells Claude (it wakes a turn, which gets the verified tools)."""
    state = runtime(request).started()
    await state.limiter.enforce("verify", ctx.ids.session_id, ledger=ctx.ledger())
    checked = await ctx.caller.kernel.call("POST /verify/check", VerifyCheckRequest(
        session_id=ctx.ids.session_id, code=body.code))
    if checked.verified:                            # noted once a session, whichever check found it verified
        conn = ctx.conn
        await conn.commit()
        try:
            noted = await append_note_once(conn, ctx.ids, NOTES["verified"], wake=True)
            await conn.commit()
        except BaseException:
            await conn.rollback()
            raise
        if noted is not None:
            state.runner.start(ctx.caller)
    return VerifyChecked(state=checked)


@router.get("/desks/{slug}/demo_inbox", response_model=list[DemoInboxEntry],
            responses=error_responses(401, 422, 503))
async def demo_inbox(response: Response, ctx: Annotated[VisitorCtx, Depends(visitor_ctx)]) -> list[DemoInboxEntry]:
    """The session's Demo inbox, read from the kernel with the visitor's credential: the codes sent for the
    verifications this session started, never an owner alert. Its bodies hold codes, so the answer is never stored,
    here or in a cache."""
    response.headers["Cache-Control"] = NO_STORE
    return await ctx.caller.kernel.call("GET /demo_inbox?session_id=", query={"session_id": ctx.ids.session_id})


# Demo agents -------------------------------------------------------------------------------------------------


async def _mint_agent(ctx: VisitorCtx) -> DemoAgentIssued:
    """A demo agent the kernel mints for the visitor's session on its Desk; a kernel 429 passes through."""
    return await ctx.caller.kernel.call("POST /agents/demo", DemoAgentRequest(desk_id=ctx.ids.desk_id))


@router.post("/desks/{slug}/agents/key", response_model=DemoAgentIssued,
             responses=error_responses(401, 404, 422, 429, 503))
async def agent_key(request: Request, response: Response,
                    ctx: Annotated[VisitorCtx, Depends(visitor_ctx)]) -> DemoAgentIssued:
    """A demo key for connecting an agent of the visitor's own: its key ID, its Ed25519 private key and a spending
    limit the demo wallet signed, which the agent sends when it opens its session at the A2A endpoint. The key is
    handed over in this answer once and kept nowhere, here or in a cache. Five demo agents a copy an hour, this and
    sending the built-in one together."""
    state = runtime(request).started()
    await state.limiter.enforce("demo_agent", ctx.ids.copy_id, ledger=ctx.ledger())
    issued = await _mint_agent(ctx)
    response.headers["Cache-Control"] = NO_STORE
    return issued


@router.get("/desks/{slug}/agent_tasks", response_model=AgentTasks, responses=error_responses(401, 422, 503))
async def agent_tasks(response: Response, ctx: Annotated[VisitorCtx, Depends(visitor_ctx)]) -> AgentTasks:
    """Which words the built-in agent's tasks take on the visitor's Desk, the set its first message comes from
    (`agents.demo_task_set`): the business type setup stored for the Desk, or Turner's on the copy's own Desk. A key
    the page words its task chips by, never text of the Desk's. Read with the visitor's session; never cached."""
    task_set = await demo_task_set(ctx.conn, ctx.ro, ctx.ids.desk_id)
    await ctx.conn.commit()
    response.headers["Cache-Control"] = NO_STORE
    return AgentTasks(task_set=task_set)


class SendAgentIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    task: DemoTask
    idempotency_key: IdempotencyKey                     # one per click, required (`send_agent`)


def _keyed(agents: DemoAgents, ctx: VisitorCtx, body: SendAgentIn, slug: str, *,
           claim: bool) -> tuple[str | None, DemoAgentRun | None]:
    """The run the body's key started in the copy, and with `claim`, a new run's record when the copy doesn't hold the
    key yet (taken with no await between the check and the claim); 409 `conflict` when the key's request had another
    body, or came from another session or went to another Desk, and 429 `rate_limited` while the key map is full."""
    key, sha = body.idempotency_key, body_sha256(body.model_dump(mode="json", exclude={"idempotency_key"}))
    try:
        if not claim:
            return agents.keyed(ctx.ids.copy_id, key, sha, slug, ctx.ids), None
        return agents.claim(ctx.ids.copy_id, key, sha, body.task, slug, ctx.ids)
    except KeyReused:
        raise ApiProblem(409, "conflict") from None
    except KeysFull as full:
        raise RateLimited(full.retry_after) from None


@router.post("/desks/{slug}/send_agent", status_code=202, response_model=AgentRunStarted,
             responses=error_responses(401, 404, 409, 422, 429, 503))
async def send_agent(slug: str, body: SendAgentIn, request: Request,
                     ctx: Annotated[VisitorCtx, Depends(visitor_ctx)]) -> AgentRunStarted:
    """Send the built-in visiting agent, Alex Kim's assistant, to the Desk on one of the demo tasks; it runs in this
    process and talks to the Desk through the public A2A endpoint. Poll its run each second with the ID answered
    here. Five demo agents a copy an hour; 503 `demo_budget` once today's model budget is spent.

    Each send carries an `idempotency_key`, one per click (422 without one, as for any missing field). A repeat in
    the copy within the hour answers the run the first started (its ID; poll it for its state) and starts nothing, and
    a repeat that finds the key never counts on the limit. One with another task, or from another session or to
    another Desk than the key's, is 409 `conflict`. The key is claimed once the limit and the budget let the request
    through, before the kernel mints the agent. A request is admitted (looked up, counted and claimed) under its key's
    lock in this process, so a repeat sent meanwhile waits for that admission, then answers the run; another process
    admits on its own, so during a deploy's overlap a repeat routed to the other task can be counted twice. Keys live
    in this process's memory, like the runs, each for its run's hour; while 1000 are held, a new one is 429
    `rate_limited` until the oldest one's hour ends.

    A request that fails before anything is made (refused by the limit or the budget, or the kernel refused to mint the
    agent with a 4xx) frees its key, so the same request can be sent again. Once the kernel may have minted the agent
    (no answer came back, or a 5xx) or the run started, the key keeps the run however it ends, a failed one too, and a
    new click sends a new key.

    The agent's task is the fixed line of the Desk's set (`agents.demo_task_set`: its setup business type, or Turner's
    for the copy's own Desk), read before anything is claimed."""
    state = runtime(request).started()
    key = body.idempotency_key
    task_set = await demo_task_set(ctx.conn, ctx.ro, ctx.ids.desk_id)
    await ctx.conn.commit()
    async with state.agents.admissions.admitting(ctx.ids.copy_id, key):
        run_id, _ = _keyed(state.agents, ctx, body, slug, claim=False)
        if run_id is not None:
            return AgentRunStarted(run_id=run_id)
        # The key map is full: refused before the limit counts it. Other keys can still fill it while the limit counts
        # this one, and `claim` then refuses a send the limit counted (accepted).
        wait = state.agents.key_wait()
        if wait is not None:
            raise RateLimited(wait)
        await state.limiter.enforce("demo_agent", ctx.ids.copy_id, ledger=ctx.ledger())
        await require_model_budget(request)
        run_id, claimed = _keyed(state.agents, ctx, body, slug, claim=True)
        if claimed is None:                     # never in practice: only claim adds a key, under this key's lock
            return AgentRunStarted(run_id=run_id)
    try:
        issued = await _mint_agent(ctx)
    except KernelFailed:                        # a definite refusal: nothing was made, so the key is free again
        state.agents.free(ctx.ids.copy_id, key, claimed, "the kernel refused to mint the agent")
        raise
    except BaseException:                       # the agent may exist: the key keeps the failed run for good
        state.agents.fail(claimed, "the agent's mint went unanswered")
        raise
    return AgentRunStarted(run_id=state.agents.launch(issued, body.task, slug, ctx.ids, run=claimed,
                                                      task_set=task_set))


@router.get("/desks/{slug}/send_agent/{run_id}", response_model=DemoAgentRun,
            responses=error_responses(401, 404, 422, 503))
async def agent_run(run_id: Annotated[str, Path(max_length=64)], request: Request, response: Response,
                    ctx: Annotated[VisitorCtx, Depends(visitor_ctx)]) -> DemoAgentRun:
    """The built-in agent's run as it stands, for the session that sent it (any other is 404): each message the agent
    sent, exactly as sent, as the agent's own untrusted words, and what the Desk answered, as the kernel checked it.
    Kept for an hour. Never cached: a Desk turn can carry a payment link."""
    run = runtime(request).started().agents.run(run_id, ctx.ids.session_id)
    if run is None:
        raise ApiProblem(404, "not_found")
    response.headers["Cache-Control"] = NO_STORE
    return run
