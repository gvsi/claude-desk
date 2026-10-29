"""The owner's routes, under `/api/owner/`: the only paths the owner cookie is sent to.

Creating a copy is the one call that needs the passcode. Every other owner route takes the copy from the
kernel's `GET /whoami` answer for the owner cookie (`deps.owner_ctx`), never from the browser.
"""

import asyncio
import logging
from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, StringConstraints

from desk.api.cookies import set_owner_cookie
from desk.api.deliver import status_shown
from desk.api.deps import ApiProblem, OwnerCtx, Runtime, client_ip, owner_context, owner_ctx, runtime
from desk.api.jobs import defer_resume_after_answer, resume_after_answer
from desk.api import owner_reads
from desk.api.kernel_client import KernelFailed, KernelUnavailable
from desk.api.passcode import check_passcode
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
    DeskSummary,
    NeedsYouItem,
    OwnerTranscript,
    Today,
    error_responses,
    operation_ids,
)
from desk.api.store import Ids, transcript
from desk.contracts import Decision, DemoInboxEntry, LedgerPage, SessionState
from desk.kernel_api import AnswerRequest, CreateCopyRequest, DeskAnsweringRequest, DeskUpdated

router = APIRouter(prefix="/api/owner", generate_unique_id_function=operation_ids("owner"))
logger = logging.getLogger(__name__)


class CopyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    passcode: Annotated[str, StringConstraints(min_length=1, max_length=200)]


async def _desks(ctx: OwnerCtx) -> tuple[list[dict], dict[str, dict]]:
    """The copy's Desks in the order they were made, and their businesses by ID, from its kernel_ro rows."""
    desks = [row for row in await ctx.ro.desks() if row["desk_id"] in ctx.desk_ids]
    businesses = {row["business_id"]: row
                  for row in await ctx.ro.rows("businesses", business_id=[desk["business_id"] for desk in desks])}
    return desks, businesses


def _summary(desk: dict, business: dict) -> DeskSummary:
    return DeskSummary(desk_id=desk["desk_id"], slug=desk["slug"], name=desk["name"], business_name=business["name"],
                       hours=desk["hours"], answering=desk["answering"])


async def copy_out(ctx: OwnerCtx) -> CopyOut:
    """The copy's Desks, from its kernel_ro rows, in the order they were made."""
    desks, businesses = await _desks(ctx)
    return CopyOut(copy_id=ctx.copy_id, desks=[_summary(desk, businesses[desk["business_id"]]) for desk in desks])


async def _new_copy(state: Runtime, response: Response) -> CopyOut:
    """A new copy of the Rivera seed, read back through its own owner token, which goes only into the cookie."""
    created = await state.kernel.public().call("POST /copies", CreateCopyRequest())
    async with owner_context(state, created.owner_token) as ctx:
        copy = await copy_out(ctx)
    set_owner_cookie(response, created.owner_token)
    return copy


@router.post("/copies", status_code=201, response_model=CopyOut, responses=error_responses(401, 422, 429, 503))
async def create_copy(body: CopyRequest, request: Request, response: Response) -> CopyOut:
    """A fresh copy of the Rivera seed for whoever holds the passcode, and the owner cookie for it."""
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
    """The copy's businesses, each with its Desks, in the order the Desks were made: the Desk switcher."""
    found, businesses = await _desks(ctx)
    listed: dict[str, BusinessOut] = {}
    for desk in found:
        business = businesses[desk["business_id"]]
        if business["business_id"] not in listed:
            listed[business["business_id"]] = BusinessOut(
                business_id=business["business_id"], name=business["name"],
                owner_display_name=business["owner_display_name"], timezone=business["timezone"], desks=[])
        listed[business["business_id"]].desks.append(_summary(desk, business))
    return list(listed.values())


DeskId = Annotated[str, Path(max_length=128)]


@router.put("/desks/{desk_id}/answering", response_model=DeskUpdated, responses=error_responses(401, 404, 422, 503))
async def answering(desk_id: DeskId, body: AnsweringIn,
                    ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> DeskUpdated:
    """The Answering switch, set by the kernel with the owner's credential. Off, visitors can only leave their
    details or ask for a callback; the owner's own previews keep every tool."""
    return await ctx.kernel.call("PUT /desks/{id}/answering", DeskAnsweringRequest(on=body.on),
                                 path={"id": ctx.desk(desk_id)})


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


@router.get("/desks/{desk_id}/conversations", response_model=list[ConversationSummary],
            responses=error_responses(401, 404, 422, 503))
async def conversations(desk_id: DeskId, ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> list[ConversationSummary]:
    """The Desk's conversations, the latest activity first; the owner's own previews included."""
    return await owner_reads.conversations(ctx, ctx.desk(desk_id))


@router.get("/conversations/{session_id}", response_model=OwnerTranscript,
            responses=error_responses(401, 404, 422, 503))
async def conversation(session_id: Annotated[str, Path(max_length=128)], ctx: Annotated[OwnerCtx, Depends(owner_ctx)],
                       after: Annotated[int, Query(ge=0)] = 0) -> OwnerTranscript:
    """A conversation on one of the copy's Desks, as the owner sees it, after the cursor `after` (polled every 2 s).
    The cursor never skips a row: a session's rows commit in the order of their `n`."""
    session = await ctx.ro.session(session_id)
    if session is None or session["desk_id"] not in ctx.desk_ids:
        raise ApiProblem(404, "not_found")
    ids = Ids(copy_id=ctx.copy_id, desk_id=session["desk_id"], session_id=session_id)
    state = SessionState(session_id=session_id, kind=session["kind"], verified=session["verified"],
                         assurance=session["assurance"], mode=session["mode"], generation=session["generation"])
    return OwnerTranscript(state=state, items=await transcript(ctx.ro.conn, ids, "owner", after))


@router.get("/desks/{desk_id}/safety", response_model=list[Attempt], responses=error_responses(401, 404, 422, 503))
async def safety(desk_id: DeskId, ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> list[Attempt]:
    """The attempts the checkpoint stopped on the Desk, newest first: refused requests and replies of Claude's it
    blocked (the "stopped" Today counts)."""
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
    the copy's Desks is 404 and never sent; one already done is the kernel's 409 `conflict`."""
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
    there and then, as the visitor's session (also during a take-over); the visitor sees the outcome, and Claude
    follows up, once the resume job ran and the visitor's own credential is present (the open stream or the next
    request). Drafted rule cards come back in `card_diff`; proving them is a rules route's work, so an answer never
    waits on a proof.

    When the kernel refuses the answer (409: answered before, expired or cancelled) or its response is lost, the
    decision is read as it stands: once it left `held`, an outcome the visitor wasn't shown yet gets the (idempotent)
    resume job, so a lost response still resumes the chat, and the answer is 409 `already_resolved` with the
    decision. A decision still `held` keeps the kernel's own error, its code included ("Errors"): a 409 is
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
    await _resume(state, ctx, result.decision)
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
    if not await status_shown(ctx.ro.conn, decision, or_later=True):
        await _resume(state, ctx, decision)
    return JSONResponse(AlreadyResolved(decision=decision).model_dump(mode="json"), status_code=409)


async def _resume(state: Runtime, ctx: OwnerCtx, decision: Decision) -> None:
    """Defer the resume job for the decision's session, named by the kernel's answer within the owner's copy. If the
    queue can't take it, the request does the job's work itself: like the job, it holds only IDs and the signed
    record and makes no kernel call. If that fails too, the answer still stands, and the due-decisions job surfaces
    the outcome once it is final."""
    session = await ctx.ro.session(decision.session_id)
    if session is None or session["desk_id"] not in ctx.desk_ids:
        logger.warning("an answered request's session isn't one of the copy's")
        return
    ids = Ids(copy_id=ctx.copy_id, desk_id=session["desk_id"], session_id=decision.session_id)
    try:
        await defer_resume_after_answer(state.jobs, ids, decision)
        return
    except Exception as error:
        logger.error("the resume job couldn't be queued (%s); resuming here", type(error).__name__)
    try:
        async with state.database().connect() as conn:
            await resume_after_answer(conn, ids, decision)
    except Exception as error:
        logger.error("the answer couldn't be resumed here either (%s)", type(error).__name__)
