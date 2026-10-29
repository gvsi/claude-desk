"""The owner's routes, under `/api/owner/`: the only paths the owner cookie is sent to.

Creating a copy is the one call that needs the passcode. Every other owner route takes the copy from the
kernel's `GET /whoami` answer for the owner cookie (`deps.owner_ctx`), never from the browser.
"""

import asyncio
import logging
from typing import Annotated

from fastapi import APIRouter, Depends, Path, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, StringConstraints
from sqlalchemy import func, select

from desk.api.cookies import set_owner_cookie
from desk.api.deliver import PHASES
from desk.api.deps import ApiProblem, OwnerCtx, Runtime, client_ip, owner_context, owner_ctx, runtime
from desk.api.jobs import defer_resume_after_answer
from desk.api.kernel_client import KernelFailed, KernelUnavailable
from desk.api.passcode import check_passcode
from desk.api.schemas import (
    AlreadyResolved,
    ApiError,
    ApprovalAnswerIn,
    ApprovalAnswerOut,
    CopyOut,
    DeskSummary,
    error_responses,
    operation_ids,
)
from desk.api.sse import RUN_EVENTS
from desk.api.store import Ids
from desk.contracts import Decision
from desk.kernel_api import AnswerRequest, CreateCopyRequest

router = APIRouter(prefix="/api/owner", generate_unique_id_function=operation_ids("owner"))
logger = logging.getLogger(__name__)


class CopyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    passcode: Annotated[str, StringConstraints(min_length=1, max_length=200)]


async def copy_out(ctx: OwnerCtx) -> CopyOut:
    """The copy's Desks, from its kernel_ro rows, in the order they were made."""
    desks = [row for row in await ctx.ro.desks() if row["desk_id"] in ctx.desk_ids]
    businesses = {row["business_id"]: row["name"]
                  for row in await ctx.ro.rows("businesses", business_id=[desk["business_id"] for desk in desks])}
    return CopyOut(copy_id=ctx.copy_id, desks=[
        DeskSummary(desk_id=desk["desk_id"], slug=desk["slug"], name=desk["name"],
                    business_name=businesses[desk["business_id"]], hours=desk["hours"], answering=desk["answering"])
        for desk in desks])


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


# Held requests -----------------------------------------------------------------------------------------------


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
    if not await _shown(ctx, decision):
        await _resume(state, ctx, decision)
    return JSONResponse(AlreadyResolved(decision=decision).model_dump(mode="json"), status_code=409)


async def _shown(ctx: OwnerCtx, decision: Decision) -> bool:
    """Whether the visitor was shown the decision in this state (its ledger entry)."""
    shown = await ctx.ro.conn.execute(select(func.count()).where(
        RUN_EVENTS.c.copy_id == ctx.copy_id, RUN_EVENTS.c.session_id == decision.session_id,
        RUN_EVENTS.c.kind == "sse", RUN_EVENTS.c.type.in_(PHASES),
        RUN_EVENTS.c.payload["decision_id"].astext == decision.decision_id,
        RUN_EVENTS.c.payload["ledger_seq"].astext == str(decision.ledger_seq)))
    return shown.scalar_one() > 0


async def _resume(state: Runtime, ctx: OwnerCtx, decision: Decision) -> None:
    """Defer the resume job for the decision's session, named by the kernel's answer within the owner's copy. If the
    queue can't take it, the answer still stands and the due-decisions job surfaces the outcome within a minute."""
    session = await ctx.ro.session(decision.session_id)
    if session is None or session["desk_id"] not in ctx.desk_ids:
        logger.warning("an answered request's session isn't one of the copy's")
        return
    ids = Ids(copy_id=ctx.copy_id, desk_id=session["desk_id"], session_id=decision.session_id)
    try:
        await defer_resume_after_answer(state.jobs, ids, decision)
    except Exception as error:
        logger.error("the resume job couldn't be queued (%s)", type(error).__name__)
