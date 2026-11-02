"""The owner's routes, under `/api/owner/`: the only paths the owner cookie is sent to.

Creating a copy is the one call that needs the passcode. Every other owner route takes the copy from the
kernel's `GET /whoami` answer for the owner cookie (`deps.owner_ctx`), never from the browser.

A new copy (`copies`, `start_over`) stores the seeded hold's visitor question and signed held receipt. It also asks
the kernel for the recorded night when the settings do (Plan 01d), and stores what the kernel replayed into it
(`store_replayed_night`) before answering: recorded history for the owner's reads, never a turn.
"""

import asyncio
import logging
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Path, Query, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, StringConstraints
from sqlalchemy import exists, select
from sqlalchemy.ext.asyncio import AsyncConnection

from desk.api.cookies import set_owner_cookie, set_visitor_cookie
from desk.api.deliver import NOT_FINAL, Reply, Status, deliver, run_lock, status_shown, visitor_safe
from desk.api.deps import ApiProblem, OwnerCtx, Runtime, client_ip, owner_context, owner_ctx, runtime
from desk.api.jobs import defer_resume_after_answer, resume_after_answer
from desk.api import owner_reads
from desk.api.kernel_client import KernelFailed, KernelUnavailable
from desk.api.passcode import check_passcode
from desk.api.prompts import NOTES
from desk.api.ratelimit import RateLimitLedger
from desk.api.ro import KernelRO
from desk.api.schemas import (
    AlreadyResolved,
    AnsweringIn,
    ApiError,
    ApprovalAnswerIn,
    ApprovalAnswerOut,
    Attempt,
    BriefingList,
    BusinessOut,
    ConversationSummary,
    CopyOut,
    DeskSetup,
    DeskSummary,
    GenerationIn,
    NeedsYouItem,
    OwnerMessageIn,
    OwnerTranscript,
    PeopleOut,
    PersonOnRecord,
    Reports,
    Today,
    VisitorSession,
    error_responses,
    operation_ids,
)
from desk.api.sse import RUN_EVENTS, append_control, emit
from desk.api.store import (MESSAGES, Ids, Replayed, append_message, blocks_text, clear_hand_back_wake, has_pending,
                            has_unanswered_message, transcript)
from desk.contracts import (CopyCreated, Decision, DemoInboxEntry, LedgerPage, OwnerMessageResult, SessionState,
                            effective_brand)
from desk.events import EvOwnerJoined, EvOwnerLeft, EvOwnerTyping
from desk.kernel_api import (
    AnswerRequest,
    CreateCopyRequest,
    CreateDeskRequest,
    CreateSessionRequest,
    DeskAnsweringRequest,
    DeskBusinessRequest,
    DeskCalendarRequest,
    DeskCharterRequest,
    DeskCreated,
    DeskHoursRequest,
    DeskNotificationsRequest,
    DeskPeopleRequest,
    DeskPricesRequest,
    DeskUpdated,
    ModeRequest,
    OwnerMessageRequest,
)

router = APIRouter(prefix="/api/owner", generate_unique_id_function=operation_ids("owner"))
logger = logging.getLogger(__name__)


class CopyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    passcode: Annotated[str, StringConstraints(min_length=1, max_length=200)]


async def _desks(ctx: OwnerCtx) -> tuple[list[dict], dict[str, dict], dict[str, DeskSetup]]:
    """The copy's Desks in the order they were made and their businesses by ID, from its kernel_ro rows, and the
    unfinished setup interviews by Desk ID, from the API's own rows."""
    # Deleted Desks still consume pending setup claims; whoami lists only the active Desks to show.
    all_desks = await ctx.ro.desks()
    desks = [row for row in all_desks if row["desk_id"] in ctx.desk_ids]
    businesses = {row["business_id"]: row
                  for row in await ctx.ro.rows("businesses", business_id=[desk["business_id"] for desk in desks])}
    return desks, businesses, await owner_reads.unfinished_setups(ctx, all_desks)


def _summary(desk: dict, business: dict, setups: dict[str, DeskSetup]) -> DeskSummary:
    return DeskSummary(desk_id=desk["desk_id"], slug=desk["slug"], name=desk["name"], business_name=business["name"],
                       hours=desk["hours"], answering=desk["answering"], setup=setups.get(desk["desk_id"]))


async def copy_out(ctx: OwnerCtx) -> CopyOut:
    """The copy's Desks, from its kernel_ro rows, in the order they were made, each with its unfinished setup."""
    desks, businesses, setups = await _desks(ctx)
    return CopyOut(copy_id=ctx.copy_id,
                   desks=[_summary(desk, businesses[desk["business_id"]], setups) for desk in desks])


# A replayed visitor's words, by the kind of session they were said in; and the record each event kind carries
# (text, verdict, decision).
REPLAYED_TEXT = {"visitor": "visitor_text", "agent": "agent_text"}
EVENT_RECORDS = {"visitor_message": (True, False, False), "reply": (False, True, False),
                 "receipt": (False, False, True)}


async def store_replayed_night(conn: AsyncConnection, created: CopyCreated, *, ro_schema: str) -> int:
    """Store the night the kernel replayed into a new copy (Plan 01d) in the copy's transcripts, in the caller's
    transaction, and return how many events it stored. Each event, in shown order, is written at the moment it was
    shown with the copy's `replay_id`: a visitor's words as `visitor_text` (an agent's as `agent_text`), a reply
    through `deliver()` as Claude's via the API or the Desk's via the kernel, and a receipt as its final decision.
    A copy without a `replay_id` stores nothing. An event that doesn't fit fails the whole night: a session that isn't one of the
    copy's closed visitor or agent sessions, an event without the one record its kind carries, a decision that isn't
    final or is another session's, or an event deliver() wouldn't show."""
    if created.replay_id is None:
        return 0
    events = sorted(created.replayed_messages, key=lambda event: datetime.fromisoformat(event.shown_at))
    ro, sessions = KernelRO(conn, created.copy_id, ro_schema), {}
    for session_id in sorted({event.session_id for event in events}):
        session = await ro.session(session_id)
        if (session is None or session["desk_id"] not in created.desk_ids or session["kind"] not in REPLAYED_TEXT
                or session["closed_at"] is None):
            raise ValueError("a replayed event names a session that isn't one of the copy's closed conversations")
        sessions[session_id] = session
        await run_lock(conn, session_id)              # the run lock before any events lock, as deliver() takes them
    for event in events:
        session = sessions[event.session_id]
        ids = Ids(copy_id=created.copy_id, desk_id=session["desk_id"], session_id=event.session_id)
        replayed = Replayed(replay_id=created.replay_id, at=datetime.fromisoformat(event.shown_at))
        if (event.text is not None, event.verdict is not None, event.decision is not None) != EVENT_RECORDS[event.kind]:
            raise ValueError(f"a replayed {event.kind} doesn't carry its record")
        if event.kind == "visitor_message":
            await append_message(conn, ids, REPLAYED_TEXT[session["kind"]], text=event.text, replayed=replayed)
            continue
        if event.kind == "reply":
            item: Reply | Status = Reply(event.verdict, author=event.author,
                                         via="kernel" if event.author == "desk" else "api")
        else:
            decision = event.decision
            if decision.session_id != event.session_id or decision.state in NOT_FINAL:
                raise ValueError("a replayed receipt shows a final decision of its own session")
            item = Status(decision, "resolved" if decision.outcome == "hold" else "receipt")
        if await deliver(conn, ids, item, ro_schema=ro_schema, replayed=replayed) is None:
            raise ValueError(f"a replayed {event.kind} wouldn't be shown")
    return len(events)


async def _store_replayed(state: Runtime, created: CopyCreated) -> None:
    """Store the copy's replayed night in a transaction of its own, once the copy exists. A replay never fails the
    copy: when storing fails, nothing replayed is stored, the error's type alone is logged, and the copy is answered
    with live data only."""
    if created.replay_id is None or not created.replayed_messages:
        return
    try:
        async with state.database().connect() as conn:
            await store_replayed_night(conn, created, ro_schema=state.settings.kernel_ro_schema)
            await conn.commit()
    except Exception as error:
        logger.error("the replayed night couldn't be stored (%s); the copy has live data only", type(error).__name__)


async def store_seeded_chat(conn: AsyncConnection, created: CopyCreated, *, ro_schema: str) -> int:
    """Store the seeded visitor's question and signed held receipt together, in the caller's transaction.

    An existing visitor row guards retries under the run lock. A dropped receipt raises so the caller rolls back
    the question too; a seed must never leave half a chat. Only deliver() builds the signed held event.
    """
    chat = created.seeded_chat
    if chat is None:
        return 0
    await run_lock(conn, chat.session_id)
    session = await KernelRO(conn, created.copy_id, ro_schema).session(chat.session_id)
    if (session is None or session["desk_id"] not in created.desk_ids or session["kind"] != "visitor"
            or session["closed_at"] is not None):
        logger.warning("the seeded chat wasn't stored: not an open visitor session on one of the copy's Desks")
        return 0
    if (await conn.execute(select(exists().where(
            MESSAGES.c.copy_id == created.copy_id, MESSAGES.c.session_id == chat.session_id,
            MESSAGES.c.kind == "visitor_text")))).scalar_one():
        return 0
    ids = Ids(copy_id=created.copy_id, desk_id=session["desk_id"], session_id=chat.session_id)
    await append_message(conn, ids, "visitor_text", text=chat.visitor_line)
    if await deliver(conn, ids, Status(chat.decision, "held"), ro_schema=ro_schema) is None:
        raise ValueError("the seeded held receipt wouldn't be shown")
    return 2


async def _store_seeded(state: Runtime, created: CopyCreated) -> None:
    """Keep the seeded chat independent of the recorded night; neither writer can fail copy creation."""
    if created.seeded_chat is None:
        return
    try:
        async with state.database().connect() as conn:
            await store_seeded_chat(conn, created, ro_schema=state.settings.kernel_ro_schema)
            await conn.commit()
    except Exception as error:
        logger.error("the seeded chat couldn't be stored (%s); the copy is still available", type(error).__name__)


async def _create_copy(state: Runtime) -> CopyCreated:
    """`POST /copies`, asking for the recorded night when the settings do (`replay_night`). A kernel without the
    seeded night refuses a body that carries `replay_night` at all (422 `invalid`, which creates nothing), so a live
    copy is asked for with a body that leaves the field out (`POST /copies` sends only the fields set): at once when
    the settings ask for no replay, and once more after that refusal otherwise, and that answer stands."""
    kernel = state.kernel.public()
    if not state.settings.replay_night:
        return await kernel.call("POST /copies", CreateCopyRequest())
    try:
        return await kernel.call("POST /copies", CreateCopyRequest(replay_night=True))
    except KernelFailed as failure:
        if (failure.status, failure.code) != (422, "invalid"):
            raise
    logger.warning("the kernel refused to replay the recorded night; the copy has live data only")
    return await kernel.call("POST /copies", CreateCopyRequest())


async def _new_copy(state: Runtime, response: Response) -> CopyOut:
    """A new copy of the Turner seed, read back through its own owner token, which goes only into the cookie. It asks
    for the recorded night when the settings do (`replay_night`). The seeded hold's chat commits first, then the
    replayed night in its own transaction, so either can be stored even if the other fails."""
    created = await _create_copy(state)
    await _store_seeded(state, created)
    await _store_replayed(state, created)
    async with owner_context(state, created.owner_token) as ctx:
        copy = await copy_out(ctx)
    set_owner_cookie(response, created.owner_token)
    return copy


@router.post("/copies", status_code=201, response_model=CopyOut, responses=error_responses(401, 422, 429, 503))
async def create_copy(body: CopyRequest, request: Request, response: Response) -> CopyOut:
    """A fresh copy of the Turner seed for whoever holds the passcode, and the owner cookie for it."""
    state = runtime(request).started()
    ip = client_ip(request)
    await state.limiter.enforce("passcode", ip)          # counts the attempt; a right passcode gives it back
    if not await asyncio.to_thread(check_passcode, body.passcode, state.settings.passcode_hash):
        raise ApiProblem(401, "wrong_passcode")
    state.limiter.forget("passcode", ip)
    await state.limiter.enforce("copies", ip)
    return await _new_copy(state, response)


@router.post("/start_over", response_model=CopyOut, responses=error_responses(401, 429, 503))
async def start_over(request: Request, response: Response, ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> CopyOut:
    """A fresh copy for an owner who already has one; the old copy is left as it is, and the cookie moves on."""
    state = runtime(request).started()
    await state.limiter.enforce("copies", client_ip(request), ledger=ctx.ledger())
    return await _new_copy(state, response)


@router.get("/me", response_model=CopyOut, responses=error_responses(401, 503))
async def me(ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> CopyOut:
    """The copy the owner cookie names."""
    return await copy_out(ctx)


# Desks -------------------------------------------------------------------------------------------------------


@router.get("/desks", response_model=list[BusinessOut], responses=error_responses(401, 503))
async def desks(ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> list[BusinessOut]:
    """The copy's businesses, each with its Desks, in the order the Desks were made: the Desk switcher. Each Desk
    names its setup interview while that isn't finished."""
    found, businesses, setups = await _desks(ctx)
    listed: dict[str, BusinessOut] = {}
    for desk in found:
        business = businesses[desk["business_id"]]
        if business["business_id"] not in listed:
            listed[business["business_id"]] = BusinessOut(
                business_id=business["business_id"], name=business["name"],
                owner_display_name=business["owner_display_name"], timezone=business["timezone"],
                brand=effective_brand(business["brand"] or {}), desks=[])
        listed[business["business_id"]].desks.append(_summary(desk, business, setups))
    return list(listed.values())


@router.post("/desks", status_code=201, response_model=DeskCreated,
             responses=error_responses(401, 404, 422, 429, 503))
async def create_desk(body: CreateDeskRequest, request: Request,
                      ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> DeskCreated:
    """A new Desk in the owner's copy, made by the kernel with the owner's credential: for a new business, or for one
    of the copy's businesses (`existing_business_id`, whose name, owner name and time zone it keeps). The kernel
    activates the starter rules (every request asks, but for the utility tools) and refuses what a new Desk can't
    have: a money cap, connected tools, an owner name outside its pattern, an unknown time zone or another copy's
    business (404). Counts on the copy's `new_desk` limit (10 an hour)."""
    await runtime(request).started().limiter.enforce("new_desk", ctx.copy_id, ledger=ctx.ledger())
    return await ctx.kernel.call("POST /desks", body)


DeskId = Annotated[str, Path(max_length=128)]


@router.delete("/desks/{desk_id}", status_code=204, response_class=Response,
               responses=error_responses(401, 404, 409, 422, 503))
async def delete_desk(desk_id: DeskId, ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> Response:
    """Delete one of the copy's Desks, through the kernel with the owner's credential: its chats close, its public
    page and links stop working, and it leaves the copy's Desks; its ledger is kept. A Desk of another copy, or one
    already deleted, is 404 before anything is sent."""
    await ctx.kernel.call("DELETE /desks/{id}", path={"id": ctx.desk(desk_id)})
    return Response(status_code=204)


@router.put("/desks/{desk_id}/answering", response_model=DeskUpdated, responses=error_responses(401, 404, 422, 503))
async def answering(desk_id: DeskId, body: AnsweringIn,
                    ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> DeskUpdated:
    """The Answering switch, set by the kernel with the owner's credential. Off, visitors can only leave their
    details or ask for a callback; the owner's own previews keep every tool."""
    return await ctx.kernel.call("PUT /desks/{id}/answering", DeskAnsweringRequest(on=body.on),
                                 path={"id": ctx.desk(desk_id)})


# A Desk's parts, one route each: the kernel replaces that part (people are upserted and removed by `ref`), checks it
# and ledgers the change. A Desk of another copy is 404 before anything is sent; a deleted one is the kernel's 409.
PART_ERRORS = error_responses(401, 404, 409, 422, 503)


async def _put_part(ctx: OwnerCtx, desk_id: str, part: str, body: BaseModel) -> DeskUpdated:
    return await ctx.kernel.call(f"PUT /desks/{{id}}/{part}", body, path={"id": ctx.desk(desk_id)})


@router.put("/desks/{desk_id}/business", response_model=DeskUpdated, responses=PART_ERRORS)
async def update_business(desk_id: DeskId, body: DeskBusinessRequest,
                          ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> DeskUpdated:
    """The business the Desk belongs to: its name, the owner's name customers see, its time zone and brand, for every
    Desk of that business."""
    return await _put_part(ctx, desk_id, "business", body)


@router.put("/desks/{desk_id}/charter", response_model=DeskUpdated, responses=PART_ERRORS)
async def update_charter(desk_id: DeskId, body: DeskCharterRequest,
                         ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> DeskUpdated:
    """What the Desk tells the public about the business (contact, service area, policies), in place of before."""
    return await _put_part(ctx, desk_id, "charter", body)


@router.put("/desks/{desk_id}/hours", response_model=DeskUpdated, responses=PART_ERRORS)
async def update_hours(desk_id: DeskId, body: DeskHoursRequest,
                       ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> DeskUpdated:
    """The opening hours, in the business's time zone."""
    return await _put_part(ctx, desk_id, "hours", body)


@router.put("/desks/{desk_id}/prices", response_model=DeskUpdated, responses=PART_ERRORS)
async def update_prices(desk_id: DeskId, body: DeskPricesRequest,
                        ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> DeskUpdated:
    """The price list, in place of before; quotes already given keep their amounts."""
    return await _put_part(ctx, desk_id, "prices", body)


@router.put("/desks/{desk_id}/calendar", response_model=DeskUpdated, responses=PART_ERRORS)
async def update_calendar(desk_id: DeskId, body: DeskCalendarRequest,
                          ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> DeskUpdated:
    """The bookable slots, in place of before; the kernel keeps a slot that is booked or waiting on a request."""
    return await _put_part(ctx, desk_id, "calendar", body)


@router.put("/desks/{desk_id}/people", response_model=DeskUpdated, responses=PART_ERRORS)
async def update_people(desk_id: DeskId, body: DeskPeopleRequest,
                        ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> DeskUpdated:
    """People on record, upserted and removed by `ref`. Verification codes go only to a person's contact, so the
    kernel refuses a contact that looks masked (as the owner is shown it) and keeps the one on record when `contact`
    is null; its refusal is passed on as it is."""
    return await _put_part(ctx, desk_id, "people", body)


@router.put("/desks/{desk_id}/notifications", response_model=DeskUpdated, responses=PART_ERRORS)
async def update_notifications(desk_id: DeskId, body: DeskNotificationsRequest,
                               ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> DeskUpdated:
    """What alerts the owner at once and what waits for the briefing."""
    return await _put_part(ctx, desk_id, "notifications", body)


@router.post("/desks/{desk_id}/preview_session", response_model=VisitorSession,
             responses=error_responses(401, 404, 409, 422, 429, 503))
async def preview_session(desk_id: DeskId, request: Request, response: Response,
                          ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> VisitorSession:
    """A new chat on the Desk as a customer, for its owner: the kernel opens it with the owner's credential as a
    visitor session marked `preview`, which keeps the visitor tools while Answering is off (setup's try-out before
    going live). Its token goes only into the visitor cookie for the Desk's public routes, so the public chat then
    runs as that session. Like any new chat it counts toward the address's `new_chat` limit."""
    state = runtime(request).started()
    desk = await ctx.ro.one("desks", desk_id=ctx.desk(desk_id))
    if desk is None:
        raise ApiProblem(404, "not_found")
    ledger = RateLimitLedger(ctx.kernel, desk_id=desk_id, session_id=ctx.owner_session_id)   # the Desk previewed
    await state.limiter.enforce("new_chat", client_ip(request), ledger=ledger)
    created = await ctx.kernel.call("POST /sessions",
                                    CreateSessionRequest(desk_slug=desk["slug"], kind="visitor", preview=True))
    set_visitor_cookie(response, desk["slug"], created.session_token)
    return VisitorSession(state=created.state, resumed=False)


@router.get("/desks/{desk_id}/people", response_model=PeopleOut, responses=error_responses(401, 404, 422, 503))
async def people(desk_id: DeskId, ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> PeopleOut:
    """The people on record, in the order they were added, each with the masked contact the kernel keeps for owners'
    screens, and the leads visitors left, newest first, their names and notes as typed (untrusted text)."""
    desk_id = ctx.desk(desk_id)
    on_record = sorted(await ctx.ro.rows("people", desk_id=desk_id),
                       key=lambda row: (owner_reads.utc(row["created_at"]), row["person_id"]))
    return PeopleOut(
        people=[PersonOnRecord(person_id=row["person_id"], display_name=row["display_name"],
                               masked_contact=row["masked_contact"]) for row in on_record],
        leads=await owner_reads.leads(ctx, desk_id))


@router.get("/desks/{desk_id}/today", response_model=Today, responses=error_responses(401, 404, 422, 503))
async def today(desk_id: DeskId, request: Request, ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> Today:
    """Today on the Desk, computed from the rows on each read (so polling never empties it): how many things need the
    owner, the live conversations, the briefing since 18:00 yesterday and the last 7 days, in the business's time
    zone."""
    return await owner_reads.today(ctx, ctx.desk(desk_id), runtime(request).clock())


@router.get("/desks/{desk_id}/briefing", response_model=BriefingList,
            responses=error_responses(401, 404, 422, 503))
async def briefing(desk_id: DeskId, request: Request, ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> BriefingList:
    """Every briefing item since 18:00 yesterday in the business's time zone, newest first: the list Today's
    briefing links to."""
    return await owner_reads.briefing_list(ctx, ctx.desk(desk_id), runtime(request).clock())


@router.get("/desks/{desk_id}/reports", response_model=Reports, responses=error_responses(401, 404, 422, 503))
async def reports(desk_id: DeskId, request: Request, ctx: Annotated[OwnerCtx, Depends(owner_ctx)],
                  days: Annotated[int, Query(ge=1, le=365)] = 30) -> Reports:
    """The last `days` local dates on the Desk, today included, in the business's time zone: bookings, the money
    paid, and the conversations Claude handled alone versus the ones that needed the owner."""
    return await owner_reads.reports(ctx, ctx.desk(desk_id), runtime(request).clock(), days)


@router.get("/desks/{desk_id}/conversations", response_model=list[ConversationSummary],
            responses=error_responses(401, 404, 422, 503))
async def conversations(desk_id: DeskId, ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> list[ConversationSummary]:
    """The Desk's conversations, the latest activity first; the owner's own previews included."""
    return await owner_reads.conversations(ctx, ctx.desk(desk_id))


@router.get("/conversations/{session_id}", response_model=OwnerTranscript,
            responses=error_responses(401, 404, 422, 503))
async def conversation(session_id: Annotated[str, Path(max_length=128)], request: Request,
                       ctx: Annotated[OwnerCtx, Depends(owner_ctx)],
                       after: Annotated[int, Query(ge=0)] = 0) -> OwnerTranscript:
    """A conversation on one of the copy's Desks, as the owner sees it, after the cursor `after` (polled every 2 s).
    The cursor never skips a row: a session's rows commit in the order of their `n`. `typing_until` is when the
    visitor's typing dots stop, while they are typing (presence in this process's memory, never stored).
    Status reasons are read concurrently with the owner's kernel credential, with bounded caching for final
    execution refusals; an unreadable reason is null, so the stored transcript still renders."""
    session = await ctx.ro.session(session_id)
    if session is None or session["desk_id"] not in ctx.desk_ids:
        raise ApiProblem(404, "not_found")
    ids = Ids(copy_id=ctx.copy_id, desk_id=session["desk_id"], session_id=session_id)
    state = SessionState(session_id=session_id, kind=session["kind"], verified=session["verified"],
                         assurance=session["assurance"], mode=session["mode"], generation=session["generation"])
    process = runtime(request)
    items = await transcript(ctx.ro.conn, ids, "owner", after)
    statuses = [item for item in items if item.kind == "status" and item.event is not None]
    reasons = await asyncio.gather(*(owner_reads.refusal_reason(
        ctx, item.event.decision_id, session_id, item.event.state, item.event.ledger_seq) for item in statuses))
    for item, reason in zip(statuses, reasons, strict=True):
        item.owner_plain = reason
    return OwnerTranscript(state=state, items=items,
                           typing_until=process.presence.visitor_typing_until(session_id, process.clock()),
                           replayed=await owner_reads.transcript_replayed(ctx, session["desk_id"], session_id))


@router.get("/desks/{desk_id}/safety", response_model=list[Attempt], responses=error_responses(401, 404, 422, 503))
async def safety(desk_id: DeskId, ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> list[Attempt]:
    """The Desk's refused requests and Claude's stopped drafts, newest first. Today and Safety count refused requests
    only (owner decision, 2026-10-31). Each refusal's nullable `cause` comes from its decision's `policy_ids` and
    its ledger decide summary's `reason`/`check` and the session's verified state; drafts have no cause."""
    return await owner_reads.attempts(ctx, ctx.desk(desk_id))


@router.get("/demo_inbox", response_model=list[DemoInboxEntry], responses=error_responses(401, 503))
async def demo_inbox(response: Response, ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> list[DemoInboxEntry]:
    """The copy's Demo inbox, read from the kernel with the owner's credential. Its bodies can hold verification
    codes, so the answer is never stored, here or in a cache."""
    response.headers["Cache-Control"] = "no-store"
    return await ctx.kernel.call("GET /demo_inbox")


@router.get("/desks/{desk_id}/ledger", response_model=LedgerPage, responses=error_responses(401, 404, 422, 503))
async def ledger(desk_id: DeskId, ctx: Annotated[OwnerCtx, Depends(owner_ctx)],
                 verify: Annotated[bool, Query(description="Always true: the kernel verifies every read")] = True,
                 ) -> LedgerPage:
    """The Desk's signed ledger, verified by the kernel on every read (its chain, `first_bad_seq` and key), passed
    on unchanged."""
    return await ctx.kernel.call("GET /ledger/{desk_id}?verify=true", path={"desk_id": ctx.desk(desk_id)})


# Held requests -----------------------------------------------------------------------------------------------


@router.get("/desks/{desk_id}/needs_you", response_model=list[NeedsYouItem],
            responses=error_responses(401, 404, 422, 503))
async def needs_you(desk_id: DeskId, ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> list[NeedsYouItem]:
    """What waits for the owner on the Desk: each held request as the kernel has it now (read with the owner's
    credential, which applies expiry), oldest first, then each open callback request."""
    return await owner_reads.needs_you(ctx, ctx.desk(desk_id))


@router.post("/handoffs/{handoff_id}/done", response_model=DeskUpdated,
             responses=error_responses(401, 404, 409, 422, 503))
async def handoff_done(handoff_id: Annotated[str, Path(max_length=128)],
                       ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> DeskUpdated:
    """Mark a callback request done, through the kernel with the owner's credential. A handoff that isn't on one of
    the copy's Desks is 404 and never sent. The kernel answers 409 `conflict` for one already done, and 409 `closed`
    for one whose Desk was deleted after the copy's Desks were read; the route passes either on."""
    row = await ctx.ro.one("handoffs", handoff_id=handoff_id)
    if row is None or row["desk_id"] not in ctx.desk_ids:
        raise ApiProblem(404, "not_found")
    return await ctx.kernel.call("POST /handoffs/{id}/done", path={"id": handoff_id})


@router.get("/decisions/{decision_id}", response_model=Decision, responses=error_responses(401, 404, 422, 503))
async def decision(decision_id: Annotated[str, Path(max_length=128)],
                   ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> Decision:
    """A decision of the copy as the kernel signed it, read with the owner's credential (which applies expiry). One of
    another copy is the kernel's 404; a decision the kernel answered for that isn't on one of the copy's Desks is 404
    too, so no other copy's record is ever passed on."""
    found = await ctx.kernel.call("GET /decisions/{id}", path={"id": decision_id})
    row = await ctx.ro.one("decisions", decision_id=found.decision_id)
    if found.decision_id != decision_id or row is None or row["desk_id"] not in ctx.desk_ids:
        raise ApiProblem(404, "not_found")
    return found


@router.post("/approvals/{decision_id}/answer", response_model=ApprovalAnswerOut,
             responses={**error_responses(401, 404, 422, 503), 409: {"model": AlreadyResolved | ApiError}})
async def answer_approval(decision_id: Annotated[str, Path(max_length=128)], body: ApprovalAnswerIn,
                          request: Request,
                          ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> ApprovalAnswerOut | JSONResponse:
    """The owner's answer to a held request. The kernel decides it with the owner's credential, and an allow runs
    there and then, as the visitor's session (also during a take-over); the visitor sees the signed approved status
    before the outcome when the answer includes it, and Claude follows up once the resume job ran and the visitor's
    own credential is present (the open stream or the next
    request). Drafted rule cards come back in `card_diff`; proving them is a rules route's work, so an answer never
    waits on a proof.

    When the kernel refuses the answer (409: answered before, expired or cancelled) or its response is lost, the
    decision is read as it stands: once it left `held` and `approved`, an outcome the visitor wasn't shown yet gets
    the (idempotent) resume job, so a lost response still resumes the chat. While `approved`, publish its signed
    receipt without waking Claude and leave a `decision_pending` row under the session's run lock. The visitor's
    next request can then read its final outcome even if the first answer never queues a job. Either case answers
    409 `already_resolved` with the decision. A decision still `held` keeps the kernel's own error, its code included
    ("Errors"): a 409 is
    `{error: "kernel", code}`, and an answer that never reached the kernel is 503, `seed_unproved` and `internal`
    kept. A decision that can't be read is 503 `kernel_unavailable`. In each case answering again is safe. An answer
    the request doesn't offer is the kernel's 422 `invalid`."""
    state = runtime(request).started()
    try:
        result = await ctx.kernel.call("POST /approvals/{decision_id}/answer", AnswerRequest(answer=body.answer),
                                       path={"decision_id": decision_id})
    except KernelFailed as failure:
        if failure.status != 409:
            raise
        return await _no_longer_held(state, ctx, decision_id, failure)
    except KernelUnavailable as failure:
        return await _no_longer_held(state, ctx, decision_id, failure)
    result_fact_ids = ([fact.fact_id for fact in result.execution.facts]
                       if result.execution is not None and result.execution.state == "succeeded"
                       and result.decision.state == "executed" else [])
    await _resume(state, ctx, result.decision, result.approved, result_fact_ids=result_fact_ids)
    return ApprovalAnswerOut(decision=result.decision, card_diff=result.card_diff,
                             execution_state=result.execution.state if result.execution is not None else None)


async def _no_longer_held(state: Runtime, ctx: OwnerCtx, decision_id: str,
                          failure: KernelFailed | KernelUnavailable) -> JSONResponse:
    """The answer of a request the kernel refused to answer, or whose answer's response was lost (route docstring)."""
    try:
        decision = await ctx.kernel.call("GET /decisions/{id}", path={"id": decision_id})
    except (KernelFailed, KernelUnavailable):
        raise ApiProblem(503, "kernel", code="kernel_unavailable") from None
    if decision.state == "held":                        # the answer didn't take: the kernel's own error stands
        raise failure
    if decision.state == "approved":
        await _remember_approval(ctx, decision)
    elif not await status_shown(ctx.ro.conn, decision, or_later=True):
        await _resume(state, ctx, decision)
    return JSONResponse(AlreadyResolved(decision=decision).model_dump(mode="json"), status_code=409)


async def _remember_approval(ctx: OwnerCtx, decision: Decision) -> None:
    """Keep an in-flight approval readable even when its answer's response and resume job were lost."""
    decision = visitor_safe(decision)
    session = await ctx.ro.session(decision.session_id)
    if session is None or session["desk_id"] not in ctx.desk_ids:
        logger.warning("an answered request's session isn't one of the copy's")
        return
    ids = Ids(copy_id=ctx.copy_id, desk_id=session["desk_id"], session_id=decision.session_id)
    conn = ctx.ro.conn
    await conn.commit()
    try:
        await run_lock(conn, ids.session_id)
        await deliver(conn, ids, Status(decision, "receipt"))
        pending = (await conn.execute(select(exists().where(
            RUN_EVENTS.c.session_id == ids.session_id, RUN_EVENTS.c.kind == "control",
            RUN_EVENTS.c.type == "decision_pending", RUN_EVENTS.c.handled_at.is_(None),
            RUN_EVENTS.c.payload["decision_id"].astext == decision.decision_id)))).scalar_one()
        if not pending:
            await append_control(conn, ids, "decision_pending", {"decision_id": decision.decision_id})
        await conn.commit()
    except BaseException:
        await conn.rollback()
        raise


async def _resume(state: Runtime, ctx: OwnerCtx, decision: Decision, approved: Decision | None = None,
                  result_fact_ids: list[str] | None = None) -> None:
    """Defer the resume job for the decision's session, named by the kernel's answer within the owner's copy. If the
    queue can't take it, the request does the job's work itself: like the job, it holds only IDs and signed
    records and makes no kernel call. Both paths publish the optional approved receipt before the outcome, with
    only the outcome waking Claude and naming the executed answer's result facts. If that fails too, the answer
    still stands, and the due-decisions job surfaces the outcome once it is final."""
    decision = visitor_safe(decision)
    approved = visitor_safe(approved) if approved is not None else None
    session = await ctx.ro.session(decision.session_id)
    if session is None or session["desk_id"] not in ctx.desk_ids:
        logger.warning("an answered request's session isn't one of the copy's")
        return
    ids = Ids(copy_id=ctx.copy_id, desk_id=session["desk_id"], session_id=decision.session_id)
    try:
        await defer_resume_after_answer(state.jobs, ids, decision, approved, result_fact_ids=result_fact_ids)
        return
    except Exception as error:
        logger.error("the resume job couldn't be queued (%s); resuming here", type(error).__name__)
    try:
        async with state.database().connect() as conn:
            await resume_after_answer(conn, ids, decision, approved, result_fact_ids=result_fact_ids)
    except Exception as error:
        logger.error("the answer couldn't be resumed here either (%s)", type(error).__name__)


# The owner in a conversation (Plan 02b) ----------------------------------------------------------------------
#
# Take-over, hand-back and resume change the session's mode through the kernel with the owner's credential, under
# the session's run lock, with the event, its transcript row and the note they bring in the same transaction: a
# delivery waits for them, then reads the new generation and drops anything of the old one. Claude's follow-up after
# a hand-back or a resume runs with the visitor's own credential, once it is present: the `run_resumable` control row
# is for the visitor's open stream or next request.

SessionId = Annotated[str, Path(max_length=128)]


async def _conversation(ctx: OwnerCtx, session_id: str) -> Ids:
    """A visitor's or an agent's conversation on one of the copy's Desks, from its kernel_ro row; any other session,
    the owner's own included, is 404 and never sent to the kernel."""
    session = await ctx.ro.session(session_id)
    if session is None or session["desk_id"] not in ctx.desk_ids or session["kind"] == "owner":
        raise ApiProblem(404, "not_found")
    return Ids(copy_id=ctx.copy_id, desk_id=session["desk_id"], session_id=session_id)


async def _owner_name(ctx: OwnerCtx, desk_id: str) -> str:
    """The owner's name as the kernel has it for the Desk's business, the only name the visitor's events carry."""
    desk = await ctx.ro.one("desks", desk_id=desk_id)
    business = None if desk is None else await ctx.ro.one("businesses", business_id=desk["business_id"])
    if business is None:
        raise LookupError("the Desk's business isn't in its copy")
    return business["owner_display_name"]


async def _change_mode(ctx: OwnerCtx, session_id: str, mode: Literal["ai", "owner"], generation: int) -> SessionState:
    """Move the conversation to `mode` at the generation the owner read, as the kernel answers it (route docstrings).
    What the visitor and Claude are told follows the change the kernel made from the mode read under the run lock;
    the current mode again changes nothing and says nothing. The owner's name is read before the kernel is asked,
    so a failure to read it changes nothing rather than leave a change the visitor is never told of."""
    ids = await _conversation(ctx, session_id)
    name = await _owner_name(ctx, ids.desk_id)
    conn = ctx.ro.conn
    await conn.commit()
    try:
        await run_lock(conn, session_id)
        before = await ctx.ro.session(session_id)
        changed = await ctx.kernel.call("POST /sessions/{id}/mode", ModeRequest(mode=mode, generation=generation),
                                        path={"id": session_id})
        if changed.generation != generation and before is not None:
            await _announce(conn, ids, before["mode"], changed, name)
        await conn.commit()
    except BaseException:
        await conn.rollback()
        raise
    return changed


async def _announce(conn: AsyncConnection, ids: Ids, before: str, now: SessionState, name: str) -> None:
    """The visitor's event (`name` is the owner's, as the kernel has it) and Claude's note for a mode change; after
    one back to Claude, a `run_resumable` row when work is waiting for it. A take-over stops the wake of a hand-back
    note no turn has read (`clear_hand_back_wake`). A take-over or a hand-back also stays in the transcript
    (`_transcribed`); a resume after a breaker pause has no event and leaves no item."""
    if now.mode == "owner":
        await _transcribed(conn, ids, EvOwnerJoined(type="owner_joined", name=name))
        await append_message(conn, ids, "note", text=NOTES["taken_over"], wake=False)
        await clear_hand_back_wake(conn, ids.session_id)   # the owner answers what an earlier hand-back woke for
        return
    if before == "owner":
        await _transcribed(conn, ids, EvOwnerLeft(type="owner_left"))
    waiting = before == "owner" and await has_unanswered_message(conn, ids.session_id)
    await append_message(conn, ids, "note", text=NOTES["handed_back" if before == "owner" else "resumed"],
                         wake=waiting)
    if await has_pending(conn, ids.session_id):
        await append_control(conn, ids, "run_resumable", {"generation": now.generation})


async def _transcribed(conn: AsyncConnection, ids: Ids, event: EvOwnerJoined | EvOwnerLeft) -> None:
    """Emit the owner's joining or leaving to the visitor's stream and keep it in the transcript: a row of the event's
    kind holding that event (`event_seq`), which the owner's and the visitor's transcripts read back as it was sent.
    It has no text and no model block, so no model context, reply check or job ever carries it."""
    await append_message(conn, ids, event.type, event_seq=await emit(conn, ids, event))


@router.post("/conversations/{session_id}/takeover", response_model=SessionState,
             responses=error_responses(401, 404, 409, 422, 503))
async def takeover(session_id: SessionId, body: GenerationIn,
                   ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> SessionState:
    """Take the conversation over from Claude, or from a breaker pause, at the generation the owner last read: the
    kernel moves it to mode `owner` (a new generation, so nothing Claude had in flight is shown), the visitor sees the
    owner join by the kernel's name for them, and Claude reads that the owner took over at its next call. A stale
    generation is the kernel's 409 `stale_generation`."""
    return await _change_mode(ctx, session_id, "owner", body.generation)


@router.post("/conversations/{session_id}/handback", response_model=SessionState,
             responses=error_responses(401, 404, 409, 422, 503))
async def handback(session_id: SessionId, body: GenerationIn,
                   ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> SessionState:
    """Hand a conversation the owner took over back to Claude, at the generation the owner last read: the kernel
    moves it to mode `ai` (a new generation), the visitor sees the owner leave, and Claude reads that the owner handed
    it back. Work that waited for the owner (an answered request's outcome, a whisper) wakes Claude, whose turn runs
    with the visitor's credential once it is present: the open stream or the next request."""
    return await _change_mode(ctx, session_id, "ai", body.generation)


@router.post("/conversations/{session_id}/resume", response_model=SessionState,
             responses=error_responses(401, 404, 409, 422, 503))
async def resume(session_id: SessionId, body: GenerationIn,
                 ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> SessionState:
    """Resume a conversation the breaker paused, at the generation the owner last read: the kernel moves it back to
    mode `ai` (a new generation, its strikes reset), and Claude reads that the owner resumed it. Work still waiting
    wakes Claude as after a hand-back; work the pause's handoff already answered doesn't."""
    return await _change_mode(ctx, session_id, "ai", body.generation)


@router.post("/conversations/{session_id}/messages", response_model=OwnerMessageResult,
             responses=error_responses(401, 404, 409, 422, 503))
async def message(session_id: SessionId, body: OwnerMessageIn,
                  ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> OwnerMessageResult:
    """The owner's words in a conversation, through the kernel with the owner's credential (it ledgers both kinds).

    A `say` goes to the visitor once the owner has taken the conversation over (else 409 `take_over_first`): the
    kernel checks it and signs it at the session's generation, and only a passing verdict is shown, through
    `deliver()`, as the owner's, with an `owner_say` row so Claude reads it at its next call. A say the kernel blocks
    comes back to the owner unchanged and reaches no one; one the session moved past before it could be shown is 409
    `stale_generation`. A `whisper` is a note for Claude alone, in any mode, held as untrusted text: in mode `ai` it
    wakes Claude's next turn, which runs with the visitor's credential once it is present; during a take-over it
    waits for the hand-back; during a breaker pause Claude reads it at its first call after the resume."""
    ids = await _conversation(ctx, session_id)
    conn = ctx.ro.conn
    await conn.commit()
    try:
        await run_lock(conn, session_id)                     # the mode read below holds until this commits
        session = await ctx.ro.session(session_id)
        mode = session["mode"] if session is not None else None
        if body.kind == "say" and mode != "owner":
            raise ApiProblem(409, "take_over_first")
        result = await ctx.kernel.call("POST /owner/messages", OwnerMessageRequest(
            session_id=session_id, text=body.text, kind=body.kind))
        if body.kind == "say":
            await _said(conn, ids, result, ctx.ro.schema)
        else:
            await append_message(conn, ids, "whisper", text=body.text, ref_id=result.message_id,
                                 wake=mode != "paused")
            if mode == "ai":
                await append_control(conn, ids, "run_resumable", {"message_id": result.message_id})
        await conn.commit()
    except BaseException:
        await conn.rollback()
        raise
    return result


async def _said(conn: AsyncConnection, ids: Ids, result: OwnerMessageResult, ro_schema: str) -> None:
    """Show the owner's checked say to the visitor and note it for Claude, as the visitor was shown it (`message`)."""
    verdict = result.verdict
    if verdict is None:
        raise ValueError("the kernel answered a say without its verdict")
    if not verdict.ok:                                      # blocked: it stays with the owner
        return
    if await deliver(conn, ids, Reply(verdict, "owner", via="owner"), ro_schema=ro_schema) is None:
        raise ApiProblem(409, "stale_generation")
    await append_message(conn, ids, "owner_say", text=blocks_text(verdict.blocks), ref_id=result.message_id)


@router.post("/conversations/{session_id}/typing", status_code=204, response_class=Response,
             responses=error_responses(401, 404, 409, 422, 503))
async def typing(session_id: SessionId, body: GenerationIn, request: Request,
                 ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> None:
    """The owner is typing in a conversation they took over, at the generation they read: the visitor sees their
    initials, name and three dots for five seconds, or until their say replaces them (an `owner_typing` event that
    carries the kernel's name for the owner and when the dots stop, never text). Presence, not a message: no kernel
    call but the one naming the owner, no ledger entry. In any other mode it is 409 `take_over_first`, and at a
    generation the session has left 409 `stale_generation`. The app sends about one signal every two seconds while
    the owner types, never one per keystroke: each one still costs a kernel call, database reads and a moment of the
    conversation's lock. At most one event goes out every two seconds; a signal sooner changes nothing."""
    ids = await _conversation(ctx, session_id)
    process = runtime(request)
    conn = ctx.ro.conn
    await conn.commit()
    try:
        await run_lock(conn, session_id)                     # after a hand-back, no dots: it holds the same lock
        session = await ctx.ro.session(session_id)
        if session is None or session["mode"] != "owner":
            raise ApiProblem(409, "take_over_first")
        if session["generation"] != body.generation:
            raise ApiProblem(409, "stale_generation")
        name = await _owner_name(ctx, ids.desk_id)
        now = process.clock()
        until = process.presence.owner_typing(session_id, now)
        if until is not None:
            await emit(conn, ids, EvOwnerTyping(type="owner_typing", name=name, until=until))
        await conn.commit()
        if until is not None:                                # counted once sent: a failure holds nothing back
            process.presence.owner_typing_sent(session_id, now)
    except BaseException:
        await conn.rollback()
        raise
